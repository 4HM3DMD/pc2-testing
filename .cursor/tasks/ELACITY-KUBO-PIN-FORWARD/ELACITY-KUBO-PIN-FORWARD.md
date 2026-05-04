# Task: Elacity Kubo Pin Forward (Post-Mint Durable Pinning)

**Task ID**: ELACITY-KUBO-PIN-FORWARD
**Created**: 2026-04-29
**Status**: InProgress — client-side shipping 2026-04-29; server-side nginx patch pending ops deployment
**Priority**: P0 — v1.2 blocker, fixes Irzhy's reported playback failure end-to-end
**Target Release**: v1.2.1
**Related**:
- `.cursor/tasks/UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md` — sibling (byte-upload path)
- `.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md` — prerequisite (peering)
- `.cursor/tasks/SUPERNODE-MEDIA-PINNING/SUPERNODE-MEDIA-PINNING.md` — parallel (PC2-supernode pinning)
- `.cursor/tasks/ELACITY-IPFS-UPLOAD-502/ELACITY-IPFS-UPLOAD-502.md` — upstream fix for `base.ela.city` 502s
- `docs/handover/IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md` — root cause
- `docs/handover/ELACITY_IPFS_PIN_ENDPOINT_NGINX_PATCH.md` — server-side patch handover

---

## TL;DR

After every successful pin on a PC2 node, also call
`POST https://ipfs.ela.city/api/v0/pin/add?arg=<cid>&recursive=true`
with a bearer token. Kubo on `ipfs.ela.city` then durably pins the
content even after the minter goes offline. Fire-and-forget,
feature-flagged, default off.

Server-side requires a surgical nginx patch on the Elacity IPFS box
to expose that one Kubo verb with bearer auth. Handover document in
`docs/handover/ELACITY_IPFS_PIN_ENDPOINT_NGINX_PATCH.md`.

---

## Why this is separate from `UPLOAD-ELACITY-LOCAL-FIRST`

`UPLOAD-ELACITY-LOCAL-FIRST` is about the **byte upload path**:
creator publishes → PC2 pushes raw bytes to
`https://base.ela.city/api/2.0/files/upload` → Elacity stores them.
That endpoint has had repeated availability issues
(`ELACITY-IPFS-UPLOAD-502`), and *even when it works* it only pins
what was pushed through it — thumbnails and metadata in most cases,
not always the full encoded media.

`ELACITY-KUBO-PIN-FORWARD` is about the **signal path**: PC2 already
has the CID on its local Helia. Instead of pushing bytes, we ask
Kubo on `ipfs.ela.city` to pin that CID, and Kubo pulls the content
over libp2p (from the minter's PC2 node directly, now that
`IPFS-ELACITY-BOOTSTRAP` establishes peering at startup). This:

- Works for *any* CID the minter has locally — media, thumbnail,
  manifest, metadata — not just whatever went through the byte
  upload proxy.
- Is one tiny HTTP call with a query-string CID, not a multi-MB
  body. Survives `base.ela.city` being down entirely.
- Is idempotent: calling pin/add twice is a no-op.
- Gives `ipfs.ela.city` the *pin* signal, not just a transient cache
  — pinned CIDs survive repo GC, so buyers days later still resolve.

The two approaches are complementary. `UPLOAD-ELACITY-LOCAL-FIRST`
stays on the backlog for the creator byte-path hardening; this task
lands first because it's the direct fix for the playback failure
Irzhy reported on 2026-04-28.

---

## Requirements

- After every successful `/api/ipfs/pin` call (marketplace buy
  flow), fire an async pin-forward request.
- After every successful `/api/storage/ipfs/upload-elacity` and
  `/api/storage/ipfs/upload-elacity-directory` call (creator publish
  flow), fire an async pin-forward request on the returned CID.
- Request shape: `POST ${URL}/api/v0/pin/add?arg=<cid>&recursive=true`
  with `Authorization: Bearer <token>`. 30 s timeout.
- Fire-and-forget: response path to the PC2 user must not block on
  this; failures are logged, not raised.
- Default **off**: behaviour is unchanged when
  `ELACITY_PIN_FORWARD_URL` is not set. Safe to merge before the
  server-side patch lands.
- Diagnostic endpoint:
  `GET /api/storage/ipfs/elacity-pin-forward` (owner-guarded) reports
  configured URL (token masked), enabled/disabled, and last probe
  result per target.
- Startup log: single info line confirming whether forward is
  configured, so operators can see it in boot logs.
- No new npm dependencies; use native `fetch` + `AbortSignal.timeout`
  (already in use for `SUPERNODE-MEDIA-PINNING`).

## Non-requirements

- Does NOT retry failed forwards — idempotency of pin/add means a
  subsequent natural pin event will re-trigger. Retry logic is
  deferred to a later task if we see real-world loss.
- Does NOT change tokenURI or any on-chain metadata.
- Does NOT replace `UPLOAD-ELACITY-LOCAL-FIRST` or
  `ELACITY-IPFS-UPLOAD-502` — those still apply to the byte-upload
  path.

---

## Implementation Plan

### Client side (this task, ships today)

- [x] Draft nginx patch + handover doc
      (`docs/handover/ELACITY_IPFS_PIN_ENDPOINT_NGINX_PATCH.md`).
- [ ] Add `getElacityPinForwardConfig()` helper in
      `pc2-node/src/api/storage.ts` that reads
      `ELACITY_PIN_FORWARD_URL` + `ELACITY_PIN_FORWARD_TOKEN` and
      normalises (trim trailing slash, require https). Returns `null`
      when unset.
