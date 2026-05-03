# PC2 / Elacity — System Architecture Map

> **Purpose**: Comprehensive map of every component, layer, and data flow in the pc2.net system. Designed to be readable as a technical reference AND as a blueprint for a graphic designer to produce a professional infographic.
>
> **Audience**: Engineers, operators, designers, leadership.
>
> **Last updated**: 2026-05-03 (v1.2.7 release scope).

---

## Table of contents

1. [Executive summary (one-paragraph)](#1-executive-summary-one-paragraph)
2. [The 3-tier mental model](#2-the-3-tier-mental-model)
3. [Tier 1 — Supernode Pinning Mesh](#3-tier-1--supernode-pinning-mesh)
4. [Tier 2 — pc2-node (the production node)](#4-tier-2--pc2-node-the-production-node)
5. [Tier 3 — Frontends, dApps, and clients](#5-tier-3--frontends-dapps-and-clients)
6. [Cross-cutting layers](#6-cross-cutting-layers)
7. [Key end-to-end flows](#7-key-end-to-end-flows)
8. [Update + deployment lifecycle](#8-update--deployment-lifecycle)
9. [Glossary](#9-glossary)
10. [Infographic blueprint for designer](#10-infographic-blueprint-for-designer)

---

## 1. Executive summary (one-paragraph)

**PC2 is a sovereign personal cloud computer.** It is a self-hosted node — typically a small ARM device (Raspberry Pi, Jetson Orin), an old Mac/Linux box, or a VPS — that runs a single integrated stack: a personal file system on top of IPFS, a marketplace runtime for decentralised content, an AI assistant with multi-provider support, identity rooted in your Web3 wallet, secure-view DRM via Lit Protocol/Chipotle, peer-to-peer messaging gateways (WhatsApp/Telegram), and a desktop GUI shell forked from Puter. Multiple PC2 nodes form a **resilient peer-to-peer network** stitched together by always-on **supernodes** (a hosted IPFS Cluster mesh) that guarantees content remains reachable even when individual nodes are offline. The user owns their hardware, their data, and their keys.

---

## 2. The 3-tier mental model

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  TIER 3 — Clients & Frontends                                        │
│    Desktop GUI, mobile apps, browser dApps, Elastos launcher         │
│    (consume pc2-node APIs; users see this)                           │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  TIER 2 — pc2-node (the production node)                             │
│    Express API + IPFS (Helia) + AI + DB + sandbox + comms            │
│    (one per user; self-hosted on home/office hardware)               │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  TIER 1 — Supernode Pinning Mesh (always-on infrastructure)          │
│    IPFS Cluster (Contabo + InterServer + GCloud) + circuit relays    │
│    (3 always-on nodes; guarantees content availability)              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key principle**: Tier 2 nodes are sovereign and equal — there is no central server they "log into". Tier 1 is **infrastructure**, not authority. It exists to keep content reachable when individual Tier 2 nodes are offline (sleeping laptop, home internet drop, behind NAT). A user can ignore Tier 1 entirely and still have a working node — they just lose the always-on availability guarantee for their published content.

---

## 3. Tier 1 — Supernode Pinning Mesh

**What it is**: A small fixed mesh of always-on, fixed-IP servers that hold replicas of every CID minted or uploaded across the PC2 network. Acts as an **availability layer** so that a buyer's pc2-node can always find content even if the seller's pc2-node is currently offline.

### 3.1 Composition (production, as of v1.2.7)

| Node | Provider | Role | Disk for IPFS | Cluster peer |
|---|---|---|---|---|
| **Contabo** | Contabo VPS (DE) | Cluster bootstrap + nginx-exposed Pinning API | 300 GB | ✅ |
| **InterServer** | InterServer (US) | Cluster peer + WireGuard hub for ops + pc2-gateway | 1 TB | ✅ |
| **GCloud (`ipfs.ela.city`)** | Google Cloud | Cluster peer (planned, Phase 4) + legacy `ELACITY_PIN_FORWARD_URL` target | TBD | ⏳ planned |

### 3.2 Components running on each supernode

```
                       SUPERNODE (each instance)
        ┌────────────────────────────────────────────────────────┐
        │                                                        │
        │  ┌──────────────┐    ┌─────────────────────────────┐   │
        │  │ Kubo IPFS    │◄───┤ ipfs-cluster-service v1.1.4 │   │
        │  │ daemon       │    │ (CRDT consensus,            │   │
        │  │ (port 4101)  │    │  Pinning Services API)      │   │
        │  └──────┬───────┘    └─────────────────────────────┘   │
        │         │                       ▲                      │
        │         │                       │                      │
        │  ┌──────┴───────┐               │                      │
        │  │ pc2-gateway  │               │                      │
        │  │ (Node.js;    │     ┌─────────┴────────┐             │
        │  │ HTTP gateway │     │ nginx (Contabo)  │             │
        │  │ /ipfs/*)     │     │ exposes          │             │
        │  └──────────────┘     │ /cluster-pin/*   │             │
        │                       │ + bearer token   │             │
        │  ┌──────────────┐     └──────────────────┘             │
        │  │ Optional:    │                                      │
        │  │ pc2-ipfs-    │     ┌──────────────────┐             │
        │  │ relay        │     │ WireGuard wg0    │             │
        │  │ (circuit)    │     │ (admin/ops mesh) │             │
        │  └──────────────┘     └──────────────────┘             │
        └────────────────────────────────────────────────────────┘
```

### 3.3 What flows in/out of the supernode mesh

- **Inbound — pin requests** from pc2-nodes: HTTPS POST to `https://<supernode>/cluster-pin/pins/<cid>` with bearer token. Cluster receives, CRDT-replicates metadata to peers within ~1-3 seconds, all peers begin Bitswap-fetching the bytes from any provider (typically the originating pc2-node) until they have local copies.
- **Inbound — Bitswap/DHT** from any IPFS peer asking for content the supernode holds.
- **Outbound — Bitswap** serving requested content to anyone who asks (PC2 nodes, public IPFS gateways, browsers using js-ipfs, Brave's IPFS support).
- **Outbound — DHT provider records** announcing every CID the supernode holds.
- **Inter-supernode** — Cluster CRDT messages (port 9096) + Kubo Bitswap (port 4101) for peer-to-peer replication.

### 3.4 Failure modes mitigated

| Without supernodes | With supernodes |
|---|---|
| Buyer can't reach seller → content lost | Buyer pulls from supernode |
| Seller's home IP changes → content lost | Supernode keeps stable provider record |
| Seller offline at sale time → content unreachable | Supernode serves immediately |
| Single supernode fails | Cluster CRDT keeps content on remaining peers |

---

## 4. Tier 2 — pc2-node (the production node)

**What it is**: A single Node.js process (`pc2-node/dist/index.js`) running on a user's hardware, exposing an HTTP API on port `4200` plus a Socket.io WebSocket plus an embedded IPFS (Helia) peer plus background services. This is **the** unit of sovereignty in the PC2 network.

### 4.1 Top-level subsystem map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              pc2-node process                                │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ HTTP REST    │  │ WebSocket    │  │ IPFS (Helia) │  │ libp2p stack │     │
│  │ Express API  │  │ Socket.io    │  │ + Bitswap    │  │ TCP/WS/Noise │     │
│  │ (port 4200)  │  │ realtime     │  │ + Helia DAG  │  │ Yamux/DHT/…  │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │                 │              │
│         └─────────────────┴─────────────────┴─────────────────┘              │
│                                   │                                          │
│   ┌───────────────────────────────┼───────────────────────────────┐          │
│   │                               │                               │          │
│   ▼                               ▼                               ▼          │
│ ┌──────────────┐            ┌──────────────┐              ┌──────────────┐   │
│ │ Storage      │            │ Services     │              │ Sandbox      │   │
│ │ SQLite +     │            │ AI / Boson / │              │ Terminal +   │   │
│ │ filesystem + │            │ Gateways /   │              │ WASM + dApp  │   │
│ │ IPFS pins    │            │ Updates / …  │              │ runtime      │   │
│ └──────────────┘            └──────────────┘              └──────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 API surface (`pc2-node/src/api/`)

The HTTP API is split into ~30 route modules. Grouped:

| Group | Files | Purpose |
|---|---|---|
| **Storage / files** | `storage.ts`, `media.ts`, `public.ts`, `file.ts`, `filesystem.ts` | File CRUD, IPFS pins, public CDN-style `/ipfs/`, media gateway with retry semantics |
| **Auth / identity** | `auth.ts`, `middleware.ts`, `access-control.ts`, `whoami.ts`, `did.ts`, `wallet.ts` | SIWE login, scopes, decentralised identifiers, wallet binding |
| **AI / agent** | `ai.ts`, `tools.ts`, `gateway.ts`, `voice.ts`, `context.ts`, `wasm.ts`, `terminal.ts`, `scheduler.ts` | Multi-provider AI, tool execution, voice, scheduled tasks |
| **Network / infra** | `boson.ts`, `supernode.ts`, `setup.ts`, `chipotle-client.ts`, `http-client.ts`, `info.ts`, `system.ts` | Boson active proxy, supernode discovery, Chipotle (Lit) client |
| **Marketplace / apps** | `apps.ts`, `installed-apps.ts`, `registry.ts`, `resources.ts`, `versions.ts` | App catalog, installations, version history |
| **Ops** | `update.ts`, `backup.ts`, `audit.ts`, `telemetry.ts`, `rate-limit.ts`, `apikeys.ts` | Self-update, backup/restore, audit log |

Public health/readiness:
- `GET /health` and `GET /api/health` — version, DB/IPFS/socket/terminal status, **cluster pinning summary** (v1.2.7+)
- `GET /api/system-readiness` — transport binary availability (WireGuard, sing-box, etc.)

### 4.3 Background services (`pc2-node/src/services/`)

| Service | Purpose | Optional? |
|---|---|---|
| **`UpdateService`** | Manages git pull → npm install → build → restart cycle for self-updates. | No |
| **`clusterPin` (v1.2.7+)** | Forwards every successful local pin to the supernode IPFS Cluster. Activates when env vars set. | Yes (opt-in) |
| **`ContentSeedingService`** | Periodically re-announces owned CIDs to the DHT. | No |
| **`ContentIndexerService`** | Scans EVM blocks for marketplace listings/mints; refreshes catalog. | No |
| **`ContentIntelligenceService`** | Fingerprints content, deduplication, suggested categorisation. | No |
| **`AIChatService`** + `ai/providers/*` | Anthropic, OpenAI, Google Gemini, xAI Grok, Ollama. Provider auto-detected from env. | Yes (opt-in by API key) |
| **`gateway/channels/*`** | WhatsApp (Baileys), Telegram (grammy), AI tool dispatch from messages. | Yes |
| **`boson/*`** | Boson Active Proxy client + protocol handler (Java-compat); identity, username, crypto box, connectivity. | No |
| **`wireguard/`, `AmneziaWGService`** | Manage WireGuard / AmneziaWG tunnels for transport. | Yes |
| **`vless/VLESSRealityService`** | Alternative censorship-resistant transport. | Yes |
| **`terminal/TerminalService`** | PTY sandboxing via bubblewrap (`isolation_mode: none / namespace / disabled`). | No |
| **`wasm/WASMRuntime`**, **`sandbox/SandboxManager`** | WASM execution + resource caps; foundation for future capsule runtime. | Yes |
| **`AppInstallService`** | Installs/upgrades dApp packages from the registry into local storage. | No |
| **`media/*`** | DASH packaging, ffmpeg-side helpers for content protection workflows. | Yes |

### 4.4 Storage layer (`pc2-node/src/storage/`)

```
┌─────────────────────────────────────────────────────────────────────┐
│  pc2-node/src/storage/                                              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ database.ts                                                  │   │
│  │   @photostructure/sqlite (v1.2.7+) — prebuilt for all OS     │   │
│  │   enhance() wrapper makes API identical to better-sqlite3    │   │
│  │   File: pc2-node/data/pc2.db                                 │   │
│  │                                                              │   │
│  │   Tables: users, sessions, files, pinned_cids,               │   │
│  │           api_keys, content_events, ai_memory_*, …           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ migrations.ts                                                │   │
│  │   Forward-only schema versioning; runs at boot               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ ipfs.ts                                                      │   │
│  │   Helia + libp2p stack:                                      │   │
│  │     transports: TCP, WebSockets                              │   │
│  │     muxers:     Yamux, mplex                                 │   │
│  │     security:   Noise                                        │   │
│  │     services:   identify, ping, Kad-DHT, mDNS, autoNAT,      │   │
│  │                 circuit relay v2, dcutr, autoTLS             │   │
│  │   Bootstrap peers (priority):                                │   │
│  │     1. Operator-supplied (env override)                      │   │
│  │     2. Elacity supernode set                                 │   │
│  │     3. Public bootstrap.libp2p.io                            │   │
│  │   IPFS repo path: pc2-node/data/ipfs/                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ filesystem.ts                                                │   │
│  │   Wallet-scoped virtual file system:                         │   │
│  │     /<wallet-address>/<path>                                 │   │
│  │   Files map to IPFS CIDs in pinned_cids table                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ context.ts, indexer.ts, thumbnail.ts                         │   │
│  │   Awareness events, search index, image previews             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.5 Built-in frontend (`pc2-node/frontend/` + `pc2-node/data/test-apps/`)

- **`pc2-node/frontend/`** — built SPA (the desktop shell, served by the node itself)
- **`pc2-node/data/test-apps/`** — packaged dApps that ship with every install:
  - **`pc2-media-runtime`** — secure-view media player (DASH + Lit decryption)
  - **`ddrm-viewer`** — dDRM content viewer
  - **`supernode-manager`** — UI for browsing supernodes and connection status
  - **`elacity-market`** — marketplace browse/list/buy
  - **`elastos-nft-sources`**, **`glide-finance-bundle`** — additional creator tools
- **`src/wallet-bridge/`** — Particle Auth wallet bridge sources copied to frontend at build time

---

## 5. Tier 3 — Frontends, dApps, and clients

### 5.1 Direct pc2-node frontends

- **Built-in SPA** — served at `http://<pc2-node>:4200/` by the node itself (Puter-derived desktop GUI shell)
- **Test-apps catalog** — additional dApps loaded inside the SPA from `data/test-apps/`

### 5.2 External clients

- **Elastos launcher (Mac/Linux/Windows desktop)** — bundles the pc2-node binary + the GUI; users get a native desktop experience
- **Mobile** — limited mobile UI; plans for thin native client that talks to a remote pc2-node
- **Browser** — direct connection to a pc2-node's HTTP API or via a Boson active proxy

### 5.3 Capsule runtime (planned, v1.4+)

- WASM-based capability sandbox so 3rd-party creators can ship **untrusted** viewers/wrappers safely
- Replaces today's iframe sandbox for cases requiring stronger isolation
- See `.cursor/tasks/CAPSULE-RUNTIME-WASM/`

---

## 6. Cross-cutting layers

### 6.1 Networking layers (what pc2-node speaks, by protocol)

```
                              pc2-node networking
       ┌────────────────────────────────────────────────────────────────┐
       │                                                                │
       │   Application protocols                                        │
       │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
       │   │ HTTP     │  │ WebSocket│  │ libp2p   │  │ IPFS     │       │
       │   │ REST API │  │ (Socket  │  │ p2p      │  │ Bitswap  │       │
       │   │ port 4200│  │  .io)    │  │ stack    │  │ + DHT    │       │
       │   └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
       │                                                                │
       │   Transport layer choices                                      │
       │   ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
       │   │ TCP      │  │ WireGuard│  │ VLESS-   │                     │
       │   │ (default)│  │ (admin/  │  │ Reality  │                     │
       │   │          │  │  mesh)   │  │ (censor- │                     │
       │   │          │  │          │  │  resist) │                     │
       │   └──────────┘  └──────────┘  └──────────┘                     │
       │                                                                │
       │   Discovery / NAT traversal                                    │
       │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
       │   │ mDNS     │  │ DHT      │  │ Circuit  │  │ Boson    │       │
       │   │ (LAN)    │  │ (Kad)    │  │ Relay v2 │  │ Active   │       │
       │   │          │  │          │  │ + dcutr  │  │ Proxy    │       │
       │   └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
       │                                                                │
       └────────────────────────────────────────────────────────────────┘
```

### 6.2 Storage layer hierarchy

```
USER WRITES A FILE
        │
        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ pc2-node SQLite  │───▶│ Local Helia/IPFS │───▶│ Cluster forward  │
│ (metadata,       │    │ daemon (bytes,   │    │ (replication to  │
│  filesystem.ts)  │    │  CID generation) │    │  supernodes)     │
└──────────────────┘    └──────────────────┘    └──────────────────┘
                                │
                                │
                                ▼
                        ┌──────────────────┐
                        │ DHT announce     │
                        │ (other peers can │
                        │  discover this   │
                        │  CID)            │
                        └──────────────────┘
```

### 6.3 Security & sandbox

| Layer | Technology | Purpose |
|---|---|---|
| **Authentication** | SIWE (Sign-In with Ethereum), wallet signatures | User identity = wallet |
| **Session** | HTTP-only cookies + JWT-like tokens | Stateful auth for browser clients |
| **API key scopes** | scopes.ts + apikeys.ts | Fine-grained permissions for tools/agents |
| **Terminal sandbox** | `bubblewrap` (Linux namespaces) | PTY isolation per wallet |
| **WASM sandbox** | wasmtime-style runtime + resource caps | Safe execution of untrusted code (foundation) |
| **Content encryption** | Lit Protocol → Chipotle PKP | Secure-view DRM, programmable access conditions |
| **Network ACL** | UFW on supernodes, owner-guarded endpoints | Defence in depth |

### 6.4 AI stack (`pc2-node/src/services/ai/`)

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   AIChatService (single entry point)                             │
│         │                                                        │
│         ▼                                                        │
│   Provider router (auto-detected from env vars)                  │
│         │                                                        │
│   ┌─────┼──────┬──────┬──────┬──────┐                            │
│   ▼     ▼      ▼      ▼      ▼      ▼                            │
│ Claude OpenAI Gemini  xAI   Ollama (local)                       │
│                                                                  │
│   ▼                                                              │
│   ToolExecutor — agent calls tools (filesystem, web search,      │
│                  wallet sign, IPFS pin, secure-view sign, etc.)  │
│                                                                  │
│   ▼                                                              │
│   VectorMemoryStore (SQLite-backed) — long-term memory           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 6.5 Web3 integrations

| Capability | Library / source |
|---|---|
| **Wallet RPC** | `viem` (EVM); Particle Auth as user-facing wallet |
| **Marketplace contracts** | Listings, mints — addresses configured per chain in test-apps |
| **Block scanning** | `ContentIndexerService` reads listing/mint events from supernode RPC pool |
| **Multi-chain** | Pluggable RPC URLs via `SUPERNODE_RPC_URLS` env |
| **Gas-sponsored ops** | Particle's account abstraction layer (where used) |

### 6.6 Comms gateways (`pc2-node/src/services/gateway/`)

- **WhatsApp** via `@whiskeysockets/baileys` — session in `data/whatsapp/`, agent receives + sends messages
- **Telegram** via `grammy` — bot token in env, agent receives + sends messages
- Both gateways route into the AI agent's `ToolExecutor`, allowing chat-based control of pc2-node

### 6.7 Sandboxing & runtimes

| Today | Future (v1.4+) |
|---|---|
| iframe-based dApps | WASM capsule runtime |
| bubblewrap PTY isolation | Continues alongside |
| First-party trust assumption | Capability tokens for 3rd-party creators |

---

## 7. Key end-to-end flows

### 7.1 Mint a video (creator flow)

```
USER on pc2-node A:
  1. Drops video file into desktop GUI → uploads to pc2-node API
  2. pc2-node:
     a. Writes file to local filesystem.ts (wallet-scoped path)
     b. Adds to local Helia → CID generated
     c. Pin recorded in pinned_cids table (status=complete)
     d. clusterPin.ts forwards CID to supernode cluster (HTTPS POST)
     e. Cluster CRDT-replicates to all peers within ~3 sec
     f. Supernode peers begin Bitswap-fetching bytes from pc2-node A
  3. User signs marketplace listing transaction (wallet popup)
  4. ContentIndexerService picks up the listing event, refreshes catalog
  5. Listing visible on marketplace dApp on every other pc2-node within 1 block
```

### 7.2 Buy and play a video (consumer flow)

```
USER on pc2-node B:
  1. Browses marketplace dApp → finds listing
  2. Signs purchase transaction
  3. dApp opens pc2-media-runtime
  4. media-runtime fetches CID from local IPFS (Helia Bitswap):
     a. Discovers providers via DHT: [supernode1, supernode2, pc2-node A]
     b. Pulls bytes from fastest provider (typically supernode on gigabit)
     c. Even if pc2-node A is offline, supernodes serve content
  5. Lit Protocol / Chipotle decrypts media key (secure-view DRM)
  6. DASH player streams decrypted bytes to user
```

### 7.3 Install a dApp

```
USER on pc2-node:
  1. Browses app registry → selects new dApp
  2. AppInstallService:
     a. Resolves dApp manifest (CID + metadata)
     b. Pulls bundle bytes via IPFS (and forwards to cluster for survival)
     c. Unpacks into data/test-apps/<dapp-name>/
     d. Registers with installed-apps.ts
  3. dApp appears in launcher, runs in iframe (today) / WASM capsule (v1.4+)
```

### 7.4 Self-update a node (operator flow)

```
NODE OPERATOR:
  1. Triggers update via:
     - GUI "check for updates" → UpdateService API
     - or shell: scripts/update.sh
  2. UpdateService / update.sh:
     a. pm2 stop pc2 (briefly)
     b. git fetch origin && git reset --hard origin/main
        (preserves pc2-node/.env — gitignored — so secrets survive)
     c. npm install (pulls @photostructure/sqlite, removes old deps)
     d. npm rebuild (verify native modules)
     e. Build frontend + backend (tsc)
     f. Verify @photostructure/sqlite + node-datachannel load
     g. pm2 start ecosystem.config.cjs (re-reads env defaults)
     h. Curl /health to verify boot
  3. Migrations apply at first boot (pc2-node/src/storage/migrations.ts)
```

---

## 8. Update + deployment lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│   Source of truth: github.com/<elacity>/pc2.net (main branch)       │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         │ git push (release tag = v1.2.7, etc.)
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│   Operator triggers update (one of):                                │
│     (a) `scripts/update.sh` (shell)                                 │
│     (b) GUI → UpdateService.performUpdate()                         │
│     (c) Auto-update on schedule (future)                            │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│   On the node:                                                      │
│     - pm2 stop pc2                                                  │
│     - git fetch + reset --hard                                      │
│     - npm install + rebuild                                         │
│     - tsc (build backend) + build frontend                          │
│     - pm2 start ecosystem.config.cjs                                │
│     - Migrations apply on first boot                                │
│     - Health check (curl /health)                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Key invariants**:
- `pc2-node/.env` is gitignored → operator secrets (cluster token, AI keys) survive updates
- `ecosystem.config.cjs` reads env from `process.env` → no need to edit tracked file
- Database file (`pc2.db`) is preserved across updates (only deleted on explicit factory reset)
- IPFS repo (`pc2-node/data/ipfs/`) is preserved — peer ID is stable across updates

---

## 9. Glossary

| Term | Definition |
|---|---|
| **PC2** | "Personal Cloud Computer" — a sovereign, self-hosted node running the pc2-node software. |
| **pc2-node** | The actual Node.js process. One per user. Runs Express + Helia + AI + DB. |
| **Supernode** | An always-on, fixed-IP server that holds replicas of network content. |
| **Cluster** | IPFS Cluster — orchestration software that replicates pins across multiple Kubo nodes via CRDT. |
| **CID** | Content Identifier — IPFS hash of a piece of content, used to retrieve it. |
| **Helia** | The modern JavaScript IPFS implementation (replaces js-ipfs). pc2-node uses it embedded. |
| **libp2p** | The networking library underneath Helia/Kubo. Handles transports, security, peer discovery. |
| **Kubo** | The Go IPFS implementation. Runs on supernodes (not in pc2-node). |
| **Bitswap** | The IPFS block exchange protocol — how peers swap content blocks. |
| **DHT** | Distributed Hash Table (Kademlia) — IPFS uses it to find which peers have which CIDs. |
| **SIWE** | Sign-In with Ethereum — auth standard where users prove identity by signing a message. |
| **Lit Protocol** | Decentralised access control / threshold encryption network. |
| **Chipotle** | Elacity's hosted Lit-Protocol-compatible PKP service for secure-view DRM. |
| **PKP** | Programmable Key Pair — Lit Protocol's wallet-as-a-smart-contract abstraction. |
| **Boson Active Proxy** | Java-derived protocol for routing pc2-node traffic through supernodes. |
| **Carrier** | Future control plane (post-v1.2.7) replacing libp2p for signaling. |
| **Capsule** | Planned WASM-based sandboxed app format for 3rd-party creators (v1.4+). |
| **dDRM** | Decentralised DRM — secure-view content protection on top of Lit/Chipotle. |
| **Update.sh** | The shell script every node runs to upgrade itself. |
| **Bubblewrap** | Linux sandboxing tool (`bwrap`) used to isolate terminal sessions per wallet. |
| **WireGuard** | Modern VPN protocol used for the operator/admin mesh between supernodes and select pc2-nodes. |

---

## 10. Infographic blueprint for designer

This section is intended as a brief for the graphic designer producing a professional infographic.

### 10.1 Recommended composition

A **single tall poster** (e.g. A2 or 1200×1800 px web), divided vertically into 5 panels. Each panel maps to a section above. Use colour-coded zones (3 tier colors + 2 for cross-cutting) and consistent iconography.

### 10.2 Panel-by-panel brief

**Panel 1 — "What is PC2?" (header + tier overview)**
- Hero text: *"A sovereign personal cloud computer."*
- Sub-text: 2-3 sentences from §1 (executive summary)
- Visual: 3 horizontal layers stacked (Tier 1 / Tier 2 / Tier 3) with clear separation
- Use **icons for users on the right**, **infrastructure on the left** to imply directionality

**Panel 2 — "Tier 1 — The supernode mesh"**
- 3 supernode icons (Contabo / InterServer / GCloud) with location pins (DE / US / Cloud)
- Lines between them showing CRDT replication
- Annotation: "Always-on, fixed-IP. Holds copies of every minted CID. ~1.3 TB of capacity."
- Small icons inside each supernode for: Kubo, Cluster, nginx, optional relay
- Suggested colour: deep blue / navy (infrastructure)

**Panel 3 — "Tier 2 — Your pc2-node"**
- A central rectangle representing the pc2-node, broken into ~6 visible subsystems (HTTP API, IPFS, AI, DB, Sandbox, Comms)
- 3-5 example device icons surrounding it (Jetson Orin, Raspberry Pi, MacBook, VPS, old PC)
- Annotation: *"One per user. Self-hosted on your hardware."*
- Show 4-6 horizontal "service" pills inside (Files / AI / Marketplace / Apps / Identity / Comms)
- Suggested colour: warm green (sovereignty)

**Panel 4 — "Tier 3 — How users see it"**
- Devices: phone / laptop / desktop / browser, each with arrows to "Tier 2" rectangle
- Mini-screenshots or wireframe sketches of: marketplace, file browser, AI chat, dApp launcher
- Suggested colour: bright orange / yellow (user)

**Panel 5 — "The full picture (key flows)"**
Recommended: 2 small flow diagrams side-by-side:
- **Left**: "Mint a video" — arrows from User → Tier 2 → Tier 1 → DHT → All peers
- **Right**: "Buy and play" — arrows from User → Tier 2 → DHT → fetches from Tier 1 → decrypts → plays

Below: a small "Update lifecycle" callout (4 boxes: github → operator → node → live)

### 10.3 Iconography suggestions

| Concept | Icon hint |
|---|---|
| Supernode | Server rack with WiFi waves |
| pc2-node | Cube / sovereignty symbol |
| User | Person silhouette |
| Wallet | Key + chain |
| IPFS | Hex pattern (the IPFS logo motif) |
| Cluster | Connected nodes (small graph) |
| DRM / Lit | Lock + lightning |
| AI | Speech bubble + chip |
| WireGuard | Tunnel / shield |
| File | Document |
| Marketplace | Storefront |

### 10.4 Colour palette suggestion

- **Tier 1 (infrastructure)**: deep navy (`#0a2540`) + accent blue (`#3a7af0`)
- **Tier 2 (sovereign nodes)**: forest green (`#1e6f3a`) + accent lime (`#7ed957`)
- **Tier 3 (clients)**: warm orange (`#f0832d`) + accent yellow (`#ffd166`)
- **Cross-cutting (security/AI/web3)**: muted purple (`#6c4ab6`)
- **Backgrounds**: off-white (`#fbfaf7`) + soft grey (`#e8e6e0`)

### 10.5 What to keep OFF the infographic (for security reasons)

- ❌ Production IP addresses (use generic icons + location pins instead)
- ❌ Domain names that aren't already publicly advertised (`ipfs.ela.city` is OK; cluster URLs are not)
- ❌ Bearer tokens, API keys, peer IDs, wallet addresses
- ❌ Internal VPN subnets

### 10.6 Optional V2 — interactive web version

An HTML version of this map could be built later: each panel becomes a clickable tile that expands to show the relevant code modules. The existing `docs/pc2-architecture-diagram.html` (already in repo) could be the starting point for a v2.

---

## Appendix A — Files referenced (for the curious)

- Audit basis: `pc2-node/src/{api,services,storage}/*`, `scripts/update.sh`, `ecosystem.config.cjs`
- Cluster integration: `pc2-node/src/services/clusterPin.ts`, `.cursor/tasks/SUPERNODE-CLUSTER-SETUP/`
- AI: `pc2-node/src/services/ai/providers/*`
- Web3: `pc2-node/src/api/wallet.ts`, `pc2-node/src/api/did.ts`
- Lit/Chipotle: `pc2-node/src/api/chipotle-client.ts`, `pc2-node/src/api/setup.ts`
- DRM viewer: `pc2-node/data/test-apps/pc2-media-runtime/`
- Marketplace: `pc2-node/data/test-apps/elacity-market/`
- Update flow: `scripts/update.sh`, `pc2-node/src/services/UpdateService.ts`
- WireGuard: `pc2-node/src/services/wireguard/`, `scripts/setup-wireguard-client.sh`
- Boson: `pc2-node/src/services/boson/`, `packages/boson-activeproxy-ts/`
- This doc: `docs/SYSTEM_MAP.md`

---

*Document maintained by the PC2 engineering team. To request changes, file a task in `.cursor/tasks/SYSTEM-MAP-UPDATE/` describing the addition or correction.*
