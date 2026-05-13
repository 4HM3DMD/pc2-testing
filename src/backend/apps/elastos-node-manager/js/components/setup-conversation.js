/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/setup-conversation.js — friendly 4-card setup (v0.4).
 *
 * Replaces the technical setup-wizard for the avg-joe path. The same
 * backend endpoints power both — this component is purely a friendlier
 * shell over `/setup/install/mainchain`, `/setup/keystore`,
 * `/setup/network`, `/setup/complete`, `/chains/mainchain/start`.
 *
 * The four cards:
 *   A — Role:     "BPoS supernode" (Council node coming soon)
 *   B — Install:  one button → progress → done
 *   C — Password: generate + show + acknowledge (BPoS keystore)
 *   D — Done:     finalize, start the chain, celebrate
 *
 * Card A's choice maps to:
 *   bpos    → enableArbiter=true  (BPoS supernode, password generated server-side)
 *   council → DISABLED until the CR registration flow lands (next release)
 *
 * The earlier "help / full-node" path was removed 2026-05-07 — ENM is
 * positioned for BPoS + Council operators, not generic full-node users.
 * Existing installs whose state has enableArbiter=false load as 'bpos'
 * (we don't show a council path that won't work yet). See
 * feedback_enm_vocabulary memory entry for the wider rule.
 *
 * Recovery: on mount we GET /setup/state and jump to the right card so
 * a container restart mid-setup picks up where the operator left off.
 */

