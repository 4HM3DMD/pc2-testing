/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/validator-registration-card.js — "Next steps" guide that
 * appears on the dashboard once the chain finishes syncing but the
 * operator hasn't yet registered as a BPoS validator on-chain.
 *
 * Trigger:
 *   chain.state === 'healthy'  AND  producer.state is null/empty
 *   (chain caught up, but no on-chain producer record for our pubkey)
 *
 * Hides automatically once the operator registers in Essentials and the
 * registration tx confirms — at which point /chains/<id>/producer starts
 * returning a state (Inactive / Active) and we step out of the way.
 *
 * What it walks the operator through (no node.sh references — we manage
 * binaries, keystore, and activation inside ENM):
 *
 *   1. Copy your producer public key. The keystore is already generated
 *      and stored on this server during setup; this is the public half.
 *   2. Sign the registration tx in Elastos Essentials mobile wallet —
 *      that's the only place to put the 5,000 ELA deposit because the
 *      browser/desktop has no signing key (Architectural Invariant #2:
 *      ENM is identity-only, never asks the wallet to sign).
 *   3. Wait 6 blocks (~12 min) for chain confirmation.
 *   4. Tap Activate inside ENM — same /chains/<id>/bpos/activate
 *      endpoint Settings → Tools uses. We've kept it visible here so
 *      the operator doesn't have to dig.
 */

