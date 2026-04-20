# Testing Matrix — Lit Action Signature Authentication

Positive and negative test cases covering Phase 3 of the
`LIT-ACTION-SIGNATURE-AUTH` task. Automatable rows run in
`scripts/spike/spike-exploit-regression.mjs` (Node, deterministic);
human-attention rows document what a QA pass must cover in a live
deployment against real wallets.

---

## 1. Automated (CI-gatable)

Run by `spike-exploit-regression.mjs`. All rows must be **PASS** before
the legacy Lit Action CID is retired. Green verdict closes the P0
regression gate.

### 1.1 Static audit of sigauth Lit Actions

| ID | Check | Expected |
|---|---|---|
| A-1 | `non-media-decrypt-chipotle-sigauth.js` does not use `userAddress` for authorization | No match for `hasAccessByContentId(userAddress`, `params.userAddress`, or destructured `userAddress` from `params` |
| A-2 | `non-media-decrypt-chipotle-sigauth.js` iterates `coveredAddresses` and calls `hasAccessByContentId` | Both identifiers present |
| A-3 | `non-media-decrypt-chipotle-sigauth.js` contains `verifyWebCryptoP256` | Identifier present |
| A-4 | `non-media-decrypt-chipotle-sigauth.js` contains `ethers.verifyMessage` and `isValidSignatureEip1271` | Both present |
| A-5 | `media-decrypt-chipotle-sigauth.js` — same four checks as A-1…A-4 | All present |

### 1.2 Happy-path regression

| ID | Scenario | Expected |
|---|---|---|
| H-1 | Fresh delegation + fresh request signed by the correct EOA and ephemeral key | `verifySecureViewBundle` returns `{ ok: true }` |

### 1.3 Exploit attempts

| ID | Scenario | Expected error code |
|---|---|---|
| E-1 | Tampered `coveredAddresses` (attacker swaps in their own address after signing) | `del_sig_invalid` |
| E-2 | Stripped request signature (all-zero bytes) | `req_sig_invalid` (or `sig_malformed`) |
| E-3 | Request replay — identical bundle submitted twice | 1st: `ok`, 2nd: `replayed` |
| E-4 | Revoked delegation — used after `/lit/revoke-session` | `revoked` |
| E-5 | Wrong ephemeral key — request signed by a different device key than declared in delegation | `req_sig_invalid` |

Complementary negative cases covered by
`spike-secureview-primitives.mjs` (Phase 2a): `bad_domain`,
`bad_chain`, `bad_action_cid`, `del_expired`, `del_window_too_wide`,
`bad_req_kid`, `req_stale_or_future`, `pub_malformed`.

---

## 2. Cross-browser matrix (human-run)

Covered by `spike-webcrypto.html` + `spike-nonextractable.mjs` +
`spike-client-server-interop.mjs` in Phase 2a. Summarised here for
Phase 3 sign-off.

| Engine | P-256 generateKey | P-256 sign/verify | Canonical JSON byte-match | IndexedDB storage | Non-extractability survives reload |
|---|---|---|---|---|---|
| Chromium | ✓ | ✓ | ✓ | ✓ | ✓ |
| Firefox | ✓ | ✓ | ✓ | ✓ | ✓ |
| WebKit | ✓ | ✓ | ✓ | ✓ | ✓ |

All green — locked in Phase 2a conformance memo.

---

## 3. Wallet-in-hand (manual QA, Phase 3 sign-off)

Not automatable. Requires a human with a wallet and the dDRM viewer
connected to a Base mainnet PC2. Each row should be exercised once
before the legacy CID is retired.

### 3.1 EOA path (EIP-191)

| ID | Wallet | Browser | Expected |
|---|---|---|---|
| W-1 | MetaMask desktop | Chrome | First open triggers one `personal_sign`. Subsequent opens in the same session show session pill, no re-sign. |
| W-2 | Rabby desktop | Chrome | Same as W-1. Covered-address list matches connected account. |
| W-3 | Coinbase Wallet in-app browser | iOS | `personal_sign` prompts in-app. Session persists across page reloads within the capsule. |
| W-4 | MetaMask mobile in-app browser | Android | Same as W-3. Sign-out button in session pill wipes the key and returns to prompt state. |
| W-5 | Trust Wallet in-app browser | iOS | Same as W-3. |

### 3.2 Smart-wallet / EIP-1271 path

| ID | Wallet | Browser | Expected |
|---|---|---|---|
| W-6 | Gnosis Safe 1.3.0 via WalletConnect | Chrome | Server `/complete-session` returns 200 (EIP-1271 validates). Subsequent views decrypt normally. |
| W-7 | Particle smart account (AA-v0.6) | Chrome | Same as W-6. The embedded Particle modal shows the delegation JSON as the message to sign. |
| W-8 | Argent smart account | Argent mobile browser | Same as W-6. |

### 3.3 Negative UX checks

| ID | Scenario | Expected |
|---|---|---|
| N-1 | User rejects the initial `personal_sign` prompt | Viewer falls back to the legacy path (during rollout) with a console warning. After the legacy CID retires, the viewer displays an "unable to create secure session" error and surfaces a Retry button. |
| N-2 | User signs the delegation with a different EOA than the PC2 session wallet | `/complete-session` returns 400 with `delegation.ownerAddress does not match authenticated session`. Viewer clears the pending session and re-prompts. |
| N-3 | User signs in from two tabs simultaneously | Each tab gets its own ephemeral key (IndexedDB is per-origin + per-slot, but tabs share the slot — second tab reuses the first tab's key, no conflict). |
| N-4 | User revokes the session via the pill's "Sign out" button | IndexedDB cleared, server-side revoke entry added, any open viewer tabs start returning `revoked` on next open. |

### 3.4 Rollout watchdog

| ID | Metric | Target |
|---|---|---|
| R-1 | `% of /lit/secure-view requests with X-SecureView-Session: verified` | ≥ 95% within 7 days of legacy CID being marked `LIT_ACTION_CID_LEGACY` |
| R-2 | Session cache depth on reference node | <= `MAX_DELEGATION_WINDOW_SECONDS * avg_request_rate` (bounded) |
| R-3 | Delegation verification latency (EIP-191 path) | < 5 ms p95 |
| R-4 | Delegation verification latency (EIP-1271 path, single `eth_call`) | < 250 ms p95 |

---

## 4. How to run the automated gate

From the repo root:

```bash
# Rebuild the server primitives first (idempotent)
npm --prefix pc2-node run build:backend

# Phase 2a primitives — 15/15 negative cases + happy path
node scripts/spike/spike-secureview-primitives.mjs

# Phase 3 exploit regression — A-1..A-5, H-1, E-1..E-5
node scripts/spike/spike-exploit-regression.mjs
```

Both must print `Verdict: PASS` before the PR is mergeable. The exit
code is 0 on pass and 1 on any failure, so both scripts are suitable
for CI.
