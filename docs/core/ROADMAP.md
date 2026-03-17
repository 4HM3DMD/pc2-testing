# ElastOS Strategic Roadmap

> **Purpose:** Single source of truth for all strategic goals, technical work streams, and milestones — directly mapped to the Keystone Fund proposal and Rong Chen's original vision
> **Created:** 2026-02-24
> **Last Updated:** 2026-03-13
> **Status:** Living document — update as work progresses

---

## How This Document Works

Each **Milestone** from the DAO proposal is broken down into concrete **Work Streams**. Each work stream links to the relevant technical docs and can be checked off as completed. This is what we work through month by month.

**Related Documents:**
| Document | What It Covers |
|----------|---------------|
| [ELACITY_UNIVERSAL_ASSET_STRATEGY.md](./ELACITY_UNIVERSAL_ASSET_STRATEGY.md) | Unicorn strategy: universal digital asset protocol, marketplace types, SDK evolution |
| [APP_MANIFEST_SPEC.md](./APP_MANIFEST_SPEC.md) | app.json schema with dDRM capabilities, forward-compatible with Runtime |
| [ARCHITECTURE_CONVERGENCE.md](./ARCHITECTURE_CONVERGENCE.md) | PC2 v1 → Capsule Runtime v2 technical path |
| [SUPERNODE_ECONOMICS.md](./SUPERNODE_ECONOMICS.md) | dDRM Access Token model for supernode revenue |
| [NETWORK_HARDENING.md](../pc2-infrastructure/NETWORK_HARDENING.md) | Supernode decentralization and self-healing |
| [DECENTRALIZATION_STATUS.md](./DECENTRALIZATION_STATUS.md) | Decentralization scorecard, walk-away test roadmap |
| [AGENT_HANDOVER.md](./AGENT_HANDOVER.md) | Current state, coding patterns, infrastructure |
| [ARM_DEVICES.md](../deployment/ARM_DEVICES.md) | Jetson/Raspberry Pi deployment |

---

## Rong Chen's Original Vision (2002–2018)

These diagrams from Rong define the north star. Every work stream should move us closer to this architecture.

### The Elastos Computer (Von Neumann Extension)

```
┌─────────────────────────────────────┐
│         Elastos Computer            │
│  ┌───────────────────────────────┐  │
│  │     Classical Computer        │  │
│  │  Registers                    │  │
│  │  Memory                       │  │
│  │  Local Hard Disk (= cache)    │  │
│  └──────────┬────────────────────┘  │
│             │ TCP/IP, HTTP          │
│  ┌──────────▼────────────────────┐  │
│  │     Cloud Storage (= primary) │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Key insight:** Local storage is cache. Cloud (IPFS) is the primary storage. The "computer" extends beyond the physical device into the network. This is exactly what PC2 does today with IPFS as the storage layer.

### Smart-Web of Elastos Computers

```
    ☁️ ──── ☁️
   / |  ╲  / |
  ☁️ ── ☁️ ── ☁️
   ╲ |  /  ╲ |
    ☁️ ──── ☁️

  Each ☁️ = Personal Cloud Computer
  Each line = P2P Carrier connection
  Apps execute inside VMs/capsules
  IoT devices connect to their owner's cloud
```

**What we're building toward:** Every PC2 node is an Elastos Computer. The Carrier network connects them. Capsules are the "apps in VMs." IoT devices (Jetson, sensors, cameras) feed context into the personal cloud.

### Data Browser → Code Browser (Instant Apps)

**Web2 (Data Browser):** Browser pulls data from servers on demand.
**Smart-Web (Code Browser):** Data AND code are pushed to users and spread via social networks.

**This is the capsule model.** Capsules = code + data distributed by CID. Users install capsules from a marketplace or receive them from peers. The runtime executes them locally. "Instant Apps" that live on your hardware, not a corporate server.

### Three WebSpaces

| WebSpace | Protocol | Purpose | Status |
|----------|----------|---------|--------|
| `https://` | Web2 backward compatibility | `*.ela.city` domains | ✅ Working |
| `localhost://` | Carrier P2P | Mobile↔PC2, PC2↔PC2 | 🔨 Infrastructure ready |
| `elastos://` | Blockchain oracles | Smart contract data, DID resolution | 📋 Future |

---

## Work Streams by Milestone

### Milestone 1 — Campaign Launch & Product Continuity (Mar 1, 2026)

**Goal:** Continuity. Keep shipping. Merge the tested branch to main.

- [x] Merge `feature/jetson-gpu-acceleration` to `main` — squash merged 2026-03-03 (134 commits)
- [x] Establish weekly shipping report cadence (GitHub-based)
- [x] Set up public expenditure tracking portal
- [x] First monthly release (v1.1.0) — released 2026-03-03
- [x] Publish WCI ecosystem update article

**Status (2026-03-03): COMPLETE**
- v1.1.0 released: squash merged to main, tagged, GitHub Release published
- Verified on Mac (localhost) and Jetson (zzz.ela.city) — both boot cleanly
- Structured logging: ~295 console.log calls replaced with createLogger() module-based logging
- Security: hardcoded credentials removed from docs, server passwords rotated
- Four-tier transport cascade: WG > AWG > VLESS Reality > ActiveProxy — all tested
- Desktop UI overhaul, virtual desktops, voice AI, macOS WireGuard — all shipped
- One-command install validated on Mac and 2 independent Jetsons

---

### PRIORITY: Elacity dDRM & dApp Store (Immediate — Post v1.1.0)

**Goal:** Build the V1 dApp Store and Media Market using the Elacity SDK. This is the first work stream after v1.1.0 release.

**Branch:** `feature/elacity-ddrm-marketplace` (created from main after v1.1.0)
**Detailed Plan:** Cursor internal plan — "App Store and Media Market" (ID: `app_store_and_media_market_2489ec7b`)

**Prerequisites:**
- [x] postMessage wallet bridge for iframe-sandboxed apps *(completed Mar 3)*
- [x] COOP/COEP header testing for media player SharedArrayBuffer *(completed Mar 3)*
- [x] Confirm SDK access with CTO (npm registry, test CIDs, API endpoints) *(completed Mar 3)*

**Backend Foundation:**
- [x] `installed_apps` SQLite table (name, cid, version, manifest, installed_at, size, status) *(completed Mar 3)*
- [x] AppInstallService — fetch CID from IPFS, verify, store, register *(completed Mar 3)*
- [x] Install/uninstall/list/update API endpoints (`/api/apps/*`) *(completed Mar 3)*
- [x] App registry manifest format — formal `app.json` spec v1.0 with validation, categories, dDRM, forward-compatibility *(completed Mar 8)*
- [ ] App build pipeline (Vite build → static bundle → IPFS pin → CID → registry)

