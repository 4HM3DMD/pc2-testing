# Task: dApp Centre — Dark Mode Support

**Task ID**: DAPP-CENTRE-DARK-MODE
**Created**: 2026-04-29
**Status**: Proposed
**Priority**: Low (polish / consistency)
**Recommended release**: **v1.3** (nice-to-have, not a v1.2 blocker)
**Branch**: TBD (fresh feature branch off `main` after v1.2.0 tag)

## Description

The dApp Centre
([src/backend/apps/app-center/index.html](../../../src/backend/apps/app-center/index.html))
is currently hard-coded to a light theme (`#f8fafc`, `#ffffff`,
`#e2e8f0`, etc. inlined throughout its ~1900-line single-file
implementation). The Puter desktop shell already supports a system-wide
dark mode toggle (the `pc2_dark_mode: true` localStorage flag visible
on every boot in the logs), and the Elacity Market capsule demonstrates
a clean `[data-theme="dark"]` CSS-variable pattern that the dApp Centre
should match.

This is purely cosmetic consistency — it does not fix any bug, does
not block any release-gate, and does not affect any install flow.

## Background / Evidence

Observed on 2026-04-29: after spending an hour in Elacity Market (which
respects dark mode) the user opens the dApp Centre and the screen goes
bright white. Asked: *"can't the dapp centre also have a dark mode
similar to what elacity market has?"*

### Reference pattern (proven in production)

Elacity Market already implements dark mode cleanly:

- CSS variables:
  [pc2-node/data/test-apps/elacity-market/styles.css:6-50](../../../pc2-node/data/test-apps/elacity-market/styles.css)

```css
:root {
  --bg-primary: #f5f5f5;
  --bg-secondary: #ffffff;
  --bg-card: #ffffff;
  --bg-card-hover: #f3f4f6;
  --bg-surface: #f0f0f0;
  /* ... foreground / border / accent vars ... */
}

[data-theme="dark"] {
  --bg-primary: #121212;
  --bg-secondary: #1a1a1a;
  --bg-card: #1e1e1e;
  --bg-card-hover: #2a2a2a;
  --bg-surface: #262626;
  /* ... */
}
```

- JS toggle:
  [pc2-node/data/test-apps/elacity-market/app.js:547-563](../../../pc2-node/data/test-apps/elacity-market/app.js)

```js
var saved = localStorage.getItem(THEME_KEY);
if (saved === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
} else {
  document.documentElement.removeAttribute('data-theme');
}

function toggleTheme() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem(THEME_KEY, 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem(THEME_KEY, 'dark');
  }
}
```

### Why dApp Centre diverges

The Centre file predates this pattern — its inline `<style>` block
uses literal hex colours (`background: #f8fafc`, `color: #0f172a`,
etc.) in ~60+ selectors. Refactoring to CSS variables is mechanical
but not trivial because of the breadth of selectors and pseudo-states
(`:hover`, `:focus`, `.active`, modals, badges, install-progress bar).

## Requirements

1. Introduce a `:root` CSS variable palette for the dApp Centre matching
   the semantic variable names already used by Elacity Market
   (`--bg-primary`, `--bg-secondary`, `--fg-primary`, `--border`,
   `--accent`, etc.) so the two capsules read as visually consistent.
2. Add a `[data-theme="dark"]` override palette with the same variable
   names, tuned to match Market's dark theme.
3. Replace every literal colour reference in the Centre's inline
   styles with the corresponding variable.
4. On page load, read the **shared** dark-mode preference. Options:
   - **(a) Sync with the parent Puter shell**: read
     `localStorage.getItem('pc2_dark_mode')` (already used by
     `src/gui/src/initgui.js`) and mirror it.
   - **(b) Capsule-local key**: new `app_center_theme` localStorage
     key, separate from Market and Puter. Simpler, but the user ends
     up toggling three times (Puter, Market, Centre) if they want
     consistent theming.
   - **Decision point** during Agreed: recommend **(a)** for v1.3
     since Puter already broadcasts a system-wide preference. If the
     shared read is fragile across iframe origins, fall back to (b).
