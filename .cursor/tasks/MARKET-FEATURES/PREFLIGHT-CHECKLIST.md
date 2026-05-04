# Market Implementation Pre-Flight Checklist

**Related Task**: MARKET-FEATURES
**Source**: Elacity Agent feedback + Complete Contract Reference (2026-03-13)
**Status**: Resolved — all items addressed

---

## Critical Architecture Corrections Applied

1. **Access token resale uses AuthorityGateway.sellAccess()** — NOT TradeGateway.sellToken()
2. **Royalty share trading uses TradeGateway** — sellToken/buyToken/withdrawListing for tokenId=2
3. **No Marketplace or Auction contracts on Base** — old plan items 4-7 removed
4. **Access tokens cannot be directly transferred** — only move through buy/sell flows
5. **opType check required** — resell only enabled when operative.opType === 2

## Contract Address Reference (Base 8453)

| Contract | Address | Used For |
|----------|---------|----------|
| AuthorityGateway | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` | Buy/sell access tokens |
| TradeGateway | `0x9eC53758b698f9F68C0654DDd9159173a159a459` | Trade royalty shares |
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` | Central registry |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` | Channel factory |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment token (6 decimals) |

## ABI Fragments Implemented in wallet.js

### AuthorityGateway
```javascript
'function sellAccess(address ledger, uint256 tokenId, uint256 quantity, uint256 pricePerToken, address payToken)'
'function withdrawListing(address operative, uint256 tokenId, uint256 quantity)'
'function sellersOf(address operative, uint256 tokenId) view returns (address[])'
'function listings(address operative, uint256 tokenId, address seller) view returns (uint256, uint256, address)'
'function hasAccess(address accessor, address ledger, uint256 tokenId) view returns (bool)'
```

### TradeGateway
```javascript
'function sellToken(address operative, uint256 tokenId, uint256 quantity, uint256 pricePerToken, address payToken)'
'function buyToken(address seller, address operative, uint256 tokenId, uint256 quantity) payable'
'function withdrawListing(address operative, uint256 tokenId, uint256 quantity)'
'function createOffer(address operative, uint256 tokenId, uint256 quantity, uint256 pricePerToken, address payToken)'
'function acceptOffer(address from, address operative, uint256 tokenId, uint256 quantity)'
'function cancelOffer(address operative, uint256 tokenId)'
```

### Operative (per-asset ERC1155)
```javascript
'function OP_TYPE() view returns (uint16)'
'function resellerCut() view returns (uint16)'
'function rewardsOf(address user, address payToken) view returns (uint256)'
'function hasTradeAccess(address account, uint256 tokenId) view returns (bool)'
'function withdrawRewards(address paymentToken)'
'function balanceOf(address account, uint256 id) view returns (uint256)'
'function setApprovalForAll(address operator, bool approved)'
'function isApprovedForAll(address account, address operator) view returns (bool)'
'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)'
```

## Approval Requirements

| Action | Approval Target | Method |
|--------|----------------|--------|
| Resell access token | AuthorityGateway | `operative.setApprovalForAll(AG, true)` |
| List royalty shares | TradeGateway | `operative.setApprovalForAll(TG, true)` |
| Buy access (ERC20) | PaymentProcessor | `erc20.approve(PP, amount)` |

## Error Handling Implemented

Contract errors are decoded to user-friendly messages:
- AvailabilityError → "Not enough copies available"
- InsufficientBalance → "Insufficient balance"
- NotApprovedError → "Please approve the contract first"
- NotAllowedError → "You don't have permission for this action"
- PriceFulfillmentError → "Incorrect payment amount"
- User rejection → silent dismiss (no error toast)

## Security Checklist (All Verified)

- [x] Validate addresses with `ethers.isAddress()`
- [x] Validate amounts are positive and within bounds (max 1,000,000 USDC)
- [x] Check approval before operations requiring it
- [x] Handle user rejection gracefully
- [x] opType check before resell (only opType === 2)
- [x] Access tokens blocked from direct transfer
- [x] Self-transfer blocked
