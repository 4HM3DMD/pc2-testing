# Supernode Capability Assessment — RPC, IPFS, CDN

> **Purpose:** Map what the existing supernode mesh can do today, what
> it's missing for RPC proxying and Elacity IPFS pinning, and how both
> converge with Anders' `elastos-runtime` roadmap.
> **Created:** 2026-04-29
> **Status:** Assessment — no changes made to live supernodes
> **Related:**
> [SUPERNODE_ECONOMICS.md](./SUPERNODE_ECONOMICS.md),
> [ARCHITECTURE_CONVERGENCE.md](./ARCHITECTURE_CONVERGENCE.md),
> [ROADMAP.md](./ROADMAP.md),
> [`.cursor/tasks/SUPERNODE-RPC-PROXY/SUPERNODE-RPC-PROXY.md`](../../.cursor/tasks/SUPERNODE-RPC-PROXY/SUPERNODE-RPC-PROXY.md),
> [`.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md`](../../.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md)

---

## 1. Executive Summary

The mesh is already in better shape than Irzhy's and the user's recent
RPC / pinning pain suggests. All four supernodes answer the gateway API,
`Elacity Flagship` (InterServer) and `Elacity Contabo` both serve
`app.ela.city` / `gateway.ela.city` / `creator.ela.city` /
`market.ela.city` under the existing `*.ela.city` Let's Encrypt cert,
and the two "Boson Network" nodes (`155.138.245.211`, `45.32.138.246`)
participate in the mesh but do not expose user-facing HTTPS.

Three concrete things are achievable **without any architectural
rewrite and without disturbing live traffic**:

1. **Base / ESC RPC proxy on InterServer + Contabo** — one extra
   `nginx` site + one Alchemy/Infura key per node. Ships the
   `SUPERNODE-RPC-PROXY` task. Purely additive; the existing gateway
   service is untouched.
2. **Elacity IPFS reverse-peering** — pair the Contabo/InterServer
   gateways with `ipfs.ela.city` (Kubo 0.24.0, which is already public)
   via the `ELACITY_IPFS_MULTIADDRS` path in
   `IPFS-ELACITY-BOOTSTRAP`. No new daemon needed on the supernodes;
   PC2 nodes dial Elacity's Kubo directly. Same pattern as Anders'
   `elastos setup --with kubo --with ipfs-provider`.
3. **Pinning-as-a-service on the supernodes** — this is the one net-new
   service, but it's a thin authenticated wrapper around `ipfs.ela.city`
   or a small Kubo sidecar. Worth prototyping on one of the Boson
   nodes first (they have no user-facing traffic to risk).

All three map cleanly to the **Tier 1 / Tier 2 capsule model** Anders
is building in `elastos-runtime`: each service becomes a signed capsule
with an explicit capability, which is exactly the shape
`SUPERNODE_ECONOMICS.md` Phase 5 already anticipated.

---

## 2. Current Supernode State (from public probes, 2026-04-29)

SSH from this environment is blocked by fail2ban, so everything below
was derived from public HTTP, DNS, TLS and TCP probes only. No changes
were made.

### 2.1 Mesh Topology

From `https://69.164.241.210/api/supernodes` and `…/38.242.211.112/…`
(both return the same list, cross-consistent):

| Name | IP | Region | Provider | User-facing HTTPS | Mesh (8090) | SSH |
|---|---|---|---|---|---|---|
| Elacity Flagship | `69.164.241.210` | US | InterServer | **yes** (443) | yes | yes |
| Elacity Contabo | `38.242.211.112` | EU | Contabo | **yes** (443) | yes | yes |
| Boson Network 1 | `155.138.245.211` | US | Vultr | no | yes | yes |
| Boson Network 2 | `45.32.138.246` | US | Vultr | no | yes | yes |

Every node advertises `port: 39001` (Boson / Carrier P2P) and
`proxyPort: 8090`. Boson nodes are mesh-only — they have no TLS
listener and no public gateway, which is the right posture for "pure
relay" nodes.

