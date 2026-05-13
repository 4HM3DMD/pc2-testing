/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/audit-tab.js — paginated audit log with filters + JSON export.
 *
 * Hits GET /api/audit?chainId=&tier=&from=&to=. Renders rows in a table with
 * a "Load more" pagination strategy (offset bumped by 100 per click). Export
 * fetches up to 500 rows with the current filters and assembles a JSON Blob
 * the browser saves as enm-audit-<ts>.json.
 *
 * Filtering is server-side (the API supports it), but we keep the form's
 * lightweight reactive shape so changes apply immediately on Apply.
 */

(function (root) {
    'use strict';

    var PAGE_SIZE = 100;
    // Hard cap on accumulated rows. With audit retention.days = 0 (forever),
    // an unbounded session could leak DOM. 5000 fits ~50 days of typical
    // healing activity; operators wanting more should narrow filters or
    // use the JSON export.
    var MAX_ROWS = 5000;

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
        this._renderShell();
    }

    AuditTab.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        return this;
    };

    AuditTab.prototype.destroy = function () {
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** Refresh from offset 0. */
    AuditTab.prototype.refresh = function () {
        this._offset = 0;
        this._rows = [];
        return this._loadMore(true);
    };

    /** @private */
    AuditTab.prototype._loadMore = function (clear) {
        var self = this;
        var t = root.enmTOrFallback;
        var qs = this._currentFilterQs();
        qs += (qs ? '&' : '') + 'limit=' + PAGE_SIZE + '&offset=' + this._offset;
        return this.api.get('/audit?' + qs, { skipCache: true }).then(function (data) {
            var entries = (data && data.entries) || [];
            if (clear) {
                self._tbody.innerHTML = '';
                self._rows = [];
            }
            self._rows = self._rows.concat(entries);
            entries.forEach(function (e) { self._appendRow(e); });
            self._offset += entries.length;

            // End of feed: server returned fewer rows than the page size.
            var endOfFeed = (entries.length < PAGE_SIZE);
            // Hard cap: don't let a long session accumulate unbounded DOM.
            var capReached = (self._rows.length >= MAX_ROWS);

            self._loadMoreBtn.disabled = endOfFeed || capReached;
            self._loadMoreBtn.textContent = capReached
                ? t('audit.load_more_capped')
                : t('audit.load_more');
            // Grouped row count — once an operator accrues 1,000+ rows the
            // raw integer ("1234 rows") is harder to scan than the grouped
            // form ("1,234 rows"). Falls back to raw if the util is missing.
            var fmtCount = (typeof window !== 'undefined' && window.enmFormatNumber)
                ? window.enmFormatNumber
                : function (n) { return String(n); };
            self._countLabel.textContent = fmtCount(self._rows.length) + ' rows';
            if (self._rows.length === 0) {
                self._emptyMsg.hidden = false;
            } else {
                self._emptyMsg.hidden = true;
            }
        }).catch(function (err) {
            self.notifications.warning('Failed to load audit log', err.message || String(err));
        });
    };

    /** @private */
    AuditTab.prototype._currentFilterQs = function () {
        var parts = [];
        if (this._filters.chain.value)  parts.push('chainId=' + encodeURIComponent(this._filters.chain.value));
        if (this._filters.tier.value)   parts.push('tier=' + encodeURIComponent(this._filters.tier.value));
        if (this._filters.from.value)   parts.push('from=' + Date.parse(this._filters.from.value));
        if (this._filters.to.value)     parts.push('to=' + Date.parse(this._filters.to.value));
        return parts.join('&');
    };

    /** @private */
    AuditTab.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        var head = document.createElement('header'); head.className = 'enm-audit-head';
        var h = document.createElement('h3'); h.textContent = t('audit.heading'); head.appendChild(h);
        this.root.appendChild(head);

        // Filter bar.
        var filterBar = document.createElement('div'); filterBar.className = 'enm-audit-filters';
        this._filters = {
            chain: textInput(t('audit.filter_chain')),
            tier:  selectInput([
                { value: '', label: t('audit.tier_any') },
                { value: 'AUTOMATED-SAFE',  label: 'AUTOMATED-SAFE' },
                { value: 'OWNER-CONFIRMS',  label: 'OWNER-CONFIRMS' },
                { value: 'CRITICAL-NOTIFY', label: 'CRITICAL-NOTIFY' },
                { value: 'NEVER-AUTOMATIC', label: 'NEVER-AUTOMATIC' },
                { value: 'HTTP-MUTATION',   label: 'HTTP-MUTATION' },
            ]),
            from:  dateInput(),
            to:    dateInput(),
        };
        filterBar.appendChild(label(this._filters.chain, t('audit.filter_chain')));
        filterBar.appendChild(label(this._filters.tier,  t('audit.filter_tier')));
        filterBar.appendChild(label(this._filters.from,  t('audit.filter_from')));
        filterBar.appendChild(label(this._filters.to,    t('audit.filter_to')));

        var self = this;
        filterBar.appendChild(btn(t('audit.apply_filter'), 'enm-btn-secondary',
            function () { self.refresh(); }));
        filterBar.appendChild(btn(t('audit.export_btn'),   'enm-btn-secondary',
            function () { self._exportJson(); }));
        this.root.appendChild(filterBar);

        // Table.
        var table = document.createElement('table'); table.className = 'enm-audit-table';
        var thead = document.createElement('thead');
        var tr = document.createElement('tr');
        ['col_ts', 'col_chain', 'col_rule', 'col_tier', 'col_decision', 'col_executor', 'col_outcome']
            .forEach(function (k) {
                var th = document.createElement('th'); th.textContent = t('audit.' + k); tr.appendChild(th);
            });
        thead.appendChild(tr); table.appendChild(thead);
        this._tbody = document.createElement('tbody'); table.appendChild(this._tbody);
        this.root.appendChild(table);

        this._emptyMsg = document.createElement('p'); this._emptyMsg.className = 'enm-audit-empty';
        this._emptyMsg.textContent = t('audit.empty'); this._emptyMsg.hidden = true;
        this.root.appendChild(this._emptyMsg);

        // Pagination footer.
        var foot = document.createElement('div'); foot.className = 'enm-audit-foot';
        this._countLabel = document.createElement('span'); this._countLabel.className = 'enm-audit-count';
        foot.appendChild(this._countLabel);
        this._loadMoreBtn = btn(t('audit.load_more'), 'enm-btn-secondary', function () { self._loadMore(false); });
        foot.appendChild(this._loadMoreBtn);
        this.root.appendChild(foot);
    };

    /** @private */
    AuditTab.prototype._appendRow = function (e) {
        var tr = document.createElement('tr');
        tr.dataset.tier = e.tier;
        addCell(tr, formatTs(e.ts));
        addCell(tr, e.chainId || e.chain_id || '—');
        addCell(tr, e.ruleId || e.rule_id || '—');
        addCell(tr, e.tier || '—');
        addCell(tr, e.decision || '—');
        // Executor cell shows the truncated wallet for the visible row
        // but the title= must carry the FULL address so hover + screen
        // readers + copy-paste all get the canonical value. (Previously
        // addCell defaulted title to the truncated display string,
        // making the "title=full text" promise a lie for this cell.)
        addCell(tr, shortenWallet(e.executor), e.executor || '');
        addCell(tr, e.outcome || '—');
        this._tbody.appendChild(tr);
    };

    /**
     * @private
     * Fetch up to 500 rows matching current filters, package into a JSON file
     * the browser saves locally. No server round-trip beyond /audit itself.
     */
    AuditTab.prototype._exportJson = function () {
        var self = this;
        var qs = this._currentFilterQs();
        qs += (qs ? '&' : '') + 'limit=500&offset=0';
        this.api.get('/audit?' + qs, { skipCache: true }).then(function (data) {
            var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'enm-audit-' + Date.now() + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }).catch(function (err) {
            self.notifications.warning('Export failed', err.message || String(err));
        });
    };

    function formatTs(ms) {
        if (!ms) return '—';
        var d = new Date(ms);
        return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    }
    function shortenWallet(s) {
        if (!s) return '—';
        if (s === 'system') return 'system';
        if (s.length > 12) return s.slice(0, 6) + '…' + s.slice(-4);
        return s;
    }
    function addCell(tr, text, fullText) {
        var td = document.createElement('td');
        td.textContent = text;
        // a11y: cells truncate with text-overflow:ellipsis on narrow widths.
        // Mirror full text into title= so it stays available to mouse hover,
        // screen readers, and copy-paste even when visibly clipped. For
        // truncated values (e.g. wallets shortened with `…`), callers can
        // pass the full canonical value as `fullText` so the title still
        // reveals what the visible cell hides.
        var titleSource = (fullText != null && fullText !== '')
            ? fullText
            : (text == null ? '' : text);
        td.title = String(titleSource);
        tr.appendChild(td);
    }
    function textInput(placeholder) {
        var i = document.createElement('input'); i.type = 'text';
        i.placeholder = placeholder; i.className = 'enm-audit-input';
        // Audit filters are short-lived per-session queries — browser
        // autofill / autocomplete suggestions are pure noise here. Mobile
        // keypad numeric hint helps because Elastos chain IDs are small
        // integers (e.g. `20`, `21`).
        i.setAttribute('autocomplete', 'off');
        i.setAttribute('inputmode', 'numeric');
        i.setAttribute('spellcheck', 'false');
        i.setAttribute('autocapitalize', 'off');
        return i;
    }
    function dateInput() {
        var i = document.createElement('input'); i.type = 'datetime-local';
        i.className = 'enm-audit-input';
        i.setAttribute('autocomplete', 'off');
        return i;
    }
    function selectInput(options) {
        var s = document.createElement('select'); s.className = 'enm-audit-input';
        // Select boxes also accept autofill in some browsers. Filter
        // queries are session-scoped — never bring up history.
        s.setAttribute('autocomplete', 'off');
        options.forEach(function (o) {
            var opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label;
            s.appendChild(opt);
        });
        return s;
    }
    function label(input, text) {
        var l = document.createElement('label'); l.className = 'enm-audit-label';
        var span = document.createElement('span'); span.textContent = text;
        l.appendChild(span);
        l.appendChild(input);
        return l;
    }
    function btn(text, cls, onClick) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'enm-btn ' + cls;
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    root.EnmAuditTab = AuditTab;
}(typeof window !== 'undefined' ? window : globalThis));
