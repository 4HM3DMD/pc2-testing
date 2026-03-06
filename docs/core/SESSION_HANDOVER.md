# Session Handover — Mar 6, 2026

> **Read this first when starting a new agent session.**

---

## Where We Are

**Branch:** `feature/elacity-ddrm-marketplace` (created from `main` after v1.1.0 release)
**Release:** v1.1.0 tagged and released on 2026-03-03 (134 commits squash-merged to main)
**Launcher:** v1.1.1 released — version display, one-click updates, full networking install
**DAO Proposal:** Live at https://elastos.com/proposals/69a24f49247f130078064edd
**Last Commits:** `97574518` (NAT traversal deps), `f78abdeb` (CDN network feature)

### What Just Shipped (v1.1.0 on main)

- Four-tier stealth transport cascade (WG > AWG > VLESS Reality > ActiveProxy)
- Desktop Launcher with version display, one-click updates, and full networking install
- Desktop UI overhaul (full-width top bar, layout toggle, mobile-responsive)
- Voice AI pipeline (Whisper + Ollama + Context API)
- ARM installer hardened (Go auto-detection, AmneziaWG from source, sing-box 1.13.0 pinned, Jetson power mode)
- Structured logging (no more console.log in production)
- Security: credentials rotated, removed from docs
- Upload verification against IPFS
- WireGuard reconnection with exponential backoff (15s start)

### What's Been Built on This Branch (Elacity dDRM, Mar 3-6)

#### Phase 1 Foundation — COMPLETE
- **postMessage wallet bridge** (`pc2-wallet-bridge.js`, `pc2-wallet-provider.js`) — shims `window.ethereum` for iframe-sandboxed dApps, routes wallet calls to host Particle Auth
- **COOP/COEP headers** tested for `SharedArrayBuffer` (media player needs it)
- **`installed_apps` SQLite table** + `AppInstallService.ts` — app lifecycle management
- **Install/uninstall/list/update API** endpoints (`/api/apps/*`)
- **Static file serving** for installed apps with `Cache-Control: no-cache` to prevent stale bundles

#### Elacity Market dApp — FUNCTIONAL
- **Full market UI** — Pipeline-style sidebar with Feed, Channels, My Library, Subscriptions, Watch Later
- **Light/dark theme** with toggle
- **GraphQL API client** (`api.js`) — `fetchAccessibleAssets`, `fetchChannels`, `retrieveChannel`, channel subscriptions, asset detail queries
- **Wallet integration** (`wallet.js`) — Particle Smart Wallet, auto-SIWE authentication, deduplication of login prompts, `switchToBase()` for chain switching
- **Channel directory** — grid/list views, category filters, channel detail pages with cover images and subscription tiers
- **On-chain subscription flow** — plan selection modal, ERC-20 approval, `subscribePlan()` contract call via ethers.js
- **On-chain purchase flow** — `buyAccess()` via `AuthorityGateway`, ERC-20 approval via `paymentProcessor()` — **verified working** (user purchased and played content)
- **Media preview** — inline player for content previews
- **Creator avatars** — resolved from IPFS with proper fallback

#### DRM Playback — WORKING END-TO-END
- **`.edrm` file double-click** → launches Elacity Player in a dedicated popup window (required for `SharedArrayBuffer`/COOP/COEP)
- **Lit Protocol DRM** — license acquisition, signature verification, decryption all working; `@lit-protocol/*` pinned to v7.3.0 via npm overrides
- **Local IPFS playback** — player loads content from local Helia node (`localhost:4200/ipfs/`) with fallback to Elacity CDN
- **UnixFS DAG path resolution** — `/ipfs/:cid/*` wildcard route resolves nested paths within directory CIDs (DASH segments, manifests)
- **Particle Universal Account** — SDK v1.0.24 integration fixed (removed `universalGas: true` for correct API shape)

