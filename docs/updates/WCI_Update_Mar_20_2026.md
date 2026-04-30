# ElastOS Weekly Shipping Report — Week of Mar 14–20, 2026

## GitHub Shipping Report

**ElastOS Weekly Shipping Report — Week of Mar 14–20, 2026**

**48 commits | 253 files changed | 36,241 insertions | 5 new Rust/WASM crates | 7 new apps/viewers**

---

### Shipped:

**Secure Viewer & dDRM Viewer App (Mar 15)**
- Lit Action trust model — custom `non-media-decrypt.js` with self-referential conditions + on-chain access check, Smart Account aware ([e17e784f](https://github.com/Elacity/pc2.net/commit/e17e784f))
- Capacity credit auto-detection — queries Chronicle Yellowstone for latest valid RLI token, handles 15-day rotation ([e17e784f](https://github.com/Elacity/pc2.net/commit/e17e784f))
- Server-side secure viewer — images (Sharp), PDFs (PDF.js+Canvas hybrid), text (Canvas) with watermark, buffer zeroing, auto-decrypt, parallel PDF pages ([f529d1f8](https://github.com/Elacity/pc2.net/commit/f529d1f8))
- WASM Renderer — Rust `wasm32-wasip1` crate for text rendering inside isolated WASM linear memory + WASMRuntime.ts host ([1d75909a](https://github.com/Elacity/pc2.net/commit/1d75909a))
- dDRM Viewer app — dedicated PC2 app with two display modes (centered images, full-width documents), anti-piracy measures, `.ddrm.json` capsule format, native UIWindow windowing ([1d75909a](https://github.com/Elacity/pc2.net/commit/1d75909a))
- GUI capsule integration — custom shield icon, MIME registration, double-click opens dDRM Viewer ([1d75909a](https://github.com/Elacity/pc2.net/commit/1d75909a))
- Security hardening — removed inline decrypt, raw plaintext endpoint, and saveDecryptedFile ([eaf56228](https://github.com/Elacity/pc2.net/commit/eaf56228))

**PC2 Media Runtime (Mar 16)**
- Server-side DASH/CENC decryption pipeline — Rust `cenc-decrypt` WASM crate (AES-128-CTR per-sample decryption), MSE player (no EME/CDM/SharedArrayBuffer), DRM signaling stripping (`encv→av01`, `sinf`/`senc` removal), Smart Account PSSH selection, two-phase Lit auth. **First end-to-end playback of Elacity dDRM video inside PC2** ([fffc83dd](https://github.com/Elacity/pc2.net/commit/fffc83dd))
- Media player hardening — session expiry handling (transparent re-auth), seek into unbuffered regions, audio-only support, adaptive bitrate switching with quality selector, YouTube-style keyboard shortcuts, auto-hide controls, buffering indicator ([1eae8e6d](https://github.com/Elacity/pc2.net/commit/1eae8e6d))
- WASM renderer hardening — PDF rendering via `lopdf` text extraction, code syntax highlighting via `syntect` (30+ languages) ([b63d8219](https://github.com/Elacity/pc2.net/commit/b63d8219))
- WASM-native PDF rendering — `hayro` pure-Rust PDF rasterizer for full-fidelity layout/fonts/tables/images ([e05f1468](https://github.com/Elacity/pc2.net/commit/e05f1468))
- WASM crypto hardening Phases A-C — AES-GCM decrypt-only in WASM (CEK never in Node.js heap), fMP4 strip+decrypt combined in single WASM call ([1e613930](https://github.com/Elacity/pc2.net/commit/1e613930))
- `.edrm` double-click playback from filesystem ([a6cdd638](https://github.com/Elacity/pc2.net/commit/a6cdd638))

**Lit Protocol Chipotle Migration (Mar 17)**
- Full migration from deprecated Datil SDK to Chipotle REST API — replaced ~1.2MB SDK with single `chipotle-client.ts` (~450 lines) ([4056c689](https://github.com/Elacity/pc2.net/commit/4056c689))
- `LIT_BACKEND` feature flag for dual-mode rollback (datil/chipotle) ([985e56a7](https://github.com/Elacity/pc2.net/commit/985e56a7))
- Chipotle E2E verified — default backend for non-media dDRM operations ([a8e0ece8](https://github.com/Elacity/pc2.net/commit/a8e0ece8))
- Crypto incompatibility discovery — Chipotle TEE uses PKP-AES (not threshold BLS), encryption stays on Datil SDK while decrypt moves to Chipotle ([4d5687ee](https://github.com/Elacity/pc2.net/commit/4d5687ee))
- Security — removed all hardcoded API keys and secrets from source ([bec68bb8](https://github.com/Elacity/pc2.net/commit/bec68bb8))

**Local Media Encoding Pipeline (Mar 18)**
- Creator-to-consumer media pipeline — FFmpeg transcode + Bento4 fragment + CENC-AES-128-CTR encrypt + DASH packaging + IPFS upload. Adaptive codec selection (NVIDIA GPU / SVT-AV1 / x264) ([76aafbdd](https://github.com/Elacity/pc2.net/commit/76aafbdd))
- `cenc-encrypt` Rust WASM crate — symmetric AES-128-CTR encryption with init segment transformation and binary PSSH generation ([bd21687e](https://github.com/Elacity/pc2.net/commit/bd21687e))
- Media pipeline E2E verified — creator mint → buy → download → DASH playback inside PC2 ([940759e6](https://github.com/Elacity/pc2.net/commit/940759e6))
- AES-GCM encrypt moved inside WASM — non-media file encryption no longer uses Node.js crypto; plaintext never touches V8 memory ([11d99bd0](https://github.com/Elacity/pc2.net/commit/11d99bd0))
- WASM & I/O quick wins — `wasm-opt` build pass, WASM binary preload at startup, cache key collision fix, async thumbnail generation, async HTML injection ([ee2fcd86](https://github.com/Elacity/pc2.net/commit/ee2fcd86))
- dDRM pipeline security — CEK logging removed, decrypt rate limiting, audit trail, CORS lockdown, blob URL cleanup ([aa11bcb2](https://github.com/Elacity/pc2.net/commit/aa11bcb2))
- FFmpeg added to install scripts for all platforms ([a0531d02](https://github.com/Elacity/pc2.net/commit/a0531d02))

**AV1 Playback & Init Segment Fixes (Mar 18-19)**
- Three critical AV1 playback fixes: Rust WASM `strip.rs` removes PSSH boxes inside `moov` (not just top-level), `splitInitForTrack()` splits multi-track init segments for MSE SourceBuffer compatibility, `hdlr` handler_type offset corrected ([31d8fef0](https://github.com/Elacity/pc2.net/commit/31d8fef0))
- MetaMask mint gas estimation fix with `sendTxWithRetry()` retry/skip buttons ([31d8fef0](https://github.com/Elacity/pc2.net/commit/31d8fef0))

**New Rust/WASM Crates (Mar 19)**
- `ipfs-assemble` — files ≥5MB assembled in WASM linear memory, reducing V8 heap from ~400MB to ~200MB for large files ([48918250](https://github.com/Elacity/pc2.net/commit/48918250))
- `mp4-split` (91KB) — ISO BMFF parser in Rust, full codec parsing (AVC, HEVC, AV1, AAC, Opus, FLAC), 800MB guard with JS fallback ([e5dff18c](https://github.com/Elacity/pc2.net/commit/e5dff18c))
- WASM decrypt max size raised from 50MB to 200MB — non-media dDRM files up to 200MB now decrypt inside WASM sandbox ([e5dff18c](https://github.com/Elacity/pc2.net/commit/e5dff18c))
- Player access-denied UX — user-friendly "Access Required" message instead of raw Lit errors ([e5dff18c](https://github.com/Elacity/pc2.net/commit/e5dff18c))

**Universal Asset Viewers — Tier 1 Completion (Mar 19)**
- 3D Models (GLB, glTF, OBJ, STL, FBX) — Three.js interactive viewer with VFX-grade features: wireframe (W), normals (N), grid (G), auto-rotate (A), screenshot (S), model info panel, anti-piracy (blob URL revocation, canvas watermark) ([27a29f03](https://github.com/Elacity/pc2.net/commit/27a29f03), [a790e20d](https://github.com/Elacity/pc2.net/commit/a790e20d))
- Datasets (CSV, TSV) — paginated table viewer with search, column stats, row numbers ([27a29f03](https://github.com/Elacity/pc2.net/commit/27a29f03))
- Fonts (TTF, OTF, WOFF2) — type specimen preview with @font-face blob, alphabet, pangram, size samples ([27a29f03](https://github.com/Elacity/pc2.net/commit/27a29f03))
- Archives (ZIP) — file tree listing with sizes/types via JSZip ([27a29f03](https://github.com/Elacity/pc2.net/commit/27a29f03))
- WASM CEK base64 padding fix — Chipotle REST API returns unpadded base64; added padding normalization ([ff44bc22](https://github.com/Elacity/pc2.net/commit/ff44bc22))
- Market thumbnail letterboxing — `object-fit: contain` with centered flex layout, matches live Elacity site ([4eb11959](https://github.com/Elacity/pc2.net/commit/4eb11959))
- Audio artwork in Media Runtime — album art display from asset thumbnail during audio playback ([4eb11959](https://github.com/Elacity/pc2.net/commit/4eb11959))

**WASM/Rust Performance Optimization (Mar 20)**
- Speed-tuned crypto — `cenc-decrypt` and `cenc-encrypt` changed from `opt-level = "s"` to `opt-level = 3` for ~20-40% faster AES operations ([e3ef5f02](https://github.com/Elacity/pc2.net/commit/e3ef5f02))
- `panic = "abort"` on all 5 WASM crates — ddrm-renderer reduced 482KB / 8.3% ([e3ef5f02](https://github.com/Elacity/pc2.net/commit/e3ef5f02))
- Smart build pipeline — per-crate wasm-opt levels (`-O3` for crypto, `-Oz` for utility), `--enable-simd` and `--enable-nontrapping-float-to-int` flags ([e3ef5f02](https://github.com/Elacity/pc2.net/commit/e3ef5f02))
- Security — CEK buffer zeroing in `unwrapECDHEnvelope`, derived key zeroing in mnemonic encrypt/decrypt ([e3ef5f02](https://github.com/Elacity/pc2.net/commit/e3ef5f02))

**Unified .ddrm Capsule Format (Mar 20)**
- Single `.ddrm` extension for media + non-media assets with `type` field routing ([7a3564ee](https://github.com/Elacity/pc2.net/commit/7a3564ee))
- NFT artwork thumbnails with dDRM badge overlay ([7a3564ee](https://github.com/Elacity/pc2.net/commit/7a3564ee))
- Backward compatibility with legacy `.edrm` and `.ddrm.json` ([7a3564ee](https://github.com/Elacity/pc2.net/commit/7a3564ee))

**Elacity Market — Full Feature Set (Mar 20)**
- Dual-wallet library — EOA + Smart Account balances displayed per-asset, wallet selector for purchases ([618953f9](https://github.com/Elacity/pc2.net/commit/618953f9))
- Dedicated Earnings/Revenue page — new sidebar tab with Assets/Channels/Offers sub-tabs, dual-wallet aggregation, total unclaimed banner, per-item + batch "Withdraw All" (multicall) ([3dc0d693](https://github.com/Elacity/pc2.net/commit/3dc0d693))
- 15 marketplace features: seller sorting (cheapest-first), properties accordion (15+ fields), scarcity badges (X/Y, sold out, low stock, urgency), activity history (listings/sales/offers with tx links), publish/unpublish toggle, royalty offers (create/accept/cancel via TradeGateway), subscription lifecycle (expiry states, unsubscribe), channel editing (name, description, categories, images), plan management (add/update/remove), token-gating (full CRUD with on-chain validation), distribution rights display ([3dc0d693](https://github.com/Elacity/pc2.net/commit/3dc0d693), [ee8d86b0](https://github.com/Elacity/pc2.net/commit/ee8d86b0))
- My Channels management hub — centralized channel administration with edit/plans management, server-side creator filtering ([ee8d86b0](https://github.com/Elacity/pc2.net/commit/ee8d86b0))
- Per-tab earnings badge counts, multi-token withdrawal (USDC + ETH), expanded stats (per-wallet balances, governance volume, floor price, subscriber count) ([ee8d86b0](https://github.com/Elacity/pc2.net/commit/ee8d86b0))
- Capsule-ready architecture — `app-features.js` module via `window.ElaMarket` namespace + custom DOM events for cross-module hooks ([3dc0d693](https://github.com/Elacity/pc2.net/commit/3dc0d693))
- API hardening — GraphQL error response capture, auto SIWE re-auth on expired tokens, mutation format fixes verified via schema introspection ([ee8d86b0](https://github.com/Elacity/pc2.net/commit/ee8d86b0))

**ElastOS v2 Runtime — Signed Capsules & Capability System (Team)**
- ElastOS Runtime v0.20.0-rc10 published at [elastos.elacitylabs.com](https://elastos.elacitylabs.com) — signed Linux runtime for capsules, peer-connected apps, and content sharing
- **Capability-based security model** — zero ambient authority: every capsule, tool, or AI agent starts with no permissions and receives precise capability tokens for specific actions (read, write, network, provider)
- **Signed capsule pipeline** — `elastos publish-release` with Ed25519 signature verification (`did:key:z6Mkw4NbeyfPDGyuZH5Um6xjqwbon32MEArqLLfjTqDjmrEw`), gateway installer, and `elastos update` path all signature-verified
- **Three execution surfaces** — native binary, WASM, and microVM chat all proven on one runtime with recorded QA journeys
- **Canonical install from public gateway** — `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash` with on-demand capsule download
- **Core commands proven**: `elastos setup --profile chat`, `elastos chat --nick alice`, `elastos share README.md`, `elastos open elastos://<cid>`, `elastos share --public`
- **Provider contracts** — `localhost://storage/*` (local encrypted state), `elastos://peer/` (peer surfaces), `elastos://ai/` (model routing under same capability system)
- **AI agent support** — scoped read/write tokens (e.g., agent can read `localhost://storage/notes/*` and write only to `localhost://storage/drafts/*`), Codex-backed operator agent proven on server
- **Platform verification** — Linux x86_64 and aarch64, WSL operator proof, Jetson fresh-install proof
- **Architecture** — small trusted core (isolation, signatures, capability validation, release trust, local state) with providers and capsules layered above

**Bug Fixes & Polish**
- Fixed double-signature bug (duplicate wallet bridge handlers) ([1e613930](https://github.com/Elacity/pc2.net/commit/1e613930))
- Fixed video autoplay after signing ([1e613930](https://github.com/Elacity/pc2.net/commit/1e613930))
- Fixed WASM text renderer exceeding JPEG 65535px limit ([1e613930](https://github.com/Elacity/pc2.net/commit/1e613930))
- Fixed `eth_requestAccounts` prompting unnecessarily ([1e613930](https://github.com/Elacity/pc2.net/commit/1e613930))
- Fixed duplicate wallet signatures (IPC.js + pc2-wallet-bridge.js dual handling) ([940759e6](https://github.com/Elacity/pc2.net/commit/940759e6))
- Fixed "Network fee: Unavailable" MetaMask popup ([940759e6](https://github.com/Elacity/pc2.net/commit/940759e6))
- Fixed duplicate chain switch and SIWE login popups ([940759e6](https://github.com/Elacity/pc2.net/commit/940759e6))
- Fixed IPFS directory pinning for DASH packages ([940759e6](https://github.com/Elacity/pc2.net/commit/940759e6))
- Fixed PSSH extraction (multi-pattern search) and embedding ([940759e6](https://github.com/Elacity/pc2.net/commit/940759e6))
- Fixed authority address for AuthorityGateway on Base ([5f1c72bf](https://github.com/Elacity/pc2.net/commit/5f1c72bf))
- Fixed MSE player SourceBuffer sequencing ([48918250](https://github.com/Elacity/pc2.net/commit/48918250))
- Fixed `resellerCut` display (per-mille → percentage conversion) ([618953f9](https://github.com/Elacity/pc2.net/commit/618953f9))
- Fixed `SubscriptionPlanUpdateAction` format (missing `args` wrapper) ([ee8d86b0](https://github.com/Elacity/pc2.net/commit/ee8d86b0))
- Fixed `TokenOwnershipInput` field names (`address`/`value` not `tokenAddress`/`minimumBalance`) ([ee8d86b0](https://github.com/Elacity/pc2.net/commit/ee8d86b0))

**Elastos DAO & Ecosystem**
- **Infinity proposal finalized** — audits shared with Elastos DAO Secretariat; Elastos Infinity team now part of the ElastOS teams
- **Cyber Republic DAO LLC → Elastos DAO LLC** — official name change process started
- **G-20 Group partnership renewed** — 3-month contract extension
- **ELA multi-chain expansion started** — bringing ELA to popular EVM chains, beginning with Base
- **Critical bridge limitation resolved** — after extensive research, ELA on Base via Elastos DAO Council as bridge operators is now feasible, sourcing directly from main chain (not side chains)
- **ETH ELA contract research** — evaluating migrate vs upgrade for the current Ethereum ELA contract
- **New main chain indexer** — work started on improved main chain explorer experience

---

### Next Week:
- Lit Chipotle endpoint recovery monitoring + testing
- End-to-end channel management testing (edit, plans, token-gating)
- Audio routing cleanup (remove dDRM Viewer audio passthrough)
- App Center UI rebuild against real backend APIs
- AI Model Marketplace alpha (GGUF → encrypt → IPFS → ACCESS_TOKEN → Ollama)
- Runtime + PC2 convergence planning — capsule format alignment, shared capability model

---

### Stats:
- **48 commits** across 7 days
- **253 files changed**, 36,241 insertions, 1,569 deletions
- **5 Rust/WASM crates** built: `cenc-decrypt`, `cenc-encrypt`, `ipfs-assemble`, `mp4-split`, `ddrm-renderer`
- **7 new viewers/apps**: dDRM Viewer, PC2 Media Runtime, 3D Model Viewer, CSV Viewer, Font Previewer, Archive Explorer, Creator Dashboard media mode
- **Tier 1 Universal Asset Viewers COMPLETE**: images, PDFs, text/code, audio, video, 3D models, datasets, fonts, archives — all decrypt inside WASM sandbox
- **ElastOS Runtime v0.20.0-rc10** published — signed capsules, capability tokens, 3 execution surfaces (native, WASM, microVM), AI agent support
