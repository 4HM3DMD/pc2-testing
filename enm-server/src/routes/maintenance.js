/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/maintenance.js — Settings → Danger Zone (beta.3.33).
 *
 *   GET  /maintenance/check-update          owner — latest GitHub tag vs current
 *   GET  /maintenance/status                owner — busy/idle of any pending action
 *   POST /maintenance/update                owner — fire deploy-enm.sh <tag>
 *   POST /maintenance/chain-resync          owner — wipe chain data, keep keystore
 *   POST /maintenance/uninstall             owner — uninstall extension, keep data
 *   POST /maintenance/nuke                  owner — uninstall + rm -rf everything
 *
 * All write paths are owner-gated, rate-limited via `admin` scope, and
 * accept a `confirm` field that the route validates against the exact
 * sentinel expected for that action. The frontend Danger Zone card
 * enforces the same typed-confirmation gate; this is defence in depth.
 *
 * Typed-confirmation sentinels (case-sensitive):
 *   chain-resync : "<chainId>"           (e.g. "mainchain")
 *   uninstall    : "remove"
 *   nuke         : "WIPE EVERYTHING"
 *
 * Each successful action emits an EnmAuditLog row with tier
 * "CRITICAL-INFO", decision "executed", executor "operator",
 * walletAddress = the request actor wallet, chainId = "mainchain"
 * (single-chain v0.2). Failed actions emit decision "failed" + outcome
 * containing the error message.
 *
 * Note on the response-then-die pattern: update / uninstall / nuke all
 * detach a shell-out that kills our own process. We send the 200
 * response first (Express flushes synchronously); the detached child
 * sleeps briefly before firing the destructive command so the operator
 * sees confirmation before TCP RST.
 */

'use strict';

const express = require('express');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../auth/OwnerCheckMiddleware');
const RequestSchemas = require('../services/EnmRequestSchemas');
const MaintenanceManager = require('../services/EnmMaintenanceManager');
const AuditLog = require('../services/EnmAuditLog');

// The current ENM version. Read once at module load from package.json so
// we never disagree with the deploy tag.
const CURRENT_VERSION = (() => {
    try {
        // require is relative to this file: ../../package.json
        return require('../../package.json').version;
    } catch (_) { return '0.0.0-unknown'; }
})();

/**
 * @param {object} deps
 * @param {object} deps.extensionHandle
 * @param {() => object} deps.getDb  lazy DB handle
 * @returns {import('express').Router}
 */