#### Decentralized CDN Network — COMPLETE (Mar 5-6)
- **NAT Traversal** — `@libp2p/circuit-relay-v2`, `@libp2p/dcutr`, `@libp2p/autonat` wired into Helia node for peer reachability behind NATs
- **Bitswap-first fetching** — `fetchViaBitswap()` method tries DHT `findProviders` + direct peer block exchange before falling back to HTTP gateways
- **CID announcement** — purchased content is announced on the Kademlia DHT via `dht.provide()` so other nodes can discover it
- **Periodic re-announcement** — background process re-announces all pinned CIDs (public files + marketplace purchases) every 4 hours
- **`pinned_cids` SQLite table** — tracks marketplace purchases with wallet address, size, source, and last announcement time (Migration 17)
- **In-memory CDN bandwidth tracking** — `trackCDNBandwidth()` records bytes served per CID, request counts, source breakdown (local/bitswap/gateway)
- **`GET /api/cdn/stats` endpoint** — exposes CDN bandwidth stats, top CIDs, uptime, IPFS network info
- **Supernode IPFS Relay** — standalone libp2p node deployed on 69.164.241.210:4003 (TCP) + 4004 (WS), provides circuit relay + DHT server for NAT traversal
- **Bootstrap addresses** — `PC2_SUPERNODE_BOOTSTRAP` in `ipfs.ts` points all PC2 nodes to the relay

#### Download-to-Node / Seeding — FUNCTIONAL
- **"Save to Cloud" button** on owned assets — downloads content from Elacity IPFS gateway, saves `.edrm` descriptor to user's Videos folder
- **`.edrm` descriptor format** — JSON file containing CID, contract address, token ID, gateway URL, media metadata
- **Progress UI** — animated progress bar, status messages, "Open Videos folder" link on completion
- **`openFolder` IPC handler** — new message type in `IPC.js` to open file explorer at a specific path from within dApps
- **`.edrm` file type support in GUI** — custom icon (padlock + green tick), MIME type registration, double-click opens Elacity player popup
- **IPFS CAR format support** — `fetchViaGateway` in `storage/ipfs.ts` handles directory CIDs via CAR import, Elacity gateway as primary
- **Auth for backend calls** — `pc2Fetch()` wrapper extracts `puter.auth.token` from iframe URL, includes `Authorization: Bearer` header

#### Elacity Player — BUNDLED
- Pre-built player at `test-apps/elacity-player/` with DASH streaming, DRM decryption, EIP-712 license requests

### What Needs Work Next (Priority Order)

1. **App Center UI rebuild** — rebuild the App Center against real backend APIs (currently shows hardcoded apps)
2. **Auto-download on purchase** — when a user buys content, auto-trigger `pinAndRegisterMedia` (currently manual via button)
3. **App registry manifest format** — `app.json` schema, supernode discovery endpoint for decentralized app distribution
4. **App Factory** — local packaging pipeline (build → bundle → IPFS pin → publish)
5. **Creator tools** — `media-packager` integration for uploading/transcoding content
6. **Multi-chain deposits** — leverage Particle Universal Account for cross-chain USDC/ETH deposits without bridging
7. **CDN dashboard UI** — expose `/api/cdn/stats` in the PC2 settings or status bar so users can see their node's contribution
8. **Keyboard shortcuts** (Alt+Tab, Alt+F4) and Explorer context menu enhancements

### Supernode Infrastructure

| Service | Location | Port | Status |
|---------|----------|------|--------|
| Boson DHT | 69.164.241.210 | 39001/UDP | Running |
| Active Proxy | 69.164.241.210 | 8090/TCP | Running |
| WireGuard | 69.164.241.210 | 51820/UDP | Running |
| Web Gateway | 69.164.241.210 | 80/443 | Running |
| **IPFS Relay** | 69.164.241.210 | 4003/TCP, 4004/WS | **Running (new)** — Peer ID: `12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G` |
| Elastos pg-oracle | 69.164.241.210 | 20672/TCP | Running (updated to v0.0.3.3) |

### Previous Conversation Reference

Full transcript: [Elacity dDRM Build](9e02ad6d-ab42-429d-8895-cd864df59823)

---

## Key Documents

| Document | Path | What It's For |
|----------|------|---------------|
| **This file** | `docs/core/SESSION_HANDOVER.md` | Start here |
| **Agent Handover** | `docs/core/AGENT_HANDOVER.md` | Coding patterns, infrastructure |
| **Roadmap** | `docs/core/ROADMAP.md` | All milestones with checkboxes |
| **Architecture** | `docs/core/ARCHITECTURE_CONVERGENCE.md` | PC2 v1 → capsule runtime v2 |
| **Stealth Mode** | `docs/deployment/STEALTH_MODE.md` | Transport cascade docs |
| **CDN Task** | `.cursor/tasks/CDN-EFFECT/CDN-EFFECT.md` | CDN network task details |

---

## Key Files for Elacity dDRM Work

