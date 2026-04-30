# Lit Action Auth Fix — V1.2 (for Irzhy)

> **From:** PC2 / Cursor engineering session 2026-04-17 → 2026-04-21
> **To:** Irzhy (you found the bug — thank you)
> **Status:** Implemented, end-to-end verified across PDF / PNG / MP4 / MP3 on `feature/lit-chipotle-migration`. V1.2-ready.
> **Companion docs (already in this repo, do not duplicate):**
> - Threat model + protocol spec: `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/{DESIGN,SECURITY}.md`
> - Internal V1.2 cutover diary (file-by-file changes, gotchas): `docs/handover/V12_SIGAUTH_HANDOVER.md`
> - Original Elacity-side stack reference (you wrote half of it): `docs/handover/IRZHY_DDRM_HANDOVER.md` (gitignored — has API keys)

This doc is the **short, sanitised, public-safe** version of the fix. Everything below is OK to share with the wider Elacity website team.

---

## 1. The bug you found (recap)

The legacy non-media Lit Action (`non-media-decrypt.js`, IPFS CID `Qmc…`) accepted `userAddress` as a `jsParams` field and used it directly in the on-chain access check:

```js
// LEGACY — vulnerable
const access = await contract.hasAccessByContentId(
  jsParams.userAddress,   // ← attacker-controlled
  jsParams.contentId
);
if (access) { Lit.Actions.setResponse({ cek: ... }); }
```

Because Lit Action source is loaded from a public IPFS CID, *anyone* could:

1. Stand up their own PC2 node (or just an `ethers` script).
2. Look up an authorised buyer on-chain.
3. Invoke the action with `userAddress = <victim>`.
4. Receive the CEK and decrypt the content.

We confirmed this with a ~25-line Node script (`scripts/security/exploit-lit-nonmedia.ts`, gated behind `ALLOW_SECURITY_TEST=1`). Plaintext recovered without ever holding an AccessToken. This was assigned **P0** and blocked V1.2 release.

---

## 2. Fix design — Option C: session-key delegation

We considered three options (full analysis in `DESIGN.md`):

| Option | Approach | Why we rejected / accepted |
|---|---|---|
| A | Sign every per-asset request with the wallet | UX kills it: a wallet popup per asset open breaks "double-click to play" |
| B | Server-issued JWT bound to wallet sig | Moves trust onto the PC2 server, doesn't survive a PC2 node compromise |
| **C** | One wallet sig delegates a non-extractable, device-bound P-256 key for 24 h; that key signs every request silently | **Picked.** One wallet popup per 24 h, zero per asset, and the Lit Action is the trust anchor — PC2 only forwards bytes |

### Protocol summary

```
[Buyer wallet]
    │ EIP-191 personal_sign over canonical JSON:
    │   { actionIpfsId, ownerAddr, coveredAddrs[],
    │     sessionPubKey (raw P-256), expiresAt, nonce, chainId }
    ▼
[Browser]
   • Generates the P-256 keypair via crypto.subtle.generateKey({ extractable: false })
   • Persists CryptoKey object (not bytes — they are unreadable) in IndexedDB
   • Lifetime: 24 h, then hard re-prompt
    │
    │ For each asset open:
    │   Web Crypto signs canonical JSON request:
    │     { kid, actionIpfsId, requestedAt, requestNonce }
    ▼
[PC2 server]
   • Defence-in-depth: verifies delegation EIP-191 sig (and EIP-1271 fallback for smart accounts)
   • Verifies request P-256 sig
   • Anti-replay cache on (sessionPubKey, requestNonce)
   • Forwards { delegation, delegationSig, request, requestSig } as jsParams
    ▼
[Lit Action TEE]   ← non-media-decrypt-chipotle.js / media-decrypt-chipotle.js (sigauth)
   • Re-verifies BOTH sigs (server cannot lie)
   • Asserts request.actionIpfsId === Lit.Actions.currentActionIpfsId  ← closes the original bug
   • Asserts request.requestedAt within ±60 s skew, expiresAt > now
   • Loops over delegation.coveredAddresses to call hasAccessByContentId
     (handles EOA + smart-account in one delegation)
   • Returns CEK only if a coveredAddress passes
```

