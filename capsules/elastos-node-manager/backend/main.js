/*
 * ENM backend — hybrid capsule entry point (Wave 7 / M8 sub-phases 2+3).
 *
 * What this milestone delivers:
 *   - 38 services from `enm-server/src/services/` ported to
 *     `services/` (pure cp + auth-import-shim per A18)
 *   - 10 route files from `enm-server/src/routes/` ported to
 *     `routes/` and registered via the router-adapter (which
 *     bridges Express Router → extension.get/post)
 *   - `auth.js` shim replaces the deleted OwnerCheckMiddleware
 *     using PC2's req.actor / req.user.wallet_address
 *
 * Boot order (matches enm-server/src/server.js:55-180):
 *   1. extension.import('data') for the db handle
 *   2. EnmDb.initSchema(db) — idempotent CREATE TABLE IF NOT EXISTS
 *   3. EnmAuditLog.init() — opens audit-log writer
 *   4. ChainRegistry.init({ log, auditLog, ... }) — boots managed chains
 *   5. HealthChecker.start() — F1-F19 healing rule polling
 *   6. HostConflictScanner.start() — port + binary collision watch
 *   7. LogCompactor.startCron() — daily ela.log gzip + purge
 *   8. Mount 9 routes via router-adapter
 *   9. Process-level uncaughtException + unhandledRejection
 *      handlers so ENM bugs CAN'T crash PC2 (the v1 publisher-trust
 *      model relies on this — extension code runs in PC2's main
 *      process, so we hold the door open).
 *
 * Out of scope still (M8 sub-phase 5):
 *   - Real frontend bundle copy. The placeholder app/index.html
 *     stays until the v0.5 frontend gets relocated + URL-flipped.
 *
 * Trust note: per the v0.3 publisher-trust model, this code runs
 * as TRUSTED CODE in PC2's main process. The publisher's signed
 * manifest is the security boundary; capabilities in app.json are
 * operator disclosure, not a runtime guard.
 */

'use strict';

const path = require('path');

// ---- Module state — captured at init time -------------------------------

let initialised = false;
const startedAt = Date.now();
const services = {};   // populated in init: chainRegistry, healthChecker, etc.

// ---- extensionHandle shim -----------------------------------------------
//
// The ported services were written to receive an `extensionHandle`
// object exposing .log, .import(), etc. PC2's extension global has
// the same shape but call sites use it directly. We build a small
// adapter so the unchanged services can keep using the handle they
// expect.

function buildExtensionHandle() {
    return {
        log: extension.log,
        LOG: extension.LOG,
        import: extension.import.bind(extension),
        // Process-isolated audit middleware needs access to the
        // extension-level `db` for proposal store; simplest: expose
        // imports here so EnmAuditMiddleware etc. can pull what they
        // need at use-time.
    };
}

// ---- Lifecycle ----------------------------------------------------------

extension.on('init', async () => {
    extension.log.info('[enm] booting backend…');
    const extensionHandle = buildExtensionHandle();

    try {
        const { db, kv } = extension.import('data');
        services.db = db;
        services.kv = kv;
    } catch (err) {
        extension.log.warn(
            `[enm] extension.import('data') failed (${err.message}); ` +
            `degrading to no-db mode — audit log + proposal store disabled`);
    }

    // 1. Schema init (idempotent CREATE TABLE IF NOT EXISTS).
    if (services.db) {
        try {
            const EnmDb = require('./services/EnmDb');
            await EnmDb.initSchema(services.db);
        } catch (err) {
            extension.log.error(`[enm] EnmDb.initSchema failed: ${err.message}`);
        }
    }

    // 2. Audit log writer.
    try {
        const EnmAuditLog = require('./services/EnmAuditLog');
        if (typeof EnmAuditLog.init === 'function') {
            await EnmAuditLog.init({ db: services.db, log: extension.log });
        }
        services.auditLog = EnmAuditLog;
    } catch (err) {
        extension.log.warn(`[enm] EnmAuditLog.init skipped: ${err.message}`);
    }

    // 3. ChainRegistry — manages the lifecycle of managed chains.
    try {
        services.chainRegistry = require('./services/ChainRegistry');
        if (typeof services.chainRegistry.init === 'function') {
            await services.chainRegistry.init({
                extensionHandle,
                log: extension.log,
                auditLog: services.auditLog,
            });
        }
    } catch (err) {
        extension.log.warn(`[enm] ChainRegistry.init skipped: ${err.message}`);
    }

    // 4. Health checker (F1-F19 rule polling).
    try {
        const { HealthChecker } = require('./services/HealthChecker');
        if (HealthChecker && typeof HealthChecker === 'function') {
            services.healthChecker = new HealthChecker({
                log: extension.log,
                auditLog: services.auditLog,
            });
            if (typeof services.healthChecker.start === 'function') {
                services.healthChecker.start();
            }
        }
    } catch (err) {
        extension.log.warn(`[enm] HealthChecker.start skipped: ${err.message}`);
    }

    // 5. Host conflict scanner (port + binary watch).
    try {
        const HostConflictScanner = require('./services/HostConflictScanner');
        services.hostConflictScanner = HostConflictScanner;
        if (typeof HostConflictScanner.start === 'function') {
            HostConflictScanner.start({ log: extension.log });
        }
    } catch (err) {
        extension.log.warn(`[enm] HostConflictScanner.start skipped: ${err.message}`);
    }

    // 6. Log compactor cron (daily ela.log rotation).
    try {
        const LogCompactor = require('./services/LogCompactor');
        services.logCompactor = LogCompactor;
        if (typeof LogCompactor.startCron === 'function') {
            LogCompactor.startCron({ log: extension.log });
        }
    } catch (err) {
        extension.log.warn(`[enm] LogCompactor.startCron skipped: ${err.message}`);
    }

    // 7. Process-level safety net. ENM bugs MUST NOT crash PC2.
    process.on('uncaughtException', (err) => {
        extension.log.error(`[enm] uncaughtException — swallowing: ${err.message}`);
        if (err.stack) extension.log.error(err.stack);
    });
    process.on('unhandledRejection', (reason) => {
        extension.log.error(`[enm] unhandledRejection — swallowing: ${String(reason)}`);
    });

    // 8. Public exports the loader hands back to callers.
    extension.exports.greeting = 'Elastos Node Manager';
    extension.exports.version = '0.5.0';
    extension.exports.startedAt = startedAt;
    extension.exports.isReady = () => initialised;
    extension.exports.services = services;

    initialised = true;
    extension.log.info('[enm] backend init complete');
});

