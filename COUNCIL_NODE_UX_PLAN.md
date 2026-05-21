# Council Node App — UX / Dashboards / Services / Responsiveness Plan

**Status: PLANNING ONLY.** No code is changed by this document. It is the brief for a
later autonomous fixing loop (5 audit cycles). Investigation was read-only across the
frontend app (`src/backend/apps/elastos-node-manager/`) and the backend
(`enm-server/src/`), cross-referenced with this session's deep backend knowledge.

**Guiding principle:** Main Chain mode is the design + UX + operational reference. Do NOT
redesign Main Chain unless there is a real bug/regression risk. Bring Council Node services,
EVM chains, Oracle views, the multi-chain dashboard, chain settings, and service controls up
to Main Chain's quality — branding, compactness, clarity, responsiveness — while keeping the
three modes (Main Chain / BPoS-only / Council Node) cleanly separated and operationally
correct (node.sh = source of truth when unsure).

---

## 1. Architecture as-found (so the loop doesn't relearn it)

- **Frontend** = vanilla-JS Puter app, ~23.7K LOC, no framework. Components hand-build
  `innerHTML` strings (no `el()/card()` DOM factory). Shared helpers in `js/utils.js`:
  `enmRunOnce(btn,label,fn)` (the standard single-flight mutating-action guard),
  `enmCopyButton`, `enmFormat{Uptime,Number,Bytes,Address,Date}`, `enmTOrFallback` (i18n via
  `js/strings.js`). Spine = `js/app.js` (view routing, the `PaneRouter`, responsive observer).
- **Backend** = separate sidecar (`enm-server`, API base `/api/enm`). Per-chain truth via
  `GET /chains`, `GET /chains/:id`, `GET /chains/:id/sync`, `/chains/:id/history`,
  `/rotation`, `/spv`, `/system/status`, `/council/overview`, `/updates/available`, `/healing/*`.
- **Modes are NOT modeled** — they are *inferred*: `chain-selector.js` sets
  `_mode = keys.length <= 1 ? 'bpos-only' : 'council'` (Main Chain and BPoS-only collapse to
  one). The active view is driven separately by `localStorage('enm:chain-selection')` +
  `_activeChainId`/`_overviewMode` in `app.js`. Two sources of truth that have desynced before
  (patched, not prevented).
- **Chain classes** (hardcoded in 3 parallel maps — `chain-card.js`, `app.js`,
  `chain-selector.js`): A=mainchain, B=EVM (esc/eid/pg), C=oracle, D=arbiter, E=SPV-virtual.
- **Design system** (`css/styles.css`, dark-only): tokens `--sp-1..7` (4–48px), `--r-*`,
  `--fs-*`, palette (`--accent #00d4ff`, `--success/-warning/-error`, surfaces, text tiers).
  Canonical classes: `.enm-btn(-primary/-secondary/-danger/-ghost/-sm)`,
  `.enm-section-card(+head/icon/title/help/tag/body/foot)`, `.enm-form-row(+label/control)`,
  `.enm-state-chip`, `.enm-settings-nav`/`-pills`/`-content`.
- **Responsive** = a `ResizeObserver` on `<html>` writing `body[data-app-size]` with buckets
  **compact <480 / narrow 480–699 / wide ≥700** (because `@media` measures the outer browser,
  not the iframe). Selectors use dual form `body[data-app-size="x"] .foo, .enm-app[...] .foo`.

---

## 2. Catalog — everything the fixing loop must review

