# PC2 × Elacity dDRM: Decentralization Status & Roadmap

> **Purpose:** Team-facing document covering what we've built, how decentralized it is, what's remaining, and the path to the walk-away test.
> **Created:** 2026-03-14
> **Last Updated:** 2026-03-14
> **Branch:** `dDRM-extended`

---

## Executive Summary

We have a working **encrypt → mint → buy → decrypt** pipeline for non-media digital assets (images, documents, etc.) on PC2 sovereign nodes, using the Elacity protocol's on-chain contracts and Lit Protocol for trustless decryption.

**The trust model and economic layer are fully decentralized.** Smart contracts govern access, Lit Protocol nodes perform threshold decryption, and the Lit Action code is immutable on IPFS. No single party can forge access or tamper with the decryption logic.

**What's still centralized is the convenience layer** — content discovery (Elacity GraphQL), content delivery (Elacity IPFS gateway), IPFS uploads, and Lit capacity credits. These are solvable, and solving them enables the walk-away test.

---

## What We've Built (Mar 13–14, 2026)

### End-to-End Pipeline — Working

| Step | Component | Status |
|------|-----------|--------|
| 1. Encrypt | AES-GCM via Lit Protocol on PC2 node backend | ✅ Working |
| 2. Upload | Dual IPFS upload (local Helia + Elacity gateway) | ✅ Working |
| 3. Mint | On-chain ERC-1155 mint on Base (Channel contract) | ✅ Verified |
| 4. List | Asset visible on Elacity marketplace + PC2 Market dApp | ✅ Verified |
| 5. Purchase | `buyAccess()` via AuthorityGateway, USDC payment | ✅ Verified |
| 6. Decrypt | Lit Action `executeJs()` with on-chain access check | ✅ Working |
| 7. Render | Inline image rendering in Market dApp | ✅ Working |

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

#### Capacity Credit Auto-Detection

Lit Protocol's Datil production network requires capacity credits (RLI tokens). Rather than hardcoding a token ID:
- The server queries the Chronicle Yellowstone chain for RLI tokens owned by the capacity wallet
- Selects the latest non-expired token automatically
- Handles Elacity's 15-day rotation cycle (cronjob provisions new tokens, old ones expire within 30 days)
- Supports manual override via env var or config file

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
| **Elacity GraphQL API** (`base.ela.city/api/2.0/graphql`) | Browse, search, library, asset details, channel discovery | No content discovery | On-chain indexer (The Graph or custom) |
| **Elacity IPFS Gateway** (`ipfs.ela.city/ipfs/`) | Content serving, metadata, image resolution | Can't load content | Each node runs own IPFS, use public gateways |
| **Elacity IPFS Upload** (`base.ela.city/api/2.0/files/upload`) | Upload encrypted assets + metadata | Can't publish new assets | Upload to local IPFS, propagate via DHT |
| **Elacity Auth** (nonce/login) | GraphQL API authentication | Can't query API | Node-local wallet signature verification |
| **Capacity Credit Wallet** (`0x581D...`) | RLI delegation for Lit operations | Rate-limited decryption | Each node mints own RLI tokens |
| **Royalty Addresses** (`0x0917...`, `0xCE46...`) | Protocol fee recipient on every sale | Fees flow to Elacity only | On-chain configurable per-channel |
| **Base RPC** (`mainnet.base.org`) | On-chain reads/writes | All on-chain ops fail | Use redundant RPC providers |

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
| Discover other nodes' content | ❌ No | Depends on Elacity GraphQL |
| Self-provision capacity credits | ❌ No | Not yet implemented |

---

## Roadmap to Walk-Away Test

The "walk-away test" means: Elacity Labs stops running infrastructure, but the protocol keeps working. Creators can publish, buyers can purchase, content decrypts, and protocol fees still flow on-chain.

### Tier 1: Critical Path (Enables P2P Without Elacity Infrastructure)

#### 1.1 — Decentralized Content Index

**Problem:** All content discovery goes through `base.ela.city/api/2.0/graphql`. If this API is down, nodes can't find content.

**Solution:** On-chain indexer that reads Base chain events directly.

- Channel contracts emit `AssetCreated` / `TransferSingle` events with `tokenURI` pointing to IPFS metadata
- Each PC2 node can run a lightweight indexer that:
  - Monitors Channel contract events on Base
  - Builds a local SQLite database of all assets
  - Serves browse/search/library queries locally
