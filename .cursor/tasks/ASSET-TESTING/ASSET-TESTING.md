# Task: Universal Asset Type Testing & Validation

**Task ID**: ASSET-TESTING
**Created**: 2026-03-20
**Status**: Proposed
**Priority**: High

## Description

Systematic end-to-end testing of every supported asset type across both playback pipelines (Media Runtime and dDRM Viewer), the Creator Dashboard mint flow, marketplace purchase, library display, and wallet compatibility.

## Background

With the unified `.ddrm` capsule format now in place and Wave 1 universal asset viewers completed, we need to validate every asset type works end-to-end: Creator mint → marketplace listing → purchase → library → open/play → anti-piracy controls.

---

## Pipeline 1: Media Runtime (DASH/CENC encoding pipeline)

Assets processed through the Creator Dashboard's FFmpeg/Bento4/CENC pipeline, streamed via DASH through `pc2-media-runtime`.

- [ ] **1. Video (H.264/AAC)** — any `.mp4`
  - Full playback, seek, quality selector
  - Status: **Untested**

- [ ] **2. Video (AV1)** — AV1 `.mp4` or `.webm`
  - Init segment splitting, PSSH stripping
  - Status: **Untested**

- [x] **3. Audio (MP3)** — `.mp3`
  - Audio-only DASH, artwork display
  - Status: **Passed**

- [ ] **4. Audio (WAV/FLAC)** — `.wav` or `.flac`
  - Transcoding to AAC, DASH packaging
  - Status: **Untested**

## Pipeline 2: dDRM Viewer (WASM decrypt + render/passthrough)

Assets encrypted via Creator Dashboard and viewed through `ddrm-viewer` with server-side WASM decryption.

- [ ] **5. Image (JPEG)** — `.jpg`
  - WASM render, watermark, zoom/pan
  - Status: **Untested**

- [ ] **6. Image (PNG)** — `.png`
  - WASM render, watermark
  - Status: **Untested**

- [ ] **7. PDF** — `.pdf`
  - WASM render, multi-page, zoom
  - Status: **Untested**

- [ ] **8. Text (.txt)** — `.txt`
  - WASM render, scrollable
  - Status: **Untested**

- [ ] **9. Code (.js/.py)** — source file
  - Syntax highlighting, line numbers
  - Status: **Untested**

- [x] **10. 3D Model (GLB)** — `.glb`
  - Three.js viewer, controls, watermark
  - Status: **Passed**

- [ ] **11. 3D Model (OBJ)** — `.obj`
  - OBJLoader, same controls
  - Status: **Untested**

- [ ] **12. 3D Model (STL)** — `.stl`
  - STLLoader, computed normals
  - Status: **Untested**

- [ ] **13. 3D Model (FBX)** — `.fbx`
  - FBXLoader, animation
  - Status: **Untested**

- [ ] **14. Dataset (CSV)** — `.csv`
  - Paginated table, search
  - Status: **Untested**

- [ ] **15. Dataset (TSV)** — `.tsv`
  - Tab-delimited table
  - Status: **Untested**

- [ ] **16. Font (TTF)** — `.ttf`
  - Specimen display, sizes
  - Status: **Untested**

- [ ] **17. Font (OTF)** — `.otf`
  - Same as TTF
  - Status: **Untested**

- [ ] **18. Font (WOFF2)** — `.woff2`
  - Same as TTF
  - Status: **Untested**

- [ ] **19. Archive (ZIP)** — `.zip`
  - File tree listing
  - Status: **Untested**

## Cross-Cutting (every asset)

- [ ] Creator Dashboard detects correct MIME type
- [ ] Mint transaction succeeds on-chain
- [ ] Asset appears on marketplace
- [ ] Purchase flow works (different wallet)
- [ ] Asset appears in Library
- [ ] "Open" launches correct viewer (media-runtime or ddrm-viewer)
- [ ] Server logs show WASM decrypt path
- [ ] Anti-piracy: watermark, right-click disabled, blob revoked

## Wallet Testing

- [ ] Mint with EOA wallet (MetaMask)
- [ ] Mint with Smart Account (Particle UA)
- [ ] Purchase with both wallet types

## Post-Testing Milestones

- [ ] **AI Model Marketplace Alpha** — First non-media vertical: GGUF encrypt → IPFS → ACCESS_TOKEN → decrypt → Ollama
- [ ] **Deploy Supernode Provisioning** — When Lit Chipotle production goes live

## Testing Strategy

For each asset type:
1. Upload via Creator Dashboard
2. Verify MIME detection and encryption
3. Mint on-chain
4. Verify marketplace listing
5. Purchase from a different wallet
6. Verify Library display
7. Open/play and verify viewer functionality
8. Check anti-piracy controls
9. Check server logs for WASM decrypt path
10. Save to filesystem and verify `.ddrm` file with NFT thumbnail

## Notes

- Audio (MP3) and 3D Model (GLB) already passed in prior testing sessions
- Unified `.ddrm` format means all downloaded assets now use single extension
- Both EOA and Smart Account wallets should be tested for mint and purchase flows
- AV1 video requires the init segment splitting fix from Mar 18
