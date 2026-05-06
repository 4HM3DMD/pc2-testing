/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/index.js — top-level router mount point.
 *
 * Called from main.js install.routes hook with the Express app and extension
 * handle. Responsible for:
 *   1. Mounting our static frontend at /extensions/elastos-node-manager/
 *   2. Mounting our API at /extensions/elastos-node-manager/api/
 *   3. Wiring our own audit middleware on /api routes (PC2's auditMiddleware
 *      doesn't know about our paths — Rev 6 audit).
 *
 * URL shape (per Rev 7 architecture decision):
 *   GET  /extensions/elastos-node-manager/                 → public/index.html
 *   GET  /extensions/elastos-node-manager/css/*            → public/css/*
 *   GET  /extensions/elastos-node-manager/js/*             → public/js/*
 *   GET  /extensions/elastos-node-manager/api/health       → liveness
 *   GET  /extensions/elastos-node-manager/api/setup/state  → setup wizard progress
 *   POST /extensions/elastos-node-manager/api/setup/...
 *   ...
 */

'use strict';

const express = require('express');
const path = require('node:path');

const { ENM_LOG_PREFIX, ENM_ROUTE_PREFIX, ENM_API_PREFIX } = require('../services/EnmConstants');
const enmAuditMiddleware = require('../services/EnmAuditMiddleware');

const setupRouter = require('./setup');
const systemRouter = require('./system');
const chainsRouter = require('./chains');
const eventsRouter = require('./events');
const logsRouter = require('./logs');
const healingRouter = require('./healing');
const auditRouter = require('./audit');
const configRouter = require('./config');
const ChainRegistry = require('../services/ChainRegistry');

/**
 * Mount all routes onto the PC2 Express app.
 *
 * @param {import('express').Application} app  PC2's main Express app (event.app)
 * @param {object} extensionHandle             PC2 extension global
 */
function mountRoutes(app, extensionHandle) {
    if (!app || typeof app.use !== 'function') {
        throw new Error('routes/index.mountRoutes: app is not an Express application');
    }

    const publicDir = path.join(__dirname, '..', 'public');

    // --- Static frontend ---
    // Long-cache for static assets (CSS/JS/images), no-cache for HTML.
    app.use(`${ENM_ROUTE_PREFIX}/css`, express.static(path.join(publicDir, 'css'), STATIC_LONG_CACHE));
    app.use(`${ENM_ROUTE_PREFIX}/js`,  express.static(path.join(publicDir, 'js'),  STATIC_LONG_CACHE));
    app.use(`${ENM_ROUTE_PREFIX}/assets`, express.static(path.join(publicDir, 'assets'), STATIC_LONG_CACHE));

    // index.html with no-cache so updates roll out immediately to operator.
    app.get(ENM_ROUTE_PREFIX, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(path.join(publicDir, 'index.html'));
    });
    app.get(`${ENM_ROUTE_PREFIX}/`, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(path.join(publicDir, 'index.html'));
    });
    app.get(`${ENM_ROUTE_PREFIX}/index.html`, (req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(path.join(publicDir, 'index.html'));
    });

    // --- API ---
    const api = express.Router();

    // Audit middleware applies to all mutations on this sub-router.
    api.use(enmAuditMiddleware.build(extensionHandle));

    // Liveness probe — no auth, no audit. Used for self-checks.
    api.get('/health', (req, res) => {
        res.json({ ok: true, ts: Date.now() });
    });

    api.use('/setup', setupRouter.build(extensionHandle));
    api.use('/system', systemRouter.build(extensionHandle));
    api.use('/chains', chainsRouter.build(extensionHandle));
    api.use('/logs', logsRouter.build({ extensionHandle }));
    api.use('/config', configRouter.build(extensionHandle));
    // SSE — depends on ChainRegistry being initialized in main.js init hook.
    api.use('/events', eventsRouter.build({
        extensionHandle,
        sseHub: ChainRegistry.getSseHub(),
    }));
    // Healing + audit — depend on the healing engine, initialized in 'ready'.
    // Routes resolve via lazy ChainRegistry.getEngine() inside handlers so we
    // don't crash if a request races a slow boot.
    //
    // The db handle is cached on first call so we don't re-enter the
    // `extension.import('data')` plumbing on every request (Phase 4 audit).
    let cachedDb = null;
    const getDb = () => {
        if (!cachedDb) {
            cachedDb = extensionHandle.import('data').db;
        }
        return cachedDb;
    };
    api.use('/healing', healingRouter.build({
        extensionHandle,
        getDb,
        engine: lazyEngine(extensionHandle),
    }));
    api.use('/audit', auditRouter.build({ extensionHandle, getDb }));

    app.use(ENM_API_PREFIX, api);

    extensionHandle.log.info(`${ENM_LOG_PREFIX} routes mounted under ${ENM_ROUTE_PREFIX}`);
}

/**
 * Build a thin proxy that resolves the engine on first call. This lets us
 * mount /healing routes during install.routes (engine isn't built yet) and
 * have the first actual request reach the engine that was created during
 * 'ready'.
 *
 * @param {object} extensionHandle
 */
function lazyEngine(extensionHandle) {
    let cached = null;
    function resolve() {
        if (cached) return cached;
        cached = ChainRegistry.getEngine();
        return cached;
    }
    return {
        executeApproved: (id, wallet) => {
            try { return resolve().executeApproved(id, wallet); }
            catch (err) {
                extensionHandle.log.error(`${ENM_LOG_PREFIX} engine not ready: ${err.message}`);
                return Promise.resolve({ ok: false, error: 'Healing engine not ready yet.' });
            }
        },
        rejectProposal: (id, wallet, reason) => {
            try { return resolve().rejectProposal(id, wallet, reason); }
            catch (err) {
                extensionHandle.log.error(`${ENM_LOG_PREFIX} engine not ready: ${err.message}`);
                return Promise.resolve({ ok: false, error: 'Healing engine not ready yet.' });
            }
        },
    };
}

const STATIC_LONG_CACHE = Object.freeze({
    maxAge: '1d',
    immutable: false,
    setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    },
});

module.exports = {
    mountRoutes,
};
