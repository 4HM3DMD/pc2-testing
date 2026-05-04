# PC2 Network Development Report: March 7–17, 2026

> **10 days of shipping.** This report covers all engineering work across 5 active branches, 41 commits, and thousands of lines of new infrastructure. Written for the Elacity community to understand what was built, why it matters, and what comes next.

---

## Executive Summary

In the past 10 days, the PC2 network went from having basic encrypted content support to a **fully functional decentralized Digital Rights Management (dDRM) system** — one of the first of its kind in Web3. Users can now create encrypted digital assets, trade them on-chain, and securely view them through a piracy-resistant runtime — all from their personal cloud computer.

The major achievements:

1. **Complete dDRM Creator-to-Consumer Pipeline** — encrypt, mint, buy, and securely view digital assets (images, PDFs, documents) end-to-end on Base mainnet
2. **Lit Protocol Chipotle Migration** — migrated from the deprecated Datil SDK to Lit's next-generation TEE-based Chipotle system, eliminating browser dependencies and reducing the entire Lit SDK to a single REST call
3. **Rust/WASM Security Runtime** — all decryption and rendering now happens inside WebAssembly sandboxes; plaintext content never touches the browser
4. **Server-Side DASH/CENC Media Pipeline** — DRM-protected video streaming without EME, CDM, or SharedArrayBuffer — works in any sandboxed iframe
5. **Supernode Decentralization Phase 2** — dynamic discovery, relay mode, one-command bootstrap for new infrastructure operators

---

## 1. Elacity dDRM: The Complete Digital Rights Pipeline

### What It Is

Elacity dDRM (decentralized Digital Rights Management) is Elacity Labs' proprietary system for tokenized content trading. Every digital asset — images, PDFs, documents, music, video, AI models, games — gets encrypted with a unique key, and access rights are represented as on-chain tokens (ERC-1155 AccessTokens) on Base.

Unlike traditional DRM (think Apple's FairPlay or Google's Widevine), Elacity dDRM is:
- **Decentralized**: No central license server. Key retrieval happens through Lit Protocol's Trusted Execution Environments
- **Creator-owned**: Creators set their own pricing, royalty splits, and distribution terms
- **Piracy-resistant**: Content is decrypted inside WASM sandboxes and rendered as pixels — raw files never reach the browser

### What Was Built (March 8–15)

**Creator Dashboard** — A full 4-step wizard for creating protected digital assets:
1. Select a file (image, PDF, text, code, video, audio)
2. Add metadata (title, description, category, price)
3. Encrypt & upload — two-layer encryption (AES-256-GCM + Lit key escrow), upload to IPFS
4. Mint on-chain — creates the asset as an ERC-1155 token with AccessToken, RoyaltyShare, and DistributionRight sub-tokens

The entire minting process was verified on Base mainnet with real transactions:
- Channel creation via ChannelCore contract (95/5 royalty split)
- Paid mint with USDC payment (buy_and_resell model)
- Automatic operative approval and MINTER_ROLE grants
- Assets visible on the Elacity marketplace at base.ela.city

**Market dApp** — Enhanced marketplace with purchase flow:
- Browse assets from Elacity's GraphQL-indexed catalog
- Buy AccessTokens with USDC (on-chain ERC-1155 transfer)
- Immediate cache invalidation so purchased assets appear in library
- MetaMask gas estimation fix (resolved "Estimated changes: Unavailable" popup)

**Elacity IPFS Pipeline** — Sovereign content storage:
- Dual-upload: encrypted content goes to both the local PC2 node and Elacity's IPFS infrastructure
- CIDv0 format compatibility throughout (tokenURI, asset references, gateway resolution)
- No third-party pinning services — everything flows through Elacity's infrastructure

### Why It Matters

This is the foundation for Elacity's vision of a **peer-to-peer digital marketplace**. Every PC2 node becomes both a storefront and a vault — creators upload and sell directly from their personal cloud computers, and buyers access content through cryptographic proofs rather than accounts or subscriptions. The next update will enable node-to-node trading, making this fully peer-to-peer.

---

## 2. Lit Protocol Chipotle Migration

### What It Is

Lit Protocol provides decentralized key management — they hold the encryption keys for protected content inside Trusted Execution Environments (TEEs), and only release them when on-chain conditions are met (e.g., "does this wallet hold an AccessToken for this asset?").

Lit is deprecating their current system (Datil) in favor of a new architecture called Chipotle. We completed the full migration.

### What Changed (March 17)

**Before (Datil):**
- Required the full `@lit-protocol/*` SDK (~1.2MB of dependencies)
- Used WebSocket connections, SIWE (Sign-In With Ethereum), session signatures, and capacity credits
- Heavy browser dependencies that conflict with sandboxed iframe environments
- Threshold BLS cryptography across multiple Lit nodes

