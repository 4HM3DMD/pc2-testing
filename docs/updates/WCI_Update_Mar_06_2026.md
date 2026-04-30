# Elastos WCI Team Ecosystem Report, Mar 6, 2026

**Elacity dDRM Marketplace Live, Decentralized CDN Network Deployed, Supernode IPFS Relay Running, and 6 Commits Ship on New Branch**

---

## GitHub Shipping Report

**ElastOS Weekly Shipping Report — Week of Mar 3–6, 2026**

**Branch:** `feature/elacity-ddrm-marketplace` (new, created from `main` after v1.1.0)
**6 commits | 196 files changed | 25,217 insertions, 1,254 deletions**

---

### Shipped:

**Elacity dDRM Marketplace — Phase 1 Foundation**
- Full Elacity Market dApp built and running inside PC2 — browse channels, search content, view media details, purchase with wallet signature ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))
- postMessage wallet bridge (`pc2-wallet-bridge.js` + `pc2-wallet-provider.js`) — shims `window.ethereum` for iframe-sandboxed dApps, routes wallet RPC calls to host Particle Auth ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))
- COOP/COEP per-app headers for SharedArrayBuffer — Elacity Player requires cross-origin isolation which is now served per-app without breaking other apps ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))
- `installed_apps` SQLite table + `AppInstallService.ts` — full app lifecycle management with disk space checks, IPFS fetch with retry/backoff, partial install cleanup ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))
- Install/uninstall/list/update API endpoints (`/api/apps/*`) ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))
- `.edrm` file type support in GUI — custom padlock icon, MIME registration, double-click opens Elacity Player in dedicated popup window ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))
- "Save to Cloud" download with progress UI — purchased content pins to local IPFS node with animated progress bar and "Open Videos folder" link ([6a55f430](https://github.com/Elacity/pc2.net/commit/6a55f430))

**DRM Playback — End-to-End Working**
- Elacity Player launches in a dedicated popup window (required for `SharedArrayBuffer` / WASM decryption module) ([1a225505](https://github.com/Elacity/pc2.net/commit/1a225505))
- Lit Protocol DRM license acquisition, signature verification, and decryption all verified working ([1a225505](https://github.com/Elacity/pc2.net/commit/1a225505))
- `@lit-protocol/*` packages pinned to v7.3.0 via npm overrides — v7.4.0 introduced RPC timeouts that broke license acquisition ([1a225505](https://github.com/Elacity/pc2.net/commit/1a225505))
- Player streams DASH content from local Helia IPFS node (`localhost:4200/ipfs/`) with automatic fallback to Elacity CDN ([1a225505](https://github.com/Elacity/pc2.net/commit/1a225505))
- UnixFS DAG path resolution — `/ipfs/:cid/*` wildcard route resolves nested paths within directory CIDs (DASH manifests, video/audio segments) ([1a225505](https://github.com/Elacity/pc2.net/commit/1a225505))

**On-Chain Purchase Flow**
- Particle Universal Account SDK v1.0.24 integration fixed — removed incorrect `universalGas: true` parameter that caused "Insufficient balance for gas fees" on every purchase ([1a225505](https://github.com/Elacity/pc2.net/commit/1a225505))
- Purchase via `buyAccess()` through `AuthorityGateway` contract with ERC-20 USDC approval — verified working end-to-end (user purchased and played DRM content) ([36d11838](https://github.com/Elacity/pc2.net/commit/36d11838))
- Smart Account batch buy with single wallet signature ([36d11838](https://github.com/Elacity/pc2.net/commit/36d11838))

**Decentralized CDN Network**
- NAT traversal wired into Helia IPFS node — `@libp2p/circuit-relay-v2`, `@libp2p/dcutr`, `@libp2p/autonat` enable peer reachability behind home NATs and firewalls ([f78abdeb](https://github.com/Elacity/pc2.net/commit/f78abdeb))
- Bitswap-first fetching — `fetchViaBitswap()` uses DHT `findProviders` + direct peer block exchange before falling back to HTTP gateways, enabling true peer-to-peer content delivery ([f78abdeb](https://github.com/Elacity/pc2.net/commit/f78abdeb))
- CID announcement — purchased content announced on Kademlia DHT via `dht.provide()` so other PC2 nodes can discover and fetch it peer-to-peer ([f78abdeb](https://github.com/Elacity/pc2.net/commit/f78abdeb))
- Periodic re-announcement — background process re-announces all pinned CIDs (public files + marketplace purchases) every 4 hours ([f78abdeb](https://github.com/Elacity/pc2.net/commit/f78abdeb))
- `pinned_cids` SQLite table (Migration 17) — tracks marketplace purchases with wallet address, size, source, and last announcement time ([f78abdeb](https://github.com/Elacity/pc2.net/commit/f78abdeb))
- In-memory CDN bandwidth tracking + `GET /api/cdn/stats` endpoint — records bytes served per CID, request counts, source breakdown, top CIDs, uptime ([f78abdeb](https://github.com/Elacity/pc2.net/commit/f78abdeb))
- NAT traversal packages added as direct dependencies for clean `npm install` on new nodes ([97574518](https://github.com/Elacity/pc2.net/commit/97574518))

**Supernode IPFS Relay (Infrastructure)**
- Standalone libp2p relay node deployed on supernode (69.164.241.210:4003 TCP + 4004 WebSocket)
- Provides circuit relay server, Kademlia DHT server, AutoNAT, and DCUtR for the entire PC2 network
- Running as systemd service (`pc2-ipfs-relay`) — 500+ connected peers, ~88MB RAM, stable
- Peer ID: `12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G`
- All PC2 nodes bootstrap to this relay via `PC2_SUPERNODE_BOOTSTRAP` config
- Code at `deploy/ipfs-relay/` with deployment script, systemd unit file, and `Promise.withResolvers` polyfill for Node.js v20 compatibility

**Elastos Node Maintenance**
- pg-oracle updated to v0.0.3.3 on supernode (per Elastos community request)

---

### Architecture: How the CDN Network Works

```
User A buys media on Elacity Market
  → Content pinned to User A's local IPFS node
  → CID announced on Kademlia DHT
  → Content served locally for User A's playback

User B buys the same media
  → DHT lookup finds User A as a provider
  → Bitswap fetches blocks directly from User A (peer-to-peer)
  → Falls back to Elacity CDN only if no peers available
  → User B now also announces the CID
  → Network grows stronger with each purchase

Supernode IPFS Relay
  → Helps nodes behind NATs find and connect to each other
  → Provides circuit relay for nodes that can't make direct connections
  → DHT server mode enables content discovery across the network
```

**Resource impact on PC2 nodes:** Minimal. NAT traversal runs passively via libp2p (no polling). DHT re-announcement happens once every 4 hours (~seconds of CPU). Content serving only activates when another peer requests blocks — similar to seeding a torrent. Idle nodes use negligible extra resources.

---

### What's Next

1. **App Center UI rebuild** — connect the App Center to real `/api/apps/*` backend APIs
2. **Auto-download on purchase** — eliminate the manual "Save to Cloud" step
3. **App registry manifest format** — decentralized app distribution via `app.json` schema
4. **CDN dashboard UI** — show CDN stats in PC2 settings so users see their contribution
5. **App Factory** — local build → IPFS pin → publish pipeline for developers
6. Continue through [ROADMAP.md](../core/ROADMAP.md) milestones

---

### Branch Status

| Branch | Status | Commits Ahead of Main |
|--------|--------|-----------------------|
| `main` | v1.1.0 released (2026-03-03) | — |
| `feature/elacity-ddrm-marketplace` | Active development | 6 commits |

### Repository Stats (This Branch)

| Metric | Value |
|--------|-------|
| Commits this week | 6 |
| Files changed | 196 |
| Lines added | 25,217 |
| Lines removed | 1,254 |
| New files | 42 |
| Infrastructure deployed | IPFS Relay (supernode) |

---

**Links:**
- [Repository](https://github.com/Elacity/pc2.net)
- [Branch](https://github.com/Elacity/pc2.net/tree/feature/elacity-ddrm-marketplace)
- [v1.1.0 Release](https://github.com/Elacity/pc2.net/releases/tag/v1.1.0)
- [DAO Proposal](https://elastos.com/proposals/69a24f49247f130078064edd)
