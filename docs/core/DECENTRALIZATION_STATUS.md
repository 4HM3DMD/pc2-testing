# PC2 × Elacity dDRM: Decentralization Status & Roadmap

> **Purpose:** Team-facing document covering what we've built, how decentralized it is, what's remaining, and the path to the walk-away test.
> **Created:** 2026-03-14
> **Last Updated:** 2026-04-07
> **Branch:** `feature/lit-chipotle-migration`

---

## Executive Summary

We have a working **encrypt → mint → buy → decrypt → secure view** pipeline for non-media digital assets (images, PDFs, text) on PC2 sovereign nodes, using the Elacity protocol's on-chain contracts and Lit Protocol for trustless decryption. Decrypted assets are rendered server-side and streamed as watermarked images — plaintext never reaches the browser.

**The trust model and economic layer are fully decentralized.** Smart contracts govern access, Lit Protocol nodes perform threshold decryption, and the Lit Action code is immutable on IPFS. No single party can forge access or tamper with the decryption logic.

**What's still centralized is the convenience layer** — content discovery (Elacity GraphQL), content delivery (Elacity IPFS gateway), IPFS uploads, and Lit capacity credits. These are solvable, and solving them enables the walk-away test.

---

## What We've Built (Mar 13–14, 2026)

### End-to-End Pipeline — Working

| Step | Component | Status |
|------|-----------|--------|
| 1. Encrypt | Two-layer: AES-GCM file encryption + Lit CEK encryption | ✅ Working |
| 2. Upload | Dual IPFS upload (local Helia + Elacity gateway) | ✅ Working |
| 3. Mint | On-chain ERC-1155 mint on Base (Channel contract) | ✅ Verified |
| 4. List | Asset visible on Elacity marketplace + PC2 Market dApp | ✅ Verified |
| 5. Purchase | `buyAccess()` via AuthorityGateway, USDC payment | ✅ Verified |
| 6. Decrypt | Lit Action `executeJs()` via Pinata-backed IPFS CID with on-chain access check | ✅ Working |
| 7. Render | Server-side secure viewer: images (Sharp), PDFs (PDF.js+Canvas), text (Canvas) — watermarked, no plaintext in browser | ✅ Working |

### Key Architecture Decisions

#### Lit Action Trust Model (Path A: Custom Inner Action)

This was the most critical architectural decision. The challenge: the PC2 node server calls Lit's `executeJs()`, so the session belongs to the **server wallet**, not the buyer. If we used Lit's `:userAddress` parameter, it would check the server's access — not the buyer's.

**Solution:** A custom Lit Action (`non-media-decrypt.js`) that:

1. **Receives `buyerAddress` as a `jsParam`** (passed by the server)
2. **Verifies access on-chain** by calling `AuthorityGateway.hasAccessByContentId(buyerAddress, kid)` directly via ethers.js on the Lit nodes
3. **Uses self-referential-only access conditions** at encrypt time — the condition only checks that `:currentActionIpfsId === ourCID`, meaning only this specific immutable code can trigger decryption
4. **Returns the decrypted CEK** only if access is verified

**Why this is trustless:**
- The Lit Action code is **immutable** (pinned on IPFS, content-addressed)
- It runs on **6+ distributed Lit TEE nodes** — no single party controls execution
- The `hasAccessByContentId` call is a **direct on-chain read** — can't be faked
- The server can't substitute a different buyer address because the contract checks real on-chain AccessToken ownership

```
Encrypt Time:
  Creator → PC2 Node → Lit encrypt(content, conditions=[self-ref-only]) → IPFS

Decrypt Time:
  Buyer clicks "Decrypt" → PC2 Node → Lit executeJs(code, {buyerAddress, kid, ...})
                                        → Lit nodes run action code:
                                            1. hasAccessByContentId(buyerAddress, kid) ← on-chain
                                            2. If true → decryptAndCombine(ciphertext) ← threshold decrypt
                                            3. Return CEK → PC2 Node → AES-GCM decrypt → Return bytes
```

