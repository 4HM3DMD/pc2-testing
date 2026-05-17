/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/snapshots.js — Phase 7 Layer 4 visibility + manual triggers.
 *
 *   GET    /api/enm/snapshots/:chainId           list snapshots (read)
 *   POST   /api/enm/snapshots/:chainId           take a snapshot now (owner)
 *   POST   /api/enm/snapshots/:chainId/restore   restore most-recent  (owner, double-confirm)
 *
 * Backs the Settings → Security "Auto-heal" card so the operator can see
 * snapshots being taken (without grepping logs) and can manually trigger
 * a snapshot or restore when needed.
 *
 * The autonomous path (EnmStateSnapshot service + F22 detection +
 * SelfHealingEngine._executeStateRestore) is independent of these
 * routes; they just expose the same primitives to the dashboard.
 *
 * Auth: requireOwner on the two POSTs. Read endpoint allows any
 * authenticated request (mirrors GET /audit's relaxed gate).
 */

'use strict';

const express = require('express');
const path = require('node:path');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../auth/OwnerCheckMiddleware');
const ChainRegistry = require('../services/ChainRegistry');
const ConfigStore = require('../services/ConfigStore');
const DataDir = require('../services/DataDir');

/**
 * @param {object} deps
 * @param {object} deps.extensionHandle
 * @returns {import('express').Router}
 */
function build(deps) {
    if (!deps || !deps.extensionHandle) {
        throw new TypeError('routes/snapshots.build: { extensionHandle } required');
    }
    const { extensionHandle } = deps;
    const router = express.Router();

    /**
     * GET /:chainId
     * Returns the current snapshot inventory + service config for the chain.
     * Shape:
     *   {
     *     enabled: boolean,             // cfg.global.stateSnapshot.enabled
     *     intervalSec: number,
     *     retention: number,
     *     autoRestore: boolean,
     *     snapshots: [{ name, takenAt, sizeBytes, files: [...] }],
     *     count: number,
     *     latest: { takenAt, sizeBytes, name } | null,
     *     totalSizeBytes: number,
     *   }
     */
    router.get('/:chainId', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        const chainId = String(req.params.chainId || '').trim();
        if (!/^[a-z0-9-]+$/.test(chainId)) {
            return res.status(400).json(errorBody('Invalid chainId.'));
        }
        try {
            const stateSnapshot = ChainRegistry._stateSnapshot;
            const cfg = await ConfigStore.load();
            const snapshotCfg = (cfg && cfg.global && cfg.global.stateSnapshot) || {};
            // List from disk via the service's own listSnapshots. If the
            // service isn't running (config disabled, or boot init failed)
            // we can still read the directory directly via a one-off list.
            let snapshots = [];
            if (stateSnapshot && typeof stateSnapshot.listSnapshots === 'function') {
                snapshots = await stateSnapshot.listSnapshots(chainId).catch(() => []);
            }
            const latest = snapshots.length > 0
                ? {
                    name: snapshots[0].name,
                    takenAt: snapshots[0].takenAt,
                    sizeBytes: (snapshots[0].meta && snapshots[0].meta.totalBytes) || 0,
                }
                : null;
            const totalSizeBytes = snapshots.reduce((acc, s) => {
                const sz = (s.meta && s.meta.totalBytes) || 0;
                return acc + sz;
            }, 0);
            return res.json(successBody({
                enabled: snapshotCfg.enabled !== false,  // default true
                intervalSec: snapshotCfg.intervalSec || 3600,
                retention: snapshotCfg.retention || 24,
                autoRestore: snapshotCfg.autoRestore !== false,
                count: snapshots.length,
                latest,
                totalSizeBytes,
                serviceRunning: !!stateSnapshot,
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} GET /snapshots/${chainId}: ${err.message}`,
            );
            return res.status(500).json(errorBody('Failed to list snapshots.'));
        }
    });

    /**
     * POST /:chainId
     * Trigger a take-now. The autonomous service will continue its
     * regular cadence; this is just an out-of-band capture (e.g.,
     * operator about to attempt a risky maintenance task and wants
     * a fresh backup first).
     *
     * Skips with 409 if the chain isn't in a snapshottable state
     * (alive + RPC reachable + uptime>=5min).
     */
    router.post('/:chainId', limit('admin'), requireOwner, async (req, res) => {
        const chainId = String(req.params.chainId || '').trim();
        if (!/^[a-z0-9-]+$/.test(chainId)) {
            return res.status(400).json(errorBody('Invalid chainId.'));
        }
        const stateSnapshot = ChainRegistry._stateSnapshot;
        if (!stateSnapshot || typeof stateSnapshot.takeSnapshot !== 'function') {
            return res.status(503).json(errorBody(
                'Snapshot service is not running. Check cfg.global.stateSnapshot.enabled.',
            ));
        }
        try {
            const result = await stateSnapshot.takeSnapshot(chainId);
            if (result && result.skipped) {
                // Operator-actionable precondition failure — return 409.
                return res.status(409).json(errorBody(
                    `Snapshot skipped: ${result.reason}. `
                    + 'Ensure chain is alive, RPC reachable, and uptime ≥ 5 min.',
                ));
            }
            return res.json(successBody(result));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} POST /snapshots/${chainId}: ${err.message}`,
            );
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * POST /:chainId/restore
     * Restore the most-recent snapshot. Stops the chain, copies snapshot
     * files over live state, restarts. Same flow as the autonomous F22
     * path — operator can use this to manually trigger when they suspect
     * a state desync but F22 hasn't fired yet.
     *
     * DESTRUCTIVE — requires explicit `?confirm=I-want-to-restore-state`
     * to proceed (mirrors the chain-rollback safety gate from beta.3.61).
     */
    router.post('/:chainId/restore', limit('admin'), requireOwner, async (req, res) => {
        const chainId = String(req.params.chainId || '').trim();
        if (!/^[a-z0-9-]+$/.test(chainId)) {
            return res.status(400).json(errorBody('Invalid chainId.'));
        }
        const confirm = (req.query && req.query.confirm) || '';
        if (confirm !== 'I-want-to-restore-state') {
            return res.status(412).json(errorBody(
                'Restore is destructive — overwrites live state with snapshot. '
                + 'Pass ?confirm=I-want-to-restore-state to proceed.',
            ));
        }
        const stateSnapshot = ChainRegistry._stateSnapshot;
        if (!stateSnapshot || typeof stateSnapshot.restore !== 'function') {
            return res.status(503).json(errorBody(
                'Snapshot service is not running.',
            ));
        }
        try {
            // Reuse the engine's orchestration so we get the same
            // stop → restore → start → verify flow as F22, including
            // the 6h cooldown protection.
            let adapter;
            try {
                adapter = ChainRegistry.getAdapter(chainId);
            } catch (err) {
                return res.status(404).json(errorBody(`Unknown chain "${chainId}".`));
            }
            const cfg = await ConfigStore.load();
            const chainCfg = cfg && cfg.chains && cfg.chains[chainId];
            if (!chainCfg) {
                return res.status(409).json(errorBody(
                    'Chain not configured. Cannot restore.',
                ));
            }
            const engine = ChainRegistry.getEngine();
            if (!engine || typeof engine._executeStateRestore !== 'function') {
                // Fall back to direct stateSnapshot.restore if the engine
                // isn't wired (shouldn't happen post-3.63, defensive).
                await adapter.stop().catch(() => { /* tolerate */ });
                const result = await stateSnapshot.restore(chainId);
                await adapter.start(chainCfg);
                return res.json(successBody({
                    ...result,
                    note: 'Restored via direct path (engine unavailable). Verify manually.',
                }));
            }
            const outcome = await engine._executeStateRestore(chainId, chainCfg);
            return res.json(successBody({
                ok: true,
                outcome,
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} POST /snapshots/${chainId}/restore: ${err.message}`,
            );
            // Classify common precondition failures.
            const code = /cooldown/i.test(err.message) ? 429
                : /no snapshots/i.test(err.message) ? 409
                : 500;
            return res.status(code).json(errorBody(err.message));
        }
    });

    return router;
}

module.exports = { build };
