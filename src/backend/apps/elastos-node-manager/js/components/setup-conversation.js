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

    var TOTAL_STEPS = 5;

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
    }

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
        if (this._unsubscribeInstall) { this._unsubscribeInstall(); }
        if (this._unsubscribeBootstrap) { this._unsubscribeBootstrap(); }
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
            + '<div class="enm-conv-body" aria-live="polite"></div>';
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
        else if (card === 'c') { this._renderCardC(seq); }
        else if (card === 'd') { this._renderCardD(seq); }
    };

    /** @private */
    SetupConversation.prototype._updateHeader = function (card) {
        var t = root.enmT;
        var stepNumber = ({ a: 1, b: 2, b2: 3, c: 4, d: 5 })[card] || 1;
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
            self._goto('c');
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
                    self._goto('c');
                }).catch(function () {
                    // Even if the step-advance call fails, the bootstrap
                    // itself completed — proceed to keystore. The wizard
                    // resume code is permissive about missing currentStep.
                    self._goto('c');
                });
            })
        );
    };

    /** @private */
    SetupConversation.prototype._beginInstall = function (els, alreadyStarted) {
        var t = root.enmT;
        var self = this;
        els.title.textContent = t('friendly.setup.card_b.title_active');
        els.sub.textContent   = t('friendly.setup.card_b.sub_active');
        els.progress.hidden   = false;
        els.actions.innerHTML = '';

        function applyStatus(s) {
            if (!s) { return; }
            var pct = (s.bytesTotal && s.bytesDownloaded)
                ? Math.min(100, Math.floor((s.bytesDownloaded / s.bytesTotal) * 100))
                : (s.phase === 'done' ? 100 : 0);
            els.bar.style.width = pct + '%';
            els.status.textContent = phaseLabel(s);
            if (s.phase === 'done') {
                self._renderCardBDone(els);
            }
            if (s.phase === 'failed') {
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
            // Fallback poll in case SSE drops.
            (function poll() {
                if (!self.root.isConnected) { return; }
                self.api.get('/setup/install-status/mainchain', { skipCache: true })
                    .then(function (s) {
                        applyStatus(s);
                        if (!s || (s.phase !== 'done' && s.phase !== 'failed')) {
                            setTimeout(poll, 2500);
                        }
                    })
                    .catch(function () { setTimeout(poll, 4000); });
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
              + '<button type="button" class="enm-btn enm-btn-secondary enm-password-copy">'
                + escapeHtml(t('friendly.setup.card_c.cta_copy'))
              + '</button>'
            + '</div>'
            + '<label class="enm-conv-checkbox">'
              + '<input type="checkbox" id="enm-conv-c-ack"/>'
              + '<span>' + escapeHtml(t('friendly.setup.card_c.ack')) + '</span>'
            + '</label>';

        var copyBtn = els.reveal.querySelector('.enm-password-copy');
        copyBtn.addEventListener('click', function () {
            try {
                navigator.clipboard.writeText(password).then(function () {
                    copyBtn.textContent = t('friendly.setup.card_c.cta_copied');
                    copyBtn.dataset.copied = '1';
                    setTimeout(function () {
                        copyBtn.textContent = t('friendly.setup.card_c.cta_copy');
                        delete copyBtn.dataset.copied;
                    }, 1500);
                });
            } catch (e) { /* clipboard may be blocked; user can select manually */ }
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
