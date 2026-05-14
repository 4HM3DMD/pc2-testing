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
    SettingsTab.prototype.refresh = function () {
        var self = this;
        this.api.get('/config', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            self._cfg = data && data.config;
            self._fillForm();
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
        navHead.textContent = 'Configuration';
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

        // Order matches mock: Network first, Advanced second, General last.
        var nav = [
            { key: 'network',  glyph: '⇄', label: t('settings.heading_network'),  build: this._buildNetworkSection },
            { key: 'advanced', glyph: '⚙', label: t('settings.heading_advanced'), build: this._buildAdvancedSection },
            { key: 'general',  glyph: '◉', label: t('settings.heading_general'),  build: this._buildGeneralSection },
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

        this._activate(this._activeKey);
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
        sec.revertBtn.addEventListener('click', function () { self.refresh(); });

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
                    self.refresh();
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
            help: 'Runtime knobs for the ela mainchain process. Writes ',
            helpCodes: ['chains.mainchain.{logLevel, archiveMode, memoryLimitMb, rpc}'],
            tag: { kind: 'warn', label: 'Restart required' },
        });
        this._adv = {
            card: sec.card,
            body: sec.body,
            statusEl: sec.statusEl,
            saveBtn: sec.saveBtn,
            revertBtn: sec.revertBtn,
        };

        // Row 1 — Log level.
        this._adv.logLevel = makeSelectWrap({
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
            helpSuffix: ' by ElaMainChainAdapter.',
            control: this._adv.logLevel.el,
        }));

        // Row 2 — Archive mode toggle.
        this._adv.archiveMode = makeToggleRow({
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
            control: this._adv.archiveMode.el,
        }));

        // Row 3 — Memory limit with MB suffix.
        this._adv.memory = makeInputSuffix({
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
            control: this._adv.memory.el,
        }));

        // Row 4 — RPC user.
        this._adv.rpcUser = makeInput({
            type: 'text',
            value: 'ela',
            mono: true,
            ariaLabel: 'RPC user',
            describedById: 'enm-adv-status',
        });
        this._adv.rpcUser.setAttribute('pattern', '[A-Za-z0-9]+');
        this._adv.rpcUser.setAttribute('autocomplete', 'username');
        this._adv.rpcUser.setAttribute('spellcheck', 'false');
        this._adv.rpcUser.setAttribute('autocapitalize', 'off');
        this._adv.rpcUser.title = 'Letters and numbers only (no spaces or symbols).';
        sec.body.appendChild(makeFormRow({
            label: 'RPC user',
            help: 'ela.conf ',
            helpCodes: ['RPCConfiguration.User'],
            helpSuffix: ' · Basic-Auth principal.',
            control: this._adv.rpcUser,
        }));

        // Row 5 — RPC password (secret-field with show/hide).
        this._adv.rpcPasswordField = makeSecretField({
            ariaLabel: 'RPC password',
            placeholder: '(leave blank to keep current)',
        });
        sec.body.appendChild(makeFormRow({
            label: 'RPC password',
            help: 'Encrypted by ',
            helpCodes: ['ConfigStore.setRpcPassword'],
            helpSuffix: '. Leave blank to keep the current one.',
            control: this._adv.rpcPasswordField.el,
        }));

        // Row 6 — IP whitelist (chip input with locked loopback).
        this._adv.whiteIp = makeChipInput({
            locked: ['127.0.0.1'],
            placeholder: 'add IP or CIDR…',
            ariaLabel: 'Add IP address or CIDR to whitelist',
        });
        sec.body.appendChild(makeFormRow({
            label: 'IP whitelist',
            help: 'ela.conf ',
            helpCodes: ['RPCConfiguration.WhiteIPList'],
            helpSuffix: '. Loopback stays locked so ENM can’t lose access to its own RPC.',
            control: this._adv.whiteIp.el,
        }));

        sec.statusEl.id = 'enm-adv-status';

        sec.saveBtn.addEventListener('click', function () { self._saveAdvanced(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh(); });

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

    /** @private */
    SettingsTab.prototype._fillCreds = function () {
        if (!this._adv || !this._creds) { return; }
        var d = this._creds;
        if (Array.isArray(d.whiteIPList)) {
            this._adv.whiteIp.setValue(d.whiteIPList);
        }
        // user + passwordSet may also come back here; prefer /config but
        // keep this as a fallback for the password placeholder.
        if (typeof d.user === 'string' && d.user.length > 0
            && (!this._adv.rpcUser.value || this._adv.rpcUser.value === 'ela')) {
            this._adv.rpcUser.value = d.user;
        }
    };

    /** @private */
    SettingsTab.prototype._saveAdvanced = function () {
        var t = root.enmTOrFallback;
        var self = this;
        // Clear any stale aria-invalid hints from a previous failed save
        // (batch 30).
        this._adv.memory.input.removeAttribute('aria-invalid');
        this._adv.rpcUser.removeAttribute('aria-invalid');

        // Inline client-side validation parity with the joi schema, so
        // the operator sees the problem before the round-trip.
        var memMb = parseInt(this._adv.memory.input.value, 10);
        if (!Number.isInteger(memMb) || memMb < 512 || memMb > 32768) {
            setStatus(this._adv.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_memory_range') }));
            this._adv.memory.input.setAttribute('aria-invalid', 'true');
            try { this._adv.memory.input.focus({ preventScroll: true }); }
            catch (e) { this._adv.memory.input.focus(); }
            return;
        }
        var rpcUser = this._adv.rpcUser.value.trim();
        if (rpcUser.length === 0 || !/^[A-Za-z0-9]+$/.test(rpcUser)) {
            setStatus(this._adv.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_rpc_user') }));
            this._adv.rpcUser.setAttribute('aria-invalid', 'true');
            try { this._adv.rpcUser.focus({ preventScroll: true }); }
            catch (e) { this._adv.rpcUser.focus(); }
            return;
        }

        var body = {
            logLevel: this._adv.logLevel.getValue(),
            archiveMode: this._adv.archiveMode.getValue(),
            memoryLimitMb: memMb,
            rpcUser: rpcUser,
            whiteIPList: this._adv.whiteIp.getValue(),
        };
        // RPC password is only sent if the operator typed something so
        // they can edit other knobs without re-typing it (alpha.28).
        var pw = this._adv.rpcPasswordField.input.value;
        if (pw && pw.length > 0) { body.rpcPassword = pw; }

        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._adv.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._adv.saveBtn, savingLabel, function () {
            return self.api.put('/config/mainchain', body)
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._adv.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self._adv.rpcPasswordField.input.value = '';
                    self.refresh();
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._adv.statusEl, 'error',
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

    // -----------------------------------------------------------------
    // Section: General
    // -----------------------------------------------------------------
    /** @private */
    SettingsTab.prototype._buildGeneralSection = function (t) {
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

        sec.statusEl.id = 'enm-gen-status';

        sec.saveBtn.addEventListener('click', function () { self._saveGeneral(); });
        sec.revertBtn.addEventListener('click', function () { self.refresh(); });

        return sec.card;
    };

    /** @private */
    SettingsTab.prototype._saveGeneral = function () {
        var t = root.enmTOrFallback;
        var self = this;
        this._gen.auditRetention.input.removeAttribute('aria-invalid');

        var retention = parseInt(this._gen.auditRetention.input.value, 10);
        if (!Number.isInteger(retention) || retention < 0 || retention > 3650) {
            setStatus(this._gen.statusEl, 'error',
                t('settings.save_failed', { error: t('settings.err_retention') }));
            this._gen.auditRetention.input.setAttribute('aria-invalid', 'true');
            try { this._gen.auditRetention.input.focus({ preventScroll: true }); }
            catch (e) { this._gen.auditRetention.input.focus(); }
            return;
        }
        var body = {
            autoExecuteSafe: this._gen.autoSafe.getValue(),
            criticalRequiresAck: this._gen.criticalAck.getValue(),
            auditRetentionDays: retention,
        };
        var savingLabel = t('common.saving') || 'Saving…';
        setStatus(this._gen.statusEl, '', t('common.loading') || 'Saving…');
        return root.enmRunOnce(this._gen.saveBtn, savingLabel, function () {
            return self.api.put('/config/general', body)
                .then(function () {
                    if (self._destroyed) { return; }
                    setStatus(self._gen.statusEl, 'success', '✓ ' + t('settings.saved'));
                    self.refresh();
                })
                .catch(function (err) {
                    if (self._destroyed) { return; }
                    if (err && err.status === 401) { return; }
                    setStatus(self._gen.statusEl, 'error',
                        t('settings.save_failed', { error: err.message || String(err) }));
                });
        });
    };

    // -----------------------------------------------------------------
    // Form fill / hydration
    // -----------------------------------------------------------------
    /** @private — Hydrate all three sections from the /config response. */
    SettingsTab.prototype._fillForm = function () {
        var cfg = this._cfg;
        if (!cfg) { return; }
        var chain = cfg.chains && cfg.chains.mainchain;
        if (chain) {
            // Network
            var mode = (chain.dpos && chain.dpos.ipAddressMode === 'manual')
                ? 'manual' : 'auto';
            if (this._network && this._network.seg) {
                this._network.seg.setValue(mode);
                this._onNetworkModeChange(mode);
                this._network.manualInput.value =
                    (chain.dpos && chain.dpos.ipAddressManual) || '';
            }
            // Advanced
            if (this._adv) {
                this._adv.logLevel.setValue(chain.logLevel || 'info');
                this._adv.archiveMode.setValue(!!chain.archiveMode);
                this._adv.memory.input.value = String(chain.memoryLimitMb || 4096);
                this._adv.rpcUser.value = (chain.rpc && chain.rpc.user) || 'ela';
                this._adv.rpcPasswordField.input.value = '';
                this._adv.rpcPasswordField.input.placeholder =
                    (chain.rpc && chain.rpc.passwordSet)
                        ? '(leave blank to keep current)' : 'set a password';
            }
        }
        // General
        var g = cfg.global || {};
        if (this._gen) {
            this._gen.autoSafe.setValue(
                !(g.healing && g.healing.autoExecuteSafe === false));
            this._gen.criticalAck.setValue(
                !(g.notifications && g.notifications.criticalRequiresAck === false));
            this._gen.auditRetention.input.value =
                String((g.audit && g.audit.retentionDays) || 365);
        }
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

        if (opts.tag) {
            var tag = document.createElement('div');
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
        revertBtn.textContent = 'Revert';
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
        else if (opts.id === 'general')   { saveLabel = 'Save General'; }
        saveBtn.textContent = saveLabel;
        foot.appendChild(saveBtn);

        card.appendChild(foot);

        return { card: card, body: body, statusEl: statusEl, saveBtn: saveBtn, revertBtn: revertBtn };
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
