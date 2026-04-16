# Operational Report Since `feature/ElastOS`

Generated: 2026-04-16  
Repository: `/Users/maciz/www/pc2.net`  
Comparison Range: `feature/ElastOS..HEAD`  
Current branch analyzed: `feature/lit-chipotle-migration`

---

## 1. Purpose

This document provides an operational map of implementation and bugfix work since `feature/ElastOS`, with emphasis on:

- dDRM architecture and execution path
- Lit Datil -> Chipotle migration
- V3 contract migration and access layer
- Creator/Market/runtime integration
- WASM/Rust media and non-media pipeline
- Security and reliability hardening

It is designed to answer: "Where are features implemented, and which files/folders should we inspect first?"

---

## 2. Scope Snapshot

## 2.1 Range Size

- Total commits in range: `5227`
- Diff size: `3410 files changed, 1750418 insertions, 90773 deletions`
- Earliest commit after branch divergence:
  - `cf6211aa9` — `2024-03-02 19:45:36 -0800`
- Current HEAD:
  - `62b490021` — `2026-04-14 18:14:31 +0700`

## 2.2 Commit Subject Prefix Distribution (quick parsing)

- `feat`: `452`
- `fix`: `749`
- `docs`: `106`
- `security`: `6`
- `other/unprefixed/chore/refactor/etc`: `3918`

Note: This prefix split is indicative only; many commits use custom titles.

---

## 3. Change Heatmap (Where Most File Changes Landed)

## 3.1 Top-Level Folders

- `src`: `1797` changed files
- `pc2-node`: `827`
- `extensions`: `255`
- `packages`: `112`
- `docs`: `87`

## 3.2 High-Signal Second-Level Areas

- `src/backend`: `909`
- `pc2-node/data`: `499`
- `src/gui`: `351`
- `extensions/particle-auth`: `202`
- `src/particle-auth`: `196`
- `pc2-node/src`: `141`
- `pc2-node/frontend`: `92`
- `packages/access`: `69`
- `pc2-node/crates`: `28`
- `pc2-node/wasm-renderer`: `11`
- `pc2-node/wasm-apps`: `16`
- `docs/core`: `29`

Interpretation: dDRM feature work is concentrated in `pc2-node/*`, `packages/access/*`, and `docs/core/*`, while broad product changes are concentrated in `src/backend/*` and `src/gui/*`.

---

## 4. dDRM Feature Timeline (Operational Milestones)

Chronological highlights from the dDRM-relevant stream:

1. `2026-03-04` — `522541af2`  
   `feat: Elacity dDRM marketplace — Phase 1 foundation + Market dApp + download-to-node`

2. `2026-03-13` — `d6cbf7412` / `bb2f72fc6`  
   `@elacity-js/access` package added + universal dDRM on-chain mint/access verified.

3. `2026-03-15` to `2026-03-16` — `1d75909a9`, `fffc83ddb`, `b63d82197`, `e05f1468e`, `1e613930b`  
   dDRM viewer app + server-side WASM runtime expansion (renderer, CENC decrypt path, PDF rendering hardening).

4. `2026-03-17` — `4056c6897`, `985e56a77`, `a8e0ece8a`  
   Lit Chipotle migration introduced and feature flag path (`LIT_BACKEND`) established.

5. `2026-03-18` to `2026-03-20` — `aa11bcb2b`, `76aafbddd`, `bd21687eb`, `940759e62`, `e3ef5f02f`, `7a3564ee7`, `3dc0d6935`  
   dDRM hardening + media encoding/decryption pipeline E2E + market and capsule format improvements.

6. `2026-03-23` to `2026-04-03` — `ad79b834a`, `d13c78063`, `b48ffb7b9`, `7e7affcc4`, `a3cc9563f`  
   Creator/Market UX and publish flow consolidation; Chipotle production E2E and WASM refactor.

