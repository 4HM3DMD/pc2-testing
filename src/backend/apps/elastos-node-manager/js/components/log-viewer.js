/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/log-viewer.js — terminal-style log panel with tail-follow.
 *
 * Beta 3 rewrite: emits the phase-05 DOM shape (`.enm-log-viewer >
 * .enm-log-toolbar + .enm-log-meta + .enm-log-scroller`). The
 * data/lifecycle substrate is preserved verbatim from alpha.28.1:
 *   - SSE subscribe on `chains:<chainId>:logs` (payload `{chainId,
 *     lines:[{stream, line, ts}]}` from ProcessLogStreamer).
 *   - Initial-tail seed via GET /logs/:id/tail?n=200, with the queued
 *     SSE-before-tail batch ordering buffer (Round-11 audit, batch 41).
 *   - 5000-line DOM cap with Range.deleteContents head-trim (Round-34
 *     audit, batch 107).
 *   - _destroyed lifecycle flag short-circuits every .then / SSE
 *     callback (Round-18 audit, batch 64).
 *   - Visibility-pause wrapper around the SSE handler (Round-16 audit).
 *   - role="log" + aria-relevant="additions"; aria-live="polite" was
 *     intentionally dropped in alpha.28.1 batch 24 because pairing it
 *     with role="log" forced screen readers to announce every batch
 *     (up to 500 lines/sec) — the role alone suffices. The new sticky
 *     cap banner gets its own role="status" when it un-hides.
 *
 * New for Beta 3:
 *   - Free-text search with `/regex/flags` form, debounced 200ms.
 *     Wraps matches in `.hl` spans. Updates the meta-match counter.
 *   - Inline level highlights: scan for `\b(INFO|DEBG|DEBUG|WARN|
 *     WARNING|ERROR|ERR)\b` and wrap with `.lvl-*` spans.
 *   - Stream label mapped to 3-letter code in `.enm-log-stream`
 *     (OUT/ERR/FILE/LOG); the data-stream attribute drives the
 *     colour via CSS.
 *   - Copy = clipboard write of the currently-visible (post-filter)
 *     lines. Uses root.enmCopyToClipboard if available so the
 *     "Copied!" feedback and notifications fall-through stay
 *     consistent with the rest of the app.
 *
 * v0.1 — no virtual scrolling yet; the 5000-line DOM cap keeps the
 * scroller smooth enough on baseline hardware. Full virtualization
 * waits until operators actually hit a bottleneck.
 */

