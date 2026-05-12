/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/config.js — read + write the operator-facing settings (Phase 5).
 *
 *   GET  /config                            owner-redacted view of the full config
 *   GET  /config/rpc/credentials/:chainId   owner-only — plaintext RPC user/pass + reachable hosts
 *   PUT  /config/network                    update DPoS IP override + mode
 *   PUT  /config/mainchain                  update advanced mainchain knobs
 *   PUT  /config/general                    update healing/notifications/audit prefs
 *   POST /config/rollback                   restore previous .bak version
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

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../auth/OwnerCheckMiddleware');
const os = require('node:os');
const ConfigStore = require('../services/ConfigStore');
const { redactSecrets } = require('../services/EnmConfigRedact');

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

    // GET /config/rpc/credentials/:chainId — owner-only.
    //
    // Returns the live RPC user + plaintext password so the operator can
    // wire an external wallet / dApp / monitoring tool to the chain. This
    // is the ONLY endpoint that returns the password unredacted, hence the
    // requireOwner gate and the `admin` rate-limit scope.
    //
    // Reachable hosts: ela's RPC server binds to 0.0.0.0 by default, and
    // we restrict access via WhiteIPList. The response includes:
    //   - localUrl    : http://127.0.0.1:<port>     (always works locally)
    //   - lanUrls[]   : http://<lan-ip>:<port>       (one per non-loopback iface)
    // The operator picks the URL appropriate to where their client lives,
    // and ensures the client's source IP is in whiteIPList.
    router.get('/rpc/credentials/:chainId', limit('admin'), requireOwner, async (req, res) => {
        try {
            const chainId = req.params.chainId;
            const cfg = await ConfigStore.load();
            const chain = cfg.chains && cfg.chains[chainId];
            if (!chain) {
                return res.status(404).json(errorBody(`Chain "${chainId}" is not configured.`));
            }
            if (!chain.rpc || typeof chain.rpc.passwordEncrypted !== 'string'
                || chain.rpc.passwordEncrypted.length === 0) {
                return res.status(409).json(errorBody('RPC password not set yet — finish setup first.'));
            }
            let password;
            try {
                password = ConfigStore.getRpcPassword(chain);
            } catch (err) {
                extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /config/rpc/credentials: decrypt failed: ${err.message}`);
                return res.status(500).json(errorBody('Failed to decrypt RPC password.'));
            }

            const port = chain.ports && chain.ports.rpc;
            const lanUrls = collectLanUrls(port);

            return res.json(successBody({
                chainId,
                user: chain.rpc.user,
                password,
                port,
                localUrl: `http://127.0.0.1:${port}`,
                lanUrls,
                // alpha.19: master enable state — frontend uses this to drive
                // the on/off toggle.
                enabled: chain.rpc.enabled === true,
                whiteIPList: Array.isArray(chain.rpc.whiteIPList) ? chain.rpc.whiteIPList : ['127.0.0.1'],
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /config/rpc/credentials: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
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
            // alpha.19: master gate for external RPC access. Defaults to false
            // on new installs (see EnmConfigSchema). When false, the generated
            // ela config.json hard-forces WhiteIPList=['127.0.0.1'] regardless
            // of what the operator saved here.
            if (typeof body.rpcEnabled === 'boolean') {
                chain.rpc.enabled = body.rpcEnabled;
            }
            if (typeof body.rpcUser === 'string' && body.rpcUser.length > 0) {
                chain.rpc.user = body.rpcUser;
            }
            if (typeof body.rpcPassword === 'string' && body.rpcPassword.length > 0) {
                ConfigStore.setRpcPassword(chain, body.rpcPassword);
            }
            if (Array.isArray(body.whiteIPList)) {
                chain.rpc.whiteIPList = body.whiteIPList.filter((s) => typeof s === 'string');
                // SAFETY NET (alpha.19): 127.0.0.1 is required for ENM's own
                // RPC calls + local diagnostics. Force-include if a UI bug or
                // sloppy client tries to remove it — operator can't lock us out.
                if (!chain.rpc.whiteIPList.includes('127.0.0.1')) {
                    chain.rpc.whiteIPList.unshift('127.0.0.1');
                }
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

/**
 * Build http://<ip>:<port> URLs for every non-loopback IPv4 interface so the
 * operator can pick the address matching where their client lives. IPv6 link-
 * local entries are skipped — they're rarely useful for RPC clients.
 *
 * @param {number} port
 * @returns {string[]}
 */
function collectLanUrls(port) {
    if (!Number.isInteger(port)) return [];
    const out = [];
    let ifaces;
    try { ifaces = os.networkInterfaces(); } catch { return []; }
    for (const name of Object.keys(ifaces || {})) {
        for (const a of ifaces[name] || []) {
            if (!a || a.internal) continue;
            if (a.family === 'IPv4' || a.family === 4) {
                out.push(`http://${a.address}:${port}`);
            }
        }
    }
    return out;
}

module.exports = { build, redactSecrets };