**Frontend Apps:**
- [x] Elacity Market app using `@elacity-js/api` + wallet bridge *(completed Mar 3-4)*
- [x] Media player as installable app with per-app COOP/COEP headers *(completed Mar 3)*
- [x] Purchase flow via AuthorityGateway *(verified Mar 14 — buyer received ACCESS_TOKEN + resale token, 0.01 USDC payment split correct; UA receipt parsing bug in Elacity frontend, transaction succeeds on-chain)*
- [ ] App Center UI rebuild against real backend APIs

**Download-to-Node / Content Seeding:**
- [x] Save-to-Cloud with `.edrm` descriptor, progress UI, and "Open Videos folder" *(completed Mar 4)*
- [x] `.edrm` file type support in GUI — icon, MIME, double-click opens player *(completed Mar 4)*
- [x] IPFS CAR format support for directory CIDs (DASH segments) *(completed Mar 4)*
- [ ] Auto-download on purchase (trigger pin automatically after buy)
- [ ] Auto-pin + DHT announce for purchased content (CDN effect)

**Creator Tools:**
- [ ] `media-packager` integration — cloud transcode (default) + local FFmpeg (future)
- [ ] App Factory — local packaging pipeline (build → bundle → IPFS pin → publish)
- [x] Creator Dashboard dApp — upload any file, set price/royalties, encrypt via Lit Protocol, upload to IPFS *(implemented Mar 13 — pc2-node/data/test-apps/elacity-creator/)*
  - [x] `POST /api/ipfs/add` endpoint — accepts raw bytes (base64), stores via Helia, returns CID
  - [x] `POST /api/storage/ipfs/add-directory` — creates UnixFS directory CIDs (`{dirCID}/metadata.json` pattern)
  - [x] Step-by-step wizard UI: file picker → metadata form → encrypt & upload → result with CIDs
  - [x] Universal metadata envelope schema (`elacity-asset-envelope-v1`) with asset, pricing, creator fields
  - [x] `@elacity-js/access` integration — `encryptBuffer()` with Lit Protocol ACCESS_TOKEN conditions
  - [x] On-chain minting — `mint(string,uint16,bytes,bytes)` with full opRawData/sellRawData encoding, fee from CoreStorage, gateway from `authority()`. Paid mint (opType=2) verified on BaseScan with correct sub-tokens *(verified Mar 13)*
  - [x] Channel creation — `createChannel()` on ChannelCore with metadata dir, royalty split, MINTER_ROLE auto-grant, backend GraphQL registration *(implemented Mar 13)*
  - [x] Operative approval — `setApprovalForAll(gateway, true)` with ContractCreated event fallback for proxy-based channels *(implemented Mar 13)*
  - [x] Elacity IPFS pipeline — dual upload (local + Elacity), CIDv0 resolution, marketplace visibility confirmed *(completed Mar 14)*
  - [x] Metadata format — image (auto-thumbnail), authority, categories fields for GraphQL compatibility *(completed Mar 14)*
  - [x] Server-side Lit Protocol — encryption via pc2-node backend with capacity credits *(completed Mar 14)*
  - [x] Channel selection UI — user's own channels + custom address input *(completed Mar 14)*
  - [x] On-chain purchase verified — buyer received ACCESS_TOKEN, payment split correct *(verified Mar 14)*
  - [x] Consumer decrypt endpoint — `POST /api/storage/lit/decrypt` on pc2-node with Lit Action `executeJs()` *(implemented Mar 14)*
  - [x] Lit Action trust model — custom `non-media-decrypt.js` with self-referential conditions + on-chain access check in action code *(implemented Mar 14)*
  - [x] Smart Account awareness — passes SA address as `buyerAddress` for Universal Account buyers *(implemented Mar 14)*
  - [x] Capacity credit auto-detection — queries Chronicle Yellowstone for latest valid RLI token, handles 15-day rotation *(implemented Mar 14)*
  - [x] Inline image rendering — decrypted content rendered as blob URL in Market dApp *(implemented Mar 14)*
  - [x] Gateway approval hardening — 5s delay, try-catch, "Fix Gateway Approval" tool *(implemented Mar 14)*
  - [x] End-to-end decrypt test with capacity credits — **WORKING** (Lit Payment Delegation via Relayer API, Test 13 image + Test 14 PDF verified)
  - [x] Universal asset viewer — **server-side secure viewer** for images (Sharp), PDFs (PDF.js+Canvas hybrid), text (Canvas) with watermarking, buffer zeroing, auto-decrypt, parallel PDF page loading *(completed Mar 15)*
  - [x] **WASM Renderer** — Rust crate compiled to `wasm32-wasip1` for text rendering inside isolated WASM linear memory + `WASMRuntime.ts` Node.js WASI host *(completed Mar 15)*
  - [x] **dDRM Viewer app** — dedicated PC2 app with two display modes (centered images, full-width scrollable documents), anti-piracy measures, renderer badges, puter.args IPC integration *(completed Mar 15)*
  - [x] **PC2 Media Runtime** — complete server-side DASH/CENC decryption pipeline. Rust `cenc-decrypt` WASM crate (AES-128-CTR per-sample decryption), MSE player (no EME/CDM/SharedArrayBuffer), DRM signaling stripping (`encv→av01`, `sinf`/`senc` removal), 16-byte IV support from tenc, Smart Account PSSH selection, two-phase Lit auth. **First successful end-to-end playback of Elacity DRM video inside PC2** *(completed Mar 16)*
  - [x] **Media Player hardening** — session expiry handling (transparent re-auth), seek into unbuffered regions (segment mapping + buffer flush), audio-only support, adaptive bitrate switching (bandwidth measurement + quality selector UI), YouTube-style keyboard shortcuts, auto-hide controls, buffering indicator, segment retry, buffer eviction, Elacity branding *(completed Mar 16)*
  - [x] **WASM Renderer hardening** — PDF rendering via `lopdf` text extraction, code syntax highlighting via `syntect` (30+ languages), all static content types now render inside WASM linear memory *(completed Mar 16)*
  - [x] **dDRM Viewer UX** — image zoom/pan, document zoom + page navigation with toolbar, audio player mode, floating auto-hide toolbar, fullscreen toggle, keyboard shortcuts *(completed Mar 16)*
  - [x] **WASM-native PDF rendering** — Replaced `lopdf` (WASM crash) with `hayro` pure-Rust PDF rasterizer for full-fidelity rendering (layout, fonts, tables, images). Fixed WASI compilation target (`wasm32-wasip1`). Node.js canvas fallback text wrapping fixed. Elacity brand blue (`#3b82f6`) applied to viewer. "Mint on Elacity" right-click for non-dDRM files. Wallet bridge restored *(completed Mar 16)*
  - [x] **WASM crypto hardening (Phases A-C)** — AES-GCM decrypt-only mode in WASM (CEK never in Node.js heap, 50MB threshold), fMP4 strip+decrypt combined in single WASM call (Rust port with 64-bit box support), `build-wasm.sh` pipeline, `wasm32-wasip1` toolchain. PDF text extraction spike confirmed `hayro-syntax` lacks CMap resolution — keeping `pdfjs-dist`. Phase D (Lit Chipotle) COMPLETE. Phase E (ECDH to WASM) conditional on Chipotle envelope format.
  - [x] **Bug fixes (Mar 16)** — Fixed double-signature bug (duplicate `pc2-wallet-bridge.js` + `IPC.js` handlers), fixed WASM text renderer exceeding JPEG 65535px limit, fixed video autoplay after signing, fixed `eth_requestAccounts` prompting unnecessarily (use `eth_accounts` first). Removed duplicate `eth_sendTransaction` handler from ParticleNetworkContext
  - [x] **dDRM Viewer native windowing** — launches as UIWindow via IPC `postMessage` → `launch_app()` (not browser popup), integrated with taskbar *(completed Mar 15)*
  - [x] **.ddrm.json capsule format** — descriptor files for non-media assets with CID, Lit params, mimeType. MIME: `application/x-ddrm+json`. Saved to Documents *(completed Mar 15)*
  - [x] **GUI capsule integration** — custom shield icon, MIME registration, double-click opens dDRM Viewer, content_type_to_icon mapping *(completed Mar 15)*
  - [x] **Market "Open" button** — IPC-based launch of dDRM Viewer from asset detail view *(completed Mar 15)*

