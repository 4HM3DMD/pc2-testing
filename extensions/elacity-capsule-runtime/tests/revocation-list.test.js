/**
 * SPEC: RevocationList — schema + Ed25519 verification of the
 * publisher revocation document PC2 polls.
 *
 * Helper location: pc2-node/src/services/RevocationList.ts
 *
 * Coverage: schema validation (every required field, every shape),
 * canonicalization determinism, sign+verify round-trip, every
 * rejection path (wrong root, tampered field, malformed signature),
 * the isPublisherRevoked predicate (case-insensitive lookup).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';

const HELPER_PATH = '../src/services/RevocationList.js';
let validateRevocationDoc, canonicalizeRevocationDoc, computeRevocationDigest,
    verifyRevocationList, signRevocationList, isPublisherRevoked;

try {
    ({ validateRevocationDoc, canonicalizeRevocationDoc, computeRevocationDigest,
       verifyRevocationList, signRevocationList, isPublisherRevoked }
        = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] RevocationList not yet implemented: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!verifyRevocationList) {
        t.skip('RevocationList not yet implemented (Wave 7 / M7)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pubHex(kp) {
    return Buffer.from(kp.publicKey).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

function baseDoc(overrides = {}) {
    return {
        version: 1,
        updatedAt: nowIso(),
        revocations: [],
        ...overrides,
    };
}

function freshSignedDoc(rootKp, overrides = {}) {
    const doc = baseDoc(overrides);
    const sig = signRevocationList(doc, rootKp.secretKey);
    return { ...doc, signature: sig.signature, signedBy: sig.signedBy };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('validate: clean doc passes', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    assert.doesNotThrow(() => validateRevocationDoc(doc));
});

test('validate: rejects non-object roots', (t) => {
    if (skipIfMissing(t)) return;
    for (const bad of [null, undefined, [], 'string', 42]) {
        assert.throws(() => validateRevocationDoc(bad),
            { name: 'RevocationListError', field: '(root)' },
            `should reject root=${JSON.stringify(bad)}`);
    }
});

test('validate: rejects negative or non-integer version', (t) => {
    if (skipIfMissing(t)) return;
    for (const bad of [-1, 1.5, 'one', null, undefined]) {
        const kp = nacl.sign.keyPair();
        const doc = freshSignedDoc(kp);
        doc.version = bad;
        assert.throws(() => validateRevocationDoc(doc),
            { name: 'RevocationListError', field: 'version' });
    }
});

test('validate: rejects malformed updatedAt', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    doc.updatedAt = 'tomorrow at noon';
    assert.throws(() => validateRevocationDoc(doc), { field: 'updatedAt' });
});

test('validate: rejects non-array revocations', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    doc.revocations = { not: 'an array' };
    assert.throws(() => validateRevocationDoc(doc), { field: 'revocations' });
});

test('validate: rejects revocation entry with bad publisherKey length', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp, {
        revocations: [{ publisherKey: 'aabb', reason: 'x', revokedAt: nowIso() }],
    });
    assert.throws(() => validateRevocationDoc(doc),
        { field: 'revocations[0].publisherKey' });
});

test('validate: rejects revocation entry with empty reason', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp, {
        revocations: [{ publisherKey: 'a'.repeat(64), reason: '', revokedAt: nowIso() }],
    });
    assert.throws(() => validateRevocationDoc(doc),
        { field: 'revocations[0].reason' });
});

test('validate: rejects revocation entry with bad revokedAt', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp, {
        revocations: [{ publisherKey: 'a'.repeat(64), reason: 'x', revokedAt: 'never' }],
    });
    assert.throws(() => validateRevocationDoc(doc),
        { field: 'revocations[0].revokedAt' });
});

test('validate: rejects malformed signature length', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    doc.signature = 'aabb';
    assert.throws(() => validateRevocationDoc(doc), { field: 'signature' });
});

test('validate: rejects malformed signedBy length', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    doc.signedBy = 'aabb';
    assert.throws(() => validateRevocationDoc(doc), { field: 'signedBy' });
});

// ---------------------------------------------------------------------------
// Canonicalization + digest
// ---------------------------------------------------------------------------

test('canonicalize: keys sorted, signature stripped', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp, { version: 5 });
    const canon = canonicalizeRevocationDoc(doc);
    assert.ok(!canon.includes(doc.signature), 'signature must be stripped');
    assert.ok(canon.includes(doc.signedBy), 'signedBy must be included');
    // sorted keys: revocations, signedBy, updatedAt, version (alphabetical)
    const keysOrder = canon.match(/"(\w+)":/g);
    assert.deepEqual(keysOrder, ['"revocations":', '"signedBy":', '"updatedAt":', '"version":']);
});

test('digest: stable across calls', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    assert.equal(computeRevocationDigest(doc), computeRevocationDigest(doc));
});

test('digest: 64 hex chars (sha-256)', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    assert.match(computeRevocationDigest(doc), /^[0-9a-f]{64}$/);
});

test('digest: changes when revocations change', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const a = freshSignedDoc(kp);
    const b = freshSignedDoc(kp, {
        revocations: [{ publisherKey: 'b'.repeat(64), reason: 'x', revokedAt: nowIso() }],
    });
    assert.notEqual(computeRevocationDigest(a), computeRevocationDigest(b));
});

// ---------------------------------------------------------------------------
// signRevocationList + verifyRevocationList round-trip
// ---------------------------------------------------------------------------

test('sign+verify: clean round-trip passes', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    const result = verifyRevocationList(doc, pubHex(kp));
    assert.equal(result.valid, true, `expected valid, got: ${result.reason}`);
});

test('sign+verify: with revocations', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp, {
        version: 7,
        revocations: [
            { publisherKey: 'b'.repeat(64), reason: 'key compromised', revokedAt: nowIso() },
            { publisherKey: 'c'.repeat(64), reason: 'publisher dissolved', revokedAt: nowIso() },
        ],
    });
    const result = verifyRevocationList(doc, pubHex(kp));
    assert.equal(result.valid, true);
});

test('verify: wrong revocation root rejected', (t) => {
    if (skipIfMissing(t)) return;
    const kpReal = nacl.sign.keyPair();
    const kpAttacker = nacl.sign.keyPair();
    const doc = freshSignedDoc(kpAttacker);
    const result = verifyRevocationList(doc, pubHex(kpReal));
    assert.equal(result.valid, false);
    assert.match(result.reason, /signedBy.*does not match trusted/i);
});

test('verify: tampered version → digest mismatch', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    doc.version = 9999;   // attacker bumps version
    const result = verifyRevocationList(doc, pubHex(kp));
    assert.equal(result.valid, false);
    assert.match(result.reason, /Ed25519 verify returned false/i);
});

test('verify: tampered revocations → digest mismatch', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    doc.revocations.push({
        publisherKey: 'b'.repeat(64), reason: 'gotcha', revokedAt: nowIso(),
    });
    const result = verifyRevocationList(doc, pubHex(kp));
    assert.equal(result.valid, false);
});

test('verify: trusted root must be 64 hex chars', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    assert.throws(() => verifyRevocationList(doc, 'short'), { name: 'TypeError' });
});

test('verify: trusted root comparison is case-insensitive', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    const upper = pubHex(kp).toUpperCase();
    const result = verifyRevocationList(doc, upper);
    assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// isPublisherRevoked predicate
// ---------------------------------------------------------------------------

test('isPublisherRevoked: returns the matching entry', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const target = 'b'.repeat(64);
    const doc = freshSignedDoc(kp, {
        revocations: [
            { publisherKey: 'a'.repeat(64), reason: 'first', revokedAt: nowIso() },
            { publisherKey: target,         reason: 'gotcha', revokedAt: nowIso() },
        ],
    });
    const hit = isPublisherRevoked(doc, target);
    assert.ok(hit);
    assert.equal(hit.reason, 'gotcha');
});

test('isPublisherRevoked: case-insensitive lookup', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const target = 'b'.repeat(64);
    const doc = freshSignedDoc(kp, {
        revocations: [{ publisherKey: target, reason: 'x', revokedAt: nowIso() }],
    });
    assert.ok(isPublisherRevoked(doc, target.toUpperCase()));
});

test('isPublisherRevoked: returns undefined for unknown key', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    assert.equal(isPublisherRevoked(doc, 'd'.repeat(64)), undefined);
});

test('isPublisherRevoked: handles non-string input gracefully', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const doc = freshSignedDoc(kp);
    assert.equal(isPublisherRevoked(doc, null), undefined);
    assert.equal(isPublisherRevoked(doc, 42), undefined);
});
