# Task: Elacity Platform-Side Items for Sovereign Publishing

**Task ID**: ELACITY-PLATFORM-ITEMS
**Created**: 2026-03-23
**Status**: Proposed
**Priority**: High

## Description

Items that require changes or clarification on the **Elacity platform side** (backend, GraphQL, IPFS infrastructure, indexer) to fully support sovereign cloud publishing from PC2 nodes.

These are NOT PC2-side changes — they are requests/fixes for the Elacity team.

## Background

During Creator Dashboard development, we discovered that sovereign-minted assets (published from a user's PC2 node) have friction integrating with Elacity's marketplace infrastructure. The core issue is that the publishing pipeline was designed for Elacity's own backend to control the full lifecycle. Sovereign minters bypass that flow.

## Items

### 1. CIDv1 Support in On-Chain Indexer
**Priority**: High
**Status**: Workaround in place — sovereign minting works today

**Problem**: Elacity's on-chain indexer resolves `tokenURI` metadata via `ipfs.ela.city` gateway. This gateway (go-ipfs) can resolve CIDv0 (`Qm...`) natively but struggles with CIDv1 (`bafybei...`) produced by Helia (the IPFS implementation in PC2 nodes). When a sovereign-minted asset has a CIDv1 tokenURI, the indexer finds the on-chain event but metadata resolution fails.

**Current workaround (verified Mar 23, 2026)**: PC2 Creator Dashboard uploads `metadata.json` as a flat file to Elacity's upload API using `X-Target-Flow: ipfs` (not `dir,ipfs`). This returns a CIDv0 that resolves directly as raw JSON on `ipfs.ela.city`. Assets minted this way appear correctly in the Elacity marketplace feed.

**Note**: Using `X-Target-Flow: dir,ipfs` does NOT work — Elacity's API adds timestamp prefixes to filenames, breaking metadata resolution.

**Long-term fix**: The indexer should accept both CIDv0 and CIDv1 tokenURIs. This would allow sovereign nodes to skip the Elacity upload entirely and rely solely on DHT discovery.

---

### 2. GraphQL `LedgerAsset.image` Should Be Nullable
**Priority**: Medium

**Problem**: If metadata resolution fails (timeout, CID unreachable), the `image` field returns null. Since `image` is non-nullable in the GraphQL schema, the entire query response fails instead of gracefully returning assets with a missing image.

**Fix**: Make `LedgerAsset.image` nullable (and any other fields that depend on metadata resolution). The frontend can display a placeholder for missing images.

---

### 3. ~~Confirm `X-Target-Flow: dir,ipfs` Behavior~~ (Resolved)
**Priority**: N/A
**Status**: Resolved — `dir,ipfs` does NOT work for sovereign publishing

**Finding (Mar 23, 2026)**: `X-Target-Flow: dir,ipfs` adds timestamp prefixes to uploaded filenames (e.g., `1774248661915_metadata.json`), making them inaccessible at the expected `{CID}/metadata.json` path. The working approach is `X-Target-Flow: ipfs` for flat file uploads, which returns a CIDv0 for the raw content.

---

### 4. Simplified Asset Registration Mutation for Sovereign Minters
**Priority**: Medium (future)

**Problem**: Currently assets are registered via `createBackgroundJob` mutation which is tightly coupled to Elacity's internal workflow (it expects specific jobType, requires auth tokens tied to Elacity accounts, etc.).

**Proposal**: A simpler GraphQL mutation like:
```graphql
mutation registerSovereignAsset(
  $tokenId: String!
  $txHash: String!
  $metadataURI: String!
  $channel: String!
  $chainId: Int!
) {
  registerAsset(input: {
    tokenId: $tokenId
    txHash: $txHash
    metadataURI: $metadataURI
    channel: $channel
    chainId: $chainId
  }) {
    success
    assetId
  }
}
```

This would let sovereign nodes register directly without mimicking the full BackgroundJob lifecycle. The backend verifies on-chain that the asset exists and the metadata is resolvable.

---

### 5. On-Chain Event Listener for `AssetCreated` Events
**Priority**: Low (aspirational)

**Problem**: Sovereign minters must manually notify Elacity's backend about minted assets. If the notification fails, the asset exists on-chain but is invisible in the marketplace.

**Ideal fix**: Elacity's indexer watches `AssetCreated` events on the `AuthorityGateway` contract and auto-resolves the tokenURI. This would make sovereign minting truly frictionless — mint on-chain and it appears everywhere.

**Note**: This only works if Item 1 (CIDv1 support) is resolved first.

---

### 6. DHT Relay / Pin Service for Sovereign Content
**Priority**: Low (future)

**Problem**: When a sovereign node goes offline, its content becomes unreachable if no other node has pinned it. The current workaround (uploading to Elacity's IPFS) helps but adds a centralized dependency.

**Proposal**: Elacity could offer a lightweight pin relay service — when a sovereign node publishes content, it announces via DHT and Elacity's IPFS node automatically pins it for public availability. This is more aligned with the decentralization model than explicit uploads.

---

## Notes

- Item 1 (CIDv1 support) is the most impactful for full sovereign independence
- Item 2 (nullable image) is a defensive fix for GraphQL stability
- Item 4 improves developer experience for sovereign minters
- Items 5-6 are aspirational but align with the long-term decentralization vision
- PC2-side workaround for Item 1 is verified and working (flat file upload with `X-Target-Flow: ipfs`)
- Item 3 is resolved — `dir,ipfs` confirmed broken, `ipfs` (flat) is the working approach
