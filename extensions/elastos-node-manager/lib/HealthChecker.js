/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * HealthChecker — periodic snapshotter + rule dispatcher.
 *
 * Three timer buckets per Rev 1 plan + Rev 9 native-binary architecture:
 *
 *   FAST   ( 5s) — process alive (kill -0 + /proc/<pid>/exe), RPC reachable
 *                  (single ping), exit-event drain
 *   MEDIUM (30s) — peer count, height delta, RPC latency, port conflict scan,
 *                  config validation
 *   SLOW   ( 5m) — disk free, binary --version cross-check
 *
 * State held per chain (the timeline that lets rules fire on durations):
 *   firstPeerZeroAt       — set on first 0-peer observation, cleared on >0
 *   firstRpcDownAt        — set on first RPC failure, cleared on success
 *   firstHeightStallAt    — set on the first poll where height didn't advance
 *   lastHeight            — used to detect "no change since last tick"
 *   restartAttempts       — informational only (engine owns the budget)
 *   lastBinaryVersion     — for F8
 *   lastExit              — most recent exit event (subscribed from processService)
 *
 * Phase 4 covers F1-F10. F11/F12 (BPoS), F13 (clock skew), F14 (daemon —
 * dropped in Rev 9 since no Docker), F15 (audit DB integrity) are Phase 5+.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');

const {
    ENM_LOG_PREFIX,
    HEALTH_TICK_MS,
} = require('./EnmConstants');
const HealthRules = require('./HealthRules');
const ConfigStore = require('./ConfigStore');
const { validate } = require('./EnmConfigSchema');
const { chainDir } = require('./DataDir');
const ClockSkewChecker = require('./ClockSkewChecker');
const HostConflictScanner = require('./HostConflictScanner');

class HealthChecker {
    /**
     * @param {object} deps
     * @param {object} deps.extensionHandle
     * @param {object} deps.processService
     * @param {object} deps.engine          SelfHealingEngine
     * @param {() => Array<{chainId:string}>} deps.listChains
     * @param {(chainId:string) => object}    deps.getAdapter
     */
    constructor(deps) {
        if (!deps || !deps.extensionHandle || !deps.processService
            || !deps.engine || typeof deps.listChains !== 'function'
            || typeof deps.getAdapter !== 'function') {
            throw new TypeError(
                'HealthChecker: { extensionHandle, processService, engine, listChains, getAdapter } required',
            );
        }
        this.extensionHandle = deps.extensionHandle;
        this.processService = deps.processService;
        this.engine = deps.engine;
        this.listChains = deps.listChains;
        this.getAdapter = deps.getAdapter;
        // Injected loader makes the tick logic testable without disk I/O.
        // Defaults to ConfigStore.load so production wiring is unchanged.
        this.loadConfig = (typeof deps.loadConfig === 'function')
            ? deps.loadConfig
            : () => ConfigStore.load();
        /** @type {Map<string, object>} */
        this.state = new Map();
        this._timers = { fast: null, medium: null, slow: null };
        this._running = false;

        // Capture exits so F1/F6 know what happened. NativeProcessService emits
        // `{ chainId, code, signal, manualStop }`.
        this._onExit = ({ chainId, code, signal, manualStop }) => {
            const s = this._ensureState(chainId);
            s.lastExit = { code, signal, manualStop, at: Date.now() };
        };
        this.processService.on('exit', this._onExit);
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._timers.fast   = setInterval(() => this._fastTick().catch(this._logTickErr('fast')),   HEALTH_TICK_MS.FAST);
        this._timers.medium = setInterval(() => this._mediumTick().catch(this._logTickErr('medium')), HEALTH_TICK_MS.MEDIUM);
        this._timers.slow   = setInterval(() => this._slowTick().catch(this._logTickErr('slow')),     HEALTH_TICK_MS.SLOW);
        this.extensionHandle.log.info(`${ENM_LOG_PREFIX} HealthChecker started`);
    }

    stop() {
        if (!this._running) return;
        this._running = false;
        for (const k of Object.keys(this._timers)) {
            if (this._timers[k]) {
                clearInterval(this._timers[k]);
                this._timers[k] = null;
            }
        }
        if (this._onExit) {
            this.processService.removeListener('exit', this._onExit);
        }
    }

