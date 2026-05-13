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
    // alpha.28.1 batch 56 — reconnect attempt cap. 12 attempts at
    // exponential backoff (10s, 20s, 40s, 60s × 9 more) ≈ 12 min of
    // retries before giving up. Matches audit a1612c10's "cap at e.g.
    // 6 in 60s, then back off to 60s intervals" but with a longer
    // total horizon since the operator may legitimately be on a slow
    // recovering network.
    var MAX_RECONNECT_ATTEMPTS = 12;

    /**
     * Browser EventSource can't send Authorization headers. Read the
     * same operator-session token api.js derives (from the iframe URL's
     * ?puter.auth.token= / ?auth_token= / ?token= params) and append it
     * to every events-stream URL so the backend's extractToken() picks
     * it up. Without this, alpha.12 fixed the URL but every subscribe
     * returned 401 because the request reached ENM without credentials.
     */
    function deriveToken() {
        var loc = root.location || {};
        var search = loc.search || '';
        var params;
        try { params = new URLSearchParams(search); }
        catch (_) { return null; }
        return params.get('puter.auth.token')
            || params.get('auth_token')
            || params.get('token')
            || null;
    }
    var AUTH_TOKEN = deriveToken();

    function EnmSse() {
        this._es = null;
        this._topics = new Set();           // subscribed topic names
        this._handlers = new Map();         // topic → Set<callback>
        this._stateHandlers = new Set();    // for 'open' / 'reconnecting' / 'closed'
        this._openTimer = null;
        this._connectAttempts = 0;
        // alpha.28.1 batch 21 — debounce flag for _scheduleReconnect.
        // The race-conditions audit (aaf1f87d B2) found that every
        // subscribe/unsubscribe used to trigger a full _reconnect
        // synchronously: close socket + reopen with the new topic list.
        // App boot fires ~10 subscribes consecutively (chain-card +
        // log-viewer + height-series + system-status + validator-card +
        // notifications + ...), so the EventSource got closed + recreated
        // 10 times before the first onopen landed. The race window between
        // close+recreate dropped any event the previous socket was holding.
        // This flag batches all sub/unsub deltas in the same microtask
        // into ONE reconnect at the end of the tick.
        this._reconnectScheduled = false;
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
        // (Re)connect with the new topic list. _scheduleReconnect
        // batches multiple subscribe/unsubscribe calls in the same
        // microtask into ONE network reconnect.
        this._scheduleReconnect();
        var self = this;
        return function unsubscribe() {
            var s = self._handlers.get(topic);
            if (s) {
                s.delete(cb);
                if (s.size === 0) {
                    self._handlers.delete(topic);
                    self._topics.delete(topic);
                    self._scheduleReconnect();
                }
            }
        };
    };

    /**
     * @private
     * Debounce the actual reconnect so back-to-back subscribe()/unsubscribe()
     * calls in the same tick collapse into one socket recreation. Uses a
     * microtask via Promise.resolve so the batching window is "this tick",
     * which is exactly what we want — no operator-visible delay, no
     * arbitrary setTimeout(0) lag.
     */
    EnmSse.prototype._scheduleReconnect = function () {
        if (this._reconnectScheduled) { return; }
        this._reconnectScheduled = true;
        var self = this;
        Promise.resolve().then(function () {
            self._reconnectScheduled = false;
            self._reconnect();
        });
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

    /**
     * Manually reset the reconnect-attempts counter and try once more.
     * Wired to the error-pane Retry button so an operator can recover
     * from a 'closed' state without a full page reload after a long
     * outage. Batch 56.
     */
    EnmSse.prototype.retry = function () {
        this._connectAttempts = 0;
        if (this._topics.size > 0) {
            this._scheduleReconnect();
        }
    };

    /** @private */
    EnmSse.prototype._reconnect = function () {
        this._closeNative();
        if (this._topics.size === 0) {
            return;
        }

        var qsParts = Array.from(this._topics).map(function (t) {
            return 'topic=' + encodeURIComponent(t);
        });
        // alpha.13: include the operator's session token as a query param.
        // EventSource can't send Authorization headers, so the backend
        // reads the token from ?token= via extractToken() — without this
        // every subscribe lands on the events route as anonymous and
        // returns 401.
        if (AUTH_TOKEN) {
            qsParts.push('token=' + encodeURIComponent(AUTH_TOKEN));
        }
        var url = ENDPOINT + '?' + qsParts.join('&');
        this._connectAttempts += 1;
        this._emitState('reconnecting');

        var es = new EventSource(url, { withCredentials: true });
        var self = this;

        // Defensive: if onopen doesn't fire within OPEN_TIMEOUT_MS, treat as a
        // failure and let the browser restart the connection itself (we just
        // close + recreate so we don't sit on a half-open socket).
        //
        // alpha.28.1 batch 56 (Round-8 audit a1612c10) — exponential
        // backoff replaces the previous "retry every 10s forever"
        // pattern. A corporate proxy stripping text/event-stream
        // hammered enm-server every 10s indefinitely; now retries
        // backoff 10s → 20s → 40s → 60s (capped). Emits 'closed' state
        // after MAX_RECONNECT_ATTEMPTS so chain-card / log-viewer pills
        // can surface the give-up state instead of "reconnecting…"
        // forever.
        var backoffMs;
        if (self._connectAttempts <= 1) {
            backoffMs = OPEN_TIMEOUT_MS;
        } else {
            // exponential: 10, 20, 40, then cap at 60s.
            backoffMs = Math.min(OPEN_TIMEOUT_MS * Math.pow(2, self._connectAttempts - 1), 60_000);
        }
        this._openTimer = setTimeout(function () {
            self._closeNative();
            if (self._connectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                // Give up loud — the consumer (log-viewer pill, chain-
                // card reconnect badge) can render a give-up state
                // rather than the "reconnecting…" lie. The operator
                // can manually trigger a recovery via the Retry
                // button in the error pane (batch 13).
                self._emitState('closed');
                return;
            }
            self._reconnect();
        }, backoffMs);

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