### Elacity Market dApp (runs inside iframe)
| File | Purpose |
|------|---------|
| `pc2-node/data/test-apps/elacity-market/app.js` | Main app logic — rendering, state, download, playback |
| `pc2-node/data/test-apps/elacity-market/api.js` | GraphQL API client for Elacity backend |
| `pc2-node/data/test-apps/elacity-market/wallet.js` | Wallet operations — connect, SIWE, buy, subscribe, chain switch |
| `pc2-node/data/test-apps/elacity-market/index.html` | HTML structure |
| `pc2-node/data/test-apps/elacity-market/styles.css` | All CSS including light/dark themes |

### CDN Network
| File | Purpose |
|------|---------|
| `pc2-node/src/storage/ipfs.ts` | Helia node, NAT traversal, Bitswap, DHT announce, bootstrap |
| `pc2-node/src/api/public.ts` | IPFS gateway, CDN bandwidth tracking, `/api/cdn/stats` |
| `pc2-node/src/storage/database.ts` | `trackPinnedCID`, `getAllAnnouncableCIDs` |
| `pc2-node/src/storage/migrations.ts` | Migration 17: `pinned_cids` table |
| `pc2-node/src/index.ts` | Periodic DHT re-announcement loop |
| `deploy/ipfs-relay/` | Standalone IPFS relay deployed on supernode |

### Backend APIs
| File | Purpose |
|------|---------|
| `pc2-node/src/api/storage.ts` | `/api/storage/ipfs/pin` — IPFS pinning with CAR support |
| `pc2-node/src/api/installed-apps.ts` | App install/uninstall/list endpoints |
| `pc2-node/src/services/AppInstallService.ts` | App lifecycle management service |
| `pc2-node/src/static.ts` | Static serving for installed apps with wallet bridge injection |

### GUI (file explorer, IPC)
| File | Purpose |
|------|---------|
| `src/gui/src/helpers/open_item.js` | `.edrm` double-click → opens player popup |
| `src/gui/src/IPC.js` | `openFolder` IPC handler for dApp→GUI communication |
| `src/gui/src/helpers/item_icon.js` | `.edrm` custom icon |
| `src/gui/src/lib/mime.js` | `.edrm` MIME type registration |
| `src/gui/src/icons/file-edrm.svg` | Padlock + green tick icon for DRM files |

### Wallet Bridge (injected into all dApp iframes)
| File | Purpose |
|------|---------|
| `pc2-node/frontend/pc2-wallet-bridge.js` | Host-side bridge — listens for postMessage, routes to Particle |
| `pc2-node/frontend/pc2-wallet-provider.js` | Guest-side shim — replaces `window.ethereum` inside iframe |

### Elacity Player (source + built)
| File | Purpose |
|------|---------|
| `pc2-node/data/test-apps/elacity-player-src/` | Player source code (Vite + React + TypeScript) |
| `pc2-node/data/test-apps/elacity-player/` | Built player bundle (deployed) |
| `pc2-node/data/test-apps/elacity-player-src/src/PlayerView.tsx` | Gateway resolution logic (local-first + fallback) |
| `pc2-node/data/test-apps/elacity-player-src/package.json` | `@lit-protocol/*` pinned to v7.3.0 via overrides |

---

## Infrastructure Access

```
Supernode (InterServer): root@69.164.241.210
Secondary (Contabo):     root@38.242.211.112
Passwords: ROTATED — stored in password manager, not in git
```

---

## Important Boundaries

- **"Elacity dDRM"** — always use this full name. It's Elacity Labs' commercial protocol, NOT an ELA demand mechanism.
- **ELA value** comes from native mechanisms: Carrier staking, blockchain gas, routing fees, in-OS protocol fees
- **ElastOS** = open infrastructure (community). **Elacity** = private company operating on it.
- Never reference Anders Alm by name in public docs — refer to "the V2 runtime" or "the capsule architecture"
- **Install Parity Rule** — launcher, start-local.sh, and install-arm.sh must always install the same tools
- **Never commit passwords or SSH credentials** — store in password manager only

---

## Related Repositories

| Repository | Branch | Status |
|------------|--------|--------|
| [pc2.net](https://github.com/Elacity/pc2.net) | `feature/elacity-ddrm-marketplace` | Active development |
| [elastos-launcher](https://github.com/Elacity/elastos-launcher) | `main` | v1.1.1 released |
| [document-portal](https://github.com/Elacity/document-portal) | `main` | Up to date |
| [js-sdk](https://github.com/Elacity/js-sdk) | — | Elacity SDK (reference) |
| [elacity-web](https://github.com/Elacity/elacity-web) | — | Elacity website (reference for patterns) |
