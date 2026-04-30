# Task: dApp Centre — Detail Modal Should Offer Uninstall

**Task ID**: DAPP-CENTRE-MODAL-UNINSTALL
**Created**: 2026-04-29
**Status**: Review (awaiting user smoke test)
**Priority**: Medium (v1.2 polish — UX completeness)
**Recommended release**: **v1.2** — shipped alongside DAPP-CENTRE-BUILTIN-CLASSIFICATION
**Branch**: `release/v1.2-pre-release`

## Description

When a user clicks an installed, user-installable dApp in the dApp Centre
(e.g. Elacity NFT, Glide Finance) to open the app-detail modal, the modal
footer only offers **Open** and **Close**. There is no way to uninstall
the app from the modal — the user has to leave the modal, switch to the
**Installed** tab, find the app in the list view, and only then see the
Uninstall button.

This is a discoverability gap, not a functional one: the Uninstall
capability *does* exist in the Installed-tab list renderer
([src/backend/apps/app-center/index.html:1501](../../../src/backend/apps/app-center/index.html)),
it is just never wired into `showAppDetail()`.

## Background / Evidence

Observed on 2026-04-29 during the DAPP-INSTALL-NETWORK-FETCH smoke test.
The user clicked into the Elastos NFT tile from the Discover view,
expecting to either see the app's info or be able to manage it, and
found only **Open** / **Close** buttons in the modal footer. The
Installed-tab list view did correctly show an Uninstall button for the
same app in the same session.

### Current code

[src/backend/apps/app-center/index.html:1526-1533](../../../src/backend/apps/app-center/index.html):

```js
let actionBtn;
if (app.installed || app.isBuiltIn) {
    actionBtn = `<button class="modal-btn primary" onclick="closeDetailModal(); openApp('${app.id}')">Open</button>`;
} else if (app.isComingSoon) {
    actionBtn = `<button class="modal-btn disabled">Coming Soon</button>`;
} else {
    actionBtn = `<button class="modal-btn primary" onclick="closeDetailModal(); installApp('${app.id}')">Install</button>`;
}
```

Then in the modal footer (line 1588-1592):

```html
<div class="modal-footer-actions">
    <button class="modal-btn secondary" onclick="closeDetailModal()">Close</button>
    ${actionBtn}
</div>
```

### Why the current logic is incomplete

The three mutually exclusive states (Open / Coming Soon / Install) do not
express the fourth legitimate state: the user owns an installable app
and may want to remove it. The Installed-tab list-view renderer already
knows this case — it guards the Uninstall button with `!app.isBuiltIn`
(line 1501). The modal just never runs that check.

## Requirements

1. When the modal is opened for an app where `app.installed === true`
   and `app.isBuiltIn === false`, the footer must offer an **Uninstall**
   button in addition to **Open** and **Close**.
2. The Uninstall button must call the existing `uninstallApp(appId)`
   function (already proven in the list view), which handles the
   confirm-dialog and the `DELETE /api/installed-apps/:name` call.
3. Built-in / system apps (`app.isBuiltIn === true`) must NOT show
   Uninstall, matching the existing list-view behaviour.
