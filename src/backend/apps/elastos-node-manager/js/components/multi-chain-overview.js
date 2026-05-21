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

    // beta.3.94 (Wave M2.6) — these fallback maps remain in the file
    // for two reasons: (1) strings.js may not have loaded yet on the
    // very first paint, and (2) tests that don't include strings.js
    // still need a working component. Runtime always prefers
    // enmT('chain_name.<id>') / ('chain_class_label.<X>') /
    // ('overview_state.<state>'); these are last-resort fallbacks.
    var CLASS_LABEL = {
        // 0.5.70 audit Session 70 — fallback canonicalization (matches
        // strings.js chain_class_label.A fix in same release).
        A: 'Main chain',
        B: 'EVM sidechains',
        C: 'Oracles',
        D: 'Cross-chain',
        E: 'Light clients',
        '?': 'Other',
    };
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
    var STATE_LABEL = {
        running:      'Running',
        starting:     'Starting',
        stopped:      'Stopped',
        disabled:     'Disabled',
        unconfigured: 'Not configured',
    };

    /**
     * Look up a strings.js key; if missing or not-a-string, fall back
     * to the provided default (the in-file English copy). Combines
     * enmT (full lookup) with a manual fallback so missing keys don't
     * surface "[key]" placeholder copy to the operator.
     *
     * @param {string} key      strings.js dot-path
     * @param {string} fallback English fallback when key is missing
     * @param {object} [vars]   {var} substitution
     * @returns {string}
     */
    function tFb(key, fallback, vars) {
        var t = root.enmTOrFallback || root.enmT;
        if (typeof t !== 'function') { return formatVars(fallback, vars); }
        var v = t(key, vars);
        // enmTOrFallback returns key when strings missing; enmT returns
        // "[key]" when missing. Either way we detect + fall back.
        if (!v || v === key || v === ('[' + key + ']')) {
            return formatVars(fallback, vars);
        }
        return v;
    }

    function formatVars(s, vars) {
        if (!vars) { return s; }
        return String(s).replace(/\{([a-zA-Z0-9_]+)\}/g, function (m, name) {
            return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
        });
    }

    function chainNameFor(chainId, serverDisplayName) {
        if (serverDisplayName) { return serverDisplayName; }
        return tFb('chain_name.' + chainId, CHAIN_DISPLAY_FALLBACK[chainId] || chainId);
    }
    function classLabelFor(klass) {
        var k = klass || '?';
        var fallback = CLASS_LABEL[k] || k;
        if (k === '?') { return tFb('chain_class_label.unknown', fallback); }
        return tFb('chain_class_label.' + k, fallback);
    }
    function stateLabelFor(state) {
        return tFb('overview_state.' + state, STATE_LABEL[state] || state || 'unknown');
    }

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
        // P2.2 — a single in-flight quick action (start/stop/restart) across
        // the whole pane. While set, SSE re-render is suppressed so the
        // pending button isn't wiped by a wholesale innerHTML rebuild.
        this._pendingAction = null;
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
            + '<p>' + escapeHtml(tFb('overview_pane.loading', 'Loading Council overview…')) + '</p>'
            + '</div>';
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._renderError = function (msg) {
        if (!this._root) { return; }
        // 0.5.9 audit Session 9 — add Retry button. Pre-0.5.9 the error
        // pane was terminal: operator on a flaky network or transient
        // backend hiccup saw "Overview unavailable" with no recovery
        // action except a full ENM tile reload. The Retry button calls
        // back into _fetchInitial which clears + re-renders on success.
        this._root.innerHTML = ''
            + '<div class="enm-overview-error" role="alert">'
            + '<h2>' + escapeHtml(tFb('overview_pane.error_title', 'Overview unavailable')) + '</h2>'
            + '<p>' + escapeHtml(String(msg)) + '</p>'
            + '<button type="button" class="enm-btn enm-btn-secondary enm-overview-retry" '
            +   'data-action="retry">'
            +   escapeHtml(tFb('overview_pane.retry', 'Retry'))
            + '</button>'
            + '</div>';
        var self = this;
        var btn = this._root.querySelector('[data-action="retry"]');
        if (btn) {
            btn.addEventListener('click', function () {
                if (self._destroyed) { return; }
                self._renderLoading();
                self._fetchInitial();
            });
        }
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
            this._renderError(tFb('overview_pane.error_malformed', 'Overview snapshot is malformed.'));
            return;
        }
        this._lastSnap = snap;
        // P2.2 — while a quick action is in flight, keep the latest snapshot
        // but skip the wholesale innerHTML rebuild (it would wipe the pending
        // button mid-action). The action's completion handler re-fetches and
        // renders the fresh state.
        if (this._pendingAction) { return; }
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
            '<h2>' + escapeHtml(tFb('overview_pane.title', 'Council overview')) + '</h2>',
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
            html.push('<h3>' + escapeHtml(classLabelFor(k)) + '</h3>');
            html.push('<ul class="enm-overview-rows" role="list">');
            rows.forEach(function (c) {
                html.push(self._rowHtml(c));
            });
            html.push('</ul>');
            html.push('</section>');
        });
        if (!hasRows) {
            html.push('<div class="enm-overview-empty">');
            html.push('<p><strong>' + escapeHtml(tFb('overview_pane.empty_title', 'No chains configured yet.')) + '</strong></p>');
            html.push('<p>' + escapeHtml(tFb('overview_pane.empty_body',
                'Use the setup wizard to install your first chain. Once Main chain '
                + 'is running you can add EVM sidechains, Oracles, and Arbiter from '
                + 'the same wizard.')) + '</p>');
            html.push('</div>');
        }
        html.push('</div>');
        this._root.innerHTML = html.join('');

        // Wire row clicks → chain-selector dispatch. A click on a quick-action
        // button runs the action instead of routing; a click anywhere else on
        // the row (including the explicit open button, which bubbles here)
        // routes. v0.5.187 a11y — the row is no longer role="button"/tabindex,
        // so there's no row keydown handler: the open button + action buttons
        // are native <button>s and handle Enter/Space themselves (their click
        // bubbles to this handler).
        var rowEls = this._root.querySelectorAll('.enm-overview-row');
        Array.prototype.forEach.call(rowEls, function (row) {
            row.addEventListener('click', function (ev) {
                var actionBtn = ev.target && ev.target.closest
                    ? ev.target.closest('.enm-overview-action') : null;
                if (actionBtn) {
                    ev.stopPropagation();
                    self._onAction(actionBtn.dataset.action, actionBtn.dataset.chainId, actionBtn);
                    return;
                }
                self._routeToChain(row.dataset.chainId);
            });
        });

        // Sparklines — only re-mount the diff. Tear down any chain that
        // disappeared from the snapshot or stopped being alive; mount
        // any newly-alive chain.
        this._reconcileSparklines(sorted);
    };

    /** @private — v0.5.186 (Council Node UX P2.1) — control-center row: name +
     * state chip + a class-specific operational line (height + sync badge for
     * A/B, "relays for <parent>" for C) + uptime + sparkline + open-arrow. All
     * values are real (from the Phase 1-enriched /council/overview); when a value
     * is genuinely unknown (e.g. height before RPC warms) we show an honest
     * "height pending…", never a guess. */
    EnmMultiChainOverviewPane.prototype._rowHtml = function (c) {
        var stateClass = 'state-' + escapeAttr(c.state || 'unknown');
        var uptime = c.uptimeSec != null ? formatUptime(c.uptimeSec) : '';
        var displayName = chainNameFor(c.chainId, c.displayName);
        var stateLabel = stateLabelFor(c.state);
        var ariaLabel = tFb('overview_pane.row_aria_open', 'Open {chainName} dashboard', { chainName: displayName });
        var chainIdAttr = escapeAttr(c.chainId);
        // Always render the uptime cell (empty when unknown) so the 5-column
        // grid stays aligned — an empty cell keeps the open-arrow in its column.
        var uptimeHtml = uptime
            ? '<span class="enm-overview-uptime" title="Uptime since last start">' + escapeHtml(uptime) + '</span>'
            : '<span class="enm-overview-uptime" aria-hidden="true"></span>';
        // v0.5.187 a11y — the row is NOT role="button"/tabindex anymore: it
        // contains real <button> quick-actions + an explicit open button, and
        // interactive-inside-a-button is invalid ARIA. The row stays
        // mouse-clickable (progressive enhancement); keyboard users reach the
        // open button + action buttons directly.
        return '<li class="enm-overview-row" data-chain-id="' + chainIdAttr
            + '" data-state="' + escapeAttr(c.state || 'unknown') + '">'
            + '<span class="enm-overview-dot ' + stateClass + '" aria-hidden="true"></span>'
            + '<div class="enm-overview-main">'
            +   '<div class="enm-overview-line1">'
            +     '<span class="enm-overview-name">' + escapeHtml(displayName) + '</span>'
            +     '<span class="enm-overview-state ' + stateClass + '">' + escapeHtml(stateLabel) + '</span>'
            +   '</div>'
            +   '<div class="enm-overview-meta">' + this._metaHtml(c) + '</div>'
            + '</div>'
            + '<span class="enm-overview-spark" data-chain-id="' + chainIdAttr + '"></span>'
            + uptimeHtml
            + this._actionsHtml(c)
            + '<button type="button" class="enm-overview-open" data-chain-id="' + chainIdAttr + '"'
            +   ' aria-label="' + escapeAttr(ariaLabel) + '">›</button>'
            + '</li>';
    };

    /** @private — v0.5.186 (Council Node UX P2.2) — state-gated compact quick
     * actions. alive → Restart + Stop; stopped → Start; disabled/unconfigured →
     * none (manage those in Settings). Buttons carry data-action + data-chain-id;
     * the row delegate intercepts their clicks so acting on a chain never also
     * navigates into it. Always rendered (the empty cell keeps the grid aligned)
     * and always visible for touch discoverability. */
    EnmMultiChainOverviewPane.prototype._actionsHtml = function (c) {
        var cid = escapeAttr(c.chainId);
        function btn(action, glyph, key, fallback, cls) {
            var label = tFb(key, fallback);
            return '<button type="button" class="enm-overview-action ' + cls + '"'
                + ' data-action="' + action + '" data-chain-id="' + cid + '"'
                + ' title="' + escapeAttr(label) + '" aria-label="' + escapeAttr(label) + '">'
                + '<span aria-hidden="true">' + glyph + '</span>'
                + '</button>';
        }
        var inner = '';
        if (c.alive) {
            inner += btn('restart', '⟳', 'chain_actions.restart', 'Restart', 'is-restart');
            inner += btn('stop', '■', 'chain_actions.stop', 'Stop', 'is-stop');
        } else if (c.state === 'stopped') {
            inner += btn('start', '▶', 'chain_actions.start', 'Start', 'is-start');
        }
        return '<span class="enm-overview-actions">' + inner + '</span>';
    };

    /** @private — P2.2 quick action runner. Mirrors chain-card._do: pane-wide
     * busy guard, pending button state, POST, success/fail toast (incl. 401
     * suppression + 409 host-conflict remediation), then a fresh re-fetch.
     * Disruptive actions (stop/restart) confirm first; start does not. */
    EnmMultiChainOverviewPane.prototype._onAction = function (kind, chainId, btn) {
        if (!kind || !chainId || !btn) { return; }
        if (this._pendingAction) { return; }  // one action at a time, pane-wide
        var displayName = chainNameFor(chainId, null);
        if (kind === 'stop' || kind === 'restart') {
            var confirmMsg = tFb(
                'overview_pane.action_confirm',
                'Are you sure you want to {action} {chainName}? In-progress sync work will be interrupted.',
                { action: kind, chainName: displayName });
            if (typeof root.confirm === 'function' && !root.confirm(confirmMsg)) { return; }
        }
        this._pendingAction = { chainId: chainId, kind: kind };
        var self = this;
        var glyphSpan = btn.querySelector('span');
        var prevGlyph = glyphSpan ? glyphSpan.innerHTML : '';
        btn.disabled = true;
        btn.classList.add('is-busy');
        var pastVerb = ({ start: 'started', stop: 'stopped', restart: 'restarted' })[kind] || kind;
        this.api.post('/chains/' + chainId + '/' + kind).then(function () {
            if (self.notifications && typeof self.notifications.info === 'function') {
                self.notifications.info(displayName + ' ' + pastVerb, '');
            }
        }).catch(function (err) {
            if (err && err.status === 401) { return; }  // boot path owns re-auth UX
            if (!self.notifications) { return; }
            if (err && err.body && Array.isArray(err.body.conflicts) && err.body.conflicts.length > 0) {
                var blockers = err.body.conflicts.filter(function (cf) { return cf && cf.severity === 'CRITICAL'; });
                var summary = blockers.map(function (cf) {
                    var firstStep = cf.remediation && cf.remediation[0];
                    var stepStr = (typeof firstStep === 'string' && firstStep.length > 0) ? firstStep : '';
                    var descStr = (typeof cf.description === 'string' && cf.description.length > 0) ? cf.description : 'Host conflict';
                    return '• ' + descStr + (stepStr ? ('\n   ' + stepStr) : '');
                }).join('\n');
                if (typeof self.notifications.critical === 'function') {
                    self.notifications.critical('Cannot ' + kind + ' ' + displayName + ' — host conflicts', summary);
                }
            } else if (typeof self.notifications.warning === 'function') {
                self.notifications.warning('Failed to ' + kind + ' ' + displayName, err && err.message ? err.message : String(err));
            }
        }).then(function () {
            self._pendingAction = null;
            if (self._destroyed) { return; }
            // Restore the button in case the upcoming fetch is slow, then
            // re-fetch fresh state (SSE was suppressed while pending).
            btn.disabled = false;
            btn.classList.remove('is-busy');
            if (glyphSpan) { glyphSpan.innerHTML = prevGlyph; }
            self._fetchInitial();
        });
    };

    /** @private — the class-specific operational detail line. Truthful: only
     * renders what the snapshot actually carries. */
    EnmMultiChainOverviewPane.prototype._metaHtml = function (c) {
        var klass = c.chainClass;
        // Class C (oracle) — what EVM sidechain it relays for.
        if (klass === 'C') {
            if (c.parentChainId) {
                return '<span class="enm-overview-relays">'
                    + escapeHtml(tFb('overview_pane.relays_for', 'Relays for {parent}',
                        { parent: chainNameFor(c.parentChainId, null) }))
                    + '</span>';
            }
            return '';
        }
        // Class A / B — block height + sync badge (real, from SyncTracker enrichment).
        if (klass === 'A' || klass === 'B') {
            if (typeof c.height === 'number') {
                return '<span class="enm-overview-height">'
                    + escapeHtml(tFb('overview_pane.block', 'Block {n}', { n: formatNumber(c.height) }))
                    + '</span>'
                    + this._syncBadgeHtml(c);
            }
            if (c.alive) {
                // alive but RPC hasn't reported height yet — honest, not a guess.
                return '<span class="enm-overview-meta-muted">'
                    + escapeHtml(tFb('overview_pane.height_pending', 'height pending…'))
                    + '</span>';
            }
            return '';
        }
        // Class D (arbiter) / E / unknown — the state chip already carries status;
        // no chain height exists for these services in the overview snapshot.
        return '';
    };

    /** @private — sync-state badge from the real enriched syncState; empty when
     * we have no network reference (we never fake "synced"). */
    EnmMultiChainOverviewPane.prototype._syncBadgeHtml = function (c) {
        if (c.syncState === 'synced') {
            return '<span class="enm-sync-badge synced">'
                + escapeHtml(tFb('overview_pane.synced', 'Synced')) + '</span>';
        }
        if (c.syncState === 'stalled') {
            return '<span class="enm-sync-badge stalled">'
                + escapeHtml(tFb('overview_pane.stalled', 'Stalled')) + '</span>';
        }
        if (c.syncState === 'syncing') {
            var pct = (typeof c.syncPercent === 'number') ? (' ' + Math.floor(c.syncPercent) + '%') : '';
            return '<span class="enm-sync-badge syncing">'
                + escapeHtml(tFb('overview_pane.syncing', 'Syncing') + pct) + '</span>';
        }
        return '';
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._summaryLine = function (totals) {
        if (!totals || !totals.total) {
            return tFb('overview_pane.summary_no_chains', 'No chains yet.');
        }
        // Simple " · "-joined assembly. Per-locale grammar can override
        // by providing a 'summary_running'/'summary_of_total'/etc string
        // template in a later i18n pass; for M2.6 English-only it's
        // fine to construct in place.
        var bits = [];
        bits.push(totals.running + ' running');
        if (totals.stopped > 0) { bits.push(totals.stopped + ' stopped'); }
        if (totals.disabled > 0) { bits.push(totals.disabled + ' disabled'); }
        bits.push(totals.total + ' total');
        return bits.join(' · ');
    };

    /** @private */
    EnmMultiChainOverviewPane.prototype._reconcileSparklines = function (chains) {
        if (!this.heightSeries || typeof this.heightSeries.subscribe !== 'function') { return; }
        if (!root.EnmSparkline) { return; }
        var self = this;
        // Set of chainIds that should have a sparkline right now.
        // 0.5.9 audit Session 9 — also include 'starting' state. A chain
        // that just spawned via Card 6's start-chains step may have
        // alive=false for the first ~5 sec of the boot window; pre-0.5.9
        // its sparkline holder stayed empty even though height events
        // would arrive moments later. Including 'starting' gives the
        // sparkline mount time to be ready when the first height-series
        // event lands.
        var wanted = {};
        chains.forEach(function (c) {
            if (c.alive || c.state === 'starting') { wanted[c.chainId] = true; }
        });
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
                color: 'var(--success)',
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
                this.announcer.polite(tFb(
                    'overview_pane.announce_switched_to',
                    'Switched to {chainName}',
                    { chainName: chainNameFor(chainId, null) },
                ));
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

    // v0.5.186 (Council Node UX P2.1) — thousands-separated block height.
    // Prefer the shared util when present (utils.js enmFormatNumber); fall
    // back to a local Intl/regex grouping so the component still works in
    // unit tests that don't load utils.js.
    function formatNumber(n) {
        if (typeof n !== 'number' || !isFinite(n)) { return String(n); }
        if (typeof root.enmFormatNumber === 'function') {
            try { return root.enmFormatNumber(n); } catch (_) { /* fall through */ }
        }
        try { return n.toLocaleString('en-US'); } catch (_) { /* fall through */ }
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
