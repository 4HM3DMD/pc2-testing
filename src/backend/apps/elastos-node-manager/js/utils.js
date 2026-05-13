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

    /**
     * Format a number with locale grouping. Returns the dash placeholder
     * for null / undefined / NaN / Infinity so the UI never prints raw
     * "NaN" or "Infinity" when the backend hiccups.
     *
     * @param {number} n
     * @param {{decimals?:number}} [opts]
     * @returns {string}
     */
    function formatNumber(n, opts) {
        if (n == null || typeof n !== 'number' || !isFinite(n)) { return '—'; }
        var decimals = (opts && typeof opts.decimals === 'number') ? opts.decimals : 0;
        return n.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
    }

    /**
     * Format a byte count with an adaptive unit. 2,150,000,000 → "2.0 GB".
     * Mirrors the dash placeholder rules from formatNumber.
     *
     * @param {number} bytes
     * @param {{precision?:number}} [opts]
     * @returns {string}
     */
    function formatBytes(bytes, opts) {
        if (bytes == null || typeof bytes !== 'number' || !isFinite(bytes)) { return '—'; }
        var precision = (opts && typeof opts.precision === 'number') ? opts.precision : 1;
        var abs = Math.abs(bytes);
        var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        var i = 0;
        while (abs >= 1024 && i < units.length - 1) {
            abs /= 1024;
            i += 1;
        }
        var rounded = i === 0 ? Math.round(abs) : Number(abs.toFixed(precision));
        return (bytes < 0 ? '-' : '') + rounded.toLocaleString() + ' ' + units[i];
    }

    /**
     * Truncate a long opaque identifier (wallet, pubkey, tx hash) for
     * display while keeping enough head + tail to be recognizable.
     * Returns the original string when it already fits in head+tail+1.
     *
     * @param {string} s
     * @param {{head?:number,tail?:number}} [opts]
     * @returns {string}
     */
    function formatAddress(s, opts) {
        if (s == null) { return '—'; }
        var str = String(s);
        var head = (opts && typeof opts.head === 'number') ? opts.head : 6;
        var tail = (opts && typeof opts.tail === 'number') ? opts.tail : 4;
        if (str.length <= head + tail + 1) { return str; }
        return str.slice(0, head) + '…' + str.slice(-tail);
    }

    root.enmTOrFallback = enmTOrFallback;
    root.enmPad2 = pad2;
    root.enmFormatUptime = formatUptime;
    root.enmFormatNumber = formatNumber;
    root.enmFormatBytes = formatBytes;
    root.enmFormatAddress = formatAddress;
}(typeof window !== 'undefined' ? window : globalThis));