(function (root) {
    'use strict';

    var POLL_INTERVAL_MS = 30_000;
    var SHORT_POLL_MS    = 5_000;   // faster cadence once we know we're alive but not registered

    function ValidatorRegistrationCard(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('ValidatorRegistrationCard: { api } required');
        }
        this.api           = opts.api;
        this.chainId       = opts.chainId || 'mainchain';
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-validator-card';
        this.root.hidden = true;          // hidden until poll says "show me"

        this._pollTimer = null;
        this._rendered = false;
        this._lastPubkey = null;
    }

    ValidatorRegistrationCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        // First poll happens immediately; subsequent ones from the interval.
        this._poll();
        this._pollTimer = setInterval(function () { self._poll(); }, POLL_INTERVAL_MS);
        return this;
    };

    ValidatorRegistrationCard.prototype.destroy = function () {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    ValidatorRegistrationCard.prototype._poll = function () {
        var self = this;
        Promise.all([
            this.api.get('/chains/' + this.chainId, { skipCache: true }).catch(function () { return null; }),
            this.api.get('/chains/' + this.chainId + '/producer', { skipCache: true }).catch(function () { return null; }),
        ]).then(function (results) {
            var chain    = results[0];
            var producer = results[1];
            self._reconcile(chain, producer);
        });
    };

    /**
     * @private
     * Visibility logic — match exactly the operator's "what should I do next"
     * moment. Three categories:
     *   - chain not healthy yet            → hide; the chain-card itself
     *                                        carries the message
     *   - chain healthy + already registered (producer.state set) → hide;
     *                                        the BPoS panel inside the
     *                                        chain card handles renew /
     *                                        reactivate flows
     *   - chain healthy + not registered    → show the steps
     */
    ValidatorRegistrationCard.prototype._reconcile = function (chain, producer) {
        var alive   = !!(chain && chain.state === 'healthy');
        var pubkey  = producer && producer.ourPubkey;
        var pState  = producer && producer.state;
        var enabled = producer && producer.enabled;

        // Show only when: synced AND (we have a pubkey OR backend says
        // enabled-ish) AND no on-chain producer record yet.
        var shouldShow = alive
            && (enabled || !!pubkey)
            && !pState;

        if (!shouldShow) {
            this.root.hidden = true;
            // If we sped up polling because we expected an imminent state
            // change, slow back down.
            this._setPollInterval(POLL_INTERVAL_MS);
            return;
        }

        this.root.hidden = false;
        // Operator is likely watching for confirmation right now — poll
        // every 5s so the card vanishes the moment producer.state shows up.
        this._setPollInterval(SHORT_POLL_MS);

        // Lazy-render the card body. Pubkey is the only dynamic value
        // post-render — update it inline rather than re-rendering.
        if (!this._rendered) {
            this._render();
            this._rendered = true;
        }
        if (pubkey && pubkey !== this._lastPubkey) {
            this._fillPubkey(pubkey);
            this._lastPubkey = pubkey;
        }
    };

    /** @private */
    ValidatorRegistrationCard.prototype._setPollInterval = function (ms) {
        if (this._pollIntervalMs === ms) { return; }
        this._pollIntervalMs = ms;
        if (this._pollTimer) { clearInterval(this._pollTimer); }
        var self = this;
        this._pollTimer = setInterval(function () { self._poll(); }, ms);
    };

    /** @private */
    ValidatorRegistrationCard.prototype._render = function () {
        var t = root.enmTOrFallback;
        var self = this;

        this.root.innerHTML = ''
            + '<div class="enm-validator-card-head">'
                + '<div class="enm-validator-card-eyebrow">' + escapeHtml(t('validator_card.eyebrow')) + '</div>'
                + '<h2 class="enm-validator-card-title">' + escapeHtml(t('validator_card.title')) + '</h2>'
                + '<p class="enm-validator-card-sub">' + escapeHtml(t('validator_card.sub')) + '</p>'
            + '</div>'

            + '<ol class="enm-validator-steps">'

            // ---- Step 1 — copy the producer public key
            + '<li class="enm-validator-step" data-step="1">'
                + '<div class="enm-validator-step-marker">1</div>'
                + '<div class="enm-validator-step-body">'
                    + '<h3 class="enm-validator-step-title">' + escapeHtml(t('validator_card.step1_title')) + '</h3>'
                    + '<p class="enm-validator-step-help">' + escapeHtml(t('validator_card.step1_help')) + '</p>'
                    + '<div class="enm-validator-pubkey-row">'
                        + '<code class="enm-validator-pubkey" id="enm-vc-pubkey">' + escapeHtml(t('common.loading')) + '</code>'
                        + '<button type="button" class="enm-btn enm-btn-secondary enm-validator-copy" id="enm-vc-copy">'
                            + escapeHtml(t('validator_card.copy')) + '</button>'
                    + '</div>'
                + '</div>'
            + '</li>'

            // ---- Step 2 — Essentials registration (the off-device signing step)
            + '<li class="enm-validator-step" data-step="2">'
                + '<div class="enm-validator-step-marker">2</div>'
                + '<div class="enm-validator-step-body">'
                    + '<h3 class="enm-validator-step-title">' + escapeHtml(t('validator_card.step2_title')) + '</h3>'
                    + '<p class="enm-validator-step-help">' + escapeHtml(t('validator_card.step2_help')) + '</p>'
                    + '<ol class="enm-validator-substeps">'
                        + '<li>' + escapeHtml(t('validator_card.step2_a')) + '</li>'
                        + '<li>' + escapeHtml(t('validator_card.step2_b')) + '</li>'
                        + '<li>' + escapeHtml(t('validator_card.step2_c'))
                            + '<ul class="enm-validator-fields">'
                                + '<li><b>' + escapeHtml(t('validator_card.field_name'))   + '</b> — ' + escapeHtml(t('validator_card.field_name_help')) + '</li>'
                                + '<li><b>' + escapeHtml(t('validator_card.field_pubkey')) + '</b> — ' + escapeHtml(t('validator_card.field_pubkey_help')) + '</li>'
                                + '<li><b>' + escapeHtml(t('validator_card.field_addr'))   + '</b> — ' + escapeHtml(t('validator_card.field_addr_help')) + '</li>'
                                + '<li><b>' + escapeHtml(t('validator_card.field_url'))    + '</b> — ' + escapeHtml(t('validator_card.field_url_help')) + '</li>'
                            + '</ul>'
                        + '</li>'
                        + '<li>' + escapeHtml(t('validator_card.step2_d')) + '</li>'
                    + '</ol>'
                    + '<p class="enm-validator-deposit-note">' + escapeHtml(t('validator_card.deposit_note')) + '</p>'
                + '</div>'
            + '</li>'

            // ---- Step 3 — wait 6 blocks then activate (uses ENM's existing endpoint)
            + '<li class="enm-validator-step" data-step="3">'
                + '<div class="enm-validator-step-marker">3</div>'
                + '<div class="enm-validator-step-body">'
                    + '<h3 class="enm-validator-step-title">' + escapeHtml(t('validator_card.step3_title')) + '</h3>'
                    + '<p class="enm-validator-step-help">' + escapeHtml(t('validator_card.step3_help')) + '</p>'
                    + '<div class="enm-validator-activate-row">'
                        + '<button type="button" class="enm-btn enm-btn-primary" id="enm-vc-activate">'
                            + escapeHtml(t('validator_card.activate_btn')) + '</button>'
                        + '<span class="enm-validator-activate-status" id="enm-vc-activate-status"></span>'
                    + '</div>'
                + '</div>'
            + '</li>'

            + '</ol>';

        // Copy button — clipboard or selection fallback.
        var copyBtn  = this.root.querySelector('#enm-vc-copy');
        var pubkeyEl = this.root.querySelector('#enm-vc-pubkey');
        copyBtn.addEventListener('click', function () {
            var text = self._lastPubkey || pubkeyEl.textContent || '';
            if (!text) { return; }
            var done = function () {
                var prev = copyBtn.textContent;
                copyBtn.textContent = t('validator_card.copied');
                setTimeout(function () { copyBtn.textContent = prev; }, 1200);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(function () {
                    selectInto(pubkeyEl);
                });
            } else {
                selectInto(pubkeyEl);
            }
        });

        // Activate — calls the same endpoint Settings → Tools uses, with
        // the same chain-alive precondition guard at the server side.
        var activateBtn = this.root.querySelector('#enm-vc-activate');
        var activateStatus = this.root.querySelector('#enm-vc-activate-status');
        activateBtn.addEventListener('click', function () {
            activateBtn.disabled = true;
            activateBtn.textContent = t('validator_card.activate_btn_active');
            activateStatus.textContent = '';
            self.api.post('/chains/' + self.chainId + '/bpos/activate').then(function () {
                activateStatus.textContent = t('validator_card.activate_ok');
                activateStatus.style.color = 'var(--success)';
                // Force a fast re-poll so the card hides quickly when
                // producer.state flips to Active on chain.
                self._poll();
            }).catch(function (err) {
                activateStatus.textContent = (err && err.message) || t('common.failed');
                activateStatus.style.color = 'var(--error)';
                activateBtn.disabled = false;
                activateBtn.textContent = t('validator_card.activate_btn');
            });
        });
    };

    /** @private */
    ValidatorRegistrationCard.prototype._fillPubkey = function (pubkey) {
        var el = this.root.querySelector('#enm-vc-pubkey');
        if (el) { el.textContent = pubkey; }
    };

    function selectInto(el) {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmValidatorRegistrationCard = ValidatorRegistrationCard;
}(typeof window !== 'undefined' ? window : globalThis));
