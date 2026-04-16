# ElastOS Weekly Community Update
## April 4 – April 10, 2026

> **ElastOS Runtime v0.1.2 prep** | **V3 E2E testing — 5/7 passed** | **V3 full contract migration** | **Elastos NFT marketplace app** | **Market UI/UX unification** | **8 PC2 commits** | **DRM Protocol v3 smart contract changes** | **Blockchain explorer frontend + backend** | **New RPC backend live**

---

## Table of Contents

1. [The Big Picture — What Happened This Week](#the-big-picture)
2. [ElastOS Runtime — Room Architecture & v0.1.2 Prep](#elastos-runtime--room-architecture--v012-prep)
3. [DRM Protocol v3 — Smart Contract & System Integration](#drm-protocol-v3--smart-contract--system-integration)
4. [V3 E2E Testing — Creator App, Wallet Bridge & Full Stack](#v3-e2e-testing--creator-app-wallet-bridge--full-stack)
5. [V3 Contract Migration — Zero V2 Addresses Remain](#v3-contract-migration--zero-v2-addresses-remain)
6. [Elastos NFT Marketplace — New PC2 App](#elastos-nft-marketplace--new-pc2-app)
7. [Market UI/UX Unification & Transaction Audit](#market-uiux-unification--transaction-audit)
8. [Blockchain Explorer — New Frontend & Backend](#blockchain-explorer--new-frontend--backend)
9. [Infrastructure & Operations](#infrastructure--operations)
10. [Ecosystem & Community](#ecosystem--community)
11. [What's Next](#whats-next)
12. [Summary Statistics](#summary-statistics)

---

## The Big Picture

This week was about hardening, testing, and expanding the product surface:

1. **The ElastOS Runtime was rebuilt around a cleaner Room architecture**, with Carrier-backed sync tested live across runtimes. The public release branch was reorganized into a coherent 7-commit stack for the v0.1.2 release.

2. **V3 dDRM contracts were fully migrated** — every contract address across the entire stack (Creator, Market, access SDK, content indexer, deploy infrastructure) was updated from V2 to V3. Zero V2 addresses remain in runtime code.

3. **V3 E2E testing reached 5/7 tests passing** — channel creation, free minting, paid minting, dDRM decrypt all verified on V3 contracts. Market indexer remains the blocker for the final two tests.

4. **The Elastos NFT marketplace was built as a new PC2 app** — the existing `elacity-web` React SPA was ported to run inside PC2 as a static build targeting ESC (Chain 20), with auto-login via the PC2 wallet, proxy API to ela.city, and all DRM features stripped for a pure NFT-only experience.

5. **The Market app received a comprehensive UI/UX unification** — unified commerce zones, ownership filtering, publisher actions, earnings display, and a full transaction flow audit that identified specific P0/P1 issues.

6. **A new Elastos blockchain explorer** is being built — frontend demo created, backend for staker/voter rankings, governance for live Council members and Proposals, covering the full data surface (blocks, transactions, validators, staking, governance, rich list, mempool).

7. **New RPC infrastructure** — `rpc.elastos.info/ela` is up and running, council node benchmarks revealed servers are overkill (potential monthly cost reduction from ~$115 to $45-60).

---

## ElastOS Runtime — Room Architecture & v0.1.2 Prep

**Why this matters:** The Runtime is the execution engine that makes software unable to betray its users. This week's work focused on making the architecture clearer and more honest before the public v0.1.2 release.

### Room as an ElastOS Feature
The previously scattered "wci-exec-room" concept was rebuilt into a first-class ElastOS feature: **one Room Service in the runtime**, with browser, PC2, CLI, and operator all acting as surfaces over it. This architectural clarity means:
- The browser isn't a special case — it's just another surface
- PC2 isn't a special case — it's just another surface
- The Room is the feature; the surfaces are interchangeable

### Carrier-Backed Room Sync
Carrier-backed room synchronization was implemented and **tested live across runtimes**:
- Join request → approval → successful message send → live sync verified
- Status wording verified in real browser flow

### Public Naming Cleanup
- `wci-exec-room` → `room`
- `wci-exec-room-ui` → `room-ui`
- Browser/runtime boundary cleaned up: generic browser hosting separated from Room-specific logic

### Release Preparation
- Public node control, operator control, and PC2/frontdoor flows expanded
- Install, publish, and release proofing expanded for public release
- **Public release branch reorganized into a smaller, more coherent 7-commit stack**
- Newer unpublished reliability pass includes fixes to room approval reliability, stale runtime/operator handling, installer cleanup, and clearer room sync status wording
- **Blocker:** pc2-smoke signer mismatch still failing verification — being resolved before v0.1.2 tag

---

## DRM Protocol v3 — Smart Contract & System Integration

**Why this matters:** Protocol v3 is the next generation of Elacity's dDRM smart contracts, with improved event handling, protocol-managed fees, and a cleaner integration surface.

### Smart Contract Changes
- Additional changes to facilitate events handling
- Deployed on **both testnet and Base mainnet**

### System Integration
- Adjusted common, API, and contracts SDK → **new release (0.3.2 group)**
- Frontend integration — pending

### Reliable Sync Process
- Fixed scope of events publication → PR awaiting approval in moleculer-go
- Implemented all events handler (delegate method) → **90% complete**

### Focus Next Week
- Protocol v3 wrap-up & follow-up
- Lit Protocol v3 integration
- Review pc2.net and WASM runtime + research replacement of Lit as part of supernode

---

## V3 E2E Testing — Creator App, Wallet Bridge & Full Stack

**Why this matters:** Migrating smart contracts is meaningless if the apps that use them don't work. This week we systematically tested every transaction flow against V3 contracts.

### Creator Dashboard V3 Updates
- V3 ABIs for ChannelFactory, AssetFactory, CentralStorage
- V3-only channel discovery via on-chain `ChannelCreated` event scan (replaced V2 backend GraphQL)
- Parallelized RPC calls with localStorage caching (30min TTL)
- `bytes16` contentId encoding in `opRawData` for free mints
- Removed manual Elacity royalty — V3 `protocolShares` handles 5% automatically
- Retry loop for cancelled MetaMask transactions
- Draft resume preserves `wallet_choice`

### Wallet Bridge Hardening
- Added Base chain (8453) to `CHAIN_RPC_URLS` and `CHAIN_META`
- Fixed `prefillGasForTx` to use `tx.chainId`/`walletChainId` (not `bridgeChainId`)
- Populate `tx.from` from `window.user.wallet_address` when missing
- `ensureCorrectAccount()` auto-prompts MetaMask account picker on mismatch

### V3 Bug Fixes
- **RoyaltyCapExceeded revert** — Removed manual 5% royalty push; V3 protocol handles it via `protocolShares`
- **Free mint opRawData** — V3 `AssetFactory._extractContentId` requires ≥32 bytes even for opType=0; now encodes bytes16 contentId
- **Stale V2 channels** — Replaced backend GraphQL with on-chain V3 event scanning

### E2E Test Results

| Test | Status |
|------|--------|
| 1. Provision (Lit Chipotle) | **PASS** |
| 2. Channel Creation (V3) | **PASS** |
| 3. Free Mint (V3) | **PASS** |
| 4. Paid Mint (V3) | **PASS** |
| 5. dDRM Decrypt (V3 Authority) | **PASS** |
| 6. Market (V3 Indexed Assets) | **BLOCKED** — centralized indexer shows 0 V3 assets |
| 7. Content Indexer V3 Config | **BLOCKED** — depends on #6 |

**Score: 5/7 E2E tests passed.** Market indexer is the remaining blocker.

**Commits:** `f00cc081`, `e5d8eafc`, `fa573f78`

---

## V3 Contract Migration — Zero V2 Addresses Remain

**Why this matters:** A half-migrated stack is worse than no migration — different components talking to different contract versions causes silent failures. This week we completed a full-stack migration.

### Scope of Migration
| Layer | Changes |
|-------|---------|
| **Central Config** (`sdk/config.ts`) | V3 addresses: CentralStorage, AuthorityGateway, ChannelFactory, RoyaltyTradeGateway, AssetFactory, EventHub, SubscriptionManager |
| **Server** (`storage.ts`, `chipotle-client.ts`, `dashPackager.ts`) | V3 authority address |
| **Creator App** | V3 ABIs, V3 event field names, `operative()` method signature |
| **Market App** | V3 AuthorityGateway and RoyaltyTradeGateway |
| **Access SDK** (`packages/access`) | V3 ABIs, V3 addresses, Lit network `datil→chipotle`, `subscribePlan` signature update, browser bundle rebuilt |
| **Content Indexer** | V3 event topic hashes, EventHub as source, V3 config block |
| **Deploy Infrastructure** | V3 authority on both supernodes (InterServer + Contabo), `ddrm-config.json.template` updated |

**Result:** V3 contracts deployed on Base at block ~43892300. **Zero V2 addresses remain in runtime code.**

**Commit:** `26766402`

---

## Elastos NFT Marketplace — New PC2 App

**Why this matters:** Elastos users with NFTs on the Elastos Smart Chain (ESC, Chain 20) had no way to view, buy, sell, or manage their NFTs from within PC2. This week we built a dedicated app that brings the ESC NFT marketplace directly into the personal cloud computer.

### What Was Built
The existing `elacity-web` React SPA (from the `develop` branch — the ESC NFT marketplace version) was ported to run inside PC2:

- **Static build** — Vite-built React/MUI/RTK app served from `data/test-apps/elastos-nft/`
- **ESC-only** — `REACT_APP_CHAIN_ID=20`, all Base/DRM features stripped
- **Auto-login** — Seamless integration with the PC2 EOA wallet via `pc2-wallet-provider.js`, no separate login required
- **API proxy** — PC2 node proxies GraphQL/REST requests to `ela.city/api/` for ESC NFT data

### DRM Stripping & UI Cleanup
Since this is a pure NFT marketplace (no dDRM content), extensive build-time patching was applied:
- Removed `FayeProvider` (real-time notifications — crashes with relative URLs in iframe)
- Removed server version check (prevents stale version banner)
- Removed "Create" button from header
- Removed "Messages" and "Subscriptions" from sidebar
- Removed "Cinema" section from sidebar configs
- Removed "Channels" and "Revenue" tabs from Directory page (defaults to Collections)
- Removed "Audio" and "Video" from Library (only Images)
- Removed "Audio", "Video", "All" from Explore content types (only Image)
- Removed "All" and "Revenue" toggles from Explore horizontal filter
- Made Explore the default landing page (replaced Home)
- Library defaults to card view with `categories: ['image']`

### Technical Challenges Solved
- **Asset paths in iframe** — `baseURL()` patched to use relative paths for `/static/` and `/fonts/`
- **URL-encoded filenames** — `decodeURIComponent()` added to static file server for files with spaces
- **Chain switch** — Injected script auto-switches wallet to ESC (`0x14`)
- **Welcome modal bypass** — `localStorage` keys set to skip onboarding

### Infrastructure
- `app.json` manifest for PC2 app registry
- Build script: `scripts/build-elastos-nft.sh` — automated, reproducible build pipeline
- ESC NFT API proxy routes in `pc2-node/src/api/index.ts`

---

## Market UI/UX Unification & Transaction Audit

**Why this matters:** The Elacity Market app's UI had accumulated inconsistencies — price display varied, ownership wasn't always clear, publisher actions were scattered. More critically, a systematic transaction flow audit revealed specific issues that could cause failed transactions for Smart Account users.

### UI/UX Improvements

| # | Change |
|---|--------|
| 1 | **Commerce zone unified** — Price always visible; owner sees "Owned" badge next to price |
| 2 | **Library ownership filter** — New `/api/catalog/owned/:address` endpoint |
| 3 | **Publisher owner actions** — Edit Price, Delist, Earnings strip on detail page |
| 4 | **Shared `renderAvatar()`** — Extracted helper across all views |
| 5 | **Earnings offers** — Resolved names from GraphQL `metadata.name` |
| 6 | **formatPrice** — Zero shows "$0.00", small values use fixed decimals |
| 7 | **Nav badge alignment** — Vertically centered |
| 8 | **Pinned badge** — CSS dot icon instead of emoji |
| 9 | **Resale modal** — Shows "USDC" instead of "/ea" |
| 10 | **New `/api/catalog/operative/:address`** lookup endpoint |

### Transaction Flow Audit
A comprehensive audit of all transaction functions in `wallet.js` was conducted:

- **14 transaction functions** analyzed for EOA, Smart Account batch, and Particle/Email support
- **P0 Issues Found:**
  - `cancelListing` and `delistAccess` lack SA batch path (SA users can't cancel/delist)
  - `acceptOffer` and `cancelOffer` missing `fromWallet` parameter
- **P1 Issues Found:**
  - Publisher delist missing `quantity` argument
  - No feedback for expired offers
  - Missing loading state during wallet popup

Full audit documented in `.cursor/tasks/MARKET-FEATURES/MARKET-UI-AUDIT-APRIL-2026.md`

**Commit:** `59ef4542`

---

## Blockchain Explorer — New Frontend & Backend

**Why this matters:** Elastos has lacked a modern, comprehensive blockchain explorer. The community needs accessible tools to view blocks, transactions, validators, staking positions, and governance — without relying on third-party services.

### What Was Built This Week
- **Demo frontend** for the main chain explorer
- **Main chain staker/voter rank backend** — ranking system for stakers and voters
- **Governance integration** — Live Council member list and active Proposals
- **Full data surface coverage:**
  - Blocks, transactions, validators
  - Staking positions and rankings
  - Governance (Council members, proposals)
  - Rich list, mempool
  - Charted daily metrics from `daily_stats`
- **PostgreSQL model** backing all explorer data

### Scope Assessment
> "The explorer work so far covers the full data surface users see in tables — blocks, transactions, validators, staking, governance, rich list, mempool — plus charted daily metrics from daily_stats, all backed by a concrete PostgreSQL model. In traditional terms, that's often hundreds of professional hours and a five- to six-figure build."

---

## Infrastructure & Operations

### New RPC Backend
- **`rpc.elastos.info/ela`** is up and running — new public RPC endpoint for the Elastos main chain
- [RPC documentation](https://docs.google.com/document/d/1zc6X8Zm7ZtbveZArWtycN21a49yqZQzkyaui_BvsGXI/edit?usp=sharing)

### Council Node Cost Optimization
- **Benchmarks from ElacityLabs supernode monitor** revealed current council node server requirements are significantly overkill
- **Potential monthly cost reduction:** from average ~$115 to $45-60 USD per month
- This will help make running council nodes more accessible to the community

### Supernode Status
- Lit Chipotle deployed to both supernodes (InterServer + Contabo)
- ESC full nodes fully synced on both supernodes (block 36,095,676)
- Both provision endpoints verified externally

### macOS Notarization -- COMPLETE (Confirmed Apr 16)
- All 6 Apple notarization submissions **Accepted** (Apr 5-6 submissions all cleared)
- v1.2.2 DMG notarized + ticket stapled locally
- Gatekeeper confirms: `source=Notarized Developer ID, origin=Developer ID Application: Elacity LLC (LA64G2ZMY2)`
- **Users can now double-click the .dmg to install -- no Terminal, no `xattr -cr` needed**
- GitHub release v1.2.2 includes DMG, ZIP, AppImage, .deb, and Windows .exe
- Apple keychain profile `notary-elacity` stored for future automated submissions

---

## Ecosystem & Community

### Content & Communications
- **Elacity Labs statement** blog produced and published (+ banner by Nang)
- **ElastOS weekly news** posted and shared
- **KuMining AMA** held on April 9th
- **Easter holiday banner** created by Nang
- **ElastOS weekly update banner** created by Nang
- **Elastos Continuity Plan** created
- **EF balance monitor bot** developed and optimized for community (Telegram)

### Community Support
- Community support regarding concerns — addressed with positivity and truth
- Formal request of community asset return from EF made

### Partnerships & Outreach
- KuMining AMA completed
- Introduced to a media partner for BTC Vegas interviews
- 3 small creators in Elastos ambassadors briefed with next goals and updates

---

## What's Next

### Immediate (This Coming Week)
1. **Runtime v0.1.2 release** — resolve pc2-smoke signer mismatch, tag and publish
2. **Protocol v3 wrap-up** — complete events handler, wire EventHub to backend
3. **Lit Protocol v3 integration** — evaluate and implement
4. **Market P0 fixes** — SA batch paths for cancel/delist, offer accept/cancel wallet params
5. **Elastos NFT app polish** — test all marketplace features (buy, sell, list, delist, auction)

### Short-term (Next 1-2 Weeks)
6. **Explorer deployment** — public-facing blockchain explorer
7. **V3 frontend integration** — complete SDK integration with marketplace UI
8. **macOS DMG resubmission** — APFS format, track notarization
9. **Research Lit replacement** — evaluate as part of supernode architecture

### Medium-term (This Month)
10. **Content indexer V3** — unblock final 2/7 E2E tests
11. **Explorer hardening** — UX, frontend polish, deployment and operations
12. **NFT IPFS pin & seed** — local download of purchased NFTs to personal node

---

## Summary Statistics

### ElastOS Runtime
| Metric | Value |
|--------|-------|
| Room architecture | Rebuilt as first-class ElastOS feature |
| Carrier sync | Live-tested across runtimes |
| Public branch | Reorganized to 7-commit stack |
| Release target | v0.1.2 (pending signer fix) |
| Reliability pass | Room approval, stale handling, installer cleanup |

### PC2 Engineering
| Metric | Value |
|--------|-------|
| Commits (this week) | 8 |
| V3 E2E tests passing | 5/7 |
| Contract migration | Complete — zero V2 addresses remain |
| New PC2 app | Elastos NFT marketplace |
| Market UI improvements | 13 fixes/enhancements |
| Transaction functions audited | 14 |
| P0 issues identified | 4 |
| New API endpoints | 2 (`/catalog/owned/:address`, `/catalog/operative/:address`) |

### DRM Protocol v3
| Metric | Value |
|--------|-------|
| Smart contract changes | Events handling improvements, deployed testnet + Base |
| SDK releases | 0.3.2 group (common, API, contracts) |
| Events handler | 90% complete |
| PR pending | moleculer-go events scope fix |

### Blockchain Explorer
| Metric | Value |
|--------|-------|
| Data coverage | Blocks, transactions, validators, staking, governance, rich list, mempool |
| Backend | PostgreSQL model with daily_stats charts |
| Frontend | Demo created |
| Features | Staker/voter rankings, Council members, Proposals |

### Infrastructure
| Metric | Value |
|--------|-------|
| New RPC endpoint | `rpc.elastos.info/ela` |
| Council node cost reduction | ~$115 → $45-60/month |
| Supernode status | Both live with Lit Chipotle + ESC sync |

### Ecosystem
| Metric | Value |
|--------|-------|
| Content published | Elacity Labs statement, ElastOS weekly, KuMining AMA |
| Banners created | 3 (Labs statement, Easter, weekly update) |
| Community tools | EF balance monitor bot (Telegram) |
| Partnerships | BTC Vegas media partner introduction |

---

*This update covers all work from April 4 – April 10, 2026 across the ElastOS Runtime (v0.1.2 prep), the PC2 `feature/lit-chipotle-migration` branch, DRM Protocol v3 development, blockchain explorer, infrastructure operations, and community engagement. Runtime updates from Anders. Infinity team operations included.*
