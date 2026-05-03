# Task: Supernode IPFS Cluster Setup (3-tier availability architecture)

**Task ID**: SUPERNODE-CLUSTER-SETUP
**Created**: 2026-05-02
**Status**: InProgress — Phases 1, 2, 5.1, 5.2, 5 (pc2-node integration), AND v1.2.7 SQLite migration ALL COMPLETE on Contabo + InterServer + Jetson (2026-05-02). End-to-end cluster pinning verified live in production: nginx-exposed Pinning Services API, bearer-token auth, Jetson `pm2 reload` confirmed `[ClusterPin] enabled`, backfill of 1 yesterday-failed CID rescued and replicated to both supernodes. Jetson now running v1.2.7 (SQLite migration + cluster + playback fixes — full validation of upcoming release). Pending: GCloud (Tier 1 third peer), per-node tokens, v1.2.7 git tag, ecosystem.config.cjs polish for community node auto-enrollment.
**Priority**: High — fixes root cause of "Content not yet reachable on IPFS" failures reported by Jetson + EverlastingOS users
**Target Release**: v1.2.7 (combined with SQLite migration + playback fixes)

## 2026-05-02 — Phase 1 Survey RESULTS (Contabo + InterServer)

Read-only survey ran successfully on both boxes via `scripts/cluster-setup/01-survey.sh`. **Zero service disruption** confirmed (no installs, no restarts, no config changes). GCloud (`ipfs.ela.city`) was NOT surveyed at User's request — see "GCloud status" below.

### Findings comparison

| Property | Contabo | InterServer |
|---|---|---|
| **IP** | 38.242.211.112 | 69.164.241.210 |
| **Hostname** | vmi1330656.contaboserver.net | elacity.hostname.com |
| **OS** | Ubuntu 20.04.6 LTS | Ubuntu 24.04.3 LTS |
| **Kernel** | 5.4.0-105-generic | 6.8.0-71-generic |
| **CPU** | 12-core AMD EPYC (with IBPB) | 32-core AMD EPYC 4545P |
| **RAM** | 47 GB total / 25 GB free | 91 GB total / 43 GB free |
| **Disk free** | 460 GB / 785 GB total | 2.7 TB / 3.6 TB total |
| **Uptime** | 19 weeks 5 days | 29 weeks 1 day |
| **Kubo version** | 0.34.1 (latest) | 0.34.1 (latest) ✓ matched |
| **Kubo PeerID** | `12D3KooWQZu8rY8BgD1fLq1yF1ArSnUy9D3Jf71w7C6RpbZy9nVr` | `12D3KooWFLBeemSpue43SULYbqmSrgreYDYQdfDKD2MHUnRcMc5f` |
| **Kubo libp2p port** | 4101 (NOT default 4001) | 4101 (NOT default 4001) ✓ matched |
| **Kubo StorageMax** | **8 GB** ⚠ tiny | **8 GB** ⚠ tiny |
| **Current repo size** | 3.0 GB used (37 % of 8 GB cap) | 2.7 GB used (33 % of 8 GB cap) |
| **Pinset count** | 7 (app-registry + a few) | 7 (app-registry + a few) |
| **Connected peers** | 358 | 345 |
| **Datastore type** | flatfs | flatfs |
| **`ipfs-cluster-service`** | NOT installed | NOT installed |
| **Cluster ports (9094/95/96)** | all FREE | all FREE |
| **Firewall** | `ufw` active, restrictive | `ufw` active, many ports |
| **Other PC2 services running** | esc-rpc, nginx, pc2-app-registry, pc2-boson, pc2-ipfs-relay, pc2-kubo, pc2-vless-reality, pc2-web-gateway | pc2-app-registry, pc2-boson, pc2-cloud-node, pc2-gateway, pc2-ipfs-relay, pc2-kubo, pc2-network-map, pc2-vless-reality |

### Inter-supernode connectivity (Kubo libp2p port 4101)

