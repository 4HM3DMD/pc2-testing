# Metadata Production Analysis

Date: 2026-04-17
Scope: Channel metadata production and media/non-media asset mint metadata production in `pc2-node`, including main entrypoints and documentation drift.

## Executive Summary

Metadata production currently lives mostly in the Creator dApp and spans three layers:

1. Frontend assembly of metadata payloads and on-chain mint calldata.
2. PC2 backend helpers for encryption, media packaging, and IPFS upload.
3. Elacity backend/indexer expectations for channel registration and tokenURI resolution.

The implementation is functional but split across multiple conventions. The biggest inconsistencies are:

- Channel creation docs still describe a public-scope channel with image upload, while the code creates private channels and does not upload a channel image by default.
- Asset-mint docs contain both an old "metadata directory tokenURI" model and the newer "flat `metadata.json` on Elacity IPFS" model; the implementation uses the latter for on-chain minting and keeps the directory as a sovereign backup.
- Internal consumers disagree on where critical fields live. The Creator app writes `dataToEncryptHash` under `asset`, and `kid` only under `asset.kid` for media, while the content indexer still looks for `metadata.kid` or `metadata.properties.kid`.
- Free-content metadata is internally inconsistent: the main envelope says unencrypted, but `content.json` still hardcodes `encrypted: true`.

## Main Entrypoints

### Creator dApp

- Channel creation starts in `doCreateChannel()`: `pc2-node/data/test-apps/elacity-creator/app.js:1498`.
- Asset publishing starts in the main publish flow around the encrypt/upload/build-metadata path: `pc2-node/data/test-apps/elacity-creator/app.js:2407`.
- Asset minting happens in the same flow when calldata is built and `mint()` is sent: `pc2-node/data/test-apps/elacity-creator/app.js:3383`.
- Draft save/resume is the checkpoint layer for metadata already produced but not yet minted: `pc2-node/data/test-apps/elacity-creator/app.js:3241`, `pc2-node/data/test-apps/elacity-creator/app.js:4641`.

### Backend API

- Non-media encryption entrypoint: `POST /api/storage/lit/encrypt` in `pc2-node/src/api/storage.ts:1387`.
- Local metadata directory creation: `POST /api/storage/ipfs/add-directory` in `pc2-node/src/api/storage.ts:512`.
- Elacity flat-file replication: `POST /api/storage/ipfs/upload-elacity` in `pc2-node/src/api/storage.ts:2362`.
- Media encode/package pipeline: `POST /api/media/encode` in `pc2-node/src/api/media.ts:1369`.
- Draft persistence: `POST /api/drafts` in `pc2-node/src/api/drafts.ts:19`.

### Media packaging helpers

- DASH/CENC packaging entrypoint: `createEncryptedDASH()` in `pc2-node/src/services/media/dashPackager.ts:421`.
- PSSH metadata embedding happens in `buildPSSHJson()`, `injectPSSHBox()`, and `packageDASH()`: `pc2-node/src/services/media/dashPackager.ts:135`, `196`, `255`.

### Indexing/consumption

- Metadata resolution for minted items is handled by `ContentIndexerService.resolveItemMetadata()`: `pc2-node/src/services/ContentIndexerService.ts:527`.
- The indexer extracts the content CID from `metadata.media.uri`, and the content ID from `metadata.kid` or `metadata.properties.kid`: `pc2-node/src/services/ContentIndexerService.ts:572-577`.

## Implementation Walkthrough

## 1. Channel metadata production

The Creator dApp builds channel metadata locally in `doCreateChannel()`:

- Token `0x00...00.json` contains channel name, description, creator, and type/scope traits: `pc2-node/data/test-apps/elacity-creator/app.js:1514-1523`.
- Token `0x00...02.json` contains royalty-share metadata: `pc2-node/data/test-apps/elacity-creator/app.js:1524-1529`.
- Additional per-plan token metadata files are generated for subscription plans: `pc2-node/data/test-apps/elacity-creator/app.js:1531-1545`.

That metadata is uploaded as a local IPFS directory through `/api/storage/ipfs/add-directory`: `pc2-node/data/test-apps/elacity-creator/app.js:1553-1564`, backed by `pc2-node/src/api/storage.ts:512-572`.

The resulting directory CID is used directly as the on-chain `_tokenURI` in `createChannel(...)`: `pc2-node/data/test-apps/elacity-creator/app.js:1596-1603`.

After on-chain creation, the channel is separately registered with the Elacity backend by GraphQL so it appears in marketplace/discovery flows: `pc2-node/data/test-apps/elacity-creator/app.js:1672-1688`, `1786-1822`.

## 2. Asset metadata production

The Creator dApp builds the main asset envelope in `buildMetadataEnvelope()`: `pc2-node/data/test-apps/elacity-creator/app.js:1061-1131`.

