/**
 * SPEC: scope-check (middleware predicate)
 *
 * Helper location (created in Wave 1 / SEC-3c):
 *   pc2-node/src/api/middleware/scope-check.ts
 *
 * Purpose:
 *   When a session has scope='file', the middleware must verify that the
 *   incoming request is actually targeting the file the session was scoped to.
 *   This stops the SEC-3c re-architected scoped session token from being
 *   abused as a universal Bearer.
 *
 * Required exports:
 *   export interface ScopedSession {
 *     scope: string | null;       // null = unrestricted (legacy/owner sessions)
 *     scope_data: string | null;  // JSON: { fileUid?: string; allowedPath?: string }
 *   }
 *   export interface ScopeRequest {
 *     query?: { uid?: string; file?: string; path?: string };
 *     body?: { uid?: string; file?: string; path?: string };
 *     path?: string;              // req.path (URL pathname segment)
 *   }
 *   export function isRequestInScope(session: ScopedSession, req: ScopeRequest): boolean;
 *
 * Security contract:
 *   - scope === null → true (unrestricted; backward compat for existing sessions).
 *   - scope === 'file' → true ONLY IF the request's uid/file/path matches scope_data.fileUid.
 *   - Unknown scope value → false (fail-closed, never assume new scope means more permissive).
 *   - Missing scope_data when scope !== null → false (fail-closed).
 *   - Malformed scope_data JSON → false (fail-closed, MUST NOT throw).
 *   - Comparison is exact-match for fileUid (no prefix, no normalization).
 *   - allowedPath (optional in scope_data) supports prefix-match for legitimate
 *     subpath-read flows (e.g. a directory-scoped session reading a child file).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../../src/api/middleware/scope-check.js';
let isRequestInScope;

try {
  ({ isRequestInScope } = await import(HELPER_PATH));
} catch (err) {
  console.warn(`[spec] scope-check not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
  if (!isRequestInScope) {
    t.skip('helper not yet implemented (Wave 1 / SEC-3c)');
    return true;
  }
  return false;
}

const FILE_UID = 'uuid--0xabcdef1234567890abcdef1234567890abcdef12-Desktop-photo.jpg';
const OTHER_UID = 'uuid--0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef-Desktop-other.jpg';

test('null scope is always in-scope (unrestricted session)', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: null, scope_data: null };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID } }), true);
  assert.equal(isRequestInScope(session, { path: '/api/anything' }), true);
  assert.equal(isRequestInScope(session, {}), true);
});

test('scope=file matches when query.uid equals scope_data.fileUid', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID } }), true);
});

test('scope=file matches when query.file equals scope_data.fileUid', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { query: { file: FILE_UID } }), true);
});

test('scope=file matches when body.uid equals scope_data.fileUid', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { body: { uid: FILE_UID } }), true);
});

test('scope=file rejects when uid does NOT match scope_data.fileUid', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { query: { uid: OTHER_UID } }), false);
  assert.equal(isRequestInScope(session, { query: { file: OTHER_UID } }), false);
  assert.equal(isRequestInScope(session, { body: { uid: OTHER_UID } }), false);
});

test('scope=file with no uid/file/path in request returns false (fail-closed)', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, {}), false, 'no identifying request data => no scope match');
  assert.equal(isRequestInScope(session, { query: {} }), false);
  assert.equal(isRequestInScope(session, { body: {} }), false);
});

test('scope=file with missing scope_data returns false (fail-closed)', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: null };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID } }), false);
});

test('scope=file with malformed JSON in scope_data returns false (no throw)', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: '{not valid json' };
  assert.doesNotThrow(() => isRequestInScope(session, { query: { uid: FILE_UID } }));
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID } }), false);
});

test('scope=file with scope_data missing fileUid returns false', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ otherKey: 'whatever' }) };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID } }), false);
});

test('unknown scope value returns false (fail-closed against future scope additions)', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'unknown_future_scope', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID } }), false);
});

test('fileUid match is exact — substring of FILE_UID does NOT match', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID.slice(0, 20) } }), false);
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID + '-extra' } }), false);
});

test('fileUid match is case-sensitive', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.equal(isRequestInScope(session, { query: { uid: FILE_UID.toUpperCase() } }), false);
});

test('allowedPath prefix matches when path starts with allowedPath', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ allowedPath: '/0xWALLET/Desktop' }) };
  assert.equal(isRequestInScope(session, { path: '/0xWALLET/Desktop/photo.jpg' }), true);
  assert.equal(isRequestInScope(session, { path: '/0xWALLET/Desktop' }), true);
});

test('allowedPath prefix does NOT match when path is OUTSIDE allowedPath', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ allowedPath: '/0xWALLET/Desktop' }) };
  assert.equal(isRequestInScope(session, { path: '/0xWALLET/Documents/secret' }), false);
  assert.equal(isRequestInScope(session, { path: '/0xVICTIM/Desktop/photo.jpg' }), false);
});

test('allowedPath does not allow ../ traversal', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ allowedPath: '/0xWALLET/Desktop' }) };
  assert.equal(isRequestInScope(session, { path: '/0xWALLET/Desktop/../Documents/secret' }), false,
    'paths containing ../ must be rejected even if prefix matches');
});

test('null session input returns false (fail-closed, no throw)', (t) => {
  if (skipIfMissing(t)) return;
  assert.doesNotThrow(() => isRequestInScope(null, { query: { uid: FILE_UID } }));
  assert.equal(isRequestInScope(null, { query: { uid: FILE_UID } }), false);
});

test('null request input returns false (fail-closed, no throw)', (t) => {
  if (skipIfMissing(t)) return;
  const session = { scope: 'file', scope_data: JSON.stringify({ fileUid: FILE_UID }) };
  assert.doesNotThrow(() => isRequestInScope(session, null));
  assert.equal(isRequestInScope(session, null), false);
});
