# Task: Capsule Runtime — WASM-based capability sandboxing for 3rd-party apps

**Task ID**: CAPSULE-RUNTIME-WASM
**Created**: 2026-05-02
**Status**: Proposed (sketch only — full design + implementation deferred)
**Priority**: Medium — strategic enabler, not urgent
**Target Release**: v1.4.0+ (NOT v1.2.7 — sequenced AFTER supernode Cluster ships in v1.2.7 and Carrier control plane lands in a later v1.3.x)
**Related strategy docs**:
- [`SUPERNODE-CLUSTER-SETUP`](../SUPERNODE-CLUSTER-SETUP/SUPERNODE-CLUSTER-SETUP.md) — must ship first (availability layer)
- Anders' architecture sketch (provided 2026-05-02 in chat) — *"Runtime: who may ask for what"*, *"Runtime grants viewer capability"*, *"viewer capsule receives scoped access, not raw platform authority"*
- Future `CARRIER-CONTROL-PLANE` task (not yet filed)

---

## Description

Replace iframe-sandboxed PC2 apps with a WebAssembly-based **capsule runtime** that grants explicit, scoped capabilities to creator-built modules. Today, all PC2 apps (`pc2-media-runtime`, `elacity-market`, `elacity-creator`, `ddrm-viewer`, etc.) run as HTML/JS inside iframes. This is adequate for first-party apps the Elacity team controls. **It is not adequate for genuinely 3rd-party creator-built capsules** — once we want random creators to ship custom viewers, custom DRM wrappers, custom AI-training viewers, etc., iframe sandboxing isn't a strong enough trust boundary.

WASM + WASI + capability tokens is the textbook solution to this problem. Capsules become WASM modules with NO ambient authority — they get exactly the capabilities the runtime grants them, and nothing else.

---

## Background

### Why this is strategically important (not urgent)

- **Elacity's value proposition is "creators can ship viewers, not just content"** (per Anders' sketch). The capsule runtime is what makes 3rd-party viewers SAFE to install.
- Without it, every creator-built viewer is either (a) trusted as a 1st-party app — gating real innovation, or (b) sandboxed in an iframe — leaving real security gaps that will eventually bite.
- This is foundational to the multi-creator marketplace vision. It's not foundational to v1.2.7 (Cluster availability + SQLite migration) — those ship independently.

### Why deferred to v1.4+

- **v1.2.7** ships SQLite migration + supernode IPFS Cluster (availability layer) + playback fixes. Without the cluster, no amount of capsule sandboxing matters because content isn't reliably reachable.
- **v1.2.8 / v1.3.x** brings per-pc2-node bearer tokens, GCloud third-peer cluster integration, and Carrier as control plane (replacing libp2p crash-prone signaling).
- **v1.4.0** is when capsule runtime becomes worth the engineering investment.

### Anders' words this maps to

> "Runtime: who may ask for what"
> "Runtime grants viewer capability"
> "viewer capsule receives scoped access, not raw platform authority"
> "Capsules" repeatedly throughout the architecture sketch

This task is the engineering realization of those concepts.

---

## Why Rust/WASM specifically

- **WASM** is the only cross-platform, browser-AND-server execution sandbox with strong capability semantics.
- **WASI** (WebAssembly System Interface) standardizes capability-based syscalls (filesystem, network, time, random, etc.) so capsules can have NO syscalls except those granted.
- **Rust** is the most mature, most ergonomic source language for compiling to WASM. Also viable: AssemblyScript (TypeScript-like), Go via TinyGo, C/C++ via Emscripten.
- **`wasmtime`** (Bytecode Alliance) is the most production-grade WASM runtime. Embeds via Node bindings (`@bytecodealliance/wasmtime`).

Alternative considered: **`extism`** — a higher-level plugin framework on top of `wasmtime`. Worth evaluating in the design phase as it might cut weeks off implementation.

---

## High-level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ pc2-node (host process)                                                │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │ Capsule Runtime  (NEW)                                           │ │
│   │   • Loads WASM module from IPFS CID                              │ │
│   │   • Issues capability tokens scoped per-capsule                  │ │
│   │   • Enforces every host call against the capsule's tokens        │ │
│   │                                                                  │ │
│   │   Capability tokens:                                             │ │
│   │     • storage.read(path-prefix)                                  │ │
│   │     • storage.write(path-prefix)                                 │ │
│   │     • ipfs.pin(cid)                                              │ │
│   │     • secureView.sign(action-id)                                 │ │
│   │     • drm.requestKey(asset-id)                                   │ │
│   │     • dDRM.read(channel-id)                                      │ │
│   │     • ui.window(layout-id)        ← bridge to host UI            │ │
│   │     • net.fetch(allowlisted-host) ← optional, off by default     │ │
│   └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
              ▲ runs                                  loaded from
              │                                       IPFS as a CID
              │                                                    
