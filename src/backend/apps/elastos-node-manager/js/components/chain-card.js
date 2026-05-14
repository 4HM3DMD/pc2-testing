/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/chain-card.js — single-chain status card. (0.2.0-alpha.1)
 *
 * Apple Hero rewrite. The visual hierarchy is:
 *
 *   1. PowerCircle hero — 220px Apple Activity Ring (state colour +
 *      sync percent + sonar-ping breath when healthy).
 *   2. Chain name (h3) + state subtitle (Active / Catching up / etc.).
 *   3. Primary metric — block height number stacked above a small label.
 *   4. Sparkline of last-hour block-height growth (hides when no data).
 *   5. Stats strip — peers / version / uptime, value-on-top hierarchy.
 *   6. Action row — Start / Stop / Restart / Configure (state-gated).
 *
 * What changed from alpha.18:
 *   - The Details disclosure is GONE. The sync panel and BPoS panel
 *     no longer live in the card. Sync info is communicated by the
 *     PowerCircle's filled ring + percent and the X / Y primary metric;
 *     BPoS info moves to the Identity sub-tab.
 *   - The card mounts an EnmSparkline subscribed via heightSeries.
 *   - On every state change the card dispatches 'enm:chain-state' on
 *     window so EnmFleetHealthGradient can recompute the wash hue.
 *
 * The polling cadence (refresh every 5s, sync poll adaptive, producer
 * poll every 60s when relevant) is preserved verbatim — the visual
 * surface changed, not the data layer.
 */