- [ ] Add `forwardPinToElacityKubo(cid)` that POSTs
      `${url}/api/v0/pin/add?arg=${cid}&recursive=true` with the
      bearer header, 30 s timeout, records last probe result.
- [ ] Call it in three places:
  - Inside `router.post('/ipfs/pin', ...)` on both success branches
    (next to existing `fanOutSupernodePinMirrors(cidClean)`).
  - Inside `router.post('/ipfs/upload-elacity', ...)` after the
    successful upload response.
  - Inside `router.post('/ipfs/upload-elacity-directory', ...)`
    after the CIDv0 is finalised.
- [ ] Add `router.get('/ipfs/elacity-pin-forward', ...)` diagnostic,
      owner-guarded (same pattern as `/ipfs/pin-mirrors`). Token is
      **not** returned — only its presence flag.
- [ ] Add startup log: `[Storage API] Elacity Kubo pin forward:
      enabled → <url>` when configured, one line.
- [ ] `npm run build:backend` clean.
- [ ] `ReadLints` clean on modified file.
- [ ] Smoke test: set both env vars to a stub server
      (`nc -l 9999` or similar), trigger a pin, verify request hits
      the stub with correct headers + query string, verify forward
      stays fire-and-forget if stub hangs.

### Server side (separate ops deploy, not in this task)

- [ ] Elacity ops team applies the nginx patch from
      `docs/handover/ELACITY_IPFS_PIN_ENDPOINT_NGINX_PATCH.md`.
- [ ] Shares the bearer token via secure channel (Keybase / 1Password).
- [ ] PC2 operator sets `ELACITY_PIN_FORWARD_URL=https://ipfs.ela.city`
      and `ELACITY_PIN_FORWARD_TOKEN=<shared>` in the PC2 node env
      and restarts.

### Verification (post ops-deploy)

- [ ] Mint a test asset from PC2 node A.
- [ ] Within 60 s, confirm
      `GET https://ipfs.ela.city/api/v0/pin/ls?arg=<cid>` (with
      bearer) returns the new CID in recursive form.
- [ ] Confirm diagnostic endpoint on PC2 node A shows
      `lastStatus: 200` for the forward.
- [ ] From PC2 node B (different machine, no local copy), fetch
      `/ipfs/media/init` for the new asset — expect 200 within 2 s.
- [ ] Take node A offline, retry from node B — expect 200 still
      (proves ipfs.ela.city is serving from its own pin, not via
      node A proxy).

---

## Acceptance Criteria

- [ ] With `ELACITY_PIN_FORWARD_URL` unset: zero network traffic to
      Elacity's API from the pin path; no startup noise; existing
      behaviour bit-for-bit unchanged.
- [ ] With env vars set + server-side patch live: every successful
      pin results in a 200 from the Kubo pin endpoint within 30 s.
      Failures logged once, not re-raised to client.
- [ ] Diagnostic endpoint returns `{ enabled: true, url: "...",
      tokenConfigured: true, lastProbe: {...} }` after at least one
      pin.
- [ ] `npm run build:backend` clean, no ESLint warnings on
      `storage.ts`.
- [ ] No new npm dependencies.

## Files to Modify

- `pc2-node/src/api/storage.ts` — add helper + forward call at three
  call sites + diagnostic endpoint.

## Files to Create

- `docs/handover/ELACITY_IPFS_PIN_ENDPOINT_NGINX_PATCH.md` ✅ done
- `.cursor/tasks/ELACITY-KUBO-PIN-FORWARD/ELACITY-KUBO-PIN-FORWARD.md` ✅ (this file)

## Testing Strategy

1. **Feature-flag off**: start node with
   `ELACITY_PIN_FORWARD_URL` unset. Pin a CID. Expect zero outgoing
   HTTP to ipfs.ela.city in logs. Existing test matrix unchanged.
2. **Feature-flag on, stub server**: point `ELACITY_PIN_FORWARD_URL`
   at `http://127.0.0.1:9999` (run `nc -l 9999` in another shell).
   Pin a CID. Confirm nc receives
   `POST /api/v0/pin/add?arg=<cid>&recursive=true HTTP/1.1` with
   `Authorization: Bearer <token>` header. Confirm PC2's pin
   response returns normally and is not blocked by nc hanging.
3. **Feature-flag on, slow server**: stub that accepts connection
   but never responds. Confirm PC2 pin response returns within 100
   ms; confirm diagnostic endpoint shows
   `lastStatus: 'error', lastError: <timeout>` after 30 s.
4. **Feature-flag on, live ipfs.ela.city (post ops-deploy)**: pin a
   small known-good CID. Confirm `lastStatus: 200`. Confirm
   `/api/v0/pin/ls?arg=<cid>` on ipfs.ela.city lists it.
5. **Three-call publish**: publish asset + thumbnail + metadata from
   creator UI. Confirm three separate forward calls (one per CID)
   within ~1 s of the publish completing.

## Notes

- The nginx handover document explicitly does **not** put the token
  into any config checked into git. It's generated on the box and
  referenced from nginx via a root-owned file. PC2 side reads it
  from an env var set at deploy time, same principle.
- This task unblocks the v1.2 mint → purchase → playback loop for
  all future minters. Pre-existing CIDs minted before deployment
  won't be retroactively pinned; we can add a one-shot catchup job
  later if needed (query last N mints, forward each CID).
- If the Elacity ops team prefers a different auth scheme (mTLS,
  scoped API keys, etc.) the client-side forwarder is small enough
  to retarget — only `forwardPinToElacityKubo()` needs to change.
