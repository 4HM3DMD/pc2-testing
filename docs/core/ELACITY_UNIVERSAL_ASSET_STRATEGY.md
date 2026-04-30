# Elacity Universal Asset Strategy

> **Purpose:** Define the path from media DRM marketplace to universal digital asset monetization protocol.
> **Created:** 2026-03-08
> **Last Updated:** 2026-03-18
> **Status:** Strategic direction — aligned with ROADMAP.md milestones

---

## The Core Thesis

Elacity's smart contracts (AuthorityGateway, TradeGateway, Channels, Operatives) are already asset-type agnostic. The `ACCESS_TOKEN` (ERC-1155) + Lit Protocol key delivery pattern works for ANY encrypted digital asset, not just media. The bottleneck is only in the SDK layer (`@elacity-js/media-player` is media-specific) and the metadata schema (assumes video).

Fixing this unlocks every digital marketplace vertical.

---

## What Elacity Already Has

### On-Chain (Production on Base)

| Component | Purpose | Asset-Agnostic? |
|-----------|---------|-----------------|
| **AuthorityGateway** | Access control, licensing, ACCESS_TOKEN marketplace | Yes |
| **TradeGateway** | General asset trading (royalty shares, distribution rights) | Yes |
| **Channels** | ERC-1155 containers for digital assets | Yes |
| **Operatives** | Per-asset access control (Buy&Play, Buy&Sell, Rent, PPV) | Yes |
| **LicenseModule** | Cryptographic license generation (ECDH/ECDSA) | Yes |
| **SubscriptionModule** | Time-based access management | Yes |
| **RoyaltyModule** | Multi-stakeholder revenue distribution (1000 shares = 100%) | Yes |
| **CoreStorage** | Ecosystem-wide registry | Yes |

### SDK Packages (npm)

| Package | Version | Asset Scope |
|---------|---------|------------|
| `@elacity-js/contracts` | 0.8.2-beta.24 | Universal |
| `@elacity-js/api` | 0.8.5-beta.25 | Media-coupled |
| `@elacity-js/media-player` | 0.9.0 | Media-only |
| `@elacity-js/media-packager` | beta | Media-only |
| `@elacity-js/common` | 1.0.0-beta.24 | Universal |

### Infrastructure (Live)

- 84+ PC2 nodes worldwide (personal clouds seeding content)
- 2 supernodes (InterServer + Contabo) with full transport stack
- IPFS content-addressed storage with DHT announcement
- Decentralized CDN via Bitswap peer-to-peer block exchange
- Four-tier stealth transport cascade (WG > AWG > VLESS > ActiveProxy)
- Working marketplace with purchase + playback flow
- **Lit Chipotle dDRM** — non-media encrypt/decrypt E2E verified (PDF, image, text, audio, fonts) via Chipotle TEE with on-chain access check *(completed Mar 18)*
- **WASM renderers** — Rust→WASM for AES-GCM decrypt, CENC decrypt, PDF rendering, text rendering, image rendering. Plaintext never leaves WASM linear memory *(completed Mar 16)*
- **Auto-provisioning** — fresh PC2 nodes auto-fetch Chipotle API keys from supernodes *(coded Mar 18, deployment pending)*

### ElastOS Runtime (Building — Anders/CTO)

> RC4 (0.19.0-rc4) — Pure Rust, MIT License, runs on x86_64 + aarch64 (Jetson, RPi)

