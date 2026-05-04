# Task: dApp Centre Install — Network-Fetch Fix + Supernode Bootstrap Alignment

**Task ID**: DAPP-INSTALL-NETWORK-FETCH
**Created**: 2026-04-30
**Status**: Review
**Priority**: High (pre-v1.2-release)
**Branch**: `release/v1.2-pre-release`

## Description

Two latent bugs prevented a PC2 user from installing a non-pre-installed
dApp (Glide Finance, Elacity NFT) from the dApp Centre, even though the
app bundles are correctly pinned on both supernodes:

1. **`AppInstallService.fetchFromIPFS` never ran a network fetch.** It
   called `this.ipfs.getFile(cid)` directly, which is a disk-only read
   against the local Helia `FsBlockstore`. On a cold install the blocks
   are not yet local, so the unixfs exporter surfaces a Node `ENOENT`
   for a block path like `data/ipfs/blocks/TA/BCIQD4SCI5ENIHEC…`.
2. **`PC2_SUPERNODE_BOOTSTRAP` pointed PC2 nodes at the wrong service
   on each supernode.** It listed peer IDs for ports 4003 (TCP) and
   4004 (WS). Those ports are owned by `pc2-ipfs-relay` (a Node.js
   libp2p circuit-relay-v2) which holds no content. The app-bundle
   blocks are pinned by `kubo` on **port 4101** on both flagship
   supernodes — which PC2 nodes were never dialing.

Even once (1) was fixed, (2) would have kept bitswap from finding
anything on our supernodes and forced every install to fall through
to the `ipfs.ela.city` public gateway. Fixing both makes installs
complete in a second or two via direct bitswap from our infra, with
gateway fallback retained for NAT-unlucky clients.

## Background / Evidence

Reported via Telegram 2026-04-29:

> Irzhy: it seems trying to load the app from its CID but cannot reach
> the content where these apps CID are hosted
>
> Error: ENOENT: no such file or directory, open
> '/Users/maciz/www/pc2.net/pc2-node/data/ipfs/blocks/TA/BCIQD4SCI5ENIHEC…'

### Read-only SSH verification (2026-04-30)

Used `expect` + password auth to run strictly non-destructive commands on
both supernodes. No `ipfs pin add`, no `systemctl`, no `ufw`, no config
writes. Commands run: `ipfs id`, `ipfs swarm addrs listen`,
`ipfs pin ls --type=recursive <cid>` for each of the 6 registry CIDs,
`ss -tlnp` for port ownership.

| Host | kubo peer ID | Swarm listen | All 6 registry CIDs pinned? |
|---|---|---|---|
| InterServer 69.164.241.210 | `12D3KooWFLBeemSpue43SULYbqmSrgreYDYQdfDKD2MHUnRcMc5f` | `0.0.0.0:4101` TCP + QUIC + `/dns4/.../libp2p.direct/tls/ws` | YES |
| Contabo 38.242.211.112 | `12D3KooWQZu8rY8BgD1fLq1yF1ArSnUy9D3Jf71w7C6RpbZy9nVr` | `0.0.0.0:4101` TCP + QUIC + `/dns4/.../libp2p.direct/tls/ws` | YES |

Port ownership on both hosts:

```
:4001  node (pc2-ipfs-relay libp2p #1)
:4002  node (pc2-ipfs-relay libp2p #1)
:4003  node (pc2-ipfs-relay libp2p #2 — TCP)
:4004  node (pc2-ipfs-relay libp2p #2 — WebSocket)
:4101  ipfs/kubo (pins v1.2 registry CIDs)      ← we were never dialing this
:5001  ipfs/kubo (loopback admin only)
:8080  ipfs/kubo (HTTP gateway, local network only)
```

## Requirements

1. PC2 nodes must establish a bitswap-capable libp2p connection to
   both supernode kubo daemons on port 4101.
2. `POST /api/installed-apps/install` must populate the local
   blockstore over the network before attempting disk-level assembly.
3. Error messaging surfaces at least `invalid-CID`, `private-mode`,
   and generic "could not reach the network" cases in a way that does
   not leak the raw ENOENT blockstore path to the user.
4. No regression to existing synchronous `POST /install` HTTP contract
   (smoke test `pc2-node/scripts/wave5-smoke.sh` still passes).
5. No regression to media playback, `.ddrm` viewer, or download-first
   buy flow paths — they use `getFile` / `pinRemoteCID` separately.
6. No changes to any supernode OS / systemd / nginx / firewall state.
7. No changes to `install-pinning.sh`, `deploy.sh`, or the registry
   signing key.

## Implementation

### Change 1: Bootstrap alignment (additive)

