/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/tools-update-card.js — read-only "binary update available" card.
 *
 * Lives at the top of the Tools sub-tab. Fetches /api/enm/updates/available
 * on mount + 6h interval. Three resting states:
 *
 *   no data yet              — skeleton "Checking for updates…"
 *   up-to-date (current ===  — single line "On the latest release (vX.Y.Z)"
 *     latest)
 *   update available         — full card: current vs latest, severity chip,
 *                              release-notes excerpt, copy-the-deploy-cmd
 *                              snippet. Apply-in-place button lands in
 *                              alpha.9.
 *
 * Cross-tab indicator: writes `data-update-severity` on document.body
 * whenever the envelope changes; the global CSS hangs a dot off the
 * Tools sub-tab nav button (technical-view.js owns the markup; this
 * component owns the *data*).
 */

(function (root) {
    'use strict';

    var REFRESH_MS = 6 * 60 * 60 * 1000;

    function EnmToolsUpdateCard(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('EnmToolsUpdateCard: { api } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-tools-update-card';
        this.root.innerHTML =
            '<header class="enm-tools-update-head">'
            + '<h3>Binary update</h3>'
            + '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
            + 'Checking GitHub for newer ela releases…'
            + '</p>'
            + '</header>';
        this._timer = null;
    }

    EnmToolsUpdateCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        var self = this;
        this._timer = setInterval(function () { self.refresh(); }, REFRESH_MS);
        return this;
    };

    EnmToolsUpdateCard.prototype.destroy = function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };

    EnmToolsUpdateCard.prototype.refresh = function (opts) {
        var self = this;
        var query = (opts && opts.force) ? '?refresh=1' : '';
        return this.api.get('/updates/available' + query, { skipCache: true }).then(function (env) {
            self._render(env);
            // Surface the cross-tab severity dot via body data attribute.
            // technical-view.js reads this to colour the Tools tab nav button.
            if (env && env.updateAvailable && env.severity) {
                document.body.dataset.updateSeverity = env.severity;
            } else {
                delete document.body.dataset.updateSeverity;
            }
        }).catch(function () {
            self._renderError();
            delete document.body.dataset.updateSeverity;
        });
    };

    /** @private */
    EnmToolsUpdateCard.prototype._render = function (env) {
        if (!env) { this._renderError(); return; }
        if (!env.updateAvailable) {
            this.root.dataset.severity = 'none';
            this.root.innerHTML =
                '<header class="enm-tools-update-head">'
                +   '<h3>Binary update</h3>'
                +   '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
                +     'You\'re on the latest release '
                +     '(<code>' + escapeHtml(env.current || 'unknown') + '</code>).'
                +     (env.lastCheckedAt
                        ? ' Last checked ' + relTime(env.lastCheckedAt) + '.'
                        : '')
                +   '</p>'
                + '</header>';
            return;
        }
        // Update is available.
        this.root.dataset.severity = env.severity || 'minor';
        var severityChip =
            '<span class="enm-tools-update-chip enm-tools-update-chip-' + escapeAttr(env.severity || 'minor') + '">'
            + escapeHtml(severityLabel(env.severity))
            + '</span>';
        var notes = env.releaseNotes
            ? '<details class="enm-tools-update-notes">'
              + '<summary>Release notes</summary>'
              + '<pre>' + escapeHtml(env.releaseNotes) + '</pre>'
              + (env.htmlUrl
                ? '<a href="' + escapeAttr(env.htmlUrl) + '" target="_blank" rel="noopener noreferrer">Open on GitHub →</a>'
                : '')
              + '</details>'
            : '';
        // Apply-in-place lands in alpha.9; for now show the manual deploy
        // command operators are already using to upgrade.
        var deployCmd = env.latest
            ? 'sudo PC2_OWNER_TOKEN=&lt;token&gt; /root/deploy-enm.sh enm-' + escapeHtml(env.latest)
            : 'sudo /root/deploy-enm.sh latest';
        this.root.innerHTML =
            '<header class="enm-tools-update-head">'
            +   '<div class="enm-tools-update-head-row">'
            +     '<h3>Binary update available</h3>'
            +     severityChip
            +   '</div>'
            +   '<p class="enm-tools-update-versions">'
            +     'Installed <code>' + escapeHtml(env.current || 'unknown') + '</code> '
            +     '<span aria-hidden="true">→</span> '
            +     'available <code>' + escapeHtml(env.latest) + '</code>'
            +     (env.publishedAt
                    ? ' <span class="enm-tools-update-when">'
                      + 'released ' + relTime(Date.parse(env.publishedAt))
                      + '</span>'
                    : '')
            +   '</p>'
            + '</header>'
            + notes
            + '<div class="enm-tools-update-action">'
            +   '<p>Apply-in-place lands in <code>0.2.0-alpha.9</code>. For now, deploy from a shell:</p>'
            +   '<pre class="enm-tools-update-cmd">' + deployCmd + '</pre>'
            + '</div>';
    };

    /** @private */
    EnmToolsUpdateCard.prototype._renderError = function () {
        this.root.dataset.severity = 'unknown';
        this.root.innerHTML =
            '<header class="enm-tools-update-head">'
            +   '<h3>Binary update</h3>'
            +   '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
            +     'Couldn\'t reach GitHub. Will retry in 6 hours.'
            +   '</p>'
            + '</header>';
    };

    // ---- helpers ----

    function severityLabel(s) {
        if (s === 'major') return 'MAJOR';
        if (s === 'minor') return 'MINOR';
        if (s === 'patch') return 'PATCH';
        return 'UPDATE';
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
        });
    }
    function escapeAttr(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }
    function relTime(ms) {
        if (!ms || typeof ms !== 'number') return 'recently';
        var diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (diffSec < 60)    return 'just now';
        if (diffSec < 3600)  return Math.floor(diffSec / 60) + ' min ago';
        if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' h ago';
        return Math.floor(diffSec / 86400) + ' d ago';
    }

    root.EnmToolsUpdateCard = EnmToolsUpdateCard;
}(typeof window !== 'undefined' ? window : globalThis));
