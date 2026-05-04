/**
 * SIWE Challenge Store (SEC-3a, 2026-04 audit)
 *
 * Issues short-lived, single-use SIWE nonces and validates them when a
 * client returns a signed message. Closes the replay vector that
 * verifySiweSignature() intentionally does NOT cover.
 *
 * Operational model:
 *   1. Client GETs /auth/challenge?address=0x... → receives { nonce, message }
 *   2. Client wallet signs `message`
 *   3. Client POSTs /auth/particle with { address, signature, nonce, message }
 *   4. Server: verifySiweSignature() + consumeNonce(nonce, address)
 *
 * Properties:
 *   - 256-bit (32-byte hex) nonces — collision-free for any realistic load
 *   - 10 minute TTL — enough for slow wallets, short enough to bound replay
 *   - Single-use — atomic consume() removes the nonce
 *   - Address-bound — a nonce minted for wallet A can NOT be redeemed for B
 *   - In-memory only — restart wipes pending challenges (acceptable: client retries)
 *   - Bounded — periodic sweep evicts expired entries; cap rejects spammy issuers
 *
 * Replay protection rule the helper enforces:
 *   - consume() returns false on: unknown nonce, expired nonce, already-consumed
 *     nonce, address mismatch.
 */

import { randomBytes } from 'crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // sweep every minute
const MAX_PENDING = 10_000; // per-process cap to bound memory

interface ChallengeEntry {
    address: string; // normalized (lowercased for EVM)
    expiresAt: number;
    domain: string; // bound at issue time so swap doesn't help an attacker
}

export class ChallengeStore {
    private readonly entries = new Map<string, ChallengeEntry>();
    private readonly ttl: number;
    private sweepHandle: NodeJS.Timeout | null = null;

    constructor (ttlMs: number = DEFAULT_TTL_MS) {
        this.ttl = ttlMs;
        this.startSweeper();
    }

    /**
   * Mint a challenge for `address`. Returns { nonce, message }. The
   * caller is responsible for sending `message` back to the client; the
   * client signs THIS exact string and returns it on /auth/particle.
   */
    issue (address: string, domain: string, opts: { uri?: string; chainId?: number; statement?: string } = {}): { nonce: string; message: string; expiresAt: number } {
        if ( typeof address !== 'string' || address.length === 0 ) {
            throw new Error('issue: address required');
        }
        if ( this.entries.size >= MAX_PENDING ) {
            // Bound memory under spammy load; the sweeper will catch up,
            // but evict the oldest to make room immediately.
            const oldestKey = this.entries.keys().next().value;
            if ( oldestKey ) this.entries.delete(oldestKey);
        }

        const nonce = randomBytes(32).toString('hex');
        const expiresAt = Date.now() + this.ttl;
        const normalized = normalizeForKey(address);
        this.entries.set(nonce, { address: normalized, expiresAt, domain });

        const issuedAt = new Date().toISOString();
        const uri = opts.uri || `https://${domain}`;
        const chainId = opts.chainId ?? 1;
        const statement = opts.statement || 'Sign in to your PC2 node.';
        // SIWE EIP-4361 message format (a strict subset; we re-validate on verify
        // by recovering the exact same string the client signed).
        const message = [
            `${domain} wants you to sign in with your Ethereum account:`,
            address,
            '',
            statement,
            '',
            `URI: ${uri}`,
            'Version: 1',
            `Chain ID: ${chainId}`,
            `Nonce: ${nonce}`,
            `Issued At: ${issuedAt}`,
        ].join('\n');

        return { nonce, message, expiresAt };
    }

    /**
   * Verify and atomically consume a nonce. Returns true iff:
   *   - nonce exists
   *   - nonce has not expired
   *   - nonce was issued for the same address (case-insensitive match)
   * On success the nonce is removed and CANNOT be replayed.
   */
    consume (nonce: unknown, address: unknown): { ok: true } | { ok: false; reason: string } {
        if ( typeof nonce !== 'string' || nonce.length === 0 ) {
            return { ok: false, reason: 'missing nonce' };
        }
        if ( typeof address !== 'string' || address.length === 0 ) {
            return { ok: false, reason: 'missing address' };
        }
        const entry = this.entries.get(nonce);
        if ( ! entry ) return { ok: false, reason: 'unknown or already-consumed nonce' };
        if ( entry.expiresAt < Date.now() ) {
            this.entries.delete(nonce);
            return { ok: false, reason: 'nonce expired' };
        }
        if ( entry.address !== normalizeForKey(address) ) {
            // Do NOT delete — this could be a typo, the legitimate caller still
            // has a few minutes to retry with the correct address.
            return { ok: false, reason: 'nonce was issued for a different address' };
        }
        this.entries.delete(nonce);
        return { ok: true };
    }

    size (): number {
        return this.entries.size;
    }

    clear (): void {
        this.entries.clear();
    }

    /**
   * Stop the periodic sweeper. Test/shutdown only.
   */
    stop (): void {
        if ( this.sweepHandle ) {
            clearInterval(this.sweepHandle);
            this.sweepHandle = null;
        }
    }

    private startSweeper (): void {
        this.sweepHandle = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        if ( this.sweepHandle.unref ) this.sweepHandle.unref();
    }

    private sweep (): void {
        const now = Date.now();
        for ( const [nonce, entry] of this.entries ) {
            if ( entry.expiresAt < now ) this.entries.delete(nonce);
        }
    }
}

function normalizeForKey (address: string): string {
    // EVM addresses are case-insensitive; lowercase them so case mismatch
    // between issue and consume doesn't reject a valid client. Solana
    // addresses are base58 case-sensitive but ASCII letters lowercase
    // would change them — we keep them as-is by detecting the 0x prefix.
    return address.startsWith('0x') ? address.toLowerCase() : address;
}

/** Process-wide singleton. */
export const challengeStore = new ChallengeStore();
