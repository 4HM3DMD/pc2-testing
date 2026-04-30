# PC2 patch — 3 lines to wire up the launcher

ENM is a pure extension: all backend code, frontend, DB tables, encryption, and audit logging live inside `pc2.net/extensions/elastos-node-manager/`.

The **only** PC2 modifications required are three single-line additions so the launcher knows the extension exists. PC2 owners apply these manually.

If you skip these patches, ENM still works — you just have to open it via direct URL: `http://localhost:4200/extensions/elastos-node-manager/`. The patches just make it appear as an icon in PC2's app launcher.

---

## Patch 1 — register the icon (apps.ts)

**File:** `pc2.net/pc2-node/src/api/apps.ts`

In the `hardcodedIcons` object near the top of the file (around line 12-25), add one line:

```diff
 const hardcodedIcons: Record<string, string> = {
   'editor': 'data:image/svg+xml;base64,...',
   'dao-dashboard': 'data:image/svg+xml;base64,...',
+  'elastos-node-manager': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTAiIGZpbGw9IiMzYjgyZjYiLz48cGF0aCBkPSJNMTQgMTRoMjB2NEgxOHYxMmgxNnY0SDE0eiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjM0IiBjeT0iMzQiIHI9IjQiIGZpbGw9IiMyMmM1NWUiLz48L3N2Zz4=',
   ...
 };
```

The base64 above decodes to the icon at `pc2.net/extensions/elastos-node-manager/public/assets/icon.svg`. If you change the icon, run `base64 -w0 < icon.svg` and paste the result here.

---

## Patch 2 — register the app entry (apps.ts)

**File:** `pc2.net/pc2-node/src/api/apps.ts`

In the `appMap` object (around line 41-160), add one entry:

```diff
 const appMap: Record<string, any> = {
   ...
+  'elastos-node-manager': {
+    name: 'elastos-node-manager',
+    title: 'Elastos Node Manager',
+    uuid: 'app-elastos-node-manager',
+    uid: 'app-elastos-node-manager',
+    icon: hardcodedIcons['elastos-node-manager'],
+    index_url: `${baseUrl}/extensions/elastos-node-manager/`,
+    description: 'Manage and monitor your Elastos chain validator node',
+    pc2_exclusive: true,
+    maximize_on_start: false
+  },
 };
```

This shape is copied verbatim from the existing `dao-dashboard` entry — same fields, same conventions. The `index_url` points at our extension's static frontend (no `/index.html` suffix needed; our `routes/index.js` serves the file at the trailing slash).

---

## Patch 3 — make the app appear in the recent-apps list

**File:** `pc2.net/src/backend/src/modules/apps/RecommendedAppsService.js`

Add the app name to the `APP_NAMES` whitelist (around line 30):

```diff
-const APP_NAMES = ['editor', 'terminal'];
+const APP_NAMES = ['editor', 'terminal', 'elastos-node-manager'];
```

Without this, the app exists but doesn't surface in PC2's "recently used" / suggestions panel.

---

## Total scope

3 lines added across 2 files. No deletions. No PC2 schema changes, no middleware modifications, no new dependencies in `pc2-node/package.json`.

After applying, restart PC2 and the app icon should appear in the launcher. Click it → extension's `/extensions/elastos-node-manager/` is loaded in an iframe with the standard PC2 wallet handshake.

---

## Why this is the minimum

PC2 has no runtime app-registration API today (verified Rev 5 audit). The `appMap` is a hardcoded `Record<string, AppEntry>` in `apps.ts`. Adding an entry there is the only way the launcher knows our app exists.

If PC2 later exposes a generic registration hook (suggested as upstream PR #5 in the v0.1 plan), this manual patch goes away — the extension declares its launcher entry in its own `package.json` instead. That's a v0.2 ergonomics improvement, not a v0.1 blocker.
