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
        // Close any open update-shell modal so its document-level keydown
        // listener doesn't leak across an app reinstall. _modalClose is
        // wired by _openUpdateModal whenever the modal is open.
        if (typeof this._modalClose === 'function') {
            try { this._modalClose(); } catch (e) { /* ignore */ }
            this._modalClose = null;
        }
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
        // 0.2.0-alpha.9 — surface offline-mode + fallback source so the
        // operator knows when the version comparison is build-time stale
        // vs a fresh GitHub probe.
        var isFallback = env.source === 'fallback';
        var isStale = env.status === 'stale';
        var sourceBadge = isFallback
            ? ' <span class="enm-tools-update-badge" title="GitHub unreachable; showing last known stable version baked into this ENM build.">offline</span>'
            : (isStale ? ' <span class="enm-tools-update-badge enm-tools-update-badge-stale" title="GitHub probe failed; showing the last successful result.">stale</span>' : '');

        if (!env.updateAvailable) {
            this.root.dataset.severity = 'none';
            this.root.innerHTML =
                '<header class="enm-tools-update-head">'
                +   '<h3>Binary update' + sourceBadge + '</h3>'
                +   '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
                +     'You\'re on the latest release '
                +     '(<code>' + escapeHtml(env.current || 'unknown') + '</code>).'
                +     (env.lastCheckedAt
                        ? ' Last checked ' + relTime(env.lastCheckedAt) + '.'
                        : '')
                +     (isFallback
                        ? '<br><span style="font-size:12px;color:var(--text-muted)">'
                          + 'GitHub unreachable from this server; comparison uses the build-time '
                          + '<code>knownGoodElaVersion</code> baked into this ENM bundle.'
                          + '</span>'
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
        // 0.2.0-alpha.10 — update command is no longer rendered inline.
        // A button opens a modal with the exact command, copy-to-clipboard,
        // and the audit/security boilerplate. Two reasons: (1) the inline
        // <pre> showed the operator's token as a literal "<token>"
        // placeholder which confused at least one operator, (2) modal
        // gives us room for the "what this actually does" explainer
        // without bloating the resting card.
        // Apply-in-place (real "Update now" with preflight + rollback)
        // lands in alpha.11+; this release is the UX shortcut.
        this.root.innerHTML =
            '<header class="enm-tools-update-head">'
            +   '<div class="enm-tools-update-head-row">'
            +     '<h3>Binary update available' + sourceBadge + '</h3>'
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
            +   '<button type="button" class="enm-btn enm-btn-primary enm-tools-update-btn">Update via shell</button>'
            +   '<p class="enm-tools-update-action-help">'
            +     'Opens a copy-paste-ready command. Apply-in-place (no shell required) lands in alpha.11+.'
            +   '</p>'
            + '</div>';

        var self = this;
        var btn = this.root.querySelector('.enm-tools-update-btn');
        if (btn) {
            btn.addEventListener('click', function () { self._openUpdateModal(env); });
        }
    };

    /**
     * @private
     * Show a modal with the deploy command pre-filled. The token is
     * filled in only when the user clicks "Use my owner token (auto-fill)" —
     * default is the placeholder so we don't display credentials by
     * default if someone screenshots the card.
     */
    EnmToolsUpdateCard.prototype._openUpdateModal = function (env) {
        var prev = document.querySelector('.enm-tools-update-modal');
        if (prev) prev.parentNode.removeChild(prev);

        var modal = document.createElement('div');
        modal.className = 'enm-tools-update-modal';
        modal.innerHTML =
            '<div class="enm-tools-update-modal-card" role="dialog" aria-labelledby="upd-mod-h" aria-modal="true">'
            +   '<button type="button" class="enm-tools-update-modal-close" aria-label="Close">×</button>'
            +   '<h2 id="upd-mod-h">Update to <code>' + escapeHtml(env.latest) + '</code></h2>'
            +   '<p>Run this on the host that runs your PC2 server (where ENM\'s files live):</p>'
            +   '<pre class="enm-tools-update-modal-cmd">'
            +     'sudo PC2_OWNER_TOKEN=<span class="upd-tok-slot">&lt;your-token&gt;</span> /root/deploy-enm.sh enm-' + escapeHtml(env.latest)
            +   '</pre>'
            +   '<div class="enm-tools-update-modal-actions">'
            +     '<button type="button" class="enm-btn enm-btn-secondary upd-fill-token">Auto-fill my token</button>'
            +     '<button type="button" class="enm-btn enm-btn-primary upd-copy" aria-label="Copy update shell command">Copy command</button>'
            +   '</div>'
            +   '<details class="enm-tools-update-modal-notes">'
            +     '<summary>What does this do?</summary>'
            +     '<ul>'
            +       '<li>Downloads ela <code>' + escapeHtml(env.latest) + '</code> from GitHub.</li>'
            +       '<li>Uninstalls the old ENM bundle via <code>DELETE /api/installed-apps</code> (chain data + keystore safe under <code>extensions/elastos-node-manager/</code>).</li>'
            +       '<li>Reinstalls with the new binary; pc2-node spawns it under the supervisor.</li>'
            +       '<li>Health-checks for 24s; auto-rollback if the new binary doesn\'t come up.</li>'
            +     '</ul>'
            +     (env.htmlUrl
                    ? '<p>Release notes: <a href="' + escapeAttr(env.htmlUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeAttr(env.htmlUrl) + '</a></p>'
                    : '')
            +   '</details>'
            + '</div>';
        document.body.appendChild(modal);

        // Capture focus return target + install focus trap so Tab can't
        // escape onto the chain card behind the scrim. Mirrors the
        // proposal-card + settings-drawer pattern.
        var previousFocus = document.activeElement;
        var cardSelf = self;

        var close = function () {
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            document.removeEventListener('keydown', onEsc);
            document.removeEventListener('keydown', trapHandler, true);
            try {
                if (previousFocus && typeof previousFocus.focus === 'function') {
                    previousFocus.focus({ preventScroll: true });
                }
            } catch (e) { /* focus may fail in detached states */ }
            // Drop the destroy-hook reference so a second destroy is a no-op.
            if (cardSelf) { cardSelf._modalClose = null; }
        };
        var onEsc = function (e) { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onEsc);
        var trapHandler = function (ev) {
            if (ev.key !== 'Tab') { return; }
            var focusables = modal.querySelectorAll(
                'a[href], button:not([disabled]), textarea:not([disabled]), ' +
                'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            if (!focusables.length) { return; }
            var first = focusables[0];
            var last  = focusables[focusables.length - 1];
            if (ev.shiftKey && document.activeElement === first) {
                ev.preventDefault();
                last.focus();
            } else if (!ev.shiftKey && document.activeElement === last) {
                ev.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', trapHandler, true);

        // Expose for the card-level destroy() so the listener can't leak
        // if the operator navigates away while the modal is open.
        cardSelf._modalClose = close;

        // Move focus inside the modal once it mounts so screen readers
        // announce the new region and keyboard users land on a useful
        // control. Prefer the first action button; fall back to the close X.
        try {
            var firstFocus = modal.querySelector('.upd-fill-token')
                || modal.querySelector('.upd-copy')
                || modal.querySelector('.enm-tools-update-modal-close');
            if (firstFocus) { firstFocus.focus({ preventScroll: true }); }
        } catch (e) { /* ignore */ }

        modal.querySelector('.enm-tools-update-modal-close').addEventListener('click', close);
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

        modal.querySelector('.upd-fill-token').addEventListener('click', function () {
            // The owner token lives on the URL's puter.auth.token search
            // param (PC2 standard). Read it directly so we don't ask the
            // operator to paste it.
            var params = new URLSearchParams(root.location.search || '');
            var tok = params.get('puter.auth.token');
            var slot = modal.querySelector('.upd-tok-slot');
            if (tok && slot) {
                slot.textContent = tok;
                slot.style.color = 'var(--state-stalled)';
                slot.title = 'Your auth token. Treat as a credential — don\'t share screenshots.';
            } else if (slot) {
                slot.textContent = '(token not found in URL)';
            }
        });

        var modalSelf = self;
        modal.querySelector('.upd-copy').addEventListener('click', function () {
            var pre = modal.querySelector('.enm-tools-update-modal-cmd');
            // Use textContent so the <span> placeholder is included literally.
            var text = pre ? pre.textContent : '';
            // Feature-detect so the .catch fallback has something to land in
            // when the iframe sandbox blocks the clipboard API outright.
            // Also explicitly capture `modalSelf` outside the closure —
            // the audit found that `self` was undefined inside the catch
            // because it shadows the outer scope.
            var hasClipboard = !!(navigator && navigator.clipboard && navigator.clipboard.writeText);
            if (!hasClipboard) {
                if (modalSelf && modalSelf.notifications) {
                    modalSelf.notifications.warning('Copy unavailable', 'Browser blocked clipboard access. Select the command text and copy manually.');
                }
                return;
            }
            navigator.clipboard.writeText(text).then(function () {
                var btn = modal.querySelector('.upd-copy');
                if (btn) {
                    var prev = btn.textContent;
                    btn.textContent = 'Copied ✓';
                    setTimeout(function () { btn.textContent = prev; }, 1400);
                }
            }).catch(function () {
                if (modalSelf && modalSelf.notifications) {
                    modalSelf.notifications.warning('Copy failed', 'Select the command text and copy manually.');
                }
            });
        });
    };

    /** @private */
    EnmToolsUpdateCard.prototype._renderError = function () {
        // Only fires when /updates/available itself returned non-2xx
        // (auth failure, route error). Network-unreachable cases land
        // in the main _render path with status='fallback'/'stale'.
        this.root.dataset.severity = 'unknown';
        this.root.innerHTML =
            '<header class="enm-tools-update-head">'
            +   '<h3>Binary update</h3>'
            +   '<p class="enm-stub" style="margin:0;text-align:left;padding:0">'
            +     'Update info endpoint returned an error. Will retry in 6 hours.'
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
        if (!ms || typeof ms !== 'number') { return 'recently'; }
        var diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        var human;
        if (diffSec < 60)         { human = 'just now'; }
        else if (diffSec < 3600)  { human = Math.floor(diffSec / 60) + ' min ago'; }
        else if (diffSec < 86400) { human = Math.floor(diffSec / 3600) + ' h ago'; }
        else                      { human = Math.floor(diffSec / 86400) + ' d ago'; }
        // Wrap the human label in a <time> element carrying the exact
        // ISO timestamp so:
        //   - the operator gets the precise time on hover (title=)
        //   - assistive tech can announce datetime= as the canonical
        //     value when the relative phrase ("12 min ago") is too vague
        //   - the rendered span survives static HTML strings without
        //     extra JS plumbing.
        try {
            var iso = new Date(ms).toISOString();
            return '<time datetime="' + iso + '" title="' + iso + '">' + human + '</time>';
        } catch (e) {
            return human;
        }
    }

    root.EnmToolsUpdateCard = EnmToolsUpdateCard;
}(typeof window !== 'undefined' ? window : globalThis));