    /**
     * Public: run all three buckets right now (used by tests + the chains-routes
     * post-restart hook so the operator sees fresh state without waiting 5s).
     */
    async tickNow() {
        await this._fastTick();
        await this._mediumTick();
        await this._slowTick();
    }

    // ========================================================================
    // Tick implementations
    // ========================================================================

    /** @private */
    async _fastTick() {
        const cfg = await this._loadConfigSafe();
        for (const chainInfo of this.listChains()) {
            const chainId = chainInfo.chainId;
            const chainCfg = cfg && cfg.chains && cfg.chains[chainId];
            if (!chainCfg || !chainCfg.enabled) continue;

            const s = this._ensureState(chainId);
            const status = this.processService.statusSync(chainId);

            // F1 input: process alive vs not.
            const alive = !!status.alive;
            // RPC reachability ping (cheap — one HTTP request via EnmRpcClient).
            let rpcSummary = null;
            if (alive) {
                rpcSummary = await this._pingRpc(chainId);
                if (rpcSummary.ok) {
                    s.firstRpcDownAt = null;
                } else if (!s.firstRpcDownAt) {
                    s.firstRpcDownAt = Date.now();
                }
            }

            const snap = {
                chainId,
                processStatus: status,
                processExit: s.lastExit || null,
                rpcSummary,
                diskInfo: null,
                ports: null,
                configValidation: null,
                chainConfig: chainCfg,
                ruleState: s,
            };

            // F1 + F2 fire here.
            const dets = HealthRules.runAll(snap)
                .filter((d) => d.ruleId === 'F1' || d.ruleId === 'F2');
            if (dets.length > 0) {
                await this.engine.apply(chainId, dets, chainCfg);
            }
        }
    }

    /** @private */
    async _mediumTick() {
        const cfg = await this._loadConfigSafe();
        const cfgValidation = await this._validateConfigSafe(cfg);

        for (const chainInfo of this.listChains()) {
            const chainId = chainInfo.chainId;
            const chainCfg = cfg && cfg.chains && cfg.chains[chainId];
            if (!chainCfg || !chainCfg.enabled) continue;

            const s = this._ensureState(chainId);
            const status = this.processService.statusSync(chainId);
            if (!status.alive) {
                // Reset all timers — the next start will start fresh.
                s.firstPeerZeroAt = null;
                s.firstHeightStallAt = null;
                s.firstNoInboundAt = null;
                continue;
            }

            const rpcSummary = await this._fetchRpcSummary(chainId);
            // Update peer-zero timeline.
            if (rpcSummary.ok && rpcSummary.peers === 0) {
                if (!s.firstPeerZeroAt) s.firstPeerZeroAt = Date.now();
            } else {
                s.firstPeerZeroAt = null;
            }
            // Update height-stall timeline.
            if (rpcSummary.ok && typeof rpcSummary.height === 'number') {
                if (s.lastHeight === rpcSummary.height) {
                    if (!s.firstHeightStallAt) s.firstHeightStallAt = Date.now();
                } else {
                    s.firstHeightStallAt = null;
                    s.lastHeight = rpcSummary.height;
                }
            }
            // F18 timeline — inbound peers count is needed only when arbiter mode.
            if (chainCfg.dpos && chainCfg.dpos.enableArbiter
                && rpcSummary.ok
                && typeof rpcSummary.inboundCount === 'number'
                && typeof rpcSummary.outboundCount === 'number') {
                const noInbound = rpcSummary.inboundCount === 0 && rpcSummary.outboundCount > 0;
                if (noInbound) {
                    if (!s.firstNoInboundAt) s.firstNoInboundAt = Date.now();
                } else {
                    s.firstNoInboundAt = null;
                }
            } else {
                s.firstNoInboundAt = null;
            }

            const snap = {
                chainId,
                processStatus: status,
                processExit: s.lastExit || null,
                rpcSummary,
                diskInfo: null,
                ports: null,
                configValidation: cfgValidation,
                chainConfig: chainCfg,
                ruleState: s,
            };

            const dets = HealthRules.runAll(snap).filter((d) =>
                d.ruleId === 'F3' || d.ruleId === 'F4' || d.ruleId === 'F9'
                || d.ruleId === 'F10' || d.ruleId === 'F16' || d.ruleId === 'F18');
            if (dets.length > 0) {
                await this.engine.apply(chainId, dets, chainCfg);
            }
        }
    }

