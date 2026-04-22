/**
 * SPEC: FirstRunTokenStore
 *
 * Helper location (created in Wave 2 / SEC-7):
 *   pc2-node/src/api/setup/first-run-token.ts
 *
 * Purpose:
 *   In-memory single-use token store used as a remote-setup escape hatch for
 *   the loopback lock on /api/setup/{mnemonic,info,acknowledge-mnemonic} and
 *   as a fallback for nodes with no anti-snipe password set.
 *
 * Required exports:
 *   export class FirstRunTokenStore {
 *     mint(): string;             // returns 64-hex-char single-use token
 *     verify(token: unknown): boolean;  // single-use; second call returns false
 *     clear(): void;              // wipes the store (test/admin use)
 *     size(): number;             // number of unverified tokens currently held
 *   }
 *
 * Security contract:
 *   - Tokens are 256-bit (64 hex chars) cryptographically random.
 *   - verify() is single-use: first call with a valid token returns true and
 *     atomically removes the token. Second call returns false.
 *   - verify() with non-string input returns false (no throw).
 *   - Tokens are in-memory only (lost on restart) — this is a feature.
 *   - Multiple mint() calls produce distinct tokens (extremely high probability).
 *
 * Operational model (NOT tested here, but documented for the implementer):
 *   - On node startup, a fresh FirstRunTokenStore instance is created.
 *   - At first-run, ONE token is minted and printed to journalctl/console.
 *   - The operator copies it from the log and uses it via X-First-Run-Token header
 *     to drive remote setup once.
 *   - After verify() succeeds, the token is gone — no replay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../../src/api/setup/first-run-token.js';
let FirstRunTokenStore;

try {
  ({ FirstRunTokenStore } = await import(HELPER_PATH));
} catch (err) {
  console.warn(`[spec] FirstRunTokenStore not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
  if (!FirstRunTokenStore) {
    t.skip('helper not yet implemented (Wave 2 / SEC-7)');
    return true;
  }
  return false;
}

test('mint() returns a 64-hex-char string', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const tok = store.mint();
  assert.equal(typeof tok, 'string', 'token must be a string');
  assert.match(tok, /^[0-9a-f]{64}$/, 'token must be exactly 64 lowercase hex chars (256 bits)');
});

test('verify() returns true once for a freshly minted token', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const tok = store.mint();
  assert.equal(store.verify(tok), true, 'first verify must succeed');
});

test('verify() returns false on second call (single-use)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const tok = store.mint();
  store.verify(tok);
  assert.equal(store.verify(tok), false, 'replay must fail — token must be consumed atomically');
});

test('verify() with garbage string returns false', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  assert.equal(store.verify('not-a-real-token'), false);
  assert.equal(store.verify(''), false);
  assert.equal(store.verify('0'.repeat(64)), false, 'never-minted hex must not validate');
});

test('verify() with non-string input returns false (no throw)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  assert.equal(store.verify(undefined), false);
  assert.equal(store.verify(null), false);
  assert.equal(store.verify(42), false);
  assert.equal(store.verify({}), false);
  assert.equal(store.verify([]), false);
  assert.equal(store.verify(Buffer.from('00'.repeat(32), 'hex')), false);
});

test('verify() is case-sensitive (uppercase variant of valid token fails)', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const tok = store.mint();
  const upper = tok.toUpperCase();
  // Skip if mint() happens to produce an all-digit token (rare, no letters to upcase)
  if (upper === tok) {
    t.skip('mint produced an all-digit token — re-run');
    return;
  }
  assert.equal(store.verify(upper), false, 'uppercase variant must not validate (avoid normalization ambiguity)');
});

test('multiple mint() calls produce distinct tokens', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    tokens.add(store.mint());
  }
  assert.equal(tokens.size, 100, 'all 100 tokens must be distinct');
});

test('size() reflects number of unverified tokens', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  assert.equal(store.size(), 0);
  const a = store.mint();
  const b = store.mint();
  assert.equal(store.size(), 2);
  store.verify(a);
  assert.equal(store.size(), 1);
  store.verify(b);
  assert.equal(store.size(), 0);
});

test('clear() removes all tokens; subsequent verify() returns false', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const tok = store.mint();
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.verify(tok), false, 'previously-minted tokens must not validate after clear()');
});

test('verifying one token does not consume others', (t) => {
  if (skipIfMissing(t)) return;
  const store = new FirstRunTokenStore();
  const a = store.mint();
  const b = store.mint();
  const c = store.mint();
  assert.equal(store.verify(b), true);
  assert.equal(store.verify(a), true, 'unrelated tokens must still validate');
  assert.equal(store.verify(c), true);
  assert.equal(store.verify(b), false, 'previously-consumed token still gone');
});

test('two independent stores do not share tokens', (t) => {
  if (skipIfMissing(t)) return;
  const a = new FirstRunTokenStore();
  const b = new FirstRunTokenStore();
  const tok = a.mint();
  assert.equal(b.verify(tok), false, 'token minted by store A must NOT validate against store B');
  assert.equal(a.verify(tok), true, 'and must still validate against the issuing store');
});
