# Task: Elacity Market Full Feature Coverage

**Task ID**: MARKET-FEATURES
**Created**: 2026-03-20
**Updated**: 2026-04-14
**Status**: InProgress
**Priority**: High

## Description

Audit and implementation plan to bring the Elacity Market dApp to full smart contract feature coverage on Base mainnet (chain 8453). The system uses AuthorityGateway for access tokens and TradeGateway for royalty shares — there is NO Marketplace or Auction contract on Base.

## Architecture (Base Mainnet)

```
AuthorityGateway ── buy/sell ACCESS TOKENS (tokenId=1)
TradeGateway ────── trade ROYALTY SHARES (tokenId=2)
Operative ──────── per-asset ERC1155 (access, royalty, distribution tokens)
Channel ────────── per-creator ERC1155 (subscriptions, minting)
```

**Key correction from audit**: The old plan incorrectly assumed Marketplace and Auction contracts existed on Base. They do not. All trading uses AuthorityGateway + TradeGateway.

## What's Implemented

### Core (Pre-existing)
- [x] Browse/Feed with content type tabs + presets (buyNow, popular, all)
- [x] Search with debounced text input and content type filter
- [x] Asset Detail View with metadata, attributes, price, ownership status
- [x] Purchase via `buyAccess()` on AuthorityGateway (SA batch + EOA)
- [x] Library/My Assets with dual-wallet (EOA + SA) merge and dedup
- [x] Channel Directory, subscriptions (`subscribePlan()`), follow
- [x] Download/Save (.ddrm capsule), Playback, Like, Watch Later
- [x] SIWE Authentication, Theme toggle

### Phase 1 — Access Token Resale (Completed)
- [x] **Resell Access Tokens** via `AuthorityGateway.sellAccess()` (NOT TradeGateway)
  - Approval against AuthorityGateway (not TradeGateway)
  - opType === 2 check before enabling resell
  - Both SA batch and EOA sequential paths
- [x] **Cancel Listing** via `AuthorityGateway.withdrawListing()`
- [x] **View Active Sellers** via `sellersOf()` + `listings()` on detail view
- [x] **Cancel own listings** inline from sellers list

### Phase 2 — Royalty & Governance (Completed)
- [x] **Royalty Info Display** — opType label, creator %, reseller cut %
- [x] **Resellable Badge** on cards (opType === 2)
- [x] **Royalty Share Balance** — shows token count and percentage
- [x] **List Royalty Shares** via `TradeGateway.sellToken(operative, 2, ...)`
- [x] **Transfer Royalty Shares** via `operative.safeTransferFrom(from, to, 2, amount, '0x')`
- [x] **Withdraw Royalty Rewards** via `operative.withdrawRewards(paymentToken)`
- [x] **Pending Rewards Display** via `rewardsOf()`

### Phase 3 — Safety & UX (Completed)
- [x] **NFT Transfer** restricted to channel-level ERC721 only (access tokens blocked)
- [x] **Contract Error Decoding** — maps AvailabilityError, InsufficientBalance, NotApprovedError, etc. to user-friendly messages
- [x] **User rejection handling** — silent dismiss on wallet rejection

## What's NOT on Base (Removed from Plan)

The following features were in the original plan but are NOT applicable on Base mainnet:

- ~~Fixed-Price Listing (Marketplace.listItem)~~ — No Marketplace contract on Base
- ~~Buy Listed NFT (Marketplace.buyItem)~~ — No Marketplace contract on Base
- ~~Make Offer (Marketplace.createOffer)~~ — No Marketplace contract on Base
- ~~Auctions (Auction.createAuction)~~ — No Auction contract on Base
- ~~Creator Royalty Config (Marketplace.registerRoyalty)~~ — Royalties are set at mint time, immutable
- ~~Aggregated Mint (MarketplaceAggregator)~~ — No Aggregator on Base

## Contract Addresses (Base Mainnet, chain 8453)

