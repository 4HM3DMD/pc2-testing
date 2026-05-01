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

const PORT = parseInt(process.env.PORT || '4180', 10);
const ENM_DATA_DIR = process.env.ENM_DATA_DIR || '/data/enm';
const PC2_HOSTNAME = process.env.PC2_HOSTNAME || '*'; // Origin allowed to call us.

async function main() {
    fs.mkdirSync(ENM_DATA_DIR, { recursive: true });

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

    api.use('/setup',  setupRouter.build(extensionHandle));
    api.use('/system', systemRouter.build(extensionHandle));
    api.use('/chains', chainsRouter.build(extensionHandle));
    api.use('/logs',   logsRouter.build({ extensionHandle }));
    api.use('/config', configRouter.build(extensionHandle));
    api.use('/events', eventsRouter.build({
        extensionHandle,
        sseHub: ChainRegistry.getSseHub(),
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

    // --- listen ------------------------------------------------------------
    app.listen(PORT, () => {
        log('info', `enm-server listening on :${PORT}`);
        log('info', `health: http://localhost:${PORT}${ENM_API_PREFIX}/health`);
    });
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
