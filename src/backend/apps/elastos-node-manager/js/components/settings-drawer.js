/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/settings-drawer.js — slide-in settings panel (v0.4 P5C).
 *
 * Right-side drawer with three sections (eli5 framing per the
 * vocabulary rule):
 *
 *   When to tell me                  — notification preferences
 *   How my ElastOS behaves           — auto-restart + auto-heal toggles
 *   For the technically curious      — disclosure to the v0.3 dashboard
 *
 * Theme toggle lives here too, so the header bar can collapse to a
 * single gear icon. Settings persist via localStorage today (the
 * server-side preference store is v0.5+ work — these toggles are UI-
 * only for now).
 *
 * "Show technical details" closes the drawer and asks the parent
 * (app.js) to swap the home view for the technical view via
 * onShowTechnical().
 *
 * "Reinstall my node" calls onReinstall() — parent decides whether
 * to relaunch the setup conversation or run a destructive reset.
 */

(function (root) {
    'use strict';

    var STORAGE_KEY = 'enm-prefs-v1';
    var DEFAULTS = {
        notifyHelp:      true,
        notifyMilestones: true,
        notifyWeekly:    false,
        autoRestart:     true,    // mirrors backend F1 (already on by default)
        autoHeal:        false,   // F2-F19 opt-in
    };

    function loadPrefs() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            var saved = raw ? JSON.parse(raw) : {};
            // localStorage audit a8adaad6 — JSON.parse happily returns
            // strings, numbers, arrays, and null. Object.assign with a
            // non-plain-object source either silently pollutes the
            // resulting prefs with indexed keys (arrays) or ignores
            // them entirely (primitives). Either way the runtime
            // assumption "prefs[k] is the typed value DEFAULTS[k]
            // declares" is violated. Validate shape + per-key types
            // so a malformed entry falls back to defaults rather
            // than breaking toggles silently.
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
                saved = {};
            }
            var prefs = Object.assign({}, DEFAULTS);
            Object.keys(DEFAULTS).forEach(function (k) {
                var defaultVal = DEFAULTS[k];
                if (Object.prototype.hasOwnProperty.call(saved, k)
                    && typeof saved[k] === typeof defaultVal) {
                    prefs[k] = saved[k];
                }
            });
            return prefs;
        } catch (e) { return Object.assign({}, DEFAULTS); }
    }

    function savePrefs(prefs) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); }
        catch (e) { /* ignore */ }
    }

    function SettingsDrawer(opts) {
        opts = opts || {};
        this.notifications  = opts.notifications || null;
        // null = no "Show technical details" row in the drawer (v0.5 default,
        // because the technical dashboard IS the home). Function = wire it.
        this.onShowTechnical = typeof opts.onShowTechnical === 'function'
            ? opts.onShowTechnical
            : null;
        this.onReinstall = typeof opts.onReinstall === 'function'
            ? opts.onReinstall
            : function () {};

        this._prefs = loadPrefs();
        this._open = false;
        this._builtBody = false;

        this.root = document.createElement('div');
        this.root.className = 'enm-drawer-root';
        this.root.hidden = true;

        this._renderShell();
    }

    SettingsDrawer.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        return this;
    };

    SettingsDrawer.prototype.destroy = function () {
        // Unwire the document-level ESC handler before tearing the DOM down —
        // otherwise the listener leaks (this happened on every "Reinstall my
        // node" flow, which destroys+recreates the app shell).
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        // …and the focus-trap handler too. close() removes it normally,
        // but if destroy() runs while the drawer is open (e.g. operator
        // hits Reinstall mid-flight) the trap leaked because cleanup
        // lived only in close(). One global keydown listener per app
        // teardown is a real bug — the trap re-fires Tab events into
        // detached DOM and crashes some Tab navigations.
        if (this._trapHandler) {
            document.removeEventListener('keydown', this._trapHandler, true);
            this._trapHandler = null;
        }
        if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
        this._open = false;
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    SettingsDrawer.prototype.open = function () {
        if (this._open) { return; }
        this._open = true;
        // a11y: remember where the operator's focus was so close() can
        // return them to the trigger button (WCAG 2.4.3 Focus Order).
        this._previousFocus = document.activeElement;
        this.root.hidden = false;
        if (!this._builtBody) { this._buildBody(); this._builtBody = true; }
        // Trigger the slide-in via the next frame so CSS transitions fire.
        var self = this;
        requestAnimationFrame(function () {
            self.root.classList.add('enm-drawer-open');
            // a11y: move focus into the drawer so keyboard users can act on it
            // immediately. Closing button is the safest landing point.
            var first = self.root.querySelector('button, input, [tabindex]');
            if (first && typeof first.focus === 'function') { first.focus(); }
        });
        // ESC to close.
        this._escHandler = function (ev) {
            if (ev.key === 'Escape') { this.close(); }
        }.bind(this);
        document.addEventListener('keydown', this._escHandler);
        // a11y: focus trap — Tab and Shift+Tab cycle within the drawer so
        // keyboard focus can't escape onto the dashboard behind the
        // overlay (WCAG 2.4.3 violation otherwise).
        this._trapHandler = function (ev) {
            if (ev.key !== 'Tab' || !self._open) { return; }
            var focusables = self.root.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
            if (focusables.length === 0) { return; }
            var firstEl = focusables[0];
            var lastEl  = focusables[focusables.length - 1];
            if (ev.shiftKey && document.activeElement === firstEl) {
                ev.preventDefault();
                lastEl.focus();
            } else if (!ev.shiftKey && document.activeElement === lastEl) {
                ev.preventDefault();
                firstEl.focus();
            }
        };
        document.addEventListener('keydown', this._trapHandler, true);
    };

    SettingsDrawer.prototype.close = function () {
        if (!this._open) { return; }
        this._open = false;
        this.root.classList.remove('enm-drawer-open');
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        if (this._trapHandler) {
            document.removeEventListener('keydown', this._trapHandler, true);
            this._trapHandler = null;
        }
        // a11y: restore focus to the element that opened the drawer.
        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            try { this._previousFocus.focus(); } catch (_) { /* element may be gone */ }
        }
        // Wait for the slide-out transition before hiding so it animates.
        // Track the timer id so destroy() can cancel it if we're torn down
        // mid-animation (otherwise the timer holds a reference to our root).
        var self = this;
        if (this._closeTimer) { clearTimeout(this._closeTimer); }
        this._closeTimer = setTimeout(function () {
            self._closeTimer = null;
            if (!self._open && self.root) { self.root.hidden = true; }
        }, 320);
    };

    /** @private */
    SettingsDrawer.prototype._renderShell = function () {
        // a11y/WCAG 4.1.2: aria-modal + aria-labelledby pointing at the
        // dialog's own H2 is the canonical dialog pattern. The wrapping
        // <aside> is acceptable for a side-drawer but aria-modal makes
        // the modal semantics explicit so screen-reader users know the
        // background is unreachable. The H2 id pairs with aria-labelledby
        // so the dialog's accessible name comes from the visible heading
        // (better than aria-label hand-typed strings drifting from the
        // localised heading text).
        this.root.innerHTML =
            '<div class="enm-drawer-backdrop" aria-hidden="true"></div>'
            + '<aside class="enm-drawer" role="dialog" aria-modal="true" aria-labelledby="enm-drawer-title">'
              + '<header class="enm-drawer-header">'
                + '<h2 id="enm-drawer-title">Settings</h2>'
                + '<button type="button" class="enm-drawer-close" aria-label="Close">×</button>'
              + '</header>'
              + '<div class="enm-drawer-body"></div>'
            + '</aside>';

        var self = this;
        this.root.querySelector('.enm-drawer-backdrop').addEventListener('click', function () { self.close(); });
        this.root.querySelector('.enm-drawer-close').addEventListener('click', function () { self.close(); });
    };

    /** @private */
    SettingsDrawer.prototype._buildBody = function () {
        var body = this.root.querySelector('.enm-drawer-body');
        var self = this;
        body.innerHTML = '';

        // ---- Section 1: When to tell me ---------------------------------
        body.appendChild(makeSection('When to tell me', [
            makeToggle('notifyHelp',       'Tell me when my ElastOS needs help'),
            makeToggle('notifyMilestones', 'Celebrate milestones (first reward, etc.)'),
            makeToggle('notifyWeekly',     'Send me a weekly summary'),
        ], this._prefs, function (key, value) {
            self._prefs[key] = value;
            savePrefs(self._prefs);
        }));

        // ---- Section 2: How my ElastOS behaves --------------------------
        body.appendChild(makeSection('How my ElastOS behaves', [
            makeToggle('autoRestart', 'Restart automatically if it crashes'),
            makeToggleWithHelp('autoHeal',
                'Try to fix problems without asking me',
                'Recommended only for experienced operators.'),
        ], this._prefs, function (key, value) {
            self._prefs[key] = value;
            savePrefs(self._prefs);
            // Eventually wire to /api/enm/healing/rules/:id/enable for autoHeal.
            // Today: localStorage only (UI surfaces the choice; backend still
            // F1-only-default per Wave 1 invariant).
        }));

        // ---- Section 3: Appearance --------------------------------------
        // Default behaviour: ENM follows ElastOS (PC2)'s desktop theme via
        // the puter-js `themeChanged` broadcast. The two rows below let the
        // operator override that ("Switch to {opposite} mode" sets
        // enm-theme-mode=manual) or restore inheritance ("Follow ElastOS
        // theme" sets it back to auto).
        var appearance = makeSection('Appearance', [], this._prefs, function () {});
        var apprRows = appearance.querySelector('.enm-drawer-rows');

        var themeBtn = document.createElement('button');
        themeBtn.type = 'button';
        themeBtn.className = 'enm-drawer-row enm-drawer-row-action';
        themeBtn.innerHTML =
            '<span class="enm-drawer-row-label">'
              + '<span id="enm-drawer-theme-label">Switch to dark mode</span>'
              + '<span class="enm-drawer-row-help" id="enm-drawer-theme-mode"></span>'
            + '</span>'
            + '<span class="enm-drawer-row-chevron" aria-hidden="true">›</span>';
        apprRows.appendChild(themeBtn);

        var followBtn = document.createElement('button');
        followBtn.type = 'button';
        followBtn.className = 'enm-drawer-row enm-drawer-row-action';
        followBtn.innerHTML =
            '<span class="enm-drawer-row-label">Follow ElastOS theme</span>'
            + '<span class="enm-drawer-row-chevron" aria-hidden="true">›</span>';
        apprRows.appendChild(followBtn);
        body.appendChild(appearance);

        function refreshThemeLabels() {
            var dark = document.documentElement.getAttribute('data-theme') === 'dark';
            themeBtn.querySelector('#enm-drawer-theme-label').textContent =
                dark ? 'Switch to light mode' : 'Switch to dark mode';
            var mode = root.EnmThemeService ? root.EnmThemeService.getMode() : 'auto';
            themeBtn.querySelector('#enm-drawer-theme-mode').textContent =
                mode === 'manual'
                    ? "You're overriding ElastOS's theme."
                    : 'Currently following ElastOS.';
            followBtn.hidden = (mode === 'auto');
        }
        refreshThemeLabels();
        themeBtn.addEventListener('click', function () {
            var current = document.documentElement.getAttribute('data-theme');
            var next = (current === 'dark') ? 'light' : 'dark';
            if (root.EnmThemeService) {
                root.EnmThemeService.setManual(next);
            } else {
                if (next === 'dark') { document.documentElement.setAttribute('data-theme', 'dark'); }
                else { document.documentElement.removeAttribute('data-theme'); }
                try { localStorage.setItem('elacity-theme', next); } catch (e) {}
            }
            refreshThemeLabels();
        });
        followBtn.addEventListener('click', function () {
            if (root.EnmThemeService) { root.EnmThemeService.setAuto(); }
            // The next themeChanged broadcast will re-sync. Until it arrives,
            // leave the current visual state alone (no jarring flicker).
            refreshThemeLabels();
        });

        // ---- Section 4: For the technically curious ---------------------
        var advanced = makeSection('For the technically curious', [], this._prefs, function () {});
        var rows = advanced.querySelector('.enm-drawer-rows');

        // v0.5 reset: "Show technical details" was needed when the home
        // was the friendly hero view. The technical dashboard IS the home
        // now, so we hide the disclosure unless the parent explicitly
        // wires onShowTechnical (kept for forward compatibility).
        if (typeof self.onShowTechnical === 'function') {
            var techBtn = makeAction('Show technical details', function () {
                self.close();
                self.onShowTechnical();
            });
            rows.appendChild(techBtn);
        }
        var reinstallBtn = makeAction('Reinstall my node', function () {
            if (!confirm('Reinstall your node? This re-runs the setup wizard. Your existing config will stay until you finish setup again.')) { return; }
            self.close();
            self.onReinstall();
        });
        rows.appendChild(reinstallBtn);
        body.appendChild(advanced);
    };

    function makeSection(title, rows, prefs, onChange) {
        var section = document.createElement('section');
        section.className = 'enm-drawer-section';
        section.innerHTML = '<h3 class="enm-drawer-section-title">' + escapeHtml(title) + '</h3>'
            + '<div class="enm-drawer-rows"></div>';
        var rowsWrap = section.querySelector('.enm-drawer-rows');
        rows.forEach(function (row) {
            var el = row.build(prefs, onChange);
            rowsWrap.appendChild(el);
        });
        return section;
    }

    // Each row is a builder so we can lazily evaluate against the prefs object.
    function makeToggle(key, label) {
        return {
            build: function (prefs, onChange) {
                var row = document.createElement('label');
                row.className = 'enm-drawer-row enm-drawer-row-toggle';
                row.innerHTML =
                    '<span class="enm-drawer-row-label">' + escapeHtml(label) + '</span>'
                    + '<span class="enm-drawer-toggle">'
                      + '<input type="checkbox"' + (prefs[key] ? ' checked' : '') + '/>'
                      + '<span class="enm-drawer-toggle-track"></span>'
                    + '</span>';
                row.querySelector('input').addEventListener('change', function (ev) {
                    onChange(key, ev.target.checked);
                });
                return row;
            },
        };
    }

    function makeToggleWithHelp(key, label, help) {
        return {
            build: function (prefs, onChange) {
                var row = document.createElement('label');
                row.className = 'enm-drawer-row enm-drawer-row-toggle';
                row.innerHTML =
                    '<span class="enm-drawer-row-label">'
                      + escapeHtml(label)
                      + '<span class="enm-drawer-row-help">' + escapeHtml(help) + '</span>'
                    + '</span>'
                    + '<span class="enm-drawer-toggle">'
                      + '<input type="checkbox"' + (prefs[key] ? ' checked' : '') + '/>'
                      + '<span class="enm-drawer-toggle-track"></span>'
                    + '</span>';
                row.querySelector('input').addEventListener('change', function (ev) {
                    onChange(key, ev.target.checked);
                });
                return row;
            },
        };
    }

    function makeAction(label, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'enm-drawer-row enm-drawer-row-action';
        btn.innerHTML =
            '<span class="enm-drawer-row-label">' + escapeHtml(label) + '</span>'
            + '<span class="enm-drawer-row-chevron" aria-hidden="true">›</span>';
        btn.addEventListener('click', onClick);
        return btn;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmSettingsDrawer = SettingsDrawer;
}(typeof window !== 'undefined' ? window : globalThis));