### Screens / views
| View | Component | Mode/Class | State today |
|---|---|---|---|
| Boot / error pane | `app.js` (`_showError`) | all | ok |
| Welcome | `welcome-screen.js` | all | ok |
| Setup wizard (7-card) | `setup-conversation.js` (2271 LOC) | all | ok-ish, out of scope unless bug |
| Per-chain dashboard | `chain-card.js` (1527) + `system-status.js` | A/B/C/D | **A rich; B partial; C near-empty; D relabel** |
| Mainchain extras | `node-identity-card.js`, `validator-registration-card.js`, `tools-update-card.js` | A only | ref design; gated `chainId==='mainchain'` |
| Multi-chain overview | `multi-chain-overview.js` (532) | Council | **shallow — not a control center** |
| SPV module pane | `spv-module.js` (280) | E | read-only aggregate |
| Logs tab | `log-viewer.js` (1121) | all | ok |
| Settings tab | `settings-tab.js` (5127) | A good; **B/C/D/E unstyled** | **redesign** |
| Audit tab | `audit-tab.js` (1639) | all | ok |
| EVM tab | `evm-tab.js` (86) | B | **static placeholder, backend 501** |
| Settings drawer (legacy) | `settings-drawer.js` (404) | — | superseded |
| Chain selector | `chain-selector.js` (353) | all | mode-inference lives here |
| Proposal card (healing) | `proposal-card.js` (562) | all | ok |
| Toasts / announcer | `notifications.js`, `services/announcer.js` | all | ok |

### Services (frontend) / APIs (backend)
- Frontend services: `services/api.js` (data layer), `sse.js` (live updates), `wallet.js`,
  `height-series.js`, `online-watcher.js`, `fleet-health-gradient.js`, `notifications.js`.
- Backend routes to review: `routes/chains.js` (per-chain detail + start/stop/restart +
  bootnodes), `CouncilOverviewService.js` (overview snapshot — RPC-free), `routes/updates.js`,
  `routes/maintenance.js` (resync/uninstall), `routes/spv.js`, `routes/evm.js` (**501 stub**),
  adapters `EvmSidechainAdapter.js` / `OracleAdapter.js` / `ArbiterAdapter.js` (`primaryHeight`,
  `health`).

### Update flows
- `tools-update-card.js` (Status pane, **mainchain-only**): polls `/updates/available`, shows
  up-to-date / update-available; the action **copies the `deploy-enm.sh` command** in a modal —
  it does NOT apply in place ("deferred"). No per-EVM-chain update path exists.

---

## 3. Top risks (what makes this hard / dangerous)

**Data / service-accuracy risks**
- **Backend doesn't expose what the EVM dashboard needs.** `miner.rewardAddress` and
  `miner.evmKeystoreAddr` (the "geth address") exist in config but are **not in the
  `/chains/:id` response** — the UI structurally cannot show the two addresses operators most
  want to verify. (Backend change required, not just UI.)
