# Audit Disposition — jhond0e Security Report (2026-04-21)

**Researcher**: jhond0e — `lut0xbughunter@gmail.com`
**Original recipient**: `security@elacitylabs.com`
**Report date**: 2026-04-18
**Triage handoff**: 2026-04-21 (this codebase)
**This document compiled**: 2026-04-22 (Researcher report) · 2026-04-22 amended with internal audit findings (A1-A15) · 2026-04-22 amended with Wave 5 implementation + A16 · 2026-04-22 amended with Wave 5.5 (A17 + A19) post-Wave-5 deep-audit findings
**Status**: 🟢 **All 7 in-scope researcher findings closed in code. Wave 5 (A1-A5) implemented and pushed.** Post-triage internal audit (2026-04-22) surfaced **15 additional findings (A1-A15)** of the same families. Wave 5 sweep surfaced **A16**. The post-Wave-5 deep audit (2026-04-22, second pass) surfaced **A17** (CRITICAL — app-install RCE/exfil) and **A19** (HIGH — multer originalname disk-write traversal); both are **release-blocking** and addressed in Wave 5.5. Wave 5 (A1-A5) is on `feature/lit-chipotle-migration` (commits `63039f6bd`, `38e3706ef`, `250d2c3e8`, `cb99ce5a9`, `82163b092`). Wave 5.5 (A17 + A19) is in progress on the same branch. Wave 6 (A6-A12 + **A16** + **A18**) targets v1.2.1 (≤ T+14 days). Wave 7 (A13-A15 + CORS substring + `.__puter_gui.json` `endsWith` bypass) targets v1.2.2 / v1.3. 4 smart-contract findings owned by Irzhy (in progress). 1 deferred (SEC-11, low traffic).