#### Smart Account Awareness

Buyers using Universal Accounts (ERC-4337) hold AccessTokens on their **Smart Account address**, not their EOA. The Market app detects this and passes the Smart Account address as `buyerAddress` to the decrypt endpoint, ensuring the on-chain access check succeeds.

#### Capacity Credit Management (Lit Payment Delegation)

Lit Protocol's Datil production network requires capacity credits (RLI tokens). We use Elacity's **Lit Payment Delegation Database**:
- PC2 node's auto-generated server wallet (`0xC5597Bf8A0a34AdE6b6f3b8e2F573439dF33113e`) is registered as a payee
- Registration happens automatically on startup via Lit Relayer API (`https://datil-relayer.getlit.dev/add-users`)
- Credentials stored in `data/.lit-relayer-config` (apiKey + payerSecretKey from Elacity)
- Handles Elacity's 15-day RLI token rotation cycle automatically
- **No private key storage needed** — delegation is done via the Relayer API

**Lit Action hosting:** Pinned on Pinata (`QmVMgKMKFELHTZf8PmD58nYBhr4S5DHLpuwFTvyDKLPXgq`), accessible via `ipfs.litgateway.com`. Self-referential access conditions match this CID at both encrypt and decrypt time.

**⚠️ CRITICAL: Datil network deprecated ~April 25, 2026.** Migration to Chipotle (REST API, API keys, TEE execution) required. See Roadmap.

---

## Decentralization Scorecard

### Fully Decentralized (Walk-Away Ready)

| Component | How It Works | Why It's Decentralized |
|-----------|-------------|----------------------|
| **Smart contracts** | ERC-1155 operatives, AuthorityGateway, ChannelCore on Base L2 | Immutable, permissionless, anyone can verify |
| **Access verification** | `hasAccessByContentId()` on AuthorityGateway | Direct on-chain call, no intermediary |
| **Purchase / sale** | `buyAccess()` on AuthorityGateway with USDC | On-chain, trustless, royalties auto-split |
| **Revenue distribution** | Operative contracts split payment (creator + royalty) | Enforced by smart contract, not infrastructure |
| **Lit Action code** | Pinned on IPFS, runs on 6+ distributed TEE nodes | Immutable, content-addressed, can't be tampered |
| **Encryption** | AES-GCM via Lit Protocol threshold encryption | Key shares distributed across Lit nodes |
| **Decryption** | `executeJs()` runs Lit Action on distributed nodes | No single point of failure |
| **AccessToken ownership** | ERC-1155 sub-token on operative contract | On-chain, survives any infrastructure failure |

**Bottom line:** If Elacity disappeared tomorrow, every AccessToken holder can still **prove** their ownership on-chain. The decryption code is immutable on IPFS. Any new infrastructure that speaks the same protocol can verify access and decrypt content.

### Centralized Dependencies (Need Work)

| Dependency | What It Does | Impact If Down | Decentralization Path |
|------------|-------------|----------------|----------------------|
| **Elacity GraphQL API** (`base.ela.city/api/2.0/graphql`) | Browse, search, library, asset details, channel discovery | No content discovery | ✅ On-chain indexer (`ContentIndexerService`) — DONE. Fallback only |
| **Elacity IPFS Gateway** (`ipfs.ela.city/ipfs/`) | Content serving, metadata, image resolution | Can't load content | Each node runs own IPFS, use public gateways |
| **Elacity IPFS Upload** (`base.ela.city/api/2.0/files/upload`) | Upload encrypted assets + metadata | Can't publish new assets | Upload to local IPFS, propagate via DHT |
| **Elacity Auth** (nonce/login) | GraphQL API authentication | Can't query API | Node-local wallet signature verification |
| **Capacity Credit Wallet** (`0x581D...`) | RLI delegation for Lit operations | Rate-limited decryption | Each node mints own RLI tokens |
| **Royalty Addresses** (`0x0917...`, `0xCE46...`) | Protocol fee recipient on every sale | Fees flow to Elacity only | On-chain configurable per-channel |
| **Base RPC** (`mainnet.base.org`) | On-chain reads/writes | All on-chain ops fail | ✅ Shared `rpc.ts` utility with 5 endpoints + round-robin failover |

