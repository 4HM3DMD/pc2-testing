# Elacity dDRM Integration Reference for PC2

> Source: Elacity codebase analysis, March 2026.
> This is the single source of truth for on-chain minting, encryption, and marketplace integration.

> ## Security: Session-Key Delegation (V1.2, shipped 2026-04-20)
>
> **Scope**: `non-media-decrypt-chipotle-sigauth.js` and
> `media-decrypt-chipotle-sigauth.js` Lit Actions.
>
> **Historic issue** (closed in V1.2): the previous Lit Actions
> trusted a client-supplied `userAddress` in `jsParams`. Because the
> Lit Action code is immutable/public on IPFS, any Lit-compatible
> caller could supply *any* known authorized buyer's address and
> receive the CEK. Discovered during the 2026-04-17 pre-release call.
>
> **Fix shipped**: **session-key delegation**. At wallet connect the
> buyer signs **one** `SecureViewDelegation` authorizing a
> non-extractable, device-bound P-256 key (Web Crypto, `extractable:
> false`) to decrypt dDRM content for up to 24 hours across their
> EOA + smart-account addresses. Every subsequent asset open is
> signed silently by the ephemeral key — zero wallet popups,
> preserving the "double-click to open" UX. The sigauth Lit Actions
> verify the delegation signature (EIP-191 for EOA or EIP-1271 for
> smart wallets) *and* the per-request signature before reaching the
> `AuthorityGateway.hasAccessByContentId` check against the
> delegation's `coveredAddresses`. `userAddress` has been removed
> from the authorization path entirely.
>
> **Rollout**: live as of 2026-04-20. `LIT_ACTION_CID` points at the
> new sigauth action; `LIT_ACTION_CID_LEGACY` stays pinned for 14
> days to cover clients that haven't yet adopted the session flow.
> After 14 days of zero legacy traffic the legacy action is
> unpinned and the sigauth path becomes mandatory.
>
> **Evidence**:
> - [`LIT-ACTION-SIGNATURE-AUTH/DESIGN.md`](../../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md) — full protocol, EOA/smart-account matrix, Lit Action pseudocode, rollout plan.
> - [`LIT-ACTION-SIGNATURE-AUTH/SECURITY.md`](../../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/SECURITY.md) — formal threat model, 20-row attack catalogue, residual-risk analysis.
> - [`LIT-ACTION-SIGNATURE-AUTH/TESTING.md`](../../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/TESTING.md) — positive/negative test matrix covering automated exploit regression, cross-browser, and wallet-in-hand rows.
> - [`scripts/spike/README.md`](../../../scripts/spike/README.md) — conformance spikes for the underlying primitives (EIP-191, EIP-1271, Web Crypto P-256, canonical JSON).

## Base Chain (8453) Contract Addresses

| Contract | Address |
|----------|---------|
| CORE_STORAGE | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` |
| AUTHORITY_GATEWAY | `0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29` |
| CHANNEL_CORE | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` |
| TRADE_GATEWAY | `0x9eC53758b698f9F68C0654DDd9159173a159a459` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| ELACITY_ROYALTY_ADDRESS | `0xCE4639Aa1E47E400683F49d95025475D5F50192d` (5%) |

## Elacity Backend API

- **Base URL**: `https://base.ela.city/api`
- **IPFS Gateway**: `https://ipfs.ela.city`

---

## 1. Channel Creation Flow

**Contract**: CHANNEL_CORE (`0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6`)

### Step 1: Get creation fee
`CoreStorage.channelCreationFee()` (currently returns 0)

### Step 2: Upload channel logo image to IPFS
Single file, returns `imageCID`.

### Step 3: Build metadata IPFS directory

**`0000000000000000000000000000000000000000000000000000000000000000.json`** — Token 0 (channel info):
```json
{
  "name": "Channel Name",
  "description": "Channel description",
  "image": "ipfs://<imageCID>",
  "properties": { "creator": "<creatorAddress>" },
  "attributes": [
    { "trait_type": "Type", "value": 1 },
    { "trait_type": "Scope", "value": 1 }
  ]
}
```

**`0000000000000000000000000000000000000000000000000000000000000002.json`** — Token 0x02 (royalty shares):
```json
{
  "name": "Royalty Share - Channel Name",
  "description": "Shares for royalty distribution...",
  "image": "ipfs://<imageCID>",
  "properties": { "decimals": 1, "creator": "<creatorAddress>" },
  "attributes": []
}
```

