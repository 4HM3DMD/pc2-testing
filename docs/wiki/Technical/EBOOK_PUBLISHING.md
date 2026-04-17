# Ebook & Comic Publishing — EPUB + CBZ DRM

**Status**: Implemented in PC2 Node, V1.2 release (Rust/WASM).  
**Last updated**: 2026-04-16

> Companion to `ELACITY_DDRM_INTEGRATION.md`. Describes how reflowable
> EPUB ebooks and CBZ comic archives move through the sovereign PC2
> pipeline, from upload to secure playback, using the existing dDRM
> renderer WASM module.

---

## 1. Why Two Render Tiers

Existing PC2 assets (images, PDFs, source code) flow through **pixel-lock**:
the WASM renderer decrypts the ciphertext into linear memory, rasterizes
a watermarked JPEG, and streams that JPEG to the viewer iframe. The raw
file never leaves WASM.

Pixel-lock is ideal for fixed-layout content. It fails for **reflowable
ebooks** — readers expect to resize text, change font family, switch
themes, and reflow to narrow mobile panes. Rendering every frame as a
raster image destroys that UX (text becomes pixels; accessibility tools
cannot narrate; zoom pixelates).

Therefore V1.2 introduces a second tier — **html-lock** — exclusively
for EPUB:

| Tier        | MIME types                               | Output           | DRM surface |
|-------------|------------------------------------------|------------------|-------------|
| pixel-lock  | `image/*`, `application/pdf`, `application/vnd.comicbook+zip`, source code | JPEG/WebP/PNG | Watermarked raster, no raw bytes |
| html-lock   | `application/epub+zip`                   | Sanitized XHTML  | No JS, strict CSP, zero-width stego watermark, SVG overlay |

Both tiers run inside the same `ddrm-renderer.wasm` binary and are
selected by MIME type dispatch.

---

## 2. EPUB Render Pipeline (html-lock)

### 2.1 Chapter-addressable decryption

Clients never see the whole EPUB. They request one **chapter at a time**
by POSTing to `/api/storage/lit/secure-view` with:

```json
{
  "mimeType": "application/epub+zip",
  "chapter": 0,
  "viewportWidth": 680,
  "litCiphertext": "...",
  "dataToEncryptHash": "...",
  "iv": "...",
  "kid": "...",
  "buyerAddress": "0x..."
}
```

Server-side the request is forwarded to the WASM renderer with a
`RenderCommand` containing:

```rust
RenderCommand {
    cek_b64: "…",
    iv_b64:  "…",
    mime_type: "application/epub+zip",
    chapter: Some(0),
    forensic_mark: Some("0xBuyerAddress"),
    viewport_width: Some(680),
    output_format: Some(OutputFormat::Html),
    ..
}
```

### 2.2 Inside the WASM module (`wasm-renderer/src/render/epub.rs`)

1. **Decrypt** the ZIP archive into linear memory using AES-GCM + the CEK.
2. **Parse `META-INF/container.xml`** → locate `content.opf`.
3. **Parse OPF** with `quick-xml`:
   - Extract `<metadata>` → publication title, author.
   - Check `<meta property="rendition:layout">` → if `pre-paginated`,
     return `fixed_layout = true` and abort the HTML path (see §2.4).
   - Walk `<manifest>` → map item IDs → hrefs → MIME types.
   - Walk `<spine>` → ordered chapter index.
   - If a nav document (`properties="nav"`) or `toc.ncx` exists, build
     `chapters: Vec<TocEntry>`.
4. **Read the chapter XHTML file** from the ZIP.
5. **Sanitize streaming**: the custom allow-list sanitizer (also built on
   `quick-xml`) emits only the tag/attribute set that a reader needs:
   - Headings, paragraphs, lists, emphasis, figures, tables, images.
   - `src=` attributes for `<img>` are rewritten to inline
     `data:` URIs (images extracted from the ZIP, size-capped to keep
     chapters under a few MB).
   - All `href=` attributes are rewritten:
     - Same-archive anchor → `#epub-link:<normalized-href>` (handled by
       the reader; never hits the network).
     - External → stripped.
   - `<script>`, `<object>`, `<iframe>`, inline `javascript:`,
     event handlers → all dropped.
   - CSS is either rewritten into a single `<style>` block or discarded
     when it references external resources.
6. **Watermark** — two layers:
   - **Zero-width forensic mark**. Every Nth word gets a zero-width
     Unicode sequence encoding the buyer address. Survives copy/paste
     and can be decoded with a forensic tool to trace leaked text.
     Implemented via `ForensicCursor` in `render/epub.rs`.
   - **Visible diagonal SVG overlay**. A CSS
     `background-image: url("data:image/svg+xml;...")` injects a
     translucent diagonal watermark bearing `0xBuyer — 2026-04-16`
     across the content area. Deterring screen capture without
     destroying readability.
