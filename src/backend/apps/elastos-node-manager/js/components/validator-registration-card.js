/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/validator-registration-card.js — BPoS supernode operator
 * card for the Dashboard pane. (Beta 3 rewrite — from phase-03 mock.)
 *
 * Replaces the alpha.27 "three-step Essentials guide" card with the
 * compact .bpos-card layout from enm-design-mocks/v2/phase-03-status.html
 * (variant D, lines ~742-760). Two visual states:
 *
 *   A) Not yet registered  → .enm-bpos-head with "Action required" chip +
 *                            .enm-bpos-cta-card prompting the operator to
 *                            copy their public key, open the Essentials
 *                            guide, and wait for chain confirmation.
 *                            .enm-bpos-signing-key block holds the pubkey
 *                            in a monospace <pre>, easy to read/select.
 *
 *   B) Registered, awaiting activation → "Ready to activate" chip +
 *                            single Activate button. ENM signs the
 *                            activation tx locally with the existing
 *                            keystore — no wallet round-trip.
 *
 * Once /producer reports state Active the card hides automatically; the
 * Identity sub-tab + maintenance row carry steady-state BPoS info.
 *
 * Architectural invariant (memory: feedback_enm_wallet_identity_only) —
 * ENM NEVER asks the browser wallet to sign anything. Registration is
 * signed in Elastos Essentials mobile. Activation is signed by
 * keystore.dat on this server via ela-cli. The browser wallet is
 * identity-only for ownership + audit attribution.
 *
 * Data sources:
 *   - GET /chains/:id            → coarse chain state (must be 'healthy')
 *   - GET /chains/:id/producer   → ourPubkey, state, enabled
 *   - POST /chains/:id/bpos/activate → activation tx (chain-side signed)
 *   - SSE topic chains:<chainId>:producer → push-driven state refresh
 *     when the backend ships it; falls back to the visibility-paused
 *     poll otherwise.
 *
 * alpha.28 invariants preserved:
 *   - _destroyed guard on every async .then/.catch resolution
 *   - encodeURIComponent on every dynamic path segment
 *   - 401-suppress on background fetches (boot path owns re-auth)
 *   - Conflict-envelope shape validation on 409 (batch 68 pattern)
 *   - Visibility-paused polling (batch 27/28 — stops while tab hidden)
 *   - enmRunOnce wrap on the activate button (double-click safe)
 *   - 401-disable-restore finalizer pattern (batch 60)
 *   - enmCopyButton factory for the public-key copy (alpha.29 batch 96)
 *   - 24×24 minimum touch-target floor on every actionable button
 *   - aria-labelledby on the card root + aria-live on the state chip
 */

