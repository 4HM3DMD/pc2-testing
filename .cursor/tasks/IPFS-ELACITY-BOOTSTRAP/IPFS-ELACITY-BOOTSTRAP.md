# Task: Bootstrap PC2 IPFS Node to Elacity Gateway

**Task ID**: IPFS-ELACITY-BOOTSTRAP
**Created**: 2026-04-17
**Last updated**: 2026-04-29
**Status**: InProgress — Phase 1 (peering + health endpoint) landed 2026-04-29; Phase 2 (multiaddr handshake confirmation) pending
**Priority**: P1-A — Highest (root-cause fix for v1.2 playback failure; ships in v1.2)
**Target Release**: V1.2.0 (re-targeted from V1.2.1 after Irzhy production trigger)
**Depends on**: Irzhy/Elacity team confirming `ipfs.ela.city`'s canonical libp2p multiaddr + PeerID — **non-blocking** for shipping (a sane hardcoded default is in place)
**Unblocks**: `UPLOAD-ELACITY-LOCAL-FIRST`
**Sibling**: [`SUPERNODE-MEDIA-PINNING`](../SUPERNODE-MEDIA-PINNING/SUPERNODE-MEDIA-PINNING.md) — covers the supernode side of the same problem

## 2026-04-29 — Phase 1 shipped

Code change set (all in commit on `feature/lit-chipotle-migration`):

- `pc2-node/src/storage/ipfs.ts`:
  - New constant `ELACITY_DEFAULT_BOOTSTRAP` — hardcoded
    `/ip4/34.77.31.164/tcp/4001/p2p/12D3KooWNieM3HRBJdVqaQucZEJdqA3oWKrKf3Gx3hp2cmtR9GNK`
    (lifted from the previous `PUBLIC_BOOTSTRAP_NODES` Elacity entry to
    become the single source of truth).
  - New `IPFSOptions.elacityBootstrap?: string[]` — operator override.
    Empty array explicitly disables Elacity peering; `undefined` falls
    through to the default constant.
  - `resolveElacityPeers()` validates each entry via `multiaddr()`,
    extracts the `/p2p/<peerId>` segment via regex (version-agnostic),
    and drops malformed entries with a warning rather than blocking
    startup.
  - Effective Elacity peers are merged into the bootstrap list at
    priority `supernodes → elacity → custom → public` and tracked in
    `configuredElacityPeers` / `configuredElacityPeerIds`.
  - The existing post-init dial loop and the 30 s `bootstrapHealthTimer`
    auto-include Elacity peers, so reconnect-on-disconnect already
    works without new timers.
  - New public method `getElacityPeerStatus()` walks current libp2p
    connections, matches against `configuredElacityPeerIds`, and
    returns `{ peered, configuredPeerIds, configuredMultiaddrs,
    matchedPeerIds }`.
- `pc2-node/src/index.ts`: passes `elacityBootstrap` from
  `process.env.ELACITY_IPFS_MULTIADDRS` (comma-separated) or
  `config.ipfs.elacity_bootstrap` (array). Env wins; absent both ⇒
  default constant.
- `pc2-node/src/api/storage.ts`:
  `GET /api/storage/ipfs/peers` (auth + owner-guarded) returns
  `{ connectedPeers, peerList, elacity: { peered, configuredPeerIds,
  configuredMultiaddrs, matchedPeerIds } }`.

Phase 1 keeps the original health-endpoint location proposal (`/api/
node/ipfs/peers`) deferred — landing under `/api/storage/ipfs/peers`
mirrors the existing `/api/storage/ipfs/network` route, requires zero
new auth wiring, and is the pragmatic location given storage.ts is
already where IPFS diagnostics live. Endpoint name can be aliased
later if `node` namespace becomes the convention.

### What Phase 1 does NOT include

- Operator-confirmed canonical Elacity multiaddr — still on the
  hardcoded `34.77.31.164` entry. If Irzhy/Elacity team supplies a
  newer multiaddr (e.g. `/dns4/ipfs.ela.city/...`), operators can drop
  it into `ELACITY_IPFS_MULTIADDRS` without any code change.
