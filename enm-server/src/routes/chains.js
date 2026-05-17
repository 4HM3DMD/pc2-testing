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

            // alpha.14/.15 — synced detection. The truthful signal on
            // ela mainchain is EITHER:
            //   (a) the best block's timestamp is within ~5 min of now
            //       (wallets use this heuristic), OR
            //   (b) our local height equals or exceeds the network's best
            //       height per peers' reported tips (transient "ahead of
            //       peers" by 1 also counts as synced — we just mined or
            //       received a block they haven't propagated yet).
            //
            // alpha.14 only checked (a), which left chains stuck on
            // "syncing" during slow-block periods even when fully caught
            // up. alpha.15 adds (b) by also calling getnodestate for
            // peers' max height.
            let synced = false;
            let lastBlockTime = null;
            let networkHeight = null;
            let producerState = null;
            // 0.2.0-alpha.7 — peer-quality summary surfaced for the chain-card
            // hover panel. Populated inside the synced/at-tip neighbors walk
            // below so we don't make a second `getnodestate` RPC for it.
            let peerSummary = null;
            if (status && status.alive && height != null) {
                try {
                    const rpc = adapter.rpcClient(chainCfg);

                    // Parallel: best-block header (for ageSec) + node-state (for peers' max height).
                    const [bestHashRes, nodeStateRes] = await Promise.allSettled([
                        rpc.getbestblockhash(),
                        rpc.getnodestate(),
                    ]);

                    // (a) Recency check via block timestamp.
                    let recentEnough = false;
                    if (bestHashRes.status === 'fulfilled') {
                        const hash = bestHashRes.value && bestHashRes.value.result
                            ? bestHashRes.value.result : bestHashRes.value;
                        if (typeof hash === 'string' && hash.length > 0) {
                            try {
                                const headerResp = await rpc.getblockheader(hash, 2);
                                const header = headerResp && headerResp.result
                                    ? headerResp.result : headerResp;
                                if (header && typeof header.time === 'number') {
                                    lastBlockTime = header.time;
                                    const ageSec = Math.floor(Date.now() / 1000) - header.time;
                                    recentEnough = (ageSec >= 0 && ageSec <= 5 * 60);
                                }
                            } catch (_) { /* header lookup failed; recencyEnough stays false */ }
                        }
                    }

                    // (b) Network-tip check via peers' max height.
                    // 0.2.0-alpha.7 — also extracts peer-quality fields
                    // (improvement #12). ENM already fetched this data
                    // for the at-tip check; the parity audit flagged that
                    // we throw it away. Latency/version/offset are now
                    // surfaced so the chain card can show a hover panel.
                    let atTipOrAhead = false;
                    if (nodeStateRes.status === 'fulfilled') {
                        const v = nodeStateRes.value;
                        const ns = v && v.result ? v.result : v;
                        const neighbors = ns && Array.isArray(ns.Neighbors) ? ns.Neighbors
                            : ns && Array.isArray(ns.neighbors) ? ns.neighbors : null;
                        if (Array.isArray(neighbors)) {
                            let maxH = null;
                            let latencySum = 0;
                            let latencyCount = 0;
                            const versionCounts = Object.create(null);
                            let maxAbsOffsetMs = 0;
                            // 0.2.0-beta.3.7 — collect per-peer rows for the
                            // chain-card peer popover (phase-03 .peer-pop).
                            // Pre-beta.3.7 the neighbors array was dropped
                            // after aggregation; now we keep a slim summary
                            // (≤ 50 rows) the frontend can render directly.
                            const neighborRows = [];
                            let inboundCount = 0;
                            let outboundCount = 0;
                            for (const n of neighbors) {
                                if (!n || typeof n !== 'object') continue;
                                const h = typeof n.lastblock === 'number' ? n.lastblock
                                        : typeof n.startingheight === 'number' ? n.startingheight
                                        : typeof n.Height === 'number' ? n.Height
                                        : typeof n.height === 'number' ? n.height
                                        : null;
                                if (h != null && (maxH == null || h > maxH)) maxH = h;

                                // Last-ping in microseconds (ela's wire field). Zero or
                                // negative = no pong received; skip from the average.
                                const ping = typeof n.lastpingmicros === 'number' ? n.lastpingmicros
                                           : typeof n.LastPingMicros === 'number' ? n.LastPingMicros
                                           : null;
                                const pingMs = (ping != null && ping > 0) ? Math.round(ping / 1000) : null;
                                if (pingMs != null) {
                                    latencySum += pingMs;
                                    latencyCount += 1;
                                }

                                // Peer NodeVersion / user-agent string. Pre-`getnodestate`
                                // strip the wire user-agent, so this only reads what the
                                // RPC surfaces today — often just the protocol-version
                                // integer (e.g. "20000", "80000"). Still useful for
                                // detecting fleet drift across major protocol bumps.
                                const ver = typeof n.nodeversion === 'string' ? n.nodeversion
                                          : typeof n.NodeVersion === 'string' ? n.NodeVersion
                                          : typeof n.version === 'string' ? n.version
                                          : (typeof n.protocolversion === 'number' ? String(n.protocolversion) : null);
                                if (ver) versionCounts[ver] = (versionCounts[ver] || 0) + 1;

                                // TimeOffset is reported in seconds vs us. Convert to ms
                                // for parity with the latency unit.
                                const offsetSec = typeof n.timeoffset === 'number' ? n.timeoffset
                                                : typeof n.TimeOffset === 'number' ? n.TimeOffset
                                                : null;
                                if (offsetSec != null) {
                                    const abs = Math.abs(offsetSec) * 1000;
                                    if (abs > maxAbsOffsetMs) maxAbsOffsetMs = abs;
                                }

                                // Direction. ela's getnodestate reports a boolean
                                // `inbound` (lowercase). Some legacy wire shapes use
                                // `Inbound`. We default to 'out' on missing field
                                // since outbound is the more common shape after
                                // peer discovery handshake completes.
                                let dir = null;
                                if (typeof n.inbound === 'boolean')      dir = n.inbound ? 'in' : 'out';
                                else if (typeof n.Inbound === 'boolean') dir = n.Inbound ? 'in' : 'out';
                                if (dir === 'in')       inboundCount += 1;
                                else if (dir === 'out') outboundCount += 1;

                                // Address — addrs may be "ipv6:port", "ipv4:port",
                                // a raw IP, or absent. Normalise to a single string.
                                const addr = (typeof n.addr === 'string' && n.addr)        ? n.addr
                                           : (typeof n.Addr === 'string' && n.Addr)        ? n.Addr
                                           : (typeof n.address === 'string' && n.address)  ? n.address
                                           : null;

                                if (neighborRows.length < 50) {
                                    neighborRows.push({
                                        addr,
                                        direction: dir,
                                        height: h,
                                        pingMs,
                                    });
                                }
                            }
                            if (maxH != null) {
                                networkHeight = maxH;
                                atTipOrAhead = (height >= maxH);
                            }
                            // Build peerSummary for the chain-card hover.
                            // 0.2.0-beta.3.7 — now ships per-peer rows
                            // (mock .peer-pop) + computed inbound/outbound
                            // split. Top-3 versions cap kept for the
                            // aggregate path (frontend falls back to it
                            // when neighbors[] is empty or backend hasn't
                            // populated yet).
                            const topVersions = Object.keys(versionCounts)
                                .map((k) => ({ version: k, count: versionCounts[k] }))
                                .sort((a, b) => b.count - a.count)
                                .slice(0, 3);
                            peerSummary = {
                                count: neighbors.length,
                                inbound: inboundCount,
                                outbound: outboundCount,
                                latencyMsAvg: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
                                versions: topVersions,     // [{version, count}, ...]
                                timeOffsetMaxAbsMs: maxAbsOffsetMs > 0 ? Math.round(maxAbsOffsetMs) : null,
                                neighbors: neighborRows,   // [{addr, direction, height, pingMs}, ...]
                            };
                        }
                    }

                    synced = recentEnough || atTipOrAhead;
                } catch (_) { /* synced stays false */ }
            }

            // Producer state — surface it inline so the chain-card subtitle
            // can show "Active" / "Inactive" / "Illegal" (the operator-
            // facing label the chain actually exposes) instead of the
            // generic "Healthy" when a producer is registered. One extra
            // RPC call, only when pubkey is configured.
            const ourPubkey = chainCfg.dpos && chainCfg.dpos.nodePublicKey;
            if (status && status.alive && ourPubkey) {
                try {
                    const rpc = adapter.rpcClient(chainCfg);
                    const pi = await rpc.getproducerinfo(ourPubkey).catch(() => null);
                    if (pi && pi.state) producerState = pi.state;
                    else if (pi && pi.result && pi.result.state) producerState = pi.result.state;
                } catch (_) { /* producer state stays null */ }
            }

            const syncSnapshot = { synced, alive: !!(status && status.alive), lastBlockTime };

            return res.json(successBody({
                chainId: adapter.chainId,
                displayName: adapter.displayName,
                enabled: !!chainCfg.enabled,
                state: deriveCoarseState(status, chainCfg, syncSnapshot),
                synced,
                lastBlockTime,
                networkHeight,
                producerState,
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
                // alpha.7 — peer quality (improvement #12). Populated from
                // the same `getnodestate.neighbors` we already walked for
                // the at-tip check; null when chain is dead or RPC missed.
                peerSummary,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read chain state.'));
        }
    });

    // 0.2.0-alpha.7 — DPoS rotation snapshot (improvement #02). Powers the
    // chain-card rotation strip: who's on duty, when does this node's slot
    // come up, where in the slate is this node. The parity audit found
    // node.sh has zero rotation awareness and Monitor's onduty checks are
    // post-hoc email batches, so ENM is genuinely first here.
    //
    // Returns the raw `getarbitersinfo` envelope plus convenience fields
    // computed for ENM's configured nodePublicKey:
    //   ourIndex        — position in currentarbiters[] (-1 if not in slate)
    //   ourNextIndex    — position in nextarbiters[] (-1 if not in next slate)
    //   isOnDuty        — true when the operator's pubkey === ondutyarbiter
    //   rotationLength  — length of currentarbiters[]
    //
    // Read-only, no auth gate beyond readActorWallet, same rate-limit bucket.
    router.get('/:chainId/rotation', limit('read'), async (req, res) => {
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
            const status = ChainRegistry.getProcessService().statusSync(adapter.chainId);
            if (!status || !status.alive) {
                return res.json(successBody({ enabled: false, alive: false }));
            }
            const rpc = adapter.rpcClient(chainCfg);
            const info = await rpc.getarbitersinfo().catch(() => null);
            const a = info && (info.result || info);
            if (!a || typeof a !== 'object') {
                return res.json(successBody({ enabled: false, alive: true }));
            }
            // ela's wire field names are inconsistent across endpoints; accept both
            // camelCase and lower-case variants per the existing precedent on
            // getproducerinfo + getnodestate.
            const onDuty = a.ondutyarbiter || a.onDutyArbiter || null;
            const curStart = (typeof a.currentturnstartheight === 'number')
                ? a.currentturnstartheight
                : (typeof a.currentTurnStartHeight === 'number' ? a.currentTurnStartHeight : null);
            const nextStart = (typeof a.nextturnstartheight === 'number')
                ? a.nextturnstartheight
                : (typeof a.nextTurnStartHeight === 'number' ? a.nextTurnStartHeight : null);
            const current = Array.isArray(a.currentarbiters)
                ? a.currentarbiters
                : (Array.isArray(a.currentArbiters) ? a.currentArbiters : []);
            const next = Array.isArray(a.nextarbiters)
                ? a.nextarbiters
                : (Array.isArray(a.nextArbiters) ? a.nextArbiters : []);
            const ourPubkey = chainCfg.dpos && chainCfg.dpos.nodePublicKey;
            const normalize = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
            const ourLower = normalize(ourPubkey);
            const ourIndex = ourLower
                ? current.findIndex((k) => normalize(k) === ourLower)
                : -1;
            const ourNextIndex = ourLower
                ? next.findIndex((k) => normalize(k) === ourLower)
                : -1;
            const isOnDuty = !!(ourLower && onDuty && normalize(onDuty) === ourLower);
            return res.json(successBody({
                enabled: true,
                alive: true,
                onDutyArbiter:        onDuty,
                currentTurnStartHeight: curStart,
                nextTurnStartHeight:    nextStart,
                rotationLength:         current.length,
                currentArbiters:        current,
                nextArbiters:           next,
                ourPubkey,
                ourIndex,
                ourNextIndex,
                isOnDuty,
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/rotation: ${err.message}`,
            );
            return res.status(500).json(errorBody('Failed to read rotation.'));
        }
    });

    // 0.2.0-alpha.1 — chain-card sparkline source. Decimated (≈12 pt)
    // (t, h) series spanning the requested window. The series lives in
    // the in-memory HeightSeriesStore filled by HealthChecker every 30s.
    // Read-only, no host-conflict gate, same rate-limit bucket as
    // other reads. Live updates flow over SSE topic chains:<id>:height.
    router.get('/:chainId/history', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const reqMin = Number.parseInt(req.query.windowMin, 10);
            const windowMin = Number.isFinite(reqMin)
                ? Math.max(10, Math.min(240, reqMin))
                : 60;
            const store = ChainRegistry.getHeightSeriesStore();
            const points = store.snapshot(adapter.chainId, windowMin * 60_000);
            return res.json(successBody({
                chainId:     adapter.chainId,
                points,
                windowMin,
                cadenceSec:  30,
                sourceTopic: `chains:${adapter.chainId}:height`,
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/history: ${err.message}`,
            );
            return res.status(500).json(errorBody('Failed to read height history.'));
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

            // 0.2.0-alpha.4 — host-conflict scan removed from /restart.
            // The earlier "same gate as /start" copy-paste was wrong: the
            // chain is RUNNING here, holding ports 20333-20339, so the
            // scan trips PORT_BOUND CRITICAL on the chain's own ports
            // and refuses every restart. The promised "exclude our own
            // managed PIDs" filter in the prior comment was never
            // implemented. /restart's adapter.restart() stops the old
            // process and starts a new one — if a real external conflict
            // grabs a port between stop and start (rare race), the chain
            // surfaces it as a bind error in the chain log, which the
            // operator can see via the Logs tab.
            const result = await adapter.restart(chainCfg);
            return res.json(successBody(result));
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
            // Every other handler in this file loads cfg up front. Keep that
            // pattern here — the live-RPC enrichment block below references
            // cfg.chains[adapter.chainId] and used to throw silently when this
            // line was missing, leaving networkHeight / peers / lastBlockTime
            // permanently null even though the chain was healthy.
            const cfg = await ConfigStore.load();
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
                    //
                    // ela exposes peer info via `getnodestate` (returns
                    // .Neighbors[]), NOT via `getpeerinfo` (Bitcoin-style
                    // method that ela rejects). The earlier handler used
                    // `getpeerinfo` and four parallel RPC calls — three
                    // of them failed, leaving networkHeight + peers + the
                    // synced check all null. This rewrite uses the same
                    // proven shape HealthChecker uses: just two RPC calls,
                    // peers + max-height both parsed from Neighbors.
                    const cfgChain = cfg.chains[adapter.chainId];
                    if (cfgChain) {
                        try {
                            const rpc = adapter.rpcClient(cfgChain);
                            const [blockCount, nodeStateRes] = await Promise.allSettled([
                                rpc.getblockcount(),
                                rpc.getnodestate(),
                            ]);

                            // ALWAYS prefer fresh RPC value for the displayed
                            // localHeight. SyncTracker holds a HISTORY of
                            // samples used to compute velocity / ETA — it
                            // is not the source of truth for "how many
                            // blocks do I have right now."
                            if (blockCount.status === 'fulfilled') {
                                const v = blockCount.value;
                                const h = (typeof v === 'number') ? v : (v && v.result);
                                if (typeof h === 'number') { snapshot.localHeight = h; }
                            }

                            // Parse getnodestate: peer count + peer max
                            // height come from the same Neighbors array.
                            // Defensive: ela's schema uses capital N
                            // (.Neighbors) but lowercase appears in some
                            // versions; same for height/Height/lastHeight.
                            if (nodeStateRes.status === 'fulfilled') {
                                const v = nodeStateRes.value;
                                const ns = v && v.result ? v.result : v;
                                const neighbors = ns && Array.isArray(ns.Neighbors) ? ns.Neighbors
                                    : ns && Array.isArray(ns.neighbors) ? ns.neighbors
                                    : null;
                                if (Array.isArray(neighbors)) {
                                    snapshot.peers = neighbors.length;
                                    let maxH = null;
                                    for (const n of neighbors) {
                                        if (!n || typeof n !== 'object') continue;
                                        // ela's neighbor schema (verified via direct RPC call
                                        // 2026-05-07) uses `lastblock` for the peer's current
                                        // best height. `startingheight` is what the peer had
                                        // at handshake (older). Bitcoin-style Height/height
                                        // fields are also accepted in case the schema gets
                                        // a normalisation pass upstream.
                                        const h = typeof n.lastblock === 'number' ? n.lastblock
                                                : typeof n.startingheight === 'number' ? n.startingheight
                                                : typeof n.Height === 'number' ? n.Height
                                                : typeof n.height === 'number' ? n.height
                                                : typeof n.lastHeight === 'number' ? n.lastHeight
                                                : null;
                                        if (h != null && (maxH == null || h > maxH)) maxH = h;
                                    }
                                    if (maxH != null) snapshot.networkHeight = maxH;
                                }
                            }

                            // lastBlockTime → "synced" detection. Best-block
                            // hash + header gives us the block's timestamp;
                            // if it's within ~5 min of now, the chain is
                            // caught up regardless of peer reports. Sequenced
                            // (not in the parallel batch) so the chained
                            // getblockheader doesn't compete for the RPC
                            // pool with the two main calls above.
                            try {
                                const bestHashResp = await rpc.getbestblockhash();
                                const hash = bestHashResp && bestHashResp.result
                                    ? bestHashResp.result : bestHashResp;
                                if (typeof hash === 'string' && hash.length > 0) {
                                    try {
                                        const headerResp = await rpc.getblockheader(hash, 2);
                                        const header = headerResp && headerResp.result
                                            ? headerResp.result : headerResp;
                                        if (header && typeof header.time === 'number') {
                                            snapshot.lastBlockTime = header.time;
                                            const ageSec = Math.floor(Date.now() / 1000) - header.time;
                                            // alpha.15 — synced = (recent block) OR (at/ahead of network).
                                            // Either condition alone is sufficient. Without the second
                                            // arm, a slow-block period (network calm) leaves a
                                            // fully-caught-up node stuck on "syncing" even when
                                            // localHeight >= networkHeight.
                                            const recentEnough = (ageSec >= 0 && ageSec <= 5 * 60);
                                            const atTipOrAhead = (snapshot.networkHeight != null
                                                && snapshot.localHeight != null
                                                && snapshot.localHeight >= snapshot.networkHeight);
                                            snapshot.synced = recentEnough || atTipOrAhead;
                                        }
                                    } catch (_) { /* getblockheader may fail on early boot */ }
                                }
                            } catch (_) { /* getbestblockhash failed — lastBlockTime stays null, synced stays false */ }
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
            // 0.2.0-beta.3.8 — add deposit + rewards calls alongside the
            // existing info+producerinfo pair. ela's RPC names:
            //   getdepositcoin(producerPubkey) → { available, deducted, ... }
            //     where amounts are decimal-string ELA. Pre-DPoSv2 deployments
            //     used the owner key; DPoSv2 split-key uses the node pubkey.
            //     We try the node pubkey first (mirrors what ENM registered
            //     with); if the chain rejects, we fall back to owner.
            //   getdposrewards(ownerPubkey) → [{ height, total, ... }] of
            //     reward entries. We sum the last N entries for a rough
            //     "round earnings" figure. Best-effort: not every fork of
            //     ela exposes this RPC; null on failure.
            // Both calls are .catch(() => null) so a missing or failing
            // method doesn't break the existing /producer response shape.
            const ownerPubkey = (chainCfg.dpos && chainCfg.dpos.ownerPublicKey) || ourPubkey;
            const [info, producerInfo, depositInfo, rewardsInfo] = await Promise.all([
                rpc.getinfo().catch(() => null),
                rpc.getproducerinfo(ourPubkey).catch(() => null),
                rpc.getdepositcoin(ourPubkey).catch(() => {
                    // Some forks of ela take owner pubkey in this slot. Try it.
                    if (ownerPubkey && ownerPubkey !== ourPubkey) {
                        return rpc.getdepositcoin(ownerPubkey).catch(() => null);
                    }
                    return null;
                }),
                rpc.getdposrewards(ownerPubkey).catch(() => null),
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
            // 0.2.0-alpha.6 — wallet ↔ on-chain binding check (improvement #18).
            // Surface the owner + node pubkeys the chain reports for ENM's
            // configured nodePublicKey, plus a derived `binding` status the UI
            // can chip. The parity audit found node.sh:1642 silently passes
            // node pubkey under owner slot to `getdepositcoin` — wrong for any
            // DPoSV2 split-key producer. ENM exposes both keys so the operator
            // can eyeball-match against what they registered from in Essentials.
            //
            // Deposit-address derivation (the §2 base58 dance with the
            // decimal-string-of-bigint quirk) is deferred to alpha.7 once we
            // have golden vectors round-tripped against the chain.
            const chainNodePubkey  = producerInfo && (producerInfo.nodepublickey  || producerInfo.NodePublicKey);
            const chainOwnerPubkey = producerInfo && (producerInfo.ownerpublickey || producerInfo.OwnerPublicKey);
            let binding;
            if (!producerInfo) {
                binding = 'unregistered';
            } else if (chainNodePubkey && ourPubkey
                    && chainNodePubkey.toLowerCase() !== ourPubkey.toLowerCase()) {
                // Defensive — should be impossible (we queried by ourPubkey),
                // but if some normalization happens we'd want to know.
                binding = 'mismatch';
            } else {
                binding = 'bound';
            }
            // 0.2.0-beta.3.8 — deposit + rewards extraction.
            // depositInfo from getdepositcoin is an envelope:
            //   { available: "5000.00000000", deducted: "0", assets: "...", ... }
            // We expose `depositLockedEla` (the `available` field — the still-
            // locked stake) and let the operator-facing chip show "5,000 ELA"
            // per phase-03 mock. Fields are decimal strings ELA; we keep
            // them as strings to avoid float precision loss on big stakes.
            let depositLockedEla = null;
            if (depositInfo && typeof depositInfo === 'object') {
                if (typeof depositInfo.available === 'string')      { depositLockedEla = depositInfo.available; }
                else if (typeof depositInfo.deposit === 'string')   { depositLockedEla = depositInfo.deposit; }
                else if (typeof depositInfo.assets === 'string')    { depositLockedEla = depositInfo.assets; }
            }
            // Rewards: getdposrewards returns an array of {height, total}
            // entries (per-round totals). We sum the last 24 entries as
            // an aggregate "recent rounds" figure for the active-card
            // stat. Best-effort; not every fork exposes this.
            let recentRewardsEla = null;
            if (Array.isArray(rewardsInfo) && rewardsInfo.length > 0) {
                let sum = 0;
                const recent = rewardsInfo.slice(-24);
                for (const r of recent) {
                    const v = r && (
                        typeof r.total === 'number' ? r.total
                      : typeof r.total === 'string' ? Number(r.total)
                      : null
                    );
                    if (v != null && isFinite(v)) { sum += v; }
                }
                if (sum > 0) {
                    // Round to 4 decimals — ELA reward amounts are typically
                    // small fractions like 0.0123 per block; 4 dp keeps the
                    // operator-facing display readable.
                    recentRewardsEla = sum.toFixed(4);
                }
            }
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
                // 0.2.0-beta.3.8 — additional stats for the BPoS active
                // card grid (phase-03 mock variant C). Both fields are
                // null when the RPC method isn't supported, returns an
                // empty/malformed payload, or the chain hasn't accrued
                // any rewards yet. The frontend renders "—" in that case.
                depositLockedEla,         // string ELA, e.g. "5000.00000000"
                recentRewardsEla,         // string ELA, sum of last ~24 reward entries
                // alpha.6 — binding check fields
                chainNodePubkey,
                chainOwnerPubkey,
                binding,
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
            // beta.3.59 — chain-rollback takes a `height` query param. Hoisted
            // into runAutoFix via the third options arg so the existing
            // narrow-action contract isn't disrupted for the other actions.
            const opts = { query: req.query || {} };
            const result = await runAutoFix(action, adapter, extensionHandle, opts);
            return res.json(successBody({ action, ...result }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/auto-fix: ${err.message}`);
            // beta.3.53 — classify known precondition failures as 409 Conflict
            // instead of a misleading 500. These are operator-correctable
            // states (chain is alive when we'd need it stopped; no backup to
            // restore; etc.) — they aren't internal-server errors. 500 stays
            // the default for genuinely-unexpected failures.
            const statusCode = classifyAutoFixError(err);
            return res.status(statusCode).json(errorBody(err.message));
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

    // ------------------------------------------------------------------
    // Bootstrap (alpha.10) — fetch the official Elastos chain-data snapshot
    // and apply it to the chain's data dir, replacing genesis-sync (1–3 days)
    // with snapshot-download (~15 min). Pure operator-facing acceleration —
    // the chain still verifies blocks as it catches up the tail.
    //
    // Routes:
    //   POST /:chainId/bootstrap         start a bootstrap run (owner-only)
    //   GET  /:chainId/bootstrap         current status snapshot
    //   DELETE /:chainId/bootstrap       best-effort cancel (mid-download only)
    //
    // Progress streams on SSE topic `setup:bootstrap:<chainId>` (mirrors the
    // existing `setup:install:<chainId>` topic the binary downloader uses).
    // ------------------------------------------------------------------
    router.post('/:chainId/bootstrap', limit('admin'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            // Same gate as /update — applying a snapshot while ela holds the
            // data dir open would corrupt the chain. Operator stops first.
            const status = ChainRegistry.getProcessService().statusSync(adapter.chainId);
            if (status && status.alive) {
                return res.status(409).json(errorBody(
                    'Stop the chain before bootstrapping. Click Stop on the chain card, wait for the badge to change to "Stopped", then run Bootstrap again.',
                ));
            }
            const downloader = ChainRegistry.getBootstrapDownloader();
            if (!downloader) {
                return res.status(503).json(errorBody('Bootstrap downloader is not available.'));
            }
            const result = await downloader.start(adapter.chainId);
            return res.json(successBody({
                alreadyRunning: result.alreadyRunning,
                status: result.status,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /chains/${req.params.chainId}/bootstrap: ${err.message}`);
            // 412 if it's a disk-space preflight failure — operator-actionable.
            const isPreflight = /insufficient disk|disk space|free, you have/i.test(err.message);
            return res.status(isPreflight ? 412 : 500).json(errorBody(err.message));
        }
    });

    router.get('/:chainId/bootstrap', limit('read'), async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const downloader = ChainRegistry.getBootstrapDownloader();
            return res.json(successBody({ status: downloader.getStatus(adapter.chainId) }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /chains/${req.params.chainId}/bootstrap: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    router.delete('/:chainId/bootstrap', limit('admin'), requireOwner, async (req, res) => {
        try {
            const adapter = adapterOr404(req, res, extensionHandle);
            if (!adapter) return undefined;
            const downloader = ChainRegistry.getBootstrapDownloader();
            const result = downloader.cancel(adapter.chainId);
            return res.json(successBody(result));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} DELETE /chains/${req.params.chainId}/bootstrap: ${err.message}`);
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
 * beta.3.53 — Map known precondition error messages thrown by runAutoFix
 * to the HTTP status that actually describes them. "Chain is alive" (refuse
 * to clear LOCK on a running DB) is a 409 Conflict, not a 500: the operator
 * has to stop the chain before this action can succeed — nothing crashed on
 * the server. Genuine unexpected errors keep 500.
 *
 * @param {Error} err
 * @returns {number} HTTP status code
 */
function classifyAutoFixError(err) {
    const msg = (err && err.message) ? String(err.message) : '';
    // Precondition: resource state doesn't permit this action right now.
    if (/Chain is alive/i.test(msg)) { return 409; }
    if (/No backup config/i.test(msg)) { return 409; }
    // beta.3.61 — 412 for the explicit-confirm safety gate on chain-rollback.
    // Distinct from 409 (state-based) — this is "you didn't pass the
    // dangerous-action confirmation flag" which is a missing-parameter
    // / precondition-failed semantic.
    if (/chain-rollback is destructive/.test(msg)) { return 412; }
    if (/Invalid rollback target/.test(msg)) { return 400; }
    // Unknown — keep the default.
    return 500;
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
async function runAutoFix(action, adapter, extensionHandle, opts) {
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
    if (action === A.CHAIN_ROLLBACK) {
        return runChainRollback(adapter, extensionHandle, opts);
    }
    throw new Error('Unhandled action: ' + action);
}

/**
 * beta.3.59 — operator-triggered chain rollback for the arbitrator-state
 * mismatch failure mode. After a SIGKILL of ela (OOM, deploy bounce, hard
 * reboot) the cp_dpos/default.dcp may have a stale arbitrator view; new
 * blocks reference sponsors not in our local set; PowCheckBlockContext
 * keeps rejecting them; height freezes. The recovery KB-confirmed by the
 * Elastos.ELA source (cmd/rollback/rollback.go) is: stop ela, run
 * ela-cli rollback --height N --datadir <chainDir>/elastos, restart.
 *
 * Safety:
 *   - Chain must be stopped (409 Conflict otherwise via classifyAutoFixError)
 *   - Height must be a positive integer, sufficiently below current height
 *   - Backup of default.dcp is taken before any mutation
 *   - keystore.dat lives at <chainDir>/keystore.dat, OUTSIDE the rollback
 *     scope (which is <chainDir>/elastos/data/), so it's untouched
 *   - No automatic restart afterwards — operator confirms a restart
 *     separately so they can see the post-rollback state first
 *
 * @param {object} adapter
 * @param {object} extensionHandle
 * @param {object} opts
 * @param {object} opts.query   parsed query string (height)
 * @returns {Promise<{ok: boolean, detail: string, height: number, backupPath?: string}>}
 */
async function runChainRollback(adapter, extensionHandle, opts) {
    // beta.3.61 — explicit confirmation gate. The KB-cited rollback path
    // (ela-cli rollback) is "non-transactional, DANGEROUS". An interrupted
    // rollback (SSH drop, OS reboot, OOM) leaves FFLDB block index and
    // UTXO state desynchronized — verified empirically on srv832310 when
    // a long-running rollback was interrupted and subsequent boots got
    // stuck at "INITIALIZE FINISHED → server shutting down" with no
    // recovery short of full chain wipe + bootstrap. The caller MUST
    // pass confirm=I-understand-rollback-is-destructive to proceed.
    const confirm = opts && opts.query && opts.query.confirm;
    if (confirm !== 'I-understand-rollback-is-destructive') {
        throw new Error(
            'chain-rollback is destructive and may corrupt the chain if interrupted. '
            + 'Pass ?confirm=I-understand-rollback-is-destructive to proceed. '
            + 'For most "chain stuck" cases, use chain-resync + bootstrap instead.',
        );
    }
    const proc = ChainRegistry.getProcessService();
    if (proc.statusSync(adapter.chainId).alive) {
        throw new Error('Chain is alive — stop the chain before rollback.');
    }
    const heightRaw = opts && opts.query && opts.query.height;
    const height = Number(heightRaw);
    if (!Number.isInteger(height) || height < 1_000_000) {
        // Floor guard: a rollback target below 1M almost certainly indicates
        // operator typo, not a real arbitrator-mismatch recovery. The KB
        // says rollback is "DANGEROUS, non-transactional" — be paranoid.
        throw new Error('Invalid rollback target — height must be an integer >= 1,000,000.');
    }
    // Locate ela-cli via the binary downloader's known-good state.
    const downloader = ChainRegistry.getBinaryDownloader();
    if (!downloader) {
        throw new Error('Binary downloader not available — cannot locate ela-cli.');
    }
    const onDisk = await downloader.getStatusWithDisk(adapter.chainId);
    const cliPath = onDisk && onDisk.cliPath;
    if (!cliPath) {
        throw new Error('ela-cli not found on disk — cannot perform rollback.');
    }
    const dataDir = path.join(chainDir(adapter.chainId), 'elastos');
    // Backup default.dcp before mutating. Non-fatal if it doesn't exist —
    // the rollback itself rewinds blockchain state, default.dcp will be
    // regenerated on next start.
    const dcpPath = path.join(dataDir, 'data', 'checkpoints', 'cp_dpos', 'default.dcp');
    const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `/tmp/default.dcp.bak.${backupTs}`;
    try {
        await fsp.copyFile(dcpPath, backupPath);
        extensionHandle.log.info(`${ENM_LOG_PREFIX} chain-rollback ${adapter.chainId}: backed up default.dcp to ${backupPath}`);
    } catch (err) {
        if (err.code !== 'ENOENT') { throw err; }
        // No default.dcp to back up — proceed; rollback regenerates it.
    }
    // Spawn ela-cli rollback. Use execFile (no shell), pass args directly.
    const { execFile } = require('node:child_process');
    const result = await new Promise((resolve, reject) => {
        execFile(cliPath, [
            'rollback',
            '--height', String(height),
            '--datadir', dataDir,
        ], {
            timeout: 5 * 60_000,  // 5 minutes — rollback of ~1000 blocks is fast
            maxBuffer: 4 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
    extensionHandle.log.info(`${ENM_LOG_PREFIX} chain-rollback ${adapter.chainId}: completed at height=${height}; stdout(tail)=${String(result.stdout).slice(-200)}`);
    // ALSO delete default.dcp so ela rebuilds from the most-recent
    // <height>.dcp ≤ N on next start. Without this, ela might re-load
    // the still-present (now-stale relative to rollback height) default.dcp.
    try {
        await fsp.unlink(dcpPath);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            extensionHandle.log.warn(`${ENM_LOG_PREFIX} chain-rollback ${adapter.chainId}: could not unlink default.dcp (non-fatal): ${err.message}`);
        }
    }
    return {
        ok: true,
        detail: `Chain rolled back to height ${height}. Start the chain to resume sync from there. Backup at ${backupPath}.`,
        height,
        backupPath,
    };
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
/**
 * Coarse-state derivation.
 *
 * alpha.14 — previously always returned 'syncing' for any alive chain,
 * which meant the UI never flipped to "Healthy" even on a fully caught-
 * up node. Operators saw 100% + "Syncing" forever. Fixed by accepting
 * an optional `syncSnapshot` arg from /sync's enriched response — when
 * `syncSnapshot.synced === true` (lastBlockTime within 5 min of now,
 * the truthful signal wallets use) we return 'healthy'.
 *
 * @param {object} status        from NativeProcessService.statusSync
 * @param {object|null} chainCfg from ConfigStore.load().chains[id]
 * @param {object} [syncSnapshot]  optional sync info — { synced, alive, … }
 */
function deriveCoarseState(status, chainCfg, syncSnapshot) {
    if (!chainCfg) {
        return 'unconfigured';
    }
    if (!status.alive) {
        return chainCfg.enabled ? 'stopped' : 'disabled';
    }
    if (syncSnapshot && syncSnapshot.synced === true) {
        return 'healthy';
    }
    return 'syncing';
}

module.exports = {
    build,
};
