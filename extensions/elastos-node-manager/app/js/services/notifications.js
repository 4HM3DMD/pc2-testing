/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/notifications.js — Bootstrap-style toast notifications.
 *
 * Bootstrap 5.1.3 is bundled with PC2 (verified Rev 4 audit), but our extension
 * iframe doesn't inherit it. We ship a lightweight toast system using the same
 * visual language (4 severity tiers, top-right corner, auto-dismiss for INFO).
 * That keeps Phase 3 self-contained without pulling in the full bundle.
 *
 * Severity tiers (per Rev 4 audit, agent 4):
 *   info     — auto-dismiss 5s, blue border
 *   warning  — manual dismiss, yellow border
 *   critical — manual dismiss, red border, must be acked before nav
 *   healing  — animated pulse purple border, dismiss after action completes
 *
 * Stack order: newest at top. Cap at 5 visible — older toasts collapse into a
 * "+N more" stub (Phase 5 will add a notification history panel).
 */

(function (root) {
    'use strict';

    var MAX_VISIBLE = 5;
    var INFO_AUTODISMISS_MS = 5000;

    function Notifications(opts) {
        this.container = ensureContainer(opts && opts.containerId);
        this._items = [];
        this._counter = 0;
    }

    /**
     * Show a toast.
     *
     * @param {object} args
     * @param {'info'|'warning'|'critical'|'healing'} args.severity
     * @param {string} args.title
     * @param {string} [args.body]
     * @param {string} [args.id]    use to dedupe / replace
     * @param {() => void} [args.onAck]
     * @returns {string}            the toast id
     */
    Notifications.prototype.show = function (args) {
        if (!args || !args.severity || !args.title) {
            throw new TypeError('Notifications.show: { severity, title } required');
        }
        var id = args.id || ('enm-toast-' + (++this._counter));

        // Dedupe: replace existing toast with the same id.
        this.dismiss(id, true);

        var node = renderToast(id, args, this);
        this.container.appendChild(node);
        this._items.push({ id: id, node: node, severity: args.severity });
        this._trimVisible();

        if (args.severity === 'info') {
            var self = this;
            setTimeout(function () { self.dismiss(id); }, INFO_AUTODISMISS_MS);
        }
        return id;
    };

    Notifications.prototype.info     = function (title, body) { return this.show({ severity: 'info',     title: title, body: body }); };
    Notifications.prototype.warning  = function (title, body) { return this.show({ severity: 'warning',  title: title, body: body }); };
    Notifications.prototype.critical = function (title, body) { return this.show({ severity: 'critical', title: title, body: body }); };
    Notifications.prototype.healing  = function (title, body) { return this.show({ severity: 'healing',  title: title, body: body }); };

    /**
     * Remove a toast by id. Silent if missing.
     */
    Notifications.prototype.dismiss = function (id, silent) {
        var idx = this._items.findIndex(function (t) { return t.id === id; });
        if (idx < 0) {
            return;
        }
        var item = this._items[idx];
        this._items.splice(idx, 1);
        if (silent) {
            // Dedup path (called from show() before appending the replacement
            // node). Remove synchronously so we don't end up with two DOM
            // nodes carrying the same id in the same tick.
            if (item.node.parentNode) {
                item.node.parentNode.removeChild(item.node);
            }
            return;
        }
        item.node.classList.add('enm-toast-leaving');
        // Wait for the CSS transition; remove after.
        setTimeout(function () {
            if (item.node.parentNode) {
                item.node.parentNode.removeChild(item.node);
            }
        }, 200);
    };

    Notifications.prototype.clear = function () {
        var self = this;
        this._items.slice().forEach(function (t) { self.dismiss(t.id, true); });
    };

    /** @private */
    Notifications.prototype._trimVisible = function () {
        while (this._items.length > MAX_VISIBLE) {
            var oldest = this._items.shift();
            if (oldest.node.parentNode) {
                oldest.node.parentNode.removeChild(oldest.node);
            }
        }
    };

    function ensureContainer(id) {
        var actual = id || 'enm-toast-container';
        var el = document.getElementById(actual);
        if (el) return el;
        el = document.createElement('div');
        el.id = actual;
        el.className = 'enm-toast-container';
        el.setAttribute('role', 'region');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-label', 'Notifications');
        // Anchor inside .enm-main so position:absolute lands below the
        // chrome (titlebar + tabs) without us needing to know their
        // height. Falls back to body if .enm-main isn't present yet.
        var host = document.querySelector('.enm-main') || document.body;
        host.appendChild(el);
        return el;
    }

    function renderToast(id, args, parent) {
        var t = root.enmTOrFallback;
        var sev = args.severity;
        var node = document.createElement('div');
        node.id = id;
        node.className = 'enm-toast enm-toast-' + sev;
        node.setAttribute('role', sev === 'critical' ? 'alert' : 'status');

        var head = document.createElement('div');
        head.className = 'enm-toast-head';

        var title = document.createElement('div');
        title.className = 'enm-toast-title';
        title.textContent = args.title;
        head.appendChild(title);

        var dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'enm-toast-dismiss';
        dismissBtn.setAttribute('aria-label', t('notification.dismiss'));
        dismissBtn.textContent = '×'; // ×
        dismissBtn.addEventListener('click', function () { parent.dismiss(id); });
        head.appendChild(dismissBtn);

        node.appendChild(head);

        if (args.body) {
            var body = document.createElement('div');
            body.className = 'enm-toast-body';
            body.textContent = args.body;
            node.appendChild(body);
        }

        if (sev === 'critical' && typeof args.onAck === 'function') {
            var ack = document.createElement('button');
            ack.type = 'button';
            ack.className = 'enm-toast-ack';
            ack.textContent = t('notification.ack');
            ack.addEventListener('click', function () {
                args.onAck();
                parent.dismiss(id);
            });
            node.appendChild(ack);
        }
        return node;
    }

    root.EnmNotifications = Notifications;
}(typeof window !== 'undefined' ? window : globalThis));
