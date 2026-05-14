/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/node-identity-card.js — always-on "who is this node on-chain"
 * card for the Dashboard pane. (Beta 3.13.)
 *
 * Surfaces three concepts the operator needs in one glance:
 *
 *   1. Public key (signing identity)
 *        Always shown when a keystore exists. Monospace, copiable.
 *        Operators paste this into Elastos Essentials to register a
 *        producer (the wallet there signs the deposit tx). Without
 *        a public key, a producer cannot be registered — so this
 *        is the most important value on the card.
 *
 *   2. Two addresses, explained
 *        Bound address — derived from the keystore. This is the
 *          on-chain ELA address that signs blocks and receives BPoS
 *          rewards. We show its live balance when the chain is up
 *          (via getbalancebyaddr).
 *        Operator wallet — the PC2 session wallet the user is
 *          logged in as. This is their *login identity* for ENM
 *          (audit-log attribution + ownership of the install).
 *          ENM never asks this wallet to sign chain transactions
 *          (Architectural Invariant #2 — wallet identity-only).
 *
 *   3. Producer summary, when registered
 *        State, vote totals (v1 + v2), deposit balance, claimable
 *        rewards. Read-only — registration, voting, and reward
 *        claiming all happen in Essentials or via ela-cli; ENM
 *        just surfaces them here so the operator doesn't need to
 *        run "ela-cli wallet account" by hand.
 *
 *   CR Council fields are intentionally omitted per operator
 *   preference (this card is for BPoS / signing-key operators).
 *
 * Data source: GET /api/enm/system/identity (best-effort backend
 * that gracefully degrades each section to null on RPC failure).
 *
 * Polling cadence: 60s, visibility-paused. Balances + rewards
 * change on every claim/vote tx, but rarely fast enough to need
 * tighter polling.
 *
 * alpha.28 invariants preserved:
 *   - _destroyed guard on every async .then resolution
 *   - 401-suppress on background fetches (boot path owns re-auth)
 *   - Visibility-paused polling
 *   - enmCopyButton factory for every copy interaction
 *   - aria-labelledby on the card root
 */

(function (root) {
    'use strict';

    var POLL_INTERVAL_MS = 60_000;

    function NodeIdentityCard(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('EnmNodeIdentityCard: { api } required');
        }
        this.api           = opts.api;
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-identity-card';
        this.root.setAttribute('role', 'region');
        this._titleId = 'enm-identity-title-' + Math.random().toString(36).slice(2, 8);
        this.root.setAttribute('aria-labelledby', this._titleId);

        // Skeleton — replaced on first poll resolution.
        this.root.innerHTML =
            '<header class="enm-identity-head">'
            + '<h3 id="' + this._titleId + '">Node identity</h3>'
            + '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
            + 'Reading keystore and on-chain identity…'
            + '</p>'
            + '</header>';

        this._destroyed   = false;
        this._pollPauser  = null;
        this._pollTimer   = null;
        this._lastPayload = null;
    }

    NodeIdentityCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        this._poll();
        if (typeof root.enmUseVisibilityPause === 'function') {
            this._pollPauser = root.enmUseVisibilityPause(
                function () { self._poll(); }, POLL_INTERVAL_MS
            );
        } else {
            this._pollTimer = setInterval(function () { self._poll(); }, POLL_INTERVAL_MS);
        }
        return this;
    };

    NodeIdentityCard.prototype.refresh = function () { this._poll(); };

    NodeIdentityCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._pollPauser) {
            try { this._pollPauser.stop(); } catch (_) { /* idempotent */ }
            this._pollPauser = null;
        }
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
    };

    /** @private */
    NodeIdentityCard.prototype._poll = function () {
        var self = this;
        this.api.get('/system/identity').then(function (env) {
            if (self._destroyed) { return; }
            var payload = (env && env.data) || env || {};
            self._lastPayload = payload;
            self._render(payload);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            // 401-suppress — boot path owns re-auth (alpha.28 batch 60-61).
            if (err && err.status === 401) { return; }
            // Keep the last good render; only fall back to a skeleton if
            // we never had one. Avoids the card blinking on transient
            // backend hiccups.
            if (!self._lastPayload) {
                self.root.innerHTML =
                    '<header class="enm-identity-head">'
                    + '<h3 id="' + self._titleId + '">Node identity</h3>'
                    + '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
                    + 'Couldn’t read identity — retrying every 60s.'
                    + '</p>'
                    + '</header>';
            }
        });
    };

    /** @private — escape user-displayed strings into HTML-safe form */
    function esc(s) {
        if (s == null) { return ''; }
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[c];
        });
    }

    /** @private — format ELA balance string with thousands sep + 4-decimal cap */
    function fmtEla(value) {
        if (value == null || value === '') { return null; }
        var n = parseFloat(value);
        if (!isFinite(n)) { return null; }
        // 4 decimals max; chain returns up to 8 but the trailing zeros
        // are visual noise on the dashboard.
        var fixed = n.toFixed(4).replace(/\.?0+$/, '');
        var parts = fixed.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.') + ' ELA';
    }

    /** @private — producer state → chip class + label */
    function stateChip(state) {
        if (!state) { return null; }
        var s = String(state).toLowerCase();
        var className = 'enm-identity-chip enm-identity-chip-neutral';
        if (s === 'active')      { className = 'enm-identity-chip enm-identity-chip-success'; }
        else if (s === 'pending' || s === 'returned') { className = 'enm-identity-chip enm-identity-chip-warning'; }
        else if (s === 'illegal' || s === 'inactive' || s === 'canceled') { className = 'enm-identity-chip enm-identity-chip-danger'; }
        return { className: className, label: state };
    }

    /** @private */
    NodeIdentityCard.prototype._render = function (data) {
        var ks       = data.keystore || {};
        var producer = data.producer || null;
        var wallet   = data.walletAddress || null;
        var pubkey   = ks.publicKey || null;
        var addr     = ks.address || null;
        var balance  = ks.balanceEla;

        var html = '';

        // ----- Header ------------------------------------------------
        html += '<header class="enm-identity-head">'
            + '<h3 id="' + this._titleId + '">Node identity</h3>'
            + '<p class="enm-identity-subtitle">'
            + 'The on-chain identity this node uses, plus your operator login. '
            + 'Use the public key below when registering as a BPoS supernode in '
            + '<strong>Elastos Essentials</strong>.'
            + '</p>'
            + '</header>';

        // ----- Public key (only meaningful when keystore exists) -----
        if (ks.exists && pubkey) {
            html += '<div class="enm-identity-row enm-identity-pubkey-row">'
                + '<div class="enm-identity-row-head">'
                +   '<span class="enm-identity-row-label">Public key</span>'
                +   '<span class="enm-identity-row-hint">Paste this into Essentials when registering.</span>'
                + '</div>'
                + '<div class="enm-identity-value-stack">'
                +   '<code class="enm-identity-value enm-identity-pubkey" data-fill="pubkey"></code>'
                +   '<span class="enm-identity-copy-slot" data-copy="pubkey" data-copy-value="' + esc(pubkey) + '"></span>'
                + '</div>'
                + '</div>';
        }

        // ----- Bound (keystore-derived) address ---------------------
        if (ks.exists && addr) {
            html += '<div class="enm-identity-row enm-identity-addr-row">'
                + '<div class="enm-identity-row-head">'
                +   '<span class="enm-identity-row-label">Bound address</span>'
                +   '<span class="enm-identity-row-hint">Derived from the keystore. Signs blocks and receives BPoS rewards.</span>'
                + '</div>'
                + '<div class="enm-identity-value-stack">'
                +   '<code class="enm-identity-value enm-identity-addr" data-fill="addr"></code>'
                +   '<span class="enm-identity-copy-slot" data-copy="addr" data-copy-value="' + esc(addr) + '"></span>'
                + '</div>'
                + (balance != null
                    ? '<div class="enm-identity-balance">Balance: <strong>' + esc(fmtEla(balance) || (balance + ' ELA')) + '</strong></div>'
                    : (ks.exists ? '<div class="enm-identity-balance enm-identity-balance-muted">Balance unavailable (chain RPC offline).</div>' : '')
                  )
                + '</div>';
        }

        // ----- Operator (PC2 session) wallet ------------------------
        if (wallet) {
            html += '<div class="enm-identity-row enm-identity-wallet-row">'
                + '<div class="enm-identity-row-head">'
                +   '<span class="enm-identity-row-label">Operator login</span>'
                +   '<span class="enm-identity-row-hint">The PC2 wallet you logged in with. Used for ENM access &amp; audit log&nbsp;— <strong>different from the bound address above</strong>.</span>'
                + '</div>'
                + '<div class="enm-identity-value-stack">'
                +   '<code class="enm-identity-value enm-identity-wallet" data-fill="wallet"></code>'
                +   '<span class="enm-identity-copy-slot" data-copy="wallet" data-copy-value="' + esc(wallet) + '"></span>'
                + '</div>'
                + '<div class="enm-identity-note">'
                +   'ENM never asks this wallet to sign chain transactions. '
                +   'Producer registration, voting, and reward claims happen in '
                +   'Essentials — the bound address is the signer there, not this wallet.'
                + '</div>'
                + '</div>';
        }

        // ----- Keystore-missing helper -----------------------------
        if (!ks.exists) {
            html += '<div class="enm-identity-empty">'
                + '<strong>Keystore not generated yet.</strong> Finish the setup wizard to create the producer keystore '
                + '— the public key and bound address will appear here once it exists.'
                + '</div>';
        }

        // ----- Producer details (only when registered on-chain) ----
        if (producer && (producer.state || producer.votes || producer.dposv2votes)) {
            var chip = stateChip(producer.state);
            html += '<div class="enm-identity-producer">'
                + '<div class="enm-identity-producer-head">'
                +   '<span class="enm-identity-row-label">On-chain producer</span>'
                +   (chip ? '<span class="' + chip.className + '">' + esc(chip.label) + '</span>' : '')
                + '</div>'
                + '<div class="enm-identity-producer-grid">'
                +   (producer.nickname ? ('<div class="enm-identity-stat"><span class="enm-identity-stat-label">Name</span><span class="enm-identity-stat-value">' + esc(producer.nickname) + '</span></div>') : '')
                +   '<div class="enm-identity-stat">'
                +     '<span class="enm-identity-stat-label">Votes (DPoS v1)</span>'
                +     '<span class="enm-identity-stat-value">' + esc(producer.votes || '0') + '</span>'
                +   '</div>'
                +   '<div class="enm-identity-stat">'
                +     '<span class="enm-identity-stat-label">Votes (DPoS v2)</span>'
                +     '<span class="enm-identity-stat-value">' + esc(producer.dposv2votes || '0') + '</span>'
                +   '</div>'
                +   (producer.deposit != null ? (
                    '<div class="enm-identity-stat">'
                +     '<span class="enm-identity-stat-label">Deposit</span>'
                +     '<span class="enm-identity-stat-value">' + esc(fmtEla(producer.deposit) || (producer.deposit + ' ELA')) + '</span>'
                +   '</div>'
                  ) : '')
                +   (producer.rewards != null ? (
                    '<div class="enm-identity-stat">'
                +     '<span class="enm-identity-stat-label">Claimable rewards</span>'
                +     '<span class="enm-identity-stat-value">' + esc(fmtEla(producer.rewards) || (producer.rewards + ' ELA')) + '</span>'
                +   '</div>'
                  ) : '')
                + '</div>'
                + '</div>';
        }

        this.root.innerHTML = html;

        // Fill long monospace values via textContent (avoid wrapping
        // them in innerHTML — they don't escape edge cases as cleanly,
        // and textContent makes copy-by-selection deterministic).
        if (pubkey) {
            var elPk = this.root.querySelector('[data-fill="pubkey"]');
            if (elPk) { elPk.textContent = pubkey; }
        }
        if (addr) {
            var elAd = this.root.querySelector('[data-fill="addr"]');
            if (elAd) { elAd.textContent = addr; }
        }
        if (wallet) {
            var elWa = this.root.querySelector('[data-fill="wallet"]');
            if (elWa) { elWa.textContent = wallet; }
        }

        // Mount copy buttons via the shared factory. Each slot carries
        // its value in data-copy-value (already HTML-escaped); we
        // resolve it as a function so a stale closure can't leak.
        if (typeof root.enmCopyButton === 'function') {
            var slots = this.root.querySelectorAll('.enm-identity-copy-slot');
            for (var i = 0; i < slots.length; i++) {
                (function (slot) {
                    var value = slot.getAttribute('data-copy-value') || '';
                    if (!value) { return; }
                    var btn = root.enmCopyButton({
                        value: value,
                        label: 'Copy',
                        ariaLabel: 'Copy ' + (slot.dataset.copy || 'value'),
                        notifications: null, // copy success is the visual swap; toast would be noise
                        className: 'enm-identity-copy-btn',
                    });
                    slot.appendChild(btn);
                })(slots[i]);
            }
        }
    };

    root.EnmNodeIdentityCard = NodeIdentityCard;
}(window));
