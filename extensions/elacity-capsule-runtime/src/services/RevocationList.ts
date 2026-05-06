/**
 * RevocationList — schema + Ed25519 verification for the
 * publisher-revocation document PC2 polls.
 *
 * Per the v0.3 doc: revocation transport is a signed JSON manifest
 * hosted at a well-known supernode URL (e.g.
 * `https://registry.ela.city/revocations.json`). The list is signed
 * by a SEPARATE revocation root key (cold-stored, ElacityLabs holds
 * it; multi-sig in production). PC2 verifies the list against this
 * root before trusting any of its entries.
 *
 * Document shape (from the v0.3 doc, line ~290):
 *
 *   {
 *     "version": 7,
 *     "updatedAt": "2026-05-10T12:00:00Z",
 *     "revocations": [
 *       {
 *         "publisherKey": "<32-byte ed25519 hex>",
 *         "reason":       "key compromised",
 *         "revokedAt":    "2026-05-10T11:42:00Z"
 *       }
 *     ],
 *     "signature": "<ed25519 sig over canonical (revocations[], version, updatedAt)>",
 *     "signedBy":  "<revocation-root pubkey>"
 *   }
 *
 * Trust chain at runtime:
 *   1. RevocationFetcher (M7) downloads + ETag-polls this document
 *   2. RevocationList.verifyList() validates schema + checks the
 *      signature against the configured revocation root pubkey
 *   3. CapsuleInstallOrchestrator (M6, extended in this milestone)
 *      consults RevocationList.isPublisherRevoked() before each
 *      install / preview / load
 *
 * Pure / no I/O. Caller passes the JSON-parsed document; this
 * module verifies and exposes lookup. RevocationFetcher owns the
 * network + heartbeat side.
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';

const ED25519_HEX_RE = /^[0-9a-fA-F]{64}$/;
const ED25519_SIG_HEX_RE = /^[0-9a-fA-F]{128}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

// =============================================================================
// Public types
// =============================================================================

export interface RevocationEntry {
    /** 32-byte Ed25519 publisher pubkey, lowercase hex. */
    publisherKey: string;
    reason: string;
    /** ISO 8601 UTC timestamp the revocation was authored. */
    revokedAt: string;
}

export interface RevocationListDoc {
    /** Monotonic counter — newer wins on tie-breaking. */
    version: number;
    /** ISO 8601 UTC timestamp the document was last updated. */
    updatedAt: string;
    revocations: RevocationEntry[];
    /** Ed25519 signature over the canonical (revocations + version + updatedAt) digest, hex. */
    signature: string;
    /** Revocation root pubkey, lowercase hex. */
    signedBy: string;
}

export interface VerifyResult {
    valid: boolean;
    /** Failure detail; only populated when valid===false. */
    reason?: string;
    /** Recomputed digest (for debugging mismatches). */
    computedDigest?: string;
}

export class RevocationListError extends Error {
    public readonly field: string;
    constructor(field: string, message: string) {
        super(`${field}: ${message}`);
        this.name = 'RevocationListError';
        this.field = field;
    }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate a JSON-parsed revocation document against the v0.3 schema.
 * Throws RevocationListError on any malformed field. Returns the
 * typed document on success.
 *
 * Does NOT verify the signature — call verifyList() for that.
 */
export function validateRevocationDoc(raw: unknown): RevocationListDoc {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new RevocationListError('(root)', 'must be a JSON object');
    }
    const d = raw as Record<string, unknown>;

    if (!Number.isInteger(d.version) || (d.version as number) < 0) {
        throw new RevocationListError('version', 'must be a non-negative integer');
    }
    if (typeof d.updatedAt !== 'string' || !ISO8601_RE.test(d.updatedAt)) {
        throw new RevocationListError('updatedAt', 'must be an ISO 8601 UTC timestamp');
    }
    if (!Array.isArray(d.revocations)) {
        throw new RevocationListError('revocations', 'must be an array');
    }

    for (let i = 0; i < d.revocations.length; i++) {
        const e = d.revocations[i];
        const path = `revocations[${i}]`;
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
            throw new RevocationListError(path, 'must be an object');
        }
        const entry = e as Record<string, unknown>;
        if (typeof entry.publisherKey !== 'string'
            || !ED25519_HEX_RE.test(entry.publisherKey)) {
            throw new RevocationListError(`${path}.publisherKey`,
                'must be 64 hex chars (32-byte Ed25519 pubkey)');
        }
        if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
            throw new RevocationListError(`${path}.reason`,
                'must be a non-empty string');
        }
        if (typeof entry.revokedAt !== 'string' || !ISO8601_RE.test(entry.revokedAt)) {
            throw new RevocationListError(`${path}.revokedAt`,
                'must be an ISO 8601 UTC timestamp');
        }
    }

    if (typeof d.signature !== 'string' || !ED25519_SIG_HEX_RE.test(d.signature)) {
        throw new RevocationListError('signature',
            'must be 128 hex chars (Ed25519 signature)');
    }
    if (typeof d.signedBy !== 'string' || !ED25519_HEX_RE.test(d.signedBy)) {
        throw new RevocationListError('signedBy',
            'must be 64 hex chars (32-byte revocation-root pubkey)');
    }

    return d as unknown as RevocationListDoc;
}

