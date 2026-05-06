# Elacity Labs — Weekly Team Update for the World Computer Initiative (WCI)
## April 26 – May 6, 2026

> **ElastOS v1.2 landed — the convergence release across PC2, Elastos Runtime, and Elacity dDRM, shipped Friday May 1 from a Vegas hotel room mid-Bitcoin Week** | **Public launch May 1: dApp Centre with real apps, Elacity V3 contracts on Base, rebuilt dDRM path with session-key delegation, two Rust media engines, email login, jhond0e audit closed (7/7 external findings + 20/21 internal + 79 security tests), Elastos Runtime 0.2.0 as a Rust-based zero-permissions-by-default authority layer** | **Elastos Runtime 0.2.0 published & merged to main — Home as the front door, first-party capsules (System, Documents, Library, Inbox, Chat Room, GBA, uCity), passkey-first auth, blockchain quadrant foundations, wallet approval safety** | **Elacity dDRM — ELACITY-2221 metadata alignment fully landed, Protection V3 schema + unified `cenc:lit-aes-gcm-v3` system, ELACITY-2219 Lit Chipotle keystore integration to 85% by May 6, ELACITY-2222 V3 smart contracts on the frontend** | **Three feature branches with active saves carrying forward** (`feature/lit-chipotle-migration`, `feature/metadata-alignment`, `release/v1.2-pre-release`) | **Six-day post-launch follow-up cycle: 13 community-feedback releases (v1.2.1 → v1.2.7.13) closing every reported issue in hours** | **Stealth-mode bring-up complete on fresh MacBooks** (vanilla WireGuard, AmneziaWG, VLESS Reality all working) | **Runtime Heartbeat Protocol** for launcher↔pc2-node sync that survives respawns, in-app updates, external `pm2 restart`, and crashes | **Four Apple-signed + notarised Launcher releases (v1.2.4 → v1.2.7)** | **PC2 transport binaries v1 — new release pipeline, 22 SHA-256-verified, Apple-notarised assets** | **Supernode preflight (Kubo 0.34.1 → 0.41.0 on both supernodes, mesh fully restored, libp2p memory cap deployed)** | **Wave 8 Chipotle hardening — final three audit findings closed (C-02, M-01, H-01.2)** | **CEO road trip Vol. 2: 11 days, 17 events, 9 industries, $0 in tickets — Bitcoin Week final days in Vegas + Miami Bitcoin & RWA Week, with the rights-as-productive-yield framing crystallising at the Digital Asset Yield Summit** | **88 PC2 commits on `main`, 36,199 insertions, 4,163 deletions, 370 files**

### Key Links This Week