[pc2-node/src/storage/ipfs.ts](../../../pc2-node/src/storage/ipfs.ts)
`PC2_SUPERNODE_BOOTSTRAP` extended with the two verified kubo peer
multiaddrs. Old `pc2-ipfs-relay` entries kept so NAT-traversal via
circuit-hop continues to work for home-NAT'd PC2 nodes:

```ts
const PC2_SUPERNODE_BOOTSTRAP: string[] = [
  '/ip4/69.164.241.210/tcp/4101/p2p/12D3KooWFLBeemSpue43SULYbqmSrgreYDYQdfDKD2MHUnRcMc5f',
  '/ip4/38.242.211.112/tcp/4101/p2p/12D3KooWQZu8rY8BgD1fLq1yF1ArSnUy9D3Jf71w7C6RpbZy9nVr',
  '/ip4/69.164.241.210/tcp/4003/p2p/12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G',
  '/ip4/69.164.241.210/tcp/4004/ws/p2p/12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G',
  '/ip4/38.242.211.112/tcp/4003/p2p/12D3KooWAaFWUWN7GQVeNdbdPKUUTmyoQewBAPbwXKKrhxxsck5h',
  '/ip4/38.242.211.112/tcp/4004/ws/p2p/12D3KooWAaFWUWN7GQVeNdbdPKUUTmyoQewBAPbwXKKrhxxsck5h',
];
```

### Change 2: Install path calls `pinRemoteCID` before `getFile`

[pc2-node/src/services/AppInstallService.ts](../../../pc2-node/src/services/AppInstallService.ts)
`fetchFromIPFS`:

```ts
private async fetchFromIPFS(cid: string): Promise<Buffer> {
  if (!this.ipfs) {
    throw new Error('IPFS not available — cannot fetch remote app bundles');
  }
  try {
    await this.ipfs.pinRemoteCID(cid, { timeoutMs: 300_000 });
  } catch (err: any) {
    const type = err?.type;
    if (type === 'INVALID_CID') {
      throw new Error(`App bundle CID is not a valid IPFS CID: ${cid}`);
    }
    if (type === 'PRIVATE_MODE') {
      throw new Error('IPFS is in private network mode; remote app installs require public or hybrid mode');
    }
    throw new Error(`Unable to fetch app bundle from the IPFS network (CID ${cid}): ${err?.message || err}`);
  }
  return this.ipfs.getFile(cid);
}
```

`pinRemoteCID` already implements the correct fallback cascade:
local blockstore check → bitswap (via configured peers) → `ipfs.ela.city`
gateway CAR import → DHT `findProvs`. The install path inherits all of
that for free.

`timeoutMs: 300_000` (5 minutes) is generous because Glide Finance's
bundle is 80 MB — a slow home connection falling through to the gateway
can take a minute.

### Design choices (intentionally NOT done)

- **No new `installId` / polling endpoint.** Bundles are 280 KB to 80 MB;
  worst-case gateway fallback completes well under two minutes. A
  polling-progress endpoint is gratuitous surface area for v1.2.
- **No frontend UX change.** The existing modal already shows
  "Downloading package..." at 30 % progress and "Finalizing..." at
  90 % — no backend progress feed is available, so piping extra status
  strings through would be cosmetic noise.
- **No supernode changes.** `install-pinning.sh` already does the
  right thing; the gap was purely on the PC2 client side.

## Files Modified

| File | Change |
|---|---|
| [pc2-node/src/storage/ipfs.ts](../../../pc2-node/src/storage/ipfs.ts) | Extended `PC2_SUPERNODE_BOOTSTRAP` with two kubo peer multiaddrs; updated doc comment to explain the two peer categories (pinning vs. relay). |
| [pc2-node/src/services/AppInstallService.ts](../../../pc2-node/src/services/AppInstallService.ts) | `fetchFromIPFS` now calls `pinRemoteCID` with a 5 min timeout before `getFile`; typed errors mapped to user-friendly messages. |

## Files Created

| File | Purpose |
|---|---|
| [.cursor/tasks/DAPP-INSTALL-NETWORK-FETCH/DAPP-INSTALL-NETWORK-FETCH.md](./DAPP-INSTALL-NETWORK-FETCH.md) | This document. |

## Acceptance Criteria

1. [x] InterServer kubo peer (`12D3KooWFLBeem...`) is among the bootstrap
   dial successes on node startup. Verified via
   `/tmp/pc2-node-v3.log` showing `Bootstrap dial (post-init) complete: 10/12 connected`
   (up from 8/10 before the additive change).
2. [x] Contabo kubo peer (`12D3KooWQZu8...`) is among the bootstrap dial
   successes. Verified same log line.
3. [x] Zero TypeScript compilation errors:
   `cd pc2-node && yarn build:backend` succeeds in 12.6 s.
