# Task: Elacity dDRM & dApp Store — Phase 1 Prerequisites

**Task ID**: ddrm-prerequisites
**Created**: 2026-03-03
**Status**: Review
**Priority**: High

## Description

Implement the three prerequisites identified in the dDRM/dApp Store plan before Phase 1 foundation work can begin.

## Background

The Elacity dDRM & dApp Store plan (`.cursor/plans/app_store_and_media_market_2489ec7b.plan.md`) identifies three prerequisites that must be completed before the Phase 1 foundation (SQLite schema, AppInstallService, APIs):

1. **postMessage wallet bridge** — iframe apps cannot access `window.ethereum` directly due to sandbox restrictions. A bridge is needed.
2. **COOP/COEP header testing** — The media player needs `SharedArrayBuffer` for DRM, which requires cross-origin isolation headers, but these break other apps if applied globally.
3. **SDK access confirmation** — Need npm access to `@elacity-js/media-player` and test CIDs from CTO (human task).

## Requirements

### Prerequisite 1: postMessage Wallet Bridge
- [x] Client-side shim (`pc2-wallet-provider.js`) — EIP-1193 compatible provider that forwards RPC calls via `postMessage` to parent window
- [x] Parent-side handler (in `IPC.js`) — receives wallet RPC requests from iframes, forwards to Particle Auth's `window.ethereum`, returns results
- [x] Auto-initialization — when iframe loads shim, it sends `pc2-wallet-ready`; parent responds with current accounts and chainId
- [x] Inject shim into app HTML via `static.ts`

### Prerequisite 2: Per-App COOP/COEP Headers
- [x] Modified `appsRouteHandler` in `static.ts` to conditionally set `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin`
- [x] Header decision based on app manifest `requirements.headers` field (read from `req.app.locals.installedAppManifests`)
- [ ] End-to-end test with media player app (pending app install system + `@elacity-js/media-player` npm access)

### Prerequisite 3: SDK Access Confirmation
- [ ] Confirm npm registry access for all `@elacity-js/*` packages (especially `@elacity-js/media-player` ^0.9.0)
- [ ] Obtain test content CIDs for integration testing
- [ ] Confirm API endpoints (prod vs staging) and Base chain deployment status
- **Owner**: Human (CTO/Irzhy)

## Implementation Plan

- [x] Create `pc2-node/frontend/pc2-wallet-provider.js`
- [x] Add wallet bridge handler to `src/gui/src/IPC.js` (before msg/appInstanceID validation)
- [x] Inject wallet shim into app HTML in `pc2-node/src/static.ts`
- [x] Add per-app COOP/COEP header logic in `appsRouteHandler`
- [ ] SDK access — blocked on human action

## Acceptance Criteria

- [x] An iframe app can call `window.ethereum.request({ method: 'eth_requestAccounts' })` and receive the parent wallet's accounts
- [x] An iframe app can call `window.ethereum.request({ method: 'personal_sign', params: [...] })` and the parent wallet signs
- [x] COOP/COEP headers are set only for apps with `requirements.headers: ['cross-origin-isolation']` in their manifest
- [x] TypeScript compiles clean (`npx tsc --noEmit` passes)
- [ ] End-to-end tested with Elacity Market and Player apps (blocked on Phase 2)

## Files Modified

| File | Change |
|------|--------|
| `pc2-node/frontend/pc2-wallet-provider.js` | **NEW** — Client-side EIP-1193 postMessage bridge shim |
| `src/gui/src/IPC.js` | Added `pc2-wallet-rpc` and `pc2-wallet-ready` handlers before msg/appInstanceID validation |
| `pc2-node/src/static.ts` | Inject wallet shim `<script>` tag + per-app COOP/COEP header logic in `appsRouteHandler` |

## Notes

- The wallet bridge handler is placed before the `msg`/`appInstanceID` validation in IPC.js because wallet bridge messages use `{ type }` instead of `{ msg }`, and don't have a puter `appInstanceID`.
- The `isPC2WalletBridge` flag on the provider prevents infinite loops — the parent-side handler checks this to avoid forwarding to itself.
- Iframe sandbox attributes for installed apps will be more restrictive than built-in apps. This will be implemented when `AppInstallService` is built (Phase 1 foundation).
- The `event.origin === 'null'` check handles sandboxed iframes where origin is literally the string `'null'`.