7. `2026-04-06` to `2026-04-07` — `26766402c`, `e5d8eafc9`, `f00cc0818`, `fa573f78c`  
   V2 -> V3 migration and V3 E2E validation.

---

## 5. Operational Architecture Map (Feature -> Files/Folders)

## 5.1 Lit/Chipotle Integration Layer

Primary behavior:
- Executes Lit Actions over REST (`/core/v1/lit_action`)
- Resolves API key tiering / auto-provisioning
- Performs non-media/media CEK encryption/decryption calls

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/src/api/chipotle-client.ts`
- `/Users/maciz/www/pc2.net/pc2-node/data/lit-actions/non-media-encrypt-chipotle.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/lit-actions/non-media-decrypt-chipotle.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/lit-actions/media-encrypt-chipotle.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/lit-actions/media-decrypt-chipotle.js`

Notable operational markers in code:
- `resolveApiKey`, `resolvePkpId`, `executeLitAction`
- provisioning cache file `.chipotle-provision.json`
- env priority: `LIT_CHIPOTLE_USER_KEY`, `LIT_CHIPOTLE_USAGE_KEY`, `LIT_BACKEND`

## 5.2 Non-Media dDRM API Path

Primary behavior:
- Encrypt endpoint integration
- Secure rendering endpoint (`/api/storage/lit/secure-view`)
- Lit backend branching (`chipotle` vs `datil`)
- Access-check and CEK recovery orchestration

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/src/api/storage.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/api/access-control.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/api/rate-limit.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/api/audit.ts`

## 5.3 Media dDRM Path (DASH/CENC)

Primary behavior:
- Parse PSSH metadata
- Init and segment endpoints
- CENC segment decryption and init stripping
- session-bound CEK usage for playback

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/src/api/media.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/services/media/dashPackager.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/services/media/encoder.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/services/media/mp4split.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/services/media/mpdGenerator.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/services/media/sessionManager.ts`

## 5.4 WASM Runtime Orchestration

Primary behavior:
- Server-side WASI runtime and MemFS contract
- Dispatches `ddrm-renderer`, `cenc-decrypt`, `cenc-encrypt`, `ipfs-assemble`, `mp4-split`

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/src/services/wasm/WASMRuntime.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/api/wasm.ts`
- `/Users/maciz/www/pc2.net/pc2-node/scripts/build-wasm.sh`

Compiled module targets:
- `/Users/maciz/www/pc2.net/pc2-node/wasm-apps/ddrm-renderer/ddrm-renderer.wasm`
- `/Users/maciz/www/pc2.net/pc2-node/wasm-apps/cenc-decrypt/cenc-decrypt.wasm`
- `/Users/maciz/www/pc2.net/pc2-node/wasm-apps/cenc-encrypt/cenc-encrypt.wasm`
- `/Users/maciz/www/pc2.net/pc2-node/wasm-apps/ipfs-assemble/ipfs-assemble.wasm`
- `/Users/maciz/www/pc2.net/pc2-node/wasm-apps/mp4-split/mp4-split.wasm`

## 5.5 Rust Cryptographic/Media Crates

Primary behavior:
- Runtime-level cryptography and fMP4 manipulation

Key sources:
- `/Users/maciz/www/pc2.net/pc2-node/wasm-renderer/src/main.rs`
- `/Users/maciz/www/pc2.net/pc2-node/wasm-renderer/src/lib.rs`
- `/Users/maciz/www/pc2.net/pc2-node/crates/cenc-decrypt/src/lib.rs`
- `/Users/maciz/www/pc2.net/pc2-node/crates/cenc-decrypt/src/main.rs`
- `/Users/maciz/www/pc2.net/pc2-node/crates/cenc-encrypt/src/lib.rs`
- `/Users/maciz/www/pc2.net/pc2-node/crates/cenc-encrypt/src/main.rs`
- `/Users/maciz/www/pc2.net/pc2-node/crates/cenc-encrypt/src/pssh.rs`