**After (Chipotle):**
- Replaced the entire SDK with a single REST client (`chipotle-client.ts` — ~450 lines)
- One HTTP POST per operation — no WebSocket, no SIWE, no session management
- API key authentication (three-tier: shared Elacity key, user-provided key, future API product key)
- PKP-AES encryption inside a single TEE enclave
- Feature flag (`LIT_BACKEND=chipotle|datil`) for instant rollback

**Critical Discovery:** During migration, we discovered that Datil and Chipotle use fundamentally incompatible cryptographic schemes (threshold BLS vs PKP-AES). Assets encrypted with Datil cannot be decrypted by Chipotle. The solution: new assets use Chipotle, existing assets fall back to Datil. Each asset's metadata tracks which backend was used (`litBackend` field), and the server routes to the correct decryption path automatically.

**End-to-end verified:** PDF, image, and text files all tested through the complete flow — encrypt via Creator, buy on Market, decrypt and view in dDRM Viewer.

**Security hardening:** All API keys removed from source code. Keys now resolve exclusively from gitignored local files or environment variables. API keys were rotated after the migration.

### Why It Matters

Datil is being deprecated (~April 2026). Without this migration, all dDRM functionality would stop working. The new Chipotle integration is also significantly lighter — no SDK, no browser dependencies, no WebSocket connections — which makes it viable for server-side environments and future IoT/edge deployments. The three-tier API key model also sets up the infrastructure for a self-sovereign key system where large node operators can bring their own Lit keys.

---

## 3. WASM Security Runtime

### What It Is

When you view a protected asset, the decrypted content must never exist as a raw file in the browser — otherwise it could be trivially copied. The WASM Security Runtime solves this by performing all decryption and rendering inside WebAssembly sandboxes, outputting only rendered pixels.

### What Was Built (March 15–16)

**Rust WASM Renderer** (`crates/ddrm-renderer/`):
- Image rendering: JPEG/PNG decode and resize entirely in WASM linear memory
- Text rendering: Custom bitmap font renderer with word wrapping (a-z, A-Z, 0-9, punctuation)
- PDF rendering: WASM-native PDF rasterization via the hayro crate (replaced lopdf which crashed in WASM)
- All temporary buffers zeroed after use — no plaintext remnants in memory

**dDRM Viewer App:**
- Dedicated PC2 application for viewing protected content
- Two display modes: centered images, full-width scrollable documents
- Anti-piracy measures: right-click disabled, drag-and-drop disabled, no-cache headers
- Renderer badges showing "WASM Rendered" or "Server Rendered" status
- Keyboard shortcuts, zoom/pan, page navigation for PDFs
- Audio passthrough player for protected music files
- Opens as a native UIWindow via IPC — integrated with PC2's taskbar and window management

**`.ddrm.json` Capsule Format:**
- Descriptor files that wrap encrypted content with Lit parameters and MIME type
- Registered with PC2's file system: custom shield icon, MIME type `application/x-ddrm+json`
- Double-click opens dDRM Viewer — feels like opening any other file

**Security Model — No Raw Files in Browser:**
- Encrypted CID on IPFS → `.ddrm.json` capsule on local filesystem → double-click → dDRM Viewer → server-side Lit Action validates rights → server decrypts and renders to lossy JPEG/PNG → viewer displays pixels
- The old `/lit/decrypt` endpoint (which returned raw bytes) was removed and returns HTTP 410 Gone
- Inline decrypt, `saveDecryptedFile()`, and all plaintext download paths were eliminated

### Why It Matters

This is the anti-piracy layer that makes dDRM commercially viable. Without it, any content you decrypt can be trivially saved and redistributed. With WASM rendering, the actual file never exists outside of the encryption/decryption sandbox — viewers only see rendered pixels. This is comparable to how Netflix's Widevine works, but without requiring proprietary browser plugins or hardware DRM. It runs on any device that supports WebAssembly.

---

## 4. DASH/CENC Media Pipeline

### What It Is

For video and audio content, whole-file encryption isn't practical — a 2GB movie can't be fully decrypted before playback starts. DASH (Dynamic Adaptive Streaming over HTTP) with CENC (Common Encryption) encryption enables segment-by-segment streaming: the video is split into small chunks, each encrypted independently, and decrypted on-the-fly during playback.

### What Was Built (March 15–16)

