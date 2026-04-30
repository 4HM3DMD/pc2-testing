# Network Hardening: From 10 Nodes to 100,000+

> **Purpose:** Documents every fragile point in the current supernode/gateway/connectivity architecture and what needs to change before decentralization
> **Created:** 2026-02-24
> **Status:** Phase 1 complete, Phase 2 built (on branch, not released). Community networking fix available on main.
> **Last Updated:** 2026-03-08

---

## Context

The current infrastructure works for 10-50 nodes with a single operator who can SSH into the supernode to fix issues. This document catalogs every manual intervention that was needed during real testing (Feb 2026) and defines what self-healing means at each scale tier.

### Scale Tiers

| Tier | Nodes | Supernodes | Operator Model | Status |
|------|-------|------------|----------------|--------|
| **Current** | 10-50 | 2 | Manual SSH, single operator | **Active** |
| **Phase 1** | 50-500 | 2-3 | Automated recovery, monitoring dashboard | **Complete** (transport + gateway) |
| **Phase 2** | 500-5,000 | 5-10 | Fully self-healing, node auto-migration | Planned |
| **Phase 3** | 5,000-100,000+ | 50+ | Decentralized mesh, anyone can join | Planned |

### Current Supernode Inventory (2026-03-07)

| Server | Provider | IP | Services | Role |
|--------|----------|-----|----------|------|
| InterServer | Linode | 69.164.241.210 | Gateway, Boson DHT, IPFS Relay, App Registry, WireGuard (wg0, 10.100/10.101), AmneziaWG, VLESS, Network Map | Primary |
| Contabo | Contabo | 38.242.211.112 | Gateway (slim), Boson DHT, IPFS Relay, App Registry (mirror), WireGuard (wg1, 10.102), AmneziaWG (awg0, 10.103), VLESS Reality, PC2 Node | Secondary |

### What's Deployed (Phase 1 Complete)
- Automated backup: InterServer -> Contabo every 6 hours via rsync/SSH key auth
- App registry mirror with 5-minute sync from primary
- Independent IPFS relay (500+ peers, own peer ID)
- Independent Boson DHT (own node ID, bootstraps from InterServer + Elastos Foundation)
- PC2 client code updated with multi-supernode failover for registry, IPFS, and Boson
- Slim web gateway on Contabo (read-replica, subdomain routing, user/registry APIs)
- Dual-write node registration (PC2 nodes register on all reachable supernodes)
- WireGuard server on Contabo (wg1, subnet 10.102.0.0/16, port 51820)
- AmneziaWG server on Contabo (awg0, subnet 10.103.0.0/16, port 51821, obfuscation enabled)
- VLESS Reality server on Contabo (sing-box, port 8443)
- Transport provisioning APIs on Contabo gateway (/api/wg/register, /api/awg/register, /api/vless/register)
- Client-side sequential failover: all transport services try secondary supernodes on primary failure
- ConnectivityService clears provision cache on tunnel failure for clean re-provisioning

### Three-Tier Network Architecture (Target)

| Tier | Role | Services | Who Runs It |
|------|------|----------|-------------|
| **Full Supernode** | Network backbone | Gateway, Boson DHT, IPFS Relay, WG/AWG/VLESS tunnels, App Registry, Active Proxy | Operators (VPS, 4+ cores, 8+ GB RAM, 100+ Mbps) |
| **Relay Node** | Lightweight contributor | IPFS relay, Boson DHT, content seeding | PC2 users with public IP (toggle in settings) |
| **Leaf Node** | Consumer | IPFS content seeding, local AI, personal cloud | All PC2 users (default mode, behind NAT) |

### What's Been Done (Phase 2 — Mar 7-8, on branch, NOT yet released)
- [x] Supernode bootstrap script (`deploy/supernode-bootstrap.sh`) — one-command VPS setup
- [x] Dynamic supernode discovery — gossip protocol + parallel fetch + disk persistence
- [x] Relay node mode — Settings toggle + IPFS circuitRelayServer + DHT server mode
- [x] Supernode dApp in dApp Center — spec check, service status, network view
- [x] Registry mesh sync via gossip endpoints (bidirectional)
- [x] Gateway v2.0 deployed to Contabo (register/heartbeat/gossip endpoints)
- [x] Networking fix script (`scripts/fix-networking.sh`) for community users missing WireGuard

### What's Next (Priority Order)
1. **InterServer gateway upgrade to v2.0** — purely additive, waiting for go-ahead
2. **WireGuard bundling** — bundle wg/wg-quick/wireguard-go/sing-box binaries with PC2 app so no user falls back to broken ActiveProxy (see `fix_wireguard_bundling` plan)
3. **Gateway "node offline" page** — show clear HTML error instead of infinite "initializing" when proxy fails
4. **Per-domain rate limiting** on gateway
5. **dDRM Access Token integration** for supernode economics

