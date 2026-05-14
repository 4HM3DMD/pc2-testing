/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/audit-tab.js — beta.3 redesign.
 *
 * Hits GET /api/audit?chainId=&tier=&from=&to=. Renders rows in a
 * semantic <table> with sticky thead, chip-based When + Tier filters,
 * and a slide-in right-side drawer that exposes the per-row payload +
 * duration (fields the API already returns; the v0.1 table never
 * rendered them — see routes/audit.js:94–120 decodeRow()).
 *
 * The "Copy filtered rows" toolbar button replaces the v0.1 JSON Blob
 * download: same /audit?limit=500 fetch, written as TSV to the
 * clipboard so the operator can paste straight into a ticket. The
 * drawer Copy button writes just the row's payload JSON.
 *
 * alpha.28 invariants preserved verbatim:
 *   - _destroyed guard on every .then() resolver (load AND copy)
 *   - 401 suppression on every API call (boot path owns re-auth)
 *   - 5000-row session cap on accumulated rows (MAX_ROWS)
 *   - encodeURIComponent on every dynamic query-string segment
 *   - _loadSeq stale-fetch sentinel (filter-change race fix)
 *   - row-count i18n with singular split + grouped numbers
 */

(function (root) {
    'use strict';

    var PAGE_SIZE = 100;
    // Hard cap on accumulated rows — same rationale as alpha.27: with
    // audit retention.days = 0 an unbounded session could leak DOM.
    // 5000 fits ~50 days of typical healing activity; operators wanting
    // more should narrow filters or use the Copy button (limit=500).
    var MAX_ROWS = 5000;
    var COPY_LIMIT = 500;
    // Drawer slide-out transition. Matches the settings-drawer 320ms so
    // the visual cadence is consistent across the app.
    var DRAWER_CLOSE_MS = 320;

    var TIER_VALUES = [
        'AUTOMATED-SAFE',
        'OWNER-CONFIRMS',
        'CRITICAL-NOTIFY',
        'NEVER-AUTOMATIC',
        'HTTP-MUTATION',
    ];
    // Time-range chip presets. `null` means "no filter" (All time).
    // Custom is a future hook — clicking renders an info toast.
    var WHEN_PRESETS = {
        all:    { label: 'All time' },
        today:  { label: 'Today' },
        '7d':   { label: '7 days',  ms: 7  * 24 * 3600 * 1000 },
        '30d':  { label: '30 days', ms: 30 * 24 * 3600 * 1000 },
        custom: { label: 'Custom…', future: true },
    };

    function AuditTab(opts) {
        if (!opts || !opts.api || !opts.notifications) {
            throw new TypeError('AuditTab: { api, notifications } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications;

        this.root = document.createElement('section');
        this.root.className = 'enm-audit';

        this._offset = 0;
        this._rows = [];
        // alpha.28.1 batch 16 — _destroyed flag + _loadSeq sequence
        // number preserved verbatim from alpha.27. _destroyed gates
        // every async resolver against detached-DOM writes; _loadSeq
        // makes stale Load-more fetches no-op after refresh() bumps
        // the seq (filter-change race fix).
        this._destroyed = false;
        this._loadSeq = 0;

        // Filter state. `tier` is one of TIER_VALUES or '' (any).
        // `when` is a key of WHEN_PRESETS. `from`/`to` are epoch ms
        // derived from `when` at refresh() time.
        this._filters = { tier: '', when: 'all' };

        // Drawer state.
        this._drawer = null;
        this._drawerScrim = null;
        this._drawerOpen = false;
        this._drawerRowEl = null;     // currently expanded <tr>, if any
        this._previousFocus = null;
        this._escHandler = null;
        this._trapHandler = null;
        this._drawerCloseTimer = null;

        this._renderShell();
    }

    AuditTab.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        return this;
    };

    AuditTab.prototype.destroy = function () {
        this._destroyed = true;
        // Bump the seq so any in-flight fetch's resolver short-circuits.
        this._loadSeq += 1;
        // Tear down drawer global listeners if the drawer was open at
        // destroy time. Same reasoning as settings-drawer: a leaked
        // keydown listener fires into detached DOM and breaks Tab
        // navigation elsewhere in the app.
        this._teardownDrawerListeners();
        if (this._drawerCloseTimer) {
            clearTimeout(this._drawerCloseTimer);
            this._drawerCloseTimer = null;
        }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** Refresh from offset 0. */
    AuditTab.prototype.refresh = function () {
        // Bump the seq BEFORE clearing state so any in-flight Load-more
        // resolves into a stale-seq check and bails before touching
        // _rows / _tbody. (alpha.28.1 batch 16.)
        this._loadSeq += 1;
        this._offset = 0;
        this._rows = [];
        // Close drawer on refresh — the row it pointed at may no
        // longer exist after a filter change.
        if (this._drawerOpen) { this._closeDrawer(); }
        return this._loadMore(true);
    };

    // ------------------------------------------------------------------
    // Data loading
    // ------------------------------------------------------------------

    /** @private */
    AuditTab.prototype._loadMore = function (clear) {
        var self = this;
        var t = root.enmTOrFallback;
        var mySeq = this._loadSeq;
        var qs = this._currentFilterQs();
        qs += (qs ? '&' : '') + 'limit=' + PAGE_SIZE + '&offset=' + this._offset;
        return this.api.get('/audit?' + qs, { skipCache: true }).then(function (data) {
            if (self._destroyed || self._loadSeq !== mySeq) { return; }
            var entries = (data && data.entries) || [];
            if (clear) {
                self._tbody.innerHTML = '';
                self._rows = [];
            }
            self._rows = self._rows.concat(entries);
            entries.forEach(function (e) { self._appendRow(e); });
            self._offset += entries.length;

            var endOfFeed = (entries.length < PAGE_SIZE);
            var capReached = (self._rows.length >= MAX_ROWS);

            self._loadMoreBtn.disabled = endOfFeed || capReached;
            self._loadMoreBtn.textContent = capReached
                ? t('audit.load_more_capped')
                : t('audit.load_more');

            // Grouped row count — same i18n shape as alpha.27 (split
            // singular/plural keys so "1 rows" never prints).
            var fmtCount = (typeof window !== 'undefined' && window.enmFormatNumber)
                ? window.enmFormatNumber
                : function (n) { return String(n); };
            var n = self._rows.length;
            var rowsKeyId = n === 1 ? 'audit.row_count_one' : 'audit.row_count';
            var rowsKey = t(rowsKeyId, { n: fmtCount(n) });
            self._countLabel.textContent = (rowsKey && rowsKey !== rowsKeyId)
                ? rowsKey
                : fmtCount(n) + (n === 1 ? ' row' : ' rows');

            self._emptyMsg.hidden = (self._rows.length !== 0);
            // Hide the table wrap when empty so the empty-state has
            // visual weight; the foot stays attached to the wrap so
            // it disappears with it.
            self._tableWrap.hidden = (self._rows.length === 0);
        }).catch(function (err) {
            if (self._destroyed || self._loadSeq !== mySeq) { return; }
            // alpha.28.1 batch 51 — 401 suppressed (boot path owns
            // re-auth). Without this, an expired session triggered
            // a "Failed to load audit log" toast every filter-Apply
            // click. (Audit ad49e60e ⚠ 401-not-filtered finding.)
            if (err && err.status === 401) { return; }
            self.notifications.show({
                id: 'audit-load-fail',
                severity: 'warning',
                title: 'Failed to load audit log',
                body: err.message || String(err),
            });
        });
    };

    /** @private */
    AuditTab.prototype._currentFilterQs = function () {
        var parts = [];
        if (this._filters.tier) {
            parts.push('tier=' + encodeURIComponent(this._filters.tier));
        }
        var range = this._currentWhenRange();
        if (range.from != null) { parts.push('from=' + encodeURIComponent(range.from)); }
        if (range.to   != null) { parts.push('to='   + encodeURIComponent(range.to)); }
        return parts.join('&');
    };

    /** @private */
    AuditTab.prototype._currentWhenRange = function () {
        var key = this._filters.when;
        var preset = WHEN_PRESETS[key];
        if (!preset || key === 'all' || key === 'custom') { return { from: null, to: null }; }
        if (key === 'today') {
            // Midnight UTC today.
            var now = new Date();
            var from = Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
            );
            return { from: from, to: null };
        }
        if (preset.ms) {
            return { from: Date.now() - preset.ms, to: null };
        }
        return { from: null, to: null };
    };

    // ------------------------------------------------------------------
    // Shell + chrome
    // ------------------------------------------------------------------

    /** @private */
    AuditTab.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        var self = this;

        // --- Toolbar -------------------------------------------------
        var toolbar = el('div', 'enm-audit-toolbar');
        var title = el('h2', 'enm-audit-title');
        title.id = 'enm-audit-title';
        title.textContent = t('audit.heading');
        toolbar.appendChild(title);
        // Scope note — mock has "All chains · 90-day retention" as a
        // secondary line. Phrased neutrally because the retention
        // window is operator-configured (general_audit_retention).
        var scope = el('div', 'enm-audit-scope-note');
        scope.textContent = 'All chains · audit retention as configured';
        toolbar.appendChild(scope);

        var actions = el('div', 'enm-audit-actions');
        this._copyBtn = btn(t('audit.copy_filtered') || 'Copy filtered rows',
            'enm-btn-secondary enm-audit-copy', function () { self._copyTsv(); });
        actions.appendChild(this._copyBtn);
        toolbar.appendChild(actions);
        this.root.appendChild(toolbar);

        // --- Filters -------------------------------------------------
        this.root.appendChild(this._renderFilterBar());

        // --- Table wrap ---------------------------------------------
        var wrap = el('div', 'enm-audit-table-wrap');
        this._tableWrap = wrap;
        var scroller = el('div', 'enm-audit-table-scroller');
        var table = document.createElement('table');
        table.className = 'enm-audit-table';
        // a11y: scope=col so screen readers announce the header for
        // each cell when navigating the table grid.
        var thead = document.createElement('thead');
        var theadRow = document.createElement('tr');
        var headerKeys = [
            { key: 'col_ts',       cls: 'col-ts' },
            { key: 'col_chain',    cls: 'col-chain' },
            { key: 'col_rule',     cls: 'col-rule' },
            { key: 'col_tier',     cls: 'col-tier' },
            { key: 'col_decision', cls: 'col-decision' },
            { key: 'col_executor', cls: 'col-executor' },
            { key: 'col_outcome',  cls: 'col-outcome' },
        ];
        headerKeys.forEach(function (h) {
            var th = document.createElement('th');
            th.className = h.cls;
            th.scope = 'col';
            th.textContent = t('audit.' + h.key);
            theadRow.appendChild(th);
        });
        thead.appendChild(theadRow);
        table.appendChild(thead);
        this._tbody = document.createElement('tbody');
        table.appendChild(this._tbody);
        scroller.appendChild(table);
        wrap.appendChild(scroller);

        // --- Foot (count + Load more) -------------------------------
        var foot = el('div', 'enm-audit-foot');
        this._countLabel = el('span', 'enm-audit-count');
        foot.appendChild(this._countLabel);
        this._loadMoreBtn = btn(t('audit.load_more'),
            'enm-btn-secondary enm-audit-load-more',
            function () { self._loadMore(false); });
        foot.appendChild(this._loadMoreBtn);
        wrap.appendChild(foot);
        this.root.appendChild(wrap);

        // --- Empty state --------------------------------------------
        this._emptyMsg = el('p', 'enm-audit-empty');
        this._emptyMsg.textContent = t('audit.empty');
        this._emptyMsg.hidden = true;
        this.root.appendChild(this._emptyMsg);

        // Drawer DOM is built lazily on first open — until then the
        // pane is just the table.
    };

    /** @private */
    AuditTab.prototype._renderFilterBar = function () {
        var t = root.enmTOrFallback;
        var self = this;
        var bar = el('div', 'enm-audit-filters');

        // --- When group ---------------------------------------------
        var whenGroup = el('div', 'enm-audit-filter-group');
        whenGroup.setAttribute('role', 'group');
        whenGroup.setAttribute('aria-label', t('audit.filter_when') || 'When');
        var whenLabel = el('span', 'enm-audit-filter-label');
        whenLabel.textContent = t('audit.filter_when') || 'When';
        whenGroup.appendChild(whenLabel);
        this._whenChips = {};
        ['all', 'today', '7d', '30d', 'custom'].forEach(function (key) {
            var chip = chipBtn(WHEN_PRESETS[key].label, key === 'all');
            chip.dataset.when = key;
            chip.addEventListener('click', function () { self._onWhenChip(key); });
            self._whenChips[key] = chip;
            whenGroup.appendChild(chip);
        });
        bar.appendChild(whenGroup);

        // --- Tier group ---------------------------------------------
        var tierGroup = el('div', 'enm-audit-filter-group');
        tierGroup.setAttribute('role', 'group');
        tierGroup.setAttribute('aria-label', t('audit.filter_tier') || 'Tier');
        var tierLabel = el('span', 'enm-audit-filter-label');
        tierLabel.textContent = t('audit.filter_tier') || 'Tier';
        tierGroup.appendChild(tierLabel);
        this._tierChips = {};

        var anyChip = chipBtn(t('audit.tier_any') || 'Any', true);
        anyChip.dataset.tier = '';
        anyChip.addEventListener('click', function () { self._onTierChip(''); });
        this._tierChips[''] = anyChip;
        tierGroup.appendChild(anyChip);

        TIER_VALUES.forEach(function (tier) {
            var chip = chipBtn(tier, false);
            chip.dataset.tier = tier;
            chip.addEventListener('click', function () { self._onTierChip(tier); });
            self._tierChips[tier] = chip;
            tierGroup.appendChild(chip);
        });
        bar.appendChild(tierGroup);

        return bar;
    };

    /** @private */
    AuditTab.prototype._onWhenChip = function (key) {
        var preset = WHEN_PRESETS[key];
        if (preset && preset.future) {
            // Custom is a future hook. Toast informs the operator the
            // surface is intentional, not broken.
            if (this.notifications && this.notifications.info) {
                this.notifications.info('Custom date range coming soon', '');
            }
            return;
        }
        if (this._filters.when === key) { return; }
        this._filters.when = key;
        this._syncChipGroup(this._whenChips, key);
        this.refresh();
    };

    /** @private */
    AuditTab.prototype._onTierChip = function (tier) {
        if (this._filters.tier === tier) { return; }
        this._filters.tier = tier;
        this._syncChipGroup(this._tierChips, tier);
        this.refresh();
    };

    /** @private */
    AuditTab.prototype._syncChipGroup = function (chipMap, activeKey) {
        Object.keys(chipMap).forEach(function (k) {
            var chip = chipMap[k];
            var match = (k === activeKey);
            if (match) { chip.classList.add('active'); }
            else { chip.classList.remove('active'); }
            chip.setAttribute('aria-pressed', match ? 'true' : 'false');
        });
    };

    // ------------------------------------------------------------------
    // Row rendering
    // ------------------------------------------------------------------

    /** @private */
    AuditTab.prototype._appendRow = function (e) {
        var self = this;
        var tr = document.createElement('tr');
        tr.dataset.tier = e.tier || '';
        // a11y: row is keyboard-actionable. Enter opens the drawer.
        tr.setAttribute('tabindex', '0');
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-label',
            (e.ruleId || e.rule_id || '—') + ' · ' + (e.decision || ''));

        addCell(tr, 'col-ts',       formatTs(e.ts),                 formatTsLocal(e.ts));
        addCell(tr, 'col-chain',    e.chainId || e.chain_id || '—');
        addCell(tr, 'col-rule',     e.ruleId  || e.rule_id  || '—');
        addBadgeCell(tr, 'col-tier',    e.tier   || '—', 'enm-tier-badge',    { tier: e.tier });
        addCell(tr, 'col-decision', e.decision || '—');
        addCell(tr, 'col-executor', shortenWallet(e.executor),      e.executor || '');
        addBadgeCell(tr, 'col-outcome', e.outcome || '—', 'enm-outcome-badge',
            { kind: outcomeKind(e.outcome) });

        // Row-index lookup so Prev/Next walk siblings without DOM math.
        var idx = this._rows.length - 1;
        tr.dataset.idx = String(idx);

        var openFromRow = function () { self._openDrawer(idx); };
        tr.addEventListener('click', openFromRow);
        tr.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                openFromRow();
            }
        });

        this._tbody.appendChild(tr);
    };

    // ------------------------------------------------------------------
    // Drawer
    // ------------------------------------------------------------------

    /** @private */
    AuditTab.prototype._ensureDrawer = function () {
        if (this._drawer) { return; }
        var self = this;

        this._drawerScrim = el('div', 'enm-audit-drawer-scrim');
        this._drawerScrim.hidden = true;
        this._drawerScrim.addEventListener('click', function () { self._closeDrawer(); });
        this.root.appendChild(this._drawerScrim);

        // a11y: role=dialog + aria-modal + aria-labelledby points at
        // the rule-id title. Same canonical pattern as settings-drawer.
        var d = document.createElement('div');
        d.className = 'enm-audit-drawer';
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-modal', 'true');
        d.setAttribute('aria-labelledby', 'enm-audit-drawer-title');
        d.hidden = true;

        d.innerHTML =
            '<div class="enm-audit-drawer-head">'
              + '<div class="enm-audit-drawer-head-body">'
                + '<div class="enm-audit-drawer-tier"></div>'
                + '<div class="enm-audit-drawer-title-mono" id="enm-audit-drawer-title"></div>'
                + '<div class="enm-audit-drawer-ts"></div>'
              + '</div>'
              + '<button type="button" class="enm-icon-btn enm-audit-drawer-close" aria-label="Close">×</button>'
            + '</div>'
            + '<div class="enm-audit-drawer-body">'
              + '<div class="enm-drawer-decision"></div>'
              + '<div class="enm-drawer-kv"></div>'
              + '<div class="enm-drawer-payload-section">'
                + '<div class="enm-drawer-payload-head">'
                  + '<span class="enm-drawer-payload-title">Payload</span>'
                  + '<button type="button" class="enm-btn enm-btn-secondary enm-btn-sm enm-drawer-payload-copy">Copy</button>'
                + '</div>'
                + '<pre class="enm-drawer-payload"></pre>'
              + '</div>'
            + '</div>'
            + '<div class="enm-audit-drawer-foot">'
              + '<button type="button" class="enm-btn enm-btn-secondary enm-drawer-prev">← Prev</button>'
              + '<button type="button" class="enm-btn enm-btn-secondary enm-drawer-next">Next →</button>'
            + '</div>';

        d.querySelector('.enm-audit-drawer-close')
            .addEventListener('click', function () { self._closeDrawer(); });
        d.querySelector('.enm-drawer-prev')
            .addEventListener('click', function () { self._stepDrawer(-1); });
        d.querySelector('.enm-drawer-next')
            .addEventListener('click', function () { self._stepDrawer(+1); });
        d.querySelector('.enm-drawer-payload-copy')
            .addEventListener('click', function () { self._copyDrawerPayload(); });

        this._drawer = d;
        this.root.appendChild(d);
    };

    /** @private */
    AuditTab.prototype._openDrawer = function (idx) {
        if (idx < 0 || idx >= this._rows.length) { return; }
        this._ensureDrawer();
        var entry = this._rows[idx];
        var self = this;

        // Mark the row expanded; clear the previous one.
        if (this._drawerRowEl) {
            this._drawerRowEl.classList.remove('expanded');
        }
        var rowEl = this._tbody.querySelector('tr[data-idx="' + idx + '"]');
        if (rowEl) {
            rowEl.classList.add('expanded');
            this._drawerRowEl = rowEl;
        }
        this._drawerIdx = idx;

        // Populate.
        this._fillDrawer(entry);

        // Show.
        var firstOpen = !this._drawerOpen;
        this._drawerOpen = true;
        this._drawerScrim.hidden = false;
        this._drawer.hidden = false;

        if (firstOpen) {
            // a11y: remember focus origin so close returns there.
            this._previousFocus = document.activeElement;
            // Wire global listeners only on first open. Step navigation
            // doesn't need to re-register them.
            var closeBtn = this._drawer.querySelector('.enm-audit-drawer-close');
            // Defer focus to next frame so the transition has started.
            requestAnimationFrame(function () {
                if (closeBtn && typeof closeBtn.focus === 'function') {
                    closeBtn.focus();
                }
            });
            this._escHandler = function (ev) {
                if (ev.key === 'Escape') { self._closeDrawer(); }
            };
            document.addEventListener('keydown', this._escHandler);

            // Focus trap — Tab and Shift+Tab cycle within the drawer.
            // Same shape as settings-drawer (alpha.28.1 batch 65, alpha.29
            // batch 95): same selector for first-focus and trap-bounds;
            // re-anchor focus inside the drawer if it was pushed out.
            this._trapHandler = function (ev) {
                if (ev.key !== 'Tab' || !self._drawerOpen || !self._drawer) { return; }
                var focusables = self._drawer.querySelectorAll(
                    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
                );
                if (focusables.length === 0) { return; }
                var firstEl = focusables[0];
                var lastEl  = focusables[focusables.length - 1];
                if (!self._drawer.contains(document.activeElement)) {
                    ev.preventDefault();
                    firstEl.focus();
                    return;
                }
                if (ev.shiftKey && document.activeElement === firstEl) {
                    ev.preventDefault();
                    lastEl.focus();
                } else if (!ev.shiftKey && document.activeElement === lastEl) {
                    ev.preventDefault();
                    firstEl.focus();
                }
            };
            document.addEventListener('keydown', this._trapHandler, true);
        }
    };

    /** @private */
    AuditTab.prototype._closeDrawer = function () {
        if (!this._drawerOpen) { return; }
        this._drawerOpen = false;
        if (this._drawerRowEl) {
            this._drawerRowEl.classList.remove('expanded');
            this._drawerRowEl = null;
        }
        this._teardownDrawerListeners();

        // a11y: restore focus to the element that opened the drawer.
        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            try { this._previousFocus.focus(); } catch (_) { /* gone */ }
        }
        this._previousFocus = null;

        // Hide after a short delay so a CSS slide-out transition (if
        // any) can play. Matches the settings-drawer cadence.
        var self = this;
        if (this._drawerCloseTimer) { clearTimeout(this._drawerCloseTimer); }
        this._drawerCloseTimer = setTimeout(function () {
            self._drawerCloseTimer = null;
            if (!self._drawerOpen && self._drawer) {
                self._drawer.hidden = true;
            }
            if (!self._drawerOpen && self._drawerScrim) {
                self._drawerScrim.hidden = true;
            }
        }, DRAWER_CLOSE_MS);
    };

    /** @private */
    AuditTab.prototype._teardownDrawerListeners = function () {
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        if (this._trapHandler) {
            document.removeEventListener('keydown', this._trapHandler, true);
            this._trapHandler = null;
        }
    };

    /** @private */
    AuditTab.prototype._stepDrawer = function (delta) {
        if (!this._drawerOpen || this._drawerIdx == null) { return; }
        var next = this._drawerIdx + delta;
        if (next < 0 || next >= this._rows.length) { return; }
        this._openDrawer(next);
    };

    /** @private */
    AuditTab.prototype._fillDrawer = function (e) {
        var d = this._drawer;
        if (!d || !e) { return; }
        var tier = e.tier || '';

        // Head — tier badge + rule id (mono) + ts.
        var tierWrap = d.querySelector('.enm-audit-drawer-tier');
        tierWrap.innerHTML = '';
        if (tier) {
            var badge = el('span', 'enm-tier-badge');
            badge.setAttribute('data-tier', tier);
            badge.textContent = tier;
            tierWrap.appendChild(badge);
        }
        var titleEl = d.querySelector('.enm-audit-drawer-title-mono');
        titleEl.textContent = e.ruleId || e.rule_id || '—';
        var tsEl = d.querySelector('.enm-audit-drawer-ts');
        tsEl.textContent = formatTs(e.ts) + (e.id ? ' · id=' + e.id : '');

        // Decision line — show decision verb + tier path.
        var dec = d.querySelector('.enm-drawer-decision');
        dec.innerHTML = '';
        var decisionPrefix = document.createElement('strong');
        decisionPrefix.textContent = 'Decision: ' + (e.decision || '—');
        dec.appendChild(decisionPrefix);
        if (tier) {
            dec.appendChild(document.createTextNode(' · ' + tier + ' path'));
        }

        // KV grid.
        var kv = d.querySelector('.enm-drawer-kv');
        kv.innerHTML = '';
        addKv(kv, 'Chain',    e.chainId || e.chain_id || '—');
        addKv(kv, 'Rule',     e.ruleId  || e.rule_id  || '—', true);
        addKv(kv, 'Executor', e.executor || '—', true);
        var dur = (e.durationMs != null ? e.durationMs : e.duration_ms);
        addKv(kv, 'Duration',
            (dur == null || dur === '') ? '—' : (formatMs(dur)),
            true);
        // Outcome chip in the KV grid for at-a-glance status, mirroring
        // the table cell.
        var outRow = document.createElement('div');
        outRow.className = 'enm-drawer-kv-row';
        var outKey = el('span', 'enm-drawer-kv-key');
        outKey.textContent = 'Outcome';
        var outValWrap = el('span', 'enm-drawer-kv-value');
        var outBadge = el('span', 'enm-outcome-badge');
        outBadge.setAttribute('data-kind', outcomeKind(e.outcome));
        outBadge.textContent = e.outcome || '—';
        outValWrap.appendChild(outBadge);
        outRow.appendChild(outKey);
        outRow.appendChild(outValWrap);
        kv.appendChild(outRow);

        // Payload pre.
        var pre = d.querySelector('.enm-drawer-payload');
        var payload = (e.payload != null) ? e.payload : {};
        var pretty;
        try { pretty = JSON.stringify(payload, null, 2); }
        catch (_) { pretty = String(payload); }
        // innerHTML is safe here: highlightPayloadJson escapes < > & inside
        // the JSON string and ONLY emits its own <span class="..."> wrappers.
        pre.innerHTML = highlightPayloadJson(pretty);

        // Cache the current payload pretty-print on the drawer for the
        // payload Copy button to read.
        this._currentPayloadText = pretty;

        // Prev/Next disabled states.
        var prevBtn = d.querySelector('.enm-drawer-prev');
        var nextBtn = d.querySelector('.enm-drawer-next');
        prevBtn.disabled = (this._drawerIdx <= 0);
        nextBtn.disabled = (this._drawerIdx >= this._rows.length - 1);
    };

    // ------------------------------------------------------------------
    // Copy
    // ------------------------------------------------------------------

    /**
     * @private
     * Fetch up to COPY_LIMIT rows matching current filters, serialize
     * them to TSV (tab-separated, header row + one row per entry), and
     * write the string to the clipboard via enmCopyToClipboard. This
     * replaces the alpha.27 JSON Blob download per the mock spec:
     * "Copy-to-clipboard everywhere replaces JSON Blob download".
     */
    AuditTab.prototype._copyTsv = function () {
        var self = this;
        var qs = this._currentFilterQs();
        qs += (qs ? '&' : '') + 'limit=' + COPY_LIMIT + '&offset=0';
        this.api.get('/audit?' + qs, { skipCache: true }).then(function (data) {
            // alpha.29 batch 95 — _destroyed guard preserved. Without
            // it, an operator who clicks Copy and immediately switches
            // tabs would have the clipboard mutated after they've
            // navigated away.
            if (self._destroyed) { return; }
            var entries = (data && data.entries) || [];
            var tsv = entriesToTsv(entries);

            var nf = self.notifications;
            var copyBtn = self._copyBtn;
            if (root.enmCopyToClipboard) {
                root.enmCopyToClipboard(tsv, {
                    btn: copyBtn,
                    copiedLabel: 'Copied!',
                    notifications: nf,
                    notifyOnSuccess: !copyBtn,
                    successTitle: 'Audit rows copied',
                    successBody: entries.length.toLocaleString() + ' row'
                        + (entries.length === 1 ? '' : 's') + ' copied to clipboard.',
                    failTitle: 'Copy unavailable',
                    failBody: 'Browser blocked clipboard access.',
                });
                return;
            }
            // Fallback path.
            if (typeof navigator !== 'undefined'
                && navigator.clipboard
                && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(tsv).then(function () {
                    if (nf) { nf.info('Audit rows copied', entries.length + ' rows copied to clipboard.'); }
                }, function () {
                    if (nf) { nf.warning('Copy unavailable', 'Browser blocked clipboard access.'); }
                });
            } else if (nf) {
                nf.warning('Copy unavailable', 'Browser blocked clipboard access.');
            }
        }).catch(function (err) {
            if (self._destroyed) { return; }
            // alpha.28.1 batch 52 — same 401 suppression as the load
            // path.
            if (err && err.status === 401) { return; }
            self.notifications.show({
                id: 'audit-copy-fail',
                severity: 'warning',
                title: 'Copy failed',
                body: err.message || String(err),
            });
        });
    };

    /** @private */
    AuditTab.prototype._copyDrawerPayload = function () {
        var text = this._currentPayloadText || '';
        var nf = this.notifications;
        var btnEl = this._drawer && this._drawer.querySelector('.enm-drawer-payload-copy');
        if (root.enmCopyToClipboard) {
            root.enmCopyToClipboard(text, {
                btn: btnEl,
                copiedLabel: 'Copied!',
                notifications: nf,
                notifyOnSuccess: !btnEl,
                successTitle: 'Payload copied',
                successBody: 'Audit row payload copied to clipboard.',
                failTitle: 'Copy unavailable',
                failBody: 'Browser blocked clipboard access.',
            });
            return;
        }
        if (typeof navigator !== 'undefined'
            && navigator.clipboard
            && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                if (nf) { nf.info('Payload copied', ''); }
            }, function () {
                if (nf) { nf.warning('Copy unavailable', 'Browser blocked clipboard access.'); }
            });
        } else if (nf) {
            nf.warning('Copy unavailable', 'Browser blocked clipboard access.');
        }
    };

    // ------------------------------------------------------------------
    // Helpers — kept module-local because they're audit-specific
    // ------------------------------------------------------------------

    /**
     * Map a free-text outcome string to one of four data-kind values
     * the .enm-outcome-badge[data-kind] palette supports. Heuristic
     * order matters: 'skip' check first because 'no-owner-skip' would
     * otherwise match 'no-owner' alone. Failure check covers 'failure'
     * / 'failed' / 'error' / 'Unknown action'.
     */
    function outcomeKind(outcome) {
        if (outcome == null) { return 'warn'; }
        var s = String(outcome).toLowerCase();
        if (s === 'success' || s === 'acknowledged' || s === 'restarted') { return 'success'; }
        if (s.indexOf('skip') !== -1 || s.indexOf('no-owner') !== -1) { return 'skip'; }
        if (s === 'failure' || s.indexOf('fail') !== -1 || s.indexOf('error') !== -1
            || s.indexOf('unknown action') !== -1) { return 'error'; }
        // 200 OK and similar success-shaped HTTP outcomes.
        if (s.indexOf('200') === 0 || s.indexOf('2') === 0 && /^2\d\d/.test(s)) { return 'success'; }
        return 'warn';
    }

    /**
     * UTC ISO timestamp via the shared enmFormatDate helper (alpha.28.1
     * batch 35). Falls back to a manual toISOString rewrite if the
     * helper is missing (unit tests, older bundles).
     */
    function formatTs(ms) {
        return (typeof window !== 'undefined' && window.enmFormatDate)
            ? window.enmFormatDate(ms, { mode: 'iso' })
            : (ms ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—');
    }
    function formatTsLocal(ms) {
        if (!ms) return '';
        return (typeof window !== 'undefined' && window.enmFormatDate)
            ? window.enmFormatDate(ms, { mode: 'local' })
            : new Date(ms).toLocaleString();
    }

    /** Grouped ms display so a 2847 reads as "2,847 ms" in the drawer. */
    function formatMs(n) {
        var fmt = (typeof window !== 'undefined' && window.enmFormatNumber)
            ? window.enmFormatNumber
            : function (v) { return String(v); };
        return fmt(n) + ' ms';
    }

    function shortenWallet(s) {
        if (!s) return '—';
        if (s === 'system') return 'system';
        if (s.length > 12) return s.slice(0, 6) + '…' + s.slice(-4);
        return s;
    }

    /** addCell(tr, colClass, text, fullTextForTitle?) */
    function addCell(tr, colClass, text, fullText) {
        var td = document.createElement('td');
        td.className = colClass;
        td.textContent = text;
        // a11y: cells truncate with text-overflow:ellipsis on narrow
        // widths. Mirror the full text into title= so hover + screen
        // readers + copy-paste keep working when visibly clipped.
        var titleSource = (fullText != null && fullText !== '')
            ? fullText
            : (text == null ? '' : text);
        td.title = String(titleSource);
        tr.appendChild(td);
    }

    /** Emit a styled badge inside a td. */
    function addBadgeCell(tr, colClass, text, badgeClass, dataAttrs) {
        var td = document.createElement('td');
        td.className = colClass;
        var span = document.createElement('span');
        span.className = badgeClass;
        span.textContent = (text == null) ? '—' : String(text);
        if (dataAttrs) {
            Object.keys(dataAttrs).forEach(function (k) {
                if (dataAttrs[k] != null) {
                    span.setAttribute('data-' + k, String(dataAttrs[k]));
                }
            });
        }
        td.appendChild(span);
        td.title = (text == null) ? '' : String(text);
        tr.appendChild(td);
    }

    /** Emit a drawer KV row. */
    function addKv(parent, key, value, mono) {
        var row = document.createElement('div');
        row.className = 'enm-drawer-kv-row';
        var k = el('span', 'enm-drawer-kv-key');
        k.textContent = key;
        var v = el('span', 'enm-drawer-kv-value' + (mono ? ' mono' : ''));
        v.textContent = (value == null) ? '—' : String(value);
        row.appendChild(k);
        row.appendChild(v);
        parent.appendChild(row);
    }

    /**
     * Convert audit entries to TSV. Header row first, one row per
     * entry. Fields are tab-separated; embedded tabs/newlines in
     * payload-like values are flattened to spaces so a paste into a
     * ticket / spreadsheet stays one-row-per-entry.
     */
    function entriesToTsv(entries) {
        var headers = ['timestamp', 'chain', 'rule', 'tier', 'decision', 'executor', 'outcome', 'durationMs', 'payload'];
        var lines = [headers.join('\t')];
        entries.forEach(function (e) {
            var payload;
            try { payload = JSON.stringify(e.payload != null ? e.payload : null); }
            catch (_) { payload = ''; }
            var row = [
                formatTs(e.ts),
                e.chainId || e.chain_id || '',
                e.ruleId  || e.rule_id  || '',
                e.tier    || '',
                e.decision || '',
                e.executor || '',
                e.outcome  || '',
                (e.durationMs != null ? e.durationMs : (e.duration_ms != null ? e.duration_ms : '')),
                payload || '',
            ];
            lines.push(row.map(flattenForTsv).join('\t'));
        });
        return lines.join('\n');
    }
    function flattenForTsv(v) {
        if (v == null) return '';
        return String(v).replace(/[\t\r\n]+/g, ' ');
    }

    /**
     * Lightweight JSON syntax highlighter. Operates over a JSON string
     * already pretty-printed by JSON.stringify. Escapes &, <, > first
     * so the output is safe to drop into innerHTML, then wraps tokens
     * in <span class="k|s|n|b">. The regex captures (in order):
     *   - quoted strings, optionally followed by ":" → key vs string
     *   - the literals true / false / null → booleans
     *   - integer/float numbers → numbers
     *
     * Key-string match strips the trailing colon out of the span and
     * appends it raw, matching the mock's exact shape
     * (`<span class="k">"action"</span>: <span class="s">"…"</span>`).
     */
    function highlightPayloadJson(json) {
        if (json == null) return '';
        var escaped = String(json)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return escaped.replace(
            /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
            function (match) {
                if (/^"/.test(match)) {
                    var colonMatch = match.match(/^("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?$/);
                    if (colonMatch && colonMatch[2]) {
                        return '<span class="k">' + colonMatch[1] + '</span>' + colonMatch[2];
                    }
                    return '<span class="s">' + match + '</span>';
                }
                if (/^(?:true|false|null)$/.test(match)) {
                    return '<span class="b">' + match + '</span>';
                }
                return '<span class="n">' + match + '</span>';
            }
        );
    }

    function el(tag, cls) {
        var node = document.createElement(tag);
        if (cls) { node.className = cls; }
        return node;
    }

    function btn(text, cls, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-btn ' + cls;
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    /**
     * Chip button — a <button type="button"> so keyboard activation,
     * focus ring, and screen-reader semantics come for free. aria-pressed
     * reflects the active state per WAI-ARIA toggle-button pattern.
     */
    function chipBtn(label, active) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-filter-chip' + (active ? ' active' : '');
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        b.textContent = label;
        return b;
    }

    root.EnmAuditTab = AuditTab;
}(typeof window !== 'undefined' ? window : globalThis));
