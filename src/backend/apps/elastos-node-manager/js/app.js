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
            settingsToggle: document.getElementById('enm-settings-toggle'),
            paneDashboard: document.getElementById('enm-pane-dashboard'),
            paneLogs:     document.getElementById('enm-pane-logs'),
            paneSettings: document.getElementById('enm-pane-settings'),
            paneAudit:    document.getElementById('enm-pane-audit'),
            paneEvm:      document.getElementById('enm-pane-evm'),
        };

        // The drawer (Phase 5C) is mounted once at app boot — it lives at
        // the top level so it can overlay any view (welcome, setup, home,
        // technical). It stays hidden until the gear icon is tapped.
        this._drawer = null;
        this._technicalView = null;

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
        this._wireSettingsToggle();

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
     * In v0.4 P5C this is moved INTO the settings drawer, but the
     * top-level toggle button stays in the DOM as a fallback for any
     * view where the drawer isn't mounted (e.g. error pane).
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

    /**
     * Wire the gear icon in the home header to open the settings drawer.
     * Lazy-mounts the drawer on first click so we don't pay for it
     * during welcome / setup flows.
     *
     * @private
     */
    ENMApp.prototype._wireSettingsToggle = function () {
        if (!this.els.settingsToggle) { return; }
        var self = this;
        this.els.settingsToggle.addEventListener('click', function () {
            self._openSettingsDrawer();
        });
    };

    /** @private */
    ENMApp.prototype._openSettingsDrawer = function () {
        if (!root.EnmSettingsDrawer) { return; }
        if (!this._drawer) {
            var self = this;
            this._drawer = new root.EnmSettingsDrawer({
                notifications: this.services.notifications,
                onShowTechnical: function () { self._showTechnicalView(); },
                onReinstall:     function () { self._showSetupWizard(); },
            });
            this._drawer.mount(document.body);
        }
        this._drawer.open();
    };

    /**
     * Swap the home view for the v0.3 dashboard wrapper. "Back to home"
     * inside the technical view calls _showDashboard to restore.
     *
     * @private
     */
    ENMApp.prototype._showTechnicalView = function () {
        if (!root.EnmTechnicalView) { return; }
        this._revealContent();
        this._collapseHeaderToHome();
        this._clearPanes();
        if (this._technicalView) {
            this._technicalView.destroy();
            this._technicalView = null;
        }
        var self = this;
        this._technicalView = new root.EnmTechnicalView({
            api: this.services.api,
            sse: this.services.sse,
            notifications: this.services.notifications,
            onBackHome: function () { self._showDashboard(); },
        });
        this._technicalView.mount(this.els.paneDashboard);
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
        // v0.4 home view: hero card (focal-point status) + stat strip
        // (earnings/uptime/friends) + producer identity (BPoS only).
        // The v0.3 dashboard now lives behind "Show technical details"
        // in the settings drawer (Phase 5C).
        this._revealContent();
        this._collapseHeaderToHome();
        this._clearPanes();

        // Tear down the technical view if we're returning from it.
        if (this._technicalView) {
            this._technicalView.destroy();
            this._technicalView = null;
        }
        // And clear the milestone interval before remounting (otherwise
        // back-and-forth between home / technical view leaks timers).
        if (this._milestoneTimer) {
            clearInterval(this._milestoneTimer);
            this._milestoneTimer = null;
        }

        var self = this;
        var pane = this.els.paneDashboard;

        // Hero card.
        if (root.EnmHeroCard) {
            var hero = new root.EnmHeroCard({
                chainId: 'mainchain',
                api: this.services.api,
                sse: this.services.sse,
                notifications: this.services.notifications,
                onAction: function (action) {
                    if (action === 'setup') {
                        self._showSetupWizard();
                    } else if (action === 'details') {
                        // Settings drawer comes in Phase 5C — for now,
                        // surface the underlying state as a notification
                        // so the operator isn't stranded.
                        self.services.notifications.warning(
                            'Details view coming soon',
                            'The technical details drawer ships in a coming update. '
                            + 'For now, run `docker compose logs enm-server` on the host.'
                        );
                    }
                },
            });
            hero.mount(pane);
            this._hero = hero;
        }

        // Stat strip below the hero.
        if (root.EnmStatStrip) {
            var strip = new root.EnmStatStrip({
                chainId: 'mainchain',
                api: this.services.api,
            });
            strip.mount(pane);
            this._stats = strip;
        }

        // Producer identity card — only mounts if a keystore exists
        // (the component itself decides this from /setup/keystore/account).
        if (root.EnmProducerIdentity) {
            var producer = new root.EnmProducerIdentity({
                chainId: 'mainchain',
                api: this.services.api,
                notifications: this.services.notifications,
            });
            producer.mount(pane);
        }

        // Milestone watchers — fire one-time celebrations when the
        // operator's ElastOS hits first-sync, first-reward, first-week.
        // We poll every 30s alongside the hero/stat-strip refresh; the
        // milestone helper internally guards against re-firing.
        if (root.EnmMilestone) {
            var milestoneTick = function () {
                Promise.all([
                    self.services.api.get('/chains/mainchain', { skipCache: true }).catch(function () { return null; }),
                    self.services.api.get('/chains/mainchain/producer', { skipCache: true }).catch(function () { return null; }),
                ]).then(function (results) {
                    var ctx = { chain: results[0], producer: results[1] };
                    root.EnmMilestone.maybeFire('first_sync',   ctx);
                    root.EnmMilestone.maybeFire('first_reward', ctx);
                    root.EnmMilestone.maybeFire('first_week',   ctx);
                });
            };
            milestoneTick();
            this._milestoneTimer = setInterval(milestoneTick, 30000);
        }

        // Notifications pipeline — keep the v0.3 SSE wiring so CRITICAL
        // proposals still pop as cards on top of the home view.
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
    };

    /**
     * In v0.4 home mode, the 5-tab nav goes away — the home view IS
     * the only view (settings drawer comes in Phase 5C). We keep the
     * header bar visible because the theme toggle still lives there.
     *
     * @private
     */
    ENMApp.prototype._collapseHeaderToHome = function () {
        if (!this.els.tabs) { return; }
        this.els.tabs.hidden = false;
        var tabsContainer = this.els.tabs.querySelector('.enm-header-tabs');
        if (tabsContainer) { tabsContainer.hidden = true; }
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
