# Market App — Comprehensive Audit & Status Report

**Date**: 2026-04-09
**Branch**: `feature/lit-chipotle-migration`
**Status**: InProgress — UI/UX unification complete, transaction flow issues identified

---

## 1. Work Completed (This Session)

### UI/UX Unification (Plan: `elacity_market_ui_unification`)

| # | Change | Files |
|---|--------|-------|
| 1 | **Commerce zone unified** — Price always visible; owner sees "Owned" badge next to price instead of replacing it | `app.js`, `index.html`, `styles.css` |
| 2 | **Library ownership filter** — New `/api/catalog/owned/:address` endpoint; library shows only actually-owned assets | `database.ts`, `api/index.ts`, `api.js` |
| 3 | **Publisher owner actions** — "Edit Price", "Delist", "Earnings" strip on detail page for asset publishers | `app-features.js`, `styles.css` |
| 4 | **Earnings consistency** — `getImageUrl()` for thumbnails, `formatPrice()` for monetary values | `app.js` |
| 5 | **Shared `renderAvatar()`** — Extracted helper used in cards, channel directory, detail page, channel cards | `app.js` |
| 6 | **Channel owner audit** — Verified `isChannelCreator` handles both EOA and Smart Account | `app-features.js` |
| 7 | **Visual consistency** — Hover shadows on earnings items and directory cards | `styles.css` |
| 8 | **Pinned badge** — Replaced emoji with CSS dot icon | `app.js`, `styles.css` |

### Bug Fixes (This Session)

| # | Fix | Files |
|---|-----|-------|
| 9 | **Resale modal "/ea"** → shows "USDC" as payment token | `app-features.js` |
| 10 | **Earnings badge alignment** — Vertically centered with `top:50%; transform:translateY(-50%)` | `styles.css` |
| 11 | **Offer names "Unknown"** — Now reads `metadata.name` from GraphQL (was reading null `token.name`) | `app-features.js` |
| 12 | **formatPrice "$0.00"** — Zero amounts show "$0.00" not "0.00e+0 ETH"; small prices use fixed decimals not scientific notation | `app.js` |
| 13 | **Orphan `});` syntax error** — Removed stale closure from refactored `renderOffersList`, which broke entire `app-features.js` module | `app-features.js` |

### Infrastructure Added

| # | Addition | Files |
|---|----------|-------|
| 14 | **`/api/catalog/operative/:address`** — Lookup catalog items by operative contract address | `database.ts`, `api/index.ts` |

---

## 2. Transaction Flow Audit

### All Transaction Functions in `wallet.js`

| Function | Purpose | EOA | SA Batch | Particle/Email |
|----------|---------|-----|----------|----------------|
| `buyAccess` | Buy access token (AuthorityGateway) | Yes | Yes (batch approve+buy) | Via injected provider |
| `buyAccessWithEOA` | Force EOA buy path | Yes | N/A | Via injected provider |
| `resellAccessToken` | List access for resale (AuthorityGateway) | Yes | Yes (batch approval+sell) | Via injected provider |
| `cancelAccessListing` | Cancel access listing (AuthorityGateway) | Yes | **NO — EOA only** | Via injected provider |
| `listRoyaltyShares` | List royalty shares (TradeGateway) | Yes | Yes (batch approval+sell) | Via injected provider |
| `buyRoyaltyShares` | Buy royalty shares (TradeGateway) | Yes | Yes (batch approve+buy) | Via injected provider |
| `cancelRoyaltyListing` | Cancel royalty listing (TradeGateway) | Yes | **NO — EOA only** | Via injected provider |
| `transferRoyaltyShares` | Transfer royalty shares | Yes | Yes (fromWallet) | Via injected provider |
| `withdrawRewards` | Withdraw royalty rewards | Yes | Yes (fromWallet) | Via injected provider |
| `batchWithdrawRewards` | Batch withdraw from multiple contracts | Yes | Yes (fromWallet) | Via injected provider |
| `createRoyaltyOffer` | Place buy offer (TradeGateway) | Yes | Yes (batch approve+offer) | Via injected provider |
| `acceptRoyaltyOffer` | Accept offer (TradeGateway) | Yes | Yes (fromWallet) | Via injected provider |
| `cancelRoyaltyOffer` | Cancel own offer (TradeGateway) | Yes | Yes (fromWallet) | Via injected provider |
| `transferNFT` | Transfer ERC-721/1155 | Yes | **NO — EOA only** | Via injected provider |
| `siweLogin` | SIWE authentication | EOA signs | N/A | EOA signs |