- **Options:** The Graph subgraph (hosted or self-hosted), custom event scanner, or Ponder/Envio indexer
- **Impact:** Removes the single biggest centralization point

**Effort:** Medium (1-2 weeks)

#### 1.2 — Self-Sufficient IPFS

**Problem:** Content uploads go to `base.ela.city/api/2.0/files/upload`. Content serving relies on `ipfs.ela.city/ipfs/`.

**Solution:** Each node is a first-class IPFS participant.

- We already have Helia running on each node with:
  - ✅ DHT announcement (`dht.provide()`)
  - ✅ Periodic re-announcement (every 4 hours)
  - ✅ Bitswap-first fetching
  - ✅ Circuit relay + NAT traversal
  - ✅ Supernode IPFS relay nodes
- **Remaining:**
  - Upload goes to **local IPFS first**, with optional Elacity mirror
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

Revenue flows are enforced by smart contracts, not infrastructure:

```
Buyer pays 1.00 USDC for AccessToken
  ├── 0.95 USDC → Creator wallet (on-chain transfer)
  ├── 0.05 USDC → Elacity royalty wallet (on-chain transfer, configured per-channel)
  └── AuthorityGateway may take additional protocol fee (on-chain)

On resale:
  ├── Resale price → Seller
  ├── Royalty % → Creator (enforced by operative contract)
  └── Protocol fee → AuthorityGateway
```

**Walk-away implication:** Even if all Elacity infrastructure goes offline, every `buyAccess()` call on-chain still:
- Transfers payment to the creator
- Distributes royalties per the operative contract
- Records the AccessToken on-chain for the buyer

Protocol fees are collected at the **smart contract level**, not the infrastructure level.

---

## Key Contracts (Base Mainnet, Chain ID 8453)

| Contract | Address | Purpose |
|----------|---------|---------|
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` | Fee lookups, storage |
| AuthorityGateway | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` | Access control, `buyAccess()`, `hasAccessByContentId()` |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` | Channel creation, minting |
| TradeGateway | `0x9eC53758b698f9F68C0654DDd9159173a159a459` | Secondary market trading |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment token (6 decimals) |
| OperativeBuyable Factory | `0x4A49A185c4bD77f037cE4f9fE788fc95ec8f3123` | Deploys buy-only operatives |
| OperativeBuyableSellable Factory | `0x50002734a4546Ca153BF8b4cC703Fc53Ba90eb9f` | Deploys buy+resell operatives |

---

## Lit Protocol Infrastructure

| Component | Detail |
|-----------|--------|
| Network | Datil (production) |
| Lit Action | `non-media-decrypt.js` — on-disk, read directly, no IPFS fetch needed |
| Access conditions | Self-referential only (`:currentActionIpfsId === CID`) |
| Capacity credits | RLI tokens on Chronicle Yellowstone, auto-detected |
| Capacity wallet | `0x581D4bca99709c1E0cB6f07c9D05719818AA6e49` (20 RLI tokens, rotated every 15 days) |
| Session duration | 15 minutes |
| Server wallet | Auto-generated, stored at `data/.lit-server-key` |

---

## Verified On-Chain Transactions

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

## Blocking Item

**Capacity credit delegation key.** The private key for wallet `0x581D4bca99709c1E0cB6f07c9D05719818AA6e49` (RLI token owner) is needed to delegate capacity credits for Lit Protocol operations. Without this, decrypt operations on the Datil production network are rate-limited.

**Status:** Waiting on Irzhy to provide the private key. Once received:

```bash
echo "THE_PRIVATE_KEY" > pc2-node/data/.lit-capacity-key
chmod 600 pc2-node/data/.lit-capacity-key
# Restart node — auto-detection finds the latest valid RLI token automatically
```

---

## Next Steps (Priority Order)

1. **Get capacity credit key** → enables production decrypt testing
2. **Test full E2E flow** → encrypt → mint → buy → decrypt an image on PC2 node
3. **Fix library showing all purchased assets** (GraphQL query may need adjustment)
4. **On-chain indexer prototype** (Tier 1.1) → removes GraphQL dependency
5. **Self-provisioned RLI tokens** (Tier 1.3) → removes capacity wallet dependency
6. **AI Model Marketplace alpha** → first non-media vertical (GGUF → encrypt → buy → Ollama)

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
