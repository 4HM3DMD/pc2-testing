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
        if (n == null) { return '—'; }
        // alpha.28.1 batch 25 — coerce numeric strings via Number().
        // Backend contract drift is a real risk (the chain-card height
        // path already routes through Number(); audit a3e53e9a flagged
        // it as widespread). Doing the coercion at the helper level
        // means every caller (system-status disk, audit row count,
        // chain-card peers/latency/skew, etc.) is hardened with no
        // per-caller wrapper. `Number("943210")` → 943210; `Number("abc")`
        // → NaN which the isFinite guard catches.
        var num = (typeof n === 'number') ? n : Number(n);
        if (!isFinite(num)) { return '—'; }
        var decimals = (opts && typeof opts.decimals === 'number') ? opts.decimals : 0;
        return num.toLocaleString(undefined, {
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
        if (bytes == null) { return '—'; }
        // alpha.28.1 batch 39 — mirror formatNumber: coerce numeric
        // strings via Number() so backend type drift doesn't surface
        // as "—". `Number("2150000000")` → 2150000000 → "2.0 GB".
        var n = (typeof bytes === 'number') ? bytes : Number(bytes);
        if (!isFinite(n)) { return '—'; }
        var precision = (opts && typeof opts.precision === 'number') ? opts.precision : 1;
        var abs = Math.abs(n);
        var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        var i = 0;
        while (abs >= 1024 && i < units.length - 1) {
            abs /= 1024;
            i += 1;
        }
        var rounded = i === 0 ? Math.round(abs) : Number(abs.toFixed(precision));
        return (n < 0 ? '-' : '') + rounded.toLocaleString() + ' ' + units[i];
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

    /**
     * Tri-state probe of `prefers-reduced-motion`. The CSS `*` catch-all
     * already neutralises every transition/animation under reduce-motion,
     * but JS timers carrying motion side effects (toast slide-out, drawer
     * close, attention pulses) still tick at their full duration. Call
     * this to shorten those waits to ~10ms when the user has asked for
     * less motion.
     *
     * Falsy in any environment that lacks matchMedia (older IE-like
     * shells, jsdom test sandboxes), so callers can treat the answer
     * as "assume full motion" without further branching.
     *
     * @returns {boolean}
     */
    function reducedMotion() {
        return !!(typeof root.matchMedia === 'function'
            && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /**
     * Run an async click-handler exactly once at a time.
     *
     * The de facto guard around every mutating action in the app —
     * settings saves, chain start/stop, danger-zone Wipe, validator
     * Activate. Collapses the four duties every handler has to
     * implement by hand today:
     *   1. Refuse re-entry while a previous call is still in flight.
     *   2. Disable the trigger so the operator can't double-click it.
     *   3. Swap the label to something like "Saving…" when given.
     *   4. Restore label + disabled state when the promise settles.
     *
     * `fn` may return a promise or a synchronous value; the result is
     * wrapped in Promise.resolve so both paths converge on the same
     * finally cleanup.
     *
     * Returns a promise that resolves to `null` when the call was
     * refused (already in flight) so callers can short-circuit cleanly.
     *
     * @param {HTMLButtonElement} btn
     * @param {string|null}        runningLabel  optional "Saving…" override
     * @param {function:Promise=}  fn
     * @returns {Promise<any>}
     */
    function runOnce(btn, runningLabel, fn) {
        if (!btn || btn.dataset.busy === '1') { return Promise.resolve(null); }
        btn.dataset.busy = '1';
        var prevText = btn.textContent;
        var prevDisabled = btn.disabled;
        btn.disabled = true;
        if (runningLabel) { btn.textContent = runningLabel; }
        return Promise.resolve()
            .then(typeof fn === 'function' ? fn : function () { return null; })
            .finally(function () {
                btn.dataset.busy = '0';
                btn.disabled = prevDisabled;
                if (runningLabel) { btn.textContent = prevText; }
            });
    }

    /**
     * Schedule a recurring callback that automatically pauses when the
     * tab is backgrounded and snaps back to a fresh tick + cadence
     * when it returns to the foreground.
     *
     * Page Visibility audit (Round 16 a96c7d71) found 8 pollers
     * hammering the backend at full cadence while invisible (5000+
     * fetches/hr for a hidden dashboard). Components opt in by calling
     * enmUseVisibilityPause(fn, intervalMs) in mount() and storing the
     * returned handle's .stop() for destroy().
     *
     * Behaviour:
     *   - visible at start → runs setInterval(fn, intervalMs) normally
     *   - visibilitychange → hidden: clearInterval, no callback fires
     *   - visibilitychange → visible: fire `fn` once immediately
     *     (so the UI catches up after backgrounding), then re-arm
     *     setInterval at the same cadence
     *   - .stop() removes the visibilitychange listener and clears any
     *     pending interval (idempotent, safe to call after stop)
     *
     * @param {function():void} fn
     * @param {number} intervalMs
     * @returns {{stop: function():void}}
     */
    function useVisibilityPause(fn, intervalMs) {
        var timer = null;
        var stopped = false;
        function start() {
            if (stopped) { return; }
            if (timer != null) { return; }
            timer = setInterval(fn, intervalMs);
        }
        function pause() {
            if (timer != null) { clearInterval(timer); timer = null; }
        }
        function onVisChange() {
            if (stopped) { return; }
            if (typeof document !== 'undefined' && document.hidden) {
                pause();
            } else {
                // Catch up immediately on resume so the UI doesn't show
                // up-to-`intervalMs`-old data while waiting for the next
                // tick. Wrap in try so a throwing fn doesn't poison the
                // listener.
                try { fn(); } catch (_) { /* ignore */ }
                start();
            }
        }
        // Initial state — if we mount while hidden, start paused.
        if (typeof document !== 'undefined' && !document.hidden) {
            start();
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisChange);
        }
        return {
            stop: function () {
                stopped = true;
                pause();
                if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                    document.removeEventListener('visibilitychange', onVisChange);
                }
            },
        };
    }

    /**
     * Format a server timestamp (ms since epoch) in one of three modes.
     * Three round audits (i18n / locale / numerical-edge) all flagged
     * that the codebase displays the same kind of timestamp four
     * different ways: audit-tab UTC ISO, log-viewer local HH:MM:SS,
     * tools-update relative, chain-card uptime counter. This helper
     * consolidates the three address-able formats; callers migrate
     * incrementally.
     *
     *   mode='iso'       — '2026-05-13 10:42:31 UTC' (canonical record)
     *   mode='local'     — operator's locale via toLocaleString
     *   mode='relative'  — '2 min ago' / 'just now' / '1 h ago'
     *
     * Returns '—' for null/undefined/NaN/Infinity so the UI never
     * prints raw 'NaN' or 'Invalid Date'.
     *
     * @param {number} ms  epoch milliseconds (numeric strings tolerated)
     * @param {{mode?:'iso'|'local'|'relative'}} [opts]
     * @returns {string}
     */
    function formatDate(ms, opts) {
        var n = (typeof ms === 'number') ? ms : Number(ms);
        if (n == null || !isFinite(n)) { return '—'; }
        var mode = (opts && opts.mode) || 'iso';
        try {
            var d = new Date(n);
            if (mode === 'local') {
                return d.toLocaleString();
            }
            if (mode === 'relative') {
                var diff = Math.max(0, Math.floor((Date.now() - n) / 1000));
                if (diff < 60)    { return 'just now'; }
                if (diff < 3600)  { return Math.floor(diff / 60) + ' min ago'; }
                if (diff < 86400) { return Math.floor(diff / 3600) + ' h ago'; }
                return Math.floor(diff / 86400) + ' d ago';
            }
            // default: iso with UTC suffix (canonical record format)
            return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
        } catch (e) {
            return '—';
        }
    }

    root.enmTOrFallback = enmTOrFallback;
    root.enmPad2 = pad2;
    root.enmFormatUptime = formatUptime;
    root.enmFormatNumber = formatNumber;
    root.enmFormatBytes = formatBytes;
    root.enmFormatAddress = formatAddress;
    root.enmFormatDate = formatDate;
    root.enmReducedMotion = reducedMotion;
    root.enmRunOnce = runOnce;
    root.enmUseVisibilityPause = useVisibilityPause;
}(typeof window !== 'undefined' ? window : globalThis));
