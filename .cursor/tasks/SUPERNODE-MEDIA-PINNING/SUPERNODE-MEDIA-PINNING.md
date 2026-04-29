# Task: Auto-pin marketplace-minted CIDs to supernode Kubo daemons

**Task ID**: SUPERNODE-MEDIA-PINNING
**Created**: 2026-04-29
**Last updated**: 2026-04-29
**Status**: InProgress — client-side landed (2026-04-29); supernode-side blocked on SSH/deploy
**Priority**: High — direct unblock for inter-user playback
**Target Release**: V1.2.0 (client side ships in v1.2); supernode side follows when deploy access restored
**Depends on**: —
**Blocked by**: SSH access to InterServer + Contabo to deploy `POST /api/storage/ipfs/pin` handler on `pc2-web-gateway`
**Sibling tasks**:
- [`IPFS-ELACITY-BOOTSTRAP`](../IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md) — peers PC2 nodes with `ipfs.ela.city`
- [`UPLOAD-ELACITY-LOCAL-FIRST`](../UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md) — resilient publish flow
- [`SUPERNODE-RPC-PROXY`](../SUPERNODE-RPC-PROXY/SUPERNODE-RPC-PROXY.md) — same supernode-as-shared-infra pattern

## 2026-04-29 — Client-side Phase 1 shipped (scope-trimmed)

### Discovery that reshaped the task

On starting implementation it emerged that **most of the originally-scoped
client code already exists**:

- `POST /api/storage/ipfs/pin` is a live route in
  `pc2-node/src/api/storage.ts` L672 — uses `seedingService.seedContent()`
  or falls back to `ipfs.pinRemoteCID()`, with DB tracking via
  `pinned_cids` and DHT announcement.
- `pinned_cids` (schema.sql L186) already covers everything a separate
  `marketplace_pins` table was meant to hold: `cid`, `wallet_address`,
  `source` (default `'marketplace'`), `size`, `pinned_at`,
  `last_announced_at`, `last_served_at`, `serve_count`, `pin_status`.
- `elacity-creator/app.js` L3849/L3861 and `elacity-market/app.js`
  L3742 already call `POST /api/storage/ipfs/pin` after every
  successful mint/buy.

So the *genuinely missing* client-side piece was just the
**supernode pin fan-out** — replicating the CID to the supernode
pin endpoints once they come online.

### What shipped (v1.2.0)

Config-gated mirror fan-out, default OFF so user nodes have zero
behaviour change until an operator opts in:

1. **Env var**: `SUPERNODE_PIN_MIRRORS=https://host1/api/storage/ipfs/pin,https://host2/...`
   (comma-separated). Default unset = no fan-out.
2. **Fan-out helper** in `pc2-node/src/api/storage.ts`:
   `fanOutSupernodePinMirrors(cid)`. Called after successful local
   pin in both the seeding-service branch (line ~712) and the direct
   `pinRemoteCID` branch (line ~743). Fire-and-forget, 5 s timeout,
   never awaited — zero impact on /pin response latency.
3. **Probe state**: module-scoped `mirrorProbeState: Map<url, result>`
   tracks last CID, HTTP status, duration, error, and timestamp per
   mirror for operator observability.
4. **New diagnostic endpoint**:
   `GET /api/storage/ipfs/pin-mirrors` (auth + owner). Returns
   `{ enabled, configured, lastProbes }`. Mirrors never seen return
   `null` probe entries.

### What shipped (v1.2.0) does NOT include

Cut from the original MVP because they only make sense on the supernode
side, where we can't deploy this session:

- `POST /api/storage/ipfs/pin` on supernodes calling
  `127.0.0.1:5101/api/v0/pin/add?arg=<cid>&recursive=true`.
- LRU eviction of the oldest unprotected pin at 90 % of `StorageMax=8G`.
- Capsule-pin `protected=true` flag.
- DID-signed rate-limited auth.
- `/api/health` fields `kuboReachable`, `marketplacePinsCount`,
  `kuboStorageBytes`.
