# Session Handover — Mar 8, 2026

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

#### Supernode Decentralization — Phase 1 (Completed Mar 7)
- [x] Backup system (InterServer -> Contabo, 6h rsync)
- [x] App Registry mirror + IPFS Relay + Boson DHT on Contabo
- [x] Web gateway (slim read-replica) on Contabo
- [x] WireGuard + AmneziaWG + VLESS Reality on Contabo
- [x] Transport provisioning APIs on Contabo gateway
- [x] Client-side sequential failover across supernodes
- [x] Dual-write node registration

#### Supernode Decentralization — Phase 2 (Completed Mar 7-8, NOT YET RELEASED)
- [x] Gateway v2.0: Contabo added to `DEFAULT_SUPERNODES`, gossip/register/heartbeat endpoints
- [x] Supernode bootstrap script (`deploy/supernode-bootstrap.sh`) — one-command VPS setup
- [x] Dynamic supernode discovery — parallel fetch from all endpoints, disk persistence, merge with defaults
- [x] Relay node mode — Settings toggle + `/api/supernode/relay/*` APIs + IPFS circuitRelayServer
- [x] Supernode Manager dApp in dApp Center — spec check, service status, network view
- [x] Networking fix script (`scripts/fix-networking.sh`) — standalone WG+AWG+VLESS installer for community

**Deployed:** Gateway v2.0 on both InterServer and Contabo (Mar 8).
**Tested:** All gossip/register/heartbeat endpoints verified. 84 users, 16 WireGuard peers, 4 supernodes confirmed after InterServer upgrade.
**InterServer upgrade:** Completed Mar 8 — backup at `/root/pc2/web-gateway/index.js.bak`.