- **Public launch announcement** — [ElastOS v1.2 is here: dApp store is live, dDRM markets, plus Elastos Runtime 0.20](https://blog.elastos.net) (Elastos blog, May 1)
- **Latest PC2 release** — [Elacity/pc2.net v1.2.7.13](https://github.com/Elacity/pc2.net/releases/tag/v1.2.7.13)
- **PC2 v1.2.0 milestone tag** — [Elacity/pc2.net v1.2.0](https://github.com/Elacity/pc2.net/releases/tag/v1.2.0)
- **Elastos Runtime 0.2.0** — [Elacity/elastos-runtime tree/review/0.2.0](https://github.com/Elacity/elastos-runtime/tree/review/0.2.0) — running live at [elastos.elacitylabs.com/apps/home/](https://elastos.elacitylabs.com/apps/home/)
- **Latest Launcher release** — [Elacity/elastos-launcher v1.2.7](https://github.com/Elacity/elastos-launcher/releases/tag/v1.2.7) (Apple signed + notarised, all 3 platforms)
- **PC2 transport binaries (v1)** — [Elacity/pc2.net pc2-binaries-v1](https://github.com/Elacity/pc2.net/releases/tag/pc2-binaries-v1) (22 assets, 10 darwin natives notarised)
- **PC2 install (one-liner)** — `bash <(curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/update.sh)`
- **ElastOS Runtime install** — `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash`
- **Network Map** — [map.ela.city](https://map.ela.city) | **Portal** — [portal.ela.city](https://portal.ela.city)

---

## Table of Contents

1. [The Big Picture — Three Workstreams Converging on One Release](#the-big-picture--three-workstreams-converging-on-one-release)
2. [ElastOS v1.2.0 — The Convergence Release](#elastos-v120--the-convergence-release)
3. [Elastos Runtime 0.2.0 — The Authority Layer Comes Online](#elastos-runtime-020--the-authority-layer-comes-online)
4. [Elacity dDRM — Metadata Alignment + Chipotle Integration](#elacity-ddrm--metadata-alignment--chipotle-integration)
5. [Branch Work — Feature Saves Carrying Forward](#branch-work--feature-saves-carrying-forward)
6. [The Six-Day Post-Launch Follow-Up Cycle](#the-six-day-post-launch-follow-up-cycle)
7. [v1.2.7 — Three Convergent Workstreams (SQLite, Cluster Pin, RPC)](#v127--three-convergent-workstreams-sqlite-cluster-pin-rpc)
8. [v1.2.7.7 — Channel Management + On-Chain Plans + Name-Sync](#v1277--channel-management--on-chain-plans--name-sync)
9. [The Stealth-Mode Sprint — v1.2.7.8 → v1.2.7.12](#the-stealth-mode-sprint--v1278--v12712)
10. [v1.2.7.13 — Runtime Heartbeat Protocol](#v12713--runtime-heartbeat-protocol-launcherpc2-node-sync)
11. [ElastOS Launcher — Four Apple-Signed Releases](#elastos-launcher--four-apple-signed-releases-v124--v127)
12. [PC2 Transport Binaries (v1) — New Release Pipeline](#pc2-transport-binaries-v1--new-release-pipeline)
13. [Supernode Preflight — Kubo 0.41.0 + Mesh Restoration](#supernode-preflight--kubo-0410--mesh-restoration)
14. [Wave 8 Chipotle Hardening — Final Three Findings](#wave-8-chipotle-hardening--final-three-findings)
15. [Elacity on the Road — Vol. 2: Bitcoin Week + Miami](#elacity-on-the-road--vol-2-bitcoin-week-final-days--miami-week-one)
16. [Looking Ahead — v1.2.8.0 + Beyond](#looking-ahead--v1280--beyond)
17. [Summary Statistics](#summary-statistics)

---

## The Big Picture — Three Workstreams Converging on One Release

This was the week **ElastOS v1.2 became real** — three Elacity workstreams converging on the same moment:

1. **PC2 `v1.2.0` shipped** — 268 commits + 1,251 files of work on top of v1.1.0, the headline tag of the entire post-V1.1 cycle, consolidating four months of dDRM hardening, capsule packaging, supernode operations, dApp Centre cleanup, and a closed external security audit.

2. **Elastos Runtime 0.2.0 was published and merged to main** (`Elacity/elastos-runtime/tree/review/0.2.0`) and went live at [elastos.elacitylabs.com](https://elastos.elacitylabs.com). Runtime 0.2.0 is the **first release where the product feels like a usable personal operating environment** — Home is the front door, capsules show up as proper apps (System, Documents, Library, Inbox, Chat Room, GBA, uCity), passkey-first authentication is in, and the security model fails closed by default (apps start with zero permissions until granted a capability token).

3. **The Elacity dDRM workstream landed its metadata-alignment milestone** — Protection V3 schema, the unified `cenc:lit-aes-gcm-v3` protection type across creator + player, directory-based IPFS storage for creator assets, ChannelCreated handler refinements, and the Lit Chipotle keystore-service integration that's now at 85% (ELACITY-2219), with V3 smart-contract frontend integration at 100% (ELACITY-2222) and metadata alignment at 100% (ELACITY-2221).

The public launch went live on **May 1** via the Elastos blog: *"ElastOS v1.2 is here: dApp store is live, dDRM markets, plus Elastos Runtime 0.20"* — calling out that this is the biggest user-facing release since the World Computer launch, **not because of feature count, but because the main pieces start to feel usable together**: the desktop, the app store, dDRM, identity, payments, and runtime permissions all connecting in a way normal users can actually try.

The **six days that followed launch were a positive feedback-driven follow-up cycle**: thirteen point releases (v1.2.1 → v1.2.7.13), each one closing real items reported by real community members during real fresh installs. **The Slack-to-tag latency stayed in hours, not weeks**, which is exactly the cadence open-source-style stewardship is supposed to look like. By the end of the period:

- **The full transport stack works on a fresh MacBook out of the box** — vanilla WireGuard, AmneziaWG (stealth obfuscation), and VLESS Reality (TLS-in-the-clear) all bring up cleanly, no Homebrew required, no Xcode CLT prompt, no manual sudoers fiddling
- **The PC2 install dropped its biggest first-run blocker** — migrated from `better-sqlite3` to `@photostructure/sqlite`, which ships per-platform Node-API prebuilds and works without a C++ compiler
- **Every fresh community node now contributes to global durability automatically** — IPFS Cluster pinning install-and-works on first launch, no operator action needed
- **Channel management went on-chain** via the V3 `SubscriptionModule` — bulk plan updates, token-gating with decimals, IPFS-pinned plan metadata
- **The launcher↔pc2-node status indicator survives every kind of restart** — new `pc2.heartbeat.v1` protocol, schema-versioned, contract-documented, backward compatible
- **Both supernodes were upgraded to Kubo 0.41.0** with full mesh restoration and a libp2p memory cap to contain a known upstream leak

Everything below is the detailed breakdown of how those eleven days came together.

---

## ElastOS v1.2.0 — The Convergence Release

> _Tagged April 30 (commit `04b44e939`), publicly announced May 1 via the Elastos blog. 268 commits / 1,251 files of work on top of v1.1.0. The release where the desktop, the app store, dDRM, identity, payments, and runtime permissions start to connect in a way normal users can actually try._

### 1. The dApp Centre with real installable apps

In v1.1, the dApp Centre was still placeholder-heavy. In v1.2, **users can open it, install apps, and actually use them**.

- **Elacity NFT** — the first installable third-party app. A marketplace for browsing, trading, and collecting NFTs connected to the Elastos ecosystem, running as part of the personal cloud where content + identity + payments + access control are all in the same user-owned environment.
- **Glide Finance** — Elastos Smart Chain's only DEX, available through the dApp Centre with token swaps, liquidity, farming, staking, analytics, and governance access. A wallet bridge handles connection; the RPC fallback path keeps the app responsive when one provider has issues.
- **Signed, content-addressed capsules** — apps are packaged as capsules. Each capsule is signed, content-addressed, and verified before launch. PC2 fetches the app from IPFS, verifies the signature and hash, then runs it in a sandbox. **You're installing signed software into your own cloud, not opening a random web page.**
- **Old placeholder catalogue cleaned up** — the dApp Centre now focuses on real apps: bundled Elacity capsules + the two installable third-party apps. Stale local app entries removed after update; missing icons fall back gracefully.
- **`pinRemoteCID` cold-fetch path for app bundles** — first install of any app pulls the bundle from a fan-out of IPFS sources (Elacity supernode + DHT + Pinata + Helia bootstrap peers) instead of relying on a single gateway

### 2. Elacity V3 contracts on Base + omnichain support

v1.2 brings Elacity's V3 marketplace and access-control contracts into ElastOS — a real monetisation path for creators inside the product, with Base as the first omnichain route for USDC markets.

- **One-question access check** — instead of each content type following a separate code path, access now reduces to one core check: *does this wallet have access to this content ID?* That check runs through the V3 contract path and Lit Protocol.
- **Royalty splitting at mint time** — creator and protocol shares handled directly through the contract flow instead of by creators manually
- **Free and paid mints follow the same content identity model** — cleaner for creators, easier to maintain across content types
- **Per-channel `SubscriptionModule` (V3)** with `bulkUpdatePlans`, `configureTokenOwnershipAccess`, `subscribePlan` — see [§8](#v1277--channel-management--on-chain-plans--name-sync) for the v1.2.7.7 follow-up that wired this fully into Creator + Market

### 3. The rebuilt dDRM open path

The most important security change in v1.2. The previous Lit Action flow depended too much on a client-supplied user address — a Lit Action is public on IPFS, so any client could fabricate the address field and request a key for any asset. **v1.2 closes that path.**

The new flow uses **session-key delegation**:

- At wallet-connect, the wallet signs a delegation that allows a device-bound key to open dDRM content for a limited session (configurable, default 24h)
- The user opens content silently for the rest of the session — **wallet-prompts-per-day dropped from many to one**
- The session is still tied to the wallet, the device, and the signed delegation
- The Lit Action (running inside the Lit Network's TEE) now checks: the delegation, the request signature, the action binding (`request.actionIpfsId === Lit.Actions.currentActionIpfsId` — closes the original P0 sigauth bug), freshness, replay protection, expiry, and the V3 access check, **before** returning a content key
- **No fallback to the old path** — older clients get a clear `[401 session_bundle_required]` and must upgrade

### 4. Two new Rust media engines

Protected content is no longer treated as only video. Creators can publish many file types, and users can open them through the same dDRM model.

- **Elacity Player** — handles video and audio playback. Supports the DASH and CENC path used by protected media, including AV1 video and audio playback. **Avoids depending on browser DRM modules** and keeps the playback path more controlled inside the Elacity stack. Pipelined parallel segment prefetch for measurably smoother playback. Fixed audio-only DASH stalling at ~0:39 by switching to `'sequence'` mode for AAC-only `SourceBuffer`.
- **Elacity Viewer** (also called the **dDRM Viewer**) — handles non-streaming content. Supports **PDFs, Images, 3D models, CSV datasets, Fonts, Archives, EPUB ebooks, CBZ comics**. PDFs support watermarking, page navigation, and zoom. EPUBs support a protected reader path with forensic watermarking. Comics and other visual formats route cleanly through the viewer.

### 5. Email Login (Particle Auth) — login is no longer wallet-only

Wallet login still works, and remains the best path for crypto-native users. v1.2 removes a major barrier for everyone else.

- **Email** + **MetaMask** + **WalletConnect** — three sign-in modes, all working
- Email login uses **Particle Auth**; the user still gets a wallet address and can also use a smart account for flows like batch mints, sponsored gas, and creator channel setup
- **A big change for creators, buyers, and people who want to use a personal cloud without dealing with seed phrases on day one**
- (Operator note: a community advisory was published with v1.2 — *"Please avoid minting or buying with Particle Smart Wallets for now"* — Particle is upgrading its smart-wallet system, current-flow assets may end up in an older account path. After Particle's upgrade lands, ElastOS will support universal USDC payments, with users buying from supported chains while Base works mostly in the background.)

### 6. Local-first IPFS + download-first buy flow + pipelined player

A concentrated push on the storage and playback layer that turns "best-effort pinning" into "actually durable" and "request-per-segment playback" into "pipelined parallel prefetch."

- **Local-first IPFS uploads** — Creator now stores files on the local Helia node first and returns the CID immediately, then replicates to the Elacity public IPFS node in the background. **Eliminates the 60-second hangs that occurred when Elacity's upstream Kubo wedged.**
- **Download-first buy flow + launch gate** — `.ddrm` capsules are fully fetched and verified before the launch gate opens. **You never start playing a partial file.**
- **Real-bytes download progress bar** with honest cumulative DAG sizing — no more "stuck at 99%" surprises, no more "1 KB" lies on `.ddrm` files because some entries reported `size_known: 0`
- **Pipelined parallel segment prefetch** in `pc2-media-runtime` — N=3 concurrent fetches in flight, latency bounded by the slowest segment fetch in the window, not the sum
- **Pin-forward retry queue + reconcile script** (`pc2-node/scripts/reconcile-pins.ts`) — failed pin-forward calls land in a retry table, retried with exponential backoff, surfaced via the per-CID pin status endpoint
- **Free-bytes quota** — pin call fails fast with a clear error if the user has < 1 GB free, preventing a runaway seeder from filling user disks
- **Reset DL button** — user can cancel a stuck download cleanly without leaving zombie pin attempts in the queue

### 7. IPFS / networking foundation

A series of commits on the `feature/lit-chipotle-migration` branch tightened up IPFS connectivity for the v1.2 playback path:

- **Explicit peering with `ipfs.ela.city`** + **auto-reconnect every 60s** — root-cause fix for v1.1 playback intermittency surfaced during internal testing
- **Relay-first NAT connectivity** so nodes behind home routers stay reachable
- **DHT announcement durability** so newly stored CIDs are findable from anywhere within seconds (the recursive announce-on-add pattern)
- **Supernode pin-mirror fan-out** (client-side, config-gated, off by default) — every fresh community node optionally fans out its pins to the supernode mesh
- **Hybrid Helia + Kubo bootstrap peers** for cold-fetching app bundles
- **Standalone IPFS node dev-mode** — a developer can run an isolated IPFS node for testing without polluting their production data dir
- **Refined IPFS node setup to lookup elacity node** as part of bootstrap

### 8. Wallet / RPC discipline

- **Wallet bridge forces legacy (type-0) transactions for ESC (chain 20)** — fixes the `rlp: expected input list for types.txdata` error on Glide Finance swaps caused by MetaMask auto-converting to EIP-1559. **The kind of subtle production bug only a real Glide user catches.**
- **RPC proxy with prioritised LlamaRPC + Ankr/BlockPI fall-over** when a primary upstream is rate-limited
- **Cached `eth_call` reads** — fixes the intermittent price-display bug in Market caused by AuthorityGateway calls competing for rate-limit budget
- **JSON-wrapped rate-limit errors handled** — providers that return `{ error: { ... } }` instead of HTTP 429 now correctly trigger fall-over
- **`SUPERNODE_RPC_URLS` opt-in** documented in `pc2-node/.env.example` — prepends an Alchemy URL (or your own) to the shared pool so it's tried first

### 9. dApp Centre + Start Menu UX polish

Real branded icons replace the old SVG placeholders for **Elastos DAO**, **Elacity Creator**, **AI Chat**, **Player**, **Viewer**, and **dApp Centre**. Plus:

- **Dark mode** for the Elastos DAO dashboard and dApp Centre cards
- **Channel banner fallback** using the wallpaper robot art when a creator hasn't set one
- **Start Menu reorder** — most-used apps first; dApp Centre placed directly after Elastos DAO
- **"Free" badge** on Market cards for items minted with `opType === 0` so price status is always visible without clicking through
- **Uninstall button hidden for system apps** — only user-installed apps can be removed; explicit `isSystem` classification per app
- **Creator draft-resume** correctly marks Lit / IPFS pipeline steps as "Done (from saved draft)" instead of getting stuck on "Waiting…"

### 10. Security audit closed before release

v1.2 closes the latest PC2 and gateway security audit. Community researcher **jhond0e** submitted a serious audit on April 18; v1.2 closes **all 7 in-scope external findings + 20 of 21 internal findings**. The work included:

- Removing risky mock-token and wallet-inference code paths
- Locking update routes behind owner checks
- Adding rate limits to sensitive update routes
- SIWE + SIWS based login checks
- One-time first-run token on setup routes
- Tightening proxy handling to avoid IP spoofing from LAN attackers
- Replacing shell-based gateway commands with safer argument-based calls
- Requiring provisioning tokens for mutating gateway routes
- Adding secret scanning on commits, pull requests, and long-lived branches
- Wave 8 metadata-envelope alignment on the Lit / Chipotle migration (see [§14](#wave-8-chipotle-hardening--final-three-findings))
- Lit Action whitespace normalisation so allowlist matches always succeed
- Cached delegations purged when owner ≠ current session

The v1.2 branch ships **79 passing security test cases across 5 specs**.

### 11. Smaller fixes that users will feel

- Audio-only DASH playback no longer stalls around the 39-second mark
- The dApp Centre catalogue has been cleaned up
- Stale local app entries are removed after update
- Missing icons fall back more gracefully
- The network path for app capsules is more reliable
- DHT announcements are now properly awaited
- PC2 nodes behind common home networks can receive content through relay paths more reliably
- Bug-A through Bug-H polish set (full detail in [§8](#v1277--channel-management--on-chain-plans--name-sync))

### Companion April-30 commits that landed alongside the v1.2.0 tag

| Commit | What |
|---|---|
| `04b44e939` | `chore(release): bump version to 1.2.0` |
| `918cc8910` | `feat(app-center): real branded Elastos icon for dApp Centre` |
| `5c93ebddd` | `fix(ux): Creator draft-resume progress + Market "Free" badge` |
| `039c475dc` | `fix(storage): local-first Elacity IPFS uploads + fire-and-forget replication` |
| `72b77a239` | `fix(wallet-bridge): force legacy tx type for ESC (chain 20) to avoid RLP errors` |
| `c6e50c1eb` | `less verbosity on the ipfs service` |
| `8e7382216` | `feat(ux): channel banner fallback + Start Menu reorder + dApp Centre polish (DAPP-UX-POLISH-V12)` |
| `4db74cd96` | `feat(dao-dashboard): add dark mode with theme toggle + dark hover overrides` |
| `29c4a5bc6` | `feat(apps): real branded icons for AI Chat, Elastos DAO, Elacity Creator + Player/Viewer parity` |

---

## Elastos Runtime 0.2.0 — The Authority Layer Comes Online

> _Published and merged to main on the `review/0.2.0` branch of `Elacity/elastos-runtime`. Running live at [elastos.elacitylabs.com/apps/home/](https://elastos.elacitylabs.com/apps/home/). 0.2.0 is the **first release where the product starts to feel like a usable personal operating environment**, not just runtime plumbing._

### The biggest user-facing change: Home is now the front door

Instead of PC2/shell terminology, users now enter through `elastos`, which opens **ElastOS Home** — a desktop-like surface with apps, windows, launcher, taskbar, inbox, mobile/PWA support, wallpaper settings, and cleaner capsule navigation.

- **Home is the front door** — open ElastOS, see a desktop with apps, instead of separate technical surfaces
- **Apps are clearer** — first-party capsules now show up as proper user-facing apps
- **PWA-compatible "ElastOS Home"** on mobile, with fullscreen support, touch icon behaviour, and better maximised windows

### First-party capsules in 0.2.0

| Capsule | What it does |
|---|---|
| **System** | Identity, runtime state, appearance settings (wallpaper, overlay controls) — replaces the old manager-style UI |
| **Documents** | Create / edit / save / publish / unpublish / delete / open `elastos://<cid>` document links through the right viewer |
| **Library** | Browse and open published documents and typed content without exposing raw file paths as the main UX |
| **Inbox** | Requests and approvals (e.g. wallet signing requests) handled in a dedicated cleaner Inbox capsule instead of being scattered through Home |
| **Chat Room** | Browser guests can pair into a room, approved guests stay separate from the Home user identity, and room owners can kick guests or manage runtime members |
| **GBA Emulator** | Persistent save states, clearer controls, better mobile touch controls, fullscreen ratio fixes, cleaner UI |
| **uCity** | (Bundled with GBA-class capsule infrastructure) |

### The security model — apps start with zero permissions

- **Ordinary apps and capsules are blocked from raw runtime, IPFS, wallet, node, and backend access paths.** They cannot reach the underlying infrastructure directly.
- **Capsules use the runtime/Carrier capability plane** instead of direct host routes or privileged APIs
- **First real content-availability layer** — publishing routes through `elastos://content/*`, with **signed availability receipts** and **object manifests** instead of raw IPFS usage
- **Groundwork for SmartWeb content objects** — published documents, shares, sites, releases, and protected-content descriptors all share a common object-manifest direction

### Passkey-first authentication

- **Home unlocks through passkeys**, issues scoped sessions, refreshes sessions safely, and rejects replay / expired / wrong-origin attempts
- Each passkey gets its own principal/root, and **guest access is now self-registration from Home when admin enables it** (May 6 update)
- **Hardened admin/guest rules** — guests cannot remove admin passkeys, and System only controls access policy
- Sign-out is explicit

### Blockchain quadrant foundations

- **Chain-provider read access** — apps read chain state through the provider plane, not raw RPC
- **Wallet-provider** — wallet authority lives behind the runtime, apps don't see private keys or wallet RPC
- **Wallet proof challenges** + **EVM wallet login** + **MetaMask proof linking**
- **Scoped Home/System grants** — even Home and System get just the grants they need, no more
- **Wallet approval safety** — wallet signing requests now become **pending approvals** in Inbox instead of exposing raw signing or wallet RPC. The user inspects each request before it's signed.
- **System wallet approval review/reject** — pending wallet requests can be inspected and rejected from System without apps gaining wallet authority

### Protected-content foundations (in 0.2.0, expanding through May 6)

- **DRM, rights, key, and decrypt provider contracts now fail closed** — no permissive default
- **PQ-ready algorithm metadata** — protected-content descriptors carry post-quantum-ready algorithm identifiers from the start, so the protected-content layer doesn't need a breaking migration when PQ schemes roll out

### Runtime 0.20 bundled capabilities (from the public launch post)

- **Signed, content-addressed capsules** — if the package changes, the signature check fails. If the publisher is not trusted, it should not run.
- **One permission model across execution types** — Native binaries, WASM sandboxes, MicroVMs. **The app does not need to care which one it runs on. It only sees the permissions it has been granted.**
- **Real desktop shell** — window management, taskbar, search, system tray, Elastos Manager control panel
- **Hosted rooms in two ways** — users connect through their own PC2 nodes over Carrier, or one node hosts a public gateway page where outside users request access and the owner approves them
- **Bundled GBA emulator** with persistent save state and capsule-aware file routing — open a `.gba` and it goes to the emulator, open a markdown file and it goes to the viewer, open a video and it goes to the media player

### What's coming next on Runtime (May 6 focus)

- **Principal-root encryption** — user and guest data private by design, not just separated by UI/session policy
- **User-friendly Recovery Kit** — backup, restore, and migration to another ElastOS runtime
- Continue removing shared `Users/self` assumptions in favour of principal-owned roots
- Keep wallet/node/blockchain work behind runtime capability envelopes, with no raw RPC or private-key access for apps
- Keep the branch reviewable: small slices, tests first, entropy/alignment checks after every change

### Runtime executive summary (May 6)

> _The Runtime is becoming a real trust layer. Home is the front door, System is the policy surface, Runtime owns authority, and apps/capsules stay isolated behind capability-controlled provider calls. The next major step is encrypted, recoverable, migratable user roots so public guest accounts can be safe even from the runtime operator/admin._

### Today's status

- ✅ Linux x86_64 and aarch64 supported
- 🛠️ macOS and Windows host adapters planned
- ✅ Live at [elastos.elacitylabs.com/apps/home/](https://elastos.elacitylabs.com/apps/home/) running 0.2.0
- ✅ Install: `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash` then `elastos setup` then `elastos`

---

## Elacity dDRM — Metadata Alignment + Chipotle Integration

> _Three Jira streams (`ELACITY-2221`, `ELACITY-2219`, `ELACITY-2222`) all advanced significantly during this window. The metadata-alignment workstream landed in full; the Chipotle integration is at 85%; the V3 frontend integration is in production._

### ELACITY-2221 — Metadata alignment (✅ landed)

The cross-stack workstream that unified how channel, operative, and media metadata is produced, signed, and consumed. **Full landing pad**: backend (`elacity-backend`), frontend (Creator + Market), and PC2 indexer all aligned on the same schema. The work spans `feature/metadata-alignment` and merged forward into `feature/lit-chipotle-migration`.

Concrete saves on the branches:

| Commit | What |
|---|---|
| `5e7707d4a` | `feat: prepare for metadata alignment` (the staging commit) |
| `14e151a35` | `refactor: update content metadata structures and migrate to directory-based IPFS storage for creator assets` |
| `6b528a8d3` | `feat: implement robust asset protection normalization and lookup helpers across API and app logic` |
| `3254540b2` | `refactor: update metadata envelope to support flexible media protection schemas and multi-protection structures` |
| `5dc9fc245` | `feat: implement Protection V3 metadata schema and add migration documentation` |
| `deeef3154` | `feat: migrate to unified cenc:lit-aes-gcm-v3 protection type and update system ID` |
| `1f693ebbf` | `feat: prioritize lit-aes-gcm-v3 and reorder legacy DRM system priorities in PlayerProvider` |
| `7a468c751` | `fix: adjusted metadata production to the standard` |
| `149fc06d6` | `fix: restore buildMetadataEnvelope function` |
| `3ee7bead2` | `refactor: move encryption and integrity fields into protection metadata schema` |
| `5b1141151` | `fix(indexer): support UnixFS-directory metadata CIDs from newer Creator` |
| `bf0205fb7` | `fix(apps): mark pc2-media-runtime as system role so player iframe resolves` |
| `78d9553d2` | `fix(lit): normalize Lit Action code whitespace to match Chipotle allowlist` |
| `f8afe02f9` | `fix: announce new CIDs recursively` |

### Protection V3 schema — what changed

- **Unified `cenc:lit-aes-gcm-v3` protection type** — single canonical system ID for all dDRM-protected content, regardless of whether it's video / audio / PDF / image / 3D / EPUB / CBZ
- **Multi-protection structures** — the metadata envelope now supports flexible media protection schemas, so a single asset can carry multiple protection layers (e.g., session-key delegation + V3 access check + watermark instructions)
- **Encryption + integrity fields moved into protection metadata schema** — separation of concerns; the asset's content metadata is independent of how it's protected
- **Asset protection normalization + lookup helpers** in API + app logic — fewer code paths reading the envelope, fewer places for drift
- **Legacy DRM system priorities reordered** — `lit-aes-gcm-v3` is now the first system the PlayerProvider tries; older systems remain available for backward compat but are de-prioritised

### Directory-based IPFS storage for creator assets

The shift from "single CID per asset" to "UnixFS-directory CID per asset" — a directory-style layout that holds the asset bytes + metadata envelope + protection descriptors + accompanying media + thumbnails together. The PC2 indexer was updated (`5b1141151`) to support these UnixFS-directory metadata CIDs from the newer Creator, so V3 assets show up correctly in Market.

### Backend cleanup (sync stability)

- **Disabled all trackers across the GraphQL backend, relying more on events-watcher** — fewer drift sources, single canonical state derivation from on-chain events
- **Refined ChannelCreated handler** ([ELACITY-2219]) — clean propagation from on-chain mint to backend index
- **Reviewed and fixed sync process: stale/crash on asset mint (ItemListed) and missing nftitems mapping** ([ELACITY-2221])
- **Fixed IPFS/storage API implementation** ([ELACITY-2221])

### V2 → V3 ownership / fee-recipient migration

A foundational on-chain action: **ownership and fee recipient moved from the `elacity` user to a new dedicated user (V2 on ESC and the NFTs marketplace)**. This is what made V3 contracts a clean owner-aligned starting point.

### ELACITY-2219 — Lit Chipotle keystore-service integration (85% by May 6)

The big architectural workstream — integrating Lit Chipotle directly into the keystore service, so the player-side dDRM open path can call Chipotle through the keystore boundary instead of through ad-hoc Lit Action calls.

Status as of **April 29**:
- Achieved 70% progress on backend architecture review focusing on Chipotle integration
- **Started integration of Lit Chipotle in keystore service**
- Began work on Chipotle read capability in player side

Status as of **May 6**:
- Achieved **85%** progress on backend architecture review
- ✅ **Completed integration of Lit Chipotle in keystore service**
- Today's focus: enable ability to read from Chipotle in player side, especially for video minted from PC2; enable ability to read other content types; explore IPFS solution for more resilient setup

### ELACITY-2222 — V3 smart contracts on the frontend (✅ implemented)

Frontend integration of the V3 contract suite:

- **Channel `SubscriptionModule`** — `bulkUpdatePlans`, `configureTokenOwnershipAccess`, `subscribePlan`
- **Plan metadata pinned to IPFS** — `planURI` passed in encoded args
- **Read plans directly from on-chain contract** (`getNumberOfPlans` + `getPlan`) and overlay backend-side label/description metadata
- **Legacy off-chain plan IDs guarded** — Update / Remove rejected with a clear "Use + Add Plan to create a fresh on-chain plan instead" message
- **No more "plans disappearing after save"** — UI reflects on-chain state immediately, regardless of indexer lag

(Full Creator + Market integration of these contracts landed in the v1.2.7.7 follow-up release; see [§8](#v1277--channel-management--on-chain-plans--name-sync).)

### Other dDRM-team wins from the period

- **`removed explicit grantRole after channel mint`** (`b08d8d37a`) — the V3 channel-mint contract handles role grants internally, so the explicit `grantRole` call in elacity-creator was redundant and could fail on accounts without `DEFAULT_ADMIN_ROLE`
- **`improved IPFS management in the local node`** (`2dad5ed3d`) — refined bootstrap lookup sequence, more resilient against single-peer outage
- **`ability to run standalone IPFS node (dev mode)`** (`bda09484a`) — developer can spin up an isolated IPFS instance for testing
- **`safe guard to prevent crash when opening app`** (`362b8b8d6`) — defensive null-check for missing metadata fields during the v3 schema rollout
- **`removed hasRole check before minting`** (`8bf99b065`) — V3 contract handles the role check on-chain; redundant frontend gate removed

### Forward look (May 6 dDRM focus)

- **Enable Chipotle read in player side** — especially for video minted from PC2
- **Enable read for other content types** — PDFs, images, 3D, EPUB, CBZ flowing through the same Chipotle-backed open path
- **Explore IPFS solution for more resilient setup** — investigation of IPFS slowness during upload, potential supernode-side mitigations

---

## Branch Work — Feature Saves Carrying Forward

> _Three feature branches and two release branches saw active commits during this window. None are merged to `main` yet (except for the parts that flowed through `release/v1.2-pre-release` into `v1.2.0` itself), but their saves carry forward important architectural workstreams._

### `feature/lit-chipotle-migration` (most active branch — 40 commits Apr 26 → Apr 30)

The home of the dDRM Chipotle integration plus a lot of supporting infrastructure. Most of this branch's work flowed forward through `release/v1.2-pre-release` into v1.2.0; the remaining saves continue to carry the Chipotle-keystore work and IPFS resilience improvements.

Key carrying-forward themes:
- **Wave 8 security findings** — C-02 / M-01 / H-01.2 + companion runbook + post-Test-4 allowlist-miss diagnosis (see [§14](#wave-8-chipotle-hardening--final-three-findings))
- **Protection V3 metadata schema** + migration docs (see Elacity dDRM section above)
- **IPFS connectivity foundation** — explicit peering, auto-reconnect, relay-first NAT, DHT durability, supernode pin-mirror, Elacity Kubo pin-forward
- **RPC proxy hardening** — LlamaRPC priority, Ankr/BlockPI fallbacks, cached `eth_call`, JSON-wrapped rate-limit handling
- **Market wallet improvements** — `4defea25c` cache AuthorityGateway reads; `6e9ced3ce` show Buy button on V3 assets via correct operative tokenId; `7b991dfb7` cache-buster v21→v22

### `feature/metadata-alignment` (focused branch — 32 commits Apr 26 → Apr 28)

The branch where `ELACITY-2221` did its concentrated work before flowing into `feature/lit-chipotle-migration` and then into `release/v1.2-pre-release`. Saves include the full Protection V3 schema rollout, the directory-based IPFS storage migration, the buildMetadataEnvelope restoration, and the metadata-production-to-standard adjustment.

### `release/v1.2-pre-release` (the v1.2.0 staging branch — 70 commits Apr 26 → Apr 30)

This is where everything converged before the v1.2.0 tag. Each commit on this branch is something that landed in the public v1.2.0 release.

Key staging-only work:
- `94eadab36` — `docs(v1.2-pre-release): capture post-review fixes + P7 IPFS connectivity`
- `615836c54` — `docs: DOWNLOAD-FIRST-BUY-FLOW task doc + v1.2 roadmap P6 line`
- `cac1e6d5d` — `build+scripts: rebuild GUI bundle (launch gate in) + installed-apps sync tool`
- `a810fc733` — `docs+media: pipelined player v6 + installed-apps sync gotcha + P2P framing`

### `release/v1.2.6` (the post-v1.2.0 release lineage — through May 1)

Once v1.2.0 was tagged on `release/v1.2-pre-release`, the post-launch follow-up cycle ran on `release/v1.2.6`, which carries the canonical commits for v1.2.1 through v1.2.6:

| Commit | Tag |
|---|---|
| `cdc91a51e` | `fix(v1.2.1): WalletConnect signing hardening + Jetson update reliability + Apple-grade update UX` |
| `8a8d820ba` | `fix(v1.2.2): rotate hardcoded Lit Action CID to canonical bafkreihvm4` |
| `9c85daae4` | `fix(v1.2.3): unblock GUI auto-updater + live log dropdown` |
| `e97a8d523` | `fix(v1.2.4): media playback SSL + IPFS loopback + Lit CID self-heal + Mac installer` |
| `e2f5d96b2` | `v1.2.5: native module verification gauntlet for Mac installs` |
| `124823dd1` | `v1.2.6: install reliability + media pipeline + marketplace UX + secure-view UX` |

### `hotfix/v1.2.1` (the first community-feedback wave on April 30)

The hotfix branch where the very first hours-after-launch fixes landed before being rolled forward into `release/v1.2.6`. Tracks the first three hours of community feedback after v1.2.0 went live.

---

## The Six-Day Post-Launch Follow-Up Cycle

> _Once v1.2.0 went live on April 30, real fresh installs from real community members on real laptops, Jetson boards, and VPSes started flowing in. Every reported issue got a same-day or next-day fix, tagged, signed, notarised, and re-released. **Thirteen point releases in six days, every single one closing real community feedback in hours.**_

This is what continuous open-source-style stewardship looks like in practice. The team is on the same Slack channel as the users, reproducing the issue locally, root-causing, patching, re-tagging, and re-releasing — Apple notarisation + IPFS pinning + GitHub release + signed binaries — typically within hours of the original report.

### The follow-up chain at a glance

| Version | Date | What it shipped |
|---|---|---|
| **v1.2.1** | Apr 30 | WalletConnect signing hardening + Jetson update reliability + Apple-grade update UX. Switched `pm2 reload` (which hung on slow ARM during update restart) to `startOrRestart --update-env`. Live update log dropdown with idle-timeout watchdog (kills any child producing no output for 8 min). |
| **v1.2.2** | Apr 30 | Rotated hardcoded Lit Action CID to canonical `bafkreihvm4…`. The session-key Lit Action shipped in v1.2.0 pointed at a working IPFS CID, but the Pinata pin had drifted; re-pinned + bumped the constant. |
| **v1.2.3** | Apr 30 | Unblocked GUI auto-updater + live log dropdown. Updater was failing silently on `npm install` exit-code 0 with stderr non-empty; switched to `execStreamed` with idle-timeout watchdog. |
| **v1.2.4** | Apr 30 | Media playback SSL + IPFS loopback + Lit CID self-heal + Mac installer fixes. Loopback fetches were hitting `https://localhost:4200` and failing TLS verification; switched to `http://localhost:4200` for in-process fetches. |
| **v1.2.5** | Apr 30 | Native module verification gauntlet for Mac installs. Three-attempt sequence (plain load → clean reinstall → fail loudly with module-specific fix instructions) for both `better-sqlite3` and `node-datachannel`. **Closed the "launcher silently spawns pc2-node against half-installed `node_modules`" scenario.** |
| **v1.2.6** | May 1 | Install reliability + media pipeline + marketplace UX + secure-view UX, consolidated into one polished release. |
| **v1.2.7** | May 3 | **Three convergent workstreams** — see [§7](#v127--three-convergent-workstreams-sqlite-cluster-pin-rpc) |
| **v1.2.7.1** | May 3 | Community parity hot-patch — readiness UX, update.sh drift handling, opt-in diagnostic |
| **v1.2.7.4** | May 4 | Fresh-Mac install hot-patch + AV1 codec fix + supernode dDRM hardening + WASM rebuild |
| **v1.2.7.5** | May 4 | Log hygiene + Earnings RPC discipline + Firefox/VPS reach + WireGuard readiness fix |
| **v1.2.7.7** | May 4 | **Channel management batch + on-chain plans + name-sync architecture + Bug A-H + launcher auto-restart** — see [§8](#v1277--channel-management--on-chain-plans--name-sync) |
| **v1.2.7.8** | May 5 | Three intertwined fixes — `update.sh` build OOM, post-update endpoint freshness, transport binaries release pipeline created and made canonical (see [§12](#pc2-transport-binaries-v1--new-release-pipeline)) |
| **v1.2.7.9** | May 5 | Auto-install macOS + Linux sudoers entries for `wg-quick` + `awg-quick` |
| **v1.2.7.10** | May 5 | Bundled bash 5.2.21 (macOS) + `WG_QUICK_USERSPACE_IMPLEMENTATION` env var via `sudo -E` |
| **v1.2.7.11** | May 5/6 | AmneziaWG fully unblocked + bundled `awg` CLI + osascript install fixes |
| **v1.2.7.12** | May 6 | Sudoers re-prompt loop fix + AmneziaWG `wg setconf` → `awg setconf` upstream-script patch |
| **v1.2.7.13** | May 6 | **Runtime Heartbeat Protocol** — see [§10](#v12713--runtime-heartbeat-protocol-launcherpc2-node-sync) |

The full per-fix detail is in `CHANGELOG.md` on the repo, and each GitHub tag carries a user-facing summary.

### Why this cadence matters

A release is only as good as its first 72 hours of community use. The version of v1.2.0 actually running in user installs today is the **v1.2.0 → v1.2.7.13 chain** — every issue surfaced in real-world installs **diagnosed, root-caused, fixed, tagged, signed, notarised, and released in hours, not weeks**. This is the kind of post-launch care cycle that converts "we shipped it" into "people are actually using it."

---

## v1.2.7 — Three Convergent Workstreams (SQLite, Cluster Pin, RPC)

> _The first "let it breathe" release after the v1.2.0 first-night chain. Three workstreams that had been parked during the security cycle, all landing together because they all matter for adoption._

**Why this matters:** v1.2.7 is the version most users will actually install — it's where the install path gets dramatically simpler (no more Xcode CLT prompt), the IPFS pinning becomes a default (every node helps the network without operator action), and the RPC story gets honest (public Base RPC fallback was getting rate-limited).

### 1. SQLite migration — `better-sqlite3` → `@photostructure/sqlite`

**The win:** the Mac first-run experience goes from "install Xcode CLT first" to "click Power On". `@photostructure/sqlite` is Node-API based, ships per-platform prebuilds bundled inside the npm tarball, and works across Node 20 / 22 / 24 with no compiler.

- `enhance()` wrapper in `pc2-node/src/storage/database.ts` keeps the call-site API identical
- Existing `pc2.db` files read cleanly under the new adapter (verified live on Jetson canary: 61 pinned_cids + 3 users + 3 sessions preserved)
- Companion launcher release [v1.2.6](https://github.com/Elacity/elastos-launcher/releases/tag/v1.2.6) — adds `detectSqliteAdapter()` so the launcher's pre-flight verification works for both adapters

### 2. IPFS Cluster pinning — install-and-works on every fresh node

**The win:** every fresh community node now contributes to global durability automatically.

- `pc2-node/src/services/clusterPin.ts` ships a default URL + community shared token in source
- Boot log: `[ClusterPin] enabled -> https://38.242.211.112/cluster-pin (Elacity default) (replication=2/2)`
- Abuse bounded by per-IP rate limiting at the supernode (30 req/min + burst 20)
- Operators who want a different cluster: set `SUPERNODE_CLUSTER_PIN_URL` + `_TOKEN` in `pc2-node/.env`
- Operators who want to disable: set both vars to empty strings
- Verified at 2/2 replication in 730ms on the Jetson canary

### 3. Supernode-RPC opt-in path

Particle Auth's mint flow makes ~6-12 RPC calls per mint; all 5 default public Base RPCs tightened rate limits in 2026. v1.2.7 documents an opt-in path in `pc2-node/.env.example` — 5-step Alchemy walkthrough, sets `SUPERNODE_RPC_URLS` and the `initBaseRpcPool` prepends it to the shared pool. v1.2.8 will ship a supernode-backed RPC proxy as default — community nodes never need their own Alchemy key.

### Adjacent must-haves (also in v1.2.7)

- **Update flow hardening** — `UpdateService` uses `pm2 startOrRestart --update-env`; `update.sh` migrates inline `ecosystem.config.cjs` secrets to `pc2-node/.env` BEFORE `git reset --hard`
- **`ecosystem.config.cjs` conditional-spread env block** — fixes a subtle dotenv-override bug
- **`/api/health` extended** with `cluster.pinning` summary block
- **`docs/SYSTEM_MAP.md` (619 lines)** — comprehensive system-architecture reference, the new "where do I look for X" index for new contributors

---

## v1.2.7.7 — Channel Management + On-Chain Plans + Name-Sync

> _The largest single shipping release of the period: 18 files, 2,851 insertions, 125 deletions, in one commit (`dfce7a4fc`). Combines the v1.2.7.6 launcher work + the channel/playback/UX/on-chain batch + the cross-app name-sync architecture + the stale-signer fixes that surfaced during testing._

### Channel management UI (Bug A–H)

Eight community-surfaced polishes shipped together:

| Bug | What | Fix |
|---|---|---|
| **A** | `.ddrm` files showed the descriptor's 1 KB size, not real media size | `getDdrmRealSize()` walks the protection metadata and resolves the underlying CID |
| **B** | Video timeline "grew" mid-playback | MPD `mediaPresentationDuration` and SegmentTimeline now agree byte-for-byte |
| **C** | Channel management — needs ownership warning, channel images, on-chain token-gating with decimals | Full channel-management modal in Creator + Market with these fields |
| **D** | File manager defaulted to grid view, ignoring user's saved preference | List view default; saved preference still respected |
| **E** | Market edit-channel modal clipped at viewport on small screens | Scroll inside dialog, not at body |
| **F** | Market image upload pinned only to local PC2 IPFS | Now mirrored to public Elacity gateway — globally visible, not just locally pinned |
| **G** | Update channel returned "not allowed to edit" even when wallet was the owner | Per-mode JWT cache + correct EOA/SA principal selection per channel |
| **G2** | Plan / gate save threw MetaMask's cryptic `gasLimit` error | `eth_call` pre-flight surfaces the real revert reason |
| **G3** | Stale channel-name dropdown after rename | Reconciles to the canonical backend name on every save |
| **H** | Save Profile required 3 separate clicks for name + description + images | One Save Profile button; merged into a single off-chain GraphQL call |

### On-chain plans + token-gates (V3 contracts on Base)

The big architectural change — channel plans + token-gating rules now written **on-chain** via the `SubscriptionModule` (V3):

```
bulkUpdatePlans(plans[])
configureTokenOwnershipAccess(token, decimals, rules)
subscribePlan(uint8 planId, bytes args)
```

Plan metadata pinned to IPFS; `planURI` passed in encoded args. Legacy off-chain plan IDs guarded — Update / Remove rejected with a clear "Use + Add Plan to create a fresh on-chain plan instead" message. Creator reads plans **directly from the on-chain contract** and overlays backend-side label/description metadata.

### Bug-G mirror — silent local-catalog fallback removed in elacity-market

Market's `api.js#updateChannelInformation` was silently falling back to the PC2 local catalog on **any** error — including 401/403 "not allowed to edit". User saw "saved!" toast, local mirror updated, backend never accepted the write. Closed:

```
401 / 403 / "not allowed" → throw (real error surfaces in UI)
network / 5xx          → fall back to local catalog (offline UX preserved)
```

`wallet.js#siweLogin` is now mode-aware (`{ authMode: 'eoa' | 'sa' }`); per-mode promise cache so duplicate concurrent calls coalesce.

### Stale per-mode JWT (final blocker, verified end-to-end)

After Bug-G mirror went live, the genuine "not allowed to edit" surfaced. Root cause: tokens cached by mode (`tokens.eoa`, `tokens.sa`) but **not by signer address** — a stale token from a previous wallet session would slip through `isAuthenticated('eoa')`. Fix: `isAuthenticatedAs(mode, expectedSigner)` requires cached signer to match channel creator; `siweLogin({ authMode, force: true })` mints a fresh JWT bound to the current wallet when staleness is detected.

### Batched plan management + channel-image preview reliability

`openManagePlansModal` rewritten as single inline editor with footer-pinned save bar — add/edit/remove all queue locally, then commit in one `bulkUpdatePlans` transaction. Channel-image preview robust against malformed backend `imageURL`s (`.../ipfs/ipfs://CID` doubled-prefix), unrecognised `bafk…` raw-leaves CIDs, flexbox layout collapse.

### Launcher / system (the v1.2.7.6 piece in this release)

- **Auto-respawn after update / restart** — guaranteed restart on macOS even when the launcher misbehaves. New `pc2-node/src/utils/respawner.ts` writes a detached `sleep && exec` script before exiting. **Predecessor of the v1.2.7.13 heartbeat protocol** — same problem, narrower fix.
- **Dark mode for UpdateModal** — re-themed to CSS variables; explicit button styling
- **`pc2-diagnose.sh`** captures launcher / IPFS / Lit / Chipotle reachability in a single tarball

---

## The Stealth-Mode Sprint — v1.2.7.8 → v1.2.7.12

> _Forty-eight hours of closing the long tail of fresh-Mac WireGuard / AmneziaWG / VLESS Reality bring-up bugs. This is the chain that makes "stealth mode" actually work for users without Homebrew, without Xcode CLT, without dev tools._

**Why this matters:** Stealth mode isn't a nice-to-have — it's the layer that lets a PC2 node operate from a region with active internet filtering. The whole transport cascade (PC2 active proxy → vanilla WireGuard → AmneziaWG obfuscation → VLESS Reality TLS) was passing local CI but failing on real fresh MacBooks because of fragile assumptions about what a fresh macOS install actually contains.

### v1.2.7.8 — Created the canonical transport binaries release

`BinaryManager` had been pointing at a `pc2-binaries-v1` GitHub release that hadn't been published yet. End-to-end fix: created the release, added `wg`/`wg-quick` to `TRANSPORT_BINARIES`, new `.github/workflows/publish-pc2-binaries.yml`, SHA-256 verification, `stripDarwinQuarantine` post-install, **readiness signal split** (`transport={active, label, degraded, preferred}` instead of a single confused boolean — launcher UI now shows "Active transport: AmneziaWG (Stealth)" or "ActiveProxy (fallback)").

### v1.2.7.9 — Auto-install macOS + Linux sudoers entries

`scripts/setup-transport-permissions.sh` (new) — idempotent installer for both `wg-quick` and `awg-quick`. macOS uses `osascript` admin dialog (one-click "allow PC2 to install transport permissions?"); Linux uses terminal sudo during `update.sh`. Grant scoped to ONLY the bundled binaries — no broader privilege escalation.

### v1.2.7.10 — Bundled bash 5.2.21 (macOS) + `sudo -E` env var

Two structural fixes:

**(a) Apple ships `/bin/bash` 3.2** (because of GPLv3 licensing). `wg-quick` requires bash 4+ for associative arrays. Fix: new `BinaryManager` entry for bash with a `validateFound` hook (rejects bash 3.x), then `patchMacOSScriptShebangs()` rewrites the `#!` line of bundled `wg-quick` and `awg-quick` to point at the resolved bash 4+.

**(b) `wg-quick.darwin` calls `${WG_QUICK_USERSPACE_IMPLEMENTATION:-wireguard-go}`** to find the userspace VPN engine. Sudo's `env_reset` strips the env var. Fix: `WireGuardService.detectMode()` macOS branch resolves `wgGoBinPath`; `wgQuickCmd()` passes it via `sudo -E`. Sudoers rules upgraded `NOPASSWD:` → `NOPASSWD:SETENV:`.

### v1.2.7.11 — AmneziaWG fully unblocked

Three intertwined bugs:

1. **`AmneziaWGService.ensureKeypair` was searching the wrong directories** — used the older `findTool()` helper which didn't check the bundled `~/.pc2/pc2-node/bin/<platform>-<arch>/` dir. Fix: route through `findBinary`.

2. **`awg` (the AmneziaWG fork of `wg`) was never bundled.** `awg-quick.darwin` invokes `awg setconf` to install the Jc/Jmin/Jmax/S1-S4/H1-H4 obfuscation parameters — plain `wg` rejects those keys. Fix: build `awg` from `amnezia-vpn/amneziawg-tools` alongside `wg`. Asset count went `pc2-binaries-v1` 18 → 22.

3. **Bundled bin dir wasn't on `$PATH` inside the sudo'd script** — sudo's `env_reset` + `secure_path` strips the bundled dir. Fix: inject `# PC2_PATH_SELF_LOCATION_v1` marker + `export PATH="$(cd "$(dirname "$0")" && pwd):$PATH"` after the shebang.

Plus two leftover `setupPermissions.ts` bugs:
- **`setupMacOS` osascript apostrophe escape bug** — apostrophes in entry comments terminated the outer single-quoted shell argument before osascript could run. Fix: write entry to `mktemp` file as the user, then have osascript run a fixed-shape `cp + chmod + rm` against known paths.
- **`checkWireGuardPermissions` fallback probe** — used `sudo -n <wg-quick> --version` but `wg-quick` has no `--version` flag. Fix: `sudo -n -l <wg-quick> up <args>` exits 0 silently when a NOPASSWD rule matches.

### v1.2.7.12 — Sudoers re-prompt loop fix + upstream awg-quick patch

Two regressions:

1. **Password prompt fired on every launcher restart.** `sudo -n -l` returns non-zero on macOS for non-root users in some sudoers configurations even when NOPASSWD rules are correct. Fix: SHA-256 marker file at `<wgDir>/sudoers-marker.json` written on successful install; primary probe reads the marker, hashes the entry we'd write today, compares — if equal AND `/etc/sudoers.d/pc2-wireguard` still exists, we trust it without invoking sudo.

2. **AmneziaWG still failed at `wg setconf`.** Root cause: **upstream `amnezia-vpn/amneziawg-tools/src/wg-quick/darwin.bash` was rebased from upstream wireguard-tools but the maintainer forgot to swap `wg` → `awg`.** So `awg-quick` on macOS literally calls `wg setconf` (lines 372, 402), `wg show` (lines 112, 215, 463, 474, 484), `wg showconf` — and plain `wg` rejects the obfuscation keys. Fix: rewrite `wg <subcmd>` → `awg <subcmd>` for `setconf|show|showconf|syncconf|addconf`. Patched at build time in `fetch-binaries.sh::inject_awg_subcommand_patches()` AND at runtime in `BinaryManager.patchAwgQuickSubcommands()` — same regex shape, idempotent via `# PC2_AWG_SUBCMD_PATCHED_v1` marker.

### What's now proven on a fresh MacBook

- **Vanilla WireGuard** — connects, works against any standard `wg` server
- **AmneziaWG (stealth)** — connects, all obfuscation parameters parse correctly, evades pattern-match DPI
- **VLESS Reality** — connects, TLS handshake indistinguishable from a real `cloudflare.com` connection
- **No password prompt on every launcher restart**
- **No silent ActiveProxy fallback** — readiness signal correctly reports `transport.active = "amnezia-wireguard"`

---

## v1.2.7.13 — Runtime Heartbeat Protocol (Launcher↔pc2-node Sync)

> _The capstone fix on the v1.2.7.x chain. Closes the long-standing launcher status indicator desync that hit users every time pc2-node respawned without the launcher's `spawn()` call._

**Why this matters:** Once stealth mode worked end-to-end, the remaining UX rough edge was: **the launcher's status indicator went stale every time pc2-node respawned.** Four scenarios all triggered it: macOS in-app update, manual restart, external `pm2 restart pc2`, crash + supervisor auto-restart.

### The fix

pc2-node now writes `<pc2NodeDir>/data/runtime/heartbeat.json` every 2s containing `{ schema, pid, version, port, healthy, startedAt, lastUpdated, lastRestartReason }`. The launcher polls this file (1s interval) as its single source of truth for "is pc2-node alive?" instead of tracking the child PID:

| Heartbeat state | Launcher status |
|---|---|
| File missing | `stopped` (clean exit) |
| File >5s stale | `error` (likely crashed) |
| File fresh, `healthy: false` | `stopping` |
| File fresh, `healthy: true` | `running` |

### Bonus capability: out-of-band restart trigger

Anyone with write access to `<pc2NodeDir>/data/runtime/restart-requested.flag` can request a clean respawn — the Web GUI, `scripts/update.sh`, an external supervisor, or a one-off shell command:

```bash
echo "reason: my-trigger" > ~/.pc2/pc2-node/data/runtime/restart-requested.flag
```

pc2-node's flag watcher consumes the flag, optionally honours a `reason: <tag>` line for traceability, calls `spawnDetachedRespawn`, exits cleanly. The new pc2-node writes a fresh heartbeat with the new PID + version within ~2s.

### Schema versioning + backward compatibility

Schema-versioned (`pc2.heartbeat.v1`). New launcher + old pc2-node = falls through to existing `/health` polling. Old launcher + new pc2-node = ignores the file. **No coordinated rollout required.**

### Protocol contract

Full schema, liveness rules, edge cases, and a drop-in TypeScript poller class for third-party integrators are documented at [`docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md`](https://github.com/Elacity/pc2.net/blob/main/docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md) (303 lines).

### Files changed

| File | Change |
|---|---|
| `pc2-node/src/utils/runtime-heartbeat.ts` (NEW) | `RuntimeHeartbeat` class — heartbeat writer + flag watcher (333 LOC) |
| `pc2-node/src/index.ts` | Wires heartbeat into `server.listen` callback + graceful shutdown (+60 LOC) |
| `docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md` (NEW) | Protocol contract for launcher integrators (303 LOC) |

### Companion launcher change (Elacity/elastos-launcher v1.2.7)

| File | Change |
|---|---|
| `src/main/pc2Heartbeat.ts` (NEW) | `HeartbeatPoller` class with `requestRestart(reason)` helper (244 LOC) |
| `src/main/pc2Manager.ts` | Heartbeat-aware `getStatus()` + 6-second respawn-detection defer + new exports (+274 LOC) |
| `src/main/index.ts` | Calls `shutdownHeartbeatPoller()` in `before-quit` (+5 LOC) |

The 6-second exit-handler defer is the subtle part. When pc2-node exits unexpectedly (crash OR `spawnDetachedRespawn`), the launcher waits 6s instead of immediately emitting `stopped`. If the heartbeat poller sees a fresh `running` state in that window, it cancels the deferred timer — so the launcher status stays green throughout the respawn. **Six seconds = `spawnDetachedRespawn`'s 3s sleep + 2s heartbeat interval + 1s slack.** User-initiated stops bypass the defer (`userInitiatedStopInFlight` flag) so the UI feels responsive when you click Stop.

---

## ElastOS Launcher — Four Apple-Signed Releases (v1.2.4 → v1.2.7)

> _Four launcher releases shipped this period, every one Apple-signed and notarised through the existing GitHub Actions pipeline. The launcher tag pattern (`v1.2.X`) tracks the pc2-node minor; v1.2.7 aligns with pc2-node v1.2.7.13's heartbeat protocol._

| Launcher version | Date | What |
|---|---|---|
| **v1.2.4** | Apr 30 | Aligned with PC2 v1.2.4. Fixed Node 22 ABI mismatch on install/update — `better-sqlite3` prebuilds were trying to use Node 20 ABI even though the bundled Node was 22. |
| **v1.2.5** | May 1 | Reverted v1.2.4's over-aggressive native-module rebuild that was forcing every install through `npm rebuild --build-from-source`. Added the **native module verification gauntlet**: three-attempt sequence for both `better-sqlite3` and `node-datachannel`. |
| **v1.2.6** | May 3 | **SQLite-adapter aware install/update + repair existing install.** New `detectSqliteAdapter(pc2NodeDir)` reads pc2-node's `package.json` and builds the right load-probe — `@photostructure/sqlite` for v1.2.7+ or `better-sqlite3` for v1.2.6 and earlier. Smart "existing directory" handling: detects whether `~/.pc2` is our repo vs leftover junk vs corrupt half-install, chooses repair vs backup-aside vs fresh-clone. |
| **v1.2.7** | May 6 | **Heartbeat-based pc2-node status.** Adopts pc2-node v1.2.7.13's runtime heartbeat protocol as the launcher's single source of truth. |

### Apple signing + notarisation

The launcher's `.github/workflows/build.yml` injects five secrets into the `mac` job on every tag push: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Then runs `codesign --verify --deep --strict` on the produced `.app` and uploads the signed/notarised DMGs as release assets.

**Verification of the v1.2.7 build** — all three platforms green: macOS DMG, mac zip, Linux AppImage + deb, Windows exe + setup.exe — all live on the release page.

---

## PC2 Transport Binaries (v1) — New Release Pipeline

> _A new GitHub Actions workflow that builds, codesigns, notarises, and SHA-256-verifies a curated set of native transport binaries for distribution alongside pc2-node. This is what made v1.2.7.10–.13's fresh-Mac WireGuard / AmneziaWG path possible._

**Why this matters:** PC2's transport stack needs `wg`, `wg-quick`, `wireguard-go`, `awg`, `awg-quick`, `amneziawg-go`, `bash 5+`, and `sing-box` to bring up its three connectivity modes. Most users don't have Homebrew, can't compile from C source, and don't want a sudo prompt for Xcode CLT just to use a privacy-preserving network mode. **We need to ship the binaries ourselves, and we need them Apple-trusted so macOS doesn't Gatekeeper-block them.**

### What shipped

- New workflow: `.github/workflows/publish-pc2-binaries.yml`
- Triggered manually via `workflow_dispatch` with `release_tag` + `replace_existing` inputs
- Builds for: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win-x64`
- 22 platform-specific assets in the release: 10 darwin native binaries Apple-codesigned + notarised + stapled, 4 darwin shell scripts (build-time-patched + path-self-locating + `wg→awg` subcmd patched), corresponding linux + windows assets

### Apple signing pipeline

Same five repository secrets as the launcher. The codesign loop wraps each darwin binary individually, then submits a single notarisation request, polls until `Accepted`, and `xcrun stapler staple`s the ticket. Output: **binaries that load on a fresh MacBook with zero Gatekeeper warnings, zero quarantine xattr cleanup needed by the user.**

### Runtime download path

`BinaryManager` (`pc2-node/src/utils/binary-manager.ts`) on first install:
1. Reads `TRANSPORT_BINARIES` table for the current platform
2. Downloads each missing binary from the GitHub release
3. Verifies SHA-256 against the manifest (rejects mismatch)
4. `chmod +x` and `xattr -d com.apple.quarantine` (macOS)
5. Idempotent — skip files that already exist with the right SHA-256

### Build-time patches baked into the release

- `wg-quick` and `awg-quick` get the `# PC2_PATH_SELF_LOCATION_v1` marker + `export PATH=…` injection
- `awg-quick.darwin` gets the `wg <subcmd>` → `awg <subcmd>` rewrite
- All shell scripts have their `#!` rewritten to a known-good bash 4+ path

### Companion runtime patcher for in-place upgrades

The build-time patches only hit fresh installs. For users who already have unpatched `wg-quick` / `awg-quick` on disk from earlier versions, `BinaryManager.patchTransportScriptPathSelfLocation()` and `BinaryManager.patchAwgQuickSubcommands()` apply the same regexes at runtime on first launch, idempotent via marker comments. **No re-download required for the patch to land.**

---

## Supernode Preflight — Kubo 0.41.0 + Mesh Restoration

> _A read-only audit on May 5 surfaced four issues that none of the existing handover or design docs acknowledged. All four closed in 11 minutes of operator work, with full snapshot rollback paths preserved for 7 days._

### What was opened up

| Issue | Severity |
|---|---|
| Kubo 0.34.1 had a **bitswap nil-deref crash loop on InterServer** (panicking every ~6 hours) | High |
| Cluster mesh was **asymmetric** — InterServer saw Contabo as a peer; Contabo did not see InterServer | Medium |
| `pc2-ipfs-relay` was **leaking memory unboundedly** | Critical on Contabo, harmless on InterServer (91 GB RAM) |
| Phase 3 (`/cluster-pin/` ingress symmetry on InterServer) made an incorrect architectural assumption | Deferred to follow-up task |

### What got closed (May 5, 04:50 – 05:01 UTC)

| Phase | Action | Result |
|---|---|---|
| 0 | Snapshots taken on both supernodes | `/root/preflight-snapshots/20260505T044153Z/` (Contabo), `/root/preflight-snapshots/20260505T044158Z/` (InterServer) |
| 1 | `pc2-ipfs-relay` restarted on Contabo | RSS **9.6 GB → 227 MB** (42× reduction); load 1-min **5.61 → 1.51** |
| 2 (InterServer) | Kubo 0.34.1 → 0.41.0 binary swap; fs-repo migrated v16 → v17 → v18 | Daemon ready in 5s, 0 panics in 9-minute soak; **PeerID `12D3KooW…Rc5f` preserved** |
| 2 (Contabo) | Kubo 0.34.1 → 0.41.0 binary swap; fs-repo migrated v16 → v17 → v18 | Daemon ready in 5s, 0 panics in 6-minute soak; **PeerID `12D3KooW…9nVr` preserved** |
| 3 | UFW rule on InterServer | Already present (#52) from earlier cluster-setup work |
| 4 | End-to-end verification | Cluster mesh **symmetric** (both peers `Sees 1`); pin propagation 5s round-trip |

**Outcome**: 0/2 → 2/2 supernodes healthy. Mesh fully restored. Bitswap nil-deref crash loop eliminated. v1.2.8.0 development can proceed.

### Services explicitly NOT touched

- **InterServer**: `pc2-boson` `pc2-cloud-node` `pc2-vless-reality` `pc2-app-registry` `pc2-network-map` `pc2-gateway` `pc2-ipfs-relay` — all 7 active
- **Contabo**: `pc2-boson` `pc2-vless-reality` `pc2-app-registry` `pc2-ipfs-relay` — all 4 active

### Post-preflight discovery: pc2-ipfs-relay memory leak

**Root cause**: upstream JS-libp2p connection-manager memory leak in `pc2-ipfs-relay/index.js`. Not fixable in a hot-patch.

**Mitigation applied immediately**: systemd drop-in at `/etc/systemd/system/pc2-ipfs-relay.service.d/memory-cap.conf` on both supernodes:

```ini
[Service]
# Cap memory at 6 GB to prevent unbounded growth from upstream JS-libp2p leak.
MemoryMax=6G
```

The unit's existing `Restart=always` + `RestartSec=10` handles auto-recovery. Estimated restart cadence: ~17 days on InterServer, ~19 hours on Contabo. ~10s libp2p relay outage when the cap triggers; PC2 nodes fall back to public DHT during the window.

**Cure (queued)**: lower `maxConnections` to 256 + add explicit `circuitRelayServer` caps in `deploy/ipfs-relay/index.js`. Filed as `SUPERNODE-IPFS-RELAY-LEAK-V1281`.

### Companion task doc

Full execution record + verification snippets + rollback paths in `.cursor/tasks/SUPERNODE-HEALTH-PREFLIGHT-V1280/SUPERNODE-HEALTH-PREFLIGHT-V1280.md` (643 lines).

---

## Wave 8 Chipotle Hardening — Final Three Findings

> _The final wave of the SEC-2026-04 / SEC-2026-04-28 Chipotle audit family. Three intertwined findings closed across April 27, with companion runbook updates and a live-verify script. Foundational work for v1.2.0's security posture._

### What landed

| Finding | Severity | What | Commit |
|---|---|---|---|
| **C-02** | Critical | Bind CEK decrypt to authorised `kid` in the Chipotle Lit Actions. Closes a class of cross-asset leakage where an attacker holding a valid session for asset A could request the CEK for asset B by passing B's `kid` in `jsParams` | `7c0273529` |
| **M-01** | Medium | Ignore creator-controlled RPC in `detectSmartAccountUser`. Closes the Particle smart-account spoof vector — an attacker could supply a malicious RPC URL via channel metadata, the PC2 node would query that RPC, get a forged "is smart account" response, and mis-route auth | `8e3523bfe` |
| **H-01.2** | High | Require signed provision envelope from supernodes. Gives PC2 nodes a way to verify the bootstrap payload they fetch from `/api/ddrm/provision` — Ed25519-signed by a supernode key, published as part of the v2 envelope | `71fa961de` |

### MEDIA_DECRYPT CID re-pinned to Pinata + live-verify script

The MEDIA_DECRYPT Lit Action is what the Player calls to recover the per-asset CEK during media playback. After the C-02 fix changed the action's signature, the new code was re-pinned to Pinata (which provides higher-uptime IPFS gateways than self-hosted) and a `live-verify.sh` script was added so operators can confirm at any time that the live action's source bytes match the canonical CID.

### Companion runbook + console-noise sweep

Companion runbook updated post-Test-4 allowlist-miss diagnosis (commit `77374721b`) — the original runbook missed an edge case where the Chipotle action allowlist needed to be rebuilt to include the new whitespace-normalised action source. Wave 8 also surfaced three console-noise items reported during Test 4 triage (`a35b1b236`) — none security-relevant, just user-visible warning spam during normal flow.

---

## Elacity on the Road — Vol. 2: Bitcoin Week Final Days + Miami Week One

> _The parallel workstream running underneath all of the above. **11 days, 17 events, 9 industries, $0 in tickets, and ElastOS Runtime v1.2 shipped Friday May 1 from a Vegas hotel room.** Picking up from the Vegas update (Vol. 1). The thesis hasn't moved; the way we describe it has sharpened materially._

### The thesis sharpening that happened mid-trip

At the **Digital Asset Yield Summit** (EAST Miami, May 4) — a full-day anchor event for vetted institutional allocators with $2tn+ AUM — the Securitize wedge upgraded into something more specific:

> *"Securitize tokenises real-world securities. Elacity tokenises real-world rights — royalties, licensing fees, revenue shares. Same playbook, different asset class. The interesting part: rights are productive assets. They pay native, uncorrelated yield."*

That last sentence is what closed conversations. **Music royalties pay monthly. AI training data licensing pays per use. Content royalty streams pay continuously.** Cashflow from real-world IP, uncorrelated to crypto cycles or traditional markets. Allocators are drowning in correlated yield. **Rights are a new yield-bearing asset class** — and that framing, tested cold across DAYS / Tokenized Capital Summit / Builders in Tokenization, landed on every audience archetype.

### Bitcoin Week final days (Apr 26 – 29)

The closing days of Bitcoin Week 2026 in Vegas, executed as the platform was being staged for the v1.2.0 ship.

| # | Event | Venue / Date | Audience | Why it mattered |
|---|---|---|---|---|
| 1 | **Chamber of Bitcoin** (invite-only) | The Lock Speakeasy, Apr 27 | Bitcoin-only business owners, OG community | Rare seat for any non-pure-Bitcoin chain. Synergy: *"Bitcoin made money sovereign, Elastos is doing the same for everything else"* let us belong without competing |
| 2 | **BitcoinMondays Vegas** | Legacy Club rooftop, Circa, Apr 27 | Bitcoin community + serious operators | First public test of the rights-as-productive-yield framing. Resonated. |
| 3 | **TRON Whale Night with Securitize** | OMNIA, Caesars, Apr 27 | DeFi capital, institutional crypto, tokenisation teams | The exact room where the Securitize wedge was tested cold. We sit in the gap between TRON (tokenised money flows) and Securitize (tokenised securities). |
| 4 | **Run for Hal** | Venetian, Apr 28 | Bitcoin OGs, ALS-aware crowd | A posture event, not a pitch room. The Bitcoin community quietly notes who shows up here. |
| 5 | **Bitcoin 2026 main floor** | Venetian Convention Center, Apr 28 | ~20,000 attendees across the institutional Bitcoin spectrum | Temperature read. The Bitcoin community is now meaningfully comfortable with adjacent infrastructure. **Doors open that were closed three years ago.** |
| 6 | **AI + Bitcoin: Next-Gen Revolution** (OnePiece Labs) | Las Vegas Strip, Apr 28 | Bitcoin infrastructure engineers + AI builders | **The single most thesis-aligned room of Bitcoin Week.** AI agents + Bitcoin rails + content licensing — all live conversation topics. Elacity dDRM, ACCESS_TOKEN, ERC-8183 are exactly that layer. |
| 7 | **BitGo High Roller Summit** | The Venetian, Apr 27 – 29 (3 days) | Institutional Bitcoin custody, treasury operators, capital allocators | Long-horizon partnership conversations. Custody operators are mapping the next two years of asset categories. **Plant the flag now for tokenised rights and AI-agent licences before the category gets contested.** |
| 8 | **Bitcoin Capital Reception** (Cryptio) | Chéri Rooftop, Paris LV, Apr 28 | CFOs, treasury accountants, institutional finance | Most institutionally credible reception of the week. Cryptio (compliant accounting infrastructure) is an obvious natural partner for tokenised rights flows. |
| 9 | **Bitcoin 2026 Day 3** | Venetian Convention Center, Apr 29 | Final day, all-comers | Closing meetings, follow-ups, building the final picture of who's tracking what. |

### The ship weekend (Apr 30 – May 3)

**ElastOS Runtime v1.2 shipped Friday May 1.** The team executed the release while the CEO held the hotel room and kept calls running from Vegas. **Caesars Palace sportsbook became an ad-hoc ops desk.** Sunday morning: Vegas → Houston → Miami.

The point worth making to the community: **we didn't pause the trip to ship, and we didn't pause the ship to be on the trip.** The operating model held under pressure. The technical narrative covered earlier in this document — v1.2.0 going live, v1.2.1 → v1.2.5 hot-patch chain inside 12 hours, every reported community issue closed in hours not weeks — happened with the CEO 2,000 miles from the team, mid-conference, holding partnership conversations in parallel.

### Miami Bitcoin & RWA Week (May 4 – 6, ongoing)

| # | Event | Venue / Date | Audience | Why it mattered |
|---|---|---|---|---|
| 10 | **Digital Asset Yield Summit (DAYS)** | EAST Miami Brickell, May 4 — full-day anchor | Allocators, $2tn+ AUM, vetted institutional only | **Where the upgraded framing crystallised.** Steve Leaton (EAST Miami floors 38 – 39) confirmed in person what calls had only suggested. |
| 11 | **Tokenized Capital Summit** | Miami Marriott Biscayne Bay, May 4 evening | 450+ HNWIs, family offices, 25+ billion-dollar funds, **Arthur Hayes fireside, Polygon keynote** | In HNWI rooms, lead with credibility signals (Bitcoin merge mining since 2018, open-source codebase, live product) before category framing. The Hayes-aligned macro framing — sovereign money, sovereign rights — landed naturally. |
| 12 | **Hashlock Proof of Contribution Miami** | Mindspace Wynwood, May 5 | Web3 builders, security-focused devs | Different texture from the institutional rooms. **Elacity dDRM is cross-chain rights infrastructure** — ACCESS_TOKEN, ERC-8183 compatible, content licensed once, royalties paid everywhere. |
| 13 | **An Evening with Sui** | Temple House, Miami Beach, May 5 | **Raoul Pal, Mysten Labs, a16z, Fidelity Digital Assets** | The AI + DeFi convergence panel surfaced exactly the same gap we keep seeing — the missing programmable rights layer underneath agent commerce. Sui's high-throughput execution + Elacity's rights protocol is a credible architectural pairing for AI-agent-driven micro-licensing at machine speed. |
| 14 | **AINative Proof of Fiesta** | The Clevelander, Miami Beach, May 5 night | AI-native builders, AI + crypto crossover community | AI agents need rails for spending, licensing, and transacting. **We are exactly that rails layer.** ACCESS_TOKEN delegated authority + dDRM rights primitives + ERC-8183 agentic commerce standard all map directly. |
| 15 | **Builders in Tokenization Rooftop** | 235 Lincoln Rd, Miami Beach, May 6 evening | Tokenisation practitioners, RWA builders, real-asset operators | **The single most thesis-aligned room of Miami so far.** Most practitioners are working on financial assets; the non-financial side (rights, royalties, IP, licensing) is structurally underserved. Elacity is in that exact gap, and the room recognised it instantly. |
| 16 | **MetaMask Multichain Fest** | Miami Beach, May 6 evening | **Solana, TRON, Pudgy, Stellar, Monad, Hyperliquid** ecosystem teams | Every chain wants more credible cross-chain primitives, and the rights layer is one of the few that hasn't been done well. **dDRM is genuinely chain-agnostic** — strong cross-chain integration angle for partnerships at the team-to-team level. |
| 17 | **E11EVEN — Official Consensus Afterparty** | E11EVEN Miami, May 6 night (ongoing) | Senior crypto, deal-making crowd, where Consensus week converges late | Where conversations from the day mature into genuine relationships. Not a pitch room — a continuity room. |

### Patterns emerging across the rooms

**Four different vocabularies, one gap.** Bitcoin people, Cloud people, Allocators, and AI builders all arrive at the same gap from different sides:

- **Bitcoin people** see it as the missing layer for non-monetary value
- **Cloud people** see it as the missing rights primitive for AI agents
- **Allocators** see it as a new uncorrelated productive asset class
- **AI builders** see it as the missing rails for machine-speed commerce

**Securitize keeps coming up unprompted.** Allocators and HNWIs love a category framing they already understand. *"The Securitize equivalent for rights"* gives instant context, signals seriousness, and avoids competing with the most institutionally credible RWA player.

**Productive yield is the unlock.** Yield in crypto is mostly mechanism-derived (staking, restaking, lending). Yield from real-world rights is asset-derived. Allocators trust the second far more than the first.

**Open source is the credentials.** Elacity's GitHub is what got us into Bitcoin 2026 (Open Source Pass), Solana Accelerate-adjacent rooms, and most invite-only side events. **The codebase is the resume.**

### How we are operating

Same model as Vegas, sustained. **Conference tickets: $0. Side events: $0.** All access via relationships, partner programmes, Luma signups disciplined weeks ahead, and AI-augmented research for invite-only rooms. The team headcount required to execute this trip the traditional way would be 3 – 4 people. **We're doing it with one CEO and AI tooling.**

### Coming up — the rest of the trip

| Date | Event | Venue / City |
|---|---|---|
| **Thu May 7** | Consensus Miami Day 3 final side events | Miami |
| **Fri May 8** | **DAT Summit** (Digital Asset Treasuries) — closed-door 400 – 500 senior institutional, with **Galaxy Digital, Animoca, Coinbase Institutional, Pantera Capital** on stage | The EDITION South Beach — closing room of Miami |
| **Sat – Sun May 9 – 10** | Recovery + closing follow-ups + trip-recap synthesis | Miami |
| **Mon May 11** | Miami → London | Travel day |
| **May 13 – 14** | **FT Digital Assets Summit** | Convene Aldersgate, London — most senior institutional finance audience of the entire trip |
| **May 19 onward** | Bangkok, head-down product mode | Updates landing in the runtime, dDRM pipeline, network upgrades — fed by everything from these rooms |

> *"We will keep posting from the road. Thank you for backing this work. We are present in these rooms, sharing what Elastos is building, and growing the network of people who understand why it matters."*
>
> *— A world computer you own. With an economy inside.*
>
> *— Sash, CEO, Elacity Labs*

---

## Looking Ahead — v1.2.8.0 + Beyond

### v1.2.8.0 — Chipotle Relayer (in design, internally approved)

Per the threat model: while the v1.2.0 Wave 8 hardening (C-02, M-01, H-01.2) closes the Chipotle integration's most critical bugs, **the supernodes currently still serve a signed-but-publicly-downloadable `usageKey` envelope to anyone who curls `/api/ddrm/provision`**. This lets an attacker (a) execute Lit Actions on Elacity's Chipotle quota (DoS or quota-exhaustion attack), and (b) potentially access the Chipotle dashboard if dashboard auth shares the key.

v1.2.8.0 demotes `/api/ddrm/provision` to no-key, adds a SIWE-authenticated `POST /api/ddrm/lit-action` endpoint that injects `X-Api-Key` server-side, with per-wallet + per-IP rate limiting. Three concrete file changes per the design doc at `.cursor/tasks/V1.2.8.0-CHIPOTLE-RELAYER/V1.2.8.0-CHIPOTLE-RELAYER.md`:

1. **Gateway** — `deploy/web-gateway/index.js`: add `POST /api/ddrm/auth-challenge` + `POST /api/ddrm/lit-action`; demote `/api/ddrm/provision` (Day 30, behind a feature flag)
2. **PC2 client** — `pc2-node/src/api/chipotle-client.ts`: new "Tier 0: relayer" path; existing Tier 1–4 becomes the fallback for legacy nodes during migration
3. **Adapter** — NEW `pc2-node/src/runtime/relayer-signer.ts`: wallet → SIWE signer interface, reusing the SIWE pattern from `wallet.js#siweLogin`

**Day 0**: relayer deployed; PC2 nodes opt-in via env var.
**Day 30**: `/api/ddrm/provision` drops the `usageKey` field behind feature flag.
**Day 60**: rotate the live `usageKey` per the rotation runbook.

### Other forward-looking work

- **`pc2-ipfs-relay` libp2p memory cure** — `maxConnections=256` + explicit `circuitRelayServer` caps; 24h RSS soak after deploy on each node
- **Continue the Elastos Runtime trust-layer build-out** — principal-root encryption (so guest data is private from the runtime operator), Recovery Kit (backup, restore, migration to another ElastOS runtime), continue removing shared `Users/self` assumptions
- **Continue the Chipotle keystore integration** (ELACITY-2219) — enable Chipotle read in player-side, especially for video minted from PC2; enable other content types
- **A8 — `/api/esc-rpc` TLS pinning** — blocked on DNS access for `elastossmartchain.ela.city`
- **Boson DID rotation** — Wave 4 secret scanner found a real Ed25519 private key committed at `4b10bad94`; queued as a v1.2.x patch pending input on what consumes the DID
- **Telemetry upstream forwarding (A5c)** — punted to v1.2.8.x, public-write endpoint security pass needed
- **`SUPERNODE-CLUSTER-PIN-SYMMETRY-V1281`** — Phase 3 work deferred from the supernode preflight
- **Compliance pack drafts (C2)** — GDPR DPA, SOC2 readiness, non-custodial legal opinion (founder + lawyer time, 0 eng-time)
- **B1 — `npx @elacity/create-capsule` scaffold** — 4 templates (`storefront`, `gated-content`, `nft-drop`, `agent-app`)
- **B2 — `@elacity/mcp-capsule-sdk` MCP server** — wraps the capsule CLI as JSON-RPC MCP server with 12 tools (Cursor / Claude Desktop / Continue.dev → local capsule SDK)

### What v1.2 sets the stage for (from the public launch post)

> _v1.2 brings the original idea closer: your data, your apps, your content, and eventually your AI agents should run under keys and permissions you control. The next areas to watch are: more first-party capsules in Runtime; a cleaner capsule SDK for outside developers; more dDRM content types and wallet flows; public capsule discovery through `apps.ela.city`; more of PC2 gradually moving toward the Runtime model._

---

## Summary Statistics

### PC2 Engineering — `Elacity/pc2.net` (Apr 26 – May 6)

| Metric | Value |
|--------|-------|
| Commits on `main` (non-merge) | **88** |
| Insertions | **36,199** |
| Deletions | **4,163** |
| Files changed | **370** |
| Branches active | `main`, `feature/lit-chipotle-migration` (40 commits), `feature/metadata-alignment` (32 commits), `release/v1.2-pre-release` (70 commits), `release/v1.2.6` (76 commits), `hotfix/v1.2.1` |
| Tagged releases | **18** (v1.2.0 + v1.2.1 → v1.2.7.13 + `pc2-binaries-v1`) |
| Days from v1.2.0 → v1.2.7.13 | **6** |
| Public launch announcement | May 1, Elastos blog |

### v1.2.0 Headline Numbers

| Metric | Value |
|--------|-------|
| Commits on top of v1.1.0 | **268** |
| Files touched | **1,251** |
| Capsules signed + IPFS pinned | **6/6** (Marketplace, Creator, Player, dDRM Viewer, Elastos NFT, Glide Finance) |
| External audit findings closed (jhond0e) | **7/7** |
| Internal audit findings closed | **20/21** (only A8 pending DNS access) |
| Security test cases passing | **79 across 5 specs** |
| First-party installable apps in dApp Centre | Elacity NFT + Glide Finance + bundled Elacity capsules |
| New Rust media engines | **2** (Elacity Player + Elacity Viewer/dDRM Viewer) |
| Login modes | Email (Particle Auth) + MetaMask + WalletConnect |

### Elastos Runtime 0.2.0

| Metric | Value |
|--------|-------|
| Tag | `0.2.0` |
| Branch | `review/0.2.0` (merged to main) |
| First-party capsules | **7** (System, Documents, Library, Inbox, Chat Room, GBA Emulator, uCity) |
| Authentication | Passkey-first |
| Permission model | Zero-by-default, capability-token-grant |
| Execution sandboxes supported | Native binaries, WASM, MicroVMs |
| Live deployment | [elastos.elacitylabs.com/apps/home/](https://elastos.elacitylabs.com/apps/home/) |
| Host platform support | Linux x86_64, Linux aarch64 (macOS + Windows planned) |
| PWA mode | "ElastOS Home" — fullscreen, touch icons, maximised windows |

### Elacity dDRM

| Stream | Status |
|---|---|
| ELACITY-2221 — Metadata alignment | ✅ landed (Protection V3 schema, lit-aes-gcm-v3 unified, directory-based IPFS storage) |
| ELACITY-2219 — Lit Chipotle keystore integration | **85%** (was 70% on Apr 29; integration of Lit Chipotle in keystore service complete on May 6) |
| ELACITY-2222 — V3 smart contracts on frontend | ✅ implemented |
| V2 ownership / fee-recipient migration | ✅ complete |
| Disabled GraphQL trackers (relying on events-watcher) | ✅ |
| ChannelCreated handler refinement | ✅ |
| ItemListed sync stale/crash fix | ✅ |
| nftitems mapping fix | ✅ |
| IPFS/storage API fix | ✅ |

### Launcher Engineering — `Elacity/elastos-launcher`

| Metric | Value |
|--------|-------|
| Releases shipped | **4** (v1.2.4, v1.2.5, v1.2.6, v1.2.7) |
| All Apple-signed + notarised | ✅ |
| All 3 platforms green per release | ✅ (mac / linux / win) |

### v1.2.7 Three Workstreams

| Workstream | What | Verified |
|---|---|---|
| SQLite migration | `better-sqlite3` → `@photostructure/sqlite` (Node-API) | ✅ 61 pinned_cids + 3 users + 3 sessions preserved on Jetson canary |
| IPFS Cluster pinning | Default URL + community shared token; 30 req/min per-IP rate-limited | ✅ 2/2 replication in 730ms on Jetson canary |
| RPC opt-in | `SUPERNODE_RPC_URLS=<your-alchemy>` documented | ✅ Mint flow succeeds with Alchemy RPC opt-in |

### Stealth-Mode Sprint Closures

| Step | Closes |
|---|---|
| v1.2.7.8 | `BinaryManager` pointed at non-existent release; readiness signal split |
| v1.2.7.9 | Sudoers auto-install for both `wg-quick` + `awg-quick` |
| v1.2.7.10 | Bundled bash 5; `WG_QUICK_USERSPACE_IMPLEMENTATION` via `sudo -E`; SETENV upgrade |
| v1.2.7.11 | Bundled `awg`; `findTool` → `findBinary`; PATH self-location patch; osascript apostrophe fix |
| v1.2.7.12 | Sudoers marker file (no re-prompt); upstream `awg-quick` `wg→awg` subcmd patch |
| **All three transports working on a fresh MacBook** | ✅ |

### Runtime Heartbeat Protocol (v1.2.7.13)

| Metric | Value |
|---|---|
| Heartbeat write interval | 2,000 ms |
| Launcher poll interval | 1,000 ms |
| Stale-after-ms | 5,000 ms (3 missed writes) |
| Restart-flag respawn delay | 3,000 ms |
| Schema version | `pc2.heartbeat.v1` |
| Backward-compat path | `/health` polling fallback |
| Protocol contract | `docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md` (303 LOC) |

### Supernode Preflight

| Metric | Value |
|---|---|
| Supernodes touched | InterServer + Contabo |
| Kubo upgrade | 0.34.1 → **0.41.0** |
| fs-repo migration | v16 → v17 → v18 |
| PeerIDs preserved | ✓ both |
| Mesh state after | **symmetric** — both peers `Sees 1` |
| Pin propagation latency | 5s round-trip |
| `pc2-ipfs-relay` Contabo RSS reduction | **9.6 GB → 227 MB** (42× reduction) |
| Memory cap deployed | 6 GB systemd `MemoryMax` on both |
| Total operator time | **~11 minutes** |
| User-impacting window | <1 minute |
| Snapshot retention | 7 days |

### PC2 Transport Binaries (v1)

| Metric | Value |
|---|---|
| Release tag | `pc2-binaries-v1` |
| Asset count | **22** |
| Apple-codesigned + notarised + stapled darwin natives | **10** |
| SHA-256 verification | Per binary, per platform |
| Workflow | `.github/workflows/publish-pc2-binaries.yml` |
| Build-time patches baked in | `wg→awg` subcmd rewrite, PATH self-location injection, bash shebang rewrite |

### Wave 8 Chipotle Hardening

| Finding | Severity | Closed |
|---|---|---|
| C-02 — CEK decrypt kid binding | Critical | ✅ |
| M-01 — Creator-controlled RPC ignored | Medium | ✅ |
| H-01.2 — Signed provision envelope | High | ✅ |
| MEDIA_DECRYPT CID re-pinned to Pinata + live-verify script | — | ✅ |
| Wave 8 task doc + rotation runbook + EOD status | — | ✅ |
| Post-Test-4 allowlist-miss runbook correction | — | ✅ |

### Companion Documentation

| Doc | Lines |
|---|---|
| `docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md` (NEW) | 303 |
| `docs/SYSTEM_MAP.md` (NEW) | 619 |
| `docs/core/DECENTRALIZATION_TRAJECTORY.md` (NEW) | 701 |
| `.cursor/tasks/SUPERNODE-HEALTH-PREFLIGHT-V1280/...` | 643 |
| `.cursor/tasks/V1.2.8.0-CHIPOTLE-RELAYER/...` | 472 |
| `pc2-node/src/utils/runtime-heartbeat.ts` (NEW) | 333 |
| Companion launcher `src/main/pc2Heartbeat.ts` (NEW) | 244 |

---

*This is an Elacity Labs team update for the World Computer Initiative (WCI) covering April 26 – May 6, 2026 (eleven days, due to the previous update having been published Apr 25 and last week's Friday slot missed for travel). The headline of the period is the **public launch of ElastOS v1.2 on May 1**, the convergence release across three workstreams: PC2 ships v1.2.0 (268 commits / 1,251 files of work consolidating four months of dDRM hardening, capsule packaging, supernode operations, and a closed external security audit); Elastos Runtime 0.2.0 goes live (Home as the front door, seven first-party capsules, passkey-first auth, zero-permissions-by-default capability model); and Elacity dDRM lands the metadata-alignment workstream (Protection V3 schema, unified `cenc:lit-aes-gcm-v3` system, V3 smart contracts on the frontend, Lit Chipotle keystore integration to 85%). The six days that followed launch were a positive feedback-driven follow-up cycle: thirteen point releases (v1.2.1 → v1.2.7.13) closing every reported issue in hours, including the full SQLite migration that drops the Xcode CLT first-run blocker, the IPFS Cluster install-and-works default that turns every fresh community node into a contributor to global durability, the channel-management + on-chain plans batch via the V3 `SubscriptionModule`, the stealth-mode sprint that brings vanilla WireGuard, AmneziaWG, and VLESS Reality up cleanly on fresh MacBooks, and the Runtime Heartbeat Protocol that survives every kind of pc2-node respawn. Four Apple-signed Launcher releases shipped alongside (v1.2.4 → v1.2.7), and the new PC2 transport binaries (v1) release pipeline now ships 22 SHA-256-verified, Apple-notarised assets to every fresh install. Both supernodes were upgraded to Kubo 0.41.0 with full mesh restoration. **Running in parallel underneath all of this** was the second leg of the CEO's continuous road trip — 11 days, 17 events, 9 industries, $0 in tickets, Bitcoin Week 2026 final days in Vegas plus Miami Bitcoin & RWA Week, with ElastOS Runtime v1.2 shipping Friday May 1 from a Vegas hotel room while the team executed the release. **The thesis sharpened materially mid-trip:** *"Securitize tokenises real-world securities. Elacity tokenises real-world rights — royalties, licensing fees, revenue shares. Same playbook, different asset class. The interesting part: rights are productive assets. They pay native, uncorrelated yield."* The single best framing: **v1.2 is the release where the desktop, the app store, dDRM, identity, payments, and runtime permissions start to connect in a way normal users can actually try — and the six days after launch was the team putting that promise through its first real production users, fix by fix, hour by hour, with the CEO 2,000 miles from the team holding partnership conversations in parallel.***
