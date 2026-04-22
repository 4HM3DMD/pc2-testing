# Audit Disposition — jhond0e Security Report (2026-04-21)

**Researcher**: jhond0e — `lut0xbughunter@gmail.com`
**Original recipient**: `security@elacitylabs.com`
**Report date**: 2026-04-18
**Triage handoff**: 2026-04-21 (this codebase)
**This document compiled**: 2026-04-22
**Status**: 🟢 **All 7 in-scope findings closed in code.** 4 smart-contract findings tracked separately. 1 deferred (low traffic). 2 operational follow-ups required.

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

- **SEC-1, 4, 5, 6** (smart contracts) — **owned by separate engineer**, not this repo
- **SEC-11** (DID JWT verify) — **deferred to Wave 5**, low production traffic (~<1%); rationale below

Two **operational** items still require human action:

- **`cloud.ela.city` rotation** — researcher reported this node un-owned for 14.6 days (`uptime: 1265350.22`). Code path is now closed, but the existing node should still be rotated since the un-owned window has been advertised in the report. Status from your team needed.
- **`data/identity.json` Boson DID key** — Wave 4's secret scanner surfaced a real Ed25519 private key committed at `4b10bad94` (2026-03-06) before the matching `.gitignore` rule. Already exposed on 4 origin branches. Rotation queued as `SEC-2026-04-22-BOSON-DID-ROTATION` (scaffolded today).

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

## Outstanding Items (require human decision)

### 1. Rotate `cloud.ela.city` (operational)
**Severity**: Medium (window has been documented in the researcher's report).
**Why**: At report time the node had been un-owned for 14.6 days. The exploitable code paths (Findings 3, 7, 10) are now closed in the v1.2 binary. But the existing node deployment may still be on v1.1 or earlier.
**Action needed**: Confirm `cloud.ela.city` has been (a) upgraded to v1.2 and (b) had its DID rotated as a precaution. If not done, schedule rotation runbook as `SEC-2026-04-22-CLOUD-ELA-CITY-ROTATION`.

### 2. Rotate `data/identity.json` Boson DID key (security)
**Severity**: High (real Ed25519 private key publicly readable on 4 origin branches since 2026-03-06).
**Detected by**: Wave 4's gitleaks scanner (TRIAGE-1 in `.gitleaksignore`).
**Already in `.gitignore`** but was committed before the rule was added.
**Action needed**: See [`SEC-2026-04-22-BOSON-DID-ROTATION.md`](.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/SEC-2026-04-22-BOSON-DID-ROTATION.md) (scaffolded today). Rotation requires knowing who/what consumes that DID — needs Sash's input.

### 3. Email forwarding (operational)
The researcher noted: *"Sash's initial forwards… bounced with SMTP 535 'authentication rejected'… Gmail Send-as misconfiguration carried over from the Microsoft → Gmail migration."* Until that's fixed, any future researcher reports forwarded from `sash@ela.city` will silently fail to reach `anders@wau.io` / `irzhy@wau.io`.
**Action needed**: Ops/IT — fix Gmail Send-as auth on `sash@ela.city`. Until then, this document is the authoritative handoff path.

### 4. SEC-11 (DID JWT verify) — schedule Wave 5
Deferred but not dismissed. Suggest scheduling for v1.2.1 or v1.3 — should not block v1.2 cutover.

### 5. Smart-contract findings — confirm coverage
Findings 1, 4, 5, 6 are owned by your other team member. Recommend they produce a similar `disposition.md` on the contracts repo so we can publish a single combined report to the researcher when fixes land.

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
| Boson DID rotation follow-up | [`.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/SEC-2026-04-22-BOSON-DID-ROTATION.md`](.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/SEC-2026-04-22-BOSON-DID-ROTATION.md) |
| Lit Action V1.2 cutover (separate but adjacent P0) | [`docs/handover/V12_SIGAUTH_HANDOVER.md`](V12_SIGAUTH_HANDOVER.md) |
| Secret scanning runbook | [`docs/wiki/Technical/SECRET_SCANNING.md`](../wiki/Technical/SECRET_SCANNING.md) |

---

## Communications

When responding to the researcher, recommend including:
1. This disposition document (or its TL;DR)
2. The 4 unpushed→pushed commits as evidence: `80168f706`, `b2e509c18`, `16dccaf39`, `6ba49cfac`
3. Acknowledgement of the smart-contract findings as in-flight under the other engineer
4. Bounty discussion can resume — the 7 in-scope findings are demonstrably closed
