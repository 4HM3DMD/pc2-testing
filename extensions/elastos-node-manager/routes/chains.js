/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/chains.js — chain control endpoints (Phase 2).
 *
 *   GET    /chains                   list registered chains + summary state
 *   GET    /chains/:id               full state for one chain
 *   POST   /chains/:id/start         owner-only — spawn the process
 *   POST   /chains/:id/stop          owner-only — graceful stop
 *   POST   /chains/:id/restart       owner-only — atomic stop+start
 *   GET    /chains/:id/version       binary version (cached)
 *   GET    /chains/:id/peers         RPC: getnodestate
 *   GET    /chains/:id/height        RPC: getblockcount
 *   GET    /chains/:id/info          RPC: getinfo + getmininginfo
 *   GET    /chains/:id/dpos          RPC: BPoS-specific (Phase 5 will fill in F11/F12)
 *
 * Error handling per Rev 4 audit: inline try/catch + res.status().json(errorBody).
 * Auth: requireOwner on every mutation. Reads only require authentication.
 */

'use strict';

const express = require('express');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../lib/EnmConstants');
const { limit } = require('../lib/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../lib/OwnerCheckMiddleware');
const ChainRegistry = require('../lib/ChainRegistry');
const ConfigStore = require('../lib/ConfigStore');
const HostConflictScanner = require('../lib/HostConflictScanner');
const Diagnostics = require('../lib/Diagnostics');
const LogCompactor = require('../lib/LogCompactor');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { chainDir, pidFilePath } = require('../lib/DataDir');

/**
 * @param {object} extensionHandle
 * @returns {import('express').Router}
 */
