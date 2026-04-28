# Audit Disposition — jhond0e Security Report (2026-04-21)

**Researcher**: jhond0e — `lut0xbughunter@gmail.com`
**Original recipient**: `security@elacitylabs.com`
**Report date**: 2026-04-18
**Triage handoff**: 2026-04-21 (this codebase)
**This document compiled**: 2026-04-22 (Researcher report) · 2026-04-22 amended with internal audit findings (A1-A15) · 2026-04-22 amended with Wave 5 implementation + A16 · 2026-04-22 amended with Wave 5.5 (A17 + A19) post-Wave-5 deep-audit findings · 2026-04-22 amended with Wave 6 part 1 (A6 + A10 + A12 + A18) shipped · 2026-04-23 amended with A8 decision lock-in (`elastossmartchain.ela.city`, parked on Sash's DNS-2FA travel block) · 2026-04-23 amended with Wave 6 part 2 (A7 + A11 + A16) shipped
**Status**: 🟢 **All 7 in-scope researcher findings closed in code. Wave 5 (A1-A5) + Wave 5.5 (A17, A19) + Wave 6 part 1 (A6, A10, A12, A18) + Wave 6 part 2 3/4 (A7, A11, A16) all pushed.** Post-triage internal audit (2026-04-22) surfaced **15 additional findings (A1-A15)** of the same families. Wave 5 sweep surfaced **A16**. The post-Wave-5 deep audit (2026-04-22, second pass) surfaced **A17** (CRITICAL — app-install RCE/exfil), **A19** (HIGH — multer originalname disk-write traversal), and **A18** (MED — scheduler deferred RCE). Wave 5 + 5.5 are release-blocking and pushed. Wave 6 part 1 (A6, A10, A12, A18) and Wave 6 part 2 3/4 (A7, A11, A16) are pushed; **A8 (ESC RPC TLS) parked** awaiting Sash's DNS record (decision locked: `elastossmartchain.ela.city`, blocker is travel/2FA — not a code blocker). A9 deferred to v1.2.1c. Wave 7 (A13-A15 + CORS substring + `.__puter_gui.json` `endsWith` bypass) targets v1.2.2 / v1.3. 4 smart-contract findings owned by Irzhy (in progress). 1 deferred (SEC-11, low traffic).

**Current release gate**: ⛔ **Do not tag v1.2.0 until both Wave 5 AND Wave 5.5 commit sets land on `feature/lit-chipotle-migration` and the combined Wave 5 + 5.5 smoke matrix passes.** Both pushed (HEAD `7a971b6d1`). Wave 6 part 1 also pushed but is **not** a release gate (v1.2.1 target). See [Phase A0](#phase-a--before-pushing-v12-live-release-blocking).

---

## What's left — single-glance status (2026-04-22 evening)

### 🚦 Release gates for v1.2.0 (must clear before tag)

| # | Item | Status | Owner |
|---|---|---|---|
| RG1 | Wave 5 (A1-A5) commits on `feature/lit-chipotle-migration` | ✅ Pushed (`82163b092`) | Done |
| RG2 | Wave 5.5 (A17 + A19) commits on same branch | ✅ Pushed (`f53118da8`, `ae9bbf0da`, `7fe1c11a5`) | Done |
| RG3 | Combined Wave 5 + 5.5 smoke matrix (`bash pc2-node/scripts/wave5-smoke.sh`, 26 cases) all green | ⏳ Partial (unauth probes ran clean; auth'd cases need Sash's session token / API keys for the owner + tethered cases) | Sash + dev |
| RG4 | `npm run test:security` (79 cases, 5 specs) regression-clean | ✅ Last verified 2026-04-22 | Done |
| RG5 | Smart-contract fixes status (SEC-1/4/5/6) — confirm with Irzhy whether release notes mention "shipped" or "in flight" | ⏳ Pending Irzhy update | Sash + Irzhy |
| RG6 | `cloud.ela.city` upgrade plan: in-place vs DNS-cut to fresh v1.2 node | ⏳ Pending Sash decision | Sash + ops |

### 🛠 v1.2.1b — Wave 6 part 2 (3/4 SHIPPED, 1/4 parked on DNS)

| # | Item | Status |
|---|---|---|
| **A7** | `install-ollama` SHA-256 pin + `requireOwner` + no shell pipe | ✅ Shipped 2026-04-23 (`01b2ed2dd`). Pinned SHA `25f64b810b947145095956533e1bdf56eacea2673c55a7e586be4515fc882c9f`. |
| **A11** | `/api/http` + `/api/download` DNS-rebind hardening (undici Dispatcher with `connect.lookup` IP pinning + IPv6 ULA + IPv4-mapped + CGNAT blocklist) | ✅ Shipped 2026-04-23 (`9887429e7`). `undici@^7.19.1` pinned as direct dep. 11/11 IPv4-private regex unit cases pass. |
| **A16** | `/file?uid` HMAC sign+verify + 3 server-side mint sites + `FILE_URL_SIGNING_REQUIRED` kill-switch (default OFF for log-only window) | ✅ Shipped 2026-04-23 (`2a9e39386`). New `pc2-node/src/utils/fileUrlSigner.ts`. 12/12 functional cases pass. Kill-switch flips ON at T+7d post v1.2.1 — see Phase C4. |
| **A8** | `/api/esc-rpc` TLS pinning (replace `rejectUnauthorized:false`) | ⏳ **Parked, not a code blocker**. Decision locked: Option 1 (hostname + public-CA verification), hostname `elastossmartchain.ela.city`. Live probe of `38.242.211.112:443` confirmed valid Let's Encrypt `*.ela.city` wildcard cert (issued 2026-02-20, expires 2026-05-21, auto-renewing) — the in-code "self-signed cert" comment is wrong. **Blocker**: Sash is travelling and his DNS provider requires SMS 2FA on a number he can't reach. **When unblocked** (one-message handoff: "DNS added"): agent waits ~5 min for propagation, switches the proxy + 4 other `38.242.211.112` call sites (`chipotle-client.ts`, `ConnectivityService.ts`) to the hostname, removes 5x `rejectUnauthorized:false`, pushes one atomic commit. |
| Wave 6 smoke script (`pc2-node/scripts/wave6-smoke.sh`) | Will land alongside the A8 commit (single end-to-end matrix run after the last fix). |

### 🧹 v1.2.x patches (queued, not blocking)

| # | Item | Status |
|---|---|---|
| **A9** | `esc-nft` prefix allowlist (Wave 6.5/7) | Sash to enumerate desktop UI `esc-nft/:path` calls against the live UI for an hour first. |
| **D1** | Boson DID rotation (`data/identity.json`) | Pending Sash's input on what consumes the DID. |
| **D2 / SEC-11** | DID JWT verify on `/api/did/callback` (researcher Finding #11) | Queued for v1.2.1 or v1.3. |
| **D4** | Smart-contract disposition doc (Irzhy's parallel `disposition.md`) | Pending Irzhy. |
| **D5** | Port secret-scanning gate to other Elacity repos (`lit-keystore-moleculer` first) | Recommended; not blocking. |

### 🪶 v1.2.2 / v1.3 — Wave 7 polish

| # | Item |
|---|---|
| **A13** | CORS proper suffix matching — replace `origin.includes('.ela.city')` with parsed-URL `endsWith` so `https://x.ela.city.evil.com` is rejected. |
| **A14** | Session-token redaction in `auditMiddleware` + `Token extracted` log line. |
| **A15** | Capsule-signing v2 cutover doc (warn → block-by-default). Tracked separately under `V2-APP-CAPSULE-SIGNING`. |
| `.__puter_gui.json` bypass | Tighten `authenticate`'s `endsWith('.__puter_gui.json')` to exact post-canonicalization match. |

### 🔐 Wave 8 — Chipotle hardening (post-Irzhy review, 2026-04-28)

Irzhy's 2026-04-28 deep audit of the Chipotle Lit migration surfaced three
release-gating findings separate from the researcher's original set. Full
detail lives in
[`.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/`](../../.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING.md).

"Wave 8" avoids a name collision with the existing Wave 7 polish
(A13–A15, v1.2.2). It is unrelated.

| # | Finding | Status |
|---|---|---|
| **C-02** | Chipotle Lit Action CEK decrypt was not bound to the authorised `kid`. An owner of `kid-A` could submit `kid-B`'s ciphertext and recover `kid-B`'s CEK. | ✅ Shipped. Both `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` and `…/media-decrypt-chipotle.js` now enforce `kid == first16Bytes(sha256(cekBase64))` inside the TEE and deny on mismatch. |
| **M-01** | `pc2-node/src/api/media.ts::detectSmartAccountUser` read its RPC URL from PSSH, letting a creator SSRF the server or spoof chain state. | ✅ Shipped. RPC always comes from `getBaseRpcUrl()`; the PSSH field is ignored (parameter renamed `_psshEntries`). |
| **H-01.2** | Auto-provisioning accepted unsigned JSON from supernodes — a compromised supernode could inject a malicious `apiUrl`, wrong PKP, or attacker-controlled RPC. | ✅ Shipped. `chipotle-client.ts` now requires a detached Ed25519 signature over a canonical envelope, enforces an `apiUrl` allowlist and a 90-day `signedAt` freshness window, and defaults to strict mode (`PROVISION_SIG_REQUIRED=1`). |
| H-01.1 | TLS `rejectUnauthorized:false` on supernode provision fetch. | No-op in Wave 8 — already tracked as **A8** above, parked on Sash's DNS-2FA travel block. |
| C-01 | Media decrypt flow was not authenticated. | No-op — closed by Phase 5 sigauth. Irzhy's write-up was against a pre-Phase-5 snapshot. |

**Release gate**: Wave 8 lands on `feature/lit-chipotle-migration` alongside
the earlier waves. As of 2026-04-28 the ceremony is complete end-to-end:

- New Lit Actions pinned to Pinata
  (`QmX5JxcFhyasptCWMA6unFPm3TRYjPSkJb5HhN8289r5uk` non-media,
  `QmSHMSxPogSsNki51fenDzsrkKB3eJfRMHXEPZKqPk6EAb` media). In-repo labels
  rotated to match.
- The existing Elacity Labs Ed25519 seed was reused (no new keypair
  generated); derived pubkey pinned in `chipotle-client.ts`.
- Signing pipeline deployed on both supernodes (`pc2-gateway.service` on
  InterServer `69.164.241.210`, `pc2-web-gateway.service` on Contabo
  `38.242.211.112`); `/api/ddrm/provision` now returns
  `{v:1, domain:'elacity.pc2.chipotle-provision.v1', signedAt, payload, sig}`.
- **Chipotle group-1 allowlist ceremony completed** via the Chipotle Core API.
  A fresh-install bootstrap test revealed that the Chipotle usage key *is*
  scoped to a per-group action-CID allowlist — previous drafts of this section
  claimed no dashboard step existed; that was wrong. Chipotle evaluates two
  CIDs per action: the IPFS canonical CID (`ipfs add --cid-version=0`, used
  for Pinata and for the `actionIpfsId` echoed through the delegation) and
  its own internal CID (returned by `POST /core/v1/get_lit_action_ipfs_id`,
  checked by the auth layer). Both must be kept in sync. Wave 8 pairings:

  | Action | IPFS canonical (Pinata) | Chipotle-internal (group 1) |
  |---|---|---|
  | non-media-decrypt Wave 8 | `QmX5JxcF…r5uk` | `QmNhgrX2…dS4` |
  | media-decrypt Wave 8 | `QmSHMSx…6EAb` | `QmeMz4Qb…cYQx` |

  Both Chipotle-internal CIDs were registered via `POST /core/v1/add_action`
  and added to group 1 via `POST /core/v1/add_action_to_group`. The four
  pre-Wave-8 decrypt CIDs were intentionally retained as rollback canaries.
  Verified with a `lit_action` call using the usage key: HTTP 200 + an
  action-level `missing_session_bundle` (the Phase 5 delegation gate firing
  first, as designed) rather than a 403. Total spend: $0.17. Full procedure
  for future Lit Action rotations is in the runbook Part 3.

**Regression**: `WAVE8_LIVE=1 bash pc2-node/scripts/wave8-smoke.sh` — 5 shell
checks + 9 offline Node cases + 1 live supernode probe = **15/15 green**.

**Manual 4-case C-02 end-to-end matrix**: 🚫 **Blocked on unrelated upstream
bug** (2026-04-28). Irzhy's metadata-refactor commit
[`14e151a35`](../) *"refactor: update content metadata structures and migrate
to directory-based IPFS storage for creator assets"* deletes
`function buildMetadataEnvelope(params)` from
`pc2-node/data/test-apps/elacity-creator/app.js` while leaving the call site
at line 3229 (`buildMetadataEnvelope is not defined` thrown at mint time).
Observed on a fresh Wave 8 bundle: the Wave 8 encrypt path executed cleanly
with the new CID `QmX5Jxc…r5uk`; the mint pipeline fails only at the metadata
envelope step, well after any Wave-8-relevant logic. No impact on Wave 8 code
— this is purely a test-harness regression in Irzhy's in-flight refactor.
Irzhy pinged 2026-04-28 ~08:50; resumes once he pushes a follow-up commit.

### 🔁 Kill-switch flips (post-cutover, scheduled)

| # | When | Switch | Pre-condition |
|---|---|---|---|
| **C1** | T+7 days | `GW_AUTH_REQUIRED=true` (supernode) | ≥99% of inbound calls in last 24h logged `provisioning_token=present` |
| **C2** | T+14 days | `siweRequired=true` (PC2 node) | ≥99% of `/auth/particle` calls in last 24h logged `siwe_verified=true` |
| **C3** | T+30 days | Unpin legacy Lit Action CIDs from IPFS | — |
| **C4** | T+7 days post v1.2.1 ship (A16 shipped 2026-04-23 in `2a9e39386`) | `FILE_URL_SIGNING_REQUIRED=true` | `[file] legacy-unsigned` log line drops to zero across 24h. Mint sites already updated server-side, so the only legacy traffic is from cached URLs in browser DOM / iframe srcs. |

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
| **D0a** | ✅ **WAVE 6 part 1 — A6, A10, A12, A18 (4 of 8) shipped** — argv-only system restart + Jetson cleanup, rate limits + auth on catalog/reindex, owner-binding on wallet proposals, dangerous-action gate on scheduler tasks. 4 atomic commits (`a731206f8` A12, `8b0a71fdd` A18, `d1c2036e4` A10, `61318414c` A6) on `feature/lit-chipotle-migration`. Typecheck clean, ESLint clean, no UX change for any legitimate user. | dev | **v1.2.1, shipped** | A9 deferred to Wave 6.5/7 (needs desktop UI enumeration of `esc-nft/:path` calls). |
| **D0b** | ⚡ **WAVE 6 part 2 — A7, A8, A11, A16 remaining** — SHA-256 pin on ollama install (A7), TLS pinning / hostname migration on `/api/esc-rpc` (A8 — needs Sash to confirm Contabo's hostname or accept cert-pin runbook), undici Dispatcher DNS-rebind-safe SSRF in `/api/http` (A11), HMAC-signed `/file?uid=` capability + desktop mint helpers (A16). Each is a larger refactor with new dependencies; deferred to a v1.2.1b session. | dev | **v1.2.1b, ≤ T+14 days** | [`SEC-2026-04-22-WAVE6-HARDENING`](.cursor/tasks/SEC-2026-04-22-WAVE6-HARDENING/SEC-2026-04-22-WAVE6-HARDENING.md). Should still land **before** the kill-switches flip strict (Phase C1/C2). A16 carries a 7-day log-only window after deploy before the `fileUrlSigningRequired` switch flips. |
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
| **A6 (Wave 6 part 1)** brittle bash glob in system restart + Jetson | `detectProcessManager()` and the restart fallback chain replaced `execSync(cmd, { shell:'/bin/bash' })` with `execFileSync(binary, argv)`. PM2 binary candidates are now enumerated in JS via `fs.readdirSync` over `~/.nvm/versions/node/*/bin/`, plus fixed paths `/usr/local/bin/pm2`, `/usr/bin/pm2`. Jetson `nvpmodel`/`jetson_clocks` calls dropped `2>&1` shell redirect in favour of `stdio:'pipe'` on fd 2. No shell, no glob, no env-var interpolation, no command-string concatenation anywhere in the system restart surface. | `pc2-node/src/api/system.ts` |
| **A10 (Wave 6 part 1)** unauth DoS surface on catalog/reindex + GraphQL proxies | `POST /api/catalog/reindex` now requires `authenticate` + per-IP rate limit (1 req per 5 min). The creator iframe authenticates via the existing Referer fallback (its `puter.auth.token` URL param is in the Referer header), so legitimate fire-and-forget calls are unaffected. `POST /api/elacity/graphql` and `POST /api/esc-nft/graphql` get per-IP rate limit only (30/min). Adding `authenticate` would have broken the marketplace iframe, which forwards its own ela.city Bearer token in the Authorization header for the proxy to pass upstream — PC2 cannot also use that header for session lookup. Per-IP rate limiting closes the actual A10 finding (DoS / cost amplification) without breaking iframe transport. | `pc2-node/src/api/index.ts` |
| **A12 (Wave 6 part 1)** wallet-proposal owner binding | `POST /api/wallet/proposals/:id/{approve,reject,execute}` all fetch the proposal first and verify `proposal.from.toLowerCase() === req.user.wallet_address.toLowerCase()` before mutating. Mismatch → 403 with diagnostic log. On-chain signing is still gated by the key-holding wallet (unchanged); this fix prevents a tethered wallet from poisoning the owner-facing audit trail and the desktop proposal UI by mutating another wallet's proposal records. | `pc2-node/src/api/wallet.ts` |
| **A18 (Wave 6 part 1)** scheduler dangerous-action gate | `POST /api/scheduler/tasks` and `PATCH/PUT /api/scheduler/tasks/:id` now route through `requireOwnerForDangerousAction`, which calls `requireOwner` only when the request body's `action` is in `DANGEROUS_ACTIONS = { terminal_exec, terminal_script, git_pull }`. `http_request`, `backup_create`, etc. and all read/list/delete paths remain `authenticate`-only so tethered wallets keep working as before. Today `handleTriggerTask` only marks the task as triggered (no executor wired), but the gate is in place **before** any scheduler runner service ships, so the SQLite rows can never carry a tethered-wallet-supplied dangerous payload. | `pc2-node/src/api/scheduler.ts` |
| **A7 (Wave 6 part 2)** ollama installer trust-on-first-use | `/api/ai/install-ollama` no longer pipes `curl ... | sh`. The handler downloads `https://ollama.com/install.sh` via `https.get` to a 0600 tmpfile (15s timeout, 256 KiB cap), SHA-256-verifies against the pinned constant `OLLAMA_INSTALL_SH_SHA256` (captured 2026-04-23), then `spawn('sh', [tmpfile])`. Mismatch → 503 with both expected and actual SHAs so the operator can decide whether to bump the pin (audit the upstream change first) or investigate. Also gated by `requireOwner` — installing system packages is owner-only. | `pc2-node/src/api/ai.ts` |
| **A11 (Wave 6 part 2)** SSRF DNS-rebind on `/api/http` and `/api/download` | The previous `isBlockedHost(url)` check parsed the URL hostname and applied an IPv4-only string + regex blocklist. The actual `fetch()` did its OWN `dns.lookup` at connect time, opening a classic rebind window. Replaced with `resolveAndValidate(hostname)`: single `dns.lookup({all,verbatim})`, validates EVERY returned IP against the private/loopback/link-local blocklist (now incl. IPv6 ULA `fc00::/7`, link-local `fe80::/10`, IPv4-mapped IPv6, IPv4 wildcard `0/8`, and CGNAT `100.64/10`), then returns the validated IP. A per-request `undici.Agent` is built with `connect.lookup` overridden to ALWAYS return that pinned IP — closing the rebind window. Same fix applied to `handleDownload` (same SSRF vector, same shape). Per-request agent is closed in a `finally{}` block so no socket leaks. `undici@^7.19.1` is now a direct dep. | `pc2-node/src/api/http-client.ts` |
| **A16 (Wave 6 part 2)** `/file?uid` HMAC sign+verify (mint sites — see kill-switch table for verifier) | All 3 server-side mint sites now produce real HMAC-SHA256 signatures via `mintFileUrlSignature(uid, expires)` from the new `pc2-node/src/utils/fileUrlSigner.ts` module. The signing key is a 32-byte random value at `data/.file-url-signing-key` (mode 0600, generated on first call, cached in memory). TTL changed from the absurd 999999999s ("forever") to a sane 24h via `buildExpires()`. There are no client-side mint sites — iframe apps call `POST /sign` and embed the server-minted URLs. | `pc2-node/src/api/other.ts` (2 sites), `pc2-node/src/api/filesystem.ts` (1 site), `pc2-node/src/utils/fileUrlSigner.ts` |

### Gated by a kill-switch (compatibility valve for the rollout window)

| Finding / change | Switch | Default | What "off" actually does | What "on" enforces |
|---|---|---|---|---|
| **SEC-3a** SIWE on `/auth/particle` | `config.security.siweRequired` | `false` | Signature is **verified** if supplied (logged) but not **required**. Legacy v1.1 client calls still go through. | Missing/invalid signature → 401. New ownership claims require loopback OR `firstRunToken` OR a verified SIWE. |
| **SEC-8/9** WG/AWG/VLESS provisioning | `GW_AUTH_REQUIRED` env var | `false` | Token presence is **logged for telemetry** but missing/wrong tokens still get `action=allow`. | Missing/wrong tokens → 401. |
| **A16 (Wave 6 part 2)** `/file?uid` HMAC verifier | `FILE_URL_SIGNING_REQUIRED` env var | `false` | Real HMAC signatures verify and serve. Forged HMACs / explicit expiry violations are **always 403** regardless of switch state. Pre-A16 `sig-…` URLs are served but logged as `[file] legacy-unsigned` so we can confirm zero legitimate traffic before flipping ON. | Only HMAC-valid + non-expired URLs are served; everything else → 403 with rejection reason. Mint sites (3) already produce real HMAC signatures regardless of switch state, so the only legacy traffic during the window is from cached URLs in browser DOM / iframe srcs. Target flip date: T+7d post v1.2.1. |

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
| **Wave 8 detail (C-02 + M-01 + H-01.2, Chipotle hardening, release-blocking)** | [`.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING.md`](../../.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING.md) |
| **Wave 8 rotation runbook (Lit CIDs + provision key ceremony)** | [`.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/ROTATION_RUNBOOK.md`](../../.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/ROTATION_RUNBOOK.md) |
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