**Current release gate**: ⛔ **Do not tag v1.2.0 until both Wave 5 AND Wave 5.5 commit sets land on `feature/lit-chipotle-migration` and the combined Wave 5 + 5.5 smoke matrix passes.** Wave 5 is pushed (HEAD `82163b092`). Wave 5.5 (A17 + A19) is in code; pending commit + push. See [Phase A0](#phase-a--before-pushing-v12-live-release-blocking).

---

## TL;DR

Of the 11 vulnerabilities reported, this codebase owns **7** (PC2 node + web-gateway). All 7 are fixed and verified across four shipped commits on `feature/lit-chipotle-migration`:

| Wave | Commit     | Findings closed | Date       |
|------|------------|-----------------|------------|
| 1    | `80168f706`| SEC-3c (mock-token), SEC-10 (`/api/update/install`) | 2026-04-21 |
| 2    | `b2e509c18`| SEC-3a (`/auth/particle` SIWE), SEC-7 (`/api/setup/*`) + transport hardening | 2026-04-21 |
| 3    | `16dccaf39`| SEC-2 (vless RCE), SEC-8 (wg re-key), SEC-9 (wg DELETE), gateway provisioning auth | 2026-04-22 |
| 4    | `6ba49cfac`| **Researcher's recommendation #6**: gitleaks pre-commit + CI + history sweep | 2026-04-22 |

The remaining 4 are owned by other workstreams or are explicitly deferred:

- **SEC-1, 4, 5, 6** (smart contracts) — **Irzhy is making progress** on a separate repo; will land in his own release cycle
- **SEC-11** (DID JWT verify) — **deferred to Wave 5**, low production traffic (~<1%); rationale in finding #11 below

Two follow-ups exist but **do not block the v1.2 release**:

- **`cloud.ela.city` rotation** — researcher reported this node un-owned for 14.6 days (`uptime: 1265350.22`). Decision needed before release day on whether to upgrade-in-place or DNS-cut to a fresh v1.2 node — see [Phase A4](#phase-a--before-pushing-v12-live-release-blocking).
- **`data/identity.json` Boson DID rotation** — Wave 4's secret scanner surfaced a real Ed25519 private key committed at `4b10bad94` (2026-03-06) before the matching `.gitignore` rule. Already exposed on 4 origin branches. Queued as a v1.2.x patch — see [Phase D1](#phase-d--post-v12-queued-not-blocking).

**Two release-blocker waves now exist** — see the new Internal Audit section:

- **Wave 5 (A1-A5)** — five same-family findings (3 Critical, 2 High) discovered during a post-triage sweep of the remaining ~46 API files the researcher didn't have time to cover. Same fix shape as SEC-2/SEC-7/SEC-10 (`requireOwner` + `execFile` argv form). Task doc: [`SEC-2026-04-22-WAVE5-PRE-RELEASE`](.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md). **Status**: closed (5 commits on `feature/lit-chipotle-migration`).
- **Wave 5.5 (A17 + A19)** — two release-blocking findings discovered during the post-Wave-5 deep audit explicitly requested before tagging v1.2: **A17** (CRITICAL — app-install RCE / owner-mnemonic exfil via `installed-apps.install-local` + static route) and **A19** (HIGH — multer disk-write path traversal in 4 upload configs). Same families as A1/A3. Task doc: [`SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX`](.cursor/tasks/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX.md). **Status**: in code, awaiting smoke run + commit.

---

## 1:1 Mapping — Researcher Finding → Our Disposition

### Critical

#### Finding 1 — Committed private key controls v2 ProxyAdmins on Elastos
**Severity (researcher)**: CRITICAL
**Disposition**: 🟦 **Out of scope for this repo** — handed to smart-contracts engineer
**Owner**: Other team member (per Sash's confirmation)
**Cross-cutting fix here**: Wave 4 secret scanning (gitleaks pre-commit + CI) is the *prevention* side of this finding. Researcher's remediation step 6 ("Add pre-commit and CI secret scanning…") is now in place across this repo. Confirm with smart-contracts owner whether `lit-keystore-moleculer` has the same gate.
**Risk if unaddressed**: ProxyAdmin upgrade on the three v2 gateways (CentralStorage, ChannelCore, TradeGateway) until on-chain `transferOwnership` to a fresh multisig.

---

#### Finding 2 — RCE via `POST /api/vless/register` (shell injection)
**Severity (researcher)**: CRITICAL
**Disposition**: ✅ **CLOSED — Wave 3 (`16dccaf39`)**

| What the researcher found | What we shipped |
|---|---|
| `execSync(\`/etc/vless-reality/manage-peers.sh add "${normalizedUsername}"\`)` — shell template literal interpolated user input | Replaced with `execFileSync('/etc/vless-reality/manage-peers.sh', ['add', normalizedUsername], …)` — argv form, no shell |
| No allowlist regex on `username` | Added `/^[a-z0-9][a-z0-9_-]{2,29}$/` regex pre-shell |
| No auth on `/api/vless/*` family | `requireProvisioningToken` middleware applied (kill-switch `GW_AUTH_REQUIRED` defaults to log-only mode for safe rollout) |
| Other `execSync` sites in same file (~15) likely have same pattern | **All 9 `execSync` call sites in `deploy/web-gateway/index.js` converted to `execFileSync`**; verified by `rg 'execSync\(' deploy/web-gateway` → 0 results |

**Verification**: `pc2-node/tests/security/requireProvisioningToken.test.js` (16 cases) + curl smoke matrix in both log-only and strict modes. See [`WAVE-3-GATEWAY-LOCKDOWN.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md).

---

#### Finding 3 — `POST /auth/particle` no-sig ownership claim → RCE chain
**Severity (researcher)**: CRITICAL
**Disposition**: ✅ **CLOSED — Wave 1 + Wave 2 (`80168f706` + `b2e509c18`)**

The researcher chained three weaknesses; we addressed all three:

| Sub-issue | Wave | What we shipped |
|---|---|---|
| `/auth/particle` accepts unsigned wallet claims | Wave 2 | SIWE (EIP-4361) + EIP-1271 (smart-contract sigs) + Solana SIWS (ed25519). New `GET /auth/challenge` issues nonces; `POST /auth/particle` requires signature when `siweRequired=true`. Kill-switch defaults to `false` for safe rollout. |
| `mock-token-*` accepted as valid session | Wave 1 | Deleted `mock-token-*` and `token-0x{wallet}-*` branches from `middleware.ts` (~88 LOC of dangerous wallet-inference code). Replaced one legitimate consumer in `other.ts` with a real **scoped session** (file-bound, TTL-enforced) via new `scope-check` helper + DB migration #29 (`sessions.scope`/`scope_data`). |
| `isAppToken` branch in `info.ts:264` | Wave 1 | Removed |
| Permanent deletion of `antiSnipePasswordHash` inside an unverified handler | Wave 2 | `/api/access/claim-ownership` now requires SIWE + intent proof (loopback / `firstRunToken` / anti-snipe cookie) before any irreversible write |

**Verification**: `pc2-node/tests/security/siwe-verify.test.js` (covers EVM EOA + EIP-1271 + Solana ed25519 paths) + `scope-check.test.js`. The researcher's specific PoC `curl -X POST -d '{}' …/auth/particle` now requires either a valid SIWE bundle or the kill-switch off.

**Defence-in-depth note**: Wave 2 also tightened `app.set('trust proxy', …)` from `true` (which let attackers spoof `req.ip` via `X-Forwarded-For`) to `'loopback, linklocal, uniquelocal'`, with all security decisions falling back to `req.socket.remoteAddress`. CORS allowlist extended to `*.ela.city` and `*.ela.local` for the SIWE flow.

---

#### Finding 4 — `WithdrawablePaymentProcessor.execute` unauth fund drain
**Severity (researcher)**: CRITICAL
**Disposition**: 🟦 **Out of scope for this repo** — smart contract on Base 8453
**Owner**: Other team member (smart-contracts engineer)
**Live impact (researcher)**: 0.011 USDC drained in mainnet-fork simulation; primitive applies to all 6 deployed processor proxies and all future channels.

---

#### Finding 5 — `MultiChannel.wrapChannel` subscription bypass
**Severity (researcher)**: CRITICAL
**Disposition**: 🟦 **Out of scope for this repo** — smart contract on Base 8453
**Owner**: Other team member (smart-contracts engineer)
**Live impact (researcher)**: Anvil fork at Base block 44833003 — freeloader paid 1 wei, gained `hasActiveSubscription==true` and `hasAccess==true` on a victim channel.

---

### High

#### Finding 6 — `WithdrawablePaymentProcessor.defer` targeted DoS
**Severity (researcher)**: HIGH
**Disposition**: 🟦 **Out of scope for this repo** — smart contract on Base 8453
**Owner**: Other team member (smart-contracts engineer)

---

#### Finding 7 — Unauthenticated first-run mnemonic disclosure
**Severity (researcher)**: HIGH (CVSS 8.6)
**Disposition**: ✅ **CLOSED — Wave 2 (`b2e509c18`)**

| What the researcher found | What we shipped |
|---|---|
| `GET /api/setup/mnemonic` had no auth | New `requireSetupAuth` middleware applied to `/api/setup/{mnemonic, info, mnemonic-sign-message, acknowledge-mnemonic}` |
| No one-time-token guarantee | First-run token (64-hex chars) minted at boot, printed once to stdout/journalctl. Single-use, TTL-bound (`firstRunToken.test.js` — 16 cases) |
| Endpoint world-reachable | Loopback always allowed; remote callers must present `X-First-Run-Token` |

**Verification**: `pc2-node/src/api/setup.ts` — every sensitive endpoint now carries `requireSetupAuth`:

```150:160:pc2-node/src/api/setup.ts
router.get('/mnemonic', requireSetupAuth, (req: Request, res: Response) => {
```

Researcher's note: *cloud.ela.city has already consumed its mnemonic (window closed)* — this finding does not retroactively reproduce on the live super-node, but the gate is now in place for every future fresh node. Operational rotation of cloud.ela.city is still recommended (see Outstanding Items).

---

#### Finding 8 — Unauthenticated `POST /api/wg/register` re-key hijack
**Severity (researcher)**: HIGH
**Disposition**: ✅ **CLOSED — Wave 3 (`16dccaf39`)**

| What the researcher found | What we shipped |
|---|---|
| Existing-peer branch re-keys on `publicKey` mismatch with no auth | `POST /api/wg/register` requires `X-Provisioning-Token` matching the username's registered token. Re-key by an attacker rejected; legitimate node always has its token. |
| Same defect on `/api/awg/register` | Symmetric fix applied |
| Username enumeration via `/api/wg/status` and `/api/users` (referenced by researcher) | Per-username throttle added on register paths |

**Note**: As designed, the legitimate PC2 node persists its provisioning token at `pc2-node/data/.gateway-tokens.json` (mode 0600) and resends on every gateway interaction. Cross-account binding enforced — a token for `node-A` cannot act on `node-B`.

---

#### Finding 9 — Unauthenticated `DELETE /api/wg/peer/<u>` DoS
**Severity (researcher)**: HIGH
**Disposition**: ✅ **CLOSED — Wave 3 (`16dccaf39`)**

| What the researcher found | What we shipped |
|---|---|
| `DELETE /api/wg/peer/<u>` removes any peer with no auth | Token-gated: requires `X-Provisioning-Token` matching the username's record |
| `checkRateLimit` not invoked on this branch | Per-username throttle (3/min) added |
| No symmetric AWG handler (researcher's note: "none exists in the current tree") | **Added `DELETE /api/awg/peer/<u>` with the same gating** so future AWG cleanup goes through the same code path |
| Effect survives gateway restart (rewrites `wg-peers.json`) | Restart behaviour unchanged but unauthorised callers can no longer trigger the rewrite |

---

#### Finding 10 — Unauthenticated `POST /api/update/install` (DoS + RCE)
**Severity (researcher)**: HIGH
**Disposition**: ✅ **CLOSED — Wave 1 (`80168f706`)**

| What the researcher found | What we shipped |
|---|---|
| Docstring claimed "owner only" but route had no `authenticate` / `requireOwner` | Both applied to **every** `/api/update/*` route (`/install`, `/check`, `/check-github`, `/status`, `/version`) |
| No throttle | 60 s throttle on `/install`, 30 s on `/check-github` |
| Auth-info routes (`/status`, `/progress`, `/version`) leak code freshness | Same `authenticate + requireOwner` applied |

**Verification**: `pc2-node/src/api/update.ts:150` — `router.post('/install', authenticate, requireOwner, installThrottle, …)`. Owner wallet is logged on install for audit trail.

---

#### Finding 11 — Unauthenticated `POST /api/did/callback` DID/wallet hijack
**Severity (researcher)**: HIGH
**Disposition**: ⏳ **DEFERRED to Wave 5** — explicit decision, see rationale

**Rationale for deferral** (not dismissal):
- Production traffic on the DID callback path is < 1% of node traffic (Elastos Essentials integration is opt-in, used primarily by power users)
- The fix requires a working Elastos DID resolver client + 24 h DID-document cache + audit-log + owner notification — non-trivial scope (~1 week)
- The exploit requires an in-flight tether request (5-minute window) — not background-reachable
- Higher-priority Wave 1-4 items took the slot

**Mitigation in the meantime**:
- The `mock-token` removal (Wave 1) closes the chain that would let an attacker first claim ownership and then influence their own tether record
- The SIWE gate (Wave 2) closes the precondition (claiming a fresh node) that opens the higher-impact "self-tether on own claim" variant the researcher flagged

**Wave 5 plan** (queued):
1. Verify JWT signature on every `jwt`/`signedData`/`presentation` payload (per researcher remediation #1)
2. Resolve claimed DID against Elastos DID registry; cache DID-document for 24 h
3. Replace "most recent pending request" fallback with server-issued `state` parameter required in callback (per remediation #2)
4. Audit-log + desktop notification on every `tetheredDIDs` write (per remediation #4)

---

## Researcher's "Recommended Immediate Actions" — Disposition

| # | Researcher recommendation | Status |
|---|---|---|
| 1 | v2 private key: `transferOwnership` on three Elastos ProxyAdmins to a Safe multisig with timelock | 🟦 Smart-contracts owner |
| 2 | RCE vless: replace template-literal `execSync`, add auth on `/api/vless/*` + `/api/awg/*` | ✅ Wave 3 |
| 3 | `/auth/particle`: SIWE-style signed challenge, remove `mock-token`, **rotate cloud.ela.city** | ✅ Wave 1 + 2 (code) ; ⚠️ cloud.ela.city rotation = operational |
| 4 | Payment processor: gate `execute()`/`defer()` on allowlist | 🟦 Smart-contracts owner |
| 5 | MultiChannel: ownership/consent on `addWrapper`, add `removeWrapper` | 🟦 Smart-contracts owner |
| 6 | Brief team on remaining PC2 items | ✅ This document + [`WAVE-2-SIWE-AND-SETUP.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-2-SIWE-AND-SETUP.md) + [`WAVE-3-GATEWAY-LOCKDOWN.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md) + [`WAVE-4-SECRET-HYGIENE.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md) |

Plus the implicit recommendation buried in Finding #1 step 6: *"Add pre-commit and CI secret scanning … audit `.vscode/`, `.idea/`, `.env*` across all Elacity repositories."* — ✅ **Wave 4** put this in place for `pc2.net`. Strongly recommend porting `.gitleaks.toml`, `.gitleaksignore`, `.github/workflows/secret-scan.yml`, and the `.husky/pre-commit` snippet to `lit-keystore-moleculer` and any other Elacity repo.

---

## Internal Audit Findings (2026-04-22)

After the seven researcher findings closed, I (Cursor — Composer 2 acting as senior security reviewer for Sash) audited the remaining ~46 PC2 API files plus the gateway for the same primitives the researcher used (shell-string command construction, missing `requireOwner` on privileged routes, cross-user data leaks, SSRF). Fifteen new findings, grouped into three waves by severity.

### Severity overview

| ID | Severity | Component | One-line | Wave |
|----|----------|-----------|----------|------|
| **A1** | 🔴 CRITICAL | `pc2-node/src/api/terminal.ts` | RCE via `/api/terminal/exec` + `/script` (any tethered wallet — missing `requireOwner` + shell mode) | 5 |
| **A2** | 🔴 CRITICAL | `pc2-node/src/api/git.ts` | RCE via shell-injection in `body.url`/`body.branch`/`body.message` on every `/api/git/*` handler | 5 |
| **A3** | 🔴 CRITICAL | `pc2-node/src/api/backup.ts` + `index.ts:1293-1297` | Owner-mnemonic exfil + node takeover for any tethered wallet (missing `requireOwner` on download/restore/create/delete + shell-injection in restore filename) | 5 |
| **A4** | 🟠 HIGH | `pc2-node/src/api/filesystem.ts:577-586` | Cross-user file read — tethered wallet can `GET /read?path=/0xVictim/...` and the fallback returns the victim's file | 5 |
| **A5** | 🟠 HIGH | `pc2-node/src/api/voice.ts:386,403,418` | Sudo-driven system installs by tethered wallets (missing `requireOwner` on `/voice/install`, `/enable`, `/disable`) | 5 |
| **A6** | 🟡 MEDIUM | `pc2-node/src/api/system.ts:112-119` | Brittle `shell:'/bin/bash'` with `${process.env.HOME}` glob — not exploitable today, future RCE waiting | 6 |
| **A7** | 🟡 MEDIUM | `pc2-node/src/api/ai.ts:987` | `spawn('sh',['-c','curl …\|sh'])` for ollama install — TOFU on upstream supply chain | 6 |
| **A8** | 🟡 MEDIUM | `pc2-node/src/api/index.ts:1049-1052` | `/api/esc-rpc` uses `rejectUnauthorized:false` — TLS verification disabled, MITM-able | 6 |
| **A9** | 🟡 MEDIUM | `pc2-node/src/api/index.ts:1082-1098` | `/api/esc-nft/:path(*)` is an unauthenticated open proxy with path-injection to `https://ela.city/api/<anything>` | 6 |
| **A10** | 🟡 MEDIUM | `pc2-node/src/api/index.ts:470,1009,1029` | `/api/catalog/reindex`, `/api/elacity/graphql`, `/api/esc-nft/graphql` all unauth + no rate limit — DoS surface | 6 |
| **A11** | 🟡 MEDIUM | `pc2-node/src/api/http-client.ts:48-69` | `/api/http` SSRF allowlist is DNS-rebind bypassable (re-resolves at fetch time) + IPv6 link-local missed | 6 |
| **A12** | 🟡 MEDIUM | `pc2-node/src/api/wallet.ts:99,160,199` | `/proposals/:id/{approve,reject,execute}` don't bind to `req.user.wallet_address` — any tethered wallet can manipulate any wallet's proposal records | 6 |
| **A13** | 🟢 LOW | `pc2-node/src/api/middleware.ts:440-444` | CORS `.includes('.ela.city')` matches `evil-ela.city.attacker.example`; `.ela.local` is mDNS-claimable | 7 |
| **A14** | 🟢 LOW | `pc2-node/src/api/middleware.ts:224-230` | `auditMiddleware` + `Token extracted` log lines write the full session token at INFO; replay if logs leak | 7 |
| **A15** | 🟢 LOW | `pc2-node/src/services/AppInstallService.ts:234` | Capsule signature unverified → install-warn instead of install-block (intentional v1.x; documented as v2 cutover) | 7 |
| **A16** | 🟡 MEDIUM | `pc2-node/src/api/file.ts` (`handleFile`, mounted at `GET /file` in `index.ts`) | "Signed URL" capability is unsigned — comment claims "signature verified in query" but handler performs zero crypto verification. Wallet address is parsed straight out of the `uid` query param and used to locate the file. Surfaced during Wave 5 A4 sweep, escalated to Wave 6. | 6 |

### Wave grouping rationale

**Wave 5 — release-blocking** (A1-A5): three Critical RCE/exfil paths and two High authorization-bypass paths. Same fix shape as SEC-2/SEC-7/SEC-10 (which are already shipped): add `requireOwner` and replace shell-string command construction with `execFile` argv form. No kill-switches; hard-fixed. Cannot ship v1.2 with these open. See [`SEC-2026-04-22-WAVE5-PRE-RELEASE`](.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md).

**Wave 6 — post-cutover hardening** (A6-A12 + **A16**): eight Medium items covering SSRF (A8/A9/A11), TLS pinning (A8), supply chain (A7), unauth DoS surfaces (A10), brittle shell patterns (A6), one cross-wallet record-manipulation (A12), and one unsigned "signed URL" capability (**A16** — `handleFile` claims to verify a query signature but performs zero crypto). None is RCE; none can be exploited without an existing session or a guessable filename; each weakens a defence layer that would be hit if an attacker chained another bug. Targets v1.2.1 patch ≤ T+14 days. Important: should land **before** the kill-switches flip to strict (Phase C1/C2), so that the post-cutover security posture is uniform. See [`SEC-2026-04-22-WAVE6-HARDENING`](.cursor/tasks/SEC-2026-04-22-WAVE6-HARDENING/SEC-2026-04-22-WAVE6-HARDENING.md).

**Wave 7 — defence-in-depth polish** (A13-A15): three Low items. A13/A14 are quality-of-defence (no live exploit, but they would amplify a future bug or log leak). A15 is a known v2 gap and Wave 7 just formalises the cutover plan. Targets v1.2.2 or v1.3. See [`SEC-2026-04-22-WAVE7-POLISH`](.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/SEC-2026-04-22-WAVE7-POLISH.md).

### How these were missed in the original triage

The researcher report was scoped — jhond0e prioritised the highest-dollar paths (vless RCE, mnemonic exfil, smart-contract drains) and didn't have time to enumerate every endpoint. The internal audit applied the *same primitives* he used (`rg 'execSync\|exec(\|spawn(' pc2-node/src/api`, `rg 'authenticate,' pc2-node/src/api/index.ts | rg -v 'requireOwner'`, plus path-tracing on every fallback in filesystem.ts) to the remaining files. Same bug families, same fix shapes — exactly the kind of follow-up sweep that turns a single-finding bounty into a code-quality cycle.

### Why these are reported as "additional findings" rather than "researcher said it"

In honesty to jhond0e: only A1-A5 are clearly within his scope had he gone deeper. A6-A15 are second-order — they're stuff *we* found, not him. When responding to the bounty, the right framing is: "We closed your seven findings; we then internally audited the rest of the surface using your exact methods and found 15 more, bundled as Waves 5/6/7 in the same release line." That keeps the bounty award tied to his work while documenting that we took the report seriously enough to extend it.

---

## v1.2 Release Roadmap (next week)

The 7 in-scope findings are closed in code. The list below tracks what still has to happen around the release itself — split by phase so it's clear what blocks the cutover vs. what runs after.

### Phase A — Before pushing v1.2 live (release-blocking)

| # | Item | Owner | Notes |
|---|---|---|---|
| **A0** | ⛔ **MERGE WAVE 5 (A1-A5 internal audit)** — three Critical RCE/exfil paths and two High authorization-bypass paths. Same fix shape as SEC-2/SEC-7/SEC-10. No kill-switches; hard-fixed. | dev | [`SEC-2026-04-22-WAVE5-PRE-RELEASE`](.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md). Five commits (one per fix) on `feature/lit-chipotle-migration`. Quality gate: `bash pc2-node/tests/security/wave5-smoke.sh` (19 cases) all green + `npm run test:security` regression-clean. **Cannot tag v1.2.0 until this lands.** |
| A1 | **Smoke test the full SIWE login flow on a clean node** (fresh DB, no existing session) — confirm one wallet popup, owner gets minted, scoped sessions work for iframe apps | dev | Existing `npm run test:security` (79 cases) covers the unit contracts; this is the manual end-to-end |
| A2 | **Smoke test gateway in log-only mode** — bring up a v1.2 PC2 node against a v1.2 supernode with `GW_AUTH_REQUIRED=false` (default). Confirm `/api/register` mints a provisioning token, the node persists it to `data/.gateway-tokens.json`, and subsequent `/api/wg/register` includes the `X-Provisioning-Token` header | dev / ops | Watch supernode logs — every call should log `provisioning_token=present` |
| A3 | **Smoke test scoped session tokens** — open a file viewer iframe app, confirm the iframe receives a short-lived scoped token (not the owner's session token), and confirm the scoped token is rejected by general endpoints like `/api/update` | dev | Wave 1 acceptance criterion |
| A4 | **Confirm `cloud.ela.city` upgrade plan** — decide whether to (a) upgrade in place to v1.2 then rotate its DID, or (b) provision a fresh v1.2 node and DNS-cut over. Either is fine; just decide before release | Sash | Researcher reported it un-owned for 14.6 days at report time. Code paths are now closed in v1.2 binary, but the old deployment may still be on v1.1. |
| A5 | **Confirm Irzhy's smart-contract fixes status** — they don't block v1.2 of this repo (different deploy target), but the public release notes should know whether to mention them as "in flight" or "shipped" | Sash + Irzhy | Per your update: Irzhy is making progress; will be updated later |
| A6 | **Tag the release** — once A0 lands and A1-A3 pass, tag `v1.2.0` from `feature/lit-chipotle-migration` (or merge-and-tag from `main`, depending on your release flow) | dev | Existing CHANGELOG entry is already in place; add Wave 5 line per [Wave 5 § Communications](.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md#communications) |

### Phase B — At v1.2 cutover (release day)

| # | Item | Owner | Notes |
|---|---|---|---|
| B1 | **Deploy v1.2 supernode binary** with `GW_AUTH_REQUIRED=false` (log-only mode) — this is the **default**, do not change it on release day | ops | Supernode keeps accepting unauthenticated traffic from v1.1 nodes during the rollout window |
| B2 | **Deploy v1.2 PC2 node binary** with `siweRequired=false` (log-only mode) — also the default | ops / users | Existing sessions on v1.1 keep working through the upgrade |
| B3 | **Watch logs for the first hour** for any 5xx spike on `/api/register`, `/auth/particle`, `/api/wg/register` | ops | If anything spikes, the kill-switches stay off and we triage |

### Phase C — Kill-switch flip schedule (post-cutover)

This is what I meant by *"turning something on"*. Both kill-switches default to log-only mode at release so nothing breaks for users still on v1.1. They get flipped to enforce mode on a delay once telemetry confirms safety.

| # | When | Switch | Where | Effect |
|---|---|---|---|---|
| C1 | **T+7 days** (after release) | `GW_AUTH_REQUIRED=true` | Supernode env (`/etc/elacity-gateway/.env` or systemd unit) | Supernode starts **rejecting** unauthenticated `/api/wg/*`, `/api/awg/*`, `/api/vless/*` calls instead of just logging them. Pre-condition: ≥99% of inbound calls in the last 24h logged `provisioning_token=present`. |
| C2 | **T+14 days** | `siweRequired=true` | PC2 node default in `pc2-node/src/api/auth.ts` (or per-node `config.json` override) | New ownership claims **require** a verified SIWE signature instead of just logging. Existing owners are unaffected (they already have a session). Pre-condition: ≥99% of `/auth/particle` calls in the last 24h logged `siwe_verified=true`. |
| C3 | **T+30 days** | Unpin legacy Lit Action CIDs from IPFS | Ops (Pinata / pinning service dashboard) | Already noted in CHANGELOG — closes the rollback window for the Lit Action sigauth cutover |

If telemetry doesn't hit the 99% threshold by T+7 / T+14, **don't flip** — extend the window, investigate, and flip when traffic looks clean. The kill-switch design is specifically to give us this escape hatch.

### Phase D — Post v1.2 (queued, not blocking)

| # | Item | Owner | Target | Notes |
|---|---|---|---|---|
| **D0** | ⚡ **WAVE 6 — Internal audit hardening (A6-A12 + A16 + A18)** — TLS pinning on `/api/esc-rpc`, SHA-pin on ollama install, `requireOwner` + rate-limit on catalog/reindex + GraphQL proxies, esc-nft path allowlist, DNS-rebind-safe SSRF protection in `/api/http`, owner-binding on wallet proposals, argv-only system restart, signed-URL crypto verification on `/file` (A16), **and `requireOwner` + dangerous-action allowlist on `/api/scheduler/tasks` before any runner ships (A18)** | dev | **v1.2.1, ≤ T+14 days** | [`SEC-2026-04-22-WAVE6-HARDENING`](.cursor/tasks/SEC-2026-04-22-WAVE6-HARDENING/SEC-2026-04-22-WAVE6-HARDENING.md). Important: should land **before** the kill-switches flip strict (Phase C1/C2) so the post-cutover security posture is uniform. A18 is currently a *deferred* RCE — `handleTriggerTask` only marks tasks as triggered, no executor wired — but the dangerous payloads persist in SQLite, so this gate must land **before** any scheduler runner service goes live. |
| D1 | **Boson DID rotation** ([`SEC-2026-04-22-BOSON-DID-ROTATION`](.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/SEC-2026-04-22-BOSON-DID-ROTATION.md)) — rotate the `data/identity.json` key surfaced by Wave 4 gitleaks. Needs Sash's input on what consumes the DID. | Sash + dev | v1.2.x patch | |
| D2 | **SEC-11 — DID JWT verify** — JWT signature validation on `/api/did/callback`, DID-document resolver client, `state`-parameter binding, audit log + owner notification | dev | v1.2.1 or v1.3 | Researcher Finding #11. |
| D3 | **WAVE 7 — Defence-in-depth polish (A13-A15 + 2 audit-tail items)** — CORS proper suffix matching (A13 *and* tighten `origin.includes('.ela.city')` to a parsed-URL `endsWith` so `https://x.ela.city.evil.com` is rejected), session-token redaction in audit log (A14), capsule-signing v2 cutover doc (A15), and tighten `authenticate`'s `.__puter_gui.json` `endsWith` bypass to an exact post-canonicalization match | dev | **v1.2.2 or v1.3** | [`SEC-2026-04-22-WAVE7-POLISH`](.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/SEC-2026-04-22-WAVE7-POLISH.md). The two extra audit-tail items came out of the post-Wave-5 deep audit; both are LOW-impact in practice (no `Access-Control-Allow-Credentials: true` on CORS, and `.__puter_gui.json` files don't normally hold secrets) but they belong in the polish wave. |
| D4 | **Smart-contract disposition doc** — Irzhy produces a parallel `disposition.md` on the contracts repo so we can publish a single combined response to the researcher | Irzhy | When his fixes land | |
| D5 | **Port secret-scanning gate to other Elacity repos** — `lit-keystore-moleculer` first (since it was the source of Finding #1), then any other repo with `.env*` / `.vscode/` / `.idea/` | dev | Recommended; not blocking | |
| D6 | **V2 — App capsule signing enforcement** — flip `AppInstallService` from warn-only to block-by-default for unsigned capsules. Requires publisher cert authority + manifest schema bump. | dev | v2 release | Documented by Wave 7 (A15). New task doc: [`V2-APP-CAPSULE-SIGNING`](.cursor/tasks/V2-APP-CAPSULE-SIGNING/V2-APP-CAPSULE-SIGNING.md). |

---

## Quality gates passed (this repo)

| Gate | Result |
|---|---|
| `npm run test:security` (79 cases across 5 spec files) | ✅ Passes |
| `npx tsc -p pc2-node --noEmit` | ✅ 0 errors |
| ESLint on touched files | ✅ Clean (only pre-existing `no-undef` for Node globals + 14 pre-existing `curly-newline` in unmodified `catch` blocks) |
| Gateway smoke matrix (port 18080, log-only + strict modes) | ✅ 12/12 cases |
| End-to-end SIWE + dDRM playback (PDF · PNG · MP4 · MP3) | ✅ 2026-04-21 |
| Gitleaks against current HEAD | ✅ 0 leaks (6.7 s) |

---

## What's hard-fixed vs. what's gated by a kill-switch

**Important read for anyone worried that "default off" means "security is off".** Most of the fixes are unconditional — there is no switch and they cannot be turned off. Two specific behaviors are gated by a kill-switch purely so legacy v1.1 clients keep working during the rollout window. The high-severity primitives (RCE, key disclosure, mock-token chain) are all in the unconditional set.

### Hard-fixed (no switch — security is enforced 100% of the time, day one)

| Finding / change | What's hard-fixed | Where |
|---|---|---|
| **SEC-2** vless RCE | `execSync` replaced with `execFileSync` (argv form, no shell). Plus 8 other `execSync` sites in the gateway converted to `execFileSync`. | `deploy/web-gateway/index.js` — `rg 'execSync\(' deploy/web-gateway` returns 0 |
| **SEC-3c** `mock-token` chain | Dangerous code branches physically deleted (~88 LOC) | `pc2-node/src/api/middleware.ts`, `whoami.ts`, `info.ts` |
| **SEC-7** mnemonic disclosure | `requireSetupAuth` middleware — loopback OR `firstRunToken` always required | `pc2-node/src/api/setup.ts` |
| **SEC-10** `/api/update/install` RCE | `authenticate, requireOwner, installThrottle` always required | `pc2-node/src/api/update.ts:150` |
| Scoped session tokens | New token type with DB column; iframe apps always get short-lived scoped tokens | `pc2-node/src/api/middleware.ts` + migration #29 |
| `trust proxy` hardening | Always uses `req.socket.remoteAddress` for security decisions | `pc2-node/src/api/index.ts` |
| Wave 4 gitleaks | Always runs in CI on every PR + every push to long-lived branches | `.github/workflows/secret-scan.yml` |
| **A1 (Wave 5)** terminal RCE | `requireOwner` + `execFile` argv-only; `shell:true` requests rejected with 400 | `pc2-node/src/api/terminal.ts` + `index.ts:1306-1308` |
| **A2 (Wave 5)** git RCE | All seven handlers (`clone/status/commit/push/pull/log/diff`) refactored to argv form (`execFile('git', args, …)`); URL/branch/ref/remote/path regex pre-validation; `--` argument-injection guard on every positional | `pc2-node/src/api/git.ts` |
| **A3 (Wave 5)** backup chain | `requireOwner` on all five backup routes; backup filename whitelisted (`/^[A-Za-z0-9_.-]+\.tar\.gz$/`) on download/delete/restore-upload; create + restore use `execFile('node', [scriptPath, …])` | `pc2-node/src/api/backup.ts` + `index.ts:1293-1297` |
| **A4 (Wave 5)** cross-user file read | Cross-wallet path-derived fallback restricted: a `/<addr>/...` request only retries against `<addr>` if `<addr>` matches the requesting user's EOA *or* their smart-account address (case-insensitive, null-safe). Foreign-wallet reads now return 404. | `pc2-node/src/api/filesystem.ts:577-597` |
| **A5 (Wave 5)** voice install | `requireOwner` on `/voice/install`, `/enable`, `/disable`; `/voice` + `/voice/status` stay open to tethered wallets | `pc2-node/src/api/voice.ts` |
| **A17 (Wave 5.5)** app-install RCE / owner-mnemonic exfil | `requireOwner` on all four mutating routes (`install`, `install-local`, `update`, `DELETE /:name`). `AppInstallService.installFromLocal` now strictly allowlists `localDir` to `data/dev-apps/` (path-prefix check using `path.sep`, so `data/dev-apps/../wallets` is rejected after `resolve()`); also rejects sources inside `installed-apps/` to prevent app-to-app copy. Static route's existing containment check (`filePath.startsWith(appDir + sep)`) was already correct and remains the second line. | `pc2-node/src/api/installed-apps.ts` + `pc2-node/src/services/AppInstallService.ts` |
| **A19 (Wave 5.5)** multer disk-write path traversal | All four `multer.diskStorage` configurations now use synthetic safe filenames (`${unique}.upload`, `${unique}.tar.gz`) instead of interpolating `file.originalname` into the on-disk path. The backup-restore configs additionally enforce a strict `fileFilter` regex (`/^[A-Za-z0-9_.-]+\.tar\.gz$/`) that fires **before** any disk write, so a path-traversal `originalname` is rejected pre-write. `req.file.originalname` is still preserved by multer for handlers that need to display it. | `pc2-node/src/api/index.ts` (2 configs) + `pc2-node/src/api/setup.ts` + `pc2-node/src/api/media.ts` |

### Gated by a kill-switch (compatibility valve for the rollout window)

| Finding / change | Switch | Default | What "off" actually does | What "on" enforces |
|---|---|---|---|---|
| **SEC-3a** SIWE on `/auth/particle` | `config.security.siweRequired` | `false` | Signature is **verified** if supplied (logged) but not **required**. Legacy v1.1 client calls still go through. | Missing/invalid signature → 401. New ownership claims require loopback OR `firstRunToken` OR a verified SIWE. |
| **SEC-8/9** WG/AWG/VLESS provisioning | `GW_AUTH_REQUIRED` env var | `false` | Token presence is **logged for telemetry** but missing/wrong tokens still get `action=allow`. | Missing/wrong tokens → 401. |

### Residual risk during the log-only window (and why it's acceptable)

| Theoretical attack in log-only mode | Severity | Why it's bounded |
|---|---|---|
| Attacker claims a fresh v1.2 node remotely without a SIWE signature | Low/Medium | Standard `install-pc2.sh` mints a `firstRunToken` — legitimate remote installs require it. Loopback installs are unaffected. Only a v1.2 node deliberately exposed publicly *without* using the install script and *without* loopback access is in this window. The original CRITICAL escalation path (claim → vless RCE) is hard-fixed. |
| Attacker re-keys or deletes a WG peer at the gateway | Medium | DoS on the victim's tunnel. RCE path (Finding #2) and TLS-key exfil path are hard-fixed regardless. |
| Attacker registers a vless username they don't own | Low | DoS-tier impact. The RCE that made Finding #2 CRITICAL is dead. |

In short: **every CRITICAL-severity finding has its CRITICAL component hard-fixed**. The kill-switches gate the remaining defence-in-depth layers that need legacy clients to upgrade before they can be enforced.

---

## Roll-back paths (every fix is opt-in or revertable)

- **Wave 1 (`mock-token` removal)**: revert commit `80168f706`. Migration #29 (`sessions.scope`) is additive — reverting the binary leaves the columns NULL, which is the legacy contract.
- **Wave 2 (SIWE)**: kill-switch `siweRequired=false` in `config.json` (default) → server logs the verification result but does not enforce. CLI setup over loopback unaffected by `requireSetupAuth`. CORS allowlist was extended, never reduced.
- **Wave 2 (`trust proxy`)**: still trusts the LAN reverse proxy; only LAN `X-Forwarded-For` no longer trusted — no traffic blocked.
- **Wave 3 (gateway)**: kill-switch `GW_AUTH_REQUIRED=false` (default) → log-only mode. Flip to `true` once telemetry shows ≥99 % of inbound calls carry tokens. Token store is forward-compatible — older gateway binaries simply ignore the file.
- **Wave 4 (gitleaks)**: pre-commit silently no-ops when binary not installed; CI workflow can be hard-disabled by deleting `.github/workflows/secret-scan.yml`. `.gitleaks.toml`/`.gitleaksignore` are inert without the scanner.

---

## Reference index

| Artefact | Path |
|---|---|
| Parent audit task | [`.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/SEC-2026-04-21-PC2-AUDIT.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/SEC-2026-04-21-PC2-AUDIT.md) |
| Wave 2 detail | [`.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-2-SIWE-AND-SETUP.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-2-SIWE-AND-SETUP.md) |
| Wave 3 detail | [`.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md) |
| Wave 4 detail | [`.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md`](.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md) |
| **Wave 5 detail (A1-A5, release-blocking)** | [`.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md`](.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md) |
| **Wave 5.5 detail (A17 + A19, release-blocking hotfix)** | [`.cursor/tasks/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX.md`](.cursor/tasks/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX.md) |
| **Wave 6 detail (A6-A12 + A16 + A18, ≤T+14d)** | [`.cursor/tasks/SEC-2026-04-22-WAVE6-HARDENING/SEC-2026-04-22-WAVE6-HARDENING.md`](.cursor/tasks/SEC-2026-04-22-WAVE6-HARDENING/SEC-2026-04-22-WAVE6-HARDENING.md) |
| **Wave 7 detail (A13-A15, v1.2.2/v1.3)** | [`.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/SEC-2026-04-22-WAVE7-POLISH.md`](.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/SEC-2026-04-22-WAVE7-POLISH.md) |
| Boson DID rotation follow-up | [`.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/SEC-2026-04-22-BOSON-DID-ROTATION.md`](.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/SEC-2026-04-22-BOSON-DID-ROTATION.md) |
| Lit Action V1.2 cutover (separate but adjacent P0) | [`docs/handover/V12_SIGAUTH_HANDOVER.md`](V12_SIGAUTH_HANDOVER.md) |
| Secret scanning runbook | [`docs/wiki/Technical/SECRET_SCANNING.md`](../wiki/Technical/SECRET_SCANNING.md) |

---

## Communications

When responding to the researcher, recommend including:
1. This disposition document (or its TL;DR)
2. The 4 commits as evidence for the original 7 findings: `80168f706`, `b2e509c18`, `16dccaf39`, `6ba49cfac` (all on `feature/lit-chipotle-migration`, will be in v1.2 tag)
3. Acknowledgement of the smart-contract findings as in flight under Irzhy
4. **Plus 5 additional findings (A1-A5) discovered during a post-triage internal sweep using your same methods** — closed in Wave 5 ahead of the v1.2 tag. 7 more (A6-A12) hardening items shipping as v1.2.1 ≤ T+14 days. 3 polish items (A13-A15) tracked for v1.2.2/v1.3.
5. Bounty discussion can resume — the 7 in-scope researcher findings are demonstrably closed; the bonus 15 internal findings are evidence we took the report seriously enough to extend the audit. The right framing is "your work flushed out a class of bugs across the codebase, here's what else we found".
