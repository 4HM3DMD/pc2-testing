# Session Handover — Mar 4, 2026

> **Read this first when starting a new agent session.**

---

## Where We Are

**Branch:** `feature/elacity-ddrm-marketplace` (created from `main` after v1.1.0 release)
**Release:** v1.1.0 tagged and released on 2026-03-03 (134 commits squash-merged to main)
**Launcher:** v1.1.1 released — version display, one-click updates, full networking install
**DAO Proposal:** Live at https://elastos.com/proposals/69a24f49247f130078064edd

### What Just Shipped (v1.1.0)

- Four-tier stealth transport cascade (WG > AWG > VLESS Reality > ActiveProxy)
- Desktop Launcher with version display, one-click updates, and full networking install
- Desktop UI overhaul (full-width top bar, layout toggle, mobile-responsive)
- Voice AI pipeline (Whisper + Ollama + Context API)
- ARM installer hardened (Go auto-detection, AmneziaWG from source, sing-box 1.13.0 pinned, Jetson power mode)
- Structured logging (no more console.log in production)
- Security: credentials rotated, removed from docs
- Upload verification against IPFS
- WireGuard reconnection with exponential backoff (15s start)

### What's Been Built on This Branch (Elacity dDRM, Mar 3-4)

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
- **On-chain purchase flow** — `buyAccess()` via `AuthorityGateway`, ERC-20 approval via `paymentProcessor()`
- **Media preview** — inline player for content previews
- **Creator avatars** — resolved from IPFS with proper fallback

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

### What Needs Work Next

1. **`.edrm` double-click** — currently opens the player popup; needs verification that playback actually works end-to-end from the file explorer
2. **Auto-download on purchase** — when a user buys content, it should automatically trigger `pinAndRegisterMedia` (currently only manual via button)
3. **App registry manifest format** — `app.json` schema, supernode discovery endpoint for decentralized app distribution
4. **App Factory** — local packaging pipeline (build → bundle → IPFS pin → publish)
5. **Creator tools** — `media-packager` integration for uploading/transcoding content
6. **Multi-chain deposits** — leverage Particle Universal Account for cross-chain USDC/ETH deposits without bridging
7. **Auto-pin + DHT announce** — purchased content automatically announced on DHT for CDN seeding effect
8. **Keyboard shortcuts** (Alt+Tab, Alt+F4) and Explorer context menu enhancements

### Previous Conversation Reference

Full transcript: [Elacity Market Build](9e02ad6d-ab42-429d-8895-cd864df59823)

---

## Key Documents

| Document | Path | What It's For |
|----------|------|---------------|
| **This file** | `docs/core/SESSION_HANDOVER.md` | Start here |
| **Agent Handover** | `docs/core/AGENT_HANDOVER.md` | Coding patterns, infrastructure |
| **Roadmap** | `docs/core/ROADMAP.md` | All milestones with checkboxes |
| **Architecture** | `docs/core/ARCHITECTURE_CONVERGENCE.md` | PC2 v1 → capsule runtime v2 |
| **Stealth Mode** | `docs/deployment/STEALTH_MODE.md` | Transport cascade docs |

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

### Backend APIs
| File | Purpose |
|------|---------|
| `pc2-node/src/api/storage.ts` | `/api/storage/ipfs/pin` — IPFS pinning with CAR support |
| `pc2-node/src/api/installed-apps.ts` | App install/uninstall/list endpoints |
| `pc2-node/src/services/AppInstallService.ts` | App lifecycle management service |
| `pc2-node/src/storage/ipfs.ts` | IPFS Helia node, `pinRemoteCID`, `fetchViaGateway` with CAR |
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

---

## Related Repositories

| Repository | Branch | Status |
|------------|--------|--------|
| [pc2.net](https://github.com/Elacity/pc2.net) | `feature/elacity-ddrm-marketplace` | Active development |
| [elastos-launcher](https://github.com/Elacity/elastos-launcher) | `main` | v1.1.1 released |
| [document-portal](https://github.com/Elacity/document-portal) | `main` | Up to date |
| [js-sdk](https://github.com/Elacity/js-sdk) | — | Elacity SDK (reference) |
| [elacity-web](https://github.com/Elacity/elacity-web) | — | Elacity website (reference for patterns) |
