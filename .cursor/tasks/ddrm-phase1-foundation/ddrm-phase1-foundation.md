# Task: Elacity dDRM & dApp Store — Phase 1 Foundation

**Task ID**: ddrm-phase1-foundation
**Created**: 2026-03-03
**Status**: Review
**Priority**: High

## Description

Build the core app install infrastructure: SQLite schema, AppInstallService, REST API endpoints, and integration with the existing launch apps system. This enables installing, serving, and uninstalling dApps fetched from IPFS.

## Background

With Phase 1 prerequisites complete (wallet bridge, COOP/COEP headers), this task builds the foundational app install system that the dApp Store, Elacity Market, and Media Player will use.

## Requirements

### 1. Database Schema (Migration 16)
- [x] `installed_apps` table with: app_name (PK), title, version, cid, size, icon, description, author, permissions_json, requirements_json, manifest_json, installed_at, updated_at
- [x] Index on `cid` column
- [x] Schema version bumped from 15 to 16
- [x] Migration added to `migrations.ts`
- [x] `InstalledApp` interface in `database.ts`
- [x] CRUD methods: `getInstalledApp`, `listInstalledApps`, `registerInstalledApp`, `uninstallApp`

### 2. AppInstallService
- [x] `install(manifest, cid)` — Fetch from IPFS, validate, extract, register
- [x] `installFromLocal(manifest, localDir)` — Sideloading for development
- [x] `uninstall(appName)` — Remove files + db record
- [x] `update(manifest, cid)` — Uninstall old, install new
- [x] `list()` / `get(appName)` — Query methods
- [x] Manifest validation (name format, required fields)
- [x] 100MB per-app size limit
- [x] Entry file verification (default: index.html)
- [x] Files stored at `data/installed-apps/<name>/`

### 3. REST API Endpoints
- [x] `GET /api/installed-apps` — List all installed apps
- [x] `GET /api/installed-apps/:name` — Get single app details
- [x] `POST /api/installed-apps/install` — Install from IPFS CID + manifest
- [x] `POST /api/installed-apps/install-local` — Sideload from local dir
- [x] `POST /api/installed-apps/update` — Update to new CID
- [x] `DELETE /api/installed-apps/:name` — Uninstall
- [x] All endpoints require authentication

### 4. Launch Apps Integration
- [x] `handleGetLaunchApps()` merges installed apps into `recommended` array
- [x] `handleGetApp()` falls back to installed apps when not found in built-in map
- [x] Installed apps include `installed: true` flag for frontend differentiation

### 5. Static File Serving
- [x] Installed apps served at `/installed-apps/<name>/*`
- [x] Directory traversal protection
- [x] Wallet provider shim injected into HTML
- [x] Per-app COOP/COEP headers from manifest requirements
- [x] Skipped by express.static wrapper to avoid conflicts

## App Manifest Format

```json
{
  "name": "media-player",
  "title": "Elacity Media Player",
  "version": "1.0.0",
  "description": "DRM-protected media playback powered by Elacity dDRM",
  "author": "Elacity Labs",
  "icon": "data:image/svg+xml;base64,...",
  "entry": "index.html",
  "permissions": ["wallet", "storage"],
  "requirements": {
    "headers": ["cross-origin-isolation"],
    "services": ["ipfs"]
  }
}
```

## Files Created

| File | Purpose |
|------|---------|
| `pc2-node/src/services/AppInstallService.ts` | Core install/uninstall/update service |
| `pc2-node/src/api/installed-apps.ts` | REST API router for installed apps |

## Files Modified

| File | Change |
|------|--------|
| `pc2-node/src/storage/schema.sql` | Added `installed_apps` table + index (schema v16) |
| `pc2-node/src/storage/migrations.ts` | Added Migration 16, bumped CURRENT_VERSION to 16 |
| `pc2-node/src/storage/database.ts` | Added `InstalledApp` interface + 4 CRUD methods |
| `pc2-node/src/api/index.ts` | Import + register AppInstallService + router at `/api/installed-apps` |
| `pc2-node/src/api/info.ts` | Merge installed apps into `handleGetLaunchApps()` response |
| `pc2-node/src/api/apps.ts` | Fallback lookup for installed apps in `handleGetApp()` |
| `pc2-node/src/static.ts` | Static file serving for `/installed-apps/*` with shim injection + COOP/COEP |

## Acceptance Criteria

- [x] TypeScript compiles clean (`npx tsc --noEmit` passes)
- [x] Backend builds successfully (`npm run build:backend`)
- [x] `installed_apps` table created on migration
- [x] POST `/api/installed-apps/install` accepts manifest + CID and writes files to disk
- [x] GET `/get-launch-apps` includes installed apps in response
- [x] GET `/apps/<installed-app-name>` returns app metadata
- [x] Installed app HTML served at `/installed-apps/<name>/index.html` with wallet shim injected
- [ ] End-to-end test with a real app bundle (next task)

## Testing Strategy

Manual testing sequence:
1. Start pc2-node, verify migration 16 runs
2. Install a test HTML app via `POST /api/installed-apps/install-local`
3. Verify it appears in `GET /get-launch-apps`
4. Verify it's served at `/installed-apps/<name>/index.html`
5. Verify wallet shim is injected in served HTML
6. Uninstall via `DELETE /api/installed-apps/<name>`
7. Verify it's removed from launch apps and disk

## Notes

- Bundle extraction currently supports single-file HTML. Multi-file tar/zip extraction will be added when needed for the Elacity Market app.
- The `installFromLocal` method enables sideloading during development without requiring IPFS.
- Installed apps are global (not per-wallet) since this is a personal node. Multi-tenant would need a wallet_address column.
