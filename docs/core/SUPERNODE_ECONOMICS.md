# Supernode Economics: dDRM Access Token Model

> **Purpose:** Defines the economic model for the PC2 supernode network using Elacity dDRM Access Tokens instead of traditional staking
> **Created:** 2026-03-07
> **Status:** Strategy document — not yet implemented
> **Related:** [ROADMAP.md](./ROADMAP.md), [ARCHITECTURE_CONVERGENCE.md](./ARCHITECTURE_CONVERGENCE.md), [NETWORK_HARDENING.md](../pc2-infrastructure/NETWORK_HARDENING.md)

---

## Executive Summary

The PC2 supernode network uses **Elacity dDRM Access Tokens** as the economic layer. Instead of staking tokens for passive rewards, supernode operators mint Access Tokens that users purchase to unlock premium services. Revenue flows to operators proportional to demand, creating a quality-driven marketplace.

This model reuses the existing Elacity dDRM SDK, contracts, and verification flow — the same infrastructure that handles media content access today.

---

## Why Access Tokens Over Staking

| | Staking Model | dDRM Access Token Model |
|---|---|---|
| **Incentive** | Passive — lock tokens, collect APY | Active — earn from real service demand |
| **Quality signal** | None — minimum viable infra earns same APY | Market-driven — better service = more sales |
| **Revenue source** | Token inflation or treasury subsidies | Real user payments for real services |
| **Sybil resistance** | Capital lockup | Revenue tied to actual usage metrics |
| **Day-one revenue** | Requires bootstrapping a rewards pool | Works immediately via marketplace |
| **Existing infra** | Needs new staking contracts | Reuses Elacity SDK + Lit Protocol |
| **User experience** | Abstract ("stake to earn") | Concrete ("buy access to premium network") |

---

## Token Types

### Tier 0: Free (No Token Required)

Every PC2 node gets basic network services without any token:
- IPFS relay participation (content discovery and exchange)
- Boson DHT participation (peer discovery)
- App registry access (browse and install apps)
- Basic Active Proxy routing (NAT traversal, rate-limited)

This tier is permissionless and must remain so. The network's value comes from its size.

### Tier 1: Premium Network Pass

An NFT (ERC-721 or ERC-1155) from a supernode operator's contract:
- WireGuard/AmneziaWG/VLESS tunnel access
- Priority bandwidth allocation
- Faster content routing
- Duration: monthly or annual
- Tradeable on secondary markets

### Tier 2: Enterprise Pass

Higher-tier token with additional capabilities:
- Dedicated tunnel resources and bandwidth guarantees
- Custom domain support (beyond `*.ela.city`)
- SLA commitments (uptime, latency)
- Priority support channel
- Duration: annual

### Tier 3: Media + Network Bundle

The killer consumer product — a single token that unlocks:
- Premium network access (Tier 1 equivalent)
- Unlimited streaming from the Elacity dDRM media catalog
- This bundles network infrastructure with content, like a streaming service + VPN in one

---

## How Verification Works

The dDRM SDK already handles the complete verification flow. For supernode access, the same pattern applies:

```
1. PC2 node connects to supernode (basic tier, free)
2. Node requests premium service (e.g., WireGuard tunnel)
3. Supernode: "Present your Access Token"
4. PC2 node's wallet signs a challenge
5. Lit Protocol verifies on-chain:
   - Does wallet hold SupernodeAccessToken?
   - Is the token for this supernode (or network-wide)?
   - What tier level?
   - Is it expired?
6. Supernode grants appropriate service level
```

The on-chain check uses Lit Protocol Access Control Conditions — the same mechanism that today checks "does this wallet own the media NFT?" before decrypting content.

---

## Supernode Operator Model

### Becoming an Operator

1. Deploy supernode infrastructure (Boson DHT, IPFS relay, app registry)
2. Register as an operator on the Elacity marketplace
3. Deploy an Access Token contract (template provided by Elacity)
4. Set pricing tiers and mint tokens
5. Users discover the supernode via the network registry and purchase access

### Revenue Model

```
User purchases Premium Pass (e.g., 10 USDC/month)
  |
  +--> 80% to supernode operator
  +--> 15% to Elacity protocol treasury
  +--> 5% to ELA buyback pool
```

Operators earn based on actual demand. A well-run supernode in an underserved region with good bandwidth earns more because more users buy its passes.

### Quality Enforcement