### Step 4: Upload directory to IPFS
Returns `dirCID`.

### Step 5: Encode `data` argument

Royalties always include Elacity 5%:
```typescript
const data = AbiCoder.defaultAbiCoder().encode(
  ['tuple(address,uint256)[]', 'tuple(uint8,address,uint256,uint256,bool)[]', 'tuple(address,uint256)[]'],
  [
    // Royalties: per-1000 values (percentage * 10)
    [[creatorAddress, 950], ['0xCE4639Aa1E47E400683F49d95025475D5F50192d', 50]],
    // Plans: [planId=0, payToken, priceWei, durationSeconds, active=true]
    [],
    // Token access thresholds
    []
  ]
);
```

### Step 6: Send transaction
```
createChannel(1, 1, "Channel Name", "ipfs://<dirCID>", data)
```
- Arg 1: `_channelType` — 1=Standard, 2=MultiChannel
- Arg 2: `_scope` — 1=Public, 2=Private (always 0 for MultiChannel)
- Arg 3: `_name`
- Arg 4: `_tokenURI` — `ipfs://<dirCID>` (just the directory, not /metadata.json)
- Arg 5: `data` — ABI-encoded bytes

### Step 7: Parse `ChannelCreated` event to get `channelAddr`

### Step 8: Register with backend (CRITICAL for marketplace visibility)

```
POST https://base.ela.city/api/2.0/graphql
Headers:
  Content-Type: application/json
  X-Transaction-Id: <txHash>
  Authorization: Bearer <authToken>
Body:
{
  "query": "mutation CreateChannel($input: ChannelInput) { created: createChannel(input: $input) { _id name address imageURL coverImageURL } }",
  "variables": {
    "input": {
      "name": "...",
      "address": "<channelAddr from event>",
      "description": "...",
      "creator": "<creatorAddress>",
      "scope": "1",
      "channelType": "1",
      "image": "",
      "coverImage": "",
      "categories": [],
      "plans": [],
      "tokenAccess": []
    }
  }
}
```

---

## 2. Asset Minting Flow

**Contract**: The channel contract itself (ERC-1155, uses DigitalAsset.json ABI)

### Mint function
```
mint(string _uri, uint16 opType, bytes opRawData, bytes sellRawData)
```

### opType values
- `0` = Free (no operative contract deployed, no commerce layer)
- `1` = Buy once (deploys OperativeBuyable)
- `2` = Buy and resell (deploys OperativeBuyableSellable)

### For free content (opType=0)
```
mint("dirCID/metadata.json", 0, "0x", "0x")
```
No fee, no role check, anyone can mint to a public channel.

### For paid content (opType=1 or 2)

Requires `MINTER_ROLE` on the channel contract.

