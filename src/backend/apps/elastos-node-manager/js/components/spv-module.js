/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/spv-module.js — v0.5.168 (Phase 2) — the SPV Module pane.
 *
 * Mounts when the chain selector is set to "SPV Module" (key='spv'). SPV
 * (class E) is NOT a standalone process: its state is embedded in the EVM
 * sidechains (esc/eid/pg keep their own light-client logs under
 * data/logs-spv) and in the arbiter (getspvheight for its own SPV view +
 * getsidechainblockheight per bridged sidechain). This pane aggregates all
 * of that from the backend GET /spv endpoint:
 *
 *   - Hero: the arbiter's own SPV height (the headline number) + arbiter state.
 *   - Per-sidechain rows: each EVM sidechain's SPV-tracked block height (from
 *     the arbiter) + a "View SPV logs" affordance that tails its on-disk
 *     logs-spv via GET /spv/:id/logs.
 *
 * Read-only. Polls /spv every 5s (visibility-paused so a hidden tab stops
 * fetching). Logs are fetched on demand, not polled.
 *
 * app.js _mountDashboardForActiveChain picks this up:
 *   `if (root.EnmSpvModule) { new root.EnmSpvModule(common).mount(pane); }`.
 */

(function (root) {
    'use strict';

    var POLL_INTERVAL_MS = 5000;

    // Last-resort English fallbacks — runtime prefers strings.js
    // (spv_module.* keys) via enmT, these only show before strings load or
    // in tests that don't include strings.js.
    var SIDE_NAME_FALLBACK = {
        esc: 'Smart Chain',
        eid: 'Identity Chain',
        pg: 'PG Chain',
    };

    /**
     * strings.js lookup with English fallback (mirrors multi-chain-overview's
     * tFb). Avoids surfacing "[key]" placeholders before strings.js loads.
     *
     * @param {string} key
     * @param {string} fallback
     * @param {object} [vars]
     * @returns {string}
     */
    function tFb(key, fallback, vars) {
        var t = root.enmTOrFallback || root.enmT;
        if (typeof t !== 'function') { return formatVars(fallback, vars); }
        var v = t(key, vars);
        if (!v || v === key || v === ('[' + key + ']')) { return formatVars(fallback, vars); }
        return v;
    }

    function formatVars(s, vars) {
        if (!vars) { return s; }
        return String(s).replace(/\{([a-zA-Z0-9_]+)\}/g, function (m, name) {
            return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Format a height number with thousands separators; em-dash when null. */
    function fmtHeight(n) {
        return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString() : '—';
    }

    function EnmSpvModule(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('EnmSpvModule: { api } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications || null;
        this._root = null;
        this._pauser = null;       // enmUseVisibilityPause handle
        this._timer = null;        // fallback setInterval when no pauser
        this._destroyed = false;
        this._openLogsChain = null; // chainId whose logs panel is open
    }

    EnmSpvModule.prototype.mount = function (parent) {
        if (!parent) { throw new TypeError('EnmSpvModule.mount: parent required'); }
        this._root = document.createElement('section');
        this._root.className = 'enm-spv';
        this._root.setAttribute('aria-label', tFb('spv_module.aria', 'SPV Module'));
        parent.appendChild(this._root);
        this._renderLoading();

        var self = this;
        this._fetch();
        // Visibility-paused poll (stops fetching when the tab is hidden) — the
        // same helper chain-card uses for its 5s metric poll.
        if (typeof root.enmUseVisibilityPause === 'function') {
            this._pauser = root.enmUseVisibilityPause(function () { self._fetch(); }, POLL_INTERVAL_MS);
        } else {
            this._timer = setInterval(function () { self._fetch(); }, POLL_INTERVAL_MS);
        }
    };

    EnmSpvModule.prototype.destroy = function () {
        if (this._destroyed) { return; }
        this._destroyed = true;
        if (this._pauser) { try { this._pauser.stop(); } catch (_) { /* idempotent */ } this._pauser = null; }
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._root && this._root.parentNode) {
            this._root.parentNode.removeChild(this._root);
        }
        this._root = null;
    };

    /** @private */
    EnmSpvModule.prototype._renderLoading = function () {
        if (!this._root) { return; }
        this._root.innerHTML = ''
            + '<div class="enm-spv-loading" role="status" aria-live="polite">'
            + '<p>' + escapeHtml(tFb('spv_module.loading', 'Loading SPV status…')) + '</p>'
            + '</div>';
    };

    /** @private */
    EnmSpvModule.prototype._renderError = function (msg) {
        if (!this._root) { return; }
        this._root.innerHTML = ''
            + '<div class="enm-spv-error" role="alert">'
            + '<h2>' + escapeHtml(tFb('spv_module.error_title', 'SPV status unavailable')) + '</h2>'
            + '<p>' + escapeHtml(String(msg)) + '</p>'
            + '</div>';
    };

    /** @private */
    EnmSpvModule.prototype._fetch = function () {
        var self = this;
        this.api.get('/spv', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            // api.js unwraps to parsed.result; be defensive about the envelope.
            var snap = (data && data.result && data.result.arbiter) ? data.result : data;
            self._render(snap);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            // Only paint the error pane on the FIRST load — once we've shown
            // real data, a transient poll failure shouldn't blank the view.
            if (!self._root || !self._root.querySelector('.enm-spv-hero')) {
                self._renderError((err && err.message) || 'Network error');
            }
        });
    };

    /** @private */
    EnmSpvModule.prototype._render = function (snap) {
        if (!this._root) { return; }
        var arbiter = (snap && snap.arbiter) || {};
        var sidechains = (snap && Array.isArray(snap.sidechains)) ? snap.sidechains : [];

        var arbiterStateLabel = arbiter.running
            ? tFb('spv_module.arbiter_running', 'Arbiter running')
            : (arbiter.configured
                ? tFb('spv_module.arbiter_stopped', 'Arbiter stopped')
                : tFb('spv_module.arbiter_absent', 'Arbiter not installed'));
        var arbiterStateClass = arbiter.running ? 'running' : (arbiter.configured ? 'stopped' : 'absent');

        var html = ''
            + '<p class="enm-spv-intro">'
            +   escapeHtml(tFb('spv_module.intro',
                    'SPV (light-client) sync is embedded in the EVM sidechains and the '
                    + 'Arbiter — there is no separate SPV process. This view aggregates '
                    + 'each chain’s SPV-tracked height.'))
            + '</p>'
            // ---- Hero: arbiter SPV height ----
            + '<div class="enm-card enm-spv-hero">'
            +   '<div class="enm-spv-hero-label">'
            +     escapeHtml(tFb('spv_module.hero_label', 'Arbiter SPV height'))
            +   '</div>'
            +   '<div class="enm-spv-hero-value">' + escapeHtml(fmtHeight(arbiter.spvHeight)) + '</div>'
            +   '<div class="enm-spv-hero-sub">'
            +     '<span class="enm-spv-dot ' + arbiterStateClass + '" aria-hidden="true"></span>'
            +     escapeHtml(arbiterStateLabel)
            +   '</div>'
            + '</div>';

        // ---- Per-sidechain SPV heights ----
        html += '<div class="enm-card enm-spv-sidechains">'
            + '<h3>' + escapeHtml(tFb('spv_module.sidechains_title', 'Sidechain SPV heights')) + '</h3>';
        if (sidechains.length === 0) {
            html += '<p class="enm-spv-empty">'
                + escapeHtml(tFb('spv_module.no_sidechains',
                    'No EVM sidechains are configured, so there are no SPV heights to show.'))
                + '</p>';
        } else {
            sidechains.forEach(function (sc) {
                var name = sc.displayName || SIDE_NAME_FALLBACK[sc.chainId] || sc.chainId;
                var dotClass = sc.running ? 'running' : 'stopped';
                html += '<div class="enm-spv-row" data-chain="' + escapeHtml(sc.chainId) + '">'
                    + '<span class="enm-spv-dot ' + dotClass + '" aria-hidden="true"></span>'
                    + '<span class="enm-spv-name">' + escapeHtml(name) + '</span>'
                    + '<span class="enm-spv-height">' + escapeHtml(fmtHeight(sc.spvBlockHeight)) + '</span>';
                if (sc.logsSpvPresent) {
                    html += '<button type="button" class="enm-btn enm-btn-secondary enm-spv-logs-btn" '
                        + 'data-chain="' + escapeHtml(sc.chainId) + '">'
                        + escapeHtml(tFb('spv_module.view_logs', 'View SPV logs'))
                        + '</button>';
                } else {
                    html += '<span class="enm-spv-no-logs">'
                        + escapeHtml(tFb('spv_module.no_logs_yet', 'No SPV logs yet'))
                        + '</span>';
                }
                html += '</div>';
            });
        }
        html += '</div>';

        // ---- On-demand logs panel (hidden until a row's button is clicked) ----
        html += '<div class="enm-card enm-spv-logs-panel" hidden>'
            + '<h3 class="enm-spv-logs-title"></h3>'
            + '<pre class="enm-spv-logs-pre" tabindex="0"></pre>'
            + '</div>';

        this._root.innerHTML = html;
        this._wireLogButtons();
        // Re-open the logs panel if one was open before this re-render (poll).
        if (this._openLogsChain) {
            this._showLogs(this._openLogsChain, /* silent */ true);
        }
    };

    /** @private — attach click handlers to every "View SPV logs" button. */
    EnmSpvModule.prototype._wireLogButtons = function () {
        if (!this._root) { return; }
        var self = this;
        var btns = this._root.querySelectorAll('.enm-spv-logs-btn');
        Array.prototype.forEach.call(btns, function (btn) {
            btn.addEventListener('click', function () {
                self._showLogs(btn.getAttribute('data-chain'), false);
            });
        });
    };

    /**
     * @private — fetch + render the newest logs-spv tail for one sidechain.
     * @param {string} chainId
     * @param {boolean} silent  true when re-opening after a poll re-render
     */
    EnmSpvModule.prototype._showLogs = function (chainId, silent) {
        if (!this._root || !chainId) { return; }
        this._openLogsChain = chainId;
        var panel = this._root.querySelector('.enm-spv-logs-panel');
        var title = this._root.querySelector('.enm-spv-logs-title');
        var pre = this._root.querySelector('.enm-spv-logs-pre');
        if (!panel || !title || !pre) { return; }
        panel.hidden = false;
        title.textContent = tFb('spv_module.logs_title', 'SPV logs — {chain}', { chain: chainId.toUpperCase() });
        if (!silent) { pre.textContent = tFb('spv_module.logs_loading', 'Loading…'); }

        var self = this;
        this.api.get('/spv/' + encodeURIComponent(chainId) + '/logs', { skipCache: true }).then(function (data) {
            if (self._destroyed || self._openLogsChain !== chainId) { return; }
            var payload = (data && data.result && data.result.lines) ? data.result : data;
            var lines = (payload && Array.isArray(payload.lines)) ? payload.lines : [];
            pre.textContent = lines.length
                ? lines.join('\n')
                : tFb('spv_module.logs_empty', 'No SPV log lines yet for this chain.');
        }).catch(function (err) {
            if (self._destroyed || self._openLogsChain !== chainId) { return; }
            pre.textContent = tFb('spv_module.logs_error', 'Could not read SPV logs: {msg}',
                { msg: (err && err.message) || 'error' });
        });
    };

    root.EnmSpvModule = EnmSpvModule;
    // Exported for tests.
    root.EnmSpvModule._internal = { tFb, fmtHeight, escapeHtml };
}(typeof window !== 'undefined' ? window : globalThis));
