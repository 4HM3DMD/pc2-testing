# PC2 App Registry — Supernode Deploy Surface

Lightweight HTTP service that serves the dApp catalog on port 4500, plus
the deploy machinery for keeping the catalog in sync with the v1.2 signed
registry produced by `pc2-node/scripts/package-app.ts`.

## Files

| File | Purpose |
| ---- | ------- |
| `index.js`              | The 124-line HTTP server. Reads `registry.json`, hot-reloads on mtime change, serves `/api/registry/apps[/:name]` and `/api/registry/health`. |
| `registry.json`         | The single-source-of-truth catalog. Versioned. Edit via `scripts/sync-from-pc2.mjs` rather than by hand. |
| `package.json`          | Node ≥18, ESM, no deps. |
| `scripts/sync-from-pc2.mjs`   | Merges `pc2-node/registry/v1.2/_index.json` into `registry.json`. Replaces same-name entries (preserves curated `registry` UI metadata blocks); appends new ones with sensible defaults. Idempotent. Run with `--dry-run` first. |
| `scripts/deploy.sh`     | Validates `registry.json`, sshes into both supernodes, atomic-uploads to `/root/pc2/app-registry/registry.json`, verifies via `/api/registry/health`. Keeps timestamped backups on the remote. |
| `scripts/install-pinning.sh` | Run **on each supernode** to install kubo and pin the v1.2 app CIDs so user `Install` clicks actually retrieve bytes. Idempotent — safe to re-run after appending new CIDs. |

## End-to-end flow on launch day

```
       ┌──────────────────────┐                    ┌─────────────────────┐
       │  Your laptop          │                    │  Supernode (×2)      │
       │  (where you ran A2)   │                    │                      │
       │                       │  scripts/deploy.sh │                      │
       │  registry.json (v2)   │ ───────────────►   │  /root/pc2/          │
       │  ▶ 6 v1.2 entries     │  scp + atomic mv   │   app-registry/      │
       │    with cid+sig       │                    │   registry.json      │
       │                       │                    │                      │
       │                       │  ssh + bash        │                      │
       │  install-pinning.sh   │ ───────────────►   │  systemd: pc2-kubo   │
       │                       │                    │   ipfs daemon        │
       │                       │                    │   pin add ×6         │
       └──────────────────────┘                    └────────────┬─────────┘
                                                                 │
       ┌──────────────────────┐                                  │ DHT
       │  End-user PC2 node    │                                  │
       │  (fresh install)      │  /api/registry/apps              │
       │                       │ ──────────────►                  │
       │  dApp Centre          │ ◄──── 15 apps (6 with cid)       │
       │   ▶ Click Install     │                                  │
       │                       │  Helia → libp2p DHT ─────────────┘
       │  AppInstallService    │            ▼
       │   .fetchFromIPFS(cid) │      bytes arrive from kubo,
       │                       │      tarball verified against signedBy,
       │  app launches         │      extracted to data/installed-apps/
       └──────────────────────┘
```

## Three commands to ship v1.2

Run from your laptop, in this repo:

```bash
# 0. (already done by A2) Sign the 6 apps. Output is at:
#    pc2-node/registry/v1.2/_index.json

# 1. Merge that into the supernode catalog. Run --dry-run first to preview.
node deploy/app-registry/scripts/sync-from-pc2.mjs --dry-run
node deploy/app-registry/scripts/sync-from-pc2.mjs    # writes registry.json

# 2. Push registry.json to InterServer + Contabo. Hot-reload, no restart.
bash deploy/app-registry/scripts/deploy.sh

# 3. On EACH supernode, install kubo + pin the 6 CIDs. Run remotely:
ssh root@69.164.241.210 'bash -s' < deploy/app-registry/scripts/install-pinning.sh
ssh root@38.242.211.112 'bash -s' < deploy/app-registry/scripts/install-pinning.sh
```

After step 3, a fresh PC2 node anywhere on the public internet can:

1. Open dApp Centre → see all 6 v1.2 apps with green Install buttons
2. Click Install → `getFile(cid)` finds the bytes via DHT (kubo on supernodes)
3. `AppInstallService` verifies the Ed25519 signature against `signedBy`
   (= Elacity Labs publisher key `1ab060ba…`)
4. Extracts to disk, app appears in start menu

## Adding a new app to the catalog later

```bash
# Sign and pin a new app via the packager (prompts for the publisher key):
OWNER_KEY=pc2_<owner-key> node pc2-node/scripts/package-app.ts <app-dir> --pin

# That writes pc2-node/registry/v1.2/<name>-<version>.registry.json
# and updates pc2-node/registry/v1.2/_index.json automatically.

# Re-run the three commands above. Add the new CID to V12_CIDS in
# install-pinning.sh and re-run on each supernode.
```

## Failure modes & recovery

- **`deploy.sh` fails on ssh check** → no SSH key for the supernode account.
  Either set up the key (`ssh-copy-id root@<host>`) or override the user via
  `SUPERNODES="alice@host1,alice@host2" ./deploy.sh`.

- **`/api/registry/health` shows old app count after deploy** → the supernode
  hot-reloads on mtime change with up to 1s latency. PC2 nodes additionally
  cache for 5 min (`CACHE_TTL_MS` in `pc2-node/src/api/registry.ts`). To force
  a refresh on a PC2 node, restart it.

- **`ipfs pin add` hangs** → the publisher's bytes haven't propagated to the
  DHT yet. Either wait 1-2 min and retry, or directly bridge from the
  publisher node:
  ```
  # On supernode:
  ipfs swarm connect /ip4/<publisher-public-ip>/tcp/4001/p2p/<publisher-peer-id>
  ipfs pin add <cid>
  ```

- **dApp Centre shows app but Install spinner never resolves** → kubo isn't
  pinning that CID, or kubo daemon is down. Check on the supernode:
  ```
  systemctl status pc2-kubo
  ipfs pin ls --type=recursive | grep <cid>
  ```

## Why kubo on the supernode (not Helia, not Pinata)

- **Not Helia**: Helia is the right embedded library for PC2 nodes (small,
  in-process). Supernodes need a long-running daemon with `pin add`, GC, and
  `/api/v0` semantics — that's kubo's lane.
- **Not Pinata / web3.storage**: introduces a third-party dependency on the
  v1.2 launch-day promise. We already operate the supernodes; pinning there
  keeps the trust surface inside Elacity infra.
- **Cost**: ~300 MB RSS at idle, capped at 8 GB storage by `Datastore.StorageMax`.
  Comfortably fits the existing 8 GB / 4-core supernode profile.

## Layered availability (the four-source model)

This deploy gives us layers 2 + 3:

1. The publisher's local node (your laptop) — best-effort, not always on.
2. **Supernode kubo on InterServer** (this script).
3. **Supernode kubo on Contabo** (this script).
4. Future: `ipfs.ela.city` HTTP gateway as a last-resort fetch path
   (separate task, not blocking v1.2).

Three independent locations beats any single service.