5. Provide a UI affordance — either a toggle icon in the sidebar
   header (matching Market's placement) or a simple setting in a
   new "Preferences" panel. Recommend: sidebar header toggle, 28×28,
   sun/moon icons.
6. Respect `prefers-color-scheme` as the initial default for users
   who have set no explicit preference yet.
7. No regression to the install / uninstall / search flows. No
   backend change required.
8. No change to any icon asset: app icons already ship with
   transparent backgrounds and render correctly in both themes.

## Proposed Implementation (sketch — to be refined on Agreed)

### Phase A: palette extraction (~60 min)

1. Introduce the CSS variable set in the Centre's `<style>` block.
2. Grep every literal colour in the inline styles and replace with
   the corresponding variable. Use `var(--bg-primary)` etc.
3. Visual-diff light mode against the current screenshot to confirm
   zero visual change.

### Phase B: dark palette + toggle (~30 min)

1. Add the `[data-theme="dark"]` block.
2. Add the theme-toggle button + handler (copy-paste from Market).
3. On boot, read `localStorage.getItem('pc2_dark_mode')`; if `true`
   set `data-theme="dark"`. Otherwise check `prefers-color-scheme`.
4. On toggle click, flip the attribute AND write the same
   `pc2_dark_mode` key so Puter and Centre stay in sync.

### Phase C: polish pass (~30 min)

1. Modal backgrounds, progress bar, badges, code-block / pill colours.
2. Empty-state icons and text colours.
3. Hover / active states on all interactive elements.
4. Scrollbar styling in dark mode (Market's approach).

Total estimated effort: **~2 hours end-to-end, one file.**

## Files to Modify

| File | Change |
|---|---|
| [src/backend/apps/app-center/index.html](../../../src/backend/apps/app-center/index.html) | Inline style block gains `:root` variables + `[data-theme="dark"]` override; every literal colour swapped for a variable; JS gains a theme-toggle handler and boot-time preference read; sidebar header gains a toggle button. |

Optionally (out of scope for initial landing): extract the inline
stylesheet to `src/backend/apps/app-center/styles.css` as a separate
cleanup task. Recommended only if the single-file footprint becomes
a code-review blocker.

## Files to Create

None.

## Acceptance Criteria

1. [ ] Light mode renders byte-identical to the current light mode
       (same background, borders, text colours). Visual regression
       zero.
2. [ ] Dark mode renders with the same palette Elacity Market uses
       so the two capsules read as a set.
3. [ ] Theme toggle in the sidebar header flips instantly; no
       flash-of-wrong-theme on reload.
4. [ ] Theme persists across reloads within the Centre (localStorage).
5. [ ] Theme respects the Puter-wide `pc2_dark_mode` key on boot;
       toggling in the Centre updates that key so the Puter shell and
       Market pick it up on their next reload.
6. [ ] `prefers-color-scheme: dark` is the default for users who
       haven't set a preference yet.
7. [ ] No regression to install / uninstall / search / open paths.
8. [ ] No backend change, no wave5 smoke matrix change.

## Testing Strategy

1. Manual visual diff of every view in light mode (Discover tab,
   Installed tab, detail modal, install-progress modal, empty state)
   before and after the variable refactor. Must be identical.
2. Manual: toggle dark mode, exercise every view again, confirm no
   unreadable text, no white-on-white, no missing borders.
3. Manual: toggle in Puter shell → reload Centre → confirms dark
   (shared key works).
4. Manual: clear localStorage → reload → OS set to dark → Centre
   opens in dark (prefers-color-scheme fallback works).
5. No automated tests.

## Dependencies

- DAPP-CENTRE-MODAL-UNINSTALL + DAPP-CENTRE-BUILTIN-CLASSIFICATION
  should land **first**. Rebasing dark-mode variable work on top of
  a classification diff is cheap; the reverse (landing dark-mode first
  and then threading new Uninstall styling through the variable
  system) is not.

## Out of Scope

- System-wide theming primitives shared across multiple apps
  (separate concern; requires a shell-level design decision about
  whether to ship a `@puter/theme` CSS package).
- Custom theme colours beyond light/dark (v2 feature).
- Extracting the inline stylesheet into its own `.css` file
  (recommended follow-up, not a blocker for this task).

## Notes

- The current dApp Centre inline `<style>` block is ~600 lines; the
  mechanical variable-swap is tedious but low-risk.
- If we decide to do the stylesheet extraction at the same time,
  budget another ~60 minutes and file it under this same task.
- Pre-commit hooks do not touch HTML/CSS — no gitleaks or eslint
  friction expected.
