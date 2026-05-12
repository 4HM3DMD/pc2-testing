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
    var TABS = [
        { id: 'status',   label: 'Status' },
        { id: 'identity', label: 'Identity' },
        { id: 'tools',    label: 'Tools' },
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

        this._activeTab = 'status';
        this._mounted = {};   // { tabId: componentInstance }
        this._panes = {};     // { tabId: panelDiv }
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
        this.api.get('/updates/available', { skipCache: true }).then(function (env) {
            if (env && env.updateAvailable && env.severity) {
                document.body.dataset.updateSeverity = env.severity;
            } else {
                delete document.body.dataset.updateSeverity;
            }
        }).catch(function () { /* dot stays off; GitHub may be unreachable */ });
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
        // alpha.11: removed the explanatory subtitle. It was meta-
        // commentary about how this view works ("real names not
        // inferred values") which doesn't help anyone — operators
        // either already know or never care, and avg-joe operators
        // get confused by it. The tabs themselves are self-describing.
        header.innerHTML =
            backHtml
            + '<h1 class="enm-tech-title">Elastos Node Manager</h1>';
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
        // 0.2.0 — body.dataset.activeTab tracks which sub-tab is showing.
        // The page-wash gradient (body::before in styles.css) reads this
        // attribute to hide itself on dense panes (logs / audit / forms)
        // where a coloured wash would hurt readability. Only the Status
        // tab — the dashboard hero — wears the wash.
        document.body.dataset.activeTab = tabId;
    };

    /** @private */
    TechnicalView.prototype._mountPane = function (tabId) {
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
            // Sentinel so _switchTo doesn't re-mount on tab return — the
            // real components live under status_sys / status_card / status_validator.
            this._mounted['status'] = { destroy: function () {} };
        } else if (tabId === 'identity') {
            // Producer identity — BPoS only. The component itself decides
            // whether to render based on /setup/keystore/account. Before
            // a keystore is imported the card hides and the parent pane's
            // intro paragraph carries the explanation.
            this._renderIdentity(pane, common);
        } else if (tabId === 'tools') {
            // Maintenance + reinstall, with each action state-gated
            // against current chain state.
            this._renderTools(pane);
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

    /**
     * Tools pane (Phase 3 IA rebuild) — formerly the Maintenance
     * section embedded in Status. Now its own sub-tab with state-gated
     * action buttons. Polls /chains/:id every 5s while pane is mounted
     * to keep the gate state fresh.
     *
     * @private
     */
    TechnicalView.prototype._renderTools = function (pane) {
        var self = this;
        // 0.2.0-alpha.9 — the Binary Update card moved to the Status
        // pane (it's the natural next-card after chain + validator,
        // per operator feedback). Tools now hosts only maintenance for
        // alpha.9; the Snapshot + Diagnostics + Bootstrap cards land
        // in alpha.10 per the updates-audit master plan.
        this._renderMaintenance(pane);

        // Live state-gating refresh — re-evaluate which buttons are
        // enabled every 5s based on current chain + producer state.
        var refreshGates = function () {
            self.api.get('/chains/mainchain', { skipCache: true }).then(function (chain) {
                self.api.get('/chains/mainchain/producer', { skipCache: true }).catch(function () { return null; }).then(function (producer) {
                    self._applyToolsGates(pane, chain, producer);
                });
            }).catch(function () { /* leave gates as-is on error */ });
        };
        refreshGates();
        if (this._toolsGateTimer) { clearInterval(this._toolsGateTimer); }
        this._toolsGateTimer = setInterval(refreshGates, 5000);
        // Sentinel doubles as the destroy() hook for the gate-refresh timer.
        this._mounted['tools'] = { destroy: function () {
            if (self._toolsGateTimer) { clearInterval(self._toolsGateTimer); self._toolsGateTimer = null; }
        }};
    };

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

        // Update binary: only when chain stopped.
        if (alive) {
            gate('update', true, 'Stop the chain first (binary in use).');
        } else {
            gate('update', false, '');
        }

        // Re-bootstrap: same gate as update — wiping the data dir while
        // ela has it open would corrupt the chain. Stop first.
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
              + this._maintenanceRow('update', 'Update binary',
                  "Re-download the latest <code>ela</code> + <code>ela-cli</code> from download.elastos.io. Stop the chain first if it's running; we don't auto-stop.")
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
