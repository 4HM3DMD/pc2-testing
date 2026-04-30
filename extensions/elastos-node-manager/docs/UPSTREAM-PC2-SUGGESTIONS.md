# Upstream PC2 PR suggestions

These are improvements that would benefit ENM and other extensions but are **out of scope for v0.1** (we ship a pure extension and don't change PC2 core). They're documented here so a future ENM maintainer can hand them to the PC2 team as discrete PRs.

Numbered references in `Rev N` markers point to the audit revisions in our planning doc.

## 1. Fix `event.router` → `event.app` typo (Rev 6)

`pc2.net/pc2-node/main.js:104-123` references `event.router` but the install.routes lifecycle hook payload exposes `event.app`. PC2's own pc2-node routes likely don't mount today as a result. ENM defensively checks for `event.app` and warns if missing (`main.js:48-53`); no upstream fix needed for us, but the PC2 team should fix it for everyone else.

## 2. Add `signMessage` to IPC.js (Rev 3, Rev 5)

`pc2.net/src/gui/src/IPC.js:212-271` only implements `getTetheredDID` and `openDIDTether`. `signDigest` throws `"Signing requires Essentials wallet"`. Adding `signMessage` would let extensions implement true wallet signatures for OWNER-CONFIRMS flows (currently we rely on the session-token-tied owner check + 4s cooldown + checkbox + optional anti-snipe password).

ENM's v0.2 work item depends on this: once available, `proposal-card.js` would request `dao-wallet-request { action: 'signMessage', data: { message: proposalId } }` and submit the signature with the confirm POST.

## 3. Add `on('uninstall')` extension hook (Rev 5)

`pc2.net/src/backend/src/services/ExtensionService.js` currently has no uninstall hook. Without one, ENM's cleanup ships as `scripts/enm-uninstall.sh` (operator runs manually). An `extension.on('uninstall', async () => { ... })` hook would let extensions:
- Stop child processes
- Drop their DB tables
- Remove data dirs
- Cancel scheduled timers

That's a generic extension-framework improvement, not ENM-specific.

## 4. Audit log eviction in PC2 core (Rev 4)

PC2's `audit_logs` table is unbounded (`pc2-node/src/storage/database.ts:921`). ENM ships its own `enm_audit_logs` with retention sweep (`lib/EnmDb.js:cleanupOldAuditLogs`) and runs it on a 24h timer (`main.js:scheduleAuditSweeps`). The same pattern would benefit PC2's own audit log.

## 5. Generic registration API for `appMap`

The 3-line PC2 patch in `docs/PC2-PATCH.md` (apps.ts entry + RecommendedAppsService whitelist) is mechanical. A manifest-driven registration where `package.json` declares the appMap entry would eliminate that manual step for every new built-in or extension app.

## 6. Expose `requireOwner` / `encrypt` / `decrypt` / `broadcastToUser` to extensions

Currently extensions don't get access to PC2's middleware or services. ENM ships its own equivalents:
- `lib/OwnerCheckMiddleware.js` (~150 LOC) duplicates PC2's `requireOwner`
- `lib/EnmEncryption.js` duplicates AES-256-GCM with own key file
- SSE replaces socket.io's `broadcastToUser`

Exposing these via `install.services` would let extensions reuse PC2's hardened implementations rather than risking divergent crypto.

## 7. Fix `auditMiddleware` whitelist (Rev 6)

`pc2.net/pc2-node/src/api/audit.ts:16-31` (`AUDITED_ENDPOINTS`) is a hardcoded list. PC2's own middleware doesn't audit our routes because they're not in the list. Extensions ship their own audit middleware (we do — `lib/EnmAuditMiddleware.js`). A self-registering version would simplify this.

## 8. Sanitize body redaction list extension (Rev 6)

`sanitizeBody()` in audit.ts redacts `password|secret|token|key|api_key|private` but not our specific fields (`rpcPassword`, `signature`, `antiSnipePassword`, `encryptedPassword`). We redact in our own `EnmAuditLog.redactSensitive` (`lib/EnmAuditLog.js`). A pluggable redaction list would let extensions register additional sensitive field names.

---

None of these are blockers for ENM v0.1. They become opportunities once PC2 maintainers have bandwidth.