### 2.2 What Each Flagship Node Serves

- `https://69.164.241.210/` → `gatewayId: gateway-1`, registry 107 apps,
  uptime 5.5 h, cache hit rate 7.9 % (recently restarted), `supernodes: 4`,
  `wireguard.peers: 27`.
- `https://38.242.211.112/` → `gatewayId: gateway-1`, registry 83 apps,
  uptime 30 h, cache hit rate 89.3 %, `supernodes: 4`,
  `wireguard.peers: 2`.

Both have the `ElastOS – Personal Cloud` dashboard as their default
vhost (Puter fork, with the `api.puter.com` → local origin WebSocket
interceptor). Both answer `app.ela.city`, `gateway.ela.city`,
`creator.ela.city`, `market.ela.city`, `dashboard.ela.city`,
`puter.ela.city` — all resolve to `69.164.241.210` in current DNS.

### 2.3 Services Running (from `deploy/supernode-bootstrap.sh` + V1.2 A4)

| Service | Port(s) | Purpose |
|---|---|---|
| `nginx` | 80 / 443 | TLS termination, vhost routing |
| `pc2-web-gateway` | 4500 (loopback) | Express/Node API + registry + WG orchestration |
| `pc2-ipfs-relay` | — (libp2p) | Custom libp2p circuit-relay-v2 |
| `kubo` (from V1.2 A4) | **4101/tcp (swarm, public)**, 5101 (loopback admin) | **Full Kubo daemon, `routing=dhtserver`, `MemoryMax=2G` / `StorageMax=8G`** — already pinning the 6 v1.2 capsule CIDs. External gateways (ipfs.io, pinata) resolve these via DHT provider records. |
| `pc2-app-registry` | 4510 (loopback) | App catalog mirror |
| `pc2-vless-reality` | 8443 | Stealth proxy (censorship bypass) |
| `wg-quick@wg0` | 51820/udp | WireGuard tunnel |
| `awg-quick@awg0` | 51821/udp | AmneziaWG (obfuscated WG) |
| Boson carrier | 39001/udp | Libp2p mesh transport |
| Mesh proxy | 8090/tcp | Authenticated peer-to-peer tunnel |

**Correction from the 2026-04-29 morning pass of this document:** the
earlier note that "there is no Kubo on the supernodes" was wrong. The
V1.2-PRE-RELEASE A4 work (commit `584bb035b`, 2026-04-23) installed
Kubo 0.24.x on both InterServer and Contabo on swarm port 4101 (4001
was already claimed by the older libp2p relay). Port probes confirm
4101 is open on both flagship supernodes. **Pinning infrastructure
exists; it is just only currently used for signed capsule CIDs, not
for marketplace media CIDs — that's the gap Irzhy's playback failure
on 2026-04-28 surfaces.**

The supernodes therefore give us three layers of pinning today: user's
local Helia, our two supernode Kubo daemons (InterServer + Contabo),
and Elacity's `ipfs.ela.city` Kubo on GCP. All three speak bitswap and
participate in the DHT. What's missing is the glue that propagates
marketplace-minted CIDs into layers 2 and 3 automatically.

### 2.4 Elacity Front-End Infrastructure (DNS, for context)

These are **not** on our VPS supernodes — they're hosted by Elacity on
Google Cloud, so we don't control them directly:

| Host | IP | Infra | Notes |
|---|---|---|---|
| `ela.city` | `35.205.174.216` | GCP | Main marketplace frontend |
| `api.ela.city` | `35.205.174.216` | GCP | Marketplace backend |
| `ipfs.ela.city` | `34.77.31.164` (cdn) | GCP + Cloudflare-like CDN | **Public Kubo 0.24.0 read gateway** |
| `rpc.ela.city` | `34.147.212.166` | GCP | **Currently unreachable (HTTP=000) — DNS points to a dead service** |
| `node.ela.city` / `supernode.ela.city` | `34.142.19.27` | GCP | Currently unreachable |