---

## What Each New PC2 Node Gets Today

A new PC2 node operator can:

| Capability | Works Today? | Requires |
|-----------|-------------|----------|
| Run Creator Dashboard | ✅ Yes | Own wallet |
| Encrypt assets with Lit | ⚠️ Needs capacity credits | Private key for RLI wallet |
| Upload to local IPFS | ✅ Yes | Nothing |
| Upload to Elacity IPFS | ✅ Yes | API access |
| Mint on Base (any channel) | ✅ Yes | Gas (ETH on Base) |
| Browse Elacity marketplace | ✅ Yes | Elacity API online |
| Purchase assets | ✅ Yes | USDC + gas |
| Decrypt purchased assets | ⚠️ Needs capacity credits | Private key for RLI wallet |
| Discover other nodes' content | ✅ Yes | On-chain indexer scans Base events locally |
| Self-provision capacity credits | ❌ No | Not yet implemented |

---

## Roadmap to Walk-Away Test

The "walk-away test" means: Elacity Labs stops running infrastructure, but the protocol keeps working. Creators can publish, buyers can purchase, content decrypts, and protocol fees still flow on-chain.

### Tier 1: Critical Path (Enables P2P Without Elacity Infrastructure)

#### 1.1 — Decentralized Content Index — ✅ COMPLETE (Mar 21)

**Problem:** All content discovery goes through `base.ela.city/api/2.0/graphql`. If this API is down, nodes can't find content.

**Solution:** `ContentIndexerService` — on-chain event scanner running on each PC2 node.

- ✅ Scans `DigitalAssetRegistered` events from CoreStorage contract on Base
- ✅ Builds local `content_catalog` SQLite table (migration 19) with indexes on creator, type, content_id, channel, status, block
- ✅ Resolves metadata: calls `tokenURI()` on channel contracts, fetches JSON from IPFS (local-first, then gateway fallback)
- ✅ Classifies asset types automatically (image, video, audio, document, code, ai-model, dataset, 3d, font, etc.)
- ✅ API endpoints: `GET /api/catalog` (browse/filter/search), `GET /api/catalog/stats`, `GET /api/catalog/content/:contentId`
- ✅ RPC failover with rotation across multiple providers
- ✅ Configurable: scan interval (30min), max blocks per scan (10K), metadata fetch concurrency (3)
- ✅ **Versioned contract design** — when v3 contracts deploy, add to config:
  ```json
  "contracts": {
    "v2": { "core_storage": "0xc8F50Bf1...", "from_block": 12345678 },
    "v3": { "core_storage": "0xNEW...", "from_block": 99999999 }
  }
  ```
  No code changes needed — the indexer picks up both v2 and v3 content.
- ✅ Progress tracking via settings (`indexer_last_block_v2`) — resumes from where it left off across restarts
- **Files:** `pc2-node/src/services/ContentIndexerService.ts`, `pc2-node/src/storage/database.ts` (ContentCatalogItem + 7 methods), `pc2-node/src/api/index.ts` (3 routes)
- **Impact:** Removes the single biggest centralization point — Elacity GraphQL is now optional for content discovery

#### 1.2 — Self-Sufficient IPFS

**Problem:** Content uploads go to `base.ela.city/api/2.0/files/upload`. Content serving relies on `ipfs.ela.city/ipfs/`.

**Solution:** Each node is a first-class IPFS participant.