- **Oracle has almost no real server-side status.** `OracleAdapter.health` returns
  `rpcOk:true` hardcoded for any alive process; `primaryHeight` returns only `parentBlockHeight`.
  "Connected / last activity / last error" **do not exist server-side** — they must be *built*
  (e.g. probe the oracle's status port) before the UI can honestly show them.
- **Multi-chain overview is deliberately RPC-free** (`CouncilOverviewService`): only
  state/pid/uptime/displayName + a decorative sparkline. Its `coarseState` is a 5-bucket
  classifier with **no healthy/syncing/stalled distinction** — a row labeled "Running" may
  actually be syncing or stalled (misleading-but-not-fabricated).
- **`evm-tab.js` is 100% static** over a `501` backend — pure placeholder.
- Real fields the UI ignores: `attached`, `hasKeystore`, `activeNet`, `ports`, `binaryPath`.

**UX / branding risks**
- **Side-chain screens render as unstyled default HTML.** `.enm-settings-class-*`,
  `.enm-section-classb/c/d`, `.enm-field`, `.enm-info-dl`, `.enm-section-actions` have **zero CSS**
  (verified) — no card chrome, no spacing scale, full-bleed inputs, inconsistent `<h2>/<h3>`.
  This is exactly the "generated/inconsistent" look. Class A uses the good
  `.enm-section-card`/`.enm-form-row` path; B/C/D/E bypass it.
- **Non-existent CSS-var fallbacks** drift off-palette: `var(--state-healthy,#4caf50)`,
  `var(--text-muted)`, `var(--bg-page,#0f1218)` reference vars not in `:root`.
- **`chain-card.js` is a monolithic ~1900-line card** with class conditionals; C is near-empty
  (height block deleted, one "Relays for" row).

**Responsiveness risks**
- Side-chain blocks + peers panel + SPV/syscheck have **zero `data-app-size` overrides** (and
  the side-chain settings have no base rules at all) → overflow / cramped controls / unusable
  buttons at compact (320–479px). Only the Main-Chain DOM honors the responsive model.

**Service-control risks**
- No confirmation before restart (settings-tab) and start/stop/restart bypass the shared
  `enmRunOnce` guard in some places. Overview has **no** quick controls. No per-EVM-chain update.

**Isolation / regression risks**
- Modes are inferred from chain-count + localStorage (two desyncing sources); class maps
  duplicated in 3 files; localStorage tampering can reach EVM stubs on a BPoS-only node.
- `chain-card.js` is **shared across all classes** — any change risks the Main-Chain reference.
  Mainchain-only cards are hard-gated to `chainId === 'mainchain'`.

---

## 4. Cross-cutting acceptance criteria (apply to EVERY phase)

1. **Branding:** every new/redesigned element renders through the canonical kit
   (`.enm-section-card`, `.enm-form-row`, `.enm-btn*`, `.enm-state-chip`, real `--*` tokens) and
   the `js/utils.js` helpers — never bespoke unstyled markup. Visual parity with Main Chain.
2. **Responsiveness:** every redesigned screen verified at **compact (320–479) / narrow
   (480–699) / wide (≥700)** via `data-app-size` overrides — no overflow, no cramped/unusable
   controls, no hidden critical service data.
3. **Real data only:** every displayed value traces to a real backend field; if unavailable,
   show an explicit "unknown / not reported" state and note whether the backend should expose it.
   No placeholder/guessed/decorative values presented as live.
4. **Mode isolation:** Main Chain / BPoS-only / Council Node logic stays separated; Council
   behavior must be operationally correct (compare node.sh + Main Chain when unsure), not just
   visually similar.
5. **Main Chain regression protection:** Main Chain dashboard/identity/settings render
   byte-for-byte unchanged unless a real bug is fixed. Any shared-component change (esp.
   `chain-card.js`) must be proven not to alter the Class-A path.

---

## 5. Phase-based plan (large, meaningful phases)

### Phase 1 — Foundation: design-system enforcement, mode model, backend data-truth
**Goal:** create the conditions every later phase depends on — a reusable branding kit the
side-chain screens are forced through, a real mode model, and the backend actually exposing the
fields the dashboards need. (Covers operator areas 1-foundation, 9, 10.)
**Screens/services:** `css/styles.css`, `js/utils.js` (add shared render helpers if warranted),
`js/app.js` + `chain-selector.js` (mode model), backend `routes/chains.js` +
`CouncilOverviewService.js` + `OracleAdapter.js` + `routes/evm.js`.
**Investigate later:** which ad-hoc side-chain classes need real CSS vs which markup should be
re-emitted through existing `.enm-section-card`/`.enm-form-row`; the full list of
non-existent-token fallbacks; whether to model mode explicitly (a single `getMode()` source) or
keep inference but de-duplicate the 3 class maps into one module; exactly which real fields each
dashboard needs from the backend.
**Change later:** (a) fix the off-palette fallbacks → real tokens; (b) consolidate the chain-class
maps into one shared module; (c) backend: add `miner.rewardAddress` + `miner.evmKeystoreAddr` (+
`miner.enabled`) to `GET /chains/:id`; enrich `/council/overview` with class-aware height/health
(without making it heavy — cache/throttle); build an **oracle status probe** (parent-reachability
+ last-activity + last-error) in `OracleAdapter`; replace the `evm-tab` `501` stub with either a
real view or an honest "not yet available" that isn't decorative.
**Risks to avoid:** don't make `/council/overview` synchronously RPC-heavy (it must stay fast —
throttle/cache); don't break Main Chain's settings/dashboard while refactoring shared CSS/maps;
don't fabricate oracle fields — only surface what the probe can truthfully report.
**Verify later:** unit/manual check that `/chains/:id` now returns the addresses; overview returns
enriched fields; oracle probe returns real status on pc2new; Main Chain visually unchanged;
grep proves no `--state-*`/`--text-muted`/`--bg-page`-fallback references remain.