(function (root) {
    'use strict';

    // Coarse backend state → PowerCircle visual state. Same table as
    // alpha.18; one-shot lookup so the mapping stays reviewable.
    var COARSE_TO_VISUAL = {
        unconfigured: 'off',
        stopped:      'off',
        recovering:   'booting',
        starting:     'booting',
        syncing:      'syncing',
        healthy:      'healthy',
        stalled:      'warning',
        error:        'error',
        disabled:     'off',
    };

    function ChainCard(opts) {
        if (!opts || !opts.chainId || !opts.api || !opts.notifications) {
            throw new TypeError('ChainCard: { chainId, api, notifications } required');
        }
        this.chainId = opts.chainId;
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.sse = opts.sse || null;
        // 0.2.0-alpha.1 — height-series client backs the sparkline. When
        // absent (test rigs, defensive boot) the sparkline simply never
        // shows; the rest of the card still works.
        this.heightSeries = opts.heightSeries || null;
        this.onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : function () {};
        this.onReconfigure = typeof opts.onReconfigure === 'function' ? opts.onReconfigure : null;

        this.root = document.createElement('article');
        this.root.className = 'enm-chain-card';
        this.root.dataset.chainId = this.chainId;
        this.root.dataset.state = 'unconfigured';
        this._busy = false;

        this._renderShell();
    }

    ChainCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        var self = this;
        if (this.sse) {
            this._unsubscribe = this.sse.subscribe(
                'chains:' + this.chainId + ':status',
                function (payload) { self._applyState(payload); },
            );
            // 0.2.0-alpha.1 — SSE state listener. Toggles the
            // reconnecting pill + sets data-sse-state on the card
            // root so CSS can pause the breath / dim the ring when
            // we've lost the supervisor channel.
            if (typeof this.sse.onState === 'function') {
                this._unsubSse = this.sse.onState(function (sseState) {
                    if (self._destroyed) return;
                    self._applySseState(sseState);
                });
            }
        }
        // Live-metric poll — height/peers/uptime move constantly while
        // the chain is alive. 5s matches alpha.18; backend can absorb it
        // and the dashboard feels live. alpha.28.1 batch 27 — wrapped
        // in enmUseVisibilityPause so the 720 fetches/hr stop when the
        // tab is backgrounded (audit a96c7d71). Falls back to raw
        // setInterval if the helper failed to load.
        if (typeof root !== 'undefined' && typeof root.enmUseVisibilityPause === 'function') {
            this._metricsPauser = root.enmUseVisibilityPause(function () { self.refresh(); }, 5_000);
        } else {
            this._metricsTimer = setInterval(function () { self.refresh(); }, 5_000);
        }
        // Sync poll — adaptive cadence. Drives the PowerCircle percent
        // and the primary-metric "X / Y" line. alpha.28.1 batch 31 —
        // visibility listener wakes the chained-setTimeout chain on
        // resume (the _syncPausedByHidden flag is set in _refreshSync
        // when document.hidden at scheduling time).
        this._onSyncVisChange = function () {
            if (self._destroyed) { return; }
            if (typeof document !== 'undefined' && !document.hidden && self._syncPausedByHidden) {
                self._syncPausedByHidden = false;
                self._refreshSync();
            }
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', this._onSyncVisChange);
        }
        this._refreshSync();
        // 0.2.0-alpha.7 — DPoS rotation poll (improvement #02). 60s
        // cadence; rotation only changes on round boundaries so no need
        // to hammer the RPC faster than that.
        this._refreshRotation();
        // alpha.28.1 batch 30 — visibility-pause wrap on the 60s
        // rotation poll. Saves 60 hidden-tab fetches/hr; resume-tick
        // re-fetches immediately so the rotation strip stays accurate.
        if (typeof root !== 'undefined' && typeof root.enmUseVisibilityPause === 'function') {
            this._rotationPauser = root.enmUseVisibilityPause(function () { self._refreshRotation(); }, 60_000);
        } else {
            this._rotationTimer = setInterval(function () { self._refreshRotation(); }, 60_000);
        }
        // Beta 3 — Sparkline DROPPED from the chain-card mount path.
        // phase-03 mock has no sparkline in the Dashboard view; block
        // velocity moves into the .enm-sync-progress-bar text line
        // ("Receiving N new blocks/min from peers"). The heightSeries
        // service is left untouched in case BP-C / BP-D wants to reuse
        // it for a different surface; we just don't subscribe here.
        return this;
    };

    ChainCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._metricsPauser)   { try { this._metricsPauser.stop(); } catch (_) { /* idempotent */ } this._metricsPauser = null; }
        if (this._metricsTimer)    { clearInterval(this._metricsTimer);    this._metricsTimer = null; }
        if (this._uptimeTickTimer) { clearInterval(this._uptimeTickTimer); this._uptimeTickTimer = null; }
        if (this._rotationPauser)  { try { this._rotationPauser.stop(); } catch (_) { /* idempotent */ } this._rotationPauser = null; }
        if (this._rotationTimer)   { clearInterval(this._rotationTimer);   this._rotationTimer = null; }
        if (this._syncTimer)       { clearTimeout(this._syncTimer);        this._syncTimer = null; }
        if (this._onSyncVisChange) {
            try {
                if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                    document.removeEventListener('visibilitychange', this._onSyncVisChange);
                }
            } catch (_) { /* swallow */ }
            this._onSyncVisChange = null;
        }
        if (this._unsubscribe)     { this._unsubscribe(); this._unsubscribe = null; }
        if (this._unsubSse)        { this._unsubSse();    this._unsubSse = null; }
        if (this._unsubHeight)     { this._unsubHeight(); this._unsubHeight = null; }
        if (this._sparkline)       { this._sparkline.destroy(); this._sparkline = null; }
        // alpha.28.1 batch 24 — symmetry: chain-card creates+mounts a
        // PowerCircle at line 184 but previously never called its
        // destroy(). Cosmetic today (PowerCircle has no timers; its
        // DOM is removed when `this.root` is removed below), but the
        // pattern was asymmetric and prone to regress if PowerCircle
        // ever grows internal listeners. (Lifecycle audit aff18c172.)
        if (this._powerCircle && typeof this._powerCircle.destroy === 'function') {
            try { this._powerCircle.destroy(); } catch (_) { /* idempotent */ }
            this._powerCircle = null;
        }
        // 0.2.0-alpha.1 — tell FleetHealthGradient we're going away so it
        // can drop this chain from its aggregate. Without this, a remount
        // would double-count.
        try {
            root.dispatchEvent(new root.CustomEvent('enm:chain-state', {
                detail: { chainId: this.chainId, removed: true },
            }));
        } catch (_) { /* old browsers without CustomEvent — skip */ }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /**
     * Re-fetch /chains/:id and re-render. Single-flight guarded so the
     * 5s timer, post-action refreshes, and SSE events collapse to one
     * in-flight request.
     */
    ChainCard.prototype.refresh = function () {
        if (this._destroyed) { return Promise.resolve(); }
        if (this._refreshInFlight) { return this._refreshInFlight; }
        var self = this;
        this._refreshInFlight = this.api.get('/chains/' + this.chainId, { skipCache: true }).then(function (state) {
            self._applyState(state);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            if (err && err.status === 404) {
                self._applyState({ chainId: self.chainId, state: 'unconfigured' });
                return;
            }
            // 401 → expired session, suppressed here (the boot path
            // owns the re-auth UX); without this every 5s poll during
            // an expired session stacks a fresh "Failed to refresh"
            // warning. Matches the system-status pattern.
            if (err && err.status === 401) { return; }
            // alpha.28.1 batch 19 (audit ad49e60e) — stable id so a
            // 10-minute backend outage doesn't stack 120 identical
            // toasts. show() dedupes by id, updating the existing
            // toast in place instead of mounting a fresh one.
            self.notifications.show({
                id: 'chain-refresh-fail-' + self.chainId,
                severity: 'warning',
                title: 'Failed to refresh ' + self.chainId,
                body: err && err.message ? err.message : String(err),
            });
        }).then(function () {
            self._refreshInFlight = null;
        }, function () {
            self._refreshInFlight = null;
        });
        return this._refreshInFlight;
    };

    /**
     * @private
     * Beta 3 — Dashboard view rebuilt from `enm-design-mocks/v2/
     * phase-03-status.html`. The DOM now mirrors the mock structure:
     *
     *   .enm-chain-card                          ← this.root
     *     .enm-chain-card-content                ← 2-col grid auto / 1fr
     *       .enm-hero-power[data-state]   OR     ← hero swap
     *       .enm-hero-sync (with sync %)
     *       .enm-chain-meta
     *         .enm-state-chip                    ← state pill with dot
     *         <div>
     *           .enm-chain-height-label "Block height"
     *           .enm-chain-height "1,742,891"
     *         </div>
     *         .enm-chain-subline                 ← "Fully synced" or sync info
     *         .enm-sync-progress-bar (hidden when not syncing)
     *         .enm-chain-reconnect (alpha.28 batch — kept for SSE drops)
     *     .enm-chain-rotation (alpha.7 — hidden by default)
     *     .enm-stats > .enm-stat (peers / version / uptime)
     *     .enm-chain-actions > .enm-btn ...
     *
     * The PowerCircle + Sparkline mounts from alpha.27 are GONE. The
     * mock has no sparkline on Dashboard, and the hero is now a small
     * div the chain-card owns directly (state-driven via CSS data
     * attribute). The alpha.28 lifecycle invariants (refresh poll,
     * sync poll, SSE wiring, _destroyed guard, BPoS rotation) are
     * preserved verbatim — only the DOM target selectors change.
     */
    ChainCard.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        var self = this;

        // .enm-chain-card-content — the 2-col grid (hero | meta).
        this._content = document.createElement('div');
        this._content.className = 'enm-chain-card-content';

        // Hero slot — we swap .enm-hero-power vs .enm-hero-sync into here
        // depending on coarse state. Initial render is power/stopped so
        // the card has SOMETHING the first paint before _applyState lands.
        this._heroSlot = document.createElement('div');
        this._heroSlot.className = 'enm-chain-hero-slot';
        // Clickable hero — keeps the alpha.18 "tap circle to do the
        // obvious thing" affordance. Same handler as the old
        // PowerCircle's onTap.
        this._heroSlot.setAttribute('role', 'button');
        this._heroSlot.setAttribute('tabindex', '0');
        this._heroSlot.setAttribute('aria-label',
            t('chain_card.tap_circle_aria', { chainName: this.chainId }) || 'Chain status');
        this._heroSlot.addEventListener('click', function () { self._handleCircleTap(); });
        this._heroSlot.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                self._handleCircleTap();
            }
        });
        this._content.appendChild(this._heroSlot);

        // .enm-chain-meta — right column
        this._meta = document.createElement('div');
        this._meta.className = 'enm-chain-meta';

        // state-chip
        this._stateChip = document.createElement('span');
        this._stateChip.className = 'enm-state-chip';
        // a11y: state changes get announced politely (alpha.28 carry).
        this._stateChip.setAttribute('role', 'status');
        var chipDot = document.createElement('span');
        chipDot.className = 'enm-state-chip-dot';
        this._stateChip.appendChild(chipDot);
        this._stateChipText = document.createTextNode(t('chain_state.unconfigured'));
        this._stateChip.appendChild(this._stateChipText);
        this._meta.appendChild(this._stateChip);

        // height block
        var heightBlock = document.createElement('div');
        var heightLabel = document.createElement('div');
        heightLabel.className = 'enm-chain-height-label';
        heightLabel.textContent = t('chain_card.primary_label_height') || 'Block height';
        heightBlock.appendChild(heightLabel);
        this._chainHeight = document.createElement('div');
        this._chainHeight.className = 'enm-chain-height';
        this._chainHeight.textContent = '—';
        heightBlock.appendChild(this._chainHeight);
        this._meta.appendChild(heightBlock);

        // subline — fully-synced ✓ tick OR sync info "Receiving 12 blocks/min"
        this._subline = document.createElement('div');
        this._subline.className = 'enm-chain-subline';
        this._meta.appendChild(this._subline);

        // sync-progress-bar — visible only when syncing. Carries the
        // "Receiving N blocks/min from peers" feedback line per mock.
        this._syncBar = document.createElement('div');
        this._syncBar.className = 'enm-sync-progress-bar';
        this._syncBar.hidden = true;
        this._meta.appendChild(this._syncBar);

        // alpha.28.1 — SSE-disconnect indicator pill. The mock has no
        // explicit slot for it; we tuck it inside meta so it sits with
        // the rest of the chain status info. role=status preserved.
        this._reconnectPill = document.createElement('span');
        this._reconnectPill.className = 'enm-chain-reconnect';
        this._reconnectPill.setAttribute('role', 'status');
        this._reconnectPill.textContent = t('chain_card.sse_reconnecting') || 'Reconnecting…';
        this._reconnectPill.hidden = true;
        this._meta.appendChild(this._reconnectPill);

        this._content.appendChild(this._meta);
        this.root.appendChild(this._content);

        // alpha.7 — DPoS rotation strip (improvement #02). Hidden unless
        // on-duty / in-slate / next-slate. Sits between the meta and
        // the stats row.
        this._rotationStrip = document.createElement('div');
        this._rotationStrip.className = 'enm-chain-rotation';
        this._rotationStrip.hidden = true;
        this.root.appendChild(this._rotationStrip);

        // .enm-stats — phase-03 row of stat cells. Peers/version/uptime.
        this._statsStrip = document.createElement('div');
        this._statsStrip.className = 'enm-stats';
        this._statFields = {};
        ['peers', 'version', 'uptime'].forEach(function (k) {
            var cell = document.createElement('div');
            cell.className = 'enm-stat enm-stat-' + k;
            var label = document.createElement('span');
            label.className = 'enm-stat-label';
            label.textContent = t('chain_card.' + k);
            cell.appendChild(label);
            var value = document.createElement('span');
            value.className = 'enm-stat-value';
            value.textContent = '—';
            cell.appendChild(value);
            self._statsStrip.appendChild(cell);
            self._statFields[k] = value;
        });
        this.root.appendChild(this._statsStrip);

        // .enm-chain-actions — Configure (when unconfigured) / Start /
        // Restart / Stop. Mock order is Restart first then Stop; we keep
        // that order so the destructive Stop is the rightmost button
        // (less likely to be clicked accidentally).
        var actions = document.createElement('div');
        actions.className = 'enm-chain-actions';
        this._configureBtn = makeBtn(t('chain_actions.configure'), 'enm-btn enm-btn-primary',   this._handleConfigure.bind(this));
        this._startBtn     = makeBtn(t('chain_actions.start'),     'enm-btn enm-btn-primary',   this._handleStart.bind(this));
        this._restartBtn   = makeBtn(t('chain_actions.restart'),   'enm-btn',                   this._handleRestart.bind(this));
        this._stopBtn      = makeBtn(t('chain_actions.stop'),      'enm-btn enm-btn-danger',    this._handleStop.bind(this));
        actions.appendChild(this._configureBtn);
        actions.appendChild(this._startBtn);
        actions.appendChild(this._restartBtn);
        actions.appendChild(this._stopBtn);
        this.root.appendChild(actions);

        // alpha.28 carry — `this._stateSubtitle` and `this._primaryMetric` /
        // `this._primaryLabel` are EXPECTED by _applyState + _refreshSync.
        // The new DOM doesn't have those as separate elements; we point
        // them at compatibility proxies so the old methods keep working
        // without a full rewrite. (Future Beta 3 audit pass can refactor
        // _applyState to write to the new field names directly.)
        this._stateSubtitle = this._stateChip;          // writes to text node below
        this._primaryMetric = this._chainHeight;        // value
        this._primaryLabel  = heightLabel;              // "Block height"

        // Initial hero render — empty/stopped until _applyState lands.
        this._renderHeroPower('stopped');
    };

    /**
     * @private
     * Swap the hero slot to .enm-hero-power with the given data-state.
     * Mock visual states: 'running' (green halo + pulsing dot),
     * 'stopped' (gray, no glow, no dot), 'stalled' (amber halo + dot),
     * 'error' (red, designed but not rendered in the phase-03 mock).
     */
    ChainCard.prototype._renderHeroPower = function (state) {
        if (this._heroMode === 'power' && this._heroSlot.firstChild
            && this._heroSlot.firstChild.dataset.state === state) {
            return; // no-op if already in this state — avoid DOM churn
        }
        this._heroSlot.innerHTML = '';
        var hero = document.createElement('div');
        hero.className = 'enm-hero-power';
        hero.dataset.state = state;
        var live = document.createElement('div');
        live.className = 'enm-hero-power-live';
        hero.appendChild(live);
        // SVG uses <use> to reference the shared #enm-power-icon symbol
        // defined at body top in index.html.
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'enm-hero-power-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#enm-power-icon');
        use.setAttribute('href', '#enm-power-icon');
        svg.appendChild(use);
        hero.appendChild(svg);
        this._heroSlot.appendChild(hero);
        this._heroMode = 'power';
    };

    /**
     * @private
     * Swap the hero slot to .enm-hero-sync with the given percent (0-100).
     * Mock spec: concentric SVG circles r=45, stroke-dasharray=282.6
     * (= 2πr), dashoffset = circumference × (1 - pct/100). Inner block
     * shows the percent + "Syncing" label.
     */
    ChainCard.prototype._renderHeroSync = function (percent) {
        var pct = Math.max(0, Math.min(100, percent || 0));
        var circ = 282.6; // 2π × 45 ≈ 282.74; mock uses 282.6 — keep parity
        var offset = (circ * (1 - pct / 100)).toFixed(1);
        if (this._heroMode === 'sync') {
            // In-place update: don't rebuild the SVG, just adjust dashoffset
            // + percent text so the ring animates smoothly via CSS
            // transition.
            var ring = this._heroSlot.querySelector('.enm-hero-sync svg circle:nth-of-type(2)');
            var pctEl = this._heroSlot.querySelector('.enm-hero-pct');
            if (ring) { ring.setAttribute('stroke-dashoffset', offset); }
            if (pctEl) {
                pctEl.firstChild.nodeValue = String(Math.round(pct));
            }
            return;
        }
        this._heroSlot.innerHTML = '';
        var hero = document.createElement('div');
        hero.className = 'enm-hero-sync';
        hero.innerHTML =
            '<svg viewBox="0 0 100 100" aria-hidden="true">'
            +   '<circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/>'
            +   '<circle cx="50" cy="50" r="45" fill="none" stroke="url(#enm-sync-grad)" stroke-width="6"'
            +     ' stroke-dasharray="' + circ + '"'
            +     ' stroke-dashoffset="' + offset + '"'
            +     ' stroke-linecap="round" transform="rotate(-90 50 50)"/>'
            + '</svg>'
            + '<div class="enm-hero-sync-inner">'
            +   '<div class="enm-hero-pct">' + Math.round(pct) + '<span class="enm-hero-pct-suffix">%</span></div>'
            +   '<div class="enm-hero-pct-label">Syncing</div>'
            + '</div>';
        this._heroSlot.appendChild(hero);
        this._heroMode = 'sync';
    };

    /**
     * @private
     * Tap-the-circle on the Apple Hero card is a "do the obvious thing"
     * affordance. No more disclosure to toggle since details are gone.
     *
     *   unconfigured     → open Configure wizard
     *   stopped / error  → pulse the action row so eye lands on Start
     *   alive            → pulse the action row (Stop / Restart visible)
     */
    ChainCard.prototype._handleCircleTap = function () {
        var coarse = this._lastCoarseState || 'unconfigured';
        if (coarse === 'unconfigured') {
            return this._handleConfigure();
        }
        return this._pulseActionRow();
    };

    /**
     * @private
     * Brief animation on the action row so the operator's eye lands on
     * the visible buttons. Inherited from alpha.18 — the keyframe lives
     * in styles.css. One-shot setTimeout so back-to-back taps re-fire.
     */
    ChainCard.prototype._pulseActionRow = function () {
        var row = this.root.querySelector('.enm-chain-actions');
        if (!row) return;
        // alpha.29 batch 108 (Round-34 perf finding #2, MED) — replace
        // the forced-layout `row.offsetWidth` reflow trick with a
        // requestAnimationFrame defer. Same effect (re-apply the class
        // after the browser has registered the remove) without the
        // synchronous style/layout flush. The previous trick worked
        // but caused a measurable ~1-2ms layout flush on every
        // operator click, compounding on multi-chain dashboards where
        // pulses can overlap.
        row.classList.remove('enm-chain-actions-pulse');
        var self = this;
        if (typeof requestAnimationFrame === 'function') {
            // BP-E audit fix — guard against destroy() detaching the row
            // between the schedule and the RAF firing. Without this check,
            // a fast unmount (e.g. operator switches chains mid-pulse on a
            // multi-chain dashboard) mutates a detached DOM subtree, which
            // is wasted work and trips on _destroyed-invariant CI checks.
            requestAnimationFrame(function () {
                if (self._destroyed) { return; }
                row.classList.add('enm-chain-actions-pulse');
            });
        } else {
            row.classList.add('enm-chain-actions-pulse');
        }
        // BP-E audit fix — same _destroyed guard on the 700ms removal so a
        // late-arriving "remove pulse" doesn't fire on a torn-down card.
        setTimeout(function () {
            if (self._destroyed) { return; }
            row.classList.remove('enm-chain-actions-pulse');
        }, 700);
    };

    ChainCard.prototype._applyState = function (state) {
        if (this._destroyed) { return; }
        var t = root.enmTOrFallback;
        var coarse = (state && state.state) ? state.state : 'unconfigured';
        this._lastCoarseState = coarse;
        this._lastBackendState = state || {};
        this.root.dataset.state = coarse;

        // Beta 3 — hero swap per phase-03 mock. `.hero-power` for stopped/
        // running/stalled/error; `.hero-sync` for syncing/recovering/
        // starting. Percent for sync hero lands later from _refreshSync;
        // initial percent is 0 until /sync resolves.
        if (coarse === 'syncing' || coarse === 'recovering' || coarse === 'starting') {
            this._renderHeroSync(this._lastSyncPercent || 0);
        } else {
            // Map coarse → hero-power data-state. Mock defines: running /
            // stopped / stalled / error. Unconfigured / disabled visually
            // are 'stopped' (gray, no glow).
            var heroState = (coarse === 'healthy') ? 'running'
                : (coarse === 'stalled') ? 'stalled'
                : (coarse === 'error')   ? 'error'
                : 'stopped';
            this._renderHeroPower(heroState);
        }

        // State-chip — text + modifier class. Mock variants: .accent
        // (syncing), .warn (stalled), .error (error), .muted (stopped),
        // default (healthy). The chain-chip-dot pulses; muted variant
        // mutes the pulse.
        var producerState = state && state.producerState;
        var chipText;
        if (producerState && (coarse === 'healthy' || coarse === 'syncing' || coarse === 'stalled')) {
            chipText = producerState;
            this._stateChip.dataset.state = coarse + '-producer-' + String(producerState).toLowerCase();
        } else {
            chipText = t('chain_state.' + coarse);
            this._stateChip.dataset.state = coarse;
        }
        // Update the text node without wiping the dot child.
        this._stateChipText.nodeValue = chipText;
        // Modifier classes
        this._stateChip.classList.remove('accent', 'warn', 'error', 'muted');
        if (coarse === 'syncing' || coarse === 'recovering' || coarse === 'starting') {
            this._stateChip.classList.add('accent');
        } else if (coarse === 'stalled') {
            this._stateChip.classList.add('warn');
        } else if (coarse === 'error') {
            this._stateChip.classList.add('error');
        } else if (coarse === 'stopped' || coarse === 'unconfigured' || coarse === 'disabled') {
            this._stateChip.classList.add('muted');
        }

        // Block-height number. The "/ network" suffix when syncing is set
        // later by _refreshSync via _applySyncSnapshot.
        var height = (state && state.height != null) ? state.height : null;
        this._chainHeight.textContent = formatPrimaryValue(t, coarse, height, null);
        // The "Block height" label stays static in phase-03; in alpha.27
        // it swapped to "connecting to peers" while we waited for the
        // first peer handshake. Preserve that behaviour but write into
        // the new heightLabel node (proxied via _primaryLabel).
        this._primaryLabel.textContent = formatPrimaryLabel(t, coarse, height, null);

        // Subline — at-tip "Fully synced" check when healthy, or sync
        // info during sync (lands from _refreshSync). Cleared otherwise.
        this._renderSubline(coarse, state, null);

        // Stats strip.
        // 0.2.0-alpha.28.1 — peers/latency/skew numbers now go through
        // enmFormatNumber so thousands group consistently with block
        // height (and screen readers get a steady rhythm). Falls back to
        // the raw value if the util didn't load.
        var fmtN = (typeof window !== 'undefined' && window.enmFormatNumber)
            ? window.enmFormatNumber
            : function (n) { return (n == null || !isFinite(n)) ? '—' : String(n); };
        this._statFields.peers.textContent   = state && state.peers         != null ? fmtN(state.peers) : '—';
        // 0.2.0-alpha.7 — peer quality hover (improvement #12). Backend
        // populates `peerSummary` from getnodestate.neighbors; surface as
        // a title on the peers cell so a hover shows the breakdown the
        // operator cares about (latency / version distribution / clock
        // skew) without taking more space in the resting card.
        var peersCell = this._statFields.peers && this._statFields.peers.parentNode;
        if (peersCell) {
            var ps = state && state.peerSummary;
            if (ps && (ps.latencyMsAvg != null || (ps.versions && ps.versions.length) || ps.timeOffsetMaxAbsMs != null)) {
                var lines = [];
                if (ps.latencyMsAvg != null) lines.push('Avg ping: ' + fmtN(ps.latencyMsAvg) + ' ms');
                if (ps.versions && ps.versions.length) {
                    lines.push('Versions: ' + ps.versions.map(function (v) {
                        return v.version + ' ×' + fmtN(v.count);
                    }).join(', '));
                }
                if (ps.timeOffsetMaxAbsMs != null) {
                    lines.push('Max clock skew: ±' + fmtN(ps.timeOffsetMaxAbsMs) + ' ms');
                }
                peersCell.title = lines.join('\n');
            } else {
                peersCell.title = '';
            }
        }
        this._statFields.version.textContent = state && state.binaryVersion ? state.binaryVersion : '—';
        // 0.2.0-alpha.5 — uptime gets a local 1-second tick instead of
        // riding the 5s refresh poll. We anchor _uptimeBaseMs to
        // (now - uptimeSec) every time the backend reports a number,
        // then the local interval recomputes the displayed value off
        // Date.now() each second. Effect: smooth 37s → 38s → 39s
        // counter instead of jumps from 37s → 42s every poll.
        if (state && state.uptimeSec != null) {
            this._uptimeBaseMs = Date.now() - state.uptimeSec * 1000;
            this._statFields.uptime.textContent = root.enmFormatUptime(state.uptimeSec);
            if (!this._uptimeTickTimer) {
                var card = this;
                this._uptimeTickTimer = setInterval(function () {
                    if (card._destroyed || card._uptimeBaseMs == null) return;
                    var elapsedSec = Math.floor((Date.now() - card._uptimeBaseMs) / 1000);
                    card._statFields.uptime.textContent = root.enmFormatUptime(elapsedSec);
                }, 1_000);
            }
        } else {
            this._uptimeBaseMs = null;
            this._statFields.uptime.textContent = '—';
            if (this._uptimeTickTimer) {
                clearInterval(this._uptimeTickTimer);
                this._uptimeTickTimer = null;
            }
        }

        // Action row enable/disable.
        var alive = (coarse === 'healthy' || coarse === 'syncing' || coarse === 'stalled' || coarse === 'recovering' || coarse === 'starting');
        var unconfigured = (coarse === 'unconfigured');
        this._configureBtn.hidden = !unconfigured || !this.onReconfigure;
        this._startBtn.hidden     = unconfigured;
        this._stopBtn.hidden      = unconfigured;
        this._restartBtn.hidden   = unconfigured;
        this._startBtn.disabled   = alive;
        this._stopBtn.disabled    = !alive || coarse === 'stopped';
        this._restartBtn.disabled = !alive;

        // 0.2.0-alpha.1 — notify FleetHealthGradient. CustomEvent on
        // window so the controller can subscribe once and aggregate
        // without dependency injection through technical-view / app.js.
        try {
            root.dispatchEvent(new root.CustomEvent('enm:chain-state', {
                detail: { chainId: this.chainId, coarseState: coarse },
            }));
        } catch (_) { /* old browsers without CustomEvent — skip */ }

        this.onStateChange(coarse, state);
    };

    // 0.2.0-alpha.4 — treat-as-synced threshold. When a new block lands
    // upstream the network heads forward by 1 before we've fetched it,
    // briefly putting us "1 block behind" — the formatter used to flip
    // the primary metric to "X / X+1" for one polling tick and then
    // back to "X+1" once we caught up. Reads as flicker. Anything ≤
    // this many blocks behind is treated as caught-up for the display.
    var TREAT_AS_SYNCED_THRESHOLD = 2;

    /**
     * Build the big block-height number under the state subtitle. When
     * a /sync snapshot is in flight, _refreshSync overrides this with
     * "local / network" (e.g. "943,210 / 1,123,455"). The local-only
     * variant wins when blocksBehind ≤ TREAT_AS_SYNCED_THRESHOLD even
     * if the backend's synced flag is false, so the steady-state
     * dashboard doesn't flicker on every block.
     */
    function formatPrimaryValue(t, coarse, height, syncSnapshot) {
        if (coarse === 'unconfigured') {
            return t('chain_card.primary_metric_unconfigured');
        }
        if (coarse === 'stopped') {
            return t('chain_card.primary_metric_off');
        }
        // Backend contract guard (audit a3e53e9a) — every site below
        // calls `.toLocaleString()` directly on the height field.
        // toLocaleString exists on strings AND numbers but the string
        // overload doesn't group thousands, so a backend that ever
        // typed heights as JSON strings (`"943210"`) would silently
        // break the display. enmFormatNumber coerces via Number() and
        // routes through the canonical NaN/Infinity → "—" guard.
        var fmtH = (typeof window !== 'undefined' && window.enmFormatNumber)
            ? function (v) {
                var n = typeof v === 'number' ? v : Number(v);
                return window.enmFormatNumber(n);
            }
            : function (v) {
                return (v == null) ? '—' : String(v);
            };
        if (syncSnapshot) {
            var basicallySynced = syncSnapshot.synced
                || (typeof syncSnapshot.blocksBehind === 'number'
                    && syncSnapshot.blocksBehind <= TREAT_AS_SYNCED_THRESHOLD);
            if (basicallySynced && syncSnapshot.localHeight != null) {
                return fmtH(syncSnapshot.localHeight);
            }
            if (syncSnapshot.networkHeight != null && syncSnapshot.localHeight != null) {
                return fmtH(syncSnapshot.localHeight)
                    + ' / ' + fmtH(syncSnapshot.networkHeight);
            }
            if (syncSnapshot.localHeight != null) {
                return fmtH(syncSnapshot.localHeight);
            }
        }
        if (height != null) return fmtH(height);
        return '—';
    }

    /**
     * Lowercase caption under the big number. Apple Hero pattern.
     *
     * 0.2.0-alpha.4 — when the chain is alive but we don't have a
     * block height yet (cold start, ~30-60s before peer handshake
     * completes), the value is an em-dash and the caption swaps to
     * "connecting to peers" so the operator knows the empty state is
     * intentional + ~about a minute.
     */
    function formatPrimaryLabel(t, coarse, height, syncSnapshot) {
        if (coarse === 'unconfigured') return t('chain_card.primary_label_unconfigured');
        if (coarse === 'stopped')      return t('chain_card.primary_label_off');
        var haveHeight = (height != null)
            || (syncSnapshot && syncSnapshot.localHeight != null);
        if (!haveHeight) return t('chain_card.primary_label_connecting');
        return t('chain_card.primary_label_height');
    }

    /** @private */
    ChainCard.prototype._handleConfigure = function () {
        if (typeof this.onReconfigure === 'function') this.onReconfigure(this.chainId);
    };

    /** @private */
    ChainCard.prototype._handleStart   = function () { this._do('start',   '/chains/' + this.chainId + '/start'); };
    ChainCard.prototype._handleStop    = function () { this._do('stop',    '/chains/' + this.chainId + '/stop'); };
    ChainCard.prototype._handleRestart = function () { this._do('restart', '/chains/' + this.chainId + '/restart'); };

    /** @private */
    ChainCard.prototype._do = function (kind, path) {
        if (this._busy) return;
        this._busy = true;
        var t = root.enmTOrFallback;
        var btn = (kind === 'start' ? this._startBtn : (kind === 'stop' ? this._stopBtn : this._restartBtn));
        var prev = btn.textContent;
        btn.textContent = t('chain_actions.' + kind + 'ing');
        btn.disabled = true;
        var self = this;
        this.api.post(path).then(function () {
            self.notifications.info(self.chainId + ' ' + kind, '');
            return self.refresh();
        }).catch(function (err) {
            // alpha.28.1 batch 52 — 401 suppressed; boot path owns
            // re-auth UX. Without this, expired-session caused the
            // operator's Start/Stop/Restart click to surface a
            // generic "Failed to start" toast on top of whatever
            // the error pane was already saying.
            if (err && err.status === 401) { return; }
            // Host-conflict 409 surfaces structured remediation steps.
            // alpha.28.1 batch 68 (Round-19B audit) — defensive shape
            // validation on the conflict envelope. Backend bug or stale-
            // cache replay could ship `{ description: undefined,
            // remediation: [{foo: 'bar'}] }` — the previous shape rendered
            // the resulting critical toast as "• undefined" and
            // "[object Object]" verbatim. Operator can't act on that.
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
                        ? c.description : 'Host conflict';
                    return '• ' + descStr + (stepStr ? ('\n   ' + stepStr) : '');
                }).join('\n');
                self.notifications.critical(
                    'Cannot ' + kind + ' ' + self.chainId + ' — host conflicts',
                    summary,
                );
            } else {
                self.notifications.warning(
                    'Failed to ' + kind + ' ' + self.chainId,
                    err && err.message ? err.message : String(err),
                );
            }
        }).then(function () {
            // alpha.28.1 batch 60 (Round-18 audit) — explicitly clear
            // btn.disabled here. _do() sets `btn.disabled = true` at the
            // start; on the success path _applyState's downstream call
            // would re-enable it, but on the 401-suppressed path
            // refresh() early-returns at the top guard and _applyState
            // never runs. Result before this fix: a single 401 on
            // Start/Stop/Restart leaves the button greyed out until a
            // non-401 poll lands (5+ seconds, or forever if the session
            // truly expired). Clearing disabled here re-evaluates from
            // coarse state via the queued refresh().
            btn.textContent = prev;
            btn.disabled = false;
            self._busy = false;
            self.refresh();
        });
    };

    /**
     * Adaptive sync poll. Drives the PowerCircle percent and the
     * "local / network" suffix on the primary metric. NO more sync
     * panel in 0.2.0-alpha.1 — the ring + the X / Y line tell the
     * sync story end-to-end.
     *
     * Cadence:
     *   syncing  → 10s (operator is watching the percent move)
     *   anything → 60s (drift check)
     *
     * @private
     */
    ChainCard.prototype._refreshSync = function () {
        if (this._destroyed) return;
        var self = this;
        this.api.get('/chains/' + this.chainId + '/sync', { skipCache: true }).then(function (data) {
            if (self._destroyed) return;
            self._applySyncSnapshot(data);
        }).catch(function () {
            if (self._destroyed) return;
            self._applySyncSnapshot(null);
        }).then(function () {
            if (self._destroyed || !self.root || !self.root.isConnected) return;
            // alpha.28.1 batch 31 — pause adaptive sync poll when the
            // tab is backgrounded. The chained-setTimeout pattern
            // doesn't fit the standard enmUseVisibilityPause helper
            // (which is setInterval-shaped), so we inline:
            //   - hidden: set a paused flag, skip scheduling.
            //   - visible (handled by _onSyncVisibilityChange wired at
            //     mount): clear flag + re-enter _refreshSync to catch
            //     up immediately.
            // Saves up to 360 fetches/hr while syncing on a hidden tab.
            if (typeof document !== 'undefined' && document.hidden) {
                self._syncPausedByHidden = true;
                return;
            }
            var nextMs = (self._lastCoarseState === 'syncing') ? 10_000 : 60_000;
            self._syncTimer = setTimeout(function () { self._refreshSync(); }, nextMs);
        });
    };

    /**
     * Update the PowerCircle percent + primary metric line from a
     * /sync response. Replaces _renderSyncPanel from alpha.18 — the
     * heavy panel rendering is gone; only the two visual surfaces
     * the user actually sees (ring + metric) update.
     *
     * @private
     * @param {object|null} data
     */
    ChainCard.prototype._applySyncSnapshot = function (data) {
        var t = root.enmTOrFallback;
        var coarse = this._lastCoarseState || 'unconfigured';

        // Beta 3 hero — update the sync ring percent in place. Phase-03
        // mock shows the percent number + dashoffset together; we update
        // the existing .enm-hero-sync if we're in sync mode, otherwise
        // ignore the sync snapshot (coarse state already drove the hero
        // to .enm-hero-power).
        if (data && typeof data.percent === 'number'
            && (coarse === 'syncing' || coarse === 'recovering' || coarse === 'starting')) {
            this._lastSyncPercent = data.percent;
            this._renderHeroSync(data.percent);
        }

        // Block-height number — when syncing, formatter shows
        // "local / network"; once basicallySynced, just local.
        var height = (this._lastBackendState && this._lastBackendState.height != null)
            ? this._lastBackendState.height : null;
        this._chainHeight.textContent = formatPrimaryValue(t, coarse, height, data);
        this._primaryLabel.textContent  = formatPrimaryLabel(t, coarse, height, data);

        // Subline — sync info ("Fully synced in ~4 min · 381,436 blocks
        // behind") + sync-progress-bar ("Receiving 12 new blocks/min from
        // peers"). Per phase-03 mock when syncing.
        this._renderSubline(coarse, this._lastBackendState, data);
    };

    /**
     * @private
     * Beta 3 — render the chain-subline below the chain-height per
     * phase-03 mock. When healthy: a single `.at-tip` "Fully synced"
     * chip with a ✓ glyph (CSS ::before). When syncing: an ETA line
     * + "N blocks behind" line, plus a sync-progress-bar showing
     * "Receiving N new blocks/min from peers". Otherwise: empty.
     */
    ChainCard.prototype._renderSubline = function (coarse, state, syncData) {
        if (!this._subline) { return; }
        var fmtN = (typeof window !== 'undefined' && window.enmFormatNumber)
            ? window.enmFormatNumber
            : function (n) { return (n == null || !isFinite(n)) ? '—' : String(n); };
        this._subline.innerHTML = '';
        this._syncBar.hidden = true;
        this._syncBar.innerHTML = '';

        if (coarse === 'healthy') {
            var atTip = document.createElement('span');
            atTip.className = 'enm-at-tip';
            atTip.textContent = 'Fully synced';
            this._subline.appendChild(atTip);
            return;
        }

        if (coarse === 'syncing' || coarse === 'recovering' || coarse === 'starting') {
            // ETA + blocks-behind line
            if (syncData) {
                if (syncData.etaMinutes != null) {
                    var eta = document.createElement('span');
                    eta.innerHTML = 'Fully synced in <b>~' + fmtN(syncData.etaMinutes) + ' min</b>';
                    this._subline.appendChild(eta);
                }
                if (syncData.blocksBehind != null) {
                    if (this._subline.children.length) {
                        var sep = document.createElement('span');
                        sep.className = 'enm-chain-subline-sep';
                        sep.textContent = '·';
                        this._subline.appendChild(sep);
                    }
                    var behind = document.createElement('span');
                    behind.innerHTML = '<b>' + fmtN(syncData.blocksBehind) + '</b> blocks behind';
                    this._subline.appendChild(behind);
                }
                // sync-progress-bar — block velocity feedback. Only
                // when we have a positive rate; otherwise omit so the
                // operator doesn't see "0 new blocks/min" while peers
                // are still handshaking.
                if (syncData.blocksPerMin != null && syncData.blocksPerMin > 0) {
                    this._syncBar.hidden = false;
                    var bar = document.createElement('span');
                    bar.innerHTML = 'Receiving <b>' + fmtN(syncData.blocksPerMin)
                        + ' new blocks/min</b> from peers';
                    this._syncBar.appendChild(bar);
                }
            }
            return;
        }

        // Stopped / unconfigured / error — leave subline empty. The
        // state-chip already communicates what's happening; the height
        // number reads "—" or the relevant message.
    };

    /**
     * @private
     * Apply an SSE connection-state change. Updates the card's
     * data-sse-state attribute (drives CSS dimming + breath pause)
     * and toggles the reconnecting pill. Open = everything hidden;
     * anything else = pill on, ring dimmed.
     *
     * @param {('open'|'reconnecting'|'closed')} sseState
     */
    ChainCard.prototype._applySseState = function (sseState) {
        this.root.dataset.sseState = sseState || 'open';
        if (!this._reconnectPill) return;
        this._reconnectPill.hidden = (sseState === 'open');
    };

    /**
     * @private
     * 0.2.0-alpha.7 — DPoS rotation poll. Polls /chains/:id/rotation
     * every 60s (or once on mount). Renders the rotation strip:
     *
     *  - When the operator's pubkey is on duty: green "On duty now"
     *  - When it's in the slate but not on duty: "Your slot — N of M",
     *    plus a "next up at block X" countdown if their next-arbiter
     *    index is known
     *  - When it's NOT in the slate: hide the strip entirely (no
     *    rotation context to surface)
     *
     * Hides on chain dead / not configured / not in slate. Errors
     * silently — rotation visibility is decorative, not load-bearing.
     */
    ChainCard.prototype._refreshRotation = function () {
        if (this._destroyed) return;
        // Skip when the chain is dead — no rotation context.
        if (this._lastCoarseState && (this._lastCoarseState === 'stopped'
            || this._lastCoarseState === 'unconfigured')) {
            if (this._rotationStrip) this._rotationStrip.hidden = true;
            return;
        }
        var self = this;
        this.api.get('/chains/' + this.chainId + '/rotation', { skipCache: true })
            .then(function (data) {
                if (self._destroyed || !self._rotationStrip) return;
                self._applyRotation(data);
            })
            .catch(function () {
                if (self._destroyed || !self._rotationStrip) return;
                self._rotationStrip.hidden = true;
            });
    };

    /**
     * @private
     * Render the rotation strip from a /rotation snapshot. Three states:
     *   on-duty  — operator's pubkey === ondutyarbiter, green chip
     *   in-slate — operator is in the slate but not on duty, info chip
     *   absent   — not in slate; strip hidden
     */
    ChainCard.prototype._applyRotation = function (data) {
        var strip = this._rotationStrip;
        if (!strip) return;
        if (!data || !data.enabled || !data.alive) {
            strip.hidden = true;
            return;
        }
        var inSlate     = (data.ourIndex >= 0);
        var inNextSlate = (data.ourNextIndex >= 0);
        if (!inSlate && !inNextSlate) {
            // Not currently a BPoS arbiter. No rotation context to surface.
            strip.hidden = true;
            return;
        }
        strip.hidden = false;
        strip.innerHTML = '';

        var dot = document.createElement('span');
        dot.className = 'enm-chain-rotation-dot';
        strip.appendChild(dot);

        var text = document.createElement('span');
        text.className = 'enm-chain-rotation-text';
        strip.appendChild(text);

        if (data.isOnDuty) {
            strip.dataset.state = 'onduty';
            text.textContent = 'On duty now · signing the current block';
        } else if (inSlate) {
            strip.dataset.state = 'inslate';
            // alpha.28.1 batch 68 (Round-19B audit) — guard
            // rotationLength being absent/null. The branch guard at
            // line 786 (`data.ourIndex >= 0`) validates ourIndex but
            // NOT rotationLength. If the backend omits the field
            // (one-direction RPC drift) the previous shape rendered
            // "Your slot · 3 of undefined" verbatim to the operator.
            // Matches the defensive treatment already applied to
            // nextArbiters in the next-slate branch below.
            var rl = (data.rotationLength != null) ? data.rotationLength : '—';
            text.textContent = 'Your slot · '
                + (data.ourIndex + 1) + ' of ' + rl;
        } else {
            strip.dataset.state = 'nextslate';
            text.textContent = 'Queued for next round · '
                + (data.ourNextIndex + 1) + ' of ' + (data.nextArbiters || []).length;
        }
    };

    /** Build a button. Plain helper. */
    function makeBtn(label, className, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-btn ' + className;
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    root.EnmChainCard = ChainCard;
}(typeof window !== 'undefined' ? window : globalThis));