The `ipfs.ela.city` gateway is live and serves `/ipfs/<cid>` publicly.
`/api/v0/version` is whitelisted for diagnostics; all other Kubo RPC
paths (`/api/v0/pin/add`, `/api/v0/id`, `/api/v0/config/show`, etc.)
are 404'd by nginx — **pinning from outside is correctly gated**. Any
supernode-side pinning path would need an authenticated channel to the
Elacity team's Kubo, not direct public `/api/v0/pin/add` access.

**`rpc.ela.city` has DNS but no live service.** That hostname is
perfect for the `SUPERNODE-RPC-PROXY` task — Elacity already owns the
name; we just need to point it at our supernodes (or stand one up on
the existing GCP host).

---

## 3. RPC Proxy Capability

### 3.1 Feasibility: High (MVP shippable in days, not weeks)

The Elacity flagship supernodes already run nginx + Let's Encrypt with
a `*.ela.city` wildcard cert. Adding a new vhost that terminates and
proxies to Alchemy / Infura is one file:

```nginx
# /etc/nginx/sites-available/pc2-rpc-base
server {
  listen 443 ssl http2;
  server_name rpc.node1.pc2.ela.city;
  include /etc/nginx/snippets/letsencrypt.conf;

  location /base {
    # Auth header injected server-side; never exposed to the client
    proxy_set_header Authorization "Bearer ${ALCHEMY_KEY}";
    proxy_pass https://base-mainnet.g.alchemy.com/v2/;
    proxy_set_header Host base-mainnet.g.alchemy.com;
    proxy_http_version 1.1;
    proxy_connect_timeout 5s;
    proxy_read_timeout 10s;

    # Short cache on eth_call — mirrors what the proxy does today
    proxy_cache rpc_cache;
    proxy_cache_key "$request_body";
    proxy_cache_valid 200 2s;
    proxy_cache_methods POST;
  }
}
```

Matches the flow `handleJsonRpcProxy` in `pc2-node/src/static.ts`
already expects. No daemon to run, no TypeScript to write — all
existing PC2 nodes pick it up via the `BASE_RPC_URLS` ordering.

### 3.2 Known Gaps

1. **We don't hold an Alchemy / Infura account for `*.ela.city`.** This
   is a five-minute signup; Alchemy free tier is 300 M compute units /
   month, which is ~100× current peak demand. Infura free tier is
   similar. One key per supernode for failover is fine.
2. **`rpc.ela.city` DNS exists but points to a dead GCP host.** We
   should decide: (a) repurpose the DNS to round-robin our two
   supernodes, or (b) use a separate `rpc-node1.pc2.ela.city` /
   `rpc-node2.pc2.ela.city` pair. Either works; (b) is cleaner because
   it keeps GCP-hosted services distinct from supernode-hosted ones.
3. **Boson node use** — the two Vultr supernodes could be brought into
   the RPC pool as later fallbacks once a domain pattern is decided,
   but they currently have no TLS. Not blocking for MVP.

### 3.3 Risk to Live Traffic: Zero

nginx `include /etc/nginx/sites-enabled/` drops in new vhosts without
touching existing `pc2-gateway`. The add can be done with
`ln -sf` + `nginx -t` + `systemctl reload nginx` (reload, not restart —
no connection loss).

### 3.4 Already Tracked By

[`SUPERNODE-RPC-PROXY`](../../.cursor/tasks/SUPERNODE-RPC-PROXY/SUPERNODE-RPC-PROXY.md)
covers this end-to-end. This assessment confirms its feasibility and
adds the `rpc.ela.city` DNS observation.

---

## 4. IPFS Pinning / CDN Capability

### 4.1 Feasibility: Medium (depends on which design we pick)

There are three distinct goals often conflated under "IPFS on
supernodes":

**A. CDN-style gateway** — serve `/ipfs/<cid>` reads for the community.
**Already solved** by `ipfs.ela.city` (public Kubo 0.24.0). Adding
another gateway on the supernodes is duplication unless we want geo
failover. Low priority.

