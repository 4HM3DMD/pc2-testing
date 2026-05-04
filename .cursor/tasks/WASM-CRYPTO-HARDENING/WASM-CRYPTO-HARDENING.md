# Task: WASM Crypto & Performance Hardening

**Task ID**: WASM-CRYPTO-HARDENING
**Created**: 2026-03-13
**Status**: Proposed
**Priority**: High
**Branch**: `feature/wasm-crypto-hardening`

## Description

Migrate security-sensitive cryptographic operations and CPU-intensive binary parsing from Node.js to Rust/WASM. The goal is that **everything runs exactly as it does now** — identical inputs, identical outputs, identical API behaviour — but the hot-path code is faster, memory-isolated, and plaintext-safe.

## Background

The PC2 node currently mixes JavaScript and Rust/WASM for its crypto and media pipeline:

| Operation | Current | Problem |
|-----------|---------|---------|
| P-256 EC math (point decompression, modular sqrt) | Pure JS BigInt in `media.ts` | ~50x slower than native; CEK briefly in JS heap |
| AES-GCM decrypt for dDRM assets | Node.js `crypto.createDecipheriv` fallback in `storage.ts` | Plaintext touches Node.js memory |
| fMP4 box parsing (strip encryption signaling) | Manual `Buffer.readUInt32BE` loops in `media.ts` | ~10x slower than Rust; runs on every media segment |
| PDF text extraction for FTS5 indexing | `pdfjs-dist` (JS) in `indexer.ts` | CPU-heavy for large PDFs; large JS dependency |

We already have a proven WASM infrastructure:
- **`ddrm-renderer`** crate (image/PDF/text/code rendering) at `pc2-node/wasm-renderer/`
- **`cenc-decrypt`** crate (AES-128-CTR CENC decryption) at `pc2-node/crates/cenc-decrypt/`
- **`WASMRuntime`** service at `pc2-node/src/services/wasm/WASMRuntime.ts` with `executeWASIStart()`, MemFS I/O, module caching
- All WASM modules compiled with `wasm32-wasip1`, run via `@wasmer/wasi`

---

## Tier 1: High Impact (Security + Performance)

### 1A. P-256 ECDH Envelope Unwrap → WASM

**What changes**: The entire ECDH envelope unwrap — point decompression, ECDH shared secret, AES-CBC decrypt, license payload parse — moves into a single WASM call. The CEK never enters Node.js memory.

**Current code** (`media.ts` lines 1094–1327):
- `recoverMediaCEK()` generates ephemeral P-256 key pair via `webcrypto.subtle`
- `unwrapECDHEnvelope()` decompresses the Lit ephemeral public key (33→65 bytes) using pure BigInt math (`decompressP256Point`, `modPow`, `modSqrt` — lines 1263–1327)
- Derives shared key via `subtle.deriveKey(ECDH)` → AES-CBC-256
- Decrypts CEK via `subtle.decrypt(AES-CBC)`
- Parses license payload to extract 16-byte CENC key
- Returns CEK as base64

**New Rust crate**: `pc2-node/crates/ecdh-unwrap/`

**Inputs** (via MemFS `/input/command.json` + `/input/envelope.bin`):
```json
{
  "ephemeral_private_key_raw": "<hex>",
  "our_raw_pub_key": "<hex>",
  "key_alg": { "name": "ECDH", "namedCurve": "P-256" }
}
```
`/input/envelope.bin` = raw envelope bytes from Lit Action

**Outputs** (via MemFS `/output/result.json`):
```json
{
  "success": true,
  "cek_b64": "<base64>",
  "meta_size": 42,
  "key_count": 1
}
```
The CEK is returned as base64 but **never** exists in Node.js memory as raw bytes — Node.js receives only the base64 string from stdout/MemFS.

**Rust dependencies**:
- `p256` (RustCrypto) — ECDH, point decompression, scalar operations
- `aes` + `cbc` (RustCrypto) — AES-CBC-256 decryption
- `serde`, `serde_json`, `base64`, `hex`

**Node.js changes** (`media.ts`):
- `recoverMediaCEK()`: still generates ephemeral key pair via `webcrypto.subtle` (fast, native), but **exports the private key** in PKCS8 or raw form and passes it to WASM
- `unwrapECDHEnvelope()`: replaced entirely — calls `wasmRuntime.executeECDHUnwrap(...)` which writes command.json + envelope.bin to MemFS, runs `_start`, reads result.json
- `decompressP256Point`, `bigintToBytes32`, `modPow`, `modSqrt`: **deleted** — all EC math moves to Rust
- New `WASMRuntime.executeECDHUnwrap()` method (or reuse `execute()` with WASI)

