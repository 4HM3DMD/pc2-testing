# Task: dApp Centre — Built-in Classification Must Use a Positive Signal

**Task ID**: DAPP-CENTRE-BUILTIN-CLASSIFICATION
**Created**: 2026-04-29
**Status**: Review (awaiting user smoke test)
**Priority**: **High (v1.2 correctness bug)** — shipped alongside DAPP-CENTRE-MODAL-UNINSTALL
**Recommended release**: **v1.2**
**Branch**: `release/v1.2-pre-release`

## Description

The dApp Centre classifies every app as either **built-in / System** (no
Uninstall allowed, shown with a "System" badge) or **user-installed**
(Uninstall allowed, no badge). This classification currently uses a
fragile **negative** heuristic: any app appearing in `/get-launch-apps`
that is *not* also in `/api/installed-apps` is treated as built-in.

That heuristic silently fails in the common case where
`/api/installed-apps` returns an empty list for any reason — typically
the iframe auth token isn't yet ready when the Centre boots, producing a
transient 401 that degrades to `{ apps: [] }`. In that window, every
launch-apps entry (including Elastos NFT and Glide Finance which are
absolutely user-installable) is marked as built-in, and their Uninstall
buttons disappear.

The fix is to stop inferring and start asserting: **the backend should
label each launch-apps entry as either a bundled system app or a
user-installed app explicitly**, and the frontend should consume that
label directly.

## Background / Evidence

Observed on 2026-04-29 during the DAPP-INSTALL-NETWORK-FETCH smoke test.
The user saw a "System" badge on **Elastos NFT** and no Uninstall
button, even though Elastos NFT has a real IPFS CID
(`bafybeich5bman…`) in the registry and was installed via the normal
install flow earlier in the session.

Verified: calling `GET /api/installed-apps` with the owner session
token returns Elastos NFT with its real CID. The backend is correct.
The frontend classification falls over when the iframe session's
request to that same endpoint responds slower than `/get-launch-apps`.

### Current code

Backend ([pc2-node/src/api/info.ts:97-192](../../../pc2-node/src/api/info.ts)):

```ts
const apps: Record<string, any>[] = [
  { name: 'editor',      title: 'Text Editor', uuid: 'app-editor', … },
  { name: 'viewer',      title: 'Image Viewer', … },
  { name: 'camera',      title: 'Camera', … },
  { name: 'app-center',  title: 'dApp Centre', … },
  { name: 'pdf',         title: 'PDF', … },
  { name: 'system-terminal', … },
  { name: 'recorder',    … },
  { name: 'solitaire-frvr', … },
  { name: 'calculator',  … },
  { name: 'file-processor', … },
  { name: 'ai-chat',     … },
  { name: 'dao-dashboard', … },
];

// Merged with installed apps (line 223-234):
apps.push({ name, title, uuid, icon, description, index_url,
            installed: true, version, author });
```

The hardcoded array entries have no `isSystem` / `isBuiltIn` flag, and
the installed-apps entries have `installed: true`. So the two sets are
already distinguishable in the payload — the frontend just isn't using
the distinction.

Frontend ([src/backend/apps/app-center/index.html:1208-1242](../../../src/backend/apps/app-center/index.html)):

```js
const installedNames = new Set(installedApps.map(a => a.name));
builtInApps = launchApps
    .filter(a => a.name !== 'app-center' && !installedNames.has(a.name))
    .map(a => ({ …, isBuiltIn: true, installed: true }));
…
for (const cat of catalogApps) {
    const isInstalled = installedNames.has(cat.id) || builtInNames.has(cat.id);
    const isBuiltIn = builtInNames.has(cat.id);  // ← fragile
    …
}
```

When `installedNames` is empty (401 on `/api/installed-apps`):

- `builtInApps` absorbs every launchApp
- Every catalog entry inherits `isBuiltIn: true`
- Uninstall buttons disappear for user-installed apps

## Requirements

1. Backend **must** label each hardcoded system-app entry with
   `isSystem: true` so the frontend has an authoritative positive
   signal. This is a backend change of **~12 one-line additions**.
