# Wave 7 — Extension migration plan

**Scope:** move ENM from a separate Docker container (`enm-server`) into a
PC2 backend extension (`extensions/elastos-node-manager/`). Single image,
single update path, ENM behaves like every other PC2 app.

**Why:** the sidecar pattern is the lone snowflake in PC2's app taxonomy.
Other apps (`editor`, `viewer`, `dao-dashboard`, etc.) are pure frontend
bundles or PC2 backend extensions. ENM has 50 backend files in
`enm-server/src/` running in a separate container, requiring its own
image, its own port, its own update cycle, its own
`install-enm.sh`. This plan collapses that into PC2 itself.

**Status:** plan only. v0.5 reset (truth-only UI) shipped first to give
operators a working build immediately; Wave 7 is the deployment fix.

---

## Target structure

```
extensions/elastos-node-manager/
├── package.json              { name, main: 'main.js', type: 'commonjs' }
├── main.js                   entry — registers routes + lifecycle hooks
├── services/                 (was enm-server/src/services/)
│   ├── ChainState.js
│   ├── ChainRegistry.js
│   ├── ElaMainChainAdapter.js
│   ├── EnmBinaryDownloader.js
│   ├── EnmKeystoreService.js
│   ├── EnmBposService.js
│   ├── EnmConfigSchema.js / EnmConfigRedact.js
│   ├── EnmDb.js
│   ├── EnmEncryption.js
│   ├── EnmAuditLog.js / EnmAuditMiddleware.js
│   ├── EnmConstants.js
│   ├── EnmRateLimit.js
│   ├── EnmRpcClient.js
│   ├── EnmSetupHelpers.js
│   ├── EnmFormat.js
│   ├── EnmProposalStore.js
│   ├── ConfigStore.js
│   ├── DataDir.js
│   ├── Diagnostics.js
│   ├── DiskPreflight.js
│   ├── OsPreflight.js
│   ├── ExtIpResolver.js
│   ├── HealthChecker.js / HealthRules.js
│   ├── HostConflictScanner.js
│   ├── LogCompactor.js
│   ├── NativeProcessService.js
│   ├── ProcessLogStreamer.js
│   ├── SelfHealingEngine.js
│   ├── SseHub.js
│   ├── SyncTracker.js
│   ├── ClockSkewChecker.js
│   ├── EnmBinaryLocator.js
│   ├── ChainAdapter.js
│   ├── processUtils.js
│   └── withChainLock.js
└── routes/                   (was enm-server/src/routes/)
    ├── audit.js
    ├── chains.js
    ├── config.js
    ├── events.js
    ├── evm.js
    ├── healing.js
    ├── logs.js
    ├── setup.js
    └── system.js
```

`enm-server/scripts/install-enm.sh` and `enm-server/Dockerfile` are
deleted at end of migration.

---

## main.js skeleton

```javascript
'use strict';

// Module state — initialized at the 'init' lifecycle hook.
let chainRegistry = null;
let healthChecker = null;
let conflictScanner = null;
let logCompactor = null;
let auditLog = null;

extension.on('init', async () => {
    // 1. Resolve PC2's session DB path. The old sidecar bind-mounted
    //    /data/pc2-node read-only; here we just point at PC2's config.
    const sessionService = extension.import('service:session');

    // 2. Initialize ENM's own data dir + DB.
    const { enmDataDir } = require('./services/DataDir');
    process.env.ENM_DATA_DIR = process.env.ENM_DATA_DIR || '/data/enm';

    // 3. Boot ENM services in order (matches enm-server/src/server.js).
    const ChainRegistry = require('./services/ChainRegistry');
    const HealthChecker = require('./services/HealthChecker');
    const HostConflictScanner = require('./services/HostConflictScanner');
    const LogCompactor = require('./services/LogCompactor');
    const EnmAuditLog = require('./services/EnmAuditLog');

    auditLog = new EnmAuditLog({ logger: console });
    await auditLog.init();

    chainRegistry = ChainRegistry;
    await chainRegistry.init({
        log: console,
        auditLog,
    });

    healthChecker = new HealthChecker({ log: console, auditLog });
    healthChecker.start();

    conflictScanner = new HostConflictScanner({ log: console });
    conflictScanner.start();

    logCompactor = LogCompactor;
    logCompactor.startCron({ log: console });

    // 4. Process-level safety net: ENM bugs MUST NOT crash PC2.
    process.on('uncaughtException', (err) => {
        console.error('[ENM] uncaughtException — swallowing to protect PC2:', err);
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[ENM] unhandledRejection — swallowing:', reason);
    });
});

// 5. Route registration. Each existing route file from
//    enm-server/src/routes/ ends with `module.exports = function build(extensionHandle) { ... }`
//    that returns an Express Router. We adapt by passing `extension` as
//    the shim and letting the route file call `extension.get/post`
//    directly. Concretely: the route files become small wrappers that
//    register their handlers via the extension API.
require('./routes/health')(extension);
require('./routes/setup')(extension);
require('./routes/chains')(extension);
require('./routes/healing')(extension);
require('./routes/audit')(extension);
require('./routes/config')(extension);
require('./routes/logs')(extension);
require('./routes/system')(extension);
require('./routes/evm')(extension);
require('./routes/events')(extension);  // SSE
```

