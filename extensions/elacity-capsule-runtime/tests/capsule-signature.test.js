/**
 * SPEC: CapsuleSignature — Ed25519 signing + verification of capsule
 * manifests. Closes the A2 critique gap (today's flow signs only bundle
 * bytes; capabilities + signedBy live outside the hash and can be
 * swapped post-sign).
 *
 * Helper location:
 *   pc2-node/src/services/CapsuleSignature.ts
 *
 * Required exports tested below:
 *   - canonicalizeManifest(m): string  (deterministic JSON, sorted keys)
 *   - computeManifestDigest(m): string (sha256 hex of canonical form)
 *   - signManifest(m, secretKey): { manifestDigest, signature, signedBy }
 *   - verifyManifestSignature(m, trustedKeys): { valid, reason?, computedDigest? }
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';

const HELPER_PATH = '../src/services/CapsuleSignature.js';
let canonicalizeManifest, computeManifestDigest, signManifest, verifyManifestSignature;

try {
    ({
        canonicalizeManifest,
        computeManifestDigest,
        signManifest,
        verifyManifestSignature,
    } = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] CapsuleSignature not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!signManifest) {
        t.skip('CapsuleSignature helper not yet implemented (Wave 7 / M1)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Fixtures: a baseline valid manifest + a fresh keypair per test
// ---------------------------------------------------------------------------

function baseManifest() {
    return {
        name: 'elastos-node-manager',
        version: '0.5.0',
        kind: 'hybrid',
        engines: { node: '>=20 <23', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/',
            needsRestart: false,
            schemaVersion: 1,
            dataDir: 'data/installed-apps/elastos-node-manager/state/',
            capabilities: {
                spawnProcesses: ['ela', 'ela-cli'],
                ports: { tcp: [20336, 20338], publish: true },
            },
        },
        distribution: {
            cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
            manifestDigest: '',  // filled in by signManifest
            signature: '',
            signedBy: '',
        },
    };
}

function freshKeyPair() {
    return nacl.sign.keyPair();
}

function signed(manifest, kp) {
    const out = signManifest(manifest, kp.secretKey);
    manifest.distribution.manifestDigest = out.manifestDigest;
    manifest.distribution.signature = out.signature;
    manifest.distribution.signedBy = out.signedBy;
    return manifest;
}

function pubHex(kp) {
    return Buffer.from(kp.publicKey).toString('hex');
}

// ---------------------------------------------------------------------------
// canonicalizeManifest
// ---------------------------------------------------------------------------

test('canonicalize: same logical content, different field order → same string', (t) => {
    if (skipIfMissing(t)) return;
    const a = baseManifest();
    const b = {
        // intentionally different declaration order
        distribution: a.distribution,
        backend: a.backend,
        frontend: a.frontend,
        engines: a.engines,
        kind: a.kind,
        version: a.version,
        name: a.name,
    };
    assert.equal(canonicalizeManifest(a), canonicalizeManifest(b));
});

test('canonicalize: array order IS preserved (semantically meaningful)', (t) => {
    if (skipIfMissing(t)) return;
    const a = baseManifest();
    const b = baseManifest();
    b.backend.capabilities.spawnProcesses = ['ela-cli', 'ela'];   // reversed
    assert.notEqual(canonicalizeManifest(a), canonicalizeManifest(b));
});

test('canonicalize: distribution.signature and manifestDigest are STRIPPED', (t) => {
    if (skipIfMissing(t)) return;
    const a = baseManifest();
    a.distribution.signature = 'aa'.repeat(64);
    a.distribution.manifestDigest = 'bb'.repeat(32);
    const b = baseManifest();
    b.distribution.signature = 'cc'.repeat(64);   // different
    b.distribution.manifestDigest = 'dd'.repeat(32);
    // canonical form should NOT include either field — so a + b match
    assert.equal(canonicalizeManifest(a), canonicalizeManifest(b));
});

test('canonicalize: distribution.signedBy IS included (committed)', (t) => {
    if (skipIfMissing(t)) return;
    const a = baseManifest();
    a.distribution.signedBy = 'ee'.repeat(32);
    const b = baseManifest();
    b.distribution.signedBy = 'ff'.repeat(32);
    assert.notEqual(canonicalizeManifest(a), canonicalizeManifest(b));
});

// ---------------------------------------------------------------------------
// computeManifestDigest
// ---------------------------------------------------------------------------

test('digest: stable across calls', (t) => {
    if (skipIfMissing(t)) return;
    const m = baseManifest();
    assert.equal(computeManifestDigest(m), computeManifestDigest(m));
});

test('digest: 64 hex chars (sha-256)', (t) => {
    if (skipIfMissing(t)) return;
    const d = computeManifestDigest(baseManifest());
    assert.match(d, /^[0-9a-f]{64}$/);
});

test('digest: changes when capabilities change', (t) => {
    if (skipIfMissing(t)) return;
    const a = baseManifest();
    const b = baseManifest();
    b.backend.capabilities.ports.tcp = [9999];
    assert.notEqual(computeManifestDigest(a), computeManifestDigest(b));
});

// ---------------------------------------------------------------------------
// signManifest + verifyManifestSignature: happy path
// ---------------------------------------------------------------------------

test('sign + verify happy path', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    const result = verifyManifestSignature(m, [pubHex(kp)]);
    assert.equal(result.valid, true, `expected valid, got ${result.reason}`);
    assert.match(result.computedDigest, /^[0-9a-f]{64}$/);
});

test('sign + verify with multiple trusted keys (signature matches one of them)', (t) => {
    if (skipIfMissing(t)) return;
    const kpA = freshKeyPair();
    const kpB = freshKeyPair();
    const m = signed(baseManifest(), kpA);
    const result = verifyManifestSignature(m, [pubHex(kpB), pubHex(kpA)]);
    assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// verifyManifestSignature: rejection paths
// ---------------------------------------------------------------------------

test('reject: signedBy not in trusted set', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const trustedOther = freshKeyPair();
    const m = signed(baseManifest(), kp);
    const result = verifyManifestSignature(m, [pubHex(trustedOther)]);
    assert.equal(result.valid, false);
    assert.match(result.reason, /not in trusted set/i);
});

test('reject: capabilities tampered post-sign (digest mismatch)', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    // Tamper: add a port the publisher never approved
    m.backend.capabilities.ports.tcp.push(9999);
    const result = verifyManifestSignature(m, [pubHex(kp)]);
    assert.equal(result.valid, false);
    assert.match(result.reason, /digest mismatch|tamper/i);
});

test('reject: name swapped post-sign', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    m.name = 'malicious-impostor';
    const result = verifyManifestSignature(m, [pubHex(kp)]);
    assert.equal(result.valid, false);
    assert.match(result.reason, /digest mismatch/i);
});

test('reject: signature swapped to a different valid one', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    // Replace signature with a valid-format-but-wrong one
    const fake = nacl.sign.detached(new Uint8Array(32), kp.secretKey);
    m.distribution.signature = Buffer.from(fake).toString('hex');
    // Have to also corrupt manifestDigest for this to be a "signature-only" tamper
    // but really the more interesting check is: post-tamper, verify fails one way or another.
    const result = verifyManifestSignature(m, [pubHex(kp)]);
    assert.equal(result.valid, false);
});

test('reject: signedBy length wrong (after passing schema by adding garbage)', (t) => {
    if (skipIfMissing(t)) return;
    // We can't get here through validateCapsuleManifest (it rejects bad lengths),
    // but if a downstream caller bypasses validation, verify still fails closed.
    // verifyManifestSignature calls validateCapsuleManifest internally, so this
    // throws CapsuleManifestError rather than returning {valid:false}. Confirm.
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    m.distribution.signedBy = 'aabb';   // too short
    assert.throws(() => verifyManifestSignature(m, [pubHex(kp)]),
        { name: 'CapsuleManifestError' });
});

test('reject: trustedPublisherKeys empty throws', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    assert.throws(() => verifyManifestSignature(m, []), { name: 'TypeError' });
});

test('reject: trustedPublisherKeys contains malformed entry throws', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    assert.throws(() => verifyManifestSignature(m, ['not-hex']), { name: 'TypeError' });
});

// ---------------------------------------------------------------------------
// Trusted-keys comparison: case-insensitive
// ---------------------------------------------------------------------------

test('trusted key comparison is case-insensitive', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    const upper = pubHex(kp).toUpperCase();
    const result = verifyManifestSignature(m, [upper]);
    assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// signManifest: rejects bad inputs
// ---------------------------------------------------------------------------

test('signManifest rejects wrong-length secretKey', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => signManifest(baseManifest(), new Uint8Array(32)), { name: 'TypeError' });
});

// ---------------------------------------------------------------------------
// Round-trip: sign, modify trusted set, re-verify (regression guard)
// ---------------------------------------------------------------------------

test('round-trip: same manifest verifies under multiple trusted-set lookups', (t) => {
    if (skipIfMissing(t)) return;
    const kp = freshKeyPair();
    const m = signed(baseManifest(), kp);
    const r1 = verifyManifestSignature(m, [pubHex(kp)]);
    const r2 = verifyManifestSignature(m, [pubHex(kp)]);
    assert.equal(r1.valid, true);
    assert.equal(r2.valid, true);
    assert.equal(r1.computedDigest, r2.computedDigest);
});
