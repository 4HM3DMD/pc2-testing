/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/setup-wizard.js — 4-step install wizard.
 *
 * Replaces the old 9-step path-driven wizard. The new flow follows what
 * node.sh actually does — download a prebuilt binary, generate a keystore,
 * write the config, start. No "build from source," no "paste a path."
 *
 *   1. Welcome      — what ENM does + system check (OS / disk / arch)
 *   2. Install      — download mainchain binary from download.elastos.io
 *                     (live progress over SSE topic setup:install:mainchain)
 *   3. Keystore     — generate keystore.dat via ela-cli wallet create.
 *                     Show password ONCE, prompt to download as file.
 *                     Show producer public key for registration.
 *   4. Confirm      — review summary, big "Start node" button.
 */

(function (root) {
    'use strict';

    var STEPS = ['welcome', 'install', 'keystore', 'confirm'];

    function SetupWizard(opts) {
        if (!opts || !opts.api || !opts.notifications) {
            throw new TypeError('SetupWizard: { api, notifications } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.sse = opts.sse || null;
        this.onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : function () {};

        this.root = document.createElement('section');
        this.root.className = 'enm-wizard';
        this._currentStep = 'welcome';
        this._state = {
            preflight: null,           // { os, disk }
            install: null,             // last install status
            keystore: null,            // { publicKey, address, generatedPassword? }
            keystorePassword: '',
            useGeneratedPassword: true,
        };
        this._unsubscribeInstall = null;

        this._renderShell();
    }

    SetupWizard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this._goto(this._currentStep);
        return this;
    };

    SetupWizard.prototype.destroy = function () {
        if (this._unsubscribeInstall) { this._unsubscribeInstall(); }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    SetupWizard.prototype._renderShell = function () {
        // Step indicator: numbered pills with labels.
        this._stepIndicator = document.createElement('ol');
        this._stepIndicator.className = 'enm-wizard-steps';
        this._stepNodes = {};
        STEPS.forEach(function (step, i) {
            var li = document.createElement('li');
            li.className = 'enm-wizard-step';
            li.dataset.step = step;
            var num = document.createElement('span');
            num.className = 'enm-wizard-step-num';
            num.textContent = String(i + 1);
            var label = document.createElement('span');
            label.className = 'enm-wizard-step-label';
            label.textContent = STEP_LABELS[step] || step;
            li.appendChild(num);
            li.appendChild(label);
            this._stepIndicator.appendChild(li);
            this._stepNodes[step] = li;
        }, this);
        this.root.appendChild(this._stepIndicator);

        this._body = document.createElement('div');
        this._body.className = 'enm-wizard-body';
        this.root.appendChild(this._body);
    };

    SetupWizard.prototype._goto = function (step) {
        this._currentStep = step;
        // Bump sequence so any in-flight async work from the previous
        // step knows it's stale and bails before mutating the DOM.
        this._renderSeq = (this._renderSeq || 0) + 1;
        Object.keys(this._stepNodes).forEach(function (k) {
            this._stepNodes[k].classList.toggle('enm-wizard-step-active', k === step);
            this._stepNodes[k].classList.toggle(
                'enm-wizard-step-done',
                STEPS.indexOf(k) < STEPS.indexOf(step),
            );
        }, this);
        this._body.innerHTML = '';
        var renderer = this['_render_' + step];
        if (typeof renderer === 'function') {
            renderer.call(this);
        } else {
            this._body.appendChild(makePara('Step "' + step + '" not implemented.'));
        }
    };

    SetupWizard.prototype._isStillRendering = function (capturedSeq) {
        return this._renderSeq === capturedSeq && this.root.isConnected;
    };

    // ===================================================================
    // Step 1 — welcome
    // ===================================================================

    SetupWizard.prototype._render_welcome = function () {
        var t = root.enmTOrFallback;
        var self = this;
        var seq = this._renderSeq;

        this._body.appendChild(makeHeading(t('wizard.welcome_heading')));
        this._body.appendChild(makePara(t('wizard.welcome_body')));

        var checkCard = document.createElement('div');
        checkCard.className = 'enm-wizard-checks';
        checkCard.innerHTML = '<div class="enm-wizard-checks-spinner"><span class="enm-spinner-dot"></span><span class="enm-spinner-dot"></span><span class="enm-spinner-dot"></span></div><p>Running system checks...</p>';
        this._body.appendChild(checkCard);

        this.api.get('/setup/preflight', { skipCache: true }).then(function (preflight) {
            if (!self._isStillRendering(seq)) return;
            self._state.preflight = preflight;
            checkCard.innerHTML = '';
            renderCheckRow(checkCard, 'Operating system',
                preflight.os && preflight.os.ok,
                preflight.os && (preflight.os.distroId
                    ? preflight.os.distroId + ' ' + (preflight.os.version || '')
                    : preflight.os.platform));
            renderCheckRow(checkCard, 'Disk space',
                preflight.disk && preflight.disk.status !== 'critical',
                preflight.disk
                    ? Number(preflight.disk.freeGb).toFixed(1) + ' GB free'
                    : null);
            renderCheckRow(checkCard, 'Wallet identity',
                preflight.wallet && preflight.wallet.ok,
                preflight.wallet && preflight.wallet.walletAddress
                    ? preflight.wallet.walletAddress.slice(0, 6) + '...' + preflight.wallet.walletAddress.slice(-4)
                    : null);

            var actions = document.createElement('div');
            actions.className = 'enm-wizard-actions';
            var btn = makeBtn('Continue', 'primary', function () { self._goto('install'); });
            actions.appendChild(btn);
            self._body.appendChild(actions);
        }).catch(function (err) {
            if (!self._isStillRendering(seq)) return;
            checkCard.innerHTML = '';
            checkCard.appendChild(makePara('System check failed: ' + (err.message || err)));
        });
    };

    // ===================================================================
    // Step 2 — install
    // ===================================================================

    SetupWizard.prototype._render_install = function () {
        var self = this;
        this._body.appendChild(makeHeading('Install Elastos node'));
        this._body.appendChild(makePara(
            'ENM downloads the official mainchain release from download.elastos.io ' +
            '— same source the upstream node.sh installer uses. No source build, ' +
            'no toolchain dependencies.',
        ));

        var card = document.createElement('div');
        card.className = 'enm-install-card';
        this._body.appendChild(card);

        var head = document.createElement('div');
        head.className = 'enm-install-card-head';
        head.innerHTML =
            '<div class="enm-install-icon" aria-hidden="true">⛓</div>' +
            '<div class="enm-install-meta">' +
                '<div class="enm-install-name">Mainchain (ELA)</div>' +
                '<div class="enm-install-sub" id="enm-install-version">Resolving latest version...</div>' +
            '</div>';
        card.appendChild(head);

        var progressWrap = document.createElement('div');
        progressWrap.className = 'enm-install-progress';
        progressWrap.hidden = true;
        progressWrap.innerHTML =
            '<div class="enm-install-bar-wrap"><div class="enm-install-bar"></div></div>' +
            '<div class="enm-install-status">Idle</div>';
        card.appendChild(progressWrap);

        var actions = document.createElement('div');
        actions.className = 'enm-wizard-actions';
        var startBtn = makeBtn('Download & install', 'primary', function () {
            startBtn.disabled = true;
            progressWrap.hidden = false;
            self._beginInstall(card, startBtn);
        });
        var nextBtn = makeBtn('Continue', 'primary', function () { self._goto('keystore'); });
        nextBtn.hidden = true;
        actions.appendChild(startBtn);
        actions.appendChild(nextBtn);
        this._body.appendChild(actions);

        // Pre-poll: maybe it's already installed.
        var preSeq = this._renderSeq;
        this.api.get('/setup/install-status/mainchain', { skipCache: true }).then(function (s) {
            if (!self._isStillRendering(preSeq)) return;
            if (s && s.phase === 'done') {
                document.getElementById('enm-install-version').textContent =
                    'Already installed: ' + (s.version || '');
                progressWrap.hidden = true;
                startBtn.hidden = true;
                nextBtn.hidden = false;
                self._state.install = s;
            }
        }).catch(function () { /* boot race; ignore */ });
    };

    SetupWizard.prototype._beginInstall = function (card, startBtn) {
        var self = this;
        var versionLine = card.querySelector('#enm-install-version');
        var bar = card.querySelector('.enm-install-bar');
        var status = card.querySelector('.enm-install-status');

        function applyStatus(s) {
            self._state.install = s;
            if (s.version) versionLine.textContent = 'Version ' + s.version;
            var pct = (s.bytesTotal && s.bytesDownloaded)
                ? Math.min(100, Math.floor((s.bytesDownloaded / s.bytesTotal) * 100))
                : (s.phase === 'done' ? 100 : 0);
            bar.style.width = pct + '%';
            status.textContent = phaseLabel(s);
            if (s.phase === 'done') {
                startBtn.hidden = true;
                var nextBtn = self._body.querySelector('.enm-wizard-actions button:last-child');
                if (nextBtn) nextBtn.hidden = false;
                self.notifications.info('ela installed', s.binaryPath || '');
            }
            if (s.phase === 'failed') {
                status.textContent = 'Failed: ' + (s.error || 'unknown error');
                startBtn.disabled = false;
                startBtn.textContent = 'Retry';
            }
        }

        // Subscribe to live SSE updates first.
        if (this.sse && typeof this.sse.subscribe === 'function') {
            this._unsubscribeInstall = this.sse.subscribe(
                'setup:install:mainchain',
                function (payload) { applyStatus(payload); },
            );
        }

        this.api.post('/setup/install/mainchain').then(function (resp) {
            applyStatus(resp.status);
            // Fallback poll in case SSE isn't wired.
            (function poll() {
                if (!self.root.isConnected) return;
                self.api.get('/setup/install-status/mainchain', { skipCache: true }).then(function (s) {
                    applyStatus(s);
                    if (s.phase !== 'done' && s.phase !== 'failed') {
                        setTimeout(poll, 2000);
                    }
                }).catch(function () { setTimeout(poll, 4000); });
            })();
        }).catch(function (err) {
            status.textContent = 'Install error: ' + (err.message || err);
            startBtn.disabled = false;
        });
    };

    // ===================================================================
    // Step 3 — keystore
    // ===================================================================

    SetupWizard.prototype._render_keystore = function () {
        var self = this;

        this._body.appendChild(makeHeading('Generate producer keystore'));
        this._body.appendChild(makePara(
            'BPoS supernodes sign blocks with a server-side keystore (keystore.dat). ' +
            'ENM generates one for you using ela-cli — the keystore stays on this server, ' +
            'never leaves. Treat the password like a recovery seed: if you lose it, the ' +
            'producer key is gone forever.',
        ));

        // Mode toggle: BPoS (with keystore) vs full-node (no keystore)
        var modeWrap = document.createElement('div');
        modeWrap.className = 'enm-wizard-mode';
        modeWrap.innerHTML =
            '<label class="enm-wizard-mode-opt"><input type="radio" name="enm-mode" value="bpos" checked>' +
            '<span><strong>BPoS supernode</strong><span class="enm-wizard-mode-help">Earn rewards by signing blocks. Requires 2,000 ELA deposit.</span></span></label>' +
            '<label class="enm-wizard-mode-opt"><input type="radio" name="enm-mode" value="full">' +
            '<span><strong>Full node</strong><span class="enm-wizard-mode-help">Follow the chain only — no keystore, no deposit.</span></span></label>';
        this._body.appendChild(modeWrap);

        // Password choice
        var pwCard = document.createElement('div');
        pwCard.className = 'enm-wizard-pwcard';
        pwCard.innerHTML =
            '<label><input type="radio" name="enm-pw" value="generate" checked> Generate a strong password for me</label>' +
            '<label><input type="radio" name="enm-pw" value="custom"> I\'ll choose my own password</label>' +
            '<input type="password" id="enm-pw-input" placeholder="Choose a strong password (16+ chars)" autocomplete="new-password" hidden>';
        this._body.appendChild(pwCard);

        var input = pwCard.querySelector('#enm-pw-input');
        pwCard.querySelectorAll('input[name="enm-pw"]').forEach(function (r) {
            r.addEventListener('change', function () {
                self._state.useGeneratedPassword = (r.value === 'generate' && r.checked);
                input.hidden = self._state.useGeneratedPassword;
            });
        });

        var actions = document.createElement('div');
        actions.className = 'enm-wizard-actions';
        var generateBtn = makeBtn('Generate keystore', 'primary', function () {
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
            self._submitKeystore(generateBtn, modeWrap, input);
        });
        actions.appendChild(generateBtn);
        this._body.appendChild(actions);
    };

    SetupWizard.prototype._submitKeystore = function (btn, modeWrap, pwInput) {
        var self = this;
        var modeRadio = modeWrap.querySelector('input[name="enm-mode"]:checked');
        var enableArbiter = modeRadio && modeRadio.value === 'bpos';
        var body = { enableArbiter: enableArbiter };
        if (enableArbiter && !self._state.useGeneratedPassword) {
            var pw = (pwInput.value || '').trim();
            if (pw.length < 8) {
                btn.disabled = false;
                btn.textContent = 'Generate keystore';
                self.notifications.warning('Password too short', 'Use at least 8 characters.');
                return;
            }
            body.password = pw;
        }
        this.api.post('/setup/keystore', body).then(function (resp) {
            self._state.keystore = resp;
            if (!enableArbiter) {
                self._goto('confirm');
                return;
            }
            self._showKeystoreReveal(resp);
        }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Retry';
            self.notifications.warning('Keystore generation failed', err.message || String(err));
        });
    };

    SetupWizard.prototype._showKeystoreReveal = function (resp) {
        var self = this;
        // Hide the previous body content; show the reveal card.
        this._body.innerHTML = '';
        this._body.appendChild(makeHeading('Save your keystore password'));
        var p = makePara(
            'Below is the password we generated for your keystore. Save it somewhere ' +
            'safe — a password manager, a printed copy in a fireproof place, anywhere ' +
            'that survives the loss of this server. We will not show it again.',
        );
        this._body.appendChild(p);

        if (resp.generatedPassword) {
            var pwReveal = document.createElement('div');
            pwReveal.className = 'enm-pw-reveal';
            pwReveal.innerHTML =
                '<code class="enm-pw-value"></code>' +
                '<button class="enm-btn enm-btn-secondary enm-pw-copy" type="button">Copy</button>' +
                '<button class="enm-btn enm-btn-secondary enm-pw-download" type="button">Download .txt</button>';
            pwReveal.querySelector('.enm-pw-value').textContent = resp.generatedPassword;
            pwReveal.querySelector('.enm-pw-copy').addEventListener('click', function () {
                navigator.clipboard.writeText(resp.generatedPassword)
                    .then(function () { self.notifications.info('Copied', 'Password is in the clipboard. Paste it into your password manager NOW.'); })
                    .catch(function () { self.notifications.warning('Copy failed', 'Select the password and copy manually.'); });
            });
            pwReveal.querySelector('.enm-pw-download').addEventListener('click', function () {
                var blob = new Blob([
                    'Elastos Node Manager — keystore password\n',
                    'Generated: ' + new Date().toISOString() + '\n',
                    'Producer public key: ' + resp.publicKey + '\n',
                    'Address: ' + resp.address + '\n\n',
                    'PASSWORD: ' + resp.generatedPassword + '\n\n',
                    'Keep this file offline. If you lose this password the keystore is unrecoverable.\n',
                ], { type: 'text/plain' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'elastos-keystore-password.txt';
                a.click();
                URL.revokeObjectURL(url);
            });
            this._body.appendChild(pwReveal);
        } else {
            this._body.appendChild(makePara('You chose your own password. Make sure you have it saved before continuing.'));
        }

        var ack = document.createElement('label');
        ack.className = 'enm-pw-ack';
        ack.innerHTML = '<input type="checkbox" id="enm-pw-ack-check"> I have saved the password somewhere safe.';
        this._body.appendChild(ack);

        var actions = document.createElement('div');
        actions.className = 'enm-wizard-actions';
        var nextBtn = makeBtn('Continue', 'primary', function () { self._goto('confirm'); });
        nextBtn.disabled = true;
        actions.appendChild(nextBtn);
        this._body.appendChild(actions);

        ack.querySelector('input').addEventListener('change', function (ev) {
            nextBtn.disabled = !ev.target.checked;
        });
    };

    // ===================================================================
    // Step 4 — confirm
    // ===================================================================

    SetupWizard.prototype._render_confirm = function () {
        var self = this;
        this._body.appendChild(makeHeading('Ready to start'));
        this._body.appendChild(makePara(
            'Review the setup below. Clicking Start will write the chain config, ' +
            'launch the mainchain process, and take you to the dashboard.',
        ));

        var summary = document.createElement('dl');
        summary.className = 'enm-wizard-summary';
        var ks = this._state.keystore || {};
        var inst = this._state.install || {};
        var rows = [
            ['Mainchain version', inst.version || 'mainchain installed'],
            ['Mode', ks.enableArbiter === false ? 'Full node' : 'BPoS supernode'],
        ];
        if (ks.publicKey) {
            rows.push(['Producer public key', truncMid(ks.publicKey, 12, 12)]);
        }
        if (ks.address) {
            rows.push(['Producer address', ks.address]);
        }
        rows.forEach(function (r) {
            var dt = document.createElement('dt'); dt.textContent = r[0];
            var dd = document.createElement('dd'); dd.textContent = r[1];
            summary.appendChild(dt); summary.appendChild(dd);
        });
        this._body.appendChild(summary);

        var actions = document.createElement('div');
        actions.className = 'enm-wizard-actions';
        var startBtn = makeBtn('Write config & start node', 'primary', function () {
            startBtn.disabled = true;
            startBtn.textContent = 'Working...';

            // /setup/network with mode='auto' so the IPAddress is detected.
            self.api.post('/setup/network', { mode: 'auto' }).then(function () {
                return self.api.post('/setup/complete', {});
            }).then(function () {
                self.notifications.info('Setup complete', 'Loading dashboard...');
                self.onComplete();
            }).catch(function (err) {
                startBtn.disabled = false;
                startBtn.textContent = 'Retry';
                self.notifications.warning('Could not finish setup', err.message || String(err));
            });
        });
        actions.appendChild(startBtn);
        this._body.appendChild(actions);
    };

    // ===================================================================
    // helpers
    // ===================================================================

    var STEP_LABELS = {
        welcome:  'Welcome',
        install:  'Install',
        keystore: 'Keystore',
        confirm:  'Confirm',
    };

    function makeHeading(text) {
        var h = document.createElement('h2');
        h.textContent = text;
        return h;
    }

    function makePara(text) {
        var p = document.createElement('p');
        p.textContent = text;
        return p;
    }

    function makeBtn(label, variant, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'enm-btn enm-btn-' + (variant || 'primary');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function renderCheckRow(parent, label, ok, detail) {
        var row = document.createElement('div');
        row.className = 'enm-wizard-check-row enm-wizard-check-' + (ok ? 'ok' : 'fail');
        row.innerHTML =
            '<span class="enm-wizard-check-mark" aria-hidden="true">' + (ok ? '✓' : '!') + '</span>' +
            '<span class="enm-wizard-check-label"></span>' +
            '<span class="enm-wizard-check-detail"></span>';
        row.querySelector('.enm-wizard-check-label').textContent = label;
        row.querySelector('.enm-wizard-check-detail').textContent = detail || '';
        parent.appendChild(row);
    }

    function phaseLabel(s) {
        switch (s.phase) {
            case 'idle':        return 'Ready';
            case 'resolving':   return 'Looking up the latest release...';
            case 'downloading':
                if (s.bytesTotal) {
                    var mb = (s.bytesDownloaded / 1024 / 1024).toFixed(1);
                    var total = (s.bytesTotal / 1024 / 1024).toFixed(1);
                    return 'Downloading... ' + mb + ' / ' + total + ' MB';
                }
                return 'Downloading...';
            case 'extracting':  return 'Extracting...';
            case 'verifying':   return 'Verifying binary...';
            case 'done':        return 'Installed';
            case 'failed':      return 'Failed';
            default:            return s.phase || '';
        }
    }

    function truncMid(s, head, tail) {
        if (!s || s.length <= head + tail + 3) return s;
        return s.slice(0, head) + '…' + s.slice(-tail);
    }

    root.EnmSetupWizard = SetupWizard;
}(typeof window !== 'undefined' ? window : globalThis));
