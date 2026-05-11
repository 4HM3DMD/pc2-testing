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
            // 0.2.0-alpha.1 — Apple Hero page-wash controller. Sets
            // <html data-fleet-health> based on aggregate chain state.
            // Mount happens in _showDashboard (only the dashboard wears
            // the wash; setup wizard / welcome stay neutral).
            fleetHealth:   root.EnmFleetHealthGradient ? new root.EnmFleetHealthGradient() : null,
            // 0.2.0-alpha.1 — block-height history client backing the
            // chain-card sparkline. One subscription per chainId, fan-
            // out to N listeners (currently just chain-card, but the
            // Identity / EVM panes may want it later). Bootstrap +
            // SSE delta + 5-min poll fallback handled internally.
            heightSeries:  root.EnmHeightSeriesClient
                              ? new root.EnmHeightSeriesClient(
                                    /* api */ null, /* sse */ null,
                                ) /* sentinel; reassigned below once api/sse exist */
                              : null,
        };
        // The HeightSeriesClient constructor wants api + sse refs at
        // construction time — but services.api / services.sse aren't
        // bound until this object literal evaluates. Reassign now that
        // we have them.
        if (this.services.heightSeries && root.EnmHeightSeriesClient) {
            this.services.heightSeries = new root.EnmHeightSeriesClient(
                this.services.api,
                this.services.sse,
            );
        }

        // Step 1: window-manager IPC contract MUST happen before anything else.
        this.services.wallet.sendReady();
        this.services.wallet.installCloseHandler();

        // Listen for PC2's themeChanged broadcast so ENM follows the
        // operator's desktop choice automatically. Manual override
        // (drawer's theme switch) is honoured first.
        if (root.EnmThemeService) { root.EnmThemeService.init(); }

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
        this._wireCrossTabSync();

        // Step 3 + 4: probe backend, then decide wizard vs dashboard.
        return this.services.api.get('/health', { skipCache: true })
            .catch(function (err) {
                throw withTag(err, 'health');
            })
            .then(function () {
                return self.services.api.get('/setup/state', { skipCache: true });
            })
            .then(function (setupState) {
                // Treat any truthy `completed` as "setup is done" — SQLite
                // stores booleans as 0/1 integers, so the GET /setup/state
                // response surfaces `completed: 1` not `completed: true`.
                // Earlier strict-equality (=== true) was wrong: it routed
                // every already-configured operator back to the welcome
                // screen on every page load. Falsy or missing → setup.
                if (setupState && setupState.completed) {
                    self._showDashboard();
                } else {
                    self._showSetupWizard();
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

    /**
     * BroadcastChannel('enm') — when the operator finishes setup in one
     * browser tab, any other tab still showing welcome/setup needs to
     * route to the dashboard. Without this they sit on a stale view
     * until refresh.
     *
     * Posts on _showDashboard call sites that follow setup completion.
     * Listens here at boot. Tab that posts doesn't see its own message
     * (BroadcastChannel skips own-origin posts), so no infinite loop.
     *
     * Falls back silently in browsers without BroadcastChannel — the
     * stale-tab is a polish issue, not a correctness one.
     *
     * @private
     */
    ENMApp.prototype._wireCrossTabSync = function () {
        if (typeof BroadcastChannel !== 'function') { return; }
        var self = this;
        try {
            this._bc = new BroadcastChannel('enm');
            this._bc.addEventListener('message', function (ev) {
                if (!ev || !ev.data) { return; }
                if (ev.data.type === 'setup-complete') {
                    // Only react if we're not already on the dashboard.
                    if (!self._technicalView) {
                        self.services.api.invalidate('/setup/state');
                        self._showDashboard();
                    }
                }
            });
        } catch (_) { /* incompatible env — silently skip */ }
    };

    /** @private — broadcast a setup-completed event to peer tabs */
    ENMApp.prototype._broadcastSetupComplete = function () {
        if (this._bc) {
            try { this._bc.postMessage({ type: 'setup-complete' }); } catch (_) {}
        }
    };

    /** @private */
    ENMApp.prototype._openSettingsDrawer = function () {
        if (!root.EnmSettingsDrawer) { return; }
        if (!this._drawer) {
            var self = this;
            this._drawer = new root.EnmSettingsDrawer({
                notifications: this.services.notifications,
                // v0.5 reset: technical view is the default home, so the
                // "Show technical details" disclosure is no longer needed.
                // The drawer's onShowTechnical handler is a no-op now;
                // settings-drawer.js hides the row when not provided.
                onShowTechnical: null,
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
    ENMApp.prototype._showSetupWizard = function () {
        // Friendly path (v0.4): Welcome → Setup conversation → Home.
        // The 5-tab dashboard chrome is hidden until setup is done.
        // Tear down anything from the home view first (idempotent if
        // we're coming straight from boot).
        if (typeof this._teardownHomeView === 'function') { this._teardownHomeView(); }
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
            // Defensive: script tag missing. v0.5 deletes the legacy wizard
            // fallback (setup-wizard.js was 600+ LOC of pre-conversation
            // code), so a missing component now produces a clear error
            // pane instead of silently rendering the older flow.
            this.els.paneDashboard.innerHTML =
                '<p class="enm-stub">Setup conversation component not loaded. '
                + 'Hard-refresh the page (Ctrl-Shift-R).</p>';
            return;
        }
        var conv = new root.EnmSetupConversation({
            api: this.services.api,
            notifications: this.services.notifications,
            sse: this.services.sse,
            onComplete: function () {
                self.services.api.invalidate('/setup/state');
                self._showDashboard();
                // Tell any other open ENM tabs to also flip to dashboard.
                self._broadcastSetupComplete();
            },
        });
        conv.mount(this.els.paneDashboard);
    };

    ENMApp.prototype._showDashboard = function () {
        // 0.2.0-alpha.1 — Apple Hero phase 2: paint the page wash before
        // the technical view mounts. Default bucket is 'healthy' so the
        // green wash is in place before chain-cards report in; the
        // gradient controller corrects to the truthful bucket on the
        // first 'enm:chain-state' event (chain-card emits these in
        // phase 6 of the rewrite).
        if (this.services.fleetHealth) {
            this.services.fleetHealth.mount('healthy');
        }
        // v0.5 reset — the home view IS the v0.3 technical dashboard.
        //
        // The friendly home (hero-card + stat-strip + milestone-toast)
        // shipped in Phase 5B was making claims it couldn't back up:
        // role inferred from registration status, "happy and earning"
        // before the operator was actually registered, "friends" instead
        // of peers, fake earned counts. We deleted those components in
        // v0.5. Setup conversation + welcome still ship (they pull only
        // verifiable backend state); everything post-setup goes straight
        // to the technical view, which renders only what the API
        // explicitly returns.
        this._revealContent();
        this._collapseHeaderToHome();
        this._clearPanes();
        this._teardownHomeView();

        if (!root.EnmTechnicalView) {
            // Defensive fallback: if the script tag is missing, surface
            // a clear error rather than silently rendering nothing.
            this.els.paneDashboard.innerHTML =
                '<p class="enm-stub">Technical view component not loaded. '
                + 'Hard-refresh the page (Ctrl-Shift-R).</p>';
            return;
        }

        var self = this;
        this._technicalView = new root.EnmTechnicalView({
            api: this.services.api,
            sse: this.services.sse,
            notifications: this.services.notifications,
            // 0.2.0-alpha.1 — chain-card subscribes for sparkline data.
            heightSeries: this.services.heightSeries,
            // No "back to home" button — the technical view IS home now.
            onBackHome: null,
        });
        this._technicalView.mount(this.els.paneDashboard);

        // Notifications pipeline — keep CRITICAL proposal cards popping
        // on top of the dashboard.
        if (this.services.sse) {
            this._notifSub = this.services.sse.subscribe('notifications', function (payload) {
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
     * Destroy everything _showDashboard mounted. Called on remount and
     * when transitioning to setup so we don't leak SSE subs or intervals.
     *
     * @private
     */
    ENMApp.prototype._teardownHomeView = function () {
        if (this._technicalView) {
            this._technicalView.destroy();
            this._technicalView = null;
        }
        if (this._notifSub) { this._notifSub(); this._notifSub = null; }
        // 0.2.0-alpha.1 — page-wash controller tears down with the home
        // view. The CSS attribute on <html> is intentionally left in
        // place so a re-mount doesn't flash a neutral wash before the
        // first state report.
        if (this.services && this.services.fleetHealth) {
            this.services.fleetHealth.destroy();
        }
        // Height-series client unsubscribes all per-chain SSE wirings +
        // 5-min poll intervals on teardown. Buffers are dropped — fresh
        // bootstrap on remount.
        if (this.services && this.services.heightSeries) {
            this.services.heightSeries.destroy();
        }
        // The settings drawer is lazy-mounted on first gear click. When we
        // transition out of the home view (e.g. to the setup wizard via
        // "Reinstall my node"), tear it down so its document-level ESC
        // handler doesn't outlive the home shell.
        if (this._drawer) {
            this._drawer.destroy();
            this._drawer = null;
        }
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
