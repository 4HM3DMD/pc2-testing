/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/power-circle.js — the hero status visualization.
 *
 * One concentric SVG widget that replaces the old "state badge + stats grid +
 * sync bar" stack. It tells the operator at a glance what the chain is doing,
 * using:
 *
 *   - outer ring colour     = current state (off / booting / syncing / healthy / warning / error)
 *   - inner fill ring       = sync percent, only when state === 'syncing'
 *   - centre label          = percent number (syncing) OR a glyph (everything else)
 *   - centre subtitle       = a one-word state name underneath the chain name
 *
 * Visual states map from the 6 backend coarse states (chain-card emits them):
 *
 *   unconfigured  → off       (faint, awaits Configure)
 *   stopped       → off       (faint, awaits Start)
 *   starting      → booting   (animated rotating arc — the Apple-spinner look)
 *   recovering    → booting
 *   syncing       → syncing   (steady ring + filling inner ring + %)
 *   healthy       → healthy   (steady ring + soft glow + ✓)
 *   stalled       → warning   (amber ring + !)
 *   error         → error     (red ring + ✕)
 *
 * The whole circle is a single click target — tap it to do "the obvious thing"
 * for the current state (start when off, open details when running, etc.).
 * The chain-card supplies the click handler.
 *
 * Animations all use Apple's spring easing — cubic-bezier(0.32, 0.72, 0, 1) —
 * via the --motion-spring token in styles.css.
 */

