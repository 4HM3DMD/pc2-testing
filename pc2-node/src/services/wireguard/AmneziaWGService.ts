/**
 * AmneziaWG Service
 *
 * Manages an obfuscated WireGuard tunnel (AmneziaWG) to the PC2 supernode.
 * Used as a stealth fallback when standard WireGuard is blocked by DPI systems.
 *
 * AmneziaWG uses the same cryptographic core as WireGuard (ChaCha20-Poly1305)
 * but adds transport-layer obfuscation: randomized headers, padded packets,
 * and junk traffic that make the tunnel undetectable by Deep Packet Inspection.
 *
 * Runs on a separate interface (awg0) and subnet (10.101.x.x) to coexist
 * with the standard WireGuard tunnel (wg0, 10.100.x.x).
 *
 * Flow:
 *   1. Check if AmneziaWG tools (awg, awg-quick, amneziawg-go) are installed
 *   2. Generate or load a persistent keypair (same curve25519 as WireGuard)
 *   3. Call the supernode's AWG provisioning API to receive IP + obfuscation params
 *   4. Configure and bring up the awg0 interface with obfuscation
 *   5. Periodically verify tunnel health via ping
 *   6. Register http://<awg-ip>:4200 with the gateway
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

export interface AmneziaWGConfig {
    dataDir: string;
    gatewayUrl: string;
    secondaryGatewayUrls?: string[];
    nodeId: string;
    localPort: number;
    gatewayTokenStore?: import('../gateway/GatewayTokenStore.js').GatewayTokenStore;
}

export interface AWGObfuscationParams {
    Jc: number;
    Jmin: number;
    Jmax: number;
    S1: number;
    S2: number;
    S3: number;
    S4: number;
    H1: number;
    H2: number;
    H3: number;
    H4: number;
    I1?: string;
}

export interface AWGProvisionResponse {
    assignedIP: string;
    serverPublicKey: string;
    serverEndpoint: string;
    serverIP: string;
    obfuscation: AWGObfuscationParams;
}

export interface AmneziaWGStatus {
    available: boolean;
    connected: boolean;
    assignedIP: string | null;
    serverEndpoint: string | null;
    lastHandshake: number | null;
    transferRx: number;
    transferTx: number;
}

const AWG_INTERFACE = 'awg0';
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const PROVISION_TIMEOUT_MS = 10_000;
const HEALTH_FAILURE_THRESHOLD = 3;

export class AmneziaWGService {
    private config: AmneziaWGConfig;
    private awgDir: string;
    private privateKeyPath: string;
    private publicKeyPath: string;
    private provisionPath: string;
    private assignedIP: string | null = null;
    private serverEndpoint: string | null = null;
    private connected = false;
    private healthTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures = 0;
    private onTunnelDown: (() => void) | null = null;
    private _available: boolean | null = null;

    constructor (config: AmneziaWGConfig) {
        this.config = config;
        this.awgDir = join(config.dataDir, 'amneziawg');
        this.privateKeyPath = join(this.awgDir, 'private.key');
        this.publicKeyPath = join(this.awgDir, 'public.key');
        this.provisionPath = join(this.awgDir, 'provision.json');
    }

    private static isMacOS = process.platform === 'darwin';
    private static isWindows = process.platform === 'win32';

    private awgGoBinPath: string | null = null;
    private awgQuickBinPath: string | null = null;
    private awgCliBinPath: string | null = null;

    /**
   * Find a binary by checking bundled path first, then well-known system paths.
   */
    private findBinary (name: string, extraPaths: string[] = []): string | null {
        const bundledDir = join(typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)),
                        '..',
                        '..',
                        '..',
                        'bin',
                        `${process.platform}-${process.arch}`);
        const bundled = join(bundledDir, AmneziaWGService.isWindows ? `${name}.exe` : name);
        if ( existsSync(bundled) ) return bundled;

        for ( const p of extraPaths ) {
            if ( existsSync(p) ) return p;
        }

        if ( ! AmneziaWGService.isWindows ) {
            try {
                const found = execSync(`which ${name} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/sh' }).toString().trim();
                if ( found && existsSync(found) ) return found;
            } catch { /* not on PATH */ }
        }

        return null;
    }

    /**
   * Check if AmneziaWG tools are installed.
   * Checks bundled binaries first, then system paths.
   * Not available on Windows (AmneziaWG is Linux/macOS only).
   *
   * v1.2.7.11: also resolves the `awg` CLI (the AmneziaWG fork of `wg`).
   * awg-quick.darwin / awg-quick.linux scripts shell out to `awg setconf`
   * to install the obfuscation parameters (Jc/S1-S4/H1-H4) — plain `wg`
   * cannot parse those keys. Pre-v1.2.7.11 builds didn't ship `awg`,
   * causing `awg-quick up` to fail mid-bring-up with `awg: command not
   * found`. Probe is informational here (we still only require awg-go +
   * awg-quick to mark "available"); the actual lookup-via-PATH happens
   * inside the awg-quick script after our PATH self-location patch
   * prepends the bundled bin dir.
   */
    isAvailable (): boolean {
        if ( this._available !== null ) return this._available;

        if ( AmneziaWGService.isWindows ) {
            this._available = false;
            return false;
        }

        this.awgGoBinPath = this.findBinary('amneziawg-go', [
            '/usr/local/bin/amneziawg-go', '/opt/homebrew/bin/amneziawg-go',
        ]);
        if ( ! this.awgGoBinPath ) {
            this._available = false;
            return false;
        }

        this.awgQuickBinPath = this.findBinary('awg-quick', [
            '/usr/local/bin/awg-quick', '/opt/homebrew/bin/awg-quick',
        ]);
        if ( ! this.awgQuickBinPath ) {
            this._available = false;
            return false;
        }

        // v1.2.7.11: locate the awg CLI for keypair generation and as an
        // explicit signal that awg-quick will succeed at the setconf step.
        // Fallback to bundled `wg` is acceptable for keygen (same Curve25519
        // format) but not for awg-quick's setconf — that path requires the
        // bundled bin dir to be on the script's PATH (handled separately).
        this.awgCliBinPath = this.findBinary('awg', [
            '/usr/local/bin/awg', '/opt/homebrew/bin/awg',
        ]);

        this._available = true;
        const awgCliInfo = this.awgCliBinPath ? this.awgCliBinPath : 'NOT FOUND (awg-quick setconf will fail; will fall back to wg for keygen only)';
        logger.info(`[AmneziaWG] Stealth transport tools detected (awg-go: ${this.awgGoBinPath}, awg-quick: ${this.awgQuickBinPath}, awg: ${awgCliInfo})`);
        return true;
    }

    /**
   * Build the awg-quick command string.
   *
   * v1.2.7.10: passes WG_QUICK_USERSPACE_IMPLEMENTATION via `sudo -E` so
   * awg-quick (a fork of wg-quick) can locate the bundled amneziawg-go binary.
   * Same env-var name as wg-quick uses, but pointed at amneziawg-go instead
   * of wireguard-go. Without this, sudo's secure_path strips ~/.pc2/.../bin/
   * and the awg-quick.darwin / awg-quick.linux scripts fail with
   * "amneziawg-go: command not found" the moment they try to spin up the
   * obfuscation engine.
   *
   * Requires the SETENV flag on the sudoers entry — v1.2.7.10 sudoers writer
   * (setupPermissions.ts:buildSudoersEntry) emits NOPASSWD:SETENV: rules.
   * Pre-v1.2.7.10 entries get detected as needing upgrade by
   * checkWireGuardPermissions and re-prompted on next launch.
   */
    private awgQuickCmd (action: 'up' | 'down', confPath: string): string {
        const absConf = resolve(confPath);
        const awqPath = this.awgQuickBinPath || 'awg-quick';

        if ( this.awgGoBinPath ) {
            return `WG_QUICK_USERSPACE_IMPLEMENTATION=${this.awgGoBinPath} sudo -E ${awqPath} ${action} ${absConf}`;
        }
        return `sudo ${awqPath} ${action} ${absConf}`;
    }

    /**
   * Force cleanup of stale AmneziaWG state: bring down the interface,
   * kill orphaned amneziawg-go processes, and remove stale runtime files.
   */
    private forceCleanup (confPath: string): void {
        try {
            execSync(`${this.awgQuickCmd('down', confPath)} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/sh' });
        } catch { /* may not be up */ }
        try {
            execSync('sudo killall amneziawg-go 2>/dev/null', { stdio: 'pipe', shell: '/bin/sh' });
        } catch { /* may not exist */ }
        try {
            execSync('sudo rm -rf /var/run/amneziawg/ 2>/dev/null', { stdio: 'pipe', shell: '/bin/sh' });
        } catch { /* may not exist */ }
    }

    /**
   * Generate or load a persistent keypair.
   * Uses standard wg tools for key generation (same curve25519 format).
   */
    ensureKeypair (): { publicKey: string; privateKey: string } {
        if ( ! existsSync(this.awgDir) ) {
            mkdirSync(this.awgDir, { recursive: true });
        }

        if ( existsSync(this.privateKeyPath) && existsSync(this.publicKeyPath) ) {
            return {
                privateKey: readFileSync(this.privateKeyPath, 'utf8').trim(),
                publicKey: readFileSync(this.publicKeyPath, 'utf8').trim(),
            };
        }

        logger.info('[AmneziaWG] Generating new keypair...');
        // AmneziaWG uses the same key format as WireGuard, so the bundled `wg`
        // is a fine fallback when `awg` is missing.
        //
        // v1.2.7.11: previously used `findTool` which only searched system
        // paths (`/usr/bin`, `/opt/homebrew/bin`) and `which`, NEVER the
        // bundled `~/.pc2/pc2-node/bin/<platform>-<arch>/` directory. On a
        // fresh-Mac install where users didn't `brew install wireguard-tools`,
        // this resolved to the literal string 'wg' and `execSync('wg genkey')`
        // crashed with "wg: command not found" — exactly what was seen in
        // production logs (issue triggered by stealth toggle on v1.2.7.10).
        // `findBinary` checks bundled dir first, then the supplied extra
        // paths, then `which` — so the bundled wg/awg is always preferred.
        const keygenTool = this.awgCliBinPath
            || this.findBinary('awg', ['/usr/local/bin/awg', '/opt/homebrew/bin/awg'])
            || this.findBinary('wg', ['/usr/local/bin/wg', '/opt/homebrew/bin/wg', '/usr/bin/wg', '/usr/sbin/wg']);
        if ( ! keygenTool ) {
            throw new Error('[AmneziaWG] No wg/awg binary available for keygen — bundle download may have failed');
        }
        logger.debug(`[AmneziaWG] Using ${keygenTool} for keypair generation`);
        const privateKey = execSync(`"${keygenTool}" genkey`, { stdio: 'pipe', shell: '/bin/sh' }).toString().trim();
        const publicKey = execSync(`echo "${privateKey}" | "${keygenTool}" pubkey`, {
            stdio: 'pipe',
            shell: '/bin/sh',
        }).toString().trim();

        writeFileSync(this.privateKeyPath, `${privateKey }\n`, { mode: 0o600 });
        writeFileSync(this.publicKeyPath, `${publicKey }\n`, { mode: 0o644 });
        logger.info(`[AmneziaWG] Keypair generated (pubkey: ${publicKey.slice(0, 8)}...)`);

        return { publicKey, privateKey };
    }

    /**
   * Register with the supernode's AmneziaWG provisioning API.
   * Returns connection parameters including obfuscation params.
   * Tries primary gateway first, then secondary gateways on failure (sequential failover).
   */
    async provision (): Promise<AWGProvisionResponse> {
        const { publicKey } = this.ensureKeypair();

        if ( existsSync(this.provisionPath) ) {
            try {
                const cached = JSON.parse(readFileSync(this.provisionPath, 'utf8')) as AWGProvisionResponse;
                if ( cached.assignedIP && cached.serverPublicKey && cached.serverEndpoint && cached.obfuscation ) {
                    logger.info(`[AmneziaWG] Using cached provision: ${cached.assignedIP}`);
                    return cached;
                }
            } catch {
                logger.warn('[AmneziaWG] Invalid cached provision, re-provisioning...');
            }
        }

        const gatewayUrls = [
            this.config.gatewayUrl,
            ...(this.config.secondaryGatewayUrls || []),
        ];

        const body = JSON.stringify({
            username: await this.getUsername(),
            nodeId: this.config.nodeId,
            publicKey,
        });

        let lastError: Error | null = null;

        for ( const gatewayUrl of gatewayUrls ) {
            const url = `${gatewayUrl}/api/awg/register`;
            logger.info(`[AmneziaWG] Provisioning via ${url}...`);

            // SEC-INFRA-GW-AUTH (Wave 3): same pattern as WireGuardService —
            // attach the per-gateway provisioning token if we have one.
            const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
            const headers = this.config.gatewayTokenStore
                ? this.config.gatewayTokenStore.headersFor(gatewayUrl, jsonHeaders)
                : jsonHeaders;

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body,
                    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
                });

                if ( ! response.ok ) {
                    const errBody = await response.text();
                    throw new Error(`AWG provisioning failed (${response.status}): ${errBody}`);
                }

                const data = await response.json() as AWGProvisionResponse;
                if ( !data.assignedIP || !data.serverPublicKey || !data.serverEndpoint || !data.obfuscation ) {
                    throw new Error('Invalid AWG provisioning response');
                }

                writeFileSync(this.provisionPath, JSON.stringify(data, null, 2));
                logger.info(`[AmneziaWG] Provisioned: ${data.assignedIP} via ${data.serverEndpoint}`);
                return data;
            } catch ( err ) {
                lastError = err instanceof Error ? err : new Error(String(err));
                logger.warn(`[AmneziaWG] Provisioning failed via ${gatewayUrl}: ${lastError.message}`);
            }
        }

        throw lastError || new Error('All AmneziaWG provisioning endpoints failed');
    }

    /**
   * Clear cached provision data so the next provision() call re-registers
   * with a supernode. Used during failover when the current supernode is down.
   */
    clearProvisionCache (): void {
        try {
            if ( existsSync(this.provisionPath) ) {
                const { unlinkSync } = require('fs');
                unlinkSync(this.provisionPath);
                logger.info('[AmneziaWG] Provision cache cleared for failover');
            }
        } catch {
            // Non-critical
        }
    }

    /**
   * Configure and bring up the AmneziaWG interface with obfuscation params.
   */
    async connect (provision?: AWGProvisionResponse, options?: { endpointOverride?: string }): Promise<void> {
        if ( ! provision ) {
            provision = await this.provision();
        }

        const { privateKey } = this.ensureKeypair();
        const confPath = join(this.awgDir, `${AWG_INTERFACE}.conf`);
        const obf = provision.obfuscation;
        const endpoint = options?.endpointOverride || provision.serverEndpoint;

        const interfaceLines = [
            '[Interface]',
            `Address = ${provision.assignedIP}/32`,
            `PrivateKey = ${privateKey}`,
            'MTU = 1280',
            `Jc = ${obf.Jc}`,
            `Jmin = ${obf.Jmin}`,
            `Jmax = ${obf.Jmax}`,
            `S1 = ${obf.S1}`,
            `S2 = ${obf.S2}`,
            `S3 = ${obf.S3}`,
            `S4 = ${obf.S4}`,
            `H1 = ${obf.H1}`,
            `H2 = ${obf.H2}`,
            `H3 = ${obf.H3}`,
            `H4 = ${obf.H4}`,
        ];

        if ( obf.I1 ) {
            interfaceLines.push(`I1 = ${obf.I1}`);
        }

        const conf = [
            ...interfaceLines,
            '',
            '[Peer]',
            `PublicKey = ${provision.serverPublicKey}`,
            `Endpoint = ${endpoint}`,
            `AllowedIPs = ${provision.serverIP}/32`,
            'PersistentKeepalive = 25',
        ].join('\n');

        writeFileSync(confPath, `${conf }\n`, { mode: 0o600 });

        // Clean up any existing interface and stale state from previous attempts
        this.forceCleanup(confPath);

        try {
            execSync(this.awgQuickCmd('up', confPath), { stdio: 'pipe', timeout: 15_000, shell: '/bin/sh' });
        } catch ( error: unknown ) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to bring up AmneziaWG interface: ${msg}`);
        }

        this.assignedIP = provision.assignedIP;
        this.serverEndpoint = provision.serverEndpoint;
        this.connected = true;

        logger.info(`[AmneziaWG] Interface ${AWG_INTERFACE} up (stealth mode): ${provision.assignedIP}`);

        const reachable = await this.pingServer(provision.serverIP);
        if ( ! reachable ) {
            logger.warn('[AmneziaWG] Server not reachable through tunnel (may need a moment to establish)');
        } else {
            logger.info('[AmneziaWG] Stealth tunnel verified - server reachable');
        }
    }

    setOnTunnelDown (callback: () => void): void {
        this.onTunnelDown = callback;
    }

    startHealthCheck (serverIP: string): void {
        if ( this.healthTimer ) return;
        this.consecutiveFailures = 0;

        this.healthTimer = setInterval(async () => {
            if ( ! this.connected ) return;

            const ok = await this.pingServer(serverIP);
            if ( ok ) {
                if ( this.consecutiveFailures > 0 ) {
                    logger.info(`[AmneziaWG] Health check recovered after ${this.consecutiveFailures} failure(s)`);
                }
                this.consecutiveFailures = 0;
                return;
            }

            this.consecutiveFailures++;
            logger.warn(`[AmneziaWG] Health check failed (${this.consecutiveFailures}/${HEALTH_FAILURE_THRESHOLD})`);

            if ( this.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ) {
                logger.error('[AmneziaWG] Stealth tunnel declared dead after consecutive failures');
                this.connected = false;
                this.consecutiveFailures = 0;
                if ( this.onTunnelDown ) {
                    this.onTunnelDown();
                }
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    async disconnect (): Promise<void> {
        if ( this.healthTimer ) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }

        const confPath = join(this.awgDir, `${AWG_INTERFACE}.conf`);
        try {
            execSync(`${this.awgQuickCmd('down', confPath)} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/sh' });
        } catch {
            // May not be up
        }

        this.connected = false;
        logger.info('[AmneziaWG] Disconnected');
    }

    getAssignedIP (): string | null {
        return this.assignedIP;
    }

    getServerIP (): string | null {
        if ( ! this.serverEndpoint ) return null;
        return this.serverEndpoint.split(':')[0];
    }

    isConnected (): boolean {
        return this.connected;
    }

    getStatus (): AmneziaWGStatus {
        return {
            available: this._available === true,
            connected: this.connected,
            assignedIP: this.assignedIP,
            serverEndpoint: this.serverEndpoint,
            lastHandshake: null,
            transferRx: 0,
            transferTx: 0,
        };
    }

    private pingServer (serverIP: string): Promise<boolean> {
        const timeoutFlag = AmneziaWGService.isMacOS ? '-t 3' : '-W 3';
        return new Promise((resolve) => {
            exec(`ping -c 1 ${timeoutFlag} ${serverIP}`, { timeout: 5000 }, (error) => {
                resolve(!error);
            });
        });
    }

    private async getUsername (): Promise<string> {
        const usernamePath = join(this.config.dataDir, 'username.json');
        if ( existsSync(usernamePath) ) {
            try {
                const data = JSON.parse(readFileSync(usernamePath, 'utf8'));
                if ( data.username ) return data.username;
            } catch {
                // Fall through
            }
        }
        throw new Error('No username registered - register a username before enabling AmneziaWG');
    }

    /**
   * @deprecated v1.2.7.11 — use `findBinary` instead. This helper was kept
   * for one release cycle in case any external caller depended on it (none
   * currently do; it was internal-only). It now delegates to `findBinary`
   * so the bundled bin dir is always checked first; behaviour is otherwise
   * identical for paths it used to resolve.
   */
    private findTool (name: string): string | null {
        return this.findBinary(name, [
            `/usr/local/bin/${name}`,
            `/usr/bin/${name}`,
            `/opt/homebrew/bin/${name}`,
        ]);
    }
}
