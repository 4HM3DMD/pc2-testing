# V3 Contract Migration — E2E Testing Status

> **Purpose:** Track end-to-end testing progress for the Elacity V3 contract migration (ElastOS v1.2 launch).
> **Created:** 2026-04-07
> **Last Updated:** 2026-04-07
> **Branch:** `feature/lit-chipotle-migration`
> **Test Environment:** Local PC2 node, MetaMask (EOA), Base Mainnet (chain 8453)

---

## V3 Contract Addresses

| Contract | Address | Deploy Block |
|----------|---------|-------------|
| ChannelFactory | `0xE1365ed47353De2F8A6a69E271e36650A9EE368F` | 43892000 |
| AuthorityGateway | `0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D` | — |
| CentralStorage | `0x0C1EeA2A3361B80AC0e42179335dB536A951760b` | — |
| RoyaltyTradeGateway | `0xd02451BCE627EF476B8ee52Cf131C426f67dbcB2` | — |
| EventHub | `0x5a694A6d988354dca491fe0F6db7a6ef46b656c2` | — |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | — |

---

## Test Results Summary

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Auto-provision (supernode → node) | ✅ PASS | Lit Chipotle credentials auto-provisioned from supernode on fresh startup |
| 2 | Create V3 channel | ✅ PASS | Channel `0x6756E140...` deployed via ChannelFactory, EOA owner `0x34DA...3Dc3` |
| 3 | Mint free asset | ✅ PASS | Image encrypted, uploaded to IPFS, minted on V3 channel, contentId bound in CentralStorage, WASM viewer playback confirmed |
| 4 | Mint paid asset (buy_and_resell) | ✅ PASS | Video transcoded, encrypted, minted with 0.01 USDC pricing, royalty distribution verified on-chain (95% creator, 5% protocol) |
| 5 | dDRM encrypt/decrypt (hasAccessByContentId) | ⏳ PENDING | Needs V3 AuthorityGateway address in Lit Action |
| 6 | Buy/sell on Market app | ⛔ BLOCKED | Elacity GraphQL indexer has not indexed V3 assets (returns `total: 0`). Market app frontend is V3-ready |
| 7 | Content indexer V3 events | ⏳ PENDING | ContentIndexerService needs V3 CentralStorage config added |

---

## Detailed Test Results

### Test 1: Auto-Provision (Supernode → Node)

**Date:** Apr 6, 2026
**Result:** PASS

- Deleted local Lit cache, restarted PC2 node
- Node contacted supernode at `/api/ddrm/provision`
- Received Chipotle API key, PKP ID, Lit Action CIDs
- Credentials written to local `data/` directory
- Encrypt/decrypt operations functional after provisioning

### Test 2: Create V3 Channel

**Date:** Apr 6, 2026
**Result:** PASS

- Used Creator Dashboard to create new channel via V3 ChannelFactory
- Channel address: `0x6756E1407164Ae34f8df5334d48D0e45C094B8b9`
- Owner: `0x34daf31b99b5a59ceb18e424dbc112fa6e5f3dc3` (EOA)
- ChannelFactory `ChannelCreated` event emitted correctly
- Channel visible in Creator Dashboard dropdown after on-chain scan

### Test 3: Mint Free Asset (Image)

**Date:** Apr 6, 2026
**Result:** PASS

- Uploaded test image through Creator Dashboard
- Two-layer encryption (AES-GCM + Lit Chipotle)
- IPFS upload: encrypted payload + metadata JSON
- Minted on V3 channel with `opType = 0` (free)
- `contentId` (bytes16) correctly encoded in `opRawData`
- CentralStorage log confirmed content binding
- WASM viewer rendered the decrypted image with watermark

**Bug fixed during test:** Free mints initially failed because V3 `AssetFactory` always calls `_extractContentId` from `opRawData`. Fixed by encoding `bytes16 contentId` into the raw data field.

### Test 4: Mint Paid Asset (Video, Buy & Resell)

**Date:** Apr 6, 2026
**Result:** PASS

- Uploaded video file, transcoded via PC2 node pipeline
- Minted with `opType = 2` (buy_and_resell), price 0.01 USDC
- MetaMask transaction signed successfully
- Video playback confirmed via dDRM viewer

**On-chain royalty verification (decoded from transaction logs):**

| Token | Recipient | Amount | Meaning |
|-------|-----------|--------|---------|
| ROYALTY_SHARE (ID 2) | `0x34DA...` (creator) | 950 | 95% royalty share |
| ROYALTY_SHARE (ID 2) | `0xdb0e...` (protocol) | 50 | 5% protocol share |
| ACCESS_TOKEN (ID 1) | `0x34DA...` (creator) | 1,000,000 | Copies for sale |
| DISTRIBUTION_RIGHT (ID 3) | `0x34DA...` (creator) | 1 | Distribution control |

**Confirmed:** V3 `protocolShares` automatically applies the 5% protocol fee at mint time — no manual royalty calculation needed in the Creator app.

### Test 5: dDRM Encrypt/Decrypt (hasAccessByContentId)

**Status:** PENDING

The Lit Action (`non-media-decrypt.js`) calls `hasAccessByContentId(buyerAddress, kid)` on the AuthorityGateway. The V3 AuthorityGateway address needs to be wired into the Lit Action or the decrypt endpoint.

### Test 6: Buy/Sell on Market App

**Status:** BLOCKED (Indexer dependency)

