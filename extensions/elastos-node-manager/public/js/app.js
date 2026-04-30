/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Elastos Node Manager — frontend controller (Phase 3).
 *
 * Boot sequence:
 *   1. Send READY postMessage to PC2 parent
 *   2. Install windowWillClose responder (Rev 6 audit — REQUIRED)
 *   3. Probe /api/health to confirm extension is loaded by PC2
 *   4. Probe /api/setup/state — if not completed, show setup wizard
 *   5. Else show dashboard (system status + chain cards + tabs)
 *   6. Subscribe to SSE topics (notifications, status updates per chain)
 *
 * State transitions surface to the user via the spinner text. If anything
 * fails, an error pane explains what to try next.
 */

(function (root) {
    'use strict';

    var els = null;
    var services = null;

    function bootstrap() {
        els = {
            app:         document.getElementById('app'),
            spinner:     document.getElementById('enm-spinner'),
            spinnerText: document.getElementById('enm-spinner-text'),
            error:       document.getElementById('enm-error'),
            content:     document.getElementById('enm-content'),
            tabs:        document.getElementById('enm-tabs'),
            paneDashboard: document.getElementById('enm-pane-dashboard'),
            paneLogs:    document.getElementById('enm-pane-logs'),
            paneSettings: document.getElementById('enm-pane-settings'),
            paneAudit:   document.getElementById('enm-pane-audit'),
        };

        services = {
            wallet:        new root.EnmWalletService(),
            api:           new root.EnmApiClient(),
            sse:           new root.EnmSse(),
            notifications: new root.EnmNotifications(),
        };

        // 1. + 2. — these MUST happen before anything else (Rev 6 audit).
        services.wallet.sendReady();
        services.wallet.installCloseHandler();

        // 3. Health probe — confirms our extension's routes are mounted.
        return probeHealth().then(function () {
            // Show the connection-state indicator.
            services.sse.onState(function (state) {
                if (state === 'reconnecting') {
                    setSpinnerText(root.enmTOrFallback('app.reconnecting'));
                }
            });

            // 4. Decide between wizard and dashboard.
            return services.api.get('/setup/state', { skipCache: true });
        }).then(function (setupState) {
            if (!setupState || !setupState.completed) {
                showSetupWizard();
                return;
            }
            showDashboard();
        }).catch(function (err) {
            showError(buildBootErrorMessage(err));
        });
    }

    function probeHealth() {
        return services.api.get('/health', { skipCache: true })
            .catch(function (err) {
                throw new Error('Backend health probe failed: ' + (err.message || 'unknown'));
            });
    }

    function showSetupWizard() {
        revealContent();
        els.paneDashboard.innerHTML = '';
        els.paneLogs.innerHTML = '';
        var wizard = new root.EnmSetupWizard({
            api: services.api,
            notifications: services.notifications,
            sse: services.sse,
            onComplete: function () {
                // After wizard finishes, switch to the dashboard.
                services.api.invalidate('/setup/state');
                showDashboard();
            },
        });
        wizard.mount(els.paneDashboard);
        switchTab('dashboard');
    }

    function showDashboard() {
        revealContent();
        els.tabs.hidden = false;
        wireTabs();

        // Tear down anything from a previous mount (e.g. wizard → dashboard
        // transition) so we don't leak listeners.
        els.paneDashboard.innerHTML = '';
        els.paneLogs.innerHTML = '';
        els.paneSettings.innerHTML = '';
        els.paneAudit.innerHTML = '';

        // Dashboard pane: system status + chain cards.
        var sys = new root.EnmSystemStatus({
            api: services.api,
            notifications: services.notifications,
        });
        sys.mount(els.paneDashboard);

        // Settings pane.
        var settings = new root.EnmSettingsTab({
            api: services.api,
            notifications: services.notifications,
        });
        settings.mount(els.paneSettings);

        // Audit pane.
        var audit = new root.EnmAuditTab({
            api: services.api,
            notifications: services.notifications,
        });
        audit.mount(els.paneAudit);

        var chainsContainer = document.createElement('div');
        chainsContainer.className = 'enm-chains-grid';
        els.paneDashboard.appendChild(chainsContainer);

        services.api.get('/chains', { skipCache: true }).then(function (data) {
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
                    api: services.api,
                    notifications: services.notifications,
                    sse: services.sse,
                });
                card.mount(chainsContainer);
            });
            // Logs pane: a single log viewer for the first chain (mainchain in v0.1).
            els.paneLogs.innerHTML = '';
            var first = chains[0];
            var logViewer = new root.EnmLogViewer({
                chainId: first.chainId,
                api: services.api,
                sse: services.sse,
            });
            logViewer.mount(els.paneLogs);
        }).catch(function (err) {
            services.notifications.warning(
                'Failed to load chains',
                err && err.message ? err.message : String(err),
            );
        });

        // Notifications topic — server-pushed messages from SelfHealingEngine.
        // Two payload shapes:
        //   1. { proposalId, chainId, ruleId, severity, summary, detail }
        //      → open a ProposalCard modal so the operator can review + confirm
        //   2. plain notification (no proposalId)
        //      → fire a toast in the appropriate severity tier
        services.sse.subscribe('notifications', function (payload) {
            if (!payload) { return; }
            if (payload.proposalId) {
                openProposalById(payload.proposalId);
                return;
            }
            services.notifications.show({
                severity:  mapSeverity(payload.severity),
                title:     payload.summary || payload.title || 'Notification',
                body:      payload.detail  || payload.body  || '',
                id:        payload.proposalId || ('enm-sse-' + (payload.ts || Date.now())),
            });
        });

        // On dashboard mount, fetch any pending proposals from a previous session
        // so a refreshing operator doesn't lose visibility on outstanding asks.
        loadPendingProposals();

        switchTab('dashboard');
    }

    /**
     * Translate the backend's SEVERITY enum (INFO/WARNING/CRITICAL/HEALING) to
     * the toast component's lowercase severity. Anything unknown defaults to
     * 'info' so we never silently drop a notification.
     */
    function mapSeverity(s) {
        var v = (typeof s === 'string') ? s.toLowerCase() : 'info';
        if (v === 'critical' || v === 'warning' || v === 'healing' || v === 'info') {
            return v;
        }
        return 'info';
    }

    function loadPendingProposals() {
        services.api.get('/healing/suggestions', { skipCache: true }).then(function (data) {
            var props = (data && data.proposals) || [];
            props.forEach(function (p) { openProposal(p); });
        }).catch(function () {
            // Silent — endpoint may not be ready until first 'ready' tick. The
            // SSE subscription above will deliver new ones live.
        });
    }

    function openProposalById(id) {
        services.api.get('/healing/suggestions', { skipCache: true }).then(function (data) {
            var rec = (data && Array.isArray(data.proposals))
                ? data.proposals.find(function (p) { return p.id === id; })
                : null;
            if (rec) { openProposal(rec); }
        }).catch(function () { /* ignore — surfaces via toast next time */ });
    }

    function openProposal(p) {
        var card = new root.EnmProposalCard({
            proposal: p,
            api: services.api,
            notifications: services.notifications,
        });
        card.mount(document.body);
    }

    function wireTabs() {
        if (els.tabs.dataset.wired === '1') { return; }
        els.tabs.dataset.wired = '1';
        var buttons = els.tabs.querySelectorAll('[data-tab]');
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
        });
    }

    function switchTab(name) {
        var panes = {
            dashboard: els.paneDashboard,
            logs:      els.paneLogs,
            settings:  els.paneSettings,
            audit:     els.paneAudit,
        };
        Object.keys(panes).forEach(function (k) { panes[k].hidden = (k !== name); });
        var buttons = els.tabs.querySelectorAll('[data-tab]');
        buttons.forEach(function (b) {
            b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
        });
    }

    function revealContent() {
        els.spinner.hidden = true;
        els.error.hidden = true;
        els.content.hidden = false;
        els.app.setAttribute('data-state', 'ready');
    }

    function setSpinnerText(text) {
        if (els && els.spinnerText) { els.spinnerText.textContent = text; }
    }

    function showError(message) {
        if (!els) { return; }
        els.spinner.hidden = true;
        els.content.hidden = true;
        els.error.hidden = false;
        els.error.textContent = message;
        els.app.setAttribute('data-state', 'error');
    }

    function buildBootErrorMessage(err) {
        if (err && err.status === 401) {
            return root.enmTOrFallback('owner.unauthenticated');
        }
        var detail = err && err.message ? err.message : String(err);
        return root.enmTOrFallback('app.backendUnreachable') + ' Details: ' + detail;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
}(typeof window !== 'undefined' ? window : globalThis));
