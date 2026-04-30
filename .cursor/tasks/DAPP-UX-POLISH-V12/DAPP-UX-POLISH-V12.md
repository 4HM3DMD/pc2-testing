# Task: dApp Centre + Start Menu — v1.2 Pre-Release UX Polish

**Task ID**: DAPP-UX-POLISH-V12
**Created**: 2026-04-29
**Status**: Review (awaiting user smoke test after restart)
**Priority**: High (pre-release v1.2 blocker for visible UX bugs; polish for the rest)
**Recommended release**: **v1.2** — ships with DAPP-INSTALL-NETWORK-FETCH smoke-test window
**Branch**: `release/v1.2-pre-release`

## Description

During the DAPP-INSTALL-NETWORK-FETCH smoke test on 2026-04-29, the user
found five real UX issues in the dApp Centre + Start Menu surfaces. All
five are live on the user's dev install and observable in the paired
screenshots (attached to the session). This task batches all five into
one coordinated v1.2 pre-release fix since they share code paths and
testing surface.

## Issues to Fix

### 1. Duplicates in the "All Apps" grid (CRITICAL — visible bug)

The dApp Centre shows every user-installable dApp (Elacity Market,
Elacity Player, Elacity Viewer, Elacity Creator, Glide Finance) twice
in the "All Apps" grid — once with the registry-provided category icon
(nice-looking) and once with a generic "package" cube icon.

**Root cause (verified with live API call):**
`/api/installed-apps` returns rows with field **`app_name`**, not
`name`. The dApp Centre frontend does `installedApps.map(a => a.name)`,
which produces `Set([undefined, undefined, …])`. Consequence:

- `installedNames.has(cat.id)` is always `false` → registry apps show
  an "Install" button instead of "Open".
- Every installed app falls into the "not in catalog" branch of
  `mergeApps` because `catalogApps.find(c => c.id === undefined)` is
  always false, so every installed app is added a second time with the
  generic fallback styling.

**Fix:** `a.name` → `a.app_name` in two spots in
`src/backend/apps/app-center/index.html` (lines ~1222, ~1263). Done
with a tolerant read `(a.app_name ?? a.name)` for forward-compat.

### 2. Wrong icons for installed apps in dApp Centre (HIGH — visible bug)

Even after the duplicates bug is fixed, the dApp Centre renders
installed apps (Glide, Elastos NFT) with the **registry's category
SVG key** (`swap` for Glide, `image` for NFT), not the actual app
logo shipped in the bundle. The category glyphs are obviously wrong —
Glide's real logo is a teal wave; Elastos NFT ships a proper Elastos
roundel.

**User confirmed:** "[the] Start menu is correct, it's NOT correct in
the dapp centre". The Start Menu pulls its icon URL from
`/get-launch-apps`, which already resolves to the real bundle logo
(`/installed-apps/<name>/logo.png` etc). The dApp Centre reads only
the registry `icon` field and ignores the launch-apps icon URL.

**Fix:** In `loadData()`, build a `launchAppIcons` map from
`/get-launch-apps` responses (`{name: iconUrl}`). In `mergeApps` step
1 (catalog branch), when an app is installed, set `builtInIcon` from
that map so `getAppIconHtml` uses the real bundle logo.

### 3. Glide bundle icon fallback too narrow (MEDIUM — visible bug)

Separate from #2, the backend's icon-URL resolver in
`pc2-node/src/api/info.ts` tries a fixed list:
`['favicon-64.png', 'favicon.png', 'favicon-192.png', 'icon.png', 'icon.svg', 'favicon.ico']`.

Glide's bundle ships `logo.png`, `logo_128x128.png`, `logo_200x200.png`,
`logo_256x256.png`, `android-chrome-192x192.png`, `apple-touch-icon.png` —
none match except `favicon.ico`, which is a 16×16 blob that renders
pixelated at 48 px. (This doesn't currently affect the Start Menu — the
hardcoded `svg` icon overrides it — but it affects every other surface
that resolves the bundle icon URL.)

**Fix:** Prepend higher-quality candidates
(`logo.png`, `logo_256x256.png`, `logo_200x200.png`,
`android-chrome-192x192.png`, `apple-touch-icon.png`) before
`favicon.ico`. Cheap and covers all common PWA-style bundles.
Also in `pc2-node/src/api/apps.ts` which has the same logic for the
single-app endpoint.

### 4. Uninstalled app lingers in Start Menu (HIGH — stale data bug)

After the user uninstalls a dApp from the dApp Centre, the Start Menu
continues to show the app's tile with its icon. Only a full page reload
clears it.

**Root cause:** `src/gui/src/UI/UITaskbar.js` fetches `/get-launch-apps`
once at init and caches into `window.launch_apps`. Nothing listens for
install/uninstall events. The dApp Centre performs the DELETE server-
side but never notifies the parent window that the app list changed.

**Fix:** Simple postMessage bridge. After any successful install or
uninstall in the dApp Centre, post `{msg: 'apps:changed'}` to the
parent. IPC.js receives and re-fetches `/get-launch-apps`, replacing
`window.launch_apps` so the next time the Start menu opens, it renders
the fresh list. (Deferred: push-based update to live-open Start menus.)

### 5. Launched apps open behind the dApp Centre window (MEDIUM — UX rough edge)

When the user clicks "Open" in the dApp Centre, the new app window is
created but the dApp Centre keeps the top z-index — the new window
sits behind it and looks like nothing happened.

**Current state:** `IPC.js` line 155–157 does call `focusWindow()`
after launch, so the intended behavior already exists. The issue is
likely one of timing: the window is focused before it is fully
rendered, so the next render pass (triggered by the iframe's
content) pushes the dApp Centre back on top.

