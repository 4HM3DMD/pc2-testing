/**
 * CapsuleSignature — Ed25519 signing + verification for capsule manifests.
 *
 * Closes the A2 critique gap: today's `AppInstallService.verifyDistributionSignature`
 * signs only the BUNDLE bytes, leaving manifest fields (capabilities,
 * signedBy, version, name) outside the hash. An attacker who controls
 * the registry can swap capabilities post-signature while the bundle
 * signature still verifies.
 *
 * This module fixes that by signing a CANONICAL form of the manifest
 * itself. The signature commits to:
 *   - name + version + kind + channel
 *   - engines (node + pc2)
 *   - frontend.entry, backend.* (incl. capabilities!)
 *   - assets[] (incl. each asset's sha256 + signature)
 *   - distribution.cid + distribution.mirrors + distribution.signedBy
 *
 * Excluded from the canonical form (since they ARE the signature output):
 *   - distribution.signature
 *   - distribution.manifestDigest
 *
 * Trust chain:
 *   1. Verifier checks signedBy ∈ trustedPublisherKeys (registry binds
 *      publisher name → set of accepted Ed25519 pubkeys; rejects unknown)
 *   2. Recompute manifestDigest from canonicalized manifest
 *   3. Compare with manifest.distribution.manifestDigest (defends against
 *      truncation attacks where the digest is changed)
 *   4. Verify the signature against the recomputed digest using signedBy
 *
 * Sole publisher in v1: ElacityLabs. The trustedPublisherKeys set is
 * sourced from PC2's registry (M7 work). For tests + dev signing, callers
 * pass an explicit set.
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';

import {
    CapsuleManifest,
    CapsuleManifestError,
    validateCapsuleManifest,
} from './CapsuleManifest.js';

// =============================================================================
// Public API
// =============================================================================

/**
 * Verification outcome. `valid: true` means the signature checks out
 * AND the publisher is in the trusted set AND the embedded digest
 * matches the recomputed canonical digest.
 */
export interface VerifyResult {
    valid: boolean;
    /** Why verification failed; populated only when `valid: false` */
    reason?: string;
    /** The recomputed digest (hex); populated even on failure for debugging */
    computedDigest?: string;
}

/**
 * Output of signManifest — the three fields a publisher writes back into
 * `distribution.{manifestDigest, signature, signedBy}` before publishing.
 */
export interface SignatureBundle {
    manifestDigest: string;
    signature: string;
    signedBy: string;
}

/**
 * Canonicalize a capsule manifest into a deterministic JSON string.
 *
 * Rules:
 *   1. Object keys sorted alphabetically at every level.
 *   2. Arrays preserved in original order (semantically meaningful).
 *   3. The two output fields are excluded:
 *        - distribution.signature
 *        - distribution.manifestDigest
 *      `distribution.signedBy` IS included — the publisher claim is
 *      part of what we commit to.
 *   4. UTF-8 encoded with no whitespace separators (compact form).
 *
 * Returns the canonical string; throws if input contains non-canonicalizable
 * values (functions, undefined inside arrays, BigInt, etc.).
 */
export function canonicalizeManifest(manifest: CapsuleManifest): string {
    const stripped = stripSignatureOutputs(manifest);
    return canonicalStringify(stripped);
}

/**
 * Compute the SHA-256 of the canonicalized manifest, returned as
 * lower-case hex (64 chars). This is the value that gets signed.
 */
