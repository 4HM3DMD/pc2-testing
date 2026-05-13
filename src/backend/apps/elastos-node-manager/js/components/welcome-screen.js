/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/welcome-screen.js — first-run welcome (v0.4 "Welcome Home").
 *
 * One illustration, one headline, one paragraph, one button. No menus,
 * no tabs, no jargon. This is the very first thing an operator sees on
 * a fresh install — its job is to lower the activation cost from
 * "I have to learn what this app does" to "I just tap one button."
 *
 * Triggers `onContinue()` when the operator taps the CTA. The parent
 * (app.js) is responsible for swapping in the setup conversation next.
 */

(function (root) {
    'use strict';

    function WelcomeScreen(opts) {
        if (!opts) { opts = {}; }
        this.onContinue = typeof opts.onContinue === 'function'
            ? opts.onContinue
            : function () {};

        this.root = document.createElement('section');
        this.root.className = 'enm-welcome';
    }

    WelcomeScreen.prototype.mount = function (parent) {
        var t = root.enmT;
        parent.appendChild(this.root);

        this.root.innerHTML =
            '<div class="enm-welcome-inner">'
            + '<div class="enm-welcome-illust">'
                + (root.EnmIllust ? root.EnmIllust.welcome({ size: 128 }) : '')
            + '</div>'
            + '<h2 class="enm-welcome-title">' + escapeHtml(t('friendly.welcome.title')) + '</h2>'
            + '<p class="enm-welcome-body">' + escapeHtml(t('friendly.welcome.body')) + '</p>'
            + '<button type="button" class="enm-btn enm-btn-primary enm-btn-hero enm-welcome-cta">'
                + escapeHtml(t('friendly.welcome.cta')) + ' <span aria-hidden="true">→</span>'
            + '</button>'
            + '</div>';

        var self = this;
        var cta = this.root.querySelector('.enm-welcome-cta');
        cta.addEventListener('click', function () {
            self.onContinue();
        });
        // a11y: the welcome screen is the operator's first interactive
        // landmark on a clean install. Without this focus call they have
        // to Tab past the (empty) header + skip-link to reach the only
        // meaningful control. Focusing the CTA on mount also gives
        // screen-reader users an immediate announcement of the button's
        // label + role.
        try { cta.focus({ preventScroll: true }); } catch (e) { cta.focus(); }
        return this;
    };

    WelcomeScreen.prototype.destroy = function () {
        if (this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
    };

    // alpha.28.1 batch 83 (Round-24 finding #1, MED) — align with the
    // defensive null/undefined coercion every other escapeHtml copy
    // in the codebase already uses (setup-conversation:1101,
    // validator-card:364, settings-drawer:411, technical-view:673,
    // tools-update-card:442). Welcome-screen was the only outlier
    // calling `String(s)` raw — if a future i18n key returns undefined
    // (strings.js fails to load, or `friendly.welcome.title` is renamed),
    // the welcome card's first-impression renders the literal string
    // "undefined" instead of empty. Trivial inconsistency that
    // defeated the file's own defensive pattern.
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmWelcomeScreen = WelcomeScreen;
}(typeof window !== 'undefined' ? window : globalThis));