#### opRawData encoding
```typescript
const opRawData = AbiCoder.encode(
  ['bytes16', 'string', 'address[]', 'uint256[]', 'uint256[]', ...(isResellable ? ['uint16'] : [])],
  [
    contentId,                    // bytes16: KID (first 16 bytes of content hash)
    `ipfs://${metadataURI}`,     // string: full metadata URI
    [creator, ...royaltyAddresses, ELACITY_ROYALTY_ADDRESS],
    [1, ...Array(royaltyCount).fill(2)],  // role types: 1=AccessToken, 2=RoyaltyShare
    [copiesNumber, ...royaltyPerThousandValues],
    ...(isResellable ? [resellerCut] : [])  // uint16: reseller cut (per-1000)
  ]
);
```

#### sellRawData encoding
```typescript
const sellRawData = AbiCoder.encode(
  ['uint256', 'uint256', 'address'],
  [copiesNumber, priceInWei, paymentTokenAddress]
);
```

- Price in wei: `parseUnits("4.99", 6)` for USDC (6 decimals)
- Payment token: USDC on Base = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

### Royalty structure (per-1000 basis)
- Creator: `royalty * 10` (e.g., 95% = 950)
- Elacity: always 50 (5%)
- Total must equal 1000

### Default values (from Elacity frontend)
- Price: 4.99 USDC
- Copies: 10,000
- Access method: buy_and_resell (opType=2)
- Reseller cut: 900 (90% to reseller on secondary sales)
- Creator royalty: 95% (950 per-1000)
- Elacity royalty: 5% (50 per-1000)

### Post-mint
1. Parse `AssetCreated` event to get `tokenId` and `opContract` (operative contract address)
2. Call `setApprovalForAll(AUTHORITY_GATEWAY, true)` on the operative contract
3. Get the channel's `authority()` address for the gateway

---

## 3. Metadata Directory Structure (for minted assets)

Uploaded as IPFS directory. The tokenURI on-chain stores `dirCID/metadata.json`.

### Required files in the directory

| File | Purpose |
|------|---------|
| `metadata.json` | Main metadata |
| `content.json` | Technical content details |
| `contract.json` | MCO (Media Contract Ontology) — only for paid content |
| `0000...0001.json` | AccessToken metadata |
| `0000...0002.json` | RoyaltyShare metadata |
| `0000...0003.json` | DistributionRight metadata (only for opType=2) |

### metadata.json structure
```json
{
  "name": "Asset Title",
  "description": "...",
  "image": "ipfs://<thumbnailCID>",
  "kid": "<KID>",
  "media": {
    "uri": "ipfs://<encryptedContentCID>",
    "contentType": "application",
    "size": 12345,
    "protectionType": "lit-aes-v1"
  },
  "properties": {
    "chainId": 8453,
    "ledger": "<channelAddress>",
    "authority": "<authorityGateway>",
    "publisher": "<creatorAddress>",
    "dataToEncryptHash": "<litDataToEncryptHash>"
  }
}
```

The `kid` and `dataToEncryptHash` fields are **critical** — without them, consumers cannot retrieve the decryption key.

---

## 4. Encryption Architecture (Sovereign Node Model)

The user's pc2-node follows the same pattern as Elacity's backend. The user's node IS their backend.

### Flow
1. Frontend uploads raw file to user's own pc2-node
2. pc2-node encrypts with Lit Protocol (server-side, unrestricted HTTPS to Datil production)
3. pc2-node generates KID from content hash (first 16 bytes of SHA-256)
4. pc2-node returns: encrypted ciphertext, `dataToEncryptHash`, KID
5. Frontend uploads encrypted content to IPFS
6. Frontend builds metadata directory (including `dataToEncryptHash` and KID)
7. Frontend uploads metadata directory to IPFS
8. Frontend mints token on-chain with KID embedded in `opRawData`
9. Mint deploys operative contract with AccessToken gating

### Lit Protocol details
- **Network**: `datil` (production, still running, sunsets ~30 days after Chipotle V3 launches March 25)
- **SDK**: `@lit-protocol/lit-node-client` (minimum v6.4.0)
- **Session**: SIWE signed, 7-day expiry, abilities: AccessControlConditionDecryption + LitActionExecution
- **Capacity credits**: Elacity frontend does NOT use capacity delegation in client code. For development/testing volumes on Datil production, no credits needed.
- **Access control conditions**: Reference the channel address + KID, not the token ID. The token ID only needs to exist at decryption time.
- **No chicken-and-egg problem**: KID is derived from content before minting. ACCs use KID. Token exists by decryption time.

### Decryption flow (consumer side)
1. Consumer's wallet signs an EIP-712 LicenseRequest with contentId (KID), ledger (channel), tokenId
2. AuthorityGateway verifies the consumer holds an AccessToken
3. Lit session sigs are obtained (SIWE sign)
4. Lit nodes verify access conditions and release the decryption key
5. Content is decrypted locally

> **V1.2 change (in flight)**: step 1 is being extended with a
> one-time `SecureViewDelegation` signed by the buyer's wallet on
> connect. The delegation authorizes a short-lived, non-extractable
> ephemeral key (Web Crypto) to sign per-request payloads silently
> for the session (≤ 24h). The Lit Action verifies both signatures
> and uses the delegation's `coveredAddresses` for
> `hasAccessByContentId` — never a `userAddress` parameter. Closes
> the bypass at the top of this document and preserves the
> "double-click to open" UX. See
> [`DESIGN.md`](../../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md)
> and [`SECURITY.md`](../../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/SECURITY.md).

### CEK caching (session-scoped, per-buyer, LRU)

Every successful Lit decryption call costs roughly **$0.01** of Chipotle
usage. A naive implementation would pay that price on every chapter of
a 14-chapter EPUB or every page of a 40-page PDF. PC2 avoids this with
a small in-process cache in `pc2-node/src/api/storage.ts`:

- **Key**: `${kid}:${buyerAddress}`. Scoped per-buyer so access
  revocation on one wallet cannot be bypassed by another.
- **Value**: the 32-byte AES-256 CEK plus a `cachedAt` timestamp.
- **TTL**: 5 minutes. After that the cache re-validates against Lit.
- **Capacity**: 50 entries. Enough for a few concurrent readers without
  letting memory grow unbounded on a long-running node.
- **Eviction policy**: **true LRU**. Reads promote the entry to the most
  recently used position by `delete` + `set` on the backing `Map`,
  exploiting `Map`'s insertion-order iteration. When capacity is
  reached we evict the first (oldest-read) key, not the first-inserted
  one. A previous coarser implementation could evict hot entries on a
  busy node; the V1.2 fix guarantees active readers stay cached.
- **Promise coalescing**: if two requests for the same cache-miss key
  race, only one Lit call goes out. The second awaits the first's
  promise via `pendingLitCalls: Map<string, Promise<Uint8Array>>`. This
  prevents a tab reload from double-billing.
- **Stats**: `hits`, `misses`, `evictions`, `expirations`,
  `manualFlushes`, `coalesced` counters expose cache behaviour for
  capacity tuning.

### Owner admin endpoints

Two node-owner-guarded endpoints expose cache control for incident
response and local observability:

```
GET  /api/storage/admin/cek-cache/stats
POST /api/storage/admin/cek-cache/flush
```

Both are protected by `authenticate` + `requireOwner` middleware — any
non-owner request is rejected with `401`. `flush` accepts an optional
body to scope invalidation:

- `{}` — flush all entries.
- `{ kid }` — drop every cached CEK for a specific content ID (useful
  if a key is suspected compromised).
- `{ buyerAddress }` — drop every cached CEK for a wallet (useful
  after an access-token transfer / revocation).
- `{ kid, buyerAddress }` — drop one exact entry.

Typical response:

```json
{
  "success": true,
  "flushed": 3,
  "scope": { "kid": "0xabc…", "buyerAddress": "0x1234…" },
  "stats": { "size": 47, "hits": 182, "misses": 12, "evictions": 0, "expirations": 1, "manualFlushes": 1, "coalesced": 4 }
}
```

---

## 5. Backend Authentication (Nonce-Sign-Login)

The Elacity backend requires authentication for mutations (channel creation, user profile, etc.). The flow is:

### Step 1: Get nonce
```graphql
query GetNonce($address: String!) {
  getNonce(address: $address)
}
```
Returns an integer nonce unique to the wallet address.

### Step 2: Sign the nonce
The message format must be exactly:
```
Approve signature on https://ela.city with nonce <nonce>
```
Signed via `personal_sign` with the message hex-encoded.

### Step 3: Login
```graphql
mutation UserLogin($address: String!, $signature: String!) {
  userLogin(address: $address, signature: $signature) {
    token address alias expiresIn
  }
}
```
Returns a JWT `token` for use as `Authorization: Bearer <token>` header.

### Registering an existing on-chain channel
The same `createChannel` mutation is used to register a channel that was deployed on-chain but not yet known to the backend. The `X-Transaction-Id` header must contain the original creation transaction hash so the backend can verify it on-chain.

---

## 6. Sovereign Asset Publishing & IPFS Strategy

### How sovereign-minted assets appear on Elacity Marketplace

Elacity's on-chain indexer watches for `AssetCreated` events and resolves `tokenURI(tokenId)` to fetch metadata from `ipfs.ela.city`. No explicit backend notification is needed — the asset appears automatically if:

1. The `tokenURI` is a CIDv0 (`Qm...`) that resolves on `ipfs.ela.city`
2. The metadata JSON has the expected `elacity-asset-envelope-v1` structure
3. The `image`, `properties.authority`, and `properties.ledger` fields are present

### IPFS Upload Strategy (Resolved Mar 23, 2026)

**Working approach**: Upload `metadata.json` as a **flat file** to Elacity's IPFS using:

```
POST https://base.ela.city/api/2.0/files/upload
Header: X-Target-Flow: ipfs
Body: FormData with single file named 'metadata.json'
```

This returns a CIDv0 (`Qm...`) for the raw JSON content, which resolves directly at `https://ipfs.ela.city/ipfs/{CID}`. This CID is used as the on-chain `tokenURI`.

