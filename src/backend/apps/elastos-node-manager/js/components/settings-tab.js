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

    /** @private */
    SettingsTab.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        this._sections = {};
        this.root.appendChild(this._buildNetworkSection(t));
        this.root.appendChild(this._buildAdvancedSection(t));
        this.root.appendChild(this._buildRpcCredsSection(t));
        this.root.appendChild(this._buildGeneralSection(t));
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
            whiteIp:     textInput(),
        };

        var rows = [
            [t('settings.adv_log_level'),   this._adv.logLevel],
            [t('settings.adv_archive_mode'), this._adv.archiveMode],
            [t('settings.adv_memory_limit'), this._adv.memory],
            [t('settings.adv_rpc_user'),    this._adv.rpcUser],
            [t('settings.adv_rpc_password'), this._adv.rpcPassword],
            [t('settings.adv_white_ip'),    this._adv.whiteIp],
        ];
        rows.forEach(function (r) {
            var row = document.createElement('div'); row.className = 'enm-settings-row';
            row.appendChild(label(r[1], r[0]));
            section.appendChild(row);
        });

        var whiteIpHelp = document.createElement('p');
        whiteIpHelp.className = 'enm-settings-help';
        whiteIpHelp.textContent = t('settings.adv_white_ip_help');
        section.appendChild(whiteIpHelp);

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

        this._creds = {
            revealBtn: btn(t('settings.rpc_reveal_btn'), 'enm-btn-secondary',
                this._toggleCreds.bind(this)),
            panel: document.createElement('div'),
            statusLine: document.createElement('p'),
            data: null,
            pwShown: false,
        };
        this._creds.panel.className = 'enm-rpc-creds-panel';
        this._creds.panel.style.display = 'none';
        this._creds.statusLine.className = 'enm-settings-status';

        var actions = document.createElement('div'); actions.className = 'enm-settings-actions';
        actions.appendChild(this._creds.revealBtn);
        section.appendChild(actions);
        section.appendChild(this._creds.panel);
        section.appendChild(this._creds.statusLine);

        this._sections.rpcCreds = section;
        return section;
    };

    /** @private */
    SettingsTab.prototype._toggleCreds = function () {
        var t = root.enmTOrFallback;
        // If already shown, hide and forget.
        if (this._creds.panel.style.display !== 'none') {
            this._creds.panel.style.display = 'none';
            this._creds.panel.innerHTML = '';
            this._creds.data = null;
            this._creds.pwShown = false;
            this._creds.revealBtn.textContent = t('settings.rpc_reveal_btn');
            this._creds.statusLine.textContent = '';
            return;
        }
        var self = this;
        this._creds.statusLine.textContent = t('common.loading');
        this.api.get('/config/rpc/credentials/mainchain', { skipCache: true }).then(function (data) {
            self._creds.data = data;
            self._creds.pwShown = false;
            self._renderCredsPanel();
            self._creds.panel.style.display = '';
            self._creds.revealBtn.textContent = t('settings.rpc_hide_btn');
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

        // Plain rows
        p.appendChild(credRow(t('settings.rpc_field_user'), d.user));
        p.appendChild(credPasswordRow(this, t));
        p.appendChild(credRow(t('settings.rpc_field_local'), d.localUrl));

        // LAN URLs — list (one per interface)
        var lanWrap = document.createElement('div');
        lanWrap.className = 'enm-rpc-creds-row';
        var lanLabel = document.createElement('span');
        lanLabel.className = 'enm-rpc-creds-label';
        lanLabel.textContent = t('settings.rpc_field_lan');
        lanWrap.appendChild(lanLabel);
        if (Array.isArray(d.lanUrls) && d.lanUrls.length > 0) {
            d.lanUrls.forEach(function (u) {
                lanWrap.appendChild(credValueWithCopy(u));
            });
        } else {
            var none = document.createElement('span');
            none.className = 'enm-rpc-creds-empty';
            none.textContent = t('settings.rpc_no_lan');
            lanWrap.appendChild(none);
        }
        p.appendChild(lanWrap);

        // WhiteIPList — show as comma-joined string
        p.appendChild(credRow(t('settings.rpc_field_white'),
            (d.whiteIPList || []).join(', ')));
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
            this._adv.whiteIp.value = (chain.rpc && Array.isArray(chain.rpc.whiteIPList))
                ? chain.rpc.whiteIPList.join(', ') : '127.0.0.1';
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
            whiteIPList: this._adv.whiteIp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
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