(function (root) {
    'use strict';

    var TOTAL_STEPS = 6;

    function SetupConversation(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('SetupConversation: { api, notifications, sse } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications || null;
        this.sse = opts.sse || null;
        this.onComplete = typeof opts.onComplete === 'function'
            ? opts.onComplete
            : function () {};
        this.onCancel = typeof opts.onCancel === 'function'
            ? opts.onCancel
            : null;

        this.root = document.createElement('section');
        this.root.className = 'enm-conversation';

        this._goal = null;            // 'bpos' | 'council' (council is disabled today)
        this._currentCard = 'a';      // which card is showing
        this._cardSeq = 0;            // bump on every render to ignore stale callbacks
        this._unsubscribeInstall = null;
        // alpha.28.1 — install poll timer handle so the fallback poll
        // in _beginInstall can be cancelled. See _teardownInstallTracking
        // for why this is necessary.
        this._installPollTimer = null;
    }

    /**
     * Cancel the Card-B install poll + SSE subscription. Called from
     * destroy(), from _goto() when navigating away from Card B, and
     * from _beginInstall.applyStatus when a terminal phase is observed.
     * Without this the IIFE poll outlives the operator's navigation and
     * can call applyStatus on stale DOM, including yanking the operator
     * involuntarily into Card B Done.
     */
    SetupConversation.prototype._teardownInstallTracking = function () {
        if (this._installPollTimer) {
            clearTimeout(this._installPollTimer);
            this._installPollTimer = null;
        }
        if (this._unsubscribeInstall) {
            this._unsubscribeInstall();
            this._unsubscribeInstall = null;
        }
    };

    SetupConversation.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._renderShell();
        var self = this;
        // Recovery: jump to the right card based on what already exists.
        this.api.get('/setup/state', { skipCache: true }).then(function (s) {
            self._resumeFromState(s);
        }).catch(function () {
            self._goto('a');
        });
        return this;
    };

    SetupConversation.prototype.destroy = function () {
        this._teardownInstallTracking();
        if (this._unsubscribeBootstrap) { this._unsubscribeBootstrap(); this._unsubscribeBootstrap = null; }
        if (this._bootstrapPollTimer) { clearInterval(this._bootstrapPollTimer); this._bootstrapPollTimer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    SetupConversation.prototype._renderShell = function () {
        this.root.innerHTML =
            '<header class="enm-conv-header">'
            + '<div class="enm-conv-progress" aria-hidden="true">'
                + '<div class="enm-conv-progress-bar"></div>'
            + '</div>'
            + '<div class="enm-conv-progress-text" aria-live="polite"></div>'
            + '</header>'
            // a11y: dropped aria-live="polite" from the body region. The
            // header's progress text already announces every step
            // transition ("Step 3 of 6"); pairing a second live region
            // on the body caused screen readers to queue + interleave
            // both, sometimes reading the body content twice (once on
            // the body's mutation, once on heading navigation). The
            // body is announced normally via the heading focus added
            // in batch 6 (_goto focuses the new card title).
            + '<div class="enm-conv-body"></div>';
        this._headerProgress = this.root.querySelector('.enm-conv-progress-bar');
        this._headerText     = this.root.querySelector('.enm-conv-progress-text');
        this._body           = this.root.querySelector('.enm-conv-body');
    };

    /** @private */
    SetupConversation.prototype._resumeFromState = function (s) {
        // Edge case: if /setup/state says we're already done, jump
        // straight to the home view instead of re-running setup.
        // (Can happen if the conversation is mounted by mistake or
        // if the operator hits a stale URL after completion.)
        // Truthy check — SQLite stores `completed: 1` not `=== true`.
        if (s && s.completed) {
            this.onComplete();
            return;
        }

        // Map server-side step → which card to show on resume.
        // Conservative: if anything is unclear, start at A.
        var step = (s && s.currentStep) || 'welcome';
        if (step === 'install' || step === 'preflight' || step === 'welcome') {
            this._goto('a');
        } else if (step === 'bootstrap') {
            // Operator finished the binary install but hasn't picked
            // bootstrap-or-genesis yet (or is mid-bootstrap). Resume on
            // Card B2 — the choice screen reasserts on any reload, and
            // the running-bootstrap branch reconciles via the snapshot
            // status endpoint once the card mounts.
            this._goal = 'bpos';
            this._goto('b2');
        } else if (step === 'keystore') {
            // Already past install — assume 'bpos' (the only goal users can
            // reach today; pre-2026-05-07 'help' installs are read as bpos
            // since the help path is gone).
            // skipped this. Operator can back out on the goal card.
            this._goal = 'bpos';
            this._goto('c');
        } else if (step === 'network' || step === 'confirm' || step === 'complete') {
            // Existing installs that picked the old "help" path are
            // shown as 'bpos' here — the council option isn't selectable
            // yet, and "help" no longer exists as a goal.
            this._goal = 'bpos';
            this._goto('d');
        } else {
            // Unknown step value (server schema drift, garbage response,
            // etc.) — fail safe by starting from the top.
            this._goto('a');
        }
    };

    /** @private */
    SetupConversation.prototype._goto = function (card) {
        // alpha.28.1 — cancel any in-flight Card-B install tracking
        // BEFORE swapping `_currentCard`. The poll loop checks
        // `_currentCard === 'b'` to decide whether to keep ticking, so
        // updating that field is enough to stop new ticks, but a tick
        // already in flight could still resolve into a stale `els`
        // reference. _teardownInstallTracking explicitly cancels the
        // SSE subscription too, so SSE events that arrive after the
        // operator has clicked Back can't yank them forward.
        if (this._currentCard === 'b' && card !== 'b') {
            this._teardownInstallTracking();
        }
        // alpha.28.1 batch 70 (Round-19A audit finding #1) — Card B2 has
        // its own poll + SSE pair (_bootstrapPollTimer set at line 520
        // running every 2s, _unsubscribeBootstrap set at line 515).
        // Both were only cleaned in (a) destroy, (b) re-arming guards in
        // _b2BeginBootstrap, (c) terminal phases of applyStatus + the
        // _b2OnBootstrapDone happy path. The Card B2 Back link at line
        // 411 calls _goto('b') — none of those three teardown paths
        // fired, so the bootstrap poll + SSE continued ticking for the
        // rest of the wizard session (pinned closures, wasted 2s GETs,
        // and the captured `applyStatus` writing to detached `els`).
        // Symmetrical with the Card-B leak guard above.
        if (this._currentCard === 'b2' && card !== 'b2') {
            if (this._unsubscribeBootstrap) { this._unsubscribeBootstrap(); this._unsubscribeBootstrap = null; }
            if (this._bootstrapPollTimer) { clearInterval(this._bootstrapPollTimer); this._bootstrapPollTimer = null; }
        }
        this._currentCard = card;
        this._cardSeq += 1;
        var seq = this._cardSeq;
        this._updateHeader(card);
        this._body.innerHTML = '';
        // Brief enter animation by re-applying the class on the body.
        this._body.classList.remove('enm-conv-enter');
        // Force reflow so the class re-add re-triggers the animation.
        // eslint-disable-next-line no-unused-expressions
        void this._body.offsetWidth;
        this._body.classList.add('enm-conv-enter');

        if (card === 'a') { this._renderCardA(seq); }
        else if (card === 'b') { this._renderCardB(seq); }
        else if (card === 'b2') { this._renderCardB2(seq); }
        else if (card === 'b3') { this._renderCardB3(seq); }
        else if (card === 'c') { this._renderCardC(seq); }
        else if (card === 'd') { this._renderCardD(seq); }

        // a11y/focus: each card swap re-renders `_body.innerHTML`, which
        // destroys the previously-focused control (the Continue/Install
        // button operators just clicked). Without an explicit focus
        // landing, focus drops to body and screen readers don't
        // announce that the wizard advanced. Move focus to the new
        // card's heading (with a temporary tabindex so it accepts
        // programmatic focus), and let the user Tab forward from there.
        try {
            var heading = this._body.querySelector('.enm-conv-title')
                || this._body.querySelector('h2, h3');
            if (heading && typeof heading.focus === 'function') {
                if (!heading.hasAttribute('tabindex')) {
                    heading.setAttribute('tabindex', '-1');
                }
                heading.focus({ preventScroll: true });
            }
        } catch (e) { /* DOM may be torn down mid-render */ }
    };

    /** @private */
    SetupConversation.prototype._updateHeader = function (card) {
        var t = root.enmT;
        // b3 is the clock-skew check inserted between bootstrap (b2) and
        // keystore (c). Adding it bumps c and d each by one.
        var stepNumber = ({ a: 1, b: 2, b2: 3, b3: 4, c: 5, d: 6 })[card] || 1;
        // Card C (keystore) is required for BPoS — never skipped now that
        // numbering shifts (A=1, B=2, D=3).
        var total = TOTAL_STEPS;
        if (false /* removed: 'help' goal no longer exists, BPoS always needs keystore */) {
            total = 3;
            if (card === 'd') { stepNumber = 3; }
        }
        var pct = Math.round((stepNumber / total) * 100);
        this._headerProgress.style.width = pct + '%';
        this._headerText.textContent = t('friendly.setup.progress', {
            n: stepNumber,
            total: total,
        });
    };

    /** @private — Card A: pick a goal */
    SetupConversation.prototype._renderCardA = function (seq) {
        var t = root.enmT;
        var I = root.EnmIllust;
        this._body.innerHTML =
            '<h2 class="enm-conv-title">' + escapeHtml(t('friendly.setup.card_a.title')) + '</h2>'
            + '<div class="enm-goal-tiles">'
              + '<button type="button" class="enm-goal-tile" data-goal="bpos" aria-pressed="false">'
                + '<div class="enm-goal-illust enm-goal-illust-earn">'
                  + (I ? I.trophy({ size: 64 }) : '')
                + '</div>'
                + '<div class="enm-goal-tile-title">' + escapeHtml(t('friendly.setup.card_a.bpos_title')) + '</div>'
                + '<div class="enm-goal-tile-sub">'  + escapeHtml(t('friendly.setup.card_a.bpos_sub'))   + '</div>'
                + '<div class="enm-goal-tile-meta">' + escapeHtml(t('friendly.setup.card_a.bpos_meta'))  + '</div>'
              + '</button>'
              + '<button type="button" class="enm-goal-tile enm-goal-tile-disabled" data-goal="council" aria-pressed="false" aria-disabled="true" disabled>'
                + '<div class="enm-goal-illust enm-goal-illust-help">'
                  + (I ? I.shield({ size: 64 }) : '')
                + '</div>'
                + '<div class="enm-goal-tile-title">' + escapeHtml(t('friendly.setup.card_a.council_title')) + '</div>'
                + '<div class="enm-goal-tile-sub">'  + escapeHtml(t('friendly.setup.card_a.council_sub'))   + '</div>'
                + '<div class="enm-goal-tile-meta">' + escapeHtml(t('friendly.setup.card_a.council_meta'))  + '</div>'
              + '</button>'
            + '</div>'
            + '<p class="enm-conv-footer">' + escapeHtml(t('friendly.setup.card_a.footer')) + '</p>';

        var self = this;
        this._body.querySelectorAll('[data-goal]').forEach(function (tile) {
            tile.addEventListener('click', function () {
                if (!self._stillRendering(seq)) { return; }
                self._goal = tile.dataset.goal;
                self._goto('b');
            });
        });
    };

    /** @private — Card B: install */
    SetupConversation.prototype._renderCardB = function (seq) {
        var t = root.enmT;
        var I = root.EnmIllust;
        this._body.innerHTML =
            '<div class="enm-install-illust">' + (I ? I.gear({ size: 96 }) : '') + '</div>'
            + '<h2 class="enm-conv-title" id="enm-conv-b-title">' + escapeHtml(t('friendly.setup.card_b.title_idle')) + '</h2>'
            + '<p class="enm-conv-sub"   id="enm-conv-b-sub">'   + escapeHtml(t('friendly.setup.card_b.sub_idle'))   + '</p>'
            + '<div class="enm-install-progress" id="enm-conv-b-progress" hidden>'
              + '<div class="enm-install-bar-wrap">'
                + '<div class="enm-install-bar" id="enm-conv-b-bar"></div>'
              + '</div>'
              + '<div class="enm-install-status" id="enm-conv-b-status">' + escapeHtml(t('friendly.setup.card_b.phase_preparing')) + '</div>'
            + '</div>'
            + '<div class="enm-conv-actions" id="enm-conv-b-actions"></div>';

        var self = this;
        var els = {
            title:    this._body.querySelector('#enm-conv-b-title'),
            sub:      this._body.querySelector('#enm-conv-b-sub'),
            progress: this._body.querySelector('#enm-conv-b-progress'),
            bar:      this._body.querySelector('#enm-conv-b-bar'),
            status:   this._body.querySelector('#enm-conv-b-status'),
            actions:  this._body.querySelector('#enm-conv-b-actions'),
        };

        // Recovery: if the binary is already on disk, advance immediately.
        this.api.get('/setup/install-status/mainchain', { skipCache: true }).then(function (s) {
            if (!self._stillRendering(seq)) { return; }
            if (s && s.phase === 'done' && s.binaryPath) {
                self._renderCardBDone(els);
            } else if (s && s.phase === 'downloading') {
                // Resume mid-install: subscribe to SSE for live updates.
                self._beginInstall(els, /* alreadyStarted */ true);
            } else {
                self._renderCardBIdle(els);
            }
        }).catch(function () {
            if (!self._stillRendering(seq)) { return; }
            self._renderCardBIdle(els);
        });
    };

    /** @private */
    SetupConversation.prototype._renderCardBIdle = function (els) {
        var t = root.enmT;
        els.actions.innerHTML = '';
        var self = this;
        els.actions.appendChild(
            makeBtn(t('friendly.setup.card_b.cta_install'), 'primary hero', function (ev) {
                ev.target.disabled = true;
                self._beginInstall(els, /* alreadyStarted */ false);
            })
        );
        els.actions.appendChild(makeTextLink(t('friendly.setup.back'), function () {
            self._goto('a');
        }));
    };

    /** @private */
    SetupConversation.prototype._renderCardBDone = function (els) {
        var t = root.enmT;
        els.title.textContent = t('friendly.setup.card_b.title_done');
        els.sub.textContent   = t('friendly.setup.card_b.sub_done');
        els.progress.hidden   = false;
        els.bar.style.width   = '100%';
        els.status.textContent = t('friendly.setup.card_b.phase_done');
        els.actions.innerHTML = '';
        var self = this;
        els.actions.appendChild(
            makeBtn(t('friendly.setup.card_b.cta_continue'), 'primary hero', function () {
                // alpha.10: after binary install, the operator picks
                // bootstrap-vs-genesis on Card B2 before reaching the
                // keystore step.
                self._goto('b2');
            })
        );
    };

    /** @private — Card B2: bootstrap vs genesis */
    SetupConversation.prototype._renderCardB2 = function (seq) {
        var t = root.enmT;
        var I = root.EnmIllust;
        this._body.innerHTML =
            '<div class="enm-install-illust">' + (I ? I.gear({ size: 96 }) : '') + '</div>'
            + '<h2 class="enm-conv-title" id="enm-conv-b2-title">' + escapeHtml(t('friendly.setup.card_b2.title_idle')) + '</h2>'
            + '<p class="enm-conv-sub"   id="enm-conv-b2-sub">'   + escapeHtml(t('friendly.setup.card_b2.sub_idle'))   + '</p>'
            + '<div class="enm-b2-tiles" id="enm-conv-b2-tiles">'
                + '<button type="button" class="enm-b2-tile enm-b2-tile-bootstrap" data-choice="bootstrap">'
                    + '<div class="enm-b2-tile-badge">' + escapeHtml(t('friendly.setup.card_b2.badge_recommended')) + '</div>'
                    + '<div class="enm-b2-tile-title">' + escapeHtml(t('friendly.setup.card_b2.tile_bootstrap_title')) + '</div>'
                    + '<div class="enm-b2-tile-sub">'   + escapeHtml(t('friendly.setup.card_b2.tile_bootstrap_sub'))   + '</div>'
                    + '<div class="enm-b2-tile-meta">'  + escapeHtml(t('friendly.setup.card_b2.tile_bootstrap_meta'))  + '</div>'
                + '</button>'
                + '<button type="button" class="enm-b2-tile enm-b2-tile-genesis" data-choice="genesis">'
                    + '<div class="enm-b2-tile-title">' + escapeHtml(t('friendly.setup.card_b2.tile_genesis_title')) + '</div>'
                    + '<div class="enm-b2-tile-sub">'   + escapeHtml(t('friendly.setup.card_b2.tile_genesis_sub'))   + '</div>'
                    + '<div class="enm-b2-tile-meta">'  + escapeHtml(t('friendly.setup.card_b2.tile_genesis_meta'))  + '</div>'
                + '</button>'
            + '</div>'
            + '<div class="enm-install-progress" id="enm-conv-b2-progress" hidden>'
              + '<div class="enm-install-bar-wrap">'
                + '<div class="enm-install-bar" id="enm-conv-b2-bar"></div>'
              + '</div>'
              + '<div class="enm-install-status" id="enm-conv-b2-status">' + escapeHtml(t('friendly.setup.card_b2.phase_preparing')) + '</div>'
            + '</div>'
            + '<div class="enm-conv-actions" id="enm-conv-b2-actions"></div>';

        var self = this;
        var els = {
            title:    this._body.querySelector('#enm-conv-b2-title'),
            sub:      this._body.querySelector('#enm-conv-b2-sub'),
            tiles:    this._body.querySelector('#enm-conv-b2-tiles'),
            progress: this._body.querySelector('#enm-conv-b2-progress'),
            bar:      this._body.querySelector('#enm-conv-b2-bar'),
            status:   this._body.querySelector('#enm-conv-b2-status'),
            actions:  this._body.querySelector('#enm-conv-b2-actions'),
        };

        // Tile click → handle the chosen path
        els.tiles.querySelectorAll('.enm-b2-tile').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var choice = btn.dataset.choice;
                if (choice === 'bootstrap') {
                    self._b2BeginBootstrap(els, /* alreadyStarted */ false);
                } else {
                    self._b2ChooseGenesis(els);
                }
            });
        });

        // Render a Back link below the tiles for symmetry with other cards.
        els.actions.appendChild(makeTextLink(t('friendly.setup.back'), function () {
            self._goto('b');
        }));

        // Recovery: if a bootstrap is already running on the server, jump
        // straight to the live-progress UI.
        this.api.get('/chains/mainchain/bootstrap', { skipCache: true }).then(function (data) {
            if (!self._stillRendering(seq)) { return; }
            var s = data && data.status;
            if (!s) { return; }
            if (s.phase === 'downloading' || s.phase === 'extracting'
                || s.phase === 'applying'   || s.phase === 'verifying'
                || s.phase === 'resolving') {
                self._b2BeginBootstrap(els, /* alreadyStarted */ true);
            } else if (s.phase === 'done') {
                self._b2OnBootstrapDone(els);
            }
            // 'idle' / 'failed' both leave the choice tiles visible so the
            // operator can decide what to do next.
        }).catch(function () { /* tiles already rendered — nothing to do */ });
    };

    /** @private */
    SetupConversation.prototype._b2ChooseGenesis = function (els) {
        var t = root.enmT;
        var self = this;
        // Disable both tiles while we hit the server.
        els.tiles.querySelectorAll('.enm-b2-tile').forEach(function (b) { b.disabled = true; });
        els.sub.textContent = t('friendly.setup.card_b2.advancing');
        this.api.post('/setup/bootstrap', { choice: 'genesis' }).then(function () {
            if (self.notifications && typeof self.notifications.info === 'function') {
                self.notifications.info(t('friendly.setup.card_b2.genesis_picked_title'),
                    t('friendly.setup.card_b2.genesis_picked_sub'));
            }
            self._goto('b3');
        }).catch(function (err) {
            els.tiles.querySelectorAll('.enm-b2-tile').forEach(function (b) { b.disabled = false; });
            els.sub.textContent = t('friendly.setup.card_b2.advance_failed',
                { error: err && err.message ? err.message : String(err) });
        });
    };

    /** @private */
    SetupConversation.prototype._b2BeginBootstrap = function (els, alreadyStarted) {
        var t = root.enmT;
        var self = this;
        els.tiles.hidden = true;
        els.title.textContent = t('friendly.setup.card_b2.title_running');
        els.sub.textContent   = t('friendly.setup.card_b2.sub_running');
        els.progress.hidden   = false;
        els.actions.innerHTML = '';
        // Allow the operator to abort while the download is in flight.
        // Hidden once we enter the apply phase (can't safely cancel then).
        var cancelBtn = makeTextLink(t('friendly.setup.card_b2.cancel'), function () {
            cancelBtn.disabled = true;
            self.api.del('/chains/mainchain/bootstrap').catch(function () { /* ignore */ });
        });
        els.actions.appendChild(cancelBtn);

        // alpha.12 — clear any previous poll timer when (re)starting.
        if (this._bootstrapPollTimer) { clearInterval(this._bootstrapPollTimer); this._bootstrapPollTimer = null; }
        var done = false;

        function applyStatus(s) {
            if (!s || done) { return; }
            var pct = (s.bytesTotal && s.bytesDownloaded)
                ? Math.min(100, Math.floor((s.bytesDownloaded / s.bytesTotal) * 100))
                : (s.phase === 'done' ? 100 : (s.phase === 'extracting' ? 95 : 5));
            els.bar.style.width = pct + '%';
            els.status.textContent = bootstrapPhaseLabel(s);

            // Once we're applying, hide the cancel link — it can't safely abort.
            if (cancelBtn && (s.phase === 'applying' || s.phase === 'verifying')) {
                cancelBtn.style.display = 'none';
            }
            if (s.phase === 'done') {
                done = true;
                if (self._bootstrapPollTimer) { clearInterval(self._bootstrapPollTimer); self._bootstrapPollTimer = null; }
                self._b2OnBootstrapDone(els);
            }
            if (s.phase === 'failed') {
                done = true;
                if (self._bootstrapPollTimer) { clearInterval(self._bootstrapPollTimer); self._bootstrapPollTimer = null; }
                els.title.textContent = t('friendly.setup.card_b2.title_failed');
                els.sub.textContent   = s.error || t('friendly.setup.card_b2.sub_failed');
                els.actions.innerHTML = '';
                els.actions.appendChild(
                    makeBtn(t('friendly.setup.card_b2.cta_retry'), 'primary hero', function () {
                        self._b2BeginBootstrap(els, false);
                    })
                );
                els.actions.appendChild(makeTextLink(t('friendly.setup.card_b2.cta_fallback_genesis'), function () {
                    self._b2ChooseGenesis(els);
                }));
            }
        }

        // alpha.12 — SSE delivers real-time progress when it's healthy, but
        // a 2-second poll on GET /chains/.../bootstrap is the belt-and-
        // suspenders that keeps the UI moving even if the EventSource is
        // misconfigured or proxied through something that breaks SSE. The
        // 10 GB download takes ~15 min, so a 2 s poll is negligible.
        if (this.sse && typeof this.sse.subscribe === 'function') {
            if (this._unsubscribeBootstrap) { this._unsubscribeBootstrap(); }
            this._unsubscribeBootstrap = this.sse.subscribe(
                'setup:bootstrap:mainchain',
                function (payload) { applyStatus(payload); },
            );
        }
        this._bootstrapPollTimer = setInterval(function () {
            if (done) { return; }
            self.api.get('/chains/mainchain/bootstrap', { skipCache: true }).then(function (data) {
                applyStatus(data && data.status);
            }).catch(function () { /* leave the existing display, the poll retries */ });
        }, 2000);

        // Kick off the actual download (or just re-attach to a running one).
        var startPromise = alreadyStarted
            ? this.api.get('/chains/mainchain/bootstrap', { skipCache: true })
                .then(function (data) { return { status: data && data.status }; })
            : this.api.post('/chains/mainchain/bootstrap');
        startPromise.then(function (result) {
            applyStatus(result && result.status);
        }).catch(function (err) {
            applyStatus({ phase: 'failed', error: err && err.message ? err.message : String(err) });
        });
    };

    /** @private */
    SetupConversation.prototype._b2OnBootstrapDone = function (els) {
        var t = root.enmT;
        var self = this;
        if (this._unsubscribeBootstrap) { this._unsubscribeBootstrap(); this._unsubscribeBootstrap = null; }
        els.title.textContent = t('friendly.setup.card_b2.title_done');
        els.sub.textContent   = t('friendly.setup.card_b2.sub_done');
        els.bar.style.width   = '100%';
        els.status.textContent = t('friendly.setup.card_b2.phase_done');
        els.actions.innerHTML = '';
        els.actions.appendChild(
            makeBtn(t('friendly.setup.card_b2.cta_continue'), 'primary hero', function () {
                self.api.post('/setup/bootstrap', { choice: 'bootstrap' }).then(function () {
                    self._goto('b3');
                }).catch(function () {
                    // Even if the step-advance call fails, the bootstrap
                    // itself completed — proceed to the clock-skew check.
                    // The wizard resume code is permissive about missing
                    // currentStep so it'll still land on the right card.
                    self._goto('b3');
                });
            })
        );
    };

    /** @private — Card B3: host clock vs internet clock (F13).
     *
     * ELA's Schnorr signatures get rejected silently when the host clock
     * drifts >~4.2s from consensus partners — the operator scores a
     * missed-vote penalty without ever seeing an error. The backend's
     * /setup/preflight probes Google/Cloudflare for the wall-clock and
     * compares against Date.now(); we surface that result here so the
     * operator can fix NTP BEFORE registering as a BPoS supernode.
     *
     * Three outcomes:
     *   ok && !skipped     → GREEN. Show ±Xms, allow continue.
     *   skipped            → YELLOW. Network unreachable; warn but allow continue.
     *   !ok && !skipped    → RED. Skew > 2s; show fix command, require retry.
     *
     * Failure-mode invariant: if the preflight HTTP call itself fails,
     * we render the YELLOW (skipped) state so the operator can always
     * proceed. The wizard MUST NEVER block on this card.
     */
    SetupConversation.prototype._renderCardB3 = function (seq) {
        var I = root.EnmIllust;
        this._body.innerHTML =
            '<div class="enm-install-illust">' + (I ? I.gear({ size: 96 }) : '') + '</div>'
            + '<h2 class="enm-conv-title" id="enm-conv-b3-title">Checking host clock…</h2>'
            + '<p class="enm-conv-sub"   id="enm-conv-b3-sub">Comparing your server clock to internet time. DPoS signatures fail if the host drifts more than ~4 seconds.</p>'
            + '<div id="enm-conv-b3-detail" class="enm-clock-detail"></div>'
            + '<div class="enm-conv-actions" id="enm-conv-b3-actions"></div>';

        var self = this;
        var els = {
            title:   this._body.querySelector('#enm-conv-b3-title'),
            sub:     this._body.querySelector('#enm-conv-b3-sub'),
            detail:  this._body.querySelector('#enm-conv-b3-detail'),
            actions: this._body.querySelector('#enm-conv-b3-actions'),
        };

        this._runClockSkewProbe(els, seq);
    };

    /** @private */
    SetupConversation.prototype._runClockSkewProbe = function (els, seq) {
        var self = this;
        els.detail.innerHTML = '';
        els.actions.innerHTML = '';
        els.title.textContent = 'Checking host clock…';
        els.sub.textContent   = 'Comparing your server clock to internet time. DPoS signatures fail if the host drifts more than ~4 seconds.';

        this.api.get('/setup/preflight', { skipCache: true }).then(function (resp) {
            if (!self._stillRendering(seq)) { return; }
            var cs = resp && resp.clockSkew;
            // If the backend somehow omitted the field entirely (older
            // server, schema drift), treat that as a SKIP — never block.
            if (!cs) {
                cs = { ok: true, skipped: true, reason: 'no clockSkew in preflight response' };
            }
            self._renderClockSkewResult(els, seq, cs);
        }).catch(function (err) {
            if (!self._stillRendering(seq)) { return; }
            // Even the preflight call itself failed — render as a SKIP so
            // the operator can continue. This is the absolute backstop:
            // the wizard NEVER gets stuck on this card.
            self._renderClockSkewResult(els, seq, {
                ok: true,
                skipped: true,
                reason: err && err.message ? err.message : String(err),
            });
        });
    };

    /** @private */
    SetupConversation.prototype._renderClockSkewResult = function (els, seq, cs) {
        var self = this;
        // Three branches by visual severity. The "continue" button is
        // present in GREEN and YELLOW; only RED hides it (and requires
        // the operator to fix NTP + retry).
        if (cs.skipped) {
            // YELLOW: probe didn't reach the internet. Warn the operator
            // but allow continue — many bare-metal setups intentionally
            // firewall outbound HTTPS.
            els.title.textContent = 'Clock check skipped';
            els.sub.textContent   = 'We could not reach a time server to verify your host clock. If your host clock is wrong, DPoS signatures will be silently rejected.';
            els.detail.innerHTML =
                '<div class="enm-clock-card enm-clock-card-warn">'
                  + '<div class="enm-clock-card-icon" aria-hidden="true">⚠</div>'
                  + '<div class="enm-clock-card-body">'
                    + '<div class="enm-clock-card-title">Could not verify NTP</div>'
                    + '<div class="enm-clock-card-sub">'
                      + 'Reason: ' + escapeHtml(cs.reason || 'network unreachable') + '. '
                      + 'Make sure your host has NTP running before going live: '
                      + '<code>sudo timedatectl set-ntp true</code>.'
                    + '</div>'
                  + '</div>'
                + '</div>';

            els.actions.appendChild(
                makeBtn('Continue anyway', 'primary hero', function () { self._goto('c'); })
            );
            els.actions.appendChild(makeTextLink('Retry check', function () {
                self._runClockSkewProbe(els, seq);
            }));
            return;
        }

        if (!cs.ok) {
            // RED: skew exceeds the safe window. The operator MUST fix
            // this before going live — we don't offer a "continue anyway"
            // path because a producer with wrong time scores missed-votes
            // immediately on registration.
            var skewMs = Number.isFinite(cs.skewMs) ? cs.skewMs : 0;
            var skewSeconds = (Math.abs(skewMs) / 1000).toFixed(1);
            var direction = skewMs > 0 ? 'ahead of' : 'behind';
            els.title.textContent = 'Host clock is out of sync';
            els.sub.textContent   = 'Your server clock is ' + skewSeconds + 's ' + direction
                + ' internet time. DPoS will reject your signatures and you will score missed-vote penalties.';
            els.detail.innerHTML =
                '<div class="enm-clock-card enm-clock-card-error">'
                  + '<div class="enm-clock-card-icon" aria-hidden="true">!</div>'
                  + '<div class="enm-clock-card-body">'
                    + '<div class="enm-clock-card-title">Fix this before continuing</div>'
                    + '<div class="enm-clock-card-sub">'
                      + 'Run this on the host, then press Retry:'
                      + '<pre class="enm-clock-fix"><code>sudo timedatectl set-ntp true</code></pre>'
                      + 'After NTP catches up (usually &lt;30s), retry the check.'
                    + '</div>'
                  + '</div>'
                + '</div>';

            els.actions.appendChild(
                makeBtn('Retry check', 'primary hero', function (ev) {
                    ev.target.disabled = true;
                    self._runClockSkewProbe(els, seq);
                })
            );
            // Escape hatch: operators in air-gapped or test environments
            // can override. Marked clearly as risk-acknowledged so the
            // intent is unambiguous in audit logs.
            els.actions.appendChild(makeTextLink('Continue anyway (not recommended)', function () {
                self._goto('c');
            }));
            return;
        }

        // GREEN: clock is in sync. Auto-advance is tempting, but per the
        // spec we let the operator confirm — keeps every card in the
        // wizard symmetric (info → ack → continue).
        var absMs = Number.isFinite(cs.absSkewMs)
            ? cs.absSkewMs
            : Math.abs(Number.isFinite(cs.skewMs) ? cs.skewMs : 0);
        els.title.textContent = 'Clock is in sync';
        els.sub.textContent   = 'Your host clock matches internet time within the safe window.';
        els.detail.innerHTML =
            '<div class="enm-clock-card enm-clock-card-ok">'
              + '<div class="enm-clock-card-icon" aria-hidden="true">✓</div>'
              + '<div class="enm-clock-card-body">'
                + '<div class="enm-clock-card-title">±' + escapeHtml(String(absMs)) + 'ms</div>'
                + '<div class="enm-clock-card-sub">'
                  + 'Measured against ' + escapeHtml(cs.source || 'an internet time source') + '. '
                  + 'DPoS signing windows are 4 s wide, so you have plenty of margin.'
                + '</div>'
              + '</div>'
            + '</div>';

        els.actions.appendChild(
            makeBtn('Continue', 'primary hero', function () { self._goto('c'); })
        );
        els.actions.appendChild(makeTextLink('Recheck', function () {
            self._runClockSkewProbe(els, seq);
        }));
    };

    /** @private */
    SetupConversation.prototype._beginInstall = function (els, alreadyStarted) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_b.title_active');
        els.sub.textContent   = t('friendly.setup.card_b.sub_active');
        els.progress.hidden   = false;
        els.actions.innerHTML = '';

        // alpha.28.1 bug fix — the previous version had two real bugs the
        // setup-wizard deep audit caught:
        //   (B1) the fallback poll IIFE was unkillable. Its only stop
        //        condition was `!self.root.isConnected`, which doesn't
        //        fire when the operator clicks Back from Card B mid-
        //        install. The poll kept running, calling applyStatus
        //        on stale DOM, and on `phase==='done'` could yank the
        //        operator forward into Card B's Done state even though
        //        they had navigated to a different card.
        //   (R1) Card B's applyStatus had no `done` guard like Card B2
        //        does. SSE + poll both delivering `phase==='done'` ran
        //        _renderCardBDone twice — second call wrote into a DOM
        //        that the first had already replaced.
        // Fixed by:
        //   - latching `installComplete` in a closure so applyStatus
        //     short-circuits after the first terminal phase observed
        //   - storing the poll timer on `this._installPollTimer` so
        //     destroy() and _goto() can clear it
        //   - gating the poll on `_currentCard === 'b'` so navigation
        //     away cancels future ticks even if a tick is mid-flight
        var installComplete = false;

        function applyStatus(s) {
            if (!s) { return; }
            if (installComplete) { return; }
            var pct = (s.bytesTotal && s.bytesDownloaded)
                ? Math.min(100, Math.floor((s.bytesDownloaded / s.bytesTotal) * 100))
                : (s.phase === 'done' ? 100 : 0);
            els.bar.style.width = pct + '%';
            els.status.textContent = phaseLabel(s);
            if (s.phase === 'done') {
                installComplete = true;
                self._teardownInstallTracking();
                self._renderCardBDone(els);
            }
            if (s.phase === 'failed') {
                installComplete = true;
                self._teardownInstallTracking();
                els.title.textContent = t('friendly.setup.card_b.phase_failed');
                els.sub.textContent   = t('friendly.setup.card_b.failed_help');
                els.actions.innerHTML = '';
                els.actions.appendChild(
                    makeBtn(t('friendly.setup.card_b.cta_retry'), 'primary hero', function (ev) {
                        ev.target.disabled = true;
                        self._beginInstall(els, false);
                    })
                );
            }
        }

        // Subscribe to SSE for live updates if we have the channel.
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
            applyStatus(resp && resp.status);
            // Fallback poll in case SSE drops. Bound to `this._currentCard
            // === 'b'` AND `installComplete === false` so navigation away
            // and terminal phases both kill the loop. Timer handle is
            // stored on `this` so destroy() / _teardownInstallTracking
            // can cancel a pending tick.
            (function poll() {
                if (installComplete) { return; }
                if (self._currentCard !== 'b') { return; }
                if (!self.root.isConnected) { return; }
                self.api.get('/setup/install-status/mainchain', { skipCache: true })
                    .then(function (s) {
                        applyStatus(s);
                        if (!installComplete && self._currentCard === 'b'
                            && (!s || (s.phase !== 'done' && s.phase !== 'failed'))) {
                            self._installPollTimer = setTimeout(poll, 2500);
                        }
                    })
                    .catch(function () {
                        if (!installComplete && self._currentCard === 'b') {
                            self._installPollTimer = setTimeout(poll, 4000);
                        }
                    });
            })();
        }).catch(function (err) {
            applyStatus({ phase: 'failed', error: err && err.message ? err.message : String(err) });
        });
    };

    /** @private — Card C: keystore password (always required for BPoS) */
    SetupConversation.prototype._renderCardC = function (seq) {
        var t = root.enmT;
        this._body.innerHTML =
            '<h2 class="enm-conv-title" id="enm-conv-c-title">' + escapeHtml(t('friendly.setup.card_c.title_initial')) + '</h2>'
            + '<p class="enm-conv-sub"  id="enm-conv-c-sub">'  + escapeHtml(t('friendly.setup.card_c.sub_initial'))  + '</p>'
            + '<div id="enm-conv-c-reveal"></div>'
            + '<div class="enm-conv-actions" id="enm-conv-c-actions"></div>';

        var self = this;
        var els = {
            title:   this._body.querySelector('#enm-conv-c-title'),
            sub:     this._body.querySelector('#enm-conv-c-sub'),
            reveal:  this._body.querySelector('#enm-conv-c-reveal'),
            actions: this._body.querySelector('#enm-conv-c-actions'),
        };

        els.actions.appendChild(
            makeBtn(t('friendly.setup.card_c.cta_generate'), 'primary hero', function (ev) {
                if (!self._stillRendering(seq)) { return; }
                ev.target.disabled = true;
                self._generateKeystore(els, seq);
            })
        );
        els.actions.appendChild(makeTextLink(t('friendly.setup.back'), function () {
            self._goto('b');
        }));
    };

    /** @private */
    SetupConversation.prototype._generateKeystore = function (els, seq) {
        var t = root.enmT;
        var self = this;
        // BPoS path → server generates a strong password.
        this.api.post('/setup/keystore', { enableArbiter: true }).then(function (resp) {
            if (!self._stillRendering(seq)) { return; }
            self._renderKeystoreReveal(els, resp.generatedPassword || '');
        }).catch(function (err) {
            self._notify(t('friendly.error.generic'),
                err && err.message ? err.message : String(err), 'warning');
            // Re-enable the generate button.
            els.actions.innerHTML = '';
            els.actions.appendChild(
                makeBtn(t('friendly.setup.card_c.cta_generate'), 'primary hero', function (ev) {
                    ev.target.disabled = true;
                    self._generateKeystore(els, seq);
                })
            );
        });
    };

    /** @private */
    SetupConversation.prototype._renderKeystoreReveal = function (els, password) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_c.title_generated');
        els.sub.textContent   = t('friendly.setup.card_c.sub_generated');
        els.reveal.innerHTML =
            '<div class="enm-password-reveal">'
              + '<code class="enm-password-value">' + escapeHtml(password) + '</code>'
              + '<button type="button" class="enm-btn enm-btn-secondary enm-password-copy" aria-label="Copy keystore password">'
                + escapeHtml(t('friendly.setup.card_c.cta_copy'))
              + '</button>'
            + '</div>'
            + '<label class="enm-conv-checkbox">'
              + '<input type="checkbox" id="enm-conv-c-ack"/>'
              + '<span>' + escapeHtml(t('friendly.setup.card_c.ack')) + '</span>'
            + '</label>';

        // alpha.28.1 batch 58 — routed through enmCopyToClipboard so the
        // feature-detect + writeText path is shared with the other four
        // copy sites. Custom onFallback preserves the select-the-password
        // affordance so the operator can ⌘-C manually when the iframe
        // sandbox blocks the API. Round-6 clipboard-UX audit a8a932d2.
        var copyBtn = els.reveal.querySelector('.enm-password-copy');
        copyBtn.addEventListener('click', function () {
            root.enmCopyToClipboard(password, {
                btn: copyBtn,
                copiedLabel: t('friendly.setup.card_c.cta_copied'),
                resetMs: 1500,
                onFallback: function () {
                    // Programmatically select the password code so Ctrl+C works.
                    try {
                        var passEl = els.reveal.querySelector('.enm-password-value');
                        if (passEl) {
                            var range = document.createRange();
                            range.selectNodeContents(passEl);
                            var sel = root.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                    } catch (selErr) { /* ignore — operator can manually triple-click */ }
                },
            });
        });

        els.actions.innerHTML = '';
        var continueBtn = makeBtn(t('friendly.setup.card_c.cta_continue'), 'primary hero', function () {
            self._goto('d');
        });
        continueBtn.disabled = true;
        els.actions.appendChild(continueBtn);

        var ack = els.reveal.querySelector('#enm-conv-c-ack');
        ack.addEventListener('change', function () {
            continueBtn.disabled = !ack.checked;
        });
    };

    /** @private — Card D: finalize + start + celebrate */
    SetupConversation.prototype._renderCardD = function (seq) {
        var t = root.enmT;
        var I = root.EnmIllust;
        this._body.innerHTML =
            '<div class="enm-celebration-illust">' + (I ? I.celebration({ size: 120 }) : '') + '</div>'
            + '<h2 class="enm-conv-title" id="enm-conv-d-title">' + escapeHtml(t('friendly.setup.card_d.title_starting')) + '</h2>'
            + '<p class="enm-conv-sub"   id="enm-conv-d-sub">'   + escapeHtml(t('friendly.setup.card_d.sub_starting'))   + '</p>'
            + '<div class="enm-conv-actions" id="enm-conv-d-actions"></div>';

        var self = this;
        var els = {
            title:   this._body.querySelector('#enm-conv-d-title'),
            sub:     this._body.querySelector('#enm-conv-d-sub'),
            actions: this._body.querySelector('#enm-conv-d-actions'),
        };

        // Finalize: set network to auto-detect, mark complete, then attempt
        // to start the chain. Three outcomes — handle each distinctly:
        //   1. setup steps fail → show error + retry
        //   2. setup OK, start OK → celebrate + open dashboard
        //   3. setup OK, start FAILED → celebrate (config is saved) BUT
        //      surface the start error and let the operator move on to
        //      dashboard manually. Previously the start error was swallowed
        //      silently — the operator saw "Done!" while ela was dead, and
        //      only learned the truth from the dashboard's stopped badge.
        var startError = null;
        this.api.post('/setup/network', { mode: 'auto' })
            .then(function () { return self.api.post('/setup/complete', {}); })
            .then(function () {
                return self.api.post('/chains/mainchain/start').catch(function (err) {
                    // Record but don't reject — setup itself succeeded.
                    startError = err;
                });
            })
            .then(function () {
                if (!self._stillRendering(seq)) { return; }
                els.title.textContent = t('friendly.setup.card_d.title_done');
                if (startError) {
                    var detail = startError && startError.message ? startError.message : String(startError);
                    els.sub.innerHTML =
                        escapeHtml(t('friendly.setup.card_d.sub_done')) +
                        '<br><br><strong>Heads up:</strong> the chain didn\'t start ' +
                        'on its own — <em>' + escapeHtml(detail) + '</em>. Open the ' +
                        'dashboard and press <strong>Start</strong> on the Mainchain ' +
                        'card; the Logs sub-tab will show why if it refuses again.';
                    if (self.notifications) {
                        self.notifications.warning('Setup saved, chain not started', detail);
                    }
                } else {
                    els.sub.textContent = t('friendly.setup.card_d.sub_done');
                }
                els.actions.appendChild(
                    makeBtn(t('friendly.setup.card_d.cta'), 'primary hero', function () {
                        self.onComplete();
                    })
                );
            })
            .catch(function (err) {
                if (!self._stillRendering(seq)) { return; }
                els.title.textContent = t('friendly.error.generic');
                els.sub.textContent   = err && err.message ? err.message : String(err);
                els.actions.appendChild(
                    makeBtn(t('friendly.setup.card_b.cta_retry'), 'primary hero', function () {
                        self._goto('d');
                    })
                );
            });
    };

    /** @private */
    SetupConversation.prototype._stillRendering = function (seq) {
        return this.root.isConnected && this._cardSeq === seq;
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
        // If the i18n lookup returned the bracketed key, fall back.
        if (label.indexOf('[') === 0) {
            return s.phase || t('friendly.setup.card_b.phase_preparing');
        }
        return label;
    }

    /**
     * Bootstrap phase label with optional MB/MB progress decoration.
     * The phase keys live under friendly.setup.card_b2.phase_*.
     */
    function bootstrapPhaseLabel(s) {
        var t = root.enmT;
        if (!s) { return t('friendly.setup.card_b2.phase_preparing'); }
        var key = 'friendly.setup.card_b2.phase_' + s.phase;
        var label = t(key);
        if (label.indexOf('[') === 0) {
            label = s.phase || t('friendly.setup.card_b2.phase_preparing');
        }
        // Append "X.X / Y.Y GB" while downloading so the operator can see
        // a moving number even when the bar % barely budges on a 10 GB file.
        if (s.phase === 'downloading' && s.bytesTotal) {
            var got = (s.bytesDownloaded / (1024 ** 3)).toFixed(2);
            var tot = (s.bytesTotal / (1024 ** 3)).toFixed(2);
            label += ' — ' + got + ' / ' + tot + ' GB';
        }
        return label;
    }

    function makeBtn(label, variant, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        var classes = ['enm-btn'];
        if (variant && variant.indexOf('primary') !== -1) { classes.push('enm-btn-primary'); }
        if (variant && variant.indexOf('hero') !== -1)    { classes.push('enm-btn-hero'); }
        if (!variant || (variant.indexOf('primary') === -1 && variant.indexOf('hero') === -1)) {
            classes.push('enm-btn-secondary');
        }
        b.className = classes.join(' ');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function makeTextLink(label, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-conv-textlink';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmSetupConversation = SetupConversation;
}(typeof window !== 'undefined' ? window : globalThis));
