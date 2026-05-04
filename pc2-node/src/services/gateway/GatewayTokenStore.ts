/**
 * Gateway Provisioning-Token Store (PC2-node side).
 *
 * Wave 3 / SEC-INFRA-GW-AUTH (PC2 Security Triage 2026-04-21).
 * Counterpart to deploy/web-gateway/lib/provisioning-token.js.
 *
 * Per-gateway token storage
 *   PC2 nodes register the same username on multiple supernodes
 *   (primary + secondaries via dual-write). Each supernode mints its
 *   OWN provisioning token on first registration — they're independent.
 *   This store therefore persists a Map<gatewayBaseUrl, token> not a
 *   single global token.
 *
 * Storage
 *   $PC2_DATA/gateway-tokens.json
 *   File created with mode 0600 (owner-read/write only). The plaintext
 *   tokens are sensitive — anyone who reads this file can re-key the
 *   node's WG/awg/vless tunnel and delete its peers on the matching
 *   supernode. The file must NEVER ship in backups, logs, or commits.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

interface GatewayTokensFile {
    /** Map of normalised gateway base-URL -> plaintext provisioning token. */
    tokens: Record<string, string>;
}

/**
 * Normalises a gateway base URL so https://demo.ela.city, https://demo.ela.city/,
 * and https://demo.ela.city/api all key into the same store entry.
 */
function normaliseGatewayUrl (url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return url.replace(/\/+$/, '');
    }
}

export class GatewayTokenStore {
    private readonly storagePath: string;
    private cache: GatewayTokensFile;

    constructor (dataDir: string) {
        this.storagePath = join(dataDir, 'gateway-tokens.json');
        this.cache = this.load();
    }

    private load (): GatewayTokensFile {
        if ( ! existsSync(this.storagePath) ) {
            return { tokens: {} };
        }
        try {
            const raw = readFileSync(this.storagePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<GatewayTokensFile>;
            if ( parsed && typeof parsed === 'object' && parsed.tokens ) {
                return { tokens: { ...parsed.tokens } };
            }
        } catch ( err ) {
            logger.warn(`[GatewayTokenStore] Failed to parse ${this.storagePath}: ${err instanceof Error ? err.message : err}`);
        }
        return { tokens: {} };
    }

    private persist (): void {
        try {
            const tmp = `${this.storagePath}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
            renameSync(tmp, this.storagePath);
            try {
                chmodSync(this.storagePath, 0o600);
            } catch {
            }
        } catch ( err ) {
            logger.error(`[GatewayTokenStore] Failed to persist: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** Returns the stored token for this gateway, or null. */
    get (gatewayUrl: string): string | null {
        const key = normaliseGatewayUrl(gatewayUrl);
        return this.cache.tokens[key] ?? null;
    }

    /**
     * Persist a freshly minted token for this gateway. No-op if the same
     * token is already stored. Logs (without revealing the token) when a
     * new entry is written, so operators can audit token-mint events.
     */
    set (gatewayUrl: string, token: string): void {
        if ( typeof token !== 'string' || token.length === 0 ) return;
        const key = normaliseGatewayUrl(gatewayUrl);
        if ( this.cache.tokens[key] === token ) return;
        this.cache.tokens[key] = token;
        this.persist();
        logger.info(`[GatewayTokenStore] Stored provisioning token for ${key} (length=${token.length})`);
    }

    /**
     * Build headers for a gateway request. Returns the inbound headers
     * unchanged if no token is stored for the URL (callers will then
     * either be in legacy mode or be the very first /api/register call).
     */
    headersFor (gatewayUrl: string, base: Record<string, string> = {}): Record<string, string> {
        const token = this.get(gatewayUrl);
        if ( ! token ) return { ...base };
        return { ...base, 'X-Provisioning-Token': token };
    }
}