(function (root) {
    'use strict';

    var MAX_DOM_LINES = 5000;
    var INITIAL_TAIL_N = 200;
    var SEARCH_DEBOUNCE_MS = 200;

    // Pre-compiled lvl-keyword regex. Word-bounded so "INFORMATION"
    // doesn't match "INFO" mid-word; case-insensitive because some
    // log writers emit lowercase. The capture group preserves the
    // exact spelling for display so an "ERR" stays "ERR" and an
    // "ERROR" stays "ERROR".
    var LVL_REGEX = /\b(INFO|DEBG|DEBUG|WARN|WARNING|ERROR|ERR)\b/gi;
    var LVL_CLASS = {
        INFO: 'lvl-info',
        DEBG: 'lvl-debug',
        DEBUG: 'lvl-debug',
        WARN: 'lvl-warn',
        WARNING: 'lvl-warn',
        ERROR: 'lvl-error',
        ERR: 'lvl-error',
    };

    var STREAM_LABEL = {
        stdout: 'OUT',
        stderr: 'ERR',
        file:   'FILE',
    };

    // batch 71 carry-over — guards against malformed truthy `ts`
    // values (Invalid Date → NaN:NaN:NaN in the timestamp before this
    // probe). `|| Date.now()` alone only catches falsy values.
    function safeDate(raw) {
        if (raw == null) { return new Date(); }
        var n = (typeof raw === 'number') ? raw : Date.parse(raw);
        if (!isFinite(n)) { return new Date(); }
        var d = new Date(n);
        if (isNaN(d.getTime())) { return new Date(); }
        return d;
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function formatTimestamp(ts) {
        var d = safeDate(ts);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    function streamLabel(stream) {
        return STREAM_LABEL[stream] || 'LOG';
    }

    // HTML-escape because we build innerHTML for the lvl + hl
    // highlight spans below. textContent isn't an option once we
    // need to overlay class spans on substrings.
    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Wrap every LVL_REGEX match in a `.lvl-*` span. Returns HTML —
     * caller MUST have already escaped the raw text.
     *
     * @param {string} escapedText
     * @returns {string}
     */
    function applyLvlHighlights(escapedText) {
        // Reset lastIndex defensively (global regex carries state).
        LVL_REGEX.lastIndex = 0;
        return escapedText.replace(LVL_REGEX, function (m) {
            var cls = LVL_CLASS[m.toUpperCase()] || 'lvl-info';
            return '<span class="' + cls + '">' + m + '</span>';
        });
    }

    /**
     * Wrap matches of `pattern` in `.hl` spans. Operates on the
     * lvl-decorated HTML by splitting on tag boundaries so we never
     * insert `.hl` spans inside an existing `.lvl-*` span's opening
     * tag (which would produce malformed nested HTML like
     * `<span class="<span class="hl">lvl-info</span>">`).
     *
     * @param {string} html  output of applyLvlHighlights
     * @param {RegExp|null} regex  null/undefined disables highlighting
     * @returns {{html: string, matched: boolean}}
     */
    function applySearchHighlights(html, regex) {
        if (!regex) {
            return { html: html, matched: false };
        }
        // Split on the existing `<span ...>` and `</span>` markers so
        // we only highlight inside text nodes. The split keeps the
        // delimiters (capture group) so we can re-emit them unchanged.
        var parts = html.split(/(<[^>]+>)/g);
        var matched = false;
        for (var i = 0; i < parts.length; i += 1) {
            var p = parts[i];
            if (p.charAt(0) === '<') { continue; } // tag — leave alone
            regex.lastIndex = 0;
            var next = p.replace(regex, function (m) {
                matched = true;
                return '<span class="hl">' + m + '</span>';
            });
            parts[i] = next;
        }
        return { html: parts.join(''), matched: matched };
    }

    /**
     * Parse the search input into a usable RegExp.
     *
     *   "/error/i"  → /error/i
     *   "/abc/"     → /abc/
     *   "block"     → /block/i (case-insensitive substring)
     *   ""          → null  (no filter)
     *
     * Malformed regex (e.g. an unterminated character class) falls
     * back to a literal substring search so the operator never sees a
     * broken filter input — the box "just works" with whatever they
     * type.
     *
     * @param {string} raw
     * @returns {{pattern: string, isRegex: boolean, regex: RegExp|null}}
     */
    function parseSearchPattern(raw) {
        var s = (raw == null) ? '' : String(raw);
        if (s.length === 0) {
            return { pattern: '', isRegex: false, regex: null };
        }
        // `/pattern/flags` form: at least 2 slashes, ≥1 char between.
        var slashed = /^\/(.+)\/([gimsuy]*)$/.exec(s);
        if (slashed) {
            try {
                // Force 'g' so .replace highlights every match; merge
                // with caller-supplied flags (deduped).
                var flags = slashed[2];
                if (flags.indexOf('g') === -1) { flags += 'g'; }
                return {
                    pattern: slashed[1],
                    isRegex: true,
                    regex: new RegExp(slashed[1], flags),
                };
            } catch (e) {
                // Malformed regex → degrade to literal substring of
                // the whole raw string (incl. slashes). Operator sees
                // their text highlighted; no error toast for a
                // mid-type half-typed regex.
            }
        }
        // Literal substring (case-insensitive). Escape regex
        // metacharacters so "1.2.3" doesn't match "1x2y3".
        var literal = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return {
            pattern: s,
            isRegex: false,
            regex: new RegExp(literal, 'gi'),
        };
    }

    function LogViewer(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('LogViewer: { api, chainId } required');
        }
        this.api = opts.api;
        this.sse = opts.sse || null;        // optional — graceful degrade
        this.notifications = opts.notifications || null;
        this.chainId = opts.chainId || 'mainchain';

        this._lines = []; // { stream, line, ts } — most recent at end
        this._followTail = true;
        this._unsubscribe = null;
        this._sseStateUnsub = null;
        this._sseConnState = 'open';

        // Initial-tail vs first-SSE-batch ordering race (batch 41).
        // SSE batches that arrive while the /tail GET is still in-
        // flight get queued; the queue drains AFTER the tail seed
        // settles so newer SSE rows sit BELOW the historical tail.
        this._initialTailDone = false;
        this._pendingSseBatches = [];

        // Lifecycle flag — every .then / SSE callback short-circuits
        // when this flips. Without it, a teardown mid-fetch would
        // append into a detached scroller (already removed from DOM).
        this._destroyed = false;

        // DOM cache — populated by _renderShell.
        this.root = null;
        this._toolbar = null;
        this._searchInput = null;
        this._liveBtn = null;
        this._copyBtn = null;
        this._metaCount = null;
        this._metaMatches = null;
        this._metaSource = null;
        this._scroller = null;
        this._capBanner = null;

        // Search state.
        this._searchRaw = '';
        this._searchSpec = parseSearchPattern('');
        this._searchDebounce = null;
        this._matchCount = 0;

        // Head-trim accounting (sticky banner once it un-hides).
        this._droppedCount = 0;

        this._renderShell();
    }

    LogViewer.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._loadInitialTail();
        this._subscribe();
        return this;
    };

    LogViewer.prototype.destroy = function () {
        // Mark destroyed FIRST so any in-flight _loadInitialTail
        // resolutions short-circuit before mutating detached DOM.
        this._destroyed = true;
        if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
        if (this._sseStateUnsub) { this._sseStateUnsub(); this._sseStateUnsub = null; }
        if (this._searchDebounce) {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = null;
        }
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
    };

    /** @private */
    LogViewer.prototype._renderShell = function () {
        var t = root.enmTOrFallback || function (k, fb) { return fb || k; };
        var self = this;

        this.root = document.createElement('section');
        this.root.className = 'enm-log-viewer';

        // ---- toolbar -----------------------------------------------------
        var toolbar = document.createElement('div');
        toolbar.className = 'enm-log-toolbar';
        this._toolbar = toolbar;

        var toolbarLeft = document.createElement('div');
        toolbarLeft.className = 'enm-log-toolbar-left';

        var title = document.createElement('div');
        title.className = 'enm-log-title';
        title.textContent = this.chainId;
        // a11y: heading truncates with text-overflow:ellipsis on narrow
        // widths. Mirror the full label into title= so it stays readable.
        title.title = this.chainId;
        toolbarLeft.appendChild(title);

        // Chain pill — only one chain in v0.1; the pill is a surface
        // ready for a future selector. Active by default.
        var pill = document.createElement('span');
        pill.className = 'enm-log-chain-pill active';
        pill.textContent = this.chainId;
        toolbarLeft.appendChild(pill);

        // Search input. Debounced 200ms so the regex compile + DOM
        // re-walk doesn't fire on every keystroke.
        var searchWrap = document.createElement('div');
        searchWrap.className = 'enm-log-search';

        // The mock uses a glyph as the icon. We emit an inline SVG-
        // alike so the icon scales with the input font-size; the
        // glyph kept as the rendered character is fine.
        var searchIcon = document.createElement('span');
        searchIcon.className = 'enm-log-search-icon';
        searchIcon.setAttribute('aria-hidden', 'true');
        searchIcon.textContent = '⌕'; // ⌕
        searchWrap.appendChild(searchIcon);

        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'enm-log-search-input';
        searchInput.placeholder = 'Filter… (or /regex/)';
        searchInput.setAttribute('aria-label', 'Filter visible log lines');
        searchInput.addEventListener('input', function () {
            self._scheduleSearchUpdate(searchInput.value);
        });
        this._searchInput = searchInput;
        searchWrap.appendChild(searchInput);

        toolbarLeft.appendChild(searchWrap);
        toolbar.appendChild(toolbarLeft);

        var toolbarRight = document.createElement('div');
        toolbarRight.className = 'enm-log-toolbar-right';

        // Live / paused button. data-paused="true|false" drives the
        // gray vs accent state in CSS; class .enm-log-following
        // stays on while SSE state-tracking matches alpha.28.
        var liveBtn = document.createElement('button');
        liveBtn.type = 'button';
        liveBtn.className = 'enm-log-live-btn';
        liveBtn.setAttribute('data-paused', 'false');
        var liveDot = document.createElement('span');
        liveDot.className = 'enm-log-live-dot';
        liveDot.setAttribute('aria-hidden', 'true');
        liveBtn.appendChild(liveDot);
        // Wrap the label in a span so the dot stays untouched when we
        // toggle text. Keeps the markup stable for AT users.
        var liveLabel = document.createElement('span');
        liveLabel.className = 'enm-log-live-label';
        liveLabel.textContent = t('log_viewer.live', 'Live');
        liveBtn.appendChild(liveLabel);
        liveBtn.addEventListener('click', function () {
            // Don't toggle while disconnected — non-actionable then.
            if (self._sseConnState !== 'open') { return; }
            self._followTail = !self._followTail;
            self._refreshLiveLabel();
            if (self._followTail) { self._scrollToBottom(); }
        });
        this._liveBtn = liveBtn;
        this._liveLabel = liveLabel;
        toolbarRight.appendChild(liveBtn);

        // Copy. Uses enmCopyToClipboard when available so the
        // "Copied!" label-swap + notifications fall-through stays
        // consistent with every other copy site in the app.
        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'enm-btn enm-btn-secondary enm-log-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.setAttribute('aria-label', 'Copy visible log lines to clipboard');
        copyBtn.addEventListener('click', function () { self._copyVisible(); });
        this._copyBtn = copyBtn;
        toolbarRight.appendChild(copyBtn);

        toolbar.appendChild(toolbarRight);
        this.root.appendChild(toolbar);

        // ---- meta row ----------------------------------------------------
        // Hidden by default on narrow/compact via CSS; built unconditionally
        // here because CSS handles the visibility (DRY — JS doesn't need to
        // know breakpoints).
        var meta = document.createElement('div');
        meta.className = 'enm-log-meta';

        var metaCount = document.createElement('span');
        metaCount.className = 'enm-log-meta-count';
        metaCount.textContent = '0 lines';
        this._metaCount = metaCount;
        meta.appendChild(metaCount);

        // Match counter — hidden until a search is active. We
        // toggle visibility with the `hidden` attribute so AT users
        // don't read the "0 match" caption every render.
        var metaMatches = document.createElement('span');
        metaMatches.className = 'enm-log-meta-matches';
        metaMatches.hidden = true;
        this._metaMatches = metaMatches;
        meta.appendChild(metaMatches);

        var metaSep = document.createElement('span');
        metaSep.className = 'enm-log-meta-sep';
        metaSep.textContent = '·'; // ·
        meta.appendChild(metaSep);

        var metaSource = document.createElement('span');
        metaSource.className = 'enm-log-meta-source';
        // The mock spec calls for plain text + two <code> spans.
        // textContent for the framing, appendChild for the codes —
        // never innerHTML on user-visible chrome.
        metaSource.appendChild(document.createTextNode('Tail seeded from '));
        var tailCode = document.createElement('code');
        tailCode.textContent = '/tail?n=' + INITIAL_TAIL_N;
        metaSource.appendChild(tailCode);
        metaSource.appendChild(document.createTextNode(' · SSE '));
        var sseCode = document.createElement('code');
        sseCode.textContent = 'chains:' + this.chainId + ':logs';
        metaSource.appendChild(sseCode);
        this._metaSource = metaSource;
        meta.appendChild(metaSource);

        this.root.appendChild(meta);

        // ---- scroller ----------------------------------------------------
        var scroller = document.createElement('div');
        scroller.className = 'enm-log-scroller';
        // a11y: role="log" alone — pairing with aria-live="polite"
        // forced screen readers to announce every SSE batch (up to
        // 500 lines/sec). aria-relevant="additions" tells AT to focus
        // on appended content if it's queried explicitly.
        scroller.setAttribute('role', 'log');
        scroller.setAttribute('aria-relevant', 'additions');
        scroller.setAttribute('aria-label', 'Log lines for chain ' + this.chainId);
        this._scroller = scroller;

        // Sticky cap banner — hidden until the 5000 line cap is hit.
        var cap = document.createElement('div');
        cap.className = 'enm-log-cap-banner';
        cap.hidden = true;
        cap.textContent = '5,000-line DOM cap reached. Older lines dropped from the top.';
        this._capBanner = cap;
        scroller.appendChild(cap);

        // Auto-pause on scroll-up; auto-resume on scroll-to-bottom.
        // The previous (alpha.28) shape only auto-paused; resuming
        // required clicking the live button. The new behaviour mirrors
        // tailing tools (less +F, journalctl -f) where reaching the
        // bottom re-engages the follow.
        scroller.addEventListener('scroll', function () {
            if (self._destroyed) { return; }
            var nearBottom = (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 4;
            if (!nearBottom && self._followTail) {
                self._followTail = false;
                self._refreshLiveLabel();
            } else if (nearBottom && !self._followTail && self._sseConnState === 'open') {
                self._followTail = true;
                self._refreshLiveLabel();
            }
        });

        this.root.appendChild(scroller);

        // ---- SSE state tracking -----------------------------------------
        // Same shape as alpha.28 — the "live" pill flips to "reconnecting…"
        // (with the dot animation killed via CSS) whenever the
        // EventSource is mid-reconnect.
        if (this.sse && typeof this.sse.onState === 'function') {
            this._sseStateUnsub = this.sse.onState(function (state) {
                if (self._destroyed) { return; }
                self._sseConnState = state;
                self._refreshLiveLabel();
            });
        }
        this._refreshLiveLabel();
    };

    /** @private */
    LogViewer.prototype._refreshLiveLabel = function () {
        if (!this._liveBtn) { return; }
        if (this._sseConnState !== 'open') {
            // Disconnected — neutralize the button. data-paused="true"
            // gives the gray theme; class .enm-log-reconnecting can
            // be styled separately if needed. The dot animation is
            // gated off in CSS via [data-paused="true"].
            this._liveBtn.setAttribute('data-paused', 'true');
            this._liveBtn.classList.add('enm-log-reconnecting');
            this._liveLabel.textContent = 'reconnecting…';
            this._liveBtn.title = 'Live log stream lost — auto-reconnecting';
            return;
        }
        this._liveBtn.classList.remove('enm-log-reconnecting');
        this._liveBtn.setAttribute('data-paused', this._followTail ? 'false' : 'true');
        this._liveLabel.textContent = this._followTail ? 'Live' : 'Paused';
        // Clear title= when the label already says everything visible.
        this._liveBtn.removeAttribute('title');
    };

    /** @private */
    LogViewer.prototype._loadInitialTail = function () {
        var self = this;
        return this.api.get('/logs/' + encodeURIComponent(this.chainId) + '/tail?n=' + INITIAL_TAIL_N, { skipCache: true })
            .then(function (data) {
                if (self._destroyed) { return; }
                if (data && Array.isArray(data.lines) && data.lines.length > 0) {
                    self._appendBatch(data.lines);
                }
            })
            .catch(function () {
                // Silent — chain may not have started yet, /tail returns empty.
            })
            .then(function () {
                if (self._destroyed) { return; }
                self._initialTailDone = true;
                self._drainPendingSseBatches();
            });
    };

    /** @private */
    LogViewer.prototype._drainPendingSseBatches = function () {
        if (!this._pendingSseBatches || this._pendingSseBatches.length === 0) {
            return;
        }
        var queued = this._pendingSseBatches;
        this._pendingSseBatches = [];
        for (var i = 0; i < queued.length; i += 1) {
            this._appendBatch(queued[i]);
        }
    };

    /** @private */
    LogViewer.prototype._subscribe = function () {
        if (!this.sse || typeof this.sse.subscribe !== 'function') {
            // No SSE service — graceful degrade to the initial tail
            // only. The Live button stays interactive but no new
            // lines arrive.
            return;
        }
        var self = this;
        var topic = 'chains:' + this.chainId + ':logs';
        // Visibility-pause: drop SSE appends to the DOM when the tab
        // is hidden so a 500 lines/sec firehose doesn't keep allocating
        // nodes nobody's looking at. Lines arriving while hidden are
        // pushed into the `_lines` buffer (so copy/serialization still
        // sees them) but the DOM doesn't grow. On visibility resume
        // the existing scroller stays as-is and the next real SSE
        // batch picks it up — for v0.1 the rolling MAX_DOM_LINES
        // window is the operator-facing contract; a future "replay
        // missed-while-hidden" feature can re-render from `_lines`.
        // (The Round-16 Page-Visibility audit's enmUseVisibilityPause
        // is shaped for setInterval pollers and isn't a clean fit for
        // SSE handlers, so we open-code the visibility branch.)
        var handler = function (payload) {
            if (self._destroyed) { return; }
            if (!payload || !Array.isArray(payload.lines)) { return; }
            if (!self._initialTailDone) {
                self._pendingSseBatches.push(payload.lines);
                return;
            }
            if (typeof document !== 'undefined' && document.hidden) {
                // Accumulate into the entry buffer without touching DOM.
                // MAX_DOM_LINES is enforced only on render so the buffer
                // doesn't grow unbounded — cap here too.
                for (var i = 0; i < payload.lines.length; i += 1) {
                    self._lines.push(payload.lines[i]);
                }
                if (self._lines.length > MAX_DOM_LINES) {
                    self._lines.splice(0, self._lines.length - MAX_DOM_LINES);
                }
                return;
            }
            self._appendBatch(payload.lines);
        };

        this._unsubscribe = this.sse.subscribe(topic, handler);
    };

    /** @private */
    LogViewer.prototype._scheduleSearchUpdate = function (raw) {
        var self = this;
        this._searchRaw = raw;
        if (this._searchDebounce) {
            clearTimeout(this._searchDebounce);
        }
        this._searchDebounce = setTimeout(function () {
            self._searchDebounce = null;
            if (self._destroyed) { return; }
            self._applySearch();
        }, SEARCH_DEBOUNCE_MS);
    };

    /** @private */
    LogViewer.prototype._applySearch = function () {
        var spec = parseSearchPattern(this._searchRaw);
        this._searchSpec = spec;
        // Re-walk the existing line nodes and re-decorate. We don't
        // re-build the whole list because the underlying `_lines`
        // buffer is unchanged — only the per-line classification
        // (match / no-match) and the highlight span overlay shift.
        var nodes = this._scroller.querySelectorAll('.enm-log-line');
        var totalMatches = 0;
        for (var i = 0; i < nodes.length; i += 1) {
            var node = nodes[i];
            var raw = node.getAttribute('data-line') || '';
            var html = applyLvlHighlights(escapeHtml(raw));
            var hl = applySearchHighlights(html, spec.regex);
            var textNode = node.querySelector('.enm-log-text');
            if (textNode) { textNode.innerHTML = hl.html; }
            if (hl.matched) {
                node.classList.add('match');
                totalMatches += 1;
            } else {
                node.classList.remove('match');
            }
        }
        this._matchCount = totalMatches;
        this._refreshMeta();
    };

    /** @private */
    LogViewer.prototype._refreshMeta = function () {
        if (!this._metaCount) { return; }
        var n = this._lines.length;
        this._metaCount.textContent = n.toLocaleString() + (n === 1 ? ' line' : ' lines');
        if (this._searchSpec && this._searchSpec.regex) {
            this._metaMatches.hidden = false;
            this._metaMatches.textContent = '· ' + this._matchCount.toLocaleString()
                + (this._matchCount === 1 ? ' match' : ' matches');
        } else {
            this._metaMatches.hidden = true;
            this._metaMatches.textContent = '';
        }
    };

    /** @private */
    LogViewer.prototype._appendBatch = function (lines) {
        if (!Array.isArray(lines) || lines.length === 0) {
            return;
        }

        var frag = document.createDocumentFragment();
        var spec = this._searchSpec;
        var matchesAdded = 0;
        for (var i = 0; i < lines.length; i += 1) {
            var entry = lines[i];
            this._lines.push(entry);
            var node = this._renderLine(entry, spec);
            if (node.classList.contains('match')) { matchesAdded += 1; }
            frag.appendChild(node);
        }
        this._scroller.appendChild(frag);

        // Trim to MAX_DOM_LINES — drop oldest from the top. Use
        // Range.deleteContents for the bulk removal so we get ONE
        // layout invalidation per trim, not N (batch 107).
        if (this._lines.length > MAX_DOM_LINES) {
            var excess = this._lines.length - MAX_DOM_LINES;
            // Drop the same range from the search-match count first
            // (before we slice the array) so the meta counter stays
            // in sync. Counted by reading the DOM head nodes' .match
            // class because the search-state is the source of truth.
            var trimmedMatches = 0;
            var lineNodes = this._scroller.querySelectorAll('.enm-log-line');
            var trimEnd = Math.min(excess, lineNodes.length);
            for (var k = 0; k < trimEnd; k += 1) {
                if (lineNodes[k].classList.contains('match')) {
                    trimmedMatches += 1;
                }
            }
            this._lines.splice(0, excess);

            if (lineNodes.length > 0 && typeof document.createRange === 'function') {
                var first = lineNodes[0];
                var last = lineNodes[Math.min(excess, lineNodes.length) - 1];
                var range = document.createRange();
                range.setStartBefore(first);
                range.setEndAfter(last);
                range.deleteContents();
            } else {
                // Fallback: per-child loop. Skips .enm-log-cap-banner
                // because the banner is sticky and not a log line.
                for (var j = 0; j < excess; j += 1) {
                    var next = this._scroller.querySelector('.enm-log-line');
                    if (!next) { break; }
                    this._scroller.removeChild(next);
                }
            }

            this._matchCount = Math.max(0, this._matchCount - trimmedMatches);
            this._droppedCount += excess;
            if (this._capBanner && this._capBanner.hidden) {
                this._capBanner.hidden = false;
                this._capBanner.setAttribute('role', 'status');
            }
        }

        this._matchCount += matchesAdded;
        this._refreshMeta();

        if (this._followTail) {
            this._scrollToBottom();
        }
    };

    /** @private */
    LogViewer.prototype._renderLine = function (entry, searchSpec) {
        var div = document.createElement('div');
        div.className = 'enm-log-line';
        var stream = (entry && entry.stream) || 'log';
        div.setAttribute('data-stream', stream);
        // Stash the raw line text in a data-attr so _applySearch can
        // re-decorate without needing the entry object again.
        var raw = (entry && entry.line != null) ? String(entry.line) : '';
        div.setAttribute('data-line', raw);

        var d = safeDate(entry && entry.ts);
        var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());

        var ts = document.createElement('span');
        ts.className = 'enm-log-ts';
        ts.textContent = time;
        div.appendChild(ts);

        var streamCell = document.createElement('span');
        streamCell.className = 'enm-log-stream';
        streamCell.textContent = streamLabel(stream);
        div.appendChild(streamCell);

        var text = document.createElement('span');
        text.className = 'enm-log-text';
        // Build the decorated HTML: lvl spans first, search-highlight
        // spans overlaid on top. Both pass through escapeHtml so the
        // raw line text can't inject markup.
        var html = applyLvlHighlights(escapeHtml(raw));
        var hl = applySearchHighlights(html, searchSpec && searchSpec.regex);
        text.innerHTML = hl.html;
        div.appendChild(text);

        if (hl.matched) {
            div.classList.add('match');
        }

        // Full ISO + stream in the tooltip so the operator can read
        // the exact timestamp without expanding the line.
        div.title = d.toISOString() + ' [' + stream + ']';
        return div;
    };

    /** @private */
    LogViewer.prototype._scrollToBottom = function () {
        var self = this;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                if (self._destroyed || !self._scroller) { return; }
                self._scroller.scrollTop = self._scroller.scrollHeight;
            });
        } else {
            this._scroller.scrollTop = this._scroller.scrollHeight;
        }
    };

    /**
     * Serialize the currently-visible (post-filter) lines into a
     * plaintext blob and copy to clipboard.
     *
     * @private
     */
    LogViewer.prototype._copyVisible = function () {
        var spec = this._searchSpec;
        var filtered = [];
        var entries = this._lines;
        for (var i = 0; i < entries.length; i += 1) {
            var e = entries[i];
            var line = (e && e.line != null) ? String(e.line) : '';
            if (spec && spec.regex) {
                spec.regex.lastIndex = 0;
                if (!spec.regex.test(line)) { continue; }
            }
            var d = safeDate(e && e.ts);
            var ts;
            try { ts = d.toISOString(); }
            catch (err) { ts = '?'; }
            filtered.push(ts + ' [' + ((e && e.stream) || 'log') + '] ' + line);
        }
        var text = filtered.join('\n') + (filtered.length > 0 ? '\n' : '');

        var nf = this.notifications;
        var copyBtn = this._copyBtn;
        if (root.enmCopyToClipboard) {
            root.enmCopyToClipboard(text, {
                btn: copyBtn,
                copiedLabel: 'Copied!',
                notifications: nf,
                notifyOnSuccess: !copyBtn,  // notification only if no in-button feedback
                successTitle: 'Logs copied',
                successBody: filtered.length.toLocaleString() + ' line'
                    + (filtered.length === 1 ? '' : 's') + ' copied to clipboard.',
                failTitle: 'Copy unavailable',
                failBody: 'Browser blocked clipboard access.',
            });
            return;
        }
        // Fallback path — older browsers or unit tests without the
        // util. Direct clipboard write, no in-button feedback.
        if (typeof navigator !== 'undefined'
            && navigator.clipboard
            && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                if (nf) { nf.info('Logs copied', filtered.length + ' lines copied to clipboard.'); }
            }, function () {
                if (nf) { nf.warning('Copy unavailable', 'Browser blocked clipboard access.'); }
            });
        } else if (nf) {
            nf.warning('Copy unavailable', 'Browser blocked clipboard access.');
        }
    };

    root.EnmLogViewer = LogViewer;
}(typeof window !== 'undefined' ? window : globalThis));
