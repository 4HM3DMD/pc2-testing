/**
 * FirstRunTokenStore (SEC-7, 2026-04 audit)
 *
 * In-memory single-use token store used as the remote-setup escape hatch
 * for the loopback lock on /api/setup/{info,mnemonic,acknowledge-mnemonic,
 * mnemonic-sign-message} and as a fallback for /api/access/claim-ownership
 * when no anti-snipe password has been set.
 *
 * Operational model:
 *   - On node startup, ONE token is minted and printed to journalctl/console.
 *   - The operator copies it from the log and uses it via the
 *     `X-First-Run-Token: <token>` header to drive remote setup once.
 *   - After verify() succeeds, the token is consumed (single-use, atomic).
 *   - Tokens are in-memory only, so a restart wipes them — this is a feature.
 *
 * Spec: pc2-node/tests/security/firstRunToken.test.js
 */

import { randomBytes } from 'crypto';

export class FirstRunTokenStore {
    private readonly tokens = new Set<string>();

    /**
   * Mint a fresh 256-bit (64 lowercase hex chars) single-use token.
   */
    mint (): string {
        const tok = randomBytes(32).toString('hex');
        this.tokens.add(tok);
        return tok;
    }

    /**
   * Verify a candidate token. Returns true ONCE per minted token; the
   * token is atomically removed on success. Returns false for non-string
   * input, unknown tokens, and previously-consumed tokens. Never throws.
   */
    verify (token: unknown): boolean {
        if ( typeof token !== 'string' || token.length === 0 ) return false;
        if ( ! this.tokens.has(token) ) return false;
        this.tokens.delete(token);
        return true;
    }

    /**
   * Number of unverified tokens currently held. Test/admin use only.
   */
    size (): number {
        return this.tokens.size;
    }

    /**
   * Wipe all unverified tokens. Test/admin use only.
   */
    clear (): void {
        this.tokens.clear();
    }
}

/**
 * Process-wide singleton. The first time this module is imported,
 * a single token is minted and the module exposes it via getBootToken().
 * The operator should arrange for this to be logged at startup.
 */
let bootToken: string | null = null;
export const firstRunTokenStore = new FirstRunTokenStore();

/**
 * Mint (or return the previously-minted) boot-time token. Idempotent
 * within one process — calling this twice returns the same token so
 * server.ts can log it without consuming or duplicating it.
 *
 * The token remains valid until either (a) someone uses it (single-use
 * verify consumes it) or (b) the process restarts.
 */
export function getOrMintBootToken (): string {
    if ( bootToken === null ) {
        bootToken = firstRunTokenStore.mint();
    }
    return bootToken;
}
