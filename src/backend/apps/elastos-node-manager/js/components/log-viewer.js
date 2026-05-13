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
        // a11y: heading truncates with text-overflow:ellipsis on narrow widths.
        // Mirror the full label into title= so it stays readable.
        title.title = title.textContent;
        head.appendChild(title);

        this._tailToggle = document.createElement('button');
        this._tailToggle.type = 'button';
        this._tailToggle.className = 'enm-log-tail-toggle enm-log-following';
        this._tailToggle.textContent = t('log_viewer.live');
        // Don't mirror the same string into title= — duplicating a
        // visible button label is pure noise for screen-reader users
        // (they get the label, then the title, identical). The title=
        // is only assigned in the reconnecting branch where it carries
        // additional context.
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
                // Disconnected — amber pill. CSS turns the leading dot
                // amber and kills the pulse animation so the badge reads
                // as "calm urgency" rather than "everything is fine".
                self._tailToggle.textContent = 'reconnecting…';
                self._tailToggle.classList.remove('enm-log-following');
                self._tailToggle.classList.add('enm-log-reconnecting');
                self._tailToggle.title = 'Live log stream lost — auto-reconnecting';
                return;
            }
            self._tailToggle.classList.remove('enm-log-reconnecting');
            self._tailToggle.textContent = t(self._followTail ? 'log_viewer.live' : 'log_viewer.paused');
            self._tailToggle.classList.toggle('enm-log-following', self._followTail);
            // Clear title= in the connected branch — see _renderShell
            // comment; we only set title= when the badge carries info
            // not already visible in the label.
            self._tailToggle.removeAttribute('title');
        };
        this._tailToggle.addEventListener('click', function () {
            // Don't toggle while disconnected — the badge is non-actionable then.
            if (self._sseConnState !== 'open') { return; }
            self._followTail = !self._followTail;
            self._refreshTailLabel();
            if (self._followTail) { self._scrollToBottom(); }
        });
        head.appendChild(this._tailToggle);

        // Download button — mirrors the audit-tab JSON export pattern.
        // Builds a plaintext blob from the current buffer (capped at
        // MAX_DOM_LINES = 5000 lines) so the operator can attach the
        // log slice to a bug report without copying line-by-line.
        this._downloadBtn = document.createElement('button');
        this._downloadBtn.type = 'button';
        this._downloadBtn.className = 'enm-btn enm-btn-secondary enm-log-download';
        this._downloadBtn.textContent = 'Download';
        this._downloadBtn.setAttribute('aria-label', 'Download visible logs as text');
        this._downloadBtn.title = 'Download the visible log buffer (up to ' + MAX_DOM_LINES + ' lines)';
        this._downloadBtn.addEventListener('click', function () { self._exportText(); });
        head.appendChild(this._downloadBtn);

        // Buffer-drop pill — invisible until the first head-trim runs in
        // _appendBatch. Once shown, persists for the rest of the mount
        // so the operator knows the visible buffer is a rolling window.
        this._bufferPill = document.createElement('span');
        this._bufferPill.className = 'enm-log-buffer-pill';
        this._bufferPill.hidden = true;
        this._bufferPill.setAttribute('role', 'status');
        head.appendChild(this._bufferPill);

        this.root.appendChild(head);

        this._scroller = document.createElement('div');
        this._scroller.className = 'enm-log-scroller';
        // a11y: role="log" alone is enough; pairing with aria-live="polite"
        // forced screen readers to announce every SSE batch (up to 500
        // lines/sec). The Live/Paused toggle is the operator's existing
        // control over auto-scroll; AT users can read the scroller
        // explicitly via the live-region role without flooding.
        this._scroller.setAttribute('role', 'log');
        this._scroller.setAttribute('aria-label', t('log_viewer.heading') + ' — ' + this.chainId);

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
            // Tally lines that fell off the head so the buffer-drop pill
            // can honestly report "N older lines dropped". Without this
            // the operator's mental model ("this is the chain's log
            // file") is wrong — it's a rolling window of MAX_DOM_LINES.
            this._droppedCount = (this._droppedCount || 0) + excess;
            if (this._bufferPill) {
                this._bufferPill.hidden = false;
                this._bufferPill.textContent = 'Older lines dropped: '
                    + this._droppedCount.toLocaleString();
                this._bufferPill.title = 'The viewer keeps the most recent '
                    + MAX_DOM_LINES.toLocaleString() + ' lines in memory. '
                    + 'Use Download to capture the visible buffer.';
            }
        }

        if (this._followTail) {
            this._scrollToBottom();
        }
    };

    /**
     * @private
     * Build a plaintext blob from the current buffer and trigger a
     * download. Mirrors the audit-tab JSON export pattern so operators
     * can attach a log slice to a bug report without copying line-by-line.
     */
    LogViewer.prototype._exportText = function () {
        var lines = (this._lines || []).map(function (e) {
            var ts;
            try { ts = new Date(e.ts || Date.now()).toISOString(); }
            catch (err) { ts = '?'; }
            var stream = (e.stream === 'stderr' ? 'stderr' : 'stdout');
            return ts + ' [' + stream + '] ' + (e.line || '');
        });
        var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'enm-logs-' + this.chainId + '-' + Date.now() + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
