# Task: PC2 Security Triage 2026-04-21 (External Audit Findings)

**Task ID**: SEC-2026-04-21-PC2-AUDIT
**Created**: 2026-04-21
**Status**: 🟡 In Progress — Wave 0.5 + Wave 1 + Wave 2 shipped, Wave 3-5 pending
**Priority**: **P0 — Critical Security**
**Scope**: PC2 node (`pc2-node/`) + web-gateway (`deploy/web-gateway/`) + Particle Auth GUI (`packages/particle-auth/`)
**Out of scope**: `cloud.ela.city` rotation runbook (deferred), iframe app token re-issue (SEC-3d backlog)

---

## TL;DR

External security review (2026-04-21) flagged **11 vulnerabilities** in
the PC2 node / web-gateway / GUI auth stack — 5 Critical, 6 High. Of
those, **7 affect the PC2 stack directly** and are fixed under this
task. The remaining 4 are tracked separately (4 are `cloud.ela.city`
ops/rotation items handled by infra; SEC-11 DID JWT verify is demoted
to Wave 5 because production traffic is < 1 %).

**The seven in-scope findings, by severity:**

| ID    | Severity | One-line                                                  | Wave |
|-------|----------|-----------------------------------------------------------|------|
| SEC-2 | Critical | RCE via shell-injection in web-gateway `execSync` template | 3    |
| SEC-3a| Critical | `/auth/particle` accepts unsigned wallet claims (impersonation) | 2    |
| SEC-3c| Critical | `mock-token-*` lets anyone hijack any wallet's session     | 1    |
| SEC-7 | Critical | `/api/setup/*` exposes mnemonic to unauthenticated callers | 2    |
| SEC-8 | High     | `/api/wireguard/register` accepts unauthenticated re-keys | 3    |
| SEC-9 | High     | `/api/users/{u}` allows unauthenticated user deletion     | 3    |
| SEC-10| High     | `/api/update/install` is unauthenticated `git pull && npm install && restart` (RCE) | 1 |

Plus four supporting hardening items uncovered during planning:

| ID                  | Severity | One-line                                                          | Wave |
|---------------------|----------|-------------------------------------------------------------------|------|
| SEC-TRUST-PROXY     | High     | `app.set('trust proxy', true)` lets attackers spoof `req.ip`      | 2    |
| SEC-CORS-AUDIT      | Medium   | CORS allowlist missing `*.ela.city` / `*.ela.local` for SIWE flow | 2    |
| SEC-INFRA-GW-AUTH   | High     | Web-gateway has no per-node provisioning token (foundation for SEC-2/8/9) | 3 |
| SEC-CI-SECRETSCAN   | Medium   | No CI secret-scanning; `.vscode/.idea/.env*` historically leaked   | 4    |

---

## Wave Plan

### Wave 0.5 — Spec-first test pre-write ✅ (commit `80168f706`)

`pc2-node/tests/security/` — 79 spec cases across 5 helper test
files. All spec assertions are skipped until the matching helper
ships, but `npm run test:security` exits 0 today.

- `firstRunToken.test.js` — single-use, TTL-bound boot token
- `scope-check.test.js` — scoped session resource check
- `requireProvisioningToken.test.js` — gateway HMAC auth (Wave 3)
- `siwe-verify.test.js` — EVM EOA + EIP-1271 + Solana ed25519
- `did-jwt-verify.test.js` — Elastos DID JWT verify (Wave 5)

**Why pre-write**: forces every Wave 1-5 helper to satisfy a concrete
contract before merging. No "I'll write tests later". Catches
forgotten edge cases (zero-length nonce, empty arrays, replay,
expired TTL) at design time.

### Wave 1 — Auth lockdown + scoped sessions ✅ (commit `80168f706`)

- **SEC-10**: `/api/update/*` now requires `authenticate +
  requireOwner`. RCE removed. 60 s throttle on `/install`, 30 s on
  `/check-github` (anti-abuse). Owner wallet logged on install for
  audit.
