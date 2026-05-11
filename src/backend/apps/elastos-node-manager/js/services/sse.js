/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/sse.js — EventSource wrapper for the /api/enm/events endpoint.
 *
 * Browser EventSource auto-reconnects with the Last-Event-ID header (matches
 * our SseHub's monotonic id). We add:
 *   - Topic-aware subscription API (subscribe('chains:mainchain:logs', cb))
 *   - Connection-state events (open / closed / reconnecting) for UI feedback
 *   - Defensive recreation if EventSource never fires onopen within 10s
 *
 * alpha.12 — the ENDPOINT was hard-coded to a Puter-extension legacy path
 * (`/extensions/elastos-node-manager/api/events`) that doesn't exist now
 * that ENM is a standalone service-type app on its own port. Any consumer
 * relying on SSE (Card B2's bootstrap progress, log viewer's live tail
 * reconnect signal) silently failed because the URL resolved to an HTML
 * 404 instead of text/event-stream. We now derive the same backend base
 * as api.js (root.ENM_API_BASE → http://<host>:4180/api/enm) and append
 * /events, so SSE and REST point at the same place.
 */

(function (root) {
    'use strict';

    // root.ENM_API_BASE is set by services/api.js at load time. Falling
    // back to the legacy path keeps the older proxied deploy working
    // until everyone is on the standalone service-app layout.
    var ENDPOINT = (root.ENM_API_BASE ? root.ENM_API_BASE + '/events'
                                      : '/extensions/elastos-node-manager/api/events');
    var OPEN_TIMEOUT_MS = 10_000;

    function EnmSse() {
        this._es = null;
        this._topics = new Set();           // subscribed topic names
        this._handlers = new Map();         // topic → Set<callback>
        this._stateHandlers = new Set();    // for 'open' / 'reconnecting' / 'closed'
        this._openTimer = null;
        this._connectAttempts = 0;
    }

    /**
     * Add a subscription. The callback receives the parsed JSON payload for
     * each event on the topic. Returns an unsubscribe function.
     *
     * @param {string} topic
     * @param {(payload: object) => void} cb
     * @returns {() => void}
     */
    EnmSse.prototype.subscribe = function (topic, cb) {
        if (typeof topic !== 'string' || typeof cb !== 'function') {
            throw new TypeError('EnmSse.subscribe: (topic, cb) required');
        }
        this._topics.add(topic);
        var set = this._handlers.get(topic);
        if (!set) {
            set = new Set();
            this._handlers.set(topic, set);
        }
        set.add(cb);
        // (Re)connect with the new topic list.
        this._reconnect();
        var self = this;
        return function unsubscribe() {
            var s = self._handlers.get(topic);
            if (s) {
                s.delete(cb);
                if (s.size === 0) {
                    self._handlers.delete(topic);
                    self._topics.delete(topic);
                    self._reconnect();
                }
            }
        };
    };

    /**
     * Subscribe to connection state changes. Receives 'open' | 'reconnecting' | 'closed'.
     */
    EnmSse.prototype.onState = function (cb) {
        if (typeof cb !== 'function') {
            throw new TypeError('EnmSse.onState: cb required');
        }
        this._stateHandlers.add(cb);
        var self = this;
        return function () { self._stateHandlers.delete(cb); };
    };

    EnmSse.prototype.close = function () {
        this._closeNative();
        this._topics.clear();
        this._handlers.clear();
        this._emitState('closed');
    };

    /** @private */
    EnmSse.prototype._reconnect = function () {
        this._closeNative();
        if (this._topics.size === 0) {
            return;
        }

        var qs = Array.from(this._topics)
            .map(function (t) { return 'topic=' + encodeURIComponent(t); })
            .join('&');
        var url = ENDPOINT + '?' + qs;
        this._connectAttempts += 1;
        this._emitState('reconnecting');

        var es = new EventSource(url, { withCredentials: true });
        var self = this;

        // Defensive: if onopen doesn't fire within OPEN_TIMEOUT_MS, treat as a
        // failure and let the browser restart the connection itself (we just
        // close + recreate so we don't sit on a half-open socket).
        this._openTimer = setTimeout(function () {
            self._closeNative();
            self._reconnect();
        }, OPEN_TIMEOUT_MS);

        es.onopen = function () {
            clearTimeout(self._openTimer);
            self._openTimer = null;
            self._connectAttempts = 0;
            self._emitState('open');
        };
        es.onerror = function () {
            // Browser auto-retries on its own; we just surface the state
            // transition. Don't close the EventSource — that disables retry.
            self._emitState('reconnecting');
        };
        // Register a listener per subscribed topic. SSE 'event:' field values
        // map to addEventListener names exactly.
        this._topics.forEach(function (topic) {
            es.addEventListener(topic, function (ev) {
                var payload;
                try { payload = JSON.parse(ev.data); } catch (e) { payload = ev.data; }
                var set = self._handlers.get(topic);
                if (!set) return;
                set.forEach(function (cb) {
                    try { cb(payload); } catch (handlerErr) {
                        // One handler throwing must not block the others.
                        if (root.console && console.error) {
                            console.error('EnmSse handler error on topic ' + topic + ':', handlerErr);
                        }
                    }
                });
            });
        });

        this._es = es;
    };

    /** @private */
    EnmSse.prototype._closeNative = function () {
        if (this._openTimer) {
            clearTimeout(this._openTimer);
            this._openTimer = null;
        }
        if (this._es) {
            try { this._es.close(); } catch (_) { /* swallow */ }
            this._es = null;
        }
    };

    /** @private */
    EnmSse.prototype._emitState = function (state) {
        this._stateHandlers.forEach(function (cb) {
            try { cb(state); } catch (_) { /* swallow */ }
        });
    };

    root.EnmSse = EnmSse;
}(typeof window !== 'undefined' ? window : globalThis));
