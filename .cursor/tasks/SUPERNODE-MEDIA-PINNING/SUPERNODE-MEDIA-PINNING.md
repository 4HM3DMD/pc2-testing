# Task: Auto-pin marketplace-minted CIDs to supernode Kubo daemons

**Task ID**: SUPERNODE-MEDIA-PINNING
**Created**: 2026-04-29
**Status**: Proposed
**Priority**: High — direct unblock for inter-user playback
**Target Release**: V1.2.1 (post-v1.2.0 fast-follow)
**Depends on**: —
**Blocked by**: —
**Sibling tasks**:
- [`IPFS-ELACITY-BOOTSTRAP`](../IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md) — peers PC2 nodes with `ipfs.ela.city`
- [`UPLOAD-ELACITY-LOCAL-FIRST`](../UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md) — resilient publish flow
- [`SUPERNODE-RPC-PROXY`](../SUPERNODE-RPC-PROXY/SUPERNODE-RPC-PROXY.md) — same supernode-as-shared-infra pattern

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