## 5.6 V3 Contract and Universal Access SDK

Primary behavior:
- Canonical addresses and ABI bindings
- mint payload encoding
- chain/IPFS/constants abstraction for client/server use

Key files:
- `/Users/maciz/www/pc2.net/packages/access/src/contracts/abis.ts`
- `/Users/maciz/www/pc2.net/packages/access/src/contracts/encode.ts`
- `/Users/maciz/www/pc2.net/packages/access/src/constants.ts`
- `/Users/maciz/www/pc2.net/packages/access/src/client.ts`
- `/Users/maciz/www/pc2.net/packages/access/src/node/client.ts`
- `/Users/maciz/www/pc2.net/packages/access/src/lit/*`
- `/Users/maciz/www/pc2.net/packages/access/__tests__/*`

## 5.7 Creator dApp Implementation

Primary behavior:
- Channel creation / mint flow
- metadata envelope and publishing pipeline
- non-media/media routing and upload strategy

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-creator/app.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-creator/index.html`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-creator/styles.css`

## 5.8 Market dApp Implementation

Primary behavior:
- browse/discovery
- buy/list/resell/royalty operations
- EOA/smart-account handling
- playback launch hooks to viewer/runtime apps

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-market/app.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-market/wallet.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-market/api.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-market/app-features.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-market/styles.css`

## 5.9 Viewer/Player Apps

Primary behavior:
- dDRM capsule viewing
- media runtime playback
- universal asset handling extensions

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/ddrm-viewer/viewer.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/pc2-media-runtime/player.js`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-player-src/src/PlayerProvider.tsx`
- `/Users/maciz/www/pc2.net/pc2-node/data/test-apps/elacity-player-src/src/PlayerView.tsx`

## 5.10 Wallet Bridge/Auth Integration

Primary behavior:
- wallet bridge between host and app contexts
- Particle auth integration and account mode behavior

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/frontend/pc2-wallet-bridge.js`
- `/Users/maciz/www/pc2.net/pc2-node/frontend/pc2-wallet-provider.js`
- `/Users/maciz/www/pc2.net/pc2-node/src/api/wallet.ts`
- `/Users/maciz/www/pc2.net/pc2-node/src/services/wallet/ParticleWalletProvider.ts`

## 5.11 IPFS and Gateway/Provision Surface

Primary behavior:
- content add/pin/retrieve flow
- supernode/gateway provisioning support

Key files:
- `/Users/maciz/www/pc2.net/pc2-node/src/storage/ipfs.ts`
- `/Users/maciz/www/pc2.net/extensions/ipfs-storage/providers/IPFSProvider.js`
- `/Users/maciz/www/pc2.net/deploy/ipfs-relay/index.js`
- `/Users/maciz/www/pc2.net/deploy/web-gateway/ddrm-config.json.template`

---

## 6. Bugfix and Hardening Themes (dDRM Stream)

Observed recurring hardening themes:

1. **Access verification correctness**
- EOA vs Smart Account address handling fixes
- V3 authority/address default corrections
- routing non-media play to correct viewer path

2. **CEK and metadata integrity**
- base64 padding handling
- capsule format standardization
- PSSH metadata consistency

3. **Media playback resilience**
- AV1 behavior fixes
- init segment splitting/stripping improvements
- session and seek recovery hardening

4. **Security controls**
- removal of inline/raw decrypt endpoint path
- CEK logging removal
- decrypt rate-limits and audit instrumentation

5. **Publishing and mint reliability**
- free mint and royalty constraints
- Creator form and flow consolidation
- channel management and approval fixes

---

## 7. Crosswalk With `IRZHY_DDRM_HANDOVER.md`

Handover file reference:
- `/Users/maciz/Downloads/IRZHY_DDRM_HANDOVER.md`

Crosswalk summary:

1. **Chipotle REST client and Lit Actions**
- Handover sections 2/3/5/6 map to:
  - `pc2-node/src/api/chipotle-client.ts`
  - `pc2-node/data/lit-actions/*-chipotle.js`

2. **V3 addresses and access checks**
- Handover section 4 maps to:
  - `packages/access/src/contracts/abis.ts`
  - `packages/access/src/contracts/encode.ts`

3. **Secure-view non-media path**
- Handover section 6 maps to:
  - `pc2-node/src/api/storage.ts`
  - `pc2-node/src/services/wasm/WASMRuntime.ts`

4. **Media pipeline and runtime**
- Handover sections 6/7 map to:
  - `pc2-node/src/api/media.ts`
  - `pc2-node/src/services/media/*`
  - `pc2-node/crates/cenc-*`
  - `pc2-node/wasm-apps/*`

5. **Creator and Market reference flows**
- Handover sections 8/9 map to:
  - `pc2-node/data/test-apps/elacity-creator/*`
  - `pc2-node/data/test-apps/elacity-market/*`

6. **Implementation plan and test matrix**
- Handover sections 10/11 are reflected by commit stream from 2026-03 to 2026-04 and corresponding code in areas above.

---

## 8. Priority Navigation Guide (Where To Start By Goal)

If your goal is:

1. **Understand key escrow/decrypt trust boundary**
- Start with `pc2-node/src/api/chipotle-client.ts` and `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js`

2. **Debug "buyer has access but cannot view content"**
- Check `pc2-node/src/api/storage.ts` (`/lit/secure-view`) and `packages/access/src/contracts/abis.ts`

3. **Debug media init/segment playback issues**
- Check `pc2-node/src/api/media.ts` and `pc2-node/src/services/wasm/WASMRuntime.ts`

4. **Audit cryptographic path and CEK handling**
- Check `pc2-node/wasm-renderer/src/*` and `pc2-node/crates/cenc-*`

5. **Modify Creator mint metadata or publishing flow**
- Check `pc2-node/data/test-apps/elacity-creator/app.js` and `packages/access/src/contracts/encode.ts`

6. **Modify buy/list/resell UX or wallet transaction flow**
- Check `pc2-node/data/test-apps/elacity-market/wallet.js` and `pc2-node/data/test-apps/elacity-market/app.js`

7. **Check infrastructure/provision behavior**
- Check `pc2-node/src/api/chipotle-client.ts`, `deploy/web-gateway/*`, `deploy/ipfs-relay/*`

---

## 9. Noted Mismatch Risks and Verification Targets

1. **Datil vs Chipotle compatibility**
- Assets are backend-specific; verify `litBackend` routing paths in both storage and media APIs.

2. **Stale V2 docs vs V3 code**
- Treat `packages/access/src/contracts/abis.ts` as canonical for current contract bindings.

3. **Media status drift**
- Handover text and commit log differ across dates regarding media E2E completeness.
- Re-verify current behavior with a fresh end-to-end run using latest `HEAD`.

4. **Generated/built artifacts vs source**
- For contract defaults and authority values, prefer TypeScript source over stale built JS copies.

---

## 10. Recommended Next Step (Operational)

For team onboarding, run a focused 90-minute walkthrough in this order:

1. `chipotle-client.ts` (key resolution + execute path)
2. `storage.ts` secure-view flow
3. `media.ts` init + segment flow
4. `WASMRuntime.ts` execution model
5. `packages/access/contracts/*` V3 bindings
6. `elacity-creator/app.js` and `elacity-market/wallet.js`

This sequence matches the practical request path: `mint -> buy -> decrypt -> render/play`.

---

## 11. Source Inputs Used For This Report

- Git range analysis over `feature/ElastOS..HEAD`
- Directory-level diff statistics
- Commit stream filtered by dDRM/Lit/Chipotle/WASM/Market/Creator keywords
- Handover document: `DDRM_HANDOVER.md` (confidential)