**B. DHT / relay participation** — so PC2 user nodes can always find
peers that hold the blocks they asked for. **Already solved** by
`pc2-ipfs-relay.service` (libp2p circuit-relay-v2 on every supernode)
plus Helia DHT. What's missing is Elacity's Kubo as a bootstrap peer
in the PC2 node — that's `IPFS-ELACITY-BOOTSTRAP`, not a supernode
change.

**C. Pinning of marketplace-minted CIDs to long-tail CDN** — this is
the thing that maps to "IPFS pinning of assets on Elacity marketplace
for CDN support" and is the concrete production gap that surfaced on
2026-04-28: when one user mints content on their PC2 node and another
user (Irzhy) tries to play it back, neither his local IPFS nor
`ipfs.ela.city` can resolve the CID, because the publisher's libp2p
peer isn't reachable through DHT in time and the public Kubo nodes
don't yet have the blocks.

Three options, ranked by effort:

- **C1. Pin to `ipfs.ela.city` more reliably.** The existing Creator
  flow already POSTs to `https://base.ela.city/api/2.0/files/upload`
  (see `pc2-node/src/api/storage.ts` L2977, L3061, L3178). Either that
  path silently fails for some CIDs, or the upload hits one Kubo and
  the public gateway reads from another. Coordinating with Irzhy to
  confirm the upload-to-gateway propagation contract is the cheapest
  fix and unblocks the immediate symptom. Requires no supernode work
  on our side.
- **C2. Auto-pin marketplace CIDs to our supernode Kubo daemons.**
  These are *already running* on InterServer and Contabo (port 4101,
  see §2.3). What's missing is a thin authenticated `/api/storage/ipfs/pin`
  on each supernode that accepts a CID + DID-signed request and runs
  `ipfs pin add` on the local Kubo via its loopback admin port (5101).
  Then the marketplace mint flow fires three pins in parallel:
  publisher's local Helia, supernode-1, supernode-2. Bitswap +
  `routing=dhtserver` propagation does the rest. This is the work
  that becomes `SUPERNODE-MEDIA-PINNING` (new task, see §7).
- **C3. Self-host a third Kubo behind `ipfs.ela.city`'s GCP load
  balancer.** Out of scope for us — that's Elacity team's call.

C1 is the quickest test (a single Telegram exchange with Irzhy); C2 is
the architectural fix that aligns with sovereignty and gives Elacity a
second-tier safety net.

### 4.2 What Changes on the Supernode for C2

The Kubo daemons exist. The only net-new code is:

1. A new endpoint in `pc2-web-gateway`: `POST /api/storage/ipfs/pin`
   with `{ cid, source: 'marketplace-mint' }`, owner-DID-signed,
   rate-limited per wallet. Translates internally to a call against
   the local Kubo HTTP API (`http://127.0.0.1:5101/api/v0/pin/add?arg=<cid>`).
2. A client call in the marketplace mint flow that, after a successful
   on-chain transaction, fires (in parallel, fire-and-forget):
   `POST https://69.164.241.210/api/storage/ipfs/pin` and
   `POST https://38.242.211.112/api/storage/ipfs/pin`.
3. Optional: a once-per-mint `dial` from the supernode Kubo to the
   publisher's libp2p multiaddr, to kick bitswap directly without
   waiting for DHT. Sugar — DHT propagation works fine, just slower.

Same DID-signed request pattern already in `pc2-web-gateway`. No new
daemons, no port changes, no architectural rewrite.

### 4.3 Risk to Live Traffic

Low. The new endpoint is purely additive. Storage pressure on each
supernode Kubo is bounded by `StorageMax=8G` (already configured). At
average DASH-encoded asset size ~50–500 MB, we get 16–160 assets per
supernode before garbage collection kicks in — a soft limit we measure
and grow as the marketplace scales. If it fills, we add more
supernodes (the very flywheel `SUPERNODE_ECONOMICS.md` is built
around).