**Critical design constraint**: `subtle.generateKey` stays in Node.js because it's hardware-backed (OpenSSL/BoringSSL). Only the **envelope unwrap** (which touches the CEK) moves to WASM. The private key must be exported (`extractable: true` — already set in current code at line 1132) so it can be passed to WASM.

**Security improvement**:
- CEK never exists as a JS object — only as bytes inside WASM linear memory
- BigInt EC math (timing-sensitive) replaced by constant-time Rust implementations from `p256`
- WASM linear memory is not accessible to other Node.js code

**Performance improvement**: ~20-50x for point decompression; ~5-10x for the full unwrap including AES-CBC

**Files to modify**:
- `pc2-node/src/api/media.ts` — replace `unwrapECDHEnvelope` + EC helpers with WASM call
- `pc2-node/src/services/wasm/WASMRuntime.ts` — add `executeECDHUnwrap()` method

**Files to create**:
- `pc2-node/crates/ecdh-unwrap/Cargo.toml`
- `pc2-node/crates/ecdh-unwrap/src/main.rs` (WASI entry)
- `pc2-node/crates/ecdh-unwrap/src/lib.rs` (core logic)
- `pc2-node/wasm-apps/ecdh-unwrap/` (compiled binary destination)

---

### 1B. AES-GCM Decrypt → WASM (storage.ts fallback path)

**What changes**: The `decryptAssetTwoLayer()` function in `storage.ts` (lines 969–994) currently does AES-256-GCM decryption using Node.js `crypto.createDecipheriv`. This is the fallback path when WASM rendering fails or for audio passthrough. We move the AES-GCM decrypt into the existing `ddrm-renderer` WASM binary (which already has `aes-gcm` in its Cargo.toml).

**Current code** (`storage.ts` lines 1117–1155):
```typescript
function decryptAssetTwoLayer(params, ipfsService?) {
  // ... recovers CEK via Lit ...
  const decipher = crypto.createDecipheriv('aes-256-gcm', cekBytes, ivBytes);
  decipher.setAuthTag(authTag);
  const part1 = decipher.update(ciphertext);
  const part2 = decipher.final();
  const decryptedBytes = Buffer.concat([part1, part2]);
  // ... cekBytes.fill(0) ...
  return decryptedBytes;
}
```

**Approach**: Rather than creating a new crate, extend the existing `ddrm-renderer` WASM binary to support a `"decrypt_only"` render mode. The renderer already decrypts internally for its render path; we just need a mode that decrypts and outputs raw bytes instead of a rendered image.

**New command mode** for `ddrm-renderer`:
```json
{
  "mode": "decrypt_only",
  "cek_b64": "<base64>",
  "iv_b64": "<base64>"
}
```

**Output**: `/output/result.json` + `/output/decrypted.bin` (raw plaintext bytes)

**Node.js changes** (`storage.ts`):
- `decryptAssetTwoLayer()` refactored: calls WASM `decrypt_only` mode instead of `crypto.createDecipheriv`
- The plaintext bytes are read from MemFS and used for the Node.js canvas fallback rendering (images, PDFs, text) or audio passthrough
- `cekBytes.fill(0)` still called on the Node.js-side copy of the CEK (used to build the command JSON)
- The decryptedBytes Buffer returned from MemFS is still zeroed after use by the caller

**Rust changes** (`ddrm-renderer`):
- Add a new entry path in `main.rs` that reads command.json, checks `mode == "decrypt_only"`, decrypts `/input/encrypted.bin`, and writes raw bytes to `/output/decrypted.bin` + result.json
- The `aes-gcm` crate is already a dependency — just needs a new function `decrypt_only()`

**Security improvement**: Even on the fallback path, decryption happens in WASM. The CEK and plaintext briefly exist in WASM linear memory, not in Node.js heap. The plaintext is copied to Node.js only when needed for canvas rendering or audio passthrough (and zeroed after).

**Performance improvement**: Marginal (~same speed as OpenSSL AES-NI), but the security isolation is the primary goal.

**Files to modify**:
- `pc2-node/wasm-renderer/src/main.rs` — add `decrypt_only` mode handler
- `pc2-node/src/api/storage.ts` — replace `decryptAssetTwoLayer()` body with WASM call
- `pc2-node/src/services/wasm/WASMRuntime.ts` — may need `executeDecryptOnly()` or reuse existing `executeRenderer()` with the new mode

**Files to create**: None (extends existing crate)

---

## Tier 2: Medium Impact (Performance)

### 2A. fMP4 Box Parsing → WASM (Combined Strip + Decrypt)