That envelope includes:

- Top-level identity fields: `schema`, `name`, `description`, `image`, `category`.
- `media`: public-facing delivery fields such as `uri`, `mimeType`, and `protectionType`.
- `asset`: low-level encryption/storage fields such as CID, encryption status, algorithm, `dataToEncryptHash`, `actionCid`, authority, chain, and rpc.
- `pricing`, `properties`, `creator`, `attributes`, `adult`, `licensing`, `legal`.

Supporting metadata files are also produced:

- `content.json` via `buildContentJson()`: `pc2-node/data/test-apps/elacity-creator/app.js:1133-1145`.
- `contract.json` via `buildContractJson()`: `pc2-node/data/test-apps/elacity-creator/app.js:1155-1176`.
- Per-token metadata files via `buildTokenTypeJsons()`: `pc2-node/data/test-apps/elacity-creator/app.js:1178-1215`.

These files are collected into a local metadata directory and added to local IPFS: `pc2-node/data/test-apps/elacity-creator/app.js:3167-3189`.

But the on-chain `tokenURI` used for minting is not that directory CID. The Creator app uploads only `metadata.json` as a flat file to Elacity IPFS and uses the returned CID as `mintUri`: `pc2-node/data/test-apps/elacity-creator/app.js:3191-3218`, `3404-3406`. The local directory remains a backup path.

## 3. Media-specific metadata production

For media files, metadata is partially produced by the backend encode pipeline and partially by the Creator dApp.

The backend media job returns:

- `cid`, `mpdUri`, `kid`, `dataToEncryptHash`, `ciphertext`, and preview/media stats: `pc2-node/src/api/media.ts:1603-1615`.

The Creator dApp then injects those into the metadata envelope:

- Sets media-specific protection type and playback fields: `pc2-node/data/test-apps/elacity-creator/app.js:3079-3095`.
- Stores `asset.mpdUri`, `asset.kid`, and `asset.litBackend` for protected media: `pc2-node/data/test-apps/elacity-creator/app.js:3085-3089`.
- Uses the media pipeline `kid` when creating token-type metadata and the on-chain content ID: `pc2-node/data/test-apps/elacity-creator/app.js:3131-3160`, `3389-3399`.

Separately, the media packager embeds Lit/PSSH metadata inside the init segment:

- `authority`, `chainId`, `rpc`, `actionIpfsId`, `litBackend`, `ciphertext`, `hash`, `kid`: `pc2-node/src/services/media/dashPackager.ts:141-156`, `352-367`.

That means media metadata lives in two places:

- User-visible asset envelope on IPFS.
- DRM/PSSH payload inside the media init segment.

## 4. Mint calldata production

Paid mint calldata is built in `encodeOpRawData()`:

- It derives a `bytes16` content ID from the supplied hash via `hashToContentId()`: `pc2-node/data/test-apps/elacity-creator/app.js:1254-1257`.
- It encodes `metadataUri`, role allocations, supplies, royalties, and optional reseller cut: `pc2-node/data/test-apps/elacity-creator/app.js:1259-1300`.

Asset mint then calls the channel contract’s `mint(string _uri, uint16 opType, bytes opRawData, bytes sellRawData)`: `pc2-node/data/test-apps/elacity-creator/app.js:3404-3406`.

## Documentation Drift and Inconsistencies

### D-01: Channel scope in docs does not match implementation

The implementation creates private channels:

- `createChannel(..., CHANNEL_SCOPE.PRIVATE, ...)`: `pc2-node/data/test-apps/elacity-creator/app.js:1597-1601`.
- Backend registration also records `scope: "2"`: `pc2-node/data/test-apps/elacity-creator/app.js:1799-1803`.

But `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` still shows:

- `createChannel(1, 1, ...)`
- `_scope` documented as `1`
- backend registration example with `"scope": "1"`

References: `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md:83-89`, `105-117`.

### D-02: Channel image upload is documented but not implemented in the current creation flow

The integration doc describes:

- "Step 2: Upload channel logo image to IPFS"
- channel metadata examples with `image: "ipfs://<imageCID>"`

Reference: `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md:31-59`.

But the current `doCreateChannel()` flow:

- does not upload a channel image,
- does not put `image` into local channel metadata,
- registers backend channel records with `image: ''` and `coverImage: ''`.

References: `pc2-node/data/test-apps/elacity-creator/app.js:1514-1529`, `1795-1807`.

### D-03: Asset tokenURI strategy is described two different ways in docs; code implements the flat-file model

Older/earlier doc passages still describe minting with `dirCID/metadata.json` and directory uploads:

- `mint("dirCID/metadata.json", ...)`
- "Uploaded as IPFS directory. The tokenURI on-chain stores `dirCID/metadata.json`"

