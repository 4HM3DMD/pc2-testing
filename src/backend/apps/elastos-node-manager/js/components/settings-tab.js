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
        // Danger zone always rendered last so it doesn't draw the eye on
        // first scan and the operator has to scroll past everything else.
        this.root.appendChild(this._buildDangerZoneSection(t));
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
        var typed = (this._danger.confirmInput.value || '').trim();
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
        // Force a FULL page load on the top window — not an SPA navigation.
        //
        // Why this matters: without a full reload, PC2's desktop keeps its
        // in-memory list of installed apps and the just-wiped tile lingers
        // on the launcher. Clicking it opens a window for an app whose
        // bundle is gone and the user sees a stuck "Initializing..." spinner.
        //
        // We're usually loaded inside a Puter window (iframe of /apps/...),
        // so root.top !== root. Navigating root.top.location forces the
        // outer desktop to do a fresh GET / and re-fetch /api/installed-apps,
        // at which point ENM is correctly absent. The ?app-uninstalled
        // hint is purely informational — PC2 doesn't read it today, but
        // it's a hook future code can use to show a "X uninstalled" toast.
        //
        // Try/catch guards against same-origin policy weirdness: if we
        // somehow can't touch root.top, fall back to the current window.
        var redirectAfter = 5000;
        setTimeout(function () {
            try {
                var top = root.top || root;
                top.location.href = top.location.origin
                    + '/?app-uninstalled=elastos-node-manager';
            } catch (_) {
                root.location.href = '/?app-uninstalled=elastos-node-manager';
            }
        }, redirectAfter);
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
