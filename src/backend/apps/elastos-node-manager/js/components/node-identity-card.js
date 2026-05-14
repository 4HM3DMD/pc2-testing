/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/node-identity-card.js — always-on "who is this node on-chain"
 * card for the Dashboard pane. (Beta 3.14 — see below for the truth-
 * correction the previous beta.3.13 copy needed.)
 *
 * Surfaces two concepts the operator needs in one glance:
 *
 *   1. Node public key (consensus signing identity)
 *        Always shown when a keystore exists. Monospace, copiable.
 *        Operators paste this into Elastos Essentials to register a
 *        producer (the Essentials wallet there signs the deposit tx
 *        AND becomes the owner of the producer entry). Without a
 *        public key, a producer cannot be registered — this is the
 *        most important value on the card.
 *
 *   2. Node signing address (derived from the keystore)
 *        The address derived from the same keystore.dat the node
 *        uses to sign block proposals and DPoS round consensus
 *        messages. This is a CONSENSUS SIGNING IDENTITY only —
 *        it does NOT hold funds and does NOT receive BPoS rewards.
 *        We show its live balance (which will typically be 0) as a
 *        sanity check, not because it accrues anything.
 *
 *        Block rewards go to the OWNER's address — the address
 *        derived from the OwnerPublicKey in the producer-registration
 *        transaction (typically the Essentials wallet that registered
 *        this supernode). The owner claims those rewards by signing
 *        a DPoSV2ClaimReward transaction from Essentials.
 *
 *        Sources (verified against Elastos.ELA HEAD):
 *          - dpos/state/arbitrators.go:732-801 — rewards credited to
 *            getOwnerKeyStandardProgramHash(producer.OwnerPublicKey())
 *          - core/types/payload/producerinfo.go:24-35 — OwnerKey vs
 *            NodePublicKey distinction
 *          - servers/interfaces.go:2317-2347 — dposv2rewardinfo is
 *            keyed by the owner-derived stake address, not the node key
 *
 *   3. Producer summary, when registered (BPoS-only)
 *        State, vote totals (v1 + v2), deposit balance, claimable
 *        rewards. Read-only — registration, voting, and reward
 *        claiming all happen in Essentials.
 *
 *   CR Council fields are intentionally omitted per operator
 *   preference (this card is for BPoS / signing-key operators).
 *
 *   The PC2 operator-login wallet is intentionally NOT shown — it
 *   was on beta.3.13 but operator feedback was "not needed", and
 *   it conflated two distinct identities (ENM auth vs on-chain
 *   producer ownership) in a way that wasn't useful.
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
        // beta.3.14: PC2 operator-login wallet intentionally not
        // rendered. The previous beta.3.13 row conflated ENM auth
        // identity with on-chain producer ownership and operator
        // feedback was "not needed".
        var pubkey   = ks.publicKey || null;
        var addr     = ks.address || null;
        var balance  = ks.balanceEla;

        var html = '';

        // ----- Header ------------------------------------------------
        html += '<header class="enm-identity-head">'
            + '<h3 id="' + this._titleId + '">Node identity</h3>'
            + '<p class="enm-identity-subtitle">'
            + 'The consensus-signing identity this node uses on-chain. '
            + 'Paste the public key below into <strong>Elastos Essentials</strong> '
            + 'when registering as a BPoS supernode — the Essentials wallet that '
            + 'signs the registration becomes the producer owner and is where '
            + 'all block rewards are credited.'
            + '</p>'
            + '</header>';

        // ----- Node public key (only meaningful when keystore exists) -----
        if (ks.exists && pubkey) {
            html += '<div class="enm-identity-row enm-identity-pubkey-row">'
                + '<div class="enm-identity-row-head">'
                +   '<span class="enm-identity-row-label">Node public key</span>'
                +   '<span class="enm-identity-row-hint">Paste this into Essentials when registering your supernode. The Essentials wallet signing the registration becomes the producer owner.</span>'
                + '</div>'
                + '<div class="enm-identity-value-stack">'
                +   '<code class="enm-identity-value enm-identity-pubkey" data-fill="pubkey"></code>'
                +   '<span class="enm-identity-copy-slot" data-copy="pubkey" data-copy-value="' + esc(pubkey) + '"></span>'
                + '</div>'
                + '</div>';
        }

        // ----- Node signing address (keystore-derived) ------------
        // beta.3.14 truth-correction: this address is a CONSENSUS
        // SIGNING IDENTITY only. It does NOT hold funds and does
        // NOT receive BPoS rewards. Rewards go to the OwnerPublicKey-
        // derived stake address (the Essentials wallet that
        // registered the producer). Verified against Elastos.ELA
        // HEAD: dpos/state/arbitrators.go:732-801,
        // servers/interfaces.go:2317-2347.
        if (ks.exists && addr) {
            html += '<div class="enm-identity-row enm-identity-addr-row">'
                + '<div class="enm-identity-row-head">'
                +   '<span class="enm-identity-row-label">Node signing address</span>'
                +   '<span class="enm-identity-row-hint">Derived from the keystore. Signs block proposals during your producer&rsquo;s on-duty rounds. <strong>Does not hold funds and does not receive rewards.</strong></span>'
                + '</div>'
                + '<div class="enm-identity-value-stack">'
                +   '<code class="enm-identity-value enm-identity-addr" data-fill="addr"></code>'
                +   '<span class="enm-identity-copy-slot" data-copy="addr" data-copy-value="' + esc(addr) + '"></span>'
                + '</div>'
                + (balance != null
                    ? '<div class="enm-identity-balance">Balance: <strong>' + esc(fmtEla(balance) || (balance + ' ELA')) + '</strong> <span class="enm-identity-balance-muted">(typically 0 &mdash; this address is signing-only).</span></div>'
                    : (ks.exists ? '<div class="enm-identity-balance enm-identity-balance-muted">Balance unavailable (chain RPC offline).</div>' : '')
                  )
                + '<div class="enm-identity-note">'
                +   '<strong>Block rewards go to your Essentials wallet</strong>, not this address. '
                +   'When you register the supernode in Essentials, that wallet becomes the '
                +   'producer owner. Rewards are credited to the owner address every round '
                +   'and claimed by signing a <code>DPoSV2ClaimReward</code> transaction from '
                +   'Essentials.'
                + '</div>'
                + '</div>';
        }

        // beta.3.14 -- operator-login wallet row dropped (was the PC2
        // session wallet from data.walletAddress; operator feedback
        // was "not needed").

        // ----- Keystore-missing helper -----------------------------
        if (!ks.exists) {
            html += '<div class="enm-identity-empty">'
                + '<strong>Keystore not generated yet.</strong> Finish the setup wizard to create the producer keystore '
                + '&mdash; the node public key and signing address will appear here once it exists.'
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
                +     '<span class="enm-identity-stat-label">Owner stake (locked)</span>'
                +     '<span class="enm-identity-stat-value">' + esc(fmtEla(producer.deposit) || (producer.deposit + ' ELA')) + '</span>'
                +   '</div>'
                  ) : '')
                +   (producer.rewards != null ? (
                    '<div class="enm-identity-stat">'
                +     '<span class="enm-identity-stat-label">Claimable in Essentials</span>'
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
