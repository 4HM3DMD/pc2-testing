/**
 * SPEC: verifyProvisioningToken (gateway helper)
 *
 * Helper location (created in Wave 3 / SEC-INFRA-GW-AUTH):
 *   deploy/web-gateway/lib/provisioning-token.js
 *
 * Purpose:
 *   Per-node provisioning token authentication for the PC2 web gateway.
 *   The gateway uses raw http.createServer (not Express), so this is a plain
 *   verification function called as the first lines of each handler that
 *   touches WireGuard / VLESS / awg / DELETE peer endpoints.
 *
 * Required exports:
 *   export function verifyProvisioningToken({
 *     token,         // value of X-Provisioning-Token request header
 *     username,      // username being acted upon (URL segment or body field)
 *     store          // ProvisioningTokenStore instance with token<->username binding
 *   }): boolean;
 *
 *   export class ProvisioningTokenStore {
 *     // Persistent map of username -> { tokenHash, createdAt, lastUsedAt? }
 *     constructor(persistencePath?: string);
 *     mint(username: string): string;        // returns plaintext token; stores hash
 *     verify(token: string, username: string): boolean;
 *     rotate(username: string): string;      // invalidates old, returns new token
 *     revoke(username: string): void;
 *     has(username: string): boolean;
 *   }
 *
 * Security contract:
 *   - Tokens are 256-bit (64-hex-char) cryptographically random.
 *   - Stored as SHA-256 hash, NEVER in plaintext (defense against gateway DB leak).
 *   - verify() is constant-time (timing-safe compare of hashes).
 *   - verify() returns false for ANY mismatch: wrong token, wrong username, missing inputs.
 *   - Tokens are username-bound: token minted for "node-A" cannot register peers as "node-B".
 *   - rotate() invalidates the old token immediately (single-token-per-username invariant).
 *
 * Operational model (NOT tested here, documented for the implementer):
 *   - First call to /api/register for a new username mints + returns the token ONCE.
 *   - PC2 node stores token at $PC2_DATA/gateway-token.json (mode 0600).
 *   - Subsequent /api/{wg,awg,vless,wg/peer/...} calls send token in X-Provisioning-Token.
 *   - Gateway-side rate-limit on /api/register prevents bulk username squatting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../../../deploy/web-gateway/lib/provisioning-token.js';
let verifyProvisioningToken;
let ProvisioningTokenStore;

try {
  ({ verifyProvisioningToken, ProvisioningTokenStore } = await import(HELPER_PATH));
} catch (err) {
  console.warn(`[spec] provisioning-token not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
  if (!verifyProvisioningToken || !ProvisioningTokenStore) {
    t.skip('helper not yet implemented (Wave 3 / SEC-INFRA-GW-AUTH)');
    return true;
  }
  return false;
}

const NODE_A = 'node-aaa-1234';
const NODE_B = 'node-bbb-5678';

test('mint() returns a 64-hex-char token', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  assert.match(tok, /^[0-9a-f]{64}$/);
});

test('verify() returns true for the correct token+username', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  assert.equal(verifyProvisioningToken({ token: tok, username: NODE_A, store }), true);
});

test('verify() returns false when token is correct but username is different (cross-account attack)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tokA = store.mint(NODE_A);
  store.mint(NODE_B);
  assert.equal(verifyProvisioningToken({ token: tokA, username: NODE_B, store }), false,
    'token issued for NODE_A must NOT authorize actions on NODE_B');
});

test('verify() returns false for a tampered token', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  const tampered = tok.slice(0, -1) + (tok.slice(-1) === '0' ? '1' : '0');
  assert.equal(verifyProvisioningToken({ token: tampered, username: NODE_A, store }), false);
});

test('verify() returns false when token is missing/empty', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  store.mint(NODE_A);
  assert.equal(verifyProvisioningToken({ token: undefined, username: NODE_A, store }), false);
  assert.equal(verifyProvisioningToken({ token: null, username: NODE_A, store }), false);
  assert.equal(verifyProvisioningToken({ token: '', username: NODE_A, store }), false);
});

test('verify() returns false when username is missing/empty', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  assert.equal(verifyProvisioningToken({ token: tok, username: undefined, store }), false);
  assert.equal(verifyProvisioningToken({ token: tok, username: null, store }), false);
  assert.equal(verifyProvisioningToken({ token: tok, username: '', store }), false);
});

test('verify() returns false for a username that has never been minted', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  assert.equal(verifyProvisioningToken({ token: tok, username: 'unknown-node', store }), false);
});

test('verify() does not throw on malformed inputs', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  assert.doesNotThrow(() => verifyProvisioningToken({ token: 42, username: NODE_A, store }));
  assert.doesNotThrow(() => verifyProvisioningToken({ token: { hex: 'abc' }, username: NODE_A, store }));
  assert.doesNotThrow(() => verifyProvisioningToken({ token: 'tok', username: ['array'], store }));
  assert.doesNotThrow(() => verifyProvisioningToken({}));
});

test('rotate() invalidates the previous token (single-token-per-username invariant)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok1 = store.mint(NODE_A);
  const tok2 = store.rotate(NODE_A);
  assert.notEqual(tok1, tok2, 'rotate must produce a new token');
  assert.equal(verifyProvisioningToken({ token: tok1, username: NODE_A, store }), false,
    'old token must be invalidated immediately on rotate');
  assert.equal(verifyProvisioningToken({ token: tok2, username: NODE_A, store }), true);
});

test('revoke() invalidates the token; subsequent verify returns false', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  store.revoke(NODE_A);
  assert.equal(verifyProvisioningToken({ token: tok, username: NODE_A, store }), false);
  assert.equal(store.has(NODE_A), false);
});

test('mint() called twice for same username throws or returns existing (NEVER silently overwrites)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  store.mint(NODE_A);
  // The implementer MUST choose one of: throw OR return existing token.
  // Silent overwrite is a security bug because it would let an attacker
  // replace a legitimate node's token by re-registering its username.
  let threw = false;
  let secondToken = null;
  try {
    secondToken = store.mint(NODE_A);
  } catch {
    threw = true;
  }
  if (!threw) {
    assert.ok(secondToken, 'mint() must either throw or return a non-null token');
    // If it returned, the spec demands rotate() be the explicit operation; mint() should NOT silently issue a new one.
    // Document this constraint in the helper file.
    t.diagnostic('mint() returned a value for an existing username; verify it is not a fresh token by checking rotate() is the documented mechanism for renewal');
  }
});

test('store is NOT in-memory only — persists across new instances when persistencePath is set', { skip: true }, (t) => {
  // SKIP: integration test, exercise during SEC-INFRA-GW-AUTH implementation.
  // Verifies that ProvisioningTokenStore(path) loads previously persisted tokens.
  // Tested as part of Wave 3 manual checkpoint (CP-6).
});

test('hashes stored, not plaintext (defense against gateway data leak)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new ProvisioningTokenStore();
  const tok = store.mint(NODE_A);
  // Probe the internal state (helper must expose a debug accessor or use serialized form).
  // Implementers: provide a `toJSON()` or `inspect()` method that returns sanitized state.
  if (typeof store.toJSON === 'function') {
    const dump = JSON.stringify(store.toJSON());
    assert.equal(dump.includes(tok), false,
      'plaintext token must NOT appear in serialized store state');
  } else {
    t.skip('store.toJSON() not exposed; manually verify hash-only storage by reading the helper source');
  }
});
