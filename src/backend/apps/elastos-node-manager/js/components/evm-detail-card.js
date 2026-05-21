/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/evm-detail-card.js — Council Node UX Phase 3 (v0.5.187).
 *
 * Additive per-chain dashboard card for EVM sidechains (Class B: esc / eid /
 * pg). It mounts BELOW the shared chain-card hero, which already shows
 * height / state / sync / health / start-stop-restart for every class. The
 * chain-card is the Main Chain (Class A) reference and is intentionally left
 * untouched — this card lives alongside it for Class B only, so the Class-A
 * render path is byte-for-byte unchanged.
 *
 * Surfaces the three EVM-specific values the generic hero never shows and
 * that an operator most wants to verify:
 *   1. Mining on / off            (cfg.miner.enabled)
 *   2. EVM account address        (the geth keystore account — evmKeystoreAddr)
 *   3. Block-reward address       (cfg.miner.rewardAddress)
 *
 * Data source: GET /api/enm/chains/:id → .miner { enabled, evmKeystoreAddr,
 * rewardAddress } (added in Phase 1, P1.1). Real-data-only: a null field
 * renders as "—", never a fabricated address. The encrypted account password
 * is never sent by the backend and is never shown here.
 *
 * The per-EVM-chain binary Update flow is Phase 5, not here. Node output
 * lives in the Logs tab; this card does not invent an error line.
 *
 * Polling: 60 s, visibility-paused (addresses + the mining flag change
 * rarely). alpha.28 invariants preserved: _destroyed guard on async
 * resolves, 401-suppress on the background fetch, enmCopyButton for copy,
 * aria-labelledby on the card root. Copy is inline English to match the
 * peer node-identity-card (pending any future bulk i18n pass).
 */