---

## Per-file migration map

### Services (low touch — mostly copy as-is)

These are pure logic and don't depend on Express/Router/middleware.
Migration = `cp` to the new directory. No code changes.

- `ChainState.js`, `ChainRegistry.js`, `ElaMainChainAdapter.js`,
  `EnmBinaryDownloader.js`, `EnmKeystoreService.js`,
  `EnmBposService.js`, `EnmConfigSchema.js`, `EnmConfigRedact.js`,
  `EnmDb.js`, `EnmEncryption.js`, `EnmAuditLog.js`, `EnmConstants.js`,
  `EnmRateLimit.js`, `EnmRpcClient.js`, `EnmSetupHelpers.js`,
  `EnmFormat.js`, `EnmProposalStore.js`, `ConfigStore.js`, `DataDir.js`,
  `Diagnostics.js`, `DiskPreflight.js`, `OsPreflight.js`,
  `ExtIpResolver.js`, `HealthChecker.js`, `HealthRules.js`,
  `HostConflictScanner.js`, `LogCompactor.js`, `NativeProcessService.js`,
  `ProcessLogStreamer.js`, `SelfHealingEngine.js`, `SseHub.js`,
  `SyncTracker.js`, `ClockSkewChecker.js`, `EnmBinaryLocator.js`,
  `ChainAdapter.js`, `processUtils.js`, `withChainLock.js`

### Auth — replaced

`enm-server/src/auth/OwnerCheckMiddleware.js`:
- Uses Bearer token from `Authorization: Bearer <token>` header
- Looks up the token in pc2-node's session DB
- Sets `req.actorWallet`

In Wave 7, **delete this file**. Use PC2's existing auth:
- `req.user` (deprecated but populated) — IUser instance
- `req.actor` — Actor instance
- Wallet address: `req.user.wallet_address`
- Owner check: compare against the operator wallet stored in PC2's
  config (or implement a small `extension.import('service:user')`
  wrapper that resolves "is this actor the PC2 owner?").

Routes that use `requireOwner` middleware become:
```javascript
extension.post('/chains/:chainId/start', { subdomain: 'api' },
    async (req, res) => {
        if (!isOperator(req.actor)) {
            return res.status(403).json({ error: 'owner_only' });
        }
        // ...handler...
    }
);
```

### Routes (medium touch — Express → extension API)

Each route file currently does:
```javascript
function build(extensionHandle) {
    const router = express.Router();
    router.get('/...', limit('read'), async (req, res) => { ... });
    return router;
}
```

After migration:
```javascript
module.exports = function (extension) {
    extension.get('/api/enm/...', { subdomain: 'api' }, async (req, res) => { ... });
    extension.post('/api/enm/...', { subdomain: 'api', mw: [rateLimitMw('read')] }, async (req, res) => { ... });
};
```

Three substantive changes per route file:
1. Replace `router.get/post(...)` with `extension.get/post('/api/enm/...', ...)`
2. Replace `requireOwner` with an inline operator check
3. Replace `extensionHandle.log` with `console` (or
   `extension.import('core').util.helpers.logger` — TBD which is preferred)

### server.js — DELETED