export function computeManifestDigest(manifest: CapsuleManifest): string {
    const canonical = canonicalizeManifest(manifest);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Sign a manifest. Used by publishers (and by tests).
 *
 * @param manifest  The capsule manifest to sign. Any existing
 *                  `distribution.signature` / `manifestDigest` are
 *                  ignored (canonicalization strips them).
 * @param secretKey 64-byte Ed25519 secret key (tweetnacl.sign.keyPair().secretKey)
 * @returns         The three values to write back into manifest.distribution
 */
export function signManifest(
    manifest: CapsuleManifest,
    secretKey: Uint8Array,
): SignatureBundle {
    if (secretKey.length !== nacl.sign.secretKeyLength) {
        throw new TypeError(
            `secretKey must be ${nacl.sign.secretKeyLength} bytes; got ${secretKey.length}`,
        );
    }

    // Derive the public key from the secret key per Ed25519 convention:
    // tweetnacl stores pubkey in the second half of the 64-byte secret key.
    const publicKeyBytes = secretKey.slice(32);
    const signedByHex = Buffer.from(publicKeyBytes).toString('hex');

    // The digest must commit to signedBy. If the caller hasn't pre-filled
    // it (typical: they don't know the pubkey until they call us), embed
    // it on a clone before canonicalising — without mutating the input.
    // Verify-time will recompute against the manifest with signedBy set,
    // so both sides see the same canonical form.
    const cloneForDigest = JSON.parse(JSON.stringify(manifest)) as CapsuleManifest;
    if (!cloneForDigest.distribution) {
        // Should never reach here in practice — schema validation requires
        // distribution — but defensive in case a publisher omits it before
        // signing.
        (cloneForDigest as unknown as Record<string, unknown>).distribution = {};
    }
    cloneForDigest.distribution.signedBy = signedByHex;

    const digestHex = computeManifestDigest(cloneForDigest);
    const digestBytes = Buffer.from(digestHex, 'hex');
    const signatureBytes = nacl.sign.detached(new Uint8Array(digestBytes), secretKey);

    return {
        manifestDigest: digestHex,
        signature: Buffer.from(signatureBytes).toString('hex'),
        signedBy: signedByHex,
    };
}

/**
 * Verify a signed manifest. Returns a structured result so callers can
 * surface the failure reason (no throwing on bad signatures — that's a
 * normal path the install flow handles gracefully).
 *
 * Throws only on programmer error (manifest fails schema validation,
 * trustedPublisherKeys is malformed).
 *
 * @param manifest  Already-validated capsule manifest. If you got it
 *                  from JSON.parse without running through
 *                  validateCapsuleManifest first, this function will
 *                  validate it (and throw CapsuleManifestError on bad
 *                  schema).
 * @param trustedPublisherKeys  Set of accepted publisher pubkeys, hex.
 *                  Comparison is case-insensitive. Sole-publisher (v1)
 *                  callers pass {ElacityLabs key}; tests pass their
 *                  generated test key.
 */
export function verifyManifestSignature(
    manifest: CapsuleManifest,
    trustedPublisherKeys: Iterable<string>,
): VerifyResult {
    // Validate first so downstream code can trust the structure.
    validateCapsuleManifest(manifest);

    const trusted = normalizeTrustedKeys(trustedPublisherKeys);
    const dist = manifest.distribution;
    const signedBy = dist.signedBy.toLowerCase();

    if (!trusted.has(signedBy)) {
        return {
            valid: false,
            reason: `publisher key ${truncateKey(signedBy)} not in trusted set ` +
                    `(allowed: ${trusted.size} key${trusted.size === 1 ? '' : 's'})`,
        };
    }

    const computedDigest = computeManifestDigest(manifest);
    if (computedDigest !== dist.manifestDigest.toLowerCase()) {
        return {
            valid: false,
            reason: `manifestDigest mismatch — declared ${truncateDigest(dist.manifestDigest)}, ` +
                    `computed ${truncateDigest(computedDigest)} ` +
                    `(manifest may have been tampered after signing)`,
            computedDigest,
        };
    }

    let publicKeyBytes: Buffer;
    let signatureBytes: Buffer;
    try {
        publicKeyBytes = Buffer.from(dist.signedBy, 'hex');
        signatureBytes = Buffer.from(dist.signature, 'hex');
    } catch (err: any) {
        return {
            valid: false,
            reason: `signature/signedBy not valid hex: ${err.message}`,
            computedDigest,
        };
    }

    if (publicKeyBytes.length !== nacl.sign.publicKeyLength) {
        return {
            valid: false,
            reason: `signedBy length ${publicKeyBytes.length}, expected ${nacl.sign.publicKeyLength}`,
            computedDigest,
        };
    }
    if (signatureBytes.length !== nacl.sign.signatureLength) {
        return {
            valid: false,
            reason: `signature length ${signatureBytes.length}, expected ${nacl.sign.signatureLength}`,
            computedDigest,
        };
    }

    const digestBytes = Buffer.from(computedDigest, 'hex');
    const verified = nacl.sign.detached.verify(
        new Uint8Array(digestBytes),
        new Uint8Array(signatureBytes),
        new Uint8Array(publicKeyBytes),
    );

    if (!verified) {
        return {
            valid: false,
            reason: 'Ed25519 verify returned false (signature does not match digest+pubkey)',
            computedDigest,
        };
    }

    return { valid: true, computedDigest };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Return a deep copy of the manifest with `distribution.signature` and
 * `distribution.manifestDigest` removed — those are outputs of the
 * signing process and must not be part of the input we sign.
 */
function stripSignatureOutputs(manifest: CapsuleManifest): unknown {
    const cloned = JSON.parse(JSON.stringify(manifest));
    if (cloned && cloned.distribution && typeof cloned.distribution === 'object') {
        delete cloned.distribution.signature;
        delete cloned.distribution.manifestDigest;
    }
    return cloned;
}

/**
 * Deterministic JSON serialization: object keys sorted, arrays
 * preserved in order, no whitespace.
 *
 * Refuses non-JSON-safe values (functions, undefined values inside
 * objects, BigInt, symbols) — throws CapsuleManifestError so the
 * publisher catches the mistake at signing time.
 */
function canonicalStringify(value: unknown): string {
    return serialize(value, '(root)');
}

function serialize(value: unknown, path: string): string {
    if (value === null) return 'null';

    const t = typeof value;
    if (t === 'boolean') return value ? 'true' : 'false';

    if (t === 'number') {
        if (!Number.isFinite(value as number)) {
            throw new CapsuleManifestError(path, `non-finite number ${value} cannot be canonicalized`);
        }
        return JSON.stringify(value);
    }

    if (t === 'string') return JSON.stringify(value);

    if (t === 'bigint') {
        throw new CapsuleManifestError(path, `BigInt cannot be canonicalized; use a string instead`);
    }
    if (t === 'function' || t === 'symbol') {
        throw new CapsuleManifestError(path, `${t} value cannot be canonicalized`);
    }
    if (t === 'undefined') {
        throw new CapsuleManifestError(path, `undefined cannot appear in canonical JSON`);
    }

    if (Array.isArray(value)) {
        const parts = value.map((v, i) => serialize(v, `${path}[${i}]`));
        return '[' + parts.join(',') + ']';
    }

    // Object: sort keys, recurse. Skip own-property === undefined (matches
    // JSON.stringify behavior; canonicalize-friendly).
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    const parts: string[] = [];
    for (const k of keys) {
        parts.push(JSON.stringify(k) + ':' + serialize(obj[k], `${path}.${k}`));
    }
    return '{' + parts.join(',') + '}';
}

function normalizeTrustedKeys(raw: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const k of raw) {
        if (typeof k !== 'string') {
            throw new TypeError(`trusted publisher key must be a string; got ${typeof k}`);
        }
        if (k.length !== 64 || !/^[0-9a-fA-F]+$/.test(k)) {
            throw new TypeError(
                `trusted publisher key must be 64 hex chars (32-byte Ed25519 pubkey); got "${k}"`,
            );
        }
        out.add(k.toLowerCase());
    }
    if (out.size === 0) {
        throw new TypeError('trustedPublisherKeys must contain at least one key');
    }
    return out;
}

function truncateKey(hex: string): string {
    return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}

function truncateDigest(hex: string): string {
    return hex.length > 16 ? `${hex.slice(0, 12)}…` : hex;
}
