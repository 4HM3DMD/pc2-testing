# Elacity Universal Asset Strategy

> **Purpose:** Define the path from media DRM marketplace to universal digital asset monetization protocol.
> **Created:** 2026-03-08
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

### Tier 1: Ready Now (Contracts Support Today)

| Marketplace | Asset Type | Revenue Model | Difficulty |
|-------------|-----------|---------------|------------|
| Media streaming | Video, music, podcasts | Buy/rent/subscribe | Done |
| E-books / documents | PDF, ePub, text | Buy/rent | Easy |
| Stock photography | Images | Buy, royalty-free | Easy |
| Design templates | Figma, PSD, HTML | Buy | Easy |
| Audio samples / SFX | WAV, MP3 packs | Buy | Easy |
| 3D models | glTF, FBX | Buy/license | Medium |
| Fonts | OTF, TTF, WOFF | License | Easy |

### Tier 2: Needs `@elacity-js/access` (M3-M4)

| Marketplace | Asset Type | Revenue Model | TAM |
|-------------|-----------|---------------|-----|
| **AI model marketplace** | ONNX, SafeTensors, GGUF | Buy/rent/compute-time | $50B+ by 2030 |
| Code marketplace | npm packages, plugins, themes | License/subscribe | $15B+ |
| Dataset marketplace | CSV, Parquet, JSON | Buy/subscribe/usage | $10B+ |
| Software licensing | Executables, SaaS access | License keys, subscription | $200B+ |
| API marketplace | Endpoint access | Usage-based, subscription | $30B+ |
| Education marketplace | Courses, tutorials | Buy/subscribe | $40B+ |

### Tier 3: Needs Runtime (M5-M7)

| Marketplace | Asset Type | Revenue Model | TAM |
|-------------|-----------|---------------|-----|
| Agent marketplace | LLM agents, tools, skills | Hire/subscribe/revenue-share | Emerging |
| Compute marketplace | GPU/CPU time | Usage-based | $100B+ |
| MicroVM app marketplace | Full sandboxed apps | Buy/subscribe | Emerging |

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

### 6. Creator Tools

Buyer experience is built. Creator tools are thin. Need a "Creator Dashboard" dApp that makes it dead simple to: select file, set price, set royalties, encrypt, upload, list. One click from file to marketplace.

**Action:** Creator Dashboard dApp with `@elacity-js/asset-packager` integration.

### 7. Data Unions

The massive TAM is collective data: photographer collectives, research teams, music catalogs licensing combined catalogs. `MultiChannel` already supports multi-creator channels. Extend to "Data Unions" with proportional ROYALTY_SHARE distribution.

**Action:** Data Union channel type in dApp Center (M5+).

---

## Runtime Convergence

When the Rust Runtime is ready, dDRM access tokens and capability tokens work together:

```
1. User/Agent buys ACCESS_TOKEN on-chain (Elacity contracts)
2. Capsule requests "drm:decrypt" capability
3. Runtime checks: does wallet hold ACCESS_TOKEN?
   (calls AuthorityGateway.hasAccess() via @elacity-js/contracts)
4. Runtime issues capability token: { action: "decrypt", resource: CID, expires: ... }
5. Capsule presents capability token to Lit Protocol for decryption key
6. Capsule decrypts and uses the asset
7. Everything audited in capability log
```

**Key insight:** dDRM ACCESS_TOKENs are the on-chain authorization layer. Runtime capability tokens are the off-chain enforcement layer. They're complementary, not competing.

---

## The 30-Second Pitch

Elacity is the monetization protocol for the decentralized web. Every digital asset — media, AI models, code, datasets, agent skills — encrypted and distributed via IPFS, with access tokens on-chain. Creators keep 95%+. Buyers own what they buy. Agents trade autonomously 24/7. No middlemen, no platform lock-in, no censorship.

We have working DRM contracts on Base, a functioning marketplace, 84+ PC2 nodes seeding content, and the only decentralized DRM stack in production. We're building what Apple, Google, and Amazon built for the old internet — but for the new one, where users own their infrastructure and creators own their revenue.

---

*This document is the strategic north star. Update as the market evolves and execution progresses.*