| Component | Status | What It Does |
|-----------|--------|-------------|
| Runtime core | Verified | Capability tokens, Ed25519 signatures, 12 checks/invocation, audit logging |
| Capsule execution | Verified | WASM (Wasmtime) + microVM (crosvm/KVM), rootless launch on Jetson and WSL |
| Carrier | Verified | DID identity, DHT discovery, gossip, relay, cross-network P2P (Iroh/QUIC) |
| P2P Chat | Proven | Native + WASM + microVM on one runtime, same wire format |
| DID identity | Verified | `did:key` with Ed25519, ready for DID sidechain bridge |
| Encrypted storage | Working | AES-256-GCM via `localhost://storage/` |
| Content sharing | Working | `elastos share` bundles files → IPFS → browser link |
| Signed releases | Proven | Ed25519-signed publish/install/update pipeline |
| Data capsules | Working | Signed content + viewer capsules (markdown viewer, GBA emulator) |
| AI provider | Working | LLM routing via `elastos://ai/` |
| Blockchain | Next | Elastos nodes as capsules, DID sidechain bridge, payment flows |

**Architecture:** 10 Rust crates, dozens of capsules. Everything runs inside Digital Capsules: signed, sandboxed, governed by capability tokens. Zero ambient authority — capsules start with no permissions.

---

## SDK Evolution

### The Critical Missing Package: `@elacity-js/access`

The Lit Protocol key retrieval logic is currently buried inside `@elacity-js/media-player`. Extracting it into a standalone package enables any consumer to decrypt dDRM-protected content, regardless of asset type.

```
BEFORE:
  @elacity-js/media-player
    └── Lit Protocol integration (LOCKED to DASH/CENC video)
    └── MediaSource API
    └── WASM decryption

AFTER:
  @elacity-js/access (NEW — universal)
    └── Lit Protocol key retrieval (works for ANY encrypted CID)
    └── ACCESS_TOKEN ownership verification
    └── Decrypt-to-buffer (returns raw bytes)
    └── Certificate caching
    └── Subscription verification

  @elacity-js/media-player (unchanged, but now CONSUMES @elacity-js/access)
    └── DASH streaming
    └── MediaSource API
    └── WASM video decryption
```

### Technical Spec

Full `@elacity-js/access` specification: [`docs/core/ACCESS_PACKAGE_SPEC.md`](./ACCESS_PACKAGE_SPEC.md)

