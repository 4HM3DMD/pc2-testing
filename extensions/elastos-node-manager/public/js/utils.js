/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * utils.js — shared frontend helpers.
 *
 * Loaded after strings.js (which defines window.enmT) but before any service
 * or component file. Centralizes the enmTOrFallback wrapper so we have one
 * source of truth for string lookup with a defensive fallback.
 */

(function (root) {
    'use strict';

    /**
     * Look up a string via window.enmT. If strings.js failed to load, return
     * the key unchanged so the UI is at least readable rather than blank.
     *
     * @param {string} key
     * @param {object} [vars]
     * @returns {string}
     */
    function enmTOrFallback(key, vars) {
        if (typeof root.enmT === 'function') {
            return root.enmT(key, vars);
        }
        return key;
    }

    /**
     * Pad an integer to two digits (e.g. 7 → "07"). Used by log timestamps.
     *
     * @param {number} n
     * @returns {string}
     */
    function pad2(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    /**
     * Format a duration in seconds as the most useful unit.
     *
     * @param {number} seconds
     * @returns {string}
     */
    function formatUptime(seconds) {
        if (seconds == null || !isFinite(seconds)) { return '—'; }
        var s = Math.max(0, Math.floor(seconds));
        if (s < 60) { return s + 's'; }
        if (s < 3600) { return Math.floor(s / 60) + 'm'; }
        if (s < 86_400) {
            return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
        }
        var days = Math.floor(s / 86_400);
        var hours = Math.floor((s % 86_400) / 3600);
        return days + 'd ' + hours + 'h';
    }

    root.enmTOrFallback = enmTOrFallback;
    root.enmPad2 = pad2;
    root.enmFormatUptime = formatUptime;
}(typeof window !== 'undefined' ? window : globalThis));
