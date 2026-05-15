/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/settings-tab.js — Beta 3 rewrite (phase-04).
 *
 * Mirrors enm-design-mocks/v2/phase-04-settings.html structure:
 *   - .enm-settings-wrap = grid 200px 1fr on wide; 1fr on narrow/compact.
 *   - Wide nav rail (.enm-settings-nav, sticky) is hidden on narrow/compact
 *     by a CSS rule on .enm-app[data-app-size]; an alternate pill row
 *     (.enm-settings-pills) takes its place. Both are rendered, CSS hides
 *     one based on viewport.
 *   - Three sections only: Network · Mainchain Advanced · General.
 *     Danger-Zone UI dropped per phase-04 mock. The wipe methods stay as
 *     dead code (DELETE /api/installed-apps/...) for a future surface.
 *     RPC reveal-only panel dropped — credentials merged into Advanced.
 *   - Per-section Save → three separate PUT /config/{network,mainchain,
 *     general} endpoints. There is no global Apply.
 *
 * alpha.28 behavioural carry-over still applies:
 *   - _destroyed guard on every .then/.catch (batch 16, 51, 95).
 *   - 401 suppression — boot path owns re-auth; no scary toast (batch 51).
 *   - enmRunOnce on every Save button (utils.js runOnce) — disables +
 *     swaps label "Saving…" then restores in .finally so a slow backend
 *     can never double-save.
 *   - .finally re-enables disabled state regardless of resolve/reject
 *     (alpha.28 batch 60 finalizer pattern).
 *   - ARIA: role="tablist" on the nav, role="tab" on items, role="tabpanel"
 *     on each section-card, aria-selected reflected on nav + pills,
 *     role="status" on every foot status, role="alert" on error states.
 *   - Locked 127.0.0.1 chip — chip[data-locked="true"] renders 🔒 instead
 *     of remove × and refuses removal. setValue auto-merges the locked
 *     entries so the backend can never drop it. Backend has a defence in
 *     depth anyway.
 *   - No-op-on-save-when-no-changes guard for whitelist / RPC enabled
 *     (alpha.20).
 *   - CJK IME isComposing guard on the chip Enter handler (batch 18).
 *   - Multi-value paste handler (batch 18).
 *   - Detect-now writes inline mono result next to the button (not a save).
 *   - Empty-on-manual validation block on _saveNetwork (batch 85).
 *
 * Lifecycle: same shape as alpha.27 — constructor builds shell, mount()
 * attaches + refreshes, destroy() detaches + flips _destroyed.
 */