### 4.4 Already Tracked By

[`IPFS-ELACITY-BOOTSTRAP`](../../.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md)
covers goal B (PC2 peering with `ipfs.ela.city`).
[`UPLOAD-ELACITY-LOCAL-FIRST`](../../.cursor/tasks/UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md)
already covers C1 (resilient publish flow, parked). Goal C2 is **new**
and lives at
[`SUPERNODE-MEDIA-PINNING`](../../.cursor/tasks/SUPERNODE-MEDIA-PINNING/SUPERNODE-MEDIA-PINNING.md)
(created alongside this update).

---

## 5. Convergence with `elastos-runtime`

The architecture diagram from Anders' `README.md`:

```
Runtime  ← minimal trusted base (signatures, capabilities)
Shell    ← capsule with orchestrator capability
Capsules ← sandboxed apps/providers (WASM · microVM · zero ambient authority)
```

Maps onto our supernode design one-to-one:

| `elastos-runtime` concept | Supernode today | Supernode after capsule runtime V2 |
|---|---|---|
| Trusted base | `nginx` + systemd + DID identity | Same, unchanged |
| Shell | `pc2-web-gateway` + `pc2-app-registry` | Orchestrator capsule with `cap:supernode-orchestrator` |
| Capsule: content | `pc2-ipfs-relay` | `capsule:ipfs-relay` (free tier) |
| Capsule: transport | `pc2-vless-reality`, `wg-quick@wg0`, `awg-quick@awg0` | `capsule:tunnel-wg`, `capsule:tunnel-awg`, `capsule:tunnel-vless` (each token-gated) |
| Capsule: JSON-RPC | (not yet — this assessment) | `capsule:rpc-base`, `capsule:rpc-esc` |
| Capsule: pinning | (not yet — this assessment) | `capsule:ipfs-pin` (token-gated) |
| Capability token | WireGuard shared key (manual) | Access Token (ERC-1155) verified by Lit ACC |
| Signed publisher | `deploy/supernode-bootstrap.sh` (SHA-pinned) | `elastos setup --profile operator` |

### 5.1 What This Means Practically

**Do not build the RPC proxy or pinning service as anything the runtime
will later have to unwind.** Concretely:

1. **Each new service is a systemd unit + a directory under
   `/opt/pc2/capsules/<name>/`**. Anders' capsule runtime will later
   pick up the same layout as a capsule bundle. That's why
   `SUPERNODE_ECONOMICS.md` phase 5 says "Supernode = collection of
   capsules" — we want our current systemd services to be nearly
   literal ancestors of those capsules.
2. **Auth goes through DID + Lit Protocol** from day one, even if the
   early version uses a bearer shared secret. The moment we introduce
   "here's a random API key", we've created a migration debt to the
   capability-token model.
3. **No ambient authority.** The RPC nginx snippet above holds the
   Alchemy key in an env file readable only by the `nginx` user; the
   gateway can't see it, and neither can any capsule we add later.
   Same for Kubo's API socket — loopback-only, explicit authenticated
   proxy in front of it.
4. **`elastos setup --with kubo --with ipfs-provider`** is the same
   shape we'd want to end up with. If we build a pinning service now,
   make sure it can be dropped in by the future `elastos setup
   --profile operator` without a rewrite.

### 5.2 Observable Points of Convergence

- `elastos node ...` commands in the runtime map to our existing
  `/api/supernodes`, `/api/registry/apps`, `/api/health` endpoints.
  Keep those endpoints stable.
- `elastos serve` vs `elastos` — "one live host owner per home" — is
  exactly the posture `pc2-web-gateway` takes. Preserve.
- `/apps/room-browser/` as the hosted room route in the runtime is
  analogous to the `app.ela.city` / `puter.ela.city` dashboard we're
  serving today. Worth mirroring the path name when the dashboard
  lands inside the runtime.
