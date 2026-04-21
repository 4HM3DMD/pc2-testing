# Task: Creator — Local IPFS Fallback for Thumbnail Upload

**Task ID**: CREATOR-THUMBNAIL-FALLBACK
**Created**: 2026-04-21 · **Shipped**: 2026-04-21
**Status**: ✅ Done — fix shipped in `pc2-node/data/test-apps/elacity-creator/app.js` (and synced to `installed-apps/`). Mirror QA pass against a degraded Elacity IPFS still pending — recommend running before V1.2 tag.
**Priority**: P1 — High (assets minted while Elacity IPFS pinning is degraded permanently lose their thumbnail)
**Target Release**: V1.2 (end of April 2026)
**Related**: `.cursor/tasks/ELACITY-IPFS-UPLOAD-502/ELACITY-IPFS-UPLOAD-502.md`,
`.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md`

## TL;DR

When `POST /api/storage/ipfs/upload-elacity` fails (currently 502 + slow due to
Elacity pinning service degradation), the encrypted **media asset** and the
**metadata directory** correctly fall back to a local IPFS CID via Helia.
The **thumbnail** does not — it is silently dropped and the asset's metadata
records `imageUri = ""`.

Result: even after Elacity IPFS recovers, those assets will permanently
display the generic file-type icon in the marketplace, file manager, and
Elacity Player. There is no path to "heal" them retroactively because the
metadata.json is already pinned with the empty thumbnail field.

## How to reproduce (current bug, in the field as of 2026-04-21)

1. In Elacity Creator, mint any asset with a user-selected thumbnail (audio
   `.mp3`, video `.mp4`, image, document — all paths share the bug).
2. Observe console:
   ```
   [Creator] Using user-selected thumbnail
   :4200/api/storage/ipfs/upload-elacity:1  Failed to load resource: 502 (Bad Gateway)
   [Creator] No thumbnail generated — asset will have no preview image in marketplace
   ```
3. Open the resulting `.ddrm` from the Videos folder. Player iframe receives
   `THUMBNAIL: (empty)` in `puter.args`. Player shows the default music-note
   / film-strip icon. File manager shows the default DDRM shield icon.

## Root cause (file + line)

`pc2-node/data/test-apps/elacity-creator/app.js` ~L3119–L3137:

```js
if (thumbBase64) {
  var thumbResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: thumbBase64, filename: 'thumbnail.jpg' }),
  });
  if (thumbResp.ok) {
    var thumbData = await thumbResp.json();
    imageUri = 'ipfs://' + thumbData.cid;
    console.log('[Creator] Thumbnail uploaded:', imageUri);
  }
  // ← BUG: no else branch. On failure imageUri stays null.
}

if (!imageUri) {
  console.warn('[Creator] No thumbnail generated — asset will have no preview image in marketplace');
}
```

Compare with the **asset** upload path at `app.js` L2873–L2900 (correct):

```js
var assetCid = localAssetCid;        // computed earlier via local /api/storage/ipfs/add
try {
  var elacityAssetResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', { ... });
  if (elacityAssetResp.ok) {
    var elacityAssetData = await elacityAssetResp.json();
    assetCid = elacityAssetData.cid;
  }
} catch (_) { /* ignore — keep localAssetCid */ }
// assetCid is always set: prefers Elacity, falls back to local
```

The asset path has belt-and-braces; the thumbnail path has belt only. Same
fix needed in three call-sites in `app.js`:

| Use | Line approx. | Currently fails-silent? |
|---|---|---|
| Encrypted asset | 2877 | ❌ has fallback (`localAssetCid`) |
| **Thumbnail**   | **3120** | ✅ **silent drop — this task** |
| Metadata JSON | 3313 | ❌ has fallback (`localMetaDirCid`) |

## Fix design

1. Before attempting the Elacity upload, **always** call
   `POST /api/storage/ipfs/add` (local Helia) with the same `thumbBase64`
   and store the returned CID as `localThumbCid`.
2. On Elacity success, use `'ipfs://' + thumbData.cid` as today.
3. On Elacity failure (non-2xx **or** thrown), use `'ipfs://' + localThumbCid`.
4. Only emit "No thumbnail generated" when **both** the user-selected and
   auto-generated thumbnail steps produced no bytes (`thumbBase64` is empty),
   not when the upload failed.

Pseudo-diff:

```js
if (thumbBase64) {
  // Always pin locally first; this guarantees the bytes are reachable
  // via *some* IPFS gateway even if Elacity's pinning service is down.
  let localThumbCid = null;
  try {
    const localResp = await pc2Fetch('/api/storage/ipfs/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: thumbBase64, filename: 'thumbnail.jpg' }),
    });
    if (localResp.ok) {
      const localData = await localResp.json();
      localThumbCid = localData.cid;
    }
  } catch (e) {
    console.warn('[Creator] Local thumbnail pin failed:', e.message);
  }

  let elacityThumbCid = null;
  try {
    const thumbResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: thumbBase64, filename: 'thumbnail.jpg' }),
    });
    if (thumbResp.ok) {
      const thumbData = await thumbResp.json();
      elacityThumbCid = thumbData.cid;
    }
  } catch (e) {
    console.warn('[Creator] Elacity thumbnail upload failed (will use local CID):', e.message);
  }

  // Prefer Elacity (faster global discovery), fall back to local
  if (elacityThumbCid) {
    imageUri = 'ipfs://' + elacityThumbCid;
    console.log('[Creator] Thumbnail pinned to Elacity:', imageUri);
  } else if (localThumbCid) {
    imageUri = 'ipfs://' + localThumbCid;
    console.log('[Creator] Thumbnail pinned locally only (Elacity unreachable):', imageUri);
  }
}
```

## Acceptance criteria

- [ ] When `/api/storage/ipfs/upload-elacity` returns 502, the minted
      asset's `metadata.json` still has a non-empty `imageUri` (a local
      IPFS CID).
- [ ] Player (`pc2-media-runtime`) receives that CID in `puter.args.thumbnail`
      and displays the cover art (audio) / poster (video).
- [ ] File manager `.ddrm` thumbnail rendering uses the same CID.
- [ ] When Elacity IPFS recovers, the same `metadata.json` continues to
      work — Elacity's gateway will eventually pull the bytes from PC2 via
      DHT (depends on `IPFS-ELACITY-BOOTSTRAP` for fast resolution).
- [ ] No regression in the happy path (Elacity up): `imageUri` still
      points at Elacity-pinned CID, not the local one.
- [ ] Console log clearly distinguishes the three states: pinned-elacity,
      pinned-local-only, no-bytes-at-all.

## Files to modify

- `pc2-node/data/test-apps/elacity-creator/app.js` — the thumbnail block
  around L3119–L3137.
- After test passes, copy to `pc2-node/data/installed-apps/elacity-creator/app.js`
  (Puter app two-copy deployment — see `V12_SIGAUTH_HANDOVER.md` §"App
  deployment gotcha").

## Out of scope

- Fixing the underlying Elacity IPFS 502 — that's `ELACITY-IPFS-UPLOAD-502`.
- Re-issuing thumbnails for already-minted broken assets. Those assets
  must be re-minted manually by their creator.

## Notes

- Same fallback pattern should also apply to the **asset** and **metadata**
  paths — they currently catch `try { … } catch` but do *not* check the
  HTTP status code. A non-2xx Elacity response (502) currently uses the
  Elacity (broken) CID instead of the local one. Verify and fix in same PR.
- This bug has been latent for the entire life of the Creator. It only
  surfaced now because Elacity's upload endpoint started returning 502.
  Without that, every dev test happened to hit the happy path.
