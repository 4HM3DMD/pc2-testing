# Protection V3 Migration (Metadata + PSSH)

This document describes the migration from legacy protection identifiers and scalar metadata fields to the new V3 model.

## Scope

- Metadata shape migration:
  - `media.protectionType` becomes `string[]` for all assets.
  - `asset.protections` becomes the canonical array for protection entries.
- Protection identifier migration:
  - `lit-aes-gcm-v1` -> `lit-aes-gcm-v3`
  - `cenc:lit-aes-gcm-v1` -> `cenc:lit-aes-gcm-v3`
- Media PSSH system ID migration:
  - old: `bf8ef85d2c54475d8c1ee27db60332a2`
  - new: `bf2c86c1d9ff4ab1b4be45ae4d99e1fe`

## Canonical Metadata (V3)

### Non-media (protected)

```json
{
  "media": {
    "protectionType": ["lit-aes-gcm-v3"]
  },
  "asset": {
    "encrypted": true,
    "protections": [
      {
        "algorithm": "aes-256-gcm",
        "protectionType": "lit-aes-gcm-v3",
        "dataToEncryptHash": "0x...",
        "actionCid": "Qm...",
        "litCiphertext": "<hex>",
        "iv": "<hex-or-base64>",
        "litBackend": "chipotle",
        "contentHash": "0x...",
        "contentHashAlgorithm": "SHA-256",
        "authority": "0x...",
        "chain": "base",
        "chainId": 8453,
        "rpc": "https://mainnet.base.org"
      }
    ]
  }
}
```

### Media (protected)

```json
{
  "media": {
    "protectionType": ["cenc:lit-aes-gcm-v3"]
  },
  "asset": {
    "encrypted": true,
    "protections": [
      {
        "algorithm": "aes-128",
        "protectionType": "cenc:lit-aes-gcm-v3",
        "dataToEncryptHash": "0x...",
        "actionCid": "Qm...",
        "litCiphertext": "<hex>",
        "iv": "<hex-or-base64>",
        "litBackend": "chipotle",
        "contentHash": "0x...",
        "contentHashAlgorithm": "SHA-256",
        "authority": "0x...",
        "chain": "base",
        "chainId": 8453,
        "rpc": "https://mainnet.base.org"
      }
    ],
    "mpdUri": "ipfs://...",
    "kid": "0x..."
  }
}
```

### Unprotected (all asset types)

```json
{
  "media": {},
  "asset": {
    "encrypted": false
  }
}
```

For unprotected assets, omit both fields entirely:

- do not include `media.protectionType`
- do not include `asset.protections`

## Algorithm Rules

- Media protection entries must use `algorithm: "aes-128"`.
- Non-media protection entries must use `algorithm: "aes-256-gcm"`.

## PSSH Rules (Media)

- Media encryption/decryption parameters are carried in PSSH and are authoritative for playback flow.
- PSSH `protectionType` now uses `cenc:lit-aes-gcm-v3`.
- PSSH `SystemID` is now `bf2c86c1d9ff4ab1b4be45ae4d99e1fe`.

## Backward Compatibility

Consumers must continue to support previous metadata and media payloads:

- Legacy scalar `media.protectionType` values.
- Legacy flat `asset` protection fields:
  - `asset.protectionType`, `asset.algorithm`, `asset.dataToEncryptHash`, `asset.actionCid`, `asset.authority`, `asset.chain`, `asset.chainId`, `asset.rpc`.
- Legacy media protection types in PSSH (`cenc:lit-drm-sa-v1`, `cenc:lit-drm-v1`) are still readable as fallback.

Compatibility strategy implemented:

1. Normalize old/new fields into a single internal representation.
2. Prefer V3 array fields and V3 PSSH entry when present.
3. Fallback to legacy fields/types only when V3 data is absent.

## Implementation Surfaces

### Producer

- `pc2-node/data/test-apps/elacity-creator/app.js`
  - Writes `media.protectionType` as array.
  - Writes `asset.protections` as array.
  - Applies media/non-media algorithm split.

### Consumer (metadata)

- `pc2-node/data/test-apps/elacity-market/api.js`
- `pc2-node/data/test-apps/elacity-market/app.js`
  - Normalize metadata for old and new shapes.
  - Resolve protection fields from `asset.protections` first, then legacy fallback.

### Media packaging + decryption path

- `pc2-node/src/services/media/dashPackager.ts`
  - Emits V3 media protection type in PSSH payload.
  - Uses new PSSH system ID.

- `pc2-node/crates/cenc-encrypt/src/pssh.rs`
  - Generates PSSH payload with V3 media protection type.
  - Uses new PSSH system ID.

- `pc2-node/src/api/media.ts`
  - Prefers `cenc:lit-aes-gcm-v3` during init/decrypt setup.
  - Keeps legacy fallback behavior.

- `pc2-node/data/test-apps/elacity-player-src/src/PlayerProvider.tsx`
  - Prioritizes `cenc:lit-aes-gcm-v3` in DRM system config.
  - Retains legacy fallback entries for old assets.

## Notes

- Legacy `cenc:web3-drm-v1` is no longer active in the V3 flow.
- Historical assets remain readable/playable through compatibility normalization and fallback selection.
