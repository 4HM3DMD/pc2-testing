/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * SseHub — Server-Sent Events fan-out by topic.
 *
 * Why SSE not WebSocket?
 *   PC2's WebSocket helpers (broadcastToUser, room-based fan-out) are NOT
 *   exposed to extensions in v0.1 (verified Rev 7 audit). SSE works over plain
 *   HTTP, no Socket.io permissions needed. Browsers auto-reconnect via the
 *   built-in EventSource API. Trade-off: server→client only — but that's all
 *   the dashboard needs (logs + status + notifications all push-only).
 *
 * Topics:
 *   system                      → CPU/RAM/disk snapshots
 *   chains:<chainId>:status     → coarse state changes
 *   chains:<chainId>:logs       → per-line log batches
 *   notifications               → toast + banner messages
 *
 * Wire format: standard SSE frames with `event:` and `data:` fields.
 *   event: <topic>
 *   id: <monotonic counter>
 *   data: <JSON-encoded payload>
 *   <blank line>
 *
 * Heartbeat: `event: enm:heartbeat\n…` SSE frame every 25s. Two jobs:
 *   (a) bytes-on-wire keep reverse proxies (nginx, Cloudflare) from
 *       killing idle connections — same effect as the old comment-line
 *       heartbeat, just visible to JavaScript.
 *   (b) clients can listen for the event to detect zombie sockets where
 *       TCP stays open but no data flows (server hung, proxy<>server
 *       link dead). Pre-0.5.104 the heartbeat was a comment line which
 *       SSE deliberately discards before reaching browser JS, so the
 *       client had no signal of a frozen-but-connected server and
 *       state pills showed "open" forever.
 */

'use strict';

const { ENM_LOG_PREFIX } = require('./EnmConstants');

const HEARTBEAT_MS = 25_000;
const SUBSCRIBE_LIMIT_PER_RESPONSE = 16;

class SseHub {
    /**
     * @param {object} deps
     * @param {object} deps.extensionHandle
     */
    constructor(deps) {
        if (!deps || !deps.extensionHandle) {
            throw new TypeError('SseHub: { extensionHandle } required');
        }
        this.extensionHandle = deps.extensionHandle;

        /** @type {Map<string, Set<import('express').Response>>} */
        this.subscribers = new Map();

        /** @type {Map<import('express').Response, { topics: Set<string>, walletAddress: string|null }>} */
        this.connections = new Map();

        /**
         * Monotonic event id. Emitted as the SSE `id:` field so clients
         * see a strictly-increasing sequence across all publishes from
         * one process. v0.5.104: ids let CLIENTS detect gaps after a
         * reconnect (compare last-seen id to first id after reconnect)
         * but the route handler does NOT honor `Last-Event-ID` for
         * server-side replay — events published during a disconnect
         * window are not buffered or re-delivered. If durable replay is
         * needed in future, hook the buffer here and read the header
         * in routes/events.js. Counter resets on process restart.
         */
        this.eventId = 0;

        this._heartbeat = setInterval(() => this._sendHeartbeats(), HEARTBEAT_MS);
        if (typeof this._heartbeat.unref === 'function') {
            this._heartbeat.unref();
        }
    }

    /**
     * Attach an Express response to one or more topics. The response remains
     * open until the client disconnects (browser closes tab, network drop) or
     * we shut down (close()).
     *
     * @param {import('express').Response} res
     * @param {object} opts
     * @param {string[]} opts.topics
     * @param {string|null} [opts.walletAddress]
     */
    subscribe(res, opts) {
        if (!res || typeof res.write !== 'function') {
            throw new TypeError('SseHub.subscribe: res required');
        }
        const topics = Array.isArray(opts && opts.topics) ? opts.topics : [];
        if (topics.length === 0 || topics.length > SUBSCRIBE_LIMIT_PER_RESPONSE) {
            throw new RangeError(
                `SseHub.subscribe: must request 1..${SUBSCRIBE_LIMIT_PER_RESPONSE} topics`,
            );
        }
        for (const t of topics) {
            if (typeof t !== 'string' || !/^[a-z0-9:-]+$/.test(t)) {
                throw new TypeError(`SseHub.subscribe: invalid topic "${t}"`);
            }
        }

        // SSE response headers — `text/event-stream` triggers EventSource on the
        // browser side. `Cache-Control: no-cache` prevents proxies from buffering.
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // Disable nginx buffering if PC2 ever lives behind it.
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders && res.flushHeaders();

        // Greet the client so they know the connection succeeded immediately.
        res.write(`: connected ${new Date().toISOString()}\n\n`);

        const subscription = {
            topics: new Set(topics),
            walletAddress: (opts && opts.walletAddress) || null,
        };
        this.connections.set(res, subscription);

        for (const t of topics) {
            let set = this.subscribers.get(t);
            if (!set) {
                set = new Set();
                this.subscribers.set(t, set);
            }
            set.add(res);
        }

        // Disconnect cleanup. close = client closed; finish = we ended.
        const cleanup = () => this._unsubscribe(res);
        res.on('close', cleanup);
        res.on('error', cleanup);
    }

