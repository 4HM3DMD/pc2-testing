# Task: Upload-Elacity Local-First + Fire-and-Forget Replication

**Task ID**: UPLOAD-ELACITY-LOCAL-FIRST
**Created**: 2026-04-17
**Status**: Parked (Agreed direction, deferred to next work window)
**Priority**: High — publish flow UX degrades by 3× 60 s whenever `base.ela.city` is slow

## Description

Refactor `POST /api/storage/ipfs/upload-elacity` so the Creator publish
flow never blocks on Elacity IPFS being slow/down. Match the resilient
pattern already used by the sibling endpoint `/upload-elacity-directory`:
local Helia IPFS first (returns immediately), then fire-and-forget
replication to Elacity with a hard timeout and explicit status in the
response.

## Background

On 2026-04-17 a community member reported the Creator flow hanging at
`📋 Upload metadata — Building metadata…`. Investigation showed:

- `pc2-node` logs: `[IPFS-Elacity] Upload failed: 504 Gateway Time-out`
  after exactly 60 s. Live probe of
  `https://base.ela.city/api/2.0/files/upload` returned no HTTP response
  within 30 s — Elacity's upstream IPFS pinning service was struggling.
- `elacity-creator/app.js` calls `/upload-elacity` **three times** per
  publish (asset + thumbnail + metadata). Every slow request × 3 =
  ~3 minutes of blank spinner before the flow errors out.
- The endpoint has **no `fetch` timeout** and **no local fallback** —
  it just waits for Elacity.
- Zero code we shipped on 2026-04-17 (EPUB copy-lockdown, CEK cache
  LRU, recovery endpoint) touched the upload path. The slowness is an
  external service issue with an opportunity to harden our side.

The `/upload-elacity-directory` endpoint already does the right thing
(see `pc2-node/src/api/storage.ts` L2720–L2752): store to local IPFS,
convert CIDv1→CIDv0 for gateway compat, then `fetch` Elacity as
fire-and-forget, warning on failure.

## Alignment with Sovereign Direction

Per discussion with the user, the long-term target is:

1. PC2 node writes content to its own local IPFS — sovereign, fast,
   available instantly on DHT.
2. Elacity's indexer observes `AssetCreated` events on-chain and pulls
   metadata + preview from DHT (or replicates to its own IPFS for its
   public gateway).
3. Creators never need Elacity's upload API as a synchronous
   dependency.

This task is a concrete step in that direction for the three current
callers of `/upload-elacity`, without changing the on-chain or
metadata-structure contract.

## Requirements

- Publish flow unblocks in ≤ 200 ms for the 3 `/upload-elacity` calls
  even when Elacity IPFS is returning 504 / timing out.
- Content remains reachable via DHT + local IPFS immediately.
- Elacity replication still happens when the service is healthy, so
  content shows up on `ipfs.ela.city` without extra user action.
- CID returned to the client stays **CIDv0** (`Qm…`) for gateway
  compatibility (Elacity's go-ipfs resolves CIDv0 natively).
- No change to existing response shape; callers can ignore new fields.

## Implementation Plan

- [ ] **Refactor `POST /ipfs/upload-elacity`** in
      `pc2-node/src/api/storage.ts`:
  - Decode `content` (base64) or fetch from local by `cid` (existing
    behaviour).
  - Add bytes to local Helia IPFS with `pin: true, announce: true`.
  - Convert CIDv1 → CIDv0 using `multiformats/cid` (same pattern as
    `/upload-elacity-directory`).
  - Kick off fire-and-forget replication to
    `https://base.ela.city/api/2.0/files/upload` inside an `AbortController`
    with a **15 s timeout**.
  - Respond immediately with
    `{ success: true, cid: cidV0, size, replication: 'pending' | 'ok' | 'failed' }`.
    ("pending" when we return before Elacity responds, which is the
    usual case; we track final state in logs only.)
- [ ] **Add logging**: `[IPFS-Elacity] Replicated <cid> (<ms> ms)` on
      success, `[IPFS-Elacity] Replication timed out for <cid>` on
      abort.
- [ ] **Defensive fallback**: if local IPFS isn't available
      (`req.app.locals.ipfs` nullish), fall back to the current
      synchronous-Elacity path **with a 15 s `AbortController`** so we
      never hang for 60 s.
- [ ] **Frontend tolerant of new response shape**: the existing
      callers in `elacity-creator/app.js` (lines 2877, 3120, 3313) only
      read `elacityAssetResp.ok` + `data.cid`, so no frontend changes
      required, but verify by reading the three call sites.
- [ ] **Type/lint**: `npm run build:backend` clean, no ESLint warnings.

## Acceptance Criteria

- [ ] With `base.ela.city` reachable: full publish completes within
      normal time, item appears on `https://ipfs.ela.city/ipfs/<cid>`
      after a short delay.
- [ ] With `base.ela.city` hard-down (simulate via `hosts` block): full
      publish completes within **≤ 2 s**, item appears via DHT at
      `http://localhost:8080/ipfs/<cid>` and eventually on
      `ipfs.ela.city` once the service returns.
- [ ] CID returned is a CIDv0 (`Qm…`), same content hash as the v1 we
      stored locally.
- [ ] Logs clearly distinguish "replication pending", "replication ok",
      "replication timed out".

## Files to Modify

- `pc2-node/src/api/storage.ts` — `router.post('/ipfs/upload-elacity', …)`
  (lines ~2624–2691 as of commit `82bc3aa9f`).
- `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` — update Section 6
  ("Sovereign Asset Publishing & IPFS Strategy") to describe the new
  behaviour and rationale.

## Testing Strategy

1. **Happy path**: publish one asset, inspect server logs for
   `[IPFS-Elacity] Replicated … (<ms> ms)`. Fetch CID from
   `https://ipfs.ela.city/ipfs/<cid>` — expect 200.
2. **Degraded-Elacity path**: add `127.0.0.1 base.ela.city` to
   `/etc/hosts` to force connection refusals. Publish an asset. Confirm
   the progress bar completes within ~2 s and the CID is reachable via
   local gateway.
3. **Slow-Elacity path**: point `ELACITY_UPLOAD` to
   `https://httpbin.org/delay/30` in a test fixture. Confirm the 15 s
   timeout fires and the response is still `{ replication: 'pending' }`
   with the correct local CID.
4. **Three-call publish**: verify that an asset + thumbnail + metadata
   publish cycle does not exceed ~5 s end-to-end even with Elacity
   unresponsive, vs. ~180 s in current HEAD.

## Notes

- This is a *V1.2.x fast-follow*, not a V1.3 item — it is backward
  compatible and fixes user-visible flakiness today.
- Community context: reported by a user whose publish flow stalled on
  2026-04-17. Context preserved in transcript
  `cceb86b1-3772-4925-92d7-5f0ae7a955d1`.
- While here, also consider adding the same `AbortController` +
  timeout to the other `fetch(ELACITY_UPLOAD, …)` call inside
  `/upload-elacity-directory` (currently "fire-and-forget" but has no
  explicit timeout — relies on Node's default which can exceed 60 s).
