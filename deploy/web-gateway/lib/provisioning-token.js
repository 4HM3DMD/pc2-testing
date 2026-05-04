/**
 * Per-node Provisioning Token Store + Verifier
 *
 * Wave 3 / SEC-INFRA-GW-AUTH (PC2 Security Triage 2026-04-21).
 * See pc2-node/tests/security/requireProvisioningToken.test.js for the
 * authoritative contract. See .cursor/tasks/SEC-2026-04-21-PC2-AUDIT/
 * for the rollout plan.
 *
 * Threat model
 *   Pre-fix: every gateway endpoint that touches a per-user resource
 *   (WireGuard peers, AmneziaWG peers, VLESS users, peer deletion)
 *   accepted any caller who knew a victim's USERNAME — a public string.
 *   That gave attackers an easy primitive to:
 *     - re-key any user's WG tunnel (SEC-8)
 *     - delete any user's WG peer (SEC-9)
 *     - inject a shell command via the VLESS register username (SEC-2)
 *
 * Fix
 *   On the FIRST /api/register call for a username, the gateway mints a
 *   one-time 256-bit token, returns it ONCE in the response, and stores
 *   only its SHA-256 hash on disk. Every subsequent gateway call that
 *   acts on that username must include the plaintext token in the
 *   X-Provisioning-Token header. The gateway hashes the inbound token
 *   and constant-time-compares against the stored hash for the named
 *   username. Wrong username -> false. Wrong token -> false. Missing
 *   inputs -> false. NEVER throws on bad input (handlers stay simple).
 *
 * Why hash-at-rest
 *   If an attacker reads /root/pc2/web-gateway/data/provisioning-tokens.json
 *   they see only hashes. They cannot replay any of them — the hash
 *   compare requires the plaintext side as input. Strict improvement
 *   over the alternative (plaintext-at-rest) at zero runtime cost.
 *
 * Why username-bound (not global)
 *   A global "is this a known token" check would let any compromised
 *   PC2 node act on behalf of every other node. Binding the token to
 *   the username it was minted for limits blast radius to that one
 *   account if a single node's disk is read.
 *
 * Why mint() refuses to overwrite
 *   Silent overwrite would let an attacker re-claim a victim's
 *   username (via /api/register), get a fresh token, then re-key /
 *   delete the victim's peer. The username-claim handler MUST refuse
 *   to mint a second token; renewal is the explicit rotate() flow.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HASH_HEX_LEN = 64;
const TOKEN_BYTES = 32;

function sha256Hex(input) {
    return createHash('sha256').update(input).digest('hex');
}

function timingSafeHexEqual(aHex, bHex) {
    if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
    if (aHex.length !== bHex.length || aHex.length !== HASH_HEX_LEN) return false;
    let aBuf;
    let bBuf;
    try {
        aBuf = Buffer.from(aHex, 'hex');
        bBuf = Buffer.from(bHex, 'hex');
    } catch {
        return false;
    }
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
}

export class ProvisioningTokenStore {
    /**
     * @param {string|null} persistencePath - JSON file path; null = in-memory only
     */
    constructor(persistencePath = null) {
        this.persistencePath = persistencePath;
        // Map<username, { tokenHash: string, createdAt: string, lastUsedAt?: string, rotatedAt?: string }>
        this._records = new Map();
        if (persistencePath) this._load();
    }

    _load() {
        try {
            if (!fs.existsSync(this.persistencePath)) return;
            const raw = fs.readFileSync(this.persistencePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.records) {
                for (const [u, rec] of Object.entries(parsed.records)) {
                    if (rec && typeof rec.tokenHash === 'string' && rec.tokenHash.length === HASH_HEX_LEN) {
                        this._records.set(u, rec);
                    }
                }
            }
        } catch (err) {
            // Corrupt file is treated as empty — operator must intervene.
            // Do NOT throw: the gateway must keep serving the unauthenticated
            // routes even if the token store is unreadable.
            console.error(`[provisioning-token] Failed to load ${this.persistencePath}: ${err.message}`);
        }
    }

    _persist() {
        if (!this.persistencePath) return;
        try {
            const dir = path.dirname(this.persistencePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const records = {};
            for (const [u, rec] of this._records.entries()) records[u] = rec;
            const tmp = `${this.persistencePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ records }, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, this.persistencePath);
        } catch (err) {
            console.error(`[provisioning-token] Failed to persist: ${err.message}`);
        }
    }

    /**
     * Issue a new token for a username that has never been minted.
     * Returns the plaintext token (only chance to see it).
     * Throws if the username already has a token — use rotate() to renew.
     */
    mint(username) {
        if (typeof username !== 'string' || username.length === 0) {
            throw new TypeError('mint(username): username must be a non-empty string');
        }
        if (this._records.has(username)) {
            throw new Error(`mint(${username}): token already exists; use rotate() to renew`);
        }
        const token = randomBytes(TOKEN_BYTES).toString('hex');
        this._records.set(username, {
            tokenHash: sha256Hex(token),
            createdAt: new Date().toISOString(),
        });
        this._persist();
        return token;
    }

    /**
     * Returns true iff the token+username matches a stored record. Never
     * throws. Touches lastUsedAt as a side effect (helpful for audit).
     */
    verify(token, username) {
        if (typeof token !== 'string' || token.length !== HASH_HEX_LEN) return false;
        if (typeof username !== 'string' || username.length === 0) return false;
        const rec = this._records.get(username);
        if (!rec) return false;
        const inboundHash = sha256Hex(token);
        if (!timingSafeHexEqual(inboundHash, rec.tokenHash)) return false;
        rec.lastUsedAt = new Date().toISOString();
        // Best-effort persist — failure does not affect the verify result.
        try { this._persist(); } catch { /* swallowed */ }
        return true;
    }

    /**
     * Replace an existing token with a fresh one. Old token is invalidated
     * immediately. Returns the new plaintext token.
     */
    rotate(username) {
        if (typeof username !== 'string' || username.length === 0) {
            throw new TypeError('rotate(username): username must be a non-empty string');
        }
        const token = randomBytes(TOKEN_BYTES).toString('hex');
        const prev = this._records.get(username);
        this._records.set(username, {
            tokenHash: sha256Hex(token),
            createdAt: prev ? prev.createdAt : new Date().toISOString(),
            rotatedAt: new Date().toISOString(),
        });
        this._persist();
        return token;
    }

    revoke(username) {
        if (typeof username !== 'string' || username.length === 0) return;
        if (this._records.delete(username)) this._persist();
    }

    has(username) {
        if (typeof username !== 'string' || username.length === 0) return false;
        return this._records.has(username);
    }

    /**
     * Sanitised serialisation for debugging. NEVER includes plaintext tokens.
     * The test suite verifies that JSON.stringify(store.toJSON()) does not
     * contain the plaintext token returned by mint().
     */
    toJSON() {
        const records = {};
        for (const [u, rec] of this._records.entries()) {
            records[u] = {
                tokenHash: `[redacted-sha256:${rec.tokenHash.slice(0, 8)}…]`,
                createdAt: rec.createdAt,
                lastUsedAt: rec.lastUsedAt,
                rotatedAt: rec.rotatedAt,
            };
        }
        return { records, count: this._records.size };
    }
}

/**
 * Top-level verify helper. Same semantics as store.verify(token, username)
 * but matches the spec signature exactly: { token, username, store }.
 */
export function verifyProvisioningToken({ token, username, store } = {}) {
    if (!store || typeof store.verify !== 'function') return false;
    return store.verify(token, username);
}

/**
 * Gateway helper: extract the X-Provisioning-Token header from a Node http req.
 * Returns the trimmed string token, or null if absent / malformed.
 * Header lookup is case-insensitive (Node normalises headers to lowercase).
 */
export function getProvisioningTokenFromRequest(req) {
    if (!req || !req.headers) return null;
    const raw = req.headers['x-provisioning-token'];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
