# Elacity Labs — Weekly Team Update for the World Computer Initiative (WCI)
## April 10 – April 17, 2026

> **ElastOS Runtime v0.1.2 released** | **Elastos blockchain explorer LIVE** | **EPUB + CBZ ebooks/comics land on dDRM** | **Security sweep from community feedback — zip-bomb hardening, mnemonic recovery, Docker guard rails** | **Copy-paste exfiltration closed** | **CEK cache goes true-LRU + owner admin endpoints** | **NFT IPFS pinning (Phase 7)** | **Elastos NFT app — build pipeline + 45 → 22 MB bundle** | **PC2 ↔ Runtime convergence inventory published** | **macOS notarization confirmed complete** | **11 PC2 commits, 8,418 insertions**

### Key Links This Week

- **ElastOS Runtime v0.1.2** — [github.com/Elacity/elastos-runtime · `review/0.1.2`](https://github.com/Elacity/elastos-runtime/tree/review/0.1.2)
- **Elastos Blockchain Explorer** — [https://blockchain.elastos.io/](https://blockchain.elastos.io/)
- **Install ElastOS Runtime** — `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash`

---

## Table of Contents

1. [The Big Picture — What Happened This Week](#the-big-picture)
2. [ElastOS Runtime v0.1.2 — Released This Week](#elastos-runtime-v012--released-this-week)
3. [EPUB + CBZ Ebook & Comic Support — New dDRM Content Class](#epub--cbz-ebook--comic-support--new-ddrm-content-class)
4. [Security Sweep — Responding to Community Feedback](#security-sweep--responding-to-community-feedback)
5. [Copy-Paste Exfiltration Closed + Paged/Scrolling Reading](#copy-paste-exfiltration-closed--pagedscrolling-reading)
6. [CEK Cache — True LRU + Owner Admin Endpoints](#cek-cache--true-lru--owner-admin-endpoints)
7. [NFT IPFS Pinning — Phase 7 Sovereign Persistence](#nft-ipfs-pinning--phase-7-sovereign-persistence)
8. [Elastos NFT App — Build Pipeline & Bundle Cleanup](#elastos-nft-app--build-pipeline--bundle-cleanup)
9. [PC2 ↔ ElastOS Runtime Convergence — Inventory Published](#pc2--elastos-runtime-convergence--inventory-published)
10. [Elastos Blockchain Explorer — Full-Stack Build](#elastos-blockchain-explorer--full-stack-build)
11. [Infrastructure & Operations](#infrastructure--operations)
12. [What's Parked & What's Next](#whats-parked--whats-next)
13. [Summary Statistics](#summary-statistics)

---

## The Big Picture

This week was about **shipping a brand-new content class to dDRM, closing security gaps surfaced directly by the community, and preparing PC2 for convergence with the ElastOS Runtime**:

1. **EPUB ebooks and CBZ comics are now fully supported through the dDRM pipeline** — a new reflowable "html-lock" render tier plus a "pixel-lock" comic path, all inside the existing `ddrm-renderer` WASM module. Creator upload, encryption, viewer, and marketplace all updated end-to-end. This came out of one community question ("can we do an ebook?") and shipped in the same week.

2. **A full security sweep was run against community feedback** — a community member's Docker-data-loss and name-recovery concerns, plus an internal audit of the newly-added EPUB/CBZ paths. We shipped mnemonic-based identity recovery, Docker volume guard rails, WASM zip-bomb hardening, and closed a copy-paste exfiltration path in the DRM viewer.

3. **The CEK caching layer was audited and corrected** — what was labelled LRU was actually FIFO. Fixed with proper promotion-on-read, plus two owner-guarded admin endpoints so node operators can observe cache behaviour and force-invalidate keys after access revocation. Cost impact: multi-chapter EPUBs and multi-page PDFs now pay Lit once instead of N times.

4. **NFT IPFS Pinning landed as Phase 7** — the `nft_pins` table, three API endpoints, and Pin+Download buttons on the Elastos NFT app. Sovereign users can now seed their own NFT images/metadata on their PC2 node, so their collection stays reachable even if Elacity's gateway is down.

5. **The Elastos NFT app got a proper build pipeline and aggressive bundle cleanup** — `scripts/build-elastos-nft.sh` now clones, patches, strips, and builds reproducibly. Tier 1 cleanup took the bundle from **45 MB down to 22 MB** (removed XMTP WASM, unused route chunks, marketing images). API-level content-type filtering ensures the app only shows NFT images, not misleading DRM assets.

6. **A comprehensive PC2 ↔ Runtime convergence inventory was published** — `PC2_CONVERGENCE_INVENTORY_FOR_RUNTIME.md` maps every PC2 subsystem (8 WASM crates, wallet bridge, dDRM pipeline, IPFS stack, Contabo infrastructure, smart contracts) to the Runtime capsule model, with a bottoms-up migration sequence starting at v0.1.2.

7. **A production-grade Elastos blockchain explorer is live at [blockchain.elastos.io](https://blockchain.elastos.io/)** — Go sync engine + PostgreSQL + chi API + React/Vite frontend + Bash self-healing monitor, from genesis to live tip, delivered by one team member with AI assistance. Sub-millisecond balance lookups (20M-entry UTXO cache), WebSocket live feed, dynamic OpenGraph for shareable links, and two-source node cross-validation that raises a Telegram alert if our node lags the network by more than 50 blocks.

8. **macOS notarization is officially closed out** — all 6 Apple submissions Accepted, v1.2.2 DMG notarized and stapled. Gatekeeper confirms `Notarized Developer ID — Elacity LLC`. Users double-click the `.dmg` and install — no Terminal, no `xattr -cr` workaround.

---

## ElastOS Runtime v0.1.2 — Released This Week

**Why this matters:** ElastOS Runtime v0.1.2 is the first release where **PC2 becomes a boring front door** rather than a demo shell. Device-backed identity, hosted rooms, the explicit operator lane, and a tightened release/install/update pipeline all land in the same tag. 0.1.2 closes the gap between local proof and the installed-path experience community members actually get when they run `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash`.

> Repo: [`Elacity/elastos-runtime` · `review/0.1.2`](https://github.com/Elacity/elastos-runtime/tree/review/0.1.2) — 18 commits on this release line.

### Headline capabilities in 0.1.2

**Identity that starts with the device, not a file**
- `feat(identity): derive main DID from device key` — the primary DID is now derived from a device-backed key instead of a loose keystore. First-run identity is intrinsic to the machine.
- `feat(identity): store local profile under the device-backed identity` — the local profile now lives under that identity, so profile state has a trust anchor from install onwards.
- Result: `did:key` + Ed25519 with encrypted key storage, consistent across PC2, chat, rooms, share, and site surfaces.

**Sovereign rooms, now with a hosted browser**
- `feat(browser-runtime): add hosted browser capsule foundation` — a capsule that runs inside the runtime and exposes a hosted browser surface.
- `feat(capsules): add room-browser capsule assets` — the assets that make the room-browser a first-class installed surface.
- `feat(room): add hosted room runtime and browser integration` — the hosted `/apps/room-browser/` route now comes up under the explicit operator lane via `elastos room open --addr 0.0.0.0:8090`.
- Flow that works today: DID-backed invite → accept → member list sync → hosted room browser open in any browser against the running runtime.

**Explicit operator lane for remote control**
- `feat(node-control): add operator lane and remote node control` — `elastos setup --profile operator` + `elastos serve` brings up the owner runtime, and `elastos node info` / `elastos node status --peer <did:key:…>` give signed remote-status and trusted-source update control over Carrier.
- Operator paths (room open, agent, non-interactive capsule, run) are no longer mixed with the user path — they have their own lane and their own profile.

**PC2 front door honesty pass**
- `feat(pc2): surface room, chat, and identity flows honestly` — PC2 no longer dresses up surfaces it can't complete. Room, chat, and identity flows now surface real state, not aspirational screens.
- One home = one live host owner at a time: `elastos` (PC2 lane), `elastos serve` (operator lane), or `elastos room open` (reuses the operator runtime). No parallel entrypoints pretending to share a home.

**Release, install, and update pipeline tightened for 0.1.2**
- `chore(release): package room-browser and tighten 0.1.2 release proofs` — room-browser now packaged into the signed release surface.
- `fix(release): restore linux runtime portability audit` — Linux x86_64 and aarch64 are the truthful full-runtime baseline again, audited on every release cut.
- `fix(setup): clarify source-bootstrap path for fresh source checkouts` + `docs(setup): add trusted-source add example` — source builds now have an honest first-run story; they're explicitly a source artifact, not a pretend self-contained install.
- `test(public): expect stable release channel` — public acceptance tests now assert the stable channel, not a preview track.
- `fix(smoke): handle null ticket fields in public operator proof` — the operator smoke tolerates the real shape of ticket data coming back from Carrier.
- `chore(chat): normalize lockfile package version to 0.1.2` — canonical 0.1.2 tag alignment across crates.

**Docs aligned with the shipped runtime**
- `docs(runtime): align docs with the shipped runtime model` — `GETTING_STARTED.md`, `INSTALL.md`, `COMMAND_MATRIX.md`, `INTERACTIVE_RUNTIME_CONTRACT.md` now describe the runtime that actually ships, not the one the earlier docs were hoping for.

### What is *proven* on the 0.1.2 line

From the release [`state.md`](https://github.com/Elacity/elastos-runtime/blob/review/0.1.2/state.md):

- `just verify` — source-line gate: alignment, clean-home setup, command smoke, candidate command audit, `fmt`, `clippy`, tests
- `just verify-release` — release-trust gate: everything above **plus** the PTY PC2 front-door smoke
- `scripts/shared-runtime-gossip-proof.sh` — bidirectional gossip delivery on a shared runtime
- `scripts/chat-wasm-native-interop-smoke.sh` — native ↔ WASM chat end-to-end
- `scripts/chat-wasm-local-smoke.sh` — local WASM chat
- Two-runtime operator Carrier proof (operator status)
- Two-runtime room **presence** sync proof
- Two-runtime room **message** sync proof
- Two-runtime room **attachment** sync proof
- `scripts/public-install-identity-smoke.sh` — installed-path DID/profile acceptance
- `scripts/public-install-operator-smoke.sh` — installed-path operator-node acceptance
- `scripts/public-install-pc2-frontdoor-smoke.sh` — installed-path PC2 front-door acceptance

### Runtime classes in 0.1.2

Every command now has one explicit runtime expectation. **No command may hang.**

| Class | Commands | Contract |
|---|---|---|
| Managed dashboard | `elastos`, `elastos pc2` | Auto-starts or reuses the managed PC2 runtime (first-class front door) |
| Managed packaged interactive | `elastos capsule <name> --lifecycle interactive --interactive` | Reuses a compatible active runtime or the managed PC2 runtime |
| Managed user | `elastos chat` | Reuses a healthy PC2 runtime first, otherwise a managed chat runtime |
| No runtime | `elastos share`, `elastos open`, `elastos attest`, `elastos update`, `elastos setup`, `elastos site *` | Runs direct |
| Operator | `elastos room open`, `elastos agent`, non-interactive `elastos capsule`, `elastos run` | One explicit live runtime owner per home (`elastos serve`) |
| Starts own service | `elastos serve`, `elastos gateway`, `elastos site serve` | Starts its own daemon |

### Install surface, in one block

```bash
curl -fsSL https://elastos.elacitylabs.com/install.sh | bash

# Core PC2 front door only
elastos setup

# Broader demo/test surface (hosted room browser surface)
elastos setup --profile demo

# Explicit operator lane (elastos serve, node, agent, run)
elastos setup --profile operator
```

### Release summary — what this means for users

The focus of 0.1.2 was **identity, rooms, setup, and verification** — and the net effect is that more of ElastOS now behaves like one system instead of a set of partially connected paths:

- **Unified identity.** The system derives its main DID from the device key, and the local profile is stored under that same identity. The command line, the identity service, and the home screen now agree on who you are instead of keeping separate identity state.
- **Browser-based room access, end-to-end.** A new room-browser capsule plus the backend to use it: joining a room from a browser, browser pairing and approval, room invites and accept flows, room status and pending requests, and sync across runtimes over Carrier.
- **Home screen exposes live state.** The home screen (PC2) now shows room state, pending browser requests, active sessions, and notifications. Chat behaviour was cleaned up so it's clearer whether you return to the home screen or the terminal when you exit.
- **Clearer advanced / operator path.** `setup --profile operator` for the advanced/admin path, remote node control over Carrier, installed-path acceptance checks for identity, home-screen startup, and operator control, plus better source-checkout setup — including handling when trusted-source configuration is missing.

### Open truths (kept honest on purpose)

- The main blocker is **target-machine PC2 boringness**, not missing features.
- Hosted room setup currently spans `--profile demo` + operator lane — that split is still too implicit and will collapse in a later release.
- Installed-target full `elastos → PC2 → app → home` path is still a manual acceptance item.
- Linux is the truthful full-runtime baseline (x86_64 + aarch64). macOS is a developer workstation, not a full runtime target yet.

See § 9 ([PC2 ↔ Runtime Convergence](#pc2--elastos-runtime-convergence--inventory-published)) for how PC2 plugs into 0.1.2 and what moves over in 0.1.3.

---

## EPUB + CBZ Ebook & Comic Support — New dDRM Content Class

**Why this matters:** A community member asked if PC2 could protect ebooks the same way it protects PDFs and video. The honest answer was "not with pixel-lock" — rendering reflowable text as images destroys accessibility, zoom fidelity, and mobile reflow. So this week we added a **second render tier** to the dDRM WASM module and landed EPUB + CBZ support end-to-end, without changing the Runtime capability surface.

### Two render tiers inside the same WASM module

| Tier | MIME types | Output | DRM surface |
|------|------------|--------|-------------|
| **pixel-lock** (existing + CBZ) | `image/*`, `application/pdf`, `application/vnd.comicbook+zip`, source code | Watermarked JPEG/WebP/PNG | Raster, raw bytes never leave WASM |
| **html-lock** (new) | `application/epub+zip` | Sanitized XHTML | No JS, strict CSP, zero-width forensic watermark, SVG overlay, sandboxed iframe |

Both tiers dispatched by MIME type inside `ddrm-renderer.wasm`. Capability surface still `drm:decrypt` / `drm:render` — zero impact on the Runtime capsule contract.

### EPUB pipeline (html-lock)

- **Chapter-addressable decryption** — clients never see the whole book. One POST to `/api/storage/lit/secure-view` returns one chapter, forensically watermarked for this buyer.
- **Rust/WASM implementation** in `wasm-renderer/src/render/epub.rs`:
  - Parses `META-INF/container.xml` → locates `content.opf`
  - Parses OPF with `quick-xml` — title, author, spine, manifest, TOC (`toc.ncx` or nav doc)
  - Streams the chapter XHTML through a custom **allow-list sanitizer**: headings, paragraphs, lists, emphasis, figures, tables, images kept; `<script>`, `<object>`, `<iframe>`, inline `javascript:`, and all event handlers stripped
  - Rewrites `<img src>` to inline data-URIs; rewrites `<a href>` same-archive links to `#epub-link:…` (client-intercepted, never hits the network); external links stripped
  - Applies a **zero-width forensic watermark** — every Nth word gets a zero-width Unicode sequence encoding the buyer address; survives copy-paste and can be decoded to trace leaks
  - Overlays a translucent **diagonal SVG watermark** via CSS `background-image`
- **Strict CSP header** on every response: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`

### CBZ pipeline (pixel-lock)

- ZIP → natural-sort page filenames (so `page10.jpg` comes after `page2.jpg`) → decode → resize to viewport → watermark → re-encode JPEG
- Reader supports **Single-page** and **Webtoon/scroll** modes with neighbour prefetch (1 before + 1 after current page)
- Same `pixel-lock` watermark pipeline as existing PDF/image DRM — single source of truth for forensic marks

### Fixed-layout EPUB graceful fallback

Pre-paginated EPUBs (manga, picture books, technical docs exported as EPUB) can't reflow. The renderer detects `rendition:layout=pre-paginated` and returns HTTP **409** with `totalChapters: N`. V1.2 ships detection + friendly error; automatic chapter→pixel fallback is a V1.2.x fast-follow.

### Creator + Market UX

- `elacity-creator`: EXT_MIME_MAP recognises `.epub → application/epub+zip`, `.cbz → application/vnd.comicbook+zip` (bypasses the browser File API's unreliable `file.type`). Auto-category detection. New "Comic / Graphic Novel (CBZ)" dropdown option. File icons.
- `elacity-market`: content badges display "Ebook" / "Comic"; `CONTENT_TYPE_ICONS` updated.

### WASM binary metrics

- Final size: **5.4 MB** after `wasm-opt -Oz` with bulk-memory, nontrapping-float-to-int, and SIMD enabled.
- Capsule version `1.1.0 → 1.1.2` over the course of the week (feature + security hardening + copy-lockdown + paged-mode scaffolding).

**Commits:** `f835b33e` (feature), `b0524a14` (security), `6101fbc1` (copy-lockdown + modes), `69892070` (docs sync)

**Documentation:** `docs/wiki/Technical/EBOOK_PUBLISHING.md` — full pipeline spec, viewer integration, fixed-layout handling, Runtime alignment notes.

---

## Security Sweep — Responding to Community Feedback

**Why this matters:** a community member raised two operational concerns this week:

> *"is it going to be possible to recover my myname.ela.city. Got the name and got the setup code but then my dockersetup didnt work so i lost the data. no wallet connected. is it going to be possible to run pc2 in a docker container with docker compose?"*

Two of those concerns — **identity recovery** and **Docker data safety** — were gaps. A new user ran `docker compose down -v` (the `-v` flag wipes named volumes), lost their `identity.json`, and couldn't rebuild the same DID to re-claim their `myname.ela.city` handle. We shipped three workstreams to close the gap, plus tightened WASM safety as part of the same sweep.

### Workstream A: Mnemonic-based identity recovery

The PC2 first-run flow generates a 24-word BIP-39 recovery phrase, but there was previously **no way to use it** after the volume was gone. Now:

| Recovery path | How |
|---|---|
| **HTTP endpoint** | `POST /api/setup/restore-mnemonic` — pre-auth, setup-wizard only, rate-limited (5/15 min/IP). Refuses to clobber a live node. |
| **CLI script** | `npm run recover-mnemonic` — hidden prompt, `--mnemonic` for non-interactive, `--force` keeps old `identity.json.bak-<iso>` |
| **Offline / container-less** | `docker compose run --rm pc2-node npm run recover-mnemonic` |

Derivation is **cryptographically identical** to `IdentityService.mnemonicToSeed` — same HKDF + ed25519 path. Tested end-to-end: same phrase → identical `nodeId` across runs. The phrase never touches disk or logs.

### Workstream B: Docker volume guard rails

The root cause of the reported data loss was the unclear contract of `docker compose down -v`. We shipped:

- **Top-of-file warning block** in `pc2-node/docker-compose.yml` explicitly listing which commands preserve vs destroy the `pc2-data` volume
- **Separate `pc2-backups` volume** mounted at `/app/backups`, so a stray `docker volume rm pc2-node_pc2-data` cannot take the last-chance tarball with it
- Per-volume comments flagging `pc2-data` as critical

### Workstream C: WASM zip-bomb + unbounded-alloc hardening

While we were in the EPUB/CBZ code for the feature, the renderer's memory-safety story got a full audit. Found four open paths, closed all four with documented hard caps:

| Guard-rail | Value | Purpose |
|---|---|---|
| `MAX_ENTRY_UNCOMPRESSED_BYTES` | 32 MB | Per ZIP entry — stops oversized allocations |
| `MAX_COMPRESSION_RATIO` | 200× | Rejects classic zip bombs at entry level |
| `MAX_MANIFEST_ENTRIES` | 10,000 | Caps OPF `<item>` rows |
| `MAX_CHAPTER_HTML_BYTES` | 16 MB | Caps sanitized XHTML output |

CBZ path has equivalent caps on entry size, ratio, and page count. WASM module bumped `1.1.0 → 1.1.1` as a security hotfix. Public API (`RenderCommand`, `RenderResult`, MemFS paths) identical — zero breakage for the Runtime convergence plan.

### Workstream D: RECOVERY.md operator guide

A single-source `docs/wiki/Technical/RECOVERY.md` captures:
- What the mnemonic does and does NOT restore (DID: yes; database, IPFS store, certs: no)
- All three recovery paths with step-by-step commands
- A drop-in community-reply snippet for future data-loss / recovery threads

### Sovereign-scale note

As long as the registrar binds usernames to the DID (which is already derived from the mnemonic), re-running `recover-mnemonic` + the setup wizard's re-claim flow reattaches `yourname.ela.city` automatically. **No operator intervention needed at the supernode level.** This holds at any scale.

**Commits:** `1665eca6` (recovery), `b0524a14` (WASM hardening)

---

## Copy-Paste Exfiltration Closed + Paged/Scrolling Reading

**Why this matters:** During EPUB testing with Alice in Wonderland, the first thing a tester tried was ⌘C on a paragraph of Carroll's prose — and it worked. Text flowed straight out of the DRM viewer into any editor. The forensic watermark would still trace a leak, but we shouldn't make casual exfiltration easy. Same community test also surfaced a UX gap: the Prev/Next buttons jumped whole chapters, confusing anyone expecting page turns.

### The copy-lockdown fix — defence in depth

Three layers of protection now ride on every EPUB chapter:

1. **CSS baked into the sanitized HTML by the WASM renderer itself** (`wrap_chapter_html`):
   - `user-select: none` + vendor prefixes → mouse selection silently blocked
   - `::selection { background: transparent; color: inherit }` → ⌘A / Shift-click still "selects" invisibly, defeating the obvious UX cue
   - `-webkit-user-drag: none` on text and images → no drag-to-desktop save
   - `-webkit-touch-callout: none` → no iOS long-press action sheet
   - `@media print { body { visibility: hidden } }` → ⌘P produces a blank page
2. **Parent-frame + iframe event listeners** intercepting `contextmenu`, `copy`, `cut`, and print shortcuts as a belt-and-braces complement
3. **Forensic watermark unchanged** — any leaked text still carries the buyer's zero-width trace

Because the CSS lives inside the sanitized HTML (not on the parent frame), a malicious script in the parent can't strip it — and the iframe itself can't either because all scripts are stripped by the sanitizer and blocked by `sandbox` + CSP.

### Paged ↔ Scrolling reading mode

Two UX models, switchable from the toolbar, persisted in `localStorage`:

| Mode | Behaviour |
|---|---|
| **Paged** (default) | Chapter rendered into CSS columns sized to the viewport. `← / →` and `PgUp/PgDn` step one page at a time; `[` / `]` force a chapter jump. Status bar: `Page 3 of 12 · Chapter 2 of 15`. Kindle-feel. |
| **Scrolling** | Continuous vertical scroll within the chapter. `← / →` scroll; `[` / `]` switch chapters. Status bar: `Chapter 2 · 2 of 15`. |

The iframe sandbox was narrowed from fully-locked-down to `sandbox="allow-same-origin"` only — needed so the parent can apply the paging transforms. Scripts, forms, downloads, and top-navigation remain blocked. Since the sanitizer strips scripts anyway, same-origin is a passive capability, not an execution surface.

### The "what are these dots?" question

One tester saw `* * * * * *` in the middle of a chapter and suspected broken images. They're actually **typographic asterisms** — Carroll's original scene-break notation from the 1865 edition. Now styled as `.asterism` class with proper centering, letter-spacing, and `break-inside: avoid` so they never split across pages.

**Commit:** `6101fbc1`

---

## CEK Cache — True LRU + Owner Admin Endpoints

**Why this matters:** Every Lit Protocol decryption call costs roughly **$0.01** of Chipotle usage. A 14-chapter EPUB or a 40-page PDF at $0.01 per page/chapter adds up fast. The existing cache was supposed to make chapter 1 pay and chapters 2-N ride free — but an audit this week revealed the eviction policy was mislabelled.

### Bug 1 — "LRU" was actually FIFO

The cache called `cekSessionCache.keys().next().value` to pick a victim — that returns insertion order, not last-access order. On a busy multi-user node, an active reader could get evicted by 50 cold one-off requests, costing an extra $0.01 Lit call on their next chapter.

**Fix:** on every cache hit, `delete` then re-`set` to promote the entry to the Map's tail (most-recently-used position). Cache insertion now correctly evicts the head (least-recently-used). True LRU.

### Bug 2 — No way to force-invalidate after access revocation

If a user's NFT access was revoked, they kept decrypt capability for up to 5 minutes until TTL expired. The only mitigation was a full node restart.

**Fix:** two new owner-guarded endpoints in `/api/storage/admin/cek-cache/`:

```
GET  /stats   → { size, capacity, ttlMs, hits, misses, evictions,
                  expirations, manualFlushes, coalesced }

POST /flush   → body: { kid? , buyerAddress? }
                • {}                         full cache wipe
                • { kid }                    drop all cached CEKs for a content ID
                • { buyerAddress }           drop all cached CEKs for a wallet
                • { kid, buyerAddress }      drop one exact entry
```

Both protected by `authenticate` + `requireOwner` middleware. Non-owner requests → `401`. Every flush logs actor + scope.

### Additional correctness tightening

- New `cekCacheKey(kid, buyer)` helper so read and write paths can't drift apart
- `flushCEKCache` splits on the **first** `:` (not the last), handling kids that contain `:` characters safely
- `cekCacheStats.coalesced` counter added to verify promise-coalescing is actually saving calls on a busy node

**No security property changed:** key still `(kid, buyer.toLowerCase())`, `buyerAddress` still derived from the authenticated session, TTL still 5 min, capacity still 50, process restart still flushes.

### Observed cost savings

Confirmed during EPUB testing: a 14-chapter book pays Lit $0.01 on chapter 1 and **$0.00 on chapters 2-14**. The server logs now show `[Lit] CEK cache hit for kid=… (saved $0.01)` on every cache hit.

**Commit:** `82bc3aa9`

---

## NFT IPFS Pinning — Phase 7 Sovereign Persistence

**Why this matters:** Elastos NFT users were trusting Elacity's IPFS gateway to keep their art alive. If the gateway goes down (or a node drops the pin), the image disappears from their Library even though they still own the token. Phase 7 makes the PC2 node the **primary pinner** for the user's own NFT collection.

### Database + API

- **Migration 27** adds `nft_pins` table with composite PK `(cid, wallet_address)` — multi-wallet-per-node safe
- **Endpoints:**
  - `POST /api/nft/pin` — stores the CID locally, fetches from any reachable IPFS gateway, pins with DHT announce
  - `GET  /api/nft/pins` — list pinned NFTs for a wallet
  - `GET  /api/nft/pin/:cid` — pin status
  - `DELETE /api/nft/pin/:cid` — unpin + garbage-collect

### UI patches in the Elastos NFT app

- **Pin + Download buttons** on the `ArtAssetView` page — one click, content on your node forever
- **Pin badges** on Library cards so you can see which NFTs are sovereign-persisted at a glance
- **Auth handshake** extracts `puter.auth.token` so the iframe fetch calls are authenticated against the PC2 node

### Gateway reachability fixes along the way

- **Profile images** were broken when the thumbnail URL was relative — `account.ts` now recognises relative URLs instead of double-prefixing
- **Dead IPFS gateways swapped out**: `cloudflare-ipfs.com` and `ipfs.ela.city` (both failing intermittently) replaced with `ipfs.io`
- **Post-build `sed`** catches any remaining gateway references in compiled JS — reproducible across future rebuilds

**Commit:** `b4817edc`

---

## Elastos NFT App — Build Pipeline & Bundle Cleanup

**Why this matters:** Last week we ported `elacity-web` into PC2 as the Elastos NFT app. Shipping it fast meant some rough edges: bundle size was 45 MB (too big for a PC2 app), Explore showed audio/video categories that had no content on ESC, and there was no reproducible build — every run was manual.

### Reproducible build pipeline

`scripts/build-elastos-nft.sh` is now a single command that:

1. Clones `elacity-web develop` branch into a temp dir
2. Patches for ESC (chain 20) — removes Base/DRM features, adds auto-login
3. Applies UI stripping (see below)
4. Applies content filtering (image-only for all ESC views)
5. Builds with Vite
6. Runs Tier 1 bundle cleanup
7. Copies output to `pc2-node/data/test-apps/elastos-nft/`
8. Runs post-build `sed` for IPFS gateway refs

### Tier 1 bundle cleanup — 45 MB → 22 MB

| Removed | Reason |
|---|---|
| XMTP WASM | Messaging feature unused on ESC-NFT profile |
| Unused route chunks | Feature flags remove entire view trees |
| Marketing images | Elacity-specific banners not relevant to NFT app |

Conservative chunk fix preserved shared context chunks imported by the main bundle — no functional regressions.

### API-level content filtering (no more fake results)

Previously the app showed "All content", "Audio", "Video" filters with zero results on ESC. Now every Explore/Latest/Most-Viewed/Recently-Sold query sends `contentType: ['image']` at the API level — so the filters match what actually exists on ESC.

### Sidebar + header polish

Removed: Home, Messages, Subscriptions, Create button, Cinema section, Audio/Video Library categories, Channels/Revenue Directory tabs. Explore is the default landing page. Library defaults to card view with image-only categories.

### Collections support

Added `contractType: 'Collection'` query parameter, so multi-asset collections render as collections, not as flat lists of individual tokens.

### Sibling Market app polish

- Royalty offers UI, batch withdraw, publisher actions
- Commerce zone unification
- Earnings display cleanup
- Avatar consistency
- Storage/API endpoint refinements

**Commits:** `62b49002` (app + bundle + market), `b4817edc` (Phase 7 + infra)

---

## PC2 ↔ ElastOS Runtime Convergence — Inventory Published

**Why this matters:** PC2 and the ElastOS Runtime are on a convergence path — PC2's working subsystems (wallet bridge, dDRM pipeline, IPFS stack, WASM crates, infrastructure) should become Runtime capsules over time, not duplicate effort. This week we published the first concrete map so the Runtime side and the PC2 side work off the same source of truth.

### `PC2_CONVERGENCE_INVENTORY_FOR_RUNTIME.md`

Single source of truth for "everything PC2 has built that maps to Runtime capsules, providers, and infrastructure." Covers:

- **8 WASM crates** targeting `wasm32-wasip1` (same target as Runtime) — `ddrm-renderer`, `aes-gcm-decrypt`, `cenc-decrypt`, `cenc-encrypt`, `ipfs-assemble`, `mp4-split`, `evm-multicall`, `amm-engine`. Each with size, purpose, and proposed Runtime capsule mapping.
- **Wallet bridge** — working EVM integration reference ready to be templated into a Runtime capsule
- **Full dDRM pipeline** — Lit Chipotle → WASM decrypt → viewer
- **IPFS stack** (Helia) — working content addressing with DHT + Bitswap
- **Smart contracts** — V3 addresses on Base mainnet, all ABIs
- **Infrastructure** — ESC archive node on Contabo (fully synced), RPC proxy, Base RPC, Contabo/InterServer supernodes
- **Bottoms-up migration sequence** — what moves to capsules first, with explicit dependency order

### Follow-up links doc

All repository URLs, GitHub file links, BaseScan contract links, launcher release links, and live product URLs are now gathered in one navigable page, so the Runtime team can jump straight to any artefact without hunting.

### How PC2 plugs into Runtime 0.1.2

- Runtime codebase now at **~96K LOC**, **17 capsules** (see § 2)
- Device-backed DID + hosted rooms + explicit operator lane all shipped in 0.1.2
- `review/0.1.2` branch consolidated into 18 commits across Apr 15–16

### Decisions agreed this week

- **Bottoms-up migration**: Runtime 0.1.2 ships first, PC2 starts consuming capsules from 0.1.3 onwards, capsule-by-capsule rather than big-bang
- First PC2 → Runtime capsule candidates: wallet bridge, `ddrm-renderer`, Contabo ESC RPC proxy
- Contabo ESC archive node is the first concrete piece of PC2 infrastructure the Runtime can consume for blockchain capsule work

**Commits:** `1aff5e7b` (inventory), `df88b806` (clickable links)

---

## Elastos Blockchain Explorer — Full-Stack Build

> **Live now:** [https://blockchain.elastos.io/](https://blockchain.elastos.io/)

**Why this matters:** Elastos has lacked a modern, comprehensive blockchain explorer. The demo frontend and the main-chain staker/voter rank backend landed last week. **This week the full production stack came together and went live** at [blockchain.elastos.io](https://blockchain.elastos.io/) — a single team member, working with AI assistance, delivered what would traditionally take a team of six engineers 14–18 weeks. Not a template, not a fork, not a dashboard bolted onto someone else's indexer. Every layer was designed and written to work together.

### The Sync Engine — Go + PostgreSQL + JSON-RPC

A Go-based blockchain sync engine connects directly to an ELA full node over JSON-RPC and indexes the entire chain from genesis to current tip. Every block, transaction, input, output, and address relationship is stored — a complete relational picture of the chain, not just block headers.

- **Batch inserts** with a configurable worker pool for ingest throughput
- **Resumable** — picks up where it stopped after restarts; no re-index from scratch
- **Live mode** — once caught up to the tip, switches to polling and broadcasts new blocks **instantly over WebSocket** to every connected browser
- **Concurrent backfill system** — runs in parallel to compute derived data that can't be cheaply calculated on-the-fly: full address transaction mappings, daily statistics, early vote records, and governance state

### The API Layer — chi + LRU + 20 M-entry UTXO cache

Built on Go's `chi` router. Exposes endpoints for blocks, transactions, addresses, governance, statistics, sync status, health, and an ELA JSON-RPC passthrough.

- Results cached in an **LRU cache with configurable TTL**
- A **20-million-entry UTXO cache** keeps balance lookups **under one millisecond** without touching the database
- **Sync status endpoint** exposes: current height, chain tip, sync progress, backfill completion across 6 job types, node health, last-block age, and whether the local node is lagging behind the global network. Infrastructure transparency treated as a first-class API feature.

### The Aggregator — Governance + Cross-Validation

Runs continuously in the background:

- Computes daily statistics
- Tracks governance producer votes and rankings
- Maintains the Cyber Republic council member list
- **Cross-validates local node height against two independent public ELA RPC endpoints** — if the local node falls more than **50 blocks behind** the network, flags the sync status API immediately **and triggers a Telegram alert** to operators

### The Frontend — React 18 + TypeScript + Vite

Talks to the backend exclusively through the JSON API and WebSocket — no ad-hoc polling, no stale data. Every view hydrates from the same source of truth the sync engine built.

- **Homepage** — live network stats + real-time block feed (no polling)
- **Block pages** — full transaction detail
- **Transaction pages** — complete flow of ELA between addresses
- **Address pages** — full transaction history, balance, UTXO breakdown from the backfilled data
- **Governance section** — producer rankings with logos and vote counts
- **Statistics section** — daily chain metrics as charts across configurable time windows

### SEO & Shareability

Every page generates **dynamic OpenGraph metadata server-side** so shared links render with real data in previews: block height and timestamp, address balance, transaction summary.

- Middleware in the Go backend intercepts known route patterns, fetches the relevant chain data, injects it into the Vite-built `index.html`, and returns enriched HTML
- **Crawlers get populated metadata. Browsers hydrate normally.** No compromise on either side.
- **Full sitemap** keeps the entire indexed chain history discoverable to search engines

### Monitoring & Self-Healing

A Bash monitoring system runs every minute with **nine health checks**:

1. ELA node RPC
2. PostgreSQL
3. Docker container
4. API health
5. nginx frontend
6. Sync stall
7. Node height gap (vs public peers)
8. Disk usage
9. Memory pressure

### Scope & Economics

> *A traditional team of six would take 14 to 18 weeks. One person with AI assistance delivered the same scope with tighter architectural consistency throughout, because every decision was made with full context of every other decision in the system.*
>
> *This is on the cheap side — built externally by a contracting team this would likely have cost $100K or more.*

### Live at [blockchain.elastos.io](https://blockchain.elastos.io/)

Public deployment is live. All data surfaces — blocks, transactions, validators, staking, governance, rich list, mempool, charted daily metrics — are populated, query-ready, and served off the stack described above. Share-link previews (OpenGraph) resolve with real on-chain data, and the monitoring loop is already guarding the production instance.

---

## Infrastructure & Operations

### macOS Notarization — officially complete

- All 6 Apple notarization submissions **Accepted** (April 5–6 submissions all cleared by Apr 16)
- **v1.2.2 DMG** notarized + ticket stapled locally
- Gatekeeper confirms: `source=Notarized Developer ID, origin=Developer ID Application: Elacity LLC (LA64G2ZMY2)`
- Users can now **double-click the `.dmg` to install** — no Terminal, no `xattr -cr` workaround
- GitHub release v1.2.2 includes DMG, ZIP, AppImage, `.deb`, and Windows `.exe`
- Apple keychain profile `notary-elacity` stored for future automated submissions

**Commit:** `6f3bb806`

### Contabo ESC RPC proxy (for Phase 7 + Runtime convergence)

- PC2 now exposes `/api/esc-rpc` → proxies to `https://38.242.211.112/rpc/esc` (Contabo archive node with self-signed cert)
- **RPC fallback** built-in: Contabo primary, `api.ela.city/esc` secondary
- This is the same endpoint listed in the PC2 ↔ Runtime convergence inventory — ready for Runtime blockchain-capsule work

### IPFS gateway reliability

- Dead gateways (`cloudflare-ipfs.com`, intermittent `ipfs.ela.city`) replaced with `ipfs.io`
- Post-build `sed` ensures any compiled-in gateway refs also get swapped
- Profile-image fetch path fixed (`account.ts` now recognises relative thumbnail URLs)

### Static asset resolver refactor

- `/images/*`, `/static/*`, `/fonts/*` now handled uniformly
- Fixes a class of "asset 404" bugs when filenames contained URL-encoded characters (spaces, parentheses)

### Dev environment hygiene

- Killed 28 stale `tsx watch` processes, some 3+ days old, that had been accumulating from prior dev sessions. Live node on `:4200` healthy post-cleanup.
- `.gitignore` tightened: SQLite WAL sidecars (`*.db-wal`, `*.db-shm`, `*.db-journal`) + dev-scratch folders (`test-samples/`, `temp-3d-models/`) no longer show up as untracked.

---

## What's Parked & What's Next

### Parked (captured, awaiting next work window)

**`UPLOAD-ELACITY-LOCAL-FIRST`** — `POST /api/storage/ipfs/upload-elacity` currently does a **synchronous** call to `base.ela.city` with no timeout and no local fallback. On April 17 the service returned 504s and the Creator publish flow blocked for up to 3 × 60 seconds (asset + thumbnail + metadata) per publish. Full implementation plan, acceptance criteria, and degraded-service test strategy captured in `.cursor/tasks/UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md`. Aligned with the longer-term sovereign direction: user uploads to their own IPFS; Elacity indexer observes on-protocol and replicates.

### Immediate (this coming week)

1. **Full manual QA pass on EPUB + CBZ** — the feature shipped without end-to-end user testing; verify Paged mode, copy-lockdown, fixed-layout 409, natural-sort comics
2. **Execute `UPLOAD-ELACITY-LOCAL-FIRST`** — ~1 day of work, unblocks the publish flow whenever Elacity IPFS is slow
3. **PC2 adoption of Runtime 0.1.2 capabilities** — start wiring PC2 into the device-backed DID + hosted room surfaces now that the tag is out
4. **Market P0 fixes from last week's audit** — SA batch paths for cancel/delist, offer accept/cancel wallet params

### Short-term (1–2 weeks)

5. **V1.2.x fast-follow: automatic fixed-layout EPUB → pixel-lock fallback** in the viewer
6. **Elastos blockchain explorer — public-facing deployment** (frontend + API + monitoring stack already built end-to-end this week)
7. **V3 frontend integration** — complete SDK wiring with marketplace UI
8. **Content indexer V3** — unblock final 2/7 V3 E2E tests

### Medium-term (this month)

9. **Begin Runtime capsule migration** — start with the Contabo ESC node as a blockchain capsule, per the convergence inventory
10. **NFT IPFS pinning — Phase 8**: automatic pin-on-buy when a user acquires a new NFT, so the user never has to click Pin manually
11. **Research Lit replacement** — evaluate as part of supernode architecture (carried from last week)

---

## Summary Statistics

### PC2 Engineering (Apr 10–17)

| Metric | Value |
|--------|-------|
| Commits (non-merge) | **11** |
| Insertions | **8,418** |
| Deletions | **500** |
| Unique files touched | **53** |
| Areas | pc2-node (38 files), docs (11), .cursor (2), scripts + root (2) |

### Ebooks & Comics (new content class)

| Metric | Value |
|--------|-------|
| New MIME types supported | 2 (`application/epub+zip`, `application/vnd.comicbook+zip`) |
| Render tiers | 2 (pixel-lock + html-lock) |
| WASM module size | 5.4 MB (wasm-opt -Oz) |
| Capsule version | 1.1.0 → 1.1.2 (feature → security → lockdown) |
| New Rust source files | 2 (`render/epub.rs`, `render/cbz.rs`) |
| New viewer apps | 2 (`reader-epub.js`, `reader-cbz.js`) |
| Runtime contract changes | 0 (capability surface unchanged) |

### Security

| Workstream | Outcome |
|---|---|
| Mnemonic recovery | HTTP + CLI + Docker-compose-run paths all shipped |
| Docker volume guard rails | Warning block + separate backups volume |
| WASM zip-bomb hardening | 4 hard caps across EPUB + CBZ paths |
| Copy-paste exfiltration | Closed via CSS + iframe listeners + forensic watermark |
| Community feedback closed | Name-recovery + Docker-data-loss concerns raised in the group this week |

### CEK Caching

| Metric | Value |
|--------|-------|
| Eviction policy | FIFO → **true LRU** |
| Admin endpoints | `GET /stats`, `POST /flush` (owner-only) |
| Cost savings observed | 14-chapter EPUB pays Lit **1 time** instead of 14 |
| Stats counters | hits, misses, evictions, expirations, manualFlushes, coalesced |

### NFT IPFS Pinning (Phase 7)

| Metric | Value |
|--------|-------|
| New DB table | `nft_pins` (migration 27) |
| New API endpoints | 3 (`POST/GET/DELETE /api/nft/pin`, `GET /api/nft/pins`) |
| UI surfaces | Pin+Download buttons on ArtAssetView, badges on Library cards |
| IPFS gateway fixes | Dead `cloudflare-ipfs.com`/`ipfs.ela.city` swapped to `ipfs.io` |

### Elastos NFT App

| Metric | Value |
|--------|-------|
| Bundle size | **45 MB → 22 MB** |
| Build script | `scripts/build-elastos-nft.sh` (reproducible) |
| UI surfaces stripped | Home, Messages, Subscriptions, Create, Cinema, Audio/Video |
| Content type filter | Image-only at API level (Explore, Latest, Most-Viewed, Recently-Sold) |
| Collections support | `contractType: 'Collection'` query parameter |

### ElastOS Runtime 0.1.2 (released this week)

| Metric | Value |
|--------|-------|
| Branch / tag line | [`review/0.1.2`](https://github.com/Elacity/elastos-runtime/tree/review/0.1.2) |
| Commits on the line | **18** across Apr 15–16 |
| Codebase size | ~96K LOC, **17 capsules** |
| Identity | Main DID now derived from device-backed key; local profile stored under it |
| Rooms | Hosted room runtime + room-browser capsule packaged into the signed release |
| Operator lane | `elastos setup --profile operator` + `elastos serve` + `elastos node info/status` |
| PC2 front door | "Honesty pass" — room/chat/identity now surface real state, not demo screens |
| Proof surface | `just verify-release` + 3 public-install smokes + 3 cross-runtime room sync tests |
| Supported baseline | Linux x86_64 + aarch64 |

### PC2 ↔ Runtime Convergence

| Metric | Value |
|--------|-------|
| Inventory published | `PC2_CONVERGENCE_INVENTORY_FOR_RUNTIME.md` |
| WASM crates mapped | 8 |
| Migration approach | Bottoms-up — capsule at a time, starting Runtime 0.1.3 |
| First capsule candidates | Wallet bridge, `ddrm-renderer`, Contabo ESC RPC proxy |

### Elastos Blockchain Explorer

| Metric | Value |
|--------|-------|
| Live URL | **[https://blockchain.elastos.io/](https://blockchain.elastos.io/)** |
| Delivery | Full stack end-to-end — Go sync engine + PostgreSQL + chi API + React/Vite frontend + Bash monitor |
| Chain coverage | Genesis → live tip, every block/tx/input/output/address relationship |
| Balance lookup latency | **< 1 ms** via 20 M-entry UTXO cache |
| Live block feed | WebSocket broadcast (no polling) |
| Backfill jobs | 6 types (address tx mappings, daily stats, votes, governance, …) |
| Cross-validation | Local height vs 2 independent public ELA RPCs; >50-block lag → Telegram alert |
| SEO surface | Server-side dynamic OpenGraph for every route + full sitemap |
| Health checks | **9** (ELA RPC, Postgres, Docker, API, nginx, sync stall, height gap, disk, memory) — runs every minute |
| Team size | **1 person with AI assistance** (traditional equivalent: 6 engineers × 14–18 weeks, ≈ $100K+ external build) |

### Infrastructure

| Metric | Value |
|--------|-------|
| macOS notarization | **Complete** — all 6 submissions Accepted |
| DMG installation | Double-click, no Terminal |
| Contabo ESC RPC | Live at `https://38.242.211.112/rpc/esc` via PC2 proxy `/api/esc-rpc` |
| Supernodes | InterServer + Contabo both live, Lit Chipotle + ESC sync |
| Dev-env cleanup | 28 stale `tsx watch` processes retired |

### Documentation

| New / Updated | File |
|---|---|
| New | `docs/wiki/Technical/RECOVERY.md` (operator recovery guide) |
| New | `docs/handover/PC2_CONVERGENCE_INVENTORY_FOR_RUNTIME.md` (Runtime convergence map) |
| Updated | `docs/wiki/Technical/EBOOK_PUBLISHING.md` (copy-lockdown, paged-mode, testing) |
| Updated | `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` (CEK cache + admin endpoints) |
| Updated | `docs/core/ROADMAP.md` (EPUB + CBZ listed under V1.2) |
| Parked task | `.cursor/tasks/UPLOAD-ELACITY-LOCAL-FIRST/` |

---

*This is an Elacity Labs team update for the World Computer Initiative (WCI) covering April 10 – April 17, 2026. In scope: **ElastOS Runtime 0.1.2** (identity, hosted rooms, operator lane, release pipeline), PC2 `feature/lit-chipotle-migration` branch work (dDRM WASM renderer for EPUB + CBZ, recovery + Docker guard rails, CEK caching observability, NFT IPFS pinning, Elastos NFT app build pipeline), the PC2 ↔ Runtime convergence inventory, and the end-to-end Elastos blockchain explorer build. Community feedback — specifically a member's name-recovery and Docker-data-loss concerns — drove two of the week's three largest security workstreams and has now been materially closed in code, docs, and tests.*
