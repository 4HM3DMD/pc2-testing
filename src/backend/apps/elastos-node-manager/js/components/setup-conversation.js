/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/setup-conversation.js — Beta 3 setup wizard.
 *
 * Reshaped from the alpha.28 conversational 6-step wizard to match the
 * v2/phase-06-wizard-modals.html mock. The DOM contract is now:
 *
 *   .enm-wiz-shell
 *     .enm-wiz-body           ← swaps per-card (role grid, install
 *                                progress, bootstrap tiles, clock-skew,
 *                                password reveal, celebration)
 *     .enm-setup-actions      ← footer with Cancel (hidden when N/A) +
 *                                Continue / primary CTA
 *
 * Card A (role chooser) is the new welcome experience — there's no
 * separate welcome-screen step any more; welcome-screen.js is a thin
 * shim that just constructs this component. Card A renders the
 * BPoS / Council .enm-role-grid with `data-selected`/`data-disabled`
 * exactly like the mock. The operator picks BPoS (Council is "Coming
 * soon"), then clicks Continue to kick `_startAutoInstall`, which is
 * the SAME pipeline alpha.28's user-driven Card B/B2/B3/C/D walked
 * one step at a time — re-routed so the new mock's single-screen
 * entry path can drive it from end to end.
 *
 * The five downstream cards (B, B2, B3, C, D) keep their existing
 * behaviours and lifecycle guards:
 *   - install (binary fetch + SSE/poll progress; cancel hits
 *     DELETE /setup/auto-install-ela)
 *   - bootstrap-vs-genesis (Card B2; snapshot download with cancel)
 *   - clock-skew preflight (Card B3; F13 NTP check)
 *   - keystore password reveal (Card C; ack-gated continue)
 *   - finalize + start chain (Card D; celebrates + onComplete)
 *
 * The alpha.28 invariants live on:
 *   - `_destroyed` flag flipped FIRST in destroy() so any in-flight
 *     SSE/poll/HTTP callbacks short-circuit
 *   - `_cardSeq` bumped on every body swap; `_stillRendering(seq)`
 *     gates every async .then so stale resolves can't mutate the
 *     new card's DOM
 *   - `_teardownInstallTracking` / bootstrap-teardown both run on
 *     destroy and on _goto out of Card B/B2 (prevents poll-after-
 *     navigate)
 *   - 401 on /setup/install-status polls is suppressed (catch swallows
 *     so the operator doesn't see a forbidden toast during the brief
 *     window between owner-pair and first authenticated request)
 *   - SSE `setup:install:mainchain` / `setup:bootstrap:mainchain`
 *     topic subscriptions with poll fallback
 *   - Clock-skew probe always renders a continue path (the wizard
 *     MUST NEVER deadlock on F13)
 *   - Cross-tab BC: setup-complete broadcast handled in app.js;
 *     _setupConv is stored on app so destroy() can fire on broadcast
 *
 * The 9-step alpha.1 wizard and its `_goal === 'help'` branch are
 * permanently retired — ENM is positioned for BPoS + Council operators
 * only. Existing installs whose backend state has enableArbiter=false
 * load as 'bpos' on resume.
 */

(function (root) {
    'use strict';

    function SetupConversation(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('SetupConversation: { api, notifications, sse } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications || null;
        this.sse = opts.sse || null;
        this.announcer = opts.announcer || (root.enmAnnouncer || null);
        this.onComplete = typeof opts.onComplete === 'function'
            ? opts.onComplete
            : function () {};
        this.onCancel = typeof opts.onCancel === 'function'
            ? opts.onCancel
            : null;

        this.root = document.createElement('section');
        this.root.className = 'enm-wiz-shell';
        // role=region so the wizard reads as a named landmark in
        // screen-reader rotors. aria-labelledby set after the heading
        // mounts (per-card).
        this.root.setAttribute('role', 'region');
        this.root.setAttribute('aria-label', 'Setup wizard');

        this._goal = null;            // 'bpos' | 'council' (council is disabled today)
        this._currentCard = 'a';      // which card is showing
        this._cardSeq = 0;            // bump on every render to ignore stale callbacks
        this._unsubscribeInstall = null;
        this._unsubscribeBootstrap = null;
        this._installPollTimer = null;
        this._bootstrapPollTimer = null;
        // alpha.28.1 batch 83 — _destroyed flag so async resolves and
        // SSE callbacks can short-circuit if destroy() fires between
        // a poll dispatch and its .then. Symmetric with the original
        // alpha.28 setup-conversation; central to every async branch
        // in this file.
        this._destroyed = false;
    }

    /**
     * Cancel any in-flight install poll + SSE subscription. Called from
     * destroy() and from internal transitions that abandon Card B's
     * progress UI. Without this the IIFE poll outlives navigation and
     * applies status to a DOM the user has navigated away from.
     */
    SetupConversation.prototype._teardownInstallTracking = function () {
        if (this._installPollTimer) {
            clearTimeout(this._installPollTimer);
            this._installPollTimer = null;
        }
        if (this._unsubscribeInstall) {
            try { this._unsubscribeInstall(); } catch (_) { /* ignore */ }
            this._unsubscribeInstall = null;
        }
    };

    /** Symmetric helper for Card B2's bootstrap poll + SSE. */
    SetupConversation.prototype._teardownBootstrapTracking = function () {
        if (this._bootstrapPollTimer) {
            clearInterval(this._bootstrapPollTimer);
            this._bootstrapPollTimer = null;
        }
        if (this._unsubscribeBootstrap) {
            try { this._unsubscribeBootstrap(); } catch (_) { /* ignore */ }
            this._unsubscribeBootstrap = null;
        }
    };

    SetupConversation.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._renderShell();
        var self = this;
        // Recovery: jump to the right card based on what already exists.
        // Without this, an operator who refreshes the page mid-install
        // would be sent back to Card A and lose context.
        this.api.get('/setup/state', { skipCache: true }).then(function (s) {
            if (self._destroyed) { return; }
            self._resumeFromState(s);
        }).catch(function () {
            if (self._destroyed) { return; }
            self._goto('a');
        });
        return this;
    };

    SetupConversation.prototype.destroy = function () {
        // alpha.28.1 batch 83 — flip flag FIRST so any in-flight poll/SSE
        // callbacks can see it before they mutate detached DOM.
        this._destroyed = true;
        this._teardownInstallTracking();
        this._teardownBootstrapTracking();
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    SetupConversation.prototype._renderShell = function () {
        // Two-region shell. The body region is swapped per card; the
        // footer (.enm-setup-actions) is a stable element whose Cancel/
        // Continue buttons mutate per card. Keeping the footer outside
        // the swap means screen-reader focus rings on the action row
        // don't blink off between card transitions.
        this.root.innerHTML =
            '<div class="enm-wiz-body"></div>'
            + '<div class="enm-setup-actions">'
              + '<button type="button" class="enm-btn enm-btn-secondary enm-setup-cancel" hidden></button>'
              + '<button type="button" class="enm-btn enm-btn-primary enm-setup-continue" disabled></button>'
            + '</div>';
        this._body         = this.root.querySelector('.enm-wiz-body');
        this._cancelBtn    = this.root.querySelector('.enm-setup-cancel');
        this._continueBtn  = this.root.querySelector('.enm-setup-continue');
    };

    /** @private */
    SetupConversation.prototype._resumeFromState = function (s) {
        // Already done? Skip the wizard entirely.
        // Truthy check — SQLite stores `completed: 1` not `=== true`.
        if (s && s.completed) {
            this.onComplete(s);
            return;
        }

        var step = (s && s.currentStep) || 'welcome';
        if (step === 'install' || step === 'preflight' || step === 'welcome') {
            // Fresh install: land on the role chooser.
            this._goto('a');
        } else if (step === 'bootstrap') {
            // Binary in place, bootstrap-vs-genesis pending.
            this._goal = 'bpos';
            this._goto('b2');
        } else if (step === 'keystore') {
            this._goal = 'bpos';
            this._goto('c');
        } else if (step === 'network' || step === 'confirm' || step === 'complete') {
            this._goal = 'bpos';
            this._goto('d');
        } else {
            // Unknown step value (schema drift, garbage response) —
            // fail safe by starting from the top.
            this._goto('a');
        }
    };

    /** @private */
    SetupConversation.prototype._goto = function (card) {
        // alpha.28.1 batch 70/83 — tear down any in-flight Card-B
        // install tracking BEFORE swapping _currentCard. A tick already
        // in flight could still resolve into a stale DOM reference if
        // we relied on _currentCard alone, so we explicitly cancel the
        // timer + SSE here.
        if (this._currentCard === 'b' && card !== 'b') {
            this._teardownInstallTracking();
        }
        if (this._currentCard === 'b2' && card !== 'b2') {
            this._teardownBootstrapTracking();
        }
        this._currentCard = card;
        this._cardSeq += 1;
        var seq = this._cardSeq;
        this._body.innerHTML = '';
        // Reset footer to default hidden-Cancel + disabled-Continue.
        // Cards opt in by mutating these refs.
        this._resetFooter();

        if (card === 'a')       { this._renderCardA(seq); }
        else if (card === 'b')  { this._renderCardB(seq); }
        else if (card === 'b2') { this._renderCardB2(seq); }
        else if (card === 'b3') { this._renderCardB3(seq); }
        else if (card === 'c')  { this._renderCardC(seq); }
        else if (card === 'd')  { this._renderCardD(seq); }

        // a11y/focus: every card swap re-renders `_body.innerHTML`,
        // destroying the previously-focused control. Without an
        // explicit landing, focus drops to body and screen readers
        // don't announce that the wizard advanced. Move focus to the
        // new card's heading (with a temporary tabindex so it accepts
        // programmatic focus), and let the user Tab forward from there.
        try {
            var heading = this._body.querySelector('.enm-wiz-heading')
                || this._body.querySelector('h2, h3');
            if (heading && typeof heading.focus === 'function') {
                if (!heading.hasAttribute('tabindex')) {
                    heading.setAttribute('tabindex', '-1');
                }
                heading.focus({ preventScroll: true });
                // Announce the new step to screen readers via the
                // shared announcer (alpha.29 batch 97). The heading
                // focus catches sighted users; the announcer covers
                // VoiceOver/NVDA users who may have focus parked on
                // a different region.
                if (this.announcer && typeof this.announcer.polite === 'function') {
                    try { this.announcer.polite(heading.textContent || ''); } catch (_) { /* ignore */ }
                }
            }
        } catch (_) { /* DOM may be torn down mid-render */ }
    };

    /** @private — reset the stable footer between card swaps. */
    SetupConversation.prototype._resetFooter = function () {
        // Footer reset: each card re-wires the two buttons to its own
        // handlers. Clearing the handlers (by replacing the nodes)
        // is the simplest way to guarantee no stale listeners survive.
        var newCancel = this._cancelBtn.cloneNode(false);
        var newContinue = this._continueBtn.cloneNode(false);
        newCancel.hidden = true;
        newCancel.textContent = '';
        newCancel.disabled = false;
        newContinue.disabled = true;
        newContinue.textContent = '';
        this._cancelBtn.parentNode.replaceChild(newCancel, this._cancelBtn);
        this._continueBtn.parentNode.replaceChild(newContinue, this._continueBtn);
        this._cancelBtn = newCancel;
        this._continueBtn = newContinue;
    };

    // ====================================================================
    // Card A — role chooser (BPoS vs Council)
    // ====================================================================

    /** @private */
    SetupConversation.prototype._renderCardA = function (seq) {
        var t = root.enmT;
        // The mock heading is "How will you run this node?" but the
        // existing string key is friendly.welcome.title — Beta 3 reuses
        // it because the role-grid IS the welcome screen now. The
        // friendly.setup.card_a.title key ("What kind of node?") sits
        // closer to the mock copy, so we lead with that.
        var heading = t('friendly.setup.card_a.title');
        var para = t('friendly.welcome.body');
        // Card A's heading is the named landmark for the wizard region.
        this.root.setAttribute('aria-label', heading);
        this._body.innerHTML =
            '<h2 class="enm-wiz-heading" id="enm-wiz-heading-a">' + escapeHtml(heading) + '</h2>'
            + '<p class="enm-wiz-para">' + escapeHtml(para) + '</p>'
            + '<div class="enm-role-grid" role="radiogroup" aria-labelledby="enm-wiz-heading-a">'
              + '<button type="button" class="enm-role-card" data-goal="bpos" role="radio" aria-checked="false">'
                + '<div class="enm-role-card-head">'
                  + '<span class="enm-role-card-radio" aria-hidden="true"></span>'
                  + '<span class="enm-role-card-title">' + escapeHtml(t('friendly.setup.card_a.bpos_title')) + '</span>'
                + '</div>'
                + '<p class="enm-role-card-help">' + escapeHtml(t('friendly.setup.card_a.bpos_sub')) + '</p>'
                // 0.2.0-beta.3.6 — phase-06 mock spec is a three-line
                // meta list for the BPoS role-card: Requires / Wallet /
                // Auto-installs. Pre-beta.3.6 rendered a single
                // "APR ~17% · Stake 5,000 ELA" pair that didn't match
                // any mock variant and conflated reward economics with
                // setup requirements.
                + '<div class="enm-role-card-meta">'
                  + '<span><b>' + escapeHtml(t('friendly.setup.card_a.bpos_requires_label')) + ':</b> '
                    + escapeHtml(t('friendly.setup.card_a.bpos_requires_value')) + '</span>'
                  + '<span><b>' + escapeHtml(t('friendly.setup.card_a.bpos_wallet_label')) + ':</b> '
                    + escapeHtml(t('friendly.setup.card_a.bpos_wallet_value')) + '</span>'
                  + '<span><b>' + escapeHtml(t('friendly.setup.card_a.bpos_install_label')) + ':</b> '
                    + escapeHtml(t('friendly.setup.card_a.bpos_install_value')) + '</span>'
                + '</div>'
              + '</button>'
              + '<button type="button" class="enm-role-card" data-goal="council" data-disabled="true" disabled aria-disabled="true" role="radio" aria-checked="false">'
                // 0.2.0-beta.3.6 — badge text is "Coming soon" on wide
                // / narrow and "Soon" on compact (<480px). We emit both
                // spans and CSS keys the right one off body[data-app-
                // size="compact"]. Single-source-of-truth in strings.js.
                + '<span class="enm-role-card-badge">'
                  + '<span class="enm-role-card-badge-long">'
                    + escapeHtml(t('friendly.setup.card_a.council_meta')) + '</span>'
                  + '<span class="enm-role-card-badge-short">'
                    + escapeHtml(t('friendly.setup.card_a.council_meta_compact')) + '</span>'
                + '</span>'
                + '<div class="enm-role-card-head">'
                  + '<span class="enm-role-card-radio" aria-hidden="true"></span>'
                  + '<span class="enm-role-card-title">' + escapeHtml(t('friendly.setup.card_a.council_title')) + '</span>'
                + '</div>'
                + '<p class="enm-role-card-help">' + escapeHtml(t('friendly.setup.card_a.council_sub')) + '</p>'
                + '<div class="enm-role-card-meta">'
                  + '<span><b>' + escapeHtml(t('friendly.setup.card_a.council_status_label')) + ':</b> '
                    + escapeHtml(t('friendly.setup.card_a.council_status_value')) + '</span>'
                + '</div>'
              + '</button>'
            + '</div>';

        var self = this;
        var cards = this._body.querySelectorAll('.enm-role-card');
        cards.forEach(function (card) {
            // The Council card has data-disabled="true" + disabled attr;
            // the disabled attribute alone blocks the click but we also
            // guard inside the handler defensively.
            card.addEventListener('click', function () {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                if (card.getAttribute('data-disabled') === 'true') { return; }
                cards.forEach(function (c) {
                    c.removeAttribute('data-selected');
                    c.setAttribute('aria-checked', 'false');
                });
                card.setAttribute('data-selected', 'true');
                card.setAttribute('aria-checked', 'true');
                self._goal = card.getAttribute('data-goal');
                self._continueBtn.disabled = false;
            });
        });

        // Wire the footer Continue button for Card A. The Cancel button
        // stays hidden on the initial role-chooser — there's nothing to
        // cancel yet.
        this._continueBtn.textContent = 'Continue';
        this._continueBtn.disabled = true;
        var continueBtn = this._continueBtn;
        continueBtn.addEventListener('click', function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            if (!self._goal || self._goal === 'council') { return; }
            // alpha.28 enmRunOnce — disable + label-swap while the
            // install request is in flight so double-clicks can't
            // fire /setup/install/mainchain twice.
            var runOnce = root.enmRunOnce;
            if (typeof runOnce === 'function') {
                runOnce(continueBtn, 'Setting up…', function () {
                    return Promise.resolve().then(function () {
                        if (self._destroyed) { return null; }
                        self._goto('b');
                    });
                });
            } else {
                continueBtn.disabled = true;
                continueBtn.textContent = 'Setting up…';
                self._goto('b');
            }
        });
    };

    // ====================================================================
    // Card B — install binary (progress card)
    // ====================================================================

    /** @private */
    SetupConversation.prototype._renderCardB = function (seq) {
        var t = root.enmT;
        var heading = t('friendly.setup.card_b.title_active');
        var para    = t('friendly.setup.card_b.sub_active');
        this.root.setAttribute('aria-label', heading);
        this._body.innerHTML =
            '<h2 class="enm-wiz-heading" id="enm-wiz-heading-b">' + escapeHtml(heading) + '</h2>'
            + '<p class="enm-wiz-para" id="enm-wiz-b-para">' + escapeHtml(para) + '</p>'
            + '<div class="enm-install-progress" id="enm-wiz-b-progress" role="status" aria-live="polite">'
              + '<div class="enm-install-bar" aria-hidden="true">'
                + '<div class="enm-install-bar-fill" id="enm-wiz-b-bar" style="width:0%"></div>'
              + '</div>'
              + '<div class="enm-install-bar-label" id="enm-wiz-b-pct">0%</div>'
            + '</div>'
            + '<div class="enm-install-detail" id="enm-wiz-b-detail" aria-live="polite"></div>';

        var self = this;
        var els = {
            title:  this._body.querySelector('#enm-wiz-heading-b'),
            sub:    this._body.querySelector('#enm-wiz-b-para'),
            bar:    this._body.querySelector('#enm-wiz-b-bar'),
            pct:    this._body.querySelector('#enm-wiz-b-pct'),
            detail: this._body.querySelector('#enm-wiz-b-detail'),
        };

        // Footer: Cancel aborts the auto-install; Continue is hidden
        // until the install reaches `done`. Cancel hits the same
        // DELETE endpoint the alpha.27 flow used.
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = t('friendly.setup.cancel');
        this._continueBtn.disabled = true;
        this._continueBtn.hidden = true;
        this._continueBtn.textContent = t('friendly.setup.card_b.cta_continue');

        this._cancelBtn.addEventListener('click', function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._cancelBtn.disabled = true;
            self.api.del('/setup/auto-install-ela').catch(function () { /* ignore — fall through to Card A */ });
            self._teardownInstallTracking();
            self._goto('a');
        });

        // Recovery: if the binary is already on disk, advance immediately.
        // Otherwise kick off the install. 401 on /setup/install-status is
        // suppressed by the catch — during the brief window between
        // first owner pairing and the first authenticated GET, a 401
        // is expected and shouldn't surface as a toast.
        this.api.get('/setup/install-status/mainchain', { skipCache: true }).then(function (s) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            if (s && s.phase === 'done' && s.binaryPath) {
                self._cardBOnDone(els, seq);
            } else if (s && s.phase === 'downloading') {
                self._beginInstall(els, seq, /* alreadyStarted */ true);
            } else {
                self._beginInstall(els, seq, /* alreadyStarted */ false);
            }
        }).catch(function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            // Any HTTP failure (incl. 401 during first-pair) → kick the
            // install through the POST endpoint, which the backend
            // handles idempotently.
            self._beginInstall(els, seq, /* alreadyStarted */ false);
        });
    };

    /** @private */
    SetupConversation.prototype._beginInstall = function (els, seq, alreadyStarted) {
        var t = root.enmT;
        var self = this;
        // alpha.28.1 bug fix — latch `installComplete` in a closure so
        // applyStatus short-circuits after the first terminal phase
        // observed. Without it, SSE + poll both delivering
        // `phase === 'done'` ran _cardBOnDone twice — second call
        // wrote into a DOM the first had already replaced.
        var installComplete = false;

        function applyStatus(s) {
            if (!s || installComplete || self._destroyed) { return; }
            if (!self._stillRendering(seq)) { return; }
            var pct = (s.bytesTotal && s.bytesDownloaded)
                ? Math.min(100, Math.floor((s.bytesDownloaded / s.bytesTotal) * 100))
                : (s.phase === 'done' ? 100 : (s.phase === 'verifying' ? 95 : 5));
            els.bar.style.width = pct + '%';
            els.pct.textContent = pct + '%';
            els.sub.textContent = phaseLabel(s);
            if (s.phase === 'done') {
                installComplete = true;
                self._teardownInstallTracking();
                self._cardBOnDone(els, seq);
            }
            if (s.phase === 'failed') {
                installComplete = true;
                self._teardownInstallTracking();
                self._cardBOnFailed(els, seq, s);
            }
        }

        // Subscribe to SSE for live updates.
        if (this.sse && typeof this.sse.subscribe === 'function') {
            if (this._unsubscribeInstall) { this._unsubscribeInstall(); }
            this._unsubscribeInstall = this.sse.subscribe(
                'setup:install:mainchain',
                function (p) { applyStatus(p); }
            );
        }

        var startReq = alreadyStarted
            ? Promise.resolve(null)
            : this.api.post('/setup/install/mainchain');

        startReq.then(function (resp) {
            if (self._destroyed) { return; }
            applyStatus(resp && resp.status);
            // Fallback poll bound to _currentCard === 'b' AND
            // installComplete === false so navigation away and terminal
            // phases both kill the loop. Timer handle is stored on
            // `this` so destroy()/teardown can cancel a pending tick.
            (function poll() {
                if (installComplete || self._destroyed) { return; }
                if (self._currentCard !== 'b') { return; }
                if (!self.root.isConnected) { return; }
                self.api.get('/setup/install-status/mainchain', { skipCache: true })
                    .then(function (s) {
                        if (self._destroyed) { return; }
                        applyStatus(s);
                        if (!installComplete && self._currentCard === 'b'
                            && (!s || (s.phase !== 'done' && s.phase !== 'failed'))) {
                            self._installPollTimer = setTimeout(poll, 2500);
                        }
                    })
                    .catch(function () {
                        // alpha.28.1 — 401 expected during first-pair;
                        // retry on a longer cadence so we don't burn
                        // request budget while owner-token settles.
                        if (!installComplete && self._currentCard === 'b' && !self._destroyed) {
                            self._installPollTimer = setTimeout(poll, 4000);
                        }
                    });
            })();
        }).catch(function (err) {
            if (self._destroyed) { return; }
            applyStatus({ phase: 'failed', error: err && err.message ? err.message : String(err) });
        });
    };

    /** @private */
    SetupConversation.prototype._cardBOnDone = function (els, seq) {
        var t = root.enmT;
        var self = this;
        els.bar.style.width = '100%';
        els.pct.textContent = '100%';
        els.title.textContent = t('friendly.setup.card_b.title_done');
        els.sub.textContent   = t('friendly.setup.card_b.sub_done');
        els.detail.innerHTML  = '';
        // Hide Cancel + reveal Continue. Continue moves to Card B2
        // (bootstrap-vs-genesis).
        this._cancelBtn.hidden = true;
        this._continueBtn.hidden = false;
        this._continueBtn.disabled = false;
        this._continueBtn.textContent = t('friendly.setup.card_b.cta_continue');
        this._continueBtn.addEventListener('click', function onClick() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onClick);
            self._goto('b2');
        });
    };

    /** @private */
    SetupConversation.prototype._cardBOnFailed = function (els, seq, s) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_b.phase_failed');
        els.sub.textContent   = t('friendly.setup.card_b.failed_help');
        var errMsg = s && s.error ? String(s.error) : '';
        if (errMsg) {
            els.detail.innerHTML = '<p class="enm-install-detail-error">' + escapeHtml(errMsg) + '</p>';
        }
        // Swap Cancel→Back, Continue→Retry. Retry re-enters _beginInstall.
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = t('friendly.setup.back');
        this._cancelBtn.disabled = false;
        this._continueBtn.hidden = false;
        this._continueBtn.disabled = false;
        this._continueBtn.textContent = t('friendly.setup.card_b.cta_retry');
        this._continueBtn.addEventListener('click', function onRetry() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onRetry);
            self._renderCardB(self._cardSeq); // re-render to reset progress UI
        });
    };

    // ====================================================================
    // Card B2 — bootstrap vs genesis snapshot
    // ====================================================================

    /** @private */
    SetupConversation.prototype._renderCardB2 = function (seq) {
        var t = root.enmT;
        var heading = t('friendly.setup.card_b2.title_idle');
        this.root.setAttribute('aria-label', heading);
        this._body.innerHTML =
            '<h2 class="enm-wiz-heading" id="enm-wiz-heading-b2">' + escapeHtml(heading) + '</h2>'
            + '<p class="enm-wiz-para" id="enm-wiz-b2-para">' + escapeHtml(t('friendly.setup.card_b2.sub_idle')) + '</p>'
            + '<div class="enm-role-grid" id="enm-wiz-b2-tiles" role="radiogroup" aria-labelledby="enm-wiz-heading-b2">'
              + '<button type="button" class="enm-role-card" data-choice="bootstrap" role="radio" aria-checked="false">'
                + '<span class="enm-role-card-badge enm-role-card-badge-ok">' + escapeHtml(t('friendly.setup.card_b2.badge_recommended')) + '</span>'
                + '<div class="enm-role-card-head">'
                  + '<span class="enm-role-card-radio" aria-hidden="true"></span>'
                  + '<span class="enm-role-card-title">' + escapeHtml(t('friendly.setup.card_b2.tile_bootstrap_title')) + '</span>'
                + '</div>'
                + '<p class="enm-role-card-help">' + escapeHtml(t('friendly.setup.card_b2.tile_bootstrap_sub')) + '</p>'
                + '<div class="enm-role-card-meta"><span>' + escapeHtml(t('friendly.setup.card_b2.tile_bootstrap_meta')) + '</span></div>'
              + '</button>'
              + '<button type="button" class="enm-role-card" data-choice="genesis" role="radio" aria-checked="false">'
                + '<div class="enm-role-card-head">'
                  + '<span class="enm-role-card-radio" aria-hidden="true"></span>'
                  + '<span class="enm-role-card-title">' + escapeHtml(t('friendly.setup.card_b2.tile_genesis_title')) + '</span>'
                + '</div>'
                + '<p class="enm-role-card-help">' + escapeHtml(t('friendly.setup.card_b2.tile_genesis_sub')) + '</p>'
                + '<div class="enm-role-card-meta"><span>' + escapeHtml(t('friendly.setup.card_b2.tile_genesis_meta')) + '</span></div>'
              + '</button>'
            + '</div>'
            + '<div class="enm-install-progress" id="enm-wiz-b2-progress" role="status" aria-live="polite" hidden>'
              + '<div class="enm-install-bar" aria-hidden="true">'
                + '<div class="enm-install-bar-fill" id="enm-wiz-b2-bar" style="width:0%"></div>'
              + '</div>'
              + '<div class="enm-install-bar-label" id="enm-wiz-b2-pct">0%</div>'
            + '</div>'
            + '<div class="enm-install-detail" id="enm-wiz-b2-detail"></div>';

        var self = this;
        var els = {
            title:    this._body.querySelector('#enm-wiz-heading-b2'),
            sub:      this._body.querySelector('#enm-wiz-b2-para'),
            tiles:    this._body.querySelector('#enm-wiz-b2-tiles'),
            progress: this._body.querySelector('#enm-wiz-b2-progress'),
            bar:      this._body.querySelector('#enm-wiz-b2-bar'),
            pct:      this._body.querySelector('#enm-wiz-b2-pct'),
            detail:   this._body.querySelector('#enm-wiz-b2-detail'),
        };

        // Footer: Back to Card B, Continue disabled until a choice is made
        // (or auto-fires when the bootstrap finishes).
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = t('friendly.setup.back');
        this._cancelBtn.addEventListener('click', function () {
            if (self._destroyed) { return; }
            self._teardownBootstrapTracking();
            self._goto('b');
        });
        this._continueBtn.disabled = true;
        this._continueBtn.textContent = t('friendly.setup.card_b2.cta_continue');

        var pickedChoice = null;
        els.tiles.querySelectorAll('.enm-role-card').forEach(function (card) {
            card.addEventListener('click', function () {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                els.tiles.querySelectorAll('.enm-role-card').forEach(function (c) {
                    c.removeAttribute('data-selected');
                    c.setAttribute('aria-checked', 'false');
                });
                card.setAttribute('data-selected', 'true');
                card.setAttribute('aria-checked', 'true');
                pickedChoice = card.getAttribute('data-choice');
                self._continueBtn.disabled = false;
            });
        });

        this._continueBtn.addEventListener('click', function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            if (!pickedChoice) { return; }
            if (pickedChoice === 'genesis') {
                self._b2ChooseGenesis(els, seq);
            } else {
                self._b2BeginBootstrap(els, seq, /* alreadyStarted */ false);
            }
        });

        // Recovery: if a bootstrap is already running on the server,
        // jump straight to the live-progress UI.
        this.api.get('/chains/mainchain/bootstrap', { skipCache: true }).then(function (data) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            var s = data && data.status;
            if (!s) { return; }
            if (s.phase === 'downloading' || s.phase === 'extracting'
                || s.phase === 'applying'   || s.phase === 'verifying'
                || s.phase === 'resolving') {
                self._b2BeginBootstrap(els, seq, /* alreadyStarted */ true);
            } else if (s.phase === 'done') {
                self._b2OnBootstrapDone(els, seq);
            }
            // 'idle' / 'failed' both leave the tiles visible.
        }).catch(function () { /* tiles already rendered */ });
    };

    /** @private */
    SetupConversation.prototype._b2ChooseGenesis = function (els, seq) {
        var t = root.enmT;
        var self = this;
        els.tiles.querySelectorAll('.enm-role-card').forEach(function (b) { b.disabled = true; });
        els.sub.textContent = t('friendly.setup.card_b2.advancing');
        this._continueBtn.disabled = true;
        this.api.post('/setup/bootstrap', { choice: 'genesis' }).then(function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            if (self.notifications && typeof self.notifications.info === 'function') {
                self.notifications.info(
                    t('friendly.setup.card_b2.genesis_picked_title'),
                    t('friendly.setup.card_b2.genesis_picked_sub')
                );
            }
            self._goto('b3');
        }).catch(function (err) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            els.tiles.querySelectorAll('.enm-role-card').forEach(function (b) { b.disabled = false; });
            els.sub.textContent = t('friendly.setup.card_b2.advance_failed',
                { error: err && err.message ? err.message : String(err) });
            self._continueBtn.disabled = false;
        });
    };

    /** @private */
    SetupConversation.prototype._b2BeginBootstrap = function (els, seq, alreadyStarted) {
        var t = root.enmT;
        var self = this;
        els.tiles.hidden = true;
        els.title.textContent = t('friendly.setup.card_b2.title_running');
        els.sub.textContent   = t('friendly.setup.card_b2.sub_running');
        els.progress.hidden   = false;
        // Footer: keep Cancel (now aborts the download) — hide Continue
        // until bootstrap completes.
        this._continueBtn.hidden = true;
        this._continueBtn.disabled = true;
        // Replace the existing Cancel handler with a bootstrap-abort.
        // beta.3.37 — explicitly reset `disabled` on the clone. cloneNode
        // preserves attributes, so a prior cancellation that disabled the
        // button (or a stale state on reload) would carry through and the
        // operator couldn't click Cancel a second time.
        var newCancel = this._cancelBtn.cloneNode(false);
        newCancel.hidden = false;
        newCancel.disabled = false;
        newCancel.textContent = t('friendly.setup.card_b2.cancel');
        this._cancelBtn.parentNode.replaceChild(newCancel, this._cancelBtn);
        this._cancelBtn = newCancel;
        this._cancelBtn.addEventListener('click', function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._cancelBtn.disabled = true;
            self.api.del('/chains/mainchain/bootstrap').catch(function () { /* ignore */ });
        });

        this._teardownBootstrapTracking();
        var done = false;

        function applyStatus(s) {
            if (!s || done || self._destroyed) { return; }
            if (!self._stillRendering(seq)) { return; }
            // beta.3.37 — SSE events publish { got, total } (see
            // EnmBootstrapDownloader._emit), HTTP poll responses carry
            // { bytesDownloaded, bytesTotal }. Pre-3.37 the wizard only
            // looked at the HTTP shape, so every SSE chunk-progress
            // event hit the fallback branch and re-snapped the bar
            // back to 5%. Accept both shapes.
            var got   = (typeof s.bytesDownloaded === 'number') ? s.bytesDownloaded
                      : (typeof s.got === 'number') ? s.got : 0;
            var total = (typeof s.bytesTotal === 'number') ? s.bytesTotal
                      : (typeof s.total === 'number') ? s.total : 0;
            var pct = (total && got)
                ? Math.min(100, Math.floor((got / total) * 100))
                : (s.phase === 'done' ? 100 : (s.phase === 'extracting' ? 95 : 5));
            els.bar.style.width = pct + '%';
            els.pct.textContent = pct + '%';
            els.sub.textContent = bootstrapPhaseLabel(s);
            // Hide cancel during apply/verify — can't safely abort.
            if (self._cancelBtn && (s.phase === 'applying' || s.phase === 'verifying')) {
                self._cancelBtn.hidden = true;
            }
            if (s.phase === 'done') {
                done = true;
                self._teardownBootstrapTracking();
                self._b2OnBootstrapDone(els, seq);
            }
            if (s.phase === 'failed') {
                done = true;
                self._teardownBootstrapTracking();
                self._b2OnBootstrapFailed(els, seq, s);
            }
        }

        if (this.sse && typeof this.sse.subscribe === 'function') {
            this._unsubscribeBootstrap = this.sse.subscribe(
                'setup:bootstrap:mainchain',
                function (payload) { applyStatus(payload); }
            );
        }
        this._bootstrapPollTimer = setInterval(function () {
            if (done || self._destroyed) { return; }
            self.api.get('/chains/mainchain/bootstrap', { skipCache: true }).then(function (data) {
                if (self._destroyed) { return; }
                applyStatus(data && data.status);
            }).catch(function () { /* tick again on next interval */ });
        }, 2000);

        var startPromise = alreadyStarted
            ? this.api.get('/chains/mainchain/bootstrap', { skipCache: true })
                .then(function (data) { return { status: data && data.status }; })
            : this.api.post('/chains/mainchain/bootstrap');
        startPromise.then(function (result) {
            if (self._destroyed) { return; }
            applyStatus(result && result.status);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            applyStatus({ phase: 'failed', error: err && err.message ? err.message : String(err) });
        });
    };

    /** @private */
    SetupConversation.prototype._b2OnBootstrapDone = function (els, seq) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_b2.title_done');
        els.sub.textContent   = t('friendly.setup.card_b2.sub_done');
        els.bar.style.width   = '100%';
        els.pct.textContent   = '100%';
        // Restore Continue; reset cancel back to Back.
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = t('friendly.setup.back');
        this._continueBtn.hidden = false;
        this._continueBtn.disabled = false;
        this._continueBtn.textContent = t('friendly.setup.card_b2.cta_continue');
        this._continueBtn.addEventListener('click', function onClick() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onClick);
            self.api.post('/setup/bootstrap', { choice: 'bootstrap' })
                .then(function () { if (!self._destroyed) { self._goto('b3'); } })
                .catch(function () {
                    // Bootstrap is done on-disk even if step-advance fails;
                    // the resume code is permissive about missing currentStep
                    // so we still land on the right card.
                    if (!self._destroyed) { self._goto('b3'); }
                });
        });
    };

    /** @private */
    SetupConversation.prototype._b2OnBootstrapFailed = function (els, seq, s) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_b2.title_failed');
        els.sub.textContent   = (s && s.error) || t('friendly.setup.card_b2.sub_failed');
        // Cancel→Back, Continue→Retry.
        // beta.3.37 — explicitly reset `disabled` and `hidden`. The
        // failure path is reached after the cancel button was disabled
        // by its own click handler; cloneNode preserved that, so the
        // operator's "skip and sync from scratch" button rendered but
        // wasn't clickable.
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = t('friendly.setup.card_b2.cta_fallback_genesis');
        var newCancel = this._cancelBtn.cloneNode(false);
        newCancel.hidden = false;
        newCancel.disabled = false;
        newCancel.textContent = t('friendly.setup.card_b2.cta_fallback_genesis');
        this._cancelBtn.parentNode.replaceChild(newCancel, this._cancelBtn);
        this._cancelBtn = newCancel;
        this._cancelBtn.addEventListener('click', function () {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._b2ChooseGenesis(els, seq);
        });
        this._continueBtn.hidden = false;
        this._continueBtn.disabled = false;
        this._continueBtn.textContent = t('friendly.setup.card_b2.cta_retry');
        this._continueBtn.addEventListener('click', function onRetry() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onRetry);
            self._b2BeginBootstrap(els, seq, false);
        });
    };

    // ====================================================================
    // Card B3 — clock-skew preflight (F13)
    // ====================================================================

    /**
     * ELA's Schnorr signatures get rejected silently when the host clock
     * drifts >~4.2s from consensus partners. We surface the preflight
     * result so the operator can fix NTP BEFORE registering. Three
     * outcomes (skipped / out-of-sync / in-sync); the wizard MUST NEVER
     * deadlock on this card, so even a probe failure renders the
     * skipped (YELLOW) path with a Continue button.
     */
    SetupConversation.prototype._renderCardB3 = function (seq) {
        var tt = root.enmTOrFallback;
        var initialTitle = 'Checking host clock…';
        this.root.setAttribute('aria-label', initialTitle);
        this._body.innerHTML =
            '<h2 class="enm-wiz-heading" id="enm-wiz-heading-b3">' + escapeHtml(initialTitle) + '</h2>'
            + '<p class="enm-wiz-para" id="enm-wiz-b3-para">Comparing your server clock to internet time. DPoS signatures fail if the host drifts more than ~4 seconds.</p>'
            + '<div id="enm-wiz-b3-detail" class="enm-install-detail enm-clock-detail" aria-live="polite"></div>';

        var self = this;
        var els = {
            title:  this._body.querySelector('#enm-wiz-heading-b3'),
            sub:    this._body.querySelector('#enm-wiz-b3-para'),
            detail: this._body.querySelector('#enm-wiz-b3-detail'),
        };

        // Cancel = Back to B2; Continue is wired by the result handler.
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = tt('friendly.setup.back');
        this._cancelBtn.addEventListener('click', function () {
            if (self._destroyed) { return; }
            self._goto('b2');
        });

        this._runClockSkewProbe(els, seq);
    };

    /** @private */
    SetupConversation.prototype._runClockSkewProbe = function (els, seq) {
        var self = this;
        els.detail.innerHTML = '';
        els.title.textContent = 'Checking host clock…';
        els.sub.textContent   = 'Comparing your server clock to internet time. DPoS signatures fail if the host drifts more than ~4 seconds.';
        // Disable Continue while probe is in flight.
        this._continueBtn.disabled = true;
        this._continueBtn.hidden = false;
        this._continueBtn.textContent = 'Checking…';

        this.api.get('/setup/preflight', { skipCache: true }).then(function (resp) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            var cs = resp && resp.clockSkew;
            if (!cs) {
                cs = { ok: true, skipped: true, reason: 'no clockSkew in preflight response' };
            }
            self._renderClockSkewResult(els, seq, cs);
        }).catch(function (err) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            // Even the probe call itself failed — render as a SKIP so
            // the operator can always continue. The wizard NEVER gets
            // stuck on this card.
            self._renderClockSkewResult(els, seq, {
                ok: true,
                skipped: true,
                reason: err && err.message ? err.message : String(err),
            });
        });
    };

    /** @private */
    SetupConversation.prototype._renderClockSkewResult = function (els, seq, cs) {
        var tt = root.enmTOrFallback;
        var self = this;

        if (cs.skipped) {
            // YELLOW: probe didn't reach the internet. Warn but allow continue.
            els.title.textContent = tt('clock_skew.skipped_title');
            els.sub.textContent   = tt('clock_skew.skipped_sub');
            els.detail.innerHTML =
                '<div class="enm-clock-card enm-clock-card-warn">'
                  + '<div class="enm-clock-card-icon" aria-hidden="true">!</div>'
                  + '<div class="enm-clock-card-body">'
                    + '<div class="enm-clock-card-title">' + escapeHtml(tt('clock_skew.skipped_card_title')) + '</div>'
                    + '<div class="enm-clock-card-sub">'
                      + tt('clock_skew.skipped_card_body', {
                          reason: escapeHtml(cs.reason || 'network unreachable'),
                      })
                    + '</div>'
                  + '</div>'
                + '</div>';
            this._continueBtn.disabled = false;
            this._continueBtn.textContent = tt('clock_skew.skipped_cta_continue');
            this._continueBtn.addEventListener('click', function onContinue() {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                self._continueBtn.removeEventListener('click', onContinue);
                self._goto('c');
            });
            return;
        }

        if (!cs.ok) {
            // RED: skew exceeds the safe window. Operator MUST fix this.
            var skewMs = Number.isFinite(cs.skewMs) ? cs.skewMs : 0;
            var skewSeconds = (Math.abs(skewMs) / 1000).toFixed(1);
            var direction = skewMs > 0
                ? tt('clock_skew.direction_ahead')
                : tt('clock_skew.direction_behind');
            els.title.textContent = tt('clock_skew.out_of_sync_title');
            els.sub.textContent   = tt('clock_skew.out_of_sync_sub', {
                skewSeconds: skewSeconds,
                direction:   direction,
            });
            els.detail.innerHTML =
                '<div class="enm-clock-card enm-clock-card-error">'
                  + '<div class="enm-clock-card-icon" aria-hidden="true">!</div>'
                  + '<div class="enm-clock-card-body">'
                    + '<div class="enm-clock-card-title">' + escapeHtml(tt('clock_skew.out_card_title')) + '</div>'
                    + '<div class="enm-clock-card-sub">' + tt('clock_skew.out_card_body') + '</div>'
                  + '</div>'
                + '</div>';
            // Continue → Retry. Cancel keeps "Back". A second option
            // (Continue anyway) lives inline in the detail card as a
            // text link for the air-gapped/test environment escape.
            els.detail.innerHTML += '<p class="enm-clock-override-row">'
                + '<button type="button" class="enm-conv-textlink enm-clock-override-btn">'
                  + escapeHtml(tt('clock_skew.out_cta_override'))
                + '</button>'
                + '</p>';
            els.detail.querySelector('.enm-clock-override-btn').addEventListener('click', function () {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                self._goto('c');
            });
            this._continueBtn.disabled = false;
            this._continueBtn.textContent = tt('clock_skew.out_cta_retry');
            this._continueBtn.addEventListener('click', function onRetry() {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                self._continueBtn.removeEventListener('click', onRetry);
                self._runClockSkewProbe(els, seq);
            });
            return;
        }

        // GREEN: in sync. Show the absolute skew + continue.
        var absMs = Number.isFinite(cs.absSkewMs)
            ? cs.absSkewMs
            : Math.abs(Number.isFinite(cs.skewMs) ? cs.skewMs : 0);
        els.title.textContent = tt('clock_skew.ok_title');
        els.sub.textContent   = tt('clock_skew.ok_sub');
        els.detail.innerHTML =
            '<div class="enm-clock-card enm-clock-card-ok">'
              + '<div class="enm-clock-card-icon" aria-hidden="true">+</div>'
              + '<div class="enm-clock-card-body">'
                + '<div class="enm-clock-card-title">' + escapeHtml(tt('clock_skew.ok_card_title', { absMs: String(absMs) })) + '</div>'
                + '<div class="enm-clock-card-sub">'
                  + tt('clock_skew.ok_card_body', {
                      source: escapeHtml(cs.source || tt('clock_skew.ok_default_source')),
                  })
                + '</div>'
              + '</div>'
            + '</div>';
        this._continueBtn.disabled = false;
        this._continueBtn.textContent = tt('clock_skew.ok_cta_continue');
        this._continueBtn.addEventListener('click', function onContinue() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onContinue);
            self._goto('c');
        });
    };

    // ====================================================================
    // Card C — keystore password reveal
    // ====================================================================

    /** @private */
    SetupConversation.prototype._renderCardC = function (seq) {
        var t = root.enmT;
        var heading = t('friendly.setup.card_c.title_initial');
        this.root.setAttribute('aria-label', heading);
        this._body.innerHTML =
            '<h2 class="enm-wiz-heading" id="enm-wiz-heading-c">' + escapeHtml(heading) + '</h2>'
            + '<p class="enm-wiz-para" id="enm-wiz-c-para">' + escapeHtml(t('friendly.setup.card_c.sub_initial')) + '</p>'
            + '<div id="enm-wiz-c-reveal"></div>';

        var self = this;
        var els = {
            title:   this._body.querySelector('#enm-wiz-heading-c'),
            sub:     this._body.querySelector('#enm-wiz-c-para'),
            reveal:  this._body.querySelector('#enm-wiz-c-reveal'),
        };

        // Cancel = Back to B3. Continue starts as "Generate my password"
        // and swaps to "Continue" once the reveal is acknowledged.
        this._cancelBtn.hidden = false;
        this._cancelBtn.textContent = t('friendly.setup.back');
        this._cancelBtn.addEventListener('click', function () {
            if (self._destroyed) { return; }
            self._goto('b3');
        });
        this._continueBtn.disabled = false;
        this._continueBtn.textContent = t('friendly.setup.card_c.cta_generate');
        this._continueBtn.addEventListener('click', function onGenerate() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onGenerate);
            self._continueBtn.disabled = true;
            self._continueBtn.textContent = 'Generating…';
            self._generateKeystore(els, seq);
        });
    };

    /** @private */
    SetupConversation.prototype._generateKeystore = function (els, seq) {
        var t = root.enmT;
        var self = this;
        // BPoS path → server generates a strong password.
        this.api.post('/setup/keystore', { enableArbiter: true }).then(function (resp) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._renderKeystoreReveal(els, seq, resp.generatedPassword || '');
        }).catch(function (err) {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._notify(t('friendly.error.generic'),
                err && err.message ? err.message : String(err), 'warning');
            // Reset Continue back to generate.
            self._continueBtn.disabled = false;
            self._continueBtn.textContent = t('friendly.setup.card_c.cta_generate');
            self._continueBtn.addEventListener('click', function onRetry() {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                self._continueBtn.removeEventListener('click', onRetry);
                self._continueBtn.disabled = true;
                self._continueBtn.textContent = 'Generating…';
                self._generateKeystore(els, seq);
            });
        });
    };

    /** @private */
    SetupConversation.prototype._renderKeystoreReveal = function (els, seq, password) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_c.title_generated');
        els.sub.textContent   = t('friendly.setup.card_c.sub_generated');
        els.reveal.innerHTML =
            '<div class="enm-password-reveal">'
              + '<code class="enm-password-value">' + escapeHtml(password) + '</code>'
              + '<span class="enm-password-copy-slot"></span>'
            + '</div>'
            + '<label class="enm-conv-checkbox">'
              + '<input type="checkbox" id="enm-wiz-c-ack"/>'
              + '<span>' + escapeHtml(t('friendly.setup.card_c.ack')) + '</span>'
            + '</label>';

        // alpha.29 batch 100 — keystore-password copy button via the
        // root.enmCopyButton factory. Replaces 30+ lines of hand-wired
        // onFallback + selectInto + warning-toast plumbing.
        var pwEl = els.reveal.querySelector('.enm-password-value');
        if (typeof root.enmCopyButton === 'function') {
            var copyBtn = root.enmCopyButton({
                value: password,
                label: t('friendly.setup.card_c.cta_copy'),
                copiedLabel: t('friendly.setup.card_c.cta_copied'),
                ariaLabel: 'Copy keystore password',
                resetMs: 1500,
                notifications: self.notifications,
                failTitle: t('friendly.setup.card_c.copy_fail_title'),
                failBody: t('friendly.setup.card_c.copy_fail_body'),
                getDisplayEl: function () { return pwEl; },
            });
            copyBtn.classList.add('enm-password-copy');
            var slot = els.reveal.querySelector('.enm-password-copy-slot');
            if (slot && slot.parentNode) {
                slot.parentNode.replaceChild(copyBtn, slot);
            }
        }

        // Continue gated on the ack checkbox.
        this._continueBtn.disabled = true;
        this._continueBtn.textContent = t('friendly.setup.card_c.cta_continue');
        this._continueBtn.addEventListener('click', function onContinue() {
            if (self._destroyed || !self._stillRendering(seq)) { return; }
            self._continueBtn.removeEventListener('click', onContinue);
            self._goto('d');
        });
        var ack = els.reveal.querySelector('#enm-wiz-c-ack');
        ack.addEventListener('change', function () {
            self._continueBtn.disabled = !ack.checked;
        });
    };

    // ====================================================================
    // Card D — finalize + start chain + celebrate
    // ====================================================================

    /** @private */
    SetupConversation.prototype._renderCardD = function (seq) {
        var t = root.enmT;
        var heading = t('friendly.setup.card_d.title_starting');
        this.root.setAttribute('aria-label', heading);
        this._body.innerHTML =
            '<h2 class="enm-wiz-heading" id="enm-wiz-heading-d">' + escapeHtml(heading) + '</h2>'
            + '<p class="enm-wiz-para" id="enm-wiz-d-para">' + escapeHtml(t('friendly.setup.card_d.sub_starting')) + '</p>'
            + '<div class="enm-install-progress" role="status" aria-live="polite">'
              + '<div class="enm-install-bar" aria-hidden="true">'
                + '<div class="enm-install-bar-fill" style="width:90%"></div>'
              + '</div>'
              + '<div class="enm-install-bar-label">Almost there…</div>'
            + '</div>'
            + '<div class="enm-install-detail" id="enm-wiz-d-detail"></div>';

        var self = this;
        var els = {
            title:  this._body.querySelector('#enm-wiz-heading-d'),
            sub:    this._body.querySelector('#enm-wiz-d-para'),
            detail: this._body.querySelector('#enm-wiz-d-detail'),
        };

        // Hide cancel; Continue starts disabled until finalize completes.
        this._cancelBtn.hidden = true;
        this._continueBtn.hidden = false;
        this._continueBtn.disabled = true;
        this._continueBtn.textContent = 'Finishing up…';

        // Finalize: set network to auto-detect, mark complete, then try
        // to start the chain.
        //   1. setup steps fail → show error + retry
        //   2. setup OK, start OK → celebrate + open dashboard
        //   3. setup OK, start FAILED → celebrate (config saved) BUT
        //      surface the start error and let the operator move on.
        //      Previously the start error was swallowed silently — the
        //      operator saw "Done!" while ela was dead.
        var startError = null;
        this.api.post('/setup/network', { mode: 'auto' })
            .then(function () {
                if (self._destroyed) { return null; }
                return self.api.post('/setup/complete', {});
            })
            .then(function () {
                if (self._destroyed) { return null; }
                return self.api.post('/chains/mainchain/start').catch(function (err) {
                    startError = err;
                });
            })
            .then(function () {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                els.title.textContent = t('friendly.setup.card_d.title_done');
                if (startError) {
                    var detail = startError && startError.message ? startError.message : String(startError);
                    els.sub.innerHTML =
                        escapeHtml(t('friendly.setup.card_d.sub_done')) +
                        '<br><br><strong>Heads up:</strong> the chain didn\'t start ' +
                        'on its own — <em>' + escapeHtml(detail) + '</em>. Open the ' +
                        'dashboard and press <strong>Start</strong> on the Mainchain card.';
                    if (self.notifications) {
                        self.notifications.warning('Setup saved, chain not started', detail);
                    }
                } else {
                    els.sub.textContent = t('friendly.setup.card_d.sub_done');
                }
                self._continueBtn.disabled = false;
                self._continueBtn.textContent = t('friendly.setup.card_d.cta');
                self._continueBtn.addEventListener('click', function onDone() {
                    if (self._destroyed || !self._stillRendering(seq)) { return; }
                    self._continueBtn.removeEventListener('click', onDone);
                    self.onComplete();
                });
            })
            .catch(function (err) {
                if (self._destroyed || !self._stillRendering(seq)) { return; }
                els.title.textContent = t('friendly.error.generic');
                els.sub.textContent   = err && err.message ? err.message : String(err);
                self._continueBtn.disabled = false;
                self._continueBtn.textContent = t('friendly.setup.card_b.cta_retry');
                self._continueBtn.addEventListener('click', function onRetry() {
                    if (self._destroyed || !self._stillRendering(seq)) { return; }
                    self._continueBtn.removeEventListener('click', onRetry);
                    self._renderCardD(self._cardSeq);
                });
            });
    };

    // ====================================================================
    // Helpers
    // ====================================================================

    /** @private */
    SetupConversation.prototype._stillRendering = function (seq) {
        return !this._destroyed && this.root.isConnected && this._cardSeq === seq;
    };

    /** @private */
    SetupConversation.prototype._notify = function (title, body, severity) {
        if (!this.notifications) { return; }
        var fn = severity === 'warning' ? 'warning' : 'info';
        if (typeof this.notifications[fn] === 'function') {
            this.notifications[fn](title, body);
        }
    };

    function phaseLabel(s) {
        var t = root.enmT;
        if (!s) { return t('friendly.setup.card_b.phase_preparing'); }
        var key = 'friendly.setup.card_b.phase_' + s.phase;
        var label = t(key);
        if (label.indexOf('[') === 0) {
            return s.phase || t('friendly.setup.card_b.phase_preparing');
        }
        return label;
    }

    function bootstrapPhaseLabel(s) {
        var t = root.enmT;
        if (!s) { return t('friendly.setup.card_b2.phase_preparing'); }
        var key = 'friendly.setup.card_b2.phase_' + s.phase;
        var label = t(key);
        if (label.indexOf('[') === 0) {
            label = s.phase || t('friendly.setup.card_b2.phase_preparing');
        }
        if (s.phase === 'downloading' && s.bytesTotal) {
            var got = (s.bytesDownloaded / (1024 ** 3)).toFixed(2);
            var tot = (s.bytesTotal / (1024 ** 3)).toFixed(2);
            label += ' — ' + got + ' / ' + tot + ' GB';
        }
        return label;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmSetupConversation = SetupConversation;
}(typeof window !== 'undefined' ? window : globalThis));