#### Known Community Issue (Mar 8) — "Keeps Initializing" on Remote Connect
**Scope:** 21 broken users (proxy:// endpoints), 10 working (WireGuard). Verified on InterServer registry.
**Root cause:** WireGuard tools not installed. Node falls back to ActiveProxy which registers `proxy://host:8090/session`. Gateway tries HTTP proxy to port 8090 (Boson binary protocol) → `Parse Error: Expected HTTP/` → page hangs on "initializing" forever.
**Why it happened:** Users installed PC2 before the networking install was added to the scripts (pre-v1.1.0), used the wrong script for their platform (e.g. `start-local.sh` on Jetson — doesn't install `wireguard-go`), or installed manually without running any install script.
**Fix commands (on `main`, no branch push needed):**
- **Jetson/ARM:** `curl -sSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/install-arm.sh | bash`
- **Ubuntu/Debian x86:** `cd ~/pc2.net && git pull && bash scripts/start-local.sh`
- **Standalone (any Linux):** `bash scripts/fix-networking.sh` (on branch, not yet on main)
**Permanent fix:** Bundle WireGuard/AWG/VLESS binaries with the app. See plan: `fix_wireguard_bundling_d5a881fa`.

#### Community Fix Verification (In Progress — Mar 8)
- **Werolo (Jetson):** Running `curl -sSL .../install-arm.sh | bash` to install WireGuard+AWG+VLESS. Awaiting confirmation.
- **Chelsea (Ubuntu VM x86):** Will run `cd ~/pc2.net && git pull && bash scripts/start-local.sh` tomorrow (Mar 9).
- **Other affected users (19+):** Same root cause. Post fix commands in community once Werolo/Chelsea confirm.

#### WireGuard Bundling — Phase 1 COMPLETE, Phase 2 IN PROGRESS (Mar 8)
**Phase 1 (detection infrastructure) — COMPLETE:**
- [x] Bundled binary detection — `WireGuardService`, `AmneziaWGService`, `VLESSRealityService` check `pc2-node/bin/{platform}-{arch}/` first
- [x] Windows WireGuard support — `wireguard.exe /installtunnelservice` path
- [x] `scripts/fetch-binaries.sh` — downloads/compiles `wg`, `wg-quick`, `wireguard-go`, `sing-box` for all platforms
- [x] Permission setup module — `setupPermissions.ts` with macOS `osascript` auth dialog, Linux sudoers.d, manual instructions
- [x] API endpoints — `GET /api/supernode/wireguard/status`, `POST /api/supernode/wireguard/setup-permissions`
- [x] `.gitignore` updated — `bin/` excluded from git

**Phase 2 (runtime auto-provisioning) — COMPLETE (Mar 8):**
- [x] `BinaryManager` (`pc2-node/src/utils/binary-manager.ts`) — auto-downloads missing transport binaries on first startup
- [x] `fetch-binaries.sh` enhanced — now also cross-compiles `amneziawg-go` and `awg-quick` for all platforms
- [x] Integrated into `BosonService.initialize()` — runs before WG/AWG/VLESS service detection
- [x] Safety net design — install scripts untouched, BinaryManager only downloads if binary genuinely missing
- [x] Platform support: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64

**Pending:**
- [ ] Create GitHub release `pc2-binaries-v1` with pre-compiled binaries for all platforms
- [ ] Gateway "node offline" page — deferred; replaces infinite "initializing" with friendly HTML + auto-retry

**Verified:** `wg`, `wg-quick`, `wireguard-go`, `sing-box` all detected from bundled paths in dev node logs (darwin-arm64).

> **PRE-MERGE CHECKLIST — Do this BEFORE merging branch to main:**
> 1. On your Mac, run: `bash pc2-node/scripts/fetch-binaries.sh all`
>    - This cross-compiles wireguard-go, amneziawg-go, awg-quick, and downloads sing-box for all 5 platforms
>    - Output lands in `pc2-node/bin/` (gitignored, not committed)
> 2. Go to GitHub > Elacity/pc2.net > Releases > "Create a new release"
>    - Tag: `pc2-binaries-v1`
>    - Title: "PC2 Transport Binaries v1"
>    - Upload ALL files from `pc2-node/bin/` as release assets, named as:
>      - `wireguard-go-{platform}-{arch}` (e.g. `wireguard-go-linux-arm64`)
>      - `amneziawg-go-{platform}-{arch}` (e.g. `amneziawg-go-darwin-arm64`)
>      - `awg-quick-{platform}` (e.g. `awg-quick-linux`)
>      - sing-box is downloaded directly from SagerNet releases, no upload needed
>    - Publish the release
> 3. Then merge branch to main
>
> **Why:** The BinaryManager in `pc2-node/src/utils/binary-manager.ts` downloads from these URLs
> at startup when binaries are missing. Without the release, downloads return 404 (safe — just
> logs a warning and continues, same behavior as today). With the release, any missing binary
> is auto-downloaded on first PC2 startup.

#### App Manifest Specification — COMPLETE (Mar 8)
- [x] `docs/core/APP_MANIFEST_SPEC.md` — formal spec v1.0 with field reference, validation rules, examples
- [x] Expanded `AppManifest` interface — added `category`, `system`, `capabilities.drm`, `distribution.signedBy`, expanded `type` to include `microvm`/`agent`
- [x] Enhanced `validateManifest()` — semver enforcement, entry path safety (backslash check), length limits, capability type warnings
- [x] All 5 test-app `app.json` files updated — categories, `drm: true` for Elacity apps
- [x] Registry entries updated — `category` at app level, `drm: true` in capabilities
- [x] Forward-compatible with: Elacity dDRM SDK, ElastOS Runtime (capsules + capability tokens), ERC-8004 Agent Registry
- [x] Vision documented: Elacity as universal digital asset marketplace (media, AI models, code, datasets, agents) for humans and agents

#### Universal Asset Strategy — DOCUMENTED (Mar 8)
- [x] `docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md` — full strategy: Elacity as "Amazon of digital assets"
- [x] SDK evolution plan: `@elacity-js/access` (universal decrypt), `@elacity-js/asset-packager` (generic encryption)
- [x] Marketplace verticals mapped: media, AI models, code, datasets, software, agents (with TAMs)
- [x] Revenue model: 7+ fee streams from media to white-label to enterprise DRM-as-a-Service
- [x] Strategic blind spots documented: agent-to-agent commerce, composable assets, fiat onramp, mobile, enterprise B2B, creator tools, data unions
- [x] ROADMAP.md updated with SDK evolution milestones, AI model marketplace, mobile app, fiat onramp, white-label protocol, universal marketplace scaling
- [x] ARCHITECTURE_CONVERGENCE.md Part 15 added — dDRM as universal access layer, ACCESS_TOKEN-to-capability-token bridge, agent-to-agent commerce
- [x] APP_MANIFEST_SPEC.md updated — universal asset metadata schema (`asset` field alongside `media`), 12 asset types defined

#### Next Up (Priority Order)
1. **Verify community fix** — confirm Werolo and Chelsea's domains work remotely after install
2. ~~**InterServer gateway upgrade to v2.0**~~ — DONE (Mar 8, 08:08 UTC). Backup at `index.js.bak`.
3. ~~**WireGuard binary bundling (BinaryManager)**~~ — DONE (Mar 8). Runtime auto-download of transport binaries.
4. ~~**App registry manifest format**~~ — DONE (Mar 8). Formal spec at `docs/core/APP_MANIFEST_SPEC.md`.
5. ~~**Universal asset strategy**~~ — DONE (Mar 8). Full strategy at `docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md`.
6. **Create GitHub release `pc2-binaries-v1`** — run `fetch-binaries.sh all`, upload assets to release
7. **`@elacity-js/access` package** — extract Lit Protocol from media-player into universal access layer (THE critical SDK unlock)
8. **Creator Dashboard dApp** — upload any file, set price/royalties, encrypt, list on marketplace
9. **AI Model Marketplace alpha** — encrypt GGUF model -> IPFS -> ACCESS_TOKEN -> decrypt -> Ollama
10. **Fiat onramp** — Particle Smart Account + Stripe/Moonpay for one-click credit card purchases
11. **Gateway "node offline" page** — deferred; replaces infinite "initializing" spinner with friendly error + retry
12. **Test bootstrap script on a fresh VPS** — validate one-command supernode deployment
13. **App Factory** — local packaging pipeline (build -> bundle -> IPFS pin -> publish)
14. **dDRM Access Token contract** — ERC-1155 tiered tokens for supernode economics (deferred to Milestone 3-4)

### Supernode Infrastructure

#### InterServer (Primary) — 69.164.241.210
| Service | Port | Status |
|---------|------|--------|
| Boson DHT | 39001/UDP | Running |
| Active Proxy | 8090/TCP | Running |
| WireGuard (wg0) | 51820/UDP | Running (subnets 10.100/10.101) |
| AmneziaWG | 51821/UDP | Running |
| VLESS Reality | 8443/TCP | Running |
| Web Gateway | 80/443 | Running |
| IPFS Relay | 4003/TCP, 4004/WS | Running — Peer ID: `12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G` |
| Elastos pg-oracle | 20672/TCP | Running (v0.0.3.3) |

#### Contabo (Secondary) — 38.242.211.112
| Service | Port | Status |
|---------|------|--------|
| Boson DHT | 39001/UDP | Running — Node ID: `EbfCHQUfwawec8Pyz9vdYTXRRoR1GpjNPgLc3vAhAoam` |
| IPFS Relay | 4003/TCP | Running (500+ peers) |
| App Registry (mirror) | 4500/TCP | Running (5-min sync from primary) |
| WireGuard (wg1) | 51820/UDP | Running (subnet 10.102) |
| AmneziaWG (awg0) | 51821/UDP | Running (subnet 10.103) |
| VLESS Reality (sing-box) | 8443/TCP | Running |
| Slim Web Gateway | 80/443 | Running (read-replica with transport provisioning APIs) |
| Automated Backup | cron 6h | Running (rsync from InterServer) |

### Network Decentralization Status
- **Two independent supernodes** with full transport stack
- **Sequential failover** — PC2 clients try all supernodes on tunnel failure
- **Dual-write registration** — new nodes register on all reachable supernodes
- **Three-tier target** — Full Supernodes > Relay Nodes > Leaf Nodes (see SUPERNODE_ECONOMICS.md)

### Previous Conversation References

- [Elacity dDRM Build](9e02ad6d-ab42-429d-8895-cd864df59823) — dApp store, media market, CDN, wallet bridge
- [Supernode Decentralization](f18dbf44-f5de-4238-8c62-499018cd4e50) — gateway v2.0, bootstrap script, dynamic discovery, relay mode, supernode dApp, community networking fix, docs update

---

## Key Documents

| Document | Path | What It's For |
|----------|------|---------------|
| **This file** | `docs/core/SESSION_HANDOVER.md` | Start here |
| **Agent Handover** | `docs/core/AGENT_HANDOVER.md` | Coding patterns, infrastructure |
| **Roadmap** | `docs/core/ROADMAP.md` | All milestones with checkboxes |
| **Architecture** | `docs/core/ARCHITECTURE_CONVERGENCE.md` | PC2 v1 -> capsule runtime v2 |
| **Universal Asset Strategy** | `docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md` | Unicorn strategy, marketplace verticals, SDK evolution, revenue model |
| **App Manifest Spec** | `docs/core/APP_MANIFEST_SPEC.md` | app.json schema, field reference, validation rules |
| **Supernode Economics** | `docs/core/SUPERNODE_ECONOMICS.md` | dDRM Access Token model, three-tier architecture |
| **Network Hardening** | `docs/pc2-infrastructure/NETWORK_HARDENING.md` | Scale tiers, fragile points, supernode inventory |
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