function build(deps) {
    if (!deps || !deps.extensionHandle || typeof deps.getDb !== 'function') {
        throw new Error('routes/maintenance.build: { extensionHandle, getDb } required');
    }
    const { extensionHandle, getDb } = deps;
    const router = express.Router();

    // ------------------------------------------------------------------
    // GET /maintenance/check-update
    //
    // Returns whether an ENM extension update is available on GitHub,
    // alongside the version strings the frontend needs for the card.
    // ------------------------------------------------------------------
    router.get('/check-update', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const info = await MaintenanceManager.checkLatestVersion(CURRENT_VERSION);
            return res.json(successBody(info));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /maintenance/check-update: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // ------------------------------------------------------------------
    // GET /maintenance/status
    //
    // Busy/idle of any pending destructive action. Used by the
    // frontend to disable buttons during an in-flight action.
    // ------------------------------------------------------------------
    router.get('/status', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        return res.json(successBody(MaintenanceManager.status()));
    });

    // ------------------------------------------------------------------
    // POST /maintenance/update    owner
    //
    // Body: { tag: "enm-v0.2.0-beta.3.33" }
    //
    // Spawns /root/deploy-enm.sh <tag> as a detached child. ENM dies
    // mid-deploy; pc2-node reinstalls + restarts. Audit emitted before
    // detach so the row survives our PID's death.
    // ------------------------------------------------------------------
    router.post('/update', limit('admin'), requireOwner, async (req, res) => {
        const { value, details } = RequestSchemas.validateBody(
            RequestSchemas.maintenanceUpdateBody, req.body,
        );
        if (details) {
            return res.status(400).json({
                ...errorBody('Invalid request body.'),
                details,
            });
        }
        const wallet = readActorWallet(req);
        const tag = value.tag;
        try {
            // Audit FIRST so the row lands before the script kills us.
            // If the script then ENOENTs we'll have an orphan audit row
            // saying "operator clicked update", which is fine — the
            // operator will see the (still-running) ENM and notice the
            // version didn't change.
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'executed', executor: 'operator',
                outcome: `Maintenance update queued: ${tag}`,
                payload: { action: 'update', tag },
            });
            const r = await MaintenanceManager.update({
                tag, log: extensionHandle.log,
            });
            return res.json(successBody({
                queued: true,
                tag: r.tag,
                logFile: r.logFile,
                message: 'Update queued. ENM will restart in a few seconds. '
                    + 'Reload this page after ~30 seconds to see the new version.',
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /maintenance/update: ${err.message}`);
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'failed', executor: 'operator',
                outcome: `Maintenance update failed: ${err.message}`,
                payload: { action: 'update', tag, code: err.code },
            });
            const status = err.code === 'BUSY' ? 409 : 500;
            return res.status(status).json(errorBody(err.message));
        }
    });

    // ------------------------------------------------------------------
    // POST /maintenance/chain-resync    owner
    //
    // Body: { chainId: "mainchain", confirm: "mainchain" }
    //
    // confirm must equal chainId — the frontend types-to-confirm gate.
    // We re-check server-side so a CSRF-style request without the
    // typed value can't bypass the safety check.
    // ------------------------------------------------------------------
    router.post('/chain-resync', limit('admin'), requireOwner, async (req, res) => {
        const { value, details } = RequestSchemas.validateBody(
            RequestSchemas.maintenanceChainResyncBody, req.body,
        );
        if (details) {
            return res.status(400).json({
                ...errorBody('Invalid request body.'),
                details,
            });
        }
        const wallet = readActorWallet(req);
        const { chainId, confirm } = value;
        if (confirm !== chainId) {
            return res.status(400).json(errorBody(
                'Confirmation does not match chain name.',
            ));
        }
        try {
            const r = await MaintenanceManager.chainResync({
                chainId,
                log: extensionHandle.log,
                // beta.3.42 — extensionHandle lets the resync reach into
                // enm_setup_state and reset current_step='bootstrap' so
                // the wizard reappears for the operator to choose
                // bootstrap-vs-genesis again. Without this, the resync
                // just silently wipes data and the dashboard sits at
                // "syncing from 0" forever.
                extensionHandle,
            });
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'executed', executor: 'operator',
                outcome: `Chain resync ${chainId}: wiped ${r.removedPaths.length} path(s); keystore backup=${r.keystoreBackup || 'none'}`,
                payload: r,
            });
            return res.json(successBody({
                action: 'chain-resync',
                chainId,
                removedPaths: r.removedPaths,
                keystoreBackup: r.keystoreBackup,
                message: 'Chain data wiped. Re-sync started — may take 4–8 hours.',
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /maintenance/chain-resync: ${err.message}`);
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'failed', executor: 'operator',
                outcome: `Chain resync ${chainId} failed: ${err.message}`,
                payload: { action: 'chain-resync', chainId, code: err.code },
            });
            const status = err.code === 'BUSY' ? 409
                : err.code === 'NO_CHAIN' ? 404 : 500;
            return res.status(status).json(errorBody(err.message));
        }
    });

    // ------------------------------------------------------------------
    // POST /maintenance/uninstall    owner
    //
    // Body: { confirm: "remove" }
    //
    // Detaches a script that DELETEs the extension via pc2-node
    // (purge=false), leaving /var/lib/pc2/data/extensions/elastos-
    // node-manager intact for recovery.
    // ------------------------------------------------------------------
    router.post('/uninstall', limit('admin'), requireOwner, async (req, res) => {
        const { value, details } = RequestSchemas.validateBody(
            RequestSchemas.maintenanceUninstallBody, req.body,
        );
        if (details) {
            return res.status(400).json({
                ...errorBody('Invalid request body.'),
                details,
            });
        }
        const wallet = readActorWallet(req);
        if (value.confirm !== 'remove') {
            return res.status(400).json(errorBody(
                'Confirmation must be the word "remove".',
            ));
        }
        try {
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'executed', executor: 'operator',
                outcome: 'Maintenance uninstall queued (data dir preserved)',
                payload: { action: 'uninstall' },
            });
            const r = await MaintenanceManager.uninstall({ log: extensionHandle.log });
            return res.json(successBody({
                queued: true,
                logFile: r.logFile,
                message: 'Uninstall queued. ENM extension will be removed in a few seconds. '
                    + 'Your chain data + keystore stay on disk at '
                    + '/var/lib/pc2/data/extensions/elastos-node-manager for future recovery.',
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /maintenance/uninstall: ${err.message}`);
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'failed', executor: 'operator',
                outcome: `Maintenance uninstall failed: ${err.message}`,
                payload: { action: 'uninstall', code: err.code },
            });
            const status = err.code === 'BUSY' ? 409 : 500;
            return res.status(status).json(errorBody(err.message));
        }
    });

    // ------------------------------------------------------------------
    // POST /maintenance/nuke    owner
    //
    // Body: { confirm: "WIPE EVERYTHING" }     case-sensitive
    //
    // Detaches a script that DELETEs the extension (purge=true) and
    // rm -rf the data dir. Operator loses keystore. Extra confirm-
    // word friction reflects the impact.
    // ------------------------------------------------------------------
    router.post('/nuke', limit('admin'), requireOwner, async (req, res) => {
        const { value, details } = RequestSchemas.validateBody(
            RequestSchemas.maintenanceNukeBody, req.body,
        );
        if (details) {
            return res.status(400).json({
                ...errorBody('Invalid request body.'),
                details,
            });
        }
        const wallet = readActorWallet(req);
        // Case-sensitive — "wipe everything" / "WIPE everything" both
        // bounce. Operator must type the exact gate string.
        if (value.confirm !== 'WIPE EVERYTHING') {
            return res.status(400).json(errorBody(
                'Confirmation must be exactly "WIPE EVERYTHING" (uppercase).',
            ));
        }
        try {
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'executed', executor: 'operator',
                outcome: 'Maintenance NUKE queued — extension uninstall + data wipe',
                payload: { action: 'nuke' },
            });
            const r = await MaintenanceManager.nuke({ log: extensionHandle.log });
            return res.json(successBody({
                queued: true,
                logFile: r.logFile,
                message: 'Nuclear wipe queued. ENM will be removed and ALL data destroyed '
                    + '(including the keystore) in a few seconds. There is no undo.',
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /maintenance/nuke: ${err.message}`);
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                ruleId: null, tier: 'CRITICAL-INFO',
                decision: 'failed', executor: 'operator',
                outcome: `Maintenance nuke failed: ${err.message}`,
                payload: { action: 'nuke', code: err.code },
            });
            const status = err.code === 'BUSY' ? 409 : 500;
            return res.status(status).json(errorBody(err.message));
        }
    });

    return router;
}

/**
 * Best-effort audit write. The audit row is high-value (operator
 * accountability for destructive actions) but a failed write must not
 * block the action — the operator already authorised, and the audit
 * loss is preferable to a 500 that leaves the operator unsure.
 *
 * @param {() => object} getDb
 * @param {object} log
 * @param {object} entry
 */
async function _audit(getDb, log, entry) {
    try {
        const db = getDb();
        await AuditLog.append(db, {
            walletAddress: entry.walletAddress || '0x0',
            chainId: 'mainchain',
            ruleId: entry.ruleId,
            tier: entry.tier,
            decision: entry.decision,
            executor: entry.executor,
            outcome: entry.outcome,
            payload: entry.payload,
        });
    } catch (err) {
        log.warn(`${ENM_LOG_PREFIX} maintenance audit append failed: ${err.message}`);
    }
}

module.exports = { build, CURRENT_VERSION };
