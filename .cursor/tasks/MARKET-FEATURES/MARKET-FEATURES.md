# Task: Elacity Market Full Feature Coverage

**Task ID**: MARKET-FEATURES
**Created**: 2026-03-20
**Updated**: 2026-03-13
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

## Future Considerations

- Subscription plan management (`bulkUpdatePlans`) for channel owners
- Token-gated access configuration (`configureTokenOwnershipAccess`)
- Royalty share offers via TradeGateway (`createOffer`, `acceptOffer`, `cancelOffer`)
- Batch reward withdrawal via `multicall()`

## Files Modified

- `pc2-node/data/test-apps/elacity-market/wallet.js` — All contract interactions
- `pc2-node/data/test-apps/elacity-market/app.js` — UI logic, modals, handlers
- `pc2-node/data/test-apps/elacity-market/index.html` — Modal HTML, governance section
- `pc2-node/data/test-apps/elacity-market/styles.css` — Styling for new features
- `pc2-node/data/test-apps/elacity-market/api.js` — GraphQL query (royalty field)
