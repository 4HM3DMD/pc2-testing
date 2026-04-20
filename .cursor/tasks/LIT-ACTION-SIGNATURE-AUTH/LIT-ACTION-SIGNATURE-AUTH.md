# Task: Lit Action Session-Key Delegation Auth (P0 Security)

**Task ID**: LIT-ACTION-SIGNATURE-AUTH
**Created**: 2026-04-17 · **Revised**: 2026-04-20 (implementation complete)
**Status**: Review — Phases 2a–3 shipped on `feature/lit-chipotle-migration`; awaiting User sign-off + merge
**Priority**: **P0 — Critical Security** — shipped for V1.2 DRM release
**Target Release**: V1.2 (end of April 2026)
**Related**: `pc2-node/data/lit-actions/non-media-decrypt.js`,
`pc2-node/src/api/storage.ts` (`/lit/secure-view`),
`pc2-node/src/api/chipotle-client.ts`

## TL;DR

The non-media Lit Action trusts `userAddress` from `jsParams`. Since
the Lit Action code is public and immutable on IPFS, any party can
invoke it with any authorized buyer's address and receive the CEK.
**Access control is currently bypassable.**

**Fix** (Option C — session key delegation): on wallet connect the
buyer signs **one** delegation message that authorizes an ephemeral,
device-bound, non-extractable key to decrypt dDRM content for 24
hours across their EOA + smart account. Every subsequent asset open
is signed silently by the ephemeral key — no wallet prompt. The Lit
Action verifies both signatures and uses the **covered addresses
listed in the delegation** for the on-chain access check.
`userAddress` is removed from `jsParams` entirely.

- Full technical design: **[`DESIGN.md`](./DESIGN.md)**
- Formal threat model & attack catalogue: **[`SECURITY.md`](./SECURITY.md)**

## Why Option C (and not A or B)

| | A: per-asset sig | B: per-session sig | **C: session key** |
|---|---|---|---|
| Wallet prompts/day | Many | 3-5 | **1** |
| "Double-click to open" | ❌ regression | ⚠️ partial | ✅ preserved |
| Closes current exploit | ✅ | ✅ | ✅ |
| Damage if one secret leaks | 1 asset, 60s | Library for 15m | Need **both** sig + non-extractable key |
| Dev effort | ~1.5d | ~2d | ~3.5d |

Community feedback on 2026-04-17 call explicitly weighted UX:
*"What one user said was how nice it was to just double-click and
open a file."* Option C preserves that. See DESIGN.md §9 for the
complete comparison.

## Background

### How the vulnerability was confirmed

1. `pc2-node/data/lit-actions/non-media-decrypt.js` lines 42–63 take
   `userAddress` from `jsParams` and pass it straight into
   `gateway.hasAccessByContentId(checksumUser, normalizedKid)`.
2. The action is loaded by CID (`ipfsId`) — immutable, public source.
3. An attacker with their own PC2 (or a custom Chipotle call) can
   invoke the action with arbitrary `jsParams`. Supplying any
   authorized buyer's address returns the CEK.
4. A 25-line Node script reproducing the exploit is specified in
   DESIGN.md §1.3.

### Threat model (short)

- **Attacker** controls a PC2 node or any Lit-compatible client.
- **Needs**: public `(ciphertext, kid, actionIpfsId, authority, rpc)`
  (all pinned alongside the asset) + one authorized buyer address
  (readable from `AccessTokenMinted` events).
- **Gets today**: the CEK. Forever, until we rotate.
- **Gets after fix**: nothing. Cannot forge the delegation
  (requires wallet key) or the per-request signature (requires the
  non-extractable device key).

Full threat model in SECURITY.md.

### Why surfaced now

Identified on V1.2 pre-release team call 2026-04-17. A team member
reproduced the attack on a test channel and retrieved plaintext
without holding an AccessToken. Transcript stored in project
transcripts.

## Requirements

### Must-have (blocks V1.2 release)

- [ ] Buyer's wallet address is **cryptographically proven** before
      the Lit Action releases a CEK. The action does not accept a
      naked address parameter.
- [ ] **One wallet prompt per wallet-connect**, not per asset and not
      per session. Subsequent asset opens have zero wallet popups.
- [ ] Delegation message binds: `domain`, `chainId`, `actionIpfsId`,
      `ownerAddress`, `coveredAddresses[]`, `sessionPublicKey`,
      `issuedAt`, `expiresAt` (≤ 24h), `nonce`.
