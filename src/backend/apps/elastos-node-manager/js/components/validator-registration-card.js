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
        // alpha.28.1 batch 16 — _destroyed flag so _poll's resolving
        // Promise.all can't write into a detached DOM after destroy().
        this._destroyed = false;
    }

    ValidatorRegistrationCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        // First poll happens immediately; subsequent ones from the interval.
        this._poll();
        // alpha.28.1 batch 28 — migrate to enmUseVisibilityPause so the
        // 30s/5s polls stop when the tab is hidden. Falls back to raw
        // setInterval if the helper failed to load. _setPollInterval
        // below switches between cadences via the same helper.
        this._pollIntervalMs = POLL_INTERVAL_MS;
        this._armPoll(POLL_INTERVAL_MS);
        return this;
    };

    /** @private */
    ValidatorRegistrationCard.prototype._armPoll = function (ms) {
        var self = this;
        if (this._pollPauser) { try { this._pollPauser.stop(); } catch (_) { /* idempotent */ } this._pollPauser = null; }
        if (this._pollTimer)  { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (typeof root !== 'undefined' && typeof root.enmUseVisibilityPause === 'function') {
            this._pollPauser = root.enmUseVisibilityPause(function () { self._poll(); }, ms);
        } else {
            this._pollTimer = setInterval(function () { self._poll(); }, ms);
        }
    };

    ValidatorRegistrationCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._pollPauser) { try { this._pollPauser.stop(); } catch (_) { /* idempotent */ } this._pollPauser = null; }
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    ValidatorRegistrationCard.prototype._poll = function () {
        var self = this;
        // alpha.28.1 batch 48 — flag fetch failures so _reconcile can
        // distinguish "not yet synced" (null + no error flag) from
        // "backend outage" (null + error flag). Previously both paths
        // hid the card with no operator signal; under a persistent
        // 500/401 the operator couldn't tell whether their producer
        // status was unknown or just not-yet-registered.
        // (Round-4 empty/loading/error audit a3ca028e.)
        var chainFailed = false;
        var producerFailed = false;
        Promise.all([
            this.api.get('/chains/' + this.chainId, { skipCache: true })
                .catch(function (err) {
                    // 401 = expired session; suppress operator-visible
                    // noise (boot path owns re-auth). Other statuses
                    // (404 / 500 / network) flag as a real outage.
                    if (!err || err.status !== 401) { chainFailed = true; }
                    return null;
                }),
            this.api.get('/chains/' + this.chainId + '/producer', { skipCache: true })
                .catch(function (err) {
                    if (!err || err.status !== 401) { producerFailed = true; }
                    return null;
                }),
        ]).then(function (results) {
            if (self._destroyed) { return; }
            var chain    = results[0];
            var producer = results[1];
            // If both endpoints failed AND we were already showing the
            // card, leave it as-is instead of hiding (last-known-good
            // wins until the backend recovers). The chain-card next
            // to us already surfaces backend outage state, so we don't
            // need a second indicator — just don't lie by hiding.
            if (chainFailed && producerFailed && !self.root.hidden) {
                return;
            }
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
            // a11y/focus: if the operator was focused inside this card
            // (e.g. on Activate or the Copy button) when polling decides
            // to hide it, focus drops to body. Move focus to a stable
            // landmark first so the next Tab makes sense.
            try {
                if (this.root && this.root.contains && this.root.contains(document.activeElement)) {
                    var fallback = document.getElementById('enm-tech-pane-status')
                        || document.getElementById('enm-pane-dashboard')
                        || document.getElementById('enm-main');
                    if (fallback && typeof fallback.focus === 'function') {
                        fallback.focus({ preventScroll: true });
                    }
                }
            } catch (e) { /* DOM may not be live during teardown */ }
            this.root.hidden = true;
            // If we sped up polling because we expected an imminent state
            // change, slow back down.
            this._setPollInterval(POLL_INTERVAL_MS);
            return;
        }

        // Re-show recovery: if the card was previously hidden mid-activate,
        // the Activate button may still be in its disabled/"Activating…"
        // state. Reset to the resting label so the operator can retry —
        // BUT only when enmRunOnce isn't currently single-flight-blocking
        // the button. (Round-11 race audit B7: a poll resolve that
        // re-shows the card while the Activate POST is in flight would
        // re-enable the button mid-request → double-click possible →
        // the second click hits a still-pending /bpos/activate.)
        if (this.root.hidden && this._rendered) {
            var btn = this.root.querySelector('#enm-vc-activate');
            if (btn && btn.dataset.busy !== '1') {
                btn.disabled = false;
                btn.textContent = root.enmTOrFallback('validator_card.activate_btn');
            }
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
        // alpha.28.1 batch 28 — route through _armPoll so the cadence
        // switch reuses the visibility-pause wrapper.
        this._armPoll(ms);
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
                        // alpha.29 batch 96 — copy button now rendered via
                        // root.enmCopyButton (factory primitive) at post-
                        // mount time below. The empty placeholder span
                        // marks where to insert.
                        + '<span class="enm-validator-copy-slot"></span>'
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
                        + '<span class="enm-validator-activate-status" id="enm-vc-activate-status" role="status" aria-live="polite"></span>'
                    + '</div>'
                + '</div>'
            + '</li>'

            + '</ol>';

        // alpha.29 batch 96 — copy button created via root.enmCopyButton
        // (utils.js factory) instead of the previous 25-line hand-wired
        // pattern. Same UX: text-swap on success, selectInto + warning
        // toast on fallback. Round-33 architectural triage — proves the
        // factory pattern at the cleanest call site first; remaining 4
        // sites migrate in follow-up batches.
        var pubkeyEl = this.root.querySelector('#enm-vc-pubkey');
        var copyBtn = root.enmCopyButton({
            value: function () { return self._lastPubkey || pubkeyEl.textContent || ''; },
            label: t('validator_card.copy'),
            copiedLabel: t('validator_card.copied'),
            ariaLabel: t('validator_card.copy_aria'),
            resetMs: 1200,
            notifications: self.notifications,
            failTitle: t('validator_card.copy_fail_title'),
            failBody: t('validator_card.copy_fail_body'),
            getDisplayEl: function () { return pubkeyEl; },
        });
        copyBtn.id = 'enm-vc-copy';
        copyBtn.classList.add('enm-validator-copy');
        var slot = this.root.querySelector('.enm-validator-copy-slot');
        if (slot && slot.parentNode) { slot.parentNode.replaceChild(copyBtn, slot); }

        // Activate — calls the same endpoint Settings → Tools uses, with
        // the same chain-alive precondition guard at the server side.
        // Routed through enmRunOnce (batch 6) so a double-click can't
        // POST /bpos/activate twice — was the only mutating button in
        // the codebase still using a hand-rolled disabled toggle.
        var activateBtn = this.root.querySelector('#enm-vc-activate');
        var activateStatus = this.root.querySelector('#enm-vc-activate-status');
        var runOnce = root.enmRunOnce;
        activateBtn.addEventListener('click', function () {
            var activatingLabel = t('validator_card.activate_btn_active');
            var fallback = function (fn) { return fn(); };
            // Always call enmRunOnce when available; degrade gracefully
            // if the helper failed to load.
            (runOnce || fallback)(activateBtn, activatingLabel, function () {
                activateStatus.textContent = '';
                return self.api.post('/chains/' + self.chainId + '/bpos/activate').then(function () {
                    // alpha.28.1 batch 86 (Round-26 finding #3) —
                    // _destroyed guard on both then/catch branches so
                    // a teardown during the in-flight POST doesn't
                    // mutate detached DOM (activateStatus.textContent
                    // and the _poll() call kick).
                    if (self._destroyed) { return; }
                    activateStatus.textContent = t('validator_card.activate_ok');
                    // alpha.28.1 batch 28 — use --success-strong instead of
                    // --success. The strong variant ships a darker green
                    // (#1f8a3c vs #34c759) which clears WCAG 1.4.3 AA
                    // contrast against --bg-elevated. The pale-success
                    // earlier failed the audit at ~3:1; activate_ok is
                    // a one-shot confirmation message and must be
                    // readable. (PR cleanup audit a95877fe.)
                    activateStatus.style.color = 'var(--success-strong, var(--success))';
                    // Force a fast re-poll so the card hides quickly when
                    // producer.state flips to Active on chain.
                    self._poll();
                }).catch(function (err) {
                    if (self._destroyed) { return; }
                    activateStatus.textContent = (err && err.message) || t('common.failed');
                    activateStatus.style.color = 'var(--error-strong, var(--error))';
                });
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