**Local backup**: The PC2 node also creates a full metadata directory (containing `metadata.json`, `content.json`, `contract.json`, and token-type JSONs) on its local Helia IPFS node with DHT announcement. This CIDv1 directory serves as the sovereign backup.

**What does NOT work**: Using `X-Target-Flow: dir,ipfs` for directory uploads — Elacity's API adds timestamp prefixes to filenames (e.g., `1774248661915_metadata.json`) which breaks metadata resolution.

### Preview & Thumbnail IPFS Strategy

Preview clips and thumbnails are also uploaded to Elacity via the same `upload` endpoint with `X-Target-Flow: ipfs`. The CIDv0 returned by Elacity is used in metadata fields (`media.previewURL`, `image`) to ensure they resolve on the public gateway.

### Elacity Platform Items (for future discussion)

See `.cursor/tasks/ELACITY-PLATFORM-ITEMS/ELACITY-PLATFORM-ITEMS.md` for items that would improve sovereign publishing support on the Elacity platform side:

1. **CIDv1 support in indexer** — long-term fix so sovereign nodes don't need Elacity's upload API
2. **`LedgerAsset.image` nullable in GraphQL** — prevents query crashes when metadata resolution fails
3. **Simplified asset registration mutation** — alternative to BackgroundJob pipeline for sovereign minters
4. **On-chain event auto-indexing** — watch `AssetCreated` events for frictionless sovereign publishing

