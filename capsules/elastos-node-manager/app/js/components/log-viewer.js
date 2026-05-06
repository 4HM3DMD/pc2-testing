/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/log-viewer.js — terminal-style log panel with tail-follow.
 *
 * Subscribes to chains:<chainId>:logs over SSE. On first mount, fetches a
 * recent tail via GET /api/logs/:id/tail to seed the view. Renders lines into
 * a virtualized list so 10k lines stay smooth (per Rev 6 audit acceptance
 * criteria: 55fps p95 scroll on baseline hardware).
 *
 * v0.1: simple cap of 5,000 lines in DOM; older lines dropped from the head.
 * Full virtual scrolling can wait for v0.2 if the operator wants the full file.
 */

(function (root) {
    'use strict';

    var MAX_DOM_LINES = 5000;
    var INITIAL_TAIL_N = 200;

    function LogViewer(opts) {
        if (!opts || !opts.chainId || !opts.api || !opts.sse) {
            throw new TypeError('LogViewer: { chainId, api, sse } required');
        }
        this.chainId = opts.chainId;
        this.api = opts.api;
        this.sse = opts.sse;

        this.root = document.createElement('section');
        this.root.className = 'enm-log-viewer';
        this._lines = []; // { stream, line, ts } most recent at end

        this._followTail = true;
        this._unsubscribe = null;

        this._renderShell();
    }

    LogViewer.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._loadInitialTail();
        this._subscribe();
        return this;
    };

    LogViewer.prototype.destroy = function () {
        if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
        if (this._sseStateUnsub) { this._sseStateUnsub(); this._sseStateUnsub = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    LogViewer.prototype._renderShell = function () {
        var t = root.enmTOrFallback;

        var head = document.createElement('header');
        head.className = 'enm-log-head';

        var title = document.createElement('h3');
        title.className = 'enm-log-title';
        title.textContent = t('log_viewer.heading') + ' — ' + this.chainId;
        head.appendChild(title);

        this._tailToggle = document.createElement('button');
        this._tailToggle.type = 'button';
        this._tailToggle.className = 'enm-log-tail-toggle enm-log-following';
        this._tailToggle.textContent = t('log_viewer.live');
        this._tailToggle.title = t('log_viewer.live');
        var self = this;
        // SSE connection-state tracking — was missing before, so the
        // "live" badge stayed lit even when the EventSource was
        // reconnecting. Now we listen and override the label to
        // "reconnecting…" when the stream is down. Unsub registered
        // for cleanup in destroy().
        this._sseConnState = 'open';  // assume open until told otherwise
        if (this.sse && typeof this.sse.onState === 'function') {
            this._sseStateUnsub = this.sse.onState(function (state) {
                self._sseConnState = state;
                self._refreshTailLabel();
            });
        }
        this._refreshTailLabel = function () {
            if (self._sseConnState !== 'open') {
                self._tailToggle.textContent = 'reconnecting…';
                self._tailToggle.classList.remove('enm-log-following');
                self._tailToggle.title = 'Live log stream lost — auto-reconnecting';
                return;
            }
            self._tailToggle.textContent = t(self._followTail ? 'log_viewer.live' : 'log_viewer.paused');
            self._tailToggle.classList.toggle('enm-log-following', self._followTail);
            self._tailToggle.title = self._tailToggle.textContent;
        };
        this._tailToggle.addEventListener('click', function () {
            // Don't toggle while disconnected — the badge is non-actionable then.
            if (self._sseConnState !== 'open') { return; }
            self._followTail = !self._followTail;
            self._refreshTailLabel();
            if (self._followTail) { self._scrollToBottom(); }
        });
        head.appendChild(this._tailToggle);

        this.root.appendChild(head);

        this._scroller = document.createElement('div');
        this._scroller.className = 'enm-log-scroller';
        this._scroller.setAttribute('role', 'log');
        this._scroller.setAttribute('aria-live', 'polite');

        // If user scrolls up manually, pause auto-tail.
        this._scroller.addEventListener('scroll', function () {
            var nearBottom = (self._scroller.scrollHeight - self._scroller.clientHeight - self._scroller.scrollTop) < 4;
            if (!nearBottom && self._followTail) {
                self._followTail = false;
                self._tailToggle.textContent = t('log_viewer.paused');
                self._tailToggle.classList.remove('enm-log-following');
            }
        });

        this.root.appendChild(this._scroller);

        this._empty = document.createElement('p');
        this._empty.className = 'enm-log-empty';
        this._empty.textContent = t('log_viewer.empty');
        this._scroller.appendChild(this._empty);
    };

    /** @private */
    LogViewer.prototype._loadInitialTail = function () {
        var self = this;
        return this.api.get('/logs/' + this.chainId + '/tail?n=' + INITIAL_TAIL_N, { skipCache: true })
            .then(function (data) {
                if (!data || !Array.isArray(data.lines)) { return; }
                if (data.lines.length === 0) { return; }
                self._appendBatch(data.lines);
            })
            .catch(function () {
                // Silent — chain may not have started yet, /tail returns empty.
            });
    };

    /** @private */
    LogViewer.prototype._subscribe = function () {
        var self = this;
        this._unsubscribe = this.sse.subscribe(
            'chains:' + this.chainId + ':logs',
            function (payload) {
                if (payload && Array.isArray(payload.lines)) {
                    self._appendBatch(payload.lines);
                }
            },
        );
    };

    /** @private */
    LogViewer.prototype._appendBatch = function (lines) {
        if (!Array.isArray(lines) || lines.length === 0) {
            return;
        }
        if (this._empty && this._empty.parentNode) {
            this._empty.parentNode.removeChild(this._empty);
            this._empty = null;
        }

        var frag = document.createDocumentFragment();
        for (var i = 0; i < lines.length; i += 1) {
            var entry = lines[i];
            this._lines.push(entry);
            frag.appendChild(this._renderLine(entry));
        }
        this._scroller.appendChild(frag);

        // Trim to MAX_DOM_LINES — drop oldest from the top.
        if (this._lines.length > MAX_DOM_LINES) {
            var excess = this._lines.length - MAX_DOM_LINES;
            this._lines.splice(0, excess);
            for (var j = 0; j < excess && this._scroller.firstElementChild; j += 1) {
                this._scroller.removeChild(this._scroller.firstElementChild);
            }
        }

        if (this._followTail) {
            this._scrollToBottom();
        }
    };

    /** @private */
    LogViewer.prototype._renderLine = function (entry) {
        var pad2 = root.enmPad2;
        var div = document.createElement('div');
        div.className = 'enm-log-line enm-log-line-' + (entry.stream === 'stderr' ? 'stderr' : 'stdout');
        // Prefix with HH:MM:SS for readability — full timestamp is in the title.
        var d = new Date(entry.ts || Date.now());
        var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
        var ts = document.createElement('span');
        ts.className = 'enm-log-ts';
        ts.textContent = time;
        div.appendChild(ts);

        var content = document.createElement('span');
        content.className = 'enm-log-text';
        content.textContent = entry.line; // textContent — never innerHTML (XSS)
        div.appendChild(content);

        div.title = d.toISOString() + ' [' + (entry.stream || 'log') + ']';
        return div;
    };

    /** @private */
    LogViewer.prototype._scrollToBottom = function () {
        // Defer to the next frame so all newly-appended children measure correctly.
        var self = this;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                self._scroller.scrollTop = self._scroller.scrollHeight;
            });
        } else {
            this._scroller.scrollTop = this._scroller.scrollHeight;
        }
    };

    root.EnmLogViewer = LogViewer;
}(typeof window !== 'undefined' ? window : globalThis));