- Runtime PeerID fetch from `https://ipfs.ela.city/api/v0/id`. Parked
  for Phase 2; env-var override is the safer first move.
- Public (non-owner) read of peer count. Locked to `requireOwner` for
  v1.2 to avoid leaking peer-list info to unauthenticated callers.

## 2026-04-28 production trigger

This task's symptom finally hit a real user. Irzhy reported:

- Bought a marketplace asset minted from another PC2 node
  (`bafybeiflfrufuucgbeztwducthonjs7zjz2dsdpk4ajkgxodnkoiru7c3y`).
- Download succeeded (confirmed metadata reached his node).
- Playback failed at "Resolving content and recovering decryption
  key…" with the player error `"fetch failed"`.

Live diagnosis in
[`docs/core/SUPERNODE_CAPABILITY_ASSESSMENT.md`](../../../docs/core/SUPERNODE_CAPABILITY_ASSESSMENT.md)
§4 confirmed:

- His local IPFS gateway returned non-OK for the DASH stream
  sub-path because his Helia only had the metadata, not the bytes.
- `https://ipfs.ela.city/ipfs/<cid>/stream.mpd` timed out at 15 s+ —
  Elacity's Kubo could not resolve the CID via DHT in any reasonable
  time.
- A known-good CID resolved on `ipfs.ela.city` instantly, ruling out a
  gateway outage.

Net: Elacity's Kubo and the publisher's Helia have no peering, so
DHT discovery fails. This task is the structural fix.

## Description

PC2's local Helia node is not peered with Elacity's IPFS gateway. When
we publish content locally and Elacity's indexer is the reader (or
vice versa), the DHT walk between the two often times out, and
callers fall back to the slow HTTP gateway path.

This task adds Elacity's public IPFS multiaddr(s) to PC2's bootstrap
list *and* performs an explicit post-start swarm-connect so the peering
is immediate rather than "best effort via DHT discovery."

## Background

- Elacity's gateway lives at `ipfs.ela.city` (HTTP) and runs a
  go-ipfs node. Its libp2p multiaddrs are stable; we just haven't
  hard-coded them into PC2's bootstrap.
- PC2's Helia setup already supports custom bootstrap nodes via
  `IPFSNode.options.customBootstrap` — see
  `pc2-node/src/storage/ipfs.ts` L71-L76 and L217-L235.
- `PUBLIC_BOOTSTRAP_NODES` (ipfs.ts L61) ships libp2p defaults only;
  Elacity's node is not in that list.
- Bootstrap-at-start gives us peer *addresses*, but doesn't guarantee
  a connection. We also need an explicit post-ready
  `libp2p.dial(multiaddr)` call to `ipfs.ela.city`'s node — the same
  pattern go-ipfs users achieve with `ipfs swarm connect`.

## Why this matters for V1.2

1. **UX**: fewer publish-flow stalls caused by Elacity not seeing our
   content via DHT. Not every stall has the same cause, but
   missing-peer is a common one.
2. **Architecture direction**: enables `UPLOAD-ELACITY-LOCAL-FIRST`.
   The whole "PC2 writes locally, Elacity pulls from protocol"
   pattern relies on a reliable peer link between the two nodes.
3. **Debuggability**: adds a clear, single "are we peered with
   Elacity?" health check to surface the link going down in future.

## Requirements

- [ ] PC2 starts with Elacity's IPFS node in the bootstrap list.
- [ ] After libp2p starts, PC2 explicitly dials Elacity's multiaddr
      once; failures are logged at `warn` and retried with backoff,
      never block node startup.
- [ ] New health probe `/api/node/ipfs/peers` returns the peer count
      and includes a boolean `elacityPeered: boolean`.
