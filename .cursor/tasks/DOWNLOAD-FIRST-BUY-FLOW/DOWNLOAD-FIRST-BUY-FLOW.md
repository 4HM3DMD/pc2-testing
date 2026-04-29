# Task: Download-First Buy Flow (v1.2-pre-release)

**Task ID**: DOWNLOAD-FIRST-BUY-FLOW
**Created**: 2026-04-29
**Status**: Review
**Priority**: High
**Branch**: `release/v1.2-pre-release`

## Description

Replace the v1.2 "fire-and-forget pin + fake progress timer + immediate
.ddrm write" buy flow with one that actually waits for the pin to land
on the local node before claiming the asset is "downloaded", and gate
the file-open launcher so no `.ddrm` opens a runtime until the
underlying CID is fully pinned.

## Background

During afternoon diagnosis on 2026-04-29 (see
[IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md](../../docs/handover/IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md) §"Afternoon 2 Update") MTK surfaced the
architectural gap between the v1.2 UX and its technical reality:

- `elacity-market/app.js` `pinAndRegisterMedia` (pre-rewrite) posted to
  `/api/storage/ipfs/pin`, got back `{queued: true}` in milliseconds,
  then immediately wrote a 1 KB `.ddrm` pointer file and told the user
  "Downloaded & saved — you're now a seeder!"
- The progress bar at lines 3731-3737 was a cosmetic `setInterval` that
  crept 10 % → 90 % regardless of actual pin state.
- In reality the media blocks were still downloading in the background.
  Playback fell through to `ipfs.ela.city` for anything not yet in local
  Helia — that's the stuttering at 0:19 / 0:21 MTK reported.
- The launcher (`open_item.js`) didn't check pin state at all before
  handing off to the player / viewer.

The fix is a download-first flow that's honest about state at every
step — and, critically, a single launch gate that covers both media
and non-media `.ddrm` capsules from one code point.

## Requirements

1. **Server exposes real pin state** — client can poll per-CID for
   `queued`/`pinning`/`complete`/`failed` and retry a failed pin.
2. **Buy flow waits for `complete`** before declaring success.
3. **User's folder shows the state honestly** — a `(Preparing)`
   placeholder while downloading, the clean name only when the pin is
   complete.
4. **No fake progress %** — Helia does not expose block-level pin
   progress cleanly. Use elapsed time + expected size instead.
5. **Launch gate** — double-clicking any `.ddrm` with
   `pinStatus !== 'complete'` shows a preparing overlay, polls status,
   offers Retry on failure, and does not launch the runtime until the
   CID is actually pinned.
6. **Legacy compat** — existing `.ddrm` files (no `pinStatus` field)
   continue to open exactly as before. No forced migration.
7. **Graceful degradation** — if the pin-status API is unreachable
   (node restarting, offline), the launcher falls through to today's
   streaming playback. A user is never stranded on an un-dismissable
   modal.
8. **Retry rate-limit** — server-side 30 s per-CID debounce on
   `/pin/:cid/retry` (returns 429 + `retryAfterMs`); client-side
   mirror with a matching 30 s window.
9. **Gap recovery** — incomplete pins re-queue on node startup
   (`ContentSeedingService.runGapRecovery`), surfacing a status
   breakdown in the log so an operator can tell at a glance what got
   cleaned up.

## Implementation Plan

### Phase 0: branch + handover + discard build artifacts

- [x] Discard stray working-tree diffs on `pc2-node/frontend/bundle.min.js`
      and `pc2-node/frontend/puter.js/v2` (build artifacts, regenerated
      in Phase 4).
- [x] Add "Afternoon 2 Update" to
      [`IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md`](../../docs/handover/IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md)
      documenting the installed-apps gotcha, honest P2P framing, and
      this task's scope.
- [x] Bump `pc2-media-runtime/index.html` cache-buster to
      `player.js?v=6-pipelined`.
- [x] Commit to `feature/lit-chipotle-migration` (`a810fc73`).

### Phase 1: release branch

- [x] Create `release/v1.2-pre-release` off `feature/lit-chipotle-migration`.
- [x] Push to origin.

### Phase 2: server endpoints (`b748d33d`)

- [x] `DatabaseManager.getPinnedCIDDetail(cid)` — single-row lookup
      keyed by CID (most-recent row across wallets; pin state is a
      property of the CID on this node, not a specific purchase).
- [x] `GET /api/storage/ipfs/pin-status/:cid` — returns
      `{status, sizeBytes, source, pinnedAt}` or
      `{status:'not-pinned'}` if unknown. No fake mid-download `pinnedBytes`.
- [x] `POST /api/storage/ipfs/pin/:cid/retry` — re-queues a failed pin
      via `seedingService.seedContent`. 30 s per-CID debounce returning
      429 + `retryAfterMs`. 200 with `already_complete` if the CID is
      already good.