The exact reason the original attack is closed: **the Lit Action no longer trusts any caller-supplied identity claim**. The effective user is derived cryptographically from a signature it can re-verify against the action CID *it is itself running under*.

---

## 3. What we shipped

### 3.1 New Lit Actions (sigauth)

| File | New IPFS CID | Replaces |
|---|---|---|
| `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` | `bafkreihvm4zkyuefnuptlbdins6cmd2mbslj2xgnyzz3ssdg2ggg3jtkk4` | legacy `Qmc…` non-media action |
| `pc2-node/data/lit-actions/media-decrypt-chipotle.js` | `bafkreihw7brius3xw2u7ltjac26hoqudulkc6mfwqrjxtrobanz2ryhvsq` | legacy media action |

Both are pinned to ≥2 IPFS providers and registered with Chipotle group `1` (`elacity-ddrm`).

The two `*-sigauth.js` files were renamed to the canonical `*-chipotle.js` names in Phase 5 cleanup (2026-04-21) — same bytes, same IPFS CIDs, no Chipotle re-registration needed. The legacy vulnerable `*-chipotle.js` files were deleted in the same cleanup; the legacy IPFS CIDs are unpinned by ops at the 14-day mark (~2026-05-03).

### 3.2 Server changes (TypeScript)

| File | What changed |
|---|---|
| `pc2-node/src/api/storage.ts` | `/lit/secure-view` now returns **401 `session_bundle_required`** if the request omits `secureViewSession`. Removed `userAddress` from Datil jsParams. Added `getNonMediaActionCid()` getter so other modules don't duplicate env resolution. |
| `pc2-node/src/api/chipotle-client.ts` | `getChipotleNonMediaActionCode()` no longer has a `'legacy'` mode — it only loads the sigauth action. `recoverNonMediaCEK` and `recoverMediaCEKEnvelope` require a `secureViewSession` bundle and stop forwarding `userAddress`. |
| `pc2-node/src/api/media.ts` | New **two-phase 412 init** for media (kid is unknowable client-side until the server parses the MPD; see §3.4). After MPD parse, when `litBackend === 'chipotle'`, **server overrides PSSH-recorded action CID with the server-controlled `NON_MEDIA_ACTION_CID`** so the client signs against the action that will actually execute. |

### 3.3 Browser changes (parent frame)

The secure-view session is owned by the **PC2 parent frame**, not by individual app iframes. This matters because some wallets (incl. some Particle/Trust Wallet in-app browsers) refuse to prompt from inside a sandboxed iframe.

| File | Role |
|---|---|
| `pc2-node/src/wallet-bridge/pc2-secure-view-session.js` | Web Crypto primitives (gen, IndexedDB persistence, sign delegation, sign request, canonical JSON). `extractable: false` on the private key. |
| `pc2-node/src/wallet-bridge/pc2-secure-view.js` | Manager — ensures session exists, kicks the wallet exactly once when needed, exposes `signRequest({ kid, actionIpfsId })`. |
| `pc2-node/frontend/pc2-wallet-bridge.js` | New RPC method: `pc2_secureView_sign`. Iframes (viewer, player, creator preflight) call `window.ethereum.request({ method: 'pc2_secureView_sign', params: [{ kid, actionIpfsId }] })` and get back a signed bundle silently. |

### 3.4 App-iframe changes

| File | What changed |
|---|---|
| `pc2-node/data/test-apps/ddrm-viewer/viewer.js` | Removed in-iframe wallet prompts. Now: ask parent for bundle → POST to `/lit/secure-view` with `secureViewSession` attached. Bundle re-fetched per chapter on EPUBs (free — just hits IndexedDB-cached delegation + new P-256 sig). |
| `pc2-node/data/test-apps/pc2-media-runtime/player.js` | New `mediaInitWithSecureView(buildBody)` wrapper around `tryInit()`/`refreshSession()`. On HTTP 412 from `/api/media/init`, asks parent for a bundle for the server-supplied `(kid, actionIpfsId)` and retries with bundle attached. MPD is cached server-side for 60 s so retry is free. |
| `pc2-node/data/test-apps/{ddrm-viewer,shared}/lib/secure-view-session.js` | **Deleted.** All secure-view logic now lives in the parent frame. |
| `pc2-node/data/test-apps/ddrm-viewer/index.html` + `pc2-node/data/test-apps/pc2-media-runtime/index.html` + `pc2-node/frontend/index.html` | Cache-busting query strings (`?v=20260421a`, `?v=5-sigauth-2`). |

