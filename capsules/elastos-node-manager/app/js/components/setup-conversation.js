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
 *   A — Goal:     "Earn rewards" vs "Help the network" (BPoS vs Full)
 *   B — Install:  one button → progress → done
 *   C — Password: generate + show + acknowledge (skipped for follower)
 *   D — Done:     finalize, start the chain, celebrate
 *
 * Card A's choice maps to:
 *   earn → enableArbiter=true (BPoS supernode, password generated server-side)
 *   help → enableArbiter=false (full-node, no keystore, skip card C)
 *
 * Recovery: on mount we GET /setup/state and jump to the right card so
 * a container restart mid-setup picks up where the operator left off.
 */

(function (root) {
    'use strict';

    var TOTAL_STEPS = 4;

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

        this._goal = null;            // 'earn' | 'help'
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
        } else if (step === 'keystore') {
            // Already past install — assume 'earn' since 'help' would've
            // skipped this. Operator can back out on the goal card.
            this._goal = 'earn';
            this._goto('c');
        } else if (step === 'network' || step === 'confirm' || step === 'complete') {
            this._goal = (s && s.enableArbiter === false) ? 'help' : 'earn';
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
        else if (card === 'c') { this._renderCardC(seq); }
        else if (card === 'd') { this._renderCardD(seq); }
    };

    /** @private */
    SetupConversation.prototype._updateHeader = function (card) {
        var t = root.enmT;
        var stepNumber = ({ a: 1, b: 2, c: 3, d: 4 })[card] || 1;
        // For the "help" path, skip card C — total steps becomes 3 and
        // numbering shifts (A=1, B=2, D=3).
        var total = TOTAL_STEPS;
        if (this._goal === 'help') {
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
              + '<button type="button" class="enm-goal-tile" data-goal="earn" aria-pressed="false">'
                + '<div class="enm-goal-illust enm-goal-illust-earn">'
                  + (I ? I.trophy({ size: 64 }) : '')
                + '</div>'
                + '<div class="enm-goal-tile-title">' + escapeHtml(t('friendly.setup.card_a.earn_title')) + '</div>'
                + '<div class="enm-goal-tile-sub">'  + escapeHtml(t('friendly.setup.card_a.earn_sub'))   + '</div>'
                + '<div class="enm-goal-tile-meta">' + escapeHtml(t('friendly.setup.card_a.earn_meta'))  + '</div>'
              + '</button>'
              + '<button type="button" class="enm-goal-tile" data-goal="help" aria-pressed="false">'
                + '<div class="enm-goal-illust enm-goal-illust-help">'
                  + (I ? I.shield({ size: 64 }) : '')
                + '</div>'
                + '<div class="enm-goal-tile-title">' + escapeHtml(t('friendly.setup.card_a.help_title')) + '</div>'
                + '<div class="enm-goal-tile-sub">'  + escapeHtml(t('friendly.setup.card_a.help_sub'))   + '</div>'
                + '<div class="enm-goal-tile-meta">' + escapeHtml(t('friendly.setup.card_a.help_meta'))  + '</div>'
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
                // For "help" goal, skip card C entirely.
                self._goto(self._goal === 'help' ? 'd' : 'c');
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

    /** @private — Card C: keystore password (only on 'earn' goal) */
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
