# Elacity App Registry — v1.2

This directory holds the **signed registry entries** for the six v1.2 apps that
ship with Elacity / PC2.

## Publisher

```
Name:       Elacity Labs
Key type:   ed25519
Public key: 1ab060ba7578261355504300c1193c484ed8a46a30499c3fa3cb9065930367eb
```

The corresponding private key lives off-repo at
`~/.elastos/keys/elacity-labs.ed25519` (chmod 0600). It is generated on first
run of `pc2-node/scripts/package-app.ts` and must be backed up out-of-band —
losing it permanently breaks the publisher identity for this capsule line.

## What's in here

| File                                     | App              | Role     | CID
| ---------------------------------------- | ---------------- | -------- | ---
| `_index.json`                            | (consolidated)   | —        | (all 6 entries, served by supernodes as `apps.json`)
| `elacity-market-0.2.0.registry.json`     | Elacity Market   | `system` | `bafybeiczcdan4j7zfw2ychjgzco4y4lbb5mqceezxfl5h7f3koau7t6x5y`
| `elacity-creator-0.1.0.registry.json`    | Elacity Creator  | `system` | `bafybeidhttd3uozgo3odpcvs3hvmrsbo2pgrbce6srum65y5qfzzvzztxy`
| `elacity-player-0.2.0.registry.json`     | Elacity Player   | `system` | `bafybeifbgkjmgnwvddgntdihvssvyncj5xml2ft6qi3dr3hellgf7wgxbi`
| `ddrm-viewer-0.1.0.registry.json`        | dDRM Viewer      | `system` | `bafkreicswjb7mvwdgauwd6dhw7ryirndxfraocjo2avn53vfs24oo7jeua`
| `elastos-nft-0.1.0.registry.json`        | Elastos NFT      | `dapp`   | `bafybeich5bmanb3nx65scjcv3rp3wjcge4np6von6ybwrp7xsob7llczdy`
| `glide-finance-1.0.0.registry.json`      | Glide Finance    | `dapp`   | `bafybeib6jbeosgudsbilc2bhlkbycnhuvdxwc5zfp22dmbsniknxddwvzq`

`role: "system"` apps are bundled inside the PC2 binary and can't be
uninstalled. `role: "dapp"` apps are downloadable from the dapp store via the
v1.2.1 `apps.ela.city` UI. See
[`docs/core/V1.2_ADOPTION_ROADMAP.md`](../../../docs/core/V1.2_ADOPTION_ROADMAP.md)
for the full split rationale.

## Entry shape

Each `<name>-<version>.registry.json` is the app's `app.json` manifest plus a
`distribution` block that carries the signed-bundle pointer:

```jsonc
{
  "name": "elacity-market",
  "version": "0.2.0",
  "role": "system",
  "...": "(rest of manifest verbatim)",
  "distribution": {
    "channel": "stable",
    "cid": "bafybei...",          // IPFS CID of the .tar.gz bundle
    "signature": "a0c55b...",     // hex-encoded Ed25519 detached signature over the tarball bytes
    "signedBy": "1ab060ba...",    // publisher Ed25519 pubkey (matches above)
    "size": 7124385               // tarball size in bytes
  }
}
```

A consumer (PC2 node, dapp-store UI) verifies an install by:

1. Fetching the `cid` over IPFS / a supernode mirror.
2. Recomputing `nacl.sign.detached.verify(tarballBytes, signature, signedBy)`.
3. Confirming `signedBy === <pinned Elacity Labs pubkey>` for first-party apps,
   or any allowed publisher key for third-party `dapp` capsules.

## How these were produced

```bash
# pc2-node/scripts/package-app.ts <name> --pin --auth $PC2_AUTH_TOKEN
#   1. tar.gz + gzip the source dir
#   2. Sign tarball bytes with ~/.elastos/keys/elacity-labs.ed25519
#   3. POST to /api/storage/ipfs/add to pin via the local Helia node
#   4. Write <name>-<version>.registry.json
```

## What's next

* **A4** — pin-set cron on the supernode (InterServer + Contabo): periodically
  fetch `_index.json` and pin every CID.
* **v1.2.1 `apps.ela.city`** — UI consumes `_index.json`, renders Install /
  Up-to-date affordances based on `role`.
