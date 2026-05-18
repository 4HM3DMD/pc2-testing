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

    /**
     * alpha.25 — wire a ResizeObserver to the iframe's html element and write
     * the current size class as body[data-app-size]. CSS rules selectoring on
     * this attribute can override @media-query rules that don't fire correctly
     * inside iframe (where @media measures the OUTER browser viewport instead
     * of the iframe interior).
     *
     * Breakpoints chosen to match the design proposals doc:
     *   narrow:  < 700px (settings nav rail collapses; tabs wrap; form rows stack)
     *   medium:  700px..999px (tabs reduced, content stays full-width)
     *   wide:    >= 1000px (default; nav rail visible; max-width caps lifted)
     */
    function setupResponsiveObserver() {
        // alpha.28.1 — guard against double-install. init() is called
        // once on first boot and AGAIN each time the operator clicks
        // Retry on the error pane (batch 8). Without this guard each
        // retry stacks another ResizeObserver (or another resize
        // listener), pinning a closure to the previous app instance
        // and doubling the per-resize work. After 5 retries the page
        // does 5× the work on every layout change.
        if (root.__enmRespObserverInstalled) { return; }
        root.__enmRespObserverInstalled = true;
        function classify(w) {
            // Beta 3 — phase-02 mock breakpoints. Three sizes only:
            //   compact  < 480px   iPhone-class / split-screen
            //   narrow   480-699   tablet / large phone
            //   wide     >= 700    desktop default
            // The old "medium" bucket (700-999) collapsed into "wide";
            // the new "compact" bucket below 480 is the addition.
            if (w < 480) return 'compact';
            if (w < 700) return 'narrow';
            return 'wide';
        }
        function apply(width) {
            if (!document.body) return;
            var cls = classify(width);
            if (document.body.dataset.appSize !== cls) {
                document.body.dataset.appSize = cls;
            }
        }
        // Inline script in index.html sets <html data-app-size> before first
        // paint; mirror it to body so CSS can select either. body is
        // guaranteed present by the time app.js runs (script lives below </body>).
        // alpha.29 batch 112 (Round-34 perf finding #6, LOW) — read the
        // width the head IIFE already computed (via
        // window.__enmInitialWidth) in the fallback branch, instead of
        // re-querying window.innerWidth which forces a second layout
        // flush. Saves ~2-3ms off first paint by deduping the read.
        var initial = document.documentElement.dataset.appSize;
        if (!initial) {
            var w = (typeof root.__enmInitialWidth === 'number')
                ? root.__enmInitialWidth
                : (window.innerWidth || document.documentElement.clientWidth || 1200);
            apply(w);
        } else {
            document.body.dataset.appSize = initial;
        }
        // 0.2.0-beta.3.5 — re-measure after a paint tick. Inside Puter's
        // window-launch flow the iframe's initial width can be 0 or
        // mis-reported (the desktop sizes the iframe a frame or two AFTER
        // the script runs), which would lock the layout into a wrong size
        // bucket until the operator manually resizes. requestAnimation
        // Frame + a 50ms safety net gives the desktop time to settle
        // before we read the final width. ResizeObserver picks up
        // anything after that.
        function reapply() {
            var w2 = window.innerWidth || document.documentElement.clientWidth || 0;
            if (w2 > 0) { apply(w2); }
        }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                requestAnimationFrame(reapply);
            });
        }
        setTimeout(reapply, 50);
        // Dynamic updates: ResizeObserver on documentElement reports the iframe
        // interior width. This is the ONLY reliable size signal in PC2 — neither
        // @media nor postMessage from PC2 gives us iframe width.
        if (typeof root.ResizeObserver === 'function') {
            var ro = new root.ResizeObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    apply(entries[i].contentRect.width);
                }
            });
            ro.observe(document.documentElement);
        } else {
            // Legacy fallback — poll window.resize. Loses fidelity vs ResizeObserver
            // (only fires on outer browser resize, not iframe resize) but better
            // than nothing.
            window.addEventListener('resize', function () {
                apply(window.innerWidth || document.documentElement.clientWidth);
            });
        }
    }

    /**
     * Wire the error-pane Retry / Reload buttons. Called once during
     * init so the listeners survive every subsequent _showError() call.
     * Retry re-runs init() with the previous flags; Reload is a hard
     * fallback when retry can't even reach the error pane.
     */
    ENMApp.prototype._wireErrorActions = function () {
        var self = this;
        var t = root.enmTOrFallback;
        // alpha.28.1 batch 40 — replace index.html's English defaults
        // with i18n strings now that strings.js has loaded. The
        // English defaults remain in markup as a fallback for the
        // brief window before this runs.
        // alpha.28.1 batch 80 (Round-22 audit finding #4) — also
        // localise the spinner text. The previous shape rendered the
        // English literal "Connecting to Node Manager…" regardless of
        // the operator's selected locale. The element was queried into
        // this.els.spinnerText at boot but never written.
        if (this.els.spinnerText) {
            var connectingText = t('app.connecting');
            if (connectingText && connectingText !== 'app.connecting') {
                this.els.spinnerText.textContent = connectingText;
            }
        }
        if (this.els.errorRetry) {
            var retryText = t('app.retry');
            if (retryText && retryText !== 'app.retry') {
                this.els.errorRetry.textContent = retryText;
            }
        }
        if (this.els.errorReload) {
            var reloadText = t('app.reload');
            if (reloadText && reloadText !== 'app.reload') {
                this.els.errorReload.textContent = reloadText;
            }
        }
        var skipLink = document.querySelector('.enm-skip-link');
        if (skipLink) {
            var skipText = t('app.skip_link');
            if (skipText && skipText !== 'app.skip_link') {
                skipLink.textContent = skipText;
            }
        }
        if (this.els.errorRetry && !this.els.errorRetry.dataset.wired) {
            this.els.errorRetry.dataset.wired = '1';
            this.els.errorRetry.addEventListener('click', function () {
                if (self.els.error) { self.els.error.hidden = true; }
                if (self.els.spinner) { self.els.spinner.hidden = false; }
                // alpha.28.1 batch 57 — also reset the SSE reconnect-
                // attempt counter so an operator who waited out a long
                // outage doesn't have to also reload the page. The
                // retry() method (batch 56) reschedules a reconnect
                // if any topics are subscribed; safe no-op otherwise.
                if (self.services && self.services.sse
                    && typeof self.services.sse.retry === 'function') {
                    try { self.services.sse.retry(); } catch (_) { /* ignore */ }
                }
                self.init();
            });
        }
        if (this.els.errorReload && !this.els.errorReload.dataset.wired) {
            this.els.errorReload.dataset.wired = '1';
            this.els.errorReload.addEventListener('click', function () {
                try { location.reload(); } catch (e) { /* iframe sandbox */ }
            });
        }
    };

    ENMApp.prototype.init = function () {
        // alpha.28.1 batch 77 (Round-22 audit finding #1, HIGH) — populate
        // this.els BEFORE _wireErrorActions runs. The previous shape called
        // _wireErrorActions() at the top of init() and only created
        // this.els below it. Constructor sets this.els = null (line 23),
        // so the very first init() did `null.errorRetry` → TypeError, and
        // the synchronous throw propagated up before the
        // unhandledrejection guard (line ~160) had been installed. Failure
        // mode: every fresh boot bricked on a permanent spinner with no
        // error pane and no Retry affordance. Retry never had a chance to
        // recover because the throw aborted init() before even
        // _showSetupWizard/_showDashboard fired. Reordering is the
        // minimal-risk fix; the constructor-default this.els = null is
        // kept so any future code path that touches this.els before init()
        // still surfaces loud rather than silently no-op'ing.
        this.els = {
            app:          document.getElementById('app'),
            spinner:      document.getElementById('enm-spinner'),
            spinnerText:  document.getElementById('enm-spinner-text'),
            error:        document.getElementById('enm-error'),
            errorTitle:   document.getElementById('enm-error-title'),
            errorDetail:  document.getElementById('enm-error-detail'),
            errorRetry:   document.getElementById('enm-error-retry'),
            errorReload:  document.getElementById('enm-error-reload'),
            content:      document.getElementById('enm-content'),
            tabs:         document.getElementById('enm-tabs'),
            // themeToggle removed in alpha.29 v2 Phase 1c — dark-only.
            settingsToggle: document.getElementById('enm-settings-toggle'),
            paneDashboard: document.getElementById('enm-pane-dashboard'),
            paneLogs:     document.getElementById('enm-pane-logs'),
            paneSettings: document.getElementById('enm-pane-settings'),
            paneAudit:    document.getElementById('enm-pane-audit'),
            paneEvm:      document.getElementById('enm-pane-evm'),
        };
        this._wireErrorActions();
        // alpha.28.1 batch 22 — defensive belt-and-braces safety net.
        // Today every async path has a terminal .catch (verified by the
        // console hygiene audit aca70d0a). A future regression — a new
        // .then() without .catch() — would surface as a silent red
        // browser warning the operator can't see. This listener
        // converts that into a polite single-shot toast so a real bug
        // gets a chance to be noticed. Idempotent flag so Retry doesn't
        // stack listeners.
        if (!root.__enmRejectionGuardInstalled) {
            root.__enmRejectionGuardInstalled = true;
            var self = this;
            root.addEventListener('unhandledrejection', function (ev) {
                var err = ev && ev.reason;
                var msg = (err && err.message) ? err.message : String(err);
                if (self.services && self.services.notifications) {
                    self.services.notifications.show({
                        id: 'enm-unhandled-rejection',
                        severity: 'warning',
                        title: 'Unexpected error',
                        body: msg,
                    });
                }
                // Don't suppress the browser's own warning; preventDefault()
                // would silence DevTools too, which we want for debugging.
            });
        }
        // alpha.28.1 batch 18 — guard against accidental file-drop
        // navigating the iframe away. Without these listeners a file
        // dropped onto the ENM iframe (e.g. operator dragging a
        // keystore JSON onto the page) is treated by the browser as
        // a navigation and the page loads `file://...`, killing the
        // dashboard. Install once at boot; idempotent flag keeps Retry
        // from stacking listeners. (Audit ac802d65 #8.)
        if (!root.__enmDropGuardInstalled) {
            root.__enmDropGuardInstalled = true;
            document.addEventListener('dragover', function (e) { e.preventDefault(); });
            document.addEventListener('drop',     function (e) { e.preventDefault(); });
        }
        // alpha.25: install responsive observer FIRST so size class is set
        // before any UI mounts. Otherwise components measure with the wrong
        // class and render at the wrong breakpoint on first paint.
        // (this.els was populated at the very top of init() in batch 77 —
        // before the responsive observer because _wireErrorActions reads
        // this.els.errorRetry / errorReload.)
        setupResponsiveObserver();

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
            // alpha.29 batch 97 — shared SR announcer. Mounted here so
            // every service / component has access without having to
            // resolve the singleton through window.enmAnnouncer (which
            // also works, but `this.services.announcer` is the explicit
            // dependency-injection-friendly path that mirrors the
            // notifications service).
            announcer:     root.enmAnnouncer || null,
            // alpha.29 batch 98 — offline + recovery banner. Subscribes
            // to navigator online/offline events; renders a banner
            // while offline; calls our refresh callback on recovery.
            onlineWatcher: root.enmOnlineWatcher || null,
        };
        // mount the announcer's hidden live regions onto document.body
        // now that body is present (this.els was populated above).
        if (this.services.announcer && typeof this.services.announcer.mount === 'function') {
            try { this.services.announcer.mount(); } catch (_) { /* ignore */ }
        }
        // mount the online watcher with our recovery refresh callback.
        // On reconnect we re-run init() — the same path the error-pane
        // Retry button uses (batch 57) — so the dashboard re-fetches
        // /health, /setup/state, and re-subscribes SSE topics.
        if (this.services.onlineWatcher && typeof this.services.onlineWatcher.mount === 'function') {
            var appSelf = this;
            try {
                this.services.onlineWatcher.mount({
                    onRetry: function () { appSelf.init(); },
                    announcer: this.services.announcer,
                });
            } catch (_) { /* ignore */ }
        }
        // 0.2.0-alpha.2 — heightSeries needs api + sse refs at construction
        // time. They're only bound after the services literal evaluates,
        // so the client is instantiated on the next statement, not inside
        // the literal. (The earlier sentinel-and-reassign approach threw
        // synchronously: the constructor asserts `api required`.)
        this.services.heightSeries = root.EnmHeightSeriesClient
            ? new root.EnmHeightSeriesClient(this.services.api, this.services.sse)
            : null;

        // beta.3.70 — mount the chain selector in the topbar. It's a
        // small dropdown that REPLACES the old static MAINNET pill +
        // duplicate brand cluster. Loads /config asynchronously to
        // detect node mode (BPoS-only vs council) and renders the
        // option list accordingly (others grayed for BPoS-only).
        // Mount is best-effort: if the element or component is
        // missing for any reason, app continues without it.
        try {
            var selectorEl = document.getElementById('enm-chain-selector');
            if (selectorEl && root.EnmChainSelector) {
                this._chainSelector = new root.EnmChainSelector({
                    root: selectorEl,
                    api: this.services.api,
                });
                this._chainSelector.mount();
            }
        } catch (err) {
            // Non-fatal — log to console so a real bug surfaces in
            // dev tools, but never block the rest of init.
            if (typeof console !== 'undefined') {
                console.warn('ENM chain selector mount failed:', err && err.message);
            }
        }

        // beta.3.89 (Wave M2.1) — install the PaneRouter listener so
        // selector key changes route to the right pane content + tab
        // visibility. Wired here at init time (not in _showDashboard)
        // because the chain selector is mounted at init and could
        // theoretically dispatch before the dashboard is up; the
        // listener internally gates on this._dashboardMounted so events
        // during the setup wizard period are dropped.
        this._initPaneRouter();

        // Step 1: window-manager IPC contract MUST happen before anything else.
        this.services.wallet.sendReady();
        this.services.wallet.installCloseHandler();

        // EnmThemeService removed in alpha.29 v2 Phase 1c — ENM is
        // dark-only now, so PC2's themeChanged broadcast is irrelevant.
        // index.html's pre-paint script hard-sets <html data-theme="dark">
        // unconditionally.

        // Step 2: resolve identity in the background (non-blocking). The
        // identity is still useful for audit attribution + the producer
        // identity card; we just don't render a wallet badge anymore (PC2's
        // launcher / system tray already shows the operator's wallet).
        // alpha.28.1 batch 83 (Round-24 finding #2, MED) — surface a
        // console.warn when /whoami resolves to null despite a token
        // being present. Previously the .then silently set
        // self.identity = null and operators had no signal that audit
        // attribution would be "unknown wallet" for the rest of the
        // session. The wallet service swallows all errors into null
        // internally so we can't .catch — we have to gate on the
        // (token-present && identity-null) combination here.
        var self = this;
        this.services.wallet.getIdentity().then(function (id) {
            self.identity = id;
            var hasToken = !!(self.services.api && self.services.api.token);
            if (!id && hasToken && root.console && console.warn) {
                console.warn(
                    'EnmApp: /whoami returned no identity despite token present; '
                    + 'audit log entries will be attributed to "unknown wallet" '
                    + 'for this session.'
                );
            }
        });

        // _wireThemeToggle removed in alpha.29 v2 Phase 1c — dark-only.
        this._wireSettingsToggle();
        // Beta 3 — wire the 4 top-level tabs (Dashboard/Logs/Settings/
        // Audit). Click switches the active tab + mirrors .enm-app
        // [data-active-tab] for the wash-gradient CSS.
        this._wireTabs();
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
                    // alpha.28.1 batch 79 (Round-22 audit finding #3) —
                    // pass the already-fetched setupState into
                    // _showSetupWizard so it doesn't re-fetch the same
                    // endpoint with skipCache:true. The previous shape
                    // burned one extra HTTP round-trip on every fresh
                    // boot landing in setup, AND introduced a half-
                    // second blank-pane window between _revealContent
                    // and _mountWelcomeScreen while the second fetch
                    // was in flight (operator saw the spinner vanish
                    // into an empty grey content area). Pass-through
                    // collapses both: no extra fetch, no blank-pane gap.
                    self._showSetupWizard(setupState);
                }
            })
            .catch(function (err) {
                self._showError(err);
            });
    };

    // _wireThemeToggle removed in alpha.29 v2 Phase 1c — dark-only
    // (the entire light/dark switching feature is gone).

    /**
     * Beta 3 — wire the 4 top-level tabs (Dashboard / Logs / Settings /
     * Audit). Click switches the active tab: updates aria-selected,
     * .active class, roving tabindex, panel visibility, and the
     * `data-active-tab` attribute on .enm-app (which CSS reads to
     * fade the page wash on dense tabs). Arrow-Left / Arrow-Right
     * provide WAI-ARIA tablist navigation between tabs.
     *
     * Idempotent — Retry re-runs init() but the dataset.wired guard
     * prevents stacked listeners.
     *
     * @private
     */
    ENMApp.prototype._wireTabs = function () {
        if (!this.els.tabs) { return; }
        if (this.els.tabs.dataset.wired === '1') { return; }
        this.els.tabs.dataset.wired = '1';
        var self = this;
        var tabBtns = Array.prototype.slice.call(
            this.els.tabs.querySelectorAll('.enm-tab[data-tab]'),
        );
        var panes = {
            dashboard: this.els.paneDashboard,
            logs:      this.els.paneLogs,
            settings:  this.els.paneSettings,
            audit:     this.els.paneAudit,
        };

        function activate(tabId) {
            tabBtns.forEach(function (b) {
                var on = (b.dataset.tab === tabId);
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
                b.setAttribute('tabindex', on ? '0' : '-1');
            });
            Object.keys(panes).forEach(function (k) {
                if (panes[k]) { panes[k].hidden = (k !== tabId); }
            });
            // Mirror onto the .enm-app container so CSS can fade the
            // wash gradient on dense tabs (settings / logs / audit).
            if (self.els.app) {
                self.els.app.setAttribute('data-active-tab', tabId);
            }
            // Beta 3 — lazy-mount each pane's component on first
            // activation. Idempotent — the per-component method's
            // own gate stops re-mounting. Pattern matches the alpha.29
            // batch 103 enmLoadScript path for audit-tab (which still
            // gets script-level lazy-load on top of this DOM mount).
            if (tabId === 'settings') { self._mountSettingsTabLazy(); }
            else if (tabId === 'logs')  { self._mountLogViewerLazy(); }
            else if (tabId === 'audit') { self._mountAuditTabLazy(); }
        }

        tabBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                activate(btn.dataset.tab);
            });
            btn.addEventListener('keydown', function (ev) {
                // WAI-ARIA tablist: ArrowRight / ArrowLeft cycle through
                // tabs. Home / End jump to first / last.
                var idx = tabBtns.indexOf(btn);
                if (idx < 0) { return; }
                var nextIdx = -1;
                if (ev.key === 'ArrowRight') { nextIdx = (idx + 1) % tabBtns.length; }
                else if (ev.key === 'ArrowLeft') { nextIdx = (idx - 1 + tabBtns.length) % tabBtns.length; }
                else if (ev.key === 'Home') { nextIdx = 0; }
                else if (ev.key === 'End')  { nextIdx = tabBtns.length - 1; }
                if (nextIdx >= 0) {
                    ev.preventDefault();
                    activate(tabBtns[nextIdx].dataset.tab);
                    tabBtns[nextIdx].focus();
                }
            });
        });
    };

    /**
     * Beta 3 — lazy-mount the EnmSettingsTab component into pane-settings
     * the first time the operator activates the Settings tab. Idempotent:
     * subsequent activations reuse the same instance. Skips silently when
     * EnmSettingsTab isn't loaded (defensive — the script tag could be
     * missing on a partial bundle).
     *
     * @private
     */
    ENMApp.prototype._mountSettingsTabLazy = function () {
        if (this._settingsTab) { return; }
        if (!this.els.paneSettings) { return; }
        if (!root.EnmSettingsTab) {
            this.els.paneSettings.innerHTML =
                '<p class="enm-stub">Settings component not loaded. '
                + 'Hard-refresh the page (Ctrl-Shift-R).</p>';
            return;
        }
        // beta.3.93 (M2.5) — pass chainId + chainClass so the settings
        // tab dispatches to the right per-class mount entry point.
        // Falls back to mainchain/A for the legacy single-chain path
        // (PaneRouter init defaults _activeChainId to 'mainchain'
        // when nothing's stored in localStorage).
        var chainId = this._activeChainId || 'mainchain';
        var CHAIN_CLASS = {
            mainchain: 'A', esc: 'B', eid: 'B', pg: 'B',
            'esc-oracle': 'C', 'eid-oracle': 'C', 'pg-oracle': 'C',
            arbiter: 'D', spv: 'E',
        };
        this._settingsTab = new root.EnmSettingsTab({
            api: this.services.api,
            notifications: this.services.notifications,
            chainId: chainId,
            chainClass: CHAIN_CLASS[chainId] || 'A',
        });
        this._settingsTab.mount(this.els.paneSettings);
    };

    /**
     * Beta 3 — lazy-mount EnmLogViewer into pane-logs on first
     * activation. beta.3.89 (M2.1): chainId now sources from
     * _activeChainId (PaneRouter), falling back to 'mainchain' for
     * the legacy single-chain path. Idempotent.
     *
     * @private
     */
    ENMApp.prototype._mountLogViewerLazy = function () {
        if (this._logViewer) { return; }
        if (!this.els.paneLogs) { return; }
        if (!root.EnmLogViewer) {
            this.els.paneLogs.innerHTML =
                '<p class="enm-stub">Log viewer component not loaded.</p>';
            return;
        }
        this._logViewer = new root.EnmLogViewer({
            api: this.services.api,
            sse: this.services.sse,
            notifications: this.services.notifications,
            chainId: this._activeChainId || 'mainchain',
        });
        this._logViewer.mount(this.els.paneLogs);
    };

    /**
     * Beta 3 — lazy-mount EnmAuditTab into pane-audit on first
     * activation. The component file itself is ALSO lazy-loaded
     * (alpha.29 batch 103) via window.ENM_LAZY_SCRIPTS.auditTab;
     * if EnmAuditTab isn't on the global yet, kick the script load
     * and re-try once it resolves. Idempotent.
     *
     * @private
     */
    ENMApp.prototype._mountAuditTabLazy = function () {
        if (this._auditTab) { return; }
        if (!this.els.paneAudit) { return; }
        var self = this;
        function mountNow() {
            if (self._auditTab) { return; }
            if (!root.EnmAuditTab) {
                self.els.paneAudit.innerHTML =
                    '<p class="enm-stub">Audit component failed to load. '
                    + 'Hard-refresh the page (Ctrl-Shift-R).</p>';
                return;
            }
            self._auditTab = new root.EnmAuditTab({
                api: self.services.api,
                notifications: self.services.notifications,
                // 0.2.0-beta.3.8 — pass the SSE service so the audit
                // tab can subscribe to `audit` topic for live row
                // prepends. Optional; absence falls back to the old
                // refresh-to-see-new-rows behaviour.
                sse: self.services.sse,
            });
            self._auditTab.mount(self.els.paneAudit);
        }
        if (root.EnmAuditTab) { mountNow(); return; }
        var src = (root.ENM_LAZY_SCRIPTS && root.ENM_LAZY_SCRIPTS.auditTab) || null;
        if (src && typeof root.enmLoadScript === 'function') {
            // Show a transient stub while the script downloads.
            self.els.paneAudit.innerHTML =
                '<p class="enm-stub">Loading audit log…</p>';
            root.enmLoadScript(src).then(function () {
                self.els.paneAudit.innerHTML = '';
                mountNow();
            }).catch(function () {
                self.els.paneAudit.innerHTML =
                    '<p class="enm-stub">Failed to load the audit log. Try again or refresh.</p>';
            });
        } else {
            mountNow();
        }
    };

    /**
     * Wire the gear icon to switch to the Settings top-level tab.
     * Beta 3 replaces the alpha.27 settings-drawer overlay with the
     * in-pane Settings tab so the gear just programmatically clicks
     * the matching tab button (which fires the regular tab activation
     * including the lazy mount).
     *
     * @private
     */
    ENMApp.prototype._wireSettingsToggle = function () {
        if (!this.els.settingsToggle) { return; }
        // Singleton guard — same reason as _wireThemeToggle above.
        if (this.els.settingsToggle.dataset.wired === '1') { return; }
        this.els.settingsToggle.dataset.wired = '1';
        var self = this;
        this.els.settingsToggle.addEventListener('click', function () {
            // Beta 3 — gear icon switches to the Settings tab (in-pane)
            // instead of opening the legacy settings-drawer overlay.
            // settings-drawer.js was dropped in BP-B per the phase-04
            // mock which has no drawer surface; all config lives in
            // the Settings tab now. The old _openSettingsDrawer path
            // remains in the codebase (commented above this method)
            // as a future hook if a slide-out variant ever returns.
            var settingsTabBtn = self.els.tabs
                && self.els.tabs.querySelector('.enm-tab[data-tab="settings"]');
            if (settingsTabBtn) {
                settingsTabBtn.click();
                settingsTabBtn.focus();
            }
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
        // alpha.28.1 batch 24 — singleton guard. Retry-driven init()
        // re-runs previously opened a SECOND BroadcastChannel; both
        // stayed subscribed to setup-complete + proposal-actioned, so
        // every cross-tab event fired N times where N = retry count.
        // (Lifecycle audit aff18c172.) Keep the previous BroadcastChannel
        // alive on retry; it's still valid.
        if (this._bc) { return; }
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
                } else if (ev.data.type === 'proposal-actioned') {
                    // alpha.28.1 batch 22 (audit ac31f3a08, scenario #4)
                    // — peer window confirmed/rejected a healing
                    // proposal first. Close our copy of the modal
                    // silently so the operator doesn't see a "Failed"
                    // toast when their click hits the already-actioned
                    // proposal. The `id` field lets the close target
                    // the right proposal when multiple are open.
                    if (self._proposalCard && self._proposalCard.proposal
                        && self._proposalCard.proposal.id === ev.data.id) {
                        try { self._proposalCard.close(); }
                        catch (_) { /* already closing */ }
                        // alpha.28.1 batch 93 (Round-30 audit finding #3)
                        // — surface a toast so the operator knows their
                        // peer tab actioned this proposal (and how).
                        // Previously the modal evaporated silently with
                        // no signal; especially bad for destructive
                        // Confirms where this tab's operator may have
                        // been leaning the opposite way. The `verdict`
                        // field has been in the BC payload (line 458)
                        // since batch 22 but was never read.
                        // alpha.28.1 batch 94 (Round-31 regression check)
                        // — route through notifications.show with a stable
                        // id so duplicate BC events (peer's close-path can
                        // emit twice if both action handler and close
                        // hook broadcast) collapse to a single toast
                        // rather than stacking. Uses the proposal id so
                        // distinct peer-actioned proposals don't dedupe
                        // each other.
                        if (self.services && self.services.notifications) {
                            var peerVerdict = (ev.data.verdict === 'confirmed')
                                ? 'Confirmed in another window'
                                : 'Rejected in another window';
                            self.services.notifications.show({
                                id: 'peer-verdict-' + ev.data.id,
                                severity: 'info',
                                title: peerVerdict,
                            });
                        }
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

    /** @private — broadcast a healing-proposal action to peer tabs */
    ENMApp.prototype._broadcastProposalActioned = function (id, verdict) {
        if (this._bc) {
            try { this._bc.postMessage({ type: 'proposal-actioned', id: id, verdict: verdict }); }
            catch (_) { /* incompatible env */ }
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
    ENMApp.prototype._showSetupWizard = function (setupState) {
        // Friendly path (v0.4): Welcome → Setup conversation → Home.
        // The 5-tab dashboard chrome is hidden until setup is done.
        // Tear down anything from the home view first (idempotent if
        // we're coming straight from boot).
        if (typeof this._teardownHomeView === 'function') { this._teardownHomeView(); }
        // beta.3.89 (M2.1) — PaneRouter gating. While the setup wizard
        // is up, chain selection has nothing to scope; drop the flag so
        // any stray enm:chain-change event (e.g. selector auto-reset
        // when /config first resolves) is a no-op until dashboard mounts.
        this._dashboardMounted = false;
        this._revealContent();
        this._clearPanes();
        if (this.els.tabs) { this.els.tabs.hidden = true; }
        // beta.0.4.2 — hide the chain selector during the setup wizard.
        // Pre-0.4.2 the selector mounted in init() and stayed visible
        // through every screen including welcome — confusing the
        // operator who saw "Multi-chain overview" as a clickable option
        // before they'd even installed mainchain. The selector belongs
        // on the dashboard, not the welcome screen.
        var selectorEl = document.getElementById('enm-chain-selector');
        if (selectorEl) { selectorEl.hidden = true; }

        // alpha.28.1 batch 79 (Round-22 finding #3) — if init() already
        // fetched /setup/state and passed us the result, branch
        // synchronously instead of firing a second fetch. The original
        // shape blindly re-fetched on every entry, which (a) doubled
        // network round-trips on every boot landing in setup, (b)
        // created a visible blank-pane gap between _revealContent and
        // _mountWelcomeScreen while the second fetch was in flight
        // (operator saw the spinner vanish into an empty grey content
        // area for 500-1500ms on a cold backend).
        // Reinstall path (the menu item that calls _showSetupWizard()
        // with no argument) still hits the network so it gets the
        // fresh post-reinstall state.
        var self = this;
        if (setupState) {
            var resumeFromArg = setupState.currentStep && setupState.currentStep !== 'welcome';
            if (resumeFromArg) {
                this._mountSetupConversation();
            } else {
                this._mountWelcomeScreen();
            }
            return;
        }

        // If the operator has clearly already started setup (binary on disk
        // or partial install), skip the welcome screen and resume in the
        // conversation. Otherwise, lead with the welcome.
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
        // beta.3.36 — welcome-screen.js internally builds an
        // EnmSetupConversation in its mount() with whatever opts we
        // pass through. Pre-beta.3.36 we only handed it { onContinue,
        // announcer }; SetupConversation's constructor then threw
        // "{ api, notifications, sse } required" because opts.api was
        // null. Operators on an existing install never saw it (they
        // skip the welcome and go straight to dashboard); fresh-install
        // operators hit it the moment they opened the app.
        //
        // Fix: hand the welcome screen the same dependencies we'd
        // hand SetupConversation directly. Welcome screen forwards
        // them to its inner SetupConversation.
        var screen = new root.EnmWelcomeScreen({
            api:           this.services.api,
            notifications: this.services.notifications,
            sse:           this.services.sse,
            announcer:     this.services.announcer,
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
        // alpha.28.1 batch 92 (Round-30 audit, MED) — store the
        // SetupConversation instance on `this` so _showDashboard can
        // call its destroy() before wiping the pane via _clearPanes.
        // The previous shape stored the instance in a local `var conv`,
        // so a cross-tab BC-driven 'setup-complete' transition in Tab B
        // (Tab A completed setup → broadcast) yanked Tab B straight to
        // _showDashboard, which did innerHTML='' on the pane without
        // ever calling SetupConversation.destroy(). The orphaned
        // instance kept its _installPollTimer + _bootstrapPollTimer +
        // _unsubscribeInstall + _unsubscribeBootstrap SSE subs alive —
        // exactly the leak pattern batches 70/83 fixed for the user-
        // driven _goto path. Storing on `this` lets _showDashboard
        // tear it down cleanly.
        this._setupConv = new root.EnmSetupConversation({
            api: this.services.api,
            notifications: this.services.notifications,
            sse: this.services.sse,
            // BP-E audit fix — inject announcer so the wizard card
            // transitions (A → B → B2 → B3 → C → D) can call
            // this.announcer.polite() per step. Without this, setup-
            // conversation.js falls back to the window.enmAnnouncer
            // singleton, but the dependency-injection contract is the
            // canonical wire and missing it trips audit-tier checks.
            announcer: this.services.announcer,
            onComplete: function () {
                self.services.api.invalidate('/setup/state');
                self._showDashboard();
                // Tell any other open ENM tabs to also flip to dashboard.
                self._broadcastSetupComplete();
            },
        });
        this._setupConv.mount(this.els.paneDashboard);
    };

    ENMApp.prototype._showDashboard = function () {
        // beta.0.4.2 — restore the chain selector when leaving setup
        // wizard for the dashboard. Pairs with _showSetupWizard's hide.
        var selectorEl = document.getElementById('enm-chain-selector');
        if (selectorEl) { selectorEl.hidden = false; }
        // 0.2.0-alpha.1 — Apple Hero phase 2: paint the page wash before
        // the technical view mounts. The gradient controller corrects
        // to the truthful bucket on the first 'enm:chain-state' event
        // (chain-card emits these in phase 6 of the rewrite).
        //
        // alpha.28.1 batch 78 (Round-22 audit finding #2) — initial
        // bucket is now 'idle' (neutral grey) instead of 'healthy'
        // (green). The 200–600ms window between dashboard mount and
        // first chain-state event was painting a green "everything OK"
        // wash to an operator who may have just opened ENM BECAUSE
        // something is broken. Neutral grey on first paint, then crossfade
        // to the truthful bucket once chain-cards report — no false-
        // positive flash, no misleading first impression on a sick fleet.
        if (this.services.fleetHealth) {
            this.services.fleetHealth.mount('idle');
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
        // batch 92 — tear down the setup conversation BEFORE _clearPanes
        // wipes its DOM. Without this the orphaned instance's poll/SSE
        // callbacks keep firing against detached DOM (Round-30 audit).
        if (this._setupConv) {
            try { this._setupConv.destroy(); } catch (_) { /* ignore */ }
            this._setupConv = null;
        }
        this._revealContent();
        this._collapseHeaderToHome();
        this._clearPanes();
        this._teardownHomeView();

        // BP-E — technical-view.js is gone. The Dashboard pane now
        // mounts the 4 components that used to live inside technical-
        // view's Status sub-tab directly: system-status strip, chain-
        // card hero, BPoS card, and tools-update card. The Logs /
        // Settings / Audit tabs that technical-view also hosted are
        // top-level Beta 3 tabs (_mountLogViewerLazy /
        // _mountSettingsTabLazy / _mountAuditTabLazy in _wireTabs).
        //
        // beta.3.89 (Wave M2.1) — Dashboard mount is now per-chain.
        // _activeChainId comes from PaneRouter (init'd above, defaults
        // to 'mainchain'). If the operator selected 'all' (Multi-chain
        // overview) before the dashboard mounted, route into overview
        // mode instead. _mountDashboardForActiveChain is the shared
        // entry point used by both the initial mount and PaneRouter
        // re-mounts triggered by selector clicks.
        var self = this;
        this._dashboardMounted = true;
        if (this._activeChainId === 'all') {
            this._enterOverviewMode();
        } else {
            this._mountDashboardForActiveChain();
        }

        // Notifications pipeline — keep CRITICAL proposal cards popping
        // on top of the dashboard.
        if (this.services.sse) {
            this._notifSub = this.services.sse.subscribe('notifications', function (payload) {
                if (!payload) { return; }
                // beta.3.56 — handle backend auto-resolve. When the
                // HealthChecker retires a pending proposal because the
                // underlying condition cleared (chain came back up,
                // RPC reachable, peers > 0, etc.), it pushes an SSE
                // notification with proposalActioned=true. Close the
                // matching modal if open and surface a friendly toast
                // explaining why. Same close-on-action contract used
                // by the cross-tab BroadcastChannel handler so the
                // modal stays consistent across all dismiss paths.
                //
                // Toast is only shown when a modal was actually open.
                // Silent backstage cleanup (proposal retired before
                // the operator ever saw it) doesn't deserve a toast —
                // would add noise when the "Auto-healed." toast from
                // F1/F2 already conveyed the recovery.
                if (payload.proposalActioned && payload.proposalId) {
                    var hadOpenModal = self._proposalCard
                        && self._proposalCard.proposal
                        && self._proposalCard.proposal.id === payload.proposalId;
                    if (hadOpenModal) {
                        try { self._proposalCard.close(); }
                        catch (_) { /* already closing */ }
                        self.services.notifications.show({
                            severity: 'info',
                            title:    payload.summary || 'Resolved',
                            body:     payload.detail  || 'Chain recovered — no action needed.',
                            id:       'auto-resolved-' + payload.proposalId,
                        });
                    }
                    return;
                }
                if (payload.proposalId) {
                    self._openProposalById(payload.proposalId);
                    return;
                }
                // alpha.28.1 batch 19 (audit ad49e60e) — stable id
                // derived from content. The previous fallback
                // 'enm-sse-' + (payload.ts || Date.now()) used a fresh
                // value on every push, so a backend retry loop emitting
                // the same alert stacked toasts. Hash severity+summary
                // to dedupe content-identical alerts in place; only
                // genuinely new content gets a new toast.
                var sseTitle = payload.summary || payload.title || 'Notification';
                var sseId = payload.proposalId
                    || ('enm-sse-' + payload.severity + ':' + sseTitle);
                self.services.notifications.show({
                    severity: mapSeverity(payload.severity),
                    title:    sseTitle,
                    body:     payload.detail  || payload.body  || '',
                    id:       sseId,
                });
            });
        }
        this._loadPendingProposals();
    };

    /**
     * beta.3.89 (Wave M2.1) — PaneRouter wiring.
     *
     * Wires the chain selector's enm:chain-change event into:
     *   1. Tab strip visibility (hidden when key='all')
     *   2. Pane mount (per-chain Dashboard for chain keys, multi-chain
     *      overview pane for 'all')
     *
     * The pre-M2.1 dashboard mounted unconditionally for mainchain and
     * the selector event was silent (zero listeners). With PaneRouter,
     * the selector becomes load-bearing: clicking "Multi-chain overview"
     * actually swaps the dashboard for an aggregate view.
     *
     * Selector ↔ PaneRouter sync:
     *   - localStorage 'enm:chain-selection' is the shared key. Selector
     *     writes; PaneRouter reads at boot for the initial activeChainId.
     *   - chain-selector.js dispatches enm:chain-change on user click AND
     *     on availability auto-reset (selector's _refreshAvailability
     *     forces back to mainchain when stored selection is invalid for
     *     this install's mode). PaneRouter listens for both.
     *
     * Idempotent — _paneRouterInstalled gate stops re-wiring on Retry.
     *
     * @private
     */
    ENMApp.prototype._initPaneRouter = function () {
        if (this._paneRouterInstalled) { return; }
        this._paneRouterInstalled = true;
        // Initial activeChainId from the selector's storage key. Falls
        // back to 'mainchain' for any unknown / missing value so the
        // dashboard always has a definite chain to mount for.
        this._activeChainId = this._loadStoredChainSelection();
        // overviewMode flag tracks whether we're rendering the multi-
        // chain aggregate pane (true) or a per-chain dashboard (false).
        // Default false; switched by _enterOverviewMode / _exitOverviewMode.
        this._overviewMode = (this._activeChainId === 'all');
        // _dashboardMounted gates the listener so events fired during
        // the setup wizard period (selector mounts at init, before the
        // dashboard exists) don't try to manipulate panes that haven't
        // been created.
        if (typeof this._dashboardMounted !== 'boolean') {
            this._dashboardMounted = false;
        }
        var self = this;
        // Listen at document level so the event bubbles from the
        // selector root (which sits in the topbar, sibling of the
        // pane container). bubbles:true is set by chain-selector.js.
        document.addEventListener('enm:chain-change', function (ev) {
            var key = (ev && ev.detail && ev.detail.key) || 'mainchain';
            if (!self._dashboardMounted) {
                // Setup wizard is up — just remember the new selection
                // so _showDashboard picks it up on transition.
                self._activeChainId = key;
                self._overviewMode = (key === 'all');
                return;
            }
            self._handleChainChange(key);
        });
    };

    /**
     * @private
     * @returns {string} one of: 'all', 'mainchain', 'esc', 'eid', 'pg',
     *                   'arbiter', 'spv'. Falls back to 'mainchain' on
     *                   missing / unknown / non-string values.
     */
    ENMApp.prototype._loadStoredChainSelection = function () {
        var VALID = { all: 1, mainchain: 1, esc: 1, eid: 1, pg: 1, arbiter: 1, spv: 1 };
        try {
            var v = root.localStorage && root.localStorage.getItem('enm:chain-selection');
            if (typeof v === 'string' && VALID[v] === 1) { return v; }
        } catch (_) { /* private-mode / storage disabled */ }
        return 'mainchain';
    };

    /**
     * Handle a chain selection change. Branches on 'all' (overview
     * mode) vs a specific chain key (per-chain dashboard mode).
     *
     * @private
     * @param {string} key — the new selector key
     */
    ENMApp.prototype._handleChainChange = function (key) {
        if (key === 'all') {
            this._activeChainId = 'all';
            this._enterOverviewMode();
            return;
        }
        // Specific chain. Exit overview mode if we were in it, then
        // re-mount the Dashboard pane for the new chain. Only re-mounts
        // when chainId actually changed — clicking the same chain twice
        // is a no-op (saves a full teardown + remount cycle).
        var prev = this._activeChainId;
        this._activeChainId = key;
        if (this._overviewMode) {
            this._exitOverviewMode();
            this._mountDashboardForActiveChain();
            return;
        }
        if (prev !== key) {
            this._remountForActiveChain();
        }
    };

    /**
     * Tear down per-chain dashboard + lazy pane mounts, then mount the
     * multi-chain overview pane. Hides the tab strip — the overview is
     * a single full-pane view, not tabbed.
     *
     * @private
     */
    ENMApp.prototype._enterOverviewMode = function () {
        this._overviewMode = true;
        // Hide tabs (overview has no Dashboard/Logs/Settings/Audit split).
        if (this.els.tabs) { this.els.tabs.hidden = true; }
        // Mirror on body for CSS hooks (M2.3 styling reads this).
        if (document.body) { document.body.dataset.enmOverview = '1'; }
        // Tear down per-chain mounts so their SSE subs + timers free.
        this._teardownHomeView();
        this._teardownLazyPanes();
        this._clearPanes();
        // The overview pane lives in paneDashboard slot (the only one
        // we keep visible). The other panes stay hidden so screen
        // readers don't announce empty regions.
        if (this.els.paneDashboard) { this.els.paneDashboard.hidden = false; }
        if (this.els.paneLogs)      { this.els.paneLogs.hidden = true; }
        if (this.els.paneSettings)  { this.els.paneSettings.hidden = true; }
        if (this.els.paneAudit)     { this.els.paneAudit.hidden = true; }
        this._mountMultiChainOverview();
    };

    /**
     * Inverse of _enterOverviewMode — restore tab strip + tear down
     * the overview pane. Does NOT mount the per-chain dashboard;
     * callers (currently only _handleChainChange) do that explicitly.
     *
     * @private
     */
    ENMApp.prototype._exitOverviewMode = function () {
        this._overviewMode = false;
        if (this.els.tabs) { this.els.tabs.hidden = false; }
        if (document.body) { document.body.dataset.enmOverview = '0'; }
        if (this._overviewPane && typeof this._overviewPane.destroy === 'function') {
            try { this._overviewPane.destroy(); } catch (_) { /* idempotent */ }
        }
        this._overviewPane = null;
        this._clearPanes();
    };

    /**
     * Tear down + re-mount the Dashboard pane for the current
     * _activeChainId. Also tears down lazy panes (Settings/Logs/Audit)
     * so they re-mount with the new chainId on their next tab activation.
     * Called when the operator switches between two specific chains
     * (e.g. mainchain → esc).
     *
     * @private
     */
    ENMApp.prototype._remountForActiveChain = function () {
        this._teardownHomeView();
        this._teardownLazyPanes();
        this._clearPanes();
        this._mountDashboardForActiveChain();
        // If a tab other than Dashboard was active, immediately re-mount
        // its lazy component so the operator doesn't see an empty pane.
        if (this.els.tabs) {
            var activeBtn = this.els.tabs.querySelector('.enm-tab.active');
            var activeTabId = activeBtn ? activeBtn.dataset.tab : 'dashboard';
            if (activeTabId === 'settings') { this._mountSettingsTabLazy(); }
            else if (activeTabId === 'logs')  { this._mountLogViewerLazy(); }
            else if (activeTabId === 'audit') { this._mountAuditTabLazy(); }
        }
    };

    /**
     * Mount the per-chain Dashboard components for _activeChainId.
     * Extracted from _showDashboard so the same shape can be re-used
     * by PaneRouter on subsequent chain switches.
     *
     * Mainchain (Class A) gets the full 5-component layout: chain-
     * card, system-status, node-identity, BPoS, tools-update. Non-
     * mainchain chains get a stub in M2.1; M3+ replaces with per-
     * class (B/C/D) dashboards. The selector's _isOptionEnabled
     * gate prevents non-mainchain selection on a real install
     * today, so the stub is only reachable via direct localStorage
     * tampering until M3 ships.
     *
     * @private
     */
    ENMApp.prototype._mountDashboardForActiveChain = function () {
        var pane = this.els.paneDashboard;
        if (!pane) { return; }
        var chainId = this._activeChainId || 'mainchain';
        // beta.3.92 (M2.4) — chainClass static lookup mirrors the
        // server-side ChainAdapter.CHAIN_ID_TO_CLASS table. Passed
        // down to chain-card (and future per-class components) so
        // they can gate class-specific sections without waiting for
        // the first /chains/<id> API roundtrip. mainchain → 'A' for
        // the only chain we actively render today; non-A chains hit
        // the stub branch below.
        var CHAIN_CLASS = {
            mainchain: 'A', esc: 'B', eid: 'B', pg: 'B',
            'esc-oracle': 'C', 'eid-oracle': 'C', 'pg-oracle': 'C',
            arbiter: 'D', spv: 'E',
        };
        var chainClass = CHAIN_CLASS[chainId] || null;
        var common = {
            api: this.services.api,
            sse: this.services.sse,
            notifications: this.services.notifications,
            chainId: chainId,
            chainClass: chainClass,
            heightSeries: this.services.heightSeries || null,
        };
        this._dashboardMounts = [];

        if (chainId !== 'mainchain') {
            // M2.1 stub. Per-class dashboards land in M3 (Class B —
            // ESC/EID/PG), M4 (Class C — Oracles), M6 (Class D —
            // Arbiter). Until then any non-mainchain selection shows
            // a "Coming soon" stub so the operator gets a clear signal
            // rather than a broken mainchain dashboard rendered for
            // the wrong chain.
            // beta.3.94 (M2.6) — labels sourced from strings.js with
            // English fallbacks. Falls back to the in-place table when
            // strings.js isn't loaded yet (very first paint).
            var labelMap = {
                esc:     'Smart Chain (ESC)',
                eid:     'Identity Chain (EID)',
                pg:      'PG Chain',
                arbiter: 'Arbiter Service',
                spv:     'SPV Module',
            };
            var t = root.enmTOrFallback;
            function _fb(key, fb, vars) {
                if (typeof t !== 'function') {
                    return vars ? fb.replace(/\{(\w+)\}/g, function (m, n) { return vars[n] || m; }) : fb;
                }
                var v = t(key, vars);
                if (!v || v === key || v === ('[' + key + ']')) {
                    return vars ? fb.replace(/\{(\w+)\}/g, function (m, n) { return vars[n] || m; }) : fb;
                }
                return v;
            }
            var displayName = _fb('chain_name.' + chainId, labelMap[chainId] || chainId);
            var titleText = _fb('pane_stub.dashboard_title', '{chainName} dashboard', { chainName: displayName });
            var bodyText = _fb('pane_stub.dashboard_body',
                'This chain is not yet wired in the operator UI. Per-class '
                + 'dashboards land in upcoming milestones (M3 — EVM sidechains, '
                + 'M4 — Oracles, M6 — Arbiter). For now, use the chain selector '
                + 'above to return to Main chain.');
            // escape minimal — these come from our own strings, but
            // defense in depth in case a future translation adds
            // markup-looking chars.
            function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
            pane.innerHTML =
                '<div class="enm-pane-stub" role="status" aria-live="polite">'
                + '<h2>' + _esc(titleText) + '</h2>'
                + '<p>' + _esc(bodyText) + '</p>'
                + '</div>';
            return;
        }

        // Class A — mainchain. Original 5-component dashboard layout.
        // 0.2.0-beta.3.4 — phase-03 mock puts the chain-card hero at
        // the TOP of the dashboard pane (the primary affordance —
        // operator looks at the power button / sync ring first), with
        // system-status BELOW. The BP-E rewrite had these reversed.
        if (root.EnmChainCard) {
            var card = new root.EnmChainCard(common);
            card.mount(pane);
            this._dashboardMounts.push(card);
        }
        if (root.EnmSystemStatus) {
            var sys = new root.EnmSystemStatus(common);
            sys.mount(pane);
            this._dashboardMounts.push(sys);
        }
        if (root.EnmNodeIdentityCard) {
            var ident = new root.EnmNodeIdentityCard(common);
            ident.mount(pane);
            this._dashboardMounts.push(ident);
        }
        if (root.EnmValidatorRegistrationCard) {
            var bpos = new root.EnmValidatorRegistrationCard(common);
            bpos.mount(pane);
            this._dashboardMounts.push(bpos);
        }
        if (root.EnmToolsUpdateCard) {
            var upd = new root.EnmToolsUpdateCard(common);
            upd.mount(pane);
            this._dashboardMounts.push(upd);
        }
    };

    /**
     * Tear down the lazy-mounted Settings / Logs / Audit panes. Called
     * by _remountForActiveChain so the next tab activation re-mounts
     * with the new chainId. Each lazy component owns its own SSE +
     * timer cleanup via destroy(); we just need to drop our handle.
     *
     * @private
     */
    ENMApp.prototype._teardownLazyPanes = function () {
        if (this._settingsTab && typeof this._settingsTab.destroy === 'function') {
            try { this._settingsTab.destroy(); } catch (_) { /* idempotent */ }
        }
        this._settingsTab = null;
        if (this._logViewer && typeof this._logViewer.destroy === 'function') {
            try { this._logViewer.destroy(); } catch (_) { /* idempotent */ }
        }
        this._logViewer = null;
        if (this._auditTab && typeof this._auditTab.destroy === 'function') {
            try { this._auditTab.destroy(); } catch (_) { /* idempotent */ }
        }
        this._auditTab = null;
    };

    /**
     * Mount the multi-chain overview pane. M2.1 ships a minimal stub
     * (placeholder copy explaining the milestone path); M2.3 replaces
     * it with EnmMultiChainOverviewPane (the real aggregate component
     * with per-chain status rows + sparklines). Picks up the real
     * component automatically once it lands — no app.js change needed.
     *
     * @private
     */
    ENMApp.prototype._mountMultiChainOverview = function () {
        var pane = this.els.paneDashboard;
        if (!pane) { return; }
        if (root.EnmMultiChainOverviewPane) {
            this._overviewPane = new root.EnmMultiChainOverviewPane({
                api: this.services.api,
                sse: this.services.sse,
                notifications: this.services.notifications,
                announcer: this.services.announcer,
                heightSeries: this.services.heightSeries || null,
            });
            this._overviewPane.mount(pane);
            return;
        }
        // M2.1 stub (rare — only reached if multi-chain-overview.js
        // failed to load). beta.3.94 (M2.6) wires the copy through
        // strings.js with the same fallback pattern as the dashboard
        // stub above.
        var t = root.enmTOrFallback;
        function _fb(key, fb) {
            if (typeof t !== 'function') { return fb; }
            var v = t(key);
            if (!v || v === key || v === ('[' + key + ']')) { return fb; }
            return v;
        }
        function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
        var stubTitle = _fb('pane_stub.overview_title', 'Multi-chain overview');
        var stubBody = _fb('pane_stub.overview_body',
            'Aggregate status for every configured chain lands in M2.3 '
            + '(MultiChainOverviewPane). Until then this pane is a placeholder '
            + 'so the chain-selector wiring (M2.1) is reachable. Use the '
            + 'selector above to switch back to Main chain.');
        pane.innerHTML =
            '<div class="enm-pane-stub" role="status" aria-live="polite">'
            + '<h2>' + _esc(stubTitle) + '</h2>'
            + '<p>' + _esc(stubBody) + '</p>'
            + '</div>';
    };

    /**
     * Destroy everything _showDashboard mounted. Called on remount and
     * when transitioning to setup so we don't leak SSE subs or intervals.
     *
     * @private
     */
    ENMApp.prototype._teardownHomeView = function () {
        // BP-E — technical-view.js retired. Beta 3 Dashboard tears
        // down its 4 directly-mounted components instead. Each one
        // owns its own SSE subs + poll timers + visibility-pausers,
        // so calling destroy() in order is sufficient. Iterate in
        // reverse so a teardown failure deep in the chain doesn't
        // strand earlier mounts.
        if (this._dashboardMounts && this._dashboardMounts.length) {
            for (var i = this._dashboardMounts.length - 1; i >= 0; i -= 1) {
                try { this._dashboardMounts[i].destroy(); }
                catch (_) { /* idempotent — keep going */ }
            }
            this._dashboardMounts = [];
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
        // Beta 3 — `this.els.tabs` (id="enm-tabs") is now the
        // `<nav class="enm-tabs">` tab strip itself (was the parent
        // header nav in alpha.27). Hiding it hides just the tab row,
        // keeping the brand + env pill + gear icon visible — the
        // correct "chrome on, tabs off" state for the welcome screen.
        // The old `.enm-header-tabs` inner-wrapper queryselector is
        // no longer needed; that element doesn't exist in the new
        // shell.
        if (!this.els.tabs) { return; }
        this.els.tabs.hidden = false;
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
        // alpha.28.1 batch 55 — short-circuit if the same proposal is
        // already on screen (live card matches id). Without this, a
        // backend retry or duplicate SSE event opened a second modal
        // on top of the first; the operator's confirm/reject hit one
        // dialog while the other lingered. (Race-conditions audit
        // aaf1f87d "sequence-number gaps" section.)
        if (this._proposalCard && this._proposalCard.proposal
            && this._proposalCard.proposal.id === id) {
            return;
        }
        this.services.api.get('/healing/suggestions', { skipCache: true }).then(function (data) {
            // Re-check under .then in case the proposal-card mounted
            // between our check above and this fetch resolving.
            if (self._proposalCard && self._proposalCard.proposal
                && self._proposalCard.proposal.id === id) {
                return;
            }
            var rec = (data && Array.isArray(data.proposals))
                ? data.proposals.find(function (p) { return p.id === id; })
                : null;
            if (rec) { self._openProposal(rec); }
        }).catch(function () {});
    };

    ENMApp.prototype._openProposal = function (p) {
        if (!root.EnmProposalCard) { return; }
        var self = this;
        // alpha.28.1 batch 22 — track the live card on `_proposalCard`
        // so the cross-tab `proposal-actioned` BC listener can match
        // by id and close it silently when a peer window actioned it
        // first (avoids the operator seeing a "Confirmation failed"
        // toast for an action that actually succeeded in the other
        // window).
        var card = new root.EnmProposalCard({
            proposal: p,
            api: this.services.api,
            notifications: this.services.notifications,
            onActioned: function (verdict) {
                self._broadcastProposalActioned(p.id, verdict);
            },
            onClose: function () {
                if (self._proposalCard === card) { self._proposalCard = null; }
            },
        });
        this._proposalCard = card;
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
            // navigator.onLine is unreliable as a TRUE signal (false
            // positives) but a RELIABLE false signal — when it's
            // false, the browser confirms no network. Use that to
            // override the "blame the backend" copy and tell the
            // operator they're offline. Saves a misleading docker-logs
            // pointer when the real problem is their wifi.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                title  = t('app.offlineTitle');
                detail = t('app.offlineHelp');
            } else {
                title  = t('app.backendUnreachable');
                detail = t('app.backendHelp') + (err.message ? ' (' + err.message + ')' : '');
            }
        } else {
            title  = t('app.generic_error');
            detail = (err && err.message) ? err.message : String(err);
        }
        this.els.errorTitle.textContent = title;
        this.els.errorDetail.textContent = detail;

        // a11y/focus: the error pane lives inside role="alert" so screen
        // readers announce the new content, but sighted keyboard users
        // need a focus indicator landing inside it. Promote the title
        // to a programmatically-focusable element and move focus there
        // so the next Tab walks into the error pane's links/buttons.
        try {
            if (this.els.errorTitle && typeof this.els.errorTitle.focus === 'function') {
                if (!this.els.errorTitle.hasAttribute('tabindex')) {
                    this.els.errorTitle.setAttribute('tabindex', '-1');
                }
                this.els.errorTitle.focus({ preventScroll: true });
            }
        } catch (e) { /* focus may fail in detached states */ }
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