7. **Return** the sanitized chapter HTML to the node via MemFS, along
   with `total_chapters`, `chapters[]`, `epub_title`, `epub_author`.

### 2.3 On the node (`/api/storage/lit/secure-view`)

When the MIME type is EPUB the node:

- Sets `Content-Type: text/html; charset=utf-8; profile=epub-chapter`.
- Adds response headers:
  - `X-Asset-Chapters: 42`
  - `X-Asset-TOC: <base64-json>`  (only on the first chapter response)
  - `X-Asset-Title: <encoded>`
  - `X-Asset-Author: <encoded>`
- Attaches a strict Content-Security-Policy:

  ```
  Content-Security-Policy: default-src 'none'; img-src data:;
    style-src 'unsafe-inline'; font-src data:; base-uri 'none';
    form-action 'none';
  ```

This CSP is enforced in the browser *in addition to* the WASM sanitizer
— defense in depth. Even if a malformed chapter slips past sanitization,
the browser cannot execute scripts or fetch remote resources.

### 2.4 Fixed-layout EPUB fallback

EPUB 3 supports pre-paginated layouts (manga, picture books, technical
PDFs exported as EPUB). These cannot reflow. When the renderer detects
`rendition:layout = pre-paginated`:

- Returns `fixed_layout = true` and no HTML body.
- Node responds with HTTP **409** + JSON: `{ error: "epub-fixed-layout",
  totalChapters: N }`.
- The client is expected to retry each chapter via the CBZ/pixel-lock
  path. This gives fixed-layout publishers a graceful upgrade path
  without breaking the reflowable majority.

(V1.2 ships detection + 409. Automatic chapter→pixel fallback in the
viewer is a V1.2.x fast-follow — currently a client receiving 409 will
surface an "EPUB uses a fixed layout" message.)

---

## 3. CBZ Render Pipeline (pixel-lock)

CBZ is a ZIP of image files, one per page. Simpler than EPUB.

### 3.1 Inside `wasm-renderer/src/render/cbz.rs`

1. Decrypt → ZIP archive in linear memory.
2. Enumerate ZIP entries.
3. **Natural sort** page filenames so `page10.jpg` comes after
   `page2.jpg` (custom `natural_cmp`).