(function (root) {
    'use strict';

    var POLL_INTERVAL_MS = 60_000;

    function EvmDetailCard(opts) {
        if (!opts || !opts.api) { throw new TypeError('EnmEvmDetailCard: { api } required'); }
        if (!opts.chainId)      { throw new TypeError('EnmEvmDetailCard: { chainId } required'); }
        this.api           = opts.api;
        this.chainId       = opts.chainId;
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-section-card enm-evm-detail-card';
        this.root.setAttribute('role', 'region');
        this._titleId = 'enm-evm-detail-title-' + Math.random().toString(36).slice(2, 8);
        this.root.setAttribute('aria-labelledby', this._titleId);
        this.root.innerHTML =
            '<header class="enm-section-card-head">'
            + '<div class="enm-section-card-headbody">'
            +   '<div class="enm-section-card-title" id="' + this._titleId + '">Mining &amp; rewards</div>'
            +   '<div class="enm-section-card-help">Reading EVM mining configuration…</div>'
            + '</div>'
            + '</header>';

        this._destroyed  = false;
        this._pollPauser = null;
        this._pollTimer  = null;
        this._lastMiner  = null;
    }

    EvmDetailCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        this._poll();
        if (typeof root.enmUseVisibilityPause === 'function') {
            this._pollPauser = root.enmUseVisibilityPause(function () { self._poll(); }, POLL_INTERVAL_MS);
        } else {
            this._pollTimer = setInterval(function () { self._poll(); }, POLL_INTERVAL_MS);
        }
        return this;
    };

    EvmDetailCard.prototype.refresh = function () { this._poll(); };

    EvmDetailCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._pollPauser) {
            try { this._pollPauser.stop(); } catch (_) { /* idempotent */ }
            this._pollPauser = null;
        }
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    EvmDetailCard.prototype._poll = function () {
        var self = this;
        this.api.get('/chains/' + this.chainId).then(function (env) {
            if (self._destroyed) { return; }
            var d = (env && env.result) || (env && env.data) || env || {};
            self._lastMiner = d.miner || null;
            self._render(d);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            if (err && err.status === 401) { return; }  // boot path owns re-auth
            // Keep the last good render; only show an error sub if we never had one.
            if (!self._lastMiner) {
                var help = self.root.querySelector('.enm-section-card-help');
                if (help) { help.textContent = 'Couldn’t read mining configuration — retrying every 60s.'; }
            }
        });
    };

    /** @private */
    EvmDetailCard.prototype._render = function (d) {
        var miner = d && d.miner ? d.miner : null;
        var mining = !!(miner && miner.enabled);
        var evmAddr = miner && miner.evmKeystoreAddr ? miner.evmKeystoreAddr : null;
        var rewardAddr = miner && miner.rewardAddress ? miner.rewardAddress : null;

        var tag = mining
            ? '<span class="enm-section-card-tag success">Mining on</span>'
            : '<span class="enm-section-card-tag muted">Mining off</span>';

        var html = ''
            + '<header class="enm-section-card-head">'
            +   '<div class="enm-section-card-headbody">'
            +     '<div class="enm-section-card-title" id="' + this._titleId + '">Mining &amp; rewards</div>'
            +     '<div class="enm-section-card-help">'
            +       (mining
                       ? 'This node produces blocks for the sidechain. Block rewards are credited to the reward address below.'
                       : 'This node is running as a sync-only node (not producing blocks). Mining is configured in Settings.')
            +     '</div>'
            +   '</div>'
            +   tag
            + '</header>'
            + '<div class="enm-section-card-body">'
            +   '<div class="enm-detail-list">'
            +     this._addrRow('EVM account', 'The node’s geth keystore account on this chain.', evmAddr, 'evm-account')
            +     this._addrRow('Block reward address', 'Where this node’s block rewards are credited.', rewardAddr, 'reward')
            +   '</div>'
            + '</div>'
            + '<div class="enm-section-card-foot">'
            +   '<span class="enm-section-card-foot-status">Node output is in the Logs tab.</span>'
            + '</div>';

        this.root.innerHTML = html;

        // Fill long monospace values via textContent (deterministic copy-by-selection).
        var fillEvm = this.root.querySelector('[data-fill="evm-account"]');
        if (fillEvm) { fillEvm.textContent = evmAddr || '—'; }
        var fillReward = this.root.querySelector('[data-fill="reward"]');
        if (fillReward) { fillReward.textContent = rewardAddr || '—'; }

        // Mount copy buttons only for rows that have a real value.
        if (typeof root.enmCopyButton === 'function') {
            var slots = this.root.querySelectorAll('.enm-detail-copy-slot');
            for (var i = 0; i < slots.length; i++) {
                (function (slot) {
                    var value = slot.getAttribute('data-copy-value') || '';
                    if (!value) { return; }
                    var btn = root.enmCopyButton({
                        value: value,
                        label: 'Copy',
                        ariaLabel: 'Copy ' + (slot.dataset.copy || 'value'),
                        notifications: null,
                        className: 'enm-detail-copy-btn',
                    });
                    slot.appendChild(btn);
                })(slots[i]);
            }
        }
    };

    /** @private — stacked label + hint + monospace address value + copy button.
     * When the value is unknown we render "—" and omit the copy button (nothing
     * to copy) — never a fabricated address. */
    EvmDetailCard.prototype._addrRow = function (label, hint, value, key) {
        var copySlot = value
            ? '<span class="enm-detail-copy-slot" data-copy="' + esc(key) + '" data-copy-value="' + esc(value) + '"></span>'
            : '';
        return '<div class="enm-detail-addr-row' + (value ? '' : ' is-empty') + '">'
            + '<div class="enm-detail-row-head">'
            +   '<span class="enm-detail-label">' + esc(label) + '</span>'
            +   '<span class="enm-detail-hint">' + esc(hint) + '</span>'
            + '</div>'
            + '<div class="enm-detail-value-stack">'
            +   '<code class="enm-detail-addr" data-fill="' + esc(key) + '"></code>'
            +   copySlot
            + '</div>'
            + '</div>';
    };

    /** @private — HTML-escape displayed strings */
    function esc(s) {
        if (s == null) { return ''; }
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmEvmDetailCard = EvmDetailCard;
}(typeof window !== 'undefined' ? window : globalThis));
