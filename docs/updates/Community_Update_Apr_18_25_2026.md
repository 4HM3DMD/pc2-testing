# Elacity Labs — Weekly Team Update for the World Computer Initiative (WCI)
## April 18 – April 25, 2026

> **ElastOS Runtime — desktop shell, hosted chat-room with web pairing, GBA emulator with save persistence, Essentials codebase fully audited (165 docs, ~869 findings), 5-phase frontend-overhaul plan locked** | **P0 Lit Action vulnerability closed end-to-end — session-key delegation cutover live across PDF/PNG/MP4/MP3** | **External security report triaged + 7 in-scope findings closed** | **Internal post-triage audit surfaced 21 additional findings — 7 hard-fix waves shipped (Waves 1–6)** | **gitleaks pre-commit + CI + push gates live** | **v1.2 adoption roadmap published** | **Standalone capsule packager + Ed25519 sign + IPFS pin for all 6 v1.2 apps** | **Both supernodes (InterServer + Contabo) now pin all 6 v1.2 capsule CIDs via Kubo with DHT provider records — global libp2p reachability verified via `ipfs.io` and Pinata** | **dApp Centre catalog cleanup — 15 fillers removed, 6 real apps with role: system\|dapp** | **Telemetry on-ramp pipeline shipped (4 funnel events, anonymous install ID, kill-switch, self-contained dashboard)** | **Audio-only DASH playback fix in pc2-media-runtime (MSE 'sequence' mode)** | **Founder on the ground at Google Cloud Next Vegas (35K attendees) — sovereign compute, AI compliance, and tokenised data-rights conversations landing in front of CISOs and enterprise CTOs** | **53 PC2 commits, 29,117 insertions, 8,733 deletions, 434 file changes**

### Key Links This Week