**Fix:** ensure focus happens on the next frame after window-ready,
or use a known-good call like `UIWindow.focus()` after a
`requestAnimationFrame`. Minor change in `launch_app.js` or `IPC.js`.

### 6. Install progress bar has no real-time insight (MEDIUM — UX polish)

The install modal currently shows only a single "Downloading package…"
string with two scripted progress jumps (10 % → 30 % → 90 % → 100 %).
Users report this feels opaque — they want reassurance that the
install is making progress.

**Root cause:** `POST /api/installed-apps/install` is synchronous
and returns only when done. There is no progress channel.

**Fix:** Add real-time stage-based progress via the existing
Socket.io broadcast infrastructure.

- `AppInstallService.install()` gains an optional `onProgress(stage, pct, meta)` param.
- `api/installed-apps.ts` install route wires `onProgress` →
  `broadcastToUser(io, wallet, 'install:progress', ...)`.
- Stages: `fetching` → `verifying` → `extracting` → `registering` → `done` (or `failed`).
- Parent Puter GUI (`src/gui/src/globals.js` / socket wiring)
  listens for `install:progress` and forwards to any live app-center
  iframe via postMessage.
- App-center listens for `apps:installProgress` postMessage, updates
  the progress bar label + percentage.

Fallback remains scripted stages so pre-refresh tests keep working.

## Implementation Plan

- [x] Frontend fix #1 — duplicates: `(a.app_name ?? a.name)` in `loadData` and `mergeApps` — `src/backend/apps/app-center/index.html`
- [x] Frontend fix #2 — real icons: new `launchAppIcons` map built from `/get-launch-apps`; catalog installed entries get `builtInIcon: launchAppIcons[cat.id]`; `getAppIconHtml` now accepts URL-style `src` (not only `data:`)
- [x] Backend fix #3 — `resolveBundleIcon()` helper: parses PWA web manifest `icons[]` for the largest square first, then probes a broader filename list (`logo.png`, `android-chrome-*.png`, `apple-touch-icon.png`, …) with `favicon.ico` only as a last-resort — `pc2-node/src/api/info.ts`
- [x] Frontend fix #4 — `apps:changed` dual-channel: WS `apps:changed` handler in `UIDesktop.js` + `apps:changed` postMessage handler in `IPC.js`; both re-fetch `/get-launch-apps` and refresh `window.launch_apps` so the next Start-menu open is fresh. Backend emits `apps:changed` on install AND uninstall.
- [x] Frontend fix #5 — `requestAnimationFrame` wrap around the `focusWindow()` call in IPC.js `launchApp` handler so focus runs AFTER the child iframe's first render pass.
- [x] Backend fix #6 — `InstallProgressCallback` type + `install(manifest, cid, onProgress?)`; stages emit at `fetching(5)`, `verifying(55)`, `extracting(60..90)`, `registering(95)`, `done(100)` / `failed`; extractTarGz reports throttled file-count progress every 5 entries; `installed-apps.ts` route bridges `onProgress` → `broadcastToUser(io, wallet, 'install:progress', …)`; `UIDesktop.js` forwards via `apps:installProgress` postMessage to every iframe; app-center only updates its modal when `appName === currentInstallAppId`.
- [x] Sync complete: `pc2-node/frontend/apps/app-center/index.html` kept in lock-step (it is a build artefact rebuilt from `src/backend/apps/` by `npm run build:frontend` inside pc2-node).
- [x] `yarn build` (tsc) clean, `ReadLints` clean, `npm run build:gui` produced a fresh `bundle.min.js` (markers verified: `install:progress`, `apps:changed`, `apps:installProgress`, `requestAnimationFrame`).
- [ ] **User smoke test** (see Testing Strategy).
- [ ] Commit once user confirms the smoke test.

## Acceptance Criteria

1. dApp Centre "All Apps" shows each user-installable dApp exactly **once**.
2. Installed dApps show their real bundle logo (not registry category SVG, not generic cube).
3. Uninstalling a dApp removes it from the Start Menu without a page reload (next Start-menu open is fresh).
4. Clicking "Open" in the dApp Centre brings the new app window to the front.
5. Install modal shows at least 4 distinct progress stages with real percentages derived from server events.
6. `git status` clean; `yarn build` exits 0; no new lint warnings.

## Files to Modify

- `src/backend/apps/app-center/index.html`
- `pc2-node/frontend/apps/app-center/index.html` (synced copy)
- `pc2-node/src/api/info.ts`
- `pc2-node/src/api/apps.ts`
- `pc2-node/src/api/installed-apps.ts`
- `pc2-node/src/services/AppInstallService.ts`
- `src/gui/src/IPC.js`
- `src/gui/src/helpers/launch_app.js` (if needed for fix #5)
- `src/gui/src/UI/UITaskbar.js`

## Testing Strategy

Smoke test per acceptance criteria after restart:

1. Open dApp Centre → Discover → All Apps. Count Glide Finance cards: must be 1.
2. Verify Glide and Elastos NFT cards show branded logos.
3. Uninstall Glide. Open Start Menu. Glide must not appear.
4. Reinstall Glide. Progress modal must show ≥ 4 distinct stages.
5. Click Open. New Glide window must be on top.

## Notes

- Scope deliberately batched because all 5 issues share the dApp
  Centre + Start Menu + install pipeline surface. Splitting would risk
  regressions between commits.
- This is the final pre-release sweep for the v1.2 dApp Centre UX.
  Deferred items (dark mode = DAPP-CENTRE-DARK-MODE) remain in v1.3
  queue.