- We already have Helia running on each node with:
  - ✅ DHT announcement (`dht.provide()`)
  - ✅ Tiered re-announcement — hot (2h) / warm (6h) / cold (12h) based on serve recency *(upgraded Mar 21)*
  - ✅ Startup burst re-announcement of all pinned CIDs *(added Mar 21)*
  - ✅ Bitswap-first fetching
  - ✅ Circuit relay + NAT traversal
  - ✅ Supernode IPFS relay nodes
  - ✅ **ContentSeedingService** — automatic pin queue with priority, dedup, retry, gap recovery, and persistent serve tracking *(added Mar 21)*
  - ✅ Persistent serve stats (`serve_count`, `last_served_at`) for CID tier classification *(added Mar 21)*
  - ✅ Unpin endpoint (`DELETE /api/ipfs/unpin/:cid`) for content removal *(added Mar 21)*
- ✅ **Auto-download on purchase** — `pinAndRegisterMedia()` in Market dApp auto-calls `POST /api/storage/ipfs/pin` → `seedContent()` after `buyAccess()`. Full chain: purchase → pin → DHT announce → DB tracking *(verified Mar 23)*
- ✅ **Disk quota enforcement** — `isQuotaExceeded()` in ContentSeedingService checks `statfsSync` against `disk_quota_percent` *(completed Mar 23)*
- ✅ **Bandwidth enforcement** — `bandwidthGuard` middleware on `/ipfs/` routes, rolling 5s window, 503 with Retry-After *(completed Mar 23)*
- **Remaining:**
  - Upload goes to **local IPFS first**, with optional Elacity mirror (DEFERRED — needs Elacity-side coordination)
  - Content resolves from **any IPFS gateway** (local → peers → public gateways)
  - Metadata `tokenURI` should use `ipfs://` URIs (already the case), resolvable from any gateway
  - Pin content on multiple providers (Pinata, web3.storage) for redundancy

**Effort:** Low (most infrastructure exists, needs fallback chain for resolution)

#### 1.3 — Self-Provisioned Capacity Credits

**Problem:** Lit Protocol operations on Datil network require RLI tokens. Currently uses Elacity's delegation wallet.

**Solution:** Each node operator mints their own RLI tokens.

- RLI tokens are free to mint on Chronicle Yellowstone (just gas on testnet chain)
- Node generates its own server wallet on first startup
- Node mints an RLI token and uses it for all Lit operations
- Auto-renewal on expiry (current tokens last 30 days)
- **No dependency on Elacity's wallet or delegation**

**Effort:** Low-Medium (1 week — mint flow + auto-renewal)

### Tier 2: Enhanced Decentralization

#### 2.1 — Peer Discovery

**Problem:** Nodes don't know about each other's content without the centralized API.

**Solution:**
- **Option A:** Use IPFS's existing DHT — content is already announced, peers already discover providers
- **Option B:** Lightweight on-chain registry of node endpoints (address → IPFS multiaddr)
- **Option C:** Gossip protocol between nodes (already implemented for supernodes)
- Start with Option A (already working), add B for explicit node registry

**Effort:** Low (A is done, B is medium)

#### 2.2 — Node-Local Auth

**Problem:** Market app authenticates via Elacity's SIWE nonce endpoint.

**Solution:** Node verifies wallet signatures directly.

- PC2 node already has its own auth layer (`puter.auth.token`)
- For on-chain operations, wallet signature is sufficient
- No round-trip to `base.ela.city` needed for nonce generation
- Standard SIWE verification is a local operation

**Effort:** Low (partially done)

#### 2.3 — Configurable Protocol Fees

**Problem:** Royalty addresses are hardcoded to Elacity wallets.

**Solution:** Fees already flow on-chain via the operative contracts.

- Each channel's authority contract already supports configurable royalty splits
- Creator sets split at mint time (currently 95% creator / 5% Elacity)
- **This already works** — the addresses are configured per-channel, not globally
- For protocol-level fees, AuthorityGateway takes a cut on `buyAccess()`
- Elacity collects fees via smart contract logic, not infrastructure control

**No work needed** — this is already decentralized by design.

### Tier 3: Full Sovereignty

#### 3.1 — Cross-Node Library Sync

**Problem:** "My Library" depends on Elacity GraphQL to know what the user owns.

**Solution:** Query the chain directly.