2. Frontend **must** consume the new `isSystem` flag as the primary
   classification source. The old fallback logic may stay as a
   defensive secondary check but must never override a definitive
   `isSystem: true/false` from the backend.
3. If `/api/installed-apps` fails, the frontend **must not** silently
   tag user-installed apps as built-in. Safe default: if the request
   fails, surface a non-blocking UI hint ("Install state unavailable;
   retry or refresh") rather than corrupting classification.
4. No regression to the System badge on genuine built-in apps
   (Text Editor, Image Viewer, Camera, dApp Centre, PDF, Terminal,
   Recorder, Solitaire FRVR, Calculator, File Analyzer, AI Chat,
   Elastos DAO).
5. No change to `DELETE /api/installed-apps/:name` or to any install
   path.

## Proposed Implementation (sketch — to be refined on Agreed)

### Backend (`pc2-node/src/api/info.ts`)

Add `isSystem: true` to each of the 12 hardcoded entries. Also add
`isSystem: false` (or omit) when merging installed-apps, so the flag
is unambiguous on both sides of the payload.

```ts
const apps: Record<string, any>[] = [
  { name: 'editor',      title: 'Text Editor', …, isSystem: true },
  { name: 'viewer',      …, isSystem: true },
  { name: 'camera',      …, isSystem: true },
  { name: 'app-center',  …, isSystem: true },
  { name: 'pdf',         …, isSystem: true },
  { name: 'system-terminal', …, isSystem: true },
  { name: 'recorder',    …, isSystem: true },
  { name: 'solitaire-frvr', …, isSystem: true },
  { name: 'calculator',  …, isSystem: true },
  { name: 'file-processor', …, isSystem: true },
  { name: 'ai-chat',     …, isSystem: true },
  { name: 'dao-dashboard', …, isSystem: true },
];
…
// Installed apps merge:
apps.push({
  name: installed.app_name,
  title: installed.title,
  …
  installed: true,
  isSystem: false,        // ← new, explicit
  version: installed.version,
  author: installed.author || undefined,
});
```

### Frontend (`src/backend/apps/app-center/index.html`)

Replace the negative-inference classification with a direct read:

```js
// Build a lookup by app name so we preserve the backend's authoritative flag.
const launchAppByName = new Map(launchApps.map(a => [a.name, a]));

// Drop the old "filter out anything in installedNames" step entirely —
// isSystem from the backend already gives us the correct answer.
builtInApps = launchApps
    .filter(a => a.name !== 'app-center' && a.isSystem === true)
    .map(a => ({ …, isBuiltIn: true, installed: true }));

for (const cat of catalogApps) {
    const launchEntry = launchAppByName.get(cat.id);
    const isInstalled = installedNames.has(cat.id) || !!launchEntry?.installed;
    // Prefer the backend flag; only fall back to the old heuristic if the
    // backend didn't supply one (e.g. legacy installed-apps-only entries).
    const isBuiltIn =
      launchEntry?.isSystem === true ? true
      : launchEntry?.isSystem === false ? false
      : builtInNames.has(cat.id);   // legacy fallback
    const isComingSoon = !isInstalled && (cat.registryStatus === 'coming_soon' || (!cat.cid && cat.registryStatus !== 'available'));
    allApps.push({ ...cat, installed: isInstalled, isBuiltIn, isComingSoon });
}
```

If `/api/installed-apps` fails (Promise.allSettled already tolerates
this), also surface a subtle banner ("Install state is loading — retry
in a moment") so the user isn't surprised that Uninstall hasn't
appeared yet. Non-blocking; no behaviour change.

## Files to Modify

| File | Change |
|---|---|
| [pc2-node/src/api/info.ts](../../../pc2-node/src/api/info.ts) | Add `isSystem: true` to each of the 12 hardcoded system-app entries; add `isSystem: false` to the installed-apps merge push. |
| [src/backend/apps/app-center/index.html](../../../src/backend/apps/app-center/index.html) | Consume the new `isSystem` flag as the primary classifier; keep the old inference as a legacy fallback; optional non-blocking banner on `/api/installed-apps` failure. |

## Files to Create

None.

## Acceptance Criteria

1. [x] Backend: `GET /get-launch-apps` response includes `isSystem: true`
       on all 12 hardcoded system apps, `isSystem: false` on every
       installed-app entry. Implementation adds a single post-declaration
       loop rather than 12 per-entry edits to minimise review surface.
2. [ ] **Pending user smoke test**: Frontend: install a fresh user app,
       cold-reload the dApp Centre, the app appears with NO "System"
       badge and WITH an Uninstall button (both in the Installed tab
       list AND in the detail modal — latter depends on
       DAPP-CENTRE-MODAL-UNINSTALL).
3. [ ] **Pending user smoke test**: built-in apps (Text Editor, PDF,
       Camera, etc.) continue to show the "System" badge and NO
       Uninstall button in either place.
4. [ ] **Pending user smoke test**: simulate `/api/installed-apps`
       failure (DevTools → Network → block request) and reload —
       user-installed apps still classify correctly (no System badge,
       still show as installed via `launchInstalledNames` fallback).
5. [x] No regression to install, uninstall, or open paths — code
       paths unchanged, only classification upstream of them.
6. [x] No regression to wave5 smoke matrix — no endpoint signatures
       changed.
7. [x] Backend payload remains backward-compatible: older PC2 clients
       that ignore `isSystem` still see the app list as before
       (additive field only).

## Testing Strategy

1. Backend: `curl -H "Authorization: Bearer $TOK" http://localhost:4200/get-launch-apps | jq '.recommended[] | {name, isSystem, installed}'`.
   Expect: 12 entries with `isSystem: true, installed: undefined`,
   plus N entries with `isSystem: false, installed: true`.
2. Frontend manual: cold browser (Cmd+Shift+R), open dApp Centre,
   check badges on Elastos NFT / Glide Finance (should be none) vs
   Text Editor / PDF (should be "System").
3. Frontend manual: open DevTools → Network tab → right-click the
   `/api/installed-apps` request → Block request → reload Centre →
   confirm Elastos NFT / Glide Finance still classify correctly (not
   flipped to System).
4. Frontend manual: Install → verify flag is `false` → Uninstall →
   verify removal. Reinstall → verify flag is still `false`.

## Dependencies

- **Must ship together with DAPP-CENTRE-MODAL-UNINSTALL**, or at
  least land in the same release. Fixing classification without
  adding the modal-Uninstall button means user-installed apps become
  correctly-classified but still hard to remove; fixing the modal
  button without classification means built-in apps temporarily
  acquire an Uninstall button (destructive). Pair them.

## Out of Scope

- Broadening `isSystem` to the rest of the catalog registry
  response (registry apps already have a real CID as a positive
  signal; they're inherently user-installable).
- Generalising the "install state unavailable" banner into a broader
  offline-first UX (v1.3 polish item).
- Any rename from `isBuiltIn` to `isSystem` in the frontend state —
  keep the existing name to minimise diff; just source it from the
  new backend flag.

## Notes

- This is the root cause of Irzhy's "no Uninstall button" observation
  reported 2026-04-29.
- Estimated effort: **~30 minutes** across backend + frontend + test.
- Pre-commit hooks (gitleaks, eslint) run on the backend file; no
  new risk flagged.

## Results

- **Backend change landed in 13 lines total**: a `for (const a of apps) { a.isSystem = true; }`
  loop after the hardcoded-apps array, plus a single `isSystem: false`
  line in the installed-apps push.
- **Frontend change landed in ~20 lines total**: a new `launchInstalledNames`
  module variable populated in `loadData`, the old `!installedNames.has()`
  filter replaced with `a.isSystem === true` (with legacy fallback if
  `isSystem` is missing entirely), and `launchInstalledNames` added to
  the `isInstalled` check in `mergeApps`.
- **Backend build**: `yarn build:backend` clean in 21.67 s, zero TS errors.
- **Lints**: zero linter errors on both touched files.