Key design decisions:
- **Clean-room build** using Lit Protocol SDK directly (not extracted from media-player's minified bundle)
- **Two encryption paths:** CENC-compatible `acquireLicense()` for media + AES-GCM `encryptBuffer()`/`decryptBuffer()` for non-media
- **Browser + Node.js** dual entry points for server-side decryption on PC2 node
- **Capsule-ready** — stateless, no singletons, separated verify/acquire/decrypt, extensible types
- **Creator + Consumer** — same package handles encryption (creator) and decryption (consumer)

### Security Model

**Media (streaming):** Key passes to WASM module — segment-by-segment decryption, never raw file on disk. Equivalent to Widevine L3 (same as Netflix in browsers). No change from today.

**Non-media (files):** AES-GCM via WebCrypto — decrypted file is raw in memory. By design: matches Steam/Adobe/Kindle license model. DRM prevents unauthorized access, not redistribution by authorized purchasers. Royalties at purchase time, on-chain audit trail.

**PC2 node advantage:** Non-media assets decrypt server-side on the PC2 Node.js backend. No browser, no COOP/COEP, no SharedArrayBuffer, no popup windows. AI models decrypt → load into Ollama. Everything inside the user's PC2 desktop.

**Runtime v2 upgrade:** When the Rust Runtime arrives, `@elacity-js/access` becomes a WASM capsule. Key never leaves sandbox. Capability tokens scope access. Full audit trail. The package API stays the same — security comes from Runtime isolation.

### New Package: `@elacity-js/asset-packager`

Generic counterpart to `media-packager` for non-media assets:
- Encrypt any file/directory with Lit Protocol access conditions
- Upload encrypted bundle to IPFS
- Register on-chain via Channel + Operative
- Track background jobs via `BackgroundJobService`

### API Evolution

`@elacity-js/api` needs new services alongside existing ones:
- `AssetService` — generic asset queries (any content type, not just NFT media)
- `MarketplaceService` — cross-type marketplace queries and listings
- `LicenseService` — license status, history, delegation between wallets

### Universal Metadata Schema

Extend the Channel metadata to support any asset type (backward compatible):

```json
{
  "kid": "RFC-4122 content identifier",
  "iscc": "International Standard Content Code",
  "name": "Asset name",
  "description": "Asset description",
  "image": "ipfs://thumbnail",

  "asset": {
    "uri": "ipfs://encrypted-content-CID",
    "contentType": "application/x-ai-model",
    "assetType": "ai-model",
    "runtime": "wasm",
    "size": 1073741824,
    "protectionType": ["cenc:lit-drm-v1"]
  },

  "media": {
    "uri": "ipfs://encrypted-mpd-manifest",
    "contentType": "video/mp4",
    "protectionType": ["cenc:lit-drm-v1"]
  },

  "properties": {
    "chainId": 8453,
    "channel": "0x...",
    "authority": "0x...",
    "operative": "0x...",
    "publisher": "0x...",
    "distribution": "download"
  }
}
```

`media` is optional (backward compat for existing content). `asset` is the universal field for new content types.

---

## Marketplace Verticals

### Tier 1: Quick Markets (Days to Build — File In, File Out)

Unlocked by `@elacity-js/access` + Creator Dashboard. All use the same flow: encrypt file → IPFS pin → mint on Base. Buyer purchases ACCESS_TOKEN → download → decrypt → open locally on PC2. No special runtime, no COOP/COEP, no popup windows.

> **Status (Mar 18):** All Tier 1 asset types work TODAY on Chipotle. The dDRM pipeline is asset-agnostic — same AES-256-GCM encryption, same Lit Chipotle CEK escrow, same on-chain access check. Only the renderer differs.

| Marketplace | Asset Type | Revenue Model | Consumer Action on PC2 | Status |
|-------------|-----------|---------------|----------------------|--------|
| Media streaming | Video, music, podcasts | Buy/rent/subscribe | Play in WASM player (existing) | **Done** (Datil; Chipotle media pending) |
| E-books / documents | PDF, ePub, DOCX | Buy/rent | WASM PDF renderer in dDRM Viewer | **Done** (Chipotle verified) |
| Stock photography | JPG, PNG, RAW, PSD | Buy, royalty-free | WASM image renderer in dDRM Viewer | **Done** (Chipotle verified) |
| Audio samples / SFX | MP3, WAV, FLAC | Buy | HTML5 `<audio>` player in dDRM Viewer | **Done** (Chipotle verified) |
| Design templates | Figma, PSD, HTML/CSS | Buy | Decrypt → download | **Done** (same pipeline) |
| Fonts | OTF, TTF, WOFF2 | License | Decrypt → install/download | **Done** (same pipeline) |
| 3D models | glTF, FBX, OBJ | Buy/license | Decrypt → Three.js viewer (future) | Ready (needs viewer) |
| Spreadsheets / data | CSV, JSON, XML | Buy | WASM text renderer | **Done** (same pipeline) |

### Tier 2: Medium Markets (Weeks — Local Runtime Integration)

Need PC2 backend endpoints that handle "decrypt + load" in one step. Content decrypts server-side on the PC2 node (Node.js), no browser involved.

| Marketplace | Asset Type | Revenue Model | Consumer Action on PC2 | TAM |
|-------------|-----------|---------------|----------------------|-----|
| **dApp Store** | HTML/JS/CSS/WASM bundles | Buy/subscribe | Decrypt → install → run locally in sandbox | **Massive** (see below) |
| **AI model marketplace** | GGUF, SafeTensors, ONNX | Buy/rent/compute-time | Decrypt on node → `ollama create` → chat | $50B+ by 2030 |
| Code marketplace | npm packages, plugins, themes | License/subscribe | Decrypt → install in sandbox | $15B+ |
| Dataset marketplace | CSV, Parquet, JSON-L | Buy/subscribe/usage | Decrypt → import to SQLite/embeddings | $10B+ |
| Education marketplace | Courses, tutorials | Buy/subscribe | Decrypt → local viewer | $40B+ |
| **HTML5 Games** | HTML/JS/WASM game bundles | Buy/play | Decrypt → run in sandboxed iframe | Emerging |

#### The dApp Store Model

Any web application — DeFi protocols, NFT marketplaces, DAO dashboards, productivity tools — can be packaged, encrypted, and sold as a dApp on Elacity. This solves real problems:

**Why developers would sell dApps on Elacity:**
- Revenue for open-source work (Uniswap, Aave, etc. could sell their frontends)
- No hosting costs — the buyer's PC2 node runs the app
- No frontend attacks — users run a signed, verified copy locally
- Royalties on resale (built into Elacity contracts)

**Why users would buy dApps:**
- Run DeFi apps locally — no trusting hosted frontends that can be DNS-hijacked
- Own your tools — no platform can revoke access or shut down
- Privacy — app runs on your hardware, talks directly to smart contracts
- Offline capability — works without internet (for non-blockchain features)

**Example: Uniswap on ElastOS**
```
CREATOR (Uniswap team):
  1. Build frontend → bundle as signed package
  2. Encrypt with Elacity dDRM (AES-256-GCM + Chipotle CEK)
  3. Upload to IPFS → mint ACCESS_TOKEN on Base
  4. Set price: 5 USDC, royalty: 95% to Uniswap, 5% protocol

BUYER:
  1. Browse ElastOS dApp Store → find "Uniswap DEX"
  2. Purchase ACCESS_TOKEN (credit card via Smart Account)
  3. PC2 node verifies ACCESS_TOKEN → Lit TEE releases CEK
  4. dApp decrypted → signature verified → installed locally
  5. User runs Uniswap locally, talking directly to Base contracts
  6. Updates: Uniswap publishes new version → signed update flow

TODAY (PC2 v1): dApp runs in sandboxed iframe
FUTURE (Runtime v2): dApp runs as signed capsule with capability tokens
```

**What already works:** PC2 has `AppInstallService` with CID-based app installation. The dDRM encryption pipeline is asset-agnostic. What's needed is the Creator Dashboard recognizing app bundles and routing them through `AppInstallService` after decrypt.

### Tier 3: Complex Markets (Months — Needs ElastOS Runtime v2)

These asset types require the full capsule sandbox from Anders' ElastOS Runtime for proper isolation, capability-gated execution, and audit trails.

| Marketplace | Asset Type | Revenue Model | What Runtime Provides | TAM |
|-------------|-----------|---------------|-----------------------|-----|
| Native software | Executables, CLI tools | License keys, subscription | WASM/microVM capsule sandbox — app can't access anything without capability tokens | $200B+ |
| Native games | Unity/Godot/custom engines | Buy/play | microVM (Firecracker/KVM) for full Linux game environments with GPU pass-through | $200B+ |
| API marketplace | Endpoint access | Usage-based, subscription | Provider capsules with metering + rate limiting via capability tokens | $30B+ |
| Agent marketplace | LLM agents, tools, skills | Hire/subscribe/revenue-share | Agent capsules with `elastos://ai/` routing, same sandbox as human apps | Emerging |
| Compute marketplace | GPU/CPU time | Usage-based | Capsule-level resource metering, TEE attestation | $100B+ |

**Key Runtime capabilities needed:**
- **WASM sandbox (Wasmtime)** — Already verified in Runtime RC4. Capsules execute with zero ambient authority.
- **microVM sandbox (Firecracker/KVM)** — Verified on Jetson and WSL. Required for full OS environments (native games, heavy compute).
- **Capability tokens** — Ed25519-signed, 12-check validation, time-limited, audited. The enforcement layer that makes paid software sandboxing trustworthy.
- **Data capsules** — Signed content + declared viewer capsule. This IS the dDRM asset model — encrypted content paired with the capsule that can render it.

---

## The Platform Flywheel

```
Creators upload assets → dDRM encrypts → ACCESS_TOKENs minted
     │
     ▼
Marketplace lists assets → Buyers purchase ACCESS_TOKENs
     │
     ▼
Buyers' PC2 nodes seed content (CDN effect) → Network grows
     │
     ▼
More nodes = better CDN = faster delivery → More buyers
     │
     ▼
Protocol fees (2-5%) → ELA buyback → Token value rises
     │
     ▼
Node operators earn revenue → More operators deploy supernodes
     │
     ▼
More supernodes = more capacity → Larger marketplace
     │
     (loop)
```

This is a three-sided marketplace (creators, buyers, operators) with positive-sum economics.

---

## Revenue Model

| Stream | Source | Fee | Timeline | Revenue at Scale |
|--------|--------|-----|----------|-----------------|
| Media marketplace | Content purchases | 2-5% | Now | $10-50M/yr |
| **dApp Store** | **dApp purchases + subscriptions** | **5-15%** | **M3-M4** | **$50-200M/yr** |
| AI model marketplace | Model licensing | 5-10% | M3-M4 | $50-200M/yr |
| Software licensing | License sales | 5% | M3-M4 | $20-100M/yr |
| Supernode access tokens | Network services | 15% of token sales | M3-M4 | $5-20M/yr |
| Agent marketplace | Agent hire/services | 5-10% | M7+ | $50-500M/yr |
| White-label protocol fees | Third-party marketplaces | 1-2% | M5+ | $100M+/yr |
| Enterprise DRM-as-a-Service | B2B licensing | SaaS pricing | M5+ | $50-200M/yr |

---

## Strategic Blind Spots to Address

### 1. Agent-to-Agent Commerce

Current thinking is human-centric. Explosive growth comes from agents buying from agents autonomously (no human in the loop). An AI coding agent discovers, purchases, and loads a dDRM-gated code library — all via MCP/A2A protocols and Particle Smart Accounts. The contracts already support this via `UniversalAccountTransactionExecutor`.

**Action:** Expose MCP/A2A endpoints. Position Elacity to agent builders, not just human creators. Aligns with ERC-8004 roadmap (M7) but messaging should start now.

### 2. Composable Assets (Nested Licensing)

One asset depends on others: an AI model trained on licensed datasets, a course using licensed music. The `ROYALTY_SHARE` token already supports multi-stakeholder splits. Need a `dependencies[]` declaration in Channel metadata so royalty trees flow through all contributors.

**Action:** Extend Channel metadata schema. The `RoyaltyModule` already handles multi-recipient distribution.

### 3. Fiat Onramp

99% of creators and consumers don't have crypto wallets. Particle Smart Accounts help (social login = wallet), but one-click credit card purchase of ACCESS_TOKENs is essential for mass adoption.

**Action:** Prioritize Particle fiat onramp integration (Stripe/Moonpay). Every marketplace requiring "connect wallet" first loses 95% of users.

### 4. Enterprise B2B

Every software company has a licensing problem. Elacity's `LicenseModule` + `AuthorityGateway` is a drop-in replacement for centralized license management. No server to maintain, no piracy, instant royalty distribution, global audit trail.

**Action:** Start building enterprise case studies (M4+). One enterprise customer at $1M/yr ARR > 10,000 individual media creators.

### 5. Mobile

PC2 is desktop/server focused. Content consumption is 80%+ mobile. Need a lightweight mobile app that connects to the user's PC2 node via WireGuard tunnel for marketplace browsing, purchases, and streaming.

**Action:** React Native mobile app targeting M3-M4. This is the App Store distribution play.

### 6. Creator Tools — PARTIALLY ADDRESSED

~~Buyer experience is built. Creator tools are thin.~~ Creator Dashboard dApp is implemented (Mar 13-14) with full upload → encrypt → mint flow. Works for any file type.

**Remaining:** Creator Dashboard needs dApp-specific metadata (manifest, permissions, runtime requirements) and media-specific routing (DASH encoder for video/audio).

### 7. Data Unions

The massive TAM is collective data: photographer collectives, research teams, music catalogs licensing combined catalogs. `MultiChannel` already supports multi-creator channels. Extend to "Data Unions" with proportional ROYALTY_SHARE distribution.

**Action:** Data Union channel type in dApp Center (M5+).

### 8. dApp Store Discovery

The dApp Store needs more than just a list of apps. Discoverability drives adoption:
- Categories (DeFi, Games, Productivity, AI, Social)
- Ratings and reviews (compatible with ERC-8004 Reputation Registry)
- "Verified" badges for known teams (Uniswap, Aave, etc.)
- Auto-update mechanism (new version CID → signed update)
- Try-before-you-buy (time-limited capability token via SubscriptionModule)

**Action:** Build discovery layer as part of dApp Store v1 (v1.5.0).

---

## Runtime Convergence

### Current State (Mar 18, 2026)

The ElastOS Runtime (Anders/CTO) is at RC4 (0.19.0-rc4). It is a pure Rust binary with zero OpenSSL dependencies that runs on x86_64 and aarch64 (Jetson, Raspberry Pi). The following is verified and working:

- **Capsule execution** in both WASM (Wasmtime) and microVM (crosvm/KVM)
- **Carrier P2P** with DID identity, DHT discovery, gossip, relay
- **3-mode chat** — native, WASM, and microVM capsules all on one runtime
- **Cross-network P2P** — seed server to Jetson via DHT, no manual tickets
- **Rootless microVM** — app capsules run without sudo on Jetson and WSL
- **Data capsules** — signed content paired with viewer capsules
- **Signed releases** — Ed25519-signed publish/install/update pipeline
- **Fresh install to chat** — `curl | bash` → verified → running in one command

### How dDRM Maps to Capsules

Our existing dDRM components map directly to Runtime capsule types:

```
OUR CODE (Rust/WASM, already built)          RUNTIME CAPSULE TYPE
─────────────────────────────────            ────────────────────
aes-gcm-decrypt (WASM crate)           →    dDRM Provider Capsule (WASM)
cenc-decrypt (WASM crate)              →    Media DRM Capsule (WASM)
text-renderer (WASM crate)             →    Viewer Capsule (WASM)
pdf-renderer (WASM crate)              →    Viewer Capsule (WASM)
chipotle-client.ts                     →    dDRM Provider Capsule (Rust port)
dDRM Viewer app                        →    Data Capsule viewer
.ddrm.json descriptor                  →    Data Capsule manifest
Creator Dashboard                      →    App Capsule
```

The key insight: **our WASM modules already compile to `wasm32-wasip1`** — the same WASI target the Runtime uses via Wasmtime. Repackaging them as signed capsules is straightforward.

### ACCESS_TOKEN ↔ Capability Token Bridge

When the Rust Runtime arrives, dDRM access tokens and capability tokens work together:

```
ACCESS_TOKEN (on-chain, Elacity)         Capability Token (off-chain, Runtime)
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ holder: 0x416d...21b1        │        │ holder: "media-player-capsule"│
│ channel: 0xABC...            │  ──►   │ resource: "ipfs://QmXyz"      │
│ tokenId: 42                  │        │ action: "drm:decrypt"         │
│ type: ACCESS_TOKEN (1)       │        │ expires: "2026-04-01T00:00Z" │
│ chain: Base (8453)           │        │ signature: <ed25519>          │
└──────────────────────────────┘        └──────────────────────────────┘

1. User/Agent buys ACCESS_TOKEN on-chain (Elacity contracts)
2. Capsule requests "drm:decrypt" capability from Runtime
3. Runtime checks: does wallet hold ACCESS_TOKEN?
   (calls AuthorityGateway.hasAccess() via @elacity-js/contracts)
4. Runtime issues scoped capability token
5. dDRM Provider Capsule decrypts CEK (Lit Chipotle TEE)
6. Viewer/App Capsule receives decrypted bytes — never raw to host
7. Runtime audit log records everything cryptographically
```

**ACCESS_TOKENs are the on-chain authorization layer (who has the right). Capability tokens are the off-chain enforcement layer (what can actually happen). They're complementary, not competing.**

### The dApp Store on Runtime v2

```
TODAY (PC2 v1.x):
  dApp = HTML/JS/CSS in sandboxed iframe
  Security = CSP headers + postMessage bridge
  Isolation = limited (iframe same-origin policy)
  Audit = none

FUTURE (Runtime v2.0):
  dApp = signed Digital Capsule (WASM or microVM)
  Security = capability tokens (zero ambient authority)
  Isolation = Wasmtime sandbox or Firecracker VM
  Audit = every capability grant cryptographically logged

  The capsule CANNOT:
  - Access the network without a token
  - Read files outside its scope
  - Talk to other capsules without permission
  - Exfiltrate user data
  
  The capsule CAN:
  - Make RPC calls to smart contracts (if granted network capability)
  - Store local state (if granted storage capability)
  - Display UI (always permitted — rendering is safe)
```

This means a user running "Uniswap DEX" as a Runtime capsule has cryptographic guarantees that the app can ONLY talk to the blockchain endpoints it's permitted to access. No data exfiltration, no secret network calls, no file access — enforced by the Runtime, not by trust.

### Convergence Timeline

```
WHAT WE SHIP                     RUNTIME DEPENDENCY
───────────────────────────────  ──────────────────────
v1.2.0  Non-media dDRM            None — pure PC2
        (Chipotle, auto-provision)

v1.3.0  AI models + dApp bundles  None — decrypt + load
        + datasets

v1.4.0  Media pipeline             None — existing WASM
        (Chipotle encoder)

v1.5.0  HTML5 games, 3D models    None — iframe sandbox
        dApp Store v1

v1.6.0  Signed capsule format     Light — Ed25519 from Runtime
        dApp Store v2

v2.0.0  Full Runtime convergence  Full — Wasmtime + capabilities
        PC2 desktop as Shell capsule
        dDRM as Provider Capsule

v2.1.0  Native game capsules      Full — microVM (Firecracker)
        Software licensing
```

v1.2.0 through v1.5.0 ship value with zero Runtime dependency. The Runtime convergence makes everything *better* (real sandboxing, capability tokens, cross-platform portability) but is not a blocker for the marketplace to grow.

---

## The 30-Second Pitch

Elacity is the Amazon of digital assets for Web3. Every digital product — media, dApps, AI models, code, datasets, games, agent skills — encrypted and distributed via IPFS, with access tokens on-chain. Creators keep 95%+. Buyers own what they buy and run it on their own hardware. Agents trade autonomously 24/7. No middlemen, no platform lock-in, no censorship.

Imagine: Uniswap sells their DEX as a dApp for $5. You buy it, download it to your PC2 node, and run it locally — no hosted frontend to hack, no DNS to hijack. A photographer sells stock photos with instant royalty splits. An AI researcher sells a fine-tuned model that auto-loads into your local Ollama. A game studio sells their HTML5 game and gets paid on every resale.

We have working DRM contracts on Base, a functioning marketplace, 84+ PC2 nodes seeding content, a pure Rust runtime with WASM + microVM sandboxing, and the only decentralized DRM stack in production. We're building what Apple, Google, and Amazon built for the old internet — but for the new one, where users own their infrastructure and creators own their revenue.

---

*This document is the strategic north star. Update as the market evolves and execution progresses.*
*Last updated: 2026-03-18 — Added Runtime convergence details, dApp Store model, asset readiness status.*