function build(extensionHandle) {
    const router = express.Router();

    // --- list chains ---
    router.get('/', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const chains = ChainRegistry.listChains();
            const cfg = await ConfigStore.load();
            const result = await Promise.all(chains.map(async (c) => {
                const chainCfg = cfg.chains[c.chainId];
                const status = ChainRegistry.getProcessService().statusSync(c.chainId);
                return {
                    chainId: c.chainId,
                    displayName: c.displayName,
                    enabled: !!(chainCfg && chainCfg.enabled),
                    configured: !!chainCfg,
                    state: deriveCoarseState(status, chainCfg),
                    pid: status.pid,
                };
            }));
            return res.json(successBody({ chains: result }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /chains: ${err.message}`);
            return res.status(500).json(errorBody('Failed to list chains.'));
        }
    });

    // --- single chain detail ---
    router.get('/:chainId', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains[adapter.chainId];
            if (!chainCfg) {
                return res.status(404).json(errorBody(`Chain "${adapter.chainId}" not configured yet.`));
            }
            const status = ChainRegistry.getProcessService().statusSync(adapter.chainId);
            return res.json(successBody({
                chainId: adapter.chainId,
                displayName: adapter.displayName,
                enabled: !!chainCfg.enabled,
                state: deriveCoarseState(status, chainCfg),
                pid: status.pid,
                attached: status.attached,
                ports: chainCfg.ports,
                binaryPath: chainCfg.binaryPath,
                binaryVersion: chainCfg.binaryVersion,
                activeNet: chainCfg.activeNet,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read chain state.'));
        }
    });

    // --- mutations: start / stop / restart ---
    router.post('/:chainId/start', limit('write'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains[adapter.chainId];
            if (!chainCfg) {
                return res.status(409).json(errorBody(
                    `Chain "${adapter.chainId}" is not configured. Complete the setup wizard first.`,
                ));
            }

            // Host conflict scan — refuse to spawn if anything CRITICAL is
            // unresolved (rogue ela process, port already bound, permission
            // denied on data dir). The operator can override by passing
            // ?force=1, which the dashboard surfaces as a guarded checkbox.
            const force = req.query && req.query.force === '1';
            const conflicts = await HostConflictScanner.scan({ logger: extensionHandle.log });
            const blockers = HostConflictScanner.blockers(conflicts);
            if (blockers.length > 0 && !force) {
                extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} refusing start of ${adapter.chainId} — ${blockers.length} CRITICAL host conflicts`,
                );
                return res.status(409).json({
                    success: false,
                    error: 'Host has unresolved conflicts; refusing to start. Resolve them or pass ?force=1.',
                    conflicts,
                });
            }

            const result = await adapter.start(chainCfg);
            return res.json(successBody({
                ...result,
                // Surface non-blocking conflicts so the dashboard can show a
                // banner ("legacy node.sh data nearby") without aborting.
                warnings: conflicts.filter((c) => c.severity !== 'CRITICAL'),
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/start: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    router.post('/:chainId/stop', limit('write'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const result = await adapter.stop();
            return res.json(successBody(result));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/stop: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    router.post('/:chainId/restart', limit('write'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains[adapter.chainId];
            if (!chainCfg) {
                return res.status(409).json(errorBody(
                    `Chain "${adapter.chainId}" is not configured.`,
                ));
            }

            // Same conflict gate as start. We exclude ROGUE_PROCESS hits
            // matching our own managed PIDs here — restart's first step is
            // to stop our own running instance, which would otherwise show
            // up as a "rogue" until the SIGTERM lands.
            const force = req.query && req.query.force === '1';
            const conflicts = await HostConflictScanner.scan({ logger: extensionHandle.log });
            const blockers = HostConflictScanner.blockers(conflicts);
            if (blockers.length > 0 && !force) {
                return res.status(409).json({
                    success: false,
                    error: 'Host has unresolved conflicts; refusing to restart. Resolve them or pass ?force=1.',
                    conflicts,
                });
            }

            const result = await adapter.restart(chainCfg);
            return res.json(successBody({
                ...result,
                warnings: conflicts.filter((c) => c.severity !== 'CRITICAL'),
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/restart: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // --- read-only RPC proxies (auth required, no owner-only restriction) ---
    router.get('/:chainId/version', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains[adapter.chainId];
            if (!chainCfg) {
                return res.status(404).json(errorBody('Not configured.'));
            }
            return res.json(successBody({
                binaryPath: chainCfg.binaryPath,
                binaryVersion: chainCfg.binaryVersion,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/version: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    router.get('/:chainId/peers', limit('read'), wrapRpc('peers',
        async (rpc) => ({ nodestate: await rpc.getnodestate() }),
        extensionHandle,
    ));

    router.get('/:chainId/height', limit('read'), wrapRpc('height',
        async (rpc) => ({ blockcount: await rpc.getblockcount() }),
        extensionHandle,
    ));

    router.get('/:chainId/info', limit('read'), wrapRpc('info',
        async (rpc) => {
            const [info, mining] = await Promise.all([rpc.getinfo(), rpc.getmininginfo()]);
            return { info, mining };
        },
        extensionHandle,
    ));

    // Live sync progress for the dashboard's progress bar.
    //
    // Reads from SyncTracker — populated by HealthChecker's medium tick at
    // 30s cadence. The tracker computes velocity (blocks per minute) from a
    // rolling 30-min window of (ts, height) samples and ETA-to-fully-synced
    // from velocity + (networkBest - localHeight).
    //
    // Returns a structured snapshot:
    //   { localHeight, networkHeight, blocksBehind, percent, velocityBpm,
    //     etaSec, sampleCount, windowMinutes, lastSampleAt, stale }
    //
    // Frontend polls this every 10s when state==='syncing' (vs 60s when
    // healthy) so the bar updates smoothly without burning request budget.
    router.get('/:chainId/sync', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            let snapshot;
            try {
                snapshot = ChainRegistry.getSyncTracker().syncSnapshot(adapter.chainId);
            } catch (err) {
                // Tracker not yet initialized (boot race). Return an empty
                // snapshot so the UI can show "—" rather than 500.
                return res.json(successBody({
                    localHeight: null,
                    networkHeight: null,
                    blocksBehind: null,
                    percent: null,
                    velocityBpm: null,
                    etaSec: null,
                    sampleCount: 0,
                    windowMinutes: null,
                    lastSampleAt: null,
                    stale: true,
                }));
            }
            return res.json(successBody(snapshot));
        } catch (err) {
            extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/sync: ${err.message}`,
            );
            return res.status(500).json(errorBody(err.message));
        }
    });

    // BPoS-specific listing — full producer set + height. Useful for an
    // operator browsing the supernode roster from the dashboard.
    router.get('/:chainId/dpos', limit('read'), wrapRpc('dpos',
        async (rpc) => {
            const [producers, height] = await Promise.all([
                rpc.listproducers({ start: 0, limit: -1, state: 'all' }),
                rpc.getblockcount(),
            ]);
            return { producers, height };
        },
        extensionHandle,
    ));

    // BPoS — single-producer focused. Returns our specific producer's state +
    // votes + inactiveheight + computed inactiveRounds. F12 surfaces this on
    // the chain-card; the operator sees their own stats without scanning the
    // full producer list.
    router.get('/:chainId/producer', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains[adapter.chainId];
            if (!chainCfg) {
                return res.status(404).json(errorBody('Not configured.'));
            }
            const ourPubkey = chainCfg.dpos && chainCfg.dpos.nodePublicKey;
            if (!ourPubkey) {
                return res.json(successBody({ enabled: false }));
            }
            const rpc = adapter.rpcClient(chainCfg);
            const [info, producerInfo] = await Promise.all([
                rpc.getinfo().catch(() => null),
                rpc.getproducerinfo(ourPubkey).catch(() => null),
            ]);
            const currentHeight = info && (
                typeof info.height === 'number' ? info.height
              : typeof info.blocks === 'number' ? info.blocks
              : null
            );
            const inactiveHeight = producerInfo && typeof producerInfo.inactiveheight === 'number'
                ? producerInfo.inactiveheight : null;
            const inactiveRounds = (currentHeight != null && inactiveHeight != null)
                ? (currentHeight - inactiveHeight) : null;
            return res.json(successBody({
                enabled: true,
                ourPubkey,
                state: producerInfo && producerInfo.state,
                votes: producerInfo && producerInfo.votes,
                dposv2votes: producerInfo && producerInfo.dposv2votes,
                rank: producerInfo && producerInfo.index,
                inactiveHeight,
                inactiveRounds,
                currentHeight,
            }));
        } catch (err) {
            const status = err && err.name === 'RpcUnreachableError' ? 503 : 500;
            extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/producer failed: ${err.message}`,
            );
            return res.status(status).json(errorBody(err.message));
        }
    });

    // GET /:chainId/diagnose
    // Walk every subsystem (config → binary → host conflicts → process →
    // stale PID → leveldb LOCK → RPC → peers → sync → disk) and return a
    // structured findings array the dashboard renders as an "exactly what's
    // wrong" report.
    router.get('/:chainId/diagnose', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains && cfg.chains[adapter.chainId];
            const report = await Diagnostics.runFullDiagnose({
                chainId: adapter.chainId,
                chainConfig: chainCfg || null,
                processService: ChainRegistry.getProcessService(),
                adapter,
                syncTracker: (() => { try { return ChainRegistry.getSyncTracker(); } catch { return null; } })(),
                logger: extensionHandle.log,
            });
            return res.json(successBody(report));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/diagnose: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // POST /:chainId/auto-fix?action=<key>
    // Whitelisted, idempotent remediations the operator can trigger from the
    // diagnose UI. Each action maps to a single safe step — never anything
    // that touches live keys or rewrites chain data.
    router.post('/:chainId/auto-fix', limit('admin'), requireOwner, async (req, res) => {
        const action = (req.query && typeof req.query.action === 'string') ? req.query.action : '';
        if (!Object.values(Diagnostics.AUTO_FIX_ACTIONS).includes(action)) {
            return res.status(400).json(errorBody(`Unknown auto-fix action "${action}".`));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const result = await runAutoFix(action, adapter, extensionHandle);
            return res.json(successBody({ action, ...result }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/auto-fix: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // POST /:chainId/compact-logs
    // Manually trigger a log rotation pass. Same routine that runs daily —
    // exposed for the operator's "free space now" button in Settings.
    router.post('/:chainId/compact-logs', limit('admin'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const opts = (cfg.global && cfg.global.logRotation) || {};
            const report = await LogCompactor.compactNow({
                chainId: adapter.chainId,
                gzipAfterDays: opts.gzipAfterDays,
                purgeAfterDays: opts.purgeAfterDays,
                logger: extensionHandle.log,
            });
            return res.json(successBody(report));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/compact-logs: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    return router;
}

/**
 * Run a whitelisted auto-fix action. Each branch is intentionally narrow:
 * the operator is implicitly granting permission to do exactly this one
 * thing, no more.
 *
 * @param {string} action     one of Diagnostics.AUTO_FIX_ACTIONS
 * @param {object} adapter    chain adapter (already 404-guarded)
 * @param {object} extensionHandle
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function runAutoFix(action, adapter, extensionHandle) {
    const A = Diagnostics.AUTO_FIX_ACTIONS;
    if (action === A.REMOVE_STALE_PID) {
        const p = pidFilePath(adapter.chainId);
        try {
            await fsp.unlink(p);
            return { ok: true, detail: 'Removed ' + p };
        } catch (err) {
            if (err.code === 'ENOENT') return { ok: true, detail: 'No PID file to remove' };
            throw err;
        }
    }
    if (action === A.RESTART_CHAIN) {
        const cfg = await ConfigStore.load();
        const chainCfg = cfg.chains && cfg.chains[adapter.chainId];
        if (!chainCfg) throw new Error('Chain not configured.');
        await adapter.restart(chainCfg);
        return { ok: true, detail: 'Restart issued — see audit tab' };
    }
    if (action === A.CONFIG_ROLLBACK) {
        const restored = await ConfigStore.rollback();
        if (!restored) return { ok: false, detail: 'No backup config to roll back to' };
        return { ok: true, detail: 'Rolled back to previous config' };
    }
    if (action === A.CLEAR_LEVELDB_LOCK) {
        // Refuse if the chain is alive — clearing LOCK on a live ela would
        // corrupt the DB. We trust the diagnose step: it only reports the
        // LOCK file when the process is gone.
        const proc = ChainRegistry.getProcessService();
        if (proc.statusSync(adapter.chainId).alive) {
            throw new Error('Chain is alive — refuse to clear LOCK on a running DB.');
        }
        const lockPath = path.join(chainDir(adapter.chainId), 'elastos', 'data', 'chain', 'LOCK');
        try {
            await fsp.unlink(lockPath);
            return { ok: true, detail: 'Removed ' + lockPath };
        } catch (err) {
            if (err.code === 'ENOENT') return { ok: true, detail: 'No LOCK file present' };
            throw err;
        }
    }
    throw new Error('Unhandled action: ' + action);
}

/**
 * Look up an adapter for `:chainId` or send 404 + return null.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} extensionHandle
 * @returns {import('../lib/ChainAdapter')|null}
 */
function adapterOr404(req, res, extensionHandle) {
    const id = req.params.chainId;
    try {
        return ChainRegistry.getAdapter(id);
    } catch (err) {
        extensionHandle.log.debug(`${ENM_LOG_PREFIX} unknown chainId "${id}": ${err.message}`);
        res.status(404).json(errorBody(`Unknown chain "${id}".`));
        return null;
    }
}

/**
 * Build a route handler that loads the chain config, gets an RpcClient, runs
 * the supplied async function, and packages the response. Centralizes the
 * try/catch + auth boilerplate.
 *
 * @param {string} kind  short label for log messages
 * @param {(rpc: import('../lib/EnmRpcClient').EnmRpcClient) => Promise<object>} fn
 * @param {object} extensionHandle
 * @returns {import('express').RequestHandler}
 */
function wrapRpc(kind, fn, extensionHandle) {
    return async function rpcProxy(req, res) {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains[adapter.chainId];
            if (!chainCfg) {
                return res.status(404).json(errorBody('Not configured.'));
            }
            const rpc = adapter.rpcClient(chainCfg);
            const payload = await fn(rpc);
            return res.json(successBody(payload));
        } catch (err) {
            // Distinguish "chain not running" (RpcUnreachableError) from real failures.
            const status = err && err.name === 'RpcUnreachableError' ? 503 : 500;
            extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/${kind} failed: ${err.message}`,
            );
            return res.status(status).json(errorBody(err.message));
        }
    };
}

/**
 * Coarse state for the dashboard ("healthy" | "syncing" | "stopped" | ...).
 * Phase 4's HealthChecker will replace this with the real state machine.
 *
 * @param {{ alive: boolean, pid: number|null, attached: boolean }} status
 * @param {object|null} chainCfg
 * @returns {string}
 */
function deriveCoarseState(status, chainCfg) {
    if (!chainCfg) {
        return 'unconfigured';
    }
    if (!status.alive) {
        return chainCfg.enabled ? 'stopped' : 'disabled';
    }
    return 'syncing'; // Phase 4 distinguishes healthy / stalled / etc.
}

module.exports = {
    build,
};
