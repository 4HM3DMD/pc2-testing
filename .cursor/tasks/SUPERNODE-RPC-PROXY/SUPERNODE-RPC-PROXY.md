# Task: Supernode-backed Base / ESC RPC proxy

**Task ID**: SUPERNODE-RPC-PROXY
**Created**: 2026-04-29
**Status**: Proposed
**Priority**: Medium (UX follow-up for v1.2.1 / v1.3)

## Description

Run an authoritative JSON-RPC endpoint on our existing supernodes
(InterServer `69.164.241.210`, Contabo `38.242.211.112`) and add them
to `BASE_RPC_URLS` in `pc2-node/src/static.ts`. Eliminates dependency
on public community RPCs for Base reads, removes public rate limits as
a UX factor, aligns with Elastos sovereignty principles.

## Background

On 2026-04-28 the user reported intermittent "price not showing" on
Elacity Market asset detail pages. Root cause trace:

1. `renderOpTypeBadge` fires 8–12 `eth_call`s per asset open
   (`sellersOf`, N × `listings`, `balanceOf`, etc.)
2. `mainnet.base.org` (Coinbase official) rate-limits hard (~60 req/min)
   and returns the throttle response as **HTTP 200 + JSON-wrapped error**,
   not HTTP 429.
3. Our `handleJsonRpcProxy` only failed over on HTTP non-2xx; the
   JSON-error case fell through to the client and never tried the
   configured llamarpc / publicnode fallbacks. Fixed in `a3c599d6c`.
4. Additional resilience:
   - `542487ebc` — diagnostic log on fallback trigger
   - (this branch) — reorder `BASE_RPC_URLS` with llamarpc first,
     add Ankr + BlockPI fallbacks
   - (this branch) — add `eth_call` to proxy cache (2 s TTL) to
     dedupe rapid re-open bursts

Those fixes make the existing flow much more robust, but we still
depend on public community RPCs. That dependency:

- Puts our UX at the mercy of third-party rate limits and uptime
- Makes us a "quiet" consumer — no SLA, no support channel
- Doesn't align with the Elastos sovereignty narrative (we talk about
  running our own infrastructure; our Market reads still route to
  Coinbase / llama / Ankr / BlockPI / public-node endpoints)
- Each user node hitting public RPCs is inefficient; a shared cached
  proxy at the supernode level amortizes reads across the network

## Requirements

### MVP (minimum to close this task)

1. **Deploy a JSON-RPC proxy service** on each of our two active
   supernodes (`69.164.241.210`, `38.242.211.112`). Implementation
   options (pick cheapest first, revisit if needed):

   - **Option A (fastest, cheapest)**: a thin reverse-proxy running
     `nginx` or `caddy` that forwards to an authenticated Alchemy or
     Infura endpoint (one Alchemy free tier per supernode = 300M CU/month,
     way beyond our current demand). Cost: $0 until scale, ~$49/mo
     per node once we outgrow free tier.

   - **Option B (more sovereign)**: self-host `reth` (Base-compatible
     L2 node) on each supernode. Cost: $0 RPC, requires ~500 GB storage
     + ongoing sync (full Base archive is larger but pruned is manageable).
     Higher ops burden.

   - **Option C (hybrid)**: Alchemy/Infura primary + cached query layer
     (Rust `axum` service) on supernode that serves common reads
     (`sellersOf`, `listings`, `balanceOf`) from a local SQLite / Redis
     cache with block-level invalidation. Best UX, most build.

   MVP ships Option A; B/C tracked as follow-up.

2. **Signed public endpoints**: expose as
   `https://rpc.node1.pc2.ela.city/base` and
   `https://rpc.node2.pc2.ela.city/base`, TLS via existing Let's Encrypt
   setup on the supernodes (already in place for pc2-gateway.service).

3. **Add to `BASE_RPC_URLS`**: as the first two entries, ahead of
   public community RPCs.

4. **Health monitoring**: supernode proxy must return HTTP 503 if its
   upstream (Alchemy/Infura/reth) is unreachable. Our client-side
   fallback then moves to the next URL without masking outages.

