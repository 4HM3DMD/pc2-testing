# Elacity dDRM Integration Reference for PC2

> Source: Elacity codebase analysis, March 2026.
> This is the single source of truth for on-chain minting, encryption, and marketplace integration.

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

## 6. Asset Registration with Backend (BackgroundJob Pipeline)

Minted assets are registered via the BackgroundJob system, not a simple mutation.

### Elacity's media minting pipeline
1. **Create BackgroundJob**: `createBackgroundJob(input)` — tracks upload → transcode → encode → generate_metadata → broadcast_tx
2. **Generate metadata**: `generateBackgroundJobMetadata(requestId, payload)` — backend builds the IPFS metadata directory and returns `metadataURI`
3. **After on-chain mint**: `updateBackgroundJob(requestId, input)` — transitions to COMPLETED

The backend learns about assets through this pipeline. There is no separate "register asset" mutation.

### For sovereign packaging (PC2 model)
- **If marketplace visibility on ela.city is needed**: Use the BackgroundJob system, or confirm with the Elacity team if the on-chain indexer picks up assets that have valid `tokenURI` metadata
- **If building a PC2-native marketplace**: No backend registration needed. Read on-chain `AssetCreated` events and resolve `tokenURI(tokenId)` for metadata

### Why previously minted assets are invisible
Assets minted without a BackgroundJob have no record in the Elacity backend. The on-chain indexer may eventually detect them if it scans for `AssetCreated` events, but this depends on the indexer's implementation.

---

## 8. Key Considerations for Sovereign Packaging

- **IPFS pinning**: Your node is the sole pinner. Content becomes unreachable if the node goes offline. Consider remote pinning (Pinata, web3.storage) for availability.
- **Backend registration**: On-chain minting alone doesn't make assets visible in the Elacity marketplace. You must call the GraphQL `createChannel` mutation (with auth + tx hash) and use the BackgroundJob pipeline for assets. Without this, assets exist on-chain but the Elacity indexer won't surface them.
- **MINTER_ROLE for paid content**: Minting with opType 1 or 2 requires `MINTER_ROLE` on the channel contract. For your own channel, the creator wallet automatically has `DEFAULT_ADMIN_ROLE` and can grant `MINTER_ROLE`. For the public Elacity channel, the role must be granted by the channel admin.
- **No transcoding needed for non-media**: Elacity's backend transcodes video/audio to MPEG-DASH. For documents, images, data files — skip this entirely. Just encrypt the raw file.
- **Universal Accounts (later)**: Elacity uses `REACT_APP_TX_EXECUTOR=ua` with Particle Network Universal Accounts. The smart account address is `msg.sender` on-chain. For now, using EOA directly works for channel creation and free mints. UA can be wired in later for paid minting.

---

## 9. ABI References

All ABIs are in `/src/lib/drm/contracts/`:

| ABI | Contents |
|-----|----------|
| `ChannelCore.json` | `createChannel`, `ChannelCreated` event |
| `CoreStorage.json` | `channelCreationFee()`, `mediaCreationFee()` |
| `DigitalAsset.json` | Channel contract ABI: `mint`, `authority()`, `totalSupply()`, `tokenURI()`, `hasRole`, `grantRole`, `MINTER_ROLE`, `DEFAULT_ADMIN_ROLE`, `setApprovalForAll`, `AssetCreated` event |
