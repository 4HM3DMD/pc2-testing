/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * server.js — standalone Express bootstrap for the Elastos Node Manager
 * sidecar. Replaces the Puter-extension lifecycle (preinit/init/install.routes/
 * ready) with a single startup sequence:
 *
 *   1. Open ENM's own SQLite DB at ENM_DATA_DIR/enm.db
 *   2. Initialize schema (delegates to services/EnmDb.initSchema)
 *   3. Build the "extensionHandle" object the ported routes/services expect
 *      — same shape as Puter's, but backed by our DB + console logger
 *   4. Initialize ChainRegistry (process supervisor + adapters)
 *   5. Mount all route builders
 *   6. Start the post-boot work (reattach orphan ela processes, launch
 *      sweepers + auto-start) — same as the old extension's 'ready' handler
 *   7. listen() on PORT
 *
 * Auth: every mutating route already imports requireOwner from
 * ../auth/OwnerCheckMiddleware, which reads pc2-node's session DB to
 * resolve the Bearer token to a wallet, then matches against pc2-node's
 * recorded owner wallet. Nothing wired here.
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Copy keystore.dat into PC2's data root so it survives an ENM
 * uninstall+purge. The keystore is the ONLY unrecoverable piece —
 * losing it means losing the registered BPoS supernode on-chain.
 * Chain data, audit DB, binaries, configs are all re-creatable.
 *
 * Returns a summary the operator's UI can surface so they know where
 * the backup lives.
 */
function backupKeystoreForTeardown() {
    // Module exports `{ EnmKeystoreService, generatePassword }` — destructure;
    // `require` of the whole module returns the wrapper object, not the class.
    const { EnmKeystoreService } = require('./services/EnmKeystoreService');
    const svc = new EnmKeystoreService();
    const src = svc.keystorePath();
    if (!fs.existsSync(src)) {
        return { keystore_backed_up: false, reason: 'no keystore present' };
    }
    const pc2Data = process.env.PC2_DATA_DIR || '/var/lib/pc2/data';
    const backupRoot = path.join(pc2Data, 'backups', 'elastos-node-manager');
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(backupRoot, `keystore-${ts}.dat`);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o600);
    return {
        keystore_backed_up: true,
        backup_path: dst,
        original_path: src,
        message: `Keystore backed up. To restore: cp ${dst} ${src}`,
    };
}

const { openDb } = require('./db');

// Services
const { ENM_LOG_PREFIX, ENM_API_PREFIX, errorBody, successBody } = require('./services/EnmConstants');
const enmAuditMiddleware = require('./services/EnmAuditMiddleware');
const ChainRegistry = require('./services/ChainRegistry');
const { initSchema } = require('./services/EnmDb');

// Routes
const setupRouter = require('./routes/setup');
const systemRouter = require('./routes/system');
const chainsRouter = require('./routes/chains');
const eventsRouter = require('./routes/events');
const logsRouter = require('./routes/logs');
const healingRouter = require('./routes/healing');
const auditRouter = require('./routes/audit');
const configRouter = require('./routes/config');
const updatesRouter = require('./routes/updates');
const evmRouter = require('./routes/evm');
// beta.3.33 — Settings → Danger Zone backend (update / chain-resync /
// uninstall / nuke). Mounted at /api/enm/maintenance/* below.
const maintenanceRouter = require('./routes/maintenance');
// beta.3.43 — Settings → Identity tab backend (unlock / backup /
// import / reset). Mounted at /api/enm/identity/* below.
const identityRouter = require('./routes/identity');
// beta.3.90 (Wave M2.2) — Council scope endpoints (multi-chain
// overview aggregator). Mounted at /api/enm/council/* below.
const councilRouter = require('./routes/council');
// beta.3.78 — snapshots routes + EnmStateSnapshot service removed.
// Per operator review: a chain server's canonical recovery is resync
// from peers, not a 1-hour-old cache rollback. The snapshot system
// was a band-aid for an upstream ela bug (crash-on-corrupt cp_dpos)
// and auto-rollback could mask real corruption. F22 detection stays
// (operators want to KNOW about DPoS desync) but its action is now
// CRITICAL_NOTIFY — operator decides what to do.