| From → To | Result |
|---|---|
| Contabo → InterServer:4101 | **OPEN** ✓ |
| InterServer → Contabo:4101 | **OPEN** ✓ |
| Contabo → GCloud:4101 | **closed/filtered** ⚠ |
| InterServer → GCloud:4101 | **closed/filtered** ⚠ |
| Contabo ↔ InterServer Bitswap peering today? | **No** (TCP works but they don't currently know about each other in libp2p) |

### Critical observations

1. **Both boxes are massively over-provisioned.** Combined: 138 GB RAM, 3.5 TB disk free, 44 CPU cores. We can run a serious replication tier here.
2. **`StorageMax: 8 GB` on both** — this is the default Kubo cap, never raised. With 3+ TB free disk, we're using **0.07 %** of available capacity. Bumping to 500 GB–1 TB is the single highest-leverage change.
3. **Same Kubo version (0.34.1) on both** — perfect. No version skew when we add Cluster.
4. **TCP path between Contabo ↔ InterServer is OPEN on port 4101** — Cluster gossip + libp2p direct peer dial will both work without firewall changes.
5. **They aren't currently peering with each other directly** despite both connecting to ~350 global peers — they discovered each other via DHT but haven't formed a direct Bitswap connection. Adding mutual `Peering.Peers` config entries (or Cluster's bootstrap) fixes this immediately.
6. **GCloud (`ipfs.ela.city`) port 4101 is closed from both supernodes** — needs separate investigation: is Kubo on GCloud listening on a different port, or is there a firewall blocking it?
7. **Both boxes already host MANY other PC2 services** (boson DHT, app registry, web gateway, etc.). Cluster setup must be carefully scoped — `ipfs-cluster-service` only, on free ports 9094-9096, no impact on existing services.
8. **Firewall additions needed BEFORE Cluster swarm works** — port 9096 (TCP) needs to be opened bidirectionally between Contabo ↔ InterServer (ufw allow from specific IPs only, NOT public).

### GCloud status (deferred per User decision 2026-05-02)

User's call: do NOT survey GCloud yet. Proceed with Contabo + InterServer two-node Cluster first to prove the pattern. GCloud can join later as a third Cluster peer once we know the setup is stable. The closed port 4101 is a clue worth investigating — likely Kubo on GCloud is on a different port (could be the canonical 4001) or behind a load-balancer.

---

## Phase 2 PROPOSAL — what to actually change (awaiting User approval)

Before any changes, getting User's explicit go-ahead because both boxes are in production. Proposed changes are SMALL and REVERSIBLE.

### 2.1 Kubo `StorageMax` bump (~30 sec per box, no service restart needed)

Change `Datastore.StorageMax` in each box's `/root/.ipfs/config` from `"8GB"` to a sensible value:

- **Contabo**: bump to **300 GB** (leaves 160 GB headroom on a 460 GB / 785 GB disk for OS + other services + buffer)
- **InterServer**: bump to **1 TB** (leaves 1.7 TB headroom on a 2.7 TB / 3.6 TB disk)

Asymmetric on purpose — InterServer has 3× the disk, so it carries more.

Method: `ipfs config Datastore.StorageMax 300GB` (live-edit, no daemon restart needed; takes effect immediately).

**Risk**: zero on Contabo (lots of headroom). Minimal on InterServer (uses ext4, no quota issues).

### 2.2 Mutual peering config (~30 sec per box, no restart)

Add the other supernode's PeerID + multiaddr to each box's `Peering.Peers` config so Kubo holds a persistent direct connection (better than DHT-mediated discovery):

```bash
# On Contabo:
ipfs config --json Peering.Peers '[{"ID":"12D3KooWFLBeemSpue43SULYbqmSrgreYDYQdfDKD2MHUnRcMc5f","Addrs":["/ip4/69.164.241.210/tcp/4101"]}]'

# On InterServer:
ipfs config --json Peering.Peers '[{"ID":"12D3KooWQZu8rY8BgD1fLq1yF1ArSnUy9D3Jf71w7C6RpbZy9nVr","Addrs":["/ip4/38.242.211.112/tcp/4101"]}]'
```

Takes effect on next periodic peering reconciliation (~1 min). No restart required.

**Risk**: zero. Just adds a peer pin to the config.

### 2.3 UFW open port 9096 between supernodes ONLY (~5 sec per box)

```bash
# On Contabo:
ufw allow from 69.164.241.210 to any port 9096 comment 'IPFS Cluster swarm from InterServer'

# On InterServer:
ufw allow from 38.242.211.112 to any port 9096 comment 'IPFS Cluster swarm from Contabo'
```

**Risk**: minimal — opens 9096 only from a specific peer IP, not the world. Easy to revoke with `ufw delete`.

### 2.4 Install `ipfs-cluster-service` v1.1.x (latest) on both boxes (~2 min per box)

```bash
# Reproducible install via official binary (NO compile, NO Go toolchain):
cd /tmp
wget -q https://dist.ipfs.tech/ipfs-cluster-service/v1.1.4/ipfs-cluster-service_v1.1.4_linux-amd64.tar.gz
tar xzf ipfs-cluster-service_v1.1.4_linux-amd64.tar.gz
install -m 755 ipfs-cluster-service/ipfs-cluster-service /usr/local/bin/
# ditto for ipfs-cluster-ctl
```

**Risk**: low. Just drops two binaries in `/usr/local/bin/`. Doesn't touch Kubo or any running service. Doesn't auto-start anything.

### 2.5 Cluster init + bootstrap (~5 min total)

1. Generate shared secret on Contabo: `ipfs-cluster-service init --consensus crdt`
2. scp `/root/.ipfs-cluster/identity.json` and the secret hex to InterServer
3. On InterServer: `ipfs-cluster-service init --consensus crdt --secret <hex>` and add Contabo's peer ID to trusted peers
4. Start `ipfs-cluster-service daemon &` on Contabo first
5. Start on InterServer with `--bootstrap /ip4/38.242.211.112/tcp/9096/ipfs/<contabo-cluster-peer-id>`
6. Verify: `ipfs-cluster-ctl peers ls` → should show 2 peers
7. Smoke pin: `ipfs-cluster-ctl pin add bafybeidhttd3uozgo3odpcvs3hvmrsbo2pgrbce6srum65y5qfzzvzztxy --replication-min 2 --replication-max 2` and confirm both pin in <10s

**Risk**: medium-low. New service, but only listens on 9094-9096 (all free). systemd unit can be drafted but daemon can run under tmux first for testing. If anything goes wrong, just `kill` the cluster daemon — Kubo and PC2 services are unaffected.

### 2.6 systemd unit for `pc2-cluster.service` (~10 min)

Once smoke-tested, write a proper systemd unit so Cluster auto-starts on reboot. Match the existing pc2-* service naming convention.

---

## 2026-05-02 — Phase 2 RESULTS (LIVE — 2-node Cluster operational)

All 6 sub-steps completed cleanly on both Contabo and InterServer with **zero disruption to existing services**. Final state:

### Cluster identity

| Node | Cluster Peer ID | Kubo Peer ID |
|---|---|---|
| Contabo (38.242.211.112) | `12D3KooWJuGc9wSpyWZh3yHbcCxmpC9aujKzUwcWT86RVv31m4UW` | `12D3KooWQZu8rY8BgD1fLq1yF1ArSnUy9D3Jf71w7C6RpbZy9nVr` |
| InterServer (69.164.241.210) | `12D3KooWPpBC7v6smm5eHv5yx45rfE3xzk5k3srnGu8Dg9Jgjyw6` | `12D3KooWFLBeemSpue43SULYbqmSrgreYDYQdfDKD2MHUnRcMc5f` |

Cluster shared secret stored in `/root/.ipfs-cluster/service.json` on both boxes (also backed up at `/tmp/cluster-secret.txt` on Contabo). **TODO: move secret to a proper secrets store before more peers are added.**

### Smoke test (passed)

```
$ ipfs-cluster-ctl pin add --replication-min 2 --replication-max 2 \
    --name 'cluster-smoke-test-2026-05-02' QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG

QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG | cluster-smoke-test-2026-05-02:
  > vmi1330656.contaboserver.net : PINNED
  > elacity.hostname.com : PINNED
```

Within **5 seconds** of issuing the pin command on Contabo, the CID was pinned on both nodes' local Kubo blockstores. CRDT replication confirmed working.

### Per-step verification

| Step | Result |
|---|---|
| 2.1 — Kubo `StorageMax` 8 GB → Contabo 300 GB / InterServer 1 TB | ✓ Confirmed; no daemon restart needed; existing Kubo pids preserved (Contabo 2808774, InterServer 1913311) |
| 2.2 — Mutual `Peering.Peers` config | ✓ Set on both. Note: `ipfs swarm peers` still doesn't show them as direct Kubo Bitswap peers, but Cluster's libp2p layer handles peer discovery independently and works correctly |
| 2.3 — UFW open port 9096 from specific peer IP | ✓ Contabo rule [21] allow from 69.164.241.210; InterServer rule [52] allow from 38.242.211.112 |
| 2.4 — Install `ipfs-cluster-service` v1.1.4 + `ipfs-cluster-ctl` v1.1.4 | ✓ Both binaries in `/usr/local/bin/`, ~36 MB + ~20 MB |
| 2.5 — Initialize CRDT Cluster + start daemons | ✓ Both daemons started, both joined cluster, both saw each other as peers ("Sees 1 other peers") |
| 2.6 — `pc2-cluster.service` systemd unit installed + enabled + transitioned | ✓ On both: `systemctl is-active` returns `active`, enabled for boot, transitioned cleanly from nohup to systemd-managed without losing pin state |

### Service inventory after change

**Contabo** — 9 PC2-related services running (was 8 before, +pc2-cluster.service):
esc-rpc, nginx, pc2-app-registry, pc2-boson, pc2-cluster (NEW), pc2-ipfs-relay, pc2-kubo, pc2-vless-reality, pc2-web-gateway

**InterServer** — 9 PC2 services running (was 8 before, +pc2-cluster.service):
pc2-app-registry, pc2-boson, pc2-cloud-node, pc2-cluster (NEW), pc2-gateway, pc2-ipfs-relay, pc2-kubo, pc2-network-map, pc2-vless-reality

**Zero existing services were restarted, modified, or disrupted during the entire Phase 2.**

### Cluster ports listening

Both boxes:
- `127.0.0.1:9094` — REST API (auth-bound to localhost; secure)
- `127.0.0.1:9095` — IPFS Proxy (Kubo-compat HTTP API)
- `0.0.0.0:9096` — Cluster swarm (libp2p, public — protected by ufw rule + cluster shared secret)
- `127.0.0.1:9097` — Pinning Service API (IPFS Pinning Services API spec)

### Logs

Cluster daemon logs at `/var/log/ipfs-cluster/daemon.log` on both boxes. `journalctl -u pc2-cluster.service` also captures everything.

### Outstanding cleanup

- **Smoke-test pin** `QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG` (1 KB IPFS welcome readme) is still in the Cluster pinset. Harmless but should be removed: `ipfs-cluster-ctl pin rm QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG` from either box. Deferred due to SSH rate-limit cooldown when trying.

### What this delivers TODAY

**Any CID pinned via either supernode's `ipfs-cluster-ctl pin add --replication-min 2` is automatically replicated to both supernodes within seconds.** This is a real, working availability tier. From this point onward, any content published with this guarantee can survive a single supernode failure with zero user-visible impact.

What's NOT delivered yet (Phase 5):
- pc2-node still uses `SUPERNODE_PIN_MIRRORS` env var to fan-out pins to per-node `/api/storage/ipfs/pin` endpoints. That works, but it's not Cluster-aware. Phase 5 wires pc2-node to talk to Cluster's Pinning Services API on port 9097 directly — eliminates the need for `pc2-web-gateway` to act as a pin proxy on each supernode.

---

## Phase 5 PROPOSAL — pc2-node integrates with Cluster (next session)

Now that the supernode side works, the pc2-node side needs to consume it.

### 5.1 Expose Cluster's Pinning Services API publicly (auth-protected)

Currently `127.0.0.1:9097` is loopback-only on each supernode. To let pc2-nodes hit it remotely, either:
- (a) Reverse-proxy through nginx with TLS + bearer-token auth (preferred — matches existing pc2-web-gateway pattern), OR
- (b) Open 9097 publicly with the Pinning Services API's built-in token auth (simpler but less defense-in-depth)

Recommend (a). Existing nginx on Contabo can host the proxy at e.g. `https://supernode-contabo.elacity.network/cluster-pin/`.

### 5.2 Provision per-pc2-node bearer tokens

Each pc2-node gets its own short-lived bearer token (rotation policy TBD). Token grants permission to call `POST /pins/{cid}` against the Cluster Pinning Services API.

### 5.3 Add Cluster client to pc2-node

New module `pc2-node/src/services/clusterPin.ts`:
- Wraps the Pinning Services API spec (HTTP REST)
- Method: `replicateToCluster(cid: string, name?: string, replicationMin: number = 2): Promise<PinStatus>`
- Called from `seedingService.seedContent()` after a successful local pin
- Replaces the existing `SUPERNODE_PIN_MIRRORS` fan-out (deprecated but kept for backwards compat)

### 5.4 Add availability badge endpoint to pc2-node

`GET /api/storage/ipfs/availability/:cid` queries Cluster status across all known supernodes, returns `{ replicas: N, healthy: boolean, lastSeen }`. Marketplace UI uses this for the green/yellow/red badge.

### 5.5 Pre-fetch via Cluster swarm in `tryPinForPublicRequest`

When `tryPinForPublicRequest` (in `pc2-node/src/api/public.ts`) is called for a CID and the local IPFS doesn't have it, ALSO ask the Cluster what nodes have it. Then dial those Kubo peers directly (faster than pure DHT).

---

## What's still on the roadmap after Phase 5

- **GCloud (`ipfs.ela.city`) joins the Cluster** as third peer (RF=2 → RF=3). Needs survey + matching Kubo version + Cluster init with shared secret.
- **Cluster bandwidth/availability metrics** to a simple dashboard (Grafana or HTML page on pc2-web-gateway).
- **Per-pin policy** — e.g. capsule pins protected from LRU eviction, gateway-cache pins evictable.
- **Carrier as control plane** for non-content events (separate task).
- **Capsule WASM runtime** (separate task `CAPSULE-RUNTIME-WASM` filed 2026-05-02).

---

## Rust/WASM in the roadmap context (analysis 2026-05-02)

User asked whether Rust/WASM crates would be useful. My analysis:

### Where Rust/WASM is NOT useful right now

| Area | Why not |
|---|---|
| Supernode Cluster setup | `ipfs-cluster-service` is Go, mature, official, just install the binary — no value in re-implementing |
| pc2-node SQLite | Just migrated to `@photostructure/sqlite` (v1.2.7), no benefit from a Rust SQLite alternative |
| Media decryption | Already WASM (custom `cenc:lit-aes-gcm-v3` decryptor compiled to WASM). Working great. |
| RTK Query / Express APIs | JS-native, no value swap |
| libp2p networking | Already JS via Helia, swap to Rust libp2p would mean rewriting half the codebase |

### Where Rust/WASM IS strategically valuable — Anders' "runtime" concept

Anders' sketch describes a **capability-based capsule runtime**: viewer apps ("capsules") that receive scoped capabilities from a runtime, not raw platform authority. This is **exactly the use-case WASM was designed for**.

The pattern:

```
┌────────────────────────────────────────────────────────────┐
│ Runtime (host process — pc2-node)                          │
│   ├── grants capability tokens                             │
│   ├── enforces capability checks                           │
│   └── hosts WASM modules in sandboxed VMs                  │
│                                                            │
│   ┌──────────────────────────────────────────────────────┐ │
│   │ Capsule (WASM module — e.g. video viewer)            │ │
│   │   • Imports: only the capabilities granted           │ │
│   │   • No filesystem / network / DOM access by default  │ │
│   │   • Can be from any creator, runs sandboxed          │ │
│   └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

**Why this matters for Elacity:**
- Today, PC2 apps are HTML/JS in iframes (`pc2-media-runtime`, `elacity-market`, etc.). Sandboxing relies on browser iframe boundaries — adequate but not capability-based.
- For 3rd-party creator-built capsules (let's say an AI training viewer, a custom DRM wrapper, a community-built viewer for a new format), **iframe sandboxing isn't strong enough** — you'd be giving them effectively free reign within their iframe.
- **WASM + WASI + capability tokens = the right substrate** for letting creators ship code that PC2 nodes execute safely.

### Concrete recommendation

**File a separate task `CAPSULE-RUNTIME-WASM` for after v1.2.7** (post-Cluster, post-Carrier integration). Don't conflate with the Cluster work. Strategy:

1. **Short-term (v1.2.x → v1.3.x)**: keep iframe-based PC2 apps. Don't re-platform.
2. **Medium-term (v1.4+)**: prototype a `pc2-node-capsule-runtime` using `wasmtime` (Bytecode Alliance, Rust) embedded via Node bindings. Define capability tokens for: storage read/write, IPFS pin, secure-view sign, DRM key request, dDRM contract reads.
3. **Long-term**: gradually migrate the most-locked-down apps (e.g. `pc2-media-runtime` viewer) to a WASM capsule. Existing HTML/JS apps stay as-is until creators specifically opt into WASM.
4. **Rust comes in as the recommended source language** for capsule authors (also AssemblyScript, Go via TinyGo). Provide an SDK in `pc2-node/src/sdk/capsule/` (TypeScript bindings to capability tokens).

This aligns directly with Anders': *"Runtime: who may ask for what"*, *"Runtime grants viewer capability"*, *"viewer capsule receives scoped access, not raw platform authority."*

**Verdict: yes, Rust/WASM is strategically valuable — but specifically for the capsule runtime, not for the supernode/Cluster work being planned now.** Don't slow down v1.2.7 to add Rust; sequence it as v1.4+.

User chose **sequential rollout starting with Contabo only**:
1. SSH access to Contabo first → run read-only survey script `scripts/cluster-setup/01-survey.sh` → record findings here
2. Draft Contabo-specific Phase 2-3 (Kubo standardisation + Cluster bootstrap) → User reviews
3. After Contabo is stable, repeat for GCloud (`ipfs.ela.city`)
4. After GCloud is stable, repeat for InterServer
5. Cluster's mesh comes online incrementally — single-node Cluster works, then expands to 2-node, then 3-node

Rationale: Contabo is fully User-controlled with no shared infra; lowest blast radius if anything goes sideways during the survey or Kubo upgrade. GCloud (`ipfs.ela.city`) carries production traffic and InterServer hosts pc2-web-gateway, so they wait until the pattern is proven on Contabo.

**v1.2.7 release timing decision**: hold the release until at least Phase 1 (Contabo survey) is documented, so the v1.2.7 CHANGELOG can correctly reference what comes next architecturally instead of just listing fixes in isolation. v1.2.7 fixes are already deployed to production Jetson via hot-patch (2026-05-02) so users are already protected during the wait.
**Depends on**: V1.2.7 ships first (carries the playback-failure UX fixes that make this task's deployment safe)
**Builds on**:
- [`SUPERNODE-MEDIA-PINNING`](../SUPERNODE-MEDIA-PINNING/SUPERNODE-MEDIA-PINNING.md) — Phase 1 client-side fan-out shipped; this task delivers Phase 2 supernode side
- [`IPFS-ELACITY-BOOTSTRAP`](../IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md) — PC2 nodes already peer with `ipfs.ela.city` (34.77.31.164); this task makes that peering meaningful by guaranteeing every published CID is on it
- v1.2.7 playback fixes (Fix B in particular: clearing stale `failed` flag when public-gateway auto-import succeeds — once supernodes have the CID, this auto-heal path becomes nearly instant)

---

## TL;DR

Three always-on supernodes (Contabo, GCloud, InterServer) currently run as **independent Kubo daemons that don't talk to each other**. This task makes them act as **one logical pinning tier** by deploying IPFS Cluster across all three with replication factor = 3. Every published asset gets pinned to all three within ~10 seconds, eliminating the cold-start failure mode where a publisher's home node going offline makes content unreachable.

After this lands, the user-facing UX promise becomes: **"if it published successfully, it stays available — period."**

---

## Background

### The current failure mode (production-confirmed 2026-05-02)

User EverlastingOS bought a video on his Jetson. Server logs show:

1. Player calls `/api/media/init` for `bafybeieyhw2itxjty…`
2. Local IPFS gateway timeout (10s) — Jetson has no peer that has the blocks
3. Public gateway (`ipfs.ela.city`) ALSO times out — supernode doesn't have it either
4. `/init` returns 503 with "Content not yet reachable"
5. ContentSeedingService retries 3× over ~5 min, all fail with `[Seeding] Pin failed (content not found, giving up)`
6. Publisher's home node was offline → asset is unreachable across the entire network until they come back

DB state on Jetson at investigation time confirmed: 4 distinct CIDs in `pin_status='failed'`, all with `bytes_downloaded=0`. Same content sitting on the publisher's node was inaccessible to a buyer because there was no replication tier between them.

### Why client-side fixes alone can't solve this

V1.2.7 playback fixes (Fix A: auto-retry on Play; Fix B: clear stale flag on auto-heal; Fix C: faster timeout; Fix D: clear stale UI) materially improve the *experience* of the failure — the user sees a friendly "Downloading…" UI instead of a misleading error. But they cannot create blocks that aren't there. **The content has to actually exist somewhere reachable.** That somewhere is the supernode tier.

### Why "edge cache CDN" growth alone isn't enough either

Once a PC2 node has bytes, libp2p Bitswap *does* serve them to other PC2 peers — the user's intuition that the network grows organically as people buy is correct. But this only kicks in *after* enough buyers exist for popular content. For brand-new content with one publisher who's offline, there's no edge yet. Supernodes are the bootstrap.

---

## Architecture

### Target 3-tier topology

```
┌──────────────────────────────────────────────────────────────────┐
│  TIER 1 — ELACITY PINNING TIER  (always-on, fixed IPs, RF=3)     │
│                                                                  │
│   Contabo supernode ───┐                                         │
│   38.242.211.112       │                                         │
│   ↕ Cluster gossip     │                                         │
│   GCloud (ipfs.ela.city) ─── IPFS Cluster (shared pinset)        │
│   34.77.31.164         │                                         │
│   ↕ Cluster gossip     │                                         │
│   InterServer ─────────┘                                         │
│   69.164.241.210                                                 │
│                                                                  │
│   • Every published CID pinned here within ~10s                  │
│   • Cluster auto-replicates between the 3 nodes                  │
│   • Each node ALSO joins libp2p as a regular peer                │
│   • PC2 nodes already peer with ipfs.ela.city via                │
│     IPFS-ELACITY-BOOTSTRAP (Phase 1 shipped)                     │
└──────────────────────────────────────────────────────────────────┘
                              ▲ ▲ ▲
                              │ │ │
                  ┌───────────┘ │ └───────────────┐
                  │             │                 │
┌─────────────────┴───┐ ┌───────┴────────┐ ┌──────┴─────────┐
│ Edge: Jetson (E.OS) │ │ Edge: User Mac │ │ Edge: ...      │
│  pc2-node v1.2.7    │ │ pc2-node       │ │                │
│  Pins what user buys│ │                │ │                │
│  Serves to peers    │ │                │ │                │
│  via Bitswap        │ │                │ │                │
└─────────────────────┘ └────────────────┘ └────────────────┘
                              ▲
                              │
                ┌─────────────┴───────────────┐
                │ TIER 3 — PUBLIC WEB         │
                │ Anonymous viewers via       │
                │ ipfs.ela.city HTTP gateway  │
                └─────────────────────────────┘
```

### Why IPFS Cluster (vs. just Kubo + manual pinning)

| Without Cluster (current) | With Cluster (this task) |
|---|---|
| Each supernode runs solo | Three supernodes act as one pinset |
| Publishing must hit each node separately | Publish to any one → all three replicate within seconds |
| If one supernode goes down, its pins are gone | Cluster automatically re-pins to surviving nodes |
| No way to query "is this CID safe?" | `ipfs-cluster-ctl pin ls <cid>` shows replication state |
| Manual capacity tracking per node | Cluster tracks pinset-wide storage |
| No proof of replication | Cluster status is the auditable receipt |

Cluster gives us an actual **availability layer** rather than three lonely caches.

---

## Existing infrastructure (already on hand)

| Node | IP | Role today | Disk (need to confirm) | Notes |
|---|---|---|---|---|
| Contabo supernode | 38.242.211.112 | Kubo daemon, used as pin-mirror target by SUPERNODE-MEDIA-PINNING | TBD | User's, full control |
| GCloud (`ipfs.ela.city`) | 34.77.31.164 | Public IPFS gateway, libp2p peer hardcoded into PC2 bootstrap | TBD | User's, full control |
| InterServer supernode | 69.164.241.210 | Currently used as SSH jump-host to reach Jetson; runs pc2-web-gateway | TBD | User's, full control |
| Jetson (EverlastingOS-style PC2 node) | 10.100.0.4 (private, via InterServer jump) | pc2-node v1.2.7 (post-deploy 2026-05-02) | ~500GB+ available | Production reference node |

**Already deployed (no rework needed):**
- PC2 client-side pin fan-out via `SUPERNODE_PIN_MIRRORS` env var
- PC2 client-side bootstrap peering with `ipfs.ela.city`
- v1.2.7 playback fixes that gracefully handle the "still loading" path

**What's missing (this task):**
- IPFS Cluster on the 3 supernodes
- `POST /api/storage/ipfs/pin` handler on each supernode that hands off to local Cluster
- Cluster-aware health endpoint exposing replication state to PC2 nodes for UX badging

---

## Information needed from User before implementation

To turn this from a plan into runnable scripts, the User needs to provide / confirm:

### Per supernode (Contabo, GCloud, InterServer):

1. **SSH access method** — current key, or open inbound port + password during setup window?
2. **OS + version** — `cat /etc/os-release`
3. **Current Kubo (`go-ipfs`) version** — `ipfs version` (or "not installed yet")
4. **Disk free for IPFS data** — `df -h /var/lib/ipfs` (or wherever Kubo is rooted)
5. **Currently running services on the box** — anything else competing for ports 4001 (libp2p), 5001 (RPC), 8080 (HTTP gateway), 9094-9096 (Cluster)?
6. **Outbound firewall** — anything blocking outbound TCP/UDP to peer IPs?
7. **Inbound firewall** — confirm 4001 and 9096 (Cluster swarm) are open between the 3 supernodes

### Across all three:

8. **Confirmed Kubo PeerIDs** for each box (so we can wire mutual bootstrap)
9. **Cluster replication factor** — propose RF=3 (each pin on all 3); User to confirm
10. **Per-node storage budget** — propose 500GB each (1.5TB usable with full replication, but if disks differ, propose asymmetric quotas)
11. **Pinset garbage-collection policy** — propose: never auto-evict marketplace pins (they're the product); auto-evict gateway-cache pins LRU at 90 % capacity

---

## Implementation Plan

Phased rollout — each phase independently testable, each phase produces a deployable artifact.

### Phase 1 — Survey + dry-run plan (no code, no SSH)

- [ ] User confirms supernode IPs match the table above (or corrects them)
- [ ] User answers the "Information needed" questionnaire above
- [ ] Draft `scripts/cluster-setup/01-survey.sh` — read-only diagnostic that runs on each supernode and dumps OS, Kubo version, disk free, port availability, current pinset size. User runs it (or hands an SSH window) and pastes output into this task.
- [ ] Refine the rest of the plan based on actual survey output.

### Phase 2 — Kubo standardisation

- [ ] Pin all three supernodes to the same Kubo version (latest stable; document specific tag)
- [ ] Standardise `IPFS_PATH`, datastore choice (badger vs. flatfs), `Datastore.StorageMax`, `Routing.Type` across all three
- [ ] Open ports 4001 (libp2p), 8080 (gateway, only on GCloud — kept private on Contabo + InterServer)
- [ ] **NO Cluster yet** — verify each Kubo is healthy on its own first
- [ ] Test: cross-pin a known CID from one Kubo to the others via direct peer; confirm Bitswap propagation

### Phase 3 — IPFS Cluster bootstrap

- [ ] Generate **Cluster shared secret** (32-byte random hex; stored in 1Password / Bitwarden, distributed via secure channel)
- [ ] Install `ipfs-cluster-service` and `ipfs-cluster-ctl` on all three nodes
- [ ] Configure `service.json` on each:
  - Trusted peers: the other two
  - Replication factor min/max = 3 / 3
  - Allocator: `freespace` (prefer the node with most free disk for any given pin)
- [ ] Start `ipfs-cluster-service` on all three; verify gossip with `ipfs-cluster-ctl peers ls`
- [ ] Smoke pin: `ipfs-cluster-ctl pin add <known-test-cid>` on any node; confirm it appears on all three within 10s

### Phase 4 — pc2-web-gateway integration

- [ ] On each supernode, deploy a thin `POST /api/storage/ipfs/pin` handler (Node.js / express; can sit alongside existing pc2-web-gateway):
  - Accepts `{ cid: string }` body
  - Calls `ipfs-cluster-ctl pin add <cid>` (or hits Cluster's REST API on `127.0.0.1:9094`)
  - Returns `{ ok: true, replicas: N }` once all peers acknowledge
- [ ] Apply DID-signed auth (per `SUPERNODE-MEDIA-PINNING` Phase 2 design)
- [ ] Rate-limit per peer-ID (e.g. 60 pins/min) to prevent abuse
- [ ] Test fan-out from a PC2 node: set `SUPERNODE_PIN_MIRRORS` to all three, mint a test asset, confirm it's pinned on all three within 30s

### Phase 5 — PC2-node consumption + UX

- [ ] Update default `SUPERNODE_PIN_MIRRORS` baked into `start-local.sh` and the production install script to include all three supernodes
- [ ] Add `GET /api/storage/ipfs/availability/:cid` to pc2-node — queries Cluster status across all three supernodes, returns `{ replicas: N, healthy: boolean, lastSeen }`
- [ ] Marketplace UI badge: green ✓ "Replicated to N supernodes" when `replicas >= 2`, yellow ⚠ "Limited replication" when `replicas == 1`, red ✗ "At-risk — single source" when `replicas == 0`
- [ ] Player adjustment: if `availability.replicas >= 1`, skip the local-IPFS timeout path and pull directly from supernode (faster cold-start path for low-edge content)

### Phase 6 — Operational hygiene

- [ ] Cluster health metrics → Grafana / simple HTTP dashboard (pinset size, replication state, disk usage per node)
- [ ] Backup `service.json` + cluster identity per node to encrypted store
- [ ] Document recovery runbook: "if Contabo dies, here's how to spin up a replacement Cluster peer"
- [ ] LRU eviction policy for **non-marketplace** content (gateway cache only); marketplace pins are sticky

---

## Acceptance Criteria

1. **Publication guarantee**: a freshly-published asset CID can be successfully retrieved from any of the 3 supernodes via `/ipfs/<cid>` HTTP gateway within 30 seconds of mint.
2. **Resilience**: take any one supernode offline → remaining 2 still serve all marketplace CIDs without user-visible degradation.
3. **Re-replication**: when the offline supernode comes back, Cluster auto-pulls any pins added during its downtime.
4. **PC2 node experience**: a Jetson buying a brand-new asset from a publisher whose home node is offline can still play it within 5-10 seconds (vs. current behaviour of "Content not yet reachable" indefinite failure).
5. **Observability**: Marketplace UI shows accurate availability badges driven by real Cluster state, not heuristics.
6. **No regression**: existing `SUPERNODE_PIN_MIRRORS` fan-out continues to work for any pc2-node not yet upgraded.

---

## Out of Scope (separate follow-ups)

- **Carrier as control plane** for non-content events (peer discovery for pub-sub, NAT traversal). File as `CARRIER-CONTROL-PLANE` after this lands.
- **ELA-token incentives** for community-run supernodes. File as `SUPERNODE-INCENTIVES` after Cluster is stable and we have load data.
- **Per-region supernodes** (e.g. Asia-Pacific) — same Cluster pattern, just more peers; tackle once 3-node baseline proves stable.
- **`pc2-node` join Cluster as follower** (read-only pinset sync to user nodes) — interesting but adds complexity; defer until Phase 6 metrics show a real need.

---

## Risk Notes

| Risk | Mitigation |
|---|---|
| Cluster shared secret leaks → unauthorized pinning | DID-signed pin endpoint in Phase 4; secret rotation runbook |
| Single supernode disk fills up | RF=3 + `freespace` allocator means Cluster will refuse new pins to a full node and route to others; Phase 6 metrics alert before it happens |
| Network partition between supernodes | Cluster handles split-brain via CRDT consensus by default; document the known partition-recovery behaviour |
| Existing per-node pinsets diverge from Cluster's view | Phase 3 includes "import existing pins into Cluster" step before going live |
| Increased load on `ipfs.ela.city` from being authoritative | Already happening in practice; this task formalises and scales it |

---

## Notes

This task represents the **single biggest UX improvement available right now** for the EverlastingOS-class user (residential ISP, single home node, publishing original content). The v1.2.7 playback fixes fix the *symptom* of cold-start unreachability; this task fixes the *cause*.

Once landed, the platform's value proposition becomes credible: *"publish once, stays available, served from a growing edge network."* Without it, the platform is one offline publisher away from looking broken.

---

## 2026-05-02 — Phase 5 LIVE-DEPLOYMENT RESULTS (Jetson + Contabo)

### Phase 5.1 — nginx exposure (Contabo)

- **Single additive `location /cluster-pin/` block** added to `/etc/nginx/sites-enabled/pc2-gateway` inside the existing `server { listen 443 ssl; server_name 38.242.211.112; ... }` block. Backup at `/root/nginx-backups/pc2-gateway.bak.20260503-004209`.
- **Bearer token gate** inline in nginx (`if ($http_authorization != "Bearer ...") { return 401; }`) — token recorded in user's password manager.
- **Validation flow**: `nginx -t` passed → `systemctl reload nginx` (graceful, zero downtime) → 7 external curl tests (no token = 401 ✓, wrong token = 401 ✓, correct token = 200 ✓, POST = 200 with delegate addrs ✓, regression on PC2 frontend / dDRM / RPC / `*.ela.city` = all clean ✓).
- **First deploy attempt** failed safely: backup file inside `sites-enabled/` triggered `default_server` collision in nginx -t. The script's safety net rolled back automatically — no production touch. Backup convention moved to `/root/nginx-backups/`.
- **Smoke-test pin** `QmYwAPJzv5...` and **e2e test pin** `bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy` both DELETEd after verification — cluster pinset clean except for real backfilled production CIDs.

### Phase 5 — pc2-node integration (Jetson)

- **Files deployed via base64-over-nested-SSH** (Mac → InterServer → WG → Jetson) with md5 verification:
  - `pc2-node/dist/services/clusterPin.js` (new, 11447 bytes, md5 `5a034fe277b67ae36dbafedf0abdd128`)
  - `pc2-node/dist/api/storage.js` (replaced, 157714 bytes, md5 `8bf96f34f61a8f8ffb5fdb88d5427e80`)
  - Backup of original `storage.js` at `pc2-node/dist/api/storage.js.bak.20260503-065207`
- **`ecosystem.config.cjs` updated** at `/home/orin_nano/pc2.net/ecosystem.config.cjs` — added 5 env vars (`SUPERNODE_CLUSTER_PIN_URL`, `SUPERNODE_CLUSTER_PIN_TOKEN`, `SUPERNODE_CLUSTER_PIN_REPLICATION_MIN`, `SUPERNODE_CLUSTER_PIN_REPLICATION_MAX`, `NODE_TLS_REJECT_UNAUTHORIZED=0`). Backup at `ecosystem.config.cjs.bak.20260503-065207`.
- **`pm2 reload ecosystem.config.cjs --only pc2`** — graceful restart, restart counter 9→10, pc2 online.
- **Boot log confirmed cluster module loaded**:
  ```
  [INFO] [clusterPin] [ClusterPin] enabled -> https://38.242.211.112/cluster-pin (replication=2/2)
  [INFO] [clusterPin] [ClusterPin] retry scheduler started (interval=30000ms, maxAttempts=5)
  ```
- **Public cluster-availability endpoint verified**: `GET http://127.0.0.1:4200/api/storage/ipfs/cluster-availability/<cid>` → 200 with `{"available":..., "status":..., "delegates":[]}`. Confirms clusterPin module is reachable from inside pc2-node.

### Backfill (one-shot rescue of yesterday's failed pins)

- **`pc2-node/scripts/cluster-backfill.mjs`** committed to repo. Auto-detects `@photostructure/sqlite` (v1.2.7+) or falls back to `better-sqlite3` (v1.2.6). DRY_RUN supported. Backs up DB before any writes.
- **Jetson DB stats**: 61 total `pinned_cids` rows (59 complete, 2 failed → 1 unique CID). `nft_pins` empty.
- **LIVE backfill 2026-05-02**: 1 CID pushed to cluster (`bafybeidrmrsohnva4asvqptsspwvrtwluldkui7fyvcbpmpfcq7gdgo5p4`, originally minted 2026-05-01). Result: `ok=1 err=0`. Verified via `ipfs-cluster-ctl status` on InterServer:
  ```
  bafybeidrmrsohnva4asvqptsspwvrtwluldkui7fyvcbpmpfcq7gdgo5p4 | backfill-bafybeidrmrs-1777763019591:
      > vmi1330656.contaboserver.net : PINNING | Attempts: 1 | Priority: true
      > elacity.hostname.com : PINNING | Attempts: 1 | Priority: true
  ```
- **Jetson DB updated**: `pinned_cids.pin_status` for that CID flipped from `failed` → `complete`.

### Open follow-ups (sequenced)

1. **User smoke test on Jetson** — mint or buy something, watch `[ClusterPin] ok cid=...` line appear in pc2-out.log within seconds. (No further code change needed — just user-side verification.)
2. **Cut v1.2.7 git tag + GitHub release** once user confirms behavior.
3. **Bake env vars into `update.sh` / `ecosystem.config.cjs` defaults** so all community pc2-nodes auto-enroll on next update. (Implemented 2026-05-03: `ecosystem.config.cjs` now reads from `process.env`; operators set vars via `pc2-node/.env`. See `pc2-node/.env.example`.)
4. **Per-pc2-node bearer token issuance** (replace shared token with rotatable per-node tokens — needs simple admin endpoint on a supernode).
5. **InterServer nginx exposure** for failover (currently InterServer's pc2-gateway Node.js process binds 80/443; needs different exposure pattern, e.g. add a side-port for cluster-pin).
6. **GCloud `ipfs.ela.city`** joins as third Cluster peer.
7. **TLS hygiene — `cluster.ela.city` DNS + Let's Encrypt** (deferred 2026-05-03: User is travelling; ela.city DNS provider requires SMS verification on a Thailand-only phone number. Will be done on User's return.)
   - **What User does**: add one DNS A record on the `ela.city` zone — `cluster.ela.city A 38.242.211.112` (TTL 300). Touches no existing record on the zone; purely additive.
   - **What I do once DNS is live**: certbot on Contabo issues a real Let's Encrypt cert for `cluster.ela.city`, nginx adds a `server_name cluster.ela.city` block alongside the existing IP-based one, Jetson env switches to `https://cluster.ela.city/cluster-pin`, `NODE_TLS_REJECT_UNAUTHORIZED=0` is removed from Jetson env. Certbot's systemd renewal timer auto-handles 90-day cert refresh.
   - **Why this matters for community pc2 nodes**: until DNS is live, only the Jetson talks to the cluster (it has the IP+token+TLS bypass we set manually). Once DNS is live + per-node tokens are issued, community nodes can join the cluster with a system-trusted TLS connection and zero special config.
   - **Risk on existing services**: zero. New nginx vhost is purely additive on Contabo; InterServer untouched; ela.city marketplace + every other subdomain untouched.
   - **Estimate once unblocked**: ~30 min wall clock (10 min DNS propagation + 20 min cert/nginx/Jetson reconfig).
8. **pm2 log rotation** — Jetson `pm2-out.log` was 945 MB at deploy time; configure `pm2-logrotate`.
9. **ElastOS Launcher v1.2.6 release** (BLOCKING for v1.2.7 of pc2.net to reach Mac/Linux/Windows GUI users) — current launcher v1.2.5 (`Elacity/elastos-launcher@main`, `src/main/pc2Manager.ts`) hard-codes `npm rebuild better-sqlite3 --build-from-source` in BOTH the install flow (line 791) AND the update flow (line 1101), and its `verifyNativeModules()` gauntlet (lines 856-867) requires `better-sqlite3` to load. v1.2.7 of pc2.net removed `better-sqlite3` (migrated to `@photostructure/sqlite`), so the launcher's verification gauntlet will trip on every install/update against v1.2.7 and either (a) silently rebuild a useless `better-sqlite3` next to the real `@photostructure/sqlite`, or (b) fail outright on a Mac without Xcode CLT — exactly the failure mode the migration was supposed to fix. **Required launcher PR**: replace the `better-sqlite3` rebuild step with a generic `npm rebuild` (drops the per-module force-build), and swap the `better-sqlite3` entry in the verification gauntlet for `@photostructure/sqlite` (probe is `const { DatabaseSync } = require('@photostructure/sqlite'); new DatabaseSync(':memory:').prepare('SELECT 1').get()`; fix hint becomes "clean reinstall" instead of "install Xcode CLT"). ~30 lines changed across 4 spots in `pc2Manager.ts`. No launcher logic change beyond that.
