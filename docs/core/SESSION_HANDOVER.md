# Session Handover — Mar 15, 2026

> **Read this first when starting a new agent session.**

---

## Where We Are

**Branch:** `dDRM-extended` (branched from `feature/elacity-ddrm-marketplace` on Mar 13)
**Release:** v1.1.0 tagged and released on 2026-03-03 (134 commits squash-merged to main)
**Launcher:** v1.1.1 released — version display, one-click updates, full networking install
**DAO Proposal:** Live at https://elastos.com/proposals/69a24f49247f130078064edd
**Last Commit:** — feat: secure viewer pipeline, PDF hybrid rendering, auto-decrypt, parallel page loading

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

**Implementation branch:** `dDRM-extended` (branched from `feature/elacity-ddrm-marketplace` on Mar 13)

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
- [ ] Test with text files (.txt) — secure viewer text pipeline untested
- [ ] Lit Chipotle migration — Datil network deprecated ~April 25, 2026, need to migrate to Chipotle REST API

**Known issues:**
- Elacity frontend UA receipt parsing: `UAReceiptFetcher.enrichOperationsWithContracts` throws `TypeError` after successful on-chain purchase. Bug is in Elacity's frontend, not our code.
- MPD parser error for image assets: Elacity's media player tries to parse image metadata as DASH manifest. Expected for non-video content.
- Lit Datil deprecation: Datil network being deprecated ~April 25, 2026 in favor of Chipotle (REST API, API key auth, TEE-based). Migration required.

#### Next Up — Engineering Priorities
1. **Lit Chipotle migration** — CRITICAL. Datil deprecated ~April 25, 2026. Replace v7 SDK with Chipotle REST API.
2. **Test text file (.txt) flow** — secure viewer text pipeline implemented but untested
3. **On-chain indexer prototype** — replace Elacity GraphQL dependency with event scanner (The Graph / custom)
4. **Self-provisioned RLI tokens** — each node mints own capacity credits, removes Elacity wallet dependency
5. **AI Model Marketplace alpha** — first non-media vertical: GGUF → encrypt → IPFS → ACCESS_TOKEN → decrypt → Ollama
7. ~~**Consumer decrypt endpoint**~~ — DONE (Mar 14) — Lit Action `executeJs()` with on-chain access check
8. ~~**Lit Action trust model**~~ — DONE (Mar 14) — self-ref conditions, access check in action code
9. ~~**Capacity credit auto-detection**~~ — DONE (Mar 14) — Chronicle Yellowstone query, handles 15-day rotation
10. ~~**Universal asset viewer (images)**~~ — DONE (Mar 14) — inline blob URL rendering in Market dApp
11. ~~**`@elacity-js/access` package**~~ — DONE (Mar 13)
12. ~~**Creator Dashboard dApp**~~ — DONE (Mar 13-14)
13. ~~**Elacity IPFS pipeline**~~ — DONE (Mar 14)
14. ~~**On-chain purchase verification**~~ — DONE (Mar 14)
15. **Create GitHub release `pc2-binaries-v1`** — run `fetch-binaries.sh all`, upload assets to release (DEFERRED)
16. **Gateway "node offline" page** — replaces infinite "initializing" spinner
17. **Fiat onramp** — Particle Smart Account + Stripe/Moonpay
18. **App Factory** — local packaging pipeline
19. **dDRM Access Token contract** — ERC-1155 tiered tokens for supernode economics (deferred to Milestone 3-4)

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
- [dDRM Pipeline E2E](fd6755f0-d73c-4e41-8df3-0f57f15071a2) — @elacity-js/access, Creator Dashboard, Lit Action trust model (Path A), capacity credit auto-detection, decrypt endpoint, decentralization analysis
- [Secure Viewer & PDF](current-session) — secure viewer pipeline, PDF hybrid rendering, two-layer encryption fix, Lit Pinata/relayer integration, auto-decrypt, parallel pages

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
| `pc2-node/data/lit-actions/non-media-decrypt.js` | Trustless on-chain access check + threshold CEK decryption |

#### Secure Viewer Pipeline (Mar 15)
| File | Purpose |
|------|---------|
| `pc2-node/src/api/storage.ts` (`/lit/secure-view`) | Server-side asset rendering: Sharp (images), PDF.js+Canvas (PDFs), Canvas (text) |
| `pc2-node/data/test-apps/elacity-market/app.js` | Auto-decrypt, parallel PDF page loading, loading overlay, scrollable PDF container |
| `pc2-node/data/test-apps/elacity-creator/app.js` | PDF thumbnail generation via `/api/storage/thumbnail` |

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
| `src/gui/src/helpers/open_item.js` | `.edrm` double-click → opens player popup |
| `src/gui/src/IPC.js` | `openFolder` IPC handler for dApp→GUI communication |
| `src/gui/src/helpers/item_icon.js` | `.edrm` custom icon |
| `src/gui/src/lib/mime.js` | `.edrm` MIME type registration |
| `src/gui/src/icons/file-edrm.svg` | Padlock + green tick icon for DRM files |

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
| [pc2.net](https://github.com/Elacity/pc2.net) | `dDRM-extended` | Active development (branched from `feature/elacity-ddrm-marketplace`) |
| [elastos-launcher](https://github.com/Elacity/elastos-launcher) | `main` | v1.1.1 released |
| [document-portal](https://github.com/Elacity/document-portal) | `main` | Up to date |
| [js-sdk](https://github.com/Elacity/js-sdk) | — | Elacity SDK (reference) |
| [elacity-web](https://github.com/Elacity/elacity-web) | — | Elacity website (reference for patterns) |