(function (root) {
    'use strict';

    // IPv4 / IPv6 / CIDR validation — server has the authoritative joi
    // schema, this is for inline UX feedback only.
    //
    // 0.2.0-beta.3.7 — phase-04 mock's whitelist help copy says "IPv4
    // or IPv6". Pre-beta.3.7 the regex only accepted IPv4 + optional
    // /0–/32 prefix; operators trying to add an IPv6 address (e.g.
    // `2001:db8::1` or `fe80::/64`) saw the validation flash red even
    // though the backend would have accepted the entry. The IPv4 path
    // stays unchanged; the IPv6 alternative is a deliberately permissive
    // match (full address, ::-compressed, and optional /0–128 prefix)
    // — strict RFC validation belongs on the backend joi schema, this
    // is just to keep obviously-malformed input out of the chip-input.
    var IPV4_OR_CIDR = '(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\\/(?:[0-9]|[12][0-9]|3[0-2]))?';
    var IPV6_OR_CIDR = '(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}'    // 8 full groups
        + '|(?:[0-9A-Fa-f]{1,4}:){1,7}:'                              // leading groups + ::
        + '|(?:[0-9A-Fa-f]{1,4}:){1,6}(?::[0-9A-Fa-f]{1,4})'          // 1-6 groups :: 1 group
        + '|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}'
        + '|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}'
        + '|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}'
        + '|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}'
        + '|[0-9A-Fa-f]{1,4}:(?:(?::[0-9A-Fa-f]{1,4}){1,6})'
        + '|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:)';
    var IP_OR_CIDR_RE = new RegExp(
        '^(?:'
        + IPV4_OR_CIDR
        + '|(?:' + IPV6_OR_CIDR + ')(?:\\/(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?'
        + ')$'
    );

    function SettingsTab(opts) {
        if (!opts || !opts.api || !opts.notifications) {
            throw new TypeError('SettingsTab: { api, notifications } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.root = document.createElement('section');
        this.root.className = 'enm-settings-wrap';
        this._cfg = null;
        this._creds = null;
        this._destroyed = false;
        this._activeKey = 'network';
        this._sections = {};
        this._navItems = {};
        this._pills = {};
        this._renderShell();
    }

    SettingsTab.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        return this;
    };

    SettingsTab.prototype.destroy = function () {
        this._destroyed = true;
        // BP-E audit fix — tear down the chip-input's internal flash-
        // invalid timer so a 900ms-late border-reset can't fire on a
        // detached input after the pane unmounts (e.g. operator clicked
        // Save then immediately switched tabs).
        if (this._adv && this._adv.whiteIp
            && typeof this._adv.whiteIp.destroy === 'function') {
            try { this._adv.whiteIp.destroy(); } catch (_) { /* idempotent */ }
        }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /**
     * @private
     * Fetch /config + /config/rpc/credentials/mainchain in parallel so the
     * Advanced section's whitelist + RPC user populate on first paint.
     * Both endpoints are owner-gated; 401s are suppressed because the boot
     * path drives re-auth.
     */
    /**
     * @param {string} [scope]  'network' / 'advanced' / 'general' to
     *   re-hydrate only that section. Omit to re-hydrate all three.
     *
     * 0.2.0-beta.3.9 — scoped refresh. Pre-beta.3.9, the post-save
     * .then() called refresh() (no scope) which wiped pending edits in
     * the two un-saved sections. Operator now keeps their work-in-
     * progress across saves.
     */
    SettingsTab.prototype.refresh = function (scope) {
        var self = this;
        this.api.get('/config', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            self._cfg = data && data.config;
            self._fillForm(scope);
            // beta.3.18 — clean every section the refresh touched.
            // Without `scope` we clean every section after a full
            // /config reload (initial mount or external refresh).
            SECTION_KEYS.forEach(function (k) {
                if (!scope || scope === k) { self._markClean(k); }
            });
        }).catch(function (err) {
            if (self._destroyed) { return; }
            if (err && err.status === 401) { return; }
            self.notifications.show({
                id: 'settings-config-load-fail',
                severity: 'warning',
                title: 'Failed to load config',
                body: err.message || String(err),
            });
        });
        this._loadCreds();
    };

    /**
     * @private
     * Shell: nav (wide) + pills (narrow/compact, hidden by CSS on wide) +
     * content host. All three sections built up-front; only the active one
     * is visible. Pane switching just toggles [hidden] on the section-cards
     * and the .active class on the nav/pill items.
     */
    SettingsTab.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        var self = this;

        // Nav rail (column 1 on wide). role=tablist for AT.
        this._navEl = document.createElement('aside');
        this._navEl.className = 'enm-settings-nav';
        this._navEl.setAttribute('role', 'tablist');
        this._navEl.setAttribute('aria-label', 'Settings sections');

        var navHead = document.createElement('div');
        navHead.className = 'enm-settings-nav-head';
        navHead.textContent = t('settings.nav_label_config') || 'Configuration';
        this._navEl.appendChild(navHead);

        // Pills (alt nav for narrow/compact). Same role pattern. Hidden by
        // CSS on wide via .enm-app[data-app-size] not being set.
        this._pillsEl = document.createElement('div');
        this._pillsEl.className = 'enm-settings-pills';
        this._pillsEl.setAttribute('role', 'tablist');
        this._pillsEl.setAttribute('aria-label', 'Settings sections');

        // Content host (column 2).
        this._contentEl = document.createElement('div');
        this._contentEl.className = 'enm-settings-content';

        // beta.3.18 — Phase 1 IA reshape. Five task-oriented sections in
        // the order an operator opens them. The schema-dump (Network /
        // Mainchain Advanced / General) is gone; each section now groups
        // by what the operator is trying to DO. The previous knobs are
        // redistributed:
        //   Access   ← (NEW) RPC whitelist (was Advanced) + RPC creds collapsed
        //   Security ← anti-snipe (was General) + healing toggle (was General) +
        //              critical-ack (was General), with explainer copy
        //   Network  ← IP detect (unchanged)
        //   Storage  ← audit retention (was General)
        //   Advanced ← (warning banner) + log level / memory / archive
        //              (always visible per operator option (2b), with
        //              "don't change unless you know why" banner).
        var nav = [
            { key: 'access',   glyph: '⇆', label: t('settings.heading_access'),   build: this._buildAccessSection },
            { key: 'security', glyph: '◈', label: t('settings.heading_security'), build: this._buildSecuritySection },
            { key: 'network',  glyph: '⇄', label: t('settings.heading_network'),  build: this._buildNetworkSection },
            { key: 'storage',  glyph: '◳', label: t('settings.heading_storage'),  build: this._buildStorageSection },
            { key: 'advanced', glyph: '⚙', label: t('settings.heading_advanced'), build: this._buildAdvancedSection },
        ];
        nav.forEach(function (item) {
            // Nav item (wide rail).
            var navBtn = document.createElement('button');
            navBtn.type = 'button';
            navBtn.className = 'enm-settings-nav-item';
            navBtn.setAttribute('role', 'tab');
            navBtn.dataset.key = item.key;
            var navGlyph = document.createElement('span');
            navGlyph.className = 'enm-settings-nav-glyph';
            navGlyph.setAttribute('aria-hidden', 'true');
            navGlyph.textContent = item.glyph;
            navBtn.appendChild(navGlyph);
            navBtn.appendChild(document.createTextNode(item.label));
            navBtn.addEventListener('click', function () { self._activate(item.key); });
            self._navEl.appendChild(navBtn);
            self._navItems[item.key] = navBtn;

            // Pill (narrow/compact alt).
            var pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'enm-settings-pill';
            pill.setAttribute('role', 'tab');
            pill.dataset.key = item.key;
            pill.textContent = item.glyph + ' ' + item.label;
            pill.addEventListener('click', function () { self._activate(item.key); });
            self._pillsEl.appendChild(pill);
            self._pills[item.key] = pill;

            // Section card.
            var section = item.build.call(self, t);
            section.setAttribute('role', 'tabpanel');
            section.setAttribute('aria-labelledby', 'enm-section-h-' + item.key);
            self._contentEl.appendChild(section);
            self._sections[item.key] = section;
        });

        this.root.appendChild(this._navEl);
        this.root.appendChild(this._pillsEl);
        this.root.appendChild(this._contentEl);

        // 0.2.0-beta.3.8 — wire delegated change/input listeners so each
        // section's "Restart required" / "No restart needed" tag flips
        // to "Unsaved changes" when its body has dirty form state.
        // Cleared by _markClean() on successful save and on refresh()
        // (hydrating from /config is the canonical clean state).
        this._wireDirtyTracking();

        this._activate(this._activeKey);
    };

    /**
     * 0.2.0-beta.3.8 — attach input/change listeners to each section's
     * body element so changes anywhere inside the section's form rows
     * flip its tag to "Unsaved changes". Single listener per section
     * via event delegation; each fires `setDirty(true)` exactly once
     * per dirty transition, then re-checks against a "snapshot of clean"
     * is intentionally NOT done — once dirty, the tag stays warning
     * until Save (or Revert via refresh()) clears it. Operators can
     * be on the safe side and Save explicitly; we don't try to detect
     * "operator changed X then changed X back" as clean.
     *
     * @private
     */
    // beta.3.18 — section keys map 1:1 to instance properties. Cleaner
    // than the alphabet-soup `key === 'advanced' ? 'adv' : ...` chain
    // and easier to extend when more sections land in later phases.
    var SECTION_KEYS = ['access', 'security', 'network', 'storage', 'advanced'];
    SettingsTab.prototype._sectionRef = function (key) {
        return this['_' + key];
    };

    SettingsTab.prototype._wireDirtyTracking = function () {
        var self = this;
        var handler = function (sectionKey) {
            return function () {
                var sec = self._sectionRef(sectionKey);
                if (sec && typeof sec.setDirty === 'function') {
                    sec.setDirty(true);
                }
            };
        };
        // Attach to each section's BODY el so events bubble up from
        // any contained form control (input, select, button, toggle).
        SECTION_KEYS.forEach(function (key) {
            var sec = self._sectionRef(key);
            if (!sec || !sec.body) { return; }
            sec.body.addEventListener('input',  handler(key));
            sec.body.addEventListener('change', handler(key));
            // Buttons inside the body (toggle, segmented) emit `click`
            // when state changes; also count those.
            sec.body.addEventListener('click',  handler(key));
        });
    };

    /**
     * 0.2.0-beta.3.8 — flip a section back to clean. Called from
     * refresh() after /config hydration and from each section's Save
     * .then() after a successful PUT.
     *
     * @private
     * @param {string} key  one of SECTION_KEYS (access/security/network/storage/advanced)
     */
    SettingsTab.prototype._markClean = function (key) {
        var sec = this._sectionRef(key);
        if (sec && typeof sec.setDirty === 'function') {
            sec.setDirty(false);
        }
    };

    /**
     * @private
     * Activate a section: toggle [hidden] on the other section-cards,
     * mirror .active class + aria-selected onto nav + pill.
     */
    SettingsTab.prototype._activate = function (key) {
        if (!this._sections[key]) { return; }
        this._activeKey = key;
        Object.keys(this._sections).forEach(function (k) {
            this._sections[k].hidden = (k !== key);
        }, this);
        Object.keys(this._navItems).forEach(function (k) {
            var active = (k === key);
            this._navItems[k].classList.toggle('active', active);
            this._navItems[k].setAttribute('aria-selected', active ? 'true' : 'false');
            this._pills[k].classList.toggle('active', active);
            this._pills[k].setAttribute('aria-selected', active ? 'true' : 'false');
        }, this);
    };

    // -----------------------------------------------------------------
    // Section: Network
    // -----------------------------------------------------------------
    /** @private */
    SettingsTab.prototype._buildNetworkSection = function (t) {
        var self = this;
        var sec = makeSection({
            id: 'network',
            icon: '⇄',
            title: t('settings.heading_network'),
            help: 'Mainchain DPoS IP announcement. Writes ',
            helpCodes: ['chains.mainchain.dpos.ipAddressMode', 'ipAddressManual'],
            tag: { kind: 'warn', label: 'Restart required' },
        });
        this._network = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
            setDirty: sec.setDirty,
        };

        // Row 1 — IP mode segmented control.
        var seg = makeSeg({
            options: [
                { value: 'auto',   label: 'Auto-detect' },
                { value: 'manual', label: 'Manual' },
            ],
            value: 'auto',
            onChange: function (v) { self._onNetworkModeChange(v); },
        });
        this._network.seg = seg;
        sec.body.appendChild(makeFormRow({
            label: 'External IP detection',
            help: 'Auto = ENM queries ',
            helpCodes: ['GET /system/extip'],
            helpSuffix: ' on each restart. Manual = pin a static address.',
            control: seg.el,
        }));

        // Row 2 — Manual IP input (disabled when mode === auto).
        this._network.manualInput = makeInput({
            type: 'text',
            placeholder: 'e.g. 203.0.113.14',
            mono: true,
            ariaLabel: 'Manual IP address',
            describedById: 'enm-net-status',
        });
        this._network.manualInput.setAttribute('autocomplete', 'off');
        this._network.manualInput.setAttribute('spellcheck', 'false');
        this._network.manualInput.setAttribute('autocapitalize', 'off');
        this._network.manualInput.setAttribute('autocorrect', 'off');
        this._network.manualRow = makeFormRow({
            label: 'Manual IP address',
            help: 'Enabled only when mode is Manual. IPv4 or IPv6.',
            control: this._network.manualInput,
            disabled: true,
        });
        sec.body.appendChild(this._network.manualRow);

        // Row 3 — Detect now button (no save).
        var detectBtn = document.createElement('button');
        detectBtn.type = 'button';
        detectBtn.className = 'enm-btn';
        detectBtn.textContent = t('settings.ip_detect_btn');
        this._network.detectBtn = detectBtn;
        this._network.detectResult = document.createElement('span');
        this._network.detectResult.className = 'enm-detect-result';
        var detectGroup = document.createElement('div');
        detectGroup.className = 'enm-form-inline';
        detectGroup.appendChild(detectBtn);
        detectGroup.appendChild(this._network.detectResult);
        detectBtn.addEventListener('click', function () { self._detectIp(); });
        sec.body.appendChild(makeFormRow({
            label: 'Detect now',
            help: 'One-shot probe. Shows the result inline without saving.',
            control: detectGroup,
        }));

        // Foot status node — also gets the id described by the manual
        // input so AT links error text to the offending field.
        sec.statusEl.id = 'enm-net-status';

        sec.saveBtn.addEventListener('click', function () { self._saveNetwork(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh('network'); });

        return sec.card;
    };

    /** @private — Manual IP row is gated on seg state. */
    SettingsTab.prototype._onNetworkModeChange = function (mode) {
        // 0.2.0-beta.3.4 hotfix — belt-and-suspenders guard. makeSeg's
        // initial paint no longer fires onChange (post-beta.3.4), but
        // if a future refactor reintroduces the racy pattern this
        // guard surfaces it as a no-op rather than letting the
        // SettingsTab constructor throw mid-build and leave a blank
        // pane.
        if (!this._network || !this._network.manualRow) { return; }
        var disabled = (mode !== 'manual');
        this._network.manualRow.setAttribute('data-disabled', disabled ? 'true' : 'false');
    };

    /** @private */
    SettingsTab.prototype._detectIp = function () {
        var t = root.enmTOrFallback;
        var self = this;
        this._network.detectResult.textContent = t('settings.ip_detecting');
        this._network.detectResult.classList.remove('ok', 'err');
        this.api.get('/system/extip', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            if (data && data.ok && data.ip) {
                self._network.detectResult.textContent =
                    t('settings.ip_detected', { ip: data.ip });
                self._network.detectResult.classList.add('ok');
            } else {
                var reason = (data && data.reason) || t('settings.ip_detect_unknown');
                self._network.detectResult.textContent =
                    t('settings.ip_detect_failed', { reason: reason });
                self._network.detectResult.classList.add('err');
            }
        }).catch(function (err) {
            if (self._destroyed) { return; }
            if (err && err.status === 401) { return; }
            self._network.detectResult.textContent = t('settings.ip_detect_failed', {
                reason: err.message || String(err),
            });
            self._network.detectResult.classList.add('err');
        });
    };

    /** @private */
    SettingsTab.prototype._saveNetwork = function () {
        var t = root.enmTOrFallback;
        var self = this;
        // Clear stale aria-invalid (batch 85).
        this._network.manualInput.removeAttribute('aria-invalid');

        var mode = this._network.seg.getValue();
        var manualValue = this._network.manualInput.value.trim();

        // Manual mode requires a value — block the PUT inline.
        if (mode === 'manual' && manualValue.length === 0) {
            setStatus(this._network.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_ip_required') }));
            this._network.manualInput.setAttribute('aria-invalid', 'true');
            try { this._network.manualInput.focus({ preventScroll: true }); }
            catch (e) { this._network.manualInput.focus(); }
            return;
        }

        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._network.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._network.saveBtn, savingLabel, function () {
            return self.api.put('/config/network',
                { mode: mode, manualValue: manualValue })
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._network.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self.refresh('network');
                    // beta.3.18 — Network change needs a chain restart
                    // before peers see the new IP. Prompt the operator.
                    self._promptRestartIfNeeded('network');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._network.statusEl, 'error',
                        t('settings.save_failed', { error: err.message || String(err) }));
                });
        });
    };

    // -----------------------------------------------------------------
    // Section: Mainchain Advanced
    // -----------------------------------------------------------------
    /** @private */
    SettingsTab.prototype._buildAdvancedSection = function (t) {
        var self = this;
        var sec = makeSection({
            id: 'advanced',
            icon: '⚙',
            title: t('settings.heading_advanced'),
            help: t('settings.advanced_intro'),
            tag: { kind: 'warn', label: 'Restart required' },
        });
        this._advanced = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
            setDirty: sec.setDirty,
        };
        // beta.3.18 backward-compat alias — _saveAdvanced and _fillAdvanced
        // refer to this._adv historically. Both reshaping paths now hit
        // this._advanced; keep the alias so a stray reference doesn't
        // throw mid-refresh.
        this._adv = this._advanced;

        // beta.3.18 — operator chose option (2b): the dangerous knobs
        // are always visible at the bottom of Settings, but only behind
        // an explicit "don't touch this" warning banner. This makes
        // them discoverable without making them tempting.
        var warn = document.createElement('div');
        warn.className = 'enm-advanced-warning';
        var warnIcon = document.createElement('div');
        warnIcon.className = 'enm-advanced-warning-icon';
        warnIcon.setAttribute('aria-hidden', 'true');
        warnIcon.textContent = '⚠';
        var warnBody = document.createElement('div');
        warnBody.className = 'enm-advanced-warning-body';
        var warnTitle = document.createElement('div');
        warnTitle.className = 'enm-advanced-warning-title';
        warnTitle.textContent = t('settings.advanced_warn_title');
        var warnText = document.createElement('div');
        warnText.className = 'enm-advanced-warning-text';
        warnText.textContent = t('settings.advanced_warn_body');
        warnBody.appendChild(warnTitle);
        warnBody.appendChild(warnText);
        warn.appendChild(warnIcon);
        warn.appendChild(warnBody);
        sec.body.appendChild(warn);

        // Row 1 — Log level.
        this._advanced.logLevel = makeSelectWrap({
            options: [
                { value: 'debug', label: 'debug' },
                { value: 'info',  label: 'info' },
                { value: 'warn',  label: 'warn' },
                { value: 'error', label: 'error' },
            ],
            value: 'info',
        });
        sec.body.appendChild(makeFormRow({
            label: 'Log level',
            help: 'Mapped to ela.conf ',
            helpCodes: ['PrintLevel'],
            helpSuffix: ' by ElaMainChainAdapter. Default (info) is right for almost everyone.',
            control: this._advanced.logLevel.el,
        }));

        // Row 2 — Archive mode toggle.
        this._advanced.archiveMode = makeToggleRow({
            initial: false,
            getLabel: function (on) {
                return on
                    ? { title: 'On · keep full block history',
                        sub: 'Disk-heavy. Recommended only if an explorer needs it.' }
                    : { title: 'Off · prune historical blocks',
                        sub: 'Recommended for most operators.' };
            },
        });
        sec.body.appendChild(makeFormRow({
            label: 'Archive mode',
            help: 'Keeps full historical block data instead of pruning. Disk-heavy.',
            control: this._advanced.archiveMode.el,
        }));

        // Row 3 — Memory limit with MB suffix.
        this._advanced.memory = makeInputSuffix({
            type: 'number',
            value: '4096',
            min: 512,
            max: 32768,
            step: 1,
            mono: true,
            suffix: 'MB',
            ariaLabel: 'Memory limit in megabytes',
            describedById: 'enm-adv-status',
        });
        sec.body.appendChild(makeFormRow({
            label: 'Memory limit',
            help: 'Per-process cap. Range 512 – 32,768 MB. Default 4,096.',
            control: this._advanced.memory.el,
        }));

        sec.statusEl.id = 'enm-adv-status';

        sec.saveBtn.addEventListener('click', function () { self._saveAdvanced(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh('advanced'); });

        return sec.card;
    };

    // -----------------------------------------------------------------
    // Section: Access (beta.3.18 — NEW)
    //   RPC whitelist + RPC creds (user/password). All three move out
    //   of the old "Mainchain Advanced" since they're access-control
    //   concerns, not runtime tuning. Saves via PUT /config/mainchain
    //   (same backend endpoint; partial body is supported per the
    //   alpha.28 _saveRpcEnabled dead-code comment).
    // -----------------------------------------------------------------
    /** @private */
    SettingsTab.prototype._buildAccessSection = function (t) {
        var self = this;
        var sec = makeSection({
            id: 'access',
            icon: '⇆',
            title: t('settings.heading_access'),
            help: t('settings.access_intro'),
            tag: { kind: 'warn', label: 'Restart required' },
        });
        this._access = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
            setDirty: sec.setDirty,
        };

        // Row 1 — IP whitelist (chip input with locked loopback). This
        // is the one knob the operator told us actually mattered, so
        // it's the first thing in the first section.
        this._access.whiteIp = makeChipInput({
            locked: ['127.0.0.1'],
            placeholder: t('settings.rpc_white_add_placeholder'),
            ariaLabel: 'Add IP address or CIDR to whitelist',
        });
        sec.body.appendChild(makeFormRow({
            label: 'Allowed IPs',
            help: 'Anyone on these IPs (or CIDR ranges) can hit the JSON-RPC. 127.0.0.1 stays locked so ENM doesn’t lose access to its own RPC. Whitelisted IPs still need the credentials below to authenticate.',
            control: this._access.whiteIp.el,
        }));

        // Row 2 — RPC user.
        this._access.rpcUser = makeInput({
            type: 'text',
            value: 'ela',
            mono: true,
            ariaLabel: 'RPC user',
            describedById: 'enm-access-status',
        });
        this._access.rpcUser.setAttribute('pattern', '[A-Za-z0-9]+');
        this._access.rpcUser.setAttribute('autocomplete', 'username');
        this._access.rpcUser.setAttribute('spellcheck', 'false');
        this._access.rpcUser.setAttribute('autocapitalize', 'off');
        this._access.rpcUser.title = t('settings.rpc_user_tooltip');
        sec.body.appendChild(makeFormRow({
            label: 'RPC user',
            help: 'Basic-Auth principal. Default (ela) is fine unless you have a reason to change it.',
            control: this._access.rpcUser,
        }));

        // Row 3 — RPC password (secret field with show/hide).
        this._access.rpcPasswordField = makeSecretField({
            ariaLabel: 'RPC password',
            placeholder: t('settings.rpc_password_placeholder_set'),
        });
        sec.body.appendChild(makeFormRow({
            label: 'RPC password',
            help: 'Stored encrypted on disk. Leave blank to keep the current one; type a new value to rotate.',
            control: this._access.rpcPasswordField.el,
        }));

        sec.statusEl.id = 'enm-access-status';

        sec.saveBtn.addEventListener('click', function () { self._saveAccess(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh('access'); });

        return sec.card;
    };

    // -----------------------------------------------------------------
    // Section: Security (beta.3.18 — NEW)
    //   Anti-snipe password (was in General) + healing toggle (was in
    //   General) + critical-ack (was in General). All recontextualized
    //   with "what this protects" callouts. Two backend endpoints:
    //   POST /config/anti-snipe-password (its own button row) and
    //   PUT /config/general (criticalRequiresAck + autoExecuteSafe).
    // -----------------------------------------------------------------
    /** @private */
    SettingsTab.prototype._buildSecuritySection = function (t) {
        var self = this;
        var sec = makeSection({
            id: 'security',
            icon: '◈',
            title: t('settings.heading_security'),
            help: t('settings.security_intro'),
            tag: { kind: 'success', label: 'No restart needed' },
        });
        this._security = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
            setDirty: sec.setDirty,
        };

        // Row 1 — Anti-snipe password (set / clear) with a "what this
        // protects" callout above it so operators understand WHY the
        // password is worth setting.
        var antiSnipeCallout = document.createElement('div');
        antiSnipeCallout.className = 'enm-security-callout';
        var antiSnipeCalloutHead = document.createElement('div');
        antiSnipeCalloutHead.className = 'enm-security-callout-head';
        antiSnipeCalloutHead.textContent = t('settings.anti_snipe_what');
        var antiSnipeCalloutBody = document.createElement('div');
        antiSnipeCalloutBody.className = 'enm-security-callout-body';
        antiSnipeCalloutBody.textContent = t('settings.anti_snipe_what_body');
        antiSnipeCallout.appendChild(antiSnipeCalloutHead);
        antiSnipeCallout.appendChild(antiSnipeCalloutBody);
        sec.body.appendChild(antiSnipeCallout);

        this._security.antiSnipeField = makeSecretField({
            ariaLabel: 'Anti-snipe password',
            placeholder: t('settings.anti_snipe_placeholder_unset'),
        });
        sec.body.appendChild(makeFormRow({
            label: 'Anti-snipe password',
            help: 'Optional. When set, high-stakes healing actions need this password to execute. Leave blank when typing a NEW password to keep the current one.',
            control: this._security.antiSnipeField.el,
        }));
        // Inline button row for Set + Clear (independent of the
        // section's main Save button — backend uses a dedicated
        // POST /config/anti-snipe-password endpoint).
        var antiSnipeActions = document.createElement('div');
        antiSnipeActions.className = 'enm-form-inline';
        this._security.antiSnipeSaveBtn = document.createElement('button');
        this._security.antiSnipeSaveBtn.type = 'button';
        this._security.antiSnipeSaveBtn.className = 'enm-btn';
        this._security.antiSnipeSaveBtn.textContent = t('settings.anti_snipe_set_btn');
        this._security.antiSnipeClearBtn = document.createElement('button');
        this._security.antiSnipeClearBtn.type = 'button';
        this._security.antiSnipeClearBtn.className = 'enm-btn enm-btn-danger';
        this._security.antiSnipeClearBtn.textContent = t('settings.anti_snipe_clear_btn');
        this._security.antiSnipeClearBtn.hidden = true;
        this._security.antiSnipeStatus = document.createElement('span');
        this._security.antiSnipeStatus.className = 'enm-detect-result';
        antiSnipeActions.appendChild(this._security.antiSnipeSaveBtn);
        antiSnipeActions.appendChild(this._security.antiSnipeClearBtn);
        antiSnipeActions.appendChild(this._security.antiSnipeStatus);
        sec.body.appendChild(makeFormRow({
            label: 'Apply password',
            help: 'Saves immediately on click — bypasses the section Save.',
            control: antiSnipeActions,
        }));
        this._security.antiSnipeSaveBtn.addEventListener('click', function () { self._saveAntiSnipe(); });
        this._security.antiSnipeClearBtn.addEventListener('click', function () { self._clearAntiSnipe(); });

        // Row 2 — Auto-execute safe healing (with a callout).
        var healingCallout = document.createElement('div');
        healingCallout.className = 'enm-security-callout';
        var healingHead = document.createElement('div');
        healingHead.className = 'enm-security-callout-head';
        healingHead.textContent = t('settings.healing_what');
        var healingBody = document.createElement('div');
        healingBody.className = 'enm-security-callout-body';
        healingBody.textContent = t('settings.healing_what_body');
        healingCallout.appendChild(healingHead);
        healingCallout.appendChild(healingBody);
        sec.body.appendChild(healingCallout);

        this._security.autoSafe = makeToggleRow({
            initial: true,
            getLabel: function (on) {
                return on
                    ? { title: 'On · auto-execute safe healing',
                        sub: 'Restart-on-crash, rotate logs, reload config — handled automatically.' }
                    : { title: 'Off · every action waits for the operator',
                        sub: 'Even AUTOMATED-SAFE playbooks need a manual confirm.' };
            },
        });
        sec.body.appendChild(makeFormRow({
            label: 'Auto-execute safe healing',
            help: 'If a healing playbook is tagged safe, ENM runs it without asking. Unsafe playbooks always wait for the operator.',
            control: this._security.autoSafe.el,
        }));

        // Row 3 — Critical alerts require ack (with a callout).
        var ackCallout = document.createElement('div');
        ackCallout.className = 'enm-security-callout';
        var ackHead = document.createElement('div');
        ackHead.className = 'enm-security-callout-head';
        ackHead.textContent = t('settings.critical_ack_what');
        var ackBody = document.createElement('div');
        ackBody.className = 'enm-security-callout-body';
        ackBody.textContent = t('settings.critical_ack_what_body');
        ackCallout.appendChild(ackHead);
        ackCallout.appendChild(ackBody);
        sec.body.appendChild(ackCallout);

        this._security.criticalAck = makeToggleRow({
            initial: true,
            getLabel: function (on) {
                return on
                    ? { title: 'On · require explicit ack',
                        sub: 'Recommended. Keeps slashing-risk alerts sticky.' }
                    : { title: 'Off · auto-dismiss after view',
                        sub: 'Critical alerts stop being sticky.' };
            },
        });
        sec.body.appendChild(makeFormRow({
            label: 'Critical alerts require ack',
            help: 'Critical events stay visible in the alerts strip until you explicitly dismiss them. Off = auto-dismiss after view.',
            control: this._security.criticalAck.el,
        }));

        sec.statusEl.id = 'enm-security-status';

        sec.saveBtn.addEventListener('click', function () { self._saveSecurity(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh('security'); });

        return sec.card;
    };

    // -----------------------------------------------------------------
    // Section: Storage (beta.3.18 — NEW)
    //   Audit retention (was in General). Future Phase 3 will add log
    //   retention + keystore backup. Saves via PUT /config/general.
    // -----------------------------------------------------------------
    /** @private */
    SettingsTab.prototype._buildStorageSection = function (t) {
        var self = this;
        var sec = makeSection({
            id: 'storage',
            icon: '◳',
            title: t('settings.heading_storage'),
            help: t('settings.storage_intro'),
            tag: { kind: 'success', label: 'No restart needed' },
        });
        this._storage = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
            setDirty: sec.setDirty,
        };

        this._storage.auditRetention = makeInputSuffix({
            type: 'number',
            value: '365',
            min: 0,
            max: 3650,
            step: 1,
            mono: true,
            suffix: 'days',
            ariaLabel: 'Audit retention in days',
            describedById: 'enm-storage-status',
        });
        sec.body.appendChild(makeFormRow({
            label: 'Audit retention',
            help: 'How long ENM keeps audit-log entries. ',
            helpCodes: ['0'],
            helpSuffix: ' = forever. Range 0 – 3,650 days.',
            control: this._storage.auditRetention.el,
        }));

        sec.statusEl.id = 'enm-storage-status';

        sec.saveBtn.addEventListener('click', function () { self._saveStorage(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh('storage'); });

        return sec.card;
    };

    /**
     * @private
     * Fetch /config/rpc/credentials/mainchain to populate the whitelist
     * chips, RPC user, and the password-placeholder hint. The same
     * endpoint also returns URLs + the rpc enabled flag — those parts of
     * the response are intentionally ignored by Beta 3 (the reveal panel
     * is dropped per phase-04 mock). _saveRpcEnabled remains below as
     * dead-code documentation of the partial-PUT shape.
     */
    SettingsTab.prototype._loadCreds = function () {
        var self = this;
        this.api.get('/config/rpc/credentials/mainchain', { skipCache: true })
            .then(function (data) {
                if (self._destroyed) { return; }
                self._creds = data || null;
                self._fillCreds();
            })
            .catch(function (err) {
                if (self._destroyed) { return; }
                if (err && err.status === 401) { return; }
                // Non-fatal — _fillForm's /config response still gives us
                // enough to render. Whitelist will fall back to the locked
                // loopback default.
            });
    };

    /** beta.3.18 — _fillCreds rebased onto the Access section. */
    SettingsTab.prototype._fillCreds = function () {
        if (!this._access || !this._creds) { return; }
        var d = this._creds;
        if (Array.isArray(d.whiteIPList)) {
            this._access.whiteIp.setValue(d.whiteIPList);
        }
        if (typeof d.user === 'string' && d.user.length > 0
            && (!this._access.rpcUser.value || this._access.rpcUser.value === 'ela')) {
            this._access.rpcUser.value = d.user;
        }
    };

    /** @private */
    SettingsTab.prototype._saveAdvanced = function () {
        var t = root.enmTOrFallback;
        var self = this;
        // Clear any stale aria-invalid hints from a previous failed save
        // (batch 30).
        this._advanced.memory.input.removeAttribute('aria-invalid');

        // Inline client-side validation parity with the joi schema, so
        // the operator sees the problem before the round-trip.
        var memMb = parseInt(this._advanced.memory.input.value, 10);
        if (!Number.isInteger(memMb) || memMb < 512 || memMb > 32768) {
            setStatus(this._advanced.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_memory_range') }));
            this._advanced.memory.input.setAttribute('aria-invalid', 'true');
            try { this._advanced.memory.input.focus({ preventScroll: true }); }
            catch (e) { this._advanced.memory.input.focus(); }
            return;
        }

        // beta.3.18 — Advanced now ONLY owns log/memory/archive. RPC
        // user/password/whitelist moved to the Access section + are
        // saved via _saveAccess (also PUT /config/mainchain; partial
        // body, backend merges).
        var body = {
            logLevel: this._advanced.logLevel.getValue(),
            archiveMode: this._advanced.archiveMode.getValue(),
            memoryLimitMb: memMb,
        };

        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._advanced.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._advanced.saveBtn, savingLabel, function () {
            return self.api.put('/config/mainchain', body)
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._advanced.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self.refresh('advanced');
                    self._promptRestartIfNeeded('advanced');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._advanced.statusEl, 'error',
                        t('settings.save_failed', { error: err.message || String(err) }));
                });
        });
    };

    /**
     * beta.3.18 — save Access section (RPC user / password / whitelist).
     * Same backend endpoint as _saveAdvanced (PUT /config/mainchain) but
     * carries a different subset of the body. Partial PUT is supported
     * by the backend route.
     * @private
     */
    SettingsTab.prototype._saveAccess = function () {
        var t = root.enmTOrFallback;
        var self = this;
        this._access.rpcUser.removeAttribute('aria-invalid');

        var rpcUser = this._access.rpcUser.value.trim();
        if (rpcUser.length === 0 || !/^[A-Za-z0-9]+$/.test(rpcUser)) {
            setStatus(this._access.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_rpc_user') }));
            this._access.rpcUser.setAttribute('aria-invalid', 'true');
            try { this._access.rpcUser.focus({ preventScroll: true }); }
            catch (e) { this._access.rpcUser.focus(); }
            return;
        }

        var body = {
            rpcUser: rpcUser,
            whiteIPList: this._access.whiteIp.getValue(),
        };
        // RPC password is only sent if the operator typed something so
        // they can edit other Access knobs without re-typing it
        // (carried over from alpha.28 _saveAdvanced behavior).
        var pw = this._access.rpcPasswordField.input.value;
        if (pw && pw.length > 0) { body.rpcPassword = pw; }

        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._access.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._access.saveBtn, savingLabel, function () {
            return self.api.put('/config/mainchain', body)
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._access.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self._access.rpcPasswordField.input.value = '';
                    self.refresh('access');
                    self._promptRestartIfNeeded('access');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._access.statusEl, 'error',
                        t('settings.save_failed', { error: err.message || String(err) }));
                });
        });
    };

    // Beta 3 — phase-04 mock dropped the RPC reveal-only panel and the
    // Danger-Zone surface. The API methods stay below as dead code so a
    // future surface can wire them up without rediscovering the partial-
    // PUT shapes:
    //
    //   PUT /config/mainchain { rpcEnabled: bool }     ← master toggle
    //   PUT /config/mainchain { whiteIPList: string[] } ← partial whitelist
    //   GET /config/rpc/credentials/mainchain          ← URLs + creds
    //   DELETE /api/installed-apps/<name>?purge=true   ← danger-zone wipe
    //
    // The consolidated _saveAdvanced above PUTs every mainchain field in
    // one shot, so rpcEnabled + whiteIPList no longer need their own
    // dedicated save buttons; the data lives in the same /config/mainchain
    // body. _loadCreds above still hits the GET endpoint to hydrate the
    // whitelist chips.
    //
    // SettingsTab.prototype._saveRpcEnabled = function (enabled) {
    //     return this.api.put('/config/mainchain', { rpcEnabled: enabled });
    // };
    //
    // SettingsTab.prototype._saveWhitelist = function () {
    //     var list = this._adv.whiteIp.getValue();
    //     return this.api.put('/config/mainchain', { whiteIPList: list });
    // };
    //
    // SettingsTab.prototype._renderCredsPanel = function () {
    //     // Alpha.27 rendered .enm-rpc-creds-panel with URLs + creds +
    //     // RPC enable toggle. Beta 3 merges credentials into the Mainchain
    //     // Advanced section's form and drops the URL panel entirely.
    // };
    //
    // SettingsTab.prototype._doWipe = function () { /* see alpha.27 */ };
    // SettingsTab.prototype._handleWipeSuccess = function () { /* idem */ };
    // SettingsTab.prototype._handleWipeFailure = function () { /* idem */ };

    // beta.3.18 — _buildGeneralSection retired. Its rows redistributed:
    //   anti-snipe + healing toggle + critical-ack  → _buildSecuritySection
    //   audit retention                              → _buildStorageSection
    // The function body below is kept as DEAD CODE (never wired into the
    // nav array) for one release as audit-trail of the original copy;
    // remove on the next IA-touching phase.
    // eslint-disable-next-line no-unused-vars
    SettingsTab.prototype._buildGeneralSection_DEAD = function (t) {
        var self = this;
        var sec = makeSection({
            id: 'general',
            icon: '◉',
            title: t('settings.heading_general'),
            help: 'ENM-side preferences applied immediately, no ela restart. Writes ',
            helpCodes: ['global.{healing.autoExecuteSafe, notifications.criticalRequiresAck, audit.retentionDays}'],
            tag: { kind: 'success', label: 'No restart needed' },
        });
        this._gen = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
            setDirty: sec.setDirty,
        };

        // Row 1 — Auto-execute safe healing.
        this._gen.autoSafe = makeToggleRow({
            initial: true,
            getLabel: function (on) {
                return on
                    ? { title: 'On · auto-execute',
                        sub: 'Restart-on-crash, rotate logs, reload config.' }
                    : { title: 'Off · every action waits for the operator',
                        sub: 'Even AUTOMATED-SAFE playbooks need a manual confirm.' };
            },
        });
        sec.body.appendChild(makeFormRow({
            label: 'Auto-execute safe healing',
            help: 'If a healing playbook is tagged safe, ENM runs it without confirmation. Unsafe playbooks always wait for the operator.',
            control: this._gen.autoSafe.el,
        }));

        // Row 2 — Critical alerts require ack.
        this._gen.criticalAck = makeToggleRow({
            initial: true,
            getLabel: function (on) {
                return on
                    ? { title: 'On · require explicit ack',
                        sub: 'Recommended. Keeps slashing-risk alerts sticky.' }
                    : { title: 'Off · auto-dismiss after view',
                        sub: 'Critical alerts stop being sticky.' };
            },
        });
        sec.body.appendChild(makeFormRow({
            label: 'Critical alerts require ack',
            help: 'Critical events stay visible in the alerts strip until you explicitly dismiss them. Off = auto-dismiss after view.',
            control: this._gen.criticalAck.el,
        }));

        // Row 3 — Audit retention with days suffix.
        this._gen.auditRetention = makeInputSuffix({
            type: 'number',
            value: '365',
            min: 0,
            max: 3650,
            step: 1,
            mono: true,
            suffix: 'days',
            ariaLabel: 'Audit retention in days',
            describedById: 'enm-gen-status',
        });
        sec.body.appendChild(makeFormRow({
            label: 'Audit retention',
            help: 'How long ENM keeps audit-log entries. ',
            helpCodes: ['0'],
            helpSuffix: ' = forever. Range 0 – 3,650 days.',
            control: this._gen.auditRetention.el,
        }));

        // 0.2.0-beta.3.10 — Anti-snipe password row. Optional security
        // gate on healing proposals that set requireAntiSnipe=true. The
        // backend stores a scrypt hash (POST /config/anti-snipe-password);
        // frontend never sees the plaintext or hash, only a `set` boolean
        // surfaced by GET /config (cfg.global.antiSnipePasswordSet). The
        // input is its own form (own save + clear button) so the General
        // section's main Save flow isn't entangled with this security-
        // sensitive flow.
        this._gen.antiSnipeField = makeSecretField({
            ariaLabel: 'Anti-snipe password',
            placeholder: 'unset · type a new password to set',
        });
        var antiSnipeRow = makeFormRow({
            label: 'Anti-snipe password',
            help: 'Optional. When set, healing proposals tagged ',
            helpCodes: ['requireAntiSnipe'],
            helpSuffix: ' need this password to confirm. Defends against'
                + ' a leaked owner-token still being able to execute high-'
                + ' stakes actions. Leave blank when typing a NEW password'
                + ' to keep the current one (Clear button below to disable).',
            control: this._gen.antiSnipeField.el,
        });
        sec.body.appendChild(antiSnipeRow);
        // Inline row for the two anti-snipe buttons + status.
        var antiSnipeActions = document.createElement('div');
        antiSnipeActions.className = 'enm-form-inline';
        this._gen.antiSnipeSaveBtn = document.createElement('button');
        this._gen.antiSnipeSaveBtn.type = 'button';
        this._gen.antiSnipeSaveBtn.className = 'enm-btn';
        this._gen.antiSnipeSaveBtn.textContent = 'Set password';
        this._gen.antiSnipeClearBtn = document.createElement('button');
        this._gen.antiSnipeClearBtn.type = 'button';
        this._gen.antiSnipeClearBtn.className = 'enm-btn enm-btn-danger';
        this._gen.antiSnipeClearBtn.textContent = 'Clear';
        this._gen.antiSnipeClearBtn.hidden = true;  // shown only when SET
        this._gen.antiSnipeStatus = document.createElement('span');
        this._gen.antiSnipeStatus.className = 'enm-detect-result';
        antiSnipeActions.appendChild(this._gen.antiSnipeSaveBtn);
        antiSnipeActions.appendChild(this._gen.antiSnipeClearBtn);
        antiSnipeActions.appendChild(this._gen.antiSnipeStatus);
        sec.body.appendChild(makeFormRow({
            label: 'Apply',
            help: 'Saves immediately on click — bypasses the section Save.',
            control: antiSnipeActions,
        }));
        this._gen.antiSnipeSaveBtn.addEventListener('click', function () {
            self._saveAntiSnipe();
        });
        this._gen.antiSnipeClearBtn.addEventListener('click', function () {
            self._clearAntiSnipe();
        });

        sec.statusEl.id = 'enm-gen-status';

        sec.saveBtn.addEventListener('click', function () { self._saveGeneral(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh('general'); });

        return sec.card;
    };

    /**
     * beta.3.18 — POST a new anti-snipe password. Rebased onto
     * this._security.antiSnipeField from the Security section build.
     */
    SettingsTab.prototype._saveAntiSnipe = function () {
        var self = this;
        var t = root.enmTOrFallback;
        var s = this._security;
        var password = s.antiSnipeField.input.value;
        if (typeof password !== 'string' || password.length < 8) {
            s.antiSnipeStatus.textContent = t('settings.anti_snipe_min_length');
            s.antiSnipeStatus.classList.remove('ok');
            s.antiSnipeStatus.classList.add('err');
            try { s.antiSnipeField.input.focus({ preventScroll: true }); }
            catch (e) { s.antiSnipeField.input.focus(); }
            return;
        }
        s.antiSnipeStatus.textContent = t('common.saving') || 'Saving…';
        s.antiSnipeStatus.classList.remove('ok', 'err');
        return root.enmRunOnce(s.antiSnipeSaveBtn, t('common.saving') || 'Saving…', function () {
            return self.api.post('/config/anti-snipe-password', { password: password })
                .then(function () {
                    if (self._destroyed) { return; }
                    s.antiSnipeField.input.value = '';
                    s.antiSnipeStatus.textContent = t('settings.anti_snipe_saved');
                    s.antiSnipeStatus.classList.add('ok');
                    s.antiSnipeClearBtn.hidden = false;
                    s.antiSnipeField.input.placeholder = t('settings.anti_snipe_placeholder_set');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    s.antiSnipeStatus.textContent = (err && err.message) || 'Save failed.';
                    s.antiSnipeStatus.classList.add('err');
                });
        });
    };

    /** beta.3.18 — POST empty-string password to clear the hash. */
    SettingsTab.prototype._clearAntiSnipe = function () {
        var self = this;
        var t = root.enmTOrFallback;
        var s = this._security;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm(t('settings.anti_snipe_clear_confirm'))) {
                return;
            }
        }
        s.antiSnipeStatus.textContent = t('common.saving') || 'Saving…';
        s.antiSnipeStatus.classList.remove('ok', 'err');
        return root.enmRunOnce(s.antiSnipeClearBtn, t('common.saving') || 'Saving…', function () {
            return self.api.post('/config/anti-snipe-password', { password: '' })
                .then(function () {
                    if (self._destroyed) { return; }
                    s.antiSnipeStatus.textContent = t('settings.anti_snipe_cleared');
                    s.antiSnipeStatus.classList.add('ok');
                    s.antiSnipeClearBtn.hidden = true;
                    s.antiSnipeField.input.placeholder = t('settings.anti_snipe_placeholder_unset');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    s.antiSnipeStatus.textContent = (err && err.message) || 'Clear failed.';
                    s.antiSnipeStatus.classList.add('err');
                });
        });
    };

    /**
     * beta.3.18 — save Security section (autoExecuteSafe +
     * criticalRequiresAck). Anti-snipe is saved separately via
     * _saveAntiSnipe (its own button row, bypasses this section save).
     * Backend: PUT /config/general; same endpoint as Storage's save,
     * different subset.
     * @private
     */
    SettingsTab.prototype._saveSecurity = function () {
        var t = root.enmTOrFallback;
        var self = this;
        var body = {
            autoExecuteSafe: this._security.autoSafe.getValue(),
            criticalRequiresAck: this._security.criticalAck.getValue(),
        };
        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._security.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._security.saveBtn, savingLabel, function () {
            return self.api.put('/config/general', body)
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._security.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self.refresh('security');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._security.statusEl, 'error',
                        t('settings.save_failed', { error: err.message || String(err) }));
                });
        });
    };

    /**
     * beta.3.18 — save Storage section (auditRetentionDays only in
     * Phase 1; Phase 3 will add log retention + keystore backup).
     * Backend: PUT /config/general; same endpoint as Security's save.
     * @private
     */
    SettingsTab.prototype._saveStorage = function () {
        var t = root.enmTOrFallback;
        var self = this;
        this._storage.auditRetention.input.removeAttribute('aria-invalid');

        var retention = parseInt(this._storage.auditRetention.input.value, 10);
        if (!Number.isInteger(retention) || retention < 0 || retention > 3650) {
            setStatus(this._storage.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_retention') }));
            this._storage.auditRetention.input.setAttribute('aria-invalid', 'true');
            try { this._storage.auditRetention.input.focus({ preventScroll: true }); }
            catch (e) { this._storage.auditRetention.input.focus(); }
            return;
        }
        var body = { auditRetentionDays: retention };
        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._storage.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._storage.saveBtn, savingLabel, function () {
            return self.api.put('/config/general', body)
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._storage.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self.refresh('storage');
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._storage.statusEl, 'error',
                        t('settings.save_failed', { error: err.message || String(err) }));
                });
        });
    };

    // -----------------------------------------------------------------
    // Form fill / hydration
    // -----------------------------------------------------------------
    /**
     * beta.3.18 — _fillForm rebased onto 5 sections. Each section's
     * save handler re-hydrates only its own fields after a successful
     * PUT so pending edits in other sections aren't wiped.
     *
     * @private
     * @param {string} [scope]  one of SECTION_KEYS or undefined (= all)
     */
    SettingsTab.prototype._fillForm = function (scope) {
        var cfg = this._cfg;
        if (!cfg) { return; }
        if (!scope || scope === 'access')   { this._fillAccess(cfg); }
        if (!scope || scope === 'security') { this._fillSecurity(cfg); }
        if (!scope || scope === 'network')  { this._fillNetwork(cfg); }
        if (!scope || scope === 'storage')  { this._fillStorage(cfg); }
        if (!scope || scope === 'advanced') { this._fillAdvanced(cfg); }
    };

    /** @private */
    SettingsTab.prototype._fillNetwork = function (cfg) {
        var chain = cfg && cfg.chains && cfg.chains.mainchain;
        if (!chain || !this._network || !this._network.seg) { return; }
        var mode = (chain.dpos && chain.dpos.ipAddressMode === 'manual')
            ? 'manual' : 'auto';
        this._network.seg.setValue(mode);
        this._onNetworkModeChange(mode);
        this._network.manualInput.value =
            (chain.dpos && chain.dpos.ipAddressManual) || '';
    };

    /** beta.3.18 — only fills log/memory/archive now. */
    SettingsTab.prototype._fillAdvanced = function (cfg) {
        var chain = cfg && cfg.chains && cfg.chains.mainchain;
        if (!chain || !this._advanced) { return; }
        this._advanced.logLevel.setValue(chain.logLevel || 'info');
        this._advanced.archiveMode.setValue(!!chain.archiveMode);
        this._advanced.memory.input.value = String(chain.memoryLimitMb || 4096);
    };

    /** beta.3.18 — Access section (RPC user / password / whitelist). */
    SettingsTab.prototype._fillAccess = function (cfg) {
        var chain = cfg && cfg.chains && cfg.chains.mainchain;
        if (!chain || !this._access) { return; }
        this._access.rpcUser.value = (chain.rpc && chain.rpc.user) || 'ela';
        this._access.rpcPasswordField.input.value = '';
        this._access.rpcPasswordField.input.placeholder =
            (chain.rpc && chain.rpc.passwordSet)
                ? (root.enmTOrFallback('settings.rpc_password_placeholder_set') || '(leave blank to keep current)')
                : 'set a password';
        // Whitelist chips are populated by _loadCreds (separate endpoint
        // returns the actual list); _fillAccess doesn't need to touch
        // them. Same shape as alpha.28's flow.
    };

    /** beta.3.18 — Security section (anti-snipe + healing + ack). */
    SettingsTab.prototype._fillSecurity = function (cfg) {
        if (!this._security) { return; }
        var t = root.enmTOrFallback;
        var g = (cfg && cfg.global) || {};
        this._security.autoSafe.setValue(
            !(g.healing && g.healing.autoExecuteSafe === false));
        this._security.criticalAck.setValue(
            !(g.notifications && g.notifications.criticalRequiresAck === false));
        if (this._security.antiSnipeField) {
            this._security.antiSnipeField.input.value = '';
            if (g.antiSnipePasswordSet) {
                this._security.antiSnipeClearBtn.hidden = false;
                this._security.antiSnipeField.input.placeholder = t('settings.anti_snipe_placeholder_set');
            } else {
                this._security.antiSnipeClearBtn.hidden = true;
                this._security.antiSnipeField.input.placeholder = t('settings.anti_snipe_placeholder_unset');
            }
            if (this._security.antiSnipeStatus) {
                this._security.antiSnipeStatus.textContent = '';
                this._security.antiSnipeStatus.classList.remove('ok', 'err');
            }
        }
    };

    /** beta.3.18 — Storage section (audit retention only in Phase 1). */
    SettingsTab.prototype._fillStorage = function (cfg) {
        if (!this._storage) { return; }
        var g = (cfg && cfg.global) || {};
        this._storage.auditRetention.input.value =
            String((g.audit && g.audit.retentionDays) || 365);
    };

    // -----------------------------------------------------------------
    // beta.3.18 — Restart modal helper.
    //
    // Operator option (3): lifecycle stays on the Dashboard, but when
    // a Settings save needs a chain restart to take effect, surface a
    // modal here so the operator can restart in one click instead of
    // hunting for the power circle. Reuses the phase-06 modal-card
    // chrome (.enm-modal-scrim + .enm-modal-card) shared with the
    // proposal card and tools-update modal.
    // -----------------------------------------------------------------
    /**
     * Fire the restart prompt after a successful save. Caller passes
     * the section key so the modal can name what changed in the body.
     * If the chain isn't currently running, we show a different
     * message (nothing to restart — changes apply on next start).
     *
     * @private
     * @param {string} sectionKey
     */
    SettingsTab.prototype._promptRestartIfNeeded = function (sectionKey) {
        var self = this;
        var t = root.enmTOrFallback;

        // Tear down any prior restart modal still open. The Settings
        // tab can fire two saves back-to-back; we only want one active.
        if (typeof this._restartModalClose === 'function') {
            try { this._restartModalClose(); } catch (e) { /* no-op */ }
            this._restartModalClose = null;
        }

        // Probe chain state via the same /chains/mainchain endpoint
        // the dashboard uses. Best-effort: if the probe fails we still
        // open the modal but with the generic body, since the change
        // is saved and the operator's intent (restart) is clear.
        this.api.get('/chains/mainchain', { skipCache: true })
            .then(function (envelope) {
                if (self._destroyed) { return; }
                var state = envelope && envelope.data;
                // Coarse states that mean "process alive". Anything
                // else means "nothing to restart".
                var alive = !!(state && (
                    state.state === 'healthy'
                    || state.state === 'syncing'
                    || state.state === 'starting'
                    || state.state === 'recovering'
                    || state.state === 'stalled'
                    || (state.pid && state.attached !== false)
                ));
                self._openRestartModal(alive);
            })
            .catch(function () {
                if (self._destroyed) { return; }
                // Assume alive on probe failure so the operator still
                // gets the Restart-now button. Worst case: backend
                // returns "chain not running" on /restart and the
                // modal's status line surfaces that.
                self._openRestartModal(true);
            });
    };

    /** @private — actually mount the modal DOM. */
    SettingsTab.prototype._openRestartModal = function (chainAlive) {
        var self = this;
        var t = root.enmTOrFallback;

        var modalRoot = document.createElement('div');
        modalRoot.className = 'enm-restart-modal-root';

        var scrim = document.createElement('div');
        scrim.className = 'enm-modal-scrim';
        modalRoot.appendChild(scrim);

        var card = document.createElement('div');
        card.className = 'enm-modal-card enm-restart-modal-card';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-labelledby', 'enm-restart-mod-h');
        card.setAttribute('aria-modal', 'true');

        var heading = document.createElement('h2');
        heading.id = 'enm-restart-mod-h';
        heading.className = 'enm-modal-heading';
        heading.textContent = t('settings.restart_modal_title');
        card.appendChild(heading);

        var summary = document.createElement('p');
        summary.className = 'enm-modal-summary';
        summary.textContent = chainAlive
            ? t('settings.restart_modal_body')
            : t('settings.restart_modal_chain_stopped');
        card.appendChild(summary);

        var statusLine = document.createElement('p');
        statusLine.className = 'enm-restart-modal-status';
        statusLine.setAttribute('role', 'status');
        statusLine.setAttribute('aria-live', 'polite');
        card.appendChild(statusLine);

        var actions = document.createElement('div');
        actions.className = 'enm-modal-actions';
        var laterBtn = document.createElement('button');
        laterBtn.type = 'button';
        laterBtn.className = 'enm-btn';
        laterBtn.textContent = t('settings.restart_modal_later');
        var nowBtn = document.createElement('button');
        nowBtn.type = 'button';
        nowBtn.className = 'enm-btn enm-btn-primary';
        nowBtn.textContent = t('settings.restart_modal_now');
        // When the chain isn't alive there's nothing to restart;
        // disable the primary action + lean on the secondary as
        // the dismiss button.
        if (!chainAlive) {
            nowBtn.disabled = true;
            laterBtn.textContent = t('common.close') || 'Close';
        }
        actions.appendChild(laterBtn);
        actions.appendChild(nowBtn);
        card.appendChild(actions);

        modalRoot.appendChild(card);
        document.body.appendChild(modalRoot);

        // Focus management — capture the return target + simple
        // focus trap on Tab.
        var previousFocus = document.activeElement;
        var modalClosed = false;
        var close = function () {
            if (modalClosed) { return; }
            modalClosed = true;
            if (modalRoot.parentNode) { modalRoot.parentNode.removeChild(modalRoot); }
            document.removeEventListener('keydown', onEsc);
            document.removeEventListener('keydown', trap, true);
            scrim.removeEventListener('click', onScrim);
            try {
                if (previousFocus && typeof previousFocus.focus === 'function') {
                    previousFocus.focus({ preventScroll: true });
                }
            } catch (e) { /* focus may fail on detached elements */ }
            if (self) { self._restartModalClose = null; }
        };
        var onEsc = function (e) { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onEsc);
        var onScrim = function (ev) { if (ev.target === scrim) close(); };
        scrim.addEventListener('click', onScrim);
        var trap = function (ev) {
            if (ev.key !== 'Tab') { return; }
            var focusables = card.querySelectorAll('button:not([disabled])');
            if (!focusables.length) { return; }
            var first = focusables[0];
            var last  = focusables[focusables.length - 1];
            if (ev.shiftKey && document.activeElement === first) {
                ev.preventDefault(); last.focus();
            } else if (!ev.shiftKey && document.activeElement === last) {
                ev.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', trap, true);

        laterBtn.addEventListener('click', close);
        nowBtn.addEventListener('click', function () {
            statusLine.textContent = t('settings.restart_modal_restarting');
            nowBtn.disabled = true;
            laterBtn.disabled = true;
            self.api.post('/chains/mainchain/restart')
                .then(function () {
                    if (modalClosed) { return; }
                    statusLine.textContent = t('settings.restart_modal_done');
                    // Auto-close after a brief read pause so the
                    // operator sees the confirmation before the
                    // modal disappears.
                    setTimeout(close, 1200);
                })
                .catch(function (err) {
                    if (modalClosed) { return; }
                    nowBtn.disabled = false;
                    laterBtn.disabled = false;
                    if (err && err.status === 401) {
                        statusLine.textContent = '';
                        return;
                    }
                    statusLine.textContent = t('settings.restart_modal_failed',
                        { error: (err && err.message) || String(err) });
                });
        });

        // Initial focus on the primary action so the operator can
        // hit Enter to restart immediately.
        try { (chainAlive ? nowBtn : laterBtn).focus({ preventScroll: true }); }
        catch (e) { (chainAlive ? nowBtn : laterBtn).focus(); }

        this._restartModalClose = close;
    };

    // -----------------------------------------------------------------
    // Builders for the form primitives. Each returns a small handle the
    // SettingsTab can talk to (.el for the DOM node, .getValue / .setValue
    // / .input as needed). The DOM emitted matches the phase-04 mock 1:1.
    // -----------------------------------------------------------------

    /**
     * makeSection({ id, icon, title, help, helpCodes?, helpSuffix?, tag? })
     * → { card, body, statusEl, saveBtn, revertBtn }
     *
     * Emits the canonical .enm-section-card three-part structure
     * (head / body / foot) and returns refs the caller can wire into.
     */
    function makeSection(opts) {
        var card = document.createElement('div');
        card.className = 'enm-section-card';

        // --- head ---
        var head = document.createElement('div');
        head.className = 'enm-section-card-head';
        var icon = document.createElement('div');
        icon.className = 'enm-section-card-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = opts.icon || '';
        head.appendChild(icon);

        var headbody = document.createElement('div');
        headbody.className = 'enm-section-card-headbody';
        var title = document.createElement('div');
        title.className = 'enm-section-card-title';
        title.id = 'enm-section-h-' + opts.id;
        title.textContent = opts.title || '';
        headbody.appendChild(title);
        if (opts.help) {
            var help = document.createElement('div');
            help.className = 'enm-section-card-help';
            renderHelp(help, opts.help, opts.helpCodes, opts.helpSuffix);
            headbody.appendChild(help);
        }
        head.appendChild(headbody);

        // 0.2.0-beta.3.8 — section tag now has two paint states. By
        // default it shows the static intent ("Restart required" /
        // "No restart needed"); when the section's body has unsaved
        // changes, the tag flips to a warning "Unsaved changes"
        // chip. setDirty(true|false) is exposed on the returned
        // section handle so each section's body-change listener can
        // toggle.
        var tag = null;
        if (opts.tag) {
            tag = document.createElement('div');
            tag.className = 'enm-section-card-tag ' + (opts.tag.kind || 'muted');
            tag.textContent = opts.tag.label;
            head.appendChild(tag);
        }
        card.appendChild(head);

        // --- body ---
        var body = document.createElement('div');
        body.className = 'enm-section-card-body';
        card.appendChild(body);

        // --- foot ---
        var foot = document.createElement('div');
        foot.className = 'enm-section-card-foot';
        var statusEl = document.createElement('div');
        statusEl.className = 'enm-section-card-foot-status';
        statusEl.setAttribute('role', 'status');
        statusEl.setAttribute('aria-live', 'polite');
        foot.appendChild(statusEl);

        var revertBtn = document.createElement('button');
        revertBtn.type = 'button';
        revertBtn.className = 'enm-btn';
        // beta.3.18 — Revert label routed through i18n (settings audit
        // flagged this as one of ~15 inline-English strings).
        var tFn = root.enmTOrFallback;
        revertBtn.textContent = (typeof tFn === 'function'
            && tFn('settings.revert_btn')) || 'Revert';
        foot.appendChild(revertBtn);

        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'enm-btn enm-btn-primary';
        // 0.2.0-beta.3.6 — phase-04 mock spec is section-specific labels
        // ("Save Network" / "Save Advanced" / "Save General") rather
        // than a generic "Save" so operators can re-confirm what scope
        // they're committing to before clicking. Caller passes opts.id
        // already; capitalise it for display.
        var saveLabel = 'Save';
        if (opts.id === 'network')        { saveLabel = 'Save Network'; }
        else if (opts.id === 'advanced')  { saveLabel = 'Save Advanced'; }
        else if (opts.id === 'access')    { saveLabel = 'Save Access'; }
        else if (opts.id === 'security')  { saveLabel = 'Save Security'; }
        else if (opts.id === 'storage')   { saveLabel = 'Save Storage'; }
        else if (opts.id === 'general')   { saveLabel = 'Save General'; }
        saveBtn.textContent = saveLabel;
        foot.appendChild(saveBtn);

        card.appendChild(foot);

        // 0.2.0-beta.3.8 — setDirty wires the dynamic Restart-tag.
        // When dirty: tag swaps to "Unsaved changes" in warning palette.
        // When clean: tag restores its construction-time label + kind.
        function setDirty(isDirty) {
            if (!tag) { return; }
            if (isDirty) {
                tag.className = 'enm-section-card-tag warn';
                tag.textContent = 'Unsaved changes';
            } else if (opts.tag) {
                tag.className = 'enm-section-card-tag ' + (opts.tag.kind || 'muted');
                tag.textContent = opts.tag.label;
            }
        }
        return { card: card, body: body, statusEl: statusEl, saveBtn: saveBtn, revertBtn: revertBtn, setDirty: setDirty };
    }

    /**
     * makeFormRow({ label, help?, helpCodes?, helpSuffix?, control, disabled? })
     * → HTMLElement
     */
    function makeFormRow(opts) {
        var row = document.createElement('div');
        row.className = 'enm-form-row';
        if (opts.disabled) { row.setAttribute('data-disabled', 'true'); }

        var lblBlock = document.createElement('div');
        lblBlock.className = 'enm-form-label-block';
        var lbl = document.createElement('div');
        lbl.className = 'enm-form-label';
        lbl.textContent = opts.label || '';
        lblBlock.appendChild(lbl);
        if (opts.help || opts.helpCodes) {
            var help = document.createElement('div');
            help.className = 'enm-form-label-help';
            renderHelp(help, opts.help || '', opts.helpCodes, opts.helpSuffix);
            lblBlock.appendChild(help);
        }
        row.appendChild(lblBlock);

        var control = document.createElement('div');
        control.className = 'enm-form-control';
        if (opts.control) { control.appendChild(opts.control); }
        row.appendChild(control);
        return row;
    }

    /**
     * makeSeg({ options: [{value,label}], value, onChange })
     * → { el, getValue, setValue }
     */
    function makeSeg(opts) {
        var el = document.createElement('div');
        el.className = 'enm-seg';
        el.setAttribute('role', 'radiogroup');
        var current = opts.value || (opts.options[0] && opts.options[0].value);
        var optEls = {};

        opts.options.forEach(function (o) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'enm-seg-opt';
            btn.dataset.value = o.value;
            btn.setAttribute('role', 'radio');
            btn.textContent = o.label;
            btn.addEventListener('click', function () { setValue(o.value); });
            el.appendChild(btn);
            optEls[o.value] = btn;
        });

        // 0.2.0-beta.3.4 hotfix — split paint() (visual only) from
        // setValue() (paint + fire onChange). The initial-state setup
        // must NOT fire onChange because the caller's onChange handler
        // may reference DOM nodes (e.g. _network.manualRow) that aren't
        // built yet during the segmented control's own construction.
        // Pre-fix: SettingsTab constructor threw inside _onNetworkMode
        // Change('auto') trying to setAttribute on an undefined
        // manualRow, killing the whole tab render. Pattern now matches
        // makeToggle / makeSelectWrap which also paint without firing.
        function paint(v) {
            if (!optEls[v]) { return; }
            current = v;
            Object.keys(optEls).forEach(function (k) {
                var active = (k === v);
                optEls[k].classList.toggle('active', active);
                optEls[k].setAttribute('aria-checked', active ? 'true' : 'false');
            });
        }
        function setValue(v) {
            if (!optEls[v]) { return; }
            paint(v);
            if (typeof opts.onChange === 'function') { opts.onChange(current); }
        }
        paint(current);

        return {
            el: el,
            getValue: function () { return current; },
            setValue: function (v) { setValue(v); },
        };
    }

    /**
     * makeToggle({ initial, onChange })
     * → { el, getValue, setValue }
     */
    function makeToggle(opts) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'enm-toggle';
        el.setAttribute('role', 'switch');
        var track = document.createElement('div');
        track.className = 'enm-toggle-track';
        var thumb = document.createElement('div');
        thumb.className = 'enm-toggle-thumb';
        el.appendChild(track);
        el.appendChild(thumb);

        var on = !!opts.initial;
        function paint() {
            el.setAttribute('data-on', on ? 'true' : 'false');
            el.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        el.addEventListener('click', function () {
            on = !on;
            paint();
            if (typeof opts.onChange === 'function') { opts.onChange(on); }
        });
        paint();

        return {
            el: el,
            getValue: function () { return on; },
            setValue: function (v) { on = !!v; paint(); },
        };
    }

    /**
     * makeToggleRow({ initial, title?, sub?, getLabel?(on)→{title,sub}, onChange })
     * → { el, getValue, setValue }
     *
     * Wraps a makeToggle with adjacent .enm-toggle-row-text title+sub.
     * getLabel lets the row's text track the toggle state (e.g. Off /
     * pruning vs On / archive).
     */
    function makeToggleRow(opts) {
        var row = document.createElement('div');
        row.className = 'enm-toggle-row';

        var textWrap = document.createElement('div');
        textWrap.className = 'enm-toggle-row-text';
        var titleEl = document.createElement('div');
        titleEl.className = 'enm-toggle-row-text-title';
        var subEl = document.createElement('div');
        subEl.className = 'enm-toggle-row-text-sub';
        textWrap.appendChild(titleEl);
        textWrap.appendChild(subEl);

        var toggle = makeToggle({
            initial: !!opts.initial,
            onChange: function (on) {
                paintText(on);
                if (typeof opts.onChange === 'function') { opts.onChange(on); }
            },
        });

        function paintText(on) {
            if (typeof opts.getLabel === 'function') {
                var l = opts.getLabel(on) || {};
                titleEl.textContent = l.title || '';
                subEl.textContent = l.sub || '';
            } else {
                titleEl.textContent = opts.title || '';
                subEl.textContent = opts.sub || '';
            }
        }
        paintText(!!opts.initial);

        // Phase-04 mock places toggle BEFORE the text block. Match.
        row.appendChild(toggle.el);
        row.appendChild(textWrap);

        return {
            el: row,
            getValue: function () { return toggle.getValue(); },
            setValue: function (v) { toggle.setValue(v); paintText(!!v); },
        };
    }

    /**
     * makeInput({ type?, value?, placeholder?, mono?, ariaLabel?, describedById? })
     * → HTMLInputElement
     */
    function makeInput(opts) {
        var i = document.createElement('input');
        i.type = opts.type || 'text';
        i.className = opts.mono ? 'enm-input mono' : 'enm-input';
        if (opts.value != null) { i.value = String(opts.value); }
        if (opts.placeholder) { i.placeholder = opts.placeholder; }
        if (opts.min != null) { i.min = String(opts.min); }
        if (opts.max != null) { i.max = String(opts.max); }
        if (opts.step != null) { i.step = String(opts.step); }
        if (opts.ariaLabel) { i.setAttribute('aria-label', opts.ariaLabel); }
        if (opts.describedById) { i.setAttribute('aria-describedby', opts.describedById); }
        if (opts.type === 'number') {
            i.setAttribute('inputmode', 'numeric');
            if (opts.min != null && opts.max != null) {
                i.title = 'Between ' + opts.min + ' and ' + opts.max;
            }
        }
        return i;
    }

    /**
     * makeInputSuffix({ ...inputOpts, suffix })
     * → { el, input }
     */
    function makeInputSuffix(opts) {
        var wrap = document.createElement('div');
        wrap.className = 'enm-input-wrap';
        var input = makeInput(opts);
        wrap.appendChild(input);
        var sfx = document.createElement('span');
        sfx.className = 'enm-input-suffix';
        sfx.setAttribute('aria-hidden', 'true');
        sfx.textContent = opts.suffix || '';
        wrap.appendChild(sfx);
        return { el: wrap, input: input };
    }

    /**
     * makeSelectWrap({ options: [{value,label}], value, onChange? })
     * → { el, getValue, setValue }
     */
    function makeSelectWrap(opts) {
        var wrap = document.createElement('div');
        wrap.className = 'enm-select-wrap';
        var sel = document.createElement('select');
        sel.className = 'enm-select';
        opts.options.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            sel.appendChild(opt);
        });
        if (opts.value != null) { sel.value = String(opts.value); }
        if (typeof opts.onChange === 'function') {
            sel.addEventListener('change', function () { opts.onChange(sel.value); });
        }
        wrap.appendChild(sel);
        var chev = document.createElement('span');
        chev.className = 'enm-select-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.textContent = '▾'; // ▾
        wrap.appendChild(chev);
        return {
            el: wrap,
            getValue: function () { return sel.value; },
            setValue: function (v) { sel.value = String(v); },
        };
    }

    /**
     * makeSecretField({ value?, placeholder?, ariaLabel? })
     * → { el, input, getValue, setValue }
     *
     * Password input + eye-toggle that flips type password↔text. Operator
     * is already authenticated as owner, so the toggle is a shoulder-
     * surfing mitigation, not a security gate.
     */
    function makeSecretField(opts) {
        var wrap = document.createElement('div');
        wrap.className = 'enm-secret-field';
        var input = makeInput({
            type: 'password',
            value: opts.value || '',
            placeholder: opts.placeholder || '',
            mono: true,
            ariaLabel: opts.ariaLabel || 'Password',
        });
        input.setAttribute('autocomplete', 'new-password');
        input.setAttribute('spellcheck', 'false');
        wrap.appendChild(input);

        var eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'enm-btn enm-btn-icon';
        eye.setAttribute('aria-label', 'Show password');
        eye.setAttribute('aria-pressed', 'false');
        eye.textContent = '\u{1F441}'; // 👁
        eye.addEventListener('click', function () {
            var shown = input.type === 'text';
            input.type = shown ? 'password' : 'text';
            eye.setAttribute('aria-pressed', shown ? 'false' : 'true');
            eye.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
        });
        wrap.appendChild(eye);

        return {
            el: wrap,
            input: input,
            getValue: function () { return input.value; },
            setValue: function (v) { input.value = v == null ? '' : String(v); },
        };
    }

    /**
     * makeChipInput({ locked, placeholder?, ariaLabel? })
     * → { el, getValue, setValue }
     *
     * Reuses the alpha.27 chipInput behaviour (locked entries, IP/CIDR
     * validation, dedupe, CJK IME guard, multi-value paste) but emits
     * the mock's class names: .enm-chip-input, .enm-chip,
     * .enm-chip[data-locked="true"], .enm-chip-lock, .enm-chip-remove,
     * .enm-chip-input-input.
     */
    function makeChipInput(opts) {
        opts = opts || {};
        var lockedValues = Array.isArray(opts.locked) ? opts.locked.slice() : [];

        var el = document.createElement('div');
        el.className = 'enm-chip-input';

        var newInput = document.createElement('input');
        newInput.type = 'text';
        newInput.className = 'enm-chip-input-input';
        newInput.placeholder = opts.placeholder || '';
        newInput.setAttribute('aria-label', opts.ariaLabel || 'Add value');
        newInput.setAttribute('autocomplete', 'off');
        newInput.setAttribute('autocapitalize', 'off');
        newInput.setAttribute('autocorrect', 'off');
        newInput.spellcheck = false;

        var values = [];
        // BP-E audit fix — track the flash-invalid border-reset timer on
        // a closure-local variable so the returned destroy() can clear it.
        // makeChipInput is a free function, not a method, so it has no
        // access to a parent `self`; the SettingsTab calls our destroy()
        // during its own destroy() flow.
        var flashTimer = null;
        var destroyed = false;

        function isLocked(v) { return lockedValues.indexOf(v) !== -1; }

        function render() {
            // Tear down existing chips, keep newInput.
            var chips = el.querySelectorAll('.enm-chip');
            for (var i = 0; i < chips.length; i += 1) { el.removeChild(chips[i]); }
            // Insert chips before newInput in order.
            values.forEach(function (v, idx) {
                var chip = document.createElement('span');
                chip.className = 'enm-chip';
                var locked = isLocked(v);
                if (locked) { chip.setAttribute('data-locked', 'true'); }
                if (locked) {
                    var lock = document.createElement('span');
                    lock.className = 'enm-chip-lock';
                    lock.setAttribute('aria-label', 'locked');
                    lock.textContent = '\u{1F512}'; // 🔒
                    chip.appendChild(lock);
                }
                chip.appendChild(document.createTextNode(v));
                if (!locked) {
                    var rm = document.createElement('button');
                    rm.type = 'button';
                    rm.className = 'enm-chip-remove';
                    rm.setAttribute('aria-label', 'Remove ' + v);
                    rm.textContent = '×'; // ×
                    rm.addEventListener('click', function () {
                        values.splice(idx, 1);
                        render();
                    });
                    chip.appendChild(rm);
                }
                if (locked) {
                    chip.title = 'Locked — needed for ENM’s own RPC calls.';
                }
                el.insertBefore(chip, newInput);
            });
        }

        function flashInvalid(reason) {
            // BP-E audit fix — guard against destroy() racing the 900ms
            // border-reset timer. The chip-input lives inside the settings
            // pane; if the operator clicks Save or navigates away while a
            // flash is in flight, the old timer would mutate the input's
            // style after it's been detached. Stash the id on a closure-
            // local so destroy() (added below) can clear it.
            if (destroyed) { return; }
            var prev = newInput.style.borderColor;
            newInput.style.borderColor = 'var(--error, #ef5060)';
            if (flashTimer) { clearTimeout(flashTimer); }
            flashTimer = setTimeout(function () {
                flashTimer = null;
                if (destroyed) { return; }
                newInput.style.borderColor = prev;
            }, 900);
            newInput.setAttribute('aria-invalid', 'true');
            var hint = reason
                || (root.enmTOrFallback
                    ? root.enmTOrFallback('settings.rpc_white_invalid')
                    : 'Not a valid IPv4 or CIDR.');
            newInput.title = hint;
            var clearOnce = function () {
                newInput.removeAttribute('aria-invalid');
                newInput.removeEventListener('input', clearOnce);
            };
            newInput.addEventListener('input', clearOnce);
        }

        function tryAdd() {
            var candidate = (newInput.value || '').trim();
            if (!candidate) { return; }
            if (!IP_OR_CIDR_RE.test(candidate)) { flashInvalid(); return; }
            if (values.indexOf(candidate) !== -1) {
                newInput.value = '';
                return;
            }
            values.push(candidate);
            newInput.value = '';
            render();
        }

        function ensureLockedPresent() {
            for (var i = lockedValues.length - 1; i >= 0; i--) {
                if (values.indexOf(lockedValues[i]) === -1) {
                    values.unshift(lockedValues[i]);
                }
            }
        }

        newInput.addEventListener('keydown', function (e) {
            // CJK IME guard (batch 18).
            if (e.isComposing || e.keyCode === 229) { return; }
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                tryAdd();
            }
        });

        // Multi-value paste (batch 18).
        newInput.addEventListener('paste', function (e) {
            var cb = e.clipboardData || (typeof root !== 'undefined' ? root.clipboardData : null);
            if (!cb || typeof cb.getData !== 'function') { return; }
            var text = cb.getData('text');
            if (!text || !/[,\s\n\t]/.test(text)) { return; }
            e.preventDefault();
            var parts = text.split(/[,\s\n\t]+/);
            for (var i = 0; i < parts.length; i += 1) {
                var v = parts[i].trim();
                if (!v) { continue; }
                newInput.value = v;
                tryAdd();
            }
        });

        el.appendChild(newInput);
        ensureLockedPresent();
        render();

        return {
            el: el,
            getValue: function () { return values.slice(); },
            setValue: function (arr) {
                values = Array.isArray(arr) ? arr.filter(function (s) {
                    return typeof s === 'string' && s.length > 0;
                }) : [];
                ensureLockedPresent();
                render();
            },
            // BP-E audit fix — parent SettingsTab.destroy() calls this
            // during its own teardown so an in-flight flashInvalid timer
            // can't mutate a detached input's style after the pane is
            // unmounted.
            destroy: function () {
                destroyed = true;
                if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
            },
        };
    }

    // -----------------------------------------------------------------
    // Misc helpers
    // -----------------------------------------------------------------

    /**
     * Set the foot status text + a state class ('success' | 'warn' |
     * 'error' | ''). Toggles role between status (info/success) and
     * alert (error) so AT announces errors with higher priority.
     */
    function setStatus(el, kind, text) {
        if (!el) { return; }
        el.classList.remove('success', 'warn', 'error');
        if (kind) { el.classList.add(kind); }
        // Mock-aligned roles: errors should escalate to alert.
        if (kind === 'error') {
            el.setAttribute('role', 'alert');
            el.setAttribute('aria-live', 'assertive');
        } else {
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
        }
        el.textContent = text || '';
    }

    /**
     * renderHelp(targetEl, prefix, codes?, suffix?)
     *
     * Append a mix of plain text and inline <code> spans into the given
     * element. Used for both .enm-section-card-help and .enm-form-label-
     * help so the prose can interleave runtime field names ("Writes
     * chains.mainchain.dpos.ipAddressMode + ipAddressManual.").
     */
    function renderHelp(el, prefix, codes, suffix) {
        if (prefix) { el.appendChild(document.createTextNode(prefix)); }
        if (Array.isArray(codes)) {
            codes.forEach(function (c, idx) {
                if (idx > 0) { el.appendChild(document.createTextNode(' + ')); }
                var code = document.createElement('code');
                code.textContent = c;
                el.appendChild(code);
            });
        }
        if (suffix) { el.appendChild(document.createTextNode(suffix)); }
    }

    root.EnmSettingsTab = SettingsTab;
}(typeof window !== 'undefined' ? window : globalThis));