No slashing needed. The market enforces quality:
- Bad uptime → users stop buying → revenue drops
- Good performance → word of mouth → revenue grows
- ERC-8004 reputation scores provide transparent quality signals
- Users can switch supernodes at any time (passes are per-supernode or network-wide)

---

## Network-Wide vs Per-Supernode Tokens

### Option A: Per-Supernode Tokens

Each operator deploys their own contract. Users buy passes for specific supernodes.
- Pro: Operators compete on quality and price
- Pro: Users choose exactly which infrastructure they trust
- Con: Fragmented — user behind a firewall in Tokyo needs to know which supernode serves Asia

### Option B: Network-Wide Token

A single Elacity Network Access contract. Holding it grants access across all participating supernodes.
- Pro: Simple UX — "one pass, access everywhere"
- Pro: Revenue distributed proportionally to all operators
- Con: Free-rider problem — poor-quality supernodes still get revenue

### Recommended: Hybrid (Option C)

- **Network-wide base token** grants Tier 1 access across all supernodes
- Revenue distributed by bandwidth served (measured and attested)
- **Per-supernode premium tokens** for operators offering specialized/premium services
- Operators can set their own pricing for Tier 2+ services

This mirrors telecom: a carrier plan gives you network access everywhere, but premium services vary by tower/region.

---

## Integration with Existing Architecture

### What Exists Today and What It Becomes

| Current Component | Role Today | Role with Access Tokens |
|---|---|---|
| `ConnectivityService.ts` | Connects to first reachable supernode | Connects + presents Access Token for tier verification |
| `UsernameService.ts` | Registers `alice.ela.city` domain | Same, plus token-gated premium features |
| Boson Active Proxy | Free NAT traversal for all | Free at basic tier, priority bandwidth at Tier 1+ |
| IPFS Relay | Free content relay for all | Same — always free (network effect) |
| Web Gateway | Routes `*.ela.city` traffic | Same + enforces per-request tier limits |
| Elacity Market dApp | Sells media content NFTs | Also sells Supernode Access Tokens |
| Lit Protocol | Verifies media NFT ownership | Also verifies Access Token ownership |

### Contract Architecture (Future)

```
ElacityNetworkAccess.sol (ERC-1155)
  |
  +-- tokenId 1: Basic Pass (free mint, rate-limited)
  +-- tokenId 2: Premium Pass (monthly, paid)
  +-- tokenId 3: Enterprise Pass (annual, paid)
  +-- tokenId 4: Media + Network Bundle (monthly, paid)

SupernodeOperatorRegistry.sol
  |
  +-- registerSupernode(address operator, string metadata)
  +-- reportBandwidth(address operator, uint256 bytesServed)
  +-- claimRevenue(address operator)
```

---

## Three-Tier Network Architecture

The PC2 network operates on three tiers of participation, each contributing different value:

### Tier 1: Full Supernodes

The network backbone. Operators run all services on dedicated infrastructure.

- **Requirements:** VPS or dedicated server, 4+ CPU cores, 8+ GB RAM, 100+ Mbps, public IP, Ubuntu 22.04+
- **Services:** Gateway, Boson DHT, IPFS Relay, WireGuard/AmneziaWG/VLESS tunnels, App Registry, Active Proxy, Bandwidth Metering
- **Economics:** Earn revenue from Access Token holders; proportional to bandwidth served
- **How to join:** Run the bootstrap script, or install the Supernode dApp from the dApp Center (which runs the same setup after verifying specs)

### Tier 2: Relay Nodes

Lightweight contributors that strengthen the mesh without running the full stack.

- **Requirements:** PC2 node with a public IP address (no NAT)
- **Services:** IPFS relay (circuit-relay-v2), Boson DHT participation, content seeding
- **Economics:** Free tier — no token required to contribute; relay operators earn micro-rewards from bandwidth metering once the token economy is live
- **How to join:** Toggle "Relay Mode" in PC2 Settings (enabled by default if public IP detected)

### Tier 3: Leaf Nodes

Standard PC2 users. They consume services and contribute by seeding content.

- **Requirements:** Any PC2 installation
- **Services:** IPFS content seeding (purchased media becomes CDN), local AI, personal cloud
- **Economics:** Basic tier is free. Users purchase Access Tokens for premium services (WireGuard tunnels, priority bandwidth)
- **How to join:** Install PC2 (this is the default mode)

### Supernode dApp in dApp Center

The Supernode dApp provides a UI within PC2 for users to upgrade their node:

