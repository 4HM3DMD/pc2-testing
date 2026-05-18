/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * CouncilOverviewService — Wave M2.2 (beta.3.90) — multi-chain
 * aggregator backing the future MultiChainOverviewPane (M2.3) and the
 * new `council:overview` SSE topic.
 *
 * WHY THIS EXISTS
 *
 * Pre-3.90 the chain-card hero was the only widget that read live
 * chain state, and it was hard-bound to a single chainId. A Council
 * operator running 9 services has no aggregate view — they'd have to
 * click each chain in the selector to see whether it's alive. The
 * overview pane (M2.3) renders one row per configured chain with a
 * mini status badge + sparkline, and clicking a row routes to that
 * chain via PaneRouter (M2.1).
 *
 * The pane needs a lightweight server-side aggregation that doesn't
 * stack 9× per-chain RPC fans every 5 seconds. CouncilOverviewService
 * pulls from CHEAP sources only:
 *
 *   - ChainRegistry.listChains() → names + classes + parentChainId
 *   - NativeProcessService.statusSync(chainId) → alive/pid (no RPC)
 *   - ConfigStore.load() → enabled flags
 *   - meta sidecar startedAt → uptimeSec for the 'starting' grace window
 *
 * Per-chain RPC details (block height, peer count, sync%, producer
 * state) stay in `GET /api/enm/chains/<id>`; the overview is a HEADER
 * view, not a replacement for the per-chain detail panes.
 *
 * BOOT INTEGRATION
 *
 * Started in server.js after ChainRegistry.initHealing() so the
 * HealthChecker is already running (the overview piggy-backs on the
 * NativeProcessService exit hook which is registered during
 * ChainRegistry.init).
 *
 * SSE CONTRACT
 *
 * Topic: 'council:overview' (matches SseHub topic regex /^[a-z0-9:-]+$/)
 * Payload:
 *   {
 *     ts: number,                  // Date.now() snapshot timestamp
 *     chains: [
 *       {
 *         chainId, displayName, chainClass, parentChainId,
 *         enabled, alive, pid, attached,
 *         uptimeSec,                // null if stopped or meta missing
 *         state,                    // 'unconfigured'|'disabled'|'stopped'|'starting'|'running'
 *       }, ...
 *     ],
 *     totals: {
 *       total, running, enabled, stopped, disabled,
 *       byClass: { A, B, C, D, E }
 *     }
 *   }
 *
 * Publication policy:
 *   - Periodic tick every TICK_INTERVAL_MS (5s) when subscribers exist
 *   - Immediate re-publish on process-exit hook (any chain dies)
 *   - De-duped against last snapshot: identical content is not re-sent
 *     (saves wire frames; clients can rely on receiving a frame only
 *     when something actually changed)
 *
 * Cache:
 *   - getCachedSnapshot() returns the last-built snapshot for the
 *     GET /api/enm/council/overview initial-fetch endpoint (M2.3
 *     hydrates the pane before SSE delivers the first delta).
 */

'use strict';

const { ENM_LOG_PREFIX } = require('./EnmConstants');
const ConfigStore = require('./ConfigStore');

const TICK_INTERVAL_MS = 5_000;
const STARTUP_GRACE_SEC = 60;
const SSE_TOPIC = 'council:overview';

class CouncilOverviewService {
    /**
     * @param {object} deps
     * @param {object} deps.extensionHandle  PC2 extension handle (for log)
     * @param {object} deps.registry         ChainRegistry singleton
     * @param {object} deps.sseHub           SseHub for publishing
     */
    constructor(deps) {
        if (!deps || !deps.extensionHandle || !deps.registry || !deps.sseHub) {
            throw new TypeError(
                'CouncilOverviewService: { extensionHandle, registry, sseHub } required',
            );
        }
        this.extensionHandle = deps.extensionHandle;
        this.registry = deps.registry;
        this.sseHub = deps.sseHub;
        this.log = deps.extensionHandle.log || console;
        this._tickHandle = null;
        this._lastSnapshot = null;
        this._started = false;
        this._exitHook = null;
    }

    /**
     * Start the periodic publish loop + register the exit hook on
     * NativeProcessService. Idempotent.
     */
    start() {
        if (this._started) { return; }
        this._started = true;
        this._tickHandle = setInterval(() => { this._tickOnce(); }, TICK_INTERVAL_MS);
        if (typeof this._tickHandle.unref === 'function') {
            this._tickHandle.unref();
        }
        // Publish the first snapshot immediately so subscribers connecting
        // before the first tick get fresh state.
        setImmediate(() => { this._tickOnce(); });
        // Re-publish on any chain exit so the overview reacts within
        // ~10ms of the death signal (vs up to TICK_INTERVAL_MS).
        try {
            const proc = this.registry.getProcessService();
            if (proc && typeof proc.on === 'function') {
                this._exitHook = (evt) => {
                    const cId = (evt && evt.chainId) || '?';
                    this.log.debug(
                        `${ENM_LOG_PREFIX} council:overview: exit signal `
                        + `from ${cId} — re-publishing`,
                    );
                    this._tickOnce();
                };
                proc.on('exit', this._exitHook);
            }
        } catch (err) {
            this.log.debug(
                `${ENM_LOG_PREFIX} council:overview: exit-hook registration `
                + `failed (non-fatal): ${err.message}`,
            );
        }
    }

