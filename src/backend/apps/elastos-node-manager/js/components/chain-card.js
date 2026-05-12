/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/chain-card.js — single-chain status card. (0.2.0-alpha.1)
 *
 * Apple Hero rewrite. The visual hierarchy is:
 *
 *   1. PowerCircle hero — 220px Apple Activity Ring (state colour +
 *      sync percent + sonar-ping breath when healthy).
 *   2. Chain name (h3) + state subtitle (Active / Catching up / etc.).
 *   3. Primary metric — block height number stacked above a small label.
 *   4. Sparkline of last-hour block-height growth (hides when no data).
 *   5. Stats strip — peers / version / uptime, value-on-top hierarchy.
 *   6. Action row — Start / Stop / Restart / Configure (state-gated).
 *
 * What changed from alpha.18:
 *   - The Details disclosure is GONE. The sync panel and BPoS panel
 *     no longer live in the card. Sync info is communicated by the
 *     PowerCircle's filled ring + percent and the X / Y primary metric;
 *     BPoS info moves to the Identity sub-tab.
 *   - The card mounts an EnmSparkline subscribed via heightSeries.
 *   - On every state change the card dispatches 'enm:chain-state' on
 *     window so EnmFleetHealthGradient can recompute the wash hue.
 *
 * The polling cadence (refresh every 5s, sync poll adaptive, producer
 * poll every 60s when relevant) is preserved verbatim — the visual
 * surface changed, not the data layer.
 */