- Direct-dial from supernode Kubo to publisher multiaddr after pin.

These land in Phase 2 once deploy access is restored. Activation then
is a one-line env-var flip on each pc2-node; no client update needed.

### Live verification

Smoke test on maintainer's pc2-node with
`SUPERNODE_PIN_MIRRORS=https://69.164.241.210/...,https://38.242.211.112/...`:

- `POST /api/storage/ipfs/pin` `{"cid":"bafkqaaa"}` → `200 OK` in ~15 ms
  (response returned before fan-out starts).
- Fan-out fired in parallel, both mirrors responded `404` (expected —
  supernode endpoint not yet deployed): 281 ms InterServer,
  637 ms Contabo.
- `GET /api/storage/ipfs/pin-mirrors` now reports per-mirror probe
  state with status/duration/timestamp.

Confirms: (a) fan-out never blocks caller, (b) 404s from unreachable
mirrors are tolerated, (c) probe state surfaces operator diagnostics.

### Activation path when supernode side ships

1. Deploy `POST /api/storage/ipfs/pin` handler on each supernode's
   `pc2-web-gateway` per the MVP spec below.
2. Operators of user pc2-nodes set
   `SUPERNODE_PIN_MIRRORS="https://.../api/storage/ipfs/pin,..."` and
   restart. Existing released builds already ship the fan-out code.
3. Monitor `GET /api/storage/ipfs/pin-mirrors` for fan-out health.

## 2026-04-29 Afternoon — Phase 2 Deployment Plan (supernode side)

### Status update

Irzhy's playback failure from 2026-04-28 has exposed a new, more immediate
gap than originally diagnosed: `ipfs.ela.city`'s nginx had
`proxy_read_timeout 120s` on `/api/v0/pin/add`, causing large-DAG pins to
silently fail. Fix landed 2026-04-29 afternoon (see
`docs/handover/IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md`). With that in
place, **Tier A (ipfs.ela.city) now works** for new mints via
`ELACITY-KUBO-PIN-FORWARD`. This task (`SUPERNODE-MEDIA-PINNING`) adds
**Tier B** — a second durable pin location geographically separated from
GCP — making the system survive an `ipfs.ela.city` outage without user
impact.

### Why Phase 2 is deferred (not today)

During the 2026-04-29 afternoon work, we observed:

1. **Kubo pinstore serialization**: on `ipfs.ela.city` a single
   in-flight `ipfs pin add --progress` for a large DAG blocks every
   other `pin/ls`, `pin/add`, and `pin/verify` for the duration (tens
   of minutes). This likely applies to Kubo 0.24 on the supernodes too.
   Implication: a naive `/api/storage/ipfs/pin` handler that just
   forwards to `127.0.0.1:5101/api/v0/pin/add?stream-channels=false`
   will deadlock the supernode pin subsystem if a large pin is
   in-flight. Mitigation is in the handler design below.
2. **User directive**: explicit "be very careful — these are live
   supernodes, do not break anything". Needs a staged rollout with
   pre-flight checks and one-shot rollback.
3. **Current Kubo on `ipfs.ela.city` is itself mid-storm** (a pin
   add is blocking pin/ls right now). Safer to let that settle before
   we start touching the supernodes.

### Phase 2 deployment plan (one supernode at a time)

All steps are explicitly user-gated. No supernode is touched without
"approved" on the previous step.

#### Step 1 — Ship handler artefact in the repo (safe, no deploy)

Create `deploy/web-gateway/handlers/ipfs-pin.js` — a standalone handler
module that:

- Exposes a single function `handleIpfsPin(req, res, deps)` consumable
  by the existing `pc2-web-gateway` routing layer.
- Validates body shape (`{ cid: string, source?: string, ... }`) and
  rejects non-CIDv0/v1 inputs in ~ms.