- AccessToken ownership is on-chain (ERC-1155 `balanceOf` on operative contracts)
- Node can scan all known operative contracts for tokens held by connected wallet
- Combined with on-chain indexer (Tier 1.1), the node has a complete local view
- **No API dependency** — pure on-chain reads

**Effort:** Medium (depends on Tier 1.1 indexer)

#### 3.2 — Decentralized Lit Action Hosting

**Problem:** Lit Action is deployed to Elacity's IPFS.

**Solution:** Already mostly solved.

- Lit Actions are **content-addressed** (IPFS CID = hash of code)
- Same code on any IPFS gateway = same CID
- Can pin to Pinata, web3.storage, Filebase, or any IPFS provider
- Currently the server reads the action code from disk and passes it via `code` parameter (bypasses IPFS fetch entirely)
- The `ipfsId` is needed only for the self-referential access condition matching

**Effort:** Already done (disk-first, IPFS as backup)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     FULLY DECENTRALIZED                         │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────────┐   │
│  │   Base    │    │ Lit Protocol │    │      IPFS DHT       │   │
│  │ Mainnet  │    │   (Datil)    │    │                     │   │
│  │          │    │              │    │  Content-addressed   │   │
│  │ Channels │    │ 6+ TEE nodes │    │  Immutable storage   │   │
│  │ Operativ │    │ Threshold    │    │  P2P distribution    │   │
│  │ Gateway  │    │ decryption   │    │                     │   │
│  └────┬─────┘    └──────┬───────┘    └──────────┬──────────┘   │
│       │                 │                       │               │
├───────┼─────────────────┼───────────────────────┼───────────────┤
│       │                 │                       │               │
│  ┌────▼─────────────────▼───────────────────────▼──────────┐   │
│  │                   PC2 NODE (Sovereign)                   │   │
│  │                                                          │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐            │   │
│  │  │ Creator  │  │  Market  │  │  Storage   │            │   │
│  │  │Dashboard │  │   dApp   │  │   API      │            │   │
│  │  │          │  │          │  │            │            │   │
│  │  │ Encrypt  │  │ Browse   │  │ Lit encrypt│            │   │
│  │  │ Upload   │  │ Purchase │  │ Lit decrypt│            │   │
│  │  │ Mint     │  │ Decrypt  │  │ IPFS pin   │            │   │
│  │  │ Approve  │  │ Render   │  │ Server key │            │   │
│  │  └──────────┘  └──────────┘  └────────────┘            │   │
│  │                                                          │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐            │   │
│  │  │  Helia   │  │ Wallet   │  │  Lit Node  │            │   │
│  │  │  (IPFS)  │  │ Bridge   │  │  Client    │            │   │
│  │  │          │  │          │  │ (Server)   │            │   │
│  │  │ DHT      │  │ Particle │  │ Session    │            │   │
│  │  │ Bitswap  │  │ Auth     │  │ Capacity   │            │   │
│  │  │ Relay    │  │ Smart    │  │ Delegation │            │   │
│  │  │ NAT trav │  │ Account  │  │ Auto-detect│            │   │
│  │  └──────────┘  └──────────┘  └────────────┘            │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                  CENTRALIZED (TO BE REPLACED)                   │
│                                                                 │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────┐   │
│  │ Elacity API  │  │ Elacity IPFS  │  │ Capacity Wallet    │   │
│  │ (GraphQL)    │  │ (Gateway)     │  │ (RLI Delegation)   │   │
│  │              │  │               │  │                    │   │
│  │ Discovery    │  │ Upload        │  │ Rate limit bypass  │   │
│  │ Search       │  │ Serving       │  │ Session sigs       │   │
│  │ Library      │  │ Resolution    │  │                    │   │
│  └──────────────┘  └───────────────┘  └────────────────────┘   │
│                                                                 │
│  Replace with:     Replace with:      Replace with:            │
│  On-chain indexer  Local IPFS +        Self-minted RLI         │
│  (The Graph /      public gateways     tokens per node         │
│   custom scanner)                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Protocol Fee Model (Already Decentralized)

Revenue flows are enforced by smart contracts, not infrastructure.