┌─────────────┴─────────────┐                ┌────────────────────────┐
│ Capsule (WASM module)     │                │ Capsule SDK (Rust)     │
│   ↑ creator-built          │ ←imports from→ │   • capability tokens  │
│   ↑ runs WITH NO ambient  │                │   • host bindings      │
│     authority             │                │   • UI primitives       │
│   ↑ only what runtime     │                └────────────────────────┘
│     grants it             │
└───────────────────────────┘
```

---

## Implementation Sketch (rough — full design needed in Phase 1)

### Phase 1 — Spike + design (~2 weeks)

- [ ] Evaluate `wasmtime` vs `extism` for the host runtime
- [ ] Decide capability token format (JWT? CAR? custom?)
- [ ] Design SDK API surface in Rust
- [ ] Prototype: minimal capsule that requests `storage.read('/Public')` and renders a directory listing in a UI window
- [ ] Document trust boundary (what the runtime guarantees, what it doesn't)

### Phase 2 — Production runtime (~6 weeks)

- [ ] Production capability enforcement layer
- [ ] Capsule loader from IPFS (with signature verification)
- [ ] Capsule manifest format (analogous to current `package.json` for PC2 apps)
- [ ] Capsule SDK published as a Cargo crate (`elacity-capsule-sdk`)
- [ ] Quickstart docs + 3 example capsules (viewer, indexer, transformer)

### Phase 3 — Migration of existing apps (incremental, ~ongoing)

- [ ] Convert `pc2-media-runtime` to a WASM capsule (proof-of-concept; existing iframe stays as fallback)
- [ ] Document migration path for community-built apps
- [ ] Establish review/audit process for capsules submitted for the Elacity app store

### Phase 4 — App store integration (~4 weeks)

- [ ] Marketplace UI surfaces "WASM Capsule" badge with clear capability disclosure (like Android permissions)
- [ ] Per-capsule capability audit log
- [ ] Revoke/sandbox controls

---

## Acceptance Criteria

1. A creator can ship a capsule (a `.wasm` file pinned to IPFS) that gets loaded by any PC2 node and executes with ONLY the capabilities the user explicitly granted at install.
2. The capsule cannot escape its sandbox — it CAN'T touch the filesystem outside its grant, CAN'T make arbitrary network calls, CAN'T access other users' data, CAN'T impersonate other capsules.
3. Capability grants are user-visible and revocable from the marketplace UI.
4. Existing iframe-based apps continue to work unchanged (capsule runtime is additive, not a replacement).

---

## Out of Scope

- Re-implementing `pc2-node` itself in Rust (no benefit; existing TS/JS stack is fine)
- Forcing all 1st-party apps into capsules (iframe is fine for trusted code)
- Full WASI Preview 2 / Component Model adoption (use Preview 1 for stability initially)

---

## Risk Notes

| Risk | Mitigation |
|---|---|
| `wasmtime` Node bindings less mature than the Rust crate | Spike Phase 1 evaluates this; fallback is a separate `pc2-capsule-runtime` Rust process called via IPC |
| Capability design gets it wrong on first try | Phase 1 spike + docs; capability tokens versioned; backwards compatibility for old capsules |
| Performance overhead vs. native JS apps | Acceptable trade-off for trust gain; benchmarks in Phase 1 |
| Community confusion ("which apps are capsules?") | UI badging + audit log; clear migration story |

---

## Notes

This task is **strategic, not urgent**. Filing now (per User decision 2026-05-02) so the architectural intent is captured before context is lost. **Do NOT begin implementation before:**

1. v1.2.7 ships ✓ (combines SQLite migration + supernode Cluster + playback fixes)
2. Cluster proves stable across community pc2-nodes (post-v1.2.7 telemetry / few weeks)
3. Carrier control plane integration is at least scoped if not landed

Deeply tied to Anders' "runtime" concept in the architecture sketch. Re-read his text before starting implementation; the vocabulary should align directly.