### How `app-features.js` Calls These Functions

| Feature UI | Wallet Function | Passes `fromWallet`/SA? | Issues |
|------------|-----------------|-------------------------|--------|
| Earnings withdraw | `withdrawRewards` / `batchWithdrawRewards` | Yes (`data-wallet`) | OK |
| List royalty shares | `listRoyaltyShares` | Yes (`walletKey`) | OK |
| Transfer shares | `transferRoyaltyShares` | Yes (`walletKey`) | OK |
| Resell access | `resellAccessToken` | Yes (wallet dropdown) | OK |
| Buy access (vendors) | `buyAccess` | N/A (core logic) | OK |
| Make offer | `createRoyaltyOffer` | No extra selector | OK (wallet.js handles) |
| **Cancel offer** | `cancelRoyaltyOffer` | **NO — missing `fromWallet`** | **BUG: SA users can't cancel** |
| **Accept offer** | `acceptRoyaltyOffer` | **NO — missing `fromWallet`** | **BUG: SA users can't accept** |
| **Publisher delist** | `cancelAccessListing` | N/A | **BUG: missing `quantity` arg** |
| Cancel royalty listing | `cancelRoyaltyListing` | N/A | **BUG: EOA only in wallet.js** |
| Cancel access listing | `cancelAccessListing` | N/A | **BUG: EOA only in wallet.js** |

---

## 3. Critical Issues Found

### P0 — Will Cause Errors

1. **Publisher delist missing `quantity` argument**
   - `renderAssetOwnerActions` calls `Wallet.cancelAccessListing(operativeAddr, tokenId)` with 2 args
   - `wallet.js` expects 3 args: `(operativeAddr, tokenId, quantity)` and uses `ethers.getBigInt(quantity)`
   - **Will throw** or encode wrong calldata
   - **Fix**: Pass listing quantity as 3rd arg

### P1 — Wrong Wallet Identity

2. **Cancel listing functions never use SA batch**
   - `cancelAccessListing` and `cancelRoyaltyListing` always use `parentSendTransaction` (EOA as `msg.sender`)
   - If user listed via SA batch, the listing was created by SA as `msg.sender`
   - `withdrawListing` requires the **same** `msg.sender` that created the listing
   - **Impact**: SA users who listed tokens cannot cancel those listings
   - **Fix**: Add SA batch path to both cancel functions, with `fromWallet` parameter

3. **Offer accept/cancel missing `fromWallet` in UI**
   - `cancelRoyaltyOffer(addr)` — omits 2nd param `fromWallet` → always EOA
   - `acceptRoyaltyOffer(from, addr, qty)` — omits 4th param `fromWallet` → always EOA
   - **Impact**: SA users who created offers via SA can't cancel them; SA users can't accept
   - **Fix**: Add wallet selector or auto-detect based on offer source

4. **`transferNFT` is EOA-only**
   - Always uses `fromAddr = connectedAddress` (EOA)
   - SA-held NFTs cannot be transferred
   - **Impact**: Low (NFT transfer is channel-level only, not common)
   - **Fix**: Add SA batch path with `fromWallet` parameter

### P2 — Edge Cases

5. **`buyAccess` EOA fallback approval owner ambiguity**
   - When `resolveSmartAccount()` returns null but `smartAccountAddress` is still set, `approveIfNeeded` may check wrong owner
   - **Impact**: Rare edge case
   - **Fix**: Clear SA override in EOA fallback

6. **`expectTokens` assumes USDC 6 decimals**
   - SA batch `expectTokens` hardcodes 6 decimals
   - **Impact**: Wrong if payment token is not USDC (currently all are USDC on Base)
   - **Fix**: Derive decimals from `payToken` address

---

## 4. Comparison with Creator App Patterns