    /**
     * Stop the periodic loop + unregister the exit hook. Idempotent.
     */
    stop() {
        if (!this._started) { return; }
        this._started = false;
        if (this._tickHandle) {
            clearInterval(this._tickHandle);
            this._tickHandle = null;
        }
        if (this._exitHook) {
            try {
                const proc = this.registry.getProcessService();
                if (proc && typeof proc.off === 'function') {
                    proc.off('exit', this._exitHook);
                } else if (proc && typeof proc.removeListener === 'function') {
                    proc.removeListener('exit', this._exitHook);
                }
            } catch (_) { /* idempotent */ }
            this._exitHook = null;
        }
    }

    /**
     * Build a fresh snapshot from the cheap sources. Async only because
     * ConfigStore.load() is async (it reads the cfg file once with a
     * small in-process cache).
     *
     * @returns {Promise<object>} snapshot payload
     */
    async build() {
        let cfg = { chains: {} };
        try {
            cfg = await ConfigStore.load();
        } catch (err) {
            this.log.debug(
                `${ENM_LOG_PREFIX} council:overview: ConfigStore.load failed `
                + `(${err.message}); rendering chains as unconfigured`,
            );
            cfg = { chains: {} };
        }
        const chainsCfg = (cfg && cfg.chains) || {};
        let proc = null;
        try { proc = this.registry.getProcessService(); }
        catch (_) { proc = null; }

        const list = this.registry.listChains();
        const items = list.map((meta) => {
            return buildChainEntry({
                meta,
                chainCfg: chainsCfg[meta.chainId] || null,
                proc,
                log: this.log,
            });
        });

        const totals = aggregateTotals(items);

        return {
            ts: Date.now(),
            chains: items,
            totals,
        };
    }

    /**
     * Returns the most recently published snapshot, or null if no tick
     * has run yet. Used by the GET /api/enm/council/overview endpoint
     * so M2.3's pane can hydrate before the first SSE frame lands.
     *
     * @returns {object|null}
     */
    getCachedSnapshot() {
        return this._lastSnapshot;
    }

    /**
     * Force a tick now (used by chain-mutation routes like /start, /stop
     * to push an overview update without waiting up to TICK_INTERVAL_MS).
     * Returns the snapshot built. Always safe to call — internal errors
     * are logged + swallowed.
     *
     * @returns {Promise<object|null>}
     */
    async triggerPublish() {
        return this._tickOnce();
    }

    /** @private */
    async _tickOnce() {
        let snap = null;
        try {
            snap = await this.build();
        } catch (err) {
            this.log.warn(`${ENM_LOG_PREFIX} council:overview build failed: ${err.message}`);
            return null;
        }
        // Always update cache even if no subscribers; GET endpoint
        // reads the cache so it should be current.
        this._lastSnapshot = snap;
        const subs = (typeof this.sseHub.subscriberCount === 'function')
            ? this.sseHub.subscriberCount(SSE_TOPIC) : 0;
        if (subs === 0) {
            return snap;
        }
        // De-dupe: only push if anything changed since the last push.
        // shallowEqualSnap intentionally ignores the timestamp + uptime
        // so seconds-ticking-up doesn't flood SSE; clients can show
        // "as of <ts>" from the last received frame.
        if (this._lastPublished && shallowEqualSnap(this._lastPublished, snap)) {
            return snap;
        }
        this._lastPublished = snap;
        try {
            this.sseHub.publish(SSE_TOPIC, snap);
        } catch (err) {
            this.log.debug(
                `${ENM_LOG_PREFIX} council:overview publish failed `
                + `(non-fatal): ${err.message}`,
            );
        }
        return snap;
    }
}

/**
 * Build a single chain entry. Pure: takes everything as input + returns
 * a fresh object. Exported via _internal for unit tests.
 *
 * @param {object} args
 * @param {object} args.meta       ChainRegistry.listChains() entry
 * @param {object|null} args.chainCfg  cfg.chains[id] or null
 * @param {object|null} args.proc  NativeProcessService instance
 * @param {object} args.log
 * @returns {object} chain entry
 */