- [x] `ContentSeedingService.runGapRecovery` logs a status breakdown
      (`{queued:1,failed:2}` etc).

### Phase 3: client (`ef07ad37`)

- [x] Rewrite `pinAndRegisterMedia` in
      [`pc2-node/data/test-apps/elacity-market/app.js`](../../pc2-node/data/test-apps/elacity-market/app.js):
  - Write `<title> (Preparing).ddrm` with
    `pinStatus='downloading'`, `estimatedSizeBytes`,
    `downloadStartedAt`.
  - POST `/ipfs/pin` with `{cid, estimatedSize, buyerWallets}` (the
    legacy code was not sending `estimatedSize`, so the server could
    not size its adaptive timeout).
  - Poll `/pin-status/:cid` every 2 s. Show elapsed time + `~X expected`.
  - After 120 s of pinning, offer "Continue in background".
  - On `complete`: write final `<title>.ddrm` with
    `pinStatus='complete'` + `pinnedSizeBytes`, delete placeholder.
  - On `failed`: Retry link wired to `/pin/:cid/retry` with 30 s debounce.
  - Disk-quota errors get a specific message.
- [x] Add `ddrmLaunchGate(descriptor)` + `showDdrmGateOverlay(...)` to
      [`src/gui/src/helpers/open_item.js`](../../src/gui/src/helpers/open_item.js).
  - Single gate covers BOTH media (`pc2-media-runtime`) and non-media
    (`ddrm-viewer`) dispatch branches.
  - Fast paths: `pinStatus === undefined` (legacy) → proceed;
    `pinStatus === 'complete'` (trusted post-pin write) → proceed.
  - Server unreachable → proceed (graceful degradation).
  - Otherwise: overlay with live poll + Cancel + Retry (on `failed`).

### Phase 4: build + sync (`cac1e6d5`)

- [x] Rebuild GUI bundle via `pc2-node/scripts/build-frontend.js` so
      `bundle.min.js` ships the launch gate.
- [x] Create `pc2-node/scripts/sync-installed-apps.sh` — idempotent
      rsync from `data/test-apps/<app>/` → `data/installed-apps/<app>/`
      for `elacity-market` and `pc2-media-runtime`. Dry-run by default;
      `--apply` to copy. Fixes the dual-folder gotcha documented in the
      handover.
- [x] Run the script in `--apply` mode to sync local installed-apps.

### Phase 5: smoke checks

- [x] TypeScript type-check (`tsc --noEmit`) — 0 errors.
- [x] JS syntax check on both `test-apps/elacity-market/app.js` and
      the synced `installed-apps/elacity-market/app.js`.
- [x] Bundle content check: `pin-status`, `Preparing your content`,
      `pin-status unreachable`, and the retry URL all present.
- [x] Code-inspection coverage of 6 runtime scenarios (see Acceptance
      Criteria below).
- [x] Push 3 feature commits to `origin/release/v1.2-pre-release`.
- [ ] **Live end-to-end smoke by MTK** (owner: user; cannot run in this
      session without a live pc2-node + test CID + wallet).

### Phase 6: docs

- [x] Roadmap update in
      [`docs/core/V1.2_ADOPTION_ROADMAP.md`](../../docs/core/V1.2_ADOPTION_ROADMAP.md)
      — new P6 line in "Pre-v1.2 wave summary" + one-line framing.
- [x] This task document.
- [ ] Release-notes blurb (see "For v1.2 Release Notes" below) to be
      pulled into whatever the founder uses for the v1.2.0 tag.

## Acceptance Criteria

Each of these is a runtime scenario the code must handle correctly.
Static coverage has been verified; live verification is MTK's.

1. **Happy path, media**
   - Buy an NFT with a cleartext media CID.
   - Observe `<title> (Preparing).ddrm` in Videos/ within ~1 s.
   - Modal shows "Downloading to your node... Xs elapsed (~Ymb expected)".
   - On `complete`, `(Preparing)` placeholder is deleted, final
     `<title>.ddrm` appears, modal shows "Downloaded (size) — you own
     this offline."
   - Double-click the final file → player launches immediately (fast path).

2. **Happy path, non-media**
   - Buy an encrypted PDF / image.
   - Same flow as #1 but file lands in Documents/ or Pictures/ via the
     existing `isNonMediaAsset` + mime switch. Launch gate returns
     true for `pinStatus === 'complete'`, `ddrm-viewer` opens.

3. **Slow / very large file**
   - After 120 s in `pinning` state, "Continue in background" link
     appears next to the status text.
   - Clicking it dismisses polling; the user can close the buy modal.
   - Re-opening the `(Preparing).ddrm` file replays the gate overlay,
     which polls live status and finalizes when the pin lands.