- **SEC-3c**: deleted both `mock-token-*` and `token-0x{wallet}-*`
  branches from `src/api/middleware.ts` (~88 LOC of dangerous
  wallet-inference code). Replaced one legitimate consumer in
  `src/api/other.ts` with a real **scoped session** bound to the file
  path, with TTL and resource check enforced via new
  `scope-check.ts` helper. Migration #29 adds `scope` + `scope_data`
  columns to `sessions`. Strict rewrite of `whoami.ts`. Removed
  `isAppToken` branch from `info.ts:264`.

### Wave 2 — SIWE + setup auth + transport hardening ✅ (THIS COMMIT)

- **SEC-3a**: SIWE (Sign-In With Ethereum, EIP-4361) + EIP-1271
  smart-contract sigs + Solana SIWS ed25519 signatures. Three new
  server helpers:
    - `pc2-node/src/api/auth/challenge-store.ts` — in-memory,
      single-use, 5-min TTL nonce store
    - `pc2-node/src/api/auth/siwe-verify.ts` — verifier
      (EVM/EIP-1271/Solana)
    - `pc2-node/src/api/setup/first-run-token.ts` — single-use boot
      token printed to console for first-run setup
  Three endpoint changes:
    - `GET /auth/challenge` (new) — issues nonces
    - `POST /auth/particle` — if `siweRequired=true`, blocks
      unsigned claims; ownership claim path also requires intent
      proof (loopback / `firstRunToken` / anti-snipe cookie)
    - `POST /api/access/claim-ownership` — same intent + SIWE gate
  Frontend (`packages/particle-auth/.../ParticleNetworkContext.tsx`)
  fetches the challenge, signs with `personal_sign`, and POSTs the
  signature alongside the Particle JWT.
  **Kill-switch**: `siweRequired=false` by default → zero risk
  rollout. Flip to `true` once GUI is rolled out.

- **SEC-7**: New `requireSetupAuth` middleware on
  `/api/setup/{info,mnemonic,acknowledge-mnemonic,
  mnemonic-sign-message}` — requires loopback or
  `X-First-Run-Token`. Token is minted at boot and printed to
  stdout / journalctl for remote setup.

- **SEC-TRUST-PROXY**: `app.set('trust proxy', ...)` tightened from
  `true` to `'loopback, linklocal, uniquelocal'`. All security
  decisions still use `req.socket.remoteAddress` for defence in
  depth.

- **SEC-CORS-AUDIT**: `corsMiddleware` allowlist extended to
  `*.ela.city` and `*.ela.local` so the SIWE wiring works from any
  Elacity origin.

### Wave 3 — Web-gateway lockdown ⏳ (next)

- **SEC-INFRA-GW-AUTH**: per-node provisioning token (HMAC) issued
  by the gateway and stored locally on the PC2 node. Foundation for
  SEC-2/8/9 — every gateway-facing endpoint will require it.
- **SEC-2**: replace `execSync` template literal with
  `execFileSync` + strict allowlist regex. Sweep all `execSync`
  sites in `deploy/web-gateway/index.js`.
- **SEC-8**: re-key endpoint (`/api/wireguard/register`,
  `/api/awg/register`) requires WireGuard signature from the **old**
  key + provisioning token.
- **SEC-9**: `DELETE /api/users/{u}` restricted to self-only +
  per-username rate limit + provisioning token.

### Wave 4 — CI / secret hygiene ⏳

- **SEC-CI-SECRETSCAN**: gitleaks / trufflehog as pre-commit hook
  + GitHub Action. Sweep `.vscode/.idea/.env*` across the entire
  repo history.

### Wave 5 — DID hardening (deprioritised, low traffic) ⏳

- **SEC-11 spike** (1 day) — verify Essentials walletaccess scheme
  echoes server-issued `?state=` in callback body.
- **SEC-11** (full) — JWT signature verification against Elastos
  DID resolver, 24 h DID-doc cache, audit log + owner notification
  on tether writes.

---

## Files

### Created

