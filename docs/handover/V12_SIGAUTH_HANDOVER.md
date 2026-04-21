# V1.2 dDRM Sigauth Cutover — Engineer Handover

**Author**: PC2 / Cursor session 2026-04-20 → 2026-04-21
**Status**: Implementation complete, V1.2-ready. Pending cleanup (Phase 5.4–5.7) and docs (Phase 4).
**Reader**: Anyone joining the PC2 dDRM track for V1.2 release.
**Pre-reqs**: Familiarity with PC2's Lit Action / Chipotle stack and the
`.ddrm` capsule format. If new, read
`docs/handover/IRZHY_DDRM_HANDOVER.md` first.

---

## 1. Why this work existed (the P0 vulnerability)

Before this cutover, `pc2-node/data/lit-actions/non-media-decrypt.js`
took `userAddress` from `jsParams` and passed it straight into the
on-chain access check. Because Lit Action source is public on IPFS
(loaded by CID), **any attacker with their own PC2 node could call the
action with any authorized buyer's address and receive the CEK.**

Full threat model: `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/SECURITY.md`
Original task: `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/LIT-ACTION-SIGNATURE-AUTH.md`
Original design: `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md`

**Surfaced**: 2026-04-17 V1.2 pre-release call. Reproduced with a
~25-line Node script. Plaintext retrieved without holding an AccessToken.

## 2. What we shipped (Option C — Session-Key Delegation)

| Concept | Where it lives |
|---|---|
| Buyer signs **one** EIP-191 delegation message authorizing an ephemeral, device-bound P-256 key for 24 h across their EOA + smart account | `pc2-node/src/wallet-bridge/pc2-secure-view-session.js` (key gen, delegation/request signing) + `pc2-secure-view.js` (parent-frame manager) |
| Per-asset request signed silently by ephemeral key (no wallet prompt) | Same files; bundle returned via `pc2_secureView_sign` RPC |
| Sigauth Lit Action verifies delegation EIP-191 sig + request P-256 sig + replay protection + action-CID binding | `pc2-node/data/lit-actions/non-media-decrypt-chipotle-sigauth.js` and `media-decrypt-chipotle-sigauth.js` |
| Server forwards signed bundle, never sends `userAddress` | `pc2-node/src/api/storage.ts` (`/lit/secure-view`), `pc2-node/src/api/chipotle-client.ts` (`recoverNonMediaCEK`, `recoverMediaCEKEnvelope`), `pc2-node/src/api/media.ts` (`/api/media/init`) |

End-to-end flow:

```
[Buyer wallet]
    │ 1. EIP-191 sign delegation { actionIpfsId, ownerAddr, coveredAddrs[],
    │                              sessionPubKey, expiresAt, nonce }
    ▼
[Browser IndexedDB] ── stores delegation + non-extractable P-256 key ── 24h
    │
    │ 2. For each asset open:
    │    - Web Crypto P-256 signs request { kid, actionIpfsId,
    │                                       requestedAt, requestNonce }
    ▼
[PC2 server] ── forwards { delegation, delegationSig, request, requestSig }
    │       ── as jsParams to Lit Action via Chipotle REST
    ▼
[Lit Action TEE] ── verifies sigs, replay, action-CID binding
                 ── derives effective user from delegation.coveredAddresses
                 ── on-chain hasAccessByContentId(user, kid)
                 ── if pass → returns CEK via Lit.Actions.Decrypt
```

## 3. The 24-hour journey (what changed when)

### 3.1 Day 1–2 (pre-summary, captured in
`.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/`)
- Spec, threat model, primitives spike, server + client helpers
- Sigauth Lit Actions written, pinned, registered with Chipotle group `1`
- `ddrm-viewer` (PDF/EPUB/CBZ/image/dataset) migrated and validated end-to-end

### 3.2 Phase 5 (this session) — Hard cutover, no legacy fallback