**Rust CENC Decryption WASM Crate** (`crates/cenc-decrypt/`):
- Full fMP4 parser: moof, traf, trun, senc, tenc box parsing
- Per-sample AES-128-CTR decryption with 8-byte and 16-byte IV support
- DRM stripping: removes encryption signaling from init segments (encv→av01, enca→mp4a, strip sinf/pssh) and media segments (strip senc/saiz/saio, fix trun data offsets)
- Runs in WASM — the Content Encryption Key (CEK) stays in WASM linear memory, zeroed after use

**MSE-Based Media Player** (`pc2-media-runtime/player.js`):
- JavaScript-only DASH player using MediaSource Extensions — no EME, no CDM, no SharedArrayBuffer
- Adaptive bitrate switching: bandwidth measurement with harmonic mean, conservative quality selection, 8-second cooldown, gear icon UI
- Session management: 10-minute idle timeout, transparent re-authentication on 410 errors
- Seek recovery: maps time→segment, flushes MSE buffers, re-fetches from new position
- Audio-only support for music content
- YouTube-style keyboard shortcuts, click-to-play, buffering spinner

**Server-Side Media API** (`/api/media/*`):
- `POST /media/prepare-auth` — Initiates Lit authentication (SIWE for Datil, stub for Chipotle)
- `POST /media/init` — Fetches MPD manifest from IPFS, extracts PSSH, recovers CEK via Lit, creates playback session
- `POST /media/segment` — Fetches encrypted segment from IPFS, decrypts via WASM, strips DRM signaling, streams clear fMP4

**ECDH P-256 Envelope** — The CEK for media is never transmitted in the clear. Instead:
1. The server generates an ephemeral ECDH key pair
2. The Lit Action (inside the TEE) generates its own ephemeral key pair
3. Both sides derive a shared AES key via Diffie-Hellman
4. The CEK is wrapped in a binary envelope and only unwrappable by the requesting server

### Why It Matters

This makes PC2 the first personal cloud that can stream DRM-protected video without browser plugins, hardware modules, or cross-origin restrictions. The entire DRM stack runs server-side — the browser just receives clear fMP4 chunks via MSE. This works inside sandboxed iframes where traditional EME-based DRM (Widevine, FairPlay) cannot operate. It opens the door to decentralized Netflix/Spotify experiences where creators stream directly from their nodes.

---

## 5. Supernode Decentralization (Phase 2)

### What It Is

Supernodes are the backbone of the PC2 network — they provide WireGuard tunnels, relay IPFS content, and serve as discovery points for personal nodes. Phase 2 focused on making the supernode infrastructure resilient and easy to expand.

### What Was Built (March 8)

- **Gateway v2.0**: Dynamic supernode discovery with gossip protocol, register/heartbeat endpoints, deployed on Contabo infrastructure
- **One-Command Bootstrap**: `deploy/supernode-bootstrap.sh` — spin up a new supernode with a single command
- **Dynamic Discovery**: Nodes query multiple supernodes in parallel, persist results to disk, fail over automatically
- **Relay Mode**: PC2 nodes can toggle relay mode in Settings, enabling IPFS circuit relay and DHT server for the network
- **Supernode Manager dApp**: Built-in app for monitoring supernode health, services, and network status
- **Community Networking Fix**: `scripts/fix-networking.sh` — diagnostic and repair script for common connectivity issues
- **Multi-Supernode Failover**: WireGuard, AmneziaWG, and VLESS services now try multiple supernodes before giving up

### Why It Matters

A decentralized network needs decentralized infrastructure. Phase 2 means anyone can run a supernode, the network discovers them automatically, and if one goes down, traffic routes around it. This is the foundation for the upcoming incentivized supernode economics (staking, rewards, SLA guarantees).

---

## 6. Network Map & Community Tools

### What Was Built (March 8–13)

**3D Network Visualization** (map.ela.city):
- Interactive 3D "World Computer" orb alongside the 2D network topology graph
- Animated particle flow on all active links: gold for backbone, green for PC2 nodes, cyan for peer-to-peer
- Core vs carrier supernode distinction with visual hierarchy (pulsing double rings vs single rings)
- Breathing glow effects, offline/sleeping state visualization
- Full SEO overhaul: JSON-LD schemas, OpenGraph/Twitter cards, sitemap, Google Analytics

**`@elacity-js/access` SDK:**
- Universal access layer extracted from the media player into a standalone package
- 47 unit tests covering conditions, payload parsing, events, crypto roundtrip, IPFS fetch
- Browser and Node.js entry points (server-side decryption for AI models, datasets, agent commerce)
- Clean-room implementation with no singletons — capsule-ready architecture

**Weekly Shipping Report:**
- Comprehensive report covering all 3 repos (pc2.net, elacitylabs.com, portal.ela.city) — posted to GitHub Discussions #6

---