    /**
     * Push a payload to every response subscribed to `topic`.
     *
     * @param {string} topic
     * @param {object|string} data  serialized as JSON if not already a string
     */
    publish(topic, data) {
        const subs = this.subscribers.get(topic);
        if (!subs || subs.size === 0) {
            return;
        }
        const id = ++this.eventId;
        const payload = (typeof data === 'string') ? data : JSON.stringify(data);
        // Pre-format the SSE frame once; re-use for every subscriber.
        const frame = `event: ${topic}\nid: ${id}\ndata: ${payload}\n\n`;

        for (const res of subs) {
            try {
                res.write(frame);
            } catch (err) {
                // Broken pipe / write after end — drop the subscriber. cleanup
                // below removes them properly on the next tick.
                this.extensionHandle.log.debug(
                    `${ENM_LOG_PREFIX} SseHub.publish: subscriber write failed: ${err.message}`,
                );
                this._unsubscribe(res);
            }
        }
    }

    /**
     * Push a payload to subscribers matching a wallet address. Used for
     * healing notifications which carry proposalIds: leaking proposalIds
     * cross-wallet would let one operator confirm another operator's
     * proposals (Phase 4 audit, agent 2).
     *
     * Subscribers without a recorded wallet (anonymous SSE — shouldn't happen
     * in production since /events requires auth, but defensive) are skipped.
     *
     * Address comparison is exact-match here: callers normalize EVM addresses
     * to lowercase before passing in. The compare cost stays O(subscribers
     * for topic), no extra index needed.
     *
     * @param {string} walletAddress
     * @param {string} topic
     * @param {object|string} data
     */
    publishToWallet(walletAddress, topic, data) {
        if (!walletAddress) {
            return; // No-op: a missing wallet means no one is the intended recipient.
        }
        const subs = this.subscribers.get(topic);
        if (!subs || subs.size === 0) {
            return;
        }
        const id = ++this.eventId;
        const payload = (typeof data === 'string') ? data : JSON.stringify(data);
        const frame = `event: ${topic}\nid: ${id}\ndata: ${payload}\n\n`;

        for (const res of subs) {
            const sub = this.connections.get(res);
            if (!sub || !sub.walletAddress || sub.walletAddress !== walletAddress) {
                continue;
            }
            try {
                res.write(frame);
            } catch (err) {
                this.extensionHandle.log.debug(
                    `${ENM_LOG_PREFIX} SseHub.publishToWallet: subscriber write failed: ${err.message}`,
                );
                this._unsubscribe(res);
            }
        }
    }

    /**
     * Number of currently-connected responses (for monitoring / tests).
     */
    connectionCount() {
        return this.connections.size;
    }

    /**
     * Number of subscribers for a given topic.
     *
     * @param {string} topic
     * @returns {number}
     */
    subscriberCount(topic) {
        const set = this.subscribers.get(topic);
        return set ? set.size : 0;
    }

    /**
     * Tear down all subscribers — used on extension shutdown so we don't
     * leak open responses.
     */
    close() {
        clearInterval(this._heartbeat);
        for (const res of this.connections.keys()) {
            try { res.end(); } catch (_) { /* swallow */ }
        }
        this.connections.clear();
        this.subscribers.clear();
    }

    /** @private */
    _unsubscribe(res) {
        const sub = this.connections.get(res);
        if (!sub) {
            return;
        }
        for (const topic of sub.topics) {
            const set = this.subscribers.get(topic);
            if (!set) continue;
            set.delete(res);
            if (set.size === 0) {
                this.subscribers.delete(topic);
            }
        }
        this.connections.delete(res);
    }

    /**
     * @private
     * v0.5.104 — emit an explicit `event: enm:heartbeat` SSE frame
     * instead of the pre-0.5.104 comment-line `:heartbeat`. The comment
     * was invisible to browser JS (SSE protocol strips colon-prefixed
     * lines before dispatching), so clients had no way to detect a
     * frozen-but-TCP-alive server. The explicit event lets the client
     * watchdog (services/sse.js _watchdogTimer) force a reconnect when
     * >60s elapses without any frame — covering the
     * hung-server / dead-proxy scenarios EventSource.onerror doesn't
     * catch on its own. Still keeps reverse proxies happy because the
     * bytes flow.
     *
     * Broadcast to every connection regardless of topic subscription —
     * this is connection-level liveness, not a topic event.
     */
    _sendHeartbeats() {
        const now = Date.now();
        const id = ++this.eventId;
        const frame = `event: enm:heartbeat\nid: ${id}\ndata: ${now}\n\n`;
        for (const res of this.connections.keys()) {
            try {
                res.write(frame);
            } catch (_) {
                this._unsubscribe(res);
            }
        }
    }
}

module.exports = {
    SseHub,
    HEARTBEAT_MS,
    SUBSCRIBE_LIMIT_PER_RESPONSE,
};
