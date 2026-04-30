# Protection V3 Migration (Compact Reference)

This is the canonical migration summary for `feature/metadata-alignment`.

## What Is New

- Metadata envelope now writes `version: "1.1"`.
- Canonical protection data now lives in `asset.protections[]`.
- `media.protectionType` is now array-shaped when present.
- Protection identifiers:
  - non-media: `lit-aes-gcm-v3`
  - media: `cenc:lit-aes-gcm-v3`
- Media PSSH SystemID changed to `bf2c86c1d9ff4ab1b4be45ae4d99e1fe`.

## Canonical Write Rules

1. Protected non-media:
- `asset.encrypted = true`
- `media.protectionType = ["lit-aes-gcm-v3"]`
- `asset.protections[0].algorithm = "aes-256-gcm"`

2. Protected media:
- `asset.encrypted = true`
- `media.protectionType = ["cenc:lit-aes-gcm-v3"]`
- `asset.protections[0].algorithm = "aes-128"`
- PSSH uses `protectionType = "cenc:lit-aes-gcm-v3"`
- PSSH SystemID is `bf2c86c1d9ff4ab1b4be45ae4d99e1fe`

3. Unprotected assets:
- `asset.encrypted = false`
- omit `media.protectionType`
- omit `asset.protections`

## Canonical Read/Normalization Rules

Consumers must support both new and legacy shapes.

1. Normalize `media.protectionType` scalar/array to array internally.
2. Resolve protection fields in this order:
- `asset.protections[0].*`
- legacy flat `asset.*`
3. Protected-state detection must consider all of:
- `asset.encrypted`
- media protection array entries
- presence of protection entry data

## Backward Compatibility

Legacy behavior remains supported:

- legacy flat protection fields on `asset.*`
- legacy scalar `media.protectionType`
- legacy media protection entries:
  - `cenc:lit-drm-sa-v1`
  - `cenc:lit-drm-v1`

Player/media selection priority is:

1. `cenc:lit-aes-gcm-v3`
2. `cenc:lit-drm-sa-v1`
3. `cenc:lit-drm-v1`

`cenc:web3-drm-v1` remains disabled.

## Implementation Surfaces

- Creator (producer):
  - `pc2-node/data/test-apps/elacity-creator/app.js`
- Market (metadata normalization/consumption):
  - `pc2-node/data/test-apps/elacity-market/api.js`
  - `pc2-node/data/test-apps/elacity-market/app.js`
- Media packaging/runtime:
  - `pc2-node/src/services/media/dashPackager.ts`
  - `pc2-node/src/api/media.ts`
  - `pc2-node/crates/cenc-encrypt/src/pssh.rs`
  - `pc2-node/data/test-apps/elacity-player-src/src/PlayerProvider.tsx`

## QA Checklist

1. Mint protected non-media and verify `asset.protections[0]` + array `media.protectionType`.
2. Mint protected media and verify V3 media protection type + new PSSH SystemID.
3. Play new protected media and verify V3 path is selected first.
4. Open legacy protected assets and verify fallback paths still work.
5. Mint unprotected asset and verify no `media.protectionType` and no `asset.protections`.