### Phase 2 — Multi-chain dashboard → operational control center + safe quick actions
**Goal:** turn `multi-chain-overview.js` from a shallow list into a real control center; add
compact, safe quick actions. (Areas 3, 4.)
**Screens/services:** `multi-chain-overview.js`, `CouncilOverviewService.js`, `services/api.js`,
`routes/chains.js` (start/stop/restart), update endpoint (Phase 5).
**Investigate later:** the densest readable layout at compact width (card-grid vs table);
per-class column sets (EVM: height/sync/peers/miner+geth addr/mining; Oracle: status/parent/last
activity; Arbiter: SPV height/cross-chain reach); which quick actions are safe per class/state.
**Change later:** render per chain+service: chain height, service status + what it's doing, sync
state, health state, miner/geth address (EVM), oracle status (where relevant), warnings/errors,
and **compact quick actions** Start/Stop/Restart/Update. Route all actions through `enmRunOnce`;
**confirm before dangerous/disruptive actions** (stop/restart/update); show explicit
success/failure/pending after each.
**Risks to avoid:** misleading coarse "Running" (use the enriched health from Phase 1); action
buttons that fire without confirm; overflow at 320px; issuing N parallel RPCs that hammer the box.
**Verify later:** every row's data matches `GET /chains/:id`; actions produce real state changes +
correct pending→success/fail UI; full compact/narrow/wide pass; Council-only (not shown in Main
Chain/BPoS-only mode).

### Phase 3 — EVM single dashboards + Oracle views
**Goal:** make each EVM chain dashboard complete + compact, and make the Oracle section real and
visible beneath the EVM status. (Areas 5, 6.)
**Screens/services:** `chain-card.js` (Class B + the embedded oracle section), `spv-module.js`,
`evm-tab.js`, backend oracle probe (Phase 1), `/chains/:id`, `/chains/:id/sync`, `/logs`.
**Investigate later:** whether to decompose the monolithic `chain-card.js` into per-class
renderers (reduces Main-Chain regression risk) vs tightening the class branches; how to show a
compact log/error hint without the full log viewer; where the embedded oracle sub-card sits.
**Change later:** EVM card shows chain height, node status, **geth/EVM account address**, **miner
reward address + mining on/off**, sync status, service health, embedded **Oracle section below the
EVM status** (running/stopped, healthy/unhealthy, connected/parent chain, last activity, errors,
safe quick controls, update status), log/error hints, quick actions, and an **Update** action.
**Risks to avoid:** regressing the Class-A hero/identity path via shared-card edits; showing
oracle "healthy" purely from PID (use the Phase-1 probe truth); cramming the oracle sub-card so it
overflows on compact.
**Verify later:** every EVM field real; oracle section populated from the probe (or honest
"unknown"); compact/narrow/wide pass; Main Chain card unchanged; arbiter "SPV height" still correct.

### Phase 4 — Side-chain settings redesign
**Goal:** redesign every Class B/C/D/E settings screen to match Main Chain — clear, compact, safe,
responsive. (Area 7.)
**Screens/services:** `settings-tab.js` (the B/C/D/E mounts: `_renderClassBForm`,
`_renderClassCInfo`, `_renderClassDInfo`, the SPV stub), `css/styles.css`, `js/utils.js`.
**Investigate later:** re-emit B/C/D/E through the Class-A `.enm-settings-nav`/`-content` +
`.enm-section-card` + `.enm-form-row` contract (preferred) vs giving the ad-hoc classes real CSS;
which side-chain settings are safe to expose vs read-only; confirmation patterns for Save→Restart.
**Change later:** rebuild side-chain settings on the canonical primitives; route Save/Restart
through `enmRunOnce`; add confirmation for disruptive applies; add `data-app-size` overrides;
consistent header/icon/tag/section hierarchy matching Main Chain.
**Risks to avoid:** leaving any unstyled `.enm-section-classX`/`.enm-field`/`.enm-info-dl` markup;
breaking the working EVM peer/bootnode editor that already lives in settings; Main-Chain settings
regression.
**Verify later:** side-chain settings visually indistinguishable in quality from Main Chain;
compact/narrow/wide pass; Save/Restart safe + status-reporting; peer editor still works.

