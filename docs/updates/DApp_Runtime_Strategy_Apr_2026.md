# dApp-to-Runtime Capsule Strategy & Next Steps

> **Date:** April 2, 2026
> **Branch:** `feature/lit-chipotle-migration`
> **Context:** Post-Glide Finance integration, pre-Lit mainnet swap

---

## Executive Summary

Glide Finance is the first third-party DeFi dApp running inside PC2 — packaged as a downloadable, locally-served app with wallet bridge integration. This validates the dApp Store model: users install apps from other PC2 nodes or IPFS, and apps run in sandboxed iframes with capability-gated wallet access.

**What's done:** Core DEX features (Swap, Liquidity, Farm, Stake, Analytics) work on Elastos Smart Chain. Wallet bridge handles MetaMask + WalletConnect. Token approvals and swaps confirmed on-chain.

**What's next:** Lit Protocol mainnet is now live. Priority shifts to the Elacity Creator/Market apps with production dDRM, then back to dApp Store packaging for broader distribution.

---

## Table of Contents

1. [Glide Finance — Current State](#glide-finance--current-state)
2. [Outstanding Infrastructure Items](#outstanding-infrastructure-items)
3. [dApp-to-Capsule Evolution Strategy](#dapp-to-capsule-evolution-strategy)
4. [Lit Protocol Mainnet Transition](#lit-protocol-mainnet-transition)
5. [Elacity App — Next Priority](#elacity-app--next-priority)
6. [Returning to Glide Later](#returning-to-glide-later)
7. [Task Sequence](#task-sequence)

---

## Glide Finance — Current State

### Working Features
| Feature | Status | Notes |
|---------|--------|-------|
| Swap | **Working** | On-chain confirmed (tx `0xb5b9...35b1`) |
| Liquidity (Add/Remove) | **Working** | Token approvals + LP operations verified |
| Farm | **Working** | Stake LP tokens, view rewards |
| Stake (Pools) | **Working** | Single-asset staking pools |
| stELA (Liquid Staking) | **Working** | Liquid staking interface loads |
| Analytics | **Working** | TVL, volume, token data via subgraph |
| Governance | **Working** | Links to Snapshot (external) |
| Bridge | **Hidden** | Architectural limitation (see below) |

### Wallet Bridge Capabilities
| Capability | MetaMask | WalletConnect | Particle Auth |
|------------|----------|---------------|---------------|
| Connect | Yes | Yes | Yes (embedded) |
| Sign transactions | Yes | Yes | Yes |
| Switch to ESC | Yes (auto) | Yes (auto) | N/A (ESC default) |
| Gas estimation | Yes | Yes | Yes |
| Token approvals | Yes | Yes | Yes |
| Multi-chain reads | ESC only | ESC only | ESC only |

### Bridge Page — Known Limitation

**Problem:** Glide's Bridge page automatically fires multiple `wallet_switchEthereumChain` calls during initialization (ESC → BSC → ETH → ESC) to load balances from different chains. In PC2's sandboxed iframe, all RPC traffic flows through a single `window.ethereum` proxy. These rapid chain switches destabilize ethers.js v5 providers (which are strictly bound to their initialization chain), causing `NETWORK_ERROR: underlying network changed`.

**What was tried:**
1. Dynamic `bridgeChainId` updates + `chainChanged` events — caused providers to crash
2. Iframe reload on chain change — caused infinite reload loop (Glide re-triggers switches on init)
3. `NETWORK_ERROR` suppression — chain switched mechanically but Glide UI didn't update

**Current solution:** `bridgeChainId` pinned to ESC (20). Bridge tab hidden via CSS + MutationObserver. All read RPCs route to ESC. `wallet_switchEthereumChain` forwarded to MetaMask fire-and-forget for signing.

**Future fix (dApp sandboxing v2):** Per-request chain routing in wallet bridge, or dApp-side isolated `JsonRpcProvider` instances per chain. Requires capsule-level network capability tokens to properly scope chain access.

### Technical Artifacts

| Component | File | Purpose |
|-----------|------|---------|
| Wallet Bridge (parent) | `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` | Intercepts RPC from iframes, routes to wallet/chain RPCs |
| Wallet Provider (child) | `pc2-node/frontend/pc2-wallet-provider.js` | EIP-1193 shim injected into dApp iframes |
| Glide App | `pc2-node/data/test-apps/glide-finance/` | Bundled static frontend |
| RPC Cache | In `pc2-wallet-bridge.js` | TTL cache per RPC method |
| Chain Metadata | In `pc2-wallet-bridge.js` | 9 chains with RPCs + metadata for `wallet_addEthereumChain` |
| WASM Multicall | `pc2-node/packages/evm-multicall/` | Rust WASM Multicall3 encoder |
| WASM AMM Engine | `pc2-node/packages/amm-engine/` | Rust WASM Uniswap V2 math |

---

## Outstanding Infrastructure Items

### 1. Contabo ESC RPC Sync (Priority: Medium)

**Status:** Full ESC node started on Contabo supernode (38.242.211.112), systemd service configured, gateway proxy at `/rpc/esc` with method whitelist. Sync was initiated but completion needs verification.

**What needs doing:**
```bash
# SSH to Contabo and check sync status
ssh root@38.242.211.112
curl -s http://127.0.0.1:20636 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}'

# If synced (returns false), test from a PC2 node:
curl -s https://contabo.ela.city/rpc/esc -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

**Once synced:**
- Verify `/api/rpc/esc` returns correct block numbers
- The RPC is already first in `CHAIN_RPC_URLS[20]` array in wallet bridge
- All PC2 nodes automatically use it as primary ESC endpoint
- Fallback to `api.elastos.io/eth` and `api.elastos.io/esc` if unreachable

### 2. ESC Subgraph (Priority: Low — Workaround in Place)

**Status:** Glide depends on TheGraph hosted service for ESC data (pairs, tokens, volumes). The hosted subgraph is unreliable:
- `DEADLINE_EXCEEDED` errors on complex queries
- Stale data (hours behind chain head)
- No SLA or uptime guarantee

**Current workaround:** Deadline fix with `block_constraint: "number_gte"` parameter reduces stale-data errors.

**Long-term solution:** Self-hosted subgraph on Contabo:
1. Install Graph Node + IPFS + PostgreSQL on Contabo
2. Point Graph Node at local ESC full node (once synced)
3. Deploy Glide's subgraph definition
4. Update Glide's frontend config to use self-hosted endpoint
5. Benefits all ESC dApps, not just Glide

**Complexity:** Medium. Graph Node requires ~16GB RAM + fast SSD. Contabo has capacity but this is a separate project.

### 3. WASM Multicall & AMM Engine Integration (Priority: Low — Built but Not Wired)

**Status:** Both Rust WASM crates are built and compiled:
- `evm-multicall` (116KB) — Multicall3 ABI encoder/decoder
- `amm-engine` (143KB) — Uniswap V2 AMM math

**Not yet wired:** These were built for potential future optimization (batch RPC calls, client-side price calculation). Glide works fine without them since its existing JS handles these operations. Wire these when building a native DEX UI or when RPC call volume becomes a bottleneck.

---

## dApp-to-Capsule Evolution Strategy

### The Journey: Glide as Proof of Concept → Capsule Distribution

```
TODAY (v1.x — iframe sandbox):
  Developer bundles dApp as static files (HTML/JS/CSS)
  → User downloads via dApp Store or IPFS
  → App served locally from installed-apps/
  → Runs in sandboxed iframe with postMessage wallet bridge
  → Security: CSP + iframe sandbox + wallet bridge gatekeeping
  → Distribution: bundled in PC2 or manual install

v1.5 (dApp Store):
  Same technical model, but with marketplace distribution
  → Encrypt dApp bundle with Lit Protocol dDRM
  → Mint as ACCESS_TOKEN on Base
  → Users purchase → decrypt → auto-install
  → Apps discoverable via dApp Store UI
  → Revenue split: 95% developer, 5% protocol
  → Security: same iframe sandbox + signed manifests

v2.0 (Runtime Capsules):
  dApps become signed capsules with capability tokens
  → Developer signs bundle with Ed25519 key
  → Runtime verifies signature before loading
  → Each app gets isolated WASM sandbox (Wasmtime)
  → Network access gated by capability tokens
  → Wallet access gated by capability tokens
  → Multi-chain support via per-capsule provider configs
  → Bridge page works: each capsule gets its own providers
  → Distribution: CID-addressed, verified before execution
  → Security: ENFORCED by Runtime (not best-effort)
```

### What Glide Proved

1. **Third-party React dApps work in PC2 iframes** — no code changes to Glide's frontend
2. **Wallet bridge pattern is viable** — `postMessage` → parent handler → `window.ethereum` scales to any EVM dApp
3. **RPC proxy + cache dramatically improves performance** — 38x speedup on cached methods
4. **Single-chain dApps work perfectly** — Swap, Liquidity, Staking all work on ESC
5. **Multi-chain dApps hit architectural limits** — Bridge page needs per-request chain isolation, which requires capsule-level network scoping
6. **Auto-connect simplifies UX** — `connectorIdv2: 'injected'` + auto ESC switch on load

### What Needs to Change for Capsules

| Current (iframe) | Future (capsule) |
|-------------------|------------------|
| `postMessage` wallet bridge | Capability token: `{ action: "wallet:sign", chain: 20 }` |
| Single global `bridgeChainId` | Per-capsule chain configuration |
| CSS/JS to hide broken features | Manifest declares supported features |
| Manual `index.html` patching | Manifest-driven injection |
| `express.static` serving | Runtime HTTP proxy from capsule sandbox |
| No signature verification | Ed25519 signature check before load |
| Trust: iframe sandbox (escapable) | Trust: WASM sandbox (enforced) |

### Capsule Packaging Format (Target)

```json
{
  "name": "glide-finance",
  "version": "1.0.0",
  "signature": "ed25519:<hex>",
  "contentHash": "sha256:<hex>",
  "manifest": {
    "entry": "index.html",
    "permissions": {
      "wallet": {
        "chains": [20],
        "methods": ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4"]
      },
      "network": {
        "rpc": {
          "20": ["https://api.elastos.io/eth"],
          "1": ["https://ethereum-rpc.publicnode.com"]
        }
      },
      "storage": "none"
    },
    "features": ["swap", "liquidity", "farm", "stake"],
    "excludedRoutes": ["/bridge"]
  }
}
```

---

## Lit Protocol Mainnet Transition

### Status: UNBLOCKED

Lit Protocol's Chipotle network is now live on mainnet (confirmed April 2026). This unblocks the entire Elacity dDRM production pipeline.

### What This Means

| Component | Dev Network (current) | Mainnet (target) |
|-----------|----------------------|-------------------|
| Lit Actions | Registered on Chipotle dev | Re-register on Chipotle mainnet |
| PKP keys | Dev network keys | New mainnet PKP |
| Capacity credits | Dev credits (free) | Production credits (paid) |
| API URL | Dev Chipotle API | Production Chipotle API |
| Encryption | Working E2E on dev | Same code, production endpoints |

### Migration Steps

1. **Create production Lit account** at `dashboard.litprotocol.com`
2. **Register 4 Lit Action CIDs** (media-decrypt, non-media-decrypt, media-encrypt, non-media-encrypt)
3. **Create scoped API key** for production use
4. **Fund account** with capacity credits
5. **Update `chipotle-client.ts`**: `DEFAULT_API_URL`, `DEFAULT_PKP_ID`
6. **Update `deploy/web-gateway/index.js`**: provisioning config for both supernodes
7. **Deploy to InterServer + Contabo supernodes**
8. **E2E test**: mint → buy → decrypt (media + non-media)
9. **Update Creator Dashboard**: verify publish pipeline works end-to-end
10. **Update Market app**: verify purchase + decrypt works

### Risk: Capacity Credit Costs

Dev network has free credits. Production will have costs. Need to:
- Monitor credit consumption per encrypt/decrypt operation
- Implement credit budgeting in PC2 node config
- Plan for self-provisioned RLI tokens (each node mints own credits)

---

## Elacity App — Next Priority

### Why Elacity Next (Not More Glide)

1. **Lit mainnet is live** — the biggest blocker for Elacity production is cleared
2. **Glide is stable** — core DEX features work, Bridge is an edge case hidden from users
3. **Elacity is our product** — Glide is a third-party app proving dApp Store viability; Elacity is the core marketplace
4. **Revenue path** — Elacity Creator/Market with production dDRM enables real content sales with 5% protocol fee
5. **Capsule convergence** — Elacity apps (Creator, Market, Player, Viewer) become the reference capsules for Runtime v2

### Elacity App + Lit Mainnet Work Plan

**Phase 1: Lit Mainnet Swap (1-2 days)**
- [ ] Create production Lit account
- [ ] Register Lit Action CIDs on mainnet
- [ ] Update `chipotle-client.ts` endpoints
- [ ] Deploy to supernodes
- [ ] E2E test: encrypt → mint → buy → decrypt

**Phase 2: Creator Dashboard Production (1-2 days)**
- [ ] Verify full publish pipeline on Lit mainnet (file → encrypt → IPFS → mint)
- [ ] Test capacity credit consumption
- [ ] Verify channel creation + management
- [ ] Test both EOA and Agent Wallet minting

**Phase 3: Market App Production (1-2 days)**
- [ ] Verify purchase + decrypt on Lit mainnet
- [ ] Test media playback (DASH/CENC pipeline)
- [ ] Test non-media viewing (images, PDFs, 3D, etc.)
- [ ] Verify resale flow

**Phase 4: Wallet Bridge for Elacity (if needed)**
- Elacity apps already use the PC2 wallet bridge
- Verify everything still works with latest bridge changes
- Base chain (chain ID 8453) may need adding to `CHAIN_RPC_URLS` if not already present

---

## Returning to Glide Later

### When to Return

1. **After capsule architecture is designed** — per-capsule chain scoping solves Bridge page
2. **After ESC subgraph is self-hosted** — reliable data for Analytics + Farm APR
3. **After Contabo ESC RPC is synced** — self-sovereign chain access verified

### What to Fix When Returning

| Item | Effort | Dependency |
|------|--------|------------|
| Bridge page chain switching | High | Capsule v2 network isolation |
| Self-hosted ESC subgraph | Medium | Contabo ESC full node synced |
| Remove subgraph deadline workaround | Low | Self-hosted subgraph |
| Add Glide to dApp Store | Medium | dApp Store UI + packaging pipeline |
| Wire WASM multicall + AMM engine | Low | Optional optimization |
| Glide auto-update from IPFS CID | Medium | dApp Store auto-update mechanism |

### Glide as a Capsule (Future Vision)

When Runtime v2 capsule architecture is ready:
1. Package Glide as signed capsule with `capsule.json` manifest
2. Declare chain permissions: `wallet.chains: [20]` (ESC only for v1)
3. Declare excluded routes: `/bridge` (until multi-chain capsule support)
4. Distribute via IPFS CID — any PC2 node can install
5. Users download from dApp Store or directly from another PC2 node
6. Runtime verifies signature, grants capability tokens, launches in WASM sandbox

---

## Task Sequence

### Immediate (This Week)
1. **Verify Contabo ESC RPC sync status** — SSH check, confirm block height
2. **Begin Lit mainnet swap** — production account, API keys, Lit Action CIDs
3. **E2E test Elacity on Lit mainnet** — full pipeline: encrypt → mint → buy → decrypt

### Short-term (Next 1-2 Weeks)
4. **Production deploy Elacity** — Creator + Market on Lit mainnet, both supernodes
5. **V3 contract migration** (when ABIs arrive) — update addresses in 8+ locations
6. **v1.3 release prep** — merge to main, tag, test on fresh installs

### Medium-term (This Month)
7. **Contabo ESC subgraph** — Graph Node setup (if ESC RPC is synced)
8. **dApp Store UI** — categories, search, install flow
9. **dApp packaging format** — manifest spec, signed bundles

### Returning to Glide (Future)
10. **Per-capsule network isolation** — design in capsule v2 architecture
11. **Glide capsule packaging** — first third-party capsule in dApp Store
12. **Bridge page fix** — with proper chain-scoped providers

---

*This document is a living strategy guide. Update as external dependencies resolve (V3 contracts, Lit mainnet details, Runtime capsule spec).*