| Concern | Creator App | Market App | Match? |
|---------|-------------|------------|--------|
| EOA address | `state.walletAddress` | `connectedAddress` | Yes |
| SA address | URL `puter.smart_account` | Same + IPC + provider | Yes |
| Embedded tx | IPC `walletSendTransaction` | Same | Yes |
| SA batch | IPC `walletExecuteSmartAccountBatch` | Same | Yes |
| Receipt handling | Base RPC + provider fallback (for AA hashes) | Same | Yes |
| SA confirmation | Log/event polling when hash unreliable | **NOT used** (relies on hash) | **Gap** |
| Wallet choice modal | `showWalletChoice()` when `hasSmartAccount()` | Per-action wallet dropdowns | Different but OK |
| Auth login | EOA signs, includes `sa` param | Same | Yes |
| Approval pattern | `setApprovalForAll` on operative for gateway | Same | Yes |

---

## 5. Files Modified (All Changes on Branch)

### Backend (`pc2-node/src/`)
- `api/index.ts` — New catalog/earnings/graphql-proxy endpoints
- `storage/database.ts` — Catalog model, channel metadata, operative lookup
- `storage/migrations.ts` — Migrations 24-26
- `storage/schema.sql` — TEXT token_id
- `services/ContentIndexerService.ts` — AssetCreated scanning, hex token IDs
- `services/wasm/WASMRuntime.ts` — Multicall return type

### Frontend Market (`pc2-node/data/test-apps/elacity-market/`)
- `app.js` — renderDetail, renderCard, renderAvatar, formatPrice, earnings, IPFS
- `app-features.js` — Earnings badge, offers, publisher actions, royalty UI
- `api.js` — Local catalog, GraphQL proxy, owned items
- `wallet.js` — Base chain switch, SIWE, buyAccess AA hash, resell flows
- `styles.css` — Full layout/styling update
- `index.html` — Commerce restructure, skeleton loading, breadcrumbs

### Other
- `pc2-node/config/default.json` — Scan interval 30→5 min
- `pc2-node/crates/evm-multicall/` — WASM toolkit extensions
- `pc2-node/frontend/pc2-wallet-bridge.js` — Chain switch handling
- `src/gui/src/services/WalletService.js` — External MetaMask + SA batch
- `packages/particle-auth/` — expectTokens fix

---

## 6. Plan — Remaining Work

### Phase A: Fix Critical Transaction Bugs (P0+P1)

- [ ] **A1**: Fix publisher delist — pass quantity to `cancelAccessListing`
- [ ] **A2**: Add SA batch path to `cancelAccessListing` (wallet.js)
- [ ] **A3**: Add SA batch path to `cancelRoyaltyListing` (wallet.js)
- [ ] **A4**: Pass `fromWallet` to `cancelRoyaltyOffer` in offers tab UI
- [ ] **A5**: Pass `fromWallet` to `acceptRoyaltyOffer` in offers tab UI
- [ ] **A6**: Add SA batch path to `transferNFT` (wallet.js) — lower priority

### Phase B: Testing Matrix

| Scenario | EOA | SA (Agent) | Particle (Email) |
|----------|-----|------------|-------------------|
| Connect wallet | | | |
| Browse feed | | | |
| View asset detail | | | |
| Buy access (native) | | | |
| Buy access (USDC) | | | |
| Resell access token | | | |
| Cancel access listing | | | |
| List royalty shares | | | |
| Cancel royalty listing | | | |
| Buy royalty shares | | | |
| Transfer royalty shares | | | |
| Create royalty offer | | | |
| Cancel royalty offer | | | |
| Accept royalty offer | | | |
| Withdraw rewards | | | |
| Batch withdraw | | | |
| View earnings | | | |
| View offers tab | | | |
| Channel subscribe | | | |
| Library view | | | |

### Phase C: Polish & UX

- [ ] **C1**: Offer tab — show content thumbnail from `metadata.image`
- [ ] **C2**: Offer quantity → display as percentage (÷10) since 10 raw = 1%
- [ ] **C3**: SA confirmation — add log polling fallback for unreliable AA hashes
- [ ] **C4**: Remove console.log noise from production paths

---

## 7. Branch Status

- **Branch**: `feature/lit-chipotle-migration`
- **207 files changed** (includes prior work on this branch)
- **Not yet committed**: All changes from this session are in working tree
- **Next**: Commit + push to GitHub