    /** @private */
    async _slowTick() {
        const cfg = await this._loadConfigSafe();
        // F13 — host clock check, runs once per slow tick (not per chain).
        const clockSkew = await this._checkClockSkew();
        // F19 — host conflict scan, also once per tick (cheap when nothing
        // matches; ss/lsof + readdir on a handful of paths). Cached for 5
        // minutes so a chain card doesn't re-scan on every refresh.
        const hostConflicts = await this._scanHostConflicts();

        for (const chainInfo of this.listChains()) {
            const chainId = chainInfo.chainId;
            const chainCfg = cfg && cfg.chains && cfg.chains[chainId];
            if (!chainCfg || !chainCfg.enabled) continue;

            const s = this._ensureState(chainId);
            const diskInfo = await this._diskFree(chainId);
            // Binary version check — for F8.
            const versionInfo = await this._binaryVersion(chainCfg.binaryPath);
            if (versionInfo.ok) {
                s.lastBinaryVersion = versionInfo.version;
            }

            // BPoS-only checks — F11/F12 only matter when arbiter mode is on.
            const bpos = chainCfg.dpos && chainCfg.dpos.enableArbiter
                ? await this._fetchBposState(chainId, chainCfg, s)
                : null;

            const snap = {
                chainId,
                processStatus: this.processService.statusSync(chainId),
                processExit: s.lastExit || null,
                rpcSummary: null,
                diskInfo,
                ports: null,
                configValidation: null,
                chainConfig: chainCfg,
                ruleState: s,
                bpos,
                clockSkew,
                hostConflicts,
            };

            const dets = HealthRules.runAll(snap).filter((d) =>
                d.ruleId === 'F5'  || d.ruleId === 'F6'  || d.ruleId === 'F8'
                || d.ruleId === 'F11' || d.ruleId === 'F12' || d.ruleId === 'F13'
                || d.ruleId === 'F19');
            if (dets.length > 0) {
                await this.engine.apply(chainId, dets, chainCfg);
            }
        }
    }