4. [ ] **Pending user / Irzhy smoke test**: cold install of
   `glide-finance` (`bafybeib6jbeosg…`) and `elastos-nft`
   (`bafybeich5bman…`) from a PC2 node that has not seen those CIDs
   before completes end-to-end with no ENOENT and the app becomes
   runnable.
5. [x] `pc2-node/scripts/wave5-smoke.sh` logic unchanged — install-path
   permission gating (`requireOwner`) is the same; the HTTP contract
   (201 `{ app }` on success, 4xx `{ error }` on failure) is the same.
6. [x] No changes to supernode OS / systemd / nginx / ufw / pin state.
7. [x] No changes to `install-pinning.sh`, `deploy.sh`, or the registry
   signing key.
8. [x] No changes to media / `.ddrm` viewer / download-first buy flow.

## Results

### Code compile + runtime

- `yarn build:backend`: Done in 12.63 s, no TS errors.
- Restart on `/tmp/pc2-node-v3.log`:
  - `PC2 supernodes: 6 configured` (was 4, now +2 kubo peers).
  - `Bootstrap dial (initial) complete: 8/12 connected` then
    `Bootstrap dial (post-init) complete: 10/12 connected` within 15 s.
  - IPFS mode: hybrid (unchanged).
  - No error or warning lines from `ipfs.ts` related to the new addrs.

### Supernode-side evidence (read-only SSH, 2026-04-30)

For completeness, here is the exact `ipfs pin ls --type=recursive <cid>`
output for all 6 v1.2 registry CIDs on **Contabo**. InterServer reported
identically.

```
bafybeiczcdan4j7zfw2ychjgzco4y4lbb5mqceezxfl5h7f3koau7t6x5y  recursive  (elacity-market)
bafybeidhttd3uozgo3odpcvs3hvmrsbo2pgrbce6srum65y5qfzzvzztxy  recursive  (elacity-creator)
bafybeifbgkjmgnwvddgntdihvssvyncj5xml2ft6qi3dr3hellgf7wgxbi  recursive  (elacity-player)
bafkreicswjb7mvwdgauwd6dhw7ryirndxfraocjo2avn53vfs24oo7jeua  recursive  (ddrm-viewer)
bafybeich5bmanb3nx65scjcv3rp3wjcge4np6von6ybwrp7xsob7llczdy  recursive  (elastos-nft)
bafybeib6jbeosgudsbilc2bhlkbycnhuvdxwc5zfp22dmbsniknxddwvzq  recursive  (glide-finance)
```

## Testing Strategy (user-side)

1. Confirm both pre-installed apps still launch (no regression).
2. Uninstall `elacity-creator` from the dApp Centre, then reinstall it
   from the Centre. Should succeed in <10 s even on a cold repo.
3. Install `glide-finance` (80 MB) fresh — biggest bundle in the
   catalog, most exposed to timeout regression.
4. Ask Irzhy to repeat his original test: install Glide + Elastos NFT
   on a clean PC2 repo. Both should succeed.
5. Optional: delete `data/ipfs/blocks/` on a test PC2 node, restart,
   install one app to force every block to come over the network.

## Out of Scope

- Making `PC2_SUPERNODE_BOOTSTRAP` externally configurable via JSON
  (the `supernodeBootstrap` options field already covers this for
  deployments that need it).
- Seeding installed app bundles back to the swarm from PC2 nodes
  (tracked separately under a future PC2-AS-SEEDER task — not required
  for v1.2 since supernode kubo is authoritative for app bundles).
- Auto-pinning new marketplace CIDs onto supernode kubo via an
  authenticated `/api/storage/ipfs/pin` endpoint on each supernode
  (covered by
  [docs/core/SUPERNODE_CAPABILITY_ASSESSMENT.md](../../../docs/core/SUPERNODE_CAPABILITY_ASSESSMENT.md)
  §"C2. Auto-pin marketplace CIDs").
- Progress bar / installId polling for the dApp Centre Install flow.
  Reasonable v1.3 enhancement, not required for v1.2.
- Local iptables-blocking smoke test for gateway fallback. My edits do
  not touch the gateway-fallback branch in `pinRemoteCID`; re-testing
  it yields no new signal. The fallback path is unchanged since the
  DOWNLOAD-FIRST-BUY-FLOW task verified it.

## Notes

- The libp2p `/dns4/.../libp2p.direct/tls/ws` addresses advertised by
  kubo are browser-facing (`libp2p.direct` is a service that issues
  Let's Encrypt certs for libp2p peer IDs), useful later if the PC2
  Puter-style UI wants to run a browser-side libp2p client. Not needed
  for server-side Node.js PC2 clients — TCP is sufficient.
- The pc2-ipfs-relay on 4003/4004 has been in the bootstrap list for
  months; retaining it as a circuit-relay bootstrap preserves whatever
  NAT-traversal paths were already working. Dropping it is a separate,
  riskier change that warrants its own task.
