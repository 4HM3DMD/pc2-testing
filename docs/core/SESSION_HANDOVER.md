# Session Handover — Mar 3, 2026

> **Read this first when starting a new agent session.**

---

## Where We Are

**Branch:** `feature/elacity-ddrm-marketplace` (created from `main` after v1.1.0 release)
**Release:** v1.1.0 tagged and released on 2026-03-03 (134 commits squash-merged to main)
**Launcher:** v1.1.1 released — version display, one-click updates, full networking install
**DAO Proposal:** Live at https://elastos.com/proposals/69a24f49247f130078064edd

### What Just Shipped (v1.1.0)

- Four-tier stealth transport cascade (WG > AWG > VLESS Reality > ActiveProxy)
- Desktop Launcher with version display, one-click updates, and full networking install
- Desktop UI overhaul (full-width top bar, layout toggle, mobile-responsive)
- Voice AI pipeline (Whisper + Ollama + Context API)
- ARM installer hardened (Go auto-detection, AmneziaWG from source, sing-box 1.13.0 pinned, Jetson power mode)
- Structured logging (no more console.log in production)
- Security: credentials rotated, removed from docs
- Upload verification against IPFS
- WireGuard reconnection with exponential backoff (15s start)

### Validated On

- macOS (localhost) — full transport cascade, launcher, updates
- NVIDIA Jetson Orin Nano (zzz.ela.city) — WireGuard + AmneziaWG working, VLESS Reality pending supernode client-side config
- Contabo VPS (38.242.211.112) — install script verified

### Documentation Status

- `docs.ela.city` (document-portal) — fully updated: install guides, stealth transport, launcher features
- `docs/deployment/STEALTH_MODE.md` — complete with install parity rule
- `docs/deployment/TRANSPORT_ARCHITECTURE.md` — four-tier cascade architecture
- `docs/core/ROADMAP.md` — updated with v1.1.0 completion, Elacity dDRM as first priority
- `elastos-launcher/CONTRIBUTING.md` — install parity rule documented
- `elastos-launcher/README.md` — updated with all current features
- Weekly update report: `docs/reports/weekly-update-2026-03-03.html`

---

## What to Work On Next

### Priority 1: Elacity dDRM & dApp Store

**Branch:** `feature/elacity-ddrm-marketplace`
**Detailed Plan:** `.cursor/plans/app_store_and_media_market_2489ec7b.plan.md`
**SDK Source:** Cloned at `sdk/elacity-js-sdk` (gitignored)
**SDK Docs:** https://elacity.gitbook.io/elacity-sdks/

Implementation order:
1. **postMessage wallet bridge** for iframe-sandboxed apps
2. **COOP/COEP header testing** for media player SharedArrayBuffer
3. **Confirm SDK access** with CTO (npm registry, test CIDs, API endpoints)
4. **`installed_apps` SQLite table** + AppInstallService
5. **App registry manifest format** + supernode discovery endpoint
6. **Elacity Market app** using `@elacity-js/api` + wallet bridge
7. **Media player** as installable app with dDRM playback
8. **App Factory** — local packaging pipeline

### Priority 2: UI Polish (can interleave)

- Keyboard shortcuts (Alt+Tab, Alt+F4)
- Explorer context menu (Copy path, Open terminal here)
- Shortcuts overlay modal

---

## Key Documents

| Document | Path | What It's For |
|----------|------|---------------|
| **This file** | `docs/core/SESSION_HANDOVER.md` | Start here |
| **Agent Handover** | `docs/core/AGENT_HANDOVER.md` | Coding patterns, infrastructure |
| **Roadmap** | `docs/core/ROADMAP.md` | All milestones with checkboxes |
| **Architecture** | `docs/core/ARCHITECTURE_CONVERGENCE.md` | PC2 v1 → capsule runtime v2 |
| **Stealth Mode** | `docs/deployment/STEALTH_MODE.md` | Transport cascade docs |
| **dDRM Plan** | `.cursor/plans/app_store_and_media_market_2489ec7b.plan.md` | Detailed implementation plan |

---

## Infrastructure Access

```
Supernode (InterServer): root@69.164.241.210
Secondary (Contabo):     root@38.242.211.112
Passwords: ROTATED — stored in password manager, not in git
```

- Gateway runs under systemd (`pc2-gateway.service`)
- sing-box 1.13.0 running on supernode for VLESS Reality
- WireGuard: `wg show wg0` — 10+ active peers
- AmneziaWG: interface up on supernode

---

## Important Boundaries

- **"Elacity dDRM"** — always use this full name. It's Elacity Labs' commercial protocol, NOT an ELA demand mechanism.
- **ELA value** comes from native mechanisms: Carrier staking, blockchain gas, routing fees, in-OS protocol fees
- **ElastOS** = open infrastructure (community). **Elacity** = private company operating on it.
- Never reference Anders Alm by name in public docs — refer to "the V2 runtime" or "the capsule architecture"
- **Install Parity Rule** — launcher, start-local.sh, and install-arm.sh must always install the same tools

---

## Related Repositories

| Repository | Branch | Status |
|------------|--------|--------|
| [pc2.net](https://github.com/Elacity/pc2.net) | `feature/elacity-ddrm-marketplace` | Active development |
| [elastos-launcher](https://github.com/Elacity/elastos-launcher) | `main` | v1.1.1 released |
| [document-portal](https://github.com/Elacity/document-portal) | `main` | Up to date |
| [js-sdk](https://github.com/Elacity/js-sdk) | — | Elacity SDK (reference) |