**Frontend audit (Apr 7, 2026):**
- Market app `wallet.js`: V3 AuthorityGateway (`0x09dBe...`), RoyaltyTradeGateway (`0xd024...`), Base chain — all correct
- Market app `app.js`: Buy flow uses `props.authority` from API (correct pattern)
- No V2 contract crossovers found anywhere
- `installed-apps/` and `test-apps/` are identical

**Backend blocker:**
- Elacity GraphQL API (`base.ela.city/api/2.0/graphql`) returns `total: 0` for both `ProtectedAsset` and `StandardAsset` queries
- `retrieveChannel` for V3 channel `0x6756E140...` returns `null`
- The 15 indexed channels are all V2 channels
- **Root cause:** Backend indexer has not been updated to scan V3 EventHub events

**Resolution path:** Either:
1. Backend team updates the Elacity indexer to process V3 EventHub events
2. ContentIndexerService (on-node, walk-away path) gets V3 config added for local discovery

### Test 7: Content Indexer V3 Events

**Status:** PENDING

The `ContentIndexerService` supports V3 via config-only swap:
```json
"contracts": {
  "v3": { "core_storage": "0x0C1EeA2A3361B80AC0e42179335dB536A951760b", "from_block": 43892000 }
}
```

However, V3 uses `EventHub` for aggregated events rather than emitting directly from `CentralStorage`. A parser update may be needed in `ContentIndexerService.scanDigitalAssetRegistered()` to listen to EventHub topics.

---

## Bugs Fixed During Testing

| Bug | Fix | Version |
|-----|-----|---------|
| Free mint `opRawData` missing contentId | Encode `bytes16 contentId` in raw data | app.js v3.0.4 |
| V2 channels showing in Creator dropdown | Removed GraphQL fallback, V3-only on-chain scan | app.js v3.0.7 |
| Stale channel cache from V2 | Changed cache key to `elacity_v3only_channels_` | app.js v3.0.8 |
| Cancelled MetaMask tx disables mint button | Added retry loop, button re-enables as "Retry Sign & Mint" | app.js v3.0.9 |
| Draft resume prompts wallet choice | Store `wallet_choice` in draft, auto-recognize on resume | app.js v3.1.0 |
| Empty `effectiveAddr` causes contract revert | Re-request accounts if `walletAddress` empty, validate before tx | app.js v3.1.1 |
| Wallet bridge missing Base chain (8453) | Added to `CHAIN_RPC_URLS` and `CHAIN_META` | bridge v2 |
| Gas estimation uses wrong chain ID | `prefillGasForTx` now uses `tx.chainId` or `walletChainId` | bridge v2 |
| Missing `tx.from` in bridge | Populate from `window.user.wallet_address` | bridge v2 |
| Wrong MetaMask account causes silent failure | Added `ensureCorrectAccount()` with `wallet_requestPermissions` prompt | bridge v2 |
| Manual Elacity royalty (5%) duplicated protocol fee | Removed — V3 `protocolShares` handles it automatically | app.js v3.1.1 |

---

## Walk-Away Test Relevance

The V3 testing revealed a critical dependency: the centralized Elacity GraphQL API is the **primary bottleneck** for Market app functionality. With 0 V3 assets indexed, the Market cannot discover or trade V3 content.

**The walk-away architecture addresses this:**

1. **ContentIndexerService** (Tier 1.1, COMPLETE for V2) — each PC2 node scans on-chain events and builds a local catalog. Adding V3 support is a config + small parser update.

2. **Supernode RPC acceleration** (Tier 2) — supernodes can serve as shared indexer nodes, reducing the Base RPC load for individual leaf nodes scanning large block ranges. This is especially relevant for V3 channel discovery, which currently takes ~15 seconds on first load due to block-range scanning.

3. **P2P content discovery** (Tier 1.1 extension) — nodes that have indexed V3 content can share their catalogs via DHT/gossip, reducing each node's need to independently scan the full block range.

**Recommendation:** Prioritize adding V3 config to ContentIndexerService to unblock local Market testing independent of the centralized API.

---

## Files Modified During V3 Testing

| File | Changes |
|------|---------|
| `pc2-node/data/test-apps/elacity-creator/app.js` | V3 ABIs, channel discovery, mint flow, retry UX, draft resume, royalty alignment |
| `pc2-node/data/test-apps/elacity-creator/index.html` | Cache-busting version bumps (v3.0.4 → v3.1.2) |
| `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` | Base chain config, gas estimation fix, account-switch UX |
| `pc2-node/frontend/pc2-wallet-bridge.js` | Copy of above for serving |
| `docs/core/DECENTRALIZATION_STATUS.md` | V3 contracts, protocol fee model, testing status |
| `docs/core/V3_E2E_TESTING_STATUS.md` | This document |

---

## Next Steps

1. **E2E Test 5 (dDRM):** Wire V3 AuthorityGateway into Lit Action decrypt path
2. **E2E Test 7 (Indexer):** Add V3 CentralStorage/EventHub config to ContentIndexerService
3. **E2E Test 6 (Market):** Unblocked once indexer (centralized or local) processes V3 events
4. **Launcher:** Follow up on Apple notarization status (UUIDs: DMG `2434db22`, ZIP `3f2d210a`)
5. **Content Indexer V3 config:** Add to `config/default.json` for walk-away path

---

## Related Documents

| Document | Path |
|----------|------|
| Decentralization Status | `docs/core/DECENTRALIZATION_STATUS.md` |
| Roadmap | `docs/core/ROADMAP.md` |
| Session Handover | `docs/core/SESSION_HANDOVER.md` |
| Supernode Economics | `docs/core/SUPERNODE_ECONOMICS.md` |
