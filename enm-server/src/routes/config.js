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
    // 0.2.0-beta.3.10 — PUT /config/network request schema.
    //
    //   {
    //     mode:        'auto' | 'manual'  // optional; required for valid save
    //     manualValue: string              // IPv4 / IPv6 / CIDR; required when
    //                                      // mode === 'manual', ignored when 'auto'
    //   }
    //
    // Owner-only. Writes:
    //   chain.dpos.ipAddressMode     ← body.mode
    //   chain.dpos.ipAddressManual   ← body.manualValue (trimmed; null on 'auto')
    //
    // Errors: 400 on invalid mode; 409 when mainchain not configured.
    // Side-effect: ela process needs restart for the IP change to take
    // effect — the frontend Settings card carries a "Restart required"
    // tag (beta.3.6) reflecting this.
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

    // 0.2.0-beta.3.10 — PUT /config/mainchain request schema.
    //
    //   {
    //     logLevel:      'debug' | 'info' | 'warn' | 'error'  // optional
    //     archiveMode:   boolean                              // optional
    //     memoryLimitMb: integer 512..32768                   // optional
    //     rpcEnabled:    boolean                              // optional;
    //                                                          master toggle
    //                                                          for external RPC
    //     rpcUser:       non-empty string                     // optional
    //     rpcPassword:   non-empty string (plaintext)         // optional;
    //                                                          encrypted at rest
    //                                                          via ConfigStore.
    //                                                          setRpcPassword
    //     whiteIPList:   string[] (IPv4/IPv6/CIDR)            // optional;
    //                                                          127.0.0.1 forced
    //                                                          back in if absent
    //   }
    //
    // Owner-only. Each field is optional (PATCH semantics in PUT clothing
    // — caller sends only the fields they want to change). Writes go to
    // cfg.chains.mainchain.*. Side-effect: ela process needs restart for
    // logLevel / archiveMode / memoryLimitMb / rpcEnabled / whiteIPList
    // changes; rpcUser + rpcPassword take effect on next restart too
    // since they end up in ela.conf RPCConfiguration.
    //
    // Errors: 409 when mainchain not configured. Invalid fields are
    // silently ignored (defensive — frontend has inline validation).
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

    // 0.2.0-beta.3.10 — PUT /config/general request schema.
    //
    //   {
    //     autoExecuteSafe:      boolean       // optional; flips
    //                                          cfg.global.healing.autoExecuteSafe
    //     criticalRequiresAck:  boolean       // optional; flips
    //                                          cfg.global.notifications.criticalRequiresAck
    //     auditRetentionDays:   integer >= 0  // optional; 0 = forever; max 3650
    //                                          (3650 frontend-only cap, backend
    //                                          accepts any non-negative int)
    //   }
    //
    // Owner-only. No restart needed for any field — settings take
    // effect on next operation. Healing engine reads autoExecuteSafe
    // each tick; notifications service reads criticalRequiresAck each
    // toast; audit-cleanup sweep (beta.3.7, server.js) reads
    // auditRetentionDays each run.
    //
    // Errors: 500 on ConfigStore.save failure.
    //
    // Note: anti-snipe password sits on cfg.global.antiSnipePasswordHash
    // but has its own endpoint (POST /config/anti-snipe-password) to
    // keep the security-sensitive path isolated from this PUT. Adding
    // antiSnipePassword here would be a mistake — the dedicated route
    // is owner-only AND uses scrypt at the boundary.
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

    // 0.2.0-beta.3.10 — POST /config/anti-snipe-password.
    //
    // Sets (or clears) the scrypt hash that SelfHealingEngine.
    // _verifyAntiSnipePassword consults when a proposal payload has
    // requireAntiSnipe=true. Body:
    //   { password: "..." }   → hash + store at cfg.global.antiSnipePasswordHash
    //   { password: "" }      → clear (disable anti-snipe)
    //   {}                    → no-op (returns current set/unset state)
    //
    // Owner-gated. Password never echoes back; response carries only a
    // boolean `set` derived from the resulting hash presence. Hash
    // format matches what _verifyAntiSnipePassword expects exactly:
    //   `scrypt$<saltHex>$<derivedHex>`.
    //
    // Pre-beta.3.10 the anti-snipe feature was half-shipped: the
    // verify path was wired in beta.3.9 but no operator-facing way
    // to set the hash existed. This endpoint closes that loop.
    router.post('/anti-snipe-password', limit('admin'), requireOwner, async (req, res) => {
        try {
            const body = req.body || {};
            const password = (typeof body.password === 'string') ? body.password : null;
            // null = no-op (operator probably hit the endpoint with no
            // body to query state); empty-string = explicit clear.
            if (password == null) {
                const cfg = await ConfigStore.load();
                return res.json(successBody({
                    set: !!(cfg && cfg.global && cfg.global.antiSnipePasswordHash),
                }));
            }
            const cfg = await ConfigStore.load();
            cfg.global = cfg.global || {};
            if (password === '') {
                // Explicit clear. Strip the field entirely so a future
                // GET /config doesn't leak even the metadata that a
                // hash USED to be set.
                delete cfg.global.antiSnipePasswordHash;
                await ConfigStore.save(cfg, { logger: extensionHandle.log });
                return res.json(successBody({ set: false }));
            }
            // Reject obviously-weak passwords. Server-side sanity only —
            // the operator deserves to know they typed " " by accident.
            if (password.length < 8) {
                return res.status(400).json(errorBody(
                    'Anti-snipe password must be at least 8 characters.',
                ));
            }
            // Hash with scrypt — matches SelfHealingEngine.
            // _verifyAntiSnipePassword exactly. Random 16-byte salt
            // + 64-byte derived key. KDF cost defaults match Node's
            // recommendation (N=16384, r=8, p=1). Owner-only path,
            // so we can use the slightly heavier sync default.
            const crypto = require('crypto');
            const salt = crypto.randomBytes(16);
            const derived = await new Promise((resolve, reject) => {
                crypto.scrypt(password, salt, 64, (err, key) => {
                    if (err) { reject(err); } else { resolve(key); }
                });
            });
            cfg.global.antiSnipePasswordHash = 'scrypt$'
                + salt.toString('hex') + '$' + derived.toString('hex');
            await ConfigStore.save(cfg, { logger: extensionHandle.log });
            return res.json(successBody({ set: true }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} POST /config/anti-snipe-password: ${err.message}`,
            );
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
