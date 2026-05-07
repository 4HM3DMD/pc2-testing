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

        this._renderShell();
    }

    SystemStatus.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        var self = this;
        this._timer = setInterval(function () { self.refresh(); }, POLL_INTERVAL_MS);
        return this;
    };

    SystemStatus.prototype.destroy = function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    SystemStatus.prototype.refresh = function () {
        var self = this;
        return this.api.get('/system/status', { skipCache: true }).then(function (s) {
            self._setCell('cpu',    formatCpu(s.cpu),    healthCpu(s.cpu));
            self._setCell('mem',    formatMem(s.memory), healthMem(s.memory));
            self._setCell('disk',   formatDisk(s.disk),  healthDisk(s.disk));
            self._setCell('os',     formatOs(s.os),      healthOs(s.os));
            self._setCell('uptime', root.enmFormatUptime(s.node.uptimeSec), 'ok');
            // Clear any prior stale visual marker.
            Object.keys(self._cells).forEach(function (k) {
                self._cells[k].classList.remove('enm-sys-stale');
            });
            self.root.dataset.stale = '0';
        }).catch(function (err) {
            // Mark every cell as stale so the operator can see the values
            // are not live anymore. CSS dims/strikes-through stale cells.
            Object.keys(self._cells).forEach(function (k) {
                self._cells[k].classList.add('enm-sys-stale');
                self._cells[k].dataset.health = 'unknown';
            });
            self.root.dataset.stale = '1';
            self.root.title = 'System status temporarily unavailable — values may be stale.';
            if (self.notifications && err && err.status !== 401) {
                self.notifications.warning(
                    'System status unavailable',
                    err && err.message ? err.message : String(err),
                );
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
        this._fields[key].textContent = valueText;
        cell.dataset.health = health || 'ok';
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

    function formatCpu(cpu) {
        if (!cpu) return '—';
        var load = (cpu.loadAvg1m != null) ? cpu.loadAvg1m.toFixed(2) : '—';
        // Apple-grade: keep the value tight. "load" prefix is implied by
        // the CPU label; "(8 cores)" stays so the operator can read load
        // relative to capacity.
        return load + ' / ' + cpu.cores;
    }
    function formatMem(mem) {
        if (!mem) return '—';
        // Show used% prominently — the most actionable signal. Total GB
        // sits in the secondary number after the slash.
        return mem.usedPct.toFixed(0) + '% / ' + mem.totalGb.toFixed(0) + ' GB';
    }
    function formatDisk(disk) {
        if (!disk) return '—';
        // Free GB is what the operator cares about. The warning glyph used
        // to live in the value text — health attribute drives the leading
        // dot now, so the value stays a clean number.
        return disk.freeGb.toFixed(0) + ' GB free';
    }
    function formatOs(os) {
        if (!os) return '—';
        return (os.distroId || os.platform || 'unknown')
            + (os.version ? ' ' + os.version : '');
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