- `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/SEC-2026-04-21-PC2-AUDIT.md` (this file)
- `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-2-SIWE-AND-SETUP.md` (Wave 2 detail)
- `pc2-node/tests/security/{firstRunToken,scope-check,requireProvisioningToken,siwe-verify,did-jwt-verify}.test.js` (Wave 0.5)
- `pc2-node/tests/security/README.md` (Wave 0.5)
- `pc2-node/src/api/auth/challenge-store.ts` (Wave 2)
- `pc2-node/src/api/auth/siwe-verify.ts` (Wave 2)
- `pc2-node/src/api/setup/first-run-token.ts` (Wave 2)
- `pc2-node/src/api/setup/setup-auth.ts` (Wave 2)
- `pc2-node/src/api/scope-check.ts` (Wave 1)
- `pc2-node/src/db/migrations/029-session-scope.ts` (Wave 1)

### Modified

- `pc2-node/src/api/auth.ts` — SIWE challenge route + verify on `/auth/particle`
- `pc2-node/src/api/access-control.ts` — SIWE + intent gate on claim-ownership
- `pc2-node/src/api/index.ts` — register `/auth/challenge`
- `pc2-node/src/api/middleware.ts` — CORS allowlist (Wave 2); deleted mock-token branches (Wave 1)
- `pc2-node/src/api/setup.ts` — apply `requireSetupAuth` to mnemonic endpoints
- `pc2-node/src/api/update.ts` — `authenticate + requireOwner` (Wave 1)
- `pc2-node/src/api/other.ts` — scoped session (Wave 1)
- `pc2-node/src/api/whoami.ts` — strict rewrite (Wave 1)
- `pc2-node/src/api/info.ts` — drop `isAppToken` branch (Wave 1)
- `pc2-node/src/config/loader.ts` — `siweRequired` flag
- `pc2-node/src/server.ts` — tighten `trust proxy`; mint + print first-run token
- `packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx` — SIWE client wiring (+ rebuilt bundle)

---

## Acceptance Criteria

### Wave 1 ✅
- [x] `npm run test:security` passes (50 active, 29 skipped for later waves)
- [x] `npx tsc -p pc2-node --noEmit` 0 errors
- [x] ESLint clean on touched files
- [x] `/api/update/install` returns 401 without owner session
- [x] `mock-token-*` no longer accepted anywhere

### Wave 2 ✅
- [x] Same test/type/lint gates as Wave 1
- [x] `GET /auth/challenge` issues a single-use nonce
- [x] `POST /auth/particle` with `siweRequired=true` rejects missing/invalid signatures
- [x] Kill-switch (`siweRequired=false`) preserves legacy behaviour byte-for-byte
- [x] `/api/setup/mnemonic` returns 403 from non-loopback without `X-First-Run-Token`
- [x] First-run token logged to stdout on boot
- [x] CORS allows `*.ela.city` + `*.ela.local`
- [x] `req.ip` no longer trusts arbitrary `X-Forwarded-For`
- [x] User confirmed end-to-end fresh login: SIWE prompt appears,
      `✅ SIWE signature verified` in server logs

### Wave 3 ⏳ (TBD)

---

## Risk & Rollback

Every Wave 2 change has a kill-switch or is fail-open by default:

- **SIWE** (`SEC-3a`): `siweRequired=false` by default → server logs
  the verification result but does not enforce. Flip in `config.json`
  to enforce. No client work blocks server rollout.
- **`requireSetupAuth`** (`SEC-7`): loopback always allowed → CLI
  setup unaffected. Remote setup uses the boot-printed token.
- **`trust proxy`**: tightened only — still trusts the LAN reverse
  proxy. No traffic blocked.
- **CORS**: allowlist **extended**, never reduced. No new origins
  rejected.

Rollback path for any single fix: revert the named commit.
`SEC-3c` rollback requires DB migration #29 to be backed out (rename
`sessions.scope` and `sessions.scope_data` to keep schema valid).

---

## References

- External audit report: see private security inbox 2026-04-21
- SIWE spec: https://eips.ethereum.org/EIPS/eip-4361
- EIP-1271: https://eips.ethereum.org/EIPS/eip-1271
- Solana SIWS: https://github.com/phantom/sign-in-with-solana
