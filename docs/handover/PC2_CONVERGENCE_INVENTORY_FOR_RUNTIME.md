# PC2 Convergence Inventory for ElastOS Runtime

> **Date:** April 16, 2026
> **From:** Sasha Mitchell / PC2 Engineering
> **To:** Anders / Runtime Engineering
> **Purpose:** Everything PC2 has built that maps to Runtime capsules, providers, and infrastructure -- ready for the bottoms-up convergence starting with v0.1.2

### Repositories

| Repo | Branch | URL |
|------|--------|-----|
| **PC2 (main codebase)** | `feature/lit-chipotle-migration` | [github.com/Elacity/pc2.net](https://github.com/Elacity/pc2.net/tree/feature/lit-chipotle-migration) |
| **ElastOS Runtime** | `review/0.1.2` | [github.com/Elacity/elastos-runtime](https://github.com/Elacity/elastos-runtime/tree/review/0.1.2) |
| **ElastOS Launcher** (Electron) | `main` | [github.com/Elacity/elastos-launcher](https://github.com/Elacity/elastos-launcher) |
| **Elacity Market** (React dApp) | `main` | [github.com/aspect-build/elacity-app](https://github.com/aspect-build/elacity-app) |
| **Elacity JS SDK** | `main` | [github.com/aspect-build/elacity-js](https://github.com/aspect-build/elacity-js) |

---

## TL;DR

PC2 is a working personal cloud with ~50K lines of TypeScript/Rust. Everything below is built, tested, and shipping. The convergence goal: migrate these features from the PC2 monolith into Runtime capsules one at a time, starting with the pieces Anders needs most (blockchain connectivity, storage).

**What's immediately useful to Anders:**
1. ESC archive node (Contabo, fully synced) -- ready for blockchain capsule work
2. Wallet bridge patterns -- working EVM integration reference
3. 8 WASM crates targeting `wasm32-wasip1` -- same target as Runtime capsules
4. IPFS stack (Helia) -- working content addressing with DHT/Bitswap

---

## 1. Infrastructure Anders Can Use Right Now

### ESC RPC (Elastos Smart Chain)

| Resource | URL | Status |
|----------|-----|--------|
| Contabo ESC archive node | `https://38.242.211.112/rpc/esc` | Fully synced, self-signed cert |
| PC2 proxy (handles cert) | `http://localhost:4200/api/esc-rpc` | Running on any PC2 node |
| Public fallback | `https://api.ela.city/esc` | Rate-limited |

The Contabo server runs a full ESC archive node bound to `127.0.0.1:20636`, nginx proxies at `/rpc/esc`. Chain ID 20 (0x14). Standard JSON-RPC.

### Base Chain RPC

Base (chain 8453) is where our dDRM marketplace contracts live. Currently using public endpoints (Alchemy/Infura). We can set up a dedicated proxy if needed.

### Contabo Server

- IP: `38.242.211.112`
- Services: ESC archive node, nginx, available for additional capsule hosting
- Specs: Dedicated server with ample resources for additional services

---

## 2. WASM Crates (wasm32-wasip1 -- Same Target as Runtime)

These compile to the exact same WASI target the Runtime uses via Wasmtime. No recompilation or porting needed.

| Crate | Size | Purpose | Capsule Mapping |
|-------|------|---------|-----------------|
| `ddrm-renderer` | ~480KB | Text/code rendering in WASM linear memory, syntect highlighting (30+ languages), PDF rendering via lopdf | Viewer Provider Capsule |
| `aes-gcm-decrypt` | ~120KB | AES-256-GCM decryption for non-media dDRM assets | DRM Provider Capsule |
| `cenc-decrypt` | ~90KB | AES-128-CTR per-sample CENC decryption for video/audio DRM | Media DRM Provider Capsule |
| `cenc-encrypt` | ~90KB | CENC encryption for media content packaging | Creator Provider Capsule |
| `ipfs-assemble` | ~80KB | IPFS DAG reassembly (UnixFS) | Storage Provider Capsule |
| `mp4-split` | ~60KB | MP4/DASH init segment splitting for MSE player | Media Provider Capsule |
| `evm-multicall` | ~116KB | Multicall3 ABI encoder/decoder for batching EVM reads | Blockchain Provider Capsule |
| `amm-engine` | ~143KB | Uniswap V2 AMM math (price calculation) | DeFi Capsule |

All crates built with `wasm-opt` optimization, `panic = "abort"`, and SIMD-enabled where applicable.

**Source:** [`pc2-node/packages/`](https://github.com/Elacity/pc2.net/tree/feature/lit-chipotle-migration/pc2-node/packages) — each crate is a subdirectory with its own `Cargo.toml`.

**Build:**
```bash
cd pc2-node/packages/<crate>
cargo build --target wasm32-wasip1 --release
wasm-opt -O3 target/wasm32-wasip1/release/<crate>.wasm -o <crate>.wasm
```

---

## 3. PC2 Features -> Capsule Migration Map

### What becomes a Shell feature (stays in Puter)

| PC2 Feature | Description | Notes |
|-------------|-------------|-------|
| Desktop UI | Puter-based windowed desktop | Anders already has Puter in a VM |
| Dark theme | Custom CSS + theme toggle | Additive to vanilla Puter |
| Settings panel | User preferences, wallet config | Additive |
| Taskbar apps | App launcher with icons | Additive |
| File manager | Browse/upload/download | Puter built-in |

### What becomes a Provider Capsule

| PC2 Feature | Lines | Provider Type | Capability | Priority |
|-------------|-------|---------------|------------|----------|
| **Wallet Bridge** | ~800 | `wallet-provider` | `wallet:sign`, `wallet:read`, `network:rpc` | HIGH -- needed for blockchain connectivity |
| **IPFS Storage** | ~1200 | `storage-provider` | `storage:pin`, `storage:fetch`, `storage:announce` | HIGH -- already have `ipfs-provider` capsule slot |
| **dDRM Decrypt** | ~600 | `drm-provider` | `drm:decrypt`, `drm:verify-access` | MEDIUM -- needs blockchain provider first |
| **dDRM Encrypt** | ~400 | `drm-provider` | `drm:encrypt`, `drm:package` | MEDIUM |
| **AI Chat** | ~1500 | `ai-provider` | `ai:complete`, `ai:embed` | LOW -- Runtime already has `llama-provider` |
| **Content Seeding** | ~500 | `cdn-provider` | `storage:seed`, `storage:announce` | LOW |

### What becomes an App Capsule

| PC2 App | Description | Capsule Type | Viewer For |
|---------|-------------|--------------|------------|
| **Elacity Market** | dDRM marketplace (browse, buy, sell) | `wasm` or `microvm` | -- |
| **Elacity Creator** | Content minting dashboard | `wasm` or `microvm` | -- |
| **Elastos NFT** | ESC NFT marketplace | `wasm` or `microvm` | -- |
| **Elacity Player** | DASH/CENC video player | `wasm` | `.mp4`, `.mkv`, audio |
| **Elacity Viewer** | dDRM content viewer (images, PDF, 3D, code) | `wasm` | `.ddrm.json`, images, PDF |
| **Glide Finance** | DEX (Uniswap V2 on ESC) | `wasm` or `microvm` | -- |

### What maps to existing Runtime capsules

| PC2 Component | Runtime Capsule | Integration Path |
|---------------|-----------------|------------------|
| IPFS (Helia JS) | `ipfs-provider` | Replace JS Helia with Rust IPFS; or wrap as provider |
| AI chat | `ai-provider` + `llama-provider` | Runtime already has this; merge features |
| DID (wallet-based) | `did-provider` | Bridge EVM wallet identity to `did:key` |
| NAT traversal (WireGuard) | `tunnel-provider` | Runtime has this; our WireGuard config is reference |
| Site hosting | `site-provider` | Runtime has this; our `*.ela.city` DNS is infrastructure |

---

## 4. Wallet Bridge -- Reference Implementation

The wallet bridge is the most immediately useful piece for Anders' blockchain connectivity work. It's a working pattern for EVM integration inside an iframe/capsule context.

**How it works:**
```
App (iframe/capsule)
  → window.ethereum.request({ method: 'eth_sendTransaction', ... })
  → postMessage to parent (PC2 shell)
  → Shell wallet bridge classifies RPC method:
      wallet:read  → direct RPC call to chain node
      wallet:sign  → forward to MetaMask/WalletConnect/Particle
      network:rpc  → cached RPC with TTL per method
  → Response back to app via postMessage
```

**Key files:**
- [`pc2-node/src/wallet-bridge/pc2-wallet-bridge.js`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/src/wallet-bridge/pc2-wallet-bridge.js) -- Parent-side handler (800 lines)
- [`pc2-node/frontend/pc2-wallet-provider.js`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/frontend/pc2-wallet-provider.js) -- EIP-1193 shim injected into iframes

**Chain support:** 9 chains configured with RPCs + metadata, including ESC (20), Base (8453), Ethereum (1), BSC (56), Polygon (137).

**Capability classification already done:**
```javascript
WALLET_READ:  ['eth_chainId', 'eth_accounts', 'eth_getBalance', 'eth_call', 'eth_estimateGas', ...]
WALLET_SIGN:  ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', ...]
NETWORK_RPC:  ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', ...]
```

This maps directly to Runtime capability tokens: `{ action: "wallet:sign", chain: 20 }`.

---

## 5. dDRM Pipeline -- The Biggest Value-Add

This is the crown jewel for the convergence. A complete digital rights management system that could become the reference DRM Provider Capsule.

### Architecture
```
Creator mints asset:
  1. Server generates 32-byte CEK (Content Encryption Key)
  2. File encrypted with AES-256-GCM using CEK
  3. CEK sent to Lit Protocol Chipotle TEE → encrypted with PKP
  4. Encrypted file → IPFS, ciphertext → on-chain metadata
  5. ACCESS_TOKEN minted on Base (chain 8453)

Buyer views asset:
  1. Runtime checks on-chain: hasAccessByContentId(buyer, kid)
  2. If access: Lit TEE decrypts → returns original CEK
  3. Server decrypts file with AES-256-GCM + recovered CEK
  4. WASM renderer converts to pixels (never raw to browser)
```

### Smart Contracts (Base Mainnet, chain 8453)

| Contract | Address | Explorer | Purpose |
|----------|---------|----------|---------|
| AuthorityGateway | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` | [BaseScan](https://basescan.org/address/0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29) | Buy/sell ACCESS_TOKENs |
| TradeGateway | `0x9eC53758b698f9F68C0654DDd9159173a159a459` | [BaseScan](https://basescan.org/address/0x9eC53758b698f9F68C0654DDd9159173a159a459) | Trade ROYALTY_SHAREs |
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` | [BaseScan](https://basescan.org/address/0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575) | Content registry |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` | [BaseScan](https://basescan.org/address/0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6) | Creator channels |

### As a Runtime Provider Capsule

```
drm-provider capsule:
  capabilities_required:
    - wallet:read (check on-chain ownership)
    - network:rpc (Base chain 8453 for contract calls)
    - storage:fetch (IPFS for encrypted content)
  capabilities_provided:
    - drm:decrypt (returns decrypted bytes)
    - drm:encrypt (returns encrypted + metadata)
    - drm:verify-access (checks on-chain ownership)
  
  internal WASM crates:
    - aes-gcm-decrypt (non-media)
    - cenc-decrypt (media)
    - cenc-encrypt (packaging)
```

---

## 6. Capsule-Compatible Work Already Done

We've already introduced Runtime-compatible concepts at trust boundaries:

| What | Where | Purpose |
|------|-------|---------|
| `CAPABILITY_SCOPES` constant | [`pc2-node/src/types/capabilities.ts`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/src/types/capabilities.ts) | 1:1 mapping to Runtime capability token actions |
| `CapabilityPrincipal` interface | [`pc2-node/src/middleware.ts`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/src/middleware.ts) | Structured auth with type/capabilities/scopes |
| Ed25519 signature verification | [`pc2-node/src/services/AppInstallService.ts`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/src/services/AppInstallService.ts) | Verifies app bundle signatures (warn-only in v1) |
| Provider operation interfaces | [`pc2-node/src/services/providers/types.ts`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/src/services/providers/types.ts) | `DRMProvider`, `StorageProvider`, `IdentityProvider`, `ComputeProvider` |
| Wallet bridge origin tracking | [`pc2-wallet-bridge.js`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/pc2-node/src/wallet-bridge/pc2-wallet-bridge.js) | Origin validation + RPC method capability classification |
| dDRM capsule content hashing | Creator app | SHA-256 `capsuleHash` + `signedBy` fields on `.ddrm` capsules |
| Audit logging | `agent_audit_log` table | Logs skill loads, AI actions with hash verification |
| App manifests | 7 `app.json` files | `api_endpoints`, `postMessage_events`, `external_services` |
| Namespace mapping | [`NAMESPACE_MAPPING.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/core/NAMESPACE_MAPPING.md) | PC2 paths → `localhost://` namespace table |

---

## 7. Answering Anders' Question

> "The vanilla puter UI/X is easiest from Puter or our PC2 Puter UI?"

**Recommendation: Start from vanilla Puter, layer PC2 additions as capsules.**

Reasoning:
- Vanilla Puter is what the Runtime already hosts
- PC2's Puter modifications are all **additive** (wallet auth, dark theme, settings, dApp launcher, AI chat, wallet bridge)
- Starting from vanilla means Runtime's existing Puter integration works immediately
- PC2 customizations migrate one-by-one as shell extensions or capsule-provided UI

### Bottoms-Up Migration Sequence

```
Phase 1 (Now -- Runtime v0.1.2):
  Runtime: capsule orchestration + blockchain connectivity
  PC2 provides: ESC RPC endpoint, wallet bridge reference code, convergence doc (this)
  
Phase 2 (Next month):
  wallet-provider capsule (EVM signing, chain switching)
    → Uses wallet bridge patterns from PC2
    → Enables blockchain connectivity in Runtime
  storage-provider capsule (IPFS pin/fetch/serve)
    → Wraps our Helia stack or replaces with Rust IPFS
    → Enables content-addressed storage in Runtime

Phase 3 (Month after):
  drm-provider capsule (encrypt/decrypt via WASM crates)
    → Our 8 WASM crates already target wasm32-wasip1
    → Needs wallet-provider + storage-provider from Phase 2
    → Needs Lit Protocol client (or equivalent TEE)

Phase 4 (Ongoing):
  App capsules one by one:
    → Market, Creator, Player, Viewer as signed capsules
    → Each declares permissions in capsule.json
    → Runtime enforces capability tokens
```

---

## 8. What We're NOT Bringing

These are PC2 v1 patterns that should be replaced by Runtime equivalents:

| PC2 Pattern | Runtime Replacement |
|-------------|-------------------|
| Session token = full access | Capability tokens (scoped, time-limited) |
| iframe sandbox (escapable) | WASM/microVM sandbox (enforced) |
| Express.js static file serving | Runtime HTTP proxy from capsule |
| SQLite for everything | Provider-owned storage with capability gates |
| Single wallet identity | `did:key` with optional EVM bridge |
| npm/Node.js ecosystem | Cargo/Rust crates (for trusted core) |

---

## 9. Reference Documents

All in the [PC2 repository](https://github.com/Elacity/pc2.net/tree/feature/lit-chipotle-migration):

| Document | Link | What It Covers |
|----------|------|---------------|
| Architecture Convergence | [`docs/core/ARCHITECTURE_CONVERGENCE.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/core/ARCHITECTURE_CONVERGENCE.md) | 1330-line deep dive: PC2 vs Runtime, mapping every component |
| Capsule Compatibility | [`docs/core/CAPSULE_COMPATIBILITY.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/core/CAPSULE_COMPATIBILITY.md) | Refactoring inventory, provider mapping, status table |
| Namespace Mapping | [`docs/core/NAMESPACE_MAPPING.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/core/NAMESPACE_MAPPING.md) | PC2 paths → `localhost://` namespace |
| App Manifest Spec | [`docs/core/APP_MANIFEST_SPEC.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/core/APP_MANIFEST_SPEC.md) | `app.json` schema, forward-compatible with Runtime |
| dDRM Technical Handover | `docs/handover/IRZHY_DDRM_HANDOVER.md` *(private — contains secrets, not on GitHub)* | Complete dDRM implementation guide |
| dApp Runtime Strategy | [`docs/updates/DApp_Runtime_Strategy_Apr_2026.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/updates/DApp_Runtime_Strategy_Apr_2026.md) | iframe → capsule evolution roadmap |
| PC2 Roadmap | [`docs/core/ROADMAP.md`](https://github.com/Elacity/pc2.net/blob/feature/lit-chipotle-migration/docs/core/ROADMAP.md) | Full milestones + Runtime integration status table |

### Live Products

| Product | URL |
|---------|-----|
| Elacity Market (live) | [https://ela.city](https://ela.city) |
| ElastOS Launcher releases | [github.com/Elacity/elastos-launcher/releases](https://github.com/Elacity/elastos-launcher/releases/tag/v1.2.2) |
| Runtime install script | `curl -fsSL https://elastos.elacitylabs.com/install.sh \| bash` |

---

## 10. First Capsules on ElastOS — the dapp-store unlock

The 6 apps in [`pc2-node/data/test-apps/`](https://github.com/Elacity/pc2.net/tree/feature/lit-chipotle-migration/pc2-node/data/test-apps) (Market, Creator, Elastos NFT, Glide Finance, Elacity Player, dDRM Viewer) are **already in the right shape to become the first 6 capsules on ElastOS Runtime v0.1.x**. Each one ships with:

- Valid `app.json` (capabilities, services, external_services, postMessage_events)
- Working `index.html` entry
- Compatible iframe sandbox model
- Same EIP-1193 wallet shim (`pc2-wallet-provider.js`) the Runtime will expose

### v1.2.x positioning — system apps vs dapp-store capsules

> **Founder direction (2026-04-23):** the v1.2.1 dapp-store unlock targets **two apps as removable capsules**. The four protocol apps stay built-in.

| Role | Apps | v1.2.x behaviour |
|---|---|---|
| **System / built-in** (bundled in PC2, can't be uninstalled) | `elacity-market`, `elacity-creator`, `elacity-player`, `ddrm-viewer` | Ship inside the launcher binary. Updates delivered via signed registry entries (CID + sig). These are the dDRM protocol surface — Market is the marketplace UI, Creator is the minting UI, Player opens any `.ddrm` media file, Viewer opens any `.ddrm` non-media file. Removing them would break PC2's value prop. |
| **Dapp-store capsules** (downloadable from `apps.ela.city`, removable) | `elastos-nft` (Galaxy NFT marketplace), `glide-finance` (Glide DEX) | Uninstalled by default on fresh PC2; one-click install from start menu. First proof points for the dapp-store mechanic. Risk-bounded — install-flow regressions don't affect Market/Creator/Player/Viewer users. |

**All 6 apps still get a CID + Ed25519 signature in the registry.** The split is purely an install-experience choice (does the user have to opt in?), not an infrastructure choice. Same packager output, same IPFS pin, same registry shape — just a `role: "system"` vs `role: "dapp"` field that determines whether the launcher preinstalls it.

### What's missing for the unlock

1. **Tar.gz extraction in `extractBundle`** (~20 LOC + `tar` dep)
2. **Bundle packager script** — tarball + sign + IPFS-pin (~80 LOC standalone)
3. **Registry entries with real CIDs + signatures** for all 6 apps (supernode-side, no node code change), with `role: "system" | "dapp"`
4. **Frontend "Install" button** on `apps.ela.city` for `role: "dapp"` entries (NFT, Glide)
5. **Launcher start-menu update** — show NFT and Glide as "Available" tiles on fresh PC2 (one-click install)
6. **Elacity Labs Ed25519 dev signing key** + key-of-record published
7. **Supernode pin set** — InterServer + Contabo each pin every CID they advertise in the registry (daily cron, ~30 LOC each). Today the supernodes serve registry **metadata** but not bytes; this makes them act as guaranteed seeders. Combined with `ipfs.ela.city` (the canonical Elacity Kubo node, which already hosts media + NFT artwork) and the per-PC2 `ContentSeedingService` (every install adds another seeder organically), every capsule has **four independent sources**. Removes single-host dependency on `ipfs.ela.city`; fresh installs are never DHT-gambled.

Total effort: ~3 eng-days for the packager/extractor/signing, ~2 days for the install UX, ~half a day per supernode operator for the pin-set cron. Purely additive — does not touch v1.2 release surface. Tracked in detail in [V1.2_ADOPTION_ROADMAP.md](../core/V1.2_ADOPTION_ROADMAP.md#first-capsules-on-elastos--the-dapp-store-unlock).

**Why this matters for runtime convergence:** when Anders is ready to host capsules in Runtime v0.1.x, the same tarball + signature + manifest **work without modification**. Capsule loader reads the same `app.json`, validates the same Ed25519 sig, mounts the same wallet bridge. The system/dapp distinction stays in the registry as a "preinstalled" flag — Runtime treats both the same; the Shell preinstalls the system ones at first boot. **Zero rewrite — these 6 apps become the first 6 capsules in the ElastOS app catalog on day 1 of Runtime v0.1.2.**

### Free vs. paid capsules — the dDRM extension

The dapp-store flow above describes **free capsules** (signed tarball, anyone can install). The same protocol naturally extends to **paid capsules** — the dDRM bytes pipeline is content-type agnostic, so the same encryption + Lit/Chipotle wrap + on-chain ACCESS_TOKEN that today gates a video can gate a `.tar.gz` of a capsule.

Mapped to Anders' three-tier architecture (Runtime → Shell → Capsules):

- **Free capsule install** = Anders' existing signed publish/install/update flow. Drop-in compatible with our packager output. Lives in the Runtime + Shell tiers.
- **Paid capsule install** = a `drm-provider` capsule in the Capsules tier (sibling of `wallet-provider`, `storage-provider`, `payment-provider`). When the Shell sees `manifest.distribution.drm = true`, it delegates fetch+decrypt to `drm-provider` before handing the bytes to the Runtime's signature-verify-and-install path. **The Runtime trusted base does not need to know dDRM exists.** This is the right boundary — small trusted base, dDRM stays in userland where the protocol can evolve.

Practically: ~1 eng-week additional work on top of the free-capsule unlock (~30 LOC packager extension + ~50 LOC `AppInstallService.install()` extension + ~1 day Creator UI + ~1 day Market UI). All composition of components we already have in production. No new contracts, no new infrastructure.

This means **the dapp store IS the Elacity Marketplace.** Free capsules are listings with price 0, paid capsules are listings with a price tag, same wallet flow, same dDRM contracts, same royalty mechanics. Full mechanics in [V1.2_ADOPTION_ROADMAP.md §"Paid Capsules"](../core/V1.2_ADOPTION_ROADMAP.md#paid-capsules--when-the-dapp-store-is-the-marketplace).

| App | v1.2.x role | Bundled today | IPFS-installable (post Phase 1) | Runtime capsule (Anders Phase 4) |
|---|---|---|---|---|
| `elacity-market` | **system** (built-in) | ✅ | 📋 needs CID + sig (for update channel) | 📋 same tarball, preinstalled by Shell |
| `elacity-creator` | **system** (built-in) | ✅ | 📋 needs CID + sig (for update channel) | 📋 same tarball, preinstalled by Shell |
| `elacity-player` | **system** (built-in, media runtime) | ✅ (rebranded Mar 31) | 📋 needs CID + sig (for update channel) | 📋 same tarball, preinstalled by Shell |
| `ddrm-viewer` | **system** (built-in, non-media runtime) | ✅ (rebranded Mar 31) | 📋 needs CID + sig (for update channel) | 📋 same tarball, preinstalled by Shell |
| `elastos-nft` | **dapp** (downloadable) | ✅ | 📋 needs CID + sig — **first dapp-store capsule** | 📋 same tarball, user-installed |
| `glide-finance` | **dapp** (downloadable) | ✅ | 📋 needs CID + sig — **first dapp-store capsule** | 📋 same tarball, user-installed |

---

## Quick Reference: What PC2 Ships Today

| Category | Count | Highlights |
|----------|-------|-----------|
| Apps | 7 | Market, Creator, NFT, Glide DEX, Player, Viewer, dDRM Viewer |
| WASM crates | 8 | All `wasm32-wasip1`, crypto + media + EVM |
| API endpoints | ~100 | File ops, IPFS, AI, wallet, dDRM, terminal, backup |
| Smart contracts | 4 | AuthorityGateway, TradeGateway, CoreStorage, ChannelCore ([BaseScan links above](#smart-contracts-base-mainnet-chain-8453)) |
| Supported chains | 9 | ESC, Base, Ethereum, BSC, Polygon, Arbitrum, Optimism, Avalanche, Sonic |
| Content types | 15+ | Video, audio, images, PDF, 3D models, code, datasets, fonts, archives |
| macOS launcher | Notarized | [v1.2.2 DMG download](https://github.com/Elacity/elastos-launcher/releases/tag/v1.2.2), Apple Developer ID, double-click install |
| Linux | AppImage + deb | [v1.2.2 downloads](https://github.com/Elacity/elastos-launcher/releases/tag/v1.2.2), Jetson + x86_64 verified |
