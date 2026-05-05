/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/stat-strip.js — three at-a-glance stats below the hero.
 *
 *   💰 ELA earned   ⏱️ Days running   👥 Friends connected
 *
 * Pulls from the same /chains/:id endpoint the hero already polls.
 * "Friends connected" intentionally rebrands "peers" — the technical
 * name doesn't add meaning for an avg-joe and "friends" reads warmer.
 *
 * For BPoS nodes we also surface earnings (from /producer.rewards if
 * available); for full nodes the earnings tile is hidden — there's
 * nothing to show there.
 */

(function (root) {
    'use strict';

    function StatStrip(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('StatStrip: { api } required');
        }
        this.chainId = opts.chainId || 'mainchain';
        this.api = opts.api;

        this.root = document.createElement('section');
        this.root.className = 'enm-stat-strip';

        this._role = null;
        this._pollTimer = null;
    }

    StatStrip.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._renderShell();
        this.refresh();
        var self = this;
        this._pollTimer = setInterval(function () { self.refresh(); }, 30000);
        return this;
    };

    StatStrip.prototype.destroy = function () {
        if (this._pollTimer) { clearInterval(this._pollTimer); }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    StatStrip.prototype._renderShell = function () {
        this.root.innerHTML =
            '<div class="enm-stat" id="enm-stat-earnings">'
              + '<div class="enm-stat-icon">💰</div>'
              + '<div class="enm-stat-value">—</div>'
              + '<div class="enm-stat-label">earned</div>'
            + '</div>'
            + '<div class="enm-stat" id="enm-stat-uptime">'
              + '<div class="enm-stat-icon">⏱️</div>'
              + '<div class="enm-stat-value">—</div>'
              + '<div class="enm-stat-label">running</div>'
            + '</div>'
            + '<div class="enm-stat" id="enm-stat-peers">'
              + '<div class="enm-stat-icon">👥</div>'
              + '<div class="enm-stat-value">—</div>'
              + '<div class="enm-stat-label">friends</div>'
            + '</div>';
        this._els = {
            earnings:      this.root.querySelector('#enm-stat-earnings'),
            earningsValue: this.root.querySelector('#enm-stat-earnings .enm-stat-value'),
            uptimeValue:   this.root.querySelector('#enm-stat-uptime .enm-stat-value'),
            peers:         this.root.querySelector('#enm-stat-peers'),
            peersValue:    this.root.querySelector('#enm-stat-peers .enm-stat-value'),
            peersLabel:    this.root.querySelector('#enm-stat-peers .enm-stat-label'),
        };
    };

    /** Re-fetch chain + producer state. */
    StatStrip.prototype.refresh = function () {
        var self = this;
        return Promise.all([
            this.api.get('/chains/' + this.chainId, { skipCache: true }).catch(function () { return null; }),
            this.api.get('/chains/' + this.chainId + '/producer', { skipCache: true }).catch(function () { return null; }),
        ]).then(function (results) {
            self._apply(results[0], results[1]);
        });
    };

    /** @private */
    StatStrip.prototype._apply = function (chain, producer) {
        var role = (producer && producer.enabled) ? 'bpos' : 'full';
        this._role = role;

        // Earnings tile — BPoS only. Full nodes don't earn.
        if (role === 'bpos') {
            this._els.earnings.hidden = false;
            var votes = (producer && typeof producer.votes === 'number') ? producer.votes : null;
            // We don't have a true "ELA earned" feed yet (that's a v0.5
            // concern — needs reward-tracking on the backend). For now,
            // surface vote count as the proxy metric so the tile isn't
            // a permanent dash. Label clarifies what the number means.
            if (votes != null) {
                this._els.earningsValue.textContent = formatNumber(votes);
                this._els.earnings.querySelector('.enm-stat-label').textContent = 'votes';
            } else {
                this._els.earningsValue.textContent = '—';
                this._els.earnings.querySelector('.enm-stat-label').textContent = 'earned';
            }
        } else {
            this._els.earnings.hidden = true;
        }

        // Uptime tile — universal.
        if (chain && typeof chain.uptimeSec === 'number' && chain.uptimeSec > 0) {
            this._els.uptimeValue.textContent = formatUptime(chain.uptimeSec);
        } else {
            this._els.uptimeValue.textContent = '—';
        }

        // Peers tile — universal. "0 friends" is sad, so show a friendlier
        // "finding friends…" instead.
        var peers = (chain && typeof chain.peers === 'number') ? chain.peers : null;
        if (peers == null) {
            this._els.peersValue.textContent = '—';
            this._els.peersLabel.textContent = 'friends';
        } else if (peers === 0) {
            this._els.peersValue.textContent = '0';
            this._els.peersLabel.textContent = 'finding friends…';
        } else {
            this._els.peersValue.textContent = String(peers);
            this._els.peersLabel.textContent = peers === 1 ? 'friend' : 'friends';
        }
    };

    function formatUptime(sec) {
        var days = Math.floor(sec / 86400);
        if (days >= 1) { return days + 'd'; }
        var hours = Math.floor(sec / 3600);
        if (hours >= 1) { return hours + 'h'; }
        var mins = Math.floor(sec / 60);
        if (mins >= 1) { return mins + 'm'; }
        return Math.floor(sec) + 's';
    }

    function formatNumber(n) {
        if (n >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
        if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'K'; }
        return String(n);
    }

    root.EnmStatStrip = StatStrip;
}(typeof window !== 'undefined' ? window : globalThis));