4. **Failure**
   - Server returns `pin_status='failed'` (simulate by killing Helia /
     firewall-blocking `ipfs.ela.city` during pin).
   - Buy modal shows "Download failed: … Retry".
   - First retry works; rapid second retry hits the client debounce
     and shows "Please wait Xs before retrying.".
   - Server-side retry within 30 s returns 429 + `retryAfterMs` and
     the UI surfaces that.

5. **Node restart mid-download**
   - Kill pc2-node while `pin_status='pinning'`.
   - Restart: `[Seeding] Gap recovery: found 1 incomplete pin(s)
     ({pinning:1}), re-queuing at background priority` in logs.
   - Re-open the `(Preparing).ddrm` — gate overlay shows current
     status, progresses to `complete` without user action.

6. **Legacy `.ddrm`**
   - Open an older `.ddrm` file that predates this task (no
     `pinStatus` field). Gate returns true immediately; player / viewer
     opens with existing behaviour. No network roundtrip for the gate.

## Files Modified

- `pc2-node/src/storage/database.ts` — `getPinnedCIDDetail(cid)`.
- `pc2-node/src/api/storage.ts` — new `GET /ipfs/pin-status/:cid`, `POST /ipfs/pin/:cid/retry`.
- `pc2-node/src/services/ContentSeedingService.ts` — gap-recovery log breakdown.
- `pc2-node/data/test-apps/elacity-market/app.js` — `pinAndRegisterMedia` rewritten download-first.
- `src/gui/src/helpers/open_item.js` — `ddrmLaunchGate` + `showDdrmGateOverlay`, single-point gate for both asset types.
- `pc2-node/frontend/bundle.min.js`, `pc2-node/frontend/puter.js/v2` — rebuilt bundle.
- `pc2-node/data/test-apps/pc2-media-runtime/index.html` — player cache-buster bump (Phase 0).
- `docs/handover/IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md` — Afternoon 2 section.
- `docs/core/V1.2_ADOPTION_ROADMAP.md` — P6 line item.

## Files Created

- `pc2-node/scripts/sync-installed-apps.sh` — test-apps → installed-apps rsync tool.
- `.cursor/tasks/DOWNLOAD-FIRST-BUY-FLOW/DOWNLOAD-FIRST-BUY-FLOW.md` — this document.

## Testing Strategy

- Static: tsc, node --check, bundle string grep (done, see Phase 5).
- Live: six-scenario matrix above, run by user on their pc2-node with
  the v1.2 test CIDs (Irzhy's `bafybeid2zki2ky…` is large enough to
  exercise the 120 s "Continue in background" path).

## Notes / Risks / Flags

- **Not a bug: `ipfs.ela.city` as hot path today.** The P2P seeding
  code path (announce + DHT lookup) is wired; what's weak is the
  propagation layer across Helia↔Kubo. Release-note framing agreed
  with MTK: "Elacity IPFS as a supporting hub today, supernode Tier-2
  next, full P2P on the roadmap." Exterior reviewers tracing traffic
  during a demo will see `ipfs.ela.city` answering 80-90 % of fetches,
  which is consistent with this framing.
- **v1.2 schema not bumped.** The new descriptor fields
  (`pinStatus`, `estimatedSizeBytes`, `pinnedSizeBytes`,
  `downloadStartedAt`) are additive to the existing v2 schema. Legacy
  readers ignore them; legacy writers don't set them and the launch
  gate fast-paths on their absence. A v3 schema bump can come later
  when the format is otherwise evolving.
- **`saveDdrmCapsule` not touched.** The manual "save to folder" code
  path (library view) is not on the buy flow. Files written there get
  no `pinStatus` field and go through the legacy fast path on open.
  Intentional: those assets are explicitly already-owned.
- **src/gui package.json stale build script.** `"build"` points at
  `pc2-node/test-fresh-install/scripts/build-frontend.js` which no
  longer exists. Actual script lives at
  `pc2-node/scripts/build-frontend.js`. Out of scope here; fix with a
  one-line edit whenever someone next touches the frontend build.

## For v1.2 Release Notes

Paste-ready blurb:

> **Download-first buy flow.** When you buy an asset, your PC2 node
> now actually downloads and pins it before claiming "Downloaded." You
> see honest progress — elapsed time and expected size — and a
> "(Preparing)" placeholder appears in your folder immediately so
> you're not wondering if the transaction worked. Large downloads can
> continue in the background; opening the file later resumes the
> status display. The launcher won't hand you off to the player until
> the content is fully local.
>
> Elacity IPFS continues to act as the supporting hub that guarantees
> content is always reachable; supernode Tier-2 mirrors and direct
> PC2↔PC2 peer discovery are the next steps on the decentralization
> roadmap.