### Nice-to-have (post-MVP)

- ESC equivalent — same pattern for Elastos Smart Chain reads
  (currently uses `api.elastos.io/eth` which has the same throttling
  profile). Same risks, same fix.
- Metrics (request count, upstream, cache hit rate) exported via
  Prometheus on the supernode for ongoing ops visibility.
- Rate-limit awareness on the supernode itself — short-circuit with
  cached responses when upstream is throttled, serving stale reads
  with a `Warning` header rather than a 5xx.

## Acceptance Criteria

- [ ] `curl -s -X POST -H 'Content-Type: application/json' https://rpc.node1.pc2.ela.city/base -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'` returns `{"jsonrpc":"2.0","id":1,"result":"0x2105"}` (chainId 8453 = Base)
- [ ] Same for node2 endpoint
- [ ] `BASE_RPC_URLS` in `pc2-node/src/static.ts` lists both supernode
      endpoints first, community RPCs after
- [ ] Load test: 1000 `eth_call` bursts within 60 s succeed without
      rate-limit errors (comfortably beats our peak demand)
- [ ] Supernode proxy service unit documented in
      `docs/ops/SUPERNODE_SERVICES.md` alongside `pc2-gateway.service`
      and `pc2-web-gateway.service`
- [ ] Deploy script added to `deploy/app-registry/scripts/` (follows
      existing pattern — `install-pinning.sh`, etc.)

## Files to Modify

- `pc2-node/src/static.ts` — add supernode URLs to `BASE_RPC_URLS`
- `deploy/app-registry/scripts/install-rpc-proxy.sh` — new (deploy)
- `docs/ops/SUPERNODE_SERVICES.md` — new or extend existing ops docs

## Files to Create (on supernodes, not in repo)

- `/etc/nginx/sites-available/pc2-rpc-base` (if Option A)
- `/etc/systemd/system/pc2-rpc-base.service` (if Option B/C)
- Alchemy/Infura API keys in `.env` (encrypted, deployed via `deploy.sh`)

## Testing Strategy

- Unit test: extend the offline `isTransportRateLimit` / proxy test
  harness to cover supernode URL in the fallback sequence
- Integration: hit `/api/rpc/base` with 1000 `eth_call`s in rapid
  succession from a local PC2 node, confirm all succeed via supernode
- Failure test: take supernode-node1 offline, confirm client falls
  over to supernode-node2 transparently (no user-visible error)
- Regression: existing Elacity Market flows (asset open, buy, cancel)
  unchanged, just faster

## Notes

### Why two supernodes, not more

We already operate these two for `pc2-gateway.service` /
`pc2-web-gateway.service`. Adding a third JSON-RPC pair multiplies
ops cost for marginal resilience gain; we already have 3 public
fallbacks in the list for worst-case scenarios. Revisit if Elacity
Market traffic grows 10× or if either supernode becomes unreliable.

### Why ship Option A first

Alchemy/Infura free tier is 300M compute units per month, which at our
current `eth_call` / `eth_getCode` mix handles ~5000 daily active users
before we need to upgrade. Building `reth` integration now is
speculative. We'll know when we need to upgrade because the Alchemy
dashboard will tell us, and migrating from Option A → Option B/C is a
one-line change in `BASE_RPC_URLS`.

### Relationship to IPFS-ELACITY-BOOTSTRAP

This task parallels `IPFS-ELACITY-BOOTSTRAP` — same architectural
pattern (supernodes as shared infrastructure), different service (RPC
vs. pinning). Could be run by the same deploy scripts / ops tooling
once both are landing.

### Relationship to RPC-PROXY hardening (shipped)

Commits `a3c599d6c` (fallback on JSON error), `542487ebc` (diagnostic
log), and the bundled reorder + eth_call cache change that follows
make the CURRENT public-RPC flow robust enough to ship v1.2 without
this task. This task is about removing a third-party dependency, not
about fixing a bug.
