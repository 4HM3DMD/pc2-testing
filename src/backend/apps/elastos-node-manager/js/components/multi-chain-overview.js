/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/multi-chain-overview.js — Wave M2.3 (beta.3.91) — the
 * aggregate dashboard pane that mounts when the chain selector is
 * set to "Multi-chain overview" (key='all').
 *
 * Replaces the M2.1 stub. PaneRouter._mountMultiChainOverview picks
 * this up automatically: `if (root.EnmMultiChainOverviewPane) { … }`
 * branch fires once this script is loaded; otherwise the stub copy
 * stays in place.
 *
 * BEHAVIOR
 *
 *   1. mount(parent) — paints a loading skeleton, then:
 *        a. GETs /api/enm/council/overview to hydrate immediately
 *        b. Subscribes to the `council:overview` SSE topic for live updates
 *
 *   2. Each snapshot delivers chains[] + totals. Render groups chains
 *      by class (A→B→C→D→E), one section per class, one row per chain:
 *        [● state-dot]  Chain name  ·  state  ·  uptime  ·  sparkline  ·  →
 *
 *   3. Clicking a row routes to that chain's per-chain pane via the
 *      chain-selector contract: write localStorage('enm:chain-selection')
 *      + dispatch enm:chain-change event. PaneRouter listens for that
 *      event and re-mounts.
 *
 *   4. destroy() unsubscribes SSE + per-chain height-series subs + tears
 *      down all per-chain sparkline instances + removes the root element.
 *
 * EMPTY-STATE: when /council/overview returns 0 chains (very first
 * boot, before setup) we show the friendly "no chains configured yet"
 * copy + a hint to use the setup wizard. The setup wizard is in
 * pane-dashboard at that point so the operator can see both.
 *
 * SPARKLINE: per-chain height series. Uses EnmHeightSeriesClient
 * (services/height-series.js) — the same backend that drives the
 * chain-card hero sparkline. Mount is best-effort: missing client or
 * missing sparkline holder is silently skipped (overview still useful
 * without sparklines on chains that haven't reported height yet).
 *
 * ACCESSIBILITY: each row is role="button" + tabindex="0" with an
 * aria-label of "Open <chain> dashboard". Enter/Space triggers route
 * just like a click. Section headers use h3.
 */

(function (root) {
    'use strict';

    var SSE_TOPIC = 'council:overview';

    // Visual section labels keyed by the 5-class taxonomy. These also
    // exist in strings.js (chain_name.* + section_label.*) — but for
    // M2.3 we hardcode here. M2.6 migrates to strings.js so they're
    // localizable. The fallback strings stay in case strings.js hasn't
    // resolved the key yet (e.g. operator's locale missing a key).
    var CLASS_LABEL = {
        A: 'Mainchain',
        B: 'EVM sidechains',
        C: 'Oracles',
        D: 'Cross-chain',
        E: 'Light clients',
        '?': 'Other',
    };

    // Per-chain operator-facing display name fallback. Used when the
    // server-side displayName is missing or matches the chainId (rare).
    // Mirrors the chain-selector.js labels so the overview rows + the
    // selector trigger label use identical names.
    var CHAIN_DISPLAY_FALLBACK = {
        mainchain:    'Main chain',
        esc:          'Smart Chain',
        'esc-oracle': 'ESC Oracle',
        eid:          'Identity Chain',
        'eid-oracle': 'EID Oracle',
        pg:           'PG Chain',
        'pg-oracle':  'PG Oracle',
        arbiter:      'Arbiter Service',
        spv:          'SPV Module',
    };

    // M2.2 coarseState → operator-facing label.
    var STATE_LABEL = {
        running:      'Running',
        starting:     'Starting',
        stopped:      'Stopped',
        disabled:     'Disabled',
        unconfigured: 'Not configured',
    };

    // Ordering for chain-class sections.
    var CLASS_ORDER = ['A', 'B', 'C', 'D', 'E', '?'];

    function EnmMultiChainOverviewPane(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('EnmMultiChainOverviewPane: { api } required');
        }
        this.api = opts.api;
        this.sse = opts.sse || null;
        this.notifications = opts.notifications || null;
        this.announcer = opts.announcer || null;
        this.heightSeries = opts.heightSeries || null;
        this._parent = null;
        this._root = null;
        this._unsubSse = null;
        this._lastSnap = null;
        this._sparklines = {};   // chainId → EnmSparkline instance
        this._sparkUnsubs = {};  // chainId → unsubscribe fn from heightSeries
        this._destroyed = false;
    }

    EnmMultiChainOverviewPane.prototype.mount = function (parent) {
        if (!parent) { throw new TypeError('EnmMultiChainOverviewPane.mount: parent required'); }
        this._parent = parent;
        this._root = document.createElement('section');
        this._root.className = 'enm-overview';
        this._root.setAttribute('aria-label', 'Multi-chain overview');
        parent.appendChild(this._root);
        this._renderLoading();
        this._subscribe();
        this._fetchInitial();
    };

    EnmMultiChainOverviewPane.prototype.destroy = function () {
        if (this._destroyed) { return; }
        this._destroyed = true;
        if (this._unsubSse) {
            try { this._unsubSse(); } catch (_) { /* idempotent */ }
            this._unsubSse = null;
        }
        this._teardownSparklines();
        if (this._root && this._root.parentNode) {
            this._root.parentNode.removeChild(this._root);
        }
        this._root = null;
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._renderLoading = function () {
        this._root.innerHTML = ''
            + '<div class="enm-overview-loading" role="status" aria-live="polite">'
            + '<p>Loading Council overview…</p>'
            + '</div>';
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._renderError = function (msg) {
        if (!this._root) { return; }
        this._root.innerHTML = ''
            + '<div class="enm-overview-error" role="alert">'
            + '<h2>Overview unavailable</h2>'
            + '<p>' + escapeHtml(String(msg)) + '</p>'
            + '</div>';
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._fetchInitial = function () {
        var self = this;
        this.api.get('/council/overview', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            // successBody wraps as { success: true, result: snap }.
            // Defensive: also accept the bare snap (future-proofing).
            var snap = (data && data.result) ? data.result : data;
            self._applySnapshot(snap);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            self._renderError((err && err.message) || 'Network error');
        });
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._subscribe = function () {
        if (!this.sse || typeof this.sse.subscribe !== 'function') { return; }
        var self = this;
        try {
            this._unsubSse = this.sse.subscribe(SSE_TOPIC, function (payload) {
                if (self._destroyed) { return; }
                self._applySnapshot(payload);
            });
        } catch (err) {
            // SSE subscribe failure is non-fatal; fetchInitial covers it.
            if (typeof console !== 'undefined') {
                console.warn('EnmMultiChainOverviewPane: SSE subscribe failed:', err && err.message);
            }
        }
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._applySnapshot = function (snap) {
        if (!snap || !Array.isArray(snap.chains)) {
            this._renderError('Overview snapshot is malformed.');
            return;
        }
        this._lastSnap = snap;
        this._render(snap);
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._render = function (snap) {
        if (!this._root) { return; }
        // Sort by class precedence then chainId alphabetical (stable).
        var ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
        var sorted = snap.chains.slice().sort(function (a, b) {
            var pa = ORDER[a.chainClass] !== undefined ? ORDER[a.chainClass] : 99;
            var pb = ORDER[b.chainClass] !== undefined ? ORDER[b.chainClass] : 99;
            if (pa !== pb) { return pa - pb; }
            return String(a.chainId).localeCompare(String(b.chainId));
        });
        // Group by class for visual section headers.
        var byClass = {};
        sorted.forEach(function (c) {
            var k = c.chainClass || '?';
            if (!byClass[k]) { byClass[k] = []; }
            byClass[k].push(c);
        });

        var html = [
            '<header class="enm-overview-header">',
            '<h2>Council overview</h2>',
            '<p class="enm-overview-summary">',
            escapeHtml(this._summaryLine(snap.totals)),
            '</p>',
            '</header>',
            '<div class="enm-overview-body">',
        ];
        var hasRows = false;
        var self = this;
        CLASS_ORDER.forEach(function (k) {
            var rows = byClass[k];
            if (!rows || rows.length === 0) { return; }
            hasRows = true;
            html.push('<section class="enm-overview-class" data-class="' + k + '">');
            html.push('<h3>' + escapeHtml(CLASS_LABEL[k] || k) + '</h3>');
            html.push('<ul class="enm-overview-rows" role="list">');
            rows.forEach(function (c) {
                html.push(self._rowHtml(c));
            });
            html.push('</ul>');
            html.push('</section>');
        });
        if (!hasRows) {
            html.push('<div class="enm-overview-empty">');
            html.push('<p><strong>No chains configured yet.</strong></p>');
            html.push('<p>Use the setup wizard to install your first chain. ');
            html.push('Once Mainchain is running you can add EVM sidechains, ');
            html.push('Oracles, and Arbiter from the same wizard.</p>');
            html.push('</div>');
        }
        html.push('</div>');
        this._root.innerHTML = html.join('');

        // Wire row clicks → chain-selector dispatch.
        var rowEls = this._root.querySelectorAll('.enm-overview-row');
        Array.prototype.forEach.call(rowEls, function (row) {
            row.addEventListener('click', function () {
                self._routeToChain(row.dataset.chainId);
            });
            row.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    self._routeToChain(row.dataset.chainId);
                }
            });
        });

        // Sparklines — only re-mount the diff. Tear down any chain that
        // disappeared from the snapshot or stopped being alive; mount
        // any newly-alive chain.
        this._reconcileSparklines(sorted);
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._rowHtml = function (c) {
        var stateClass = 'state-' + escapeAttr(c.state || 'unknown');
        var uptime = c.uptimeSec != null ? formatUptime(c.uptimeSec) : '';
        var displayName = c.displayName || CHAIN_DISPLAY_FALLBACK[c.chainId] || c.chainId;
        var stateLabel = STATE_LABEL[c.state] || c.state || 'unknown';
        var chainIdAttr = escapeAttr(c.chainId);
        var displayHtml = escapeHtml(displayName);
        var stateLabelHtml = escapeHtml(stateLabel);
        var uptimeHtml = uptime ? '<span class="enm-overview-uptime" title="Process uptime">' + escapeHtml(uptime) + '</span>' : '';
        return '<li class="enm-overview-row" data-chain-id="' + chainIdAttr
            + '" data-state="' + escapeAttr(c.state || 'unknown') + '"'
            + ' tabindex="0" role="button"'
            + ' aria-label="Open ' + escapeAttr(displayName) + ' dashboard">'
            + '<span class="enm-overview-dot ' + stateClass + '" aria-hidden="true"></span>'
            + '<span class="enm-overview-name">' + displayHtml + '</span>'
            + '<span class="enm-overview-state">' + stateLabelHtml + '</span>'
            + uptimeHtml
            + '<span class="enm-overview-spark" data-chain-id="' + chainIdAttr + '"></span>'
            + '<span class="enm-overview-arrow" aria-hidden="true">›</span>'
            + '</li>';
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._summaryLine = function (totals) {
        if (!totals || !totals.total) { return 'No chains yet.'; }
        var bits = [];
        bits.push(totals.running + ' running');
        if (totals.stopped > 0) { bits.push(totals.stopped + ' stopped'); }
        if (totals.disabled > 0) { bits.push(totals.disabled + ' disabled'); }
        bits.push('of ' + totals.total + ' total');
        return bits.join(' · ');
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._reconcileSparklines = function (chains) {
        if (!this.heightSeries || typeof this.heightSeries.subscribe !== 'function') { return; }
        if (!root.EnmSparkline) { return; }
        var self = this;
        // Set of chainIds that should have a sparkline right now.
        var wanted = {};
        chains.forEach(function (c) { if (c.alive) { wanted[c.chainId] = true; } });
        // Drop any sparkline that's no longer wanted (chain stopped or removed).
        Object.keys(this._sparklines).forEach(function (cId) {
            if (!wanted[cId]) { self._teardownSparkline(cId); }
        });
        // Mount any sparkline that's now wanted but not yet mounted.
        Object.keys(wanted).forEach(function (cId) {
            if (self._sparklines[cId]) { return; }
            var holder = self._root.querySelector(
                '.enm-overview-spark[data-chain-id="' + cssEscape(cId) + '"]',
            );
            if (!holder) { return; }
            var sp = new root.EnmSparkline({
                color: 'var(--state-healthy, #4caf50)',
            });
            sp.mount(holder);
            self._sparklines[cId] = sp;
            try {
                self._sparkUnsubs[cId] = self.heightSeries.subscribe(cId, function (series) {
                    if (self._destroyed) { return; }
                    if (!self._sparklines[cId]) { return; }
                    self._sparklines[cId].setSeries(series);
                });
            } catch (err) {
                // Per-chain subscribe failure shouldn't kill the row;
                // the sparkline stays as an empty SVG.
                if (typeof console !== 'undefined') {
                    console.warn(
                        'EnmMultiChainOverviewPane: heightSeries.subscribe('
                        + cId + ') failed:',
                        err && err.message,
                    );
                }
            }
        });
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._teardownSparkline = function (cId) {
        if (this._sparkUnsubs[cId]) {
            try { this._sparkUnsubs[cId](); } catch (_) { /* idempotent */ }
            delete this._sparkUnsubs[cId];
        }
        if (this._sparklines[cId]) {
            try { this._sparklines[cId].destroy(); } catch (_) { /* idempotent */ }
            delete this._sparklines[cId];
        }
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._teardownSparklines = function () {
        var self = this;
        Object.keys(this._sparklines).forEach(function (cId) { self._teardownSparkline(cId); });
        this._sparklines = {};
        this._sparkUnsubs = {};
    };

    /**
     * Persist the new selection + dispatch the chain-change event that
     * PaneRouter listens for. We don't directly hold a reference to the
     * ChainSelector instance (it's owned by app.js); the supported
     * integration path is "write localStorage + dispatch on document".
     *
     * @private
     * @param {string} chainId
     */
    EnmMultiChainOverviewPane.prototype._routeToChain = function (chainId) {
        if (!chainId) { return; }
        try {
            if (root.localStorage && typeof root.localStorage.setItem === 'function') {
                root.localStorage.setItem('enm:chain-selection', chainId);
            }
        } catch (_) { /* private mode */ }
        // Mirror the new label into the selector trigger so the topbar
        // updates in sync with the route. Best-effort: a missing selector
        // element just means the topbar will catch up on its own next
        // _render. PaneRouter's listener does the heavy lifting.
        try {
            var selectorEl = document.getElementById('enm-chain-selector');
            if (selectorEl) {
                selectorEl.setAttribute('data-active', chainId);
                var label = selectorEl.querySelector('.enm-chain-selector-label');
                if (label && CHAIN_DISPLAY_FALLBACK[chainId]) {
                    label.textContent = CHAIN_DISPLAY_FALLBACK[chainId];
                }
            }
        } catch (_) { /* no-op */ }
        try {
            document.dispatchEvent(new CustomEvent('enm:chain-change', {
                detail: { key: chainId, source: 'overview-row-click' },
                bubbles: true,
            }));
        } catch (_) { /* IE-era fallback unnecessary */ }
        if (this.announcer && typeof this.announcer.polite === 'function') {
            try {
                this.announcer.polite(
                    'Switched to ' + (CHAIN_DISPLAY_FALLBACK[chainId] || chainId),
                );
            } catch (_) { /* ignore */ }
        }
    };

    function formatUptime(sec) {
        if (typeof sec !== 'number' || sec < 0) { return ''; }
        if (sec < 60)    { return sec + 's'; }
        if (sec < 3600)  { return Math.floor(sec / 60) + 'm'; }
        if (sec < 86400) { return Math.floor(sec / 3600) + 'h'; }
        return Math.floor(sec / 86400) + 'd';
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(s) {
        return escapeHtml(String(s));
    }

    function cssEscape(s) {
        if (root.CSS && typeof root.CSS.escape === 'function') {
            return root.CSS.escape(s);
        }
        return String(s).replace(/[^\w-]/g, '\\$&');
    }

    root.EnmMultiChainOverviewPane = EnmMultiChainOverviewPane;
    // Exported for unit tests.
    root.EnmMultiChainOverviewPane._internal = {
        formatUptime,
        escapeHtml,
        escapeAttr,
        CLASS_LABEL,
        STATE_LABEL,
        CHAIN_DISPLAY_FALLBACK,
        SSE_TOPIC,
    };
}(typeof window !== 'undefined' ? window : globalThis));