### Phase 5 — EVM update flows
**Goal:** give each EVM chain a real Update action with safe, clear behavior. (Area 8.)
**Screens/services:** new per-EVM-chain update affordance (EVM card + overview quick action),
backend `routes/updates.js` + the binary downloader (`EnmBinaryDownloader`), `tools-update-card.js`
(reference UX).
**Investigate later:** whether the backend can check + apply a per-chain binary update in place
(vs the current copy-`deploy-enm.sh`-command pattern); how to detect "update available" per EVM
binary; how to apply safely (stop → swap binary → restart → verify) and roll back on failure.
**Change later:** Update button → **prompt before proceeding** → check whether a binary update
exists → apply if so → return "up to date" if not → show progress + final result → handle errors
safely. Reuse the tools-update modal chrome + `enmRunOnce`.
**Risks to avoid:** applying a bad binary with no rollback; updating while the chain is mid-flush
(coordinate with the v0.5.184 clean-shutdown drain); confusing per-chain update with the
node-wide deploy.
**Verify later:** "up to date" path; "update available → applied" path; error/rollback path;
progress + final status all real; no chaindata loss.

---

## 6. Future 5-audit-cycle verification plan

After the phases are implemented, the fixing loop runs **5 complete audit cycles**. Each cycle
checks the FULL list (UX consistency, responsiveness, real service-data accuracy, quick-action
behavior, update behavior, oracle visibility, multi-chain usefulness, EVM-dashboard usefulness,
side-chain settings design, Main-Chain regression risk, mode separation, hidden bugs/broken
states) but **leads with a focus** so the sweep deepens rather than repeats:

- **Cycle 1 — Data-truth & service accuracy.** Trace every displayed value to a real backend
  field; flag any fake/placeholder/stale/guessed value; confirm the Phase-1 backend additions
  (addresses, overview enrichment, oracle probe) return real data on pc2new.
- **Cycle 2 — Branding & responsiveness.** Every screen on the canonical kit; full
  compact/narrow/wide pass at 320/480/700+; no overflow/cramping/hidden data; no off-palette
  fallbacks remain.
- **Cycle 3 — Functional behavior.** Quick actions (start/stop/restart) confirm-then-execute with
  real pending→success/fail UI; EVM update flow (up-to-date / applied / error+rollback); oracle
  visibility; multi-chain + EVM dashboards genuinely useful end-to-end.
- **Cycle 4 — Isolation & regression.** Main Chain / BPoS-only / Council Node cleanly separated
  (try mode switches + localStorage tamper); Main Chain dashboard/settings unchanged; Council
  behavior matches node.sh expectations; shared `chain-card.js` changes proven not to alter Class A.
- **Cycle 5 — Full integration sweep.** Everything together; hidden-bug / broken-state hunt
  (empty data, stopped chains, mid-sync, unconfigured, error states); final polish + sign-off.

**For every cycle:** record what was checked, record what failed, fix the failures in the same
loop, then re-run the relevant checks until green. Deploy to pc2new and verify live (8/8 chains,
real data, the `override_sweep_cid` keeps ENM sweeper-safe across the deploy bounce). Treat any
Main-Chain regression as a stop-the-line failure.

---

## 7. Reference notes for the fixing loop
- **Main Chain reference elements** to match (from `chain-card.js`): hero power-glyph + sync ring,
  state chip with version, big block-height block, "Fully synced / ETA" subline, stats strip
  (peers/version/uptime) with peer hover-popover, action row, plus identity/validator/tools cards.
- **Design kit anchors:** tokens + classes in `css/styles.css` (`:root` L33–158; `.enm-btn` L725;
  `.enm-section-card` L1947; `.enm-form-row` L2545; settings nav/pills L1812+). Helpers in
  `js/utils.js` (`enmRunOnce` L175, `enmCopyButton` L445, `enmFormat*`).
- **Responsive anchor:** `app.js setupResponsiveObserver()` L40–121 (buckets 480/700) →
  `body[data-app-size]`; use the dual-selector form for every new rule.
- **node.sh / Main Chain are the operational truth** when Council behavior is uncertain — verify
  against them rather than copying Main-Chain UI behavior blindly onto a different service class.
- **Backend gaps that block UI** (fix backend first): miner/geth addresses absent from
  `/chains/:id`; oracle status fields don't exist server-side; `/council/overview` is RPC-free;
  `routes/evm.js` is a 501.
```