**SDK Evolution (Universal Asset Protocol):**
- [x] `@elacity-js/access` package — clean-room build of universal access layer using Lit Protocol SDK directly (see `docs/core/ACCESS_PACKAGE_SPEC.md`) *(implemented Mar 13 — 12 source files, 47 unit tests passing)*
  - [x] Lit Protocol session management + certificate caching *(lit/session.ts)*
  - [x] `verifyAccess()` — on-chain ACCESS_TOKEN check via AuthorityGateway *(verify/access-token.ts)*
  - [x] `acquireKey()` — Lit Protocol key retrieval with access conditions *(lit/key-retrieval.ts)*
  - [x] `encryptBuffer()` / `decryptBuffer()` — AES-GCM via WebCrypto (creator + consumer) *(crypto/encrypt.ts, crypto/decrypt.ts)*
  - [x] `acquireLicense()` — CENC-compatible interface for media-player backward compat *(crypto/payload.ts + lit/key-retrieval.ts)*
  - [x] `fetchAndDecrypt()` — IPFS fetch + decrypt convenience method *(fetch/ipfs.ts + client.ts)*
  - [x] Node.js entry point (`@elacity-js/access/node`) for server-side decryption *(node/session.ts, node/client.ts — LitNodeClientNodeJs + ethers.Wallet)*
  - [ ] Integration test against real Elacity content on Base
- [ ] `@elacity-js/asset-packager` package — generic asset encryption + IPFS upload (non-media counterpart to `media-packager`). Creator Dashboard uses inline pipeline for now; extract to package when patterns stabilize.
- [x] Universal metadata schema — `elacity-asset-envelope-v1` with `asset` field (cid, mimeType, size, encrypted, algorithm, dataToEncryptHash, keyId), `pricing`, `creator` *(implemented Mar 13)*
- [ ] `AssetService` in `@elacity-js/api` — generic asset queries for any content type alongside existing `NFTService`

**Tiered Marketplace Rollout:**
- [ ] **Tier 1 — Quick Markets (file in, file out):** E-books/PDFs, stock photography, audio/music, design templates, fonts, 3D models. All use `access.fetchAndDecrypt()` → save/open. No special runtime needed.
- [ ] **Tier 2 — Medium Markets (local runtime integration):** AI models (GGUF → Ollama), code packages (npm), datasets, PC2 dApps. Need PC2 backend endpoints for decrypt-and-load.
- [ ] **Tier 3 — Complex Markets (new infrastructure):** Software licensing, API marketplace, agent marketplace. Need Runtime v2 capsule sandboxes.

---

### Milestone 2 — V1 Stabilization & Network Growth (May 31, 2026)

**Goal:** Harden everything. Grow the node count. Make it dead-simple to install.

**V1 Hardening:**
- [x] Fix large file upload — was a display bug (total_size*2 removed), uploads were always completing correctly
- [x] Fix wallpaper not loading via gateway — confirmed resolved after WireGuard reconnect fix
- [ ] AV1/Firefox — server-side remuxing for MKV→MP4 (beyond the error message)
- [ ] Performance profiling on Jetson (memory, CPU, IPFS block store)
- [x] Reduce PC2 cold-start time — parallelized AI/Gateway/Boson initialization
- [x] Mobile-responsive UI improvements — taskbar z-index fix, responsive layouts, virtual desktops

**DePIN Hardware Expansion:**
- [x] Validate one-command installer on fresh Jetson Orin Nano — tested on 2 devices (EverlastingOS + Anders)
- [ ] **WSL bulletproof install** — WSL-specific script, build verification, auto-start hook, systemd detection *(reported by Joel — 3 failed installs across 2 laptops)*
- [ ] Windows hardware testing — WSL2 on Windows 10 + 11
- [ ] Raspberry Pi 4/5 validation and optimization
- [ ] Explore dedicated DePIN hardware partnerships (plug-and-play boxes)
- [ ] Debian package (.deb) for ARM devices
- [ ] macOS package (.dmg) for desktop users — needs Apple Developer cert ($99/year)
- [ ] Windows native installer (.exe) — after WSL is solid

