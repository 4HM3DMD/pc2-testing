/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/settings-tab.js — three sections: Network, Mainchain Advanced,
 * General preferences. Maps directly to /config PUT endpoints.
 *
 * v0.1 keeps the form deliberately simple — every change is one PUT, no client
 * diffing, no optimistic UI. The save button shows "Saved" briefly on success
 * or surfaces the server error inline. Failures don't lose the user's edits.
 */

(function (root) {
    'use strict';

    function SettingsTab(opts) {
        if (!opts || !opts.api || !opts.notifications) {
            throw new TypeError('SettingsTab: { api, notifications } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.root = document.createElement('section');
        this.root.className = 'enm-settings';
        this._cfg = null;
        this._renderShell();
    }

    SettingsTab.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        return this;
    };

    SettingsTab.prototype.destroy = function () {
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    SettingsTab.prototype.refresh = function () {
        var self = this;
        this.api.get('/config', { skipCache: true }).then(function (data) {
            self._cfg = data && data.config;
            self._fillForm();
        }).catch(function (err) {
            self.notifications.warning('Failed to load config', err.message || String(err));
        });
    };

    /**
     * @private
     * alpha.9 — split the monolithic scroll page into a sub-tab nav.
     * Five panes live in the same DOM but only the active one is visible,
     * so the operator never scrolls past four irrelevant blocks to reach
     * the one they want. Default landing: 'network'. Danger is always
     * the last sub-tab and is never the default — operator must click
     * into it deliberately.
     *
     * Layout adapts via container query in styles.css: vertical nav rail
     * at width >640px, horizontal pill row below. Reuses the same
     * container-type: inline-size already on .enm-settings.
     */
    SettingsTab.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        this._sections = {};
        this._panes = {};
        this._activeKey = 'network';

        // Sub-tab nav rail (rendered first, lives at column 1 in the grid).
        this._navEl = document.createElement('nav');
        this._navEl.className = 'enm-settings-nav';
        this._navEl.setAttribute('role', 'tablist');
        this._navEl.setAttribute('aria-label', 'Settings sections');
        this.root.appendChild(this._navEl);

        // Content host (column 2). Each section becomes a pane in here.
        var content = document.createElement('div');
        content.className = 'enm-settings-content';
        this.root.appendChild(content);

        var navItems = [
            { key: 'network',   label: t('settings.heading_network'),   build: this._buildNetworkSection },
            { key: 'advanced',  label: t('settings.heading_advanced'),  build: this._buildAdvancedSection },
            { key: 'rpcCreds',  label: t('settings.heading_rpc_creds'), build: this._buildRpcCredsSection },
            { key: 'general',   label: t('settings.heading_general'),   build: this._buildGeneralSection },
            { key: 'danger',    label: t('settings.heading_danger'),    build: this._buildDangerZoneSection,
              accent: 'danger' },
        ];
        var self = this;
        navItems.forEach(function (item) {
            // Nav button — the sub-tab.
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'enm-settings-nav-item';
            if (item.accent) btn.dataset.accent = item.accent;
            btn.setAttribute('role', 'tab');
            btn.dataset.key = item.key;
            btn.textContent = item.label;
            btn.addEventListener('click', function () { self._activatePane(item.key); });
            self._navEl.appendChild(btn);

            // Build the matching section and host it in a pane wrapper.
            var section = item.build.call(self, t);
            section.classList.add('enm-settings-pane');
            content.appendChild(section);
            self._panes[item.key] = section;
        });

        this._activatePane(this._activeKey);
    };

    /**
     * @private
     * Switch which pane is visible + which nav button reads as selected.
     * Aria semantics kept in sync so screen readers see the same change.
     */
    SettingsTab.prototype._activatePane = function (key) {
        if (!this._panes[key]) return;
        this._activeKey = key;
        Object.keys(this._panes).forEach(function (k) {
            this._panes[k].hidden = (k !== key);
        }, this);
        var navBtns = this._navEl.querySelectorAll('.enm-settings-nav-item');
        navBtns.forEach(function (b) {
            var active = (b.dataset.key === key);
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    };

    /** @private */
    SettingsTab.prototype._buildNetworkSection = function (t) {
        var section = document.createElement('div');
        section.className = 'enm-settings-section';
        var h = document.createElement('h3'); h.textContent = t('settings.heading_network');
        section.appendChild(h);

        var modeWrap = document.createElement('div'); modeWrap.className = 'enm-settings-row';
        this._network = { modeAuto: radio('ipMode', 'auto'), modeManual: radio('ipMode', 'manual') };
        modeWrap.appendChild(label(this._network.modeAuto, t('settings.ip_mode_auto')));
        modeWrap.appendChild(label(this._network.modeManual, t('settings.ip_mode_manual')));
        section.appendChild(modeWrap);

        this._network.manualInput = document.createElement('input');
        this._network.manualInput.type = 'text';
        this._network.manualInput.className = 'enm-settings-input';
        this._network.manualInput.placeholder = t('settings.ip_help');
        section.appendChild(this._network.manualInput);

        var actions = document.createElement('div'); actions.className = 'enm-settings-actions';
        var detectBtn = btn(t('settings.ip_detect_btn'), 'enm-btn-secondary', this._detectIp.bind(this));
        var saveBtn = btn(t('settings.ip_save_btn'),     'enm-btn-primary',   this._saveNetwork.bind(this));
        actions.appendChild(detectBtn);
        actions.appendChild(saveBtn);
        section.appendChild(actions);

        this._network.statusLine = document.createElement('p');
        this._network.statusLine.className = 'enm-settings-status';
        section.appendChild(this._network.statusLine);

        this._sections.network = section;
        return section;
    };

    /** @private */
    SettingsTab.prototype._buildAdvancedSection = function (t) {
        var section = document.createElement('div');
        section.className = 'enm-settings-section';
        var h = document.createElement('h3'); h.textContent = t('settings.heading_advanced');
        section.appendChild(h);

        this._adv = {
            logLevel:    select(['debug', 'info', 'warn', 'error']),
            archiveMode: checkbox(),
            memory:      numberInput(512, 32_768),
            rpcUser:     textInput(),
            rpcPassword: passwordInput(),
        };

        var rows = [
            [t('settings.adv_log_level'),   this._adv.logLevel],
            [t('settings.adv_archive_mode'), this._adv.archiveMode],
            [t('settings.adv_memory_limit'), this._adv.memory],
            [t('settings.adv_rpc_user'),    this._adv.rpcUser],
            [t('settings.adv_rpc_password'), this._adv.rpcPassword],
        ];
        rows.forEach(function (r) {
            var row = document.createElement('div'); row.className = 'enm-settings-row';
            row.appendChild(label(r[1], r[0]));
            section.appendChild(row);
        });

        var actions = document.createElement('div'); actions.className = 'enm-settings-actions';
        actions.appendChild(btn(t('settings.adv_save_btn'), 'enm-btn-primary', this._saveAdvanced.bind(this)));
        section.appendChild(actions);

        this._adv.statusLine = document.createElement('p');
        this._adv.statusLine.className = 'enm-settings-status';
        section.appendChild(this._adv.statusLine);

        this._sections.advanced = section;
        return section;
    };

    /**
     * @private
     * RPC credentials reveal panel. Lazy-fetched — the password only leaves
     * the server when the operator actively clicks Reveal, mirroring how
     * recovery-phrase UIs work in wallets.
     */
    SettingsTab.prototype._buildRpcCredsSection = function (t) {
        var section = document.createElement('div');
        section.className = 'enm-settings-section';

        var h = document.createElement('h3');
        h.textContent = t('settings.heading_rpc_creds');
        section.appendChild(h);

        var intro = document.createElement('p');
        intro.className = 'enm-settings-help';
        intro.textContent = t('settings.rpc_creds_intro');
        section.appendChild(intro);

        // No reveal/hide wrapper — the operator is already authenticated as
        // owner; double-gating with a Reveal button adds friction without
        // adding security. Password stays masked with a per-field Show toggle
        // so shoulder-surfing on shared screens is still mitigated.
        this._creds = {
            panel: document.createElement('div'),
            statusLine: document.createElement('p'),
            whiteStatus: document.createElement('p'),
            whiteIp: chipInput(),
            data: null,
            pwShown: false,
        };
        this._creds.panel.className = 'enm-rpc-creds-panel';
        this._creds.statusLine.className = 'enm-settings-status';
        this._creds.whiteStatus.className = 'enm-settings-status';

        section.appendChild(this._creds.panel);
        section.appendChild(this._creds.statusLine);

        this._sections.rpcCreds = section;

        // Fetch + render immediately on first build. refresh() will also be
        // called when the tab becomes active; this just makes initial render
        // happen without a manual click.
        this._loadCreds();
        return section;
    };

    /** @private — fetch credentials + render inline. */
    SettingsTab.prototype._loadCreds = function () {
        var t = root.enmTOrFallback;
        var self = this;
        this._creds.statusLine.textContent = t('common.loading');
        this.api.get('/config/rpc/credentials/mainchain', { skipCache: true }).then(function (data) {
            self._creds.data = data;
            self._renderCredsPanel();
            self._creds.statusLine.textContent = '';
        }).catch(function (err) {
            self._creds.statusLine.textContent = t('settings.rpc_load_failed',
                { error: err.message || String(err) });
        });
    };

    /** @private */
    SettingsTab.prototype._renderCredsPanel = function () {
        var t = root.enmTOrFallback;
        var d = this._creds.data;
        var p = this._creds.panel;
        p.innerHTML = '';
        if (!d) return;

        // --- Credentials ---
        p.appendChild(credRow(t('settings.rpc_field_user'), d.user));
        p.appendChild(credPasswordRow(this, t));

        // --- Connection URLs, classified by address class. ---
        // Builds one row per URL with a descriptive label that tells the
        // operator who can use it. classifyUrl returns a CSS-friendly class.
        var samesection = document.createElement('div');
        samesection.className = 'enm-rpc-url-group';

        var urlGroupHeading = document.createElement('h4');
        urlGroupHeading.className = 'enm-rpc-url-group-heading';
        urlGroupHeading.textContent = t('settings.rpc_url_group_heading');
        samesection.appendChild(urlGroupHeading);

        if (d.localUrl) {
            samesection.appendChild(rpcUrlRow(
                t('settings.rpc_url_same_machine'),
                d.localUrl,
                null,
            ));
        }
        if (Array.isArray(d.lanUrls)) {
            d.lanUrls.forEach(function (u) {
                var kind = classifyUrlAddress(u);
                var label = kind === 'public'
                    ? t('settings.rpc_url_public_internet')
                    : t('settings.rpc_url_private_network');
                var warning = kind === 'public' ? t('settings.rpc_url_public_warn') : null;
                samesection.appendChild(rpcUrlRow(label, u, warning));
            });
        }
        p.appendChild(samesection);

        // --- Whitelist — editable inline. ---
        var whiteWrap = document.createElement('div');
        whiteWrap.className = 'enm-rpc-white-group';

        var wh = document.createElement('h4');
        wh.className = 'enm-rpc-url-group-heading';
        wh.textContent = t('settings.rpc_field_white');
        whiteWrap.appendChild(wh);

        var help = document.createElement('p');
        help.className = 'enm-settings-help';
        help.textContent = t('settings.rpc_white_help');
        whiteWrap.appendChild(help);

        // Mount the chipInput element itself
        whiteWrap.appendChild(this._creds.whiteIp);
        this._creds.whiteIp.setValue(Array.isArray(d.whiteIPList) ? d.whiteIPList : []);

        var whiteActions = document.createElement('div');
        whiteActions.className = 'enm-settings-actions';
        whiteActions.appendChild(btn(
            t('settings.rpc_white_apply_btn'),
            'enm-btn-primary',
            this._saveWhitelist.bind(this),
        ));
        whiteWrap.appendChild(whiteActions);
        whiteWrap.appendChild(this._creds.whiteStatus);
        p.appendChild(whiteWrap);
    };

    /** @private — save whitelist only (partial PUT). */
    SettingsTab.prototype._saveWhitelist = function () {
        var t = root.enmTOrFallback;
        var list = this._creds.whiteIp.getValue();
        var self = this;
        this._creds.whiteStatus.textContent = t('common.loading');
        this.api.put('/config/mainchain', { whiteIPList: list }).then(function () {
            self._creds.whiteStatus.textContent = t('settings.rpc_white_applied');
            // Refresh cached data so the chips reflect what the backend persisted
            // (the backend de-dupes + filters non-strings).
            if (self._creds.data) self._creds.data.whiteIPList = list.slice();
        }).catch(function (err) {
            self._creds.whiteStatus.textContent = t('settings.rpc_white_apply_failed',
                { error: err.message || String(err) });
        });
    };

    /** @private */
    SettingsTab.prototype._togglePwVisibility = function () {
        this._creds.pwShown = !this._creds.pwShown;
        this._renderCredsPanel();
    };

    /** @private */
    SettingsTab.prototype._buildGeneralSection = function (t) {
        var section = document.createElement('div');
        section.className = 'enm-settings-section';
        var h = document.createElement('h3'); h.textContent = t('settings.heading_general');
        section.appendChild(h);

        this._gen = {
            autoSafe:        checkbox(),
            criticalAck:     checkbox(),
            auditRetention:  numberInput(0, 3650),
        };
        [
            [t('settings.general_auto_safe'),       this._gen.autoSafe],
            [t('settings.general_critical_ack'),    this._gen.criticalAck],
            [t('settings.general_audit_retention'), this._gen.auditRetention],
        ].forEach(function (r) {
            var row = document.createElement('div'); row.className = 'enm-settings-row';
            row.appendChild(label(r[1], r[0]));
            section.appendChild(row);
        });

        var actions = document.createElement('div'); actions.className = 'enm-settings-actions';
        actions.appendChild(btn(t('settings.general_save_btn'), 'enm-btn-primary', this._saveGeneral.bind(this)));
        section.appendChild(actions);

        this._gen.statusLine = document.createElement('p');
        this._gen.statusLine.className = 'enm-settings-status';
        section.appendChild(this._gen.statusLine);

        this._sections.general = section;
        return section;
    };

    /** @private */
    SettingsTab.prototype._fillForm = function () {
        var cfg = this._cfg;
        if (!cfg) return;
        var chain = cfg.chains && cfg.chains.mainchain;
        if (chain) {
            // Network
            this._network.modeAuto.checked = (chain.dpos && chain.dpos.ipAddressMode !== 'manual');
            this._network.modeManual.checked = (chain.dpos && chain.dpos.ipAddressMode === 'manual');
            this._network.manualInput.value = (chain.dpos && chain.dpos.ipAddressManual) || '';
            // Advanced
            this._adv.logLevel.value = chain.logLevel || 'info';
            this._adv.archiveMode.checked = !!chain.archiveMode;
            this._adv.memory.value = String(chain.memoryLimitMb || 4096);
            this._adv.rpcUser.value = (chain.rpc && chain.rpc.user) || 'ela';
            // RPC password: stays empty in the form; submitting an empty string keeps the existing one.
            this._adv.rpcPassword.value = '';
            this._adv.rpcPassword.placeholder = (chain.rpc && chain.rpc.passwordSet)
                ? '(leave blank to keep current)' : 'set a password';
        }
        // General
        var g = cfg.global || {};
        this._gen.autoSafe.checked = !(g.healing && g.healing.autoExecuteSafe === false);
        this._gen.criticalAck.checked = !(g.notifications && g.notifications.criticalRequiresAck === false);
        this._gen.auditRetention.value = String((g.audit && g.audit.retentionDays) || 365);
    };

    /** @private */
    SettingsTab.prototype._detectIp = function () {
        // Settings → Network → "Detect now". Hits the system endpoint that
        // already wraps ExtIpResolver (see routes/system.js).
        this._network.statusLine.textContent = 'Detecting...';
        var self = this;
        this.api.get('/system/extip', { skipCache: true }).then(function (data) {
            if (data && data.ok && data.ip) {
                self._network.statusLine.textContent = 'Detected: ' + data.ip;
            } else {
                self._network.statusLine.textContent = 'Detection failed: ' + (data && data.reason ? data.reason : 'unknown');
            }
        }).catch(function (err) {
            self._network.statusLine.textContent = 'Detection failed: ' + (err.message || String(err));
        });
    };

    /** @private */
    SettingsTab.prototype._saveNetwork = function () {
        var mode = this._network.modeManual.checked ? 'manual' : 'auto';
        var manualValue = this._network.manualInput.value.trim();
        var self = this;
        this.api.put('/config/network', { mode: mode, manualValue: manualValue }).then(function () {
            self._network.statusLine.textContent = root.enmTOrFallback('settings.saved');
            self.refresh();
        }).catch(function (err) {
            self._network.statusLine.textContent = root.enmTOrFallback('settings.save_failed', { error: err.message });
        });
    };

    /** @private */
    SettingsTab.prototype._saveAdvanced = function () {
        // Client-side guard: server (joi schema in EnmConfigSchema) is the
        // authority, but giving the operator immediate inline feedback is
        // friendlier than a generic toast after the round-trip.
        var memMb = parseInt(this._adv.memory.value, 10);
        if (!Number.isInteger(memMb) || memMb < 512 || memMb > 32_768) {
            this._adv.statusLine.textContent = root.enmTOrFallback(
                'settings.save_failed', { error: 'Memory limit must be 512..32768 MB.' });
            return;
        }
        var rpcUser = this._adv.rpcUser.value.trim();
        if (rpcUser.length === 0 || !/^[A-Za-z0-9]+$/.test(rpcUser)) {
            this._adv.statusLine.textContent = root.enmTOrFallback(
                'settings.save_failed', { error: 'RPC user must be alphanumeric, non-empty.' });
            return;
        }

        var body = {
            logLevel: this._adv.logLevel.value,
            archiveMode: this._adv.archiveMode.checked,
            memoryLimitMb: memMb,
            rpcUser: rpcUser,
        };
        // RPC password is only sent if non-empty so the operator can edit
        // other knobs without re-typing it.
        var pw = this._adv.rpcPassword.value;
        if (pw && pw.length > 0) { body.rpcPassword = pw; }
        var self = this;
        this.api.put('/config/mainchain', body).then(function () {
            self._adv.statusLine.textContent = root.enmTOrFallback('settings.saved');
            self._adv.rpcPassword.value = '';
            self.refresh();
        }).catch(function (err) {
            self._adv.statusLine.textContent = root.enmTOrFallback('settings.save_failed', { error: err.message });
        });
    };

    /** @private */
    SettingsTab.prototype._saveGeneral = function () {
        var retention = parseInt(this._gen.auditRetention.value, 10);
        if (!Number.isInteger(retention) || retention < 0 || retention > 3650) {
            this._gen.statusLine.textContent = root.enmTOrFallback(
                'settings.save_failed', { error: 'Audit retention must be 0..3650 days (0 = forever).' });
            return;
        }
        var body = {
            autoExecuteSafe: this._gen.autoSafe.checked,
            criticalRequiresAck: this._gen.criticalAck.checked,
            auditRetentionDays: retention,
        };
        var self = this;
        this.api.put('/config/general', body).then(function () {
            self._gen.statusLine.textContent = root.enmTOrFallback('settings.saved');
            self.refresh();
        }).catch(function (err) {
            self._gen.statusLine.textContent = root.enmTOrFallback('settings.save_failed', { error: err.message });
        });
    };

    /**
     * @private
     * Danger-zone section. Three-stage gate to keep the wipe from being
     * triggered accidentally:
     *   1. The entire control surface is hidden behind a Show button.
     *   2. The wipe button stays disabled until the operator types WIPE
     *      into the confirm input.
     *   3. The wipe button itself is bright red and labeled unambiguously.
     *
     * Does NOT add a backend endpoint to ENM — calls PC2's existing
     * DELETE /api/installed-apps/<name>?purge=true (same origin, same
     * Bearer token), which already runs the teardown hook that backs up
     * keystore.dat before SIGTERMing this process.
     */
    SettingsTab.prototype._buildDangerZoneSection = function (t) {
        var section = document.createElement('div');
        section.className = 'enm-settings-section enm-settings-danger';

        var h = document.createElement('h3');
        h.textContent = t('settings.heading_danger');
        section.appendChild(h);

        var intro = document.createElement('p');
        intro.className = 'enm-settings-help';
        intro.textContent = t('settings.danger_intro');
        section.appendChild(intro);

        this._danger = {
            showBtn: btn(t('settings.danger_show_btn'), 'enm-btn-secondary',
                this._toggleDangerControls.bind(this)),
            controls: document.createElement('div'),
            confirmInput: null,
            wipeBtn: null,
            statusLine: document.createElement('p'),
        };
        this._danger.controls.className = 'enm-danger-controls';
        this._danger.controls.style.display = 'none';
        this._danger.statusLine.className = 'enm-settings-status';

        // Build the hidden controls once and toggle visibility, so the form
        // state survives an open/close cycle.
        var keptH = document.createElement('div');
        keptH.className = 'enm-danger-section-h enm-danger-section-h-kept';
        keptH.textContent = t('settings.danger_kept_h');
        this._danger.controls.appendChild(keptH);

        var keptUl = document.createElement('ul');
        keptUl.className = 'enm-danger-list';
        var keptLi1 = document.createElement('li');
        keptLi1.textContent = t('settings.danger_kept_li1');
        keptUl.appendChild(keptLi1);
        var keptCode = document.createElement('code');
        keptCode.className = 'enm-danger-code';
        keptCode.textContent = t('settings.danger_kept_path');
        keptUl.appendChild(keptCode);
        var keptLi2 = document.createElement('li');
        keptLi2.textContent = t('settings.danger_kept_li2');
        keptUl.appendChild(keptLi2);
        this._danger.controls.appendChild(keptUl);

        var wipedH = document.createElement('div');
        wipedH.className = 'enm-danger-section-h enm-danger-section-h-wiped';
        wipedH.textContent = t('settings.danger_wiped_h');
        this._danger.controls.appendChild(wipedH);

        var wipedUl = document.createElement('ul');
        wipedUl.className = 'enm-danger-list';
        ['danger_wiped_li1', 'danger_wiped_li2', 'danger_wiped_li3'].forEach(function (k) {
            var li = document.createElement('li');
            li.textContent = t('settings.' + k);
            wipedUl.appendChild(li);
        });
        this._danger.controls.appendChild(wipedUl);

        var confirmH = document.createElement('div');
        confirmH.className = 'enm-danger-section-h';
        confirmH.textContent = t('settings.danger_confirm_h');
        this._danger.controls.appendChild(confirmH);

        var confirmRow = document.createElement('div');
        confirmRow.className = 'enm-danger-confirm-row';
        this._danger.confirmInput = document.createElement('input');
        this._danger.confirmInput.type = 'text';
        this._danger.confirmInput.className = 'enm-settings-input';
        this._danger.confirmInput.placeholder = t('settings.danger_confirm_ph');
        this._danger.confirmInput.autocomplete = 'off';
        this._danger.confirmInput.spellcheck = false;
        this._danger.confirmInput.addEventListener('input',
            this._refreshDangerEnabled.bind(this));
        confirmRow.appendChild(this._danger.confirmInput);

        this._danger.wipeBtn = btn(t('settings.danger_wipe_btn'), 'enm-btn-danger',
            this._doWipe.bind(this));
        this._danger.wipeBtn.disabled = true;
        confirmRow.appendChild(this._danger.wipeBtn);
        this._danger.controls.appendChild(confirmRow);

        var actions = document.createElement('div'); actions.className = 'enm-settings-actions';
        actions.appendChild(this._danger.showBtn);
        section.appendChild(actions);
        section.appendChild(this._danger.controls);
        section.appendChild(this._danger.statusLine);

        this._sections.danger = section;
        return section;
    };

    /** @private */
    SettingsTab.prototype._toggleDangerControls = function () {
        var t = root.enmTOrFallback;
        var hidden = this._danger.controls.style.display === 'none';
        if (hidden) {
            this._danger.controls.style.display = '';
            this._danger.showBtn.textContent = t('settings.danger_hide_btn');
        } else {
            this._danger.controls.style.display = 'none';
            this._danger.showBtn.textContent = t('settings.danger_show_btn');
            this._danger.confirmInput.value = '';
            this._refreshDangerEnabled();
            this._danger.statusLine.textContent = '';
        }
    };

    /** @private */
    SettingsTab.prototype._refreshDangerEnabled = function () {
        // alpha.11: compare case-insensitively. The input has
        // text-transform: uppercase in CSS, which makes "wipe" LOOK like
        // "WIPE" on screen but the underlying value stays lowercase —
        // so a strict `!== 'WIPE'` left the button permanently disabled
        // for anyone who typed in lowercase. The operator intent is
        // clearly "I typed the magic word" regardless of case.
        var typed = (this._danger.confirmInput.value || '').trim().toUpperCase();
        this._danger.wipeBtn.disabled = (typed !== 'WIPE');
    };

    /**
     * @private
     * Calls PC2's installed-apps uninstall endpoint with purge=true. This
     * is a SAME-ORIGIN request (PC2 serves both pc2-node and the ENM
     * frontend), so we hit window.location.origin — NOT the :4180 backend
     * the rest of api.js talks to.
     *
     * Once PC2 starts the teardown, our own backend (and therefore this
     * page) will get killed mid-request. The fetch may resolve with the
     * uninstall response OR fail with a network error if the kill is
     * faster than the response. We treat both as success and redirect.
     */
    SettingsTab.prototype._doWipe = function () {
        var t = root.enmTOrFallback;
        var self = this;

        // Lock the UI immediately so a double-click can't fire two requests.
        this._danger.wipeBtn.disabled = true;
        this._danger.showBtn.disabled = true;
        this._danger.confirmInput.disabled = true;
        this._danger.statusLine.textContent = t('settings.danger_in_progress');
        this._danger.statusLine.style.color = '';

        var token = (this.api && this.api.token) || null;
        var headers = { 'Accept': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        var url = root.location.origin + '/api/installed-apps/elastos-node-manager?purge=true';

        fetch(url, { method: 'DELETE', credentials: 'include', headers: headers })
            .then(function (res) {
                return res.text().then(function (text) {
                    var parsed = null;
                    try { parsed = JSON.parse(text); } catch (_) { /* fall through */ }
                    if (!res.ok) {
                        var msg = (parsed && (parsed.error || parsed.message))
                            || ('HTTP ' + res.status);
                        throw new Error(msg);
                    }
                    return parsed;
                });
            })
            .then(function (parsed) {
                self._handleWipeSuccess(parsed);
            })
            .catch(function (err) {
                // ENM died mid-request — treat as success and redirect.
                // Any TypeError fetch failure here means the connection
                // was killed by SIGTERM (expected). Distinguish from a
                // genuine HTTP error (which we threw above with a Message).
                if (err && err.message && err.message.indexOf('HTTP ') === 0) {
                    self._handleWipeFailure(err);
                } else if (err && err.name === 'TypeError') {
                    // Likely a NetworkError from the killed connection.
                    self._handleWipeSuccess(null);
                } else {
                    self._handleWipeFailure(err);
                }
            });
    };

    /** @private */
    SettingsTab.prototype._handleWipeSuccess = function (response) {
        var t = root.enmTOrFallback;
        var path = (response && response.keystore && response.keystore.backup_path)
            || (response && response.keystore_backed_up && response.backup_path)
            || '/var/lib/pc2/data/backups/elastos-node-manager/';
        this._danger.statusLine.style.color = '';
        this._danger.statusLine.textContent = t('settings.danger_done', { path: path });

        // alpha.16 — actually close the ENM app window instead of
        // navigating it to PC2 home. Reloading the iframe to '/' was
        // wrong: it dropped the entire Puter desktop into the ENM
        // window chrome, which left the operator looking at the
        // desktop inside an "Elastos Node Manager" title bar.
        //
        // Puter's IPC supports a clean exit: postMessage to the parent
        // with msg='exit' and our app instance ID, and PC2's UIWindow
        // closes our window for us (src/gui/src/IPC.js handles it).
        // The appInstanceID is on the URL params that PC2 hands us
        // when launching (puter.app_instance_id).
        //
        // 4-second delay so the operator reads the keystore-backup
        // path before the window vanishes.
        var closeAfter = 4000;
        setTimeout(function () {
            try {
                var params = new URLSearchParams(root.location.search || '');
                var instanceId = params.get('puter.app_instance_id');
                if (instanceId && root.parent && root.parent !== root) {
                    root.parent.postMessage({
                        msg: 'exit',
                        appInstanceID: instanceId,
                        statusCode: 0,
                    }, '*');
                    return;
                }
            } catch (_) { /* fall through to fallback */ }
            // Fallback for non-Puter contexts (rare — direct browser visit
            // to the ENM iframe URL): try window.close(), then a blank
            // page so the operator sees something other than a stale UI.
            try { root.close(); } catch (_) { /* not allowed */ }
            try { root.location.replace('about:blank'); } catch (_) { /* nothing more we can do */ }
        }, closeAfter);
    };

    /** @private */
    SettingsTab.prototype._handleWipeFailure = function (err) {
        var t = root.enmTOrFallback;
        this._danger.statusLine.style.color = 'var(--danger, #c0392b)';
        this._danger.statusLine.textContent = t('settings.danger_failed',
            { error: (err && err.message) || String(err) });
        // Re-enable so the operator can retry or back out.
        this._danger.wipeBtn.disabled = false;
        this._danger.showBtn.disabled = false;
        this._danger.confirmInput.disabled = false;
        this._refreshDangerEnabled();
    };

    function radio(name, value) {
        var i = document.createElement('input'); i.type = 'radio'; i.name = name; i.value = value;
        return i;
    }
    function checkbox() {
        var i = document.createElement('input'); i.type = 'checkbox'; return i;
    }
    function textInput() {
        var i = document.createElement('input'); i.type = 'text';
        i.className = 'enm-settings-input'; return i;
    }
    /**
     * chipInput — small inline pill-list editor for IPv4/CIDR entries.
     * Mirrors the textInput "looks like an input from the outside" pattern:
     * exposes .getValue() / .setValue() and a .value mirror so the rest of
     * the form fill/save code stays simple. Validation is client-side only
     * (the joi schema on the server is still the authority); on invalid we
     * flash a red border on the inline editor without committing the chip.
     *
     * Backend (whiteIPList in EnmConfigSchema) accepts string[], so this
     * replaces the previous comma-joined single-line input which had no
     * way to surface a per-entry parse error.
     */
    var IP_OR_CIDR_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?$/;

    function chipInput() {
        // Container is the "input-shaped" thing the rest of the form treats
        // as a single field. Internal layout: chip list on top, editor row
        // on the bottom.
        var container = document.createElement('div');
        container.className = 'enm-settings-input enm-chip-input';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '6px';
        container.style.padding = '6px';
        container.style.minHeight = '34px';
        container.style.height = 'auto';
        container.style.alignItems = 'stretch';

        var chipsWrap = document.createElement('div');
        chipsWrap.style.display = 'flex';
        chipsWrap.style.flexWrap = 'wrap';
        chipsWrap.style.gap = '4px';
        container.appendChild(chipsWrap);

        var editorRow = document.createElement('div');
        editorRow.style.display = 'flex';
        editorRow.style.gap = '6px';
        editorRow.style.alignItems = 'center';
        container.appendChild(editorRow);

        var newInput = document.createElement('input');
        newInput.type = 'text';
        newInput.placeholder = '127.0.0.1 or 192.168.0.0/24';
        newInput.style.flex = '1';
        newInput.style.minWidth = '0';
        newInput.style.padding = '4px 8px';
        newInput.style.border = '1px solid var(--enm-border, #cfd6dd)';
        newInput.style.borderRadius = '4px';
        newInput.style.background = 'transparent';
        newInput.style.color = 'inherit';
        newInput.style.font = 'inherit';
        editorRow.appendChild(newInput);

        var addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = 'Add';
        addBtn.style.display = 'inline-flex';
        addBtn.style.alignItems = 'center';
        addBtn.style.justifyContent = 'center';
        addBtn.style.padding = '4px 10px';
        addBtn.style.fontSize = '13px';
        addBtn.style.lineHeight = '1';
        addBtn.style.fontFamily = 'inherit';
        addBtn.style.border = '1px solid var(--enm-border, #cfd6dd)';
        addBtn.style.borderRadius = '4px';
        addBtn.style.background = 'var(--enm-surface, #f5f7fa)';
        addBtn.style.color = 'inherit';
        addBtn.style.cursor = 'pointer';
        editorRow.appendChild(addBtn);

        var values = [];

        // Re-render the chip pills from the current values[] array. Cheap to
        // do on every mutation — the list is small (operator-edited, not a
        // server feed).
        function renderChips() {
            chipsWrap.innerHTML = '';
            values.forEach(function (v, idx) {
                var chip = document.createElement('span');
                chip.style.display = 'inline-flex';
                chip.style.alignItems = 'center';
                chip.style.gap = '4px';
                chip.style.padding = '2px 6px 2px 8px';
                chip.style.fontSize = '12px';
                chip.style.lineHeight = '1.4';
                chip.style.border = '1px solid var(--enm-border, #cfd6dd)';
                chip.style.borderRadius = '10px';
                chip.style.background = 'var(--enm-surface, #f5f7fa)';

                var text = document.createElement('span');
                text.textContent = v;
                chip.appendChild(text);

                var remove = document.createElement('button');
                remove.type = 'button';
                remove.setAttribute('aria-label', 'Remove ' + v);
                remove.textContent = '×';
                remove.style.display = 'inline-flex';
                remove.style.alignItems = 'center';
                remove.style.justifyContent = 'center';
                remove.style.width = '16px';
                remove.style.height = '16px';
                remove.style.padding = '0';
                remove.style.fontSize = '14px';
                remove.style.lineHeight = '1';
                remove.style.fontFamily = 'inherit';
                remove.style.border = 'none';
                remove.style.borderRadius = '50%';
                remove.style.background = 'transparent';
                remove.style.color = 'inherit';
                remove.style.cursor = 'pointer';
                remove.addEventListener('click', function () {
                    values.splice(idx, 1);
                    syncValueMirror();
                    renderChips();
                });
                chip.appendChild(remove);
                chipsWrap.appendChild(chip);
            });
        }

        // Mirror values back to .value as a comma-joined string so any code
        // that still reads it (e.g. read-only inspection) sees a sane shape.
        // Authoritative reads/writes go through getValue/setValue.
        function syncValueMirror() {
            container.value = values.join(', ');
        }

        function flashInvalid() {
            var prev = newInput.style.borderColor;
            newInput.style.borderColor = 'var(--danger, #c0392b)';
            setTimeout(function () { newInput.style.borderColor = prev; }, 900);
        }

        function tryAdd() {
            var candidate = (newInput.value || '').trim();
            if (!candidate) { return; }
            if (!IP_OR_CIDR_RE.test(candidate)) { flashInvalid(); return; }
            // Dedupe — silently ignore exact duplicates.
            if (values.indexOf(candidate) !== -1) {
                newInput.value = '';
                return;
            }
            values.push(candidate);
            newInput.value = '';
            syncValueMirror();
            renderChips();
        }

        addBtn.addEventListener('click', tryAdd);
        newInput.addEventListener('keydown', function (e) {
            // Enter and comma both commit; comma is natural for operators
            // pasting a single CSV line.
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                tryAdd();
            }
        });

        container.getValue = function () { return values.slice(); };
        container.setValue = function (arr) {
            values = Array.isArray(arr) ? arr.filter(function (s) {
                return typeof s === 'string' && s.length > 0;
            }) : [];
            syncValueMirror();
            renderChips();
        };
        syncValueMirror();
        renderChips();
        return container;
    }
    function passwordInput() {
        var i = document.createElement('input'); i.type = 'password';
        i.autocomplete = 'new-password'; i.className = 'enm-settings-input'; return i;
    }
    function numberInput(min, max) {
        var i = document.createElement('input'); i.type = 'number';
        i.min = String(min); i.max = String(max); i.className = 'enm-settings-input';
        return i;
    }
    function select(options) {
        var s = document.createElement('select'); s.className = 'enm-settings-input';
        options.forEach(function (o) {
            var opt = document.createElement('option'); opt.value = o; opt.textContent = o;
            s.appendChild(opt);
        });
        return s;
    }
    function label(input, text) {
        var l = document.createElement('label'); l.className = 'enm-settings-label';
        l.appendChild(input);
        var span = document.createElement('span'); span.textContent = text;
        l.appendChild(span);
        return l;
    }
    function btn(text, cls, onClick) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'enm-btn ' + cls;
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    /**
     * Render a single label + value row inside the credentials panel.
     * Value is wrapped in credValueWithCopy() so the operator can copy
     * straight to clipboard without selecting.
     */
    function rpcUrlRow(label, url, warning) {
        var row = document.createElement('div');
        row.className = 'enm-rpc-url-row';
        var l = document.createElement('span');
        l.className = 'enm-rpc-url-label';
        l.textContent = label;
        row.appendChild(l);
        row.appendChild(credValueWithCopy(url));
        if (warning) {
            var w = document.createElement('p');
            w.className = 'enm-rpc-url-warning';
            w.textContent = warning;
            row.appendChild(w);
        }
        return row;
    }

    // Classify an http://IP:port URL as 'loopback' | 'private' | 'public'.
    // RFC-1918 (10/8, 172.16/12, 192.168/16) + link-local (169.254/16) all
    // count as 'private' so accidental APIPA addresses don't render as
    // "Public internet" and mislead the operator.
    function classifyUrlAddress(url) {
        try {
            var u = new URL(url);
            var h = u.hostname;
            if (h === 'localhost' || /^127\./.test(h) || h === '::1') return 'loopback';
            var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
            if (!m) return 'public'; // hostname or IPv6 — treat as public to be safe
            var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            if (a === 10) return 'private';
            if (a === 172 && b >= 16 && b <= 31) return 'private';
            if (a === 192 && b === 168) return 'private';
            if (a === 169 && b === 254) return 'private';
            return 'public';
        } catch (_e) { return 'public'; }
    }

    function credRow(labelText, value) {
        var wrap = document.createElement('div');
        wrap.className = 'enm-rpc-creds-row';
        var l = document.createElement('span');
        l.className = 'enm-rpc-creds-label';
        l.textContent = labelText;
        wrap.appendChild(l);
        wrap.appendChild(credValueWithCopy(value == null ? '' : String(value)));
        return wrap;
    }

    /**
     * Password row gets a Show/Hide toggle on top of the standard copy button.
     * Read straight off the SettingsTab instance so the toggle state survives
     * a re-render of the panel.
     */
    function credPasswordRow(tab, t) {
        var wrap = document.createElement('div');
        wrap.className = 'enm-rpc-creds-row';
        var l = document.createElement('span');
        l.className = 'enm-rpc-creds-label';
        l.textContent = t('settings.rpc_field_pw');
        wrap.appendChild(l);

        var pw = (tab._creds.data && tab._creds.data.password) || '';
        var shown = !!tab._creds.pwShown;
        var displayed = shown ? pw : pw.replace(/./g, '•');

        wrap.appendChild(credValueWithCopy(pw, displayed));

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'enm-btn enm-btn-secondary enm-rpc-creds-toggle';
        toggle.textContent = shown ? t('settings.rpc_hide_pw') : t('settings.rpc_show_pw');
        toggle.addEventListener('click', tab._togglePwVisibility.bind(tab));
        wrap.appendChild(toggle);
        return wrap;
    }

    /**
     * Read-only value rendered next to a Copy button. `display` lets callers
     * (the password row) show a masked version while still copying the real
     * value to the clipboard.
     */
    function credValueWithCopy(value, display) {
        var line = document.createElement('span');
        line.className = 'enm-rpc-creds-value-wrap';

        var span = document.createElement('span');
        span.className = 'enm-rpc-creds-value';
        span.textContent = display != null ? display : value;
        line.appendChild(span);

        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'enm-btn enm-btn-secondary enm-rpc-creds-copy';
        copyBtn.textContent = root.enmTOrFallback('settings.rpc_copy');
        copyBtn.addEventListener('click', function () {
            var p = (navigator.clipboard && navigator.clipboard.writeText)
                ? navigator.clipboard.writeText(value)
                : Promise.reject(new Error('clipboard unavailable'));
            p.then(function () {
                var prev = copyBtn.textContent;
                copyBtn.textContent = root.enmTOrFallback('settings.rpc_copied');
                setTimeout(function () { copyBtn.textContent = prev; }, 1200);
            }).catch(function () {
                // Fallback: select the value so the operator can ctrl-c
                var range = document.createRange();
                range.selectNodeContents(span);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
        });
        line.appendChild(copyBtn);
        return line;
    }

    root.EnmSettingsTab = SettingsTab;
}(typeof window !== 'undefined' ? window : globalThis));