- Content-plane `elastos share` / `elastos open` runs Kubo + ipfs-provider
  out of process — same shape as C2 above. **Anders' path suggests we
  should add Kubo as a sidecar, not fold it into `pc2-web-gateway`.**

---

## 6. Tier-2 Network Services + ELA Utility — Business Model Sketch

`SUPERNODE_ECONOMICS.md` already lays out the three-tier model and the
Access Token revenue split. This assessment only adds pricing-relevant
observations from the probe data.

### 6.1 Current Demand Surface (measured)

From the two flagship gateways' `/api/health`:

- 27 WireGuard peers on InterServer, 2 on Contabo = **29 active
  WG-tier users today**. That's the current paying-tier baseline.
- Registry: 107 and 83 apps respectively (a couple lagging in sync,
  worth a gossip pass but not critical).
- Cache hit rate of 89.3 % on a warm Contabo node suggests the gateway
  is already doing serious work; traffic is there, just not metered.

### 6.2 What an MVP Tier-2 Offer Looks Like (new vs existing)

| Service | Existing | Proposed Tier | Price anchor |
|---|---|---|---|
| Basic gateway + DHT | Free (Tier 0) | Unchanged | N/A |
| WireGuard / AWG tunnel | Free today | Tier 1 Premium Pass | **5 USDC or 50 ELA / month** |
| VLESS Reality stealth | Free today | Tier 1 Premium Pass | same token |
| JSON-RPC (Base / ESC) | N/A | Tier 1 Premium Pass | same token — unlimited reads, rate-limited writes |
| IPFS pinning (MB/month) | N/A | Tier 2 Enterprise | **10 USDC or 100 ELA / month**, 10 GB pin budget, rollover |
| Custom domain (beyond `*.ela.city`) | N/A | Tier 2 Enterprise | same |
| Media + Network bundle | N/A | Tier 3 | **20 USDC or 200 ELA / month** |

The RPC proxy is the lowest-cost addition that still deserves a tier —
it costs us nothing (Alchemy free tier), but the market rate for
Alchemy's "Growth" plan is $199/mo, so "5 USDC/mo gets you an
unmetered RPC endpoint we run ourselves" is a very strong pitch for
dApp developers in the Elastos ecosystem.

### 6.3 Why ELA Utility Works Here

- **Buyback pool:** the 5 % buyback already codified in
  `SUPERNODE_ECONOMICS.md` becomes meaningful once monthly Access
  Token sales exceed a few hundred. At 200 subscribers × 50 ELA =
  10,000 ELA/mo gross flow, 500 ELA/mo buyback is a constant bid.
- **Denomination choice:** let users pay in USDC or ELA at checkout,
  with a 5–10 % discount for ELA. Mirrors what every L1 ecosystem is
  doing and doesn't require us to build swap infrastructure.
- **Supernode ownership:** once the SupernodeOperatorRegistry is live,
  operators stake a nominal ELA bond (e.g., 1,000 ELA) to list their
  supernode in the registry, slashable for attested outages. This
  gives ELA a productive use beyond pure buyback.

### 6.4 Dependencies on Anders' Work

- **Capability tokens** (elastos-runtime) give us the primitive to
  verify "this request carries a valid Tier 1 Access Token" without
  reinventing the wheel. Until that ships, we enforce with Lit ACC +
  DID-signed nonce, which is what the dDRM path already does.
- **Signed capsule bundles** let us publish the supernode service mix
  as a reproducible artifact (`elastos capsule install supernode-full`).
  That's what makes the "Supernode dApp in dApp Center" in
  `SUPERNODE_ECONOMICS.md` Phase 2 actually one-click.

---

## 7. Concrete Next Steps (Zero-Risk First)

### 7.1 Do Now (no code, no disruption)

- [ ] **Confirm `ipfs.ela.city` PeerID with Irzhy.** Needed to close
      `IPFS-ELACITY-BOOTSTRAP` acceptance criterion 1. One Telegram
      message.