function buildChainEntry(args) {
    const { meta, chainCfg, proc, log } = args;
    const cId = meta.chainId;
    let st = null;
    try {
        st = proc ? proc.statusSync(cId) : null;
    } catch (err) {
        log.debug(
            `${ENM_LOG_PREFIX} council:overview: statusSync(${cId}) failed: ${err.message}`,
        );
        st = null;
    }
    const alive = !!(st && st.alive);
    const pid = alive ? (st.pid || null) : null;
    const attached = alive ? !!st.attached : false;
    let uptimeSec = null;
    if (alive) {
        // Read meta sidecar for startedAt → uptime. Best-effort; missing
        // file is normal for chains that crashed before writing meta.
        try {
            // Lazy require so unit tests that mock fs don't have to mock
            // processUtils too — only the meta-read path needs it.
            const fs = require('node:fs');
            const { metaFilePath } = require('./processUtils');
            const buf = fs.readFileSync(metaFilePath(cId), 'utf8');
            const m = JSON.parse(buf);
            if (m && typeof m.startedAt === 'number') {
                uptimeSec = Math.max(0, Math.floor((Date.now() - m.startedAt) / 1000));
            }
        } catch (_) { /* uptime stays null */ }
    }
    const state = coarseState({
        alive,
        chainCfg,
        uptimeSec,
    });
    return {
        chainId: cId,
        displayName: meta.displayName,
        chainClass: meta.chainClass,
        parentChainId: meta.parentChainId,
        enabled: chainCfg ? !!chainCfg.enabled : false,
        alive,
        pid,
        attached,
        uptimeSec,
        state,
    };
}

/**
 * Cheap state classifier — no RPC. The richer per-chain endpoint
 * (`GET /api/enm/chains/<id>`) does the full healthy/syncing/stalled
 * analysis; overview uses these coarse buckets:
 *
 *   - unconfigured: no cfg entry (chain not set up)
 *   - disabled:     cfg present, operator-disabled (enabled=false)
 *   - stopped:      cfg.enabled=true, process not alive
 *   - starting:     process alive, uptime < 60s (RPC may not be bound yet)
 *   - running:      process alive, uptime ≥ 60s (sync state unknown here)
 *
 * The frontend overview pane can show a yellow/green dot per state.
 * Clicking the row routes to the per-chain pane which renders the
 * full coarse state from /api/enm/chains/<id>.
 *
 * @param {object} args
 * @param {boolean} args.alive
 * @param {object|null} args.chainCfg
 * @param {number|null} args.uptimeSec
 * @returns {string}
 */
function coarseState(args) {
    const { alive, chainCfg, uptimeSec } = args;
    if (!chainCfg) { return 'unconfigured'; }
    if (!alive) { return chainCfg.enabled ? 'stopped' : 'disabled'; }
    if (typeof uptimeSec === 'number' && uptimeSec < STARTUP_GRACE_SEC) {
        return 'starting';
    }
    return 'running';
}

/**
 * Aggregate totals across the chains array.
 *
 * @param {object[]} items
 * @returns {object}
 */
function aggregateTotals(items) {
    const totals = {
        total: items.length,
        running: 0,
        enabled: 0,
        stopped: 0,
        disabled: 0,
        byClass: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    };
    for (const it of items) {
        if (it.alive) totals.running += 1;
        if (it.enabled) totals.enabled += 1;
        if (it.enabled && !it.alive) totals.stopped += 1;
        if (!it.enabled) totals.disabled += 1;
        if (it.chainClass && totals.byClass[it.chainClass] !== undefined) {
            totals.byClass[it.chainClass] += 1;
        }
    }
    return totals;
}

/**
 * Deep-compare two snapshots minus the volatile fields (ts + uptimeSec).
 * Used by _tickOnce to suppress wire frames when nothing operator-
 * visible changed (uptime ticking up alone isn't actionable; the
 * frontend computes uptime client-side from the last frame's ts +
 * its own clock).
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function shallowEqualSnap(a, b) {
    if (!a || !b) { return false; }
    if (!Array.isArray(a.chains) || !Array.isArray(b.chains)) { return false; }
    if (a.chains.length !== b.chains.length) { return false; }
    for (let i = 0; i < a.chains.length; i += 1) {
        const x = a.chains[i];
        const y = b.chains[i];
        if (!x || !y) { return false; }
        if (x.chainId !== y.chainId) { return false; }
        if (x.alive !== y.alive) { return false; }
        if (x.enabled !== y.enabled) { return false; }
        if (x.state !== y.state) { return false; }
        if (x.pid !== y.pid) { return false; }
        if (x.attached !== y.attached) { return false; }
    }
    if (!a.totals || !b.totals) { return false; }
    if (a.totals.total !== b.totals.total) { return false; }
    if (a.totals.running !== b.totals.running) { return false; }
    if (a.totals.enabled !== b.totals.enabled) { return false; }
    if (a.totals.stopped !== b.totals.stopped) { return false; }
    if (a.totals.disabled !== b.totals.disabled) { return false; }
    return true;
}

module.exports = {
    CouncilOverviewService,
    SSE_TOPIC,
    TICK_INTERVAL_MS,
    STARTUP_GRACE_SEC,
    // Exported for unit tests
    _internal: {
        buildChainEntry,
        coarseState,
        aggregateTotals,
        shallowEqualSnap,
    },
};