**What changes**: `stripEncryptionSignaling()` (init segments) and `stripSegmentEncryptionBoxes()` (media segments) move from JavaScript to Rust. The media segment path is **combined** with `cenc-decrypt` into a single WASM call: decrypt + strip in one pass, eliminating a Node.js ↔ WASM round-trip.

**Current code** (`media.ts`):
- `stripEncryptionSignaling()` (lines 623–862) — ~240 lines of manual `Buffer.readUInt32BE` / `writeUInt32BE` parsing. Runs once per init segment per track. Walks `moov→trak→mdia→minf→stbl→stsd`, finds `encv`/`enca`, reads `sinf/frma` for original format, removes `sinf` and `pssh` boxes, adjusts ancestor sizes.
- `stripSegmentEncryptionBoxes()` (lines 786–862) — ~76 lines. Runs on **every media segment**. Finds `moof→traf`, removes `senc`/`saiz`/`saio`/`sbgp`/`sgpd`, adjusts sizes, fixes `trun.data_offset`.
- `decryptSegmentViaWASM()` (lines 944–999) — calls `cenc-decrypt.wasm` for AES-128-CTR decryption, then `stripSegmentEncryptionBoxes()` is called on the result.

**Current media segment flow**:
```
Encrypted segment → [Node.js] → WASM cenc-decrypt → [Node.js] → stripSegmentEncryptionBoxes → clean segment
```

**New flow** (single WASM call):
```
Encrypted segment → WASM cenc-decrypt-v2 (decrypt + strip) → clean segment
```

**Rust changes** (`cenc-decrypt` crate — extended):
1. Add a `strip` module with Rust equivalents of `stripEncryptionSignaling` and `stripSegmentEncryptionBoxes`
2. Modify `process()` to automatically strip encryption boxes from the decrypted output
3. Add a new command field: `"strip_init": true` for init segment processing (strip only, no decrypt)
4. The existing `mp4box.rs` already parses the relevant box structures — extend it

**New command modes** for `cenc-decrypt`:
```json
// Media segment (existing + strip):
{ "cek_b64": "...", "iv_size": 8, "is_init": false, "strip": true }

// Init segment (strip only, no decrypt):
{ "is_init": true, "strip_init": true }
```

For init segments, the WASM module reads `/input/segment.bin` (the raw init segment), strips encryption signaling, and writes the clean init to `/output/segment.bin`.

**Node.js changes** (`media.ts`):
- `stripEncryptionSignaling()` — **deleted** (or kept as fallback). Init segments processed by WASM with `{ is_init: true, strip_init: true }`.
- `stripSegmentEncryptionBoxes()` — **deleted**. Integrated into the decrypt WASM call.
- `decryptSegmentViaWASM()` — simplified: no longer calls `stripSegmentEncryptionBoxes` after WASM decrypt; the WASM output is already clean.
- `findBoxStart()`, `findBoxPath()` — **deleted** (no longer needed in JS).
- The segment endpoint handler simplified: just call WASM and send the result.

**Performance improvement**: ~10x for box parsing operations. Eliminates one full Node.js ↔ WASM context switch per media segment (currently: WASM decrypt → Node.js strip → respond; new: WASM decrypt+strip → respond).

**Files to modify**:
- `pc2-node/crates/cenc-decrypt/src/main.rs` — handle `strip_init` mode
- `pc2-node/crates/cenc-decrypt/src/lib.rs` — integrate strip after decrypt
- `pc2-node/crates/cenc-decrypt/src/mp4box.rs` — extend box structures
- `pc2-node/crates/cenc-decrypt/Cargo.toml` — no new deps needed
- `pc2-node/src/api/media.ts` — remove JS strip functions, simplify WASM calls
- `pc2-node/wasm-apps/cenc-decrypt/cenc-decrypt.wasm` — rebuilt

**Files to create**:
- `pc2-node/crates/cenc-decrypt/src/strip.rs` — Rust implementation of strip functions

---

### 2B. PDF Text Extraction for Indexing → WASM

**What changes**: Replace `pdfjs-dist` in the background indexer with the `hayro-syntax` crate already compiled into our `ddrm-renderer` WASM binary. This removes the large `pdfjs-dist` JS dependency for the indexing path and runs PDF parsing in Rust.

**Current code** (`indexer.ts` lines 119–167):
```typescript
async function extractPDFText(filesystem, path, walletAddress) {
  const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = pdfjsModule;
  const pdf = await getDocument({ data: uint8Array }).promise;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    // ... join item.str values ...
  }
}
```

