/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/height-series.js — client for the chain-card sparkline data.
 *
 * Singleton service that wraps two data sources:
 *
 *   1. Initial bootstrap + periodic full refresh
 *      GET /api/enm/chains/<id>/history?windowMin=60
 *      Returns a decimated ~12-point series. Called on first subscribe
 *      and every 5 minutes as a fallback in case SSE has dropped.
 *
 *   2. Incremental updates over SSE
 *      Topic: chains:<id>:height
 *      Payload: { chainId, point: { t, h } }
 *      HealthChecker._mediumTick publishes when a fresh height lands
 *      in HeightSeriesStore (flat-front ticks don't publish).
 *
 * Multiplexing: one subscription per chainId, fan-out to N listeners.
 * The first listener bootstraps the buffer; the last unsubscribe tears
 * down the SSE subscription + the fallback poll.
 *
 * Listeners receive a snapshot array on every change. The component
 * (chain-card) re-renders its sparkline on each callback.
 *
 * NOT a singleton in the strict sense — instantiated once by app.js and
 * shared via services.heightSeries. Lifetime tied to _showDashboard.
 */

(function (root) {
    'use strict';

    // Match the server-side default window.
    var WINDOW_MIN = 60;
    // 5-min refresh covers the case where SSE was disconnected (tab
    // backgrounded, network drop, server restart). Cheap call.
    var POLL_FALLBACK_MS = 5 * 60 * 1000;

    function HeightSeriesClient(api, sse) {
        if (!api) throw new TypeError('HeightSeriesClient: api required');
        this.api = api;
        this.sse = sse || null; // SSE is optional — degrades to poll-only
        /** @type {Map<string, Array<{t:number,h:number}>>} */
        this._buffers = new Map();
        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
        /** @type {Map<string, { unsub: Function|null, intervalId: number }>} */
        this._wirings = new Map();
    }

    /**
     * Subscribe a callback to the height series for one chain. The
     * callback is invoked synchronously with the current buffer (if
     * any) and then on every subsequent change.
     *
     * @param {string} chainId
     * @param {(points: Array<{t:number,h:number}>) => void} cb
     * @returns {() => void} unsubscribe
     */
    HeightSeriesClient.prototype.subscribe = function (chainId, cb) {
        if (typeof cb !== 'function') return function () {};
        var self = this;
        var set = this._listeners.get(chainId);
        if (!set) { set = new Set(); this._listeners.set(chainId, set); }
        set.add(cb);
        if (set.size === 1) this._bootstrap(chainId);
        var snap = this._buffers.get(chainId);
        if (snap) {
            try { cb(snap.slice()); } catch (_) { /* swallow */ }
        }
        return function unsubscribe() {
            var s = self._listeners.get(chainId);
            if (!s) return;
            s.delete(cb);
            if (s.size === 0) self._teardown(chainId);
        };
    };

    /** @private */
    HeightSeriesClient.prototype._bootstrap = function (chainId) {
        var self = this;
        // Fetch the latest snapshot. On success, replace the local
        // buffer (server-side decimation owns the shape). On failure,
        // keep whatever we have — never reset to empty on a transient
        // error, that would erase the sparkline mid-tab.
        this.api.get('/chains/' + encodeURIComponent(chainId) + '/history?windowMin=' + WINDOW_MIN)
            .then(function (res) {
                var pts = (res && Array.isArray(res.points)) ? res.points : [];
                self._buffers.set(chainId, pts);
                self._broadcast(chainId);
            })
            .catch(function () {
                // First bootstrap — seed empty so the sparkline component
                // can render its "no data" state cleanly.
                if (!self._buffers.has(chainId)) self._buffers.set(chainId, []);
                self._broadcast(chainId);
            });

        // SSE delta — push new points as HealthChecker records them.
        var unsub = null;
        if (this.sse && typeof this.sse.subscribe === 'function') {
            unsub = this.sse.subscribe('chains:' + chainId + ':height', function (payload) {
                if (!payload || !payload.point) return;
                if (typeof payload.point.t !== 'number'
                    || typeof payload.point.h !== 'number') return;
                var buf = self._buffers.get(chainId) || [];
                var last = buf[buf.length - 1];
                // Drop out-of-order / dupes — server already filters but
                // a reconnect can replay one.
                if (last && payload.point.t <= last.t) return;
                buf.push(payload.point);
                // Trim to a 60-min window client-side too. Decimation
                // happens at render time in the Sparkline component.
                var cutoff = Date.now() - WINDOW_MIN * 60_000;
                while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
                self._buffers.set(chainId, buf);
                self._broadcast(chainId);
            });
        }

        // Periodic full refresh — covers SSE reconnect gaps and a tab
        // backgrounded for hours.
        var intervalId = setInterval(function () {
            self._bootstrap(chainId);
        }, POLL_FALLBACK_MS);

        this._wirings.set(chainId, { unsub: unsub, intervalId: intervalId });
    };

    /** @private */
    HeightSeriesClient.prototype._teardown = function (chainId) {
        var w = this._wirings.get(chainId);
        if (w) {
            if (typeof w.unsub === 'function') {
                try { w.unsub(); } catch (_) { /* swallow */ }
            }
            clearInterval(w.intervalId);
        }
        this._wirings.delete(chainId);
        this._listeners.delete(chainId);
        this._buffers.delete(chainId);
    };

    /** @private */
    HeightSeriesClient.prototype._broadcast = function (chainId) {
        var set = this._listeners.get(chainId);
        if (!set) return;
        var snap = (this._buffers.get(chainId) || []).slice();
        set.forEach(function (cb) {
            try { cb(snap); } catch (_) { /* swallow — one bad listener
                shouldn't poison the others */ }
        });
    };

    /**
     * Tear down everything. Called from app._teardownHomeView when the
     * dashboard remounts (setup completion, fresh-install flow).
     */
    HeightSeriesClient.prototype.destroy = function () {
        var self = this;
        Array.from(this._listeners.keys()).forEach(function (chainId) {
            self._teardown(chainId);
        });
    };

    root.EnmHeightSeriesClient = HeightSeriesClient;
}(typeof window !== 'undefined' ? window : globalThis));