| Contract | Address |
|----------|---------|
| AuthorityGateway | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` |
| TradeGateway | `0x9eC53758b698f9F68C0654DDd9159173a159a459` |
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Token IDs

| Token | ID | Purpose |
|-------|----|---------|
| ACCESS_TOKEN | 1 | Grants right to view content |
| ROYALTY_SHARE | 2 | Grants right to revenue share (10 tokens = 1%) |
| DISTRIBUTION_RIGHT | 3 | Grants right to resell (opType=2 only) |

## Operative Types

| opType | Name | Access Token Resale | Distribution Rights |
|--------|------|--------------------|--------------------|
| 0 | Free | N/A | No |
| 1 | Buy Once | No | No |
| 2 | Buy & Resell | Yes | Yes |

### Phase 4 — Royalty Offers (Completed)
- [x] **Create Royalty Offer** via `TradeGateway.createOffer()` (SA batch + EOA)
- [x] **Accept Royalty Offer** via `TradeGateway.acceptOffer()`
- [x] **Cancel Royalty Offer** via `TradeGateway.cancelOffer()`
- [x] **Offers Tab in Earnings** with resolved asset names from `metadata`
- [x] **Batch Reward Withdrawal** via `operative.multicall()`

### Phase 5 — UI/UX Unification (Completed 2026-04-09)
- [x] **Commerce zone unified** — Price always visible, owner badge additive
- [x] **Library ownership filter** — Backend `/api/catalog/owned/:address`
- [x] **Publisher owner actions** — Edit Price, Delist, Earnings strip
- [x] **Shared `renderAvatar()`** — Consistent across all views
- [x] **Earnings consistency** — `formatPrice()` for zero/small amounts
- [x] **Offer token names** — Resolved from GraphQL `metadata.name`
- [x] **Badge alignment** — Vertically centered nav badges
- [x] **Pinned icon** — CSS dot instead of emoji

## Known Issues (Identified 2026-04-09)

See full audit: `.cursor/tasks/MARKET-FEATURES/MARKET-UI-AUDIT-APRIL-2026.md`

- **P0**: Publisher delist missing `quantity` argument
- **P1**: `cancelAccessListing` / `cancelRoyaltyListing` — EOA only, SA users can't cancel
- **P1**: Offer accept/cancel UI doesn't pass `fromWallet` for SA users
- **P2**: `transferNFT` is EOA-only
- **P2**: `expectTokens` hardcodes USDC 6 decimals

### Phase 6 — Elastos NFT Marketplace App (Completed 2026-04-09 → 2026-04-16)
- [x] **Build pipeline** — `scripts/build-elastos-nft.sh` clones `elacity-web` `develop` branch, patches for ESC (chain 20), builds Vite SPA
- [x] **Auto-login** — PC2 wallet injected via `pc2-wallet-bridge.js`; `ConnectorSelect` renders null; `active` = `!!(account)`
- [x] **UI stripping** — Removed Home tab, Messages, Subscriptions, Create button; Explore is default landing
- [x] **Content filtering** — API-level `contentType: ['image']` on Explore, Latest NFTs, Most Viewed, Recently Sold
- [x] **Collections** — Directory renamed to "Collections"; `contractType: 'Collection'` filter on New Collections
- [x] **Sidebar cleanup** — Only Explore, Collections, Library (Images tab), Revenue pages remain
- [x] **Tier 1 bundle cleanup** — Removed XMTP WASM, unused route chunks, marketing images; 45MB → 22MB
- [x] **Conservative chunk fix** — Restored chunks imported by shared contexts (CapsuleExplorer, ChannelViewContext, MediaRawContext, useAccessibility, wrongPasswordModal)
- [x] **Profile image fix** — Patched `account.ts` to recognize relative `/api/esc-nft/thumbnails/...` URLs (was wrapping them in broken ipfsLink)
- [x] **IPFS gateway fix** — Replaced dead gateways (`cloudflare-ipfs.com`, `ipfs.ela.city`) with `ipfs.io` in source + post-build sed
- [x] **Contabo ESC RPC** — Added `/api/esc-rpc` proxy to Contabo archive node (38.242.211.112), plus Contabo nginx `/rpc/esc` route
- [x] **RPC fallback** — `rpcs.ts` has both Contabo proxy and public `api.ela.city/esc` as fallback
- [ ] **Full verification** — End-to-end testing of all pages after cleanup (InProgress)

### Phase 7 — NFT IPFS Pinning (InProgress 2026-04-16)
- [x] **Database** — `nft_pins` table with migration 27, composite primary key `(cid, wallet_address)`, joins with `pinned_cids`
- [x] **API endpoints** — `POST /api/nft/pin`, `GET /api/nft/pins`, `GET /api/nft/pin/:cid`, `DELETE /api/nft/pin/:cid`
- [x] **Route mounting** — Storage router mounted at `/api` in addition to `/api/storage` for clean `/api/nft/*` paths
- [x] **ArtAssetView patch** — Pin + Download buttons below NFT image (visible to owners, extracts CID from metadata)
- [x] **MyVault patch** — PinnedCidsContext fetches user's pinned CIDs, green pin badge on pinned NFT cards
- [x] **Auth fix** — Frontend extracts `puter.auth.token` from URL params, passes via `Authorization: Bearer` header
- [ ] **Testing** — Verify pin/unpin flow end-to-end with real NFTs (blocked: some NFTs use HIVE not IPFS)
- [ ] **HIVE NFT support** — NFTs stored on HIVE (`hive://public.ela.city/...`) need tokenURI metadata fetch to extract IPFS CID
- [ ] **Local-first IPFS serving** — Route pinned NFT images through node's own `/ipfs/:cid` gateway before external fallback

## Future Considerations

- Subscription plan management (`bulkUpdatePlans`) for channel owners
- Token-gated access configuration (`configureTokenOwnershipAccess`)
- SA confirmation via log polling (match Creator app pattern)

## Pending Manual Test Matrix (V1.2 pre-release)

Added 2026-04-28 after Buy-button flow was verified end-to-end on a V3 asset
(mint → catalog surface → different-wallet open → Buy → download → playback).
The following sibling flows still need a hands-on pass from a second wallet
before v1.2 sign-off:

- [ ] **Resell Access Tokens** — `AuthorityGateway.sellAccess()` as a secondary
      owner (buy, then resell at different price, cancel, edit)
- [ ] **Offers** — create / accept / cancel offers via `TradeGateway` +
      `AuthorityGateway` (both access tokens and royalty shares)
- [ ] **Royalty Share trading** — `listRoyaltyShares`, `buyRoyaltyShares`,
      `cancelRoyaltyListing`, `transferRoyaltyShares`
- [ ] **Withdraw earnings** — `withdrawRewards` / `batchWithdrawRewards` for
      access sales, royalty rewards, and channel revenue
- [ ] **Channel subscriptions** — subscribe, unsubscribe, plan switch, and
      `getPlans()`-driven pricing (see Irzhy's 2026-04-28 guidance on
      `channel.tokenURI(tokenId)` for plan metadata)
- [ ] **Cancel listing** — `withdrawListing` as seller (now uses correct
      operative-internal tokenId = 1 after Buy-button fix)
- [ ] **Free asset access** — opType = 0 assets should grant access without
      price/Buy surface

Each row should be validated on (a) a different-wallet viewer, (b) the
original creator wallet, and (c) an SA-wrapped wallet. Log outcomes back into
this section as rows are cleared.

## Files Modified

### Elacity Market (Phase 1-5)
- `pc2-node/data/test-apps/elacity-market/wallet.js` — All contract interactions
- `pc2-node/data/test-apps/elacity-market/app.js` — UI logic, rendering, formatting, earnings
- `pc2-node/data/test-apps/elacity-market/app-features.js` — Earnings, offers, publisher actions, royalty UI
- `pc2-node/data/test-apps/elacity-market/api.js` — Local catalog, GraphQL proxy, owned items
- `pc2-node/data/test-apps/elacity-market/index.html` — Commerce, skeleton, breadcrumbs
- `pc2-node/data/test-apps/elacity-market/styles.css` — Full layout/styling

### Elastos NFT + Infrastructure (Phase 6-7)
- `scripts/build-elastos-nft.sh` — Elastos NFT app build pipeline (clone, patch, build, cleanup, NFT pin UI, IPFS gateway fix)
- `pc2-node/data/test-apps/elastos-nft-src/.env.production` — ESC chain config, IPFS gateway (`ipfs.io`)
- `pc2-node/src/api/index.ts` — Catalog/earnings/graphql-proxy endpoints, ESC RPC proxy (`/api/esc-rpc`), storage router dual-mount
- `pc2-node/src/api/storage.ts` — NFT pin CRUD endpoints (`/nft/pin`, `/nft/pins`, `/nft/pin/:cid`)
- `pc2-node/src/storage/database.ts` — Catalog model, channel metadata, operative lookup, NFT pin tracking methods
- `pc2-node/src/storage/migrations.ts` — Migrations 24-27 (27 = `nft_pins` table)
- `pc2-node/src/storage/schema.sql` — Added `nft_pins` table + indexes
- `pc2-node/src/static.ts` — Refactored asset resolver for `/images/*`, `/static/*`, `/fonts/*` from embedded dApps