(function (root) {
    'use strict';

    var POLL_INTERVAL_MS = 30_000;
    var SHORT_POLL_MS    = 5_000;   // faster cadence while we're showing
                                    // and an imminent state flip is plausible

    // Map producer.state strings into one of the two render branches.
    // The mock supports two action-ready variants only; steady-state
    // (Active / Inactive while registered + active) hides the card.
    var STATE_NEEDS_REGISTRATION = 'needs_registration';
    var STATE_NEEDS_ACTIVATION   = 'needs_activation';
    var STATE_HIDE               = 'hide';

    function BposCard(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('EnmBposCard: { api } required');
        }
        this.api           = opts.api;
        this.chainId       = opts.chainId || 'mainchain';
        this.notifications = opts.notifications || null;
        this.sse           = opts.sse || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-bpos-card';
        this.root.hidden = true; // hidden until reconcile says "show me"
        // a11y — card-level region semantics. aria-labelledby points at
        // the head title we render in _render; aria-live="polite" on the
        // chip means a state transition (A → B) is announced once the
        // chip's text content changes.
        this.root.setAttribute('role', 'region');

        this._titleId = 'enm-bpos-title-' + Math.random().toString(36).slice(2, 8);
        this._chipId  = 'enm-bpos-chip-'  + Math.random().toString(36).slice(2, 8);

        this._renderedState = null;        // last state we rendered for
        this._lastPubkey    = null;
        this._pollIntervalMs = POLL_INTERVAL_MS;
        this._destroyed = false;
        this._unsubscribeProducer = null;
        this._pollPauser = null;
        this._pollTimer = null;
    }

    /**
     * Mount the card into the supplied parent and kick the initial
     * /producer fetch. Subscribes to the SSE producer topic when an
     * sse service is available; otherwise falls back to the
     * visibility-paused poll.
     *
     * @param {HTMLElement} parent
     * @returns {BposCard}
     */
    BposCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        // Initial poll happens immediately; subsequent ones from the
        // visibility-paused interval below.
        this._poll();
        this._armPoll(POLL_INTERVAL_MS);

        // SSE push — the backend ships chains:<id>:producer when the
        // producer record changes (registration confirms on chain,
        // activation lands, slot rank shifts). When we get an event we
        // re-fetch; the SSE event payload is treated as a signal, not
        // a source of truth, so the renderer never reads it directly.
        if (this.sse && typeof this.sse.subscribe === 'function') {
            this._unsubscribeProducer = this.sse.subscribe(
                'chains:' + encodeURIComponent(this.chainId) + ':producer',
                function () {
                    if (self._destroyed) { return; }
                    self._poll();
                }
            );
        }
        return this;
    };

    /**
     * Force a fresh fetch of /chains/:id + /chains/:id/producer and
     * re-reconcile the card visibility. Safe to call externally
     * (technical-view's tools-gate poll re-uses the same data).
     */
    BposCard.prototype.refresh = function () {
        this._poll();
    };

    /**
     * Tear down the card, clear timers, unsubscribe from SSE, drop
     * the root element. Idempotent — safe to call twice.
     */
    BposCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._unsubscribeProducer) {
            try { this._unsubscribeProducer(); } catch (_) { /* idempotent */ }
            this._unsubscribeProducer = null;
        }
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
    BposCard.prototype._armPoll = function (ms) {
        var self = this;
        if (this._pollPauser) {
            try { this._pollPauser.stop(); } catch (_) { /* idempotent */ }
            this._pollPauser = null;
        }
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (typeof root !== 'undefined' && typeof root.enmUseVisibilityPause === 'function') {
            this._pollPauser = root.enmUseVisibilityPause(function () { self._poll(); }, ms);
        } else {
            this._pollTimer = setInterval(function () { self._poll(); }, ms);
        }
    };

    /** @private */
    BposCard.prototype._setPollInterval = function (ms) {
        if (this._pollIntervalMs === ms) { return; }
        this._pollIntervalMs = ms;
        this._armPoll(ms);
    };

    /** @private */
    BposCard.prototype._poll = function () {
        var self = this;
        // alpha.28.1 batch 48 — distinguish "not yet synced" (null + no
        // error flag) from "backend outage" (null + error flag). The
        // outage branch keeps the existing render rather than hiding,
        // so the operator doesn't get a false "all good" signal.
        var chainFailed = false;
        var producerFailed = false;
        var chainPath = '/chains/' + encodeURIComponent(this.chainId);
        var producerPath = chainPath + '/producer';
        Promise.all([
            this.api.get(chainPath, { skipCache: true })
                .catch(function (err) {
                    // 401 = expired session; suppress operator-visible
                    // noise (boot path owns re-auth). Anything else
                    // flags as a real outage so _reconcile keeps the
                    // last-known-good UI.
                    if (!err || err.status !== 401) { chainFailed = true; }
                    return null;
                }),
            this.api.get(producerPath, { skipCache: true })
                .catch(function (err) {
                    if (!err || err.status !== 401) { producerFailed = true; }
                    return null;
                }),
        ]).then(function (results) {
            if (self._destroyed) { return; }
            var chain    = results[0];
            var producer = results[1];
            if (chainFailed && producerFailed && !self.root.hidden) {
                // Both fetches failed — leave the last-known-good
                // render in place rather than misleading the operator
                // by hiding. The chain-card next to us already
                // surfaces the outage.
                return;
            }
            self._reconcile(chain, producer);
        });
    };

    /**
     * Decide which branch (hide / not-registered / awaiting-activation)
     * to show and render it. The decision tree:
     *
     *   chain not 'healthy'                  → hide (chain-card carries it)
     *   producer.state === 'Active'          → hide (steady state, no CTA)
     *   producer.state set but not Active +
     *     producer.enabled and pubkey known  → STATE_NEEDS_ACTIVATION (B)
     *   producer.state empty/null +
     *     producer.enabled and pubkey known  → STATE_NEEDS_REGISTRATION (A)
     *
     * @private
     */
    BposCard.prototype._reconcile = function (chain, producer) {
        var alive    = !!(chain && chain.state === 'healthy');
        var pubkey   = (producer && producer.ourPubkey) || '';
        var pState   = producer && producer.state;
        var enabled  = !!(producer && producer.enabled);

        // BPoS card only makes sense for arbiter-enabled nodes. The
        // operator may flip enableArbiter off via Settings; when that
        // happens the card disappears and the steady-state plain-node
        // chain-card carries the dashboard alone.
        var bposOperator = enabled || !!pubkey;
        if (!alive || !bposOperator) {
            this._hideAndRest();
            return;
        }

        // Already steady-state Active producer → nothing for this card
        // to do. The Identity sub-tab + tools-gate Reactivate row
        // handle inactive-rounds + slashing recovery.
        if (pState && String(pState).toLowerCase() === 'active') {
            this._hideAndRest();
            return;
        }

        // Registered but not Active → operator needs to tap Activate.
        // Registration absent → operator needs to copy their pubkey
        // and complete registration in Essentials.
        var nextState = pState
            ? STATE_NEEDS_ACTIVATION
            : STATE_NEEDS_REGISTRATION;

        // Focus continuity — if the card was hidden mid-activate and a
        // poll re-shows it, the Activate button's _runOnce finalizer
        // already restored the resting label. We only need to track
        // pubkey changes and re-render on state transitions.
        this._show(nextState, pubkey);
    };

    /** @private */
    BposCard.prototype._hideAndRest = function () {
        // a11y/focus — if the operator was focused inside the card when
        // a poll decided to hide it (e.g. on the Activate button or the
        // copy button), focus drops to body. Move it to a stable
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
        // Slow back down — nothing is imminent.
        this._setPollInterval(POLL_INTERVAL_MS);
    };

    /** @private */
    BposCard.prototype._show = function (state, pubkey) {
        // Faster cadence while visible — operator is likely watching
        // for the registration / activation confirmation right now.
        this._setPollInterval(SHORT_POLL_MS);
        this.root.hidden = false;
        if (this._renderedState !== state) {
            this._render(state);
            this._renderedState = state;
        }
        if (pubkey && pubkey !== this._lastPubkey) {
            this._fillPubkey(pubkey);
            this._lastPubkey = pubkey;
        }
    };

    /**
     * Build the card body for the given state.
     *
     * State A (needs_registration):
     *   .enm-bpos-head            (accent icon + body + warn chip)
     *   .enm-bpos-cta-card        (help + copy-pubkey + open-essentials)
     *     .enm-bpos-signing-key   (pubkey <pre>)
     *   .enm-bpos-note            (info footnote, "card disappears…")
     *
     * State B (needs_activation):
     *   .enm-bpos-head            (success icon + body + ready chip)
     *   .enm-bpos-cta-card        (single Activate button)
     *
     * @private
     */
    BposCard.prototype._render = function (state) {
        // alpha.28 batch 33 — aria-labelledby points at the head-title
        // we emit inside .enm-bpos-head-body; update before innerHTML
        // is written so the AT tree sees the relation immediately.
        this.root.setAttribute('aria-labelledby', this._titleId);

        if (state === STATE_NEEDS_ACTIVATION) {
            this._renderActivation();
            return;
        }
        // Default (and the most common dashboard surface): not-registered.
        this._renderRegistration();
    };

    /** @private */
    BposCard.prototype._renderRegistration = function () {
        var t = root.enmTOrFallback;
        var self = this;
        var titleId = this._titleId;
        var chipId  = this._chipId;

        this.root.innerHTML = ''
            + '<div class="enm-bpos-head">'
                // Accent rounded box with ⚡ glyph — see phase-03 mock,
                // .enm-bpos-head-icon variant for action-needed.
                + '<div class="enm-bpos-head-icon" aria-hidden="true">'
                    + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
                        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
                        + 'stroke-linejoin="round">'
                        + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>'
                    + '</svg>'
                + '</div>'
                + '<div class="enm-bpos-head-body">'
                    + '<div class="enm-bpos-head-title" id="' + escapeAttr(titleId) + '">'
                        + escapeHtml(t('bpos_card.head_title_register'))
                    + '</div>'
                    + '<div class="enm-bpos-head-sub">'
                        + escapeHtml(t('bpos_card.head_sub_register'))
                    + '</div>'
                + '</div>'
                // aria-live=polite — when the chip text changes (A → B),
                // screen readers announce the transition without
                // interrupting the operator. Stays polite (not assertive)
                // because the change is a confirmation, not an emergency.
                + '<span class="enm-bpos-head-chip warn" id="' + escapeAttr(chipId) + '" '
                    + 'role="status" aria-live="polite">'
                    + escapeHtml(t('bpos_card.chip_action_required'))
                + '</span>'
            + '</div>'

            + '<div class="enm-bpos-cta-card">'
                + '<p class="enm-bpos-cta-help">'
                    + escapeHtml(t('bpos_card.cta_help_register'))
                + '</p>'
                + '<div class="enm-bpos-cta-row">'
                    // Copy-pubkey button — replaced post-render with the
                    // enmCopyButton factory so we inherit the aria-hidden
                    // visible-span pattern + clipboard fallback.
                    + '<span class="enm-bpos-copy-slot"></span>'
                    + '<button type="button" '
                        + 'class="enm-btn enm-bpos-open-essentials">'
                        + escapeHtml(t('bpos_card.open_essentials_btn'))
                    + '</button>'
                + '</div>'
                + '<div class="enm-bpos-signing-key">'
                    + '<div class="enm-bpos-signing-key-label">'
                        + escapeHtml(t('bpos_card.signing_key_label'))
                    + '</div>'
                    + '<pre class="enm-bpos-signing-key-value" id="enm-bpos-pubkey">'
                        + escapeHtml(t('common.loading'))
                    + '</pre>'
                + '</div>'
            + '</div>'

            + '<div class="enm-bpos-note">'
                + escapeHtml(t('bpos_card.note_after_confirm'))
            + '</div>';

        // Replace the copy slot with the enmCopyButton factory. The
        // factory hands back a fully-wired <button> with aria-hidden
        // inner span + clipboard fallback + select-into-display
        // graceful degradation (alpha.29 batch 96 pattern).
        var pubkeyEl = this.root.querySelector('#enm-bpos-pubkey');
        var copyBtn;
        if (typeof root.enmCopyButton === 'function') {
            copyBtn = root.enmCopyButton({
                value: function () {
                    // Resolve fresh at click time so a /producer push
                    // that arrives between render and click hands the
                    // latest pubkey to the clipboard.
                    return self._lastPubkey || (pubkeyEl && pubkeyEl.textContent) || '';
                },
                label:        root.enmTOrFallback('bpos_card.copy_pubkey_btn'),
                copiedLabel:  root.enmTOrFallback('bpos_card.copied'),
                ariaLabel:    root.enmTOrFallback('bpos_card.copy_aria'),
                resetMs:      1200,
                notifications: self.notifications,
                failTitle:    root.enmTOrFallback('bpos_card.copy_fail_title'),
                failBody:     root.enmTOrFallback('bpos_card.copy_fail_body'),
                getDisplayEl: function () { return pubkeyEl; },
                className:    'enm-btn-primary enm-bpos-copy-pubkey',
            });
        } else {
            // Defensive — utils.js failed to load. Provide a minimal
            // button so the card is still functional.
            copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'enm-btn enm-btn-primary enm-bpos-copy-pubkey';
            copyBtn.textContent = root.enmTOrFallback('bpos_card.copy_pubkey_btn');
            copyBtn.addEventListener('click', function () {
                var value = self._lastPubkey || (pubkeyEl && pubkeyEl.textContent) || '';
                if (!value) { return; }
                if (typeof root.enmCopyToClipboard === 'function') {
                    root.enmCopyToClipboard(String(value), {
                        notifications: self.notifications,
                        notifyOnSuccess: true,
                        successTitle: root.enmTOrFallback('bpos_card.copied'),
                    });
                } else if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(String(value)).then(function () {
                        if (self.notifications) {
                            self.notifications.info(
                                root.enmTOrFallback('bpos_card.copied'),
                                ''
                            );
                        }
                    }, function () { /* swallow — fallback already covered */ });
                }
            });
        }
        copyBtn.id = 'enm-bpos-copy-pubkey';
        var slot = this.root.querySelector('.enm-bpos-copy-slot');
        if (slot && slot.parentNode) { slot.parentNode.replaceChild(copyBtn, slot); }

        // "Open Essentials guide" — stub for Beta 3. Surfaces a
        // notifications.info with a brief deep-link instruction; the
        // actual `essentials://` deep link integration lands in a
        // follow-up. Memory: feedback_enm_wallet_identity_only — the
        // wallet is identity-only, no signing here.
        var essentialsBtn = this.root.querySelector('.enm-bpos-open-essentials');
        if (essentialsBtn) {
            essentialsBtn.addEventListener('click', function () {
                if (self._destroyed) { return; }
                if (self.notifications) {
                    self.notifications.info(
                        root.enmTOrFallback('bpos_card.essentials_guide_title'),
                        root.enmTOrFallback('bpos_card.essentials_guide_body')
                    );
                }
            });
        }
    };

    /** @private */
    BposCard.prototype._renderActivation = function () {
        var t = root.enmTOrFallback;
        var self = this;
        var titleId = this._titleId;
        var chipId  = this._chipId;

        this.root.innerHTML = ''
            + '<div class="enm-bpos-head">'
                // Success palette icon — checkmark glyph. The same
                // .enm-bpos-head-icon CSS class with .success modifier
                // (the variant defined in the v2 mock at ~line 192).
                + '<div class="enm-bpos-head-icon success" aria-hidden="true">'
                    + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
                        + 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
                        + 'stroke-linejoin="round">'
                        + '<polyline points="20 6 9 17 4 12"></polyline>'
                    + '</svg>'
                + '</div>'
                + '<div class="enm-bpos-head-body">'
                    + '<div class="enm-bpos-head-title" id="' + escapeAttr(titleId) + '">'
                        + escapeHtml(t('bpos_card.head_title_activation'))
                    + '</div>'
                    + '<div class="enm-bpos-head-sub">'
                        + escapeHtml(t('bpos_card.head_sub_activation'))
                    + '</div>'
                + '</div>'
                + '<span class="enm-bpos-head-chip" id="' + escapeAttr(chipId) + '" '
                    + 'role="status" aria-live="polite">'
                    + escapeHtml(t('bpos_card.chip_ready_to_activate'))
                + '</span>'
            + '</div>'

            + '<div class="enm-bpos-cta-card">'
                + '<button type="button" class="enm-btn enm-btn-primary enm-bpos-activate" '
                    + 'id="enm-bpos-activate">'
                    + escapeHtml(t('bpos_card.activate_btn'))
                + '</button>'
            + '</div>';

        var activateBtn = this.root.querySelector('#enm-bpos-activate');
        if (activateBtn) {
            activateBtn.addEventListener('click', function () {
                self._activate(activateBtn);
            });
        }
    };

    /**
     * POST /chains/:id/bpos/activate. enmRunOnce wraps the button so a
     * double-click can't fire the request twice; the finalizer clears
     * busy + disabled even if the promise rejects.
     *
     * @private
     * @param {HTMLButtonElement} btn
     */
    BposCard.prototype._activate = function (btn) {
        var self = this;
        var t = root.enmTOrFallback;
        var activatingLabel = t('bpos_card.activate_btn_active');
        var fallback = function (fn) { return fn(); };
        var runOnce = root.enmRunOnce || fallback;

        runOnce(btn, activatingLabel, function () {
            var path = '/chains/' + encodeURIComponent(self.chainId) + '/bpos/activate';
            return self.api.post(path).then(function () {
                // alpha.28.1 batch 86 — _destroyed guard on both
                // success and failure branches so a teardown mid-POST
                // doesn't mutate detached DOM.
                if (self._destroyed) { return; }
                if (self.notifications) {
                    self.notifications.info(
                        t('bpos_card.activate_ok_title'),
                        t('bpos_card.activate_ok_body')
                    );
                }
                // Force a fast re-poll so the card hides quickly when
                // /producer flips to Active on chain (we already have
                // SHORT_POLL_MS armed, but a manual kick removes the
                // up-to-5s lag).
                self._poll();
            }).catch(function (err) {
                if (self._destroyed) { return; }
                // 401 = expired session; boot path owns re-auth.
                if (err && err.status === 401) { return; }
                // alpha.28.1 batch 68 — conflict envelope shape
                // validation. The activate route returns 409 with
                // `{ conflicts: [{ severity, description, remediation }] }`
                // when the chain isn't ready (already-active, not-yet-
                // registered, deposit-unfunded, etc). Drop straight
                // into the critical-toast branch with the same
                // formatting chain-card uses for start/stop conflicts.
                if (err && err.body && Array.isArray(err.body.conflicts)
                    && err.body.conflicts.length > 0) {
                    var blockers = err.body.conflicts.filter(function (c) {
                        return c && c.severity === 'CRITICAL';
                    });
                    var summary = blockers.map(function (c) {
                        var firstStep = (c.remediation && c.remediation[0]);
                        var stepStr = (typeof firstStep === 'string' && firstStep.length > 0)
                            ? firstStep : '';
                        var descStr = (typeof c.description === 'string' && c.description.length > 0)
                            ? c.description : 'Activation blocked';
                        return '• ' + descStr + (stepStr ? ('\n   ' + stepStr) : '');
                    }).join('\n');
                    if (self.notifications) {
                        self.notifications.critical(
                            t('bpos_card.activate_conflict_title'),
                            summary
                        );
                    }
                    return;
                }
                if (self.notifications) {
                    self.notifications.warning(
                        t('bpos_card.activate_fail_title'),
                        (err && err.message) ? err.message : t('common.failed')
                    );
                }
            });
        });
    };

    /** @private */
    BposCard.prototype._fillPubkey = function (pubkey) {
        var el = this.root.querySelector('#enm-bpos-pubkey');
        if (el) { el.textContent = pubkey; }
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // Beta 3 export name. The constructor is the BPoS operator card;
    // EnmValidatorRegistrationCard alias is retained for backward
    // compatibility with technical-view.js (which still calls
    // `new root.EnmValidatorRegistrationCard(common)`) and any other
    // consumer that hasn't migrated yet. Renaming the consumer site
    // is a follow-up; both names point at the same constructor today.
    root.EnmBposCard = BposCard;
    root.EnmValidatorRegistrationCard = BposCard;
}(typeof window !== 'undefined' ? window : globalThis));