- **ElastOS Runtime** — [github.com/Elacity/elastos-runtime](https://github.com/Elacity/elastos-runtime)
- **Elastos Blockchain Explorer** — [https://blockchain.elastos.io/](https://blockchain.elastos.io/) (live since last week)
- **Install ElastOS Runtime** — `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash`

---

## Table of Contents

1. [The Big Picture — What Happened This Week](#the-big-picture)
2. [ElastOS Runtime — Desktop Shell, Hosted Rooms, GBA Emulator + Essentials Audit](#elastos-runtime--desktop-shell-hosted-rooms-gba-emulator--essentials-audit)
3. [P0 Lit Action Vulnerability — Session-Key Delegation Cutover (Closed End-to-End)](#p0-lit-action-vulnerability--session-key-delegation-cutover-closed-end-to-end)
4. [SEC-2026-04 — External Researcher Report + Internal Audit + 7 Hardening Waves](#sec-2026-04--external-researcher-report--internal-audit--7-hardening-waves)
5. [v1.2 Adoption Roadmap — The Full Strategic Plan](#v12-adoption-roadmap--the-full-strategic-plan)
6. [Capsule Packager + Sign + IPFS Pin (§P1)](#capsule-packager--sign--ipfs-pin-p1)
7. [Supernode Pinning + dApp Centre Cleanup (§P1.6)](#supernode-pinning--dapp-centre-cleanup-p16)
8. [Telemetry On-Ramp Pipeline — A5 + A5b (§P0)](#telemetry-on-ramp-pipeline--a5--a5b-p0)
9. [Audio-Only DASH Playback Fix](#audio-only-dash-playback-fix)
10. [Runtime-Player UI Polish — Elacity Dark Palette](#runtime-player-ui-polish--elacity-dark-palette)
11. [Networking & Outreach — Google Cloud Next + 4-Week Outreach Trip](#networking--outreach--google-cloud-next--4-week-outreach-trip)
12. [Elastos Blockchain Explorer — In Production](#elastos-blockchain-explorer--in-production)
13. [Smart Contracts — V3 Live + Ownership Migration](#smart-contracts--v3-live--ownership-migration)
14. [What's Parked & What's Next](#whats-parked--whats-next)
15. [Summary Statistics](#summary-statistics)

---

## The Big Picture

This week was about **closing the dDRM P0 the community surfaced, surviving an external security audit with all 7 in-scope findings shipped, executing a comprehensive internal sweep that found 21 more issues in the same families, and folding the highest-leverage post-v1.2 work directly into the v1.2.0 binary now that engineering blockers are clear**:

1. **A community member reproduced a P0 dDRM vulnerability on April 17** — the legacy non-media Lit Action trusted `userAddress` from `jsParams`, so anyone could call the immutable IPFS-loaded action with any authorised buyer's address and receive the CEK. By April 21 the **session-key delegation fix (Option C)** was live across PDF / PNG / MP4 (AV1+AAC) / MP3 (AAC), end-to-end verified. Buyer signs **one** EIP-191 delegation per 24h authorising a non-extractable, device-bound P-256 key — every subsequent asset open is signed silently. Zero wallet popups per asset. The Lit Action TEE is now the trust anchor; PC2 only forwards bytes.

2. **An external security researcher submitted an 11-finding report on April 18** — 7 belonged to this codebase (PC2 node + web-gateway), 4 to the smart-contracts repo, 1 deferred. **All 7 in-scope findings closed across 4 waves in 2 days** (Waves 1–4): SIWE auth on `/auth/particle`, setup-wizard lockdown, vless RCE killed via argv form, gateway provisioning tokens, gitleaks pre-commit + CI + push gates. The full disposition published as `SEC_2026_04_21_AUDIT_DISPOSITION.md` (457 lines, 1:1 finding↔fix mapping).

3. **A post-triage internal audit (the same week) surfaced 21 additional findings of the same families** — `execSync` with shell-string interpolation, missing `requireOwner`, cross-wallet data leaks. Four more waves shipped (Waves 5, 5.5, 6 part 1, 6 part 2): A1–A19, including 3 Critical (A1 terminal RCE, A3 backup-mnemonic exfil, A17 app-install RCE), 5 High (A2 git RCE, A4 cross-wallet file read, A5 voice install, A11 SSRF DNS-rebind, A19 multer traversal), and 7 Medium. **Only A8 (`/api/esc-rpc` TLS pinning) remains parked — blocked on DNS access for `elastossmartchain.ela.city`, not a code blocker.**

4. **The strategic v1.2 → v2 adoption roadmap landed** — `docs/core/V1.2_ADOPTION_ROADMAP.md` (1,082 lines), ranking every post-v1.2 item against the Bible's 4-layer thesis (Runtime / Capsule SDK / dDRM Protocol / PC2), the Acquire/Activate/Amplify/Accrue loop, audience (Creators/Devs/Users/Enterprise), and effort. Tier A (must-ship-in-v1.2.0) / Tier B (queue for rc2) / Tier C (parallel off-codebase) — every item mapped to a Bible commandment, a metric the PR moves, and a concrete DoD.

5. **Tier A engineering for v1.2.0 is now fully complete** — A1 (smoke helpers), A2 (sign + IPFS-pin all 6 apps with the Elacity Labs Ed25519 key), A3 (`role: system|dapp` field in `AppManifest`), A4 (Kubo daemon on both supernodes + 6 capsule CIDs pinned via deterministic CAR import + DHT provider announce), A5 (telemetry endpoint + table + dashboard), A5b (4 event hooks wired into real flows). The only Tier-A item left is A6 brand-icon swap — blocked on design assets (~1 hour eng-time once they arrive). **No code work blocks the v1.2.0 tag.**

6. **The supernode app-store layer is now operational worldwide.** Both InterServer (authoritative) and Contabo (mirror) run a Kubo daemon as systemd unit (`MemoryMax=2G`, `StorageMax=8G`, swarm port 4101, `routing=dhtserver` so they advertise as providers). All 6 v1.2 capsule CIDs are pinned on both. Public-gateway probes (`ipfs.io`, Pinata) confirm any PC2 node anywhere on Earth can fetch v1.2 capsule bytes via libp2p bitswap.

7. **The dApp Centre catalog was audited and cleaned up** — 9 filler "Coming Soon" cards removed, 6 real apps remain (Market, Creator, Player, dDRM Viewer as `role: system`; Elastos NFT, Glide Finance as `role: dapp`). Boot sync now only auto-installs `system` apps; cleanup pass removes stale `local:` installs of non-system apps. Sidebar restructured to ship categories (Marketplace / Media / DeFi / Blockchain / Tools / System). Icon resolution fallback chain added in the launcher merge so missing icons fall back to favicon variants instead of broken images.

8. **Telemetry plumbing for the four metrics that matter** — `install_started → wallet_ready → first_capsule_open → first_payment`. New `POST /api/telemetry/onramp` (owner-only) + `GET /summary` (public, counts only) + `telemetry_onramp` SQLite table + indexes (migration 30) + self-contained `deploy/dash/onramp.html` (4 funnel cards + bar chart, auto-poll). Anonymous per-install UUID, never tied to wallet/email/IP, `PC2_TELEMETRY_DISABLED=true` kill-switch. Verified end-to-end across 3 of 4 hooks with real flows; idempotent across restarts.

9. **A real audio bug in pc2-media-runtime, surfaced from a console-log post-mortem on April 23, was diagnosed and fixed in one commit** — Bento4-packaged audio-only DASH content was stalling at ~0:39 because MSE's default `'segments'` mode interpreted the per-fragment `tfdt`/`baseMediaDecodeTime` resets as new buffered ranges. Fix: switch the audio `SourceBuffer` to `'sequence'` mode for audio-only streams. Applied to both the encrypted DRM path and the cleartext DASH path.

10. **The runtime-player apps were re-themed to the Elacity dark palette** — dDRM viewer + media player now share the same color tokens (background, surface, text, accent) as elacity-market and elacity-creator. 19 files changed, +37 / −431 — the deletion-heavy diff is the right shape for a UI consolidation pass.

11. **Founder is on the ground at Google Cloud Next in Vegas** (35,000 attendees, biggest enterprise cloud + AI conference of the year) — the rooms this week: a PwC agentic-AI session on enterprise AI compliance, a CISO networking dinner, an AI-infrastructure roundtable (Striim / Yugabyte / Dagster), and an Altimetrik-hosted senior-tech-leader dinner. The conversations: sovereign compute, security isolation, AI-compliance + accountability, and **tokenised data-rights for AI agents consuming data autonomously**. This is the start of a 5-event 4-week outreach trip (Bitcoin 2026 Vegas next, then Consensus Miami, the Digital Asset Yield Summit, the DAT Summit, and the FT Digital Assets Summit in London).

---

## ElastOS Runtime — Desktop Shell, Hosted Rooms, GBA Emulator + Essentials Audit

> _Runtime workstream this week. PC2 patterns explicitly cited as the design template, with PC2 ↔ Runtime convergence happening capsule-by-capsule per last week's `PC2_CONVERGENCE_INVENTORY_FOR_RUNTIME.md`._

**Why this matters:** ElastOS Runtime is converging into the desktop OS that every PC2 capability eventually plugs into. This week the system **started behaving like a real operating environment** rather than a set of demo capsules — native desktop shell as a WASM capsule, window/capsule manager, system manager (Elastos Manager), and a chat experience that works both inside ElastOS and from the public web via pairing.

### Desktop shell + window/capsule management

A native **WASM-capsule desktop shell** with proper window management, taskbar (open / search), system tray, and an Elastos-logo-launched control panel (the Elastos Manager). Patterns adopted from `puter` / `pc2.net` but rewritten from scratch as a WASM capsule so the runtime hosts everything uniformly through its capsule contract. Settings panel includes appearance toggles (dark mode, top-bar visibility), DID display, and global handle / name service surface.

### Hosted chat-room experience — fully integrated

The chat-room capsule is now polished, hardened, and **fully integrated with the runtime**. Two reachability modes:

| Mode | How |
|---|---|
| **Sovereign peer chat** | Each user runs the chat capsule on their own PC2 node, peers join over Carrier |
| **Public-gateway chat** | One node opts to **gateway-host** the room as a public service. External invitees visit a public URL, request to join, owner approves from the runtime activity feed. Messages stay end-to-end via Carrier; the gateway just relays. |

Refresh, ban-list / pending-approvals UI, and activity feed (e-book pending requests, approval flows) all working. The whole flow is Carrier-only — capsules never see HTTP.

### GBA emulator + media capsule integration

The GBA emulator capsule:
- **Save state persists across reopens** — fixed this week
- Cleaner game-content open flow
- **Cross-capsule discovery**: the emulator capsule auto-detects sibling capsules (mirror, media-player, viewer) and routes content to whichever is appropriate. Open a `.gba` file → emulator. Open a `.md` → markdown viewer. Open `.mp4` → media player capsule. Same model as the dDRM access-token pattern: the right capsule is invoked with the right access primitive.

### Carrier-as-HTTP, KVM tiering for security-sensitive capsules

Architectural confirmations from this week's call:
- **Capsules know only Carrier** — the runtime is the only thing that can choose to expose a capsule to phone networks, and only with explicit user consent
- **Three-tier hardware model**: most capsules run on light WASM isolation (no KVM, much faster, much leaner); security-sensitive capsules (signing screens, custodial flows) require microVM + KVM. The MVP for the desktop is on the light tier.
- **No Electron / Node.js bloat** in the desktop — it's a WASM capsule. Quick to load even on slower internet.

### Essentials codebase — fully audited

The Essentials codebase audit completed:
- **165 docs**, **~869 findings**
- Every module **line-annotated** with `file:line` references
- Every native plugin and build script documented
- Strategic guides for: UI/UX overhaul, dependency upgrade, accessibility, performance, governance
- **1 Critical finding** (no test infrastructure exists)
- ~24 High-severity issues
- **99.2% documentation integrity score**
- Research phase **settled**

### Frontend-overhaul plan — 5 phases

1. **Prep sprint**: install Jest harness, fix 10 P0 bugs, unify mnemonic + password handling into a single `SecureString` primitive, centralise URL trust into a signed config, remove production debug code, break up the 8 largest page files (incl. `coin-transfer.page.ts` at **1,717 lines**)
2. **Extract framework-independent services** into an `@essentials/core` npm package behind abstraction interfaces — UI layer can be replaced without touching custody logic
3. **Cordova → Capacitor**: ~10 community plugins swapped, **5 custom plugins rewritten** (dappbrowser + intent are heaviest)
4. **UI rebuild**: target stack **Capacitor + React + Radix + Tailwind + Zustand**, in this order — 6 signing screens first (highest-security surface), then wallet core, then voting, then launcher + settings. In parallel: Angular 13 → 18 one major version at a time, Ionic 6 → 8, ethers 5 → 6 (web3.js removed), WalletConnect v1 phased out
5. **Polish pass**: accessibility, responsive + RTL, performance baseline, security re-audit, staged rollout

### Other Runtime hardening this week

- Improved automated checks so problems surface before release
- Strengthened public-facing environment
- The "ElastOS Manager" boundary question (what belongs in Runtime control panel vs. Elastos Manager vs. desktop settings) is being worked through case-by-case rather than top-down
- Provider-capsule pattern under consideration: today the supernode (domain manager + VPN gateway + relay) is "outside" the system — the next iteration may model it as a provider capsule users can run themselves

### Where Runtime goes next (decided this week)

- **Foundation first** — make the desktop shell + capsule-management + integration solid before anything else
- **Then blockchain** — the 4-quadrant world-computer model (Carrier ✓ / PC2 ✓ / Runtime in flight / Blockchain next). Vanilla "Sign-In with Ethereum" as the bottom-layer fallback, Particle Network + Universal Accounts as an opt-in convenience capsule above it. **PC2's wallet-bridge pattern is the candidate template** for the Runtime wallet capsule (per the PC2 convergence inventory)

---

## P0 Lit Action Vulnerability — Session-Key Delegation Cutover (Closed End-to-End)

**Why this matters:** A community member reproduced a P0 dDRM exploit on the V1.2 pre-release call on April 17 — the legacy non-media Lit Action trusted `userAddress` from `jsParams`. Because Lit Action source loads from a public IPFS CID, anyone with their own PC2 node could call the action with **any authorised buyer's address** and receive the CEK. A 25-line Node script reproduced this, retrieved plaintext without holding an `AccessToken`. Without a fix, dDRM access control was bypassable forever.

By April 21 the fix was live, end-to-end verified across PDF / PNG / MP4 (AV1+AAC) / MP3 (AAC).

### Why Option C — session-key delegation

| | A: per-asset wallet sig | B: per-session wallet sig | **C: session key** |
|---|---|---|---|
| Wallet prompts/day | Many | 3-5 | **1** |
| "Double-click to open" | ❌ regression | ⚠️ partial | ✅ preserved |
| Closes current exploit | ✅ | ✅ | ✅ |
| Damage if one secret leaks | 1 asset, 60s | Library for 15m | Need **both** sig + non-extractable key |
| Dev effort | ~1.5d | ~2d | ~3.5d |

Community feedback from April 17 explicitly weighted UX: *"What one user said was how nice it was to just double-click and open a file."* Option C preserves that.

### Protocol summary

```
[Buyer wallet]
    │ EIP-191 personal_sign over canonical JSON:
    │   { actionIpfsId, ownerAddr, coveredAddrs[],
    │     sessionPubKey (raw P-256), expiresAt, nonce, chainId }
    ▼
[Browser]
   • crypto.subtle.generateKey({ extractable: false }) — P-256
   • CryptoKey object persisted in IndexedDB; private bits unreadable to JS
   • Lifetime 24 h, then hard re-prompt
    │
    │ For each asset open:
    │   Web Crypto signs: { kid, actionIpfsId, requestedAt, requestNonce }
    ▼
[PC2 server]
   • Defence-in-depth: verifies delegation EIP-191 sig (+ EIP-1271 for smart accounts)
   • Verifies request P-256 sig
   • Anti-replay cache on (sessionPubKey, requestNonce)
   • Forwards { delegation, delegationSig, request, requestSig } as jsParams
    ▼
[Lit Action TEE]   ← non-media-decrypt-chipotle.js / media-decrypt-chipotle.js
   • Re-verifies BOTH sigs (server cannot lie)
   • Asserts request.actionIpfsId === Lit.Actions.currentActionIpfsId  ← closes the original bug
   • Asserts requestedAt within ±60 s skew, expiresAt > now
   • Loops over delegation.coveredAddresses → hasAccessByContentId
   • Returns CEK only if a coveredAddress passes
```

### What shipped, in waves over 4 days (Apr 18 → Apr 21)

| Phase | Commit | What landed |
|---|---|---|
| **0** | `55cae7aba` | Exploit reproduction harness behind `ALLOW_SECURITY_TEST=1` + crypto-primitive spikes |
| **1** | (in `55cae7aba`) | EIP-191 + EIP-1271 + P-256 sign/verify primitives, replay cache |
| **2a** | `026d22fef` | Server-side session-key primitives (canonical JSON, sig verifier, replay cache, EIP-1271 path) |
| **2b** | `b206f05cc` | Session endpoints + defence-in-depth on `/lit/secure-view` |
| **2c** | `d4775c31f` | Forward signed bundle to Lit Action via `jsParams` |
| **2d** | `c135b2232` | Sigauth Lit Actions written + rollback env-var path |
| **2e + 3 + 4** | `30808a9c1` | `ddrm-viewer` client migration + regression spike + initial docs |
| **pin** | `4087ed006` | Sigauth Lit Actions pinned to IPFS, CIDs recorded |
| **5 + 6a** | `1cb13c3c5` | **Hard cutover** — `/lit/secure-view` returns `401 session_bundle_required` if no bundle attached. No legacy fallback. `userAddress` removed from `jsParams` entirely. Player.js migrated with two-phase 412 init for media. |
| **handover** | `1c93fc16a` | Engineer handover docs (`V12_SIGAUTH_HANDOVER.md`, `IRZHY_LIT_ACTION_FIX_V12.md`) + V1.2 release task scaffolds |
| **5.4–5.7 + creator thumbnail fallback** | `5ad1f79d3` | Cleanup of legacy bytes, removed dead code paths, creator UI thumbnail fallback |
| **4 docs + announce** | `cd595b15d` | Lifted P0 banner, updated changelog, drafted community announce |

### Phase 6a media migration — the part the team-call surfaced

The Phase 5 hard cutover broke `pc2-media-runtime/player.js` because the player can't sign a request *before* `/api/media/init` (the `kid` and `actionIpfsId` are only known after the server parses the MPD/PSSH). New protocol:

1. Client `POST /api/media/init` *without* `secureViewSession`
2. If server has the bundle → recover CEK, return 200 (legacy behaviour)
3. If server doesn't → respond `412 Precondition Failed` with `{ needsSecureView: { kid, actionIpfsId } }` **and the parsed MPD is cached server-side for 60 s so the retry is free**
4. Client signs the request, retries with bundle → 200

Server-authoritative `actionIpfsId` (Phase 6a-fix2) — the client can't lie about which action it's calling.

### What's *proven* on the V1.2 sigauth path

- ✅ PDF (non-media) — sig bundle round-trip, CEK recovered
- ✅ PNG (non-media) — sig bundle round-trip, CEK recovered
- ✅ MP4 (AV1 + AAC, encrypted) — two-phase init, MPD cache, CEK recovered, segments play
- ✅ MP3 (AAC, encrypted) — same path as MP4, plays
- ✅ Exploit-regression spike — old attack now returns `del_sig_invalid` / `session_bundle_required`
- ✅ EIP-1271 fallback for Particle smart accounts confirmed working

### Companion docs (all in repo, all up to date)

- `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/{LIT-ACTION-SIGNATURE-AUTH,DESIGN,SECURITY,TESTING}.md` — full task, threat model, design, test matrix
- `docs/handover/V12_SIGAUTH_HANDOVER.md` — internal cutover diary, file-by-file
- `docs/handover/IRZHY_LIT_ACTION_FIX_V12.md` — public-safe summary for the Elacity website team

---

## SEC-2026-04 — External Researcher Report + Internal Audit + 7 Hardening Waves

**Why this matters:** An external security researcher submitted an 11-finding report to `security@elacitylabs.com` on April 18. Of the 11, **7 belong to this codebase** (PC2 node + web-gateway), 4 belong to the smart-contracts repo (the smart-contracts workstream is owning those), and 1 (SEC-11, DID JWT verify) was deferred for low traffic.

**All 7 in-scope researcher findings closed across 4 waves in 36 hours.** A post-triage internal audit then surfaced **21 additional findings of the same families** (`execSync` shell-string interpolation, missing `requireOwner`, cross-wallet leaks, SSRF, TLS verify off, scheduler deferred RCE, multer disk-write traversal). **Three more hard-fix waves shipped (Wave 5, 5.5, and Wave 6 parts 1+2)** before the next morning.

### Wave-by-wave summary

| Wave | Date | Commit | Findings closed | One-line |
|---|---|---|---|---|
| **1** | 2026-04-21 | `80168f706` | SEC-3c (mock-token), SEC-10 (`/api/update/install`) | Auth lockdown + scoped sessions |
| **2** | 2026-04-21 | `b2e509c18` | SEC-3a (`/auth/particle` SIWE), SEC-7 (`/api/setup/*`) | SIWE auth + setup wizard lockdown + transport hardening |
| **3** | 2026-04-22 | `16dccaf39` | SEC-2 (vless RCE), SEC-8 (wg re-key), SEC-9 (wg DELETE) | Gateway RCE killed via argv form + per-node provisioning tokens |
| **4** | 2026-04-22 | `6ba49cfac` | Researcher rec #6 | gitleaks pre-commit + CI + push gates (3-layer secret hygiene) |
| **5** | 2026-04-22 | `82163b092`, `cb99ce5a9`, `250d2c3e8`, `38e3706ef`, `63039f6bd` | A1 (terminal RCE), A2 (git RCE), A3 (backup mnemonic exfil), A4 (cross-wallet file read), A5 (voice install) | Five surgical RCE / cross-user closes — all `requireOwner` + argv form |
| **5.5** | 2026-04-22 | `7fe1c11a5`, `ae9bbf0da`, `f53118da8` | A17 (app-install RCE), A19 (multer disk-write traversal) | Post-Wave-5 deep-audit hotfix |
| **6 part 1** | 2026-04-23 | `61318414c`, `d1c2036e4`, `8b0a71fdd`, `a731206f8`, `7a971b6d1` | A6 (system restart shell), A10 (unauth GraphQL/reindex), A12 (wallet proposal binding), A18 (scheduler deferred RCE) | Defence-in-depth post-cutover hardening |
| **6 part 2** | 2026-04-23 | `01b2ed2dd`, `9887429e7`, `2a9e39386`, `b68cd2877` | A7 (`curl\|sh` install hardening), A11 (DNS-rebind SSRF), A16 (`/file` HMAC sign+verify) | SSRF / supply-chain / capability URLs |

### How big each fix actually was

The wave 5 + 5.5 commits are all ~1 file, ~50–200 LOC each. The patterns are:

1. **`execSync(commandString)` → `execFile(cmd, [...args])`** — eliminates shell entirely, no more `;`, `&&`, `$()`, backticks, or quote-escape bypass
2. **Missing `requireOwner` middleware on privileged routes** — added directly in `index.ts` route registration
3. **Cross-wallet fallback removed** — owner check no longer falls back to "whatever wallet was in the URL path"
4. **Per-IP rate limits** added to catalog reindex + GraphQL forwarders
5. **HMAC-SHA256 sign + verify** on `/file?uid=…` capability URLs — `pc2-node/src/utils/fileUrlSigner.ts`, 32-byte key at `data/.file-url-signing-key` (mode 0600), generated on first call
6. **DNS-rebind hardening** on `/api/http` and `/api/download` — `dns.lookup({all,verbatim})` once, validate every IP against private/loopback/link-local/CGNAT blocklist (incl. IPv6 ULA `fc00::/7`, link-local `fe80::/10`, IPv4-mapped, CGNAT `100.64/10`), then build per-request `undici.Agent` with `connect.lookup` overridden to pin the IP
7. **SHA-256 pinning of `install-ollama`** — script downloads via `https.get` to a 0600 tmpfile, SHA-256-verifies against `OLLAMA_INSTALL_SH_SHA256` constant, then `spawn('sh', [tmpfile])`. Mismatch → 503 with both expected and actual SHAs

### Verification

- `npx tsc --noEmit` clean across `pc2-node` after each wave
- ESLint clean on every modified file
- **gitleaks pre-commit clean on every commit** (pre-commit + PR + push gates)
- A11 IPv4-private regex: 11/11 unit cases (loopback, RFC1918, link-local, CGNAT, public-allow incl. `8.8.8.8` and `38.242.211.112`)
- A16 fileUrlSigner: 12/12 functional cases (key persistence, sign/verify roundtrip, tampered uid/expires/sig rejected, expired URLs rejected, legacy URLs accepted with `legacy: true` when kill-switch off, legacy URLs rejected when kill-switch on)
- `npm run test:security` (79 cases, 5 specs) regression-clean
- Wave 5 + 5.5 smoke matrix (`pc2-node/scripts/wave5-smoke.sh`, 26 cases) — unauth probes ran clean; auth'd probes need owner-credential session tokens (RG3, last release-blocker on the engineering side)

### Kill-switch flips (post-cutover, scheduled)

| When | Switch | Pre-condition |
|---|---|---|
| T+7d | `GW_AUTH_REQUIRED=true` (supernode) | ≥99% of inbound calls in last 24h logged `provisioning_token=present` |
| T+14d | `siweRequired=true` (PC2 node) | ≥99% of `/auth/particle` calls in last 24h logged `siwe_verified=true` |
| T+30d | Unpin legacy Lit Action CIDs from IPFS | — |
| T+7d post v1.2.1 | `FILE_URL_SIGNING_REQUIRED=true` | `[file] legacy-unsigned` log line drops to zero across 24h |

### Single open item

**A8 — `/api/esc-rpc` TLS pinning.** Decision locked: hostname `elastossmartchain.ela.city`. Live probe of `38.242.211.112:443` confirmed it serves a valid Let's Encrypt `*.ela.city` wildcard cert (the in-code "self-signed cert" comment is wrong). **Blocker**: DNS-record-write access is on a provider that currently requires SMS 2FA on a number not reachable while traveling. **One-message handoff** — when the A record exists, agent waits ~5min for propagation, switches the proxy + 4 other `38.242.211.112` call sites to the hostname, removes 5x `rejectUnauthorized:false`, pushes one atomic commit.

### Companion docs

- `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` (457 lines) — 1:1 finding ↔ disposition mapping, single source of truth
- `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/{SEC-2026-04-21-PC2-AUDIT,WAVE-2-SIWE-AND-SETUP,WAVE-3-GATEWAY-LOCKDOWN,WAVE-4-SECRET-HYGIENE}.md`
- `.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/`, `.../WAVE5.5-PRE-RELEASE-HOTFIX/`, `.../WAVE6-HARDENING/`, `.../WAVE7-POLISH/`, `.../BOSON-DID-ROTATION/`

---

## v1.2 Adoption Roadmap — The Full Strategic Plan

**Why this matters:** With six waves of security work shipped and v1.2 code-complete, the only release-blockers left are non-engineering (RG3 owner-credential smoke matrix, RG5 smart-contract release notes, RG6 `cloud.ela.city` strategy). That gives ~1 week of **calendar slack and compute slack** before the v1.2.0 tag. The roadmap doc is the answer to: *"what do we ship in that gap that converts security correctness into adoption — for individuals AND enterprise — and that pulls the four-layer ElastOS thesis closer to inevitable?"*

### `docs/core/V1.2_ADOPTION_ROADMAP.md` — 1,082 lines, ranked, not a wishlist

Every item is mapped to:

- **Layer** — L1 Runtime / L2 Capsule SDK / L3 dDRM Protocol / L4 PC2
- **Loop node** — Acquire / Activate / Amplify / Accrue
- **Audience** — Creators / Devs / Users / Enterprise
- **Effort** — S (days) / M (~1 eng-week) / L (multi-week)
- **Bible commandment** it primarily serves

Pre-v1.2 wave (now mostly shipped):

| Item | Owner | Eng-time | Loop node | Status |
|---|---|---|---|---|
| **P0 Telemetry** plumbing for the 4 metrics that matter | Engineering | S (~3d) | Activate | ✅ Shipped 2026-04-25 (A5 + A5b) |
| **P1 Capsule packager + IPFS pin** | Engineering | S (~2d) | Acquire | ✅ Shipped 2026-04-23 |
| **P2 `npx create-elacity-capsule` scaffold** | Team | M (~1 eng-wk) | Acquire | Queued |
| **P3 Installer hardening** (existing one-liners) | Engineering + ops | S (~2-3d) | Acquire | Queued |
| **P4 Compliance pack drafts** | Founder + lawyer | 0 eng-time | Accrue | In flight |
| **P5 Brand-icon pass** | Design | 0 eng-time once assets land | Activate | Founder-blocked on assets |

### `.cursor/tasks/V1.2-PRE-RELEASE-WORK/V1.2-PRE-RELEASE-WORK.md` — execution tracking

Tier A (must-ship-in-v1.2.0): A1 ✓ A2 ✓ A3 ✓ A4 ✓ A5 ✓ A5b ✓ — only A6 (brand-icon swap) blocked on design assets.

Tier B (queue for rc2): B1 (`npx @elacity/create-capsule`), B2 (`@elacity/mcp-capsule-sdk` MCP server with 12 tools).

Tier C (parallel off-codebase): C1 (installer hardening), C2 (compliance pack).

**Companion docs cross-linked:**
- `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` — what we just locked down
- `docs/handover/PC2_CONVERGENCE_INVENTORY_FOR_RUNTIME.md` — Runtime convergence story (last week)
- `docs/core/ROADMAP.md` — strategic milestones
- `docs/core/V1.2_TESTING_CHECKLIST.md` — manual smoke matrix
- `.cursor/tasks/V1.3-RELEASE/V1.3-RELEASE.md` — Chipotle production swap + V3 contracts + PDR Phase B

**Commit:** `e56cf0e9e` (1,082 lines).

---

## Capsule Packager + Sign + IPFS Pin (§P1)

**Why this matters:** The supernode registry already serves a catalog. The app-install pipeline already accepts `(manifest, cid)`. The missing pieces were (a) a packager, (b) tarball extraction support in `extractBundle`, (c) registry entries with **real CIDs and real Ed25519 signatures** rather than `local:` paths. Doing this pre-v1.2 means **the dapp store ships in v1.2.1 without any node-code change** — only a registry update.

### What shipped (`cfea1a4d0`, `d55ce35e4`, `f17d4b8e8`)

1. **`pc2-node/scripts/package-app.ts`** — standalone Node script, no runtime dependency:
   - Tarballs `pc2-node/data/test-apps/<name>/` → `<name>-<version>.tar.gz`
   - Computes SHA-256
   - Generates / loads Ed25519 key from `~/.elastos/keys/elacity-labs.ed25519` (auto-created mode 0600 on first run)
   - Signs the tarball
   - Pushes to PC2 node's local IPFS via `/api/storage/ipfs/add` (Helia stack)
   - Emits `<name>-<version>.registry.json` with signed `distribution` block
2. **`pc2-node/src/services/AppInstallService.ts`** — `extractBundle` extended with tar.gz support behind try/catch, falls back to today's behaviour on any error
3. **`AppManifest.role?: 'system' | 'dapp'`** — new optional field; UI consumes it in v1.2.1 (no runtime behaviour change in v1.2.0)

### Apps signed + pinned

Six v1.2 apps, all signed with `elacity-labs.ed25519`, each with non-null `distribution.cid` / `distribution.signature` / `distribution.signedBy`:

| App | Role | Tarball CID |
|---|---|---|
| `elacity-market` | system | (committed) |
| `elacity-creator` | system | (committed) |
| `elacity-player` | system | (committed) |
| `ddrm-viewer` | system | (committed) |
| `elastos-nft` | dapp | (committed) |
| `glide-finance` | dapp | (committed) |

Public key published as `pc2-node/registry/v1.2/_index.json` + `README.md` (single hex string, ready for `apps.ela.city/signing-key.json`).

### Packager fixes during the dogfood pass

- `pc2_`-prefixed owner API tokens now correctly use `X-API-Key` header (not `Authorization: Bearer`) — bug surfaced + fixed during the first signing run
- Express JSON body limit bumped 50MB → 150MB to accommodate Glide Finance's 78MB tarball (104MB base64) — `pc2-node/src/server.ts`

---

## Supernode Pinning + dApp Centre Cleanup (§P1.6)

**Why this matters:** App tarballs signed and pinned locally aren't enough — they need to be **globally fetchable** for any PC2 node anywhere on Earth to install them. That requires the supernodes (the only Elacity-operated nodes that survive a single user's PC2 going offline) to run an IPFS daemon, pin the v1.2 capsule CIDs, and announce themselves as DHT providers.

### What shipped on the supernodes

Both **InterServer (authoritative)** and **Contabo (mirror)** supernodes now:

- Run **Kubo** as a `systemd` unit (`MemoryMax=2G`, `StorageMax=8G`)
- Swarm port **4101** (4001 was occupied by an existing libp2p relay running on both boxes)
- `routing=dhtserver` so they advertise as **public providers**, not just clients
- `ufw` allow rules added for inbound 4101
- All **6 v1.2 capsule CIDs pinned** via deterministic CAR import — guarantees byte-for-byte identical CIDs across both supernodes regardless of how the daemon would otherwise chunk

### Mirror flow (clarified during the audit)

Contabo mirrors InterServer's `registry.json` via a cron job every 5 minutes (script lives at `/root/pc2/app-registry/sync-registry.sh` on Contabo). Implication: pushing `registry.json` directly to Contabo would be **overwritten on the next cron run**. Solution: `deploy/app-registry/scripts/deploy.sh` was modified to:

1. Push only to InterServer (authoritative)
2. Trigger Contabo's `sync-registry.sh` immediately after — guarantees consistency, avoids the overwrite race

### External verification — global libp2p reachability proven

Both `ipfs.io` and Pinata public gateways resolve our CIDs via DHT provider records, confirming any PC2 node worldwide can fetch v1.2 capsule bytes via libp2p bitswap. **Launch-day guarantee held.**

### dApp Centre cleanup

| Before | After |
|---|---|
| 15 apps in catalog (6 real + 9 "Coming Soon" filler) | **6 real apps** |
| `dDRM Viewer` filed under `utilities` | `tools` |
| Boot sync auto-installed every test-app on disk | Boot sync auto-installs **only `role: system`** apps; cleanup pass removes stale `local:` installs of non-system apps |
| Sidebar: All / Games / Media / Tools / System | Sidebar: All / **Marketplace** / Media / **DeFi** / Blockchain / Tools / System (Games removed; Marketplace + DeFi added) |
| `ddrm-viewer.icon` was a base64 data URL stored in the wrong field — launcher treated it as a filename → broken image | Data URL moved to `iconDataUrl`; `icon` set to `"icon.svg"` |
| `dDRM Viewer` and `Elacity Player` had `"hidden": true` in `app.json`, filtered out of the launcher | `"hidden": false` — both now visible in start menu |
| Launcher fell back to a generic icon when no `icon` field was set | Launcher merge now (a) parses `data:` URLs in `icon` and `iconDataUrl` correctly, and (b) falls back to `favicon-64.png` / `favicon.png` / `favicon.ico` / `icon.png` / `icon.svg` / `favicon-192.png` if no manifest icon |
| dApp Centre cards used `icon` values that weren't valid keys for its internal SVG dictionary → generic placeholder | 4 apps remapped to valid keys (`ddrm-viewer→shield`, `elacity-creator→edit`, `elastos-nft→image`, `glide-finance→swap`) — placeholders, but recognisable |
| `recent_apps` table retained ghost entries for uninstalled apps | One-shot SQL cleanup: deleted `recent_apps` rows for non-existent app names |

### Build pipeline drift (flagged for follow-up)

`dist/storage/schema.sql` was not being copied during `npm run build:backend` — fresh installs were getting an outdated schema (missing recent migrations). Manually synced for this release; **root-cause fix queued as a separate commit**.

**Commits:** `0a5272808` (deploy machinery), `584bb035b` (catalog cleanup + icon fixes + pinning ops).

---

## Telemetry On-Ramp Pipeline — A5 + A5b (§P0)

**Why this matters:** Every Tier-1 item in the adoption roadmap claims a metric. Without the pipe, the claims are theatre. Bible §VIII ("the only metrics that matter"): **WAC, time-to-first-value, deploy frequency, change-failure rate.** This week the on-ramp portion of that pipe shipped, end-to-end.

### What shipped (`406cb8f00`)

| Surface | What |
|---|---|
| `POST /api/telemetry/onramp` | Owner-only write endpoint |
| `GET /api/telemetry/onramp/summary` | Public read endpoint, **counts only** (no per-user data exposed) |
| `pc2-node/src/api/telemetry.ts` | Endpoint + `recordTelemetryOnce()` + `recordTelemetryOnSuccess()` helpers |
| `telemetry_onramp` SQLite table + indexes | Migration 30 in `pc2-node/src/storage/migrations.ts` |
| `deploy/dash/onramp.html` | Self-contained dashboard — 4 funnel cards + bar chart, auto-poll, configurable via `?api=` and `?refresh=`. No server required. `scp`-able to any supernode static dir → instant `dash.ela.city/onramp` |
| `pc2-node/scripts/test-telemetry.sh` | 5-step smoke (GET-baseline → 4 POST events → invalid-event 400 → no-auth 401 → GET-after) |

### Privacy posture (Shape 1: local instrumentation only)

- Anonymous **`install_id`** — UUID v4, generated once per PC2 node, persisted in `settings`, **never tied to wallet / email / IP**
- **Each event idempotent per install** via `settings.telemetry_<event>_at` — fires once, then no-ops forever (survives restarts)
- **`PC2_TELEMETRY_DISABLED=true`** kill-switch — POST returns `204 {disabled:true}`, zero rows inserted, GET continues to work
- **Default ON** — anonymous metrics that help us understand adoption without compromising sovereignty

### 4 events wired into real flows

| Event | Where it fires | Helper |
|---|---|---|
| `install_started` | After test-apps boot sync (`pc2-node/src/api/index.ts`) | `recordTelemetryOnce()` |
| `wallet_ready` | After `db.updateLastLogin()` in `handleParticleAuth` (`pc2-node/src/api/auth.ts`) | `recordTelemetryOnce()` |
| `first_capsule_open` | After `db.recordRecentApp()` in `handleRAO` (`pc2-node/src/api/other.ts`, inherits explorer-skip filter) | `recordTelemetryOnce()` |
| `first_payment` | On any 2xx exit of `/lit/secure-view` via `res.on('finish')` (`pc2-node/src/api/storage.ts`) | `recordTelemetryOnSuccess()` |

### Verified end-to-end

- `install_started` fired on real boot
- `wallet_ready` fired on real `POST /auth/particle`
- `first_capsule_open` fired on real `POST /rao`
- `first_payment` structurally validated (same `res.on('finish')` pattern as the verified ones; live verification on next encrypted-asset open)
- **Idempotency proven** across repeat HTTP calls AND restarts
- **Kill-switch confirmed** — POST returns `204 {disabled:true}`, no rows inserted

### What's queued for v1.2.1 (A5c)

Upstream forwarding to a supernode aggregator, so Elacity HQ can see global v1.2 launch numbers across all installs. Public-write endpoint needs careful security pass: rate limiting, abuse protection, GDPR opt-out language. Punted deliberately to keep A5b's privacy posture clean — today telemetry **never leaves the user's own PC2 node**.

---

## Audio-Only DASH Playback Fix

**Why this matters:** A console-log post-mortem on April 23 surfaced that audio-only DASH content (an MP3 packaged through Bento4 into fragmented MP4) was stalling at ~0:39 and showing two disjoint buffered ranges where there should have been one. Watch-time graceful-degradation hits an upper bound at the buffer gap.

### Root cause

MSE `SourceBuffer` defaults to `'segments'` mode. In `'segments'` mode, the browser uses each fragment's `tfdt`/`baseMediaDecodeTime` to position it on the timeline. Bento4's audio-only AAC framing emits these timestamps as **per-fragment-relative resets** (each fragment thinks time starts at 0), so the browser interprets every new fragment as a brand-new buffered range starting at t=0 — eventually overlapping the existing playback range and stalling.

### Fix

Switch the audio `SourceBuffer` to `'sequence'` mode when `isAudioOnly` is true. In `'sequence'` mode, the browser ignores internal timestamps and pastes segments **consecutively** — exactly what we want for a continuous AAC track that has no synchronised video.

```js
audioSB = mediaSource.addSourceBuffer(aCodec);
if (isAudioOnly) {
  audioSB.mode = 'sequence';
}
```

Applied to:
- `pc2-node/data/test-apps/pc2-media-runtime/player.js` (source of truth)
- `pc2-node/data/installed-apps/pc2-media-runtime/player.js` (deployed copy the running node serves)

Both encrypted DRM path and cleartext DASH path covered.

**Commit:** `c962f7ec1`. Single-file diff, +18 LOC, zero risk to video playback (only fires when there is no video stream).

---

## Runtime-Player UI Polish — Elacity Dark Palette

**Why this matters:** dDRM Viewer, Media Player, Creator, and Market should look like one product, not four. This week's pass aligned the runtime-player apps (Viewer + Player) to the Elacity dark palette already established by Market and Creator.

| Commit | Scope |
|---|---|
| `ff92cd0f3` | dDRM viewer + media player — color tokens, surfaces, accent. **19 files, +37 / −431** (deletion-heavy is the right shape for a UI consolidation pass) |
| `aeaa8679c` | elacity-creator — color tokens aligned with elacity-market dark mode |
| `5a4d0344d` | elacity-creator — scrollbar palette match |

After this pass: opening Viewer or Player from the start menu visually matches Market and Creator. No bespoke component styling left in the runtime-player apps that conflicts with the design system.

---

## Networking & Outreach — Google Cloud Next + 4-Week Outreach Trip

**Why this matters:** The product is finally good enough that the work can speak for itself in front of enterprise. This week the team is on the ground at **Google Cloud Next in Las Vegas** (35,000 attendees, the biggest enterprise cloud + AI conference of the year), specifically because **the conversations these rooms care about right now map directly onto what PC2 + Runtime + Lit + dDRM are**: sovereign compute, security isolation, AI compliance, AI accountability, tokenised data-rights for AI agents consuming data autonomously.

### Rooms attended this week

- **PwC agentic-AI session** — enterprise AI compliance, what governance frameworks exist today, what's missing
- **Cybersecurity Leader Networking Dinner** — CISOs from major enterprises
- **AI infrastructure roundtable** — Striim, Yugabyte, Dagster (data infra companies whose customers are exactly the buyers of "where is my data going, who authorised what")
- **Altimetrik intimate industry dinner** — senior tech leaders from large enterprises

### What's landing

The pitch maps directly:

> *"We're not just talking about digital rights management in the traditional sense — we're talking about a sovereign compute environment where you can pass tokenised rights to data, where an enterprise or individual can define access conditions, have those conditions enforced at the runtime level, and then have that data accessed and traded through on-chain validation. **And not just by humans or companies — by AI agents accessing data autonomously. Agent-to-agent.**"*

This thread is landing in the right rooms. Contacts exchanged, insights collected, follow-ups queued.

### The full outreach trip — 4 weeks, 5 events

| Event | Where | When |
|---|---|---|
| Google Cloud Next | Vegas | This week ✓ |
| Bitcoin 2026 | Vegas | Next week |
| Consensus | Miami | Following |
| Digital Asset Yield Summit | TBA | Following |
| DAT Summit | TBA | Following |
| FT Digital Assets Summit | London | Final week |

Cheapest hotels, no first-class flights — disciplined ecosystem-first outreach.

### Product talking points landing in these rooms

- **112 nodes** (since the mandate passed in March)
- **ElastOS V1 live**, shipping monthly releases
- **`elastos-runtime` open-sourced** on GitHub, converging into ElastOS for V2
- **Weekly shipping reports** published publicly (this doc is part of that cadence)
- **DePIN hardware testing** underway — Jetson nodes deploying independently
- **Elacity dDRM progressing toward marketplace readiness** — next ElastOS update lands next week
- **ELA omnichain expansion** in progress

---

## Elastos Blockchain Explorer — In Production

**Why this matters:** Last week the full-stack explorer went live at [blockchain.elastos.io](https://blockchain.elastos.io/). This week it's been running in production, monitored by the 9-check Bash health system every minute, with the cross-validation alarm (local node lagging public peers by >50 blocks → Telegram alert) staying quiet.

No commits this week — by design. The explorer is on a separate cadence; it ships when there's a feature, not when there's a calendar slot. The Bash monitoring loop and the 2-source node cross-validation are working as designed.

For new readers: the explorer was built end-to-end (Go sync engine + PostgreSQL + chi API + React/Vite frontend + Bash monitor) by **one team member with AI assistance** — equivalent to a 6-engineer × 14–18-week traditional build, ≈$100K external. Sub-millisecond balance lookups via 20M-entry UTXO cache, WebSocket live block feed, dynamic OpenGraph for shareable links. Full writeup in last week's update.

---

## Smart Contracts — V3 Live + Ownership Migration

> _Smart-contracts workstream — separate repo, not in this branch. Status from this week's standup._

**Previous achievements landed:**
- Multi-channel wrapping model fixed (Security Concerns)
- All v3 contracts deployed (Security Concerns)
- Further analysis + scoping for moving ownership and fee recipient from compromised Elacity user

**This week's focus:**
- Move ownership and fee recipient from compromised Elacity user → new user (v2 on ESC and NFTs marketplace)
- Review latest PC2 updates for alignment
- Adjust Lit keystore service to align with latest network version
- Ensure sync works properly
- Write comprehensive documentation for metadata standard and IPFS lookup

**Cross-stream coordination:** the SEC-2026-04 audit's smart-contract findings (SEC-1, 4, 5, 6) are being worked in the smart-contracts workstream's parallel `disposition.md` — landing in its own release cycle. RG5 (the v1.2 release-gate item that needs the smart-contracts status update for the release-notes "shipped vs in flight" wording) is pending the final write-up from that side.

---

## What's Parked & What's Next

### Parked (captured, awaiting external dependency)

- **A8 — `/api/esc-rpc` TLS pinning**: blocked on DNS access for `elastossmartchain.ela.city`. **One atomic commit when the A record exists** — agent waits for propagation, switches proxy + 4 other call sites to the hostname, removes 5x `rejectUnauthorized:false`. Not a code blocker.
- **A6 — Brand-icon swap**: blocked on 4 brand assets from design (`elacity-market.png`, `elacity-player.png`, `elacity-creator.png`, `ddrm-viewer.svg`). **~1 hour eng-time** once they arrive — drop into `app.json[iconDataUrl]` + `registry.json[icon]` for both surfaces, redeploy via `bash deploy/app-registry/scripts/deploy.sh`.
- **RG5 — Smart-contract release notes** for v1.2 release notes wording.
- **RG6 — `cloud.ela.city` upgrade strategy** (in-place vs DNS-cut to fresh v1.2 node) — operational decision.
- **A5c — Telemetry upstream forwarding** (v1.2.1) — public-write endpoint security design.
- **D1 — Boson DID rotation** (`data/identity.json`) — Wave 4 secret scanner surfaced a real Ed25519 private key committed at `4b10bad94` (2026-03-06, before the matching `.gitignore` rule). Already exposed on 4 origin branches. Queued as a v1.2.x patch — pending input on what consumes the DID.
- **A9 — `esc-nft` prefix allowlist** (Wave 6.5/7) — needs an hour of UI-call enumeration against the live UI first.

### Immediate (this coming week)

1. **Tag v1.2.0** once RG3 (owner-credential smoke matrix) + RG5 (smart-contract notes) + RG6 (cloud.ela.city decision) clear
2. **Brand-icon swap (A6)** the moment design assets land — visual review pass on dApp Centre + start menu
3. **A8 atomic commit** the moment the DNS A record exists
4. **`dist/storage/schema.sql` build-pipeline fix** — make `npm run build:backend` copy non-TS files so fresh installs always get the latest schema (root-cause fix for this week's manual sync)

### Short-term (1–2 weeks, post-v1.2 tag)

5. **B1 — `npx @elacity/create-capsule` scaffold** — 4 templates (`storefront`, `gated-content`, `nft-drop`, `agent-app`), each a working capsule
6. **C1 — Installer hardening pass** — SHA-256 + Ed25519 signature pinning on the existing one-liners (same pattern as A7 ollama), Let's Encrypt auto-cert against `<random>.pc2.ela.city`, cloud-init one-liners for Hetzner / Vultr / OVH / Lightsail / DigitalOcean
7. **A5c — Telemetry upstream forwarding** to supernode aggregator (after security design)
8. **Kill-switch C1** (T+7d) — `GW_AUTH_REQUIRED=true` on supernode

### Medium-term (this month)

9. **B2 — `@elacity/mcp-capsule-sdk` MCP server** — wraps the capsule CLI as JSON-RPC MCP server with 12 tools (`capsule_scaffold`, `capsule_pack`, `capsule_publish`, `ddrm_mint_listing`, `ddrm_set_price`, `wallet_address`, `wallet_balance`, `registry_search`, `registry_install`, `capsule_add_capability`, `capsule_preview`, `capsule_install`). Cursor / Claude Desktop / Continue.dev → local capsule SDK.
10. **PC2 → Runtime capsule migration** — first concrete capsule (wallet bridge or `ddrm-renderer` per the convergence inventory)
11. **Compliance pack drafts** (C2) — GDPR DPA, SOC2 readiness, non-custodial legal opinion, insurance attestation. PDF zip behind `enterprise.ela.city/compliance`. Founder + lawyer time, 0 eng-time.

---

## Summary Statistics

### PC2 Engineering (Apr 18–25)

| Metric | Value |
|--------|-------|
| Commits (non-merge) | **53** |
| Insertions | **29,117** |
| Deletions | **8,733** |
| File changes | **434** |
| Branches active | `feature/lit-chipotle-migration` |
| Areas | pc2-node, deploy/app-registry, deploy/web-gateway, deploy/dash, docs/handover, docs/core, docs/updates, .cursor/tasks, scripts |

### P0 Lit Action Sigauth (closed end-to-end)

| Metric | Value |
|--------|-------|
| Phases shipped | 0, 1, 2a-2e, 3, 4, 5, 5.4-5.7, 6a |
| Lit Actions migrated | 2 (`non-media-decrypt-chipotle.js`, `media-decrypt-chipotle.js`) |
| Verified content types | PDF ✓ PNG ✓ MP4 (AV1+AAC) ✓ MP3 (AAC) ✓ |
| New crypto primitives | Web Crypto P-256 (extractable: false), EIP-191, EIP-1271 (smart accounts) |
| Wallet prompts/day after fix | **1** (down from many) |
| Time from P0 surfaced → fix shipped | **4 days** (Apr 17 → Apr 21) |

### SEC-2026-04 Hardening Waves

| Wave | Findings | Status |
|---|---|---|
| 1: Auth lockdown + scoped sessions | SEC-3c, SEC-10 | ✅ |
| 2: SIWE + setup wizard + transport hardening | SEC-3a, SEC-7 | ✅ |
| 3: Gateway RCE + provisioning tokens | SEC-2, SEC-8, SEC-9 | ✅ |
| 4: gitleaks pre-commit + CI + push gates | rec #6 | ✅ |
| 5: RCE + cross-user (5 surgical fixes) | A1, A2, A3, A4, A5 | ✅ |
| 5.5: Post-deep-audit hotfix | A17, A19 | ✅ |
| 6 part 1: System restart, GraphQL/reindex, wallet binding, scheduler | A6, A10, A12, A18 | ✅ |
| 6 part 2: Install hardening, DNS-rebind, capability URLs | A7, A11, A16 | ✅ |
| 6 part 2: TLS pinning | A8 | ⏳ DNS-blocked |
| **Researcher findings closed** | **7 / 7 in-scope** | **✅** |
| **Internal audit findings closed** | **20 / 21** (only A8 pending DNS) | **✅** |

### v1.2 Pre-Release Work (Tier A)

| Item | Status |
|---|---|
| A1 — Wave 5 smoke helpers | ✅ `bc19c4281` |
| A2 — Sign + IPFS-pin all 6 apps | ✅ `d55ce35e4` |
| A3 — `role: system\|dapp` in `AppManifest` | ✅ `f17d4b8e8` |
| A4 — Supernode pin-set + IPFS daemons | ✅ `584bb035b` |
| A5 — Telemetry endpoint + table + dashboard | ✅ `406cb8f00` |
| A5b — 4 telemetry hooks wired into real flows | ✅ `406cb8f00` |
| A6 — Brand-icon swap | ⏳ Awaiting design assets |

### Capsule Packager + Sign + Pin

| Metric | Value |
|---|---|
| New script | `pc2-node/scripts/package-app.ts` (standalone, no runtime dep) |
| Apps signed + pinned | **6 / 6** |
| Signing key | `~/.elastos/keys/elacity-labs.ed25519` (auto-created, 0600) |
| Tarball extraction | `extractBundle` + `tar.gz` support behind try/catch fallback |
| Express body limit (for Glide Finance 78MB tarball) | 50MB → **150MB** |

### Supernode Pinning

| Metric | Value |
|---|---|
| Supernodes operational | **InterServer + Contabo** |
| IPFS daemon | Kubo, systemd unit, `MemoryMax=2G`, `StorageMax=8G` |
| Swarm port | 4101 (4001 was occupied by an existing libp2p relay) |
| Routing mode | `dhtserver` (advertises as public provider) |
| CIDs pinned per supernode | **6** (deterministic CAR import, byte-identical CIDs across both) |
| External reachability proven | `ipfs.io` ✓ + Pinata ✓ |
| ufw rules | inbound 4101 allowed |

### dApp Centre Cleanup

| Metric | Before | After |
|---|---|---|
| Apps in catalog | 15 (6 real + 9 filler) | **6 real** |
| Boot sync auto-installs | All test-apps on disk | Only `role: system` |
| Stale `local:` non-system installs | Persisted | Cleaned up on boot |
| Sidebar categories | Games / Media / Tools / System | Marketplace / Media / DeFi / Blockchain / Tools / System |
| Apps hidden from launcher | dDRM Viewer, Elacity Player | None |
| Icon resolution fallback | None — broken images | favicon-64.png → favicon.png → favicon.ico → icon.png → icon.svg → favicon-192.png |
| `ddrm-viewer` icon | Data URL in `icon` (treated as filename → 404) | Data URL in `iconDataUrl`, `icon: "icon.svg"` |
| Ghost `recent_apps` rows | Persisted | Cleaned up |

### Telemetry On-Ramp Pipeline

| Metric | Value |
|---|---|
| New endpoints | 2 (`POST /api/telemetry/onramp` owner-only, `GET /summary` public counts) |
| New table | `telemetry_onramp` (migration 30) |
| Funnel events | `install_started → wallet_ready → first_capsule_open → first_payment` |
| Anonymous install ID | UUID v4, persisted in `settings`, never tied to wallet/email/IP |
| Idempotency | Per-event-per-install via `settings.telemetry_<event>_at` |
| Kill-switch | `PC2_TELEMETRY_DISABLED=true` |
| Dashboard | `deploy/dash/onramp.html` — 4 cards + bar chart, self-contained, auto-poll |
| Smoke test | `pc2-node/scripts/test-telemetry.sh` — 5 checks pass |
| Hooks verified end-to-end | 3 / 4 with real flows; `first_payment` structurally validated |

### Roadmap Documentation

| New / Updated | File | Lines |
|---|---|---|
| **New** | `docs/core/V1.2_ADOPTION_ROADMAP.md` | 1,082 |
| **New** | `.cursor/tasks/V1.2-PRE-RELEASE-WORK/V1.2-PRE-RELEASE-WORK.md` | (tracking doc) |
| **New** | `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` | 457 |
| **New** | `docs/handover/V12_SIGAUTH_HANDOVER.md` | (cutover diary) |
| **New** | `docs/handover/IRZHY_LIT_ACTION_FIX_V12.md` | (public-safe summary) |
| **New** | `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/{*.md}` | 4 task docs |
| **New** | `.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/` | 1 |
| **New** | `.cursor/tasks/SEC-2026-04-22-WAVE5.5-PRE-RELEASE-HOTFIX/` | 1 |
| **New** | `.cursor/tasks/SEC-2026-04-22-WAVE6-HARDENING/` | 1 |
| **New** | `.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/` | 1 |
| **New** | `.cursor/tasks/SEC-2026-04-22-BOSON-DID-ROTATION/` | 1 |
| **New** | `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/{LIT-ACTION-SIGNATURE-AUTH,DESIGN,SECURITY,TESTING}.md` | 4 task docs |

### ElastOS Runtime workstream

| Metric | Value |
|---|---|
| Desktop shell | Native WASM capsule (rebuilt from `puter` / `pc2.net` patterns) |
| Window/capsule manager | ✓ Working |
| System manager (Elastos Manager) | ✓ Working — DID display, global handle, settings panel |
| Hosted chat-room | ✓ Working — sovereign + public-gateway modes via Carrier |
| GBA emulator | ✓ Save state persists across reopens; cross-capsule discovery (mirror, media, viewer) |
| Markdown viewer | ✓ Cross-capsule link from emulator works |
| Carrier-as-HTTP | Confirmed architecture — capsules know **only** Carrier |
| Hardware tiering | Light WASM (default) → microVM → KVM (security-sensitive) |
| Essentials audit | **165 docs**, **~869 findings**, line-annotated, **99.2% docs integrity** |
| Frontend overhaul plan | **5 phases locked**: prep sprint → `@essentials/core` extraction → Cordova→Capacitor → React/Radix/Tailwind/Zustand UI rebuild → polish |

### Networking & Outreach

| Metric | Value |
|---|---|
| Conference this week | Google Cloud Next, Las Vegas (35K attendees) |
| Rooms | PwC agentic-AI, CISO dinner, AI-infra roundtable (Striim/Yugabyte/Dagster), Altimetrik senior-tech dinner |
| Outreach trip | 4 weeks, 5 events (Google Cloud Next ✓, Bitcoin 2026, Consensus Miami, Digital Asset Yield Summit, DAT Summit, FT Digital Assets Summit London) |
| Pitch theme landing | Sovereign compute + AI compliance + tokenised data-rights for AI-agent autonomy |

---

*This is an Elacity Labs team update for the World Computer Initiative (WCI) covering April 18 – April 25, 2026. In scope: **ElastOS Runtime** (desktop shell + hosted rooms + GBA emulator + Essentials audit + 5-phase frontend overhaul plan), the **P0 Lit Action sigauth cutover** (Phases 0–6a + 5.4–5.7 + 4 docs/announce), the **SEC-2026-04 audit** (external researcher 7 / 7 closed + internal audit 20 / 21 closed across 7 hardening waves), the **v1.2 adoption roadmap + pre-release work bucket** (P0 telemetry pipeline, P1 capsule packager + sign + IPFS pin, supernode pinning + dApp Centre cleanup, app role schema), the **audio-only DASH playback fix**, the **runtime-player UI palette pass**, the **Elastos blockchain explorer in production**, and the **team's Google Cloud Next + 4-week outreach trip**. The community-surfaced P0 dDRM vulnerability that triggered this week's defining workstream — the community-side reproduction and the 4-day Option-C session-key delegation cutover that closed it — was both the trigger and the single best validation of why everything else in this week's work matters.*