4. Reject non-image entries (ignored rather than errored, so stray
   `metadata.xml` files don't break the read).
5. Select the requested page (1-indexed, matches PDF convention).
6. Decode the image (`image` crate).
7. Resize to the caller's `max_width` if larger.
8. Apply the existing `watermark.rs` pixel watermark (buyer short-ID +
   date, diagonal).
9. Re-encode as JPEG (quality ~80).
10. Return the JPEG bytes + `total_pages`.

### 3.2 On the node

CBZ re-uses the existing pixel-lock response headers:
`X-Asset-Pages`, `X-Renderer`, `Content-Type: image/jpeg`.

### 3.3 Why we didn't split CBR / comic-rack formats

CBR (RAR) is legally ambiguous (proprietary RAR decoder). CBT (TAR) is
rare. CB7 (7zip) would add a large Rust dep. CBZ covers ≥90% of the
market; publishers wanting RAR can re-pack as ZIP in a second.

---

## 4. Viewer Integration (`ddrm-viewer`)

The viewer is a static Elacity app served to the iframe. It dispatches
on MIME type:

```
viewer.js
├── pixel-lock MIMEs      → existing image/document renderers
├── application/epub+zip  → EpubReader.open(ctx)   [reader-epub.js]
└── application/vnd.*cbz+ → CbzReader.open(ctx)    [reader-cbz.js]
```

### 4.1 `reader-epub.js`

Opens a `<iframe sandbox="">` with *no* permissions:

- No `allow-scripts` → chapter cannot run JS.
- No `allow-same-origin` → cannot read cookies or parent DOM.
- No `allow-top-navigation` → cannot escape the viewer.
- No `allow-forms` → cannot phish.
- No `allow-downloads` → cannot save.

The iframe loads a `blob:` URL holding the sanitized chapter HTML.
Theme (light / sepia / dark), font-size (14–26px), and viewport width
are applied by injecting a `<style id="ddrm-reader-theme">` tag into the
iframe document on `onload`. Preferences persist in `localStorage` under
`ddrm-epub-prefs`.

Chapter navigation:
- Toolbar Prev/Next buttons.
- TOC panel (populated from the `X-Asset-TOC` header cached on first
  chapter response).
- Internal links: `#epub-link:<href>` clicks are captured and resolved
  to the matching TOC entry.

### 4.2 `reader-cbz.js`

Two reading modes (persisted):

- **Single page** — one centered image per viewport, click-zones toggle
  prev/next.
- **Scroll** — webtoon-style vertical stack with lazy prefetch of the
  next 6 pages.

Prefetch radius (1 before + 1 after the current page) balances
responsiveness against bandwidth. A 200-page comic never loads more
than ~8 pages into memory at once.

---

## 5. Creator & Marketplace UX

### 5.1 `elacity-creator`

- `EXT_MIME_MAP` now includes `.epub → application/epub+zip` and
  `.cbz → application/vnd.comicbook+zip` so the Browser File API's
  unreliable `file.type` is bypassed.
- Auto-category detection: EPUB → "ebook"; CBZ → "comic".
- The Category dropdown gained a "Comic / Graphic Novel (CBZ)" option,
  and the ebook option is renamed "E-book (EPUB / PDF)".
- File icons: EPUB → 📖; CBZ → 💥.

### 5.2 `elacity-market`

- `CONTENT_TYPE_ICONS` gains `ebook: '📖'` and `comic: '💥'`.
- `getContentType` now labels EPUB items as "Ebook" and CBZ items as
  "Comic", so content badges display the right string.

---

## 6. ElastOS Runtime Alignment

This entire feature ships within the existing `ddrm-renderer` WASM
module — no new capabilities, no new provider operations, no changes to
the `DRMProvider.render()` contract.

When the PC2 node migrates to the Runtime Capsule model, the viewer
endpoint is intended to become a "Viewer Provider Capsule". It consumes
capability scopes `drm:decrypt`, `drm:verify-access`, and
`storage:fetch`, and provides `drm:render`. The JSDoc in
`/api/storage/lit/secure-view` includes explicit annotations for this
mapping.

The `capsule.json` metadata already declares both render tiers so a
future Runtime host can advertise EPUB/CBZ support without rebuilding:

```json
{
  "render_tiers": {
    "pixel-lock": "image/*, application/pdf, application/vnd.comicbook+zip, text/x-*",
    "html-lock":  "application/epub+zip (reflowable; sanitized XHTML with forensic watermark)"
  }
}
```

---

## 7. Testing Checklist

Run through this before considering the feature production-ready:

- [ ] Upload a reflowable EPUB (e.g. Project Gutenberg classic).
- [ ] Verify chapter 0 loads; toolbar shows TOC; chapter count matches.
- [ ] Toggle theme (light → sepia → dark); font size +/-.
- [ ] Click a TOC entry; verify chapter-link navigation.
- [ ] Right-click in reader → confirm context menu blocked.
- [ ] View page source of iframe → confirm no `<script>` tags,
      no external URLs, zero-width characters present in text.
- [ ] Upload a fixed-layout EPUB → expect 409 + friendly message.
- [ ] Upload a CBZ (≥10 pages) → verify natural sort order.
- [ ] Toggle single / scroll modes in CBZ reader.
- [ ] Verify watermark visible on CBZ pages (diagonal; buyer short-ID).
- [ ] Verify EPUB watermark overlay visible on each chapter.

---

## 8. Known Limitations

- **Fonts inside EPUB**: publisher-supplied fonts are not yet inlined as
  data-URIs. Font-family declarations survive sanitization but fall back
  to the reader's Georgia stack if the custom font can't load.
- **EPUB audio/video**: dropped by the sanitizer. Reflowable ebooks
  containing embedded A/V degrade to text-only in V1.2.
- **MathML**: stripped for safety. A future iteration can allow the
  `mml:` namespace through the allow-list.
- **CBR / CBT / CB7**: unsupported. Re-pack as CBZ.
- **Fixed-layout EPUB**: detected + gracefully refused. Automatic
  fallback to per-chapter pixel-lock is V1.2.x.

---

## 9. File Reference

| Layer        | File                                                           |
|--------------|----------------------------------------------------------------|
| Rust/WASM    | `pc2-node/wasm-renderer/src/render/epub.rs` (new)             |
| Rust/WASM    | `pc2-node/wasm-renderer/src/render/cbz.rs` (new)              |
| Rust/WASM    | `pc2-node/wasm-renderer/src/render/watermark.rs` (forensic+SVG) |
| WASM binary  | `pc2-node/wasm-apps/ddrm-renderer/ddrm-renderer.wasm`         |
| Capsule meta | `pc2-node/wasm-apps/ddrm-renderer/capsule.json`               |
| Node API     | `pc2-node/src/api/storage.ts` (`/lit/secure-view` handler)    |
| Node runtime | `pc2-node/src/services/wasm/WASMRuntime.ts`                   |
| Viewer       | `pc2-node/data/test-apps/ddrm-viewer/reader-epub.js` (new)    |
| Viewer       | `pc2-node/data/test-apps/ddrm-viewer/reader-cbz.js` (new)     |
| Viewer       | `pc2-node/data/test-apps/ddrm-viewer/viewer.js` (dispatch)    |
| Creator      | `pc2-node/data/test-apps/elacity-creator/app.js`              |
| Market       | `pc2-node/data/test-apps/elacity-market/app.js`               |
