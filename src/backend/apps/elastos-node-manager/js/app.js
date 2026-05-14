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
        this._settingsTab = new root.EnmSettingsTab({
            api: this.services.api,
            notifications: this.services.notifications,
        });
        this._settingsTab.mount(this.els.paneSettings);
    };

    /**
     * Beta 3 — lazy-mount EnmLogViewer into pane-logs on first
     * activation. Mainchain only for Beta 3 (chain selector pill
     * present but inactive). Idempotent.
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
            chainId: 'mainchain',
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
        this._revealContent();
        this._clearPanes();
        if (this.els.tabs) { this.els.tabs.hidden = true; }

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
        var screen = new root.EnmWelcomeScreen({
            onContinue: function () { self._mountSetupConversation(); },
            // BP-E audit fix — inject announcer so welcome-screen.js can
            // call this.announcer.polite() on transitions instead of
            // silently no-oping past the constructor-time null. The
            // singleton window.enmAnnouncer is the fallback path, but
            // the dependency-injection contract is the canonical wire.
            announcer: this.services.announcer,
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
        var self = this;
        var pane = this.els.paneDashboard;
        var common = {
            api: this.services.api,
            sse: this.services.sse,
            notifications: this.services.notifications,
            chainId: 'mainchain',
            // chain-card + height-series wire-up (BP-A invariant).
            heightSeries: this.services.heightSeries || null,
        };

        this._dashboardMounts = [];
        if (root.EnmSystemStatus) {
            var sys = new root.EnmSystemStatus(common);
            sys.mount(pane);
            this._dashboardMounts.push(sys);
        }
        if (root.EnmChainCard) {
            var card = new root.EnmChainCard(common);
            card.mount(pane);
            this._dashboardMounts.push(card);
        }
        // BPoS card — hides itself when the operator is fully active
        // on chain (STATE_HIDE in validator-registration-card.js). The
        // backward-compat alias EnmValidatorRegistrationCard still
        // resolves to BposCard.
        if (root.EnmValidatorRegistrationCard) {
            var bpos = new root.EnmValidatorRegistrationCard(common);
            bpos.mount(pane);
            this._dashboardMounts.push(bpos);
        }
        // Tools update card — hides itself when on the latest release.
        if (root.EnmToolsUpdateCard) {
            var upd = new root.EnmToolsUpdateCard(common);
            upd.mount(pane);
            this._dashboardMounts.push(upd);
        }

        // Notifications pipeline — keep CRITICAL proposal cards popping
        // on top of the dashboard.
        if (this.services.sse) {
            this._notifSub = this.services.sse.subscribe('notifications', function (payload) {
                if (!payload) { return; }
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