1. **Spec Check:** Verifies CPU cores, RAM, disk space, bandwidth, and public IP availability
2. **One-Click Install:** Runs the bootstrap script to deploy all supernode services
3. **Dashboard:** Shows connected peers, bandwidth served, tunnel counts, revenue earned
4. **Configuration:** Adjust pricing tiers, service toggles, domain settings
5. **Health Monitoring:** Real-time status of all services (Boson DHT, IPFS, WG, AWG, VLESS, gateway)

This means any PC2 user with adequate hardware can become a supernode operator directly from the UI, without SSH access or DevOps knowledge.

---

## Relationship to Capsule Runtime V2

When the Rust-based capsule runtime arrives, supernodes become modular:

```
Supernode = collection of capsules:
  capsule:boson-dht        (always free — DHT participation)
  capsule:ipfs-relay       (always free — content relay)
  capsule:app-registry     (always free — app catalog)
  capsule:tunnel-wg        (token-gated — WireGuard tunnels)
  capsule:tunnel-awg       (token-gated — AmneziaWG tunnels)
  capsule:gateway          (hybrid — basic routing free, premium priority)
  capsule:bandwidth-meter  (measures usage for revenue distribution)
```

An operator chooses which capsules to run. A minimal supernode runs only the free capsules (community contribution). A full commercial supernode runs everything and earns revenue from Access Token holders.

The capability token model from the runtime aligns naturally: a dDRM Access Token is a high-level capability that grants access to supernode capsule services.

---

## Implementation Timeline

### Phase 1: Infrastructure (COMPLETE — Q1 2026)
- [x] Multi-supernode deployment (InterServer + Contabo) with registry sync
- [x] Automated backup and failover between supernodes
- [x] Dual-write registration so nodes work with any supernode
- [x] Stealth transport decentralization (WireGuard, AmneziaWG, VLESS Reality on both supernodes)
- [x] Client-side sequential failover across all transport services
- [x] Slim web gateway on secondary with transport provisioning APIs

### Phase 2: Operator Framework (Q2 2026) — MOSTLY COMPLETE
- [x] Supernode bootstrap script (`deploy/supernode-bootstrap.sh`) — one-command VPS setup *(completed Mar 7)*
- [x] Dynamic supernode discovery — gossip protocol + parallel fetch + disk persistence *(completed Mar 7)*
- [x] Relay node mode in PC2 Settings — toggle + IPFS circuitRelayServer + DHT server mode *(completed Mar 7)*
- [x] Supernode dApp in dApp Center — spec-check, service status, network view *(completed Mar 7)*
- [x] Registry mesh sync — gossip endpoints, all supernodes sync bidirectionally *(completed Mar 7)*
- [x] Community networking fix script (`scripts/fix-networking.sh`) — installs WG+AWG+VLESS for affected users *(completed Mar 8)*
- [ ] InterServer gateway upgrade to v2.0 — waiting for go-ahead *(purely additive, 2-3s restart)*
- [ ] WireGuard bundling with PC2 app — permanent fix for missing networking tools
- [ ] Service interface abstraction (TransportProvider, RegistryProvider, etc.) for capsule-ready architecture

### Phase 3: Marketplace Integration (Q2-Q3 2026)
- Design Access Token contract (ERC-1155 tiered)
- Add token verification to supernode gateway (Lit Protocol)
- List Access Tokens on Elacity Market alongside media content
- Implement bandwidth metering for revenue distribution

### Phase 4: Decentralized Operator Network (Q3-Q4 2026)
- SupernodeOperatorRegistry.sol on-chain
- Automated revenue distribution based on bandwidth attestations
- ERC-8004 agent registration for supernodes
- Geographic routing (connect to nearest supernode)

### Phase 5: Full Economy (2027+)
- Media + Network bundles
- Cross-supernode mesh routing
- Per-supernode premium tokens
- Micro-payment channels for bandwidth-heavy operations
- Capsule Runtime V2 integration (supernode services as capsule bundles)

---

## The Flywheel

```
More supernodes
  → better coverage, lower latency
    → more users buy Access Tokens
      → more revenue for operators
        → more operators deploy supernodes
          → (loop)

More supernodes running IPFS relays
  → better CDN for dDRM media
    → more content creators publish
      → more media purchases on Elacity
        → more ELA demand
          → higher ELA price
            → more attractive to run supernodes
              → (loop)
```

The supernode network and the dDRM media marketplace reinforce each other. They are the same economic system.

---

*This document will be updated as the contract architecture and runtime integration progress.*