4. Coming-soon apps (`app.isComingSoon === true`) must NOT show
   Uninstall (they aren't installed in the first place).
5. No change to any other button, no change to backend, no change to
   HTTP contract, no change to list-view rendering.

## Proposed Implementation (sketch — to be refined on Agreed)

Modify `showAppDetail()` to compute an optional secondary-action block,
inserted into the footer alongside Open/Close:

```js
let actionBtn;
let uninstallBtn = '';
if (app.installed || app.isBuiltIn) {
    actionBtn = `<button class="modal-btn primary" onclick="closeDetailModal(); openApp('${app.id}')">Open</button>`;
    if (app.installed && !app.isBuiltIn) {
        uninstallBtn = `<button class="modal-btn danger" onclick="closeDetailModal(); uninstallApp('${app.id}')">Uninstall</button>`;
    }
} else if (app.isComingSoon) {
    actionBtn = `<button class="modal-btn disabled">Coming Soon</button>`;
} else {
    actionBtn = `<button class="modal-btn primary" onclick="closeDetailModal(); installApp('${app.id}')">Install</button>`;
}
```

Then:

```html
<div class="modal-footer-actions">
    <button class="modal-btn secondary" onclick="closeDetailModal()">Close</button>
    ${uninstallBtn}
    ${actionBtn}
</div>
```

If the existing stylesheet doesn't already have a `.modal-btn.danger`
variant, reuse the red/warning styling from `.action-btn.uninstall`
used in the list view to keep visual consistency.

## Files to Modify

| File | Change |
|---|---|
| [src/backend/apps/app-center/index.html](../../../src/backend/apps/app-center/index.html) | `showAppDetail()` gains a conditional Uninstall button; optionally add `.modal-btn.danger` CSS variant if not already defined. |

## Files to Create

None.

## Acceptance Criteria

1. [ ] **Pending user smoke test**: Open dApp Centre, click a
       user-installed app tile (e.g. Elastos NFT), modal footer shows
       **Close | Uninstall | Open** (left-to-right).
2. [ ] **Pending user smoke test**: Open dApp Centre, click a bundled
       system-app tile (e.g. Text Editor), modal footer shows only
       **Close | Open** — no Uninstall.
3. [ ] **Pending user smoke test**: Open dApp Centre, click a
       coming-soon app tile, modal footer shows only **Close | Coming Soon** —
       no Uninstall.
4. [ ] **Pending user smoke test**: Clicking Uninstall from the modal
       closes the modal, triggers the existing `confirm()` dialog, then
       the existing `DELETE /api/installed-apps/:name` call, then the
       app vanishes from both Discover and Installed views.
5. [x] No regression to the existing Uninstall button in the
       Installed-tab list view — that code path is untouched.
6. [x] No regression to Install, Open, or Close behaviour — buttons
       reused verbatim.
7. [x] No backend change — wave5 smoke matrix unaffected.

## Testing Strategy

1. Manual: exercise all three button-permutation paths described above
   in the dApp Centre UI.
2. Manual: uninstall an app via the modal, reinstall it via the modal,
   confirm a clean round-trip.
3. Manual: smoke-test Text Editor / AI Chat / PDF / etc. modals to
   confirm built-in classification still suppresses Uninstall.
4. No automated tests; this is UI wiring only.

## Dependencies

- **Strongly recommended**: complete DAPP-CENTRE-BUILTIN-CLASSIFICATION
  first. If the `app.isBuiltIn` flag is miscomputed (current fallback
  bug), this task's Uninstall button will appear on genuine built-in
  apps too. Shipping this task alone would therefore make a latent bug
  visibly destructive. Either land both in the same release, or land
  classification first and ship this as a follow-up.

## Out of Scope

- Any change to the Installed-tab list view layout.
- Any backend change (`DELETE /api/installed-apps/:name` already exists
  and works).
- Adding an "Update" button for apps with newer registry versions
  (separate concern; tracked informally as a v1.3 polish item).
- Dark-mode styling (tracked separately under DAPP-CENTRE-DARK-MODE).

## Notes

- This is purely an HTML/JS change inside one file. No TypeScript
  compilation needed.
- The dApp Centre is served directly from
  `src/backend/apps/app-center/index.html`; a hard-refresh (Cmd+Shift+R)
  picks up the change after it lands.
- Estimated effort: **~15 minutes** including test.

## Results

- **Change landed in 1 file, ~14 lines total**: added a `.modal-btn.danger`
  CSS variant (6 lines, mirrors the existing `.action-btn.uninstall`
  styling), added an `uninstallBtn` computation in `showAppDetail()`
  gated by `app.installed && !app.isBuiltIn` (5 lines), and slotted
  the button between Close and the primary action in the modal footer
  (1 line).
- **Button ordering in the modal footer**: Close | Uninstall | Open
  (or Close | Install for uninstalled apps, or Close | Coming Soon).
  Uninstall sits between Close and the primary so destructive action
  is visually separated from the default/positive action.
- **Lints**: zero linter errors.
