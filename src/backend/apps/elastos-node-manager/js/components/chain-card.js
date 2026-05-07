/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/chain-card.js — single chain status card.
 *
 * Apple-grade redesign (alpha.6): the visual hierarchy is
 *
 *   1. PowerCircle — the only thing the eye lands on first. Colour and
 *      animation alone say what the chain is doing. Tap = obvious action.
 *   2. Chain name + one-line state subtitle.
 *   3. ONE primary metric line — block height (or tap-to-start prompt).
 *   4. Compact action row — only the actions that make sense for the state.
 *   5. Details toggle — everything else (version, peers, uptime, sync
 *      details, BPoS stats) lives behind a single click so the resting
 *      view stays calm.
 *
 * State-machine + data-fetch logic from the previous version is preserved
 * verbatim (refresh / _refreshSync / _refreshProducer). The redesign is
 * pure presentation.
 */

(function (root) {
    'use strict';

    // String table lives in strings.js (key path `chain_state.<state>`).
    // Format helper lives in utils.js (`enmFormatUptime`). Keeping them out
    // of this file means a v0.2 i18n drop-in only touches one file.

    function ChainCard(opts) {
        if (!opts || !opts.chainId || !opts.api || !opts.notifications) {
            throw new TypeError('ChainCard: { chainId, api, notifications } required');
        }
        this.chainId = opts.chainId;
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.sse = opts.sse || null;
        this.onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : function () {};
        this.onReconfigure = typeof opts.onReconfigure === 'function' ? opts.onReconfigure : null;

        this.root = document.createElement('article');
        this.root.className = 'enm-chain-card';
        this.root.dataset.chainId = this.chainId;
        this.root.dataset.state = 'unconfigured';
        this._cooldownTimer = null;
        this._busy = false;

        this._renderShell();
    }

    ChainCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        // Subscribe to status events for this chain.
        if (this.sse) {
            var self = this;
            this._unsubscribe = this.sse.subscribe(
                'chains:' + this.chainId + ':status',
                function (payload) { self._applyState(payload); },
            );
        }
        var self = this;
        // Live-metric poll — height/peers/uptime change constantly while
        // the chain is alive; without a periodic refresh the values sit
        // stale until something jolts a state-change SSE event. 5s is a
        // good compromise between snappy UX and not hammering the RPC
        // on every chain on the dashboard. (Real-time SSE push for these
        // fields is a v0.6+ improvement — backend already polls RPC at
        // similar cadence via HealthChecker; piggybacking on that via
        // SseHub eliminates this poll entirely later.)
        this._metricsTimer = setInterval(function () { self.refresh(); }, 5_000);
        // BPoS poll — once at mount and every 60s. Cheap because /producer
        // is a single RPC; absent if the chain isn't arbiter-mode.
        this._refreshProducer();
        this._producerTimer = setInterval(function () { self._refreshProducer(); }, 60_000);
        // Sync poll — adaptive cadence. Schedules itself; the helper picks
        // 10s if state==='syncing' and 60s otherwise so the bar updates
        // smoothly while syncing without hammering /sync when healthy.
        this._refreshSync();
        return this;
    };

    ChainCard.prototype.destroy = function () {
        // Order matters: set the destroyed flag first so any in-flight
        // promise (refresh / _refreshSync / _refreshProducer) bails out
        // when it resolves instead of calling _applyState on a detached
        // DOM. Then clear all timers (no new work scheduled). Then
        // unsubscribe from SSE last — until the very end an event can
        // still arrive, but the destroyed flag in _applyState catches it.
        this._destroyed = true;
        if (this._cooldownTimer) { clearInterval(this._cooldownTimer); this._cooldownTimer = null; }
        if (this._metricsTimer) { clearInterval(this._metricsTimer); this._metricsTimer = null; }
        if (this._producerTimer) { clearInterval(this._producerTimer); this._producerTimer = null; }
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /**
     * Re-fetch the chain summary from /api/chains/:id and re-render.
     * Single-flight guarded — overlapping calls (5s metrics timer +
     * post-action refresh + SSE event) all collapse to one in-flight
     * request, so the UI doesn't render stale data from a slow earlier
     * call after a fast later one.
     */
    ChainCard.prototype.refresh = function () {
        if (this._destroyed) { return Promise.resolve(); }
        if (this._refreshInFlight) { return this._refreshInFlight; }
        var self = this;
        this._refreshInFlight = this.api.get('/chains/' + this.chainId, { skipCache: true }).then(function (state) {
            self._applyState(state);
        }).catch(function (err) {
            // Bail on late-arriving error after destroy — otherwise we'd
            // pop a "Failed to refresh" toast for a chain card that no
            // longer exists.
            if (self._destroyed) { return; }
            // 404 means not configured yet — treat as unconfigured.
            if (err && err.status === 404) {
                self._applyState({ chainId: self.chainId, state: 'unconfigured' });
                return;
            }
            self.notifications.warning(
                'Failed to refresh ' + self.chainId,
                err && err.message ? err.message : String(err),
            );
        }).then(function () {
            self._refreshInFlight = null;
        }, function () {
            self._refreshInFlight = null;
        });
        return this._refreshInFlight;
    };

    /** @private */
    ChainCard.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        var self = this;

        // 1. Hero — the PowerCircle. One tap target, animated state colour.
        var hero = document.createElement('div');
        hero.className = 'enm-chain-hero';
        this._powerCircle = new root.EnmPowerCircle({
            ariaLabel: t('chain_card.tap_circle_aria', { chainName: this.chainId }),
            onTap: function (visualState) { self._handleCircleTap(visualState); },
        });
        this._powerCircle.mount(hero);
        this.root.appendChild(hero);

        // 2. Header — chain name + one-line state subtitle.
        var header = document.createElement('header');
        header.className = 'enm-chain-card-head';

        var name = document.createElement('h3');
        name.className = 'enm-chain-card-name';
        name.textContent = this.chainId;
        header.appendChild(name);

        this._stateSubtitle = document.createElement('p');
        this._stateSubtitle.className = 'enm-chain-card-state';
        this._stateSubtitle.textContent = t('chain_state.unconfigured');
        header.appendChild(this._stateSubtitle);

        this.root.appendChild(header);

        // 3. Primary metric line — what the operator most wants to know
        // at a glance: where the chain is in the network's blockchain.
        // Different content per state (catching up vs synced vs off).
        this._primaryMetric = document.createElement('p');
        this._primaryMetric.className = 'enm-chain-card-metric';
        this.root.appendChild(this._primaryMetric);

        // 4. Action row — compact, only the actions that apply.
        var actions = document.createElement('div');
        actions.className = 'enm-chain-actions';

        this._configureBtn = makeBtn(t('chain_actions.configure'), 'enm-btn-primary', this._handleConfigure.bind(this));
        this._startBtn     = makeBtn(t('chain_actions.start'),     'enm-btn-primary',  this._handleStart.bind(this));
        this._stopBtn      = makeBtn(t('chain_actions.stop'),      'enm-btn-secondary', this._handleStop.bind(this));
        this._restartBtn   = makeBtn(t('chain_actions.restart'),   'enm-btn-secondary', this._handleRestart.bind(this));

        actions.appendChild(this._configureBtn);
        actions.appendChild(this._startBtn);
        actions.appendChild(this._stopBtn);
        actions.appendChild(this._restartBtn);
        this.root.appendChild(actions);

        // 5. Details disclosure — everything else lives here, hidden by
        // default to keep the resting view calm. Tapping the toggle (or the
        // PowerCircle when the chain is alive) opens it.
        this._detailsToggle = document.createElement('button');
        this._detailsToggle.type = 'button';
        this._detailsToggle.className = 'enm-chain-details-toggle';
        this._detailsToggle.setAttribute('aria-expanded', 'false');
        this._detailsToggle.textContent = t('chain_card.details_show');
        this._detailsToggle.addEventListener('click', this._toggleDetails.bind(this));
        this.root.appendChild(this._detailsToggle);

        this._detailsPanel = document.createElement('div');
        this._detailsPanel.className = 'enm-chain-details';
        this._detailsPanel.hidden = true;

        // Stats inside details — version, peers, uptime (height moved to
        // the primary metric above).
        this._stats = document.createElement('dl');
        this._stats.className = 'enm-chain-stats';
        this._statFields = {};
        ['version', 'peers', 'uptime'].forEach(function (k) {
            var dt = document.createElement('dt'); dt.textContent = t('chain_card.' + k);
            var dd = document.createElement('dd'); dd.textContent = '—';
            self._stats.appendChild(dt);
            self._stats.appendChild(dd);
            self._statFields[k] = dd;
        });
        this._detailsPanel.appendChild(this._stats);

        // Sync progress panel — populated by _renderSyncPanel.
        this._syncPanel = document.createElement('section');
        this._syncPanel.className = 'enm-chain-sync';
        this._syncPanel.hidden = true;
        this._syncPanel.setAttribute('role', 'status');
        this._syncPanel.setAttribute('aria-live', 'polite');
        this._detailsPanel.appendChild(this._syncPanel);

        // BPoS panel slots in here too, lazily by _refreshProducer.
        this.root.appendChild(this._detailsPanel);
    };

    /** @private */
    ChainCard.prototype._toggleDetails = function () {
        var t = root.enmTOrFallback;
        var hidden = this._detailsPanel.hidden;
        this._detailsPanel.hidden = !hidden;
        this._detailsToggle.setAttribute('aria-expanded', hidden ? 'true' : 'false');
        this._detailsToggle.textContent = hidden
            ? t('chain_card.details_hide')
            : t('chain_card.details_show');
        // Surface a class on the root so CSS can rotate the disclosure
        // chevron without juggling extra inline styles.
        this.root.classList.toggle('enm-chain-card-expanded', hidden);
    };

    /**
     * @private
     * Tap-the-circle = "do the obvious thing for this state." Off-states
     * trigger the primary action (start / configure); live-states open
     * the details panel so the operator sees the rich info.
     */
    ChainCard.prototype._handleCircleTap = function (/* visualState */) {
        var coarse = this._lastCoarseState || 'unconfigured';
        if (coarse === 'unconfigured') {
            return this._handleConfigure();
        }
        if (coarse === 'stopped' || coarse === 'error') {
            // Don't auto-start on tap-when-error — the operator should see
            // why first. Tap = open details, which surfaces the sync panel
            // and any error context. Start is reachable via the visible button.
            if (coarse === 'stopped' && !this._detailsPanel.hidden) {
                return this._handleStart();
            }
            return this._toggleDetailsIfClosed();
        }
        // Alive states (healthy / syncing / stalled / recovering) — toggle
        // the details panel so the operator can see velocity / peers / etc.
        return this._toggleDetails();
    };

    /** @private */
    ChainCard.prototype._toggleDetailsIfClosed = function () {
        if (this._detailsPanel.hidden) this._toggleDetails();
    };

    ChainCard.prototype._applyState = function (state) {
        // Bail out if torn down — late-arriving SSE events or in-flight
        // refresh promises can call us after destroy() removed our DOM.
        if (this._destroyed) { return; }
        var t = root.enmTOrFallback;
        var coarse = state && state.state ? state.state : 'unconfigured';
        this._lastCoarseState = coarse;  // drives sync-poll cadence
        this._lastBackendState = state || {};
        this.root.dataset.state = coarse;

        // Drive the PowerCircle. Fine-grained sync percent is set by
        // _renderSyncPanel — here we set the visual state from the coarse
        // backend state. Mapping:
        //   unconfigured/stopped  → off
        //   recovering            → booting
        //   syncing               → syncing  (percent supplied later)
        //   healthy               → healthy
        //   stalled               → warning
        //   error                 → error
        var visualState = COARSE_TO_VISUAL[coarse] || 'off';
        this._powerCircle.setState(visualState);

        // Subtitle line under the chain name — calm, single-word state.
        this._stateSubtitle.textContent = t('chain_state.' + coarse);
        this._stateSubtitle.dataset.state = coarse;

        // Primary metric line. Height is the most useful at-a-glance
        // metric for an alive chain; the off-state gets a contextual prompt.
        var height = (state && state.height != null) ? state.height : null;
        this._primaryMetric.textContent = formatPrimaryMetric(t, coarse, height, null);

        // Stats inside details — version, peers, uptime (height now lives
        // on the primary metric line above so it's not duplicated).
        this._statFields.version.textContent = state && state.binaryVersion ? state.binaryVersion : '—';
        this._statFields.peers.textContent   = state && state.peers         != null ? String(state.peers) : '—';
        this._statFields.uptime.textContent  = state && state.uptimeSec     != null ? root.enmFormatUptime(state.uptimeSec) : '—';

        // Button enable/disable. When unconfigured, swap the action set:
        // hide start/stop/restart and surface a Configure CTA that re-opens
        // the wizard inline (per Wave 2.4 of the v0.3 plan).
        var alive = (coarse === 'healthy' || coarse === 'syncing' || coarse === 'stalled' || coarse === 'recovering');
        var unconfigured = (coarse === 'unconfigured');
        this._configureBtn.hidden = !unconfigured || !this.onReconfigure;
        this._startBtn.hidden     = unconfigured;
        this._stopBtn.hidden      = unconfigured;
        this._restartBtn.hidden   = unconfigured;
        // Stop is disabled both when chain is dead AND when the coarse
        // state explicitly says 'stopped' — guards against the case
        // where the operator clicks Stop, the action lands, the badge
        // flips to 'stopped', but `alive` is still true for one tick.
        this._startBtn.disabled   = alive;
        this._stopBtn.disabled    = !alive || coarse === 'stopped';
        this._restartBtn.disabled = !alive;

        // Hide the Details toggle entirely while unconfigured — there's
        // nothing useful in there yet and the empty stats look broken.
        this._detailsToggle.hidden = unconfigured;
        if (unconfigured && !this._detailsPanel.hidden) {
            this._toggleDetails();
        }

        this.onStateChange(coarse, state);
    };

    // Coarse backend state → PowerCircle visual state. Kept as a flat
    // table so the mapping is reviewable at a glance.
    var COARSE_TO_VISUAL = {
        unconfigured: 'off',
        stopped:      'off',
        recovering:   'booting',
        syncing:      'syncing',
        healthy:      'healthy',
        stalled:      'warning',
        error:        'error',
        disabled:     'off',
    };

    /**
     * Build the one-line primary-metric string under the state subtitle.
     * Apple-grade: prefer one piece of human-readable info over a wall of
     * numbers. localHeight + networkHeight comes from /sync (not the bare
     * /chains/:id state) so we recompute this from _renderSyncPanel as
     * those land too.
     */
    function formatPrimaryMetric(t, coarse, height, syncSnapshot) {
        if (coarse === 'unconfigured') {
            return t('chain_card.primary_metric_unconfigured');
        }
        if (coarse === 'stopped') {
            return t('chain_card.primary_metric_off');
        }
        // Prefer the sync snapshot when it's been populated — it has the
        // network reference.
        if (syncSnapshot) {
            if (syncSnapshot.synced && syncSnapshot.localHeight != null) {
                return t('chain_card.primary_metric_synced',
                    { height: syncSnapshot.localHeight.toLocaleString() });
            }
            if (syncSnapshot.networkHeight != null && syncSnapshot.localHeight != null) {
                return t('chain_card.primary_metric_syncing', {
                    local:   syncSnapshot.localHeight.toLocaleString(),
                    network: syncSnapshot.networkHeight.toLocaleString(),
                });
            }
            if (syncSnapshot.localHeight != null) {
                return t('chain_card.primary_metric_height',
                    { height: syncSnapshot.localHeight.toLocaleString() });
            }
        }
        if (height != null) {
            return t('chain_card.primary_metric_height',
                { height: height.toLocaleString() });
        }
        return '';
    }

    /** @private */
    ChainCard.prototype._handleConfigure = function () {
        if (typeof this.onReconfigure === 'function') {
            this.onReconfigure(this.chainId);
        }
    };

    /** @private */
    ChainCard.prototype._handleStart   = function () { this._do('start',   '/chains/' + this.chainId + '/start'); };
    ChainCard.prototype._handleStop    = function () { this._do('stop',    '/chains/' + this.chainId + '/stop'); };
    ChainCard.prototype._handleRestart = function () { this._do('restart', '/chains/' + this.chainId + '/restart'); };

    /** @private */
    ChainCard.prototype._do = function (kind, path) {
        if (this._busy) { return; }
        this._busy = true;
        var t = root.enmTOrFallback;
        var btn = (kind === 'start' ? this._startBtn : (kind === 'stop' ? this._stopBtn : this._restartBtn));
        var prev = btn.textContent;
        btn.textContent = t('chain_actions.' + kind + 'ing');
        btn.disabled = true;
        var self = this;
        this.api.post(path).then(function () {
            self.notifications.info(self.chainId + ' ' + kind, '');
            return self.refresh();
        }).catch(function (err) {
            // Host-conflict 409 carries a structured `conflicts` array. Surface
            // the per-conflict description + first remediation step so the
            // operator doesn't have to dig in DevTools.
            if (err && err.body && Array.isArray(err.body.conflicts)
                && err.body.conflicts.length > 0) {
                var blockers = err.body.conflicts.filter(function (c) {
                    return c && c.severity === 'CRITICAL';
                });
                var summary = blockers.map(function (c) {
                    var firstStep = (c.remediation && c.remediation[0]) || '';
                    return '• ' + c.description + (firstStep ? ('\n   ' + firstStep) : '');
                }).join('\n');
                self.notifications.critical(
                    'Cannot ' + kind + ' ' + self.chainId + ' — host conflicts',
                    summary,
                );
            } else {
                self.notifications.warning(
                    'Failed to ' + kind + ' ' + self.chainId,
                    err && err.message ? err.message : String(err),
                );
            }
        }).then(function () {
            btn.textContent = prev;
            self._busy = false;
            self.refresh();
        });
    };

    /**
     * Adaptive sync poll. Schedules its own next tick:
     *   syncing  → every 10s (operator is watching the bar move)
     *   anything → every 60s (cheap drift check)
     * Uses setTimeout chain instead of setInterval so timer drift doesn't
     * accumulate and we can change cadence based on the latest state.
     *
     * @private
     */
    ChainCard.prototype._refreshSync = function () {
        if (this._destroyed) { return; }
        var self = this;
        this.api.get('/chains/' + this.chainId + '/sync', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            self._renderSyncPanel(data);
        }).catch(function () {
            if (self._destroyed) { return; }
            // Don't leave the panel showing stale velocity from the
            // last successful poll. Render with null data so the bar
            // and metrics line clear; the next tick will repopulate.
            self._renderSyncPanel(null);
        }).then(function () {
            if (self._destroyed) { return; }
            if (!self.root || !self.root.isConnected) { return; }
            // Always re-arm. State drives cadence: 10s while syncing,
            // 60s while healthy/stalled/stopped.
            var nextMs = (self._lastCoarseState === 'syncing') ? 10_000 : 60_000;
            self._syncTimer = setTimeout(function () { self._refreshSync(); }, nextMs);
        });
    };

    /**
     * Render the sync progress panel from a /chains/:id/sync snapshot.
     * Hides the panel when there's nothing useful to show (no localHeight).
     *
     * @private
     * @param {object|null} data
     */
    ChainCard.prototype._renderSyncPanel = function (data) {
        var t = root.enmTOrFallback;

        // Update the PowerCircle's percent + the primary metric line on
        // every sync snapshot, even when the details panel is collapsed —
        // the circle and the metric line are visible at rest.
        if (data && this._lastCoarseState === 'syncing'
            && typeof data.percent === 'number') {
            this._powerCircle.setState('syncing', { percent: data.percent });
        } else if (data && data.synced && this._lastCoarseState === 'healthy') {
            this._powerCircle.setState('healthy');
        }
        this._primaryMetric.textContent = formatPrimaryMetric(t,
            this._lastCoarseState || 'unconfigured',
            (this._lastBackendState && this._lastBackendState.height) || null,
            data);

        if (!data || data.localHeight == null) {
            this._syncPanel.hidden = true;
            return;
        }
        this._syncPanel.hidden = false;
        this._syncPanel.dataset.stale = data.stale ? '1' : '0';

        // First render: build the structure. After that, just update text.
        if (!this._syncBar) {
            var heading = document.createElement('h4');
            heading.className = 'enm-chain-sync-heading';
            heading.textContent = t('chain_card.sync_heading');
            this._syncPanel.appendChild(heading);

            var barWrap = document.createElement('div');
            barWrap.className = 'enm-chain-sync-bar-wrap';
            barWrap.setAttribute('role', 'progressbar');
            barWrap.setAttribute('aria-valuemin', '0');
            barWrap.setAttribute('aria-valuemax', '100');
            this._syncBar = document.createElement('div');
            this._syncBar.className = 'enm-chain-sync-bar';
            barWrap.appendChild(this._syncBar);
            this._syncBarWrap = barWrap;
            this._syncPanel.appendChild(barWrap);

            this._syncStatusLine = document.createElement('p');
            this._syncStatusLine.className = 'enm-chain-sync-status';
            this._syncPanel.appendChild(this._syncStatusLine);

            this._syncMetricsLine = document.createElement('p');
            this._syncMetricsLine.className = 'enm-chain-sync-metrics';
            this._syncPanel.appendChild(this._syncMetricsLine);

            // First-sync expectation hint. Operators panic when they see
            // a near-empty progress bar with no time horizon — the
            // mainchain takes 1-3 days to sync from genesis on typical
            // hardware. Show this whenever the chain is alive but not yet
            // synced; hide once synced.
            this._syncHintLine = document.createElement('p');
            this._syncHintLine.className = 'enm-chain-sync-hint';
            this._syncPanel.appendChild(this._syncHintLine);
        }

        // Bar fill + ARIA.
        var pct = (typeof data.percent === 'number') ? data.percent : null;
        if (pct == null) {
            // No network reference yet — render an "indeterminate" stripe.
            this._syncBar.style.width = '100%';
            this._syncBarWrap.classList.add('enm-chain-sync-indeterminate');
            this._syncBarWrap.removeAttribute('aria-valuenow');
        } else {
            this._syncBar.style.width = pct.toFixed(2) + '%';
            this._syncBarWrap.classList.remove('enm-chain-sync-indeterminate');
            this._syncBarWrap.setAttribute('aria-valuenow', String(Math.floor(pct)));
        }
        this._syncBar.dataset.pct = pct == null ? '?' : Math.floor(pct);

        // Status line — five distinct states drive what the operator sees.
        // The backend's enriched /sync response (Wave 6 follow-up) gives us
        // the truthful signals we need:
        //
        //   data.synced        — latest local block within ~5 min of now,
        //                        OR blocksBehind === 0
        //   data.networkHeight — max of peers' reported tip heights
        //   data.peers         — connected peer count
        //   data.uptimeSec     — chain uptime, used for the just-started banner
        //   data.alive         — whether the process is running at all
        var alive = !!data.alive
            || this._lastCoarseState === 'healthy' || this._lastCoarseState === 'syncing'
            || this._lastCoarseState === 'starting' || this._lastCoarseState === 'recovering';
        var freshStart = alive
            && typeof data.uptimeSec === 'number' && data.uptimeSec < 60
            && !data.synced;

        if (!alive || data.stale) {
            this._syncStatusLine.textContent = t('chain_card.sync_stale');
        } else if (data.synced) {
            // Most common steady-state case — we're caught up.
            this._syncStatusLine.textContent = '✓ Fully synced';
        } else if (freshStart) {
            // Just-started chain. Peers handshake takes ~30s; networkHeight
            // is null until then. Don't blame the operator for the wait.
            this._syncStatusLine.textContent =
                'Just started — connecting to peers (this takes about a minute)';
        } else if (data.peers === 0) {
            // Genuinely no peers — operator's network or NAT may be the issue.
            this._syncStatusLine.textContent = 'Looking for peers…';
        } else if (data.networkHeight != null && data.blocksBehind != null) {
            // We have a real reference. Show "N blocks behind".
            this._syncStatusLine.textContent =
                'Catching up — ' + data.blocksBehind.toLocaleString() + ' blocks behind';
        } else if (data.localHeight != null) {
            // Peers connected but their heights aren't in yet. Show what we know.
            this._syncStatusLine.textContent =
                'Catching up — local height ' + data.localHeight.toLocaleString();
        } else {
            this._syncStatusLine.textContent = 'Catching up…';
        }

        // Metrics line — velocity + ETA. Only when we have a real
        // reference AND the chain is alive AND not already synced.
        var parts = [];
        if (alive && !data.synced && typeof data.velocityBpm === 'number' && data.velocityBpm > 0) {
            parts.push(t('chain_card.sync_velocity', {
                bpm: data.velocityBpm.toFixed(1),
            }));
        } else if (alive && !data.synced && data.localHeight != null && data.blocksBehind != null && data.blocksBehind > 0) {
            parts.push(t('chain_card.sync_no_velocity'));
        }
        if (typeof data.etaSec === 'number' && data.etaSec > 0) {
            parts.push(t(
                data.etaSec < 60 ? 'chain_card.sync_eta_lt_min' : 'chain_card.sync_eta',
                { eta: root.enmFormatUptime(data.etaSec) },
            ));
        }
        this._syncMetricsLine.textContent = parts.join(' • ');

        // Expectation hint — show during ANY syncing state (no peers,
        // catching up, fresh-start), hide when synced or stale. Without
        // this, a multi-day sync looks broken.
        if (alive && !data.synced && !data.stale) {
            this._syncHintLine.textContent =
                'First sync usually takes 1–3 days depending on your hardware. ' +
                'Leave it running — it picks up where it left off if it stops.';
            this._syncHintLine.hidden = false;
        } else {
            this._syncHintLine.hidden = true;
            this._syncHintLine.textContent = '';
        }
    };

    /**
     * Fetch /chains/:id/producer and either show the BPoS sub-panel or hide it.
     * Errors stay silent — the operator hasn't necessarily started the chain.
     *
     * @private
     */
    ChainCard.prototype._refreshProducer = function () {
        if (this._destroyed) { return; }
        var self = this;
        this.api.get('/chains/' + this.chainId + '/producer', { skipCache: true }).then(function (data) {
            // Guard against late-arriving response — destroy() may have run
            // between the api.get call and its resolution.
            if (self._destroyed) { return; }
            if (!data || !data.enabled) {
                if (self._bposPanel) { self._bposPanel.hidden = true; }
                return;
            }
            self._renderBposPanel(data);
        }).catch(function () { /* ignore — chain may be stopped or non-BPoS */ });
    };

    /** @private */
    ChainCard.prototype._renderBposPanel = function (data) {
        var t = root.enmTOrFallback;
        if (!this._bposPanel) {
            this._bposPanel = document.createElement('section');
            this._bposPanel.className = 'enm-chain-bpos';
            var heading = document.createElement('h4');
            heading.className = 'enm-chain-bpos-heading';
            heading.textContent = t('chain_card.bpos_heading');
            this._bposPanel.appendChild(heading);

            this._bposStats = document.createElement('dl');
            this._bposStats.className = 'enm-chain-bpos-stats';
            this._bposFields = {};
            ['bpos_state', 'bpos_votes', 'bpos_rank', 'bpos_inactive_rounds'].forEach(function (k) {
                var dt = document.createElement('dt'); dt.textContent = t('chain_card.' + k);
                var dd = document.createElement('dd'); dd.textContent = '—';
                this._bposStats.appendChild(dt);
                this._bposStats.appendChild(dd);
                this._bposFields[k] = dd;
            }, this);
            this._bposPanel.appendChild(this._bposStats);
            // Goes inside Details so the resting view stays calm. Operator
            // who cares about producer rank / votes opens the disclosure.
            this._detailsPanel.appendChild(this._bposPanel);
        }
        this._bposPanel.hidden = false;
        this._bposFields.bpos_state.textContent = data.state || '—';
        this._bposFields.bpos_state.dataset.state = data.state || '';
        this._bposFields.bpos_votes.textContent = (data.votes != null ? String(data.votes) : '—');
        this._bposFields.bpos_rank.textContent = (data.rank != null ? '#' + (data.rank + 1) : '—');
        var rounds = data.inactiveRounds;
        var roundsLabel;
        if (rounds == null) {
            roundsLabel = '—';
        } else if (rounds <= 0) {
            roundsLabel = '0';
        } else {
            roundsLabel = String(rounds) + ' / 1440';
        }
        this._bposFields.bpos_inactive_rounds.textContent = roundsLabel;
        this._bposFields.bpos_inactive_rounds.dataset.severity =
            (rounds != null && rounds > 1300) ? 'critical'
          : (rounds != null && rounds > 720)  ? 'warning'
          : 'ok';
    };

    function makeBtn(label, className, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-btn ' + className;
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    root.EnmChainCard = ChainCard;
}(typeof window !== 'undefined' ? window : globalThis));
