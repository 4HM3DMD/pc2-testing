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

    var POLL_INTERVAL_MS = 30_000;

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
            self._fields.cpu.textContent  = formatLoad(s.cpu);
            self._fields.mem.textContent  = formatMem(s.memory);
            self._fields.disk.textContent = formatDisk(s.disk);
            self._fields.os.textContent   = formatOs(s.os);
            self._fields.uptime.textContent = root.enmFormatUptime(s.node.uptimeSec);
        }).catch(function (err) {
            // Best-effort — keep last values rendered. Operator sees stale
            // values while the 30s tick decides whether to retry.
            if (self.notifications && err && err.status !== 401) {
                self.notifications.warning(
                    'System status unavailable',
                    err && err.message ? err.message : String(err),
                );
            }
        });
    };

    /** @private */
    SystemStatus.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        this._fields = {};
        ['cpu', 'mem', 'disk', 'os', 'uptime'].forEach(function (k) {
            var cell = document.createElement('div');
            cell.className = 'enm-sys-cell enm-sys-' + k;

            var label = document.createElement('span');
            label.className = 'enm-sys-label';
            label.textContent = t('system_status.' + k);
            cell.appendChild(label);

            var value = document.createElement('span');
            value.className = 'enm-sys-value';
            value.textContent = '—';
            cell.appendChild(value);

            this._fields[k] = value;
            this.root.appendChild(cell);
        }, this);
    };

    function formatLoad(cpu) {
        if (!cpu) return '—';
        return 'load ' + (cpu.loadAvg1m != null ? cpu.loadAvg1m.toFixed(2) : '—')
            + ' (' + cpu.cores + ' cores)';
    }
    function formatMem(mem) {
        if (!mem) return '—';
        return mem.usedPct.toFixed(1) + '% of ' + mem.totalGb.toFixed(1) + ' GB';
    }
    function formatDisk(disk) {
        if (!disk) return '—';
        if (disk.status === 'critical') return '⚠ ' + disk.freeGb.toFixed(1) + ' GB free';
        if (disk.status === 'warning')  return disk.freeGb.toFixed(1) + ' GB free (low)';
        return disk.freeGb.toFixed(1) + ' GB free';
    }
    function formatOs(os) {
        if (!os) return '—';
        if (!os.ok) return '⚠ ' + (os.platform || 'unknown');
        return (os.distroId || os.platform) + (os.version ? ' ' + os.version : '');
    }

    root.EnmSystemStatus = SystemStatus;
}(typeof window !== 'undefined' ? window : globalThis));