### 3.5 Architectural invariant we now enforce

> **The Lit Action CID is server-authoritative, never asset-authoritative.**

Legacy assets have a PSSH-recorded action CID baked into their MPD. Honouring it would mean either (a) rejecting all legacy assets, or (b) rotating the action CID without being able to roll out a fresh sig. We override the PSSH CID with the env-configured server CID at `/api/media/init`, log the override, and the client signs against the server CID. This means we can rotate the sigauth action without re-minting any asset.

---

## 4. How you can verify the fix yourself

### 4.1 Exploit regression (the test you'd want to write)

```bash
# 1. Confirm the OLD action is still vulnerable (sanity baseline)
ALLOW_SECURITY_TEST=1 LIT_ACTION_CID=Qmc<legacy>… \
  node pc2-node/scripts/security/exploit-lit-nonmedia.ts \
    --victim 0x<some-buyer-with-token> \
    --asset bafy<a-real-encrypted-asset>
# Expect: CEK leaked, base64 string printed.

# 2. Run the SAME exploit against the NEW action CID
ALLOW_SECURITY_TEST=1 LIT_ACTION_CID=bafkreihvm4zkyuefnuptlbdins6cmd2mbslj2xgnyzz3ssdg2ggg3jtkk4 \
  node pc2-node/scripts/security/exploit-lit-nonmedia.ts \
    --victim 0x<some-buyer-with-token> \
    --asset bafy<a-real-encrypted-asset>
# Expect: rejected with del_sig_invalid OR session_bundle_required.
```

After Phase 5.4–5.7 ships (next session) the old CID will be unpinned and the baseline exploit will fail with `action_not_found`. Until then, the legacy CID is still pinned for rollback, so the baseline confirms the old vector existed.

### 4.2 Negative-case matrix the action explicitly rejects

| What you tamper with in `jsParams` | Action error code |
|---|---|
| Drop `delegation` | `session_bundle_required` (server-side 401 before the action even runs) |
| Forge `delegationSig` | `del_sig_invalid` |
| Forge `requestSig` | `request_sig_invalid` |
| `request.kid` ≠ what the server passes | `kid_mismatch` |
| `request.actionIpfsId` ≠ `delegation.actionIpfsId` ≠ `Lit.Actions.currentActionIpfsId` | `bad_action_cid` |
| Replay a used `requestNonce` | `nonce_replay` |
| Use an expired delegation (`expiresAt < now`) | `expired` |
| List a `coveredAddress` that doesn't hold the AccessToken | `access_denied` |

These are all defensive — happy-path users never see them.

### 4.3 End-to-end verification we ran on 2026-04-21

| Asset type | Test | Result |
|---|---|---|
| PDF (`alice-in-wonderland.ddrm`) | Mint, open, page through | ✅ One wallet popup (delegation), zero per-page |
| PNG (`.ddrm`) | Mint, open | ✅ Silent open (delegation cached) |
| MP4 (AV1 + AAC) | Mint, open, play | ✅ 412 → bundle → 200, AV1 plays |
| MP3 (AAC in MP4 container) | Mint, open, play | ✅ Same 412 flow, audio plays |

All four use the same sigauth Lit Action. No legacy code path remains in the running server.

---

## 5. What this means for the Elacity website integration

### 5.1 If you mirror the PC2 implementation 1:1

Nothing extra to do beyond what's already in `IRZHY_DDRM_HANDOVER.md` §6 (Decrypt Flow). The new fields are:

- **Request body to `/lit/secure-view`** now requires:
  ```jsonc
  {
    "contentId": "0x...",
    "channel": "0x...",
    "buyerAddress": "0x...",
    "secureViewSession": {
      "delegationCanonical": "<canonical JSON string>",
      "delegationSig": "0x<EOA EIP-191 sig over delegationCanonical>",
      "requestCanonical": "<canonical JSON string>",
      "requestSig": "<base64url P-256 sig over requestCanonical>"
    }
  }
  ```