### V3 Model (Active)

V3 contracts handle protocol fees automatically via `protocolShares` — no manual royalty calculation needed:

```
At mint time (V3 — verified on-chain Apr 6, 2026):
  ROYALTY_SHARE token (ID 2) distribution:
  ├── 950 per-mille (95%) → Creator wallet
  └──  50 per-mille (5%)  → Protocol address (0xdb0e70c1...)

  ACCESS_TOKEN (ID 1, 1M copies) → Creator (for sale)
  DISTRIBUTION_RIGHT (ID 3, 1 copy) → Creator

On primary buy:
  Buyer pays USDC → AuthorityGateway.buyAccess()
  ├── Creator share → Creator wallet (per ROYALTY_SHARE)
  ├── Protocol share → Protocol wallet (per ROYALTY_SHARE)
  └── AccessToken transferred → Buyer

On resale:
  ├── Resale price → Seller
  ├── Royalty % → Creator (enforced by operative resellerCut)
  └── Protocol fee → per ROYALTY_SHARE distribution
```

**Walk-away implication:** Even if all Elacity infrastructure goes offline, every `buyAccess()` call on-chain still:
- Transfers payment to the creator
- Distributes royalties per the operative contract
- Records the AccessToken on-chain for the buyer

Protocol fees are collected at the **smart contract level**, not the infrastructure level.

---

## Key Contracts (Base Mainnet, Chain ID 8453)

### V3 Contracts (Active — ElastOS v1.2+)

| Contract | Address | Purpose |
|----------|---------|---------|
| CentralStorage | `0x0C1EeA2A3361B80AC0e42179335dB536A951760b` | Content registration, fee lookups |
| AuthorityGateway | `0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D` | Access control, `buyAccess()`, `hasAccessByContentId()` |
| ChannelFactory | `0xE1365ed47353De2F8A6a69E271e36650A9EE368F` | Channel creation, `ChannelCreated` events |
| RoyaltyTradeGateway | `0xd02451BCE627EF476B8ee52Cf131C426f67dbcB2` | Secondary market royalty share trading |
| EventHub | `0x5a694A6d988354dca491fe0F6db7a6ef46b656c2` | Cross-contract event aggregation |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment token (6 decimals) |

**V3 key changes from V2:**
- `protocolShares` (5%) handled automatically by V3 contracts — no manual royalty addition needed
- `operative(address channel, uint256 tokenId)` replaces V2 `operativeOf` for lookups
- `ChannelFactory` deploys channels (V2 used `ChannelCore`)
- `CentralStorage` replaces `CoreStorage` for content registration
- `EventHub` aggregates events from all V3 contracts (key for indexer integration)

### V2 Contracts (Legacy — reference only)

