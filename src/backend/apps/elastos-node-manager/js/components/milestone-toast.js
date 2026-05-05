/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/milestone-toast.js — one-time celebration overlays.
 *
 * Fires when the operator's ElastOS hits a meaningful milestone for
 * the first time:
 *   - first_sync   — chain transitions to 'healthy' for the first time
 *   - first_reward — producer.totalRewards crosses 0 for the first time (BPoS)
 *   - first_week   — uptime crosses 7 days for the first time
 *
 * "First-ever" is tracked client-side in localStorage (per-host) since
 * we don't have a server-side milestone registry yet. Each milestone
 * fires at most once per browser/install.
 *
 * Non-blocking, autodismiss (~5s), with a CSS confetti pop. The
 * operator can also click to dismiss early.
 *
 * Hooked from the home view: HeroCard / StatStrip can call
 * EnmMilestone.maybeFire('first_sync', { state: chain }) on each
 * refresh. The component checks localStorage and either fires or
 * no-ops.
 */

(function (root) {
    'use strict';

    var STORAGE_KEY = 'enm-milestones-v1';
    var AUTO_DISMISS_MS = 5500;

    function loadFired() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveFired(map) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); }
        catch (e) { /* localStorage may be blocked; ignore */ }
    }

    /**
     * Maybe fire a milestone toast. Each milestone fires at most once
     * per browser. Conditions are checked here so callers can pass the
     * full chain/producer snapshot without their own gating logic.
     *
     * @param {string} key  — 'first_sync' | 'first_reward' | 'first_week'
     * @param {object} ctx  — { chain, producer }
     */
    function maybeFire(key, ctx) {
        var fired = loadFired();
        if (fired[key]) { return; }

        var triggered = false;
        if (key === 'first_sync') {
            triggered = !!(ctx && ctx.chain && ctx.chain.state === 'healthy');
        } else if (key === 'first_reward') {
            triggered = !!(ctx && ctx.producer
                && typeof ctx.producer.totalRewards === 'number'
                && ctx.producer.totalRewards > 0);
        } else if (key === 'first_week') {
            triggered = !!(ctx && ctx.chain
                && typeof ctx.chain.uptimeSec === 'number'
                && ctx.chain.uptimeSec >= 7 * 86400);
        }
        if (!triggered) { return; }

        fired[key] = Date.now();
        saveFired(fired);
        show(key);
    }

    /** Force-show a milestone (useful for testing). */
    function show(key) {
        var t = root.enmT;
        var I = root.EnmIllust;
        var msg = t('friendly.milestone.' + key);
        if (msg.indexOf('[') === 0) {
            // Unknown key — fall back gracefully.
            msg = '🎉 Nice work!';
        }

        var overlay = document.createElement('div');
        overlay.className = 'enm-milestone';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        overlay.innerHTML =
            '<div class="enm-milestone-card">'
              + '<div class="enm-milestone-illust">' + (I ? I.celebration({ size: 64 }) : '🎉') + '</div>'
              + '<div class="enm-milestone-text">' + escapeHtml(msg) + '</div>'
              + '<button type="button" class="enm-milestone-dismiss" aria-label="Dismiss">×</button>'
            + '</div>';

        document.body.appendChild(overlay);
        // Trigger the slide-in via the next frame so the CSS transition fires.
        requestAnimationFrame(function () { overlay.classList.add('enm-milestone-shown'); });

        var dismissTimer = setTimeout(function () { dismiss(overlay); }, AUTO_DISMISS_MS);

        overlay.querySelector('.enm-milestone-dismiss').addEventListener('click', function () {
            clearTimeout(dismissTimer);
            dismiss(overlay);
        });
    }

    function dismiss(overlay) {
        overlay.classList.remove('enm-milestone-shown');
        setTimeout(function () {
            if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
        }, 320);
    }

    /** Reset for testing. Not used in production. */
    function reset() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmMilestone = {
        maybeFire: maybeFire,
        show:      show,
        reset:     reset,
    };
}(typeof window !== 'undefined' ? window : globalThis));
