/**
 * WireGuard Service
 *
 * Manages a WireGuard tunnel to the PC2 supernode for high-performance
 * NAT traversal. When available, this replaces the Boson ActiveProxy relay
 * with a kernel-level encrypted UDP tunnel that delivers near-localhost speed.
 *
 * Flow:
 *   1. Check if WireGuard tools are installed on the system
 *   2. Generate or load a persistent keypair
 *   3. Call the supernode's provisioning API to receive an IP assignment
 *   4. Configure and bring up the wg0 interface
 *   5. Periodically verify tunnel health via ping
 *   6. Register http://<wg-ip>:4200 with the gateway
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';
import { checkWireGuardPermissions, setupWireGuardSudoers, getManualSetupInstructions } from './setupPermissions.js';

export interface WireGuardConfig {
    dataDir: string;
    gatewayUrl: string;
    secondaryGatewayUrls?: string[];
    nodeId: string;
    localPort: number;
    gatewayTokenStore?: import('../gateway/GatewayTokenStore.js').GatewayTokenStore;
}

export interface WGProvisionResponse {
    assignedIP: string;
    serverPublicKey: string;
    serverEndpoint: string;
    serverIP: string;
}

export type WireGuardMode = 'kernel' | 'userspace' | 'none';

export interface WireGuardStatus {
    available: boolean;
    mode: WireGuardMode;
    connected: boolean;
    assignedIP: string | null;
    serverEndpoint: string | null;
    lastHandshake: number | null;
    transferRx: number;
    transferTx: number;
}

const WG_INTERFACE = 'wg0';
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const PROVISION_TIMEOUT_MS = 10_000;
const HEALTH_FAILURE_THRESHOLD = 3;

export class WireGuardService {
    private config: WireGuardConfig;
    private wgDir: string;
    private privateKeyPath: string;
    private publicKeyPath: string;
    private provisionPath: string;
    private assignedIP: string | null = null;
    private serverEndpoint: string | null = null;
    private connected = false;
    private externalInterface = false;
    private healthTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures = 0;
    private onTunnelDown: (() => void) | null = null;
    private _mode: WireGuardMode = 'none';

    constructor (config: WireGuardConfig) {
        this.config = config;
        this.wgDir = join(config.dataDir, 'wireguard');
        this.privateKeyPath = join(this.wgDir, 'private.key');
        this.publicKeyPath = join(this.wgDir, 'public.key');
        this.provisionPath = join(this.wgDir, 'provision.json');
    }

    private static isMacOS = process.platform === 'darwin';
    private static isWindows = process.platform === 'win32';

    private wgBinPath: string | null = null;
    private wgQuickBinPath: string | null = null;
    private wgGoBinPath: string | null = null;
    private _sudoConfigured = false;
    // v1.2.7.9: track whether we've already shown the macOS sudoers auth dialog
    // this session. Without this flag we'd re-prompt on every reconnect attempt
    // (e.g. when scheduleEndpointFreshnessCheck triggers a retry), spamming the
    // user. Resets on pc2-node restart so a previously-declined user gets a
    // fresh chance after relaunching.
    private _permissionPromptAttempted = false;

    /**
   * Resolve the bundled binaries directory for the current platform.
   * Binaries ship at pc2-node/bin/{platform}-{arch}/ alongside the app.
   */
    private static getBundledBinDir (): string {
        const thisFile = typeof __dirname !== 'undefined'
            ? __dirname
            : dirname(fileURLToPath(import.meta.url));
        // From src/services/wireguard/ → ../../.. → pc2-node root
        const appRoot = join(thisFile, '..', '..', '..');
        return join(appRoot, 'bin', `${process.platform}-${process.arch}`);
    }

    /**
   * Find a binary by checking bundled path first, then well-known system paths.
   * On Windows, also checks Program Files and common install locations.
   */
    private findBinary (name: string, extraPaths: string[] = []): string | null {
        const bundled = join(WireGuardService.getBundledBinDir(), WireGuardService.isWindows ? `${name}.exe` : name);
        if ( existsSync(bundled) ) return bundled;

        for ( const p of extraPaths ) {
            if ( existsSync(p) ) return p;
        }

        if ( ! WireGuardService.isWindows ) {
            try {
                const found = execSync(`which ${name} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/sh' }).toString().trim();
                if ( found && existsSync(found) ) return found;
            } catch { /* not on PATH */ }
        }

        return null;
    }

    /**
   * Check if WireGuard tools are available on this system.
   *
   * Search order:
   *   1. Bundled binaries (pc2-node/bin/{platform}-{arch}/)
   *   2. Platform-specific well-known paths (Program Files, Homebrew, /usr/bin)
   *   3. System PATH via `which`
   *
   * On Windows, uses wireguard.exe /installtunnelservice instead of wg-quick.
   */
    isAvailable (): boolean {
        if ( WireGuardService.isWindows ) {
            return this.detectWindowsWireGuard();
        }

        const wgExtraPaths = [
            '/usr/bin/wg', '/usr/local/bin/wg',
            '/opt/homebrew/bin/wg', '/usr/sbin/wg',
        ];
        const wgQuickExtraPaths = [
            '/usr/bin/wg-quick', '/usr/local/bin/wg-quick',
            '/opt/homebrew/bin/wg-quick', '/usr/sbin/wg-quick',
        ];

        this.wgBinPath = this.findBinary('wg', wgExtraPaths);
        this.wgQuickBinPath = this.findBinary('wg-quick', wgQuickExtraPaths);

        if ( !this.wgBinPath || !this.wgQuickBinPath ) {
            logger.info(`[WireGuard] Tools not found (wg: ${this.wgBinPath ? 'found' : 'missing'}, wg-quick: ${this.wgQuickBinPath ? 'found' : 'missing'})`);
            this._mode = 'none';
            return false;
        }

        logger.info(`[WireGuard] Found wg: ${this.wgBinPath}`);
        logger.info(`[WireGuard] Found wg-quick: ${this.wgQuickBinPath}`);

        this._mode = this.detectMode();

        if ( this._mode !== 'none' ) {
            const perms = checkWireGuardPermissions(this.wgQuickBinPath!);
            this._sudoConfigured = perms.sudoConfigured;
            if ( ! perms.sudoConfigured ) {
                logger.warn(`[WireGuard] ${perms.message}`);
            }
        }

        return this._mode !== 'none';
    }

    get sudoConfigured (): boolean {
        return this._sudoConfigured;
    }
    get mode (): WireGuardMode {
        return this._mode;
    }
    get resolvedWgPath (): string | null {
        return this.wgBinPath;
    }
    get resolvedWgQuickPath (): string | null {
        return this.wgQuickBinPath;
    }
    get resolvedWgGoPath (): string | null {
        return this.wgGoBinPath;
    }

    /**
   * Attempt to install sudoers entries so wg-quick can run without a password prompt.
   * On macOS this shows a native authorization dialog; on Linux it tries sudo tee.
   */
    async setupPermissions (): Promise<{ success: boolean; message: string }> {
        if ( WireGuardService.isWindows || this._sudoConfigured ) {
            return { success: true, message: 'Already configured' };
        }
        if ( ! this.wgQuickBinPath ) {
            return { success: false, message: 'wg-quick binary not found' };
        }
        const result = await setupWireGuardSudoers(this.wgQuickBinPath, this.wgGoBinPath || undefined);
        if ( result.success ) this._sudoConfigured = true;
        return result;
    }

    /**
   * Get human-readable manual instructions for setting up sudo permissions.
   */
    getPermissionInstructions (): string {
        return getManualSetupInstructions(this.wgQuickBinPath || 'wg-quick',
                        this.wgGoBinPath || undefined);
    }

    /**
   * Detect WireGuard on Windows. Checks:
   *   - Bundled bin/win32-x64/wg.exe
   *   - Standard install at C:\Program Files\WireGuard\wg.exe
   *   - User-installed at %LOCALAPPDATA%\WireGuard\
   */
    private detectWindowsWireGuard (): boolean {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const localAppData = process.env.LOCALAPPDATA || '';

        const winWgPaths = [
            join(programFiles, 'WireGuard', 'wg.exe'),
            ...(localAppData ? [join(localAppData, 'WireGuard', 'wg.exe')] : []),
        ];

        this.wgBinPath = this.findBinary('wg', winWgPaths);

        if ( ! this.wgBinPath ) {
            logger.info('[WireGuard] Windows: wg.exe not found');
            this._mode = 'none';
            return false;
        }

        // On Windows, wireguard.exe (tunnel service manager) should be alongside wg.exe
        const wgDir = dirname(this.wgBinPath);
        const wireguardExe = join(wgDir, 'wireguard.exe');
        if ( existsSync(wireguardExe) ) {
            this.wgQuickBinPath = wireguardExe;
        }

        logger.info(`[WireGuard] Windows: found wg.exe at ${this.wgBinPath}`);
        this._mode = 'userspace';
        return true;
    }

    /**
   * Determine whether WireGuard will use the kernel module or userspace.
   *
   * - macOS: always userspace (uses built-in utun driver via wg-quick)
   * - Linux: kernel module preferred, wireguard-go as fallback
   */
    private detectMode (): WireGuardMode {
        if ( WireGuardService.isMacOS ) {
            logger.info('[WireGuard] macOS detected, using userspace mode (utun driver)');
            return 'userspace';
        }

        // Linux: check if kernel module is already loaded
        try {
            const result = execSync('lsmod 2>/dev/null | grep -q wireguard && echo yes || echo no', {
                stdio: 'pipe', shell: '/bin/sh',
            }).toString().trim();
            if ( result === 'yes' ) return 'kernel';
        } catch {
            // lsmod unavailable
        }

        // Check if kernel module exists (loadable or built-in) without requiring root.
        try {
            execSync('modinfo wireguard 2>/dev/null', { stdio: 'pipe' });
            return 'kernel';
        } catch {
            // Module not found -- expected on Jetson with NVIDIA custom kernel
        }

        // Fall back to userspace if wireguard-go is installed (bundled or system)
        this.wgGoBinPath = this.findBinary('wireguard-go', [
            '/usr/local/bin/wireguard-go', '/usr/bin/wireguard-go',
        ]);
        if ( this.wgGoBinPath ) {
            logger.info(`[WireGuard] Kernel module unavailable, using wireguard-go at ${this.wgGoBinPath}`);
            return 'userspace';
        }

        logger.warn('[WireGuard] Neither kernel module nor wireguard-go available');
        return 'none';
    }

    /**
   * Build a command string to bring WireGuard interfaces up/down.
   *
   * - macOS: `sudo <wg-quick-path> up <conf>` (utun driver, no env var needed)
   * - Linux kernel: `sudo <wg-quick-path> up <conf>`
   * - Linux userspace: `WG_QUICK_USERSPACE_IMPLEMENTATION=<wireguard-go-path> sudo -E <wg-quick-path> up <conf>`
   * - Windows: `<wireguard.exe> /installtunnelservice <conf>` (runs as SYSTEM, no sudo)
   */
    private wgQuickCmd (action: 'up' | 'down', confPath: string): string {
        const wqPath = this.wgQuickBinPath || 'wg-quick';

        if ( WireGuardService.isWindows ) {
            const winAction = action === 'up' ? '/installtunnelservice' : '/uninstalltunnelservice';
            return `"${wqPath}" ${winAction} "${confPath}"`;
        }

        if ( this._mode === 'userspace' && !WireGuardService.isMacOS ) {
            const wgGoPath = this.wgGoBinPath || 'wireguard-go';
            return `WG_QUICK_USERSPACE_IMPLEMENTATION=${wgGoPath} sudo -E ${wqPath} ${action} ${confPath}`;
        }
        return `sudo ${wqPath} ${action} ${confPath}`;
    }

    /**
   * Generate or load a persistent WireGuard keypair.
   * Keys are stored in the node's data directory and survive reboots.
   */
    ensureKeypair (): { publicKey: string; privateKey: string } {
        if ( ! existsSync(this.wgDir) ) {
            mkdirSync(this.wgDir, { recursive: true });
        }

        if ( existsSync(this.privateKeyPath) && existsSync(this.publicKeyPath) ) {
            return {
                privateKey: readFileSync(this.privateKeyPath, 'utf8').trim(),
                publicKey: readFileSync(this.publicKeyPath, 'utf8').trim(),
            };
        }

        logger.info('[WireGuard] Generating new keypair...');
        const wgBin = this.wgBinPath || 'wg';
        const shellOpt = WireGuardService.isWindows ? 'cmd.exe' : '/bin/sh';
        const privateKey = execSync(`"${wgBin}" genkey`, { stdio: 'pipe', shell: shellOpt }).toString().trim();
        const publicKey = execSync(`echo "${privateKey}" | "${wgBin}" pubkey`, {
            stdio: 'pipe',
            shell: shellOpt,
        }).toString().trim();

        writeFileSync(this.privateKeyPath, `${privateKey }\n`, { mode: 0o600 });
        writeFileSync(this.publicKeyPath, `${publicKey }\n`, { mode: 0o644 });
        logger.info(`[WireGuard] Keypair generated (pubkey: ${publicKey.slice(0, 8)}...)`);

        return { publicKey, privateKey };
    }

    /**
   * Register with the supernode's WireGuard provisioning API.
   * Returns connection parameters (assigned IP, server public key, endpoint).
   *
   * Caches provisioning result to disk so a restart doesn't re-allocate IPs.
   * Tries primary gateway first, then secondary gateways on failure (sequential failover).
   */
    async provision (): Promise<WGProvisionResponse> {
        const { publicKey } = this.ensureKeypair();

        if ( existsSync(this.provisionPath) ) {
            try {
                const cached = JSON.parse(readFileSync(this.provisionPath, 'utf8')) as WGProvisionResponse;
                if ( cached.assignedIP && cached.serverPublicKey && cached.serverEndpoint ) {
                    logger.info(`[WireGuard] Using cached provision: ${cached.assignedIP}`);
                    return cached;
                }
            } catch {
                logger.warn('[WireGuard] Invalid cached provision, re-provisioning...');
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
            const url = `${gatewayUrl}/api/wg/register`;
            logger.info(`[WireGuard] Provisioning via ${url}...`);

            // SEC-INFRA-GW-AUTH (Wave 3): inject the per-gateway provisioning
            // token. If absent the call goes through unauthenticated and the
            // gateway will either log-only-warn (default) or 401 (strict).
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
                    throw new Error(`Provisioning failed (${response.status}): ${errBody}`);
                }

                const data = await response.json() as WGProvisionResponse;
                if ( !data.assignedIP || !data.serverPublicKey || !data.serverEndpoint ) {
                    throw new Error('Invalid provisioning response');
                }

                writeFileSync(this.provisionPath, JSON.stringify(data, null, 2));
                logger.info(`[WireGuard] Provisioned: ${data.assignedIP} via ${data.serverEndpoint}`);
                return data;
            } catch ( err ) {
                lastError = err instanceof Error ? err : new Error(String(err));
                logger.warn(`[WireGuard] Provisioning failed via ${gatewayUrl}: ${lastError.message}`);
            }
        }

        throw lastError || new Error('All WireGuard provisioning endpoints failed');
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
                logger.info('[WireGuard] Provision cache cleared for failover');
            }
        } catch {
            // Non-critical
        }
    }

    /**
   * Configure and bring up the WireGuard interface.
   *
   * First checks if wg0 is already running (e.g. brought up by setup-wireguard-client.sh
   * as root). If so, reuses the existing tunnel without provisioning, which avoids
   * overwriting the registered public key on the supernode with a different keypair.
   *
   * If the interface is not up, provisions with the supernode API, creates a
   * wg-quick config, and activates the tunnel.
   */
    async connect (provision?: WGProvisionResponse): Promise<void> {
    // Check if the interface is already up (e.g. brought up by setup script as root).
    // If so, skip provisioning entirely to avoid overwriting the registered key
    // with a different keypair from the node's data directory.
        const running = this.getRunningInterfaceInfo();
        if ( running ) {
            logger.info(`[WireGuard] Interface ${WG_INTERFACE} already up with ${running.assignedIP} -- reusing`);
            this.assignedIP = running.assignedIP;
            this.serverEndpoint = running.serverEndpoint;
            this.connected = true;
            this.externalInterface = true;

            const reachable = await this.pingServer(running.serverIP);
            if ( reachable ) {
                logger.info('[WireGuard] Tunnel verified - server reachable');
            } else {
                logger.warn('[WireGuard] Interface up but server not reachable via ping (may be filtered)');
            }
            return;
        }

        // Interface not up -- proceed with provisioning and setup
        if ( ! provision ) {
            provision = await this.provision();
        }

        const { privateKey } = this.ensureKeypair();
        const confPath = join(this.wgDir, `${WG_INTERFACE}.conf`);

        const conf = [
            '[Interface]',
            `Address = ${provision.assignedIP}/32`,
            `PrivateKey = ${privateKey}`,
            '',
            '[Peer]',
            `PublicKey = ${provision.serverPublicKey}`,
            `Endpoint = ${provision.serverEndpoint}`,
            `AllowedIPs = ${provision.serverIP}/32`,
            'PersistentKeepalive = 25',
        ].join('\n');

        writeFileSync(confPath, `${conf }\n`, { mode: 0o600 });

        try {
            execSync(`${this.wgQuickCmd('down', confPath)} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/sh' });
        } catch {
            // Interface may not be up
        }

        // v1.2.7.9: auto-trigger macOS sudoers install on first connect attempt.
        //
        // Background: wg-quick on macOS needs root to create the utun device and
        // write routes. wgQuickCmd() returns `sudo wg-quick up <conf>`. Since
        // pc2-node runs headless under pm2 (no TTY, no askpass program), the
        // sudo invocation fails immediately with "a terminal is required to read
        // the password" — wg-quick never runs, the cascade silently falls to
        // ActiveProxy. Every Mac user installing PC2 hit this from v1.2.7.0
        // through v1.2.7.8 even after we shipped the missing wg/wg-quick binaries
        // because the binaries alone don't help if sudo can't authorise.
        //
        // The fix: before the bring-up, if we're on macOS and sudoers isn't
        // configured, await setupPermissions() which uses `osascript ... with
        // administrator privileges` to show a native macOS auth dialog. The user
        // enters their login password once; we install a sudoers.d drop-in
        // scoped to BOTH bundled wg-quick AND awg-quick (see
        // setupPermissions.ts:buildSudoersEntry — single prompt unlocks
        // WireGuard, AmneziaWG, and transitively VLESS Reality which tunnels
        // through AWG). sudo then works without password and the bring-up
        // below succeeds.
        //
        // Linux is excluded because setupLinux() uses `sudo tee` which requires
        // an existing sudo session and has no GUI fallback — would hang headless.
        // Linux users are guided to the in-app /api/wireguard/setup-permissions
        // endpoint or the manual instructions from getPermissionInstructions().
        //
        // Failure modes:
        //   - User dismisses the dialog → log warning, fall through to wg-quick up
        //     which will fail with the original "no terminal" error → cascade
        //     moves to next transport. Same behaviour as before this fix.
        //   - osascript itself fails (e.g. headless Mac mini server, no
        //     WindowServer) → setupMacOS() resolves with success: false, same
        //     fall-through. No regression vs. pre-v1.2.7.9.
        //   - User grants → _sudoConfigured flips true, wg-quick up succeeds.
        if (
            WireGuardService.isMacOS
            && !this._sudoConfigured
            && !this._permissionPromptAttempted
        ) {
            this._permissionPromptAttempted = true;
            logger.info('[WireGuard] macOS sudoers entry missing; prompting user via osascript admin dialog');
            const result = await this.setupPermissions();
            if (result.success) {
                logger.info('[WireGuard] Sudoers entry installed; proceeding with bring-up');
            } else {
                logger.warn(`[WireGuard] Sudoers install declined or failed: ${result.message}`);
                // Fall through. wg-quick up will fail without sudo and the
                // cascade will move on to the next transport.
            }
        }

        try {
            execSync(this.wgQuickCmd('up', confPath), { stdio: 'pipe', timeout: 15_000, shell: '/bin/sh' });
        } catch ( error: unknown ) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to bring up WireGuard interface: ${msg}`);
        }

        this.assignedIP = provision.assignedIP;
        this.serverEndpoint = provision.serverEndpoint;
        this.connected = true;
        this.externalInterface = false;

        logger.info(`[WireGuard] Interface ${WG_INTERFACE} up (${this._mode} mode): ${provision.assignedIP}`);

        const reachable = await this.pingServer(provision.serverIP);
        if ( ! reachable ) {
            logger.warn('[WireGuard] Server not reachable through tunnel (may need a moment to establish)');
        } else {
            logger.info('[WireGuard] Tunnel verified - server reachable');
        }
    }

    /**
   * Read the current state of the WireGuard interface.
   * Returns connection info if an interface is up with a valid 10.100.x.x IP,
   * or null if no WireGuard interface is active.
   *
   * On Linux: checks wg0 via `ip addr show`
   * On macOS: uses `wg show` to find the active interface, then `ifconfig`
   */
    private getRunningInterfaceInfo (): { assignedIP: string; serverPublicKey: string; serverEndpoint: string; serverIP: string } | null {
        try {
            let assignedIP: string | null = null;
            let iface = WG_INTERFACE;

            if ( WireGuardService.isMacOS ) {
                // On macOS, wg show interfaces lists active WireGuard interface names (utunN)
                const interfaces = execSync('wg show interfaces 2>/dev/null', { stdio: 'pipe' }).toString().trim();
                if ( ! interfaces ) return null;
                iface = interfaces.split(/\s+/)[0];

                const ifconfigOutput = execSync(`ifconfig ${iface} 2>/dev/null`, { stdio: 'pipe' }).toString();
                const ipMatch = ifconfigOutput.match(/inet (10\.100\.\d+\.\d+)/);
                if ( ! ipMatch ) return null;
                assignedIP = ipMatch[1];
            } else {
                const addrOutput = execSync(`ip addr show ${WG_INTERFACE} 2>/dev/null`, { stdio: 'pipe' }).toString();
                const ipMatch = addrOutput.match(/inet (10\.100\.\d+\.\d+)/);
                if ( ! ipMatch ) return null;
                assignedIP = ipMatch[1];
            }

            const wgOutput = execSync(`wg show ${iface} 2>/dev/null`, { stdio: 'pipe' }).toString();
            const peerKeyMatch = wgOutput.match(/peer:\s+(\S+)/);
            const endpointMatch = wgOutput.match(/endpoint:\s+(\S+)/);
            if ( !peerKeyMatch || !endpointMatch ) return null;

            const serverEndpoint = endpointMatch[1];
            const serverIP = serverEndpoint.split(':')[0];

            return {
                assignedIP,
                serverPublicKey: peerKeyMatch[1],
                serverEndpoint,
                serverIP,
            };
        } catch {
            return null;
        }
    }

    /**
   * Register a callback that fires when the tunnel is declared dead.
   * ConnectivityService uses this to fall back to Boson and schedule retry.
   */
    setOnTunnelDown (callback: () => void): void {
        this.onTunnelDown = callback;
    }

    /**
   * Start periodic health monitoring.
   * Pings the supernode through the tunnel every 30s.
   * Requires HEALTH_FAILURE_THRESHOLD consecutive failures before declaring
   * the tunnel dead -- a single dropped ping (network blip) won't kill it.
   */
    startHealthCheck (serverIP: string): void {
        if ( this.healthTimer ) return;
        this.consecutiveFailures = 0;

        this.healthTimer = setInterval(async () => {
            if ( ! this.connected ) return;

            const ok = await this.pingServer(serverIP);
            if ( ok ) {
                if ( this.consecutiveFailures > 0 ) {
                    logger.info(`[WireGuard] Health check recovered after ${this.consecutiveFailures} failure(s)`);
                }
                this.consecutiveFailures = 0;
                return;
            }

            this.consecutiveFailures++;
            logger.warn(`[WireGuard] Health check failed (${this.consecutiveFailures}/${HEALTH_FAILURE_THRESHOLD})`);

            if ( this.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ) {
                logger.error('[WireGuard] Tunnel declared dead after consecutive failures');
                this.connected = false;
                this.consecutiveFailures = 0;
                if ( this.onTunnelDown ) {
                    this.onTunnelDown();
                }
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    /**
   * Tear down the WireGuard interface.
   * Skips teardown if the interface was brought up externally (e.g. by the
   * setup script as root) since the node process likely lacks permissions.
   */
    async disconnect (): Promise<void> {
        if ( this.healthTimer ) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }

        if ( ! this.externalInterface ) {
            const confPath = join(this.wgDir, `${WG_INTERFACE}.conf`);
            try {
                execSync(`${this.wgQuickCmd('down', confPath)} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/sh' });
            } catch {
                // May not be up
            }
        } else {
            logger.info('[WireGuard] Skipping interface teardown (externally managed)');
        }

        this.connected = false;
        this.externalInterface = false;
        logger.info('[WireGuard] Disconnected');
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

    getStatus (): WireGuardStatus {
        const status: WireGuardStatus = {
            available: this._mode !== 'none',
            mode: this._mode,
            connected: this.connected,
            assignedIP: this.assignedIP,
            serverEndpoint: this.serverEndpoint,
            lastHandshake: null,
            transferRx: 0,
            transferTx: 0,
        };

        if ( this.connected ) {
            try {
                const iface = this.getActiveInterface();
                const dump = execSync(`wg show ${iface} dump`, { stdio: 'pipe' }).toString();
                const lines = dump.trim().split('\n');
                if ( lines.length > 1 ) {
                    const parts = lines[1].split('\t');
                    status.lastHandshake = parts[4] ? parseInt(parts[4], 10) : null;
                    status.transferRx = parts[5] ? parseInt(parts[5], 10) : 0;
                    status.transferTx = parts[6] ? parseInt(parts[6], 10) : 0;
                }
            } catch {
                // wg show may fail if interface is down
            }
        }

        return status;
    }

    /**
   * Get the name of the active WireGuard interface.
   * On Linux this is always 'wg0'; on macOS it's a utunN interface.
   */
    private getActiveInterface (): string {
        if ( WireGuardService.isMacOS ) {
            try {
                const interfaces = execSync('wg show interfaces 2>/dev/null', { stdio: 'pipe' }).toString().trim();
                if ( interfaces ) return interfaces.split(/\s+/)[0];
            } catch { /* fall through */ }
        }
        return WG_INTERFACE;
    }

    /**
   * Ping the server IP through the tunnel to verify connectivity.
   * macOS uses -t for timeout in seconds; Linux uses -W.
   */
    private pingServer (serverIP: string): Promise<boolean> {
        const timeoutFlag = WireGuardService.isMacOS ? '-t 3' : '-W 3';
        return new Promise((resolve) => {
            exec(`ping -c 1 ${timeoutFlag} ${serverIP}`, { timeout: 5000 }, (error) => {
                resolve(!error);
            });
        });
    }

    /**
   * Read the username from the stored username.json in the data directory.
   * The UsernameService manages this file.
   */
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
        throw new Error('No username registered - register a username before enabling WireGuard');
    }
}