// Fires from LazyExtensionLoader when the capsule is being unloaded
// (e.g. user-initiated uninstall). Puter's top-level extension framework
// does NOT emit 'shutdown'; the loader does, on our terms.
extension.on('shutdown', async () => {
    initialised = false;
    extension.exports.isReady = () => false;

    const safeStop = async (label, fn) => {
        try { await fn(); }
        catch (err) { extension.log.warn(`[enm] shutdown ${label}: ${err.message}`); }
    };

    if (services.logCompactor && typeof services.logCompactor.stopCron === 'function') {
        await safeStop('LogCompactor', () => services.logCompactor.stopCron());
    }
    if (services.hostConflictScanner
        && typeof services.hostConflictScanner.stop === 'function') {
        await safeStop('HostConflictScanner', () => services.hostConflictScanner.stop());
    }
    if (services.healthChecker && typeof services.healthChecker.stop === 'function') {
        await safeStop('HealthChecker', () => services.healthChecker.stop());
    }
    if (services.chainRegistry && typeof services.chainRegistry.shutdown === 'function') {
        await safeStop('ChainRegistry', () => services.chainRegistry.shutdown());
    }
    if (services.auditLog && typeof services.auditLog.close === 'function') {
        await safeStop('EnmAuditLog', () => services.auditLog.close());
    }

    extension.log.info('[enm] backend shutdown complete');
});

// ---- Route registration via the adapter ---------------------------------
//
// Loaded synchronously at module require time so they're all
// registered before the first request arrives. The adapter handles
// the express.Router → extension.get/post bridging.

const { adaptRoute } = require('./router-adapter');

// Some route files need extra service deps in build(). Build a
// shared "extensionHandle++" object that includes everything any
// route file might pull. Routes that don't need the extras simply
// ignore them.
const extensionHandleForRoutes = {
    log: typeof extension !== 'undefined' ? extension.log : console,
    LOG: typeof extension !== 'undefined' ? extension.LOG : console.log,
    import: typeof extension !== 'undefined' ? extension.import.bind(extension) : () => null,
    extensionHandle: undefined,   // self-ref filled below for routes that
                                  // destructure { extensionHandle, ... }
    // audit.js needs getDb (returns the db handle from extension.import('data'))
    getDb: () => services.db ?? null,
    // events.js needs the sseHub instance — late-bound to whatever
    // ChainRegistry attached at init time, or a no-op fallback
    sseHub: undefined,
    // healing.js needs the SelfHealingEngine instance
    engine: undefined,
};
// Self-ref so routes that destructure `{ extensionHandle, ... }` get
// the same object back.
extensionHandleForRoutes.extensionHandle = extensionHandleForRoutes;

function mountRoute(prefix, file) {
    try {
        adaptRoute(
            extension, prefix,
            path.resolve(__dirname, 'routes', file),
            extensionHandleForRoutes,
        );
    } catch (err) {
        extension.log.warn(`[enm] route ${file} mount skipped: ${err.message}`);
    }
}

// Lazy-construct the deps the dep-heavy routes need. In production
// these come from the init flow; for the route-registration step
// we supply the same instances post-init via late binding (the
// route file captures the references closure-style; init populates
// them before any request arrives).
try {
    const { SseHub } = require('./services/SseHub');
    extensionHandleForRoutes.sseHub = new SseHub({ log: extension.log });
} catch (err) {
    extension.log.warn(`[enm] SseHub construction failed: ${err.message}`);
    extensionHandleForRoutes.sseHub = {
        broadcast: () => {}, register: () => () => {}, close: () => {},
    };
}
try {
    const { SelfHealingEngine } = require('./services/SelfHealingEngine');
    extensionHandleForRoutes.engine = new SelfHealingEngine({ log: extension.log });
} catch (err) {
    extension.log.warn(`[enm] SelfHealingEngine construction failed: ${err.message}`);
    extensionHandleForRoutes.engine = {};
}

mountRoute('/setup',   'setup.js');
mountRoute('/chains',  'chains.js');
mountRoute('/audit',   'audit.js');
mountRoute('/healing', 'healing.js');
mountRoute('/config',  'config.js');
mountRoute('/logs',    'logs.js');
mountRoute('/system',  'system.js');
mountRoute('/evm',     'evm.js');
mountRoute('/events',  'events.js');

// Convenience: a /health endpoint at the API root that doesn't go
// through the system route file (kept dead-simple so dApp Centre +
// uptime monitors can probe a known-200 endpoint without hitting
// any service code).
extension.get('/api/enm/health', { subdomain: 'api' }, (req, res) => {
    res.json({
        ok: initialised,
        version: '0.5.0',
        uptimeMs: Date.now() - startedAt,
        port: 'wave7-m8-sub-phases-2-3',
    });
});