`enm-server/src/server.js`:
- Express app instantiation → not needed (PC2 owns the Express app)
- Middleware mounting → routes register their own per-route mw
- `app.listen(PORT)` → not needed (extension shares PC2's port)
- DB schema init → moves into the `init` lifecycle hook
- Cron start → moves into the `init` lifecycle hook

### SSE — needs adaptation

`SseHub.js` uses Express's `res` object directly to write SSE frames.
This continues to work inside the extension since the route handlers
still receive Express `req`/`res`. The frontend's `EventSource` URL
changes from `:4180/api/enm/events/...` to `/api/enm/events/...`.

Verify SSE plays nicely with PC2's reverse proxy / response timeout
configuration. May need to set `res.setHeader('X-Accel-Buffering', 'no')`
explicitly.

---

## Frontend changes

`src/backend/apps/elastos-node-manager/js/services/api.js`:

```javascript
// Today:
this.base = root.ENM_API_BASE
    || (root.location.protocol + '//' + root.location.hostname + ':4180/api/enm');

// After:
this.base = '/api/enm';   // same origin as PC2; iframe relative
```

`src/backend/apps/elastos-node-manager/js/services/wallet.js`:
- Drop the `:4180/api/enm/whoami` fallback URL — use `/api/whoami`
  (PC2's existing endpoint that the `whoami` extension already serves).

`src/backend/apps/elastos-node-manager/js/services/sse.js`:
- Same pattern: change EventSource URL from absolute `:4180/api/enm/events`
  to relative `/api/enm/events`.

---

## Migration script for existing operators

For operators who already have `~/pc2/enm-data/` from the sidecar era:

```bash
# Run-once migration. Detects old enm-data location, moves into the new
# spot under PC2's data volume (so it lives inside ./data/enm now).
extensions/elastos-node-manager/scripts/migrate-from-sidecar.sh
```

The script:
1. Stops the `enm-server` container if it's running.
2. Moves `~/pc2/enm-data/` → `~/pc2/data/enm/`.
3. Strips the `enm-server:` block from `~/pc2/docker-compose.yml`.
4. Removes the bind-mount lines added by the v0.4-vintage workaround
   (the `:/app/src/backend/apps/elastos-node-manager` entry).
5. Removes `/root/pc2-testing` if it was only used for the manual build.
6. Pulls a fresh PC2 image.
7. Restarts PC2.

---

## Rollout

1. **Build the extension** in `extensions/elastos-node-manager/`,
   leaving `enm-server/` in place. Both will exist in the repo for the
   migration period.
2. **Test side by side** on a dev box: PC2 with the extension running
   on port 4100, enm-server still running on 4180. Hit each endpoint
   manually + via the frontend. Confirm parity.
3. **Cut over** by:
   - Frontend pointing at `/api/enm` (relative) instead of `:4180`
   - Migration script for operators
   - Delete `enm-server/`
   - Update `install-enm.sh` to a no-op or just delete it
4. **Documentation**: update `architecture.md`, `operator-runbook.md`,
   `v0.4-upgrade-guide.md` to drop sidecar references; add
   `v0.5-extension-migration.md` walkthrough.

---

## Risk register

| Risk | Mitigation |
|---|---|
| `ela` child process crash takes down PC2 | The child process model is the same either way (Node's `child_process` doesn't bubble crashes). Plus `uncaughtException` + `unhandledRejection` handlers in main.js. |
| Memory leak in ENM logic accumulates inside PC2's heap | Same hygiene as any backend service: clean up listeners on `extension.on('shutdown', ...)`. Set NODE_OPTIONS=--max-old-space-size if needed. |
| Permission diff: PC2 runs as different uid than enm-server did | Migration script does `chown -R` on the moved data dir. |
| SSE blocked by PC2's reverse proxy buffering | Set `X-Accel-Buffering: no` header on SSE responses. |
| Auth model mismatch: ENM's session-DB path vs PC2's actor model | Replace `OwnerCheckMiddleware` with a thin wrapper that reads `req.actor` and checks against the configured operator wallet. |
| `better-sqlite3` native build inside PC2 image | Already a dep of multiple PC2 services; should already be in the image. Verify `node_modules` includes it. |
| Healing engine starts firing F1 spuriously during migration | Stop the old enm-server before starting the new extension. F1 default-on; F2-F19 default-off (Wave 1 invariant) preserved. |

---

## Estimated scope

- **Setup + skeleton**: 30 min
- **Service migration** (mostly cp): 1h
- **Route migration** (30 endpoints): 2-3h
- **Auth replacement**: 1h
- **Frontend URL flip + smoke test**: 1h
- **Migration script**: 1h
- **Doc updates**: 1h

**Total: ~7-8h focused work.** Best done in a fresh session so the
mechanical edits don't accumulate copy-paste rot in a tired context.

---

## What stays out of scope

- **node.sh BPoS commands beyond activate/update/compress** —
  vote/stake/unstake/claim need user-supplied tx amounts; deferred to
  v0.6 when the wallet-aware UI ships
- **CR member registration / activation** — same shape as BPoS
  activate but distinct lifecycle; v0.6
- **Sidechain support** (esc/eid/eco/pgp/pg/arbiter) — adapter classes
  are missing; v0.7
- **Returning the friendly home view** — not until we have a backend
  that exposes every field the friendly view needs (real earned-ELA
  feed, etc.). v0.8 at earliest.