- [ ] Per-request message binds: `domain`, `kid`, `actionIpfsId`,
      `requestedAt`, `requestNonce`.
- [ ] Ephemeral key is generated via Web Crypto with
      `extractable: false`. Private key bits are **never** accessible
      to JavaScript on the device.
- [ ] Lit Action rejects: expired delegation, mismatched kid,
      mismatched actionIpfsId, mismatched chainId, stale
      `requestedAt`, forged signature. Every negative case has a
      specific error code.
- [ ] Works for **EOA** (EIP-191) and **contract wallets** (EIP-1271).
      Particle smart-account users see no second prompt — the EOA
      signs, delegation lists both addresses, access check loops
      over covered addresses.
- [ ] Same pattern applied to the **media** Lit Action. Audit every
      other Lit Action for the same pattern.
- [ ] Re-pin both actions to IPFS; update `NON_MEDIA_ACTION_CID` /
      `MEDIA_ACTION_CID` env defaults; keep old CIDs pinned for 14
      days as rollback.

### Should-have

- [ ] Visible "🔒 dDRM session · Nh Nm remaining" indicator in viewer
      with a one-click "Sign out" that wipes ephemeral key + adds
      delegation nonce to PC2's revocation list.
- [ ] Observability: separate counters for
      `delegationSigVerifyFailure`, `requestSigVerifyFailure`,
      `accessDenied` so we can distinguish attack attempts from
      usage errors.
- [ ] Alert on `sigVerifyFailure` rate spike per IP (crude exploit
      detector).

### Nice-to-have

- [ ] User-selectable session duration (1h / 4h / 24h). Ship 24h as
      V1.2 default; pref UI can land V1.3.
- [ ] `security/` section in `docs/wiki/Technical/` summarising the
      Lit Action security model + review checklist for any new
      action we ship.

## Implementation Plan

Detailed in DESIGN.md §5. Summary:

1. [x] **Day 0 — Spec review** — design + security docs reviewed.
2. [x] **Day 1 — Primitive spikes** — EIP-191 + EIP-1271 +
       Web Crypto P-256 across Chromium / Firefox / WebKit. P-256
       curve decision locked (secp256k1 unsupported in Web Crypto on
       every browser). Memo in `DESIGN.md §10`.
3. [x] **Day 2 — Implementation**:
       Server helpers (`pc2-node/src/utils/secureViewSession.ts`),
       client helpers (`pc2-node/data/test-apps/shared/secure-view-session.js`),
       `/lit/begin-session` + `/complete-session` + `/revoke-session`,
       `/lit/secure-view` bundle verification, `recoverNonMediaCEK` +
       `recoverMediaCEKEnvelope` forwarding, sigauth Lit Actions
       (`non-media-decrypt-chipotle-sigauth.js` +
       `media-decrypt-chipotle-sigauth.js`), `.env.example` CID
       placeholders, `ddrm-viewer` client integration.
4. [x] **Day 3 — Testing**:
       `spike-secureview-primitives.mjs` (15 negative cases);
       `spike-exploit-regression.mjs` (static audit + 5 targeted
       exploit attempts); cross-browser conformance in
       `spike-client-server-interop.mjs` +
       `spike-nonextractable.mjs`. Matrix in `TESTING.md`.
5. [x] **Day 4 — Docs + PR**:
       `ELACITY_DDRM_INTEGRATION.md` security banner lifted;
       `DESIGN.md §11–§13` + `TESTING.md` + `spike/README.md`
       updated; ready for PR review.

## Acceptance Criteria

- [ ] **Exploit-repro** script against the *old* action CID releases
      a CEK (captured as evidence). The *same* script against the
      *new* action CID fails with `del_sig_invalid`.
- [ ] End-to-end secure-view works for: EOA buyer, Particle smart-
      account buyer, PDF, EPUB (15 chapters, **one** Lit call, **zero**
      extra wallet popups after the initial delegation), CBZ, image,
      dataset.
- [ ] Opening three different assets in a row costs **one** wallet
      prompt (the delegation), not three.
- [ ] No regression in CEK cache: 15-chapter EPUB still pays one Lit
      call.
- [ ] Expired delegations, mismatched-kid / action-CID / chain-ID
      signatures, replayed request nonces, and no-sig requests all
      reject with `401`-class errors server-side and clear error
      codes from the action.