(function (root) {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';

    // viewBox is fixed; ACTUAL size is set via CSS so the widget scales smoothly
    // when the operator resizes the Puter window.
    var VB = 100;
    var CENTRE = VB / 2;
    var OUTER_R = 44;
    var INNER_R = 36;
    var OUTER_CIRC = 2 * Math.PI * OUTER_R;
    var INNER_CIRC = 2 * Math.PI * INNER_R;

    function PowerCircle(opts) {
        opts = opts || {};
        this._onTap = (typeof opts.onTap === 'function') ? opts.onTap : null;
        this._ariaLabel = opts.ariaLabel || 'Status';

        this._state = 'off';
        this._percent = null;

        this._build();
    }

    /** @private */
    PowerCircle.prototype._build = function () {
        // Outer wrapper is a <button> so it's keyboard-focusable + reads as
        // interactive to assistive tech. Inside is the SVG + the centre stack.
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'enm-power-circle';
        btn.setAttribute('aria-label', this._ariaLabel);
        btn.dataset.state = this._state;

        var self = this;
        btn.addEventListener('click', function () {
            if (self._onTap) self._onTap(self._state);
        });

        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + VB + ' ' + VB);
        svg.setAttribute('role', 'img');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('enm-pc-svg');

        // Track ring — always visible, very faint, sits behind everything.
        var track = document.createElementNS(SVG_NS, 'circle');
        track.classList.add('enm-pc-track');
        track.setAttribute('cx', CENTRE);
        track.setAttribute('cy', CENTRE);
        track.setAttribute('r',  OUTER_R);
        track.setAttribute('fill', 'none');
        svg.appendChild(track);

        // State ring — coloured per state. For 'booting' we animate a partial
        // dash so it reads as a spinner.
        var stateRing = document.createElementNS(SVG_NS, 'circle');
        stateRing.classList.add('enm-pc-state-ring');
        stateRing.setAttribute('cx', CENTRE);
        stateRing.setAttribute('cy', CENTRE);
        stateRing.setAttribute('r',  OUTER_R);
        stateRing.setAttribute('fill', 'none');
        // The full-circumference dash is the calm default. Booting overrides
        // via CSS to show a gap that animates around.
        stateRing.style.strokeDasharray = OUTER_CIRC;
        stateRing.style.strokeDashoffset = '0';
        svg.appendChild(stateRing);

        // Percent ring — only painted when state === 'syncing'.
        // Rotated -90deg so it starts at 12 o'clock and fills clockwise.
        var pctRing = document.createElementNS(SVG_NS, 'circle');
        pctRing.classList.add('enm-pc-percent-ring');
        pctRing.setAttribute('cx', CENTRE);
        pctRing.setAttribute('cy', CENTRE);
        pctRing.setAttribute('r',  INNER_R);
        pctRing.setAttribute('fill', 'none');
        pctRing.setAttribute('transform', 'rotate(-90 ' + CENTRE + ' ' + CENTRE + ')');
        pctRing.style.strokeDasharray = INNER_CIRC;
        pctRing.style.strokeDashoffset = INNER_CIRC; // empty by default
        svg.appendChild(pctRing);

        btn.appendChild(svg);

        // Centre label — text that swaps between % (syncing) and a glyph
        // (everything else). Lives in the DOM rather than SVG so we get
        // crisp typography from the inherited font stack.
        var labelWrap = document.createElement('span');
        labelWrap.className = 'enm-pc-label-wrap';

        var glyph = document.createElement('span');
        glyph.className = 'enm-pc-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        labelWrap.appendChild(glyph);

        var pctText = document.createElement('span');
        pctText.className = 'enm-pc-percent';
        pctText.setAttribute('aria-hidden', 'true');
        labelWrap.appendChild(pctText);

        btn.appendChild(labelWrap);

        this.root      = btn;
        this._stateRing = stateRing;
        this._pctRing   = pctRing;
        this._glyph     = glyph;
        this._pctText   = pctText;

        this._render();
    };

    PowerCircle.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        return this;
    };

    PowerCircle.prototype.destroy = function () {
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };

    /**
     * @param {('off'|'booting'|'syncing'|'healthy'|'warning'|'error')} state
     * @param {object} [opts]
     * @param {number} [opts.percent]  0..100, only meaningful when state==='syncing'
     */
    PowerCircle.prototype.setState = function (state, opts) {
        var validStates = ['off', 'booting', 'syncing', 'healthy', 'warning', 'error'];
        if (validStates.indexOf(state) === -1) {
            state = 'off';
        }
        this._state = state;
        if (opts && typeof opts.percent === 'number') {
            // Clamp to [0, 100] — backend can momentarily go to 100.001 etc.
            this._percent = Math.max(0, Math.min(100, opts.percent));
        } else if (state !== 'syncing') {
            this._percent = null;
        }
        this._render();
    };

    PowerCircle.prototype.setOnTap = function (fn) {
        this._onTap = (typeof fn === 'function') ? fn : null;
    };

    /** @private */
    PowerCircle.prototype._render = function () {
        this.root.dataset.state = this._state;

        // Percent ring: only paint when syncing AND we have a percent.
        // Three sub-cases for the centre label:
        //   syncing + percent known    → "82%"
        //   syncing + percent unknown  → animated dots (Apple-style "thinking")
        //   any other state            → state glyph (✓, ⏻, etc.)
        var hasPct = (this._state === 'syncing' && this._percent != null);
        if (hasPct) {
            var filled = INNER_CIRC * (this._percent / 100);
            this._pctRing.style.strokeDashoffset = (INNER_CIRC - filled).toFixed(2);
            this._pctText.textContent = this._percent.toFixed(this._percent < 10 ? 1 : 0) + '%';
            this._pctText.hidden = false;
            this._glyph.hidden = true;
            this._glyph.classList.remove('enm-pc-glyph-estimating');
        } else {
            // Empty ring (full offset = invisible).
            this._pctRing.style.strokeDashoffset = INNER_CIRC;
            this._pctText.hidden = true;
            this._glyph.hidden = false;
            if (this._state === 'syncing') {
                // Network reference not in yet — show a "still working
                // on it" hint so the circle never reads as empty/stuck.
                // The CSS class adds a gentle pulse to the dots.
                this._glyph.textContent = '···';
                this._glyph.classList.add('enm-pc-glyph-estimating');
            } else {
                this._glyph.textContent = GLYPH[this._state] || '';
                this._glyph.classList.remove('enm-pc-glyph-estimating');
            }
        }

        // ARIA — describe the state for screen readers.
        var live = STATE_ARIA[this._state] || '';
        if (this._state === 'syncing' && this._percent != null) {
            live = 'Syncing ' + Math.floor(this._percent) + ' percent';
        }
        this.root.setAttribute('aria-label', this._ariaLabel + ': ' + live);
    };

    // Centre glyphs — kept as text so they inherit the page font and scale
    // perfectly. Apple HIG-style: simple, single-stroke characters.
    //
    // alpha.18 — healthy uses the power symbol (⏻) in green, not a
    // checkmark. A check reads as "done / completed"; a running node
    // is ongoing. The power glyph + green colour + the breath
    // animation say "alive and powered on" without the false-finality
    // of a tick. Off and healthy share the glyph; the colour is what
    // changes (gray vs green) — same visual grammar as a Mac's power
    // LED.
    var GLYPH = {
        off:     '⏻',     // power symbol — dim
        booting: '',      // blank — the animated state-ring is enough
        syncing: '',      // not used — percent text takes its place
        healthy: '⏻',     // power symbol — green, breathing
        warning: '!',
        error:   '✕',
    };

    // ARIA fallback strings — chain-card overrides aria-label dynamically too.
    var STATE_ARIA = {
        off:     'Off',
        booting: 'Starting',
        syncing: 'Syncing',
        healthy: 'Healthy',
        warning: 'Warning',
        error:   'Error',
    };

    root.EnmPowerCircle = PowerCircle;
}(typeof window !== 'undefined' ? window : globalThis));