**Approach**: Add a `"text_extract"` mode to `ddrm-renderer` that uses `hayro-syntax` to parse a PDF and extract text content (no rendering, no rasterization). The text is written to `/output/text.txt`.

**New command mode** for `ddrm-renderer`:
```json
{
  "mode": "text_extract",
  "format": "pdf"
}
```

Input: `/input/data.bin` (raw PDF bytes — not encrypted, these are already stored on disk)
Output: `/output/result.json` + `/output/text.txt` (extracted plain text)

**Rust changes** (`ddrm-renderer`):
- Add `text_extract` handler in `main.rs`
- New function in `render/pdf.rs` or a new `extract/pdf.rs` module that uses `hayro_syntax::Pdf` to iterate pages and extract text content via `hayro_interpret` text extraction (if available) or fallback to content stream parsing
- **Note**: `hayro` is primarily a rasterizer. Text extraction quality depends on `hayro-syntax`'s ability to parse content streams for text operators (Tj, TJ, etc.). If extraction quality is insufficient, we fall back to `pdfjs-dist`. This is a **best-effort improvement**.

**Node.js changes** (`indexer.ts`):
- `extractPDFText()` refactored: first tries WASM text extraction, falls back to `pdfjs-dist` if WASM fails or returns empty
- The fallback preserves current behaviour exactly

**Performance improvement**: ~5-10x for large PDFs. Removes `pdfjs-dist` from the indexing hot path (but keeps it as fallback). Cold-path operation so the impact is on background CPU usage rather than user-facing latency.

