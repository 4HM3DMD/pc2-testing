/**
 * VLESS Reality Service
 *
 * Manages a VLESS Reality tunnel (via sing-box) that wraps AmneziaWG traffic
 * in TLS mimicry. Used as Tier 3 transport when UDP is completely blocked.
 *
 * Architecture (chaining):
 *   Client AWG -> UDP -> sing-box client -> TCP/VLESS Reality -> sing-box server -> UDP -> AWG server
 *
 * DPI sees: TLS 1.3 handshake with www.microsoft.com (legitimate HTTPS)
 * Actual: AmneziaWG packets encapsulated via XUDP inside the VLESS tunnel
 *
 * Flow:
 *   1. Check if sing-box binary is installed
 *   2. Call supernode's /api/vless/register to get UUID + Reality credentials
 *   3. Generate sing-box client config (UDP tunnel: localhost:51822 -> supernode:51821)
 *   4. Start sing-box as a background process
 *   5. AmneziaWG then connects through 127.0.0.1:51822 instead of directly
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

export interface VLESSRealityConfig {
    dataDir: string;
    gatewayUrl: string;
    secondaryGatewayUrls?: string[];
    nodeId: string;
    localPort: number;
    gatewayTokenStore?: import('../gateway/GatewayTokenStore.js').GatewayTokenStore;
}

export interface VLESSProvisionResponse {
    uuid: string;
    serverEndpoint: string;
    serverPublicKey: string;
    shortId: string;
    serverName: string;
}

export interface VLESSRealityStatus {
    available: boolean;
    connected: boolean;
    serverEndpoint: string | null;
    tunnelLocalPort: number;
}

const VLESS_LOCAL_PORT = 51822;
const PROVISION_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_FAILURE_THRESHOLD = 3;

export class VLESSRealityService {
    private config: VLESSRealityConfig;
    private vlessDir: string;
    private provisionPath: string;
    private configPath: string;
    private process: ChildProcess | null = null;
    private connected = false;
    private serverEndpoint: string | null = null;
    private healthTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures = 0;
    private onTunnelDown: (() => void) | null = null;
    private _available: boolean | null = null;

    constructor (config: VLESSRealityConfig) {
        this.config = config;
        this.vlessDir = join(config.dataDir, 'vless-reality');
        this.provisionPath = join(this.vlessDir, 'provision.json');
        this.configPath = join(this.vlessDir, 'client.json');
    }

    isAvailable (): boolean {
        if ( this._available !== null ) return this._available;

        const found = this.findSingBoxSafe();
        if ( found ) {
            this._available = true;
            logger.info(`[VLESSReality] sing-box binary detected at ${found}`);
        } else {
            this._available = false;
            logger.debug('[VLESSReality] sing-box not installed');
        }

        return this._available;
    }

    /**
   * Attempt to locate sing-box without throwing.
   * Checks bundled binaries first, then system paths.
   */
    private findSingBoxSafe (): string | null {
        const bundledDir = join(typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)),
                        '..',
                        '..',
                        '..',
                        'bin',
                        `${process.platform}-${process.arch}`);
        const bundled = join(bundledDir, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
        if ( existsSync(bundled) ) return bundled;

        const systemPaths = ['/usr/local/bin/sing-box', '/opt/homebrew/bin/sing-box', '/usr/bin/sing-box'];
        for ( const p of systemPaths ) {
            if ( existsSync(p) ) return p;
        }

        if ( process.platform !== 'win32' ) {
            try {
                const found = execSync('which sing-box 2>/dev/null', { stdio: 'pipe', timeout: 3000 }).toString().trim();
                if ( found && existsSync(found) ) return found;
            } catch { /* not on PATH */ }
        }

        return null;
    }

    private async provision (): Promise<VLESSProvisionResponse> {
        if ( ! existsSync(this.vlessDir) ) {
            mkdirSync(this.vlessDir, { recursive: true });
        }

        if ( existsSync(this.provisionPath) ) {
            try {
                const cached = JSON.parse(readFileSync(this.provisionPath, 'utf8'));
                if ( cached.uuid && cached.serverEndpoint && cached.serverPublicKey ) {
                    logger.info('[VLESSReality] Using cached provision');
                    return cached;
                }
            } catch {
            }
        }

        const username = await this.getUsername();
        const gatewayUrls = [
            this.config.gatewayUrl,
            ...(this.config.secondaryGatewayUrls || []),
        ];

        let lastError: Error | null = null;

        for ( const gatewayUrl of gatewayUrls ) {
            const url = `${gatewayUrl}/api/vless/register`;
            logger.info(`[VLESSReality] Provisioning with ${url}`);

            // SEC-INFRA-GW-AUTH (Wave 3): same per-gateway provisioning token
            // pattern. The gateway also rejects any username that doesn't match
            // the strict regex now (SEC-2 defence-in-depth), so a malformed name
            // would fail with 400 here too.
            const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
            const headers = this.config.gatewayTokenStore
                ? this.config.gatewayTokenStore.headersFor(gatewayUrl, jsonHeaders)
                : jsonHeaders;

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ username, nodeId: this.config.nodeId }),
                    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
                });

                if ( ! response.ok ) {
                    const errorText = await response.text();
                    throw new Error(`Provision failed (${response.status}): ${errorText}`);
                }

                const data = await response.json() as VLESSProvisionResponse;
                writeFileSync(this.provisionPath, JSON.stringify(data, null, 2));
                logger.info(`[VLESSReality] Provisioned: endpoint=${data.serverEndpoint}, serverName=${data.serverName}`);
                return data;
            } catch ( err ) {
                lastError = err instanceof Error ? err : new Error(String(err));
                logger.warn(`[VLESSReality] Provisioning failed via ${gatewayUrl}: ${lastError.message}`);
            }
        }

        throw lastError || new Error('All VLESS Reality provisioning endpoints failed');
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
                logger.info('[VLESSReality] Provision cache cleared for failover');
            }
        } catch {
            // Non-critical
        }
    }

    async connect (): Promise<void> {
        if ( this.connected ) return;

        const provision = await this.provision();
        const [serverHost, serverPortStr] = provision.serverEndpoint.split(':');
        const serverPort = parseInt(serverPortStr, 10);

        this.forceCleanup();

        const clientConfig = {
            log: { level: 'warn' },
            inbounds: [{
                type: 'direct',
                tag: 'awg-tunnel-in',
                listen: '127.0.0.1',
                listen_port: VLESS_LOCAL_PORT,
                network: 'udp',
                sniff: false,
                sniff_override_destination: false,
                override_address: serverHost,
                override_port: 51821,
            }],
            outbounds: [{
                type: 'vless',
                tag: 'vless-out',
                server: serverHost,
                server_port: serverPort,
                uuid: provision.uuid,
                packet_encoding: 'xudp',
                tls: {
                    enabled: true,
                    server_name: provision.serverName,
                    utls: { enabled: true, fingerprint: 'chrome' },
                    reality: {
                        enabled: true,
                        public_key: provision.serverPublicKey,
                        short_id: provision.shortId,
                    },
                },
            }],
            route: { final: 'vless-out' },
        };

        if ( ! existsSync(this.vlessDir) ) {
            mkdirSync(this.vlessDir, { recursive: true });
        }
        writeFileSync(this.configPath, JSON.stringify(clientConfig, null, 2));

        const singboxPath = this.findSingBox();
        logger.info(`[VLESSReality] Starting sing-box tunnel: localhost:${VLESS_LOCAL_PORT} -> ${serverHost}:51821 via VLESS Reality`);

        this.process = spawn(singboxPath, ['run', '-c', this.configPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        this.process.on('exit', (code) => {
            logger.warn(`[VLESSReality] sing-box process exited with code ${code}`);
            if ( this.connected ) {
                this.connected = false;
                this.onTunnelDown?.();
            }
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if ( msg ) logger.debug(`[VLESSReality] sing-box: ${msg}`);
        });

        await new Promise(resolve => setTimeout(resolve, 1500));

        if ( this.process.exitCode !== null ) {
            throw new Error(`sing-box failed to start (exit code: ${this.process.exitCode})`);
        }

        const portReady = this.checkLocalPort();
        if ( ! portReady ) {
            this.killProcess();
            throw new Error('sing-box started but local tunnel port not ready');
        }

        this.connected = true;
        this.serverEndpoint = provision.serverEndpoint;
        logger.info('[VLESSReality] Tunnel established');
    }

    async disconnect (): Promise<void> {
        if ( this.healthTimer ) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        this.killProcess();
        this.connected = false;
        this.consecutiveFailures = 0;
    }

    private killProcess (): void {
        if ( this.process ) {
            try {
                this.process.kill('SIGTERM');
                setTimeout(() => {
                    try {
                        this.process?.kill('SIGKILL');
                    } catch {
                    }
                }, 3000);
            } catch {
            }
            this.process = null;
        }
    }

    forceCleanup (): void {
        try {
            execSync('killall sing-box 2>/dev/null', { stdio: 'pipe' });
        } catch {
        }
    }

    setOnTunnelDown (callback: () => void): void {
        this.onTunnelDown = callback;
    }

    startHealthCheck (): void {
        if ( this.healthTimer ) clearInterval(this.healthTimer);
        this.consecutiveFailures = 0;

        this.healthTimer = setInterval(() => {
            if ( !this.connected || !this.process ) return;

            if ( this.process.exitCode !== null ) {
                this.consecutiveFailures = HEALTH_FAILURE_THRESHOLD;
            } else if ( ! this.checkLocalPort() ) {
                this.consecutiveFailures++;
            } else {
                this.consecutiveFailures = 0;
            }

            if ( this.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ) {
                logger.error(`[VLESSReality] Health check failed ${this.consecutiveFailures} times -- tunnel down`);
                this.connected = false;
                if ( this.healthTimer ) {
                    clearInterval(this.healthTimer);
                    this.healthTimer = null;
                }
                this.onTunnelDown?.();
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    isConnected (): boolean {
        return this.connected;
    }

    getTunnelLocalPort (): number {
        return VLESS_LOCAL_PORT;
    }

    getStatus (): VLESSRealityStatus {
        return {
            available: this.isAvailable(),
            connected: this.connected,
            serverEndpoint: this.serverEndpoint,
            tunnelLocalPort: VLESS_LOCAL_PORT,
        };
    }

    private checkLocalPort (): boolean {
        try {
            const platform = process.platform;
            if ( platform === 'darwin' ) {
                execSync(`lsof -i UDP:${VLESS_LOCAL_PORT} -P -n | grep sing-box`, { stdio: 'pipe', timeout: 3000 });
            } else {
                execSync(`ss -ulnp | grep ${VLESS_LOCAL_PORT}`, { stdio: 'pipe', timeout: 3000 });
            }
            return true;
        } catch {
            return false;
        }
    }

    private findSingBox (): string {
        const found = this.findSingBoxSafe();
        if ( found ) return found;
        throw new Error('sing-box binary not found');
    }

    private async getUsername (): Promise<string> {
        try {
            const usernamePath = join(this.config.dataDir, 'username.json');
            if ( existsSync(usernamePath) ) {
                const data = JSON.parse(readFileSync(usernamePath, 'utf8'));
                return data.username || 'unknown';
            }
        } catch {
        }
        return 'unknown';
    }
}