- **Async dispatch (critical)**: instead of forwarding `pin/add`
  synchronously (which blocks on DAG fetch and starves other pin ops),
  this handler:
    1. Does a quick `block/stat` probe — returns `202 AlreadyPresent`
       in ms if Kubo already has the root.
    2. Returns `202 Accepted` with a `{ jobId, status: "queued" }`
       body, queues the pin in a small in-process job runner
       (max 2 concurrent pin/add calls; deeper queue stored in RAM).
    3. Caller polls `GET /api/storage/ipfs/pin/<jobId>` for status.
- Rate-limited per-caller-IP with `limit_req`-style token bucket.
- Reachable only from authorised PC2-node IPs by default — Auth
  strategy: reuse the existing Wave-3 gateway lockdown mechanism
  (see `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md`).
- Health fields merged into the existing `/api/health` response:
  `kuboReachable`, `marketplacePinsCount`, `kuboStorageBytes`.

**Testing before deploy**: run `pc2-web-gateway` locally with this
handler against a local Kubo, confirm behaviour via `curl`.

#### Step 2 — Dry-run on InterServer ONLY (user-gated)

1. Backup `/etc/systemd/system/pc2-web-gateway.service` (current unit).
2. `scp deploy/web-gateway/handlers/ipfs-pin.js` to the supernode.
3. Restart `pc2-web-gateway` once (systemd; not Kubo — Kubo untouched).
4. Verify:
   - `/api/health` still returns 200 (existing proxy behaviour intact).
   - `POST /api/storage/ipfs/pin { cid: <known-good CID> }` returns
     202 Accepted in <100 ms.
   - Poll shows `done` and Kubo `ipfs pin ls` confirms pin.
5. Exercise failure path: 401 without auth, 404 on bad CID shape,
   503 if we kill Kubo API briefly.
6. 24-hour soak: `journalctl -u pc2-web-gateway -f` + `pin-mirrors`
   diagnostic on my pc2-node shows steady state.

Rollback at any point: restore previous systemd unit file + restart.

#### Step 3 — Enable fan-out on a single PC2 node (user-gated)