**Risk**: `hayro-syntax` may not expose full text extraction APIs (it's primarily a rasterizer). If text extraction quality is poor, we keep `pdfjs-dist` as the primary path and mark this as a future enhancement when `hayro` adds text extraction support.

**Files to modify**:
- `pc2-node/wasm-renderer/src/main.rs` — add `text_extract` mode
- `pc2-node/wasm-renderer/src/render/pdf.rs` — add text extraction function
- `pc2-node/src/storage/indexer.ts` — try WASM first, fallback to pdfjs-dist
- `pc2-node/wasm-apps/ddrm-renderer/ddrm-renderer.wasm` — rebuilt

**Files to create**: None

---

## Implementation Plan

### Phase 1: Infrastructure & 1A (ECDH Unwrap)
- [ ] Create `pc2-node/crates/ecdh-unwrap/` Rust crate with Cargo.toml
- [ ] Implement WASI entry point (`main.rs`) — read command.json + envelope.bin, write result.json
- [ ] Implement core ECDH unwrap (`lib.rs`) — P-256 point decompression, ECDH derive, AES-CBC decrypt, license parse
- [ ] Add unit tests in Rust (known test vectors for P-256 ECDH)
- [ ] Compile to `wasm32-wasip1`, deploy to `pc2-node/wasm-apps/ecdh-unwrap/`
- [ ] Add `executeECDHUnwrap()` to `WASMRuntime.ts`
- [ ] Refactor `media.ts`: replace `unwrapECDHEnvelope` + EC helpers with WASM call
- [ ] Delete `decompressP256Point`, `bigintToBytes32`, `modPow`, `modSqrt` from `media.ts`
- [ ] Test: media playback with Lit-protected content works identically
- [ ] Build backend (`npm run build:backend`), restart, verify

### Phase 2: 1B (AES-GCM Decrypt-Only)
- [ ] Add `decrypt_only` mode handler to `ddrm-renderer/src/main.rs`
- [ ] Implement `decrypt_only()` function — read encrypted.bin, decrypt via aes-gcm, write decrypted.bin
- [ ] Compile WASM, deploy
- [ ] Add `executeDecryptOnly()` to `WASMRuntime.ts` (or extend `executeRenderer`)
- [ ] Refactor `storage.ts`: replace `crypto.createDecipheriv` in `decryptAssetTwoLayer` with WASM call
- [ ] Ensure `decryptedBytes.fill(0)` still called after use in all paths (image, PDF, text, audio)
- [ ] Test: decrypt and view image, PDF, text, audio — all identical to current behaviour
- [ ] Test: verify no plaintext in Node.js heap via logging
- [ ] Build backend, restart, verify

### Phase 3: 2A (fMP4 Box Strip + Decrypt)
- [ ] Create `pc2-node/crates/cenc-decrypt/src/strip.rs` — Rust port of `stripEncryptionSignaling` and `stripSegmentEncryptionBoxes`
- [ ] Extend `mp4box.rs` for sinf/frma/pssh box parsing needed by strip
- [ ] Integrate strip into `lib.rs` `process()` — auto-strip after decrypt when `strip: true`
- [ ] Add `strip_init` mode — strip-only for init segments (no decrypt)
- [ ] Compile WASM, deploy
- [ ] Refactor `media.ts`: pass `strip: true` in command, remove JS `stripSegmentEncryptionBoxes` call from segment handler
- [ ] Add `strip_init` path for init segments — send init through WASM instead of JS `stripEncryptionSignaling`
- [ ] Delete `stripEncryptionSignaling`, `stripSegmentEncryptionBoxes`, `findBoxStart`, `findBoxPath` from `media.ts`
- [ ] Test: full media playback (init + segments), verify MSE plays clean content
- [ ] Test: multiple tracks (video + audio), verify both strip correctly
- [ ] Build backend, restart, verify

### Phase 4: 2B (PDF Text Extraction)
- [ ] Investigate `hayro-syntax` text extraction capabilities (check if it exposes text operators from content streams)
- [ ] If viable: add `text_extract` mode to `ddrm-renderer/src/main.rs`
- [ ] Implement PDF text extraction using `hayro-syntax`
- [ ] Compile WASM, deploy
- [ ] Refactor `indexer.ts`: try WASM extraction first, fallback to pdfjs-dist
- [ ] Test: index a variety of PDFs, compare extracted text quality vs pdfjs-dist
- [ ] If quality is insufficient: mark as future enhancement, keep pdfjs-dist as primary
- [ ] Build backend, restart, verify

---

## Acceptance Criteria

### Functional (must pass — no regressions)
- [ ] Media playback works identically: init → decrypt → play in browser MSE
- [ ] dDRM secure-view works for all asset types: images, PDFs, text, code, audio
- [ ] File indexing works: PDFs and text files are searchable via FTS5
- [ ] Lit Protocol ECDH envelope unwrap succeeds on first attempt
- [ ] All error paths gracefully fall back to existing behaviour

### Security
- [ ] CEK never exists as a raw `Buffer` or `Uint8Array` in Node.js heap during ECDH unwrap
- [ ] AES-GCM decrypted plaintext handled in WASM for the secure-view path
- [ ] No new `console.log` of sensitive material (CEK hex, plaintext, etc.) in production

### Performance
- [ ] ECDH unwrap completes in <5ms (currently ~50-200ms for BigInt math)
- [ ] Media segment processing (decrypt + strip) completes in single WASM call
- [ ] No measurable regression in any existing path

### Code Quality
- [ ] All deleted JS functions have Rust equivalents with identical behaviour
- [ ] Existing WASM infrastructure patterns followed (MemFS I/O, result.json, error handling)
- [ ] No `any` types added to TypeScript
- [ ] All Rust code compiles with `--target wasm32-wasip1`

---

## Testing Strategy

1. **Unit Tests (Rust)**: Test P-256 point decompression against known NIST test vectors. Test AES-GCM decrypt against known ciphertext/plaintext pairs. Test fMP4 box strip against captured init/media segments.
2. **Integration Tests**: Play a Lit-protected media asset end-to-end. View each dDRM asset type (image, PDF, text, code, audio). Index a PDF and verify FTS5 search returns expected results.
3. **Regression Tests**: Compare outputs byte-for-byte: WASM strip output vs JS strip output on same init segments. WASM ECDH unwrap CEK vs JS unwrap CEK on same envelope. WASM decrypt-only output vs Node.js decrypt output on same encrypted data.
4. **Security Audit**: Heap dump Node.js process during media playback — verify CEK not present as raw bytes. Log WASM execution times to confirm performance targets.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `p256` crate WASM compatibility | Low | High | Well-tested RustCrypto crate; verify with `wasm32-wasip1` early |
| fMP4 strip edge cases (multi-track, extended boxes) | Medium | Medium | Keep JS fallback for first release; test with diverse media |
| `hayro-syntax` text extraction quality | High | Low | Explicit fallback to `pdfjs-dist`; cold-path only |
| WASM module size growth | Low | Low | `ecdh-unwrap` crate is tiny (~100KB); `cenc-decrypt` growth minimal |
| Private key export to WASM | Low | Medium | Key is already extractable; WASM memory more isolated than JS heap |

---

## Notes

- Each phase is independently shippable — phases can be merged separately
- The branch `feature/wasm-crypto-hardening` was created from `feature/ddrm-universal-access-layer` at commit `e05f1468e`
- All WASM modules must be compiled with `cargo build --release --target wasm32-wasip1`
- The `@wasmer/wasi` runtime is already configured in `WASMRuntime.ts`
- Phase 4 (PDF text extraction) is best-effort and depends on `hayro-syntax` capabilities
