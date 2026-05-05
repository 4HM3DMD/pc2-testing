/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Elastos Node Manager — frontend controller.
 *
 * Boot sequence:
 *   1. wallet.sendReady() + installCloseHandler()           [must run first]
 *   2. wallet.getIdentity()  — non-blocking; populates the wallet badge
 *   3. api.get('/health')  — confirm sidecar reachable
 *   4. api.get('/setup/state')    — wizard vs. dashboard
 *   5. mount the chosen view
 *   6. SSE subscriptions for live status + healing notifications
 *
 * On any boot failure we render a clear error pane with copy-pasteable
 * detail (so the operator can grep their logs).
 */

(function (root) {
    'use strict';

    function ENMApp() {
        this.els = null;
        this.services = null;
        this.identity = null;
    }

    ENMApp.prototype.init = function () {
        this.els = {
            app:          document.getElementById('app'),
            spinner:      document.getElementById('enm-spinner'),
            spinnerText:  document.getElementById('enm-spinner-text'),
            error:        document.getElementById('enm-error'),
            errorTitle:   document.getElementById('enm-error-title'),
            errorDetail:  document.getElementById('enm-error-detail'),
            content:      document.getElementById('enm-content'),
            tabs:         document.getElementById('enm-tabs'),
            themeToggle:  document.getElementById('enm-theme-toggle'),
            paneDashboard: document.getElementById('enm-pane-dashboard'),
            paneLogs:     document.getElementById('enm-pane-logs'),
            paneSettings: document.getElementById('enm-pane-settings'),
            paneAudit:    document.getElementById('enm-pane-audit'),
            paneEvm:      document.getElementById('enm-pane-evm'),
        };

        this.services = {
            wallet:        new root.EnmWalletService(),
            api:           new root.EnmApiClient(),
            sse:           root.EnmSse ? new root.EnmSse() : null,
            notifications: new root.EnmNotifications(),
        };

        // Step 1: window-manager IPC contract MUST happen before anything else.
        this.services.wallet.sendReady();
        this.services.wallet.installCloseHandler();

        // Step 2: resolve identity in the background (non-blocking). The
        // identity is still useful for audit attribution + the producer
        // identity card; we just don't render a wallet badge anymore (PC2's
        // launcher / system tray already shows the operator's wallet).
        var self = this;
        this.services.wallet.getIdentity().then(function (id) {
            self.identity = id;
        });

        this._wireThemeToggle();

        // Step 3 + 4: probe backend, then decide wizard vs dashboard.
        return this.services.api.get('/health', { skipCache: true })
            .catch(function (err) {
                throw withTag(err, 'health');
            })
            .then(function () {
                return self.services.api.get('/setup/state', { skipCache: true });
            })
            .then(function (setupState) {
                if (!setupState || !setupState.completed) {
                    self._showSetupWizard();
                } else {
                    self._showDashboard();
                }
            })
            .catch(function (err) {
                self._showError(err);
            });
    };

    /**
     * Wire the theme toggle button. Persists choice to the shared
     * 'elacity-theme' localStorage key — same key dao-dashboard /
     * Elacity Market / dApp Centre use, so flipping the theme in any
     * of these surfaces propagates here on next open.
     *
     * Pre-paint script in index.html applies the saved theme before
     * first render, so this method only handles user clicks.
     *
     * @private
     */
    ENMApp.prototype._wireThemeToggle = function () {
        if (!this.els.themeToggle) { return; }
        this.els.themeToggle.addEventListener('click', function () {
            var current = document.documentElement.getAttribute('data-theme');
            var next = (current === 'dark') ? 'light' : 'dark';
            if (next === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
            } else {
                document.documentElement.removeAttribute('data-theme');
            }
            try { localStorage.setItem('elacity-theme', next); } catch (e) { /* ignore */ }
        });
    };

    ENMApp.prototype._showSetupWizard = function () {
        // Friendly path (v0.4): Welcome → Setup conversation → Home.
        // The 5-tab dashboard chrome is hidden until setup is done.
        this._revealContent();
        this._clearPanes();
        if (this.els.tabs) { this.els.tabs.hidden = true; }

        // If the operator has clearly already started setup (binary on disk
        // or partial install), skip the welcome screen and resume in the
        // conversation. Otherwise, lead with the welcome.
        var self = this;
        this.services.api.get('/setup/state', { skipCache: true }).then(function (s) {
            var resume = s && s.currentStep && s.currentStep !== 'welcome';
            if (resume) {
                self._mountSetupConversation();
            } else {
                self._mountWelcomeScreen();
            }
        }).catch(function () {
            self._mountWelcomeScreen();
        });
    };

    /** @private */
    ENMApp.prototype._mountWelcomeScreen = function () {
        var self = this;
        if (!root.EnmWelcomeScreen) { return self._mountSetupConversation(); }
        this._clearPanes();
        var screen = new root.EnmWelcomeScreen({
            onContinue: function () { self._mountSetupConversation(); },
        });
        screen.mount(this.els.paneDashboard);
    };

    /** @private */
    ENMApp.prototype._mountSetupConversation = function () {
        var self = this;
        this._clearPanes();
        if (!root.EnmSetupConversation) {
            // Should not happen — script tag missing. Fall back to legacy wizard.
            if (root.EnmSetupWizard) {
                var legacy = new root.EnmSetupWizard({
                    api: this.services.api,
                    notifications: this.services.notifications,
                    sse: this.services.sse,
                    onComplete: function () {
                        self.services.api.invalidate('/setup/state');
                        self._showDashboard();
                    },
                });
                legacy.mount(this.els.paneDashboard);
            }
            return;
        }
        var conv = new root.EnmSetupConversation({
            api: this.services.api,
            notifications: this.services.notifications,
            sse: this.services.sse,
            onComplete: function () {
                self.services.api.invalidate('/setup/state');
                self._showDashboard();
            },
        });
        conv.mount(this.els.paneDashboard);
    };

    ENMApp.prototype._showDashboard = function () {
        this._revealContent();
        this.els.tabs.hidden = false;
        this._wireTabs();
        this._clearPanes();

        var sys = new root.EnmSystemStatus({
            api: this.services.api,
            notifications: this.services.notifications,
        });
        sys.mount(this.els.paneDashboard);

        if (root.EnmProducerIdentity) {
            var producer = new root.EnmProducerIdentity({
                chainId: 'mainchain',
                api: this.services.api,
                notifications: this.services.notifications,
            });
            producer.mount(this.els.paneDashboard);
        }

        if (root.EnmSettingsTab) {
            var settings = new root.EnmSettingsTab({
                api: this.services.api,
                notifications: this.services.notifications,
            });
            settings.mount(this.els.paneSettings);
        }
        if (root.EnmAuditTab) {
            var audit = new root.EnmAuditTab({
                api: this.services.api,
                notifications: this.services.notifications,
            });
            audit.mount(this.els.paneAudit);
        }
        if (root.EnmEvmTab) {
            var evm = new root.EnmEvmTab();
            evm.mount(this.els.paneEvm);
        }

        var chainsContainer = document.createElement('div');
        chainsContainer.className = 'enm-chains-grid';
        this.els.paneDashboard.appendChild(chainsContainer);

        var self = this;
        this.services.api.get('/chains', { skipCache: true }).then(function (data) {
            var chains = (data && data.chains) || [];
            if (chains.length === 0) {
                var empty = document.createElement('p');
                empty.className = 'enm-stub';
                empty.textContent = root.enmTOrFallback('chain_card.no_chains');
                chainsContainer.appendChild(empty);
                return;
            }
            chains.forEach(function (c) {
                var card = new root.EnmChainCard({
                    chainId: c.chainId,
                    api: self.services.api,
                    notifications: self.services.notifications,
                    sse: self.services.sse,
                    onReconfigure: function () { self._showSetupWizard(); },
                });
                card.mount(chainsContainer);
            });

            self.els.paneLogs.innerHTML = '';
            if (root.EnmLogViewer && self.services.sse) {
                var viewer = new root.EnmLogViewer({
                    chainId: chains[0].chainId,
                    api: self.services.api,
                    sse: self.services.sse,
                });
                viewer.mount(self.els.paneLogs);
            }
        }).catch(function (err) {
            self.services.notifications.warning(
                'Failed to load chains',
                err && err.message ? err.message : String(err),
            );
        });

        if (this.services.sse) {
            this.services.sse.subscribe('notifications', function (payload) {
                if (!payload) { return; }
                if (payload.proposalId) {
                    self._openProposalById(payload.proposalId);
                    return;
                }
                self.services.notifications.show({
                    severity: mapSeverity(payload.severity),
                    title:    payload.summary || payload.title || 'Notification',
                    body:     payload.detail  || payload.body  || '',
                    id:       payload.proposalId || ('enm-sse-' + (payload.ts || Date.now())),
                });
            });
        }

        this._loadPendingProposals();
        this._switchTab('dashboard');
    };

    ENMApp.prototype._loadPendingProposals = function () {
        var self = this;
        this.services.api.get('/healing/suggestions', { skipCache: true }).then(function (data) {
            var props = (data && data.proposals) || [];
            props.forEach(function (p) { self._openProposal(p); });
        }).catch(function () {});
    };

    ENMApp.prototype._openProposalById = function (id) {
        var self = this;
        this.services.api.get('/healing/suggestions', { skipCache: true }).then(function (data) {
            var rec = (data && Array.isArray(data.proposals))
                ? data.proposals.find(function (p) { return p.id === id; })
                : null;
            if (rec) { self._openProposal(rec); }
        }).catch(function () {});
    };

    ENMApp.prototype._openProposal = function (p) {
        if (!root.EnmProposalCard) { return; }
        var card = new root.EnmProposalCard({
            proposal: p,
            api: this.services.api,
            notifications: this.services.notifications,
        });
        card.mount(document.body);
    };

    ENMApp.prototype._wireTabs = function () {
        if (this.els.tabs.dataset.wired === '1') { return; }
        this.els.tabs.dataset.wired = '1';
        var self = this;
        this.els.tabs.querySelectorAll('[data-tab]').forEach(function (btn) {
            btn.addEventListener('click', function () { self._switchTab(btn.dataset.tab); });
        });
    };

    ENMApp.prototype._switchTab = function (name) {
        var panes = {
            dashboard: this.els.paneDashboard,
            logs:      this.els.paneLogs,
            settings:  this.els.paneSettings,
            audit:     this.els.paneAudit,
            evm:       this.els.paneEvm,
        };
        Object.keys(panes).forEach(function (k) {
            if (panes[k]) { panes[k].hidden = (k !== name); }
        });
        this.els.tabs.querySelectorAll('[data-tab]').forEach(function (b) {
            var selected = (b.dataset.tab === name);
            b.setAttribute('aria-selected', selected ? 'true' : 'false');
            b.classList.toggle('active', selected);
        });
    };

    ENMApp.prototype._clearPanes = function () {
        ['paneDashboard', 'paneLogs', 'paneSettings', 'paneAudit', 'paneEvm'].forEach(function (k) {
            if (this.els[k]) { this.els[k].innerHTML = ''; }
        }, this);
    };

    ENMApp.prototype._revealContent = function () {
        this.els.spinner.hidden = true;
        this.els.error.hidden = true;
        this.els.content.hidden = false;
        this.els.app.setAttribute('data-state', 'ready');
    };

    ENMApp.prototype._showError = function (err) {
        this.els.spinner.hidden = true;
        this.els.content.hidden = true;
        this.els.error.hidden = false;
        this.els.app.setAttribute('data-state', 'error');

        var t = root.enmTOrFallback;
        var title, detail;
        if (err && err.status === 401) {
            title  = t('owner.unauthenticated');
            detail = t('app.unauthenticatedHelp');
        } else if (err && err.status === 403) {
            title  = t('owner.forbidden');
            detail = t('app.forbiddenHelp');
        } else if (err && err._tag === 'health') {
            title  = t('app.backendUnreachable');
            detail = t('app.backendHelp') + (err.message ? ' (' + err.message + ')' : '');
        } else {
            title  = t('app.generic_error');
            detail = (err && err.message) ? err.message : String(err);
        }
        this.els.errorTitle.textContent = title;
        this.els.errorDetail.textContent = detail;
    };

    function withTag(err, tag) {
        if (!err || typeof err !== 'object') { err = new Error(String(err)); }
        err._tag = tag;
        return err;
    }

    function mapSeverity(s) {
        var v = (typeof s === 'string') ? s.toLowerCase() : 'info';
        if (v === 'critical' || v === 'warning' || v === 'healing' || v === 'info') {
            return v;
        }
        return 'info';
    }

    function bootstrap() {
        var app = new ENMApp();
        root.enmApp = app;
        app.init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
}(typeof window !== 'undefined' ? window : globalThis));