---

## 8. Key Considerations for Sovereign Packaging

- **IPFS pinning**: Your node is the primary pinner. Elacity IPFS receives copies for public gateway reachability. Content remains available P2P via DHT if Elacity goes offline — true sovereign cloud.
- **CID strategy**: Upload `metadata.json` as a flat file to Elacity's upload API (`X-Target-Flow: ipfs`) to get a CIDv0. This is the tokenURI. Keep local CIDv1 directory as sovereign backup. See Section 6 above.
- **On-chain visibility**: Elacity's on-chain indexer detects `AssetCreated` events and resolves the tokenURI. The metadata CID must be accessible on `ipfs.ela.city` for the asset to appear in the marketplace feed.
- **MINTER_ROLE for paid content**: Minting with opType 1 or 2 requires `MINTER_ROLE` on the channel contract. The Creator Dashboard verifies `hasRole(MINTER_ROLE)` before attempting mint to fail fast.
- **DASH encryption for media**: Video/audio files are transcoded to MPEG-DASH with CENC encryption. The DRM key is encrypted with Lit Protocol (Chipotle backend). Non-media files use AES-GCM encryption directly.
- **Preview system**: Video/audio files can have an optional preview clip (first N seconds, user-configurable). The preview is uploaded unencrypted to IPFS and referenced in `media.previewURL`.
- **Auto-thumbnails**: All asset types auto-generate a thumbnail if none is provided. Video extracts a frame at 3s, audio generates a waveform placeholder, PDFs render the first page, images are resized with blur overlay.
- **Content trust signals**: Metadata includes `contentHash` (SHA-256 of original file), `legal` attestation (cryptographic hash of creator declarations), and content intelligence fields (`wordCount`, `lineCount`, `originalSize`) for AI agent verification.
- **Adult content filtering**: `adult: true/false` flag in metadata enables marketplace-level content filtering.
- **Post-mint local seeding**: After minting, the asset and metadata CIDs are registered with the local ContentSeedingService for DHT announcement and persistence.
- **Universal Accounts (later)**: Elacity uses `REACT_APP_TX_EXECUTOR=ua` with Particle Network Universal Accounts. For now, using EOA directly works. UA can be wired in later for paid minting.

---

## 9. ABI References

All ABIs are in `/src/lib/drm/contracts/`:

| ABI | Contents |
|-----|----------|
| `ChannelCore.json` | `createChannel`, `ChannelCreated` event |
| `CoreStorage.json` | `channelCreationFee()`, `mediaCreationFee()` |
| `DigitalAsset.json` | Channel contract ABI: `mint`, `authority()`, `totalSupply()`, `tokenURI()`, `hasRole`, `grantRole`, `MINTER_ROLE`, `DEFAULT_ADMIN_ROLE`, `setApprovalForAll`, `AssetCreated` event |

---

## 10. Content Type Support (V1.2)

The `ddrm-renderer` WASM module supports two render tiers:

- **pixel-lock** — images, PDFs, CBZ comics, source code → watermarked JPEG/WebP/PNG
- **html-lock** — reflowable EPUB ebooks → sanitized XHTML with strict CSP + zero-width forensic watermark + diagonal SVG overlay

Added in V1.2: `application/epub+zip` (reflowable ebooks) and
`application/vnd.comicbook+zip` (CBZ comics). See
[EBOOK_PUBLISHING.md](./EBOOK_PUBLISHING.md) for the full pipeline,
sanitization rules, viewer integration, fixed-layout EPUB fallback, and
Runtime alignment notes.
