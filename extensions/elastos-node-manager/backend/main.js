/*
 * ENM backend — hybrid capsule entry point (Wave 7 / M8 scaffolding).
 *
 * What's HERE in this milestone:
 *   - The lifecycle skeleton (init + shutdown hooks)
 *   - The /api/enm/health route (proves the capsule's routes are
 *     reachable through the lazy loader)
 *   - The /api/enm/version route (returns the capsule's version
 *     so the frontend can show "ENM v0.5 — running")
 *   - The exports surface that LazyExtensionLoader hands back to
 *     callers (greeting, version, isReady, recordRequest)
 *
 * What's DEFERRED to subsequent M8 sub-phases (per the v0.3 doc's
 * "manifest paths are scaffolding, real ports follow" pattern):
 *
 *   1. Port 37 service files from `enm-server/src/services/` to
 *      `extensions/elastos-node-manager/services/` (cp-only per A18,
 *      no logic changes). Currently stubbed via `serviceStubs` so
 *      the routes that depend on them have something to call.
 *   2. Port 10 route files from `enm-server/src/routes/`. Each one
 *      converts `function build(extensionHandle) { return router; }`
 *      → `module.exports = function (extension) { extension.get(...) }`.
 *      Three substantive changes per file: router→extension, requireOwner
 *      → inline check, extensionHandle.log → console.
 *   3. Resolve the `better-sqlite3` native-module decision. The v0.3
 *      hard rule forbids native .node modules; ENM today uses
 *      better-sqlite3 in `enm-server/src/services/EnmDb.js`. Two
 *      paths: switch to pure-JS SQLite (sql.js, accept perf hit)
 *      or carve a narrow allow-list exception. Operator decision
 *      pending — not blocking M8 scaffolding.
 *   4. Frontend bundle migration. The v0.5 ENM frontend at
 *      `src/backend/apps/elastos-node-manager/` (~30 KB across
 *      js/css/components) gets copied into `app/` with the API
 *      base flipped from `:4180/api/enm` to relative `/api/enm`.
 *
 * Trust note: this code runs as TRUSTED CODE in PC2's main process
 * once installed. Per the v0.3 trust model, the capsule's signed
 * manifest is the security boundary, not in-process capability
 * enforcement. The capabilities block in app.json is operator
 * disclosure, not a runtime guard.
 */

'use strict';

let initialised = false;
let shutdownReason = null;
let requestCount = 0;
const startedAt = Date.now();

// Service stubs — these will be replaced by real ports of the
// enm-server services in a subsequent M8 sub-phase. Keeping the
// shape so the routes that depend on them already work; just
// nothing meaningful happens yet.
const serviceStubs = {
    chainRegistry: {
        getChainState() {
            return {
                chainId: 'mainchain',
                state: 'unconfigured',
                pid: null,
                attached: false,
                note: 'service stub — real ChainRegistry port deferred to M8 sub-phase 2',
            };
        },
    },
    healthChecker: {
        getLastCheck() {
            return { ok: true, ts: Date.now(), note: 'service stub' };
        },
    },
};

// ---- Lifecycle ------------------------------------------------------------

extension.on('init', async () => {
    extension.exports.greeting = 'Elastos Node Manager';
    extension.exports.version = '0.5.0';
    extension.exports.startedAt = startedAt;
    extension.exports.isReady = () => initialised;
    extension.exports.recordRequest = () => { requestCount++; };
    extension.exports.getStats = () => ({
        requestCount,
        uptimeMs: Date.now() - startedAt,
        services: Object.keys(serviceStubs),
    });

    // In the full port: load DataDir, ConfigStore, ChainRegistry,
    // HealthChecker, HostConflictScanner, LogCompactor, EnmAuditLog
    // — same boot order as `enm-server/src/server.js:55-180`.
    // For now: just mark ready.
    initialised = true;
    extension.log.info('[enm] backend initialised (M8 scaffolding mode)');
});

extension.on('shutdown', async () => {
    shutdownReason = 'graceful';
    initialised = false;
    extension.exports.isReady = () => false;

    // In the full port: stop HealthChecker cron, close EnmAuditLog DB,
    // shut down chain processes if alive (NativeProcessService.stopAll),
    // stop SseHub broadcasts. For scaffolding, these are no-ops.
    extension.log.info(`[enm] backend shutdown (${shutdownReason})`);
});

// ---- Routes ---------------------------------------------------------------

// /api/enm/health — operator + dApp Centre + uptime monitor probe.
// Always returns 200 with the JSON below; doesn't touch any service.
extension.get('/api/enm/health', { subdomain: 'api' }, (req, res) => {
    requestCount++;
    res.json({
        ok: initialised,
        version: '0.5.0',
        uptimeMs: Date.now() - startedAt,
        scaffolding: true,
        note: 'M8 scaffolding — routes/services port to follow',
    });
});

// /api/enm/version — minimal endpoint the frontend hits to confirm
// the capsule's backend is loaded + responsive.
extension.get('/api/enm/version', { subdomain: 'api' }, (req, res) => {
    requestCount++;
    res.json({ name: 'elastos-node-manager', version: '0.5.0' });
});

// /api/enm/chains/:id — early stub. Returns the ChainRegistry
// stub's state so a frontend integration test can hit something
// real-shaped without the full chain machinery wired.
extension.get('/api/enm/chains/:chainId', { subdomain: 'api' }, (req, res) => {
    requestCount++;
    if (!isOperator(req)) {
        res.status(403).json({ error: 'owner_only' });
        return;
    }
    const state = serviceStubs.chainRegistry.getChainState();
    if (req.params.chainId !== state.chainId) {
        res.status(404).json({ error: 'unknown_chain', chainId: req.params.chainId });
        return;
    }
    res.json(state);
});

// ---- Auth helper ---------------------------------------------------------

// Replaces enm-server/src/auth/OwnerCheckMiddleware.js. PC2 already
// populates req.actor / req.user.wallet_address; we just compare
// against the operator wallet stored in PC2's config. The full port
// reads PC2's owner record via extension.import('service:user') or
// equivalent. For scaffolding: assume any authenticated request is
// the operator (the test harness sets this).
function isOperator(req) {
    // M8 scaffolding: stubbed permissive. Full port reads PC2's
    // operator wallet from the trusted-publisher / owner registry
    // and compares against req.user.wallet_address.
    return Boolean(req.user || req.actor);
}
