# PC2 Convergence Inventory for ElastOS Runtime

> **Date:** April 16, 2026
> **From:** Sasha Mitchell / PC2 Engineering
> **To:** Anders / Runtime Engineering
> **Purpose:** Everything PC2 has built that maps to Runtime capsules, providers, and infrastructure -- ready for the bottoms-up convergence starting with v0.1.2

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
- `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` -- Parent-side handler (800 lines)
- `pc2-node/frontend/pc2-wallet-provider.js` -- EIP-1193 shim injected into iframes

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

| Contract | Address | Purpose |
|----------|---------|---------|
| AuthorityGateway | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` | Buy/sell ACCESS_TOKENs |
| TradeGateway | `0x9eC53758b698f9F68C0654DDd9159173a159a459` | Trade ROYALTY_SHAREs |
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` | Content registry |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` | Creator channels |

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
| `CAPABILITY_SCOPES` constant | `types/capabilities.ts` | 1:1 mapping to Runtime capability token actions |
| `CapabilityPrincipal` interface | `middleware.ts` | Structured auth with type/capabilities/scopes |
| Ed25519 signature verification | `AppInstallService.ts` | Verifies app bundle signatures (warn-only in v1) |
| Provider operation interfaces | `services/providers/types.ts` | `DRMProvider`, `StorageProvider`, `IdentityProvider`, `ComputeProvider` |
| Wallet bridge origin tracking | `pc2-wallet-bridge.js` | Origin validation + RPC method capability classification |
| dDRM capsule content hashing | Creator app | SHA-256 `capsuleHash` + `signedBy` fields on `.ddrm` capsules |
| Audit logging | `agent_audit_log` table | Logs skill loads, AI actions with hash verification |
| App manifests | 7 `app.json` files | `api_endpoints`, `postMessage_events`, `external_services` |
| Namespace mapping | `NAMESPACE_MAPPING.md` | PC2 paths → `localhost://` namespace table |

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

| Document | Location | What It Covers |
|----------|----------|---------------|
| Architecture Convergence | `docs/core/ARCHITECTURE_CONVERGENCE.md` | 1330-line deep dive: PC2 vs Runtime, mapping every component |
| Capsule Compatibility | `docs/core/CAPSULE_COMPATIBILITY.md` | Refactoring inventory, provider mapping, status table |
| Namespace Mapping | `docs/core/NAMESPACE_MAPPING.md` | PC2 paths → `localhost://` namespace |
| App Manifest Spec | `docs/core/APP_MANIFEST_SPEC.md` | `app.json` schema, forward-compatible with Runtime |
| dDRM Technical Handover | `docs/handover/IRZHY_DDRM_HANDOVER.md` | Complete dDRM implementation guide |
| dApp Runtime Strategy | `docs/updates/DApp_Runtime_Strategy_Apr_2026.md` | iframe → capsule evolution roadmap |

---

## Quick Reference: What PC2 Ships Today

| Category | Count | Highlights |
|----------|-------|-----------|
| Apps | 7 | Market, Creator, NFT, Glide DEX, Player, Viewer, dDRM Viewer |
| WASM crates | 8 | All `wasm32-wasip1`, crypto + media + EVM |
| API endpoints | ~100 | File ops, IPFS, AI, wallet, dDRM, terminal, backup |
| Smart contracts | 4 | AuthorityGateway, TradeGateway, CoreStorage, ChannelCore |
| Supported chains | 9 | ESC, Base, Ethereum, BSC, Polygon, Arbitrum, Optimism, Avalanche, Sonic |
| Content types | 15+ | Video, audio, images, PDF, 3D models, code, datasets, fonts, archives |
| macOS launcher | Notarized | v1.2.2, Apple Developer ID, double-click install |
| Linux | AppImage + deb | Jetson + x86_64 verified |