const PORT = parseInt(process.env.PORT || '4180', 10);
// Single source of truth for ENM's data location: DataDir.enmDataDir().
// The earlier hardcoded '/data/enm' fallback put ENM's DB + setup_state at
// /data/enm/enm.db while DataDir.js put keystore + chain data at
// ${PC2_DATA_DIR}/extensions/elastos-node-manager/. Two divergent paths
// meant a purge-uninstall could wipe one and leave the other —
// reinstalls then read "setup already complete" from the surviving DB
// and skip the setup wizard. Fixed by going through DataDir.js, which
// honours ENM_DATA_DIR if set, then PC2_DATA_DIR + extensions/, then
// ./data as last-resort dev fallback. (Operator hit this 2026-05-07.)
const { enmDataDir } = require('./services/DataDir');
const ENM_DATA_DIR = enmDataDir();
const PC2_HOSTNAME = process.env.PC2_HOSTNAME || '*'; // Origin allowed to call us.

async function main() {
    // ENM_DATA_DIR is already mkdir'd by DataDir.enmDataDir() at module
    // load (line 95 above). Don't re-mkdir here.

    const dbPath = path.join(ENM_DATA_DIR, 'enm.db');
    const db = openDb(dbPath);
    log('info', `opening DB ${dbPath}`);

    await initSchema(db);
    log('info', 'schema ready');

    // --- Build the "extensionHandle" the ported routes expect. -------------
    // Routes call:
    //   handle.import('data').db        → wrapped sqlite (our `db`)
    //   handle.log.{info,warn,error}    → console wrappers
    // Anything else they'd reach for in Puter (filesystem, kvstore, etc.) is
    // not used in our route surface — verified during the port.
    const extensionHandle = {
        import(name) {
            if (name === 'data') return { db };
            throw new Error(`enm-server fake extensionHandle: unsupported import('${name}')`);
        },
        log: {
            debug: (...a) => console.debug('[ENM]', ...a),
            info:  (...a) => console.log('[ENM]',   ...a),
            warn:  (...a) => console.warn('[ENM]',  ...a),
            error: (...a) => console.error('[ENM]', ...a),
        },
    };

    // --- ChainRegistry init (NativeProcessService + adapters). -------------
    ChainRegistry.init(extensionHandle);

    // --- Express app. ------------------------------------------------------
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: false }));

    // CORS: ENM frontend is loaded from pc2-node origin (different port).
    // We must echo the request origin (not `*`) when allowing credentials,
    // so the browser sends the Bearer token.
    app.use(cors({
        origin: (origin, cb) => cb(null, true), // permissive — pc2-node already gates the desktop login
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    }));

    // --- Mount routes under /api/enm/. -------------------------------------
    const api = express.Router();

    // Audit middleware applies to all mutations.
    api.use(enmAuditMiddleware.build(extensionHandle));

    // Liveness probe — no auth, used for healthcheck / install verify.
    api.get('/health', (_req, res) => {
        res.json({ ok: true, ts: Date.now() });
    });

    // whoami — returns the wallet for the current Bearer token, or 401.
    // Used by the frontend wallet service as a fallback when PC2's
    // 'getTetheredDID' IPC isn't wired up for ENM. Also returns whether the
    // caller is the node owner so the wallet badge can reflect that.
    api.get('/whoami', (req, res) => {
        const { readActorWallet, readNodeOwner, _walletsEqual } = require('./auth/OwnerCheckMiddleware');
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        let isOwner = false;
        try {
            const owner = readNodeOwner();
            isOwner = owner ? _walletsEqual(wallet, owner) : false;
        } catch (_) { /* fail closed on owner check */ }
        res.json(successBody({ wallet_address: wallet, isOwner }));
    });

    // --- Teardown hook for service-type uninstall ---------------------------
    // pc2-node POSTs here on uninstall (purge mode) BEFORE SIGTERMing us.
    // We back up the only unrecoverable file (keystore.dat) to PC2's data
    // root so a re-install can recover the operator's BPoS supernode.
    //
    // Loopback-only — pc2-node calls us at 127.0.0.1; rejecting non-local
    // callers means a stray request can't trigger keystore copy operations.
    api.post('/teardown', (req, res) => {
        const ip = req.ip || req.socket.remoteAddress || '';
        if (!ip.startsWith('127.') && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
            return res.status(403).json(errorBody('teardown is loopback-only'));
        }
        try {
            // beta.3.84 — Wave E — mark all running chains as manualStop
            // BEFORE the keystore backup. pc2-node will SIGTERM us next; the
            // subsequent child ela SIGTERMs must NOT look like external
            // killers (Wave B forensics chased a phantom bug all night
            // because deploys were the only "killer"). Synchronous; the
            // markers must land before pc2-node sends the signal.
            try {
                const marked = ChainRegistry.getProcessService().markAllManualStop();
                log('info', `teardown: pre-marked ${marked.length} chain(s) as manualStop`);
            } catch (markErr) {
                log('warn', `teardown: markAllManualStop failed (non-fatal): ${markErr.message}`);
            }
            const result = backupKeystoreForTeardown();
            return res.json(successBody(result));
        } catch (err) {
            return res.status(500).json(errorBody(`teardown failed: ${err.message}`));
        }
    });

    api.use('/setup',  setupRouter.build(extensionHandle));
    api.use('/system', systemRouter.build(extensionHandle));
    api.use('/chains', chainsRouter.build(extensionHandle));
    api.use('/logs',   logsRouter.build({ extensionHandle }));
    api.use('/config', configRouter.build(extensionHandle));
    api.use('/updates', updatesRouter.build(extensionHandle));
    // 0.2.0-beta.3.8 — pull the hub into a local so post-boot wiring
    // (AuditLog → SSE bridge below) can publish without re-fetching.
    const sseHub = ChainRegistry.getSseHub();
    api.use('/events', eventsRouter.build({
        extensionHandle,
        sseHub,
    }));

    // Healing depends on the engine, which initializes after this module loads.
    // Pass a lazy resolver so route builders don't crash on import.
    const lazyEngine = buildLazyEngine(extensionHandle);
    let cachedDb = null;
    const getDb = () => {
        if (!cachedDb) cachedDb = extensionHandle.import('data').db;
        return cachedDb;
    };
    api.use('/healing', healingRouter.build({
        extensionHandle,
        getDb,
        engine: lazyEngine,
    }));
    api.use('/audit', auditRouter.build({ extensionHandle, getDb }));
    // beta.3.33 — Settings → Danger Zone. Owner-gated POST routes for
    // update / chain-resync / uninstall / nuke plus GET routes for
    // check-update + status. Audit middleware (skips GETs) attached
    // above already covers the destructive POSTs.
    api.use('/maintenance', maintenanceRouter.build({ extensionHandle, getDb }));
    // beta.3.43 — Settings → Identity tab (unlock keystore, download
    // backup, import, full reset). All routes owner-gated; destructive
    // ones check producer state + audit-log.
    api.use('/identity', identityRouter.build({ extensionHandle, getDb }));
    // beta.3.90 (Wave M2.2) — Council overview aggregator. GET-only;
    // lazy resolver because the CouncilOverviewService is built AFTER
    // ChainRegistry.initHealing() in the post-boot block below, so
    // the router has to mount during this build-up phase + find the
    // service later via the resolver.
    let _overviewService = null;
    api.use('/council', councilRouter.build({
        extensionHandle,
        getOverviewService: () => _overviewService,
    }));
    // beta.3.78 — /snapshots route removed (see top-of-file comment).

    // EVM placeholder (v0.5+). Reserves /api/enm/evm/* so future cross-chain
    // routes can land without naming collisions. Returns 501 today.
    api.use('/evm', evmRouter.build(extensionHandle));

    app.use(ENM_API_PREFIX, api);

    // --- Post-boot work — same as the old extension's 'ready' handler. -----
    // Wired here BEFORE listen() so we don't accept traffic until reattach
    // has had a chance to scan; sweepers run on their own timers either way.
    try {
        const reattached = await ChainRegistry.getProcessService().reattach();
        if (reattached.length > 0) {
            log('info', `reattached ${reattached.length} chain(s): ${reattached.map(r => r.chainId).join(', ')}`);
        }
    } catch (err) {
        log('error', `reattach scan failed: ${err.message}`);
    }

    try {
        ChainRegistry.initHealing(() => extensionHandle.import('data').db);
        ChainRegistry.getHealthChecker().start();
    } catch (err) {
        log('error', `healing init failed: ${err.message}`);
    }

    // beta.3.90 (Wave M2.2) — start the Council overview aggregator.
    // Periodic 5s tick + immediate re-publish on any chain exit.
    // Started AFTER ChainRegistry.init() (the registry is what the
    // aggregator reads) but doesn't depend on the healing engine, so
    // ordering relative to initHealing isn't load-bearing — placed
    // here for grouping with other post-boot service starts. The
    // closure in api.use('/council', ...) above captures the local
    // _overviewService variable so the GET endpoint sees the live
    // instance once it's built.
    try {
        const { CouncilOverviewService } = require('./services/CouncilOverviewService');
        _overviewService = new CouncilOverviewService({
            extensionHandle,
            registry: ChainRegistry,
            sseHub,
        });
        _overviewService.start();
        log('info', 'council-overview service started (tick=5s + exit-hook)');
    } catch (err) {
        log('error', `council-overview init failed: ${err.message}`);
    }

    // beta.3.51 — autoStart loop. Schema's `global.autoStart.onBoot` (default
    // true) was dead code prior to this release: reattach() only re-bound to
    // ela processes that were ALREADY running, so any boot where ela had
    // exited (deploy, crash, host reboot, post-resync) left enabled chains
    // `stopped` until F1's slow self-heal cadence eventually fired. Now we
    // schedule a post-reattach start pass after `delaySec` (default 10s).
    // See services/EnmAutoStart.js for gating + audit details.
    try {
        const { runAutoStart } = require('./services/EnmAutoStart');
        const decision = await runAutoStart({ extensionHandle, registry: ChainRegistry });
        log('info', `autoStart: ${JSON.stringify(decision)}`);
    } catch (err) {
        log('error', `autoStart init failed: ${err.message}`);
    }

    // beta.3.20 (Phase 3) — periodic storage maintenance. Compacts
    // chain logs every 24h (gzip+purge per cfg.global.logRotation) and
    // auto-backs-up the keystore every N days (default 7) per
    // cfg.global.backup.keystoreIntervalDays. Operator never has to
    // run a manual rotate or backup; both are scheduled and idempotent.
    try {
        const { EnmStorageMaintenance } = require('./services/EnmStorageMaintenance');
        const storageMaintenance = new EnmStorageMaintenance({
            extensionHandle,
            listChains: () => ChainRegistry.listChains(),
        });
        storageMaintenance.start();
    } catch (err) {
        log('error', `storage maintenance init failed: ${err.message}`);
    }

    // beta.3.78 — EnmStateSnapshot service removed. The hourly cache-
    // file backup was a band-aid for an upstream ela bug (crash on
    // corrupt cp_dpos read) and auto-rollback risked masking real
    // corruption. F22 still detects the desync signal via the log
    // probe but now alerts the operator instead of rolling state back.

    // 0.2.0-beta.3.8 — wire AuditLog → SseHub bridge. Every audit row
    // inserted via EnmAuditLog.append() now also publishes on the
    // `audit` topic. Frontend audit-tab subscribes and prepends new
    // rows in real time instead of polling.
    //
    // beta.3.52 — switched from publishToWallet (PC2-wallet-scoped) to
    // broadcast publish. ENM is single-tenant: one operator authenticated
    // via requireOwner, one keystore. There's no second wallet to leak to.
    // The /events SSE endpoint still requires authentication at subscribe
    // time, and the audit route is owner-gated; broadcasting on the topic
    // exposes the same rows the owner already reads via GET /audit.
    try {
        const AuditLog = require('./services/EnmAuditLog');
        AuditLog.setPublishHook(
            (row) => {
                if (!row) { return; }
                sseHub.publish('audit', row);
            },
            (err) => {
                log('debug', `audit SSE publish failed (non-fatal): ${err.message}`);
            },
        );
    } catch (err) {
        log('error', `audit SSE bridge init failed: ${err.message}`);
    }

    // 0.2.0-beta.3.7 — audit-log retention job. EnmDb has had
    // cleanupOldAuditLogs() since the schema was introduced, but it was
    // never wired into the boot path so audit rows accumulated forever.
    // Schedule a daily sweep at boot+1min then every 24h, honouring the
    // operator-configured retention window (settings.general.auditRetentionDays).
    // 0 = forever; we skip the sweep in that case.
    try {
        const { cleanupOldAuditLogs } = require('./services/EnmDb');
        const db = extensionHandle.import('data').db;
        const getRetention = async () => {
            // Read fresh each fire so an operator change in Settings
            // (PUT /config/general) takes effect on the next sweep
            // without a server restart.
            try {
                const ConfigStore = require('./services/ConfigStore');
                const cfg = await ConfigStore.load();
                const g = cfg && cfg.global && cfg.global.audit;
                const d = g && typeof g.retentionDays === 'number' ? g.retentionDays : null;
                if (d != null) { return d; }
            } catch (_) { /* fall through to default */ }
            // Fallback: package.json's enm.auditRetentionDaysDefault (365).
            return 365;
        };
        const sweep = async () => {
            const days = await getRetention();
            if (!days || days <= 0) {
                log('info', 'audit cleanup: retention=forever, skipping sweep');
                return;
            }
            try {
                const deleted = await cleanupOldAuditLogs(db, days);
                if (deleted > 0) {
                    log('info', `audit cleanup: pruned ${deleted} rows older than ${days}d`);
                }
            } catch (err) {
                log('error', `audit cleanup failed: ${err.message}`);
            }
        };
        // First sweep 60s after boot — past any reattach storm — then every 24h.
        setTimeout(sweep, 60_000);
        setInterval(sweep, 24 * 60 * 60 * 1000);
    } catch (err) {
        log('error', `audit cleanup init failed: ${err.message}`);
    }

    // --- listen ------------------------------------------------------------
    app.listen(PORT, () => {
        log('info', `enm-server listening on :${PORT}`);
        log('info', `health: http://localhost:${PORT}${ENM_API_PREFIX}/health`);
    });

    // beta.3.84 — Wave E — graceful-shutdown signal handlers. The
    // /teardown route handles the pc2-node-uninstall path (mark all
    // chains manualStop BEFORE pc2-node SIGTERMs us). These handlers
    // cover every OTHER way ENM can be told to shut down: systemd
    // restart, manual SIGTERM, OOM kill, kill -INT, Ctrl+C in dev.
    // Without them, those shutdowns would also kill child ela
    // processes with manual=false → spurious external-SIGTERM
    // forensic entries + spurious F1 fires after the next ENM boot.
    //
    // Signal handlers run before Node exits the event loop. They
    // call markAllManualStop() synchronously (a Map iteration —
    // sub-millisecond) then re-throw the signal to honour the
    // operator's shutdown intent. Idempotent — installing once is
    // safe even if init() is re-called (pre-deploy or hot-reload).
    if (!global.__enmSignalHandlersInstalled) {
        global.__enmSignalHandlersInstalled = true;
        const onShutdown = (signal) => {
            log('info', `received ${signal} — pre-marking running chains as manualStop`);
            try {
                const marked = ChainRegistry.getProcessService().markAllManualStop();
                log('info', `${signal}: pre-marked ${marked.length} chain(s)`);
            } catch (err) {
                log('warn', `${signal}: markAllManualStop failed (non-fatal): ${err.message}`);
            }
            // Don't process.exit() — let the natural exit path run so any
            // pending writes complete. The Node process exits when the
            // event loop drains; nothing keeps it alive after listen()
            // sockets close on signal.
        };
        process.on('SIGTERM', () => onShutdown('SIGTERM'));
        process.on('SIGINT',  () => onShutdown('SIGINT'));
    }
}

function log(level, msg) {
    const fn = console[level] || console.log;
    fn.call(console, `${ENM_LOG_PREFIX} ${msg}`);
}

/**
 * Build a thin proxy that resolves the engine on first call. Same shape the
 * original extension's routes/index.js uses to handle a slow boot.
 */
function buildLazyEngine(extensionHandle) {
    let cached = null;
    const resolve = () => (cached ||= ChainRegistry.getEngine());
    return {
        executeApproved: (id, wallet) => {
            try { return resolve().executeApproved(id, wallet); }
            catch (err) {
                extensionHandle.log.error(`engine not ready: ${err.message}`);
                return Promise.resolve({ ok: false, error: 'Healing engine not ready yet.' });
            }
        },
        rejectProposal: (id, wallet, reason) => {
            try { return resolve().rejectProposal(id, wallet, reason); }
            catch (err) {
                extensionHandle.log.error(`engine not ready: ${err.message}`);
                return Promise.resolve({ ok: false, error: 'Healing engine not ready yet.' });
            }
        },
    };
}

main().catch((err) => {
    console.error('[ENM] fatal startup error', err);
    process.exit(1);
});
