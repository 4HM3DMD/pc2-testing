/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/setup-wizard.js — first-run wizard (Phase 3 skeleton).
 *
 * Phase 3 ships a 6-step skeleton that wires up to the existing
 * /api/setup/preflight + /api/setup/binary endpoints. Phase 5 will fill in:
 *   - Keystore import step (file picker + password)
 *   - Network override step (extip auto/manual + reachability probe)
 *   - Confirm + start step
 *
 * For Phase 3 the skeleton is enough to let an operator complete the wizard
 * far enough to land on the dashboard, even if the keystore/network steps
 * remain stubs.
 */

(function (root) {
    'use strict';

    var STEPS = [
        'welcome',
        'os',
        'disk',
        'wallet',
        'binary',
        'keystore',
        'network',
        'confirm',
        'complete',
    ];

    function SetupWizard(opts) {
        if (!opts || !opts.api || !opts.notifications) {
            throw new TypeError('SetupWizard: { api, notifications } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.sse = opts.sse || null;  // optional — auto-install live progress
        this.onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : function () {};

        this.root = document.createElement('section');
        this.root.className = 'enm-wizard';
        this._currentStep = 'welcome';
        this._preflight = null;
        // Choices the wizard collects across steps. Persisted server-side via
        // /setup/keystore + /setup/network; held here so the confirm step can
        // show a summary without an extra GET.
        this._choices = {
            binaryPath: null,
            binaryVersion: null,
            enableArbiter: true,
            keystoreImported: false,
            ipMode: 'auto',
            ipManual: '',
            extipDetected: null,
        };
        this._renderShell();
    }

    SetupWizard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._goto(this._currentStep);
        return this;
    };

    SetupWizard.prototype.destroy = function () {
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    SetupWizard.prototype._renderShell = function () {
        // Step indicator at the top.
        this._stepIndicator = document.createElement('ol');
        this._stepIndicator.className = 'enm-wizard-steps';
        this._stepNodes = {};
        STEPS.forEach(function (step) {
            var li = document.createElement('li');
            li.className = 'enm-wizard-step';
            li.dataset.step = step;
            li.textContent = step;
            this._stepIndicator.appendChild(li);
            this._stepNodes[step] = li;
        }, this);
        this.root.appendChild(this._stepIndicator);

        // Body container — re-rendered per step.
        this._body = document.createElement('div');
        this._body.className = 'enm-wizard-body';
        this.root.appendChild(this._body);
    };

    /** @private */
    SetupWizard.prototype._goto = function (step) {
        this._currentStep = step;
        Object.keys(this._stepNodes).forEach(function (k) {
            this._stepNodes[k].classList.toggle('enm-wizard-step-active', k === step);
            this._stepNodes[k].classList.toggle('enm-wizard-step-done',
                STEPS.indexOf(k) < STEPS.indexOf(step));
        }, this);
        this._body.innerHTML = '';
        var renderer = this['_render_' + step];
        if (typeof renderer === 'function') {
            renderer.call(this);
        } else {
            this._body.appendChild(makePara('Step "' + step + '" not implemented yet — Phase 5.'));
        }
    };

    SetupWizard.prototype._render_welcome = function () {
        var t = root.enmTOrFallback;
        this._body.appendChild(makeHeading(t('wizard.welcome_heading')));
        this._body.appendChild(makePara(t('wizard.welcome_body')));
        var self = this;
        this._body.appendChild(makeBtn('Continue', function () { self._goto('os'); }));
    };

    SetupWizard.prototype._render_os = function () {
        var self = this;
        this._body.appendChild(makeHeading(root.enmTOrFallback('wizard.step_os')));
        var status = makePara('Checking...');
        this._body.appendChild(status);
        this._loadPreflight().then(function (pre) {
            if (pre.os.ok) {
                status.textContent = root.enmTOrFallback('wizard.os_ok', {
                    distroId: pre.os.distroId || pre.os.platform,
                    version: pre.os.version || '',
                });
                self._body.appendChild(makeBtn('Continue', function () { self._goto('disk'); }));
            } else {
                status.textContent = root.enmTOrFallback('wizard.os_fail', { reason: pre.os.reason || '' });
                self._body.appendChild(makePara('Cannot proceed on this OS in v0.1.'));
            }
        }).catch(function (err) {
            status.textContent = err.message;
        });
    };

    SetupWizard.prototype._render_disk = function () {
        var self = this;
        this._body.appendChild(makeHeading(root.enmTOrFallback('wizard.step_disk')));
        var status = makePara('Checking...');
        this._body.appendChild(status);
        this._loadPreflight().then(function (pre) {
            var d = pre.disk;
            if (d.status === 'good') {
                status.textContent = root.enmTOrFallback('wizard.disk_ok', { freeGb: d.freeGb.toFixed(1) });
            } else if (d.status === 'warning') {
                status.textContent = root.enmTOrFallback('wizard.disk_warn', { freeGb: d.freeGb.toFixed(1) });
            } else {
                status.textContent = root.enmTOrFallback('wizard.disk_fail');
            }
            if (d.ok) {
                self._body.appendChild(makeBtn('Continue', function () { self._goto('wallet'); }));
            }
        }).catch(function (err) {
            status.textContent = err.message;
        });
    };

    SetupWizard.prototype._render_wallet = function () {
        var self = this;
        this._body.appendChild(makeHeading(root.enmTOrFallback('wizard.step_wallet')));
        var status = makePara('Checking...');
        this._body.appendChild(status);
        this._loadPreflight().then(function (pre) {
            if (pre.wallet && pre.wallet.ok) {
                status.textContent = root.enmTOrFallback('wizard.wallet_ok', { wallet: pre.wallet.walletAddress });
                self._body.appendChild(makeBtn('Continue', function () { self._goto('binary'); }));
            } else {
                status.textContent = root.enmTOrFallback('wizard.wallet_fail');
            }
        });
    };

    SetupWizard.prototype._render_binary = function () {
        var self = this;
        var t = root.enmTOrFallback;
        this._body.appendChild(makeHeading(t('wizard.step_binary')));
        this._body.appendChild(makePara(t('wizard.binary_help')));

        // Two paths: auto-install (recommended) or manual path entry.
        var pathSelector = document.createElement('div');
        pathSelector.className = 'enm-wizard-radio-row';
        var modeAuto = document.createElement('input');
        modeAuto.type = 'radio'; modeAuto.name = 'wizardBinMode'; modeAuto.value = 'auto';
        modeAuto.checked = true;
        var modeManual = document.createElement('input');
        modeManual.type = 'radio'; modeManual.name = 'wizardBinMode'; modeManual.value = 'manual';
        pathSelector.appendChild(labelEl(modeAuto, t('wizard.binary_auto_btn')));
        pathSelector.appendChild(labelEl(modeManual, t('wizard.binary_manual_btn')));
        this._body.appendChild(pathSelector);

        // Auto-install panel
        var autoPanel = document.createElement('div');
        autoPanel.className = 'enm-wizard-auto-panel';

        var startBtn = makeBtn(t('wizard.binary_auto_btn'), function () {
            self._startAutoInstall(autoPanel);
        });
        autoPanel.appendChild(startBtn);

        // Manual panel (existing flow)
        var manualPanel = document.createElement('div');
        manualPanel.className = 'enm-wizard-manual-panel';
        manualPanel.style.display = 'none';

        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = t('wizard.binary_placeholder');
        input.className = 'enm-wizard-binary-input';
        input.setAttribute('aria-label', t('wizard.binary_label'));
        manualPanel.appendChild(input);
        var manualStatus = makePara('');
        manualPanel.appendChild(manualStatus);
        var verifyBtn = makeBtn(t('wizard.binary_manual_verify_btn'), function () {
            manualStatus.textContent = t('wizard.binary_validating');
            verifyBtn.disabled = true;
            self.api.post('/setup/binary', { binaryPath: input.value.trim() }).then(function (result) {
                manualStatus.textContent = t('wizard.binary_ok', { version: result.version });
                self._choices.binaryPath = result.resolvedPath;
                self._choices.binaryVersion = result.version;
                manualPanel.appendChild(makeBtn(t('wizard.build_continue_btn'),
                    function () { self._goto('keystore'); }));
            }).catch(function (err) {
                manualStatus.textContent = t('wizard.binary_fail', { reason: err.message });
                verifyBtn.disabled = false;
            });
        });
        manualPanel.appendChild(verifyBtn);

        this._body.appendChild(autoPanel);
        this._body.appendChild(manualPanel);

        function applyMode() {
            autoPanel.style.display   = modeAuto.checked   ? '' : 'none';
            manualPanel.style.display = modeManual.checked ? '' : 'none';
        }
        modeAuto.addEventListener('change', applyMode);
        modeManual.addEventListener('change', applyMode);
        applyMode();
    };

    /**
     * Kick off the auto-install pipeline and render live progress in the
     * given panel. The pipeline runs on the server (lib/EnmAutoBuilder); we
     * subscribe to SSE topic `setup:build` for phase + log updates and fall
     * back to polling /setup/build-status if SSE is silent for >5s.
     *
     * @private
     */
    SetupWizard.prototype._startAutoInstall = function (panel) {
        var self = this;
        var t = root.enmTOrFallback;

        // Replace the button with the live-progress UI.
        panel.innerHTML = '';

        var phaseLabel = document.createElement('p');
        phaseLabel.className = 'enm-wizard-build-phase';
        phaseLabel.textContent = t('wizard.build_phase_preparing');
        panel.appendChild(phaseLabel);

        var barWrap = document.createElement('div');
        barWrap.className = 'enm-wizard-build-bar-wrap';
        barWrap.setAttribute('role', 'progressbar');
        barWrap.setAttribute('aria-valuemin', '0');
        barWrap.setAttribute('aria-valuemax', '100');
        var bar = document.createElement('div');
        bar.className = 'enm-wizard-build-bar';
        barWrap.appendChild(bar);
        panel.appendChild(barWrap);

        var logHeading = document.createElement('p');
        logHeading.className = 'enm-wizard-build-log-heading';
        logHeading.textContent = t('wizard.build_log_heading');
        panel.appendChild(logHeading);

        var logBox = document.createElement('pre');
        logBox.className = 'enm-wizard-build-log';
        logBox.setAttribute('aria-live', 'polite');
        panel.appendChild(logBox);

        var actions = document.createElement('div');
        actions.className = 'enm-wizard-build-actions';
        var cancelBtn = makeBtn(t('wizard.build_cancel_btn'), function () {
            self.api.del('/setup/auto-install-ela').catch(function () { /* idempotent */ });
        });
        actions.appendChild(cancelBtn);
        panel.appendChild(actions);

        // Map server phase → percent + label. Approximate — exact percent
        // isn't knowable until make finishes, but the phases give the
        // operator a meaningful "where am I" signal.
        var PHASE_PERCENT = {
            'preparing': 5, 'fetching-go': 15, 'cloning': 30,
            'building': 60, 'verifying': 95, 'done': 100,
            'failed': 0, 'cancelled': 0, 'idle': 0,
        };
        function applyStatus(status) {
            if (!status || !status.phase) return;
            phaseLabel.textContent = t('wizard.build_phase_' + status.phase.replace(/-/g, '_')) || status.phase;
            var pct = PHASE_PERCENT[status.phase];
            if (pct != null) {
                bar.style.width = pct + '%';
                barWrap.setAttribute('aria-valuenow', String(pct));
            }
            if (Array.isArray(status.logTail)) {
                logBox.textContent = status.logTail.join('\n');
                logBox.scrollTop = logBox.scrollHeight;
            }
            if (status.phase === 'done') {
                cancelBtn.remove();
                self._choices.binaryPath = status.resolvedPath;
                self._choices.binaryVersion = status.version;
                actions.appendChild(makeBtn(t('wizard.build_continue_btn'), function () {
                    self._goto('keystore');
                }));
            } else if (status.phase === 'failed') {
                cancelBtn.remove();
                if (status.error) {
                    var errLine = document.createElement('p');
                    errLine.className = 'enm-wizard-build-error';
                    errLine.textContent = status.error;
                    panel.insertBefore(errLine, logBox);
                }
                actions.appendChild(makeBtn(t('wizard.build_retry_btn'), function () {
                    self._startAutoInstall(panel);
                }));
            }
        }

        // SSE subscription — live updates.
        var unsub = null;
        if (self.sse && typeof self.sse.subscribe === 'function') {
            unsub = self.sse.subscribe('setup:build', function (payload) {
                if (payload && payload.phase) {
                    // Pull the latest snapshot — payload only carries the
                    // delta. Keeps the UI consistent with the source of truth.
                    self.api.get('/setup/build-status', { skipCache: true })
                        .then(applyStatus)
                        .catch(function () { /* will retry on next event */ });
                }
            });
        }
        // Polling fallback — every 4 seconds. Cheap (status is in-memory).
        var pollTimer = setInterval(function () {
            self.api.get('/setup/build-status', { skipCache: true })
                .then(function (status) {
                    applyStatus(status);
                    if (status.phase === 'done'
                        || status.phase === 'failed'
                        || status.phase === 'cancelled') {
                        clearInterval(pollTimer);
                        if (unsub) try { unsub(); } catch (_) {}
                    }
                })
                .catch(function () { /* retry on next tick */ });
        }, 4000);

        // Kick the build.
        self.api.post('/setup/auto-install-ela').then(function (result) {
            if (result && result.status) applyStatus(result.status);
        }).catch(function (err) {
            phaseLabel.textContent = t('wizard.build_phase_failed') + ': ' + err.message;
        });
    };

    SetupWizard.prototype._render_keystore = function () {
        var self = this;
        var t = root.enmTOrFallback;
        this._body.appendChild(makeHeading(t('wizard.step_keystore')));
        this._body.appendChild(makePara(t('wizard.keystore_help')));

        var arbiterToggle = document.createElement('label');
        arbiterToggle.className = 'enm-wizard-checkbox';
        var arbiterInput = document.createElement('input');
        arbiterInput.type = 'checkbox';
        arbiterInput.checked = self._choices.enableArbiter !== false;
        arbiterToggle.appendChild(arbiterInput);
        var arbiterLabel = document.createElement('span');
        arbiterLabel.textContent = t('wizard.keystore_arbiter_label');
        arbiterToggle.appendChild(arbiterLabel);
        this._body.appendChild(arbiterToggle);

        // Path + password fields, hidden when arbiter mode is off.
        var ksFields = document.createElement('div');
        ksFields.className = 'enm-wizard-keystore-fields';

        var pathInput = document.createElement('input');
        pathInput.type = 'text';
        pathInput.className = 'enm-wizard-binary-input';
        pathInput.placeholder = t('wizard.keystore_path_placeholder');
        pathInput.setAttribute('aria-label', t('wizard.keystore_path_label'));
        ksFields.appendChild(pathInput);

        var pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.autocomplete = 'new-password';
        pwInput.className = 'enm-wizard-binary-input';
        pwInput.setAttribute('aria-label', t('wizard.keystore_password_label'));
        pwInput.placeholder = t('wizard.keystore_password_label');
        ksFields.appendChild(pwInput);

        this._body.appendChild(ksFields);

        var status = makePara('');
        this._body.appendChild(status);

        function updateFieldsVisibility() {
            ksFields.style.display = arbiterInput.checked ? '' : 'none';
        }
        arbiterInput.addEventListener('change', updateFieldsVisibility);
        updateFieldsVisibility();

        var saveBtn = makeBtn(t('wizard.keystore_save_btn'), function () {
            var enableArbiter = arbiterInput.checked;
            var body = { enableArbiter: enableArbiter };
            if (enableArbiter) {
                if (!pathInput.value.trim() || !pwInput.value) {
                    status.textContent = t('wizard.keystore_fail', {
                        reason: 'path and password are required',
                    });
                    return;
                }
                body.keystorePath = pathInput.value.trim();
                body.keystorePassword = pwInput.value;
            }
            saveBtn.disabled = true;
            self.api.post('/setup/keystore', body).then(function (result) {
                self._choices.enableArbiter = enableArbiter;
                self._choices.keystoreImported = !!result.keystoreImported;
                status.textContent = enableArbiter
                    ? t('wizard.keystore_ok')
                    : '';
                pwInput.value = ''; // wipe password from memory ASAP
                self._goto('network');
            }).catch(function (err) {
                status.textContent = t('wizard.keystore_fail', { reason: err.message });
                saveBtn.disabled = false;
            });
        });
        this._body.appendChild(saveBtn);
    };

    SetupWizard.prototype._render_network = function () {
        var self = this;
        var t = root.enmTOrFallback;
        this._body.appendChild(makeHeading(t('wizard.step_network')));
        this._body.appendChild(makePara(t('wizard.network_help')));

        var modeWrap = document.createElement('div');
        modeWrap.className = 'enm-wizard-radio-row';
        var auto = document.createElement('input');
        auto.type = 'radio'; auto.name = 'wizardIpMode'; auto.value = 'auto';
        auto.checked = self._choices.ipMode !== 'manual';
        var manual = document.createElement('input');
        manual.type = 'radio'; manual.name = 'wizardIpMode'; manual.value = 'manual';
        manual.checked = self._choices.ipMode === 'manual';

        modeWrap.appendChild(labelEl(auto, t('settings.ip_mode_auto')));
        modeWrap.appendChild(labelEl(manual, t('settings.ip_mode_manual')));
        this._body.appendChild(modeWrap);

        var manualInput = document.createElement('input');
        manualInput.type = 'text';
        manualInput.className = 'enm-wizard-binary-input';
        manualInput.value = self._choices.ipManual || '';
        manualInput.placeholder = '203.0.113.5  or  myhost.dyndns.org';
        this._body.appendChild(manualInput);

        var status = makePara('');
        this._body.appendChild(status);

        var detectBtn = makeBtn(t('wizard.network_detect_btn'), function () {
            status.textContent = t('common.loading');
            self.api.get('/system/extip', { skipCache: true }).then(function (data) {
                if (data && data.ok && data.ip) {
                    self._choices.extipDetected = data.ip;
                    status.textContent = data.ip;
                } else {
                    status.textContent = (data && data.reason) || 'Detect failed';
                }
            }).catch(function (err) {
                status.textContent = err.message;
            });
        });
        this._body.appendChild(detectBtn);

        function applyMode() {
            manualInput.disabled = !manual.checked;
        }
        auto.addEventListener('change', applyMode);
        manual.addEventListener('change', applyMode);
        applyMode();

        var saveBtn = makeBtn(t('wizard.network_save_btn'), function () {
            var mode = manual.checked ? 'manual' : 'auto';
            var body = { mode: mode };
            if (mode === 'manual') { body.manualValue = manualInput.value.trim(); }
            saveBtn.disabled = true;
            self.api.post('/setup/network', body).then(function () {
                self._choices.ipMode = mode;
                self._choices.ipManual = body.manualValue || '';
                self._goto('confirm');
            }).catch(function (err) {
                status.textContent = err.message;
                saveBtn.disabled = false;
            });
        });
        this._body.appendChild(saveBtn);
    };

    SetupWizard.prototype._render_confirm = function () {
        var self = this;
        var t = root.enmTOrFallback;
        this._body.appendChild(makeHeading(t('wizard.confirm_heading')));

        var summary = document.createElement('ul');
        summary.className = 'enm-wizard-summary';
        var role = self._choices.enableArbiter
            ? t('wizard.confirm_role_arbiter')
            : t('wizard.confirm_role_full');
        appendLi(summary, role);
        appendLi(summary, t('wizard.confirm_binary', { path: self._choices.binaryPath || '—' }));
        var ipDisplay = self._choices.ipMode === 'manual'
            ? (self._choices.ipManual || '—')
            : (self._choices.extipDetected
                ? self._choices.extipDetected + ' (auto)'
                : 'auto-detect at start');
        appendLi(summary, t('wizard.confirm_ip', { value: ipDisplay }));
        this._body.appendChild(summary);

        var status = makePara('');
        this._body.appendChild(status);

        var startBtn = makeBtn(t('wizard.confirm_start_btn'), function () {
            startBtn.disabled = true;
            status.textContent = t('wizard.confirm_finishing');
            self.api.post('/setup/complete').then(function () {
                self.api.invalidate('/setup/state');
                status.textContent = t('wizard.confirm_complete_no_start');
                self._goto('complete');
            }).catch(function (err) {
                status.textContent = err.message;
                startBtn.disabled = false;
            });
        });
        this._body.appendChild(startBtn);
    };

    SetupWizard.prototype._render_complete = function () {
        var self = this;
        var t = root.enmTOrFallback;
        this._body.appendChild(makeHeading(t('wizard.step_complete')));
        this._body.appendChild(makePara(t('wizard.confirm_complete_no_start')));
        this._body.appendChild(makeBtn(t('common.close'), function () {
            self.onComplete();
        }));
    };

    /** @private */
    SetupWizard.prototype._loadPreflight = function () {
        if (this._preflight) { return Promise.resolve(this._preflight); }
        var self = this;
        return this.api.get('/setup/preflight', { skipCache: true }).then(function (pre) {
            self._preflight = pre;
            return pre;
        });
    };

    function makeHeading(text) {
        var h = document.createElement('h2');
        h.className = 'enm-wizard-heading';
        h.textContent = text;
        return h;
    }
    function makePara(text) {
        var p = document.createElement('p');
        p.className = 'enm-wizard-para';
        p.textContent = text;
        return p;
    }
    function makeBtn(text, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-btn enm-btn-primary';
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }
    function labelEl(input, text) {
        var l = document.createElement('label');
        l.className = 'enm-wizard-label';
        l.appendChild(input);
        var span = document.createElement('span');
        span.textContent = text;
        l.appendChild(span);
        return l;
    }
    function appendLi(ul, text) {
        var li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
    }
    root.EnmSetupWizard = SetupWizard;
    root.ENM_WIZARD_STEPS = STEPS;
}(typeof window !== 'undefined' ? window : globalThis));