(function (root) {
    'use strict';

    // Coarse backend state → PowerCircle visual state. Same table as
    // alpha.18; one-shot lookup so the mapping stays reviewable.
    var COARSE_TO_VISUAL = {
        unconfigured: 'off',
        stopped:      'off',
        recovering:   'booting',
        starting:     'booting',
        syncing:      'syncing',
        healthy:      'healthy',
        stalled:      'warning',
        error:        'error',
        disabled:     'off',
    };

    function ChainCard(opts) {
        if (!opts || !opts.chainId || !opts.api || !opts.notifications) {
            throw new TypeError('ChainCard: { chainId, api, notifications } required');
        }
        this.chainId = opts.chainId;
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.sse = opts.sse || null;
        // 0.2.0-alpha.1 — height-series client backs the sparkline. When
        // absent (test rigs, defensive boot) the sparkline simply never
        // shows; the rest of the card still works.
        this.heightSeries = opts.heightSeries || null;
        this.onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : function () {};
        this.onReconfigure = typeof opts.onReconfigure === 'function' ? opts.onReconfigure : null;

        this.root = document.createElement('article');
        this.root.className = 'enm-chain-card';
        this.root.dataset.chainId = this.chainId;
        this.root.dataset.state = 'unconfigured';
        this._busy = false;

        this._renderShell();
    }

    ChainCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        var self = this;
        if (this.sse) {
            this._unsubscribe = this.sse.subscribe(
                'chains:' + this.chainId + ':status',
                function (payload) { self._applyState(payload); },
            );
            // 0.2.0-alpha.1 — SSE state listener. Toggles the
            // reconnecting pill + sets data-sse-state on the card
            // root so CSS can pause the breath / dim the ring when
            // we've lost the supervisor channel.
            if (typeof this.sse.onState === 'function') {
                this._unsubSse = this.sse.onState(function (sseState) {
                    if (self._destroyed) return;
                    self._applySseState(sseState);
                });
            }
        }
        // Live-metric poll — height/peers/uptime move constantly while
        // the chain is alive. 5s matches alpha.18; backend can absorb it
        // and the dashboard feels live.
        this._metricsTimer = setInterval(function () { self.refresh(); }, 5_000);
        // Sync poll — adaptive cadence. Drives the PowerCircle percent
        // and the primary-metric "X / Y" line.
        this._refreshSync();
        // 0.2.0-alpha.7 — DPoS rotation poll (improvement #02). 60s
        // cadence; rotation only changes on round boundaries so no need
        // to hammer the RPC faster than that.
        this._refreshRotation();
        this._rotationTimer = setInterval(function () { self._refreshRotation(); }, 60_000);
        // Height-series sparkline. Subscribe once on mount; the service
        // bootstraps with a GET /history then layers SSE deltas on top.
        if (this.heightSeries) {
            this._unsubHeight = this.heightSeries.subscribe(this.chainId, function (points) {
                if (self._destroyed) return;
                if (self._sparkline) self._sparkline.setSeries(points);
            });
        }
        return this;
    };

    ChainCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._metricsTimer)    { clearInterval(this._metricsTimer);    this._metricsTimer = null; }
        if (this._uptimeTickTimer) { clearInterval(this._uptimeTickTimer); this._uptimeTickTimer = null; }
        if (this._rotationTimer)   { clearInterval(this._rotationTimer);   this._rotationTimer = null; }
        if (this._syncTimer)       { clearTimeout(this._syncTimer);        this._syncTimer = null; }
        if (this._unsubscribe)     { this._unsubscribe(); this._unsubscribe = null; }
        if (this._unsubSse)        { this._unsubSse();    this._unsubSse = null; }
        if (this._unsubHeight)     { this._unsubHeight(); this._unsubHeight = null; }
        if (this._sparkline)       { this._sparkline.destroy(); this._sparkline = null; }
        // 0.2.0-alpha.1 — tell FleetHealthGradient we're going away so it
        // can drop this chain from its aggregate. Without this, a remount
        // would double-count.
        try {
            root.dispatchEvent(new root.CustomEvent('enm:chain-state', {
                detail: { chainId: this.chainId, removed: true },
            }));
        } catch (_) { /* old browsers without CustomEvent — skip */ }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /**
     * Re-fetch /chains/:id and re-render. Single-flight guarded so the
     * 5s timer, post-action refreshes, and SSE events collapse to one
     * in-flight request.
     */
    ChainCard.prototype.refresh = function () {
        if (this._destroyed) { return Promise.resolve(); }
        if (this._refreshInFlight) { return this._refreshInFlight; }
        var self = this;
        this._refreshInFlight = this.api.get('/chains/' + this.chainId, { skipCache: true }).then(function (state) {
            self._applyState(state);
        }).catch(function (err) {
            if (self._destroyed) { return; }
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

        // 1. Hero — the PowerCircle. Apple Activity Ring at 220px.
        var hero = document.createElement('div');
        hero.className = 'enm-chain-hero';
        this._powerCircle = new root.EnmPowerCircle({
            ariaLabel: t('chain_card.tap_circle_aria', { chainName: this.chainId }),
            onTap: function () { self._handleCircleTap(); },
        });
        this._powerCircle.mount(hero);
        this.root.appendChild(hero);

        // 2. Name + state subtitle.
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

        // 0.2.0-alpha.1 — SSE-disconnect indicator pill. The breath
        // animation says "alive"; when SSE drops we'd be lying. This
        // pill appears under the state subtitle while the connection
        // is reconnecting / closed, and the CSS also pauses the breath
        // via the [data-sse-state] attribute on the card root.
        this._reconnectPill = document.createElement('span');
        this._reconnectPill.className = 'enm-chain-reconnect';
        this._reconnectPill.textContent = t('chain_card.sse_reconnecting') || 'Reconnecting…';
        this._reconnectPill.hidden = true;
        header.appendChild(this._reconnectPill);

        this.root.appendChild(header);

        // 3. Primary metric — block height number stacked over a small
        // lowercase label. Mock pattern: large mono digits speak first,
        // the label sits underneath as a caption.
        var primaryWrap = document.createElement('div');
        primaryWrap.className = 'enm-chain-primary';
        this._primaryMetric = document.createElement('span');
        this._primaryMetric.className = 'enm-chain-primary-value';
        primaryWrap.appendChild(this._primaryMetric);
        this._primaryLabel = document.createElement('span');
        this._primaryLabel.className = 'enm-chain-primary-label';
        this._primaryLabel.textContent = t('chain_card.primary_label_height');
        primaryWrap.appendChild(this._primaryLabel);
        this.root.appendChild(primaryWrap);

        // 4. Sparkline — last-hour block-height growth. Mounts once;
        // setSeries fires whenever the height-series client emits.
        if (root.EnmSparkline) {
            this._sparkline = new root.EnmSparkline({
                color: 'var(--state-healthy)',
                ariaLabel: t('chain_card.sparkline_aria') || 'Block height, last hour',
            });
            this._sparkline.mount(this.root);
        }

        // 0.2.0-alpha.7 — DPoS rotation strip (improvement #02). Shows the
        // operator's slot in the current BPoS arbiter slate + whether
        // their key is on duty right now. Polled separately (60s cadence
        // — rotation only flips on round boundaries, no need to poll
        // faster than that). Hidden when chain is not alive OR not
        // registered.
        this._rotationStrip = document.createElement('div');
        this._rotationStrip.className = 'enm-chain-rotation';
        this._rotationStrip.hidden = true;
        this.root.appendChild(this._rotationStrip);

        // 5. Stats strip — peers / version / uptime. Mirrors the
        // system-status hierarchy (value-on-top + tiny label below).
        this._statsStrip = document.createElement('div');
        this._statsStrip.className = 'enm-chain-stats-strip';
        this._statFields = {};
        ['peers', 'version', 'uptime'].forEach(function (k) {
            var cell = document.createElement('div');
            cell.className = 'enm-chain-stats-cell enm-chain-stats-' + k;
            var value = document.createElement('span');
            value.className = 'enm-chain-stats-value';
            value.textContent = '—';
            cell.appendChild(value);
            var label = document.createElement('span');
            label.className = 'enm-chain-stats-label';
            label.textContent = t('chain_card.' + k);
            cell.appendChild(label);
            self._statsStrip.appendChild(cell);
            self._statFields[k] = value;
        });
        this.root.appendChild(this._statsStrip);

        // 6. Action row.
        var actions = document.createElement('div');
        actions.className = 'enm-chain-actions';
        this._configureBtn = makeBtn(t('chain_actions.configure'), 'enm-btn-primary',   this._handleConfigure.bind(this));
        this._startBtn     = makeBtn(t('chain_actions.start'),     'enm-btn-primary',   this._handleStart.bind(this));
        this._stopBtn      = makeBtn(t('chain_actions.stop'),      'enm-btn-secondary', this._handleStop.bind(this));
        this._restartBtn   = makeBtn(t('chain_actions.restart'),   'enm-btn-secondary', this._handleRestart.bind(this));
        actions.appendChild(this._configureBtn);
        actions.appendChild(this._startBtn);
        actions.appendChild(this._stopBtn);
        actions.appendChild(this._restartBtn);
        this.root.appendChild(actions);
    };

    /**
     * @private
     * Tap-the-circle on the Apple Hero card is a "do the obvious thing"
     * affordance. No more disclosure to toggle since details are gone.
     *
     *   unconfigured     → open Configure wizard
     *   stopped / error  → pulse the action row so eye lands on Start
     *   alive            → pulse the action row (Stop / Restart visible)
     */
    ChainCard.prototype._handleCircleTap = function () {
        var coarse = this._lastCoarseState || 'unconfigured';
        if (coarse === 'unconfigured') {
            return this._handleConfigure();
        }
        return this._pulseActionRow();
    };

    /**
     * @private
     * Brief animation on the action row so the operator's eye lands on
     * the visible buttons. Inherited from alpha.18 — the keyframe lives
     * in styles.css. One-shot setTimeout so back-to-back taps re-fire.
     */
    ChainCard.prototype._pulseActionRow = function () {
        var row = this.root.querySelector('.enm-chain-actions');
        if (!row) return;
        row.classList.remove('enm-chain-actions-pulse');
        // eslint-disable-next-line no-unused-expressions
        row.offsetWidth;
        row.classList.add('enm-chain-actions-pulse');
        setTimeout(function () {
            row.classList.remove('enm-chain-actions-pulse');
        }, 700);
    };

    ChainCard.prototype._applyState = function (state) {
        if (this._destroyed) { return; }
        var t = root.enmTOrFallback;
        var coarse = (state && state.state) ? state.state : 'unconfigured';
        this._lastCoarseState = coarse;
        this._lastBackendState = state || {};
        this.root.dataset.state = coarse;

        // PowerCircle visual state. Percent (for syncing) lands later
        // from /chains/:id/sync via _refreshSync; the coarse state goes
        // on the ring first so the colour flips immediately.
        var visualState = COARSE_TO_VISUAL[coarse] || 'off';
        this._powerCircle.setState(visualState);

        // 0.2.0-alpha.1 — Sparkline colour tracks the visual state so the
        // line + fill paint in the same hue as the ring. Stopped chains
        // keep their last-known sparkline but in a dimmed neutral.
        if (this._sparkline) {
            var sparkColor = (coarse === 'healthy') ? 'var(--state-healthy)'
                : (coarse === 'syncing' || coarse === 'recovering' || coarse === 'starting')
                    ? 'var(--state-syncing)'
                : (coarse === 'stalled') ? 'var(--state-stalled)'
                : (coarse === 'error')   ? 'var(--state-error)'
                : 'var(--text-muted)';
            this._sparkline.setColor(sparkColor);
        }

        // State subtitle. Producer state wins over coarse state when the
        // chain is alive AND we've fetched a producer record (alpha.15).
        // /chains/:id may include `producerState` inline since alpha.15.
        var producerState = state && state.producerState;
        if (producerState && (coarse === 'healthy' || coarse === 'syncing' || coarse === 'stalled')) {
            this._stateSubtitle.textContent = producerState;
            this._stateSubtitle.dataset.state = coarse + '-producer-' + String(producerState).toLowerCase();
        } else {
            this._stateSubtitle.textContent = t('chain_state.' + coarse);
            this._stateSubtitle.dataset.state = coarse;
        }

        // Primary metric — block height number alone. The "/ network"
        // suffix (when syncing) lands from /sync via _refreshSync.
        var height = (state && state.height != null) ? state.height : null;
        this._primaryMetric.textContent = formatPrimaryValue(t, coarse, height, null);
        this._primaryLabel.textContent = formatPrimaryLabel(t, coarse, height, null);

        // Stats strip.
        this._statFields.peers.textContent   = state && state.peers         != null ? String(state.peers) : '—';
        // 0.2.0-alpha.7 — peer quality hover (improvement #12). Backend
        // populates `peerSummary` from getnodestate.neighbors; surface as
        // a title on the peers cell so a hover shows the breakdown the
        // operator cares about (latency / version distribution / clock
        // skew) without taking more space in the resting card.
        var peersCell = this._statFields.peers && this._statFields.peers.parentNode;
        if (peersCell) {
            var ps = state && state.peerSummary;
            if (ps && (ps.latencyMsAvg != null || (ps.versions && ps.versions.length) || ps.timeOffsetMaxAbsMs != null)) {
                var lines = [];
                if (ps.latencyMsAvg != null) lines.push('Avg ping: ' + ps.latencyMsAvg + ' ms');
                if (ps.versions && ps.versions.length) {
                    lines.push('Versions: ' + ps.versions.map(function (v) {
                        return v.version + ' ×' + v.count;
                    }).join(', '));
                }
                if (ps.timeOffsetMaxAbsMs != null) {
                    lines.push('Max clock skew: ±' + ps.timeOffsetMaxAbsMs + ' ms');
                }
                peersCell.title = lines.join('\n');
            } else {
                peersCell.title = '';
            }
        }
        this._statFields.version.textContent = state && state.binaryVersion ? state.binaryVersion : '—';
        // 0.2.0-alpha.5 — uptime gets a local 1-second tick instead of
        // riding the 5s refresh poll. We anchor _uptimeBaseMs to
        // (now - uptimeSec) every time the backend reports a number,
        // then the local interval recomputes the displayed value off
        // Date.now() each second. Effect: smooth 37s → 38s → 39s
        // counter instead of jumps from 37s → 42s every poll.
        if (state && state.uptimeSec != null) {
            this._uptimeBaseMs = Date.now() - state.uptimeSec * 1000;
            this._statFields.uptime.textContent = root.enmFormatUptime(state.uptimeSec);
            if (!this._uptimeTickTimer) {
                var card = this;
                this._uptimeTickTimer = setInterval(function () {
                    if (card._destroyed || card._uptimeBaseMs == null) return;
                    var elapsedSec = Math.floor((Date.now() - card._uptimeBaseMs) / 1000);
                    card._statFields.uptime.textContent = root.enmFormatUptime(elapsedSec);
                }, 1_000);
            }
        } else {
            this._uptimeBaseMs = null;
            this._statFields.uptime.textContent = '—';
            if (this._uptimeTickTimer) {
                clearInterval(this._uptimeTickTimer);
                this._uptimeTickTimer = null;
            }
        }

        // Action row enable/disable.
        var alive = (coarse === 'healthy' || coarse === 'syncing' || coarse === 'stalled' || coarse === 'recovering' || coarse === 'starting');
        var unconfigured = (coarse === 'unconfigured');
        this._configureBtn.hidden = !unconfigured || !this.onReconfigure;
        this._startBtn.hidden     = unconfigured;
        this._stopBtn.hidden      = unconfigured;
        this._restartBtn.hidden   = unconfigured;
        this._startBtn.disabled   = alive;
        this._stopBtn.disabled    = !alive || coarse === 'stopped';
        this._restartBtn.disabled = !alive;

        // 0.2.0-alpha.1 — notify FleetHealthGradient. CustomEvent on
        // window so the controller can subscribe once and aggregate
        // without dependency injection through technical-view / app.js.
        try {
            root.dispatchEvent(new root.CustomEvent('enm:chain-state', {
                detail: { chainId: this.chainId, coarseState: coarse },
            }));
        } catch (_) { /* old browsers without CustomEvent — skip */ }

        this.onStateChange(coarse, state);
    };

    // 0.2.0-alpha.4 — treat-as-synced threshold. When a new block lands
    // upstream the network heads forward by 1 before we've fetched it,
    // briefly putting us "1 block behind" — the formatter used to flip
    // the primary metric to "X / X+1" for one polling tick and then
    // back to "X+1" once we caught up. Reads as flicker. Anything ≤
    // this many blocks behind is treated as caught-up for the display.
    var TREAT_AS_SYNCED_THRESHOLD = 2;

    /**
     * Build the big block-height number under the state subtitle. When
     * a /sync snapshot is in flight, _refreshSync overrides this with
     * "local / network" (e.g. "943,210 / 1,123,455"). The local-only
     * variant wins when blocksBehind ≤ TREAT_AS_SYNCED_THRESHOLD even
     * if the backend's synced flag is false, so the steady-state
     * dashboard doesn't flicker on every block.
     */
    function formatPrimaryValue(t, coarse, height, syncSnapshot) {
        if (coarse === 'unconfigured') {
            return t('chain_card.primary_metric_unconfigured');
        }
        if (coarse === 'stopped') {
            return t('chain_card.primary_metric_off');
        }
        if (syncSnapshot) {
            var basicallySynced = syncSnapshot.synced
                || (typeof syncSnapshot.blocksBehind === 'number'
                    && syncSnapshot.blocksBehind <= TREAT_AS_SYNCED_THRESHOLD);
            if (basicallySynced && syncSnapshot.localHeight != null) {
                return syncSnapshot.localHeight.toLocaleString();
            }
            if (syncSnapshot.networkHeight != null && syncSnapshot.localHeight != null) {
                return syncSnapshot.localHeight.toLocaleString()
                    + ' / ' + syncSnapshot.networkHeight.toLocaleString();
            }
            if (syncSnapshot.localHeight != null) {
                return syncSnapshot.localHeight.toLocaleString();
            }
        }
        if (height != null) return height.toLocaleString();
        return '—';
    }

    /**
     * Lowercase caption under the big number. Apple Hero pattern.
     *
     * 0.2.0-alpha.4 — when the chain is alive but we don't have a
     * block height yet (cold start, ~30-60s before peer handshake
     * completes), the value is an em-dash and the caption swaps to
     * "connecting to peers" so the operator knows the empty state is
     * intentional + ~about a minute.
     */
    function formatPrimaryLabel(t, coarse, height, syncSnapshot) {
        if (coarse === 'unconfigured') return t('chain_card.primary_label_unconfigured');
        if (coarse === 'stopped')      return t('chain_card.primary_label_off');
        var haveHeight = (height != null)
            || (syncSnapshot && syncSnapshot.localHeight != null);
        if (!haveHeight) return t('chain_card.primary_label_connecting');
        return t('chain_card.primary_label_height');
    }

    /** @private */
    ChainCard.prototype._handleConfigure = function () {
        if (typeof this.onReconfigure === 'function') this.onReconfigure(this.chainId);
    };

    /** @private */
    ChainCard.prototype._handleStart   = function () { this._do('start',   '/chains/' + this.chainId + '/start'); };
    ChainCard.prototype._handleStop    = function () { this._do('stop',    '/chains/' + this.chainId + '/stop'); };
    ChainCard.prototype._handleRestart = function () { this._do('restart', '/chains/' + this.chainId + '/restart'); };

    /** @private */
    ChainCard.prototype._do = function (kind, path) {
        if (this._busy) return;
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
            // Host-conflict 409 surfaces structured remediation steps.
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
     * Adaptive sync poll. Drives the PowerCircle percent and the
     * "local / network" suffix on the primary metric. NO more sync
     * panel in 0.2.0-alpha.1 — the ring + the X / Y line tell the
     * sync story end-to-end.
     *
     * Cadence:
     *   syncing  → 10s (operator is watching the percent move)
     *   anything → 60s (drift check)
     *
     * @private
     */
    ChainCard.prototype._refreshSync = function () {
        if (this._destroyed) return;
        var self = this;
        this.api.get('/chains/' + this.chainId + '/sync', { skipCache: true }).then(function (data) {
            if (self._destroyed) return;
            self._applySyncSnapshot(data);
        }).catch(function () {
            if (self._destroyed) return;
            self._applySyncSnapshot(null);
        }).then(function () {
            if (self._destroyed || !self.root || !self.root.isConnected) return;
            var nextMs = (self._lastCoarseState === 'syncing') ? 10_000 : 60_000;
            self._syncTimer = setTimeout(function () { self._refreshSync(); }, nextMs);
        });
    };

    /**
     * Update the PowerCircle percent + primary metric line from a
     * /sync response. Replaces _renderSyncPanel from alpha.18 — the
     * heavy panel rendering is gone; only the two visual surfaces
     * the user actually sees (ring + metric) update.
     *
     * @private
     * @param {object|null} data
     */
    ChainCard.prototype._applySyncSnapshot = function (data) {
        var t = root.enmTOrFallback;

        // Ring percent — only when the coarse state agrees we're syncing.
        if (data && this._lastCoarseState === 'syncing'
            && typeof data.percent === 'number') {
            this._powerCircle.setState('syncing', { percent: data.percent });
        } else if (data && data.synced && this._lastCoarseState === 'healthy') {
            // Snapped to tip — clear any leftover percent.
            this._powerCircle.setState('healthy');
        }

        // Primary metric + label. When we have a real /sync snapshot, the
        // formatter shows "local / network" while syncing; the label
        // swaps to "connecting to peers" when localHeight is still null.
        var height = (this._lastBackendState && this._lastBackendState.height != null)
            ? this._lastBackendState.height : null;
        var coarse = this._lastCoarseState || 'unconfigured';
        this._primaryMetric.textContent = formatPrimaryValue(t, coarse, height, data);
        this._primaryLabel.textContent  = formatPrimaryLabel(t, coarse, height, data);
    };

    /**
     * @private
     * Apply an SSE connection-state change. Updates the card's
     * data-sse-state attribute (drives CSS dimming + breath pause)
     * and toggles the reconnecting pill. Open = everything hidden;
     * anything else = pill on, ring dimmed.
     *
     * @param {('open'|'reconnecting'|'closed')} sseState
     */
    ChainCard.prototype._applySseState = function (sseState) {
        this.root.dataset.sseState = sseState || 'open';
        if (!this._reconnectPill) return;
        this._reconnectPill.hidden = (sseState === 'open');
    };

    /**
     * @private
     * 0.2.0-alpha.7 — DPoS rotation poll. Polls /chains/:id/rotation
     * every 60s (or once on mount). Renders the rotation strip:
     *
     *  - When the operator's pubkey is on duty: green "On duty now"
     *  - When it's in the slate but not on duty: "Your slot — N of M",
     *    plus a "next up at block X" countdown if their next-arbiter
     *    index is known
     *  - When it's NOT in the slate: hide the strip entirely (no
     *    rotation context to surface)
     *
     * Hides on chain dead / not configured / not in slate. Errors
     * silently — rotation visibility is decorative, not load-bearing.
     */
    ChainCard.prototype._refreshRotation = function () {
        if (this._destroyed) return;
        // Skip when the chain is dead — no rotation context.
        if (this._lastCoarseState && (this._lastCoarseState === 'stopped'
            || this._lastCoarseState === 'unconfigured')) {
            if (this._rotationStrip) this._rotationStrip.hidden = true;
            return;
        }
        var self = this;
        this.api.get('/chains/' + this.chainId + '/rotation', { skipCache: true })
            .then(function (data) {
                if (self._destroyed || !self._rotationStrip) return;
                self._applyRotation(data);
            })
            .catch(function () {
                if (self._destroyed || !self._rotationStrip) return;
                self._rotationStrip.hidden = true;
            });
    };

    /**
     * @private
     * Render the rotation strip from a /rotation snapshot. Three states:
     *   on-duty  — operator's pubkey === ondutyarbiter, green chip
     *   in-slate — operator is in the slate but not on duty, info chip
     *   absent   — not in slate; strip hidden
     */
    ChainCard.prototype._applyRotation = function (data) {
        var strip = this._rotationStrip;
        if (!strip) return;
        if (!data || !data.enabled || !data.alive) {
            strip.hidden = true;
            return;
        }
        var inSlate     = (data.ourIndex >= 0);
        var inNextSlate = (data.ourNextIndex >= 0);
        if (!inSlate && !inNextSlate) {
            // Not currently a BPoS arbiter. No rotation context to surface.
            strip.hidden = true;
            return;
        }
        strip.hidden = false;
        strip.innerHTML = '';

        var dot = document.createElement('span');
        dot.className = 'enm-chain-rotation-dot';
        strip.appendChild(dot);

        var text = document.createElement('span');
        text.className = 'enm-chain-rotation-text';
        strip.appendChild(text);

        if (data.isOnDuty) {
            strip.dataset.state = 'onduty';
            text.textContent = 'On duty now · signing the current block';
        } else if (inSlate) {
            strip.dataset.state = 'inslate';
            text.textContent = 'Your slot · '
                + (data.ourIndex + 1) + ' of ' + data.rotationLength;
        } else {
            strip.dataset.state = 'nextslate';
            text.textContent = 'Queued for next round · '
                + (data.ourNextIndex + 1) + ' of ' + (data.nextArbiters || []).length;
        }
    };

    /** Build a button. Plain helper. */
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
