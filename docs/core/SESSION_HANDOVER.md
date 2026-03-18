# Session Handover — Mar 13, 2026

> **Read this first when starting a new agent session.**

---

## Where We Are

**Branch:** `feature/lit-chipotle-migration` (branched from `feature/wasm-crypto-hardening`)
**Parent Branch:** `feature/wasm-crypto-hardening` → `feature/ddrm-universal-access-layer` → `feature/elacity-ddrm-marketplace`
**Release:** v1.1.0 tagged and released on 2026-03-03 (134 commits squash-merged to main)
**Launcher:** v1.1.1 released — version display, one-click updates, full networking install
**DAO Proposal:** Live at https://elastos.com/proposals/69a24f49247f130078064edd
**Last Commit:** feat: media encoding pipeline (transcode→fragment→CENC→DASH→IPFS), IPC duplicate fix

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

#### DRM Playback — WORKING END-TO-END (TWO PIPELINES)

**Pipeline 1: Elacity Player (legacy, for `.edrm` files)**
- **`.edrm` file double-click** → launches Elacity Player in a dedicated popup window (required for `SharedArrayBuffer`/COOP/COEP)
- **Lit Protocol DRM** — license acquisition, signature verification, decryption all working; `@lit-protocol/*` pinned to v7.3.0 via npm overrides
- **Particle Universal Account** — SDK v1.0.24 integration fixed (removed `universalGas: true` for correct API shape)

**Pipeline 2: PC2 Media Runtime (NEW, server-side DASH/CENC decryption)**
- **Server-side decryption** — PC2 node fetches encrypted DASH segments from local IPFS, decrypts via Rust WASM (`cenc-decrypt` crate), strips all DRM signaling, streams clear fMP4 to browser
- **Lightweight MSE player** — JavaScript-only player using MediaSource Extensions. No EME, no CDM, no SharedArrayBuffer, no COOP/COEP needed. Works inside PC2 iframe sandbox
- **Rust WASM `cenc-decrypt`** — parses fMP4 boxes (moof/trun/senc/tenc), performs per-sample AES-128-CTR decryption with correct 16-byte IV support. CEK stays in WASM linear memory
- **DRM stripping** — init segments: `encv→av01`, `enca→mp4a`, remove `sinf`/`pssh`, adjust all ancestor box sizes. Media segments: remove `senc`/`saiz`/`saio`, fix `trun.data_offset`
- **Two-phase Lit auth** — server prepares SIWE + ReCap message, user signs in market dApp, signature relayed back to init endpoint for CEK recovery
- **Smart Account aware** — detects Universal Account via Base factory contract, selects correct PSSH for SA address
- **Local IPFS playback** — content loaded from local Helia node (`localhost:4200/ipfs/`) with fallback to Elacity CDN
- **UnixFS DAG path resolution** — `/ipfs/:cid/*` wildcard route resolves nested paths within directory CIDs (DASH segments, manifests)

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

#### Network Map Visual Upgrade — DEPLOYED (Mar 8)
- [x] Decentralized topology: full supernode mesh, round-robin PC2 distribution, peer-to-peer links, offline faint links
- [x] Core vs carrier supernodes: InterServer (`supernode_J1h7RHv5`) + Contabo (`supernode_EbfCHQUf`) are large hubs; Boson relay nodes are smaller
- [x] Particle flow on all active links (gold backbone, green node-to-super, cyan peer)
- [x] Animated node painting: pulsing supernode halos, breathing glow on online PC2 nodes
- [x] Offline nodes are orange (sleeping laptops), stale nodes are dim red
- [x] Background ambient effects: dot grid + radial glow zones behind each supernode
- [x] Deployed to https://map.ela.city/ — frontend-only update, server/API untouched
- [x] Backup at `/root/pc2/network-map/frontend/dist.bak`

#### Network Map Rebrand, 3D Orb, & SEO — DEPLOYED (Mar 12-13)
- [x] **3D orb visualization (World Computer)** — Three.js force-shield with GLSL shaders, auto-rotating globe with pulsing nodes and animated arc connections, side-by-side with existing 2D graph
- [x] **Converted orb from TypeScript/Tailwind to JSX/inline styles** — 8 files in `deploy/network-map/frontend/src/components/force-shield/`
- [x] **Rebranded** header from "ElastOS Personal Cloud Compute (PC2) Network Map" to "ElastOS World Computer Network"
- [x] **White pill CTA button** — "Set up your node →" matching elacitylabs.com brand
- [x] **Simplified node statuses** — merged `stale` into `offline`; activity types simplified to `active`/`occasional`/`idle`
- [x] **Background color `#171717`** for header, footer, nodes card (matching elacitylabs.com cards)
- [x] **Elacity Labs logo** in header (links to elacitylabs.com) + footer
- [x] **Favicons** generated from Elacity Labs logo with dark background
- [x] **Full SEO overhaul:**
  - Title: "ElastOS World Computer Network — Live Node Map | Elacity"
  - Rich meta description, keywords, canonical URL
  - Open Graph + Twitter `summary_large_image` with `og-map.png` social card
  - 3x JSON-LD schemas: WebApplication, Organization, Dataset
  - `<noscript>` fallback content for JS-disabled crawlers
  - SEO text section below node table with dynamic stats
  - `robots.txt` (allowing GPTBot/CCBot), `sitemap.xml` (hourly changefreq)
  - GA4 analytics (`G-QW5NN8K9DS`) + Google Search Console verification
  - Ecosystem footer links (Elacity Labs, Exchange, Docs, Run a Node)
  - `aria-label` on canvas panels, `role="status"` on stats bar
- [x] **Mobile fixes** — orb fills panel (absolute positioning), no horizontal page scroll, node ID truncation
- [x] **App icon fixes** — regenerated base64 icons for Elacity Market and Player, removed desktop shortcuts
- [x] **Deployed** to InterServer — frontend-only, no server/API/nginx changes

#### PC2 Dev Node (Local)
- Dev node starts with `cd pc2-node && npm run dev` (NOT `npm start` from root, which launches base Puter)
- Accessible at `http://localhost:4200/`

#### `@elacity-js/access` — Universal Access Layer (IMPLEMENTED, Mar 13)

Full technical spec at `docs/core/ACCESS_PACKAGE_SPEC.md`. Key decisions:

- **Clean-room build** — built from scratch using Lit Protocol SDK directly, NOT extracted from media-player's 4.5MB minified bundle
- **Two encryption paths** — CENC-compatible `acquireLicense()` for media-player backward compat + AES-GCM `encryptBuffer()`/`decryptBuffer()` for non-media assets
- **Browser + Node.js** — dual entry points (`@elacity-js/access` for browser, `@elacity-js/access/node` for server-side)
- **Capsule-ready** — stateless, no singletons, separated verify/acquire/decrypt operations, extensible types for Runtime capability tokens
- **Security model** — key transits JS (same as today's player, Widevine L3 equivalent). Non-media files are raw after decrypt (by design — matches Steam/Adobe model). Runtime v2 capsule sandbox closes this gap.
- **No COOP/COEP needed** — non-media assets use WebCrypto (no WASM, no SharedArrayBuffer), can decrypt server-side on PC2 node. No popup windows.
- **Creator + Consumer** — same package handles both encryption (creator side) and decryption (consumer side)
- **Contract ABIs** — `packages/access/src/contracts/` contains DigitalAsset, CoreStorage, ChannelCore ABIs + Base contract addresses + opRawData/sellRawData encoding helpers
- **On-chain minting — VERIFIED WORKING** — Creator Dashboard integrates full `mint(string,uint16,bytes,bytes)` on Channel contract with correct `opRawData`/`sellRawData` encoding. Paid mint (opType=2 buy_and_resell) verified on public Elacity channel with BaseScan confirmation: AccessToken (10k copies), RoyaltyShare (95% creator / 5% Elacity at `0xCE4639...`), DistributionRight sub-tokens all minted correctly. OperativeBuyableSellable contract deployed at tx `0x26d40e78...`.
- **Operative approval** — `setApprovalForAll(gateway, true)` on the Operative contract. Event parsing uses `ContractCreated` event from factory as fallback (channel proxy emits non-standard event signatures).
- **Channel creation — WORKING** — `createChannel()` on ChannelCore (`0x6a3f7780...`) with metadata IPFS directory, 95/5 royalty split, and auto-grant of `MINTER_ROLE` to creator. Backend registration via GraphQL mutation to `base.ela.city/api/2.0/graphql`.
- **IPFS directory upload** — `POST /api/storage/ipfs/add-directory` creates proper UnixFS directory CIDs so `{dirCID}/metadata.json` resolves on any gateway. Matches Elacity's `X-Target-Flow: dir,ipfs` pattern.
- **Consumer decryption** — `acquireKey()` with SIWE-signed Lit session + `decryptWithLit()` for full Lit decrypt; `decryptWithKey()` for local AES-GCM; `fetchAndDecrypt()` combining IPFS fetch + Lit decrypt

**Two distinct pipelines (coexisting):**
- **Media** (video/audio): Existing Elacity CENC DRM pipeline (backend transcode → DASH → license server). We do NOT touch this.
- **Non-media** (documents, images, 3D models, code, datasets, apps): Server-side Lit Protocol encryption (via pc2-node) → Elacity IPFS → on-chain mint → Lit decrypt. This is what `@elacity-js/access` handles.

**Server-side Lit Protocol (Mar 13-14):**
- Lit operations moved to pc2-node backend due to iframe sandbox blocking outbound Lit node connections
- `POST /api/storage/lit/encrypt` — encrypts content with Lit Protocol using server-side LitNodeClientNodeJs
- `POST /api/storage/lit/decrypt` — decrypts via Lit Action `executeJs()` with on-chain access verification
- Capacity Credits: Auto-detected from Chronicle Yellowstone — queries RLI contract for latest non-expired token owned by capacity wallet `0x581D4bca...`
- Delegation: Owner-signed `createCapacityDelegationAuthSig` on backend (not end-user signed)
- **Blocking:** Waiting for private key of capacity wallet `0x581D4bca99709c1E0cB6f07c9D05719818AA6e49` from Irzhy

**Lit Action Trust Model (Mar 14) — KEY ARCHITECTURE:**
- Custom Lit Action (`pc2-node/data/lit-actions/non-media-decrypt.js`) runs on 6+ Lit TEE nodes
- **Self-referential-only conditions** at encrypt time (`:currentActionIpfsId === ourCID`)
- Access check embedded in action code: `hasAccessByContentId(buyerAddress, kid)` via ethers.js on Lit nodes
- `buyerAddress` passed as jsParam (not `:userAddress` which would resolve to server wallet)
- Smart Account aware — passes SA address when buyer uses Universal Account
- Server reads action code from disk, passes via `code` parameter (bypasses IPFS gateway fetches)
- Capacity token ID auto-detected from Chronicle Yellowstone chain (handles 15-day rotation cycle)

**Elacity IPFS Pipeline (Mar 13-14) — KEY BREAKTHROUGH:**
- Local IPFS (Helia) + Elacity IPFS (`POST /api/2.0/files/upload` with `X-Target-Flow: ipfs`) dual-upload
- Uses raw file CIDs from Elacity (CIDv0/base58) for all public references (tokenURI, asset.cid)
- `POST /api/storage/ipfs/upload-elacity` endpoint on pc2-node proxies uploads to Elacity's IPFS
- Solved: CIDv0 vs CIDv1, directory wrapping, chunking differences between Helia and go-ipfs

**Metadata format (fixed Mar 14):**
- `image` field: auto-generated 400px JPEG thumbnail, uploaded to Elacity IPFS
- `properties.authority`: resolved from channel's `authority()` function (AuthorityGateway address)
- `properties.categories`: array matching asset category
- Without these, Elacity's GraphQL strict schema rejects the asset (`LedgerTokenMetadata.image!`, `LedgerTokenProperties.authority!`)

**On-chain verification:**
- **First paid mint (Mar 13):** tx `0x26d40e78...` on public Elacity channel `0x2fb53d4a...`
  - Operative: `0xf2359397...` (OperativeBuyableSellable)
  - Sub-tokens: AccessToken (id=1, 10k), RoyaltyShare (id=2, 950→creator + 50→Elacity), DistributionRight (id=3)
- **Marketplace-visible mint (Mar 14):** Channel `0xb4a1c563...` (user-created)
  - Operative: `0x7D243806...`
  - Asset CID: `QmSZuxhtcmXtWP465tYGqhs7Bu7bpRXCCaGhxFi63iPNUb`
  - Metadata CID: `QmUsR7um7f8KvWMbdKGMxhiuwUceLXDLxzZhrNc7FjtkP1`
  - **Visible on base.ela.city** — detail page loads with thumbnail, metadata, operative info
- **First purchase (Mar 14):** tx `0xfbfe054a...` via Universal Smart Account
  - Buyer `0x7efe9dd2...` received resale token (#1) + ACCESS_TOKEN (#3)
  - 0.01 USDC paid: 0.0095→creator, 0.0005→Elacity
  - 0.294864 USDC gas fee to Particle/UniversalX paymaster (`0xBeb44C79...`)
  - Transaction succeeded on-chain despite UI `TypeError` in Elacity's `UAReceiptFetcher.enrichOperationsWithContracts`
- User-created channels: `0x13446a6a...`, `0xb4a1c563...` (via ChannelCore.createChannel)

**Key contract addresses (Base 8453):**
- CoreStorage: `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575`
- AuthorityGateway: `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29`
- ChannelCore: `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6`
- Elacity royalty (assets): `0xCE4639Aa1E47E400683F49d95025475D5F50192d`
- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- OperativeBuyable factory: `0x4A49A185c4bD77f037cE4f9fE788fc95ec8f3123`
- OperativeBuyableSellable factory: `0x50002734a4546Ca153BF8b4cC703Fc53Ba90eb9f`

**Tiered marketplace approach:**
- **Tier 1 (days):** E-books, photos, audio, templates, fonts, 3D models — just encrypt/upload/download
- **Tier 2 (weeks):** AI models (GGUF → Ollama), code packages, datasets, PC2 dApps — need local runtime integration
- **Tier 3 (months):** Software licensing, API marketplace, agent marketplace — need capsule sandboxes / Runtime v2

**Implementation branch:** `feature/ddrm-universal-access-layer` (branched from `feature/elacity-ddrm-marketplace`)

**Testing status (updated Mar 14):**
- [x] Lit Protocol production connectivity — **WORKING** via server-side pc2-node backend (capacity credits + delegation)
- [x] Paid mint on user-created channels — **VERIFIED WORKING** (channel `0xb4a1c563...`, operative `0x7D243806...`)
- [x] Integration with Elacity Market dApp backend (asset visibility after mint) — **VERIFIED** (visible on base.ela.city + channel page)
- [x] On-chain purchase — **VERIFIED** (buyer received ACCESS_TOKEN + resale token, payment split correct)
- [x] Consumer decrypt endpoint — `POST /api/storage/lit/decrypt` on pc2-node with Lit Action `executeJs()`
- [x] Lit Action trust model — self-referential conditions, access check in action code, Smart Account aware
- [x] Capacity credit auto-detection — queries Chronicle Yellowstone for latest valid RLI token
- [x] Inline image rendering — decrypted content rendered as blob URL in Market dApp
- [x] Gateway approval retry — 5s delay after mint, try-catch wrapper, "Fix Gateway Approval" tool in Creator
- [x] Decrypt race condition fix — `ensureRawMetadata()` fetches IPFS metadata synchronously before decrypt
- [x] **End-to-end decrypt test with capacity credits** — **WORKING** (Test 13 image, Test 14 PDF — Lit Payment Delegation via Relayer API)
- [x] Fix library showing purchased assets — **FIXED** (Smart Account address used for library query)
- [ ] Purchase with standard wallet (MetaMask) — to isolate UA receipt parsing bug
- [x] Two-layer encryption — AES-GCM file encryption + Lit CEK encryption (bypasses 4MB Lit message limit)
- [x] Lit Payment Delegation — auto-registration of PC2 server wallet via Relayer API (.lit-relayer-config)
- [x] Pinata-backed Lit Action — self-referential conditions with IPFS CID (QmVMgKMKFELHTZf8PmD58nYBhr4S5DHLpuwFTvyDKLPXgq)
- [x] Secure viewer pipeline — server-side rendering for images (Sharp), PDFs (PDF.js + Canvas hybrid), text (Canvas)
- [x] PDF hybrid text rendering — getTextContent() overlay for Node.js (PDF.js can't render font outlines in node-canvas)
- [x] Auto-decrypt on open — owned assets automatically start decrypting when detail view opens
- [x] Parallel PDF page loading — all pages fetched simultaneously with placeholder slots
- [x] Loading overlay — spinner shown in media area during decryption
- [x] PDF thumbnail generation — POST /api/storage/thumbnail endpoint for Creator app
- [x] Security: buffer zeroing, no-cache headers, right-click/drag disable, blob URL revocation, lossy JPEG conversion
- [x] Text file (.txt) secure viewer — verified working with scrollable container (Mar 15)
- [x] Optional thumbnail picker — user-selected thumbnail (max 2MB) with auto-generated fallback for images, PDFs, and text files (Mar 15)
- [x] Text file auto-thumbnail — server-side 400x300 text preview via /api/storage/thumbnail (Mar 15)
- [x] Bug fix: MetaMask "Estimated changes: Unavailable" — pre-estimate gas + chain switch settle delay (Mar 15)
- [x] Bug fix: Library cache not refreshing after purchase — immediate + delayed cache invalidation (Mar 15)
- [x] Thumbnail API fix — strip data URI prefix for clean base64 upload to Elacity IPFS (Mar 15)
- [x] **WASM Renderer** — Rust crate (`wasm-renderer/`) compiled to `wasm32-wasip1`, renders text→image inside WASM linear memory (Mar 15)
- [x] **WASMRuntime.ts** — Node.js WASI host (888 lines) using `@wasmer/wasi` + MemFS for file-based I/O with WASM module (Mar 15)
- [x] **dDRM Viewer app** — dedicated PC2 app (`data/test-apps/ddrm-viewer/`) with dark UI, two display modes (image centered, document full-width scrollable), renderer/watermark badges, anti-piracy measures (Mar 15)
- [x] **dDRM Viewer windowing** — launches as native PC2 UIWindow (iframe) via IPC `postMessage` → `launch_app()`, NOT browser popup (Mar 15)
- [x] **.ddrm.json capsule format** — descriptor files for non-media assets containing encryptedDataCid, kid, litCiphertext, mimeType, etc. Saved to Documents folder (Mar 15)
- [x] **GUI file type integration** — `.ddrm.json` icon (indigo shield), MIME registration (`application/x-ddrm+json`), double-click opens dDRM Viewer (Mar 15)
- [x] **Market "Open" button** — launches dDRM Viewer from asset detail view via IPC (Mar 15)
- [x] **IPC.js args forwarding** — `launchApp` handler passes structured `args` and `windowTitle` to `launch_app()` (Mar 15)
- [x] **PDF scrollable view** — all pages stacked vertically with scroll, replacing single-page arrow navigation (Mar 15)
- [x] **Text full-width view** — rendered text image fills window width for readability (Mar 15)
- [x] **PC2 Media Runtime** — Rust WASM `cenc-decrypt` crate (AES-128-CTR per-sample, 16-byte IVs), MSE player (no EME/CDM), DRM stripping (init+segment), two-phase Lit auth, SA-aware PSSH selection. **End-to-end DASH video playback verified** *(completed Mar 16)*
- [x] Lit Chipotle migration — Phases 0-5 complete (Mar 13-17). `chipotle-client.ts` replaces Lit SDK. `LIT_BACKEND=chipotle|datil` feature flag. **E2E round-trip verified** (Mar 17): encrypt + decrypt + plaintext match confirmed.

#### Media Encoding Pipeline — WORKING (Pending Lit API Recovery) (Mar 17-18)

Built a complete local media encoding pipeline for the Creator Dashboard. Video/audio files uploaded by creators are transcoded, fragmented, CENC-encrypted, and packaged as DASH streams — all on the local PC2 node, no cloud dependency.

**Key components built:**
- `pc2-node/src/services/media/encoder.ts` — FFprobe analysis, transcode plan builder, FFmpeg execution. Adapts to hardware: NVIDIA GPU (av1_nvenc), SVT-AV1 (libsvtav1), x264 fallback. Audio-only path. Concurrency guard.
- `pc2-node/src/services/media/bento4.ts` — Bento4 SDK management: discovers local installs or auto-downloads per-platform (linux-x64, darwin-x64, darwin-arm64). Manages `mp4fragment`, `mp4encrypt`, `mp4dash` binaries. Requires Python 3.
- `pc2-node/src/services/media/dashPackager.ts` — Orchestrates DASH packaging: CEK generation (16-byte random), CEK encryption via Chipotle Lit Action, PSSH construction (Elacity custom system ID + dDRM metadata), mp4dash execution, IPFS upload via Helia `storeDirectory()`. Includes 5-attempt retry with exponential backoff for Lit API transient failures.
- `pc2-node/src/api/media.ts` — Extended with `POST /api/media/encode` (multipart upload via Multer disk storage) and `GET /api/media/encode/status/:jobId` (polling). `runEncodePipeline` orchestrates encoder→bento4→dashPackager. Best-effort replication to Elacity IPFS for multi-node discoverability.
- `pc2-node/src/api/rate-limit.ts` — Added `media_encode` scope (5 jobs/hour/wallet)
- `pc2-node/src/api/audit.ts` — Added `media_encode` action to audit trail

**Creator Dashboard UI (media-specific):**
- File type detection (`video/*`, `audio/*`) with `isMediaFile` flag
- 4 GB max file size for media (vs standard limit for other assets)
- Large files skip FileReader (no browser memory loading)
- Purple gradient "Media Encoding Pipeline" badge on file selection
- Dynamic button text: "Encode, Upload & Mint" for media
- Detailed sub-step progress panel: Analyze → Transcode → Fragment → CENC Encrypt → IPFS Upload
- Each sub-step has inline progress bar (green when done, purple when active, red on error)
- Live transcoding stats: speed multiplier, FPS, elapsed time
- Weighted progress calculation across pipeline stages
- Fast-transition handling: marks all prior sub-steps as done when new stage detected between polls

**Chipotle media encryption:**
- `pc2-node/data/lit-actions/media-encrypt-chipotle.js` — Lit Action for encrypting 16-byte CENC CEK via PKP-AES
- `pc2-node/data/lit-actions/media-decrypt-chipotle.js` — Lit Action for decrypting CEK with on-chain access check
- `recoverMediaCEK()` in media.ts updated for `litBackend: 'chipotle'` — direct CEK recovery (no ECDH envelope)
- PSSH includes `litBackend` field for per-asset backend tracking

**IPFS integration:**
- `uploadDashToIPFS()` uses Helia `storeDirectory()` for correct UnixFS directory CIDs
- `pinRemoteCID()` enhanced: local `fs.stat()` check for directories, instant recursive fetch for already-local content
- Best-effort replication of individual DASH files to Elacity IPFS gateway for multi-node reachability

**Critical bug fix — Duplicate wallet signatures (IPC):**
- Root cause: Both `src/gui/src/IPC.js` and `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` independently listened for `pc2-wallet-rpc` messages and forwarded them to `window.ethereum`
- Every wallet interaction (SIWE login, mint, approval, chain switch, play signatures) was sent to MetaMask TWICE ("1 of 2" popups)
- Fix: `IPC.js` now explicitly ignores `pc2-wallet-rpc` and `pc2-wallet-ready` messages, deferring solely to `pc2-wallet-bridge.js`
- Documentation warning added to `pc2-wallet-bridge.js` header

**Other fixes:**
- Removed explicit gas estimation from Creator `sendTx()` — MetaMask handles internally (fixed "Network fee: Unavailable" and "likely to fail")
- Chain switch check before `wallet_switchEthereumChain` — prevents unnecessary MetaMask popup if already on Base
- Market `handlePlay` skips `Wallet.signMessage` when `siweMessage` is null (Chipotle mode)
- Market `onAccountChange` deduplication — prevents double SIWE login
- `EncodeJob` interface returns `dataToEncryptHash` and `ciphertext` for correct minting `contentId`

**Current status:** Pipeline works end-to-end through transcoding, fragmenting, and IPFS upload. CENC encryption step blocked by Lit Chipotle API outage (Phala TEE backend TLS failure). Retry mechanism in place — will recover automatically when Lit infrastructure comes back.

**Known issues:**
- Elacity frontend UA receipt parsing: `UAReceiptFetcher.enrichOperationsWithContracts` throws `TypeError` after successful on-chain purchase. Bug is in Elacity's frontend, not our code.
- MPD parser error for image assets: Elacity's media player tries to parse image metadata as DASH manifest. Expected for non-video content.
- Lit Datil deprecation: Datil network being deprecated ~April 25, 2026 in favor of Chipotle (REST API, API key auth, TEE-based). Migration required.

#### PC2 Media Runtime — WORKING END-TO-END (Mar 15-16)

Built a complete server-side DASH/CENC media decryption pipeline for PC2. Elacity's existing player relies on browser-native DRM (EME/CDM + SharedArrayBuffer) which can't work inside PC2's sandboxed iframes. The PC2 node now intercepts encrypted DASH streams, decrypts them server-side, strips all DRM signaling, and streams clear content to a lightweight MSE-based JavaScript player.

**Two WASM runtimes (both running):**
- **`ddrm-renderer`** — Non-media assets (images, PDFs, text). Decrypts and renders to pixels server-side.
- **`cenc-decrypt`** (NEW) — Media (video/audio). Rust crate → `wasm32-wasip1`. Parses fMP4 box structure (moof/trun/senc), performs per-sample AES-128-CTR decryption per CENC standard. CEK never leaves WASM linear memory.

**Key components built:**
- `pc2-node/src/api/media.ts` — Three endpoints: `/api/media/prepare-auth` (Lit SIWE flow), `/api/media/init` (MPD parse + CEK recovery via Lit Protocol), `/api/media/segment` (fetch encrypted segment from IPFS → WASM decrypt → strip DRM → stream clear content)
- `pc2-node/crates/cenc-decrypt/` — Rust CENC decryptor (mp4box parser, senc/trun/tenc extraction, AES-128-CTR per-sample decrypt with correct 16-byte IV support)
- `pc2-node/data/test-apps/pc2-media-runtime/` + `data/installed-apps/pc2-media-runtime/` — Lightweight MSE player (no SharedArrayBuffer, no EME, no CDM)
- `pc2-node/src/services/media/sessionManager.ts` — In-memory session store (CEK + MPD + init segments)
- `pc2-node/src/services/media/mpdParser.ts` — DASH MPD XML parser
- `stripEncryptionSignaling()` — Rewrites init segments: `encv→av01`, `enca→mp4a`, removes `sinf`/`pssh`, adjusts all ancestor box sizes
- `stripSegmentEncryptionBoxes()` — Removes `senc`/`saiz`/`saio` from media segments, fixes `trun.data_offset`
- Smart Account detection via Base factory contract for SA-aware PSSH selection
- Two-phase Lit auth: server prepares SIWE + ReCap, user signs in market app, runtime relays to init

**Verified:** First successful end-to-end playback of Elacity DRM-protected DASH video inside PC2 (AV1 codec, AAC audio, 33.8s duration, 16-byte CENC IVs).

#### PC2 Media Runtime — Player Improvements (Mar 16)

Comprehensive player hardening and UX polish:

**Short-term runtime improvements (all completed):**
- [x] **Session expiry handling** — server returns 410 on expired sessions, client transparently re-authenticates (wallet sign → re-init → retry segment). Idle timeout (2h inactivity) instead of absolute TTL. Concurrency guards + refresh limit.
- [x] **Audio-only & video-only support** — music note placeholder UI for audio-only DASH content, graceful degradation when video track missing.
- [x] **Seek into unbuffered regions** — server provides `segmentStarts` array per track. Client maps time→segment, flushes MSE buffers, re-appends init segments, fetches from new position. Works with both seek bar and keyboard shortcuts.
- [x] **Adaptive bitrate switching (ABR)** — bandwidth measurement via segment fetch timing (harmonic mean), conservative quality selection algorithm (30% headroom for upgrade, 8s cooldown), seamless init-segment swap for quality transitions. Gear icon UI with auto/manual quality selection.

**UI/UX improvements (all completed):**
- [x] YouTube-style keyboard shortcuts (Space/K=play, J/L=±10s, arrows=±5s, F=fullscreen, M=mute, up/down=volume)
- [x] Click-to-play on video area
- [x] Buffering indicator overlay (spinner)
- [x] Auto-hide controls with cursor hiding (3s idle)
- [x] Buffer eviction (30s behind playback)
- [x] Segment retry with exponential backoff (3 attempts)
- [x] 20-second buffer-ahead window
- [x] Enhanced error messages for MediaError codes
- [x] Elacity brand colors (#3b82f6 accent, #262626 controls bg)
- [x] Quality selector gear icon with dropdown menu (auto + manual quality options)

**Known gotcha:** Puter UIWindow clips bottom ~3-4px of iframe content. Fixed with asymmetric padding (`6px 16px 10px`). Documented in `docs/wiki/Technical/PUTER_WINDOW_GOTCHAS.md`.

#### WASM Renderer Hardening + Viewer UX (Mar 16)

**WASM renderer now handles ALL static content types inside WASM linear memory:**
- [x] **PDF rendering in WASM** — `hayro` pure-Rust PDF rasterizer (replaced `lopdf` which crashed in WASM). Full-fidelity rendering: layout, fonts, tables, images. WASM binary: 2.7MB → 5.8MB.
- [x] **Code syntax highlighting** — `syntect` crate (Sublime Text grammars) for 30+ language MIME types (`application/javascript`, `text/x-python`, `text/css`, etc.). Dark editor theme (base16-ocean.dark), line numbers, per-token coloring.
- [x] Images: already in WASM (image crate). Text: already in WASM (bitmap font).
- [x] `storage.ts` routing updated: `wasmCodeTypes` array for `application/*` code MIME types.
- [x] Fixed WASI compilation target — `wasm32-wasip1` (was `wasm32-unknown-unknown`, caused "WASI version could not be determined" error).
- [x] Fixed Node.js canvas text fallback — proper word wrapping, 640px width, 2000 line limit.
- [x] Added lowercase bitmap glyphs (a-z) to WASM text renderer.
- [x] **"Mint on Elacity"** right-click context menu for non-dDRM files, launches `elacity-creator` with file pre-loaded.
- [x] Restored `pc2-wallet-bridge.js` and `pc2-wallet-provider.js` (deleted in prior commit), fixed Particle smart wallet.
- [x] Applied Elacity Market brand blue (`#3b82f6`) to dDRM Viewer accent elements.

**dDRM Viewer UX enhancements (all completed):**
- [x] **Image zoom/pan** — CSS-based zoom (`+`/`-`/`0` keyboard, Ctrl+scroll wheel), drag-to-scroll panning when zoomed, center-stable zoom transitions.
- [x] **Document zoom + page navigation** — zoom applies to stacked page images, prev/next buttons, page indicator (`1 / N`), scroll-position tracking, PageUp/Down/Home/End keyboard shortcuts.
- [x] **Floating toolbar** — semi-transparent glassmorphism bar (zoom controls, page nav, fullscreen toggle), auto-hide after 3s idle, show on mousemove, stays visible on hover.
- [x] **Audio player** — new audio display mode with play/pause, seek bar, volume control, time display. Server-side `secure-view` endpoint extended with audio passthrough (decrypt + pass through bytes with original MIME). HTML5 `<audio>` element with blob URL.
- [x] **Fullscreen toggle** — `F` key or toolbar button.

**Security status after hardening:**
| Content Type | WASM (plaintext in sandbox) | Node.js fallback |
|---|---|---|
| Images | Primary path | Sharp (on WASM failure) |
| Text | Primary path | Canvas (on WASM failure) |
| PDF | Primary path (text extraction) | PDF.js + Canvas |
| Code | Primary path (syntect highlighting) | Falls through to text |
| Audio | N/A (passthrough) | Decrypt + pass through |

#### Next Up — Engineering Priorities
1. ~~**Lit Chipotle migration**~~ — **DONE (Mar 13-18)** — Phases 0-5 complete. Migrated to new `chipotle-dev` network. All Lit Action CIDs registered. Pinned encrypt action (`non-media-encrypt-chipotle.js`). Auto-provisioning from supernodes built. **E2E verified** (PDF, image, text — all decrypt via Chipotle on new platform).
2. ~~**End-to-end testing**~~ — **DONE (Mar 18)** — Full Creator mint → buy → dDRM Viewer decrypt verified on new Lit dev network. WASM rendering, watermarks, on-chain access check all confirmed working.
3. **Deploy supernode provisioning** — `/api/ddrm/provision` endpoint coded but NOT deployed to supernodes. See `docs/core/LIT_PRODUCTION_CHECKLIST.md` for deployment steps. **This is a v1.2.0 release blocker.**
4. **Media pipeline on Chipotle** — Full encoding pipeline built and tested (transcode, fragment, IPFS upload all working). CENC encryption blocked by Lit Chipotle API outage (Phala TEE backend). Retry mechanism in place (5 attempts, exponential backoff). Will complete E2E once Lit recovers. See media encoding pipeline section above.
5. **P-256 ECDH unwrap to WASM (Phase E)** — conditional on Chipotle envelope format. If Chipotle returns CEK directly, this phase is eliminated.
6. **`cenc-encrypt` Rust WASM crate** — Symmetric counterpart to `cenc-decrypt`. AES-128-CTR encryption in WASM, replaces `mp4encrypt` Bento4 binary. Uses identical crypto primitives from `cenc-decrypt/cenc.rs`. Target: `wasm32-wasip1`.
7. **`pssh-gen` Rust WASM crate** — PSSH box generator per ISO 23001-7. Produces binary PSSH boxes from Elacity dDRM metadata. Replaces JSON-based approach in `dashPackager.ts`.
8. ~~**WASM crypto hardening (Phases A-C)**~~ — DONE (Mar 16). Branch: `feature/wasm-crypto-hardening`.
9. ~~**WASM renderer hardening**~~ — DONE (Mar 16) — PDF, code, images, text all render inside WASM.
10. ~~**Viewer UX enhancements**~~ — DONE (Mar 16) — zoom, pan, page nav, audio player, toolbar.
11. **On-chain indexer prototype** — replace Elacity GraphQL dependency with event scanner (The Graph / custom)
12. **Self-provisioned RLI tokens** — each node mints own capacity credits, removes Elacity wallet dependency
13. **AI Model Marketplace alpha** — first non-media vertical: GGUF → encrypt → IPFS → ACCESS_TOKEN → decrypt → Ollama
14. **dApp Store** — global decentralized app marketplace. DeFi protocols (Uniswap, Aave), games, productivity tools packaged as encrypted dApps. Purchase → decrypt → run locally on PC2 node. See `docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md`.
15. **ElastOS Runtime convergence** — CTO's Runtime at RC4 (0.19.0-rc4). WASM + microVM capsule execution verified. dDRM WASM crates (`aes-gcm-decrypt`, `cenc-decrypt`) target same `wasm32-wasip1` as Runtime's Wasmtime. Convergence path: our renderers become capsules, dDRM becomes a Provider Capsule. See `docs/core/ARCHITECTURE_CONVERGENCE.md`.

#### WASM Crypto Hardening — COMPLETED Phases A-C (Mar 16)

Branch: `feature/wasm-crypto-hardening` (from `feature/ddrm-universal-access-layer` at `e05f1468e`)
Task plan: `.cursor/tasks/WASM-CRYPTO-HARDENING/WASM-CRYPTO-HARDENING.md`

**Phase A: Build Infrastructure + AES-GCM Decrypt-Only — DONE**
- `wasm32-wasip1` added to `rust-toolchain.toml`
- `pc2-node/scripts/build-wasm.sh` — builds all WASM crates, copies to `wasm-apps/`
- `decrypt_only` mode in `ddrm-renderer` WASM — AES-GCM decrypt inside WASM linear memory, CEK never in Node.js
- `executeDecryptOnly()` in `WASMRuntime.ts` — new orchestration method
- `decryptAssetTwoLayer()` in `storage.ts` refactored: WASM path for files ≤50MB, Node.js fallback for larger
- Benchmarked: 50MB threshold set based on MemFS overhead

**Phase B: fMP4 Strip + Decrypt Combined — DONE**
- `strip.rs` — Rust port of `stripEncryptionSignaling` + `stripSegmentEncryptionBoxes` with 64-bit extended box support
- `strip_init` mode in `cenc-decrypt` — strip only, no decrypt (for init segments)
- `strip: true` flag in `cenc-decrypt` — combined decrypt+strip in single WASM call
- `media.ts` refactored: `stripInitViaWASM()` + `decryptSegmentViaWASM()` with `strip: true`
- JS strip functions commented out (kept for one release cycle as safety net)

**Phase C: PDF Text Extraction Spike — DONE (no implementation)**
- `hayro-syntax` can parse PDF content stream operators (Tj/TJ) but lacks font-to-Unicode CMap resolution
- Text extraction not viable without significant work — keeping `pdfjs-dist` for indexing
- Documented findings, phase closed

**Phase D: Lit Chipotle Migration — COMPLETE (Mar 13, new branch)**

Branch: `feature/lit-chipotle-migration` (from `feature/wasm-crypto-hardening`)

**Phase 0: API Compatibility Testing — PASS (5/5)**
- Chipotle dev API reachable, inline code execution works
- Usage key (`pc2-nodes-shared`) authenticates; account key is dashboard-only
- TEE makes external RPC calls (Base mainnet) — `hasAccessByContentId` works
- `ipfs_id` not supported (422) — must send inline `code` field
- ethers v5 in TEE requires `toLowerCase()` before `getAddress()` for mixed-case addresses
- Test script: `pc2-node/scripts/test-chipotle-phase0.mjs`

**Phase 1: chipotle-client.ts — NEW FILE**
- `pc2-node/src/api/chipotle-client.ts` — minimal REST client replacing entire `@lit-protocol/*` SDK
- Three-tier API key: `data/.chipotle-user-key` (Tier 2) > `data/.chipotle-api-key` (Tier 1) > hardcoded default
- `recoverNonMediaCEK()`, `recoverMediaCEKEnvelope()`, `encryptWithLitAction()`
- `buildSelfRefConditions()`, `getChipotleInfo()`, `saveUserApiKey()` / `clearUserApiKey()`

**Phase 2: storage.ts decrypt + encrypt migrated**
- `recoverCEKAndFetchData()` → calls `recoverNonMediaCEK()` from chipotle-client
- `/lit/encrypt` route → calls `encryptWithLitAction()` (no `client.encrypt()`)
- IPFS fetch logic unchanged

**Phase 3: media.ts CEK recovery migrated**
- `recoverMediaCEK()` → calls `recoverMediaCEKEnvelope()` + local ECDH unwrap
- `fetchLitActionCode()` — fetches media Lit Action JS by IPFS CID (Chipotle requires inline code)
- `prepare-auth` returns stub in Chipotle mode (no SIWE needed)

**Phase 5: Feature flag + dual-mode**
- `LIT_BACKEND=chipotle` (default) — Chipotle REST API
- `LIT_BACKEND=datil` — full Datil SDK (WebSocket, SIWE, capacity credits)
- Both paths operational — all Datil functions remain intact for rollback
- `/lit/server-info` reports active backend + tier info

**Chipotle Dashboard Setup (updated Mar 18 — new dev network):**
- Dashboard: `https://dashboard.dev.litprotocol.com/`
- Account key: *(stored locally in `data/.chipotle-account-key`, never committed)*
- Usage key (Tier 1): *(stored locally in `data/.chipotle-api-key`, never committed)* (key name: `pc2-ddrm-v3`, scoped to `elacity-ddrm` group)
- Group: `elacity-ddrm` (group_id: 1) with encrypt + decrypt CIDs registered
- PKP: `0x09bdfc8f8ec5a3bd2970497b930bd94839f22227` (Account Master Wallet, added to group via REST API)
- IPFS Actions registered: `QmUdZUxe6BVoXiZcw4hE86YCHsgQVGEmgbN6sr7MhnL8pp` (encrypt), `QmfWksjQkuLxVGEZdHrbFKxUb2sL4K34bLYbD3mAKv2CZA` (decrypt)
- Auto-provisioning: coded in `chipotle-client.ts`, gateway endpoint in `deploy/web-gateway/index.js` (**NOT deployed yet**)
- Full details: `docs/core/CHIPOTLE_HANDOVER.md`

**Remaining items:**
- Deploy updated `non-media-decrypt.js` to IPFS (new CID due to ethers v5 fix)
- Test media Lit Action on Chipotle TEE (ECDH envelope format)
- `packages/access` Chipotle compatibility (Phase 4)
- Settings UI for Tier 2 user-provided API key (Phase 5b)
- LITKEY cost analysis for 100+ node network

**CRITICAL FINDING (Mar 17 — RESOLVED):**
Chipotle TEE uses a completely different cryptographic model than Datil:
- **Datil**: `Lit.Actions.decryptAndCombine()` — threshold BLS decryption
- **Chipotle**: `Lit.Actions.Decrypt({ pkpId, ciphertext })` — PKP-based AES

Chipotle does NOT have `decryptAndCombine`. Existing Datil-encrypted assets
require Datil backend. **New assets** encrypted with Chipotle use PKP-AES and
are decryptable only via Chipotle. The `litBackend` metadata field tracks which
scheme was used per asset.

**E2E Round-Trip VERIFIED (Mar 17):**
1. PC2 node encrypts file with AES-256-GCM (Layer 1)
2. CEK encrypted via Chipotle `Lit.Actions.Encrypt({ pkpId, message })` (Layer 2)
3. Chipotle TEE recovers CEK via `Lit.Actions.Decrypt({ pkpId, ciphertext })`
4. AES-256-GCM decrypts file → original plaintext matches exactly
5. CEK encoding: clean single-layer base64 (44 chars → 32 bytes)
6. On-chain access check (`hasAccessByContentId`) confirmed working inside TEE

**Dual-mode operation:**
- `LIT_BACKEND=datil` — for existing assets (threshold BLS, Lit SDK)
- `LIT_BACKEND=chipotle` — for new assets (PKP-AES, REST API, no SDK)
- Production recommendation: use `datil` for existing, `chipotle` for new encryption
- `/lit/encrypt` response includes `litBackend` field for per-asset tracking

**Dashboard config (Chipotle — see CHIPOTLE_HANDOVER.md for full details):**
- Dashboard: `https://dashboard.dev.litprotocol.com/`
- Usage API key: `pc2-ddrm-v3` → *(stored in `data/.chipotle-api-key`)*
- Group: `elacity-ddrm` (group_id: 1) with PKP `0x09bdfc8f8ec5a3bd2970497b930bd94839f22227` permitted
- Account key: *(stored in `data/.chipotle-account-key`, dashboard management only)*

Chipotle TEE available `Lit.Actions` methods:
`Decrypt`, `Encrypt`, `getPrivateKey`, `getLitActionPrivateKey`,
`getLitActionPublicKey`, `getLitActionWalletAddress`, `setResponse`

**Phase E: P-256 ECDH to WASM — CONDITIONAL on Chipotle format**

**Files changed (WASM hardening):**
| File | Change |
|------|--------|
| `rust-toolchain.toml` | Added `wasm32-wasip1` target |
| `pc2-node/scripts/build-wasm.sh` | NEW — automated WASM build script |
| `pc2-node/wasm-renderer/src/lib.rs` | `decrypt_only` mode, `process_decrypt_only()` |
| `pc2-node/wasm-renderer/src/main.rs` | `decrypt_only` output path (`/output/decrypted.bin`) |
| `pc2-node/wasm-renderer/src/render/text.rs` | JPEG dim cap (16384px), MAX_LINES recalculated |
| `pc2-node/src/services/wasm/WASMRuntime.ts` | `executeDecryptOnly()` method |
| `pc2-node/src/api/storage.ts` | WASM decrypt path with 50MB threshold, Node.js fallback |
| `pc2-node/crates/cenc-decrypt/src/strip.rs` | NEW — Rust fMP4 box stripping with 64-bit support |
| `pc2-node/crates/cenc-decrypt/src/lib.rs` | `strip_init` mode, `strip: true` flag |
| `pc2-node/src/api/media.ts` | `stripInitViaWASM()`, `loadCENCWasmBinary()`, `strip: true` |
| `pc2-node/wasm-apps/ddrm-renderer/ddrm-renderer.wasm` | Rebuilt |
| `pc2-node/wasm-apps/cenc-decrypt/cenc-decrypt.wasm` | Rebuilt |

#### Bug Fixes — Mar 16

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Double wallet signature (1 of 2) | `pc2-wallet-bridge.js` AND `IPC.js` both handled `pc2-wallet-rpc` messages | Removed `pc2-wallet-bridge.js` script tag from `index.html` — `IPC.js` already handles it |
| Double `eth_sendTransaction` handler | Duplicate handler in `ParticleNetworkContext.tsx` useEffect + switch case | Removed the "early handler" useEffect, kept only switch-case handler |
| WASM text renderer crash (65535px) | Text rendering produced image >65535px tall, exceeding JPEG limits | Capped `JPEG_MAX_DIM` to 16384, `MAX_LINES` recalculated |
| `eth_requestAccounts` unnecessary prompt | Market + player always called `eth_requestAccounts` even when already connected | Use `eth_accounts` first, fall back to `eth_requestAccounts` only if empty |
| Video doesn't autoplay after sign | No `play()` call after initial segments buffered | Added `$video.play()` after `startBufferLoop()` |
| Server restart loses files | Stale `run-selfhosted.js` process held IPFS ports, IPFS init failed, filesystem undefined | Always kill all node processes before restart; verify IPFS + filesystem in logs |

#### Decentralization Analysis — DOCUMENTED (Mar 14)
- [x] `docs/core/DECENTRALIZATION_STATUS.md` — comprehensive team document covering architecture, scorecard, and walk-away test roadmap
- Fully decentralized: smart contracts, access verification, purchase/sale, Lit Action, encryption/decryption, AccessToken ownership
- Centralized (to be replaced): Elacity GraphQL API, IPFS gateway, IPFS upload, capacity wallet, auth nonce
- Walk-away test requires: on-chain indexer (Tier 1), self-sufficient IPFS (mostly done), self-provisioned RLI tokens
- Protocol fees already decentralized — enforced by smart contracts, not infrastructure

#### Backlog — Marketing & Docs (Lower Priority)
- [ ] **PC2 marketing slides for elacitylabs.com** — audit and rewrite 7 slides (benefits, features, blind spots, full copywriting)
- [ ] **QuickStart component for elacitylabs.com** — installation instructions UI including Jetson Nano / ARM device entry
- [ ] **Backlinks from ela.city and docs.ela.city to map.ela.city** — SEO cross-linking between Elacity properties

#### Completed — Previously Next Up
- ~~**Verify community fix**~~ — Werolo and Chelsea confirmed
- ~~**InterServer gateway upgrade to v2.0**~~ — DONE (Mar 8)
- ~~**WireGuard binary bundling (BinaryManager)**~~ — DONE (Mar 8)
- ~~**App registry manifest format**~~ — DONE (Mar 8)
- ~~**Universal asset strategy**~~ — DONE (Mar 8)
- ~~**Network map rebrand, 3D orb, SEO**~~ — DONE (Mar 12-13)
- ~~**`@elacity-js/access` design + spec**~~ — DONE (Mar 13) — full spec, security model, marketplace tiers, runtime convergence
- ~~**`@elacity-js/access` implementation**~~ — DONE (Mar 13) — 12 source files (`packages/access/`), Lit Protocol 7.3.0, 47 unit tests passing

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
- [Network Map + Strategy](d9445cb9-12bd-437e-8d4e-ebb35ef40d64) — network map visual upgrade, universal asset strategy, app manifest spec, binary manager, handover
- [3D Orb + SEO + Rebrand](6431d137-5dd9-4c8e-b042-5d8c54b908a5) — 3D orb integration, network map rebrand to "World Computer", full SEO overhaul, GA4, app icon fixes, mobile responsiveness
- [dDRM Pipeline E2E](fd6755f0-d73c-4e41-8df3-0f57f15071a2) — @elacity-js/access, Creator Dashboard, Lit Action trust model (Path A), capacity credit auto-detection, decrypt endpoint, decentralization analysis. Also: hayro PDF rendering, WASM text fixes, Mint context menu, wallet bridge restore, Elacity branding, WASM crypto hardening Phases A-C, double-signature fix, TXT dimension cap, video autoplay, fMP4 strip+decrypt in Rust
- [Secure Viewer & PDF](fd6755f0-d73c-4e41-8df3-0f57f15071a2) — secure viewer pipeline, PDF hybrid rendering, two-layer encryption fix, Lit Pinata/relayer integration, auto-decrypt, parallel pages, dDRM Viewer app, .ddrm.json capsules, WASM renderer, GUI integration
- [Media Runtime E2E](fd6755f0-d73c-4e41-8df3-0f57f15071a2) — server-side DASH/CENC decryption pipeline, Rust WASM cenc-decrypt crate, MSE player, DRM stripping (init+segment), 16-byte IV fix, Smart Account PSSH, two-phase Lit auth
- [Media Encoding Pipeline](current) — Local media encoding pipeline (FFmpeg→Bento4→CENC→DASH→IPFS), Chipotle CEK encryption, Creator Dashboard media UI, IPC duplicate wallet fix, MetaMask gas estimation fix

---

## Key Documents

| Document | Path | What It's For |
|----------|------|---------------|
| **This file** | `docs/core/SESSION_HANDOVER.md` | Start here |
| **Agent Handover** | `docs/core/AGENT_HANDOVER.md` | Coding patterns, infrastructure |
| **Roadmap** | `docs/core/ROADMAP.md` | All milestones with checkboxes |
| **Architecture** | `docs/core/ARCHITECTURE_CONVERGENCE.md` | PC2 v1 -> capsule runtime v2 |
| **Universal Asset Strategy** | `docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md` | Unicorn strategy, marketplace verticals, SDK evolution, revenue model |
| **Decentralization Status** | `docs/core/DECENTRALIZATION_STATUS.md` | Decentralization scorecard, walk-away test roadmap, team handover |
| **Access Package Spec** | `docs/core/ACCESS_PACKAGE_SPEC.md` | @elacity-js/access technical spec, API, security model, marketplace tiers |
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

### Lit Action (runs on Lit TEE nodes)
| File | Purpose |
|------|---------|
| `pc2-node/data/lit-actions/non-media-decrypt.js` | Trustless on-chain access check + threshold CEK decryption (ethers v5/v6 compatible) |
| `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` | **NEW** — Chipotle-specific: on-chain access check + PKP-AES CEK decryption |

#### Chipotle Migration (Mar 13)
| File | Purpose |
|------|---------|
| `pc2-node/src/api/chipotle-client.ts` | **NEW** — Minimal REST client replacing entire Lit SDK, three-tier API key resolution |
| `pc2-node/scripts/test-chipotle-phase0.mjs` | Phase 0 API compatibility test script (5 tests) |
| `pc2-node/src/api/storage.ts` | Updated — `LIT_BACKEND` flag, decrypt/encrypt dual-mode (chipotle/datil) |
| `pc2-node/src/api/media.ts` | Updated — `LIT_BACKEND` flag, prepare-auth stub, recoverMediaCEK dual-mode |

#### Secure Viewer Pipeline (Mar 15)
| File | Purpose |
|------|---------|
| `pc2-node/src/api/storage.ts` (`/lit/secure-view`) | Server-side asset rendering: Sharp (images), PDF.js+Canvas (PDFs), Canvas (text), WASM fallback |
| `pc2-node/data/test-apps/elacity-market/app.js` | Auto-decrypt, "Open" button for dDRM Viewer, .ddrm.json capsule save, IPC launch |
| `pc2-node/data/test-apps/elacity-creator/app.js` | PDF thumbnail generation via `/api/storage/thumbnail` |

#### dDRM Viewer App (Mar 15)
| File | Purpose |
|------|---------|
| `pc2-node/data/test-apps/ddrm-viewer/index.html` | Viewer HTML — header, loading/error states, image + document containers, footer |
| `pc2-node/data/test-apps/ddrm-viewer/viewer.js` | Client JS — param parsing (puter.args + URL), secure-view API calls, display modes, anti-piracy |
| `pc2-node/data/test-apps/ddrm-viewer/viewer.css` | Dark theme, full-width document scroll, centered image, badges, scrollbar |
| `pc2-node/data/test-apps/ddrm-viewer/app.json` | App manifest — capabilities (wallet, network, IPFS, DRM), display settings |
| `pc2-node/src/api/apps.ts` | dDRM Viewer registration in app map with SVG icon |

#### PC2 Media Runtime (Mar 15-16)
| File | Purpose |
|------|---------|
| `pc2-node/src/api/media.ts` | Media API — prepare-auth, init (MPD+CEK), segment (decrypt+strip+stream) |
| `pc2-node/crates/cenc-decrypt/src/lib.rs` | WASM entry — orchestrates CENC decryption with tenc-derived IV size |
| `pc2-node/crates/cenc-decrypt/src/mp4box.rs` | fMP4 box parser — trun, senc, tenc extraction with correct format header skipping |
| `pc2-node/crates/cenc-decrypt/src/cenc.rs` | AES-128-CTR per-sample decryption (full-sample + subsample support) |
| `pc2-node/wasm-apps/cenc-decrypt/cenc-decrypt.wasm` | Compiled WASM binary (wasm32-wasip1) |
| `pc2-node/data/installed-apps/pc2-media-runtime/` | MSE player app (player.js, index.html) — lightweight, no EME/CDM |
| `pc2-node/src/services/media/sessionManager.ts` | In-memory session store (CEK, tracks, init segments per track) |
| `pc2-node/src/services/media/mpdParser.ts` | DASH MPD XML parser (tracks, segments, duration, codecs) |

#### WASM Renderer (Mar 15)
| File | Purpose |
|------|---------|
| `pc2-node/wasm-renderer/Cargo.toml` | Rust crate — AES-GCM decrypt + image rendering in WASM linear memory |
| `pc2-node/wasm-apps/ddrm-renderer/ddrm-renderer.wasm` | Compiled WASM binary (wasm32-wasip1) |
| `pc2-node/src/services/wasm/WASMRuntime.ts` | Node.js WASI host — @wasmer/wasi + MemFS orchestration (888 lines) |

#### Media Encoding Pipeline (Mar 17-18)
| File | Purpose |
|------|---------|
| `pc2-node/src/services/media/encoder.ts` | FFprobe analysis, transcode plans, FFmpeg execution (GPU/CPU adaptive) |
| `pc2-node/src/services/media/bento4.ts` | Bento4 SDK management — auto-download, platform detection, Python 3 check |
| `pc2-node/src/services/media/dashPackager.ts` | CEK generation, Chipotle encryption, PSSH construction, mp4dash, IPFS upload |
| `pc2-node/src/api/media.ts` | Media encode/status endpoints, `runEncodePipeline` orchestrator, Chipotle CEK recovery |
| `pc2-node/data/lit-actions/media-encrypt-chipotle.js` | Lit Action for CEK encryption via PKP-AES |
| `pc2-node/data/lit-actions/media-decrypt-chipotle.js` | Lit Action for CEK decryption with on-chain access check |
| `pc2-node/data/test-apps/elacity-creator/app.js` | Creator Dashboard with media pipeline UI, progress tracking, sub-step bars |
| `pc2-node/data/test-apps/elacity-creator/index.html` | HTML structure with media pipeline detail panel |

### Backend APIs
| File | Purpose |
|------|---------|
| `pc2-node/src/api/storage.ts` | Lit encrypt/decrypt, IPFS upload, **secure viewer** (image/PDF/text), thumbnail generation, capacity credit auto-detection |
| `pc2-node/src/api/installed-apps.ts` | App install/uninstall/list endpoints |
| `pc2-node/src/services/AppInstallService.ts` | App lifecycle management service |
| `pc2-node/src/static.ts` | Static serving for installed apps with wallet bridge injection |

### GUI (file explorer, IPC)
| File | Purpose |
|------|---------|
| `src/gui/src/helpers/open_item.js` | `.edrm` → player popup; `.ddrm.json` → dDRM Viewer via `launch_app()` |
| `src/gui/src/IPC.js` | `openFolder` handler + `launchApp` handler (forwards args/windowTitle to `launch_app`) |
| `src/gui/src/helpers/item_icon.js` | `.edrm` and `.ddrm.json` custom icons |
| `src/gui/src/helpers/content_type_to_icon.js` | `application/x-ddrm+json` → `file-ddrm.svg` mapping |
| `src/gui/src/lib/mime.js` | `.edrm` and `.ddrm.json` MIME type registration |
| `src/gui/src/icons/file-edrm.svg` | Padlock + green tick icon for media DRM files |
| `src/gui/src/icons/file-ddrm.svg` | Indigo shield icon with "D" badge for dDRM capsule files |

### Creator Dashboard dApp (runs inside iframe)
| File | Purpose |
|------|---------|
| `pc2-node/data/test-apps/elacity-creator/app.js` | Main app — file select, metadata, encrypt, IPFS upload, mint, setApprovalForAll |
| `pc2-node/data/test-apps/elacity-creator/index.html` | HTML structure with 4-step wizard |
| `pc2-node/data/test-apps/elacity-creator/styles.css` | All CSS |

### `@elacity-js/access` SDK (Universal Access Layer)
| File | Purpose |
|------|---------|
| `packages/access/src/client.ts` | Main entry point — connect, encrypt, decrypt, verify, fetchAndDecrypt |
| `packages/access/src/contracts/abis.ts` | DigitalAsset, CoreStorage, ChannelCore, Operative ABIs + Base addresses |
| `packages/access/src/contracts/encode.ts` | opRawData/sellRawData encoding for mint() |
| `packages/access/src/lit/session.ts` | LitNodeClient lifecycle, session sigs, SIWE signing |
| `packages/access/src/lit/key-retrieval.ts` | acquireKey() with getSessionSigs for consumer decryption |
| `packages/access/src/crypto/encrypt.ts` | Lit Protocol encrypt (creator side) |
| `packages/access/src/crypto/decrypt.ts` | decryptWithLit + decryptWithKey (consumer side) |
| `packages/access/src/fetch/ipfs.ts` | IPFS gateway fetch helper |

### Wallet Bridge (injected into all dApp iframes)
| File | Purpose |
|------|---------|
| `pc2-node/frontend/pc2-wallet-bridge.js` | Host-side bridge — listens for postMessage, routes to Particle |
| `pc2-node/frontend/pc2-wallet-provider.js` | Guest-side shim — replaces `window.ethereum` inside iframe |

### Network Map (map.ela.city) — Deployed on InterServer
| File | Purpose |
|------|---------|
| `deploy/network-map/frontend/src/App.jsx` | Main frontend — header, side-by-side orb/graph, stats, SEO section, footer |
| `deploy/network-map/frontend/src/components/force-shield/ShieldScene.jsx` | 3D orb entry point — Three.js canvas, stats overlay |
| `deploy/network-map/frontend/src/components/force-shield/useNetworkNodes.js` | Fetches `/api/nodes` + WebSocket updates, hashes nodeId to lat/lng |
| `deploy/network-map/frontend/src/components/force-shield/consts.js` | API base URLs (relative paths for same-origin) |
| `deploy/network-map/frontend/src/components/NetworkGraph.jsx` | 2D force-directed graph |
| `deploy/network-map/frontend/src/components/NodeList.jsx` | Node table with filters |
| `deploy/network-map/frontend/src/components/StatsChart.jsx` | Stats cards and charts |
| `deploy/network-map/frontend/src/styles.css` | All CSS (bg `#171717`, responsive, `.graph-row` side-by-side) |
| `deploy/network-map/frontend/index.html` | SEO meta, JSON-LD schemas, GA4, favicons |
| `deploy/network-map/frontend/public/` | Favicons, `og-map.png`, `robots.txt`, `sitemap.xml`, GSC verification |
| `deploy/network-map/server/collector.js` | Backend — node status/activity classification |
| `deploy/network-map/server/database.js` | SQLite queries (no more `stale` status) |
| `deploy/network-map/server/api/stats.js` | Stats endpoints (`/api/stats/summary`) |
| `deploy/network-map/server/api/nodes.js` | Nodes endpoint (`/api/nodes`) with CORS |

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
| [pc2.net](https://github.com/Elacity/pc2.net) | `feature/lit-chipotle-migration` | Active development (branched from `feature/wasm-crypto-hardening`) |
| [elastos-launcher](https://github.com/Elacity/elastos-launcher) | `main` | v1.1.1 released |
| [document-portal](https://github.com/Elacity/document-portal) | `main` | Up to date |
| [js-sdk](https://github.com/Elacity/js-sdk) | — | Elacity SDK (reference) |
| [elacity-web](https://github.com/Elacity/elacity-web) | — | Elacity website (reference for patterns) |