Set `SUPERNODE_PIN_MIRRORS="https://69.164.241.210/api/storage/ipfs/pin"`
on **one** pc2-node (the maintainer's). Mint a fresh test asset. Verify:

- Fan-out fires (visible in `GET /api/storage/ipfs/pin-mirrors`).
- InterServer returns 202 + async pin completes within 60 s.
- Third-party PC2 node can fetch + play the new asset while the
  minter's node is offline.

#### Step 4 — Mirror to Contabo (user-gated)

Repeat Steps 2–3 for `38.242.211.112`. Set
`SUPERNODE_PIN_MIRRORS=...,<contabo>` on the maintainer pc2-node. Test
that all three targets (Elacity + both supernodes) receive the pin.

#### Step 5 — General rollout (user-gated)

Once steps 1–4 are stable for 24 h:

- Document the env var in `docs/setup/PC2_NODE_SETUP.md`.
- Update `START_SERVER_WITH_ELACITY_PIN.sh` (or a successor) with
  `SUPERNODE_PIN_MIRRORS` alongside `ELACITY_PIN_FORWARD_*`.
- Newer pc2-node builds ship with a sensible default for the two
  supernodes (overridable by operators who don't want to mirror).

### Risks & explicit mitigations (read before approving any step)

| Risk | Likelihood | Blast radius | Mitigation |
|---|---|---|---|
| New handler crashes `pc2-web-gateway` on supernode | Low | All proxy traffic on that supernode | Standalone handler in own module, wrapped in try/catch; health probe on startup; rollback = restore previous unit file |
| Handler deadlocks Kubo pinstore | Medium | All pin ops on that supernode | Async job runner (max 2 concurrent pin/add), `block/stat` fast-path for already-present content, caller gets 202 immediately |
| Kubo disk fills (8 GB `StorageMax`) | Medium over months | New pins rejected | Phase 2b: LRU eviction table (`marketplace_pins`) — not in this step |
| Rate limit too loose → abuse | Low | Supernode CPU | Per-IP token bucket; only authorised PC2-node IPs via gateway ACL |
| DID auth not yet implemented | High | Non-owner can pin anything | Phase 2a uses IP allow-list / shared secret; Phase 2c adds DID-signed auth once `capsule:ipfs-pin` from `elastos-runtime` is nailed down |

### What does NOT need to happen for Phase 2 MVP

Flagged so we don't over-engineer:

- **No `marketplace_pins` table yet.** Kubo's own pinstore is the
  source of truth. We add the table when we ship LRU eviction (Phase 2b).
- **No DID-signed auth yet.** Start with IP allow-list + shared token
  (same pattern as Elacity Kubo bearer). Migrate to DID when
  `elastos-runtime` capsule lands.
- **No direct-dial to publisher multiaddr yet.** Rely on
  `IPFS-ELACITY-BOOTSTRAP` + standard DHT discovery. Add direct-dial if
  we see Phase 2 pins timing out on block fetch.

---

## Description

When a user mints media on the Elacity marketplace, automatically pin
the content CID to both supernode Kubo daemons (InterServer:4101,
Contabo:4101) in addition to the publisher's local Helia node. This
guarantees marketplace media is fetchable from at least 2 always-on
public-IP nodes the moment the on-chain mint settles, regardless of
whether the publisher's PC2 node is online or DHT-discoverable.

## Background

On 2026-04-28 Irzhy reported that an asset minted from another user's
PC2 node ("Elacity_Universal_Basic_Equity",
`bafybeiflfrufuucgbeztwducthonjs7zjz2dsdpk4ajkgxodnkoiru7c3y`) could
not play back on his node:

- His local IPFS gateway returned non-OK for `/ipfs/<cid>/stream.mpd`
  (he only had the metadata, not the DASH bytes).
- Public fallback `https://ipfs.ela.city/ipfs/<cid>/stream.mpd` timed
  out (15 s+ no response).
- Player surfaced the cryptic error `"fetch failed"`.

Live probe at the time confirmed:

- A known-good CID resolved on `ipfs.ela.city` instantly (200 OK,
  served from cache via the public Cloudflare-style CDN).
- Irzhy's specific CID timed out — Elacity's public Kubo on GCP could
  not resolve it via DHT in any reasonable time.
- The original publisher's PC2 Helia instance was the only node holding
  the blocks, and it was not directly reachable through DHT.

This is a structural gap, not a one-off bug. The current marketplace
flow already POSTs to `https://base.ela.city/api/2.0/files/upload`
(see `pc2-node/src/api/storage.ts` L2977/3061/3178), but that path is
synchronous, no-timeout, and silently fails for CIDs that don't
propagate to the public gateway. We need an additional, deterministic
path that pins minted CIDs onto infrastructure we control.

The supernode Kubo daemons already exist — they were installed by the
V1.2 A4 work (`deploy/app-registry/scripts/install-pinning.sh`,
commit `584bb035b`). They run with `routing=dhtserver`, swarm port
4101, `MemoryMax=2G`, `StorageMax=8G`. They currently pin only the 6
v1.2 capsule CIDs. This task extends them to also pin marketplace
media on demand.

## Why this matters for V1.2.1

1. **UX**: every cross-user playback today depends on a fragile DHT
   discovery + bitswap from the original publisher. With supernode
   pinning, media becomes available within a few seconds of mint and
   stays available even if the publisher's PC2 node goes offline.
2. **Sovereignty**: aligns with the supernode economics narrative —
   our own infrastructure carries the long-tail content, not third
   parties. `SUPERNODE_ECONOMICS.md` Phase 3 already lists this kind
   of pinning as a token-gated capsule role.
3. **Founders' commitment** in the 2026-04-28 conversation: "ok so its
   then a case of our elacity IPFS node needing to be pinning the
   data, i can also get the supernodes to aswell so its always
   available for all".
4. **Cheap**: no new daemon, no new ports, no architectural rewrite.
   One thin authenticated endpoint per supernode + 2 lines of glue in
   the marketplace mint flow.

## Requirements

### MVP

1. **`POST /api/storage/ipfs/pin`** on each supernode `pc2-web-gateway`:
   - Body: `{ cid: string, source?: 'marketplace-mint' | 'creator-publish' | 'manual', context?: { contractAddress?: string, tokenId?: string } }`
   - Auth: DID-signed request with the publisher's wallet (reuse the
     existing signature middleware). Rate-limited per-wallet (10
     requests / 5 min initially).
   - Server side: translates to
     `POST http://127.0.0.1:5101/api/v0/pin/add?arg=<cid>&recursive=true`
     via the local Kubo HTTP API (loopback only). Stores pin metadata
     in a new `marketplace_pins` table for retention/eviction
     bookkeeping.
   - Response: `{ pinned: true, cid: string, peerId: string, sizeBytes?: number }`
     on success, `503` if Kubo not reachable, `429` on rate limit.

2. **Call-site change** in marketplace mint flow:
   - In `pc2-node/data/test-apps/elacity-creator/app.js` (or
     wherever the post-mint hook lives — confirm during impl), after
     a successful on-chain mint, fire pin requests in parallel:
     ```js
     const pinTargets = [
       'https://69.164.241.210/api/storage/ipfs/pin',
       'https://38.242.211.112/api/storage/ipfs/pin',
     ];
     // Fire-and-forget — never block the UI on these
     ```
   - Surface the result in a new toast/log line, not a blocker.

3. **Storage policy**:
   - Each supernode pins up to `StorageMax=8G` worth of marketplace
     media. When usage > 90 %, evict pins LRU by `last_seen_request_ts`,
     keeping the most recently-fetched 80 % of capacity.
   - Eviction tracking lives in the `marketplace_pins` table; the
     existing v1.2 capsule pins are tagged `protected=true` and never
     evicted.

4. **Health surface**: extend `/api/health` to report
   `kuboReachable: bool, marketplacePinsCount: number, kuboStorageBytes: number`.
   Lets the supernode dashboard and `/api/supernodes` consumers see
   pinning capacity at a glance.

### Nice-to-have (post-MVP)

- **Direct dial**: after pinning, call `POST /api/v0/swarm/connect?arg=<publisher-multiaddr>`
  on the supernode Kubo so bitswap kicks immediately rather than
  waiting for DHT. Requires the publisher to advertise a stable
  multiaddr — same problem `IPFS-ELACITY-BOOTSTRAP` solves for the
  Elacity side.
- **Pin replication acknowledgement**: a small webhook back to the
  publisher's PC2 node (`POST /api/storage/ipfs/pin/ack`) so the user
  can see "✅ Replicated to 2 supernodes" in the Creator UI.
- **Multi-tier**: when content gets popular (request count > N), also
  pin to GCP-hosted `ipfs.ela.city` via the C1 path (coordinate with
  Irzhy). Three-layer redundancy.

## Acceptance Criteria

- [ ] `curl -X POST -H 'Content-Type: application/json' -H 'X-DID-Signature: <sig>' https://69.164.241.210/api/storage/ipfs/pin -d '{"cid":"bafyTEST"}'` returns `{ pinned: true, ... }` within 5 s for a CID already in the network, or `404 NOT_FOUND_ON_NETWORK` after a 30 s deadline if blocks cannot be located.
- [ ] Same for Contabo.
- [ ] Minting a new asset on the marketplace results in the CID appearing on both supernodes' Kubo `pin ls` within 60 s.
- [ ] Killing the publisher's PC2 node 5 minutes after mint, then opening the asset on a third PC2 node, plays back successfully — content served from supernode Kubo via bitswap.
- [ ] `marketplace_pins` LRU eviction proven via test fixture (fill > 8 GB, verify oldest unprotected pin is removed first).
- [ ] `/api/health` includes the new fields.
- [ ] No regression in the existing 6 capsule pins (they retain `protected=true` and survive eviction sweeps).

## Files to Modify

- `pc2-node/src/api/storage.ts` — new `POST /ipfs/pin` route + admin Kubo client helper.
- `pc2-node/src/storage/migrations.ts` — Migration 31: `marketplace_pins` table.
- `pc2-node/src/storage/database.ts` — `addMarketplacePin`, `evictOldestUnprotectedPin`, `listPins` helpers.
- `pc2-node/src/api/info.ts` (or wherever `/api/health` lives) — extra fields.
- `pc2-node/data/test-apps/elacity-creator/app.js` — fire pin requests after successful mint.
- `pc2-node/data/test-apps/elacity-market/app.js` — same, after secondary mints (resale flows).

## Files to Create

- `.cursor/tasks/SUPERNODE-MEDIA-PINNING/` (this directory + this doc).
- (Possibly) `pc2-node/src/services/KuboAdminClient.ts` — small typed
  wrapper around the loopback Kubo HTTP API. Optional; the existing
  `fetch()` pattern works fine if we want to keep the PR small.

## Testing Strategy

1. **Local-only**: run a local Kubo (`ipfs daemon --offline=false`)
   on port 5101, point a dev pc2-node at it, verify the new
   `/api/storage/ipfs/pin` round-trips a known CID.
2. **One-supernode dry run**: deploy to InterServer only, mint a real
   asset from a dev PC2 node, confirm pin lands within 30 s, kill the
   dev node, verify a fresh PC2 node can fetch and play back.
3. **Two-supernode end-to-end**: same as above with both supernodes,
   confirm both `pin ls` entries.
4. **Failure path**: take Kubo on one supernode offline, mint an asset,
   confirm the marketplace UI surfaces "1 of 2 supernodes pinned" but
   does not block the user.
5. **Eviction**: fill InterServer's Kubo to 7.5 GB of test pins,
   trigger eviction by adding one more 800 MB asset, confirm oldest
   unprotected pin is removed and capsule pins remain.

## Notes

### Why two supernodes, not all four

Boson Network 1 (`155.138.245.211`) and Boson Network 2
(`45.32.138.246`) currently run only the libp2p circuit-relay-v2,
not Kubo (port 4101 is closed on both — confirmed by external port
probe 2026-04-29). Bringing Kubo to those nodes is a separate
operator-side decision; once they're running it, this task's mint
hook gains two more pin targets with zero code change (just append to
the `pinTargets` array). Out of scope for this task.

### Relationship to `IPFS-ELACITY-BOOTSTRAP`

That task makes a PC2 user node directly peer with `ipfs.ela.city`'s
Kubo, which improves discoverability for content the user is currently
hosting. This task makes the supernodes themselves *hold* the content
so it's always reachable, even when the original user node is offline.
The two are complementary — ship both.

### Relationship to `UPLOAD-ELACITY-LOCAL-FIRST`

That task fixes the publish-flow latency (don't block on Elacity's
slow upload). This task adds an *additional* deterministic
pinning path so the Creator flow can rely on supernode pins regardless
of whether the legacy `base.ela.city` upload succeeded. The two are
not in conflict — `UPLOAD-ELACITY-LOCAL-FIRST` makes the Creator UX
fast; this task makes the consumer UX work.

### Relationship to `elastos-runtime` (Anders)

The `POST /api/storage/ipfs/pin` endpoint is a one-to-one analogue of
what Anders' future `capsule:ipfs-pin` will expose. Build it with the
same shape (DID-signed, capability-gated, rate-limited, observable via
metrics) so when the runtime lands, this becomes a thin shim around
the capsule rather than a rewrite. See
`docs/core/SUPERNODE_CAPABILITY_ASSESSMENT.md` §5 for the full
convergence map.

### Relationship to `SUPERNODE_ECONOMICS.md`

Phase 3 (Q2-Q3 2026) already lists "implement bandwidth metering for
revenue distribution" — the `marketplace_pins` LRU table is the
natural place to wire that up later. We track per-pin
`request_count`, `last_seen_request_ts`, `bytes_served` from the
supernode Kubo logs; revenue distribution at the SupernodeOperatorRegistry
phase reads off those.