## 7. Infrastructure & Quality

### Binary Manager (March 8)
- Runtime auto-download of transport binaries (WireGuard, AmneziaWG, sing-box) — no pre-install required
- Cross-platform fetch script for all supported architectures
- Graceful fallback when binaries unavailable

### App Manifest Spec (March 8)
- Formal `app.json` schema with universal asset metadata
- Enhanced validation: semver checks, length limits, type constraints
- Foundation for the upcoming capsule marketplace

### ARM/Jetson Fix (March 8)
- Fixed wireguard-go build on Ubuntu 20.04/Jetson: Go 1.13 was too old, now downloads Go 1.22 directly
- Eliminated "keeps initializing" issue for ARM users accessing remote domains

### WASM Crypto Hardening (March 16)
- Phase A: AES-GCM decrypt-only in WASM (CEK never in Node.js heap)
- Phase B: Combined fMP4 strip+decrypt in a single WASM call
- Phase C: WASM module caching to prevent recompilation per request
- 50MB threshold: WASM for small files, Node.js fallback for large ones

---

## Timeline View

| Date | Branch | Key Achievement |
|------|--------|-----------------|
| Mar 8 | elacity-ddrm-marketplace | Supernode Phase 2, Gateway v2.0, binary manager, ARM fix |
| Mar 8 | elacity-ddrm-marketplace | Network map visual upgrade, 3D orb, particle animations |
| Mar 13 | elacity-ddrm-marketplace | `@elacity-js/access` SDK, universal access spec, 3D orb SEO |
| Mar 13 | elacity-ddrm-marketplace | On-chain minting verified, channel creation, full Creator pipeline |
| Mar 14 | dDRM-extended | Weekly shipping report, Elacity IPFS pipeline, metadata fixes |
| Mar 14 | dDRM-extended | Server-side Lit decrypt, inline image rendering, capacity credits |
| Mar 15 | dDRM-extended | dDRM Viewer app, .ddrm.json capsules, WASM text renderer |
| Mar 15 | dDRM-extended | Security hardening: removed all plaintext download paths |
| Mar 15 | dDRM-extended | Secure viewer pipeline, PDF rendering, thumbnail picker |
| Mar 16 | ddrm-universal-access-layer | PC2 Media Runtime (DASH/CENC), Rust WASM cenc-decrypt |
| Mar 16 | ddrm-universal-access-layer | .edrm double-click playback, Lit standalone auth |
| Mar 16 | ddrm-universal-access-layer | Media player hardening: ABR, seek, session expiry |
| Mar 16 | ddrm-universal-access-layer | WASM renderer: hayro PDF, text fixes, Mint context menu |
| Mar 16 | wasm-crypto-hardening | WASM crypto Phases A-C, AES-GCM in WASM, fMP4 strip |
| Mar 16 | wasm-crypto-hardening | dDRM network vision roadmap |
| Mar 17 | lit-chipotle-migration | Chipotle REST client, feature flag, dual-mode |
| Mar 17 | lit-chipotle-migration | Chipotle E2E verified, key rotation, security audit |
| Mar 17 | lit-chipotle-migration | Developer handover document, media pipeline planning |

---

## What's Next

1. **Video/Audio Chipotle** — Create a Chipotle-compatible media Lit Action for DASH/CENC streaming, and bring the encoder pipeline into the PC2 node so users can upload and stream video directly
2. **Peer-to-Peer Markets** — Node-to-node asset trading without centralized marketplace infrastructure
3. **AI Model Marketplace** — Tokenized AI models as the first non-media asset class
4. **Datil Deprecation** — Complete transition before April 2026 deadline
5. **Production Deployment** — Switch from Lit dev API to production, merge feature branches to main

---

## Technical Stats

- **Active branches:** 5 (lit-chipotle-migration, wasm-crypto-hardening, ddrm-universal-access-layer, dDRM-extended, elacity-ddrm-marketplace)
- **Total commits (10 days):** 41
- **New Rust crates:** 2 (ddrm-renderer, cenc-decrypt)
- **New packages:** 1 (@elacity-js/access with 47 tests)
- **New dApps/apps:** 4 (Creator Dashboard, dDRM Viewer, Media Runtime, Supernode Manager)
- **On-chain contracts used:** 4 (AuthorityGateway, CoreStorage, ChannelCore, Operative)
- **Chain:** Base (8453) with USDC payments
- **Lit Protocol:** Migrated from Datil v7.3.0 SDK to Chipotle REST API

---

*Report generated March 17, 2026. For technical details, see the [Chipotle Handover](CHIPOTLE_HANDOVER.md) and [Session Handover](SESSION_HANDOVER.md) documents.*
