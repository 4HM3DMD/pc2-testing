# Wave 7 — Defence-in-Depth Polish (CORS / Token Logging / Capsule Signing)

**Task ID**: `SEC-2026-04-22-WAVE7-POLISH`
**Created**: 2026-04-22
**Status**: 🟢 **Proposed — awaiting Sash approval. Targets v1.2.2 (≤ T+30 days post-v1.2 release) or v1.3.**
**Priority**: P2 — quality-of-defence, not exploit-blocking
**Findings closed**: A13 (CORS suffix matching), A14 (token logging), A15 (capsule signing — formalise v2 plan)
**Source**: Internal audit performed 2026-04-22. See [`SEC_2026_04_21_AUDIT_DISPOSITION.md`](../../../docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md) §"Internal Audit Findings (2026-04-22)".

---

## TL;DR for a 9th grader

These three are the lowest-severity items from the post-jhond0e internal audit. None can be exploited on their own, but each one would amplify a different kind of future bug:

1. **A13 — CORS** — our list of allowed websites that can talk to the node uses a substring check (`.includes('.ela.city')`), which would also accept `evil-ela.city.attacker.example`. Today we don't `Access-Control-Allow-Credentials: true` for those, so it's fine — but tighten the check now while it's a one-liner.
2. **A14 — token logging** — the audit log writes the full session token to disk at INFO level. Anyone who can read the journal can replay any active session. Redact to first/last 4 chars.
3. **A15 — capsule app installs** — when an app's signature can't be verified, we currently log a warning and install it anyway. This is intentional for v2 dev-mode, but Wave 7 documents it explicitly so we don't forget to flip it on by v2 release.

These are pure polish. They go out as v1.2.2 or roll into v1.3, whichever is convenient.

---

## Why this wave exists

Once Waves 1-6 close, the remaining audit items are quality-of-defence:
- A13 doesn't open a hole today, but it would open one the moment someone adds `Access-Control-Allow-Credentials: true` to that block.
- A14 doesn't open a hole today, but logs are *the most common second-order leak* in any incident — a stolen log file with full tokens is a stolen session.
- A15 is a known v2 gap; formalising it in a wave doc means it gets re-evaluated at every release.

These are also the items most amenable to passing through a junior pair-rotation — small surface, easy to verify.

---

## What this wave does

### Fix A13 — CORS suffix match

**File**: `pc2-node/src/api/middleware.ts`

**Today** (lines 440-444):
```ts
origin.includes('.puter.localhost') ||
origin.includes('.puter.me') ||
origin.includes('.puter.site') ||
origin.includes('.ela.city') ||
origin.includes('.ela.local');
```

`evil-ela.city` matches `.ela.city`. Today we do **not** set `Access-Control-Allow-Credentials: true` for these origins, and `Authorization` is sent explicitly by JS rather than as a cookie, so the practical risk is low. But an attacker-controlled subdomain could still read response bodies of any unauthenticated endpoint.

**Fix**:
1. Change to a structured suffix match using the WHATWG URL parser:
   ```ts
   const ALLOWED_ORIGIN_SUFFIXES = [
     '.puter.localhost',
     '.puter.me',
     '.puter.site',
     '.ela.city',
     '.ela.local',
   ];
   try {
     const parsed = new URL(origin);
     const host = parsed.hostname.toLowerCase();
     if (ALLOWED_ORIGIN_SUFFIXES.some(s => host === s.slice(1) || host.endsWith(s))) {
       return true;
     }
   } catch { /* invalid origin → falls through to deny */ }
   ```
2. Remove `.ela.local` from the LAN-default list — mDNS hostnames are claimable by anyone on the same network. Move it to an opt-in via `config.cors.allowLan = true` for advanced users.
3. Keep the existing iframe-app origin handling intact (those use the `*.puter.*` family and pass through their own scope-token gate).

**UX impact**:
- Owners on `*.ela.city` desktop builds: unchanged.
- Owners on `*.ela.local` LAN builds: must opt in via `config.cors.allowLan = true` (CLI flag at install time, default off). Worth a CHANGELOG line; affects very few users.

