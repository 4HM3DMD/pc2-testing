/**
 * SPEC: verifyEssentialsJWT
 *
 * Helper location (created in Wave 5 / SEC-11):
 *   pc2-node/src/api/did/verify-jwt.ts
 *
 * Purpose:
 *   Cryptographically verify a JWT issued by Elastos Essentials (during
 *   walletaccess / credaccess DID flows) against the issuer DID's public key
 *   resolved via the Elastos DID resolver.
 *
 *   This replaces the unsigned-JWT-payload-parsing pattern at
 *   pc2-node/src/api/did.ts:340-360 that allows attackers to forge tether
 *   bindings (Finding 11). DEMOTED to Wave 5 because DID is barely used in
 *   production today.
 *
 * Required exports:
 *   export interface DidPublicKey {
 *     id: string;          // e.g. 'did:elastos:abc#primary'
 *     type: string;        // 'EcdsaSecp256r1VerificationKey2019' or similar
 *     publicKeyHex: string;
 *   }
 *
 *   export interface DidDocument {
 *     id: string;
 *     publicKey: DidPublicKey[];
 *     // ... other DID doc fields
 *   }
 *
 *   export interface DidResolver {
 *     resolve(did: string): Promise<DidDocument | null>;
 *   }
 *
 *   export interface DidDocCache {
 *     get(did: string): { doc: DidDocument; expiresAt: number } | undefined;
 *     set(did: string, doc: DidDocument, ttlMs: number): void;
 *   }
 *
 *   export type DidJwtVerifyResult =
 *     | { valid: true; did: string; payload: Record<string, unknown> }
 *     | { valid: false; reason: string };
 *
 *   export async function verifyEssentialsJWT(
 *     token: string,
 *     resolver: DidResolver,
 *     cache?: DidDocCache,
 *   ): Promise<DidJwtVerifyResult>;
 *
 * Security contract:
 *   - Reject 2-part JWTs (no signature segment).
 *   - Reject unsupported algorithms — Elastos Essentials uses ES256/ES256K only.
 *     Specifically: HS256 MUST be rejected (the classic alg-confusion attack).
 *   - Reject `alg: none` outright.
 *   - Resolve DID from `iss` (or `payload.iss`); reject if DID resolver returns null
 *     AND no valid cached doc is available.
 *   - Verify signature over `header.payload` against the resolved public key.
 *   - Tampered payload (signature stays the same, payload bytes change) → fail.
 *   - Cache hit during resolver outage → use cached doc (fail-open ONLY for cache
 *     hits within TTL, otherwise fail-closed).
 *   - All errors return { valid: false, reason }; NEVER throw.
 *
 * Note: signing in tests uses Node's built-in crypto for ES256 (P-256 + SHA-256).
 * The full Elastos resolver integration is left to the implementer; tests use a
 * stub resolver that returns a hardcoded DID doc with the test public key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash, randomBytes } from 'node:crypto';

const HELPER_PATH = '../../src/api/did/verify-jwt.js';
let verifyEssentialsJWT;

try {
  ({ verifyEssentialsJWT } = await import(HELPER_PATH));
} catch (err) {
  console.warn(`[spec] verify-jwt not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
  if (!verifyEssentialsJWT) {
    t.skip('helper not yet implemented (Wave 5 / SEC-11)');
    return true;
  }
  return false;
}

// --- Test JWT factory (ES256 = P-256 + SHA-256) ---------------------------

const TEST_DID = 'did:elastos:iaBcDeFgHiJkLmNoPqRsTuVwXyZ012345';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeES256JWT({ payload, privateKey, alg = 'ES256', headerOverride = {} }) {
  const header = { alg, typ: 'JWT', ...headerOverride };
  const headerSeg = b64url(JSON.stringify(header));
  const payloadSeg = b64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const sign = createSign('SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

function makeStubResolver(did, publicKeyPem) {
  return {
    resolve: async (queriedDid) => {
      if (queriedDid !== did) return null;
      return {
        id: did,
        publicKey: [{
          id: `${did}#primary`,
          type: 'EcdsaSecp256r1VerificationKey2019',
          publicKeyHex: publicKeyPem,  // implementer translates to actual key material
        }],
      };
    },
  };
}

function makeFailingResolver() {
  return { resolve: async () => null };
}

function makeMemCache() {
  const store = new Map();
  return {
    get: (did) => {
      const entry = store.get(did);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) return undefined;
      return entry;
    },
    set: (did, doc, ttlMs) => {
      store.set(did, { doc, expiresAt: Date.now() + ttlMs });
    },
  };
}

// --- Happy path -----------------------------------------------------------

test('valid ES256-signed JWT with resolver hit returns valid: true', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = { iss: TEST_DID, nonce: 'abc123', iat: Math.floor(Date.now() / 1000) };
  const token = makeES256JWT({ payload, privateKey });
  const resolver = makeStubResolver(TEST_DID, pubPem);

  const result = await verifyEssentialsJWT(token, resolver);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.did, TEST_DID);
  assert.equal(result.payload.nonce, 'abc123');
});

// --- Format failures (must NEVER throw) ----------------------------------

test('2-part JWT (no signature segment) returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: TEST_DID }));
  const result = await verifyEssentialsJWT(`${header}.${payload}`, makeStubResolver(TEST_DID, ''));
  assert.equal(result.valid, false);
  assert.match(result.reason, /format|segment|signature/i);
});

test('1-part garbage returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const result = await verifyEssentialsJWT('not-a-jwt', makeStubResolver(TEST_DID, ''));
  assert.equal(result.valid, false);
});

test('empty string returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const result = await verifyEssentialsJWT('', makeStubResolver(TEST_DID, ''));
  assert.equal(result.valid, false);
});

test('non-string token returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  await assert.doesNotReject(verifyEssentialsJWT(null, makeStubResolver(TEST_DID, '')));
  await assert.doesNotReject(verifyEssentialsJWT(undefined, makeStubResolver(TEST_DID, '')));
  await assert.doesNotReject(verifyEssentialsJWT(42, makeStubResolver(TEST_DID, '')));
  const result = await verifyEssentialsJWT(undefined, makeStubResolver(TEST_DID, ''));
  assert.equal(result.valid, false);
});

// --- Algorithm-confusion attacks ------------------------------------------

test('alg: none returns valid: false (CRITICAL: classic alg-confusion attack)', async (t) => {
  if (skipIfMissing(t)) return;
  const headerSeg = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payloadSeg = b64url(JSON.stringify({ iss: TEST_DID, nonce: 'abc' }));
  const token = `${headerSeg}.${payloadSeg}.`;
  const result = await verifyEssentialsJWT(token, makeStubResolver(TEST_DID, ''));
  assert.equal(result.valid, false);
  assert.match(result.reason, /alg|algorithm|none/i);
});

test('alg: HS256 returns valid: false (CRITICAL: HMAC-vs-asymmetric confusion)', async (t) => {
  if (skipIfMissing(t)) return;
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  // Forge an HS256 token using the public key as the HMAC secret (classic attack)
  const headerSeg = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadSeg = b64url(JSON.stringify({ iss: TEST_DID }));
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', pubPem).update(`${headerSeg}.${payloadSeg}`).digest();
  const token = `${headerSeg}.${payloadSeg}.${b64url(sig)}`;
  const result = await verifyEssentialsJWT(token, makeStubResolver(TEST_DID, pubPem));
  assert.equal(result.valid, false);
  assert.match(result.reason, /alg|algorithm|hs256|symmetric/i);
});

test('alg: RS256 (asymmetric but unexpected) returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const headerSeg = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadSeg = b64url(JSON.stringify({ iss: TEST_DID }));
  const sigSeg = b64url(randomBytes(256));
  const result = await verifyEssentialsJWT(`${headerSeg}.${payloadSeg}.${sigSeg}`, makeStubResolver(TEST_DID, ''));
  assert.equal(result.valid, false);
});

// --- Tamper detection -----------------------------------------------------

test('tampered payload (signature unchanged) returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = { iss: TEST_DID, nonce: 'original' };
  const token = makeES256JWT({ payload, privateKey });
  const [headerSeg, , sigSeg] = token.split('.');
  const tamperedPayload = b64url(JSON.stringify({ iss: TEST_DID, nonce: 'attacker-nonce', wallet: '0xATTACKER' }));
  const tamperedToken = `${headerSeg}.${tamperedPayload}.${sigSeg}`;
  const result = await verifyEssentialsJWT(tamperedToken, makeStubResolver(TEST_DID, pubPem));
  assert.equal(result.valid, false);
});

test('tampered header (alg field changed after signing) returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = { iss: TEST_DID };
  const token = makeES256JWT({ payload, privateKey });
  const [, payloadSeg, sigSeg] = token.split('.');
  const tamperedHeader = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const result = await verifyEssentialsJWT(`${tamperedHeader}.${payloadSeg}.${sigSeg}`, makeStubResolver(TEST_DID, pubPem));
  assert.equal(result.valid, false);
});

// --- DID resolution failures ----------------------------------------------

test('resolver returns null + no cache → valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = { iss: TEST_DID };
  const token = makeES256JWT({ payload, privateKey });
  const result = await verifyEssentialsJWT(token, makeFailingResolver());
  assert.equal(result.valid, false);
  assert.match(result.reason, /resolve|did|document/i);
});

test('resolver throws → valid: false (fail-closed, no crash)', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = { iss: TEST_DID };
  const token = makeES256JWT({ payload, privateKey });
  const throwingResolver = { resolve: async () => { throw new Error('Elastos RPC down'); } };
  const result = await verifyEssentialsJWT(token, throwingResolver);
  assert.equal(result.valid, false);
});

test('cache hit when resolver returns null → uses cached doc and verifies (fail-open within TTL)', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = { iss: TEST_DID, nonce: 'cached-test' };
  const token = makeES256JWT({ payload, privateKey });
  const cache = makeMemCache();
  cache.set(TEST_DID, {
    id: TEST_DID,
    publicKey: [{ id: `${TEST_DID}#primary`, type: 'EcdsaSecp256r1VerificationKey2019', publicKeyHex: pubPem }],
  }, 24 * 60 * 60 * 1000);
  const result = await verifyEssentialsJWT(token, makeFailingResolver(), cache);
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('cache miss + resolver fails → valid: false (no fail-open without cache)', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = { iss: TEST_DID };
  const token = makeES256JWT({ payload, privateKey });
  const cache = makeMemCache(); // empty
  const result = await verifyEssentialsJWT(token, makeFailingResolver(), cache);
  assert.equal(result.valid, false);
});

test('expired cache entry is treated as miss → valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = { iss: TEST_DID };
  const token = makeES256JWT({ payload, privateKey });
  const cache = makeMemCache();
  cache.set(TEST_DID, {
    id: TEST_DID,
    publicKey: [{ id: `${TEST_DID}#primary`, type: 'EcdsaSecp256r1VerificationKey2019', publicKeyHex: pubPem }],
  }, -1000); // already expired
  const result = await verifyEssentialsJWT(token, makeFailingResolver(), cache);
  assert.equal(result.valid, false);
});

// --- Missing iss field ---------------------------------------------------

test('JWT with no iss/did field in payload returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const token = makeES256JWT({ payload: { nonce: 'no-issuer' }, privateKey });
  const result = await verifyEssentialsJWT(token, makeStubResolver(TEST_DID, pubPem));
  assert.equal(result.valid, false);
  assert.match(result.reason, /iss|issuer|did/i);
});