- [ ] Config surface via `.env`:
  - `ELACITY_IPFS_MULTIADDRS=/ip4/…,/dns4/…` (comma-separated,
    overridable).
  - Default to the canonical Elacity multiaddrs — to be confirmed with
    the Elacity team member ("please share your node's PeerID +
    public multiaddr"). Until then, use the known `ipfs.ela.city` DNS
    multiaddr with the PeerID we pull from their `/api/v0/id`.

## Implementation Plan

- [ ] **Confirm Elacity multiaddrs** with the team member. Target:
      at least one `/dns4/ipfs.ela.city/tcp/4001/p2p/<PeerID>` and
      a backup `/ip4/<ip>/tcp/4001/p2p/<PeerID>`.
- [ ] **Add a constant** in `pc2-node/src/storage/ipfs.ts`:
      `ELACITY_BOOTSTRAP` string array, merged into `customBootstrap`
      when `ELACITY_IPFS_MULTIADDRS` is not overridden.
- [ ] **Post-ready dial**: after `node.libp2p.start()`, call
      `node.libp2p.dial(multiaddr(addr))` for each Elacity multiaddr.
      Wrap in `withRetry({ attempts: 3, initialDelayMs: 2000 })` and
      emit log lines:
      - `[IPFS] Connected to Elacity peer <peerId> (<ms> ms)`
      - `[IPFS] Could not connect to Elacity peer <peerId> after N
        attempts — will retry via DHT`.
- [ ] **Background reconnect**: every 5 minutes, if we're not peered
      with Elacity's PeerID, try `dial` again. Single timer, cleared
      on node shutdown.
- [ ] **Health endpoint**:
      `GET /api/node/ipfs/peers` → `{ count, elacityPeered, peers:
      [{ peerId, addr, direction }] }`. Owner-guarded is **not**
      required; expose count only to non-owner, full list to owner.
- [ ] **Docs**: add a "Peering" subsection to
      `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` Section 6.
- [ ] **Test with the `UPLOAD-ELACITY-LOCAL-FIRST` follow-up**:
      publish a small asset locally, verify Elacity's gateway resolves
      the CID within ≤ 30 s without the legacy HTTP upload path.

## Acceptance Criteria

- [ ] `curl http://localhost:3000/api/node/ipfs/peers` on a freshly
      started node shows `elacityPeered: true` within 10 s of startup
      (network permitting).
- [ ] Publishing a 10 KB text file to local IPFS only, then curling
      `https://ipfs.ela.city/ipfs/<cid>`, returns 200 within 30 s. No
      use of the legacy `/upload-elacity` HTTP path required.
- [ ] Simulating Elacity-node-down (block outbound 4001) logs the
      warnings but does not crash; reconnect loop resumes when
      connectivity is restored.
- [ ] No change to existing clients; default behaviour when env var
      is unset matches the current repo default.

## Files to Modify

- `pc2-node/src/storage/ipfs.ts` — add Elacity bootstrap constant,
  post-ready dial, background reconnect, peer introspection helper.
- `pc2-node/src/api/supernode.ts` or `pc2-node/src/api/info.ts` —
  add `GET /api/node/ipfs/peers`.
- `pc2-node/.env.example` — new `ELACITY_IPFS_MULTIADDRS` var with
  docs comment.
- `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` — peering
  subsection.

## Files to Create

- None.

## Testing Strategy

1. Cold start on laptop with normal network → expect peered within
   10 s.
2. Block 4001 outbound via `pfctl` (macOS) → node starts, warn logs
   appear, no crash.
3. Restore connectivity → reconnect loop peers within ≤ 5 min.
4. Round-trip content test described in acceptance criteria #2.

## Notes

- **Coordination needed**: ping the Elacity team member for their
  canonical `/dns4/ipfs.ela.city/…/p2p/<PeerID>` multiaddr. We can
  pull the PeerID ourselves from `https://ipfs.ela.city/api/v0/id`
  as a temporary fallback, but having them supply the authoritative
  multiaddr is cleaner and unblocks us immediately.
- This task is the prerequisite for flipping `UPLOAD-ELACITY-
  LOCAL-FIRST` off its "parked" state. Once the link is reliable,
  that task's fire-and-forget replication lands without UX risk.
- Source of feedback: V1.2 pre-release team call 2026-04-17.