- [ ] Ephemeral key is verifiably non-extractable:
      `crypto.subtle.exportKey('raw', privateKey)` throws in dev
      console.
- [ ] Sign-out wipes ephemeral key from IndexedDB; subsequent requests
      with the revoked delegation reject server-side.
- [ ] `NON_MEDIA_ACTION_CID` and `MEDIA_ACTION_CID` point at new
      pinned CIDs; old CIDs stay pinned for 14 days.
- [ ] Audit checklist in SECURITY.md §8 is all ticked.
- [ ] Docs updated; security advisory in dDRM integration doc lifted.

## Files to Modify

- `pc2-node/data/lit-actions/non-media-decrypt.js` — full rewrite
  per DESIGN.md §2.7.
- `pc2-node/data/lit-actions/media-decrypt.js` — same pattern.
- `pc2-node/src/api/storage.ts` — `/lit/secure-view` body accepts
  the delegation/request/sigs; `recoverCEKAndFetchData` forwards
  them; `userAddress` dropped from `jsParams`. Add session-begin /
  session-complete / revoke-session endpoints.
- `pc2-node/src/api/chipotle-client.ts` —
  `recoverNonMediaCEK` / `recoverMediaCEK` signatures updated.
- `pc2-node/data/test-apps/ddrm-viewer/viewer.js` — integrate
  session helper, attach delegation + request to every request,
  show session indicator.
- `pc2-node/data/test-apps/elacity-creator/app.js` — same helper for
  preflight preview.
- `pc2-node/.env.example` — new action CIDs after repin.
- `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` — Section 4
  rewrite; lift security advisory.
- `docs/core/LIT_CHIPOTLE_MIGRATION.md` — CID migration note.

## Files to Create

- `pc2-node/src/utils/secureViewSession.ts` — server helpers
  (canonical JSON, sig verify EOA + EIP-1271, Web Crypto sig verify,
  anti-replay, revocation list).
- `pc2-node/data/test-apps/shared/secure-view-session.js` — client
  helpers (ephemeral key generate/store/sign, delegation sign,
  request sign, sign-out, session indicator bindings).
- `scripts/security/exploit-lit-nonmedia.ts` — vulnerability-repro
  script, gated behind `ALLOW_SECURITY_TEST=1`. Serves as both
  evidence of the bug and regression test post-fix.
- `pc2-node/tests/lit-action-signature-auth.test.ts` — positive +
  negative coverage.

## Testing Strategy

Detailed in SECURITY.md §8. Summary:

1. **Exploit repro** — run against old CID, confirm CEK release,
   capture as evidence. Run against new CID, confirm rejection.
2. **Positive matrix** — EOA only, Particle smart account only,
   both addresses covered, third-party contract wallet (mock),
   multi-chapter EPUB.
3. **Negative matrix** — all 13 rejection cases listed in SECURITY.md
   §4 "After" column.
4. **UX** — 15-chapter EPUB = 1 wallet prompt + 1 Lit call + 14 cache
   hits. Three assets in sequence = 1 wallet prompt.
5. **Cross-browser** — Chrome, Firefox, Safari, Particle embedded.
6. **Crypto invariant** — confirm `exportKey('raw', privateKey)`
   throws.

## Dependencies / Blockers

- **No code-side blockers**. All needed pieces exist in the codebase
  today (SIWE infra `media.ts`, `personal_sign` capability in
  `types/capabilities.ts`, EIP-1271 via `ethers` in
  `recoverCEKAndFetchData`).
- **Repinning** is a standard operator task; no Elacity-team
  coordination needed (they pick up the new CID from our env).
- **Particle spike** (Day 1) de-risks the Particle-specific unknowns
  before full implementation. If the spike fails, we still have a
  path: fall back to EIP-1271 for Particle smart accounts (one
  extra RPC call per delegation, not per request).

## Notes

- The existing PC2-side `authenticate` middleware on `/lit/secure-view`
  stays. It stops unauthenticated PC2 users from calling the
  endpoint at all. The fix in this task stops an attacker who has
  their **own** PC2 node from bypassing access control at the Lit
  layer.
- Once this lands, `IPFS-ELACITY-BOOTSTRAP` and
  `UPLOAD-ELACITY-LOCAL-FIRST` become the next priorities for V1.2
  scope.
- Source: V1.2 pre-release team call 2026-04-17.
