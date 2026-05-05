/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/hero-card.js — focal-point status (v0.4 home view).
 *
 * The big circular illustration + plain-English headline + role badge
 * + context-appropriate primary action. State-driven: subscribes to
 * SSE chain status if available, falls back to 30s poll.
 *
 * Vocabulary: friendly carrot in the headline ("Your ElastOS is happy
 * and earning"), technical noun on the role badge ("BPoS supernode" or
 * "Full node") so the user always knows what their ElastOS is doing —
 * per the eli5-vs-jargon rule (commit b208637).
 *
 * State → tint mapping (CSS data-state attribute):
 *   healthy_*    → green
 *   syncing      → amber
 *   starting     → amber
 *   recovering   → amber
 *   stopped      → neutral grey
 *   stalled      → rose
 *   error        → rose
 *   unconfigured → neutral grey
 */

(function (root) {
    'use strict';

    function HeroCard(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('HeroCard: { api } required');
        }
        this.chainId = opts.chainId || 'mainchain';
        this.api = opts.api;
        this.notifications = opts.notifications || null;
        this.sse = opts.sse || null;
        this.onAction = typeof opts.onAction === 'function' ? opts.onAction : function () {};

        this.root = document.createElement('section');
        this.root.className = 'enm-hero';
        this.root.dataset.state = 'unconfigured';

        this._state = null;       // last raw state from /chains/:id
        this._role  = null;       // 'bpos' | 'full' | null
        this._unsubStatus = null;
        this._pollTimer = null;
    }

    HeroCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._renderShell();
        this.refresh();
        var self = this;
        // Subscribe to live status updates if SSE is wired.
        if (this.sse && typeof this.sse.subscribe === 'function') {
            this._unsubStatus = this.sse.subscribe(
                'chains:' + this.chainId + ':status',
                function (payload) { self._applyState(payload); }
            );
        }
        // Poll fallback — also catches role changes.
        this._pollTimer = setInterval(function () { self.refresh(); }, 30000);
        return this;
    };

    HeroCard.prototype.destroy = function () {
        if (this._unsubStatus) { this._unsubStatus(); }
        if (this._pollTimer)  { clearInterval(this._pollTimer); }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** Re-fetch chain state + producer info from the backend. */
    HeroCard.prototype.refresh = function () {
        var self = this;
        return Promise.all([
            this.api.get('/chains/' + this.chainId, { skipCache: true }).catch(function () { return null; }),
            this.api.get('/chains/' + this.chainId + '/producer', { skipCache: true }).catch(function () { return null; }),
        ]).then(function (results) {
            var chain = results[0];
            var producer = results[1];
            self._role = (producer && producer.enabled) ? 'bpos' : 'full';
            self._applyState(chain || { state: 'unconfigured' });
        });
    };

    /** @private */
    HeroCard.prototype._renderShell = function () {
        this.root.innerHTML =
            '<div class="enm-hero-illust"   id="enm-hero-illust"></div>'
            + '<div class="enm-hero-text">'
              + '<h1 class="enm-hero-title" id="enm-hero-title"></h1>'
              + '<p class="enm-hero-sub"   id="enm-hero-sub"></p>'
            + '</div>'
            + '<div class="enm-hero-role"   id="enm-hero-role" hidden></div>'
            + '<div class="enm-hero-actions" id="enm-hero-actions"></div>';
        this._els = {
            illust:  this.root.querySelector('#enm-hero-illust'),
            title:   this.root.querySelector('#enm-hero-title'),
            sub:     this.root.querySelector('#enm-hero-sub'),
            role:    this.root.querySelector('#enm-hero-role'),
            actions: this.root.querySelector('#enm-hero-actions'),
        };
    };

    /** @private */
    HeroCard.prototype._applyState = function (chain) {
        var t = root.enmT;
        this._state = chain;
        var coarse = (chain && chain.state) || 'unconfigured';

        // Pick the friendly variant for healthy depending on the role.
        var headlineKey, subKey, illustKey;
        if (coarse === 'healthy' && this._role === 'bpos') {
            headlineKey = 'friendly.state.healthy_earn';
            subKey      = 'friendly.state.healthy_earn_sub';
            illustKey   = 'healthy_earn';
        } else if (coarse === 'healthy') {
            headlineKey = 'friendly.state.healthy_help';
            subKey      = 'friendly.state.healthy_help_sub';
            illustKey   = 'healthy_help';
        } else if (coarse === 'syncing') {
            headlineKey = 'friendly.state.syncing';
            subKey      = chain && chain.etaSec
                ? 'friendly.state.syncing_sub'
                : 'friendly.state.syncing_no_eta';
            illustKey   = 'syncing';
        } else {
            headlineKey = 'friendly.state.' + coarse;
            subKey      = 'friendly.state.' + coarse + '_sub';
            illustKey   = coarse;
        }

        var eta = (chain && chain.etaSec) ? formatEta(chain.etaSec) : null;
        this._els.title.textContent = t(headlineKey);
        this._els.sub.textContent   = eta
            ? t(subKey, { eta: eta })
            : t(subKey);

        // Tint the card by mapped tone (green/amber/rose/neutral).
        var tone = mapTone(coarse);
        this.root.dataset.state = coarse;
        this.root.dataset.tone  = tone;

        // Illustration (re-renders on state change).
        if (root.EnmIllust) {
            this._els.illust.innerHTML = root.EnmIllust.heroState(illustKey, { size: 168 });
        }

        // Role badge — only shown when we know the role and it's relevant.
        if (this._role && coarse !== 'unconfigured') {
            this._els.role.hidden = false;
            this._els.role.textContent = this._role === 'bpos'
                ? 'BPoS supernode'
                : 'Full node';
        } else {
            this._els.role.hidden = true;
        }

        this._renderActions(coarse);
    };

    /** @private */
    HeroCard.prototype._renderActions = function (coarse) {
        var t = root.enmT;
        var self = this;
        this._els.actions.innerHTML = '';

        if (coarse === 'unconfigured') {
            this._els.actions.appendChild(
                makeBtn(t('friendly.action.set_up'), 'hero', function () {
                    self.onAction('setup');
                })
            );
            return;
        }

        if (coarse === 'stopped') {
            this._els.actions.appendChild(
                makeBtn(t('friendly.action.start_node'), 'hero', function (ev) {
                    ev.target.disabled = true;
                    self.api.post('/chains/' + self.chainId + '/start')
                        .catch(function () { /* error surfaces via state refresh */ })
                        .then(function () { self.refresh(); });
                })
            );
            return;
        }

        if (coarse === 'error' || coarse === 'stalled') {
            this._els.actions.appendChild(
                makeBtn(t('friendly.action.see_details'), 'hero', function () {
                    self.onAction('details');
                })
            );
            return;
        }

        var alive = (coarse === 'healthy' || coarse === 'syncing'
                     || coarse === 'starting' || coarse === 'recovering');
        if (alive) {
            // Healthy node → only secondary action (the user has nothing
            // urgent to do). Keep it understated.
            this._els.actions.appendChild(
                makeBtn(t('friendly.action.stop_node'), 'secondary', function (ev) {
                    if (!confirm('Pause your ElastOS? It will stop earning until you wake it up again.')) { return; }
                    ev.target.disabled = true;
                    self.api.post('/chains/' + self.chainId + '/stop')
                        .catch(function () {})
                        .then(function () { self.refresh(); });
                })
            );
        }
    };

    /** Map coarse state → visual tone (CSS data-tone). */
    function mapTone(coarse) {
        if (coarse === 'healthy') { return 'good'; }
        if (coarse === 'syncing' || coarse === 'starting' || coarse === 'recovering') {
            return 'working';
        }
        if (coarse === 'error' || coarse === 'stalled') { return 'alert'; }
        return 'idle';
    }

    function formatEta(sec) {
        if (sec < 60) { return 'less than a minute'; }
        var mins = Math.round(sec / 60);
        if (mins < 60) { return mins + ' min'; }
        var hours = Math.floor(mins / 60);
        var remMin = mins % 60;
        if (remMin === 0) { return hours + 'h'; }
        return hours + 'h ' + remMin + 'm';
    }

    function makeBtn(label, variant, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        var classes = ['enm-btn'];
        if (variant === 'hero') {
            classes.push('enm-btn-primary', 'enm-btn-hero');
        } else if (variant === 'secondary') {
            classes.push('enm-btn-secondary');
        } else {
            classes.push('enm-btn-primary');
        }
        b.className = classes.join(' ');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    root.EnmHeroCard = HeroCard;
}(typeof window !== 'undefined' ? window : globalThis));
