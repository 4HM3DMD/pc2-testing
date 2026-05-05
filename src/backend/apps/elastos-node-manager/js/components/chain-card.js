/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/chain-card.js — single chain status card.
 *
 * Renders a chain summary: name, state badge (one of 6 chain states), version,
 * height, peers, three primary actions (Start / Stop / Restart). Subscribes
 * to status updates via SSE; bumps height/peers via 30s API polling.
 *
 * Phase 3 ships the layout + state pipeline; Phase 5 adds BPoS-specific stats
 * (producer state, votes, missed-rounds gauge).
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
        // BPoS poll — once at mount and every 60s. Cheap because /producer
        // is a single RPC; absent if the chain isn't arbiter-mode.
        var self = this;
        this._refreshProducer();
        this._producerTimer = setInterval(function () { self._refreshProducer(); }, 60_000);
        // Sync poll — adaptive cadence. Schedules itself; the helper picks
        // 10s if state==='syncing' and 60s otherwise so the bar updates
        // smoothly while syncing without hammering /sync when healthy.
        this._refreshSync();
        return this;
    };

    ChainCard.prototype.destroy = function () {
        if (this._unsubscribe) { this._unsubscribe(); }
        if (this._cooldownTimer) { clearInterval(this._cooldownTimer); }
        if (this._producerTimer) { clearInterval(this._producerTimer); }
        if (this._syncTimer) { clearTimeout(this._syncTimer); }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /**
     * Re-fetch the chain summary from /api/chains/:id and re-render.
     */
    ChainCard.prototype.refresh = function () {
        var self = this;
        return this.api.get('/chains/' + this.chainId, { skipCache: true }).then(function (state) {
            self._applyState(state);
        }).catch(function (err) {
            // 404 means not configured yet — treat as unconfigured.
            if (err && err.status === 404) {
                self._applyState({ chainId: self.chainId, state: 'unconfigured' });
                return;
            }
            self.notifications.warning(
                'Failed to refresh ' + self.chainId,
                err && err.message ? err.message : String(err),
            );
        });
    };

    /** @private */
    ChainCard.prototype._renderShell = function () {
        var t = root.enmTOrFallback;

        // Header: name + state badge.
        var header = document.createElement('header');
        header.className = 'enm-chain-card-head';

        var name = document.createElement('h3');
        name.className = 'enm-chain-card-name';
        name.textContent = this.chainId;
        header.appendChild(name);

        this._badge = document.createElement('span');
        this._badge.className = 'enm-chain-badge';
        this._badge.textContent = t('chain_state.unconfigured');
        header.appendChild(this._badge);

        this.root.appendChild(header);

        // Stats row: version, height, peers, uptime.
        this._stats = document.createElement('dl');
        this._stats.className = 'enm-chain-stats';
        this._statFields = {};
        ['version', 'height', 'peers', 'uptime'].forEach(function (k) {
            var dt = document.createElement('dt'); dt.textContent = t('chain_card.' + k);
            var dd = document.createElement('dd'); dd.textContent = '—';
            this._stats.appendChild(dt);
            this._stats.appendChild(dd);
            this._statFields[k] = dd;
        }, this);
        this.root.appendChild(this._stats);

        // Sync progress panel — hidden until the chain reports a height or
        // we have something useful to show. _renderSyncPanel() populates.
        this._syncPanel = document.createElement('section');
        this._syncPanel.className = 'enm-chain-sync';
        this._syncPanel.hidden = true;
        this._syncPanel.setAttribute('role', 'status');
        this._syncPanel.setAttribute('aria-live', 'polite');
        this.root.appendChild(this._syncPanel);

        // Action buttons.
        var actions = document.createElement('div');
        actions.className = 'enm-chain-actions';

        this._configureBtn = makeBtn(t('chain_actions.configure'), 'enm-btn-primary', this._handleConfigure.bind(this));
        this._configureBtn.hidden = true;
        this._startBtn = makeBtn(t('chain_actions.start'),     'enm-btn-primary',  this._handleStart.bind(this));
        this._stopBtn  = makeBtn(t('chain_actions.stop'),      'enm-btn-secondary', this._handleStop.bind(this));
        this._restartBtn = makeBtn(t('chain_actions.restart'), 'enm-btn-secondary', this._handleRestart.bind(this));

        actions.appendChild(this._configureBtn);
        actions.appendChild(this._startBtn);
        actions.appendChild(this._stopBtn);
        actions.appendChild(this._restartBtn);
        this.root.appendChild(actions);
    };

    ChainCard.prototype._applyState = function (state) {
        var t = root.enmTOrFallback;
        var coarse = state && state.state ? state.state : 'unconfigured';
        this._lastCoarseState = coarse;  // drives sync-poll cadence
        this.root.dataset.state = coarse;
        this._badge.textContent = t('chain_state.' + coarse);
        this._badge.className = 'enm-chain-badge enm-chain-badge-' + coarse;

        // Stats — best-effort from whatever fields the route returned.
        this._statFields.version.textContent = state && state.binaryVersion ? state.binaryVersion : '—';
        this._statFields.height.textContent  = state && state.height        != null ? String(state.height)        : '—';
        this._statFields.peers.textContent   = state && state.peers         != null ? String(state.peers)         : '—';
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
        this._startBtn.disabled   = alive;
        this._stopBtn.disabled    = !alive;
        this._restartBtn.disabled = !alive;

        this.onStateChange(coarse, state);
    };

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
        var self = this;
        this.api.get('/chains/' + this.chainId + '/sync', { skipCache: true }).then(function (data) {
            self._renderSyncPanel(data);
        }).catch(function () {
            // Silent — boot race or chain stopped. The panel just stays as-is
            // and the next tick retries.
        }).then(function () {
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

        // Status line. The "Connecting to peers" framing covers the case
        // where the chain is alive but has no network reference yet — the
        // backend nulls velocityBpm + percent in that scenario, so we know
        // the situation by checking those fields together.
        var alive = (this._lastCoarseState === 'healthy' || this._lastCoarseState === 'syncing'
                     || this._lastCoarseState === 'starting' || this._lastCoarseState === 'recovering');
        if (data.stale) {
            this._syncStatusLine.textContent = t('chain_card.sync_stale');
        } else if (alive && pct == null && data.velocityBpm == null) {
            // Chain is up but no peers yet → no network reference → no
            // way to compute progress. Tell the operator instead of
            // displaying confusing "Network height unknown" gibberish.
            this._syncStatusLine.textContent = 'Connecting to peers…';
        } else if (pct == null) {
            this._syncStatusLine.textContent = t('chain_card.sync_unknown');
        } else if (data.blocksBehind === 0) {
            this._syncStatusLine.textContent = t('chain_card.sync_caught_up');
        } else {
            this._syncStatusLine.textContent = t('chain_card.sync_behind', {
                blocks: data.blocksBehind != null ? data.blocksBehind.toLocaleString() : '?',
            });
        }

        // Metrics line — velocity + ETA. Defensive: never show velocity
        // when the chain isn't alive (zombie buffer protection — the
        // backend now nulls this out, but the frontend guards too so a
        // backend regression can't bring back the "1150.7 blocks/min ·
        // Network height unknown" lie).
        var parts = [];
        if (alive && typeof data.velocityBpm === 'number' && data.velocityBpm > 0) {
            parts.push(t('chain_card.sync_velocity', {
                bpm: data.velocityBpm.toFixed(1),
            }));
        } else if (alive && data.localHeight != null && data.blocksBehind != null && data.blocksBehind > 0) {
            parts.push(t('chain_card.sync_no_velocity'));
        }
        if (typeof data.etaSec === 'number' && data.etaSec > 0) {
            parts.push(t(
                data.etaSec < 60 ? 'chain_card.sync_eta_lt_min' : 'chain_card.sync_eta',
                { eta: root.enmFormatUptime(data.etaSec) },
            ));
        }
        this._syncMetricsLine.textContent = parts.join(' • ');
    };

    /**
     * Fetch /chains/:id/producer and either show the BPoS sub-panel or hide it.
     * Errors stay silent — the operator hasn't necessarily started the chain.
     *
     * @private
     */
    ChainCard.prototype._refreshProducer = function () {
        var self = this;
        this.api.get('/chains/' + this.chainId + '/producer', { skipCache: true }).then(function (data) {
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
            this.root.appendChild(this._bposPanel);
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