### Economic Model
See [SUPERNODE_ECONOMICS.md](../core/SUPERNODE_ECONOMICS.md) for the dDRM Access Token model that will govern supernode revenue as the network scales.

---

## Fragile Points Identified

### 1. Gateway Stale Connection Pool

**What happened:** After a Jetson rebooted, the gateway's Node.js `http.Agent` keep-alive pool held dead TCP sockets to the old WireGuard endpoint. The gateway kept trying to reuse dead connections instead of opening fresh ones. Result: `502 Bad Gateway` / `socket hang up` for that node's domain.

**Manual fix required:** SSH into supernode, restart gateway process.

**Automated fix deployed (2026-02-23):**
- `freeSocketTimeout: 15s` on the keep-alive agent (was 60s)
- 30s interval that destroys all idle sockets in the pool
- 60s WireGuard peer health-check that probes endpoints with HEAD requests and flushes dead sockets
- Error-triggered flush on `ECONNREFUSED` / `ECONNRESET` / `socket hang up`

**Remaining risk:** The gateway process itself can crash (EADDRINUSE on restart, unhandled errors). No process supervisor is configured — it runs via `nohup`.

**What's needed for scale:**
- [ ] Run gateway under systemd or PM2 with auto-restart on crash
- [ ] Add graceful shutdown handler that drains connections before exit
- [ ] Health endpoint that external monitoring can poll
- [ ] At 1000+ nodes: connection pool per-target (not global) to isolate failures

---

### 2. Registry is a Single JSON File

**What happened:** `registry.json` on the supernode maps usernames to endpoints. It's read/written by the gateway process. No locking, no replication, no backup.

**Risks at scale:**
- Race condition: two nodes registering simultaneously can corrupt the file
- Disk failure: all domain mappings lost
- Single supernode: if that machine goes down, no node is reachable via its domain
- File grows linearly with node count — at 100K nodes, JSON parsing becomes slow

**What's needed for scale:**
- [ ] **Phase 1:** SQLite registry with WAL mode (concurrent reads, atomic writes)
- [ ] **Phase 2:** Registry replication across supernodes (periodic sync or shared datastore)
- [ ] **Phase 3:** Distributed registry (etcd, or on-chain registration via Elastos DID sidechain)
- [ ] TTL on registry entries — auto-evict nodes that haven't heartbeated in 24h
- [ ] Atomic registration API that returns success/failure (not fire-and-forget)

---

### 3. Active Proxy Overwrites WireGuard Endpoint

**What happened:** After a Jetson reboot, the ConnectivityService reconnected via both WireGuard AND Active Proxy. Active Proxy connected faster, registered a `proxy://` endpoint, and overwrote the WireGuard `http://10.100.0.x` endpoint. The gateway then routed through the slower relay instead of the direct WireGuard tunnel.

**Manual fix required:** SSH into supernode, edit `registry.json`, restart gateway.

**Code fix deployed (2026-02-24):**
- `scheduleReconnect()` now tries WireGuard before Active Proxy
- `registerProxyEndpoint()` skips registration if WireGuard is already the active transport
- `handleWireGuardDown()` already had a 60s WireGuard retry with Active Proxy teardown on success

**Remaining risk:** If WireGuard goes down briefly (packet loss, supernode restart), the fallback to Active Proxy is correct behavior. But the re-upgrade back to WireGuard depends on the 60s retry timer. During that window, the node runs on the slower relay.

**What's needed for scale:**
- [ ] Reduce WireGuard retry interval from 60s to 15s after initial fallback
- [ ] Add exponential backoff for repeated WireGuard failures (15s, 30s, 60s, 120s, cap at 5min)
- [ ] Endpoint registration should include transport type (`wireguard` vs `proxy`) so the gateway can prefer WireGuard routes when both are registered
- [ ] Nodes should be able to register BOTH endpoints simultaneously and let the gateway choose the best one

---

### 4. WireGuard Peer Management is Per-Supernode

**Current state:** Each supernode runs a WireGuard interface (`wg0`) with peers added via the `/api/wg/register` endpoint. Peer configs are stored on that supernode only.

**Risks at scale:**
- WireGuard kernel module handles ~thousands of peers before performance degrades
- If the supernode restarts, all peers must re-provision (each node calls `/api/wg/register` again on startup — this works but creates a thundering herd)
- No load balancing — all nodes connect to one supernode's WireGuard
- No peer migration — if a supernode is decommissioned, its peers are stranded

