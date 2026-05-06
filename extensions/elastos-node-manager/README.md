# Elastos Node Manager — capsule source (Wave 7 / M8)

This directory is the **source layout** for the ENM hybrid capsule —
what gets bundled into a signed `.tar.gz` by the dev signing utility
(`pc2-node/scripts/make-test-capsule.mjs`) and installed via the M1–M7
pipeline.

## Layout

```
extensions/elastos-node-manager/
├── app.json           ← capsule manifest (signed at build time)
├── app/
│   └── index.html     ← frontend entry (placeholder; see "Deferred" below)
└── backend/
    ├── package.json
    └── main.js        ← extension entry point (lifecycle + routes)
```

## Status: M8 scaffolding (Wave 7 milestone 8 of 9)

What this scaffolding **does** today:

- ✅ `app.json` is a real ENM-shaped manifest declaring real capabilities
  (spawn `ela`/`ela-cli`, write to per-capsule dataDir, listen on TCP
  20336/20338, import PC2's database + audit services).
- ✅ `backend/main.js` registers `/api/enm/health`, `/api/enm/version`,
  and `/api/enm/chains/:chainId` routes.
- ✅ Lifecycle hooks (`init`, `shutdown`) wired so the loader can
  bring the backend up and down cleanly.
- ✅ Inline `isOperator()` auth helper replaces the deleted
  `enm-server/src/auth/OwnerCheckMiddleware.js`.
- ✅ Full pipeline coverage in
  [`pc2-node/tests/security/enm-capsule-e2e.test.js`](../../pc2-node/tests/security/enm-capsule-e2e.test.js):
  bundles the on-disk source, signs with a fresh test publisher key,
  installs through `CapsuleInstaller`, registers + lazy-loads through
  `LazyExtensionLoader`, exercises every route. 6 tests, all passing
  inside the cumulative 231-test suite.

## Deferred to M8 sub-phases

These are mechanical work blocked on either operator decisions or
platform-team bandwidth. None of them is an architectural unknown —
the scaffolding above proves the integration shape works.

### Sub-phase 2 — port the 37 services

`enm-server/src/services/*.js` → `extensions/elastos-node-manager/services/`.
Per A18: `cp`-only for most files (pure logic, no Express dependency).
Affected files:

```
ChainAdapter.js, ChainRegistry.js, ChainState.js,
ClockSkewChecker.js, ConfigStore.js, DataDir.js,
Diagnostics.js, DiskPreflight.js, ElaMainChainAdapter.js,
EnmAuditLog.js, EnmAuditMiddleware.js, EnmBinaryDownloader.js,
EnmBinaryLocator.js, EnmBposService.js, EnmConfigRedact.js,
EnmConfigSchema.js, EnmConstants.js, EnmDb.js, EnmEncryption.js,
EnmFormat.js, EnmKeystoreService.js, EnmProposalStore.js,
EnmRateLimit.js, EnmRpcClient.js, EnmSetupHelpers.js,
ExtIpResolver.js, HealthChecker.js, HealthRules.js,
HostConflictScanner.js, LogCompactor.js, NativeProcessService.js,
ProcessLogStreamer.js, SelfHealingEngine.js, SseHub.js,
SyncTracker.js, processUtils.js, withChainLock.js
```

The `serviceStubs` in `backend/main.js` should be replaced by real
`require('./services/...')` once those land.

### Sub-phase 3 — port the 10 routes

`enm-server/src/routes/*.js` → register via `extension.get/post()`
inside `backend/main.js` (or split into `backend/routes/` for parity
with the source). Three substantive changes per file:

1. `router.get/post(...)` → `extension.get/post('/api/enm/...', ...)`
2. `requireOwner` middleware → inline `isOperator(req)` check
3. `extensionHandle.log` → `console` (or `extension.log`)

Files:
```
audit.js, chains.js, config.js, events.js (SSE),
evm.js, healing.js, logs.js, setup.js, system.js
```
(plus a `health.js` already collapsed into main.js for scaffolding)

### Sub-phase 4 — `better-sqlite3` decision

`EnmDb.js` uses `better-sqlite3`, a native `.node` module. The v0.3
hard rule forbids native modules from hybrid capsules (ABI fragility
across Node versions). Two paths:

- **Switch to pure-JS SQLite** (e.g. `sql.js`). Performance hit
  (~5× slower for ENM's audit-log writes per Rev 7 measurements)
  but no allow-list exception needed.
- **Carve a narrow allow-list exception** for widely-audited
  native modules like `better-sqlite3`. Adds platform-team work
  (vetting list, ABI-compat publish process). Avoids the perf hit.

Operator decision pending. Not a blocker on the scaffolding above —
becomes a blocker when sub-phase 2 ports `EnmDb.js`.

### Sub-phase 5 — full frontend bundle

The current `app/index.html` is a 50-line placeholder. The real ENM
v0.5 frontend (~30 KB across `js/`, `css/`, `js/components/`,
`js/services/`) lives at `src/backend/apps/elastos-node-manager/`
and gets copied into `app/` when this sub-phase lands. The API base
URL flips from `:4180/api/enm` (sidecar) to `/api/enm` (relative —
same-origin under the capsule install path).

## How to build the capsule (dev)

From the repo root:

```bash
node pc2-node/scripts/make-test-capsule.mjs \
    extensions/elastos-node-manager \
    /tmp/enm-capsule-out
```

Outputs:
- `elastos-node-manager-0.5.0.tar.gz` — ready to install
- `elastos-node-manager-0.5.0.json` — signed manifest
- `publisher-pubkey.hex` — the dev publisher key (add to PC2's
  trusted-publisher set to allow install)

Set `PC2_DEV_KEY_PATH=~/.pc2/enm-dev-key.json` to reuse the same
dev key across builds — useful when the trusted-publisher set is
configured once at boot.

Production CI/release infrastructure (HSM key storage, GitHub
Actions workflow, multi-sig revocation root) is **deferred until
the platform itself is proven prod-ready** per the v0.3 plan.

## Why the sidecar is going away

ENM today runs as a separate Docker container (`enm-server`) that
PC2 talks to over `:4180`. Wave 7's hybrid-capsule format collapses
the sidecar into a PC2-loaded extension, opt-in installable via
dApp Centre. This means:

- No second container for operators to manage
- No separate update cycle
- No `install-enm.sh` script
- ENM only ships to operators who chose to install it (not bundled
  into PC2's image)

The trade-off: ENM runs as trusted code in PC2's main process,
secured by the publisher signature (ElacityLabs key) + revocation
infrastructure (M7) instead of process isolation. See
`enm-server/docs/wave7-extension-migration.md` for the full plan.