References: `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md:140`, `196-207`, `246-247`.

The same doc later states the resolved strategy is:

- upload `metadata.json` as a flat file to Elacity IPFS,
- use that returned CIDv0 as the on-chain `tokenURI`,
- keep the local directory as sovereign backup.

References: `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md:314-326`, `346-347`.

The implementation matches the newer flat-file model:

- local directory is created first,
- `metadata.json` is uploaded separately to Elacity,
- the returned `metaCid` is used as `mintUri`.

References: `pc2-node/data/test-apps/elacity-creator/app.js:3167-3218`, `3404-3406`.

### D-04: AuthorityGateway address differs across docs and code

Current Creator code uses:

- `0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D`

Reference: `pc2-node/data/test-apps/elacity-creator/app.js:17`.

But other docs cite different addresses:

- `0x580c26...` in `docs/core/CHIPOTLE_HANDOVER.md:195`
- `0x8fe6bf...` in `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md:11`

This looks like a mix of old and planned V3 addresses that has not been normalized.

## Implementation Inconsistencies

### I-01: `content.json` says encrypted even for free content

`buildMetadataEnvelope()` correctly marks free assets as:

- `asset.encrypted: false`
- `asset.algorithm: 'none'`
- `asset.protectionType: 'none'`

Reference: `pc2-node/data/test-apps/elacity-creator/app.js:1086-1099`.

But `buildContentJson()` hardcodes:

- `encrypted: true`

Reference: `pc2-node/data/test-apps/elacity-creator/app.js:1133-1144`.

Because `content.json` is always emitted, a free asset can contain contradictory metadata between `metadata.json` and `content.json`.

### I-02: Creator-produced metadata and the content indexer disagree on where `kid` lives

The content indexer currently looks for:

- `metadata.kid`
- `metadata.properties.kid`

Reference: `pc2-node/src/services/ContentIndexerService.ts:576`.

But the Creator app writes:

- for media: `asset.kid`
- for non-media: no `kid` in the main envelope at all

Reference: `pc2-node/data/test-apps/elacity-creator/app.js:3085-3089`.

This means creator-produced metadata will not populate `content_id` in the catalog via the current indexer path.

### I-03: Creator-produced metadata and docs disagree on where `dataToEncryptHash` lives

The docs call out `properties.dataToEncryptHash` as critical:

- `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md:222-232`

But the Creator app writes `dataToEncryptHash` under `asset.dataToEncryptHash`:

- `pc2-node/data/test-apps/elacity-creator/app.js:1091-1099`

The market app is tolerant and reads from `asset.dataToEncryptHash`:

- `pc2-node/data/test-apps/elacity-market/app.js:3775`

But the docs and some internal assumptions still describe a different shape.

### I-04: Media documentation still describes an older Lit flow than the current implementation

`docs/core/CHIPOTLE_HANDOVER.md` still says media uses:

- "ECDH P-256 envelope wrapping"
- "Media-specific action (ECDH)"
- "Wired, untested"

Reference: `docs/core/CHIPOTLE_HANDOVER.md:55-63`.

Current implementation differs:

- the media mint path is actively used from Creator via `/api/media/encode`: `pc2-node/data/test-apps/elacity-creator/app.js:2557-2686`
- the current media decrypt path in `media.ts` uses `recoverNonMediaCEK()` on the Chipotle branch, not a separate media-envelope unwrap path: `pc2-node/src/api/media.ts:1088-1107`

This is broader than metadata alone, but it directly affects which action CIDs and metadata fields are expected in produced media assets.

## Recommended Cleanup

1. Pick one canonical asset metadata shape and align all readers to it. Either:
   - move `kid` and `dataToEncryptHash` to the documented locations, or
   - update docs and indexer to treat `asset.*` as canonical.
2. Fix `buildContentJson()` so free content emits `encrypted: false`.
3. Normalize tokenURI documentation around the flat-file Elacity CID strategy and clearly mark the local directory as backup-only for asset minting.
4. Update channel docs to reflect current private-scope defaults, or change the code if public scope is intended.
5. Decide whether channel creation should support first-class image/cover metadata at creation time; docs and code currently diverge.
6. Normalize AuthorityGateway addresses across docs before more migrations land.

## Bottom Line

The implementation’s real source of truth is the Creator app:

- Channel metadata is built locally as an IPFS directory and that directory CID is used directly on-chain.
- Asset metadata is built both as a rich local directory and as a flat `metadata.json`, but only the flat Elacity CID is used as the on-chain `tokenURI`.
- Media mint metadata is assembled from backend encode results plus frontend envelope construction, with DRM details duplicated into both the user-facing envelope and the media PSSH.

The main risk now is not that metadata is missing, but that different parts of the system and different docs are assuming different metadata shapes and URI strategies.
