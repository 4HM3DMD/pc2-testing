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
        return this;
    };

    ChainCard.prototype.destroy = function () {
        if (this._unsubscribe) { this._unsubscribe(); }
        if (this._cooldownTimer) { clearInterval(this._cooldownTimer); }
        if (this._producerTimer) { clearInterval(this._producerTimer); }
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

        // Action buttons.
        var actions = document.createElement('div');
        actions.className = 'enm-chain-actions';

        this._startBtn = makeBtn(t('chain_actions.start'),     'enm-btn-primary',  this._handleStart.bind(this));
        this._stopBtn  = makeBtn(t('chain_actions.stop'),      'enm-btn-secondary', this._handleStop.bind(this));
        this._restartBtn = makeBtn(t('chain_actions.restart'), 'enm-btn-secondary', this._handleRestart.bind(this));

        actions.appendChild(this._startBtn);
        actions.appendChild(this._stopBtn);
        actions.appendChild(this._restartBtn);
        this.root.appendChild(actions);
    };

    ChainCard.prototype._applyState = function (state) {
        var t = root.enmTOrFallback;
        var coarse = state && state.state ? state.state : 'unconfigured';
        this.root.dataset.state = coarse;
        this._badge.textContent = t('chain_state.' + coarse);
        this._badge.className = 'enm-chain-badge enm-chain-badge-' + coarse;

        // Stats — best-effort from whatever fields the route returned.
        this._statFields.version.textContent = state && state.binaryVersion ? state.binaryVersion : '—';
        this._statFields.height.textContent  = state && state.height        != null ? String(state.height)        : '—';
        this._statFields.peers.textContent   = state && state.peers         != null ? String(state.peers)         : '—';
        this._statFields.uptime.textContent  = state && state.uptimeSec     != null ? root.enmFormatUptime(state.uptimeSec) : '—';

        // Button enable/disable.
        var alive = (coarse === 'healthy' || coarse === 'syncing' || coarse === 'stalled' || coarse === 'recovering');
        this._startBtn.disabled   = alive || coarse === 'unconfigured';
        this._stopBtn.disabled    = !alive;
        this._restartBtn.disabled = !alive;

        this.onStateChange(coarse, state);
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
