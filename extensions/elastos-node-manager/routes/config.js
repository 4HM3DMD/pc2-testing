/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/config.js — read + write the operator-facing settings (Phase 5).
 *
 *   GET  /config                       owner-redacted view of the full config
 *   PUT  /config/network               update DPoS IP override + mode
 *   PUT  /config/mainchain             update advanced mainchain knobs
 *   PUT  /config/general               update healing/notifications/audit prefs
 *   POST /config/rollback              restore previous .bak version
 *
 * Mutations are owner-only and rate-limited via the `admin` scope. Reads are
 * authenticated but do not require owner — most operators run a single-owner
 * PC2 and the config is operationally safe to inspect.
 *
 * Sensitive fields (rpc.passwordEncrypted) never leave this server in
 * plaintext. The PUT endpoints accept a new RPC password as `rpcPassword` and
 * pipe it through ConfigStore.setRpcPassword (AES-GCM encrypt before persist).
 */

'use strict';

const express = require('express');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../lib/EnmConstants');
const { limit } = require('../lib/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../lib/OwnerCheckMiddleware');
const ConfigStore = require('../lib/ConfigStore');
const { redactSecrets } = require('../lib/EnmConfigRedact');

/**
 * @param {object} extensionHandle
 * @returns {import('express').Router}
 */
function build(extensionHandle) {
    const router = express.Router();

    // GET /config — full config minus secrets.
    router.get('/', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const cfg = await ConfigStore.load();
            return res.json(successBody({ config: redactSecrets(cfg) }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /config: ${err.message}`);
            return res.status(500).json(errorBody('Failed to load config.'));
        }
    });

    // PUT /config/network — DPoS external IP knobs.
    router.put('/network', limit('admin'), requireOwner, async (req, res) => {
        try {
            const { mode, manualValue } = req.body || {};
            if (mode && mode !== 'auto' && mode !== 'manual') {
                return res.status(400).json(errorBody(`Invalid mode "${mode}".`));
            }
            const cfg = await ConfigStore.load();
            const chain = cfg.chains && cfg.chains.mainchain;
            if (!chain) {
                return res.status(409).json(errorBody('Mainchain not configured.'));
            }
            chain.dpos = chain.dpos || {};
            if (mode) chain.dpos.ipAddressMode = mode;
            chain.dpos.ipAddressManual = (mode === 'manual' && typeof manualValue === 'string')
                ? manualValue.trim()
                : (mode === 'auto' ? null : chain.dpos.ipAddressManual);
            await ConfigStore.save(cfg, { logger: extensionHandle.log });
            return res.json(successBody({ dpos: chain.dpos }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} PUT /config/network: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // PUT /config/mainchain — advanced knobs.
    router.put('/mainchain', limit('admin'), requireOwner, async (req, res) => {
        try {
            const body = req.body || {};
            const cfg = await ConfigStore.load();
            const chain = cfg.chains && cfg.chains.mainchain;
            if (!chain) {
                return res.status(409).json(errorBody('Mainchain not configured.'));
            }
            if (typeof body.logLevel === 'string') chain.logLevel = body.logLevel;
            if (typeof body.archiveMode === 'boolean') chain.archiveMode = body.archiveMode;
            if (Number.isInteger(body.memoryLimitMb)) chain.memoryLimitMb = body.memoryLimitMb;

            chain.rpc = chain.rpc || {};
            if (typeof body.rpcUser === 'string' && body.rpcUser.length > 0) {
                chain.rpc.user = body.rpcUser;
            }
            if (typeof body.rpcPassword === 'string' && body.rpcPassword.length > 0) {
                ConfigStore.setRpcPassword(chain, body.rpcPassword);
            }
            if (Array.isArray(body.whiteIPList)) {
                chain.rpc.whiteIPList = body.whiteIPList.filter((s) => typeof s === 'string');
            }

            await ConfigStore.save(cfg, { logger: extensionHandle.log });
            return res.json(successBody({ ok: true }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} PUT /config/mainchain: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // PUT /config/general — healing + notifications + audit prefs.
    router.put('/general', limit('admin'), requireOwner, async (req, res) => {
        try {
            const body = req.body || {};
            const cfg = await ConfigStore.load();
            cfg.global = cfg.global || {};
            cfg.global.healing = cfg.global.healing || {};
            cfg.global.notifications = cfg.global.notifications || {};
            cfg.global.audit = cfg.global.audit || {};
            if (typeof body.autoExecuteSafe === 'boolean') {
                cfg.global.healing.autoExecuteSafe = body.autoExecuteSafe;
            }
            if (typeof body.criticalRequiresAck === 'boolean') {
                cfg.global.notifications.criticalRequiresAck = body.criticalRequiresAck;
            }
            if (Number.isInteger(body.auditRetentionDays) && body.auditRetentionDays >= 0) {
                cfg.global.audit.retentionDays = body.auditRetentionDays;
            }
            await ConfigStore.save(cfg, { logger: extensionHandle.log });
            return res.json(successBody({ global: cfg.global }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} PUT /config/general: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // POST /config/rollback — F9 healing path.
    router.post('/rollback', limit('admin'), requireOwner, async (req, res) => {
        try {
            const restored = await ConfigStore.rollback();
            if (!restored) {
                return res.status(404).json(errorBody('No backup available.'));
            }
            return res.json(successBody({ config: redactSecrets(restored) }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /config/rollback: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    return router;
}

module.exports = { build, redactSecrets };
