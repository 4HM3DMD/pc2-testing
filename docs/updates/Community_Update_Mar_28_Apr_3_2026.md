# ElastOS PC2 — Weekly Community Update
## March 28 – April 3, 2026

> **18 commits** across `feature/lit-chipotle-migration` | **~10,000 lines of Elacity code added** | **102 core files touched** | **724 total files changed** (including Glide Finance static bundle)

---

## Table of Contents

1. [The Big Picture — What Happened This Week](#the-big-picture)
2. [Particle Auth & Agent Wallet — Email Login to On-Chain Minting](#particle-auth--agent-wallet)
3. [Lit Protocol Chipotle — Production dDRM Is Live](#lit-protocol-chipotle--production-ddrm-is-live)
4. [Free Content Minting — Not Everything Needs DRM](#free-content-minting)
5. [Glide Finance DEX — First Third-Party dApp on PC2](#glide-finance-dex--first-third-party-dapp-on-pc2)
6. [Runtime Player Unification — One Player for All Content](#runtime-player-unification)
7. [Creator Dashboard Polish — Consolidated Form UX](#creator-dashboard-polish)
8. [Capsule-Compatible Refactoring — Designing for Runtime v2 Today](#capsule-compatible-refactoring)
9. [WASM/Rust Consolidation — Moving Security-Sensitive Code into Sandboxes](#wasmrust-consolidation)
10. [CEK Exposure Audit — Honest Security Assessment](#cek-exposure-audit)
11. [Wallet Bridge — Multi-Chain, Multi-Wallet, Capability-Ready](#wallet-bridge)
12. [dDRM Security Hardening — 7 Vulnerabilities Closed](#ddrm-security-hardening)
13. [Apple Developer Program — macOS Distribution Unblocked](#apple-developer-program)
14. [Elastos Documentation Portal — docs.elastos.net](#elastos-documentation-portal--docselastosnet)
15. [KuMining Partnership — ELA Merge-Mining on KuCoin](#kumining-partnership--ela-merge-mining-on-kucoin)
16. [Ecosystem Operations & Community](#ecosystem-operations--community)
17. [Documentation & Strategy](#documentation--strategy)
18. [What's Next](#whats-next)
19. [Summary Statistics](#summary-statistics)

---

## The Big Picture

This was the week where PC2 went from "impressive demo" to "production-ready pipeline." Three things happened that transformed the system:

1. **Lit Protocol Chipotle went live on mainnet**, and we completed end-to-end integration the same day. For the first time, the complete dDRM pipeline — encrypt, mint, buy, decrypt, render — works on production infrastructure with real money.

2. **The first third-party dApp (Glide Finance DEX) was packaged and runs inside PC2** without any code changes to Glide. This proves the dApp Store model: apps distributed by content hash, running locally, with wallet access mediated by bridges.

3. **A deep study of Anders' ElastOS Runtime** produced concrete capsule-compatible refactoring — not theoretical planning, but actual code that runs today while being designed to slot into Runtime v2 capsules when ready.

4. **The Elastos Documentation Portal ([docs.elastos.net](https://docs.elastos.net)) launched**, giving the entire ecosystem a unified, AI-searchable, version-controlled documentation home for the first time. And ELA merge-mining went live on KuCoin's KuMining platform, expanding accessibility for miners.

**In plain English:** We connected to the production encryption network, proved that other people's apps can run on our system, started building the bridge between today's PC2 and tomorrow's capsule-based Runtime, shipped the ecosystem's first proper documentation portal, and landed a mining partnership with a top exchange — all without breaking a single existing feature.

---

## Particle Auth & Agent Wallet — Email Login to On-Chain Minting

**Why this matters:** Most people don't have MetaMask. Most people don't know what a private key is. If Elacity requires crypto-native knowledge to use, it will never reach mainstream users. Particle Auth solves this by letting users log in with email, Google, or Apple — and automatically creating a wallet behind the scenes.

**What was built (Mar 30 – Mar 31):**

### The Problem We Solved
Before this week, PC2 only supported MetaMask-style browser extension wallets. If you logged in with email (via Particle Network), you could browse but couldn't actually do anything useful — no buying, no minting, no sending tokens. The system simply didn't know how to route transactions through Particle's embedded signer.

### Particle Auth Integration
- **Dedicated Particle project** (`01cdbdd6`) — PC2 now has its own registered project on Particle Network with email/social login, EOA wallet, and Universal Account (Smart Account) support
- **EOA email send** — Users who logged in with email can now send tokens from their basic wallet (EOA) via Particle's in-app signing popup. No MetaMask needed.
- **Agent Wallet (Universal Account) send** — Full 3-phase flow: create UserOp → sign rootHash → submit to bundler. This is the gasless, programmable wallet that Particle provides for every user.

### How Signing Works Now
When a dApp (Market, Creator) triggers a transaction for an email-logged-in user:
1. The wallet bridge detects the user is embedded (no MetaMask)
2. Instead of calling `window.ethereum`, it routes to Particle's signing popup
3. The popup shows what's being signed in human-readable format
4. User clicks "Confirm" — Particle's MPC-TSS (Multi-Party Computation) signs the transaction without ever exposing the private key
5. Transaction is broadcast to the blockchain

**Why this approach:** MPC-TSS means no single party (not Particle, not the user's device, not PC2) ever holds the complete private key. It's split across multiple parties and reconstructed only during signing.

### Agent Wallet Minting in Creator Dashboard (Mar 31)
The Creator Dashboard can now mint content using the Agent Wallet (Smart Account):

- **Dual-wallet channel creation** — When creating a channel (think: a creator's storefront), you choose which wallet pays. The channel remembers which wallet created it.
- **Channel-dictated wallet selection** — When you publish content to a channel, the wallet is automatically determined by who owns the channel. No confusing wallet-picker at publish time.
- **Batch minting** — Agent Wallet mints use `parentExecuteSmartAccountBatch` to bundle the mint transaction and role grant into a single UserOp. One signature, two on-chain operations.
- **Transaction hash resolution** — Particle's Universal Account returns an internal transaction ID, not a standard blockchain hash. We now poll `eth_getLogs` for the real Base chain transaction hash, fetch the full receipt, and parse events correctly for both `tokenId` and `opContract`.
- **Retry mechanism** — If the batch fails (e.g., "Insufficient balance for gas fees"), inline "Retry" / "Cancel" buttons appear on the progress step. No need to restart the entire publish pipeline.

### Bug Fixes (Mar 30)
- **Auto re-login after logout** — Clearing wagmi/ConnectKit persistence so users can actually log out
- **Dual-jQuery UI freeze** — Signing popup caused the main UI to freeze; fixed with proper event guard
- **EOA/SA address race condition** — Market transactions sometimes used the wrong wallet address
- **Scoped disconnect** — `disconnect_particle` now only fires in wallet mode, preventing interference with email sessions

**Commits:** `b05841e5`, `c3124137`, `265ac047`, `306d022e`, `51abd0e9`, `08adec4c`, `315ed105`, `0bc255d3`, `ece35c0b`

---

## Lit Protocol Chipotle — Production dDRM Is Live

**Why this matters:** Lit Protocol is the encryption backbone for all dDRM-protected content on Elacity. It's the service that ensures only authorized buyers can decrypt content. Until this week, we were using a development network — testing with play money. Now it's real.

**What happened:** Lit Protocol's Chipotle v3 network went live on mainnet (April 1, 2026), and we completed full production integration within 24 hours.

### What "Production" Means
| Before (Dev Network) | After (Mainnet) |
|----------------------|-----------------|
| Free test credits | Real money ($0.01 per operation) |
| Shared dev infrastructure | Dedicated TEE workers |
| Could go down without notice | SLA-backed uptime |
| Test keys and actions | Production PKP keys + registered Lit Actions |
| No cost management | Session caching + rate limiting + promise coalescing |

### The Complete dDRM Pipeline (Verified E2E)

```
Creator publishes:
  File → AES-256-GCM encrypt (WASM) → IPFS upload → On-chain mint
                                            ↑
                              CEK wrapped by Lit Protocol PKP
                              (Content Encryption Key)

Buyer purchases:
  Buy ACCESS_TOKEN on-chain → AuthorityGateway verifies ownership
  → Lit Action checks on-chain, returns CEK → WASM decrypt → Render
```

**Every asset type verified:** PDF, image, video (DASH/CENC), audio. All formats encrypt, mint, purchase, decrypt, and render correctly.

### Cost Model
- **$0.01 per Lit Action execution** (one for encrypt, one for decrypt, <1 second each)
- **Session cache** — Multi-page PDFs cost $0.01/session, not $0.01/page
- **Promise coalescing** — If 5 concurrent requests need the same CEK, only 1 Lit call is made
- **Rate limiting** — 30 calls/min per wallet prevents abuse of shared quota
- **$10 funded** — enough for ~1,000 operations during initial rollout
- **Break-even vs own TEE** — ~45,000 executions/month ($450/month)

**Commits:** `7e7affcc`, `b48ffb7b`

---

## Free Content Minting — Not Everything Needs DRM

**Why this matters:** Not all content needs encryption. Podcasters sharing free episodes, artists giving away promotional tracks, educators publishing open courseware — they want on-chain provenance and tokenized ownership without the overhead of encryption. Forcing everything through the DRM pipeline adds latency, Lit costs, and complexity for no benefit.

**What was built (Apr 2):**

### How It Works
- When a creator publishes content and sets the price to zero (or explicitly marks it "free"), the pipeline skips Lit Protocol entirely
- Content is packaged as cleartext DASH segments — the same adaptive streaming format used for DRM content, but without encryption
- An ACCESS_TOKEN is still minted on-chain, giving the creator provenance and the buyer a proof-of-access
- The `.ddrm` capsule descriptor is saved with `encrypted: false`, so the player knows to skip decryption
- **Zero Lit cost** for free content — no encrypt, no decrypt, no session, no API call

### Why This Matters for the Economy
- **Creators can offer "loss leaders"** — free tracks that drive traffic to paid albums
- **Open educational content** — textbooks, courses, tutorials with on-chain attribution
- **Protocol fee still applies** — 5% on any resale, even of free content (if the creator enables resale)
- **Same pipeline, same UX** — from the user's perspective, free and paid content look identical in the marketplace

**Commit:** `b48ffb7b`

---

## Glide Finance DEX — First Third-Party dApp on PC2

**Why this matters:** If PC2 can only run apps that we build, it's not a platform — it's a product. The entire vision of a personal cloud computer depends on being able to install and run other people's software. Glide Finance is the proof that this works.

**What was built (Apr 1–2):**

### What Is Glide Finance?
Glide is a decentralized exchange (DEX) on Elastos Smart Chain — it lets users swap tokens, provide liquidity, stake, and earn rewards. It's the biggest DeFi application on the Elastos network.

### What We Proved
1. **Zero code changes to Glide** — The original React frontend runs unmodified inside a PC2 sandboxed iframe. We didn't fork Glide, we didn't patch Glide. We packaged the static build and served it locally.
2. **The wallet bridge pattern scales** — `postMessage` from iframe → parent handler → `window.ethereum` works for any EVM dApp. MetaMask, WalletConnect, and Particle Auth all work through the same bridge.
3. **On-chain confirmed** — Token swaps verified on ESC (tx `0xb5b9...35b1`), token approvals working, LP operations functional.
4. **RPC caching dramatically improves performance** — In-memory TTL cache per method: `eth_chainId` cached for 1 hour, `eth_gasPrice` for 5 seconds, `eth_getCode` for 5 minutes. Result: **38x speedup** on cached methods.
5. **Auto-connect simplifies UX** — dApps auto-connect to the user's wallet without manual connection steps. No "Connect Wallet" button.

### Working Features
| Feature | Status |
|---------|--------|
| Swap | Working — on-chain confirmed |
| Liquidity (Add/Remove) | Working — LP operations verified |
| Farm | Working — stake LP tokens, view rewards |
| Stake (Pools) | Working — single-asset staking |
| stELA (Liquid Staking) | Working — interface loads |
| Analytics | Working — TVL, volume, token data |
| Governance | Working — links to Snapshot |
| Bridge | **Hidden** — requires per-capsule chain isolation (future) |

### Why Bridge Is Hidden (and Why That's Fine)
Glide's Bridge page fires rapid `wallet_switchEthereumChain` calls to ESC → BSC → ETH → ESC during initialization to load multi-chain balances. In PC2's single-proxy iframe architecture, these rapid switches destabilize ethers.js v5 providers. We tried three approaches (dynamic `bridgeChainId`, iframe reload, `NETWORK_ERROR` suppression) — all failed. The Bridge tab is hidden via CSS + MutationObserver. This limitation is architectural and will be solved in Runtime v2's capsule model, where each app gets its own capability-scoped network access.

### WASM Performance Crates (Built, Available for Future Use)
Two new Rust/WASM crates were built alongside Glide:
- **`evm-multicall`** (116KB) — Multicall3 ABI encoder/decoder for batching EVM read calls
- **`amm-engine`** (143KB) — Uniswap V2 AMM math engine (getAmountOut, multi-hop routing, price impact)

These aren't wired into Glide (it works fine without them) but are ready for when we build a native DEX UI or need to optimize RPC call volume.

### Supernode ESC RPC
- **Self-sovereign chain access** — Read-only ESC full node on Contabo supernode (systemd service, method whitelist, gateway proxy at `/rpc/esc`)
- **Status:** Sync initiated, completion pending verification

**Commits:** `1fcb2ae9`, `71bba594`

---

## Runtime Player Unification — One Player for All Content

**Why this matters:** Before this week, PC2 had a split personality. DRM-protected videos opened in our sophisticated Elacity Player with DASH streaming and CENC decryption. Unprotected videos opened in a bare `<video>` tag. Images opened in a basic viewer. PDFs opened in a PDF.js wrapper. The experience was inconsistent — like having two different operating systems depending on whether your content was encrypted.

**What was built (Mar 31 – Apr 1):**

### The Unification
Now **all content opens in the Elacity runtime apps** — whether it's protected or not.

### Elacity Player (Cleartext Mode)
The WASM CENC-decrypting media player (`pc2-media-runtime`) now has a cleartext mode. When opened with `cleartext=true`:
- Sets `video.src` directly via the `/read` endpoint
- Bypasses the entire DASH/CENC decryption pipeline
- All player controls (seek, volume, fullscreen, progress bar, time display) work identically
- Audio-only files display a centered audio icon
- Browser codec warnings display gracefully for unsupported formats
- **DRM functionality completely preserved** — the cleartext path returns early before any DRM code executes

### Elacity Viewer (Cleartext Mode)
The dDRM Viewer (`ddrm-viewer`) now supports cleartext rendering for all non-media types:
- **Images** (JPG, PNG, GIF, WebP, SVG, BMP) — full zoom support
- **PDFs** — client-side rendering via PDF.js with page navigation and zoom
- **3D Models** (GLB, GLTF, OBJ, STL, FBX) — Three.js viewer
- **Data Files** (CSV, TSV) — table viewer
- **Fonts** (TTF, OTF, WOFF, WOFF2) — font preview
- **Archives** (ZIP) — archive browser

### Unified File-Open Routing
A new `RUNTIME_EXTENSIONS` constant in `open_item.js` maps **35+ file extensions** to the appropriate Elacity runtime app. Double-clicking any supported file routes it to Elacity Player (video/audio) or Elacity Viewer (images/PDF/3D/data/fonts/archives). Text and code files still open in the editor. User-configured default app preferences take precedence.

### "Open With" Menu
Right-clicking a file now shows **two options**: the Elacity runtime app (default) and the legacy built-in app as an alternative.

### Elacity Branding
- "PC2 Media Player" → **Elacity Player**
- "dDRM Viewer" → **Elacity Viewer**
- Custom teal play-button gradient icon for Player, Elastos logo for Viewer
- Favicons and taskbar icons updated

**Commit:** `65881fd8`

---

## Creator Dashboard Polish — Consolidated Form UX

**Why this matters:** The Creator Dashboard had evolved rapidly over the previous two weeks, accumulating UX debt. The thumbnail upload was in an awkward location, and a separate "Settings" tab existed for content that logically belonged in "Licensing." This wasn't a feature addition — it was about making the existing workflow feel natural.

**What was built (Apr 3):**

### Form Consolidation
- **Thumbnail moved to Basics tab** — Previously in its own section, now alongside the file upload and metadata fields where users expect it. When you upload a file, you see the auto-generated thumbnail right there with an option to replace it.
- **Settings merged into Licensing tab** — The separate Settings tab (which only had "allow AI training" and "adult content" toggles) was merged into the Licensing tab where it belongs contextually. Two fewer clicks in the publish flow.

**Commit:** `913cd278`

---

## Capsule-Compatible Refactoring — Designing for Runtime v2 Today

**Why this matters:** The ElastOS Runtime is a pure Rust kernel (~16K LOC) with WASM/microVM sandboxes, capability tokens, and Ed25519 signatures. PC2 v1 is a Node.js product that works today. The question isn't "when do we switch?" — it's "how do we build v1 so that the switch is painless when v2 is ready?"

This week, we performed a deep study of Anders' Runtime codebase and produced concrete, non-breaking refactoring that runs in production today while being designed to slot into capsules.

**What was built (Apr 3):**

### 1. Unified Capability Vocabulary
**The problem:** PC2 had no formal concept of "what is an app allowed to do?" Permissions were implicit — if you could reach an API endpoint, you could call it.

**The solution:** A `CAPABILITY_SCOPES` vocabulary in `pc2-node/src/types/capabilities.ts` that defines 8 scope families:
- `fs:read`, `fs:write`, `fs:delete` — File system access
- `wallet:sign`, `wallet:send`, `wallet:read` — Wallet operations
- `drm:encrypt`, `drm:decrypt` — DRM operations
- `compute:wasm`, `compute:invoke` — WASM execution
- `net:fetch`, `net:rpc` — Network access
- `storage:ipfs:pin`, `storage:ipfs:read` — IPFS operations
- `identity:did:read`, `identity:auth` — Identity access
- `agent:delegate`, `agent:execute` — Agent operations

**Why this matters for capsules:** When Runtime v2 enforces capabilities, each capsule will request these exact scopes. We're establishing the vocabulary now so there's no translation layer needed later.

### 2. CapabilityPrincipal & Structured Authentication
**The problem:** API middleware knew the user's wallet address but nothing about their capabilities.

**The solution:** A `CapabilityPrincipal` interface that extends the existing auth with:
- `principal_type` — human, agent, or service
- `capabilities` — array of granted capability scopes
- `session_expiry` — when the capabilities expire

A new `requireCapability()` middleware function checks these capabilities. **Critically, it's opt-in and warn-only** — existing endpoints work exactly as before. New endpoints can opt into capability checking by adding the middleware.

### 3. Ed25519 App Signature Verification
**The problem:** When PC2 installs a dApp, it trusts the files blindly. There's no way to verify who created the app or whether it was tampered with.

**The solution:** `AppInstallService` now checks for an `ed25519_signature` field in `app.json`. If present, it verifies the signature against the developer's public key using `tweetnacl`. **If absent, the app still installs** — we just log a warning. This mirrors Runtime v2's mandatory signature verification but doesn't break the existing unsigned app ecosystem.

### 4. Provider Operation Interfaces
**The problem:** Services like DRM decryption, IPFS storage, and identity resolution have no formal contract. Each is implemented differently with ad-hoc APIs.

**The solution:** TypeScript interfaces in `pc2-node/src/services/providers/types.ts` that define the Provider Operation model:
- `DrmProvider` — `encrypt()` and `decrypt()` with structured I/O
- `StorageProvider` — `pin()`, `unpin()`, `resolve()` for content-addressable storage
- `IdentityProvider` — `resolve()` and `verify()` for DID operations
- `ComputeProvider` — `execute()` for sandboxed computation

Each provider communicates via a stdin/stdout JSON protocol — the same protocol the Runtime uses for WASM providers. Today these are TypeScript interfaces. Tomorrow they become the contract that capsule providers implement.

### 5. Wallet Bridge Origin Tracking
**The problem:** The wallet bridge accepted RPC calls from any iframe without knowing the source.

**The solution:** `pc2-wallet-bridge.js` now tracks the origin of every RPC request and classifies methods by required capability:
- `eth_accounts`, `eth_chainId` → `wallet:read` (low risk)
- `personal_sign`, `eth_signTypedData_v4` → `wallet:sign` (medium risk)
- `eth_sendTransaction` → `wallet:send` (high risk, requires explicit approval)

This classification isn't enforced yet — all calls still go through. But the classification data is logged and available for when capability enforcement is turned on.

### 6. dDRM Capsule Content Hashing
**The problem:** `.ddrm` capsule descriptors contained metadata about encrypted content but no way to verify that the encrypted file wasn't tampered with after descriptor creation.

**The solution:** Every `.ddrm` descriptor now includes:
- `content_hash` — SHA-256 hash of the encrypted content
- `content_hash_algorithm` — always `sha-256` (explicit, not assumed)
- `signer` — the wallet address that created the descriptor

This gives buyers cryptographic proof of content integrity. When capsules enforce content-addressing, this field becomes the CID verification anchor.

### 7. Capsule Manifests for All WASM Modules
**What:** `capsule.json` manifests created for all 7 WASM modules:
- `mp4-split` — ISO BMFF parser (init segment + per-track splitting)
- `cenc-decrypt` — AES-128-CTR CENC media decryption
- `cenc-encrypt` — AES-128-CTR CENC media encryption
- `ddrm-renderer` — Non-media dDRM content decryption/rendering
- `evm-multicall` — Multicall3 ABI encoder/decoder
- `amm-engine` — Uniswap V2 AMM math
- `ipfs-assemble` — Content assembly from IPFS chunks

Each manifest includes: name, version, SHA-256 hash of the `.wasm` binary, declared provider operations, MemFS I/O paths, and Runtime v2 compatibility fields.

**Commit:** `a3cc9563`

---

## WASM/Rust Consolidation — Moving Security-Sensitive Code into Sandboxes

**Why this matters:** Every line of security-sensitive code running in Node.js is a line that could be exploited through a JavaScript supply chain attack. WASM modules run in linear memory sandboxes — they can't access the filesystem, network, or process memory. Moving critical operations from JavaScript to Rust/WASM isn't just a performance optimization — it's a security boundary.

**What was built (Apr 3):**

### mp4-split v1.1.0: Init Segment Splitting in Rust
**The problem:** When PC2 plays DRM-protected video, the init segment (the first chunk of an MP4 that describes track layout) contains both video and audio tracks. The player needs separate init segments per track. Previously, this splitting was done in JavaScript — parsing binary MP4 box structures in Node.js.

**The solution:** A new `split_init` mode in the `mp4-split` Rust crate:
- Reads a combined init segment (containing `ftyp` + `moov` boxes with multiple `trak` entries)
- Parses the MP4 box structure in Rust (type-safe, bounds-checked)
- Filters for the target track type (`video` or `audio`)
- Rebuilds the `moov` box with only the target track
- Outputs a clean single-track init segment

**How it's activated:** The WASM module checks for `/input/command.json`. If present with `mode: "split_init"`, it runs the new path. If absent, it falls back to the original `mp4-split` behavior. This means the existing functionality is completely untouched.

### WASM-First with JS Fallback
The media API (`media.ts`) now tries the WASM path first:
```
Request for init segment
  → Try WASM split_init (Rust, sandboxed, ~15ms)
  → If WASM fails for any reason → Fall back to JS splitInitForTrack()
  → Return result to player
```

**Production verification:** After deploying, we played a dDRM-protected video and confirmed in server logs:
```
[media/split] WASM split_init for video: 1685B → 833B (removed 1 track(s), 14ms)
[media/split] WASM split_init for audio: 1685B → 728B (removed 1 track(s), 12ms)
```

Both tracks processed correctly, no fallbacks triggered, no errors.

### Capsule Audit Logging
Every WASM module execution now produces a structured audit log:
```
[capsule-audit] module=mp4-split sha256=36cf79... exit=0 elapsed=14ms
```

This establishes the observability layer that capsule runtimes require — every execution is traceable to a specific module version.

### Reproducible Build Configuration
A new `.cargo/config.toml` ensures all Rust crates compile with identical settings:
- Target: `wasm32-wasip1` (same as Runtime)
- Release optimizations: LTO, single codegen unit, `abort` on panic
- `wasm-opt` with `--enable-bulk-memory` for optimal binary size

The build script (`build-wasm.sh`) now auto-populates the SHA-256 hash in `capsule.json` after each build, preventing manifest/binary drift.

**Commit:** `a3cc9563`

---

## CEK Exposure Audit — Honest Security Assessment

**Why this matters:** Multiple code comments in `storage.ts` and `WASMRuntime.ts` previously claimed "CEK never touches Node.js memory." During the capsule compatibility audit, we discovered this isn't fully accurate. Rather than leaving misleading comments in the codebase, we documented the real data flow.

**What was found:**

### The Real CEK Flow
1. **Lit Protocol returns the CEK** as a base64 string to `chipotle-client.ts` (Node.js memory)
2. **For WASM decryption:** The CEK is written to MemFS as part of `command.json`, then WASM reads it. The plaintext stays in WASM linear memory, but the base64 CEK string briefly exists in Node.js memory during the handoff.
3. **For Node.js fallback decryption:** The CEK exists in Node.js memory for the entire decryption operation (this is the fallback path, used when WASM fails).
4. **Session cache:** The CEK is cached in a Node.js `Map` for multi-segment decryption (necessary for performance — re-calling Lit for every segment would be prohibitively slow).

### What Was Done
- **Fixed 5 misleading comments** in `storage.ts` — each now accurately describes the CEK's actual data flow
- **New "CEK Exposure Assessment" section** in `CAPSULE_COMPATIBILITY.md` — full documentation of every point where the CEK exists in JavaScript memory
- **Migration path documented** — how Runtime v2 capsules will eliminate the JavaScript CEK exposure entirely (WASM-to-WASM CEK handoff, no Node.js intermediate)

### Why Honesty Matters Here
Misleading security comments are worse than no comments at all. They give a false sense of safety and prevent the team from making informed decisions about where to invest in hardening. The CEK exposure is acceptable for v1 (the attack surface requires Node.js process memory access, which implies the machine is already compromised), but it's documented as a concrete migration target for v2.

**Commit:** `a3cc9563`

---

## Wallet Bridge — Multi-Chain, Multi-Wallet, Capability-Ready

**Why this matters:** The wallet bridge is the single most critical piece of infrastructure for dApp compatibility. Every dApp running inside PC2 talks to the blockchain through this bridge. This week it went from "works for our apps" to "works for any EVM dApp."

**What was built (Apr 1–3):**

### Multi-Chain Metadata
9 EVM chains fully configured with free, CORS-enabled RPC endpoints:
- Elastos Smart Chain (20), Ethereum (1), BSC (56), Polygon (137), Arbitrum (42161), Optimism (10), Avalanche (43114), Fantom (250), Cronos (25)
- Each chain includes: name, currency symbol, decimals, block explorer URL, and 2-3 fallback RPC endpoints
- `wallet_addEthereumChain` auto-adds networks to the user's wallet if missing

### MetaMask "All Networks" Fix
**The problem:** MetaMask's "All Networks" mode causes gas estimation to fail because the connected chain doesn't match the target chain.

**The fix:** Force `wallet_addEthereumChain` on every connect, which implicitly switches MetaMask to the correct chain.

### RPC Response Cache
In-memory TTL cache per RPC method:
| Method | TTL | Rationale |
|--------|-----|-----------|
| `eth_chainId` | 1 hour | Chain ID never changes |
| `eth_gasPrice` | 5 seconds | Fresh enough for gas estimation |
| `eth_getCode` | 5 minutes | Contract code doesn't change |
| `eth_blockNumber` | 3 seconds | Recent enough for most reads |

Result: **38x speedup** on cached methods, massively reducing RPC calls to external endpoints.

### Origin Tracking & Capability Classification
Every RPC request is now tagged with the requesting iframe's origin. Methods are classified by risk level (`wallet:read`, `wallet:sign`, `wallet:send`). Not enforced yet — logged for future capability gating.

**Commits:** `1fcb2ae9`, `71bba594`, `a3cc9563`

---

## dDRM Security Hardening — 7 Vulnerabilities Closed

**Why this matters:** Moving to production Lit means real money and real content are at stake. We performed a security hardening audit of the entire dDRM pipeline before going live.

**What was fixed (Apr 2):**

| Vulnerability | Severity | Fix |
|--------------|----------|-----|
| Client-injectable RPC URL | **Critical** | Server-side hardcode via `getBaseRpcUrl()` — clients can no longer specify which RPC endpoint to use |
| Client-injectable authority address | **Critical** | Server-side hardcode `DEFAULT_AUTHORITY` — prevents clients from bypassing access control checks |
| Client-injectable buyerAddress | **Critical** | Derived from `req.user` session only — no client-supplied wallet addresses accepted |
| No rate limiting on Lit calls | **High** | 30 calls/min per wallet with periodic cleanup map |
| Duplicate Lit charges (concurrent) | **Medium** | Promise coalescing for same `(kid, buyerAddress)` tuple |
| API keys in git | **High** | `.chipotle-*`, `.lit-*` added to `.gitignore` |
| Unauthenticated `/lit/server-info` | **Medium** | Added `authenticate` middleware |

**Commit:** `b48ffb7b`

---

## Apple Developer Program — macOS Distribution Unblocked

**Why this matters:** Until now, installing the [Elastos Launcher](https://github.com/Elacity/elastos-launcher) on macOS required users to run `xattr -cr` in Terminal to bypass Gatekeeper — a scary, trust-destroying step that most users won't do. With the Apple Developer Program certificate, we can code-sign and notarize the .dmg, making installation a simple double-click.

**What happened (Apr 3):**
- Apple accepted our Developer Program application
- This unblocks code signing and notarization for the Elastos Launcher DMG
- Users will be able to download and install without Terminal workarounds
- This also positions us for the Runtime's macOS launcher, which faces the same Gatekeeper issue

**Impact:** The roadmap item "macOS packaging" moves from "Blocked" to "Ready" — this is one of the largest UX barriers removed this week.

---

## Elastos Documentation Portal — docs.elastos.net

**Why this matters:** For years, Elastos ecosystem information has been scattered across dozens of GitHub repositories, archived websites, legacy documentation, and separate project pages. Developers evaluating the stack had no clear starting point. Node operators couldn't find setup guides. Community members couldn't answer basic questions without asking on Telegram. A fragmented knowledge base is an adoption killer.

**What was built (Mar 31 – Apr 3):**

### A Unified Documentation Home
The new portal at [docs.elastos.net](https://docs.elastos.net) is structured around the four core pillars of the Elastos stack:

| Pillar | Coverage |
|--------|----------|
| **Blockchain** | ELA main chain, ESC, EID, staking, cross-chain activity, DAO governance |
| **PC2** | Personal Cloud Computer — wallet-based access, storage, local AI, user infrastructure |
| **Runtime** | Execution layer — application permissions, sandboxing, SmartWeb security model |
| **Carrier** | Networking layer — peer discovery, NAT traversal, encrypted connections, Boson Network |

### Three Audience Paths
Rather than forcing everyone through the same technical documentation, the portal is organized by intent:
- **Use** — For non-developers: wallet setup, staking, governance participation, node setup, PC2 installation
- **Build** — For developers: smart contracts, DIDs, wallets, storage, peer-to-peer systems
- **Reference** — Technical material: protocol details, architecture, repository status, deprecation history

### AI-Assisted Search
The portal includes both full-text search and an **AI assistant** that answers questions using the documentation content itself. Questions like "How do I set up a node?", "What is the difference between ESC and EID?", or "How does ELA staking work?" get answered directly from the docs.

### Repository Inventory
One of the most important features: a structured view of **all public repositories** across the Elastos and CyberRepublic GitHub organizations with status indicators (active, maintained, stale, archived, forked, deprecated). This prevents developers from accidentally building on outdated or replaced components.

### Built for Long-Term Maintenance
- Version-controlled and searchable
- Includes `llms.txt` so AI tools and LLM-based systems can interpret the documentation programmatically
- Video demonstration created showing search and AI assistant in action
- Custom announcement banners designed for the portal launch

### Launch
- [Blog announcement](http://blog.elastos.net/announcement/documentation-portal-live/) published April 3
- Shared across X, Telegram, and Reddit
- Community update posted to build awareness ahead of launch

---

## KuMining Partnership — ELA Merge-Mining on KuCoin

**Why this matters:** ELA's security comes from Bitcoin merge-mining — the same miners who secure Bitcoin also secure Elastos. But accessing merge-mining has historically required technical setup. KuMining (KuCoin's cloud mining platform) removes this barrier entirely, letting users participate in ELA mining through a familiar exchange interface.

**What happened (Apr 1–2):**
- **Partnership finalized** — ELA merge-mining is now available on KuCoin's KuMining platform
- **Announcement published** — KuCoin Mining announcement created and shared across all channels
- **Custom banners** — 2 branded banners designed for the KuMining announcement
- **Research ongoing** — Continuing investigation into ELA on Base chain integration

**Why this matters for the ecosystem:** KuCoin is one of the top global cryptocurrency exchanges. Having ELA merge-mining accessible through their platform significantly expands the pool of potential miners and strengthens network security through broader hash rate distribution.

---

## Ecosystem Operations & Community

**Why this matters:** A healthy ecosystem isn't just code — it's people, partnerships, infrastructure, and responsiveness. This week included significant operational work keeping the network healthy and relationships active.

**What was done (Mar 31 – Apr 3):**

### Community Support & Issue Resolution
- **Elastos Identity (Essentials) issue** — Users reported problems, investigation discovered the Essentials node was down. Issue reported to Zhiming and subsequently resolved (Apr 1).
- **Sikasi Node illegal state** — Node operator issue diagnosed and resolved (Apr 2).
- **Telegram cleanup** — Community channels organized and maintained.

### Partnership & Business Development
- **MotionTrade discussions** — Meeting held, follow-up questions sent, discussion continues on potential collaboration.
- **PG chain fee flow investigation** — Research into PG chains' fee earned by EF, results documented (fees in token dev address).

### Content & Communications
- **March 31 ElastOS update** — Edited, published as threads and posts on X, Telegram, and Reddit
- **ElastOS update banner** created for social distribution
- **5 banners for docs.elastos.net** — Custom visual assets for portal launch
- **2 banners for KuMining announcement** — Partnership visual assets
- **Video demonstration** — Screen recording of docs.elastos.net search and AI assistant

---

## Documentation & Strategy

### New Documents Created

| Document | Purpose |
|----------|---------|
| **CAPSULE_COMPATIBILITY.md** | Full Runtime study + convergence assessment + CEK audit (480 lines) |
| **DApp_Runtime_Strategy_Apr_2026.md** | dApp-to-capsule evolution strategy with Glide as proof of concept |
| **Runtime_Explainer_Video_Support.md** | Video talking points for community explanation of the Runtime |
| **V3 Contract Migration Reference** | Gate 2 prep document for when new V3 ABIs arrive |

### Updated Documents

| Document | Changes |
|----------|---------|
| **ROADMAP.md** | Updated dates, Lit mainnet marked complete, Apple Developer unblocked, capsule refactoring tracked |
| **ARCHITECTURE_CONVERGENCE.md** | Apr 2026 status addendum — what's real vs what's still theoretical |
| **LIT_CHIPOTLE_MIGRATION.md** | Full production migration steps documented, security hardening table |
| **Community_Update_Mar_20-27_2026.md** | Updated with wallet integration and runtime player sections |

### Key Strategic Insight: The Convergence Model
The most important documentation outcome this week was articulating the **convergence model** (not migration model) for Runtime v2:

```
Phase 1 (Now):   PC2 ships as standalone Node.js product.
                 All new code is capsule-compatible.

Phase 2 (v1.5):  PC2 becomes a "host adapter" for the Runtime.
                 Runtime handles WASM/microVM + capability enforcement.
                 PC2 handles HTTP API, frontend, marketplace.

Phase 3 (v2.0):  Full sovereignty. Every service is a signed capsule.
                 PC2 Node.js is just one host adapter among many.
```

The Runtime defines four host adapter modes (server/headless, desktop, mobile, kiosk). Our PC2 Node.js + browser desktop IS the server/headless host adapter. We're not building something to be replaced — we're building something that will be promoted to reference implementation.

**Commits:** `a3cc9563`, `ebc4ac26`, `71bba594`, `65881fd8`

---

## What's Next

### Immediate (This Coming Week)
1. **Verify Contabo ESC RPC sync** — SSH check, confirm block height, test from PC2 nodes
2. **Deploy to supernodes** — InterServer + Contabo with production Lit config
3. **V3 contract migration** — when Irzhy provides the new SDK and ABIs, update 8+ locations
4. **macOS .dmg code signing** — use new Apple Developer cert to sign + notarize Elastos Launcher

### Short-term (Next 1-2 Weeks)
5. **v1.3 release prep** — merge `feature/lit-chipotle-migration` to main, tag, test on fresh installs
6. **Decentralized Lit relay** — supernode proxy architecture (API key stays on supernodes, never on end-user nodes)
7. **Large file encryption verification** — 4-70GB AI model files with streaming encryption

### Medium-term (This Month)
8. **dApp Store UI** — categories, search, install flow
9. **dApp packaging format** — manifest spec, signed bundles
10. **Content Intelligence** — perceptual hashing for duplicate detection
11. **elastos-keycustody Rust crate** — begin post-quantum key custody capsule

---

## Summary Statistics

### Engineering
| Metric | Value |
|--------|-------|
| Commits (this week) | 18 |
| Core Elacity code added | ~10,000 lines |
| Core Elacity code removed | ~1,300 lines |
| Core files touched | 102 |
| Total files changed (incl. Glide bundle) | 724 |
| New Rust/WASM crates built | 2 (evm-multicall, amm-engine) |
| Existing WASM crate extended | 1 (mp4-split v1.1.0 — split_init mode) |
| Capsule manifests created | 7 (capsule.json for every WASM module) |
| New documentation files | 4 (CAPSULE_COMPATIBILITY, DApp_Runtime_Strategy, Runtime_Explainer, V3 Migration) |
| Security vulnerabilities closed | 7 (3 critical, 2 high, 2 medium) |
| Asset types verified E2E on production Lit | 4 (PDF, image, video, audio) |
| Wallet types fully functional | 3 (MetaMask, WalletConnect, Particle Auth email) |
| EVM chains configured in wallet bridge | 9 |
| Third-party dApps running in PC2 | 1 (Glide Finance — zero code changes) |
| Misleading security comments fixed | 5 |
| Things broken by all of the above | 0 |

### Ecosystem & Operations
| Metric | Value |
|--------|-------|
| Documentation portal launched | [docs.elastos.net](https://docs.elastos.net) — 4 pillars, 3 audience paths, AI search |
| Exchange partnership | KuMining (KuCoin) — ELA merge-mining live |
| Community issues resolved | 2 (Essentials node down, Sikasi node illegal state) |
| Content published | ElastOS weekly update (X, Telegram, Reddit) |
| Visual assets created | 8 banners (5 docs portal, 2 KuMining, 1 update) + 1 video demo |
| Partnership discussions active | 1 (MotionTrade — ongoing) |

---

### ElastOS Runtime Update

**Anders' Runtime Progress (from state.md dated Mar 31):**
- Signed installs working — `elastos setup` fetches, verifies Ed25519, installs
- WASM execution (Wasmtime) and microVM execution (crosvm) both operational
- Carrier P2P (iroh-based QUIC + DHT + relay) proven native-to-WASM
- Capability tokens with 12 checks per invocation
- AI provider (`elastos://ai/` → llama-provider) capsule-native
- Shell capsule (Puter running inside a microVM) orchestrating capability prompts

**PC2's Role:** We identified through this week's audit that PC2 Node.js + browser desktop maps directly to the Runtime's "server/headless" host adapter mode. Our work isn't being replaced — it's being promoted to the reference implementation for the Runtime's web-facing host adapter.

**Biggest Gap:** The Runtime has NO EVM wallet, marketplace, or payment flows yet. PC2 provides all three today. The convergence model means PC2 fills these gaps while the Runtime matures.

---

### Elacity dDRM / Smart Contract Update

**Achievements This Week:**
- Lit Protocol Chipotle production integration — COMPLETE
- Full E2E dDRM pipeline verified on mainnet
- Free content minting (cleartext DASH, no Lit costs)
- Security hardening — 7 vulnerabilities closed before production deployment
- CEK exposure honestly documented with migration path

**Current Focus:**
- V3 contract migration preparation (Gate 2 — blocked on new ABIs from Irzhy)
- Supernode deployment with production Lit config
- SDK adjustments to support protocol v3 ([ELACITY-2211])

---

*This update covers all work from March 28 – April 3, 2026 on the `feature/lit-chipotle-migration` branch. All changes are backward-compatible — nothing that worked last week is broken this week.*
