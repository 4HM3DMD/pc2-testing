# Session Handover — NFT IPFS Pinning + Elastos NFT Fixes
## April 16, 2026

> **Purpose:** Full context transfer for continuing NFT IPFS pinning implementation and Elastos NFT app testing.
> **Branch:** `feature/lit-chipotle-migration`
> **Last commit:** Uncommitted changes ready to commit (see below)

---

## Table of Contents

1. [Session Summary](#1-session-summary)
2. [What Was Implemented](#2-what-was-implemented)
3. [Current State — What Works](#3-current-state--what-works)
4. [Known Issues — What Needs Fixing](#4-known-issues--what-needs-fixing)
5. [Architecture Reference](#5-architecture-reference)
6. [File Map — What Changed](#6-file-map--what-changed)
7. [Build & Test Instructions](#7-build--test-instructions)
8. [Remaining Tasks](#8-remaining-tasks)
9. [Context Files to Read](#9-context-files-to-read)

---

## 1. Session Summary

This session focused on three areas within the Elastos NFT marketplace app (a separate app from the Elacity Market dDRM app):

1. **Fixed broken profile/banner images** — The `account.ts` transform was wrapping relative thumbnail URLs (`/api/esc-nft/thumbnails/...`) in `ipfsLink()`, producing broken URLs. Patched to recognize relative paths.

2. **Fixed dead IPFS gateways** — Both `cloudflare-ipfs.com` and `ipfs.ela.city` are dead/unreachable. Replaced all references with `ipfs.io` across source, env config, and post-build compiled JS.

3. **Implemented NFT IPFS Pinning** — Backend (database, API, migration) and frontend (pin/download buttons on NFT detail page, pin indicators on Library cards) for letting NFT owners pin their IPFS content to their PC2 node.

4. **Added Contabo ESC RPC proxy** — The user's Contabo server (38.242.211.112) runs a fully synced ESC archive node. Added nginx route on Contabo and a local `/api/esc-rpc` proxy endpoint with self-signed cert handling. The `rpcs.ts` in the Elastos NFT build has both Contabo proxy (primary) and `api.ela.city/esc` (fallback).

**IMPORTANT: The dDRM stack, Elacity Market app, and all IPFS infrastructure are 100% intact.** The Elastos NFT app is entirely separate — it's a pure NFT browsing/trading app for ESC (chain 20) with no DRM features.

---

## 2. What Was Implemented

### 2.1 Backend — NFT Pin Tracking

**Database (`pc2-node/src/storage/database.ts`)**
- `trackNFTPin()` — INSERT/upsert into `nft_pins` table
- `getNFTPins(walletAddress)` — List all user's pinned NFTs (joins `pinned_cids` for real-time status)
- `getNFTPin(cid, walletAddress)` — Get single pin status
- `removeNFTPin(cid, walletAddress)` — Delete tracking record
- `updateNFTPinStatus(cid, status)` — Update pin status (queued/complete/failed)

**Schema (`pc2-node/src/storage/schema.sql`)**
```sql
CREATE TABLE IF NOT EXISTS nft_pins (
  cid TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  contract_address TEXT,
  token_id TEXT,
  name TEXT,
  collection_name TEXT,
  mime_type TEXT,
  file_path TEXT,
  pin_status TEXT DEFAULT 'queued',
  pinned_at INTEGER,
  PRIMARY KEY (cid, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_nft_pins_wallet ON nft_pins(wallet_address);
CREATE INDEX IF NOT EXISTS idx_nft_pins_contract ON nft_pins(contract_address, token_id);
```

**Migration 27 (`pc2-node/src/storage/migrations.ts`)**
- Creates `nft_pins` table and indexes for existing databases

**API Endpoints (`pc2-node/src/api/storage.ts`)**
- `POST /api/nft/pin` — Pin NFT content (triggers seedingService or direct pinRemoteCID)
  - Creates virtual filesystem entry at `/{wallet}/Pictures/NFTs/{collection}/{name}.{ext}`
  - Body: `{ cid, name, collection, contractAddress, tokenId, mimeType }`
- `GET /api/nft/pins` — List all user's pinned NFTs
- `GET /api/nft/pin/:cid` — Get pin status for specific CID
- `DELETE /api/nft/pin/:cid` — Unpin and remove tracking

**Route Mounting (`pc2-node/src/api/index.ts`)**
- Storage router is now mounted at both `/api/storage` and `/api` so NFT pin routes work at `/api/nft/*`

### 2.2 Frontend — Build Script Patches

All frontend changes are build-time patches in `scripts/build-elastos-nft.sh`:

**ArtAssetView.tsx Patch (NFT Detail Page)**
- Adds "Pin to My Node" and "Download" buttons as a `<Stack>` below the NFT image
- Extracts IPFS CID from `metadata.image`, `imageURL`, or `tokenURI` fields
- Pin button states: "Pin to My Node" → "Pinning..." (spinner) → "Pinned to Node" (green)
- Download button: `handleDownloadNft()` via anchor tag with target `_blank`
- Auth: Extracts `puter.auth.token` from URL params, sends as `Authorization: Bearer` header
- Only visible when user is the NFT owner AND a valid IPFS CID is found

**MyVaultExplorer.tsx Patch (Library Page)**
- `PinnedCidsContext` React Context fetches `GET /api/nft/pins` once on mount
- Each library card wrapped with pin indicator overlay
- Green PushPin badge (small, top-right corner) shown for pinned NFTs
- Uses same auth token extraction pattern

**IPFS Gateway Replacement**
- Pre-build: sed + Python replaces `ipfs.ela.city` and `cloudflare-ipfs.com` with `ipfs.io` in:
  - `@elacity-js/lib/src/utils/url.sanitize.ts`
  - `.env` and `.env.production`
  - All `.ts`/`.tsx` source files
- Post-build: sed replaces any remaining references in compiled JS output
- Zero dead gateway references in final build

**Profile Image Fix (account.ts)**
- Patched: `imageHash` and `bannerHash` that start with `/` are used as-is (relative URLs to backend thumbnails)
- Previously, these relative URLs were incorrectly wrapped in `ipfsLink('/ipfs/...')`, producing broken URLs

### 2.3 Infrastructure

**Contabo ESC RPC**
- Contabo server (38.242.211.112) nginx updated: `/rpc/esc` → `proxy_pass http://127.0.0.1:20636` (local ESC archive node)
- PC2 node: `/api/esc-rpc` endpoint proxies JSON-RPC to Contabo with `rejectUnauthorized: false` for self-signed cert
- Build script patches `rpcs.ts`: primary = `http://localhost:4200/api/esc-rpc`, fallback = `https://api.ela.city/esc`

**Static Asset Resolution (`pc2-node/src/static.ts`)**
- Refactored `resolveInstalledAppAsset()` handler shared between `/images/*`, `/static/*`, `/fonts/*`
- Supports Referer-based app identification + fallback scan of installed apps directory

---

## 3. Current State — What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Elastos NFT Explore page | ✅ Working | Loads NFTs from ela.city ESC API |
| Profile/banner images | ✅ Fixed | Thumbnails resolve through `/api/esc-nft/thumbnails/...` |
| IPFS images | ⚠️ Partial | `ipfs.io` gateway works but is slow; some IPFS CIDs may timeout |
| Contabo ESC RPC | ✅ Working | Fully synced, responding via `/api/esc-rpc` proxy |
| NFT Pin API | ✅ Working | All 4 endpoints tested with auth (returns proper 401/200) |
| Pin button (detail page) | ⚠️ Needs testing | Code is in build output; auth fix applied; needs manual verification |
| Pin indicator (library) | ⚠️ Needs testing | Code is in build output; needs manual verification |
| Download button | ⚠️ Needs testing | Added alongside pin button; needs verification |
| dDRM (Elacity Market) | ✅ Intact | Completely untouched — separate app |
| Node IPFS stack | ✅ Intact | Helia, Bitswap, DHT, ContentSeedingService all working |

---

## 4. Known Issues — What Needs Fixing

### P0 — Must Fix
1. **Auth in iframe fetches** — The pin/download API calls need `puter.auth.token` from URL params. The build patches extract this, but browser sandbox restrictions may strip it in some cases. **Test manually** — if 401s persist, may need to use the `postMessage` bridge pattern instead.

2. **HIVE-stored NFTs** — Many Elacity NFTs use HIVE storage (`hive://public.ela.city/download_xxx`), not IPFS. The CID extraction regex won't find an IPFS CID in these. The `tokenURI` metadata may contain the original IPFS CID but requires an extra fetch. **Not yet implemented.**

### P1 — Should Fix
3. **IPFS gateway speed** — `ipfs.io` is slow for large NFT images. Better approach: route through the node's own `/ipfs/:cid` gateway for pinned content, falling back to `ipfs.io` only for unpinned content.

4. **Pin button visibility** — The pin button only shows when `isOwned === true` AND a valid CID is extracted. If CID extraction fails (HIVE NFTs), no button appears. Need a graceful "Cannot pin (not on IPFS)" state.

### P2 — Nice to Have
5. **Virtual filesystem integration** — Pinned NFTs should appear in the user's `Pictures/NFTs/` folder. The API creates the directory entries but needs the actual file content served via the IPFS gateway.

6. **CDN participation** — Pinned NFTs announced to DHT but not yet serving as CDN for other nodes requesting the same CID.

---

## 5. Architecture Reference

### App Separation
```
PC2 Node (localhost:4200)
├── Elacity Market  (/installed-apps/elacity-market/)  ← dDRM marketplace, Base chain 8453
├── Elastos NFT     (/installed-apps/elastos-nft/)     ← NFT marketplace, ESC chain 20
├── Glide Finance   (/installed-apps/glide-finance/)   ← DEX, ESC chain 20
└── Creator App     (/installed-apps/elacity-creator/)  ← Content minting, Base chain 8453
```

### NFT Pin Data Flow
```
User clicks "Pin to My Node"
  → Frontend: POST /api/nft/pin { cid, name, collection, contractAddress, tokenId }
    → Auth: puter.auth.token from URL → Authorization: Bearer header
    → Backend: trackNFTPin() in nft_pins table
    → Backend: seedingService.seedContent(cid) or ipfs.pinRemoteCID(cid)
      → Helia fetches CID via Bitswap/DHT/gateway-fallback
      → On success: trackPinnedCID(), updateNFTPinStatus('complete'), announceCID to DHT
      → Creates virtual filesystem entry at /{wallet}/Pictures/NFTs/{collection}/{name}.ext
```

### ESC RPC Chain
```
Browser (Elastos NFT app)
  → POST /api/esc-rpc (PC2 node proxy)
    → POST https://38.242.211.112/rpc/esc (Contabo nginx, self-signed cert)
      → http://127.0.0.1:20636 (ESC archive node, fully synced)
  
Fallback (if Contabo down):
  → https://api.ela.city/esc (public RPC)
```

---

## 6. File Map — What Changed

### Backend (direct edits)
| File | What Changed |
|------|-------------|
| `pc2-node/src/api/storage.ts` | +171 lines: 4 NFT pin CRUD endpoints |
| `pc2-node/src/storage/database.ts` | +70 lines: 5 NFT pin tracking methods |
| `pc2-node/src/storage/schema.sql` | +17 lines: `nft_pins` table + indexes |
| `pc2-node/src/storage/migrations.ts` | +31 lines: Migration 27 |
| `pc2-node/src/api/index.ts` | +33 lines: ESC RPC proxy, storage router dual-mount |
| `pc2-node/src/static.ts` | +22/-15 lines: Refactored asset resolver for `/static/*`, `/fonts/*` |
| `pc2-node/data/test-apps/elastos-nft-src/.env.production` | IPFS gateway → `ipfs.io` |

### Frontend (build-time patches in `scripts/build-elastos-nft.sh`)
| Patch Target | What It Does |
|-------------|-------------|
| `ArtAssetView.tsx` | Pin + Download buttons below NFT image |
| `MyVaultExplorer.tsx` | PinnedCidsContext + green pin badge on Library cards |
| `account.ts` | Fix relative URL recognition for profile thumbnails |
| `rpcs.ts` | Contabo RPC proxy (primary) + public RPC (fallback) |
| `url.sanitize.ts` + all `.ts/.tsx` | Replace dead IPFS gateways with `ipfs.io` |
| Post-build sed on `*.js` | Catch any remaining gateway refs in compiled output |

---

## 7. Build & Test Instructions

### Rebuild Elastos NFT App
```bash
cd /Users/mtk/Documents/Cursor/pc2.net
bash scripts/build-elastos-nft.sh
```
Build takes ~3-4 minutes. Output goes to `pc2-node/data/test-apps/elastos-nft/`.

### Sync to installed-apps & restart node
```bash
rsync -a --delete pc2-node/data/test-apps/elastos-nft/ pc2-node/data/installed-apps/elastos-nft/
cd pc2-node && npx tsx watch src/index.ts
```

### Test NFT Pin API (manual)
```bash
# List pins (needs auth token)
curl -H "Authorization: Bearer <token>" http://localhost:4200/api/nft/pins

# Pin an NFT
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"cid":"QmTest...","name":"My NFT","collection":"Test","contractAddress":"0x...","tokenId":"1"}' \
  http://localhost:4200/api/nft/pin

# Check pin status
curl -H "Authorization: Bearer <token>" http://localhost:4200/api/nft/pin/QmTest...

# Unpin
curl -X DELETE -H "Authorization: Bearer <token>" http://localhost:4200/api/nft/pin/QmTest...
```

### Test in browser
1. Open `http://localhost:4200`
2. Open Elastos NFT app from taskbar
3. Navigate to an NFT you own (e.g., via Library or search)
4. Verify "Pin to My Node" and "Download" buttons appear below the image
5. Click "Pin to My Node" — should show spinner, then green "Pinned to Node"
6. Check Library — pinned NFTs should show small green pin badge

---

## 8. Remaining Tasks

### Immediate (Testing)
- [ ] Manually test pin button on NFT detail page (verify auth, CID extraction, API call)
- [ ] Manually test download button
- [ ] Verify pin indicators on Library page
- [ ] Test unpin flow (if there's a UI for it — currently only via API)
- [ ] Test with different NFT types (IPFS CID, HIVE storage, different collections)

### Short-term
- [ ] HIVE NFT support — Fetch `tokenURI` metadata to extract IPFS CID for HIVE-stored NFTs
- [ ] Local-first IPFS serving — For pinned content, serve from node's `/ipfs/:cid` gateway before falling back to `ipfs.io`
- [ ] Unpin UI — Add unpin button to pinned NFTs (currently only available via API)
- [ ] Error states — Show "Cannot pin (not on IPFS)" for non-IPFS NFTs

### Medium-term
- [ ] CDN participation — Announce pinned content availability, serve to other nodes
- [ ] Virtual filesystem files — Make pinned NFTs browsable in `Pictures/NFTs/` folder with actual content
- [ ] Batch pin — Pin all NFTs in a collection at once
- [ ] Pin progress tracking — Show download progress for large files

---

## 9. Context Files to Read

**For a new agent to get fully up to speed, read these files in order:**

### Understanding the project
1. `.cursor/tasks/MARKET-FEATURES/MARKET-FEATURES.md` — Master task tracker for all market/NFT work (Phases 1-7)
2. `.cursor/tasks/MARKET-FEATURES/MARKET-UI-AUDIT-APRIL-2026.md` — Detailed audit of market app issues
3. `docs/handover/IRZHY_DDRM_HANDOVER.md` — Complete dDRM technical reference (Lit Chipotle, encryption, contracts)
4. `docs/updates/Community_Update_Apr_4_10_2026.md` — Latest community update with full context

### Understanding the code
5. `pc2-node/src/api/storage.ts` (lines 710-886) — NFT pin API endpoints
6. `pc2-node/src/storage/database.ts` (lines 664-735) — NFT pin database methods
7. `pc2-node/src/storage/schema.sql` — Full database schema including `nft_pins`
8. `pc2-node/src/api/index.ts` (lines 991-1025) — ESC RPC proxy
9. `scripts/build-elastos-nft.sh` — Entire build pipeline (1636 lines) — the "NFT IPFS Pin" patches start around line 1080

### Understanding the IPFS infrastructure (already intact, don't modify)
10. `pc2-node/src/storage/ipfs.ts` — Helia IPFS node, pin/unpin, DHT announce, gateway fallback
11. `pc2-node/src/services/seeding/ContentSeedingService.ts` — Content seeding for CDN
12. `pc2-node/src/api/public.ts` — Public IPFS gateway at `/ipfs/:cid`

### Contabo server
- ESC archive node: fully synced, bound to `127.0.0.1:20636`
- Nginx: `/rpc/esc` → proxy_pass to ESC node
- Access: SSH to `38.242.211.112` (credentials shared verbally, not stored in code)

---

## Quick Reference

| What | Where |
|------|-------|
| Elastos NFT source patches | `scripts/build-elastos-nft.sh` |
| NFT pin API | `pc2-node/src/api/storage.ts` (lines 712-886) |
| NFT pin DB | `pc2-node/src/storage/database.ts` (lines 666-735) |
| NFT pin migration | `pc2-node/src/storage/migrations.ts` (migration 27) |
| ESC RPC proxy | `pc2-node/src/api/index.ts` (lines 993-1024) |
| IPFS gateway env | `pc2-node/data/test-apps/elastos-nft-src/.env.production` |
| Built app output | `pc2-node/data/test-apps/elastos-nft/` |
| Installed app | `pc2-node/data/installed-apps/elastos-nft/` |
| Master task doc | `.cursor/tasks/MARKET-FEATURES/MARKET-FEATURES.md` |
| This handover | `docs/handover/NFT_PINNING_SESSION_HANDOVER.md` |
