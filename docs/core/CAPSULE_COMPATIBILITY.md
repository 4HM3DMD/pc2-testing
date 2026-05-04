# PC2 v1 Capsule Compatibility Assessment

> **Purpose:** Map every PC2 v1 component to its ElastOS Runtime capsule equivalent, document readiness, and track refactoring needed for convergence.
> **Created:** 2026-04-03
> **Last Updated:** 2026-04-03
> **Related:** [ARCHITECTURE_CONVERGENCE.md](./ARCHITECTURE_CONVERGENCE.md) | [APP_MANIFEST_SPEC.md](./APP_MANIFEST_SPEC.md) | [NAMESPACE_MAPPING.md](./NAMESPACE_MAPPING.md) | [ROADMAP.md](./ROADMAP.md)

---

## Runtime Study Summary (Apr 2026)

Deep analysis of [github.com/Elacity/elastos-runtime](https://github.com/Elacity/elastos-runtime) (state.md dated 2026-03-31). The Runtime is a pure Rust monorepo (~16K LOC) targeting 5-7K trusted core lines.

### What Genuinely Works

| Component | Evidence | Notes |
|-----------|----------|-------|
| Signed installs | `elastos setup` fetches, verifies Ed25519, installs | Full chain of trust from CID to execution |
| WASM execution (Wasmtime) | `wasm32-wasip1` capsules execute in sandbox | Same target as all 6 of our Rust crates |
| microVM execution (crosvm) | Rootless on Linux (KVM) | Jetson/WSL verified. macOS cannot run microVMs (no KVM) |
| Carrier P2P | iroh-based QUIC + DHT + relay | Native-to-WASM interop proven Mar 30 |
| Capability tokens | Ed25519-signed structs with resource/action/constraints | 12 checks per invocation |
| Data capsules | Signed content + viewer | Maps directly to our `.ddrm` descriptor |
| AI provider | `elastos://ai/` → llama-provider | LLM routing already capsule-native |
| DID identity | `did:key` from Ed25519 keypair | Per-machine identity, not per-user |
| Namespace model | `localhost://Users/`, `UsersAI/`, `AppCapsules/` | Documented, file-backed |
| Shell capsule | Puter running inside a microVM | Orchestrates capability prompts |

### What's Still Rough

| Item | Impact |
|------|--------|
| `components.json` CID/checksum fields mostly empty | Release pipeline not fully automated |
| macOS: full security model works, code signing + notarization | **COMPLETE** — Apple notarized, v1.2.2 released. Double-click install, no Terminal needed |
| No blockchain/EVM wallet integration | **Biggest gap** for Elacity — gates ACCESS_TOKEN bridge |
| No marketplace, no dApp store UI | Runtime is pure infrastructure, no commerce layer |
| No encrypted capsules (DRM) | Provider interface documented but not implemented |
| No Windows support | Not a priority for Runtime team |
| No mobile support | Listed as "Later" in TASKS.md |

### What Doesn't Exist Yet (Critical for Elacity)

1. **EVM wallet** — No `ethers.js`, no `window.ethereum`, no transaction signing
2. **ACCESS_TOKEN → capability token bridge** — The core dDRM authorization mechanism
3. **On-chain verification** — `hasAccessByContentId()` has no Runtime-side equivalent
4. **Payment flows** — No purchase, no marketplace economics
5. **Content encryption/decryption capsule** — Provider interface exists, implementation doesn't

---

## Why Convergence, Not Migration

The Runtime is infrastructure. PC2 is a product. They converge, they don't swap.

```
Phase 1 (Now):  PC2 v1 ships as a standalone Node.js product.
                Design all new code to be capsule-compatible.
                The Runtime doesn't need to exist for PC2 to work.

Phase 2 (v1.5): PC2 Node.js becomes a "host adapter" for the Runtime.
                Runtime handles WASM/microVM execution + capability enforcement.
                PC2 handles HTTP API, frontend, marketplace, wallet bridge.

Phase 3 (v2.0): Full sovereignty. Every service is a signed capsule.
                PC2 Node.js is just one host adapter among many
                (desktop, mobile, kiosk).
```

**Key insight from Runtime audit:** The Runtime defines four host adapter modes — server/headless, desktop, mobile, kiosk. Our PC2 Node.js server + browser-rendered desktop IS the "server/headless" host adapter. This validates our current architecture and positions PC2 as the reference implementation.

### Risk: Blockchain Integration Gap

The Runtime has NO EVM wallet, on-chain verification, or payment flows yet (marked "Next" in TASKS.md, timeline unknown). This gates the ACCESS_TOKEN → capability token bridge — the central integration point for Elacity dDRM.

**Mitigation:** Continue building on PC2 v1. Design for capsule compatibility at every boundary. Integrate with Runtime as it matures. The dDRM Provider Capsule is the natural first convergence point.

---

## Capsule-Compatible Inventory

### Trust Boundaries Mapped to Capsule Concepts

| PC2 v1 Boundary | Current Implementation | Capsule-Compatible Refactoring (v1.x) | Runtime v2 Target |
|---|---|---|---|
| **API authentication** | Session token grants full access | `CapabilityPrincipal` with typed scopes | Capability token per operation |
| **App installation** | No signature check | Ed25519 verify (warn-only in v1) | Ed25519 verify (enforced, blocks unsigned) |
| **Service interfaces** | Ad-hoc Express routes | Typed provider interfaces (`DRMProvider`, `StorageProvider`) | stdin/stdout JSON provider contract |
| **Wallet access** | Open `postMessage` to any iframe | Origin tracking + method scope classification | Capability-gated wallet operations |
| **dDRM descriptor** | Unsigned JSON blob | Content-hashed + signer field | Signed data capsule |
| **Scope vocabulary** | Scattered (scopes, permissions, capabilities) | Unified `CAPABILITY_SCOPES` constant | Capability token `action` field |
| **WASM execution** | Wasmer WASI in-process, hardcoded args | Per-job audit logging (fingerprint, duration, exit code), correct `argv[0]`, memory limit warnings, capsule manifests | Wasmtime with capability tokens per invocation |
| **File access** | Session token grants full filesystem | App manifest `storage.read[]`/`storage.write[]` paths | `localhost://` namespace with scoped capability |

### Implementation Status

| Refactoring | File(s) | Status | Breaking? |
|---|---|---|---|
| Unified capability vocabulary | `pc2-node/src/types/capabilities.ts` | **Implemented Apr 3** | No — new file, constants only |
| `CapabilityPrincipal` in middleware | `pc2-node/src/api/middleware.ts` | **Implemented Apr 3** | No — additive interface, v1 sessions get full caps |
| `requireCapability()` middleware | `pc2-node/src/api/middleware.ts` | **Implemented Apr 3** | No — opt-in per route, not wired to block |
| Ed25519 signature verify | `pc2-node/src/services/AppInstallService.ts` | **Implemented Apr 3** | No — warn-only, unsigned apps still install |
| Provider operation interfaces | `pc2-node/src/services/providers/types.ts` | **Implemented Apr 3** | No — TypeScript interfaces only |
| Wallet bridge origin validation | `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` | **Implemented Apr 3** | No — warn-only, all RPC still passes |
| dDRM capsule content hash | `pc2-node/data/test-apps/elacity-creator/app.js` | **Implemented Apr 3** | No — extra JSON fields, readers ignore unknown |
| Fix `args[0]` in WASMRuntime | `pc2-node/src/services/wasm/WASMRuntime.ts` | **Implemented Apr 3** | No — passes correct module name instead of hardcoded `'ddrm-renderer'` |
| Per-job capsule audit logging | `pc2-node/src/services/wasm/WASMRuntime.ts` | **Implemented Apr 3** | No — additive structured log (`capsule-audit` tag) |
| Memory limit warnings | `pc2-node/src/services/wasm/WASMRuntime.ts` | **Implemented Apr 3** | No — warning when binary approaches `defaultMaxMemoryMb` |
| Capsule manifests per WASM module | `pc2-node/wasm-apps/*/capsule.json` | **Implemented Apr 3** | No — new JSON files alongside .wasm binaries |
| Reproducible build config | `pc2-node/.cargo/config.toml` | **Implemented Apr 3** | No — pins `wasm32-wasip1` target, release profile for CI |
| Build script SHA-256 integration | `pc2-node/scripts/build-wasm.sh` | **Implemented Apr 3** | No — auto-populates `capsule.json` sha256 after build |
| mp4-split `split_init` mode | `pc2-node/crates/mp4-split/src/main.rs` | **Implemented Apr 3** | No — new WASM mode, triggered by command.json |
| WASM init-split integration | `pc2-node/src/services/wasm/WASMRuntime.ts` | **Implemented Apr 3** | No — new `executeMp4InitSplit()` method |
| WASM-first init splitting | `pc2-node/src/api/media.ts` | **Implemented Apr 3** | No — WASM-first with JS fallback, transparent |
| Fix CEK security comments | `pc2-node/src/api/storage.ts` | **Implemented Apr 3** | No — documentation-only, corrects misleading claims |
| CEK Exposure Assessment | `docs/core/CAPSULE_COMPATIBILITY.md` | **Implemented Apr 3** | No — new documentation section |

---

## WASM Crate Compatibility Matrix

All 7 Rust crates already target `wasm32-wasip1` — the same target the Runtime uses for WASM capsules. No recompilation needed.

| Crate | Size | Purpose | Capsule Role | Provider Operation |
|-------|------|---------|-------------|-------------------|
| `ddrm-renderer` | ~482KB | AES-GCM decrypt, PDF/text/image render | **dDRM Provider Capsule** (core) | `drm:decrypt`, `drm:render` |
| `cenc-decrypt` | ~60KB | AES-128-CTR CENC for fMP4/DASH | **dDRM Provider Capsule** (media) | `drm:decrypt-media` |
| `cenc-encrypt` | ~65KB | AES-128-CTR CENC encrypt + PSSH | **dDRM Provider Capsule** (creator) | `drm:encrypt-media` |
| `ipfs-assemble` | ~45KB | UnixFS chunk assembly | **Storage Provider Capsule** | `storage:assemble` |
| `mp4-split` | ~91KB | ISO BMFF splitter | **Compute Provider Capsule** | `compute:mp4-split` |
| `evm-multicall` | ~116KB | Multicall3 encode/decode | **Network Provider Capsule** | `network:multicall` |
| `amm-engine` | ~143KB | Uniswap V2 AMM math | **Compute Provider Capsule** | `compute:amm` |

### Build Pipeline

Current: `scripts/build-wasm.sh` → `cargo build --release --target wasm32-wasip1` → `wasm-opt` → `wasm-apps/<name>/` → auto-update `capsule.json` sha256

Each module now ships with a `capsule.json` manifest declaring its name, capabilities, provider operations, and MemFS contract. The build script auto-populates the `sha256` field after compilation. For full capsule packaging: sign the manifest + binary with Ed25519. The Runtime's `components.json` already defines the format (`cid`, `sha256`, `size`, `platforms`).

### Capsule Manifest Format

```json
{
  "name": "<module-name>",
  "version": "1.0.0",
  "target": "wasm32-wasip1",
  "binary": "<module-name>.wasm",
  "sha256": "<auto-populated by build script>",
  "capabilities": ["<capability-scope>", ...],
  "provider_operations": ["<provider:operation>", ...],
  "memfs": {
    "input": ["/input/command.json", ...],
    "output": ["/output/result.json", ...]
  },
  "runtime_compatibility": {
    "wasi_preview": 1,
    "entry": "_start",
    "capsule_type": "wasm"
  }
}
```

### Reproducible Builds

`pc2-node/.cargo/config.toml` pins `wasm32-wasip1` as the default target with release profile: `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`. Crypto crates override to `opt-level = 3`.

---

## Provider Operation Mapping

PC2 API endpoints grouped by the Runtime's provider contract model (stdin/stdout JSON: `fetch`, `store`, `list`, `delete`).

### `drm:*` — DRM Provider

| Operation | PC2 Endpoint | Runtime Provider Method |
|-----------|-------------|----------------------|
| Decrypt non-media | `POST /api/storage/lit/secure-view` | `drm:decrypt` → `fetch` with CEK in response |
| Decrypt media (CENC) | `POST /api/media/decrypt-segment` | `drm:decrypt-media` → `fetch` per segment |
| Verify access | `eth_call` to `AuthorityGateway.hasAccessByContentId()` | `drm:verify-access` → `fetch` returns boolean |
| Encrypt non-media | `POST /api/storage/lit/encrypt` | `drm:encrypt` → `store` |
| Encrypt media (CENC) | Internal WASM pipeline | `drm:encrypt-media` → `store` |

### `storage:*` — Storage Provider

| Operation | PC2 Endpoint | Runtime Provider Method |
|-----------|-------------|----------------------|
| Read file | `POST /read` | `storage:read` → `fetch` |
| Write file | `POST /write` | `storage:write` → `store` |
| List directory | `POST /readdir` | `storage:list` → `list` |
| Delete file | `POST /delete` | `storage:delete` → `delete` |
| Pin to IPFS | `POST /api/storage/ipfs/pin` | `storage:pin` → `store` |
| Fetch from IPFS | `GET /ipfs/:cid` | `storage:ipfs-fetch` → `fetch` |

### `identity:*` — Identity Provider

| Operation | PC2 Endpoint | Runtime Provider Method |
|-----------|-------------|----------------------|
| Authenticate | `POST /auth/particle` | `identity:auth` → `fetch` |
| Get user | `GET /whoami` | `identity:whoami` → `fetch` |
| Resolve DID | `GET /api/did/:did` | `identity:resolve` → `fetch` |
| Sign data | `POST /sign` | `identity:sign` → `store` (persists signature) |

### `compute:*` — Compute Provider

| Operation | PC2 Endpoint | Runtime Provider Method |
|-----------|-------------|----------------------|
| Execute WASM | `POST /api/wasm/execute` | `compute:wasm` → `fetch` (result in response) |
| AI chat | `POST /api/ai/chat` | `compute:ai-chat` → `fetch` |
| Terminal exec | `POST /api/terminal/exec` | `compute:shell` → `fetch` |

---

## App Manifest to Capsule Manifest Bridge

### Current `app.json` (v1.0)

```json
{
  "name": "elacity-player",
  "title": "Elacity Player",
  "version": "1.0.0",
  "type": "web",
  "capabilities": {
    "wallet": true,
    "drm": true,
    "ipfs": { "fetch": true },
    "ipc": ["launchApp"]
  },
  "distribution": {
    "cid": null,
    "signature": null,
    "signedBy": null
  }
}
```

### Target `capsule.json` (Runtime v2)

```json
{
  "name": "elacity-player",
  "version": "1.0.0",
  "type": "web",
  "entry": "index.html",
  "signature": "ed25519:<hex>",
  "contentHash": "sha256:<hex>",
  "capabilities": [
    { "resource": "drm:*", "action": "fetch" },
    { "resource": "storage:ipfs/*", "action": "fetch" },
    { "resource": "wallet:sign", "action": "execute" },
    { "resource": "ipc:launchApp", "action": "execute" }
  ]
}
```

### Bridge Path

1. **v1.0 (now):** `app.json` with `capabilities` object — metadata only, not enforced
2. **v1.5 (next):** `app.json` + `distribution.signature` verified at install — warn in v1.x, block in v1.5
3. **v2.0 (Runtime):** `capsule.json` generated from `app.json` during packaging — capabilities become typed capability token requests

The `CAPABILITY_SCOPES` vocabulary (implemented in `pc2-node/src/types/capabilities.ts`) is the single mapping between `app.json` capability keys and Runtime capability token `action` fields.

---

## dDRM Capsule Format Evolution

### Current `.ddrm` (v2)

```json
{
  "schema": "ddrm-capsule-v2",
  "type": "non-media",
  "version": 1,
  "title": "My Asset",
  "encryptedDataCid": "Qm...",
  "kid": "0x...",
  "litCiphertext": "...",
  "authority": "0x8fe6bf98...",
  "acquiredBy": "0x..."
}
```

### Capsule-Compatible `.ddrm` (v2 + hash)

```json
{
  "schema": "ddrm-capsule-v2",
  "type": "non-media",
  "version": 1,
  "title": "My Asset",
  "encryptedDataCid": "Qm...",
  "kid": "0x...",
  "litCiphertext": "...",
  "authority": "0x8fe6bf98...",
  "acquiredBy": "0x...",
  "capsuleHash": "sha256:<hex of canonical JSON without this field>",
  "signedBy": "0x<creator wallet address>"
}
```

### Runtime Data Capsule (v3 — future)

```json
{
  "schema": "ddrm-capsule-v3",
  "signature": "ed25519:<hex>",
  "contentHash": "sha256:<hex>",
  "capabilities_required": [
    { "resource": "drm:decrypt", "params": { "kid": "0x..." } }
  ],
  "payload": { ... }
}
```

The `capsuleHash` field added in v2 makes `.ddrm` files content-addressable, which is a prerequisite for the Runtime's signed data capsule model.

---

## Wallet Capability Model

### Current (v1): Open Bridge

```
Any iframe → postMessage('pc2-wallet-rpc') → Parent handler → window.ethereum
                    No origin check
                    No method filtering
                    No capability requirement
```

### After Refactoring (v1.x): Tracked Bridge

```
Iframe → postMessage('pc2-wallet-rpc')
    ↓
Origin check → WARN if unregistered (v1: allow, v2: block)
    ↓
Method classification:
    DIRECT_RPC_METHODS (eth_chainId, etc.) → network:read capability
    eth_sendTransaction, personal_sign     → wallet:sign capability
    ↓
handleRpc() → window.ethereum (unchanged in v1)
```

### Runtime (v2): Capability-Gated

```
Capsule → capability token request: { action: "wallet:sign", chain: 8453 }
    ↓
Shell capsule → user prompt: "Elacity Player wants to sign a transaction on Base. Allow?"
    ↓
Capability token issued (scoped, expirable, auditable)
    ↓
Provider contract handles RPC
```

---

## CEK Exposure Assessment (Apr 2026 Audit)

> **Context:** Multiple code comments in `storage.ts` and `WASMRuntime.ts` previously claimed "CEK never touches Node.js memory." An honest audit reveals this is **not fully accurate**. This section documents the real data flow so the team can make informed security decisions.

### The Real CEK Data Flow

```
                    ┌─── Node.js Memory ───┐    ┌── WASM Linear Memory ──┐
                    │                      │    │                        │
1. Lit Protocol  →  │  cekBase64 (string)  │    │                        │
   recovers CEK     │  ↓                   │    │                        │
                    │  JSON.stringify()    │    │                        │
2. MemFS write   →  │  command.json buffer │ →  │  /input/command.json   │
                    │  (contains cek_b64)  │    │  ↓                     │
                    │                      │    │  parse → AES key bytes │
3. WASM decrypt  →  │                      │    │  decrypt(ciphertext)   │
                    │                      │    │  ↓                     │
4. Output        →  │  rendered pixels     │ ←  │  /output/rendered.bin  │
                    │  (safe to serve)     │    │  (plaintext stays)     │
                    └──────────────────────┘    └────────────────────────┘
```

### Where CEK Exists in Node.js Memory

| Stage | Variable | Lifetime | Risk |
|-------|----------|----------|------|
| Lit CEK recovery | `cekBase64` string | Until GC collects | String immutable, cannot be zeroed |
| Session cache | `cekSessionCache.get(key)` | Up to 5 minutes (TTL) | Cached for performance |
| MemFS write | `command.json` Buffer | Until `clearMemFS()` | Cleared after each execution |
| Node.js fallback | `cekBytes` Buffer | Until `cekBytes.fill(0)` | Explicitly zeroed |
| Media session | `session.cekBase64` | Session lifetime (~30 min) | Required for segment-by-segment decrypt |

### What WASM Actually Isolates

- **Plaintext** — The decrypted content (images, text, video frames) stays in WASM linear memory when using the renderer path. The browser only receives rendered pixels.
- **Decrypted video segments** — CENC decryption happens entirely in WASM; decrypted fMP4 bytes are read back but are already clear media (not sensitive secrets).

### What WASM Does NOT Isolate

- **CEK itself** — The key passes through Node.js as a base64 string before being written into WASM's MemFS. JavaScript strings are immutable and cannot be securely zeroed.
- **Lit ciphertext** — The encrypted CEK blob also lives in Node.js memory during the Lit Protocol exchange.

### Mitigation Path (Runtime v2)

In the Runtime's capsule model, the entire CEK lifecycle would be capsule-internal:
1. **Capability token** grants `drm:decrypt` permission
2. **DRM Provider Capsule** calls Lit Protocol (or equivalent) internally
3. **CEK never leaves capsule memory** — it's recovered, used, and zeroed within WASM
4. **Host adapter** (PC2 Node.js) only receives rendered output

This requires Runtime EVM/wallet integration (currently blocked — see "What Doesn't Exist Yet" above).

### Practical Risk Assessment

| Threat | Current | With Runtime v2 |
|--------|---------|----------------|
| Memory dump of Node.js process | CEK visible in heap | CEK only in WASM linear memory |
| JavaScript prototype pollution | Could intercept CEK string | N/A — no JS in path |
| Side-channel on `cekSessionCache` | TTL-bounded exposure window | No cache needed |
| Malicious npm dependency | Could read `cekBase64` | Capsule sandboxing prevents |

**Bottom line:** The current WASM path is a meaningful improvement (plaintext isolation), but the CEK itself transits through Node.js. This is an honest limitation of the v1 architecture that the Runtime's capsule model is specifically designed to solve. Comments across the codebase have been updated to reflect this accurately.

---

## WASM/Rust Consolidation (Apr 2026)

### mp4-split: Init Segment Splitting

The `mp4-split` WASM module now supports a `split_init` mode that strips non-target tracks from multi-track fMP4 init segments — the same operation previously done purely in JavaScript (`splitInitForTrack()` in `media.ts`).

**Why this matters:**
- Keeps init segment binary data in WASM linear memory during manipulation (avoids V8 GC pressure)
- Consolidates all ISO BMFF parsing into a single Rust crate
- JS fallback preserved — if WASM fails, the original JS implementation handles it transparently

**Implementation:**
- `mp4-split` Rust crate v1.1.0: reads `/input/command.json` + `/input/init.bin`, outputs filtered `/output/init.bin`
- `WASMRuntime.executeMp4InitSplit()`: new TypeScript method orchestrating MemFS lifecycle
- `media.ts`: `splitInitForTrackWithFallback()` tries WASM first, falls back to JS

---

## Honest Assessment: Timeline and Dependencies

### What We Control

| Item | Effort | Can Do Now? |
|------|--------|-------------|
| Capability vocabulary + middleware | 1 day | Yes — **done Apr 3** |
| Ed25519 signature verification | 1 day | Yes — **done Apr 3** |
| Provider interface definitions | 0.5 day | Yes — **done Apr 3** |
| Wallet bridge origin tracking | 0.5 day | Yes — **done Apr 3** |
| dDRM capsule hashing | 0.5 day | Yes — **done Apr 3** |
| V3 contract migration | 2-3 days | **Blocked** — waiting on Irzhy SDK |
| macOS .dmg code signing | 1-2 days | **DONE** — Notarized + stapled, v1.2.2 on GitHub |
| Supernode Lit relay | 1-2 days | Yes — needs Contabo/InterServer deployment |
| dDRM Provider Capsule (Rust) | 2-4 weeks | **Blocked** — needs Runtime EVM integration |
| ACCESS_TOKEN → capability bridge | 2-4 weeks | **Blocked** — needs Runtime blockchain support |

### What We Don't Control

| Dependency | Owner | Impact | Estimated Timeline |
|------------|-------|--------|-------------------|
| V3 contract ABIs + SDK | Irzhy | Gates contract migration in 8+ files | Unknown — meeting scheduled |
| Runtime EVM/wallet integration | Anders | Gates dDRM Provider Capsule | Unknown — marked "Next" in TASKS.md |
| Runtime capsule manifest spec | Anders | Gates `capsule.json` generation from `app.json` | Stable enough to design against |
| Carrier provider interface spec | Anders | Gates P2P content delivery capsule | Published, stable |

### Realistic Convergence Timeline

```
Apr 2026:  Capsule-compatible refactoring (this document) ✅
Q2 2026:   V3 contracts + supernode deployment + macOS signing
Q3 2026:   dDRM Provider Capsule prototype (if Runtime has EVM)
Q4 2026:   ACCESS_TOKEN → capability token bridge
Q1 2027:   dDRM working end-to-end inside Runtime capsules
2027-2028: Full sovereignty — all services as signed capsules
```

---

*This document tracks convergence between PC2 v1 and the ElastOS Runtime. Update as refactoring progresses and Runtime matures.*