- [ ] **Decide `rpc.ela.city` DNS policy.** Either repoint to
      supernode-hosted RPC (we do it, Elacity approves the DNS change),
      or leave the GCP host and pick `rpc-node1.pc2.ela.city` for our
      proxy. This is a conversation, not code.
- [ ] **Sign up for Alchemy Growth (Base) + free Base on Ankr.** Two
      keys, stored in 1Password. No deploy.

### 7.2 Ship Next (one session of work, purely additive)

- [ ] `deploy/app-registry/scripts/install-rpc-proxy.sh` — the nginx
      vhost plus the Alchemy key file. Deploy to InterServer and
      Contabo via existing `deploy.sh` pattern.
- [ ] Add supernode RPC URLs as first two entries in
      `BASE_RPC_URLS` in `pc2-node/src/static.ts` (and its ESC
      equivalent when that daemon lands).
- [ ] [`SUPERNODE-MEDIA-PINNING`](../../.cursor/tasks/SUPERNODE-MEDIA-PINNING/SUPERNODE-MEDIA-PINNING.md):
      authenticated `POST /api/storage/ipfs/pin` on each supernode
      gateway, plus call-site changes in the marketplace mint flow to
      fire pins to both supernodes after a successful mint.
- [ ] [`IPFS-ELACITY-BOOTSTRAP`](../../.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md):
      elevate from Proposed → InProgress; ping Irzhy for canonical
      `ipfs.ela.city` PeerID multiaddr; ship.

### 7.3 Defer Until Runtime V2 Lands

- [ ] Rewrite the existing `pc2-*.service` units as capsule bundles
      mounted under `/opt/pc2/capsules/`. Not worth doing twice.
- [ ] On-chain SupernodeOperatorRegistry + Access Token contracts. The
      `SUPERNODE_ECONOMICS.md` Phase 3 timeline is the right one.
- [ ] ELA bond + slashing. Requires the registry contract first.

---

## 8. Open Questions (Flagged for User / Irzhy)

1. **SSH access from this session is blocked** (fail2ban silently
   drops KEXINIT after TCP handshake, consistent with a persistent
   ban on IP `24.120.55.20`). Please either:
   - SSH in yourself and run the survey bundle in
     `/tmp/ssh_survey.sh` on both nodes, or
   - Whitelist our outbound IP in `/etc/fail2ban/jail.local` `ignoreip`.
   - Nothing in this document depends on the bundle — it's purely for
     confirming exact versions, disk headroom, and whether `kubo` is
     already installed.
2. **Does `rpc.ela.city` DNS belong to Elacity or us?** The current
   `A` record points to a GCP IP that returns `HTTP=000`. If Elacity
   controls the DNS, we need their OK to re-point. If we control it,
   we can do it at will. This affects step 7.1.2.
3. **Does `ipfs.ela.city` already pin content uploaded via the legacy
   `/upload-elacity` path?** If yes, then Goal C is mostly a
   coordination exercise (expose an authenticated `/pin` endpoint) and
   C2 is purely defensive redundancy. If no, then C2 is load-bearing
   for any "marketplace CDN" narrative.

---

## 9. TL;DR for the Conference Call

- Our supernode mesh is healthy and serving traffic. `ipfs.ela.city`
  is a live public Kubo gateway, but it's on GCP, not on our VPSes.
- We can ship **supernode-hosted Base / ESC RPC** in one PR + one
  deploy script, purely additive to live traffic. Big UX win for
  Elacity Market, zero dependency on Irzhy.
- We can ship **supernode-hosted IPFS pinning** via a Kubo sidecar,
  prototyped on a Boson supernode first. Bigger dependency on Irzhy
  for the peering handshake, but the work itself is small.
- Both paths are **capsule-shaped**, so Anders' runtime can later
  absorb them without a rewrite. That's the convergence story for the
  community update.
- The tier-pricing and ELA-utility story already exists in
  `SUPERNODE_ECONOMICS.md`; this assessment just grounds it in the
  measured state of the mesh.