**5.1** `/lit/secure-view` returns `401 session_bundle_required` if the
caller doesn't attach `{ delegationCanonical, delegationSig,
requestCanonical, requestSig }`. No silent legacy fall-through.
File: `pc2-node/src/api/storage.ts`.

**5.2** `getChipotleNonMediaActionCode()` no longer has a `'legacy'`
mode. It only loads `non-media-decrypt-chipotle-sigauth.js`.
File: `pc2-node/src/api/chipotle-client.ts`.

**5.3** `userAddress` removed from `jsParams` in both Datil and Chipotle
paths. The action derives the effective user from
`delegation.coveredAddresses` only.
Files: `storage.ts`, `media.ts`, `chipotle-client.ts`.

**5.build** Server rebuilt + restarted; exploit-regression spike confirms
the old attack now returns `del_sig_invalid` / `session_bundle_required`.

### 3.3 Phase 6 BLOCKER discovered + fixed (this session)

`pc2-media-runtime/player.js` was still on the legacy auth path. Two
bugs needed fixing:

**6a — Two-phase 412 init for media** (server + client)
The player can't sign a request *before* `/api/media/init` because
`kid` and `actionIpfsId` are only known after the server has parsed the
MPD/PSSH. New protocol:

1. Client `POST /api/media/init` *without* `secureViewSession`.
2. If server has the bundle → recover CEK, return 200 (legacy behaviour).
3. If server doesn't → respond `412 Precondition Failed` with
   `{ needsSecureView: { kid, actionIpfsId } }` *and the parsed MPD is
   cached server-side for 60 s so the retry is free*.
4. Client requests the bundle from the parent frame
   (`pc2_secureView_sign` RPC), retries `/api/media/init` with bundle
   attached → 200.

Server-side: `pc2-node/src/api/media.ts` (412 branch + `initContextCache`).
Client-side: `pc2-node/data/test-apps/pc2-media-runtime/player.js`
(`mediaInitWithSecureView` wrapper around `tryInit` + `refreshSession`).

**6a-fix2 — Server-authoritative action CID** *(critical)*

Symptom after 6a was deployed: every MP4/audio decryption returned
`Lit Action denied: Access denied (code=bad_action_cid)`.

Cause: legacy assets were minted with action CID `Qmc…` (v0
non-sigauth) baked into their MPD's PSSH. The new sigauth Lit Action
verifies that **the action currently executing matches the action the
user signed the delegation for** (replay-defence). Server was forwarding
the PSSH-recorded CID, but the user's delegation is bound to
`NON_MEDIA_ACTION_CID` (`bafkrei…`, the new sigauth) → mismatch → reject.

Fix: in `media.ts` after MPD parse, when `litBackend === 'chipotle'`,
override `litParams.actionCid` with `getNonMediaActionCid()` from
`storage.ts`. The 412 response now sends the server-controlled CID,
so the client signs a request bound to it, which matches what the
TEE actually runs.

**Architectural invariant established**:

> **The Lit Action CID is server-authoritative, never asset-authoritative.**

Both the non-media and media paths now follow this rule. We can rotate
the sigauth action CID without re-minting any asset. The PSSH-recorded
CID is informational only (used for legacy Datil decryption if we ever
need it; ignored for chipotle).

## 4. File-by-file changes (this session only — Phase 5 + Phase 6a)

| File | Change |
|---|---|
| `pc2-node/src/api/storage.ts` | (5.1) Mandatory `secureViewSession` on `/lit/secure-view`. (5.3) Removed `userAddress` from Datil jsParams. (6a-fix2) Added `export function getNonMediaActionCid()`. |
| `pc2-node/src/api/chipotle-client.ts` | (5.2) Removed `'legacy'` mode from `getChipotleNonMediaActionCode`. (5.3) Removed `userAddress` from `recoverNonMediaCEK` + `recoverMediaCEKEnvelope` jsParams. |
| `pc2-node/src/api/media.ts` | (5.3) Throws if `secureViewSession` missing. (6a) Added `initContextCache` + 412 branch for two-phase init. (6a-fix2) Override PSSH actionCid with `NON_MEDIA_ACTION_CID` for chipotle backend. |
| `pc2-node/src/wallet-bridge/pc2-secure-view.js` | Added extensive `[PC2 SecureView]` debug logging. (Behaviour unchanged.) |
| `pc2-node/data/test-apps/pc2-media-runtime/player.js` | New: `requestSignedBundleFromParent`, `mediaInitWithSecureView`. Both `tryInit()` and `refreshSession()` route through the wrapper. |
| `pc2-node/data/test-apps/pc2-media-runtime/index.html` | Cache-bust: `player.js?v=5-sigauth-2`. |
| `pc2-node/data/installed-apps/pc2-media-runtime/{player.js,index.html}` | Synced from `data/test-apps/`. **Required** — see §6 deployment gotcha. |
| `pc2-node/frontend/index.html` + `scripts/build-frontend.js` + `src/static.ts` + `data/test-apps/ddrm-viewer/index.html` | Cache-busting `?v=20260421a`. |

## 5. How to verify it's working (test matrix)

### 5.1 Sanity build + restart
```bash
cd pc2-node && npm run build
kill $(lsof -ti:4200) 2>/dev/null
sleep 2
PORT=4200 node dist/index.js
```

Expect on startup:
```
[Lit] Backend: chipotle
[Lit] Loaded action CID from file: bafkreihvm4zkyuefnuptlbdins6cmd2mbslj2xgnyzz3ssdg2ggg3jtkk4
```

### 5.2 Non-media (PDF/EPUB/image) — should be silent after first 24 h delegation
1. Connect wallet → **one wallet popup** asking to sign the delegation.
2. Open `alice-in-wonderland.ddrm` (PDF) → no popup, opens immediately.
3. Open a `.png.ddrm` → no popup, opens immediately.
4. Server log: `[Chipotle] Non-media CEK recovered`.

### 5.3 Media (MP4/MP3) — Phase 6 cutover
1. Open `Video.ddrm` (MP4 with AV1+AAC).
2. Browser console must show:
   ```
   [player] /init returned 412 — requesting secure-view bundle from parent: kid=0x…
   [PC2 SecureView] tryRestoreSession: restored cached session (no wallet prompt needed)
   [PC2 SecureView] signRequest: bundle ready
   ```
3. Server console must show:
   ```
   [media/init] Phase-1 412 → needsSecureView kid=… actionIpfsId=bafkrei…
   [media/init] MPD cache hit for bafyb…   ← retry skips IPFS round-trip
   [media/init] Overriding PSSH actionIpfsId for chipotle: pssh=Qmc… → server=bafkrei…
   [Chipotle] Non-media CEK recovered
   ```
4. Video plays.
5. Repeat for `audio.mp3.ddrm` — same flow, audio-only SourceBuffer.

### 5.4 Exploit regression (should still fail)
Run `pc2-node/scripts/security/spike-exploit-regression.mjs` against
the new action CID. Expect:
- All 5 attack variants reject with `del_sig_invalid` /
  `bad_action_cid` / `request_sig_invalid` / `expired` /
  `session_bundle_required`.

### 5.5 Negative cases the action explicitly rejects
| jsParams tampering | Action error code |
|---|---|
| Drop `delegation` | `session_bundle_required` (server-side 401) |
| Forge `delegationSig` | `del_sig_invalid` |
| Forge `requestSig` | `request_sig_invalid` |
| Pass a different `kid` than the one in `request` | `kid_mismatch` |
| Pass a different `actionIpfsId` than `delegation.actionIpfsId` | `bad_action_cid` |
| Replay a used `requestNonce` | `nonce_replay` |
| Use an expired delegation (`expiresAt < now`) | `expired` |
| List a `coveredAddress` that doesn't hold the AccessToken | `access_denied` |

## 6. Operational gotchas you must know

### 6.1 Two-copy app deployment (cost us hours of debugging)

Puter apps live in **two** places:
- `pc2-node/data/test-apps/<app-name>/`  ← source of truth, where you edit
- `pc2-node/data/installed-apps/<app-name>/`  ← what the server actually serves

If you edit `test-apps/`, **you must also copy to `installed-apps/`**, or your
changes will silently not load. Cache-busting via `?v=…` on the `<script>`
src does NOT help — the server is just serving the old `index.html` from
`installed-apps/`.

**Quick sync**:
```bash
cp pc2-node/data/test-apps/<app>/{player.js,index.html} pc2-node/data/installed-apps/<app>/
```

We have not yet automated this in the build (separate task — propose
adding to `scripts/build-frontend.js`).

### 6.2 Action CID rotation procedure

When you re-pin a sigauth action (e.g. to apply a security patch):

1. Pin new action JS to IPFS, capture new CID.
2. Update `pc2-node/data/.lit-action-cid` with the new CID
   (or set `LIT_ACTION_CID` env var).
3. Register the new CID with Chipotle group `1` (`elacity-ddrm`):
   ```
   chipotle add_action <new_cid>
   chipotle add_action_to_group <new_cid> 1
   ```
4. Restart pc2-node. Server log should show
   `[Lit] Loaded action CID from file: <new_cid>`.
5. **Existing user delegations become invalid** — they were signed for
   the old CID. Users get *one* fresh wallet popup on next asset open.
   This is intentional: a rotated action CID implies a security event
   and you want to invalidate outstanding delegations.
6. Old CID stays pinned for 14 days as rollback (already standard ops
   procedure per `LIT-ACTION-SIGNATURE-AUTH.md` §"Acceptance Criteria").

### 6.3 NON_MEDIA_ACTION_CID is the single source of truth

`storage.ts` declares it module-private (`let`). Other modules read it
via `getNonMediaActionCid()` (added this session). **Do not duplicate
the env-var resolution elsewhere** — always go through the getter.

### 6.4 Dual-wallet (EOA ↔ smart account)

The delegation lists `coveredAddresses[] = [EOA, smartAccount]`. The
action loops over both during `hasAccessByContentId`. This means:
- AccessToken on EOA → opens.
- AccessToken on SA → opens.
- Token on neither → `access_denied`.

The player has a redundant client-side fallback that retries `/init`
with `buyerAddress=SA` if the first attempt with `buyerAddress=EOA`
returned access-denied. This is belt-and-braces; the server-side
delegation already covers both. Safe to remove in V1.3 cleanup.

## 7. Known issues + roadmap (V1.2 cutover scope)

| ID | Status | Owner | What |
|---|---|---|---|
| `LIT-ACTION-SIGNATURE-AUTH` Phase 5.1–5.3, 6a, 6a-fix2 | ✅ Shipped this session | PC2 | Hard cutover to sigauth, both non-media + media, action CID server-authoritative |
| `LIT-ACTION-SIGNATURE-AUTH` Phase 5.4–5.7 | ⏳ Pending | PC2 | Delete legacy Lit Action JS files, rename `*-sigauth.js` → canonical, purge legacy env vars |
| `CREATOR-THUMBNAIL-FALLBACK` | 📝 Newly scaffolded this session | PC2 | Creator silently drops thumbnail when Elacity IPFS upload fails. Local IPFS fallback needed to mirror asset/metadata path. **Surfaced because** Elacity IPFS started 502'ing |
| `ELACITY-IPFS-UPLOAD-502` | 📝 Newly scaffolded this session | Elacity ops | Investigate 502 + extreme-slowness on Elacity IPFS pinning service |
| `IPFS-ELACITY-BOOTSTRAP` | ⏳ Pre-existing | PC2 | Hard-code Elacity's libp2p multiaddrs into PC2 Helia bootstrap so DHT walks resolve fast even when the pin service is degraded |
| `LIT-ACTION-SIGNATURE-AUTH` Phase 4 (docs + announce) | ⏳ Pending | PC2 + comms | Lift P0 banner from `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md`; write changelog; community post |

## 8. Security posture statement (for the changelog / announcement)

> As of V1.2, Elacity dDRM uses a session-key delegation scheme to
> authenticate every decryption call. The Lit Action no longer trusts
> any caller-supplied identity claim; instead the buyer's wallet
> cryptographically authorizes a device-bound, non-extractable
> ephemeral key for 24 hours, and every per-asset open is signed by
> that key. The previous (V1.1) authentication flaw, in which a
> motivated attacker could obtain content keys by invoking the Lit
> Action with another user's address as a parameter, is closed.
> Replayed signatures, expired delegations, mismatched key IDs, and
> mismatched action CIDs are all explicitly rejected by the Lit Action
> with distinct error codes. UX is preserved: typical users see one
> wallet prompt per 24 hours and zero prompts on subsequent asset
> opens.

## 9. Quick-reference: where to look when something breaks

| Symptom | First place to look |
|---|---|
| Wallet prompts on every asset open | `pc2-secure-view.js` `tryRestoreSession` log; IndexedDB storage |
| `bad_action_cid` from Lit Action | `[media/init] Overriding PSSH actionIpfsId` log + `getNonMediaActionCid()` value |
| `del_sig_invalid` | Wallet (Particle / MetaMask) returned a malformed sig; check delegation message canonicalization (`canonicalize()` in helper) |
| `request_sig_invalid` | P-256 key got rotated mid-session; force re-delegation by clearing IndexedDB |
| `session_bundle_required` (401) | Caller not on sigauth path; check `secureViewSession` field in request body |
| 412 on `/api/media/init` followed by hang | `pc2_secureView_sign` RPC silently failing — check parent-frame console for `[PC2 SecureView]` errors |
| MP4 plays but no thumbnail / file-icon | `CREATOR-THUMBNAIL-FALLBACK` (data, not auth) |
| 502 on `upload-elacity` | `ELACITY-IPFS-UPLOAD-502` (Elacity infra, not PC2) |
| Edits to Puter app not loading | Forgot to copy `data/test-apps/<app>/` → `data/installed-apps/<app>/` |

## 10. Contact + provenance

- This session's transcript: `4c16621e-86ec-4c19-82da-2d8388e85248`
- Pre-session Phases 2a–3 work: `feature/lit-chipotle-migration` branch
- Original V1.2 call summary: `.cursor/tasks/V1.2-RELEASE-CALL-APR17/CALL-SUMMARY.md`

---

*This document is the canonical source for V1.2 sigauth work. Update it
when you ship Phase 5.4–5.7 or any further sigauth changes — do not
write a new handover.*