**What's needed for scale:**
- [ ] **Phase 1:** Persistent peer store (SQLite) so supernode restarts don't require re-provisioning
- [ ] **Phase 2:** Peer assignment across multiple supernodes with automatic load balancing (round-robin or latency-based)
- [ ] **Phase 2:** Peer migration API — move a peer from supernode A to supernode B without downtime
- [ ] **Phase 3:** Consider replacing WireGuard with a mesh VPN (Nebula, Tailscale-style) that doesn't require centralized peer management
- [ ] At 10K+ peers per supernode: investigate WireGuard performance limits, consider splitting into multiple wg interfaces or tiered relay architecture

---

### 5. Gateway Process Has No Supervisor

**What happened:** The gateway process crashed with `EADDRINUSE` after a restart race condition. It stayed down until manually restarted via SSH.

**What's needed:**
- [ ] **Immediate:** Run gateway under systemd with `Restart=always` and `RestartSec=3`
- [ ] Alternatively: PM2 with `max_restarts: 50`, `restart_delay: 3000`
- [ ] Add port-check on startup — if port 80 is in use, wait 5s and retry before crashing
- [ ] Graceful shutdown signal handler (SIGTERM → drain connections → exit)
- [ ] Startup health-check: after binding port, verify HTTPS is serving before declaring healthy

---

### 6. No Monitoring or Alerting

**Current state:** The only way to know something is broken is when a user reports it or we SSH in and look.

**What's needed for scale:**
- [ ] **Phase 1:** Gateway `/status` endpoint with: uptime, registered nodes, active connections, error rate, last 10 errors
- [ ] **Phase 1:** Simple uptime monitoring (UptimeRobot or self-hosted) pinging each supernode's health endpoint
- [ ] **Phase 2:** Node-side health reporting — each node periodically reports its connectivity status to a central dashboard
- [ ] **Phase 2:** Alerting on: gateway crash, >5% error rate, supernode unreachable, WireGuard peer count drop
- [ ] **Phase 3:** Decentralized monitoring — nodes monitor each other, consensus on supernode health

---

### 7. SSL Certificate Management

**Current state:** Wildcard SSL for `*.ela.city` is managed manually on the supernode via Let's Encrypt.

**Risks at scale:**
- Certificate renewal failure = all domains go down
- Single certificate covers all subdomains — no per-node isolation
- Custom domains (non-ela.city) would need individual certificates

**What's needed for scale:**
- [ ] Automated certificate renewal with monitoring (certbot timer + alerting on failure)
- [ ] At multi-supernode: certificate synced across all gateway instances
- [ ] Future: per-node custom domain support with automatic ACME provisioning

---

### 8. No Rate Limiting or Abuse Protection

**Current state:** The gateway proxies all requests without any rate limiting. A malicious actor could flood a node's domain with requests, consuming the node's bandwidth and the gateway's connection pool.

**What's needed for scale:**
- [ ] Per-domain rate limiting on the gateway (e.g., 100 req/s per subdomain)
- [ ] Connection limits per source IP
- [ ] DDoS protection at the gateway level (or upstream via Cloudflare/similar)
- [ ] Abuse reporting mechanism for node operators

---

## Priority Order for Implementation

### Must-have before 100 nodes (Phase 1)
1. Gateway under systemd with auto-restart
2. SQLite registry replacing JSON file
3. Basic uptime monitoring
4. Automated SSL renewal with alerting

### Must-have before 1,000 nodes (Phase 2)
5. Registry replication across supernodes
6. Multi-supernode WireGuard with load balancing
7. Per-domain rate limiting
8. Node health dashboard
9. Dual-endpoint registration (WireGuard + proxy fallback at gateway level)

### Must-have before 100,000 nodes (Phase 3)
10. Distributed registry (on-chain or etcd cluster)
11. Mesh networking replacing centralized WireGuard
12. Decentralized monitoring
13. Per-node custom domain support
14. Geographic supernode routing (connect to nearest)

---

## Lessons Learned (Feb 2026 Testing)

| Issue | Root Cause | Time to Diagnose | Fix Type |
|-------|-----------|-------------------|----------|
| 502 Bad Gateway after reboot | Stale keep-alive sockets | 30 min | Code (health-check + auto-eviction) |
| Active Proxy overwrites WireGuard | ConnectivityService reconnect order | 20 min | Code (WireGuard priority) |
| Gateway crash on restart | EADDRINUSE race condition | 10 min | Manual restart (needs systemd) |
| Node unreachable after reboot | PM2 not auto-starting | 5 min | Config (`pm2 startup systemd`) |
| IPFS bandwidth saturation | DHT broadcasting all files | 15 min | Code (client-mode DHT) |
| Large file upload stalls | ulimit 1024 file descriptors | 20 min | Config (`limits.conf`) |

Every one of these required manual SSH intervention. At 1000 nodes, that's untenable. The hardening items above eliminate manual intervention for all six scenarios.