- **Response shape unchanged** — still `{ cek: "<base64>" }` on success, `{ error, code }` on failure.
- **Error handling**: treat `code === 'session_bundle_required'` as "user needs to (re-)sign delegation"; treat `code === 'expired'` the same way; treat any other sigauth code as "do not retry, surface error".

### 5.2 If you integrate the new client lib directly

`pc2-node/src/wallet-bridge/pc2-secure-view-session.js` is dependency-free, classic-script, and registers `window.PC2SecureViewSession`. It'll drop straight into a non-Puter web app — just call `PC2SecureViewSession.ensureSession({ wallet, ownerAddr, coveredAddrs, actionIpfsId })` once and `PC2SecureViewSession.signRequest({ kid, actionIpfsId })` per asset open. Canonical JSON is byte-identical to the server's `pc2-node/src/utils/secureViewSession.ts` so signatures verify cleanly across both.

### 5.3 What does NOT change

- Capsule format (`.ddrm`).
- WASM runtime player API.
- Smart-contract addresses, ABIs, on-chain access checks.
- IPFS pinning flow.
- Particle Auth / Smart Account handling.

This is purely an authentication-layer fix. Anything you've already integrated against `/lit/secure-view` keeps working as long as you attach the new `secureViewSession` field.

---

## 6. Known follow-ups (V1.2 scope, not blockers)

| Task | Owner | What |
|---|---|---|
| `LIT-ACTION-SIGNATURE-AUTH` Phase 5.4–5.7 | PC2 | Delete legacy Lit Action JS files, rename `*-sigauth.js` → canonical, purge legacy env vars, lift the P0 banner from `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` |
| `LIT-ACTION-SIGNATURE-AUTH` Phase 4 | PC2 + comms | Final docs + community announcement |
| `CREATOR-THUMBNAIL-FALLBACK` | PC2 | Unrelated — Creator drops thumbnail when Elacity IPFS pinning fails. Local-IPFS fallback needed (see `.cursor/tasks/CREATOR-THUMBNAIL-FALLBACK/`) |
| `ELACITY-IPFS-UPLOAD-502` | Elacity ops | Pinning service is intermittently 502'ing + extremely slow. Spec in `.cursor/tasks/ELACITY-IPFS-UPLOAD-502/` |

None of these block the P0 fix or V1.2 release.

---

## 7. Security-posture statement (suggested wording for the V1.2 changelog)

> Elacity dDRM authentication has been hardened against the V1.1 Lit Action vulnerability disclosed during pre-release review. Decryption now requires a session-bound, device-resident, cryptographically-authorised request that the Lit Action verifies inside the TEE. The previous attack — invoking the action with another user's address as a parameter — is closed. UX is preserved: typical users see one wallet prompt per 24 h and zero prompts on subsequent asset opens. Replayed signatures, expired delegations, mismatched key IDs, and mismatched action CIDs are all rejected with distinct error codes, enabling clean client-side handling.

Feel free to rephrase / shorten for the actual announcement.

---

## 8. Where to start reading if you want to audit

In priority order:

1. **Threat model**: `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/SECURITY.md` — what we defended against, what we did not.
2. **Protocol spec**: `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md` — exact canonical-JSON shape, sig algorithms, replay window, address recovery.
3. **The two Lit Actions** (TEE side):
   - `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js`
   - `pc2-node/data/lit-actions/media-decrypt-chipotle.js`
4. **Server enforcement**: `pc2-node/src/api/storage.ts` `/lit/secure-view` and `pc2-node/src/utils/secureViewSession.ts`.
5. **Client primitives**: `pc2-node/src/wallet-bridge/pc2-secure-view-session.js` + `pc2-secure-view.js`.
6. **Two-phase media init** (the one non-obvious bit): `pc2-node/src/api/media.ts` `/api/media/init` 412 branch + `pc2-node/data/test-apps/pc2-media-runtime/player.js` `mediaInitWithSecureView` wrapper.

If anything looks off, ping me before V1.2 ships — happy to walk through any of it.

— PC2

---

*Provenance: this doc summarises the work in commits on `feature/lit-chipotle-migration` from `55cae7a` (Phase 0 exploit repro) through the V1.2 cutover commit landing alongside this file. Internal cutover diary with file-by-file changes is in `docs/handover/V12_SIGAUTH_HANDOVER.md`.*
