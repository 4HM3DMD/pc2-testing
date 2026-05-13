/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/theme.js — theme inheritance from PC2 (ElastOS).
 *
 * v0.4 originally shipped its own light/dark toggle that wrote to a
 * shared 'elacity-theme' localStorage key. That worked for sibling
 * Elacity apps but not for the PC2 operator who'd already picked a
 * theme via *Settings → Theme* in the desktop — they'd get whatever
 * theme they last picked inside ENM, ignoring their PC2 choice.
 *
 * v0.4 now inherits PC2's theme automatically. PC2's ThemeService
 * broadcasts a `themeChanged` event whenever the operator changes
 * the desktop theme (see src/gui/src/services/ThemeService.js +
 * BroadcastService.js). The broadcast arrives in our iframe as:
 *
 *     { msg: 'broadcast', name: 'themeChanged',
 *       data: { palette: { primaryColor, primaryHue, ... } } }
 *
 * We read `palette.primaryColor` — 'white' means PC2 is in a
 * light-text-on-dark-chrome theme (dark mode); anything else means
 * dark-text-on-light-chrome (light mode).
 *
 * The operator's manual override in the settings drawer is still
 * respected — when they pick light/dark there, we set
 * `enm-theme-mode = 'manual'` so subsequent broadcasts don't stomp
 * their choice. Drawer also exposes "Follow ElastOS theme" which
 * resets back to `enm-theme-mode = 'auto'`.
 */

(function (root) {
    'use strict';

    var MODE_KEY    = 'enm-theme-mode';   // 'auto' (default) | 'manual'
    var VALUE_KEY   = 'elacity-theme';    // 'light' | 'dark' (shared with sibling apps)

    function getMode() {
        try { return localStorage.getItem(MODE_KEY) || 'auto'; }
        catch (e) { return 'auto'; }
    }

    function setMode(mode) {
        try { localStorage.setItem(MODE_KEY, mode); }
        catch (e) { /* localStorage blocked; ignore */ }
    }

    function applyTheme(name) {
        if (name === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    function paletteToTheme(palette) {
        if (!palette) { return null; }
        // PC2's ThemeService.reload_(): primaryColor = light_text ? 'white' : '#373e44'.
        // 'white' chrome text → dark theme. Anything else → light.
        return (palette.primaryColor === 'white') ? 'dark' : 'light';
    }

    /**
     * Boot — listen for PC2's broadcast and (in 'auto' mode) apply it.
     * Idempotent; safe to call multiple times.
     */
    function init() {
        if (root._enmThemeListenerInstalled) { return; }
        root._enmThemeListenerInstalled = true;

        root.addEventListener('message', function (ev) {
            if (!ev || !ev.data) { return; }
            if (ev.data.msg !== 'broadcast') { return; }
            if (ev.data.name !== 'themeChanged') { return; }
            if (getMode() !== 'auto') { return; } // operator override wins

            var theme = paletteToTheme(ev.data.data && ev.data.data.palette);
            if (theme) {
                applyTheme(theme);
                try { localStorage.setItem(VALUE_KEY, theme); } catch (e) {}
            }
        });

        // alpha.28.1 batch 22 — cross-tab theme sync. Without this, an
        // operator with two ENM windows open who flips the theme in
        // window A leaves window B on the old theme until manual
        // reload. The `storage` event fires in every OTHER tab when
        // localStorage changes, which is exactly what we want.
        // Multi-window audit ac31f3a08 flagged this as the cheapest of
        // its 6 cross-tab gaps.
        root.addEventListener('storage', function (ev) {
            if (!ev || !ev.key) { return; }
            if (ev.key === VALUE_KEY && (ev.newValue === 'light' || ev.newValue === 'dark')) {
                applyTheme(ev.newValue);
            }
            // MODE_KEY changes don't re-apply theme — that's a one-time
            // policy switch the operator already saw confirmation for.
        });
    }

    /**
     * Operator manually picked a theme via the drawer. Stash the value
     * AND switch to manual mode so PC2 broadcasts don't stomp it.
     */
    function setManual(name) {
        setMode('manual');
        try { localStorage.setItem(VALUE_KEY, name); } catch (e) {}
        applyTheme(name);
    }

    /**
     * Operator wants to follow PC2 again. Switch to auto mode; the
     * next themeChanged broadcast (or the page reload) will re-sync.
     */
    function setAuto() {
        setMode('auto');
    }

    /** Current theme name (computed from the data-theme attribute). */
    function current() {
        return document.documentElement.getAttribute('data-theme') === 'dark'
            ? 'dark' : 'light';
    }

    root.EnmThemeService = {
        init:      init,
        setManual: setManual,
        setAuto:   setAuto,
        getMode:   getMode,
        current:   current,
    };
}(typeof window !== 'undefined' ? window : globalThis));
