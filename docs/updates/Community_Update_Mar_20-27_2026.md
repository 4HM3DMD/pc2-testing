# ElastOS PC2 — Weekly Community Update
## March 20–27, 2026

> **51 commits** across all branches | **~34,000 lines added** | **~10,500 lines removed** | **189 files touched**

---

## Table of Contents

1. [The Big Picture — What Happened This Week](#the-big-picture)
2. [Creator Dashboard — From Upload to On-Chain Mint](#creator-dashboard)
3. [Elacity Market — Apple-Grade Redesign](#elacity-market-redesign)
4. [AI Agent Skills System — Teaching Your Node New Tricks](#ai-agent-skills-system)
5. [Runtime v2 Convergence — Building the Bridge to Capsules](#runtime-v2-convergence)
6. [Secure Backup & Restore — Your Mnemonic Is Your Identity](#secure-backup--restore)
7. [Voice Interface & Multi-Agent Communication](#voice-interface--multi-agent)
8. [A2UI Canvas — Agent-Driven Desktop Windows](#a2ui-canvas)
9. [Product Consolidation — Walk-Away Independence](#product-consolidation)
10. [Security — Shell Escape Fix & Upstream Audit](#security)
11. [Post-Quantum Cryptographic Audit](#post-quantum-audit)
12. [System Readiness & Installation Improvements](#system-readiness--installation)
13. [Codebase Health & Quality](#codebase-health--quality)
14. [Documentation & Strategy](#documentation--strategy)
15. [Upstream Puter Contributions](#upstream-puter-contributions)
16. [What's Next](#whats-next)

---

## The Big Picture

This was one of the most productive weeks in the project's history. The team shipped a complete creator-to-consumer publishing pipeline, redesigned the marketplace from scratch, built an AI skills system, prepared the codebase for Elastos Runtime v2 capsules, and hardened security from post-quantum cryptography down to shell escape vulnerabilities.

**In plain English:** We built the tools that let anyone create digital content, protect it with encryption, sell it on a marketplace, and have AI agents help manage everything — all running on your own personal computer, not someone else's server.

---

## Creator Dashboard — From Upload to On-Chain Mint

**Why this matters:** Before this week, creators could upload files but the publishing pipeline was incomplete. Now there's a full end-to-end flow: pick a file, set your price, encrypt it, mint it on-chain, and list it on the marketplace. This is the foundation of the Elacity economy — creators earning from their work without middlemen.

**What was built:**

### The Publishing Pipeline (Mar 23)
The Creator Dashboard now has a complete 3-step wizard:

1. **File Selection** — Pick any file (video, audio, image, PDF, text, AI model). The system auto-detects the category from the file type (e.g., an MP4 is automatically tagged "Video", a `.md` file tagged "AI Agent Skill").

2. **Metadata & Pricing** — Set your title, description, price, and currency (USDC, USDT, or ETH). The system auto-generates thumbnails: for video it extracts a frame, for audio it creates a waveform placeholder, for PDFs it renders the first page, for images it creates a resized blur-overlay preview.

3. **Encrypt & Mint** — Your content is encrypted using Lit Protocol (so only buyers can decrypt it), uploaded to IPFS (decentralized storage), and minted as an on-chain token on Base blockchain. The revenue split is enforced: 95% to creator, 5% platform fee.

**How it works under the hood:**
- Content is packaged into an `elacity-asset-envelope-v1` metadata standard — think of it like a shipping label that tells the marketplace everything about the asset: what it is, who made it, how much it costs, and cryptographic proof that it hasn't been tampered with.
- A SHA-256 hash of the content is stored in the metadata, so buyers can verify they got the real thing (not a modified copy).
- Legal attestation is cryptographically signed — when a creator checks "I own this content", a hash of that declaration is stored permanently.
- Preview clips are generated using FFmpeg (for video/audio) with configurable duration.
- Everything uploads to both the Elacity IPFS network (for marketplace visibility) and the creator's local Helia node (for sovereign backup).

### Publish Queue & Drafts System (Mar 23)
**Why:** Publishing can take time (encryption, upload, on-chain minting). If something fails halfway, you shouldn't have to start over.

**What:** A draft system that auto-saves your progress at each pipeline checkpoint. If your internet drops during IPFS upload, or if you want to come back tomorrow — your draft is waiting. The drafts show up in the toolbar with a badge count, and you can resume, cancel, or sign any pending draft.

**How:** A new database table (`migration 21`) stores draft state. A REST API (`/api/drafts`) manages CRUD operations. The toolbar `UIMintButton` shows a drag-and-drop upload zone plus a draft queue with sign/cancel actions.

### Gateway Approval Fix (Mar 23)
**Why:** When creators minted content, the system sometimes reported "Content is live!" even when the gateway approval actually failed. This was dishonest UX.

**What:** The approval flow now uses on-chain fallback verification (`operativeOf`) when receipt parsing misses the operative address, and the result screen honestly reports the real status — success or failure.

### AI Training Licensing (Mar 24)
**Why:** As AI becomes central to content creation, creators need to decide whether their content can be used to train AI models. This is a first-of-its-kind feature in decentralized publishing.

**What:** A new section in the Creator Dashboard lets creators toggle "Allow AI Training". When enabled, it reveals detailed settings:
- **Training scope** — what the content can train (e.g., language models, image generators)
- **Model types** — which kinds of AI models can use it
- **Derivative works** — whether AI outputs based on the content are allowed
- **Output ownership** — who owns what the AI creates

**How:** The licensing data is embedded in the metadata envelope. It's backward-compatible — assets published without AI settings simply omit the licensing block. A "AI Training Allowed" badge appears on marketplace cards so buyers know at a glance.

### Adult Content Filtering (Mar 24)
**Why:** A real marketplace needs content moderation tools. Rather than centralized censorship, we give creators the power to flag their own content, and users the power to filter.

**What:** Creators can toggle an adult content flag when publishing. The marketplace shows an 18+ badge on flagged content and provides a filter chip: off = normal content only, on = adult content only. This keeps the default feed clean while still allowing adults to access legal content.

---

## Elacity Market — Apple-Grade Redesign

**Why this matters:** The marketplace is the storefront for the entire Elacity economy. If it looks amateur, nobody trusts it with their money. This week, the market received a complete 16-phase UI/UX overhaul following Apple Human Interface Design principles.

**What changed (Mar 23):**

### Visual Design System
- **CSS Design Tokens** — A unified set of colors, motion timings, shadows, and border radiuses. Think of these as the "brand DNA" that ensures every button, card, and modal looks consistent. These are shared with the Creator Dashboard so both apps feel like one product.
- **30+ inline styles replaced with CSS classes** — The code is now maintainable and themeable.

### Card System
- Maximum 2 badges per card (keeps it clean, not cluttered)
- Hover and click micro-interactions (subtle scale, shadow changes)
- Skeleton shimmer loading (those animated gray placeholders you see on loading screens)
- IntersectionObserver infinite scroll (loads more content as you scroll, no "Load More" button)
- Colored placeholder thumbnails for assets without images

### Transitions & Animations
- Cross-fade (200ms) between views
- Slide-in/slide-out from the right (300ms) for detail views
- All animations respect `prefers-reduced-motion` — if a user has motion sensitivity settings enabled in their OS, animations are disabled

### Detail View
- Spatial zones — the page is divided into logical sections (hero, about, market data, governance)
- Collapsible sections for About, Market info, and Governance
- Buy button state machine with 5 states: idle → waiting → confirming → success → error. Each state has distinct visual feedback.

### Search & Discovery
- 300ms debounce on search (waits 300ms after you stop typing before searching — prevents hammering the backend with every keystroke)
- Recent searches saved in localStorage
- Single-row filter chips for the feed
- Library segmented control: All / Downloaded / Not Downloaded — with actual IPFS pin checking to show what's really on your node

### Accessibility (WCAG 2.1 AA)
- ARIA roles on all interactive elements (screen readers can navigate the marketplace)
- Keyboard navigation throughout
- Contrast audit to ensure text is readable
- Modal system with proper `role=dialog`, `aria-modal`, Escape key handlers

### Bug Fixes
- Non-media assets (images, PDFs) no longer try to open in the video player (which caused 404 errors)
- Progress labels in the Creator now properly sync with the actual pipeline status
- Legal toggle in Creator was completely unwired (clicking did nothing) — now properly connected

---

## AI Agent Skills System — Teaching Your Node New Tricks

**Why this matters:** Right now, AI agents on your node have a fixed set of abilities. The Skills System lets you extend what your agent can do — like installing apps on your phone, but for AI capabilities. And because skills are distributed through the Elacity marketplace, creators can sell AI skills as digital assets.

**What was built (Mar 25–26):**

### Phase 1: The Foundation (Mar 25)
- **SKILL.md format** — Skills are defined as Markdown files with YAML frontmatter (metadata at the top). Each skill specifies its name, description, what tools it needs (e.g., file access, wallet operations), and what permissions it requires.
- **4 bundled skills** shipped out of the box:
  1. **Wallet Operations** — helps your agent manage crypto transactions
  2. **File Management** — helps your agent organize your files
  3. **System Admin** — helps your agent manage your node settings
  4. **Elacity Market** — helps your agent browse and interact with the marketplace
- **Skill loader** — When an agent starts, it reads the skills directory, parses the frontmatter, and injects the skill instructions into the AI's system prompt. The agent literally learns new abilities.
- **Agent Editor UI** — A new Skills section in the Agent Editor where you can toggle individual skills on/off per agent, with warnings if a skill requires permissions the agent doesn't have.

### Phase 2: Security & Verification (Mar 25–26)
- **SHA-256 hash verification** — Every skill is hashed when loaded. Bundled skills are checked against known-good hashes. If someone tampers with a skill file, the system catches it. (Currently warn-only in v1.x, will be enforced in v2.)
- **Trust boundaries** — Each skill is wrapped with metadata about its source, allowed tools, and security guardrails. This prevents prompt injection (where a malicious skill tries to trick the AI into doing something dangerous).
- **Audit logging** — A new `agent_audit_log` database table records every skill load and message processed. There's a `GET /api/gateway/audit` endpoint to review logs, and automatic 30-day cleanup.

### Phase 3: Marketplace Integration (Mar 26)
- **Purchased skills via dDRM** — Skills bought through the marketplace go through the decrypt pipeline before loading. You can sell AI capabilities as encrypted digital assets.
- **Skill discovery tools** — Agents can list and describe available skills, enabling agent-to-agent skill recommendations.
- **"AI Agent Skill" content category** — A new category in the Creator Dashboard with auto-detection for `.md` skill files.

---

## Runtime v2 Convergence — Building the Bridge to Capsules

**Why this matters:** Elastos is building a next-generation Runtime (v2) based on Anders' capsule model — isolated containers where apps run securely without trusting the host. PC2 v1.x needs to be forward-compatible so that when Runtime v2 launches, migration is seamless rather than a painful rewrite.

**What was built (Mar 25):**

Five convergence items that make PC2 ready for capsules without breaking anything today:

1. **Prompt-level sandboxing** — Skills are wrapped with trust boundaries (source, tools, security guardrails) via a `LoadedSkill` interface. This mirrors how capsules will sandbox applications.

2. **SHA-256 hash verification** — Every skill gets hashed on load. Bundled skills are verified against known-good hashes. This mirrors how capsules verify code integrity before execution.

3. **Audit logging** — The `agent_audit_log` table and API endpoint establish the observability layer that capsule runtimes require.

4. **App capability manifests** — All 7 app.json files were enriched with `api_endpoints`, `postMessage_events`, and `external_services` fields. These document the exact API contract each app uses — which is what capability tokens in Runtime v2 will enforce.

5. **Namespace alignment** — A `NAMESPACE_MAPPING.md` document maps every PC2 v1 path to the `localhost://` URI scheme that Runtime v2 will use. The `GatewayService` now validates agent workspace paths and warns on non-standard patterns.

**In plain English:** We added security fences, verified identities, kept records, documented what each app is allowed to do, and mapped out addresses — all the things you need before moving into a more secure neighborhood (Runtime v2).

---

## Secure Backup & Restore — Your Mnemonic Is Your Identity

**Why this matters:** If you lose your computer, or your hard drive dies, you need to recover your PC2 node — your files, your agents, your identity. Previously, backups contained your identity in plain text, which meant anyone who stole your backup could impersonate you. This redesign makes your 12-word mnemonic phrase the key to everything.

**What was built (Mar 26):**

### The New Model
- **v2 nodes** (newly created) generate a mnemonic first, then mathematically derive all cryptographic keys from it. Your 12 words ARE your identity — everything else is computed from them.
- **v1 nodes** (existing) are grandfathered in — their keys were generated independently of their mnemonic, so they continue working as before.

### Encrypted Backups
- v2 backups encrypt `identity.json` into `identity.enc` using AES-256-GCM (military-grade encryption). Even if someone steals your backup file, they can't use it without your mnemonic.
- Backups now include installed apps and agents directories — a full snapshot of your digital life.

### Restore Flow
- **Setup wizard integration** — A "Restore from Backup" button with drag-and-drop upload on the first screen you see.
- **Two-step flow** — Upload and validate, then enter your mnemonic to decrypt (for v2 backups).
- **Identity conflict detection** — On startup, the node checks if someone else registered with the same identity on the gateway. If so, it auto-re-registers to reclaim ownership.
- **Disk-based upload** — The backup file is written to disk during upload rather than held in memory, preventing out-of-memory crashes on large backups.

### Safety Gate
- The setup wizard now requires you to check "I have saved my recovery phrase" before the login button becomes active. No more accidentally skipping past the most important screen.

### Testing
- 32 automated tests covering the full backup-restore cycle, including edge cases like wrong mnemonic, corrupted files, and v1-to-v2 upgrade scenarios.

---

## Voice Interface & Multi-Agent Communication

**Why this matters:** Typing is slow. Talking is natural. And a single AI agent can't be an expert at everything — sometimes it needs to ask another agent for help.

### Voice Interface (Mar 26)
**What:** You can now talk to your AI agent instead of typing.

**How it works:**
- **Browser side** — Uses the Web Speech API (built into Chrome/Firefox) for speech recognition (your voice → text) and speech synthesis (text → the agent's voice). A waveform visualization shows when the agent is listening.
- **Server side** — Whisper (OpenAI's speech-to-text model) for more accurate transcription, and Piper (an open-source text-to-speech engine) for natural-sounding responses.
- **Conversation mode** — Toggle voice mode, speak naturally, see a waveform visualization, and hear the agent read its responses aloud.

### Multi-Agent Communication (Mar 26)
**What:** Agents can now talk to each other. If your "File Manager" agent needs market data, it can delegate the task to your "Market" agent.

**How it works:**
- Two new tools: `agents_list` (see all available agents) and `agent_delegate` (send a task to another agent).
- **Depth-limited to 1 hop** — Agent A can ask Agent B for help, but Agent B can't then ask Agent C. This prevents infinite delegation loops.
- Each delegation uses the target agent's own personality ("soul") and AI model, so specialization is preserved.

---

## A2UI Canvas — Agent-Driven Desktop Windows

**Why this matters:** AI agents shouldn't be limited to text chat. Sometimes the best way to show information is a dashboard, a chart, or an interactive widget. The A2UI (Agent-to-UI) Canvas lets agents create actual desktop windows with custom content.

**What was built (Mar 26):**
- Agents can create, update, and remove desktop windows via Socket.IO events (`canvas_create`, `canvas_update`, `canvas_remove`)
- Windows render inside sandboxed iframes (`iframe_srcdoc`) for security — the agent's HTML can't access your main desktop
- Dark-theme base styles match the desktop aesthetic
- A bundled "Canvas Dashboards" skill teaches agents best practices for creating useful widgets

**In plain English:** Your AI agent can now pop up a window on your desktop showing whatever it thinks is useful — weather, portfolio stats, system health — like having a personal assistant who can put sticky notes on your screen.

---

## Product Consolidation — Walk-Away Independence

**Why this matters:** "Walk-away independence" means the system keeps working even if any single external service goes down. This week we eliminated several single points of failure.

**What was built (Mar 23):**

### RPC Fallback (Phase 1)
**The problem:** Every blockchain operation (minting, buying, checking ownership) needs an RPC endpoint — a gateway to the blockchain. We were using a single hardcoded one. If it went down, everything broke.

**The fix:** A new `rpc.ts` utility with 5 public Base RPC endpoints. Round-robin selection distributes load, and automatic failover means if one endpoint fails, the next one takes over instantly. All three files that previously had hardcoded RPCs (`storage.ts`, `chipotle-client.ts`, `dashPackager.ts`) now use this shared utility.

### Disk Quota Enforcement (Phase 2)
**The problem:** Your node seeds content to the P2P network (sharing files with other nodes). Without limits, this could fill up your hard drive.

**The fix:** `ContentSeedingService.isQuotaExceeded()` checks actual disk usage against a configurable quota (default: 50% of disk). When the quota is hit, the seeding queue pauses. When space is freed, it resumes.

### Bandwidth Enforcement (Phase 2)
**The problem:** If your node becomes popular and many people download from you, it could saturate your internet connection.

**The fix:** A `bandwidthGuard` middleware on all IPFS gateway routes. It tracks bytes served in a rolling 5-second window and returns "503 Service Unavailable" with a retry timer when the configurable limit is exceeded (default: unlimited).

### P2P Content Discovery (Phase 2)
**What:** Every content listing now includes an `is_local` flag showing whether the file is actually stored on your node. A new `/api/catalog/providers/:cid` endpoint queries the DHT (distributed hash table) to count how many nodes in the network have a copy of any given file.

### Creator Analytics (Phase 2)
**What:** A new `/api/catalog/creator/:address` endpoint that returns comprehensive stats for any creator: total assets, breakdown by type, which ones are locally pinned, total downloads served, and total bytes transferred.

### Lit Protocol Chipotle Updates
All 4 Lit Action scripts were updated for the new `main(params)` pattern required after the TEE (Trusted Execution Environment) restart. Action CIDs were re-registered and PKP keys re-added to the access control group.

---

## Security

### Shell Escape Vulnerability Fix (Mar 25)
**What was wrong:** The `HostDiskUsageService` used `execSync()` to run shell commands for checking disk space. The directory path came from user input — meaning a malicious user could inject shell commands (e.g., `; rm -rf /`).

**What was fixed:** Replaced `execSync` (which passes everything through a shell) with `execFileSync` (which passes arguments as an array, no shell interpretation). All 6 shell commands in the service were patched. Zero new dependencies — our fix is actually cleaner than upstream Puter's fix which added an NPM package called `shescape`.

### Upstream Audit (Mar 25)
We reviewed all 1,493 commits to the upstream Puter repository since we forked. Only this one security fix was worth porting back. Everything else was either cloud-centric auth, diverged filesystem/GUI code, or centralized patterns incompatible with PC2's sovereignty model.

---

## Post-Quantum Cryptographic Audit

**Why this matters:** Quantum computers are coming. When they arrive (estimates: 2030–2035), they'll be able to break many of the encryption algorithms we use today. We need to know exactly which parts of our system are vulnerable and have a plan to fix them.

**What was done (Mar 25):**

A complete audit of every cryptographic primitive used in PC2, mapped by trust boundary:

- **Shor-broken** (quantum computers will break these): ECDSA signatures, ECDH key exchange, secp256k1 (used by Ethereum/wallets). These all need migration to post-quantum alternatives.
- **Grover-weakened** (quantum computers weaken but don't break): AES-128-CTR (used only for media CENC — it's a standard requirement, not our choice). AES-256-GCM is safe.
- **Unaffected** (quantum-safe today): SHA-256 hashes, AES-256 encryption, HKDF key derivation.

### Key Finding: Lit Protocol Is the Biggest Risk
Lit Protocol is our single largest post-quantum AND centralization risk. It's a third-party service we depend on for encryption key management. The audit produced a progressive replacement strategy:

1. **Dual-write** — Start storing encryption keys in both Lit and a new sovereign system
2. **PC2 primary** — Switch to PC2-native key custody, keep Lit as backup
3. **Walk-away** — Remove Lit dependency entirely

The sovereign replacement is a Rust crate called `elastos-keycustody` using Shamir Secret Sharing + ML-KEM-768 (a NIST-approved post-quantum algorithm), compiled to `wasm32-wasip1` — the same binary format that will run inside Runtime v2 capsules.

**The "Three-in-One" insight:** Replacing Lit Protocol, migrating to post-quantum crypto, and building Runtime v2 capsule support are actually the same piece of work. One effort accomplishes three goals.

---

## System Readiness & Installation Improvements

### System Readiness Check (Mar 26)
**Why:** When users install PC2, they need various system dependencies (IPFS, database, transport binaries). If something is missing, the system should tell you — not just silently fail.

**What:**
- A new `GET /api/system-readiness` endpoint (no authentication required) that checks: database status, IPFS status, and transport binary availability (wireguard-go, amneziawg-go, awg-quick, sing-box).
- A compact status badge on the login screen (bottom-right) showing "X/Y Ready" with green/amber color.
- Click to expand and see exactly which dependencies are present or missing.
- After login, if fixable items exist, a one-click "Install missing binaries" button.

### WSL Support (Mar 26)
**Why:** Many users run Windows, and WSL2 (Windows Subsystem for Linux) is the best way to run PC2 on Windows. But the existing installer didn't handle WSL's quirks.

**What:**
- A dedicated `install-wsl.sh` script that validates the WSL2 environment, detects/enables systemd, installs `node-pty` build dependencies, handles transport binaries, and sets up PM2 persistence (with `.bashrc` fallback when systemd is unavailable).
- A comprehensive `WSL_GUIDE.md` with prerequisites, systemd setup, memory configuration, and troubleshooting.
- The main `start-local.sh` now detects WSL and recommends the WSL-specific installer.

### China Installation Fix (Mar 27)
**Why:** Team members in China were unable to install PC2 because `git clone` failed with HTTP/2 stream errors — a common problem caused by the Great Firewall interfering with GitHub connections.

**What:**
- The installer now forces Git to use HTTP/1.1 (more reliable through firewalls)
- Increases the Git buffer size to 500MB (handles large repos better)
- Tries a shallow clone first (`--depth 1`) — much smaller download
- Falls back to full clone if shallow fails
- Provides China-specific troubleshooting: GitHub proxy mirrors, ZIP download link

### Setup Wizard Improvements (Mar 26–27)
- **Mnemonic safety gate** — Login button disabled until user confirms they saved their recovery phrase
- **Step flow fix** — Fresh installs always show the welcome screen first (with restore button visible) instead of auto-skipping
- **Streamlined HTML** — Cleaner, more responsive wizard layout

### Docker Multi-Stage Build (Mar 27)
- Transport binaries (wireguard-go, amneziawg-go, sing-box) are now bundled directly into the Docker image via a multi-stage build. No more downloading binaries at runtime.

### App Icons & Desktop Cleanup (Mar 27)
- Custom SVG icons for Wallet Bridge, Supernode Manager, Elacity Creator, and Elacity Player
- Runtime-only apps (elacity-player, pc2-media-runtime, ddrm-viewer) are now hidden from the desktop via a `"hidden"` flag in app manifests. They still exist — they're just not cluttering the desktop. They launch automatically when needed (e.g., when you play a video).
- Dark mode toggle added to Settings

---

## Codebase Health & Quality

### Spring Cleaning (Mar 26)
**Net result: -407 lines of code, zero new dependencies, TypeScript compiles clean.**

What was cleaned:
- **306 lines of dead code removed** from `static.ts` (commented-out handler that was never coming back)
- **Duplicate API route removed** — an unreachable `GET /api/catalog/creator/:address` that was shadowed by an earlier definition
- **DRY refactor** — The `parseSkillFrontmatter` function existed identically in 3 files (`gateway.ts`, `ChannelBridge.ts`, `ToolExecutor.ts`). Extracted to a single shared `utils/skill-parser.ts`.
- **Health endpoint bug fix** — The `/health` endpoint always reported terminal status as "not available" because `require('./terminal.js')` didn't export `getTerminalService`. Fixed the import.
- **Silent catch blocks** — 3 fire-and-forget `.catch(() => {})` blocks in BosonService, ipfs.ts, and ConnectivityService now log at debug level for traceability.

---

## Documentation & Strategy

### ElastOS Agent Reference (Mar 26)
A comprehensive 484-line reference document for the marketing agent system covering:
- The complete why/how/what of ElastOS
- Ready-to-use talking points for different audiences
- Competitive positioning against centralized alternatives
- Historical analogies (feudalism → guilds → fiat money → digital sovereignty)
- Objection handling for common skepticism
- Audience-specific angles (developers, creators, investors, regulators)

### Rong's Binary Attack Thesis (Mar 26)
Detailed explanation of two complementary security models:
- **AppCapsule self-verification** (inside-out trust) — The app itself verifies it hasn't been tampered with
- **Elastos Runtime sandboxing** (outside-in trust) — The runtime environment restricts what the app can do

Combined, these create defense-in-depth. The document includes supply chain attack context and software trust evolution as historical analogy.

### Post-Quantum Audit Document (Mar 25)
242-line document mapping every cryptographic primitive in PC2 to its quantum vulnerability status, with a concrete migration roadmap.

### Namespace Mapping (Mar 25)
132-line document mapping every PC2 v1 path to the Runtime v2 `localhost://` URI scheme, establishing the namespace bridge for capsule migration.

### App Manifest Spec (Mar 25)
26-line spec defining the `app.json` schema with dDRM capabilities, forward-compatible with Runtime v2 capability tokens.

---

## Upstream Puter Contributions

PC2 is forked from the Puter open-source project. This week, several upstream contributions were noteworthy:

### Signed Upload System (Daniel Salazar, Mar 20)
6 commits building a complete signed upload pipeline:
1. Upload session foundation
2. Storage signing controller interfaces
3. Signed upload prepare/complete APIs
4. Default puter.js to signed single-part uploads
5. Signed multipart upload orchestration
6. Signed upload progress phases in GUI + session cleanup

### API Compatibility (Various, Mar 24)
- **Anthropic Messages API** compatibility layer (iamsrishanth) — Puter apps can now use the Claude API format
- **OpenAI Responses API** WIP support (ProgrammerIn-wonderland) — New response format from OpenAI
- **AI video generation refactor** (Shruc) — Cleaner code structure

### Platform Fixes (jelveh, Mar 21–22)
- Auth form layout improvements, Google icon, centered auth forms
- Peer icon and sidebar updates
- Login/signup excluded from temporary user creation
- App Store link fixes, default credits update

### Community Contributions
- AI voice changer playground example (Dailin)
- Documentation 404 fix for CreateAppResult (Vusal Huseynov)
- Canonical URL double-slash fix (Nandini Kashyap)
- Dead code and docs cleanup (Daniel Salazar)

---

## What's Next

Looking ahead, the immediate priorities are:

1. **V3 Contract Migration** — When new Elacity V3 contracts deploy, update ABIs and addresses in the Creator Dashboard
2. **Lit Protocol Mainnet** — When Chipotle goes to mainnet, update endpoints and test end-to-end
3. **Large File Encryption** — Verify the pipeline handles 4–70GB AI model files (GGUFs) with streaming encryption
4. **App Build Pipeline** — Vite build → static bundle → IPFS pin → CID → registry (the "App Factory")
5. **Content Intelligence** — Perceptual hashing and content fingerprinting for duplicate detection and rights management
6. **Runtime v2 Capsule Prototyping** — Begin building the `elastos-keycustody` Rust crate targeting `wasm32-wasip1`

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total commits (all branches) | 51 |
| Lines added | ~34,000 |
| Lines removed | ~10,500 |
| Net new lines | ~23,500 |
| Files touched | 189 |
| New services created | 4 (ContentIndexerService, ContentSeedingService, ContentIntelligenceService, rpc.ts) |
| New database migrations | 3 (#21 drafts, #22 audit log, #23 installed skills) |
| New documentation files | 6 (POST_QUANTUM_AUDIT, NAMESPACE_MAPPING, APP_MANIFEST_SPEC, ELASTOS_AGENT_REFERENCE, WSL_GUIDE, LIT_CHIPOTLE_MIGRATION) |
| New skills bundled | 4 (Wallet Ops, File Management, System Admin, Elacity Market) |
| Automated tests added | 32 (identity-restore cycle) |
| Security vulnerabilities fixed | 1 critical (shell injection), 1 cryptographic audit completed |
| Upstream commits reviewed | 1,493 |

---

*This update covers all work from March 20–27, 2026 across the `feature/lit-chipotle-migration` branch (primary development) and the `upstream/main` branch (Puter upstream contributions).*
