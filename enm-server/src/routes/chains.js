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

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../auth/OwnerCheckMiddleware');
const ChainRegistry = require('../services/ChainRegistry');
const ConfigStore = require('../services/ConfigStore');
const HostConflictScanner = require('../services/HostConflictScanner');
const Diagnostics = require('../services/Diagnostics');
const LogCompactor = require('../services/LogCompactor');
const ChainState = require('../services/ChainState');
const EnmBposService = require('../services/EnmBposService');
const { decrypt } = require('../services/EnmEncryption');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { chainDir, pidFilePath } = require('../services/DataDir');

/** Promise-based sleep used to give async actions time to take effect
 *  before re-checking process state. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

            // Pull live RPC + uptime when the chain is alive. The chain-card
            // UI needs height/peers/uptime to render real values; without
            // this they fall back to "—" even though the chain is healthy.
            // Each lookup is in its own try/catch so a single RPC blip
            // doesn't take down the whole status response.
            let height = null, peers = null, uptimeSec = null;
            if (status && status.alive) {
                // Uptime — read from the meta sidecar's startedAt.
                try {
                    const m = JSON.parse(
                        require('fs').readFileSync(require('../services/processUtils').metaFilePath(adapter.chainId), 'utf8'),
                    );
                    if (m && typeof m.startedAt === 'number') {
                        uptimeSec = Math.max(0, Math.floor((Date.now() - m.startedAt) / 1000));
                    }
                } catch (_) { /* meta missing; uptime stays null */ }

                // Height + peers — single RPC client, parallel calls. If
                // RPC isn't ready yet (chain still booting), both fail
                // and the response has nulls — which the UI renders as
                // "—" honestly.
                try {
                    const rpc = adapter.rpcClient(chainCfg);
                    const results = await Promise.allSettled([
                        rpc.getblockcount(),
                        rpc.getconnectioncount(),
                    ]);
                    if (results[0].status === 'fulfilled') {
                        const v = results[0].value;
                        height = (typeof v === 'number') ? v : (v && v.result) || null;
                    }
                    if (results[1].status === 'fulfilled') {
                        const v = results[1].value;
                        peers = (typeof v === 'number') ? v : (v && v.result) || null;
                    }
                } catch (_) { /* RPC unreachable; height/peers stay null */ }
            }

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
                // Operator intent (from setup conversation) — distinct from
                // producer.enabled (registration status). The hero card uses
                // this to label the role correctly even before on-chain
                // registration is complete.
                enableArbiter: !!(chainCfg.dpos && chainCfg.dpos.enableArbiter),
                hasKeystore: !!(chainCfg.dpos && chainCfg.dpos.keystorePasswordEncrypted),
                // Live values — null when chain is dead OR RPC isn't ready
                // yet. Frontend renders null as "—" instead of fabricating.
                height,
                peers,
                uptimeSec,
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
            // Verify the action took effect — adapter.start may return a
            // pid but the child can die immediately (binary missing,
            // config invalid, port collision after pre-flight). Wait
            // briefly + recheck so the operator gets honest feedback
            // instead of a "started" response on a dead chain.
            await sleep(1500);
            const liveCheck = ChainRegistry.getProcessService().statusSync(adapter.chainId);
            if (!liveCheck.alive) {
                return res.status(500).json(errorBody(
                    'Chain spawned but exited within 1.5s. Check logs (Settings → Show technical details → Logs).',
                ));
            }
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
            // Verify the chain actually stopped. Some failure modes (kill
            // signal queued, child unresponsive) will return success from
            // adapter.stop but leave the process alive.
            await sleep(800);
            const liveCheck = ChainRegistry.getProcessService().statusSync(adapter.chainId);
            if (liveCheck.alive) {
                return res.status(500).json(errorBody(
                    'Stop command issued but chain is still alive. May be hung — try Restart, or kill the PID manually.',
                ));
            }
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
            // Enrich the snapshot with two reliable signals SyncTracker
            // doesn't currently surface:
            //
            //   networkHeight — peers report their tip height in
            //                   getpeerinfo[*].height. Max of those is a
            //                   far better network reference than guessing
            //                   from local-height drift. Available within
            //                   ~30s of chain start (handshake completion).
            //
            //   lastBlockTime — the latest local block's timestamp. If it's
            //                   within 5 min of now, the chain is fully
            //                   synced regardless of what peers report.
            //                   This is what wallets use to determine
            //                   "synced" and works even with 0 peers.
            //
            //   synced        — derived: lastBlockTime within 5 min of now,
            //                   OR blocksBehind === 0 with networkHeight
            //                   known.
            try {
                const status = ChainRegistry.getProcessService().statusSync(adapter.chainId);
                snapshot.alive = !!(status && status.alive);
                snapshot.uptimeSec = null;
                snapshot.synced = false;
                snapshot.lastBlockTime = null;
                snapshot.peers = null;

                if (!snapshot.alive) {
                    // Chain not running — null any zombie buffer fields and
                    // mark stale. UI hides the panel entirely.
                    snapshot.velocityBpm = null;
                    snapshot.etaSec = null;
                    snapshot.percent = null;
                    snapshot.networkHeight = null;
                    snapshot.stale = true;
                } else {
                    // Live chain — pull the truthful signals over RPC.
                    const cfgChain = cfg.chains[adapter.chainId];
                    if (cfgChain) {
                        try {
                            const rpc = adapter.rpcClient(cfgChain);
                            const [peerInfo, peerCount, bestHash, blockCount] = await Promise.allSettled([
                                rpc.getpeerinfo(),
                                rpc.getconnectioncount(),
                                rpc.getbestblockhash(),
                                rpc.getblockcount(),
                            ]);

                            // Fall back to RPC for localHeight when
                            // SyncTracker hasn't sampled yet (first ~30s
                            // after chain start). Without this the chain-
                            // card hides the entire sync panel because
                            // its render guard requires localHeight.
                            if (snapshot.localHeight == null && blockCount.status === 'fulfilled') {
                                const v = blockCount.value;
                                const h = (typeof v === 'number') ? v : (v && v.result);
                                if (typeof h === 'number') { snapshot.localHeight = h; }
                            }

                            // peers count
                            if (peerCount.status === 'fulfilled') {
                                const v = peerCount.value;
                                snapshot.peers = (typeof v === 'number') ? v : (v && v.result) || 0;
                            }

                            // network height = max of peers' reported heights.
                            // Without this we can't compute a real %, and the
                            // UI ends up showing "Connecting to peers" forever.
                            if (peerInfo.status === 'fulfilled') {
                                const list = peerInfo.value && peerInfo.value.result
                                    ? peerInfo.value.result
                                    : peerInfo.value;
                                if (Array.isArray(list)) {
                                    let maxH = null;
                                    for (const p of list) {
                                        if (p && typeof p.height === 'number' && (maxH == null || p.height > maxH)) {
                                            maxH = p.height;
                                        }
                                    }
                                    if (maxH != null && (snapshot.networkHeight == null || maxH > snapshot.networkHeight)) {
                                        snapshot.networkHeight = maxH;
                                    }
                                }
                            }

                            // last block timestamp → "synced" detection.
                            if (bestHash.status === 'fulfilled') {
                                const hash = bestHash.value && bestHash.value.result
                                    ? bestHash.value.result
                                    : bestHash.value;
                                if (typeof hash === 'string' && hash.length > 0) {
                                    try {
                                        const headerResp = await rpc.getblockheader(hash, 2);
                                        const header = headerResp && headerResp.result
                                            ? headerResp.result : headerResp;
                                        if (header && typeof header.time === 'number') {
                                            snapshot.lastBlockTime = header.time;
                                            const ageSec = Math.floor(Date.now() / 1000) - header.time;
                                            // Elastos mainchain target is ~120s/block. We allow
                                            // 5 minutes of slack for peer-propagation jitter
                                            // before declaring "not synced".
                                            snapshot.synced = (ageSec >= 0 && ageSec <= 5 * 60);
                                        }
                                    } catch (_) { /* getblockheader may fail on early boot */ }
                                }
                            }
                        } catch (_) { /* RPC failed entirely; leave snapshot as-is */ }
                    }

                    // Recompute progress now that we may have a fresh
                    // networkHeight — SyncTracker computed an early one
                    // with a possibly null reference.
                    if (snapshot.networkHeight != null && snapshot.localHeight != null) {
                        snapshot.blocksBehind = Math.max(0, snapshot.networkHeight - snapshot.localHeight);
                        const denom = Math.max(snapshot.networkHeight, 1);
                        snapshot.percent = Math.max(0, Math.min(100,
                            (snapshot.localHeight / denom) * 100));
                    }
                    // Synced overrides everything else — even if we can't
                    // resolve networkHeight, a fresh block timestamp says
                    // we're caught up.
                    if (snapshot.synced) {
                        snapshot.percent = 100;
                        snapshot.blocksBehind = 0;
                        snapshot.etaSec = 0;
                        // velocity isn't meaningful when synced (no catch-up)
                        snapshot.velocityBpm = null;
                    } else if (snapshot.networkHeight == null) {
                        // Live chain, peers may exist, but we can't compute
                        // a meaningful velocity yet. Suppress so the UI
                        // doesn't show stale numbers.
                        snapshot.velocityBpm = null;
                        snapshot.etaSec = null;
                    }

                    // Uptime for the freshly-started banner the UI shows.
                    try {
                        const m = JSON.parse(
                            require('fs').readFileSync(
                                require('../services/processUtils').metaFilePath(adapter.chainId), 'utf8',
                            ),
                        );
                        if (m && typeof m.startedAt === 'number') {
                            snapshot.uptimeSec = Math.max(0, Math.floor((Date.now() - m.startedAt) / 1000));
                        }
                    } catch (_) { /* meta missing */ }
                }
            } catch (_) { /* status read failed; leave snapshot as-is */ }

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

    // Re-download the latest binary in place. Mirrors node.sh's
    // `ela_update` (build/skeleton/node.sh:1173). Caller decides whether
    // to stop/start the chain around it; this route just kicks off the
    // download. Progress flows on the existing SSE topic
    // `setup:install:<chainId>` so the wizard's progress UI works here too.
    router.post('/:chainId/update', limit('admin'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            // Gate: require chain to be stopped before re-downloading the
            // binary. Replacing a binary while ela has it open is unsafe
            // (file descriptor caching, partial reads, signed-section
            // mismatches) — the operator's flow should be Stop → Update
            // → Start. Front end can still bypass by stopping first.
            const status = ChainRegistry.getProcessService().statusSync(adapter.chainId);
            if (status && status.alive) {
                return res.status(409).json(errorBody(
                    'Stop the chain before updating the binary. Click Stop on the Mainchain card, wait for the badge to change to "Stopped", then run Update again.',
                ));
            }
            const downloader = ChainRegistry.getBinaryDownloader();
            if (!downloader) {
                return res.status(503).json(errorBody('Binary downloader is not available.'));
            }
            const result = await downloader.start(adapter.chainId);
            return res.json(successBody({
                alreadyRunning: result.alreadyRunning,
                status: result.status,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/update: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // ela_activate_bpos — bring an Inactive producer back to Active.
    // The keystore + password live on this server (server-side signing
    // is allowed; only browser-wallet signing is forbidden per
    // Architectural Invariant #2).
    router.post('/:chainId/bpos/activate', limit('admin'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const chainId = adapter.chainId;
            if (chainId !== 'mainchain') {
                return res.status(400).json(errorBody(
                    'BPoS lifecycle is only defined on the ELA mainchain.',
                ));
            }
            const snapshot = await ChainState.snapshot(chainId);
            if (!snapshot.cliPath) {
                return res.status(400).json(errorBody(
                    'ela-cli not yet installed. Open Settings → Show technical details → Status and click Update binary first.',
                ));
            }
            if (!snapshot.keystorePresent) {
                return res.status(400).json(errorBody(
                    'No keystore on disk — generate one via the setup conversation first.',
                ));
            }
            // Gate: chain must be alive AND fully synced before submitting
            // an activate transaction. An unsynced node has stale producer
            // state, and the chain may reject the tx with code 43001.
            const procStatus = ChainRegistry.getProcessService().statusSync(chainId);
            if (!procStatus || !procStatus.alive) {
                return res.status(409).json(errorBody(
                    'Chain must be running before reactivating. Start the chain and wait for it to fully sync first.',
                ));
            }
            try {
                const rpc = adapter.rpcClient(cfg.chains[chainId]);
                const bestHashResp = await rpc.getbestblockhash();
                const bestHash = bestHashResp && bestHashResp.result ? bestHashResp.result : bestHashResp;
                if (typeof bestHash === 'string' && bestHash.length > 0) {
                    const headerResp = await rpc.getblockheader(bestHash, 2);
                    const header = headerResp && headerResp.result ? headerResp.result : headerResp;
                    if (header && typeof header.time === 'number') {
                        const ageSec = Math.floor(Date.now() / 1000) - header.time;
                        // Same 5-min slack used by the /sync route's synced detection.
                        if (ageSec > 5 * 60) {
                            return res.status(409).json(errorBody(
                                `Chain is not yet fully synced (last block is ${Math.floor(ageSec / 60)} min old). Reactivation transactions need a synced node — wait until the dashboard shows "Fully synced", then try again.`,
                            ));
                        }
                    }
                }
            } catch (rpcErr) {
                // Can't confirm sync — refuse rather than risk a wasted tx.
                return res.status(503).json(errorBody(
                    `Cannot verify sync status (RPC error: ${rpcErr.message}). Refusing to submit reactivation while chain state is unclear.`,
                ));
            }
            const cfg = await ConfigStore.load();
            const chainCfg = cfg.chains && cfg.chains[chainId];
            const envelope = chainCfg && chainCfg.dpos && chainCfg.dpos.keystorePasswordEncrypted;
            if (!envelope) {
                return res.status(400).json(errorBody(
                    'Keystore password not stashed — re-import the keystore via Reinstall my node.',
                ));
            }
            let password;
            try { password = decrypt(envelope); }
            catch (err) {
                return res.status(500).json(errorBody(
                    `Cannot decrypt keystore password: ${err.message}.`,
                ));
            }

            const bpos = new EnmBposService({ logger: extensionHandle.log });
            const result = await bpos.activate({
                chainId,
                cliPath: snapshot.cliPath,
                publicKey: snapshot.publicKey,
                password,
            });

            // Don't keep the plaintext on the response or in any cache.
            password = null;

            if (!result.ok) {
                extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} ${chainId} BPoS activate rejected by chain: ${result.error}`,
                );
                return res.status(400).json(errorBody(result.error, {
                    buildOutput: result.buildOutput,
                    sendOutput: result.sendOutput,
                }));
            }
            return res.json(successBody({
                buildOutput: result.buildOutput,
                sendOutput: result.sendOutput,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/bpos/activate: ${err.message}`);
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
 * @returns {import('../services/ChainAdapter')|null}
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
 * @param {(rpc: import('../services/EnmRpcClient').EnmRpcClient) => Promise<object>} fn
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
