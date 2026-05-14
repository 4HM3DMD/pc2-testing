/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/system-status.js — top-bar with CPU / RAM / disk / OS.
 *
 * Polls /api/system/status every 30 seconds. Phase 5 will replace polling
 * with SSE 'system' topic pushes for higher granularity.
 */

(function (root) {
    'use strict';

    // 5-second poll matches chain-card so the dashboard feels live across
    // the board. /system/status is a cheap stat() over a few /proc paths
    // — minimal load even at this cadence.
    var POLL_INTERVAL_MS = 5_000;

    function SystemStatus(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('SystemStatus: { api } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-system-status';
        this._timer = null;
        // alpha.28.1 batch 16 — _destroyed flag so the 5s poll's pending
        // .then can short-circuit if destroy() fires while a fetch is in
        // flight. Without this the resolver mutates _cells in a removed
        // DOM subtree (harmless visually, but pins component closures).
        this._destroyed = false;

        this._renderShell();
    }

    SystemStatus.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        var self = this;
        // alpha.28.1 batch 27 — visibility-pause wrap so a hidden tab
        // doesn't fetch /system/status every 5s. 720 hits/hr saved per
        // hidden dashboard. (Audit a96c7d71.)
        if (typeof root !== 'undefined' && typeof root.enmUseVisibilityPause === 'function') {
            this._pauser = root.enmUseVisibilityPause(function () { self.refresh(); }, POLL_INTERVAL_MS);
        } else {
            this._timer = setInterval(function () { self.refresh(); }, POLL_INTERVAL_MS);
        }
        // alpha.28.1 batch 74 (Round-20A audit finding #6) — uptime
        // anchor + 1s tick. Previously the uptime cell only updated on
        // the 5s /system/status poll, so the value jumped "37s → 42s →
        // 47s" right next to the chain-card uptime which ticks smoothly
        // (chain-card anchors _uptimeBaseMs and re-derives every second).
        // The two adjacent cells reading inconsistently was the easiest
        // way to make the dashboard feel laggy. This 1s tick recomputes
        // from the most recent anchor; no extra network cost.
        this._uptimeTimer = setInterval(function () {
            if (self._destroyed || self._uptimeBaseMs == null) { return; }
            // alpha.29 batch 111 (Round-34 perf finding #4, LOW) —
            // skip the textContent write when:
            // (a) tab is hidden — no operator-visible benefit, and
            //     the next visibility-resume will catch up via the
            //     visibility-paused poll which re-anchors
            // (b) formatted value hasn't changed since the previous
            //     tick — enmFormatUptime rounds to coarse units
            //     (e.g. "5m", "1h 23m"), so the same string can
            //     repeat for whole minutes / hours at a time. textContent
            //     on an unchanged value still costs a node-replace in
            //     some browsers; caching the last printed string short-
            //     circuits ~99% of writes once the uptime crosses
            //     the first minute boundary.
            if (typeof document !== 'undefined' && document.hidden) { return; }
            var seconds = Math.floor((Date.now() - self._uptimeBaseMs) / 1000)
                + (self._uptimeBaseSec || 0);
            var formatted = root.enmFormatUptime(seconds);
            if (formatted === self._lastUptimeText) { return; }
            self._lastUptimeText = formatted;
            self._setCell('uptime', formatted, 'ok');
        }, 1000);
        return this;
    };

    SystemStatus.prototype.destroy = function () {
        this._destroyed = true;
        if (this._pauser) { try { this._pauser.stop(); } catch (_) { /* idempotent */ } this._pauser = null; }
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._uptimeTimer) { clearInterval(this._uptimeTimer); this._uptimeTimer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    SystemStatus.prototype.refresh = function () {
        var self = this;
        return this.api.get('/system/status', { skipCache: true }).then(function (s) {
            if (self._destroyed) { return; }
            self._setCell('cpu',    formatCpu(s.cpu),    healthCpu(s.cpu));
            self._setCell('mem',    formatMem(s.memory), healthMem(s.memory));
            self._setCell('disk',   formatDisk(s.disk),  healthDisk(s.disk));
            self._setCell('os',     formatOs(s.os),      healthOs(s.os));
            // Backend contract guard (audit a3e53e9a) — if /system/status
            // ever returns without a `node` envelope (partial response,
            // schema drift, proxy quirk) the previous `s.node.uptimeSec`
            // crashed the entire refresh, dropping straight into the
            // stale-everything catch path. Tolerant access keeps the
            // rest of the cells rendering and just shows uptime as the
            // dash placeholder.
            var uptimeSec = (s && s.node) ? s.node.uptimeSec : null;
            self._setCell('uptime', root.enmFormatUptime(uptimeSec), 'ok');
            // Anchor for the 1s smooth-tick (see mount() comment).
            // We store the SERVER-reported seconds at the instant we
            // received it + the client's wall-clock then; the 1s tick
            // adds (Date.now() - base) / 1000 to derive the live value.
            // Server clock drift is irrelevant — we're only computing
            // increments from the anchor, not absolute time.
            if (typeof uptimeSec === 'number' && isFinite(uptimeSec)) {
                self._uptimeBaseMs = Date.now();
                self._uptimeBaseSec = uptimeSec;
            } else {
                self._uptimeBaseMs = null;
            }
            // Clear any prior stale visual marker.
            Object.keys(self._cells).forEach(function (k) {
                self._cells[k].classList.remove('enm-sys-stale');
            });
            self.root.dataset.stale = '0';
        }).catch(function (err) {
            if (self._destroyed) { return; }
            // Mark every cell as stale so the operator can see the values
            // are not live anymore. CSS dims/strikes-through stale cells.
            Object.keys(self._cells).forEach(function (k) {
                self._cells[k].classList.add('enm-sys-stale');
                self._cells[k].dataset.health = 'unknown';
            });
            self.root.dataset.stale = '1';
            self.root.title = 'System status temporarily unavailable — values may be stale.';
            if (self.notifications && err && err.status !== 401) {
                // Reuse one stable id so a 5-min backend outage doesn't
                // stack 60 identical toasts (cap = 5 visible, but the
                // operator still sees the same warning recycled twelve
                // times a minute). Single-id show() dedupes via dismiss-
                // and-replace, so the toast updates in place instead.
                self.notifications.show({
                    id: 'enm-sys-status-unavailable',
                    severity: 'warning',
                    title: 'System status unavailable',
                    body: err && err.message ? err.message : String(err),
                });
            }
        });
    };

    /**
     * @private
     * Update one cell's value text + health attribute. The leading status
     * dot is rendered via CSS ::before driven by data-health, so all this
     * function does is set strings.
     *
     * @param {string} key   one of cpu/mem/disk/os/uptime
     * @param {string} valueText   formatted "value" string (e.g. "362 GB free")
     * @param {('ok'|'warning'|'critical'|'unknown')} health
     */
    SystemStatus.prototype._setCell = function (key, valueText, health) {
        var cell = this._cells[key];
        if (!cell) return;
        var field = this._fields[key];
        field.textContent = valueText;
        // a11y: cells use text-overflow: ellipsis on narrow widths. Mirror
        // the full text into title= so it stays accessible to mouse hover,
        // screen readers, and operator copy-paste even when truncated.
        field.title = valueText;
        cell.dataset.health = health || 'ok';
        // a11y: state was previously conveyed only by background-color on
        // the ::before dot (WCAG 1.4.1 fail for colour-blind operators).
        // Add an aria-label that explicitly names the health verdict.
        var labelMap = { ok: 'ok', warning: 'warning', critical: 'critical', unknown: 'unknown' };
        cell.setAttribute('aria-label', key + ' ' + (labelMap[health] || 'ok') + ': ' + valueText);
    };

    /** @private */
    SystemStatus.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        this._fields = {};   // value spans, for textContent updates
        this._cells  = {};   // cell wrappers, for data-health + .enm-sys-stale class
        ['cpu', 'mem', 'disk', 'os', 'uptime'].forEach(function (k) {
            var cell = document.createElement('div');
            cell.className = 'enm-sys-cell enm-sys-' + k;
            cell.dataset.health = 'unknown';

            // Value first (DOM order = visual order). The leading status
            // dot lives on the cell as a ::before — no markup needed.
            var value = document.createElement('span');
            value.className = 'enm-sys-value';
            value.textContent = '—';
            cell.appendChild(value);

            // Label sits below the value. Lowercase + secondary text.
            var label = document.createElement('span');
            label.className = 'enm-sys-label';
            label.textContent = t('system_status.' + k);
            cell.appendChild(label);

            this._fields[k] = value;
            this._cells[k]  = cell;
            this.root.appendChild(cell);
        }, this);
    };

    /* --- Value formatters ------------------------------------------------ */

    // alpha.15 — values trimmed so they fit the cell width without
    // ellipsis-truncating ("346 GB fr..." / "ubuntu 2..."). Context that
    // used to live in the value text ("free" suffix on disk, the
    // "/ NN GB" on RAM) moves to the cell label below.

    // alpha.28.1 batch 62 (Round-18 audit) — route CPU load + memory
    // percent through enmFormatNumber instead of calling .toFixed
    // directly. The codebase already acknowledged backend type drift as
    // a real risk (chain-card.js:530-544 height path explicitly Number()-
    // coerces; utils.js:78 documents the pattern). System-status was the
    // last hold-out: `cpu.loadAvg1m.toFixed(2)` and `mem.usedPct.toFixed(0)`
    // crash with TypeError if the backend ever returns those as JSON
    // strings ("1.83" instead of 1.83). The crash happens INSIDE the
    // render fn (not the .catch), so it slips past refresh()'s catch and
    // leaves the row stuck on stale cells until the next poll. formatNumber
    // already coerces via Number() and guards isFinite → dash placeholder
    // on failure, no crash.
    function _fmt(n, decimals) {
        var f = (typeof window !== 'undefined' && window.enmFormatNumber)
            ? window.enmFormatNumber
            : function (x, o) { return (typeof x === 'number' ? x : Number(x)).toFixed((o && o.decimals) || 0); };
        return f(n, { decimals: decimals });
    }
    function formatCpu(cpu) {
        if (!cpu) return '—';
        var load = _fmt(cpu.loadAvg1m, 2);
        // "1.83 / 8" — load over core count.
        return load + ' / ' + (cpu.cores != null ? cpu.cores : '—');
    }
    function formatMem(mem) {
        if (!mem) return '—';
        // Just the percent. Total GB is now in the cell label below.
        return _fmt(mem.usedPct, 0) + '%';
    }
    function formatDisk(disk) {
        if (!disk) return '—';
        // Just the GB. "free" qualifier lives on the label. Locale grouping
        // (1,024 vs 1024) so multi-TB arrays don't render as a wall of digits.
        return _fmt(disk.freeGb, 0) + ' GB';
    }
    function formatOs(os) {
        if (!os) return '—';
        // Strip any trailing words (" LTS", " (codename)") so 22px text
        // fits the cell. Distro + numeric version is enough for triage.
        var name = os.distroId || os.platform || 'unknown';
        if (os.version) {
            var v = String(os.version).split(' ')[0];
            return name + ' ' + v;
        }
        return name;
    }

    /* --- Health computation --------------------------------------------- */

    /** load-per-core > 1.0 = warning, > 1.5 = critical (host overloaded). */
    function healthCpu(cpu) {
        if (!cpu || cpu.loadAvg1m == null || !cpu.cores) return 'unknown';
        var perCore = cpu.loadAvg1m / cpu.cores;
        if (perCore > 1.5) return 'critical';
        if (perCore > 1.0) return 'warning';
        return 'ok';
    }
    /** > 90% = critical (OOM risk), > 80% = warning. */
    function healthMem(mem) {
        if (!mem || mem.usedPct == null) return 'unknown';
        if (mem.usedPct > 90) return 'critical';
        if (mem.usedPct > 80) return 'warning';
        return 'ok';
    }
    /** Trust the backend's status field — it knows ENM's disk thresholds. */
    function healthDisk(disk) {
        if (!disk) return 'unknown';
        if (disk.status === 'critical') return 'critical';
        if (disk.status === 'warning')  return 'warning';
        if (disk.freeGb != null && disk.freeGb < 10) return 'critical';
        if (disk.freeGb != null && disk.freeGb < 50) return 'warning';
        return 'ok';
    }
    /** OS preflight emits .ok=false for unsupported distros. */
    function healthOs(os) {
        if (!os) return 'unknown';
        return os.ok === false ? 'warning' : 'ok';
    }

    root.EnmSystemStatus = SystemStatus;
}(typeof window !== 'undefined' ? window : globalThis));
