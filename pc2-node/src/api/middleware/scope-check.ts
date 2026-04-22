/**
 * Scope-check predicate for resource-bound sessions.
 *
 * Created in Wave 1 / SEC-3c (PC2 Security Triage 2026-04).
 *
 * When a session has scope='file' (set by /open_item when minting iframe-app
 * tokens), the auth middleware MUST verify that the incoming request is
 * actually targeting the file the session was scoped to. This prevents
 * the SEC-3c re-architected scoped session from being abused as a universal
 * Bearer for unrelated file paths or APIs.
 *
 * Specification: pc2-node/tests/security/scope-check.test.js
 *
 * Contract summary (full details in the spec file):
 *   - scope === null         -> true (unrestricted; legacy/owner sessions)
 *   - scope === 'file'       -> true ONLY IF request uid/file/path matches
 *                               scope_data.fileUid (exact, case-sensitive),
 *                               OR path begins with scope_data.allowedPath
 *                               (prefix-match, no '..' traversal).
 *   - unknown scope          -> false (fail-closed against future scopes).
 *   - missing/malformed data -> false (fail-closed, never throws).
 */

export interface ScopedSession {
  scope?: string | null;
  scope_data?: string | null;
}

export interface ScopeRequest {
  query?: { uid?: string; file?: string; path?: string } | null;
  body?: { uid?: string; file?: string; path?: string } | null;
  path?: string;
}

interface FileScopeData {
  fileUid?: string;
  allowedPath?: string;
}

/**
 * Returns true iff the given session is permitted to handle this request.
 *
 * Never throws. Always returns a boolean. Treats every parsing/format
 * failure as a denial (fail-closed).
 */
export function isRequestInScope(session: ScopedSession | null | undefined, req: ScopeRequest | null | undefined): boolean {
  if (!session) return false;

  // Unrestricted (legacy / owner) sessions: always in scope.
  if (session.scope === null || session.scope === undefined) {
    return true;
  }

  if (!req) return false;

  if (session.scope === 'file') {
    return checkFileScope(session.scope_data, req);
  }

  // Unknown scope value: fail closed. Adding a new scope kind requires an
  // explicit branch here so the security review surfaces it.
  return false;
}

function checkFileScope(scopeDataRaw: string | null | undefined, req: ScopeRequest): boolean {
  if (!scopeDataRaw || typeof scopeDataRaw !== 'string') return false;

  let parsed: FileScopeData;
  try {
    const decoded = JSON.parse(scopeDataRaw);
    if (!decoded || typeof decoded !== 'object') return false;
    parsed = decoded as FileScopeData;
  } catch {
    return false;
  }

  const candidateIds = [
    req.query?.uid,
    req.query?.file,
    req.query?.path,
    req.body?.uid,
    req.body?.file,
    req.body?.path,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  if (parsed.fileUid && typeof parsed.fileUid === 'string') {
    for (const cand of candidateIds) {
      if (cand === parsed.fileUid) return true;
    }
  }

  if (parsed.allowedPath && typeof parsed.allowedPath === 'string') {
    const candidatePaths = [
      ...candidateIds,
      typeof req.path === 'string' ? req.path : undefined,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    for (const cand of candidatePaths) {
      if (matchesAllowedPath(cand, parsed.allowedPath)) return true;
    }
  }

  return false;
}

/**
 * Prefix-match a candidate path against allowedPath, with anti-traversal:
 *   - exact match OR candidate starts with allowedPath followed by '/'
 *   - candidate must NOT contain '..' segments (defeats prefix bypass)
 */
function matchesAllowedPath(candidate: string, allowedPath: string): boolean {
  if (candidate.includes('..')) return false;
  if (candidate === allowedPath) return true;
  const prefix = allowedPath.endsWith('/') ? allowedPath : allowedPath + '/';
  return candidate.startsWith(prefix);
}