**Carrier Overlay Network:**
- [x] Gateway under systemd with auto-restart — deployed live, enabled for boot
- [ ] SQLite registry replacing JSON file (NETWORK_HARDENING item #2) — deferred, JSON fine at current scale
- [ ] Automated SSL renewal with monitoring (NETWORK_HARDENING item #7)
- [ ] Basic uptime monitoring for supernodes (NETWORK_HARDENING item #6)
- [x] Reduce WireGuard retry interval (15s with exponential backoff) — shipped commit 0ac683b1
- [x] WireGuard macOS support — auto-install, passwordless sudo, network change detection
- [x] WireGuard PATH detection under PM2/systemd restricted environments
- [x] Community networking fix script (`scripts/fix-networking.sh`) — installs full transport stack for affected users *(completed Mar 8)*
- [ ] **WireGuard bundling with PC2 app** — bundle `wg`, `wg-quick`, `wireguard-go`, `amneziawg-go`, `sing-box` binaries so no user falls back to broken ActiveProxy
- [ ] **Gateway "node offline" page** — show clear HTML error instead of infinite "initializing" when proxy/tunnel fails

**Network Map & Public Presence (map.ela.city):**
- [x] Network map visual upgrade — decentralized topology, particle flow, animated nodes, deployed Mar 8
- [x] 3D orb visualization (World Computer) — Three.js force-shield, side-by-side with 2D graph *(completed Mar 12-13)*
- [x] Rebrand to "ElastOS World Computer Network" with Elacity Labs branding *(completed Mar 12-13)*
- [x] Simplified node statuses — merged stale→offline, activity types to active/occasional/idle *(completed Mar 12)*
- [x] Full SEO overhaul — JSON-LD, OG/Twitter cards, sitemap, robots.txt, noscript fallback *(completed Mar 13)*
- [x] GA4 analytics (G-QW5NN8K9DS) + Google Search Console verification *(completed Mar 13)*
- [x] Public API with CORS — `/api/nodes`, `/api/stats/summary` available for external integration
- [ ] PC2 marketing slides for elacitylabs.com — audit and rewrite product slides
- [ ] QuickStart component for elacitylabs.com — installation instructions UI (including Jetson/ARM)
- [ ] Backlinks from ela.city and docs.ela.city to map.ela.city

**AI Integration:**
- [ ] Integrate latest model providers as they emerge
- [x] Voice interaction prototype — Whisper (STT) + Ollama (reasoning) + Piper (TTS) — shipped Feb 26
- [x] Context API endpoint (`/api/context`) — accepts location, photo CIDs, voice transcripts, activity events
- [x] Ollama tool fallback — models rejecting tools auto-retry without tool definitions
- [x] Voice AI settings UI — install button, enable/disable toggle, opt-in on Jetson
- [ ] AI agent file management improvements
- [ ] RAG retrieval optimization for personal documents
- [ ] Evaluate PersonaPlex-7B (NVIDIA full-duplex voice) as Jetson hardware matures

**Omnichain ELA:**
- [ ] Begin ELA liquidity deployment across target EVM chains
- [ ] Chainge Finance ELA deployment plan (119,630 ELA)

---

### Milestone 3 — P2P Networking & dDRM Foundation (Sep 30, 2026)

**Goal:** Nodes start talking to each other. dDRM marketplace takes shape.

**P2P Node Networking:**
- [ ] P2P messaging between PC2 nodes (text/data via Carrier)
- [ ] Node discovery and directory (public listing with reputation)
- [ ] Social features foundation (chat between node owners)
- [ ] IoT device connectivity patterns (sensors → personal cloud)
- [ ] dDRM CEK mesh caching — P2P key relay between nodes with shared ACCESS_TOKEN ownership. Signed attestation proves on-chain rights. Reduces Lit API calls and cost at network scale. Prerequisite: Chipotle migration complete

**Awareness Layer (Context + Memory):**
- [ ] Context ingestion pipeline — location, photos, voice, motion, activity events all flowing to node
- [ ] Mobile companion app — lightweight iOS/Android app pushing GPS, photos, voice to your node
- [ ] Memory store — local SQLite + embeddings (via Ollama) for episodic and semantic memory
- [ ] Agent reads memory before every chat interaction (contextual responses, not stateless)
- [ ] Persistent agent loop — background process checking context every N minutes, firing proactive triggers
- [ ] Dynamic app generation — agent builds HTML/JS apps from context data on demand (e.g. trip map)
- [ ] Memory capsules — IPFS CID + DID ownership for generated experiences (shareable, ownable)

**Elacity dDRM Integration:**
- [x] Integrate Elacity dDRM SDK into ElastOS *(completed Mar 3-4 — Market dApp, player, wallet bridge)*
- [x] Encrypted content upload + CID distribution *(completed Mar 14 — Elacity IPFS pipeline, dual upload)*
- [x] Access token architecture (buy rights → get decryption key) *(completed Mar 4 — buyAccess + Lit Protocol DRM)*
- [x] Selective IPFS DHT announcement for dDRM content (`announce: true`) *(completed Mar 5 — dht.provide + periodic re-announce)*
- [x] Marketplace UI within ElastOS (browse, purchase, download) *(completed Mar 3-4 — Elacity Market dApp)*
- [x] Buyer node becomes seeder (CDN effect for encrypted content) *(completed Mar 5-6 — Bitswap-first + NAT traversal + relay)*
- [ ] Incentivized encrypted content CDN — PC2 buyer nodes collectively serve encrypted segments via IPFS Bitswap. Bandwidth contribution tracking per node. Popular content auto-replicates across buyer network. Economic incentive via dDRM contribution credits

**Universal Asset Marketplace (dDRM beyond media):**
- [x] Lit Action trust model — custom `non-media-decrypt.js` with self-referential conditions, on-chain access check, Smart Account aware *(completed Mar 14)*
- [x] Capacity credit auto-detection — queries Chronicle Yellowstone for latest valid RLI token, handles 15-day rotation *(completed Mar 14)*
- [x] Server-side decrypt endpoint — `POST /api/storage/lit/decrypt` with Lit Action `executeJs()` *(completed Mar 14)*
- [x] Inline image rendering — decrypted content rendered as blob URL in Market dApp *(completed Mar 14)*
- [x] **End-to-end decrypt test with capacity credits** — **WORKING** (Lit Payment Delegation via Relayer API) *(completed Mar 15)*
- [x] Two-layer encryption — AES-GCM + Lit CEK (bypasses 4MB message limit) *(completed Mar 15)*
- [x] Server-side secure viewer — images/PDFs/text rendered server-side with watermark, no plaintext in browser *(completed Mar 15)*
- [x] Auto-decrypt on asset open — owned assets automatically decrypt when viewed *(completed Mar 15)*
- [x] **WASM Renderer** — Rust→WASM text rendering + WASMRuntime.ts WASI host *(completed Mar 15)*
- [x] **dDRM Viewer** — dedicated secure viewer app with native PC2 windowing, scrollable document view, .ddrm.json capsule support *(completed Mar 15)*
- [x] **GUI file type integration** — `.ddrm.json` icon, MIME, double-click → dDRM Viewer *(completed Mar 15)*
- [x] **PC2 Media Runtime** — server-side DASH/CENC decryption: Rust WASM cenc-decrypt crate + MSE player + DRM stripping + Lit CEK recovery. End-to-end video playback verified *(completed Mar 16)*
- [x] **Lit Chipotle migration** — Datil deprecated ~April 25, 2026. Replaced v7 SDK with REST API. `chipotle-client.ts` module, `LIT_BACKEND` feature flag, dual-mode rollback. *(completed Mar 13)*
- [ ] On-chain content indexer — replace Elacity GraphQL dependency with event scanner (The Graph / custom). See [DECENTRALIZATION_STATUS.md](./DECENTRALIZATION_STATUS.md) Tier 1.1
- [ ] Self-provisioned RLI tokens — each PC2 node mints own capacity credits, removes Elacity wallet dependency. See Tier 1.3
- [ ] AI Model Marketplace alpha — encrypt GGUF/SafeTensors model → IPFS → ACCESS_TOKEN → decrypt on PC2 → load in Ollama
- [ ] Code/Plugin Marketplace — dDRM-gated npm packages, themes, extensions
- [ ] Dataset Marketplace — dDRM-gated training datasets, knowledge bases
- [ ] Fiat onramp — Particle Smart Account + Stripe/Moonpay for one-click credit card ACCESS_TOKEN purchase

**Mobile:**
- [ ] Lightweight mobile companion app (React Native) — connect to PC2 node via WireGuard, browse marketplace, purchase, stream/download

**Supernode Decentralization:**
- [x] Second supernode (Contabo 38.242.211.112) operational — deployed 2026-03-07
- [x] Automated backup: InterServer → Contabo every 6 hours (SSH key auth, rsync)
- [x] App registry mirror on Contabo with 5-minute sync from primary
- [x] IPFS relay on Contabo (peer ID: 12D3KooWAaFWUWN7, 500+ peers)
- [x] Boson DHT on Contabo (node ID: EbfCHQUfwawec8Pa, Active Proxy on :8090)
- [x] PC2 client updated: multi-supernode failover for registry, IPFS bootstrap, Boson DHT
- [x] Web gateway on Contabo (slim read-replica with subdomain routing) — deployed 2026-03-07
- [x] Dual-write node registration (PC2 nodes register on all reachable supernodes) — deployed 2026-03-07
- [x] Stealth transport decentralization: WireGuard (wg1, 10.102.0.0/16), AmneziaWG (awg0, 10.103.0.0/16), VLESS Reality on Contabo — deployed 2026-03-07
- [x] Transport provisioning APIs on Contabo gateway (/api/wg/register, /api/awg/register, /api/vless/register)
- [x] Client-side sequential failover: WireGuardService, AmneziaWGService, VLESSRealityService all try secondary supernodes on primary failure
- [x] Supernode bootstrap script (`deploy/supernode-bootstrap.sh`) — one-command VPS setup *(completed Mar 7)*
- [x] Dynamic supernode discovery — gossip protocol + parallel fetch + disk persistence *(completed Mar 7)*
- [x] Registry mesh sync via gossip endpoints (all supernodes sync with all others) *(completed Mar 7)*
- [ ] Per-domain rate limiting on gateway (NETWORK_HARDENING item #8)

**Three-Tier Network Architecture:**
- [x] **Tier 1 — Full Supernodes:** Bootstrap script + gateway v2.0 with gossip/register/heartbeat *(completed Mar 7)*
- [x] **Tier 2 — Relay Nodes:** Relay mode toggle in PC2 Settings + IPFS circuitRelayServer + DHT server mode *(completed Mar 7)*
- [x] **Tier 3 — Leaf Nodes:** Standard PC2 nodes behind NAT (IPFS content seeding, local AI, personal cloud — this is today's default)
- [x] Supernode dApp in dApp Center: spec-check, service status, network view *(completed Mar 7)*
- [ ] Node auto-migration between supernodes on failure (provision cache clear + sequential failover already working)

**Supernode Economics (dDRM Access Token Model):**
- [ ] Design Access Token contract (ERC-1155 tiered: Free/Premium/Enterprise/Bundle)
- [ ] Integrate token verification into supernode gateway (Lit Protocol)
- [ ] List Access Tokens on Elacity Market alongside media content
- [ ] Bandwidth metering and attestation for proportional revenue distribution
- [ ] On-chain SupernodeOperatorRegistry for trustless operator management
- [ ] See [SUPERNODE_ECONOMICS.md](./SUPERNODE_ECONOMICS.md) for full strategy

**Network Infrastructure:**
- [ ] Multi-domain support — DNS + SSL + gateway for `*.pc2.net` and `*.ela.net`
- [ ] Relay nodes — PC2 nodes with public IP contribute IPFS relay + Boson DHT automatically
- [ ] Censorship resistance: IP-based fallback, DHT discovery, IPFS addressing (no DNS dependency)
- [ ] Encrypted registry replication across supernodes via IPFS

---

### Milestone 4 — Protocol Fee Architecture & Year 1 Review (Dec 1, 2026)

**Goal:** ELA demand mechanics live. First annual accountability report.

**Protocol Fees:**
- [ ] Fee collection on marketplace transactions (dDRM purchases)
- [ ] Fee pooling to market-buy ELA from DEX LPs
- [ ] Transaction fee on in-OS currency operations
- [ ] Fee dashboard (transparent, on-chain tracking)

**Node Operator Economics (dDRM Access Token Model):**
- [ ] Deploy SupernodeAccessToken contract (ERC-1155, tiered)
- [ ] Integrate Lit Protocol verification into gateway for tier-gated services
- [ ] Bandwidth metering and attestation for revenue distribution
- [ ] Operator registration and revenue claim via SupernodeOperatorRegistry.sol
- [ ] Media + Network bundle tokens (streaming + premium access in one)
- [ ] Compute/storage fee models for shared services
- [ ] Revenue split enforcement: 80% operators, 15% protocol treasury, 5% ELA buyback
- [ ] dDRM contribution credits — nodes earn Elacity credits by contributing IPFS bandwidth, CEK relay for mesh caching, and uptime. Credits offset Lit/key-management costs. Self-sustaining network economics replacing Elacity subsidy model

**Universal Marketplace Growth:**
- [ ] AI Model Marketplace — full launch with categories (LLM, vision, audio, multimodal)
- [ ] Composable assets — nested licensing with dependency declarations (model A depends on dataset B, royalties flow through)
- [ ] Enterprise DRM-as-a-Service pilot — white-label Elacity contracts for B2B software licensing
- [ ] Data Unions — collective licensing via MultiChannel (photographer collectives, research teams, music catalogs)
- [ ] Agent buyer support — MCP/A2A endpoints for autonomous agent procurement of ACCESS_TOKENs
- [ ] Elacity dDRM API product — one API key for encrypt/decrypt/mint/upload/verify/stream. Pay-per-request + tiered subscription revenue model. Target markets: AI agents (MCP/A2A), third-party marketplaces, WordPress/Shopify plugins, white-label integrations. Foundation: Chipotle migration makes all Lit calls simple HTTP POSTs

**Year 1 Report:**
- [ ] Comprehensive development output report (commits, releases, features)
- [ ] Network statistics (active nodes, transactions, uptime)
- [ ] ELA value capture metrics
- [ ] Full financial expenditure transparency
- [ ] Community growth documentation

---

### Milestone 5 — Developer Platform & Capsule Marketplace (Mar 1, 2027)

**Goal:** Third-party developers can build on ElastOS.

**Developer SDK:**
- [ ] Stable API surface documented for external developers
- [ ] SDK package (npm) for building ElastOS extensions
- [ ] Extension system — install/remove capsule-shaped apps
- [ ] Developer documentation and getting-started guide
- [ ] Example capsules (template projects)

**Capsule Marketplace Alpha:**
- [ ] Distribution model: sandboxed apps identified by CID
- [ ] In-ElastOS marketplace UI (browse, install, rate)
- [ ] Capsule packaging standard (manifest, permissions, dependencies)
- [ ] Begin extracting core services behind standardized interfaces

**White-Label Protocol (Elacity-as-Infrastructure):**
- [ ] Protocol SDK — let external developers build their own marketplaces on Elacity contracts with 1-2% protocol fee
- [ ] Marketplace factory — deploy custom `Channel` + `AuthorityGateway` instances for niche verticals
- [ ] Documentation for third-party marketplace builders
- [ ] Enterprise self-hosted option (private Elacity contracts for internal digital asset management)
- [ ] dDRM API gateway — REST API wrapping key management + IPFS + on-chain contracts. Developer dashboard with usage analytics, rate limiting, billing. Technical foundation: Chipotle migration + chipotle-client.ts abstraction layer

---

### Milestone 6 — Capsule-Ready Services & Marketplace Growth (Jun 1, 2027)

**Goal:** PC2 internals progressively modularized toward capsule interfaces.

**Modular Service Interfaces:**
- [ ] Storage provider contract (IPFS, cloud, local — same interface)
- [ ] Networking provider contract (WireGuard, Carrier, future mesh)
- [ ] Identity provider contract (wallet, DID, passkeys)
- [ ] AI provider contract (Ollama, OpenAI, Anthropic — same interface)

**Storage Abstraction:**
- [ ] Multiple storage backends behind unified API
- [ ] Cross-device sync foundation
- [ ] Cloud storage integration (S3-compatible, for users who want it)

**Remote Access & Mobile:**
- [ ] Desktop-as-a-Service exploration (RDP/VNC server mode)
- [ ] Mobile app for accessing your PC2 remotely
- [ ] Mobile SDK for Carrier (phone↔PC2 — Rong's `localhost://` WebSpace)
- [ ] GeoDNS for `*.ela.city` routing to nearest supernode

---

### Milestone 7 — Runtime Integration & Agent Economy (Sep 1, 2027)

**Goal:** Anders' Rust runtime begins integrating. Agent economy emerges.

**Runtime Integration:**
- [ ] WASM sandboxed execution for capsules
- [ ] Capability token model (capsules request permissions, users grant)
- [ ] Capsule isolation (each capsule runs in its own sandbox)
- [ ] MicroVM isolation where hardware supports it (Firecracker on x86)
- [ ] DID integration with ESC/EID for `elastos://` WebSpace
- [ ] DHT participation — PC2 nodes store/forward DHT entries (Level 2)
- [ ] dDRM capsule — `@elacity-js/access` compiled to WASM, CEK never leaves capsule linear memory. ACCESS_TOKEN → capability token bridge: Runtime verifies on-chain ownership, issues scoped `{ action: "drm:decrypt", resource: CID }` token. Lit calls happen inside sandbox. Full audit trail via Runtime immutable log
- [ ] Key custody primitive — `elastos-keycustody` crate providing Shamir Secret Sharing split/combine, encrypted share storage, quorum reconstruction protocol. Mechanism-only (no policy); dDRM capsule provides policy decisions. Analogous to `elastos-storage` for key material
- [ ] Key custodian capsule — supernode-hosted capsule that stores key shares, verifies on-chain access (`hasAccessByContentId`), releases shares under proof of authorization. Content-addressed code (IPFS CID) for immutability — same trust model as Lit Actions but running on PC2 infrastructure
- [ ] `KeyCustodyRegistry.sol` — on-chain mapping of contentId → custodian supernode set. Quorum parameters (N shares, K threshold). Geographic diversity requirements. Creators choose custodian set at encrypt time
- [ ] PC2 threshold key management — creators encrypt CEK against K-of-N PC2 supernodes instead of Lit Protocol via Shamir Secret Sharing (`sharks`/`vsss-rs` Rust crates). Buyer's node collects K shares from custodian supernodes after each independently verifies on-chain access. No external dependency for key unlock. Lit becomes optional fallback for legacy content. Progression: Lit primary → Lit fallback → Lit optional → fully sovereign

**Agent Economy:**
- [ ] Agent-to-agent communication (capability-gated trust)
- [ ] Investable agents with dDRM-protected capabilities
- [ ] Tradeable skill capsules (agent expertise as distributable CIDs)
- [ ] Agent marketplace (deploy, discover, interact)
- [ ] Evaluate ERC-8004 agent registry for node/agent identity and discovery
- [ ] Register PC2 nodes and Flint agent in ERC-8004 Identity Registry (ERC-721)
- [ ] Integrate ERC-8004 Reputation Registry for dApp Store app/agent ratings
- [ ] Expose MCP/A2A endpoints in agent registration files for cross-agent discovery

**Carrier Network:**
- [ ] Multi-supernode WireGuard with load balancing (NETWORK_HARDENING Phase 2)
- [ ] Geographic supernode routing (connect to nearest)
- [ ] 5+ operational supernodes (independent operators in different jurisdictions)
- [ ] Supernode services as capsule bundles (boson-dht, ipfs-relay, tunnel-wg, gateway, bandwidth-meter)
- [ ] Mesh networking between supernodes (registry gossip, peer forwarding)

---

### Milestone 8 — Year 2 Review & Convergence Progress (Dec 1, 2027)

**Goal:** Comprehensive Year 2 accountability.

- [ ] Marketplace activity report (transactions, dDRM sales, capsule installs)
- [ ] Protocol fee deployment metrics (ELA bought, fees collected)
- [ ] Capsule architecture advancement (% of services modularized)
- [ ] Node network growth (active nodes, geographic distribution)
- [ ] Full Year 2 financial expenditure report

---

### Milestones 9–13 — Sovereign Scale (2028–2029)

**These milestones are directional. Specific tasks will be defined based on Year 1-2 learnings.**

**Peer-to-Peer Services (M9):**
- Direct exchange of compute, storage, content between nodes
- Sandboxed AI execution environments
- Protocol fee revenue expansion
- TEE-sealed local decrypt — on TEE-capable hardware (SGX, TrustZone, Secure Enclave), CEK decrypted inside local hardware enclave with no network round-trip. Ultimate sovereignty: user's own silicon is the trusted execution environment, blockchain is the access ledger. Fallback to PC2 threshold for non-TEE hardware
- Key migration tooling — re-encrypt Lit-encrypted content CEKs against PC2 custodian supernode set while Lit is still available. Enables graceful transition away from any external key management dependency. Batch migration for existing content catalogs

**Self-Sustaining Revenue (M10):**
- Protocol fees covering operational costs
- Node operator profitability from real usage
- ELA demand from structural mechanics

**Capsule Ecosystem (M11):**
- Growing catalog of independent capsules
- Autonomous agent-to-agent commerce
- Runtime convergence: minimal core + capsule ecosystem

**Enterprise Readiness (M12):**
- Enterprise-grade reliability, security, scalability
- Capital raise positioning with documented traction
- Performance and stability focus

**Mandate Completion (M13 — Mar 2029):**
- Full 3-year report: commits, releases, nodes, fees, growth, expenditure
- Foundation for self-sustainability beyond funding period

---

## Cross-Cutting Concerns (Apply to All Milestones)

### Rong's Vision Alignment

| Rong's Concept | How ElastOS Implements It | Status |
|----------------|--------------------------|--------|
| Cloud storage as primary, local as cache | IPFS as storage layer, local files as cache | ✅ Working |
| Personal Cloud Computer (Digital Silo) | PC2 node on personal hardware | ✅ Working |
| P2P network of Elastos Computers | Carrier overlay + WireGuard + Active Proxy | ✅ Working |
| Apps in VMs | Capsules in WASM/microVM sandboxes | 📋 Phase 2-3 |
| Instant Apps (Code Browser) | Capsules distributed by CID, installed from marketplace | 📋 Phase 2 |
| `https://` WebSpace | `*.ela.city` domains via gateway | ✅ Working |
| `localhost://` WebSpace | Carrier P2P between nodes | 🔨 Phase 1-2 |
| `elastos://` WebSpace | Blockchain oracles, DID resolution | 📋 Phase 3 |
| IoT / Smart Home | Jetson, sensors, cameras as context feeds | 🔨 Phase 1-2 |
| Awareness Layer | Location + photo + voice + memory → contextual agent | 🔨 Phase 2-3 |
| Full-duplex Voice | PersonaPlex-7B or equivalent on-device voice model | 📋 Phase 3+ |
| Runtime manages ALL network traffic | Capability-gated networking in runtime | 📋 Phase 3 |

### Elacity dDRM SDK Integration Path — Universal Asset Protocol

> **Vision:** Elacity as the "Amazon of digital assets" — not just media, but AI models, code, datasets,
> templates, agent skills — all gated by dDRM ACCESS_TOKENs, tradeable by humans and agents.
> See [ELACITY_UNIVERSAL_ASSET_STRATEGY.md](./ELACITY_UNIVERSAL_ASSET_STRATEGY.md) for full strategy.

```
Phase 1 — Media Foundation (M2-M3) ✅ COMPLETE:
  Integrate dDRM SDK → encrypted content upload → access tokens
  → marketplace UI → buyer downloads → buyer becomes seeder
  → app.json manifest spec with dDRM capability declaration

Phase 2 — Universal Access Layer (M3-M4):
  Extract @elacity-js/access from media-player (Lit Protocol key retrieval)
  → generic decrypt-to-buffer for ANY encrypted CID
  → AI Model Marketplace alpha (GGUF → IPFS → ACCESS_TOKEN → Ollama)
  → Code/Plugin Marketplace, Dataset Marketplace
  → Fiat onramp (Particle + Stripe/Moonpay)
  → Creator Dashboard dApp (upload any file → encrypt → list)

Phase 3 — Supernode Economics + White-Label (M3-M5):
  Supernode Access Tokens — dDRM SDK verifies network service access
  → Access Tokens listed on Elacity Market alongside all asset types
  → Media + Network + AI bundles (content + compute + access in one token)
  → White-label protocol SDK for third-party marketplace builders
  → Enterprise DRM-as-a-Service pilot
  → Fee collection → ELA buy-pressure → royalty distribution

Phase 4 — Agent Economy + Runtime (M5-M7):
  Agent-to-agent commerce — autonomous procurement via MCP/A2A
  → composable assets (nested licensing, dependency royalty trees)
  → dDRM as a capsule in the Runtime → independent versioning
  → capability tokens bridge: ACCESS_TOKEN → runtime capability grant
  → Data Unions (collective licensing via MultiChannel)
  → supernode services as token-gated capsules in the runtime

Phase 5 — Platform Scale (M7+):
  Elacity becomes protocol infrastructure (Stripe of digital assets)
  → multiple vertical marketplaces built on Elacity contracts
  → agent marketplaces (deploy, discover, hire autonomous agents)
  → cross-chain expansion (Base, Arbitrum, Solana via bridges)
  → self-sustaining revenue from protocol fees across all verticals
  → Elacity dDRM API: one key for all operations (encrypt, decrypt, mint, stream, verify)
  → PC2 dDRM mesh: CEK caching, encrypted CDN, contribution economics
  → sovereign key management: PC2 threshold network replaces Lit for new content
  → TEE-sealed local decrypt for capable hardware (SGX, TrustZone, Secure Enclave)
  → key migration: re-encrypt legacy Lit content to PC2 threshold custody
  → full walk-away from external key management dependencies
```

### SDK Package Evolution

```
TODAY:
  @elacity-js/contracts     ← Already universal (AuthorityGateway, TradeGateway, Operatives)
  @elacity-js/api           ← Media-coupled (NFTService, ChannelService)
  @elacity-js/media-player  ← Media-only (DASH, CENC, MSE, SharedArrayBuffer)
  @elacity-js/media-packager← Media-only (upload, transcode, encode)
  @elacity-js/common        ← Already universal (auth types, pagination)

TARGET (M3-M5):
  @elacity-js/contracts     ← No change needed
  @elacity-js/api           ← Add AssetService, MarketplaceService, LicenseService
  @elacity-js/access  (NEW) ← Universal access layer: verify + decrypt ANY asset via Lit Protocol
  @elacity-js/asset-packager (NEW) ← Generic encrypt + IPFS upload for non-media assets
  @elacity-js/media-player  ← Stays, becomes consumer of @elacity-js/access
  @elacity-js/media-packager← Stays for media-specific transcoding
  @elacity-js/common        ← Add universal asset type interfaces
```

### ERC-8004 Agent Registry Integration Path

> **Standard:** [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) (Draft, Aug 2025)
> **Authors:** MetaMask, Ethereum Foundation, Google, Coinbase
> **Status:** Draft, ~1,500 agents registered on Sepolia testnet (Mar 2026)
> **CTO Note:** Evaluate alongside bankr/BNKR trend — autonomous on-chain agents with identity + reputation are seeing massive market growth ($100M+ market cap).

Three on-chain registries: Identity (ERC-721 per agent), Reputation (feedback signals), Validation (zkML/TEE/re-execution proofs). Complementary to Elacity SDK — ERC-8004 handles agent discovery/trust, Elacity handles content rights/marketplace.

```
Phase 1 (M2-M5) — Forward-Compatible Design:
  Design app.json manifest services[] field to align with ERC-8004
  registration file format → zero rework when adopting the standard later
  Ensure DID integration can serve as identity layer for ERC-8004

Phase 2 (M5-M7) — Node Identity & Reputation:
  Register PC2 nodes as ERC-8004 agents (ERC-721 NFT per node)
  → node registration file advertises ela.city URL, MCP endpoint, DID
  Wire dApp Store ratings to Reputation Registry (on-chain feedback)
  → app quality, uptime, success rate as on-chain signals

Phase 3 (M7+) — Agent Economy:
  Register Flint AI agent in Identity Registry with A2A/MCP endpoints
  → other agents discover and interact with Flint via ERC-8004
  Agent-to-agent trust via Reputation + Validation registries
  → capability-gated agent interactions with on-chain reputation
  Content creators as registered agents with reputation scores
```

### Network Hardening (from NETWORK_HARDENING.md)

| Priority | Item | Target Milestone | Status |
|----------|------|-----------------|--------|
| Must-have | Gateway under systemd | M2 | Done (both supernodes) |
| Must-have | Multi-supernode transport | M3 | Done (WG+AWG+VLESS on InterServer + Contabo) |
| Must-have | Dual-write registration | M3 | Done (PC2 nodes register on all supernodes) |
| Must-have | Uptime monitoring | M2 | Pending |
| Must-have | SSL auto-renewal | M2 | Pending |
| Should-have | Supernode bootstrap script | M3 | Done (Mar 7) |
| Should-have | Dynamic supernode discovery | M3 | Done (Mar 7) |
| Should-have | Relay node mode | M3-M4 | Done (Mar 7) |
| Should-have | Supernode Manager dApp | M3 | Done (Mar 7) |
| Should-have | Community networking fix | M2-M3 | Done (Mar 8 — fix-networking.sh) |
| **Next** | **InterServer gateway v2.0 upgrade** | **M3** | **Waiting for go-ahead** |
| **Next** | **WireGuard bundling with app** | **M2-M3** | **Planned — prevents broken ActiveProxy fallback** |
| **Next** | **Gateway "node offline" page** | **M2** | **Planned — replaces infinite initializing** |
| Should-have | Per-domain rate limiting | M3 | Pending |
| Should-have | Node health dashboard | M4 | Pending |
| Future | On-chain supernode registry | M4-M7 | Pending |
| Future | Mesh networking | M7+ | Pending |
| Future | Geographic routing | M7+ | Pending |

### ELA Value Capture Mechanics

```
Usage → Fees → Buy ELA → Scarcity → Price Support

Mechanisms (Universal Asset Protocol — all verticals contribute):
1. Media marketplace fees (dDRM purchases)              → M3-M4   (TAM: $10-50M/yr)
2. AI model marketplace fees                            → M3-M4   (TAM: $50-200M/yr)
3. Code/plugin/dataset marketplace fees                 → M4-M5   (TAM: $20-100M/yr)
4. Supernode Access Token sales (network services)      → M3-M4   (TAM: $5-20M/yr)
5. Protocol fees (in-OS transactions)                   → M4
6. White-label protocol fees (third-party marketplaces) → M5+     (TAM: $100M+/yr)
7. Enterprise DRM-as-a-Service                          → M5+     (TAM: $50-200M/yr)
8. Agent-to-agent transaction fees                      → M7+     (TAM: $50-500M/yr)
9. Compute/storage fees                                 → M7+

Revenue split (Access Tokens):
  80% → supernode operators (proportional to bandwidth served)
  15% → Elacity protocol treasury
  5%  → ELA buyback pool

All fees → pool → market-buy ELA from DEX LPs

See docs/core/SUPERNODE_ECONOMICS.md for full strategy.
See docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md for marketplace vision.
```

---

## Monthly Release Cadence

Starting Month 1 (March 2026):

| Release | Target | Focus |
|---------|--------|-------|
| v1.1.0 | March 2026 | Merge Jetson branch, bug fixes, AV1 player |
| v1.2.0 | April 2026 | Hardware expansion, installer improvements, WireGuard bundling |
| v1.3.0 | May 2026 | `@elacity-js/access` package, Creator Dashboard dApp, fiat onramp |
| v1.4.0 | June 2026 | AI Model Marketplace alpha, `@elacity-js/asset-packager`, P2P messaging |
| v1.5.0 | July 2026 | Universal marketplace (code, datasets), mobile companion app alpha |
| v1.6.0 | August 2026 | Supernode Access Tokens, premium tiers, bandwidth metering |
| v1.7.0 | September 2026 | Protocol fees alpha, white-label SDK alpha, enterprise pilot |
| v1.8.0 | October 2026 | Developer SDK, composable assets (nested licensing) |
| v1.9.0 | November 2026 | Agent buyer support (MCP/A2A), capsule marketplace alpha |
| v1.10.0 | December 2026 | Year 1 hardening + comprehensive review |

*Releases beyond v1.10.0 defined based on Year 1 learnings.*

---

## How to Use This Document

1. **Monthly:** Review current milestone, check off completed items, plan next month
2. **Weekly:** Reference for shipping reports — what was done, what's next
3. **Quarterly:** Milestone review against DAO proposal commitments
4. **For new team members / contributors:** Start here to understand the full picture
5. **For community questions:** Point to specific sections showing progress and direction