| Contract | Address | Purpose |
|----------|---------|---------|
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` | Fee lookups, storage |
| AuthorityGateway | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` | Access control |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` | Channel creation, minting |
| TradeGateway | `0x9eC53758b698f9F68C0654DDd9159173a159a459` | Secondary market trading |
| OperativeBuyable Factory | `0x4A49A185c4bD77f037cE4f9fE788fc95ec8f3123` | Deploys buy-only operatives |
| OperativeBuyableSellable Factory | `0x50002734a4546Ca153BF8b4cC703Fc53Ba90eb9f` | Deploys buy+resell operatives |

---

## Lit Protocol Infrastructure

| Component | Detail |
|-----------|--------|
| Network | Datil (production) |
| Lit Action | `non-media-decrypt.js` — pinned on Pinata (QmVMgKMKFELHTZf8PmD58nYBhr4S5DHLpuwFTvyDKLPXgq), executed via ipfsId |
| Access conditions | Self-referential only (`:currentActionIpfsId === CID`) |
| Capacity credits | RLI tokens on Chronicle Yellowstone, auto-detected |
| Capacity delegation | Via Lit Relayer API, PC2 server wallet auto-registered as payee |
| Session duration | 15 minutes |
| Server wallet | `0xC5597Bf8A0a34AdE6b6f3b8e2F573439dF33113e` (auto-generated, stored at `data/.lit-server-key`) |
| ⚠️ Deprecation | Datil network deprecated ~April 25, 2026 — migrate to Chipotle |

---

## Verified On-Chain Transactions

### V3 Transactions (Apr 2026 — ElastOS v1.2 E2E Testing)

| Event | Tx Hash | Details |
|-------|---------|---------|
| V3 Channel creation | on-chain | Channel `0x6756E140...` via ChannelFactory, EOA owner `0x34DA...3Dc3` |
| V3 Free mint (image) | on-chain | Token minted, contentId bound to CentralStorage, WASM viewer playback confirmed |
| V3 Paid mint (video) | `0xc1a854205ba6...` | Channel `0x6756E140...`, Operative `0x6e2514...`, buy_and_resell, 0.01 USDC |
| V3 Royalty verification | decoded from logs | ROYALTY_SHARE: 950/1000 creator, 50/1000 protocol — confirmed correct |
| V3 Paid mint (video 2) | on-chain | Channel `0xb4a1c563...`, playback confirmed, MetaMask account-switch UX verified |

### V2 Transactions (Legacy — Mar 2026)

| Event | Tx Hash | Details |
|-------|---------|---------|
| First paid mint | `0x26d40e78...` | Channel `0x2fb53d4a...`, Operative `0xf2359397...` |
| Marketplace mint | — | Channel `0xb4a1c563...`, Operative `0x7D243806...` |
| First purchase | `0xfbfe054a...` | Buyer `0x7efe9dd2...` (Smart Account), 0.01 USDC |
| Re-mint (test 6) | — | Channel `0xb4a1c563...`, Operative `0x765D43...` |

---

## Files & Components

### Core Backend
| File | Purpose |
|------|---------|
| `pc2-node/src/api/storage.ts` | Lit encrypt/decrypt, IPFS upload, capacity credit auto-detection, session management |
| `pc2-node/data/lit-actions/non-media-decrypt.js` | Lit Action code — trustless on-chain access check + threshold decryption |

### Creator Dashboard (`pc2-node/data/test-apps/elacity-creator/`)
| File | Purpose |
|------|---------|
| `app.js` | 4-step wizard: file select → metadata → encrypt & upload → result |
| `index.html` | UI with progress indicators, fix-gateway-approval tool |
| `styles.css` | Styling |

### Market dApp (`pc2-node/data/test-apps/elacity-market/`)
| File | Purpose |
|------|---------|
| `app.js` | Browse, purchase, decrypt, render — Smart Account aware |
| `api.js` | GraphQL client for Elacity backend |
| `wallet.js` | Particle Auth, SIWE, chain switching |

### SDK
| File | Purpose |
|------|---------|
| `packages/access/` | `@elacity-js/access` — universal access layer (12 source files, 47 tests) |
| `packages/access/src/constants.ts` | Contract addresses, ABIs, chain config |

---

## Upcoming Critical Work

### Lit Protocol Chipotle Migration (CRITICAL — ~April 25, 2026 deadline)

Lit Protocol is deprecating the Datil network in favor of **Chipotle** (v3):
- New REST API (replaces SDK-based `executeJs()`)
- API key authentication (replaces SIWE sessions + capacity credits)
- TEE-based execution (replaces threshold MPC)
- **Impact:** All of `storage.ts` Lit integration (~400 lines) needs replacing with ~50 lines of REST calls
- **Risk:** If not migrated before deprecation, all encrypt/decrypt operations stop working

### Remaining Test Coverage

- [ ] Text file (.txt) end-to-end test
- [ ] JPEG image test (PNG verified)
- [ ] Large PDF (10+ pages) stress test

---

## Next Steps (Priority Order)

1. ~~**On-chain indexer prototype** (Tier 1.1) → removes GraphQL dependency~~ — ✅ DONE (Mar 21)
2. ~~**Lit Chipotle migration**~~ — ✅ DONE (Mar 21)
3. ~~**Add fallback Base RPC providers**~~ — ✅ DONE (Mar 23). Shared `rpc.ts` utility with 5 public endpoints, round-robin + failover. All backend files wired (`storage.ts`, `chipotle-client.ts`, `dashPackager.ts`)
4. ~~**Disk quota + bandwidth enforcement**~~ — ✅ DONE (Mar 23). `isQuotaExceeded()` in ContentSeedingService, `bandwidthGuard` middleware in public.ts
5. ~~**P2P content discovery**~~ — ✅ DONE (Mar 23). Catalog `is_local` flag, DHT `countProviders()`, `/api/catalog/providers/:cid`
6. ~~**Creator analytics**~~ — ✅ DONE (Mar 23). `getCreatorStats()`, `GET /api/catalog/creator/:address`
7. **Self-provisioned capacity credits** (Tier 1.3) → LIKELY OBSOLETE. Chipotle uses API keys, not RLI. Re-evaluate when production launches
8. **Reverse IPFS flow** (Tier 1.2) → upload local-first, Elacity mirror optional — DEFERRED (needs Elacity-side coordination and v3 contracts)
9. **Creator publishing UX polish** → channel creation, pricing presets, DHT announce after mint
10. **AI Model Marketplace alpha** → first non-media vertical (GGUF → encrypt → buy → Ollama)

### V3 Contract Upgrade Notes

The on-chain content indexer is designed for forward compatibility with Elacity v3 contracts:

- **Config-only swap**: Add a `"v3"` entry to `content_indexer.contracts` in `config/default.json` with the new `core_storage` address and `from_block`
- **Parallel scanning**: Both v2 and v3 content will be indexed simultaneously — no migration needed
- **Event signature changes**: If v3 emits different events (e.g., different topic signature or different event fields), a small parser update in `ContentIndexerService.scanDigitalAssetRegistered()` may be needed per version. The versioned architecture isolates these changes
- **Database compatible**: The `content_catalog` table includes a `contract_version` column — v2 and v3 content coexist in the same table

#### V3 Migration Status (Apr 7, 2026)

| Component | Status | Notes |
|-----------|--------|-------|
| **Creator Dashboard** | ✅ V3 Live | V3 ABIs, channel creation, free/paid minting, royalty distribution all verified |
| **Market App (Frontend)** | ✅ V3 Ready | V3 contract addresses, ABIs, Base chain — no V2 crossovers |
| **Market App (Backend/API)** | ⏳ Blocked | Elacity GraphQL indexer has NOT indexed V3 channels or assets (`total: 0`). Buy/sell testing blocked until indexer processes V3 EventHub events |
| **Wallet Bridge** | ✅ V3 Live | Base chain (8453) added, gas estimation fixed, account-switch UX added |
| **ContentIndexerService** | ⏳ Needs Config | V3 CentralStorage address (`0x0C1EeA...`) + `from_block` (43892000) to be added to config |
| **Lit Chipotle (dDRM)** | ⏳ Needs V3 ABI | `hasAccessByContentId` call in Lit Action needs V3 AuthorityGateway address |

**Key insight:** The centralized Elacity GraphQL API is the current bottleneck — it has 0 V3 assets indexed and doesn't recognize V3 channels. The **walk-away path** (ContentIndexerService on each node) is designed to solve this, but needs V3 config added. The supernode strategy (Tier 2) would further accelerate indexer scans by routing Base RPC reads through supernodes.

---

## Related Documents

| Document | Path |
|----------|------|
| Session Handover | `docs/core/SESSION_HANDOVER.md` |
| Roadmap | `docs/core/ROADMAP.md` |
| Access Package Spec | `docs/core/ACCESS_PACKAGE_SPEC.md` |
| Universal Asset Strategy | `docs/core/ELACITY_UNIVERSAL_ASSET_STRATEGY.md` |
| Supernode Economics | `docs/core/SUPERNODE_ECONOMICS.md` |
| Architecture Convergence | `docs/core/ARCHITECTURE_CONVERGENCE.md` |