### Fix A14 — Redact session tokens in audit log

**File**: `pc2-node/src/api/middleware.ts`

**Today** (lines 224-230):
```ts
logger.info('Token extracted', {
  // …
  tokenFull: token.length <= 100 ? token : `${token.substring(0, 100)}...`,
});
```

This writes ≤100 chars of every session token to journalctl at INFO. PC2 session tokens are 64 hex chars, so the full token gets written. Anyone who can `journalctl -u pc2-node` can grep for `Token extracted` and replay any session.

**Plus**: the `auditMiddleware` (next ~50 lines) logs the full `Referer` header, which can carry a token in a query string for some callers.

**Fix**:
1. Replace `tokenFull: ...` with `tokenFingerprint: tokenSha256(token).slice(0, 16)` — a 16-char SHA256 prefix is enough to correlate two log lines without being replayable.
2. Add a helper `redactToken(t)` that returns `${t.slice(0,4)}…${t.slice(-4)}` for the cases where we want a human-recognisable hint.
3. In `auditMiddleware`, scrub `?token=…`, `?session=…`, `?provisioningToken=…` from logged URLs (referer + request URL). Use a single `redactQueryParams(url)` helper.
4. Sweep the rest of `pc2-node/src` for `logger.*("...", { token })` and similar. Replace each with the helper.
5. Add an integration test that boots the server, makes an authenticated call, captures the log output, and asserts the token is **not** present in any log line. Currently the only easy-to-verify "doesn't leak" test we have.

**UX impact**: Zero for users. Operations gets a slightly less convenient debug log (no full token), which is the point.

### Fix A15 — Capsule signature enforcement (formalise the v2 plan)

**Files**:
- `pc2-node/src/services/AppInstallService.ts` (line ~234)
- `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` (add to Phase D)
- New: `.cursor/tasks/V2-APP-CAPSULE-SIGNING/V2-APP-CAPSULE-SIGNING.md`

**Today**: `AppInstallService.ts:234` warns about unsigned capsules but proceeds:
```ts
if (!verifyResult.valid) {
  logger.warn(`[AppInstall] Unsigned/unverified capsule: ${appId} — installing anyway (capsule-unsigned)`);
}
// proceeds to install
```

This is the right behaviour for v1.x because (a) the signing infrastructure isn't fully deployed, (b) blocking unsigned apps would brick the app catalog. It is **not** the right behaviour for v2.

**Wave 7 action**:
1. **No code change in v1.x.** The warn-and-proceed pattern stays.
2. Add a **task doc** at `.cursor/tasks/V2-APP-CAPSULE-SIGNING/V2-APP-CAPSULE-SIGNING.md` that captures:
   - The current behaviour (warn-only)
   - The v2 target behaviour (block unsigned by default; opt-in `--allow-unsigned` flag for development)
   - What signing infrastructure has to land first (cert authority for app publishers, signature-included manifest schema, key-rotation story)
   - The migration path: dual-period where unsigned still installs but warns more loudly in the UI
3. Add an entry to Phase D of the disposition doc so this is visible from the central document.
4. Add a metrics counter in `AppInstallService.ts` so we can see *how many* unsigned installs happen in the wild during v1.x — informs the v2 cutover threshold.

**UX impact**: Zero in v1.x. The doc is preparation for v2.

---

## Telemetry log format

```
[cors] denied origin=… reason=not-in-suffix-list
[cors] allowed origin=… match=*.ela.city
[audit] req=GET path=/api/foo wallet=0x…1234 token-fp=abcd1234ef567890
[capsule] install-warn appId=… verify=unsigned counter=<n>
```

The `token-fp` lets ops correlate one user's actions across calls without writing the token itself. The `[capsule] counter=<n>` lets us track unsigned-install volume over time.

---

## Smoke matrix

