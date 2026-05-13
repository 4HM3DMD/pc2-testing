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

    // Information architecture (Phase 3 rebuild):
    //   Status     — live chain telemetry only (chain card)
    //   Identity   — producer identity card (BPoS-only; hidden when no
    //                keystore). Has its own home so it doesn't clutter
    //                Status when not relevant.
    //   Tools      — Maintenance actions (compact, update, reactivate,
    //                reinstall). Each button state-gated against the
    //                current chain state — no nonsensical clicks.
    //   Logs / Settings / Audit / EVM — unchanged
    // 0.2.0-alpha.11 — Tools tab removed per operator feedback ("we
    // need all tools and tools to be removed"). The Maintenance card
    // moved onto the Status pane below the Update card so the
    // operator sees every tool inline. Compact-logs / reactivate-BPoS /
    // re-bootstrap stay; the Update-binary row went away since the
    // Update card (added in alpha.9) supersedes it. Per the
    // tools-tab-audit report 08, a future iteration may distribute the
    // rows by concern (compact → Logs, activate → Identity, etc.);
    // for now keeping the maintenance card whole + on Status is the
    // simpler ship.
    var TABS = [
        { id: 'status',   label: 'Status' },
        { id: 'identity', label: 'Identity' },
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
        // 0.2.0-alpha.1 — chain-card sparkline subscribes to this client.
        // Plumbed through here so the status sub-tab gets the singleton.
        this.heightSeries = opts.heightSeries || null;
        // null = no "back to home" link (v0.5 default — this view IS home).
        // Function = render the link and call it on click.
        this.onBackHome = typeof opts.onBackHome === 'function' ? opts.onBackHome : null;

        this.root = document.createElement('section');
        this.root.className = 'enm-tech';

        // Resume the operator's last sub-tab if we remembered one. Falls
        // back to Status on first visit or when storage is blocked.
        var rememberedTab = null;
        try {
            if (typeof sessionStorage !== 'undefined') {
                rememberedTab = sessionStorage.getItem('enm:tech:lastTab');
            }
        } catch (e) { /* private mode may block */ }
        var validIds = TABS.map(function (x) { return x.id; });
        this._activeTab = (rememberedTab && validIds.indexOf(rememberedTab) !== -1)
            ? rememberedTab
            : 'status';
        this._mounted = {};   // { tabId: componentInstance }
        this._panes = {};     // { tabId: panelDiv }
        // alpha.28.1 batch 24 — _destroyed flag. _kickUpdateScan and
        // refreshGates both fire fire-and-forget /updates/available +
        // /chains/mainchain GETs that previously wrote to body.dataset
        // and to the (detached) maintenance pane after destroy.
        // (Lifecycle audit aff18c172.)
        this._destroyed = false;
    }

    TechnicalView.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._renderShell();
        this._switchTo(this._activeTab);
        // 0.2.0-alpha.8 — kick off a single update-check poll so the
        // Tools-tab nav dot lights up even when the operator hasn't
        // opened Tools yet. The Tools update card does its own deeper
        // poll on mount; this one only needs the severity to set the
        // body[data-update-severity] attribute the CSS reads.
        this._kickUpdateScan();
        return this;
    };

    /** @private */
    TechnicalView.prototype._kickUpdateScan = function () {
        if (!this.api) return;
        var self = this;
        this.api.get('/updates/available', { skipCache: true }).then(function (env) {
            if (self._destroyed) { return; }
            if (env && env.updateAvailable && env.severity) {
                document.body.dataset.updateSeverity = env.severity;
            } else {
                delete document.body.dataset.updateSeverity;
            }
        }).catch(function () { /* dot stays off; GitHub may be unreachable */ });
    };

    TechnicalView.prototype.destroy = function () {
        this._destroyed = true;
        // 0.2.0-alpha.11 — gate-refresh timer moved here from the old
        // _renderTools sentinel. Status pane now owns the maintenance
        // card, so the timer's destroy hook lives at the tech-view
        // level instead of buried in _mounted['tools'].
        if (this._toolsGatePauser) {
            try { this._toolsGatePauser.stop(); } catch (_) { /* idempotent */ }
            this._toolsGatePauser = null;
        }
        if (this._toolsGateTimer) {
            clearInterval(this._toolsGateTimer);
            this._toolsGateTimer = null;
        }
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
        // alpha.11: removed the explanatory subtitle.
        // alpha.24: dropped the "Elastos Node Manager" h1 entirely — PC2's
        // window chrome already shows the app title in the title bar, and
        // the duplicate ate ~80px of vertical space inside the iframe
        // (significant cost on short windows). Only render the header
        // element if we have a back-link to show; otherwise skip it so
        // the tab strip floats to the top of the pane.
        if (this.onBackHome) {
            header.innerHTML = backHtml;
            header.querySelector('.enm-tech-back').addEventListener('click', function () {
                self.onBackHome();
            });
            this.root.appendChild(header);
        }

        // Sub-tab nav.
        var nav = document.createElement('nav');
        nav.className = 'enm-tech-tabs';
        nav.setAttribute('role', 'tablist');
        nav.setAttribute('aria-label', 'Technical view sections');
        TABS.forEach(function (t, idx) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'tab');
            b.id = 'enm-tech-tab-' + t.id;
            b.setAttribute('aria-controls', 'enm-tech-pane-' + t.id);
            // Roving tabindex: only the first tab is reachable via Tab on initial render;
            // the rest are reachable via arrow keys (WCAG ARIA tab pattern).
            b.setAttribute('tabindex', idx === 0 ? '0' : '-1');
            b.dataset.tab = t.id;
            b.className = 'enm-tab';
            // alpha.28.1 batch 23 — discoverability: surface the
            // arrow-key navigation in title= so keyboard operators
            // know it's available. The pattern was implemented in
            // batch 1 (roving tabindex + Left/Right/Home/End) but
            // the help-discoverability audit (a551343d) found no
            // affordance hinting at it. Help is only used on hover
            // and focus — fine: anyone using the keyboard already has
            // focus on the tab.
            b.title = t.label + ' — use ← → to switch sections, Home/End for first/last';
            b.innerHTML = escapeHtml(t.label)
                + (t.pill ? ' <span class="enm-tab-pill">' + escapeHtml(t.pill) + '</span>' : '');
            b.addEventListener('click', function () {
                self._switchTo(t.id);
                // a11y/Safari: WebKit doesn't focus <button> on click, so
                // a click-then-arrow flow moves from the previous tab.
                // Explicit focus keeps the roving-tabindex invariant
                // ("the focused tab is the active tab") true everywhere.
                try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
            });
            // Arrow-key navigation within the tablist (Left/Right/Home/End).
            b.addEventListener('keydown', function (ev) {
                var key = ev.key;
                var nextIdx;
                if (key === 'ArrowRight') {
                    nextIdx = (idx + 1) % TABS.length;
                } else if (key === 'ArrowLeft') {
                    nextIdx = (idx - 1 + TABS.length) % TABS.length;
                } else if (key === 'Home') {
                    nextIdx = 0;
                } else if (key === 'End') {
                    nextIdx = TABS.length - 1;
                } else {
                    return;
                }
                ev.preventDefault();
                var nextBtn = nav.querySelectorAll('[data-tab]')[nextIdx];
                self._switchTo(TABS[nextIdx].id);
                if (nextBtn) { nextBtn.focus(); }
            });
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
            p.id = 'enm-tech-pane-' + t.id;
            p.setAttribute('role', 'tabpanel');
            p.setAttribute('aria-labelledby', 'enm-tech-tab-' + t.id);
            p.setAttribute('tabindex', '0');
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
        // a11y/orientation: surface the current sub-tab in document.title
        // so PC2's window-chrome reads "Elastos Node Manager — Logs"
        // instead of staying frozen on the static index.html title.
        // Operators with three PC2 windows open get a real taskbar cue
        // for which section they're on. Mirrors the breadcrumb idea
        // from the navigation audit without committing to a full
        // breadcrumb component yet.
        try {
            var tabMeta = TABS.find ? TABS.find(function (x) { return x.id === tabId; }) : null;
            var tabLabel = (tabMeta && tabMeta.label) || tabId;
            document.title = 'Elastos Node Manager — ' + tabLabel;
        } catch (e) { /* document.title may be locked in some embeds */ }
        // Persist the active sub-tab so a relaunch (PC2 close + reopen)
        // returns the operator to where they were instead of always
        // landing on Status. sessionStorage scopes to the tab; localStorage
        // scopes across sessions — sessionStorage is the safer default
        // because a "fresh look" intent (open in new window) starts clean.
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('enm:tech:lastTab', tabId);
            }
        } catch (e) { /* private mode may block */ }
        // Tab visuals + roving tabindex (only the active tab is in the natural
        // Tab sequence; arrow keys move within the tablist).
        this._nav.querySelectorAll('[data-tab]').forEach(function (b) {
            var on = b.dataset.tab === tabId;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.setAttribute('tabindex', on ? '0' : '-1');
        });
        // Pane visibility.
        Object.keys(this._panes).forEach(function (k) {
            self._panes[k].hidden = (k !== tabId);
        });
        // Lazy-mount the pane's component on first switch.
        if (!this._mounted[tabId]) {
            this._mountPane(tabId);
        }
        // 0.2.0 — body.dataset.activeTab tracks which sub-tab is showing.
        // The page-wash gradient (body::before in styles.css) reads this
        // attribute to hide itself on dense panes (logs / audit / forms)
        // where a coloured wash would hurt readability. Only the Status
        // tab — the dashboard hero — wears the wash.
        document.body.dataset.activeTab = tabId;
    };

    /** @private */
    TechnicalView.prototype._mountPane = function (tabId) {
        // 0.2.0-alpha.13 — was missing! Without it the alpha.11
        // refreshGates closure resolved `self` to the browser's
        // `window` global, then `window.api` was undefined, then
        // `.get(...)` on undefined threw "Cannot read properties of
        // undefined (reading 'get')" in the iframe, breaking the
        // whole technical-view render.
        var self = this;
        var pane = this._panes[tabId];
        var common = {
            api: this.api,
            sse: this.sse,
            notifications: this.notifications,
            chainId: 'mainchain',
            // 0.2.0-alpha.1 — chain-card subscribes to this for the
            // sparkline. Pass the singleton through; optional, falls
            // back gracefully when absent.
            heightSeries: this.heightSeries || null,
        };

        if (tabId === 'status') {
            // Status pane: live chain telemetry only — system stats +
            // chain card. Producer identity moved to its own Identity
            // sub-tab, Maintenance moved to its own Tools sub-tab.
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
            // alpha.14 — first-time validator registration guide. Hidden
            // until the chain is fully synced AND the operator hasn't yet
            // registered as a BPoS producer on chain. Walks them through
            // the three-step Essentials flow + the in-app activate button.
            if (root.EnmValidatorRegistrationCard) {
                var validatorCard = new root.EnmValidatorRegistrationCard(common);
                validatorCard.mount(pane);
                this._mounted['status_validator'] = validatorCard;
            }
            // 0.2.0-alpha.9 — Binary Update card moved here from the Tools
            // sub-tab per operator feedback ("tools still not below the
            // status page card"). The card lives at the bottom of the
            // Status pane so it's the natural next thing after chain +
            // validator. Hides itself when on the latest release; surfaces
            // when an update is available. Skips entirely when GitHub is
            // unreachable AND we have no fallback known-good version to
            // compare against.
            if (root.EnmToolsUpdateCard) {
                var updateCard = new root.EnmToolsUpdateCard(common);
                updateCard.mount(pane);
                this._mounted['status_update'] = updateCard;
            }
            // 0.2.0-alpha.11 — Maintenance card mounted on Status pane
            // (Tools tab removed). Lives below the update card; the
            // operator sees all live tools inline with the chain status.
            this._renderMaintenance(pane);
            // Wire gating refresh — same poll used by the original tools
            // tab. 5s cadence keeps the buttons live as state changes.
            var refreshGates = function () {
                if (self._destroyed) { return; }
                self.api.get('/chains/mainchain', { skipCache: true }).then(function (chain) {
                    if (self._destroyed) { return; }
                    self.api.get('/chains/mainchain/producer', { skipCache: true })
                        .catch(function () { return null; })
                        .then(function (producer) {
                            if (self._destroyed) { return; }
                            self._applyToolsGates(pane, chain, producer);
                        });
                }).catch(function () { /* leave gates as-is on error */ });
            };
            // alpha.28.1 batch 28 — migrate to enmUseVisibilityPause so
            // the 5s gate-refresh stops while the tab is hidden (saves
            // ~1440 fetches/hr per backgrounded dashboard). The helper
            // also fires once on visibility-resume so gates catch up
            // immediately rather than waiting up to 5s.
            refreshGates();
            if (typeof root !== 'undefined' && typeof root.enmUseVisibilityPause === 'function') {
                this._toolsGatePauser = root.enmUseVisibilityPause(refreshGates, 5_000);
            } else {
                this._toolsGateTimer = setInterval(refreshGates, 5_000);
            }
            // Sentinel so _switchTo doesn't re-mount on tab return — the
            // real components live under status_sys / status_card / status_validator.
            this._mounted['status'] = { destroy: function () {} };
        } else if (tabId === 'identity') {
            // Producer identity — BPoS only. The component itself decides
            // whether to render based on /setup/keystore/account. Before
            // a keystore is imported the card hides and the parent pane's
            // intro paragraph carries the explanation.
            this._renderIdentity(pane, common);
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
     * Identity pane (Phase 3 IA rebuild) — wraps the EnmProducerIdentity
     * card with a context paragraph. The producer card hides itself
     * before the keystore has been imported, and without context the
     * tab would look broken. This pane always renders the explanation
     * so the operator knows why the card may be empty.
     *
     * @private
     */
    TechnicalView.prototype._renderIdentity = function (pane, common) {
        var intro = document.createElement('section');
        intro.className = 'enm-card enm-tech-identity-intro';
        intro.innerHTML =
            '<h3 class="enm-tech-section-title">Producer identity</h3>'
            + '<p class="enm-tech-section-sub">'
              + 'Your BPoS producer credentials. Once you\'ve imported a '
              + 'keystore and registered, your public key + payout address '
              + 'appear below. (CR Council registration is a separate flow '
              + 'that will land in a later release.)'
            + '</p>';
        pane.appendChild(intro);

        if (root.EnmProducerIdentity) {
            var prod = new root.EnmProducerIdentity(common);
            prod.mount(pane);
            this._mounted['identity'] = prod;
        } else {
            var stub = document.createElement('p');
            stub.className = 'enm-stub';
            stub.textContent = 'Producer identity component not loaded.';
            pane.appendChild(stub);
        }
    };

    // 0.2.0-alpha.11 — _renderTools removed. The Tools tab is gone; the
    // Maintenance card now lives on the Status pane (mounted in
    // _mountPane('status') after the Update card). The gate-refresh
    // timer the old _renderTools owned moves into _mountPane('status')
    // and is torn down in destroy().

    /**
     * Apply state-aware enabled/disabled to each Maintenance row.
     * Mirrors the backend route gates so the UI doesn't even offer
     * actions that the API would reject.
     *
     * @private
     * @param {HTMLElement} pane
     * @param {object} chain
     * @param {object|null} producer
     */
    TechnicalView.prototype._applyToolsGates = function (pane, chain, producer) {
        var alive = !!(chain && chain.pid && chain.attached);
        var producerState = producer && producer.state;
        var producerEnabled = !!(producer && producer.enabled);

        function gate(action, disabled, reason) {
            var btn = pane.querySelector('[data-action="' + action + '"]');
            if (!btn) { return; }
            btn.disabled = !!disabled;
            btn.title = disabled ? reason : '';
            // Add a visible disabled-with-reason marker on the row
            var row = btn.closest('.enm-tech-maintenance-row');
            if (row) {
                row.dataset.disabled = disabled ? '1' : '0';
                var help = row.querySelector('.enm-tech-maintenance-help');
                // Stash the original help text once, restore when re-enabled.
                if (help && !help.dataset.original) {
                    help.dataset.original = help.innerHTML;
                }
                if (help && disabled) {
                    help.innerHTML = '<span class="enm-tech-disabled-reason">' + reason + '</span>';
                } else if (help && help.dataset.original) {
                    help.innerHTML = help.dataset.original;
                }
            }
        }

        // Compact logs: always available (operator owns log files; rotation
        // is independent of chain liveness).
        gate('compact', false, '');

        // 0.2.0-alpha.11 — the 'update binary' maintenance row is gone;
        // the Update card above the Maintenance card supersedes it. No
        // gating call needed.

        // Re-bootstrap: stop chain first so the data dir isn't held open.
        if (alive) {
            gate('rebootstrap', true, 'Stop the chain first (data dir in use).');
        } else {
            gate('rebootstrap', false, '');
        }

        // Reactivate BPoS: only when alive AND producer is registered AND
        // its state is Inactive (active producers don't need reactivation).
        if (!alive) {
            gate('activate', true, 'Chain must be running.');
        } else if (!producerEnabled) {
            gate('activate', true, 'Not yet registered as a BPoS producer. See the Identity tab for the registration steps.');
        } else if (producerState === 'Active') {
            gate('activate', true, 'Producer is already Active — nothing to do.');
        } else {
            gate('activate', false, '');
        }
    };

    /**
     * @private — DOM construction for Maintenance section.
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
              + this._maintenanceRow('activate', 'Reactivate BPoS supernode',
                  "Sends a <code>producer activate</code> transaction so the chain flips your producer state from Inactive back to Active. Requires a keystore + funded deposit address.")
              + this._maintenanceRow('rebootstrap', 'Re-bootstrap chain data',
                  "Wipes the local chain DB and re-downloads the official Elastos snapshot (~10 GB, ~15 min) so a stuck or corrupt sync can recover without reinstalling. The chain must be stopped first. Existing settings + keystore are kept.")
            + '</div>';
        pane.appendChild(sec);

        // Wire each row.
        sec.querySelector('[data-action="compact"]').addEventListener('click', function (ev) {
            self._runMaintenance(ev.currentTarget, '/chains/mainchain/compact-logs',
                'Logs compacted', 'Compaction failed');
        });
        sec.querySelector('[data-action="activate"]').addEventListener('click', function (ev) {
            if (!confirm("This sends a 'producer activate' transaction on-chain "
                + 'using your keystore. Continue?')) { return; }
            self._runMaintenance(ev.currentTarget, '/chains/mainchain/bpos/activate',
                'Reactivation submitted — wait a block or two for chain confirmation',
                'Reactivation rejected');
        });
        sec.querySelector('[data-action="rebootstrap"]').addEventListener('click', function (ev) {
            // Type-to-confirm guard — same pattern as the Settings danger
            // zone. Wiping the chain DB is irreversible from the operator's
            // point of view (resync would take 1-3 days without the
            // snapshot path, which is exactly why they're using this).
            var typed = prompt(
                'Re-bootstrap wipes the local chain DB and downloads the official snapshot '
                + '(~10 GB). The chain must already be stopped. Existing keystore + settings '
                + 'are kept.\n\nType BOOTSTRAP to confirm:',
            );
            if (typed !== 'BOOTSTRAP') { return; }
            self._runMaintenance(ev.currentTarget, '/chains/mainchain/bootstrap',
                'Bootstrap started — Settings → Logs to watch progress',
                'Bootstrap failed to start');
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