    /**
     * @private
     * Fetch producer + arbiter-rotation state. Returns null on transient
     * errors so health rules just stay quiet rather than firing CRITICAL.
     *
     * @param {string} chainId
     * @param {object} chainCfg
     * @param {object} ruleState  the same per-chain state HealthChecker owns
     * @returns {Promise<{ producer: object|null, rotationStuck: boolean }|null>}
     */
    async _fetchBposState(chainId, chainCfg, ruleState) {
        const ourPubkey = chainCfg.dpos && chainCfg.dpos.nodePublicKey;
        if (!ourPubkey || ourPubkey.length === 0) {
            return null;
        }
        try {
            const adapter = this.getAdapter(chainId);
            const client = adapter.rpcClient(chainCfg);
            const [producerInfo, info] = await Promise.all([
                client.getproducerinfo(ourPubkey).catch(() => null),
                client.getinfo().catch(() => null),
            ]);
            const currentHeight = info && typeof info.height === 'number' ? info.height
                                : info && typeof info.blocks === 'number' ? info.blocks
                                : null;

            // F12 input
            let producer = null;
            if (producerInfo) {
                const inactiveHeight = (producerInfo && typeof producerInfo.inactiveheight === 'number')
                    ? producerInfo.inactiveheight : null;
                const inactiveRounds = (currentHeight != null && inactiveHeight != null)
                    ? (currentHeight - inactiveHeight) : null;
                producer = {
                    state: producerInfo.state,
                    votes: producerInfo.votes,
                    dposv2votes: producerInfo.dposv2votes,
                    rank: producerInfo.index,
                    inactiveHeight,
                    inactiveRounds,
                };
            }

            // F11 input — query two ADJACENT heights in the same tick so the
            // H and H+1 comparison is exact (Phase 5 audit, agent 1: prior impl
            // compared across slow-tick boundaries which span ~150 blocks).
            //
            // Rotation-stuck means: between height H-1 and H, the on-duty
            // arbiter index didn't advance AND the slot at that index in the
            // current arbiters list is empty (the arbiter we expected to
            // produce missed). Our pubkey doesn't have to be that arbiter —
            // F11 surfaces ANY consensus stall the dashboard can show; F12
            // is the rule that talks specifically about our producer.
            let rotationStuck = false;
            if (currentHeight != null && currentHeight > 0) {
                try {
                    const [curr, prev] = await Promise.all([
                        client.getarbitratorgroupbyheight(currentHeight).catch(() => null),
                        client.getarbitratorgroupbyheight(currentHeight - 1).catch(() => null),
                    ]);
                    const currIdx = curr && typeof curr.ondutyarbitratorindex === 'number'
                        ? curr.ondutyarbitratorindex : null;
                    const prevIdx = prev && typeof prev.ondutyarbitratorindex === 'number'
                        ? prev.ondutyarbitratorindex : null;
                    const arbiters = Array.isArray(curr && curr.arbitrators) ? curr.arbitrators : [];
                    const onDutySlot = (currIdx != null) ? arbiters[currIdx] : undefined;
                    // Empty-string slot at the ON-DUTY index — only that one
                    // matters; other empty slots are arbiters out of duty.
                    const onDutyMissed = typeof onDutySlot === 'string' && onDutySlot.length === 0;
                    if (currIdx != null && prevIdx != null && currIdx === prevIdx && onDutyMissed) {
                        rotationStuck = true;
                    }
                } catch {
                    // RPC blip — leave rotationStuck=false.
                }
            }
            return { producer, rotationStuck };
        } catch (err) {
            this.extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} bpos fetch ${chainId}: ${err.message}`,
            );
            return null;
        }
    }

    /**
     * @private
     * Run the host conflict scanner with a 5-minute cache. Slow-tick is also
     * 5 minutes, so this just guarantees we don't double-scan when tickNow is
     * called explicitly (e.g., immediately after a chain start).
     */
    async _scanHostConflicts() {
        const now = Date.now();
        if (this._hostConflictsCache
            && (now - this._hostConflictsCache.fetchedAt) < 5 * 60 * 1000) {
            return this._hostConflictsCache.value;
        }
        try {
            const result = await HostConflictScanner.scan({ logger: this.extensionHandle.log });
            this._hostConflictsCache = { value: result, fetchedAt: now };
            return result;
        } catch (err) {
            this.extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} host conflict scan failed: ${err.message}`,
            );
            const fail = [];
            this._hostConflictsCache = { value: fail, fetchedAt: now };
            return fail;
        }
    }

    /**
     * @private
     * Wraps ClockSkewChecker with a 30-min cache. Slow-tick fires every 5 min,
     * but we don't need fresh internet probes that often.
     */
    async _checkClockSkew() {
        const now = Date.now();
        if (this._clockSkewCache
            && (now - this._clockSkewCache.fetchedAt) < 30 * 60 * 1000) {
            return this._clockSkewCache.value;
        }
        try {
            const result = await ClockSkewChecker.check({ timeoutMs: 5_000 });
            this._clockSkewCache = { value: result, fetchedAt: now };
            return result;
        } catch (err) {
            const fail = { ok: false, reason: err.message };
            this._clockSkewCache = { value: fail, fetchedAt: now };
            return fail;
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /** @private */
    _ensureState(chainId) {
        let s = this.state.get(chainId);
        if (!s) {
            s = {
                firstPeerZeroAt: null,
                firstRpcDownAt: null,
                firstHeightStallAt: null,
                firstNoInboundAt: null,           // Phase 5 F18
                lastHeight: null,
                lastBinaryVersion: null,
                lastExit: null,
                restartAttempts: 0,
            };
            this.state.set(chainId, s);
        }
        return s;
    }

    /** @private */
    async _loadConfigSafe() {
        try {
            return await this.loadConfig();
        } catch (err) {
            this.extensionHandle.log.warn(
                `${ENM_LOG_PREFIX} HealthChecker config.load failed: ${err.message}`,
            );
            return null;
        }
    }

    /** @private */
    async _validateConfigSafe(cfg) {
        if (!cfg) {
            return { ok: false, error: 'config not loaded' };
        }
        try {
            validate(cfg);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    /** @private */
    async _pingRpc(chainId) {
        try {
            const adapter = this.getAdapter(chainId);
            const cfg = await this._loadConfigSafe();
            const chain = cfg && cfg.chains && cfg.chains[chainId];
            if (!chain) return { ok: false, errCode: 'no-config' };
            const client = adapter.rpcClient(chain);
            await client.getblockcount();
            return { ok: true };
        } catch (err) {
            return { ok: false, errCode: err.name || 'RpcError' };
        }
    }

    /** @private */
    async _fetchRpcSummary(chainId) {
        try {
            const adapter = this.getAdapter(chainId);
            const cfg = await this._loadConfigSafe();
            const chain = cfg && cfg.chains && cfg.chains[chainId];
            if (!chain) return { ok: false, errCode: 'no-config' };
            const client = adapter.rpcClient(chain);
            const t0 = Date.now();
            // Defensive: a future client variant or a test fake may not
            // implement every method. Guard each call with optional access
            // so a missing method becomes `null`, not a thrown TypeError.
            const callOrNull = (fn) => {
                if (typeof fn !== 'function') return Promise.resolve(null);
                try { return Promise.resolve(fn()).catch(() => null); }
                catch { return Promise.resolve(null); }
            };
            const [height, peers, nodeState] = await Promise.all([
                callOrNull(client.getblockcount && client.getblockcount.bind(client)),
                callOrNull(client.getconnectioncount && client.getconnectioncount.bind(client)),
                callOrNull(client.getnodestate && client.getnodestate.bind(client)),
            ]);

            // F18 input — count inbound vs outbound from getnodestate.Neighbors.
            // Defensive: the schema may evolve; guard each access.
            let inboundCount;
            let outboundCount;
            const neighbors = nodeState && Array.isArray(nodeState.neighbors)
                ? nodeState.neighbors
                : (nodeState && Array.isArray(nodeState.Neighbors) ? nodeState.Neighbors : null);
            if (Array.isArray(neighbors)) {
                inboundCount = 0;
                outboundCount = 0;
                for (const n of neighbors) {
                    const isInbound = (n && (n.Inbound === true || n.inbound === true));
                    if (isInbound) inboundCount += 1;
                    else outboundCount += 1;
                }
            }

            return {
                ok: typeof height === 'number' && typeof peers === 'number',
                height: typeof height === 'number' ? height : undefined,
                peers: typeof peers === 'number' ? peers : undefined,
                inboundCount,
                outboundCount,
                latencyMs: Date.now() - t0,
            };
        } catch (err) {
            return { ok: false, errCode: err.name || 'RpcError' };
        }
    }

    /** @private */
    async _diskFree(chainId) {
        try {
            const dir = chainDir(chainId);
            const stats = await fsp.statfs(dir).catch(() => null);
            if (!stats) return null;
            const freeBytes = stats.bavail * stats.bsize;
            const totalBytes = stats.blocks * stats.bsize;
            return {
                freeGb: freeBytes / (1024 ** 3),
                totalGb: totalBytes / (1024 ** 3),
            };
        } catch (err) {
            this.extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} disk free for ${chainId}: ${err.message}`,
            );
            return null;
        }
    }

    /** @private */
    async _binaryVersion(binaryPath) {
        if (!binaryPath || typeof binaryPath !== 'string') {
            return { ok: false };
        }
        if (!fs.existsSync(binaryPath)) {
            return { ok: false };
        }
        // EnmBinaryLocator.smokeTest is the canonical one-shot probe; we just
        // re-invoke it here so behavior is consistent with setup-wizard step 4.
        try {
            const Locator = require('./EnmBinaryLocator');
            const result = await Locator.smokeTest(binaryPath, { timeoutMs: 5_000 });
            return result.ok ? { ok: true, version: result.version } : { ok: false };
        } catch {
            return { ok: false };
        }
    }

    /** @private */
    _logTickErr(bucket) {
        return (err) => {
            this.extensionHandle.log.error(
                `${ENM_LOG_PREFIX} HealthChecker ${bucket} tick error: ${err.message}`,
            );
        };
    }
}

module.exports = {
    HealthChecker,
};