/**
 * Canonicalize the document into a deterministic JSON string for
 * digest computation. Excludes `signature` (it IS the output of
 * signing). Includes `signedBy` so the document commits to which
 * root authored it.
 */
export function canonicalizeRevocationDoc(doc: RevocationListDoc): string {
    const stripped = { ...doc };
    delete (stripped as Record<string, unknown>).signature;
    return canonicalStringify(stripped);
}

export function computeRevocationDigest(doc: RevocationListDoc): string {
    const canon = canonicalizeRevocationDoc(doc);
    return createHash('sha256').update(canon, 'utf8').digest('hex');
}

/**
 * Verify the revocation list against a known-good revocation root
 * pubkey. Returns a structured outcome — never throws on bad
 * signature (that's a normal path the fetcher handles by keeping
 * the previous valid list).
 *
 * Three rejection paths:
 *   1. signedBy ≠ trustedRootKey (someone else signed it)
 *   2. Signature doesn't verify against signedBy + recomputed digest
 *   3. Schema validation failed (caller didn't pre-validate)
 */
export function verifyRevocationList(
    doc: RevocationListDoc,
    trustedRootKeyHex: string,
): VerifyResult {
    validateRevocationDoc(doc);

    if (typeof trustedRootKeyHex !== 'string' || !ED25519_HEX_RE.test(trustedRootKeyHex)) {
        throw new TypeError(
            `trustedRootKeyHex must be 64 hex chars; got "${trustedRootKeyHex}"`);
    }

    const trustedRootLower = trustedRootKeyHex.toLowerCase();
    if (doc.signedBy.toLowerCase() !== trustedRootLower) {
        return {
            valid: false,
            reason: `signedBy (${truncate(doc.signedBy)}) does not match trusted ` +
                    `revocation root (${truncate(trustedRootLower)})`,
        };
    }

    const computedDigest = computeRevocationDigest(doc);
    let pubKey: Buffer;
    let sig: Buffer;
    try {
        pubKey = Buffer.from(doc.signedBy, 'hex');
        sig = Buffer.from(doc.signature, 'hex');
    } catch (err: any) {
        return { valid: false, reason: `hex decoding failed: ${err.message}` };
    }
    const verified = nacl.sign.detached.verify(
        new Uint8Array(Buffer.from(computedDigest, 'hex')),
        new Uint8Array(sig),
        new Uint8Array(pubKey),
    );
    if (!verified) {
        return {
            valid: false,
            reason: 'Ed25519 verify returned false (signature does not match digest+signedBy)',
            computedDigest,
        };
    }
    return { valid: true, computedDigest };
}

/**
 * Predicate: is the given publisher key revoked according to this
 * list? Comparison is case-insensitive (hex). The list's signature
 * is NOT re-verified here — caller should have done that at fetch
 * time and only call this with verified lists.
 */
export function isPublisherRevoked(
    list: RevocationListDoc,
    publisherKeyHex: string,
): RevocationEntry | undefined {
    if (typeof publisherKeyHex !== 'string') return undefined;
    const target = publisherKeyHex.toLowerCase();
    return list.revocations.find(e => e.publisherKey.toLowerCase() === target);
}

/**
 * Sign a revocation document with a revocation root secret key.
 * Used by CI tooling + tests; production root key lives in cold
 * storage (1-of-N or 2-of-3 multisig recommended).
 *
 * Returns { signature, signedBy } that callers paste into the doc
 * before publishing.
 */
export function signRevocationList(
    doc: Omit<RevocationListDoc, 'signature' | 'signedBy'>,
    rootSecretKey: Uint8Array,
): { signature: string; signedBy: string } {
    if (rootSecretKey.length !== nacl.sign.secretKeyLength) {
        throw new TypeError(
            `rootSecretKey must be ${nacl.sign.secretKeyLength} bytes`);
    }
    const publicKeyBytes = rootSecretKey.slice(32);
    const signedByHex = Buffer.from(publicKeyBytes).toString('hex');

    // The doc-as-signed must include signedBy so the digest commits
    // to it. Fill on a clone, hash, sign.
    const cloned: RevocationListDoc = {
        version: doc.version,
        updatedAt: doc.updatedAt,
        revocations: doc.revocations,
        signature: '',
        signedBy: signedByHex,
    };
    const digestHex = computeRevocationDigest(cloned);
    const sigBytes = nacl.sign.detached(
        new Uint8Array(Buffer.from(digestHex, 'hex')),
        rootSecretKey,
    );
    return {
        signature: Buffer.from(sigBytes).toString('hex'),
        signedBy: signedByHex,
    };
}

// =============================================================================
// Internal helpers
// =============================================================================

function canonicalStringify(value: unknown): string {
    return serialize(value);
}

function serialize(v: unknown): string {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') {
        if (!Number.isFinite(v as number)) {
            throw new RevocationListError('(canonicalize)', `non-finite number ${v}`);
        }
        return JSON.stringify(v);
    }
    if (t === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
    if (t === 'object') {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
        return '{' + keys.map(k =>
            JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
    }
    throw new RevocationListError('(canonicalize)', `unsupported type ${t}`);
}

function truncate(hex: string): string {
    return hex.length > 12 ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : hex;
}
