/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/technical-view.js — power-user dashboard wrapper (v0.4 P5C).
 *
 * The "Show technical details" disclosure from the settings drawer
 * lands here. Replaces the home view with the full v0.3 dashboard:
 * system status, the chain card (with raw state/height/peers/version),
 * producer identity, audit log, log viewer, settings tab, EVM
 * placeholder.
 *
 * Power-user terminology lives here unedited — RPC password,
 * WhiteIPList, log level, F1-F19 healing rule IDs, sync height, etc.
 * Avg-joe operators never see this view; experienced operators get
 * full v0.3 parity.
 *
 * Layout: simple sub-tab nav (Status / Logs / Settings / Audit / EVM)
 * mirroring the v0.3 5-tab dashboard. "← Back to home" button at the
 * top swaps the home view back in.
 */

(function (root) {
    'use strict';

    var TABS = [
        { id: 'status',   label: 'Status' },
        { id: 'logs',     label: 'Logs' },
        { id: 'settings', label: 'Settings' },
        { id: 'audit',    label: 'Audit' },
        { id: 'evm',      label: 'EVM',  pill: 'v0.5' },
    ];

    function TechnicalView(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('TechnicalView: { api, sse, notifications, onBackHome? } required');
        }
        this.api = opts.api;
        this.sse = opts.sse || null;
        this.notifications = opts.notifications || null;
        // null = no "back to home" link (v0.5 default — this view IS home).
        // Function = render the link and call it on click.
        this.onBackHome = typeof opts.onBackHome === 'function' ? opts.onBackHome : null;

        this.root = document.createElement('section');
        this.root.className = 'enm-tech';

        this._activeTab = 'status';
        this._mounted = {};   // { tabId: componentInstance }
        this._panes = {};     // { tabId: panelDiv }
    }

    TechnicalView.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._renderShell();
        this._switchTo(this._activeTab);
        return this;
    };

    TechnicalView.prototype.destroy = function () {
        // Destroy any mounted v0.3 components so timers / SSE subs are released.
        Object.keys(this._mounted).forEach(function (k) {
            var c = this._mounted[k];
            if (c && typeof c.destroy === 'function') { c.destroy(); }
        }, this);
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    TechnicalView.prototype._renderShell = function () {
        var self = this;

        var header = document.createElement('header');
        header.className = 'enm-tech-header';
        var backHtml = this.onBackHome
            ? '<button type="button" class="enm-tech-back enm-conv-textlink">'
              + '<span aria-hidden="true">←</span> Back to home'
            + '</button>'
            : '';
        header.innerHTML =
            backHtml
            + '<h1 class="enm-tech-title">Elastos Node Manager</h1>'
            + '<p class="enm-tech-sub">Real names — RPC, log level, healing rule IDs, '
              + 'sync height, BPoS state. Every value below comes directly from the '
              + 'backend; nothing inferred.</p>';
        if (this.onBackHome) {
            header.querySelector('.enm-tech-back').addEventListener('click', function () {
                self.onBackHome();
            });
        }
        this.root.appendChild(header);

        // Sub-tab nav.
        var nav = document.createElement('nav');
        nav.className = 'enm-tech-tabs';
        nav.setAttribute('role', 'tablist');
        TABS.forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'tab');
            b.dataset.tab = t.id;
            b.className = 'enm-tab';
            b.innerHTML = escapeHtml(t.label)
                + (t.pill ? ' <span class="enm-tab-pill">' + escapeHtml(t.pill) + '</span>' : '');
            b.addEventListener('click', function () { self._switchTo(t.id); });
            nav.appendChild(b);
        });
        this.root.appendChild(nav);
        this._nav = nav;

        // Pane containers (one per tab, lazily populated).
        var content = document.createElement('div');
        content.className = 'enm-tech-content';
        TABS.forEach(function (t) {
            var p = document.createElement('div');
            p.className = 'enm-tech-pane';
            p.dataset.tab = t.id;
            p.hidden = true;
            content.appendChild(p);
            self._panes[t.id] = p;
        });
        this.root.appendChild(content);
    };

    /** @private */
    TechnicalView.prototype._switchTo = function (tabId) {
        var self = this;
        this._activeTab = tabId;
        // Tab visuals.
        this._nav.querySelectorAll('[data-tab]').forEach(function (b) {
            var on = b.dataset.tab === tabId;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        // Pane visibility.
        Object.keys(this._panes).forEach(function (k) {
            self._panes[k].hidden = (k !== tabId);
        });
        // Lazy-mount the pane's component on first switch.
        if (!this._mounted[tabId]) {
            this._mountPane(tabId);
        }
    };

    /** @private */
    TechnicalView.prototype._mountPane = function (tabId) {
        var pane = this._panes[tabId];
        var common = {
            api: this.api,
            sse: this.sse,
            notifications: this.notifications,
            chainId: 'mainchain',
        };

        if (tabId === 'status') {
            // System status strip + the v0.3 chain card stack.
            if (root.EnmSystemStatus) {
                var sys = new root.EnmSystemStatus(common);
                sys.mount(pane);
                this._mounted['status_sys'] = sys;
            }
            if (root.EnmChainCard) {
                var card = new root.EnmChainCard(Object.assign({}, common, {
                    onReconfigure: this.onBackHome,
                }));
                card.mount(pane);
                this._mounted['status_card'] = card;
            }
            if (root.EnmProducerIdentity) {
                var prod = new root.EnmProducerIdentity(common);
                prod.mount(pane);
                this._mounted['status_prod'] = prod;
            }
            // Maintenance section — ela_update / compact-logs /
            // ela_activate_bpos. Power-user terminology because this is
            // already inside the technical view.
            this._renderMaintenance(pane);
        } else if (tabId === 'logs') {
            if (root.EnmLogViewer && this.sse) {
                var viewer = new root.EnmLogViewer(common);
                viewer.mount(pane);
                this._mounted[tabId] = viewer;
            } else {
                pane.innerHTML = '<p class="enm-stub">Live log viewer needs the SSE channel. Try refreshing.</p>';
            }
        } else if (tabId === 'settings') {
            if (root.EnmSettingsTab) {
                var settings = new root.EnmSettingsTab(common);
                settings.mount(pane);
                this._mounted[tabId] = settings;
            }
        } else if (tabId === 'audit') {
            if (root.EnmAuditTab) {
                var audit = new root.EnmAuditTab(common);
                audit.mount(pane);
                this._mounted[tabId] = audit;
            }
        } else if (tabId === 'evm') {
            if (root.EnmEvmTab) {
                var evm = new root.EnmEvmTab();
                evm.mount(pane);
                this._mounted[tabId] = evm;
            }
        }
    };

    /**
     * Maintenance section for the Status pane — surfaces the node.sh
     * commands operators historically ran by hand.
     *
     * @private
     */
    TechnicalView.prototype._renderMaintenance = function (pane) {
        var self = this;
        var sec = document.createElement('section');
        sec.className = 'enm-card enm-tech-maintenance';
        sec.innerHTML =
            '<h3 class="enm-tech-maintenance-title">Maintenance</h3>'
            + '<p class="enm-tech-maintenance-sub">'
              + 'Mirrors the node.sh helpers operators used to run by hand. '
              + 'Each action runs on this server with the keystore + binaries '
              + 'we already manage; nothing leaves this PC2.'
            + '</p>'
            + '<div class="enm-tech-maintenance-rows">'
              + this._maintenanceRow('compact', 'Compact logs',
                  'Gzip + purge ela.log per the rotation policy. Same as the daily cron — exposed for "free space now".')
              + this._maintenanceRow('update', 'Update binary',
                  "Re-download the latest <code>ela</code> + <code>ela-cli</code> from download.elastos.io. Stop the chain first if it's running; we don't auto-stop.")
              + this._maintenanceRow('activate', 'Reactivate BPoS supernode',
                  "Sends a <code>producer activate</code> transaction so the chain flips your producer state from Inactive back to Active. Requires a keystore + funded deposit address.")
            + '</div>';
        pane.appendChild(sec);

        // Wire each row.
        sec.querySelector('[data-action="compact"]').addEventListener('click', function (ev) {
            self._runMaintenance(ev.currentTarget, '/chains/mainchain/compact-logs',
                'Logs compacted', 'Compaction failed');
        });
        sec.querySelector('[data-action="update"]').addEventListener('click', function (ev) {
            if (!confirm("This re-downloads the latest binary. If the chain is running, "
                + "stop it first via the Mainchain card above — otherwise the running "
                + "ela may keep the old file open.")) { return; }
            self._runMaintenance(ev.currentTarget, '/chains/mainchain/update',
                'Update started — watch the Logs sub-tab for progress', 'Update failed to start');
        });
        sec.querySelector('[data-action="activate"]').addEventListener('click', function (ev) {
            if (!confirm("This sends a 'producer activate' transaction on-chain "
                + 'using your keystore. Continue?')) { return; }
            self._runMaintenance(ev.currentTarget, '/chains/mainchain/bpos/activate',
                'Reactivation submitted — wait a block or two for chain confirmation',
                'Reactivation rejected');
        });
    };

    /** @private */
    TechnicalView.prototype._maintenanceRow = function (action, label, help) {
        return ''
            + '<div class="enm-tech-maintenance-row">'
              + '<div class="enm-tech-maintenance-text">'
                + '<div class="enm-tech-maintenance-label">' + escapeHtml(label) + '</div>'
                + '<div class="enm-tech-maintenance-help">' + help + '</div>'
              + '</div>'
              + '<button type="button" class="enm-btn enm-btn-secondary" data-action="' + escapeHtml(action) + '">'
                + 'Run'
              + '</button>'
            + '</div>';
    };

    /** @private */
    TechnicalView.prototype._runMaintenance = function (btn, path, okMessage, errPrefix) {
        var self = this;
        var prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Running…';
        this.api.post(path).then(function (data) {
            if (self.notifications) {
                self.notifications.info(okMessage, '');
            }
            btn.textContent = 'Done';
            setTimeout(function () { btn.textContent = prev; btn.disabled = false; }, 1500);
        }).catch(function (err) {
            var detail = err && err.message ? err.message : String(err);
            if (self.notifications) {
                self.notifications.warning(errPrefix, detail);
            }
            btn.textContent = prev;
            btn.disabled = false;
        });
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmTechnicalView = TechnicalView;
}(typeof window !== 'undefined' ? window : globalThis));