| # | Test | Expected |
|---|------|----------|
| 1 | CORS preflight from `https://app.ela.city` | 200 with CORS headers |
| 2 | CORS preflight from `https://evil-ela.city.attacker.example` | 403 / no CORS headers |
| 3 | CORS preflight from `https://node-abc.ela.local` (allowLan=false) | 403 |
| 4 | CORS preflight from `https://node-abc.ela.local` (allowLan=true) | 200 |
| 5 | Make any authed request, then `journalctl -u pc2-node \| grep <full-token>` | 0 hits |
| 6 | Same, then `journalctl \| grep <token-first-16-chars>` | 0 hits (only fingerprint shown) |
| 7 | Make request with `?token=ABCDEF1234` in URL | log shows `?token=…` redacted |
| 8 | Install an unsigned capsule | succeeds with `[capsule] install-warn` log + counter increments |
| 9 | Install a signed capsule | succeeds without warn line |

Test harness: `pc2-node/tests/security/wave7-smoke.sh` + `wave7-no-token-leak.test.js`.

---

## Files

### Modified

- `pc2-node/src/api/middleware.ts` — CORS suffix match (A13), token redaction in `auditMiddleware` + `Token extracted` log (A14), referer-URL scrubbing
- `pc2-node/src/services/AppInstallService.ts` — install-warn counter only (no behaviour change for A15)
- `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` — Phase D entry for v2 capsule signing

### Created

- `.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/SEC-2026-04-22-WAVE7-POLISH.md` (this file)
- `.cursor/tasks/V2-APP-CAPSULE-SIGNING/V2-APP-CAPSULE-SIGNING.md` — v2 design doc for A15
- `pc2-node/tests/security/wave7-smoke.sh`
- `pc2-node/tests/security/wave7-no-token-leak.test.js`

---

## Deploy plan

1. **Bundle as `v1.2.2`** (or fold into v1.3 if Wave 6 takes longer than 14 days).
2. **Quality gates**: standard.
3. **Roll out**: standard PC2 update channel.
4. **Monitor**: `[cors] denied` count should be near zero in normal use; spikes are signal.

---

## Rollback

| Fix | Reverts to |
|---|---|
| A13 | Loose substring CORS; no live exploit but defence weaker |
| A14 | Full tokens in logs; no exploit alone, but compounds any log-leak incident |
| A15 | No change — Wave 7 doesn't ship code for A15, just documents the v2 plan |

Standard rule: fix forward.

---

## Acceptance criteria

- [ ] `rg "origin.includes\(" pc2-node/src/api/middleware.ts` returns 0
- [ ] `rg "tokenFull" pc2-node/src` returns 0 outside test code
- [ ] `wave7-no-token-leak.test.js` proves no token appears in any log line during a typical authenticated session
- [ ] `.cursor/tasks/V2-APP-CAPSULE-SIGNING/V2-APP-CAPSULE-SIGNING.md` exists with v2 cutover plan
- [ ] All wave7-smoke cases pass

---

## UX notes

| User type | Before Wave 7 | After Wave 7 |
|---|---|---|
| Owner on `*.ela.city` | Works | Works |
| Owner on `*.ela.local` (LAN install) | Works (loose CORS) | Works only if `config.cors.allowLan=true` (one-time install flag) |
| Operator reading logs | Sees full session tokens | Sees fingerprints only — same correlation power, no replay |
| App developer publishing capsule | Warn-only on unsigned | Warn-only (unchanged in v1.x); v2 will block by default |

The `.ela.local` opt-in is the only user-visible change. The CHANGELOG line:

> **🔒 Security:** mDNS-style `*.ela.local` origins are no longer in the default CORS allowlist — set `config.cors.allowLan = true` if your install relies on LAN access. Most users see no change.

---

## Open questions for Sash before kickoff

1. **A13 — `.ela.local`**: are there current production users on `.ela.local` that would break? (We can grep the desktop app's origin handling to be sure.)
2. **A15 — v2 cutover**: target date for v2 capsule signing? Helps prioritise the supporting infrastructure (publisher cert authority).
3. **A14 — token fingerprints**: 16-char SHA-256 prefix OK for ops correlation, or do you want more (24, 32)?
