/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/setup-wizard.js — 3-step wizard (v0.3 rebuild).
 *
 * Steps:
 *   1. Welcome             — preflight checks (OS / disk / identity)
 *   2. Install & Configure — combined: download binary + generate keystore
 *   3. Confirm & Start     — write config, spawn ela
 *
 * Architectural Invariants enforced:
 *
 *   #1 Disk is the source of truth: every step pulls from
 *      /api/enm/setup/state which derives from ChainState.snapshot. We
 *      never trust local UI state across reloads or container restarts.
 *
 *   #5 No silent UI text: install card is BLANK until the operator
 *      clicks Install. The "Resolving latest version..." text the
 *      operator was confused by has been banned. State labels reflect
 *      actual phase, never aspirational text.
 *
 *   #6 Self-heal: on init() we call /api/enm/setup/state. If it returns
 *      setupStep="complete" but the operator landed here anyway (chain
 *      still says unconfigured), we trust the wizard route — the
 *      dashboard will reroute back automatically once chain truly runs.
 *
 * The wizard is mounted EITHER from app.js boot (when no chain is
 * configured) OR inline from chain-card.js's "Configure" button (recovery
 * path for the "Not configured" badge).
 */

(function (root) {
    'use strict';

    var STEPS = ['welcome', 'install', 'confirm'];
    var STEP_LABELS = {
        welcome:  'Welcome',
        install:  'Install & configure',
        confirm:  'Confirm & start',
    };

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
        this._renderSeq = 0;
        this._unsubscribeInstall = null;

        // Per-session decisions the wizard collects. Re-derived from disk on
        // each resume so a container restart doesn't lose anything important.
        this._choices = {
            mode: 'bpos',                  // 'bpos' | 'full'
            useGeneratedPassword: true,
            customPassword: '',
        };

        // Snapshot of /api/enm/setup/state — refreshed at each step entry.
        this._setupState = null;
        this._setupStateInitialized = false;

        this._renderShell();
    }

    SetupWizard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        this._refreshState().then(function () {
            self._goto(self._currentStep);
        });
        return this;
    };

    SetupWizard.prototype.destroy = function () {
        if (this._unsubscribeInstall) { this._unsubscribeInstall(); this._unsubscribeInstall = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    SetupWizard.prototype._refreshState = function () {
        var self = this;
        return this.api.get('/setup/state', { skipCache: true }).then(function (s) {
            self._setupState = s || {};
            // ChainState-derived setupStep maps to our 3-step flow.
            var step = self._setupState.currentStep || self._setupState.setupStep;
            if (!self._setupStateInitialized) {
                if (step === 'install' || step === 'keystore') self._currentStep = 'install';
                else if (step === 'network' || step === 'confirm') self._currentStep = 'confirm';
                else if (step === 'complete') self._currentStep = 'confirm';
                else self._currentStep = 'welcome';
                self._setupStateInitialized = true;
            }
        }).catch(function () {
            self._currentStep = 'welcome';
        });
    };

    SetupWizard.prototype._renderShell = function () {
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
            label.textContent = STEP_LABELS[step];
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
        this._renderSeq += 1;
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
            this._body.appendChild(makePara('Unknown step: ' + step));
        }
    };

    SetupWizard.prototype._stillRendering = function (capturedSeq) {
        return this._renderSeq === capturedSeq && this.root.isConnected;
    };

    // ===================================================================
    // Step 1 — Welcome
    // ===================================================================

    SetupWizard.prototype._render_welcome = function () {
        var self = this;
        var seq = this._renderSeq;

        this._body.appendChild(makeHeading('Welcome to Elastos Node Manager'));
        this._body.appendChild(makePara(
            'ENM downloads the official ELA mainchain binary, generates your '
            + 'producer keystore, writes a config, and runs the node. All chain '
            + 'operations happen on this server — your wallet only proves you’re '
            + 'the operator.',
        ));

        var checks = document.createElement('div');
        checks.className = 'enm-wizard-checks';
        ['operating-system', 'disk-space', 'wallet-identity'].forEach(function (label) {
            var skel = document.createElement('div');
            skel.className = 'enm-wizard-check-row enm-wizard-check-skel';
            skel.innerHTML = '<span class="enm-skel enm-skel-circle"></span>'
                + '<span class="enm-skel enm-skel-bar enm-skel-bar-md"></span>'
                + '<span class="enm-skel enm-skel-bar enm-skel-bar-sm"></span>';
            skel.dataset.k = label;
            checks.appendChild(skel);
        });
        this._body.appendChild(checks);

        this.api.get('/setup/preflight', { skipCache: true }).then(function (p) {
            if (!self._stillRendering(seq)) return;
            checks.innerHTML = '';
            renderCheckRow(checks, 'Operating system',
                p && p.os && p.os.ok,
                p && p.os && (p.os.distroId
                    ? p.os.distroId + ' ' + (p.os.version || '')
                    : p.os.platform));
            renderCheckRow(checks, 'Disk space',
                p && p.disk && p.disk.status !== 'critical',
                p && p.disk
                    ? Number(p.disk.freeGb).toFixed(1) + ' GB free'
                    : null);
            renderCheckRow(checks, 'Wallet identity',
                p && p.wallet && p.wallet.ok,
                p && p.wallet && p.wallet.walletAddress
                    ? p.wallet.walletAddress.slice(0, 6) + '...' + p.wallet.walletAddress.slice(-4)
                    : null);

            var actions = document.createElement('div');
            actions.className = 'enm-wizard-actions';
            actions.appendChild(makeBtn('Continue', 'primary', function () { self._goto('install'); }));
            self._body.appendChild(actions);
        }).catch(function (err) {
            if (!self._stillRendering(seq)) return;
            checks.innerHTML = '';
            checks.appendChild(makePara('System check failed: ' + (err.message || err)));
        });
    };

    // ===================================================================
    // Step 2 — Install & Configure
    // ===================================================================

    SetupWizard.prototype._render_install = function () {
        var self = this;
        var seq = this._renderSeq;

        this._body.appendChild(makeHeading('Install & configure'));
        this._body.appendChild(makePara(
            'Download the latest mainchain binary from download.elastos.io and '
            + 'generate your producer keystore. The keystore stays on this server '
            + 'forever — never share its password.',
        ));

        var card = document.createElement('div');
        card.className = 'enm-install-card';
        card.innerHTML =
            '<div class="enm-install-card-head">' +
                '<div class="enm-install-icon" aria-hidden="true">⛓</div>' +
                '<div class="enm-install-meta">' +
                    '<div class="enm-install-name">Mainchain (ELA)</div>' +
                    '<div class="enm-install-sub" id="enm-install-sub">Click "Install" to begin.</div>' +
                '</div>' +
            '</div>' +
            '<div class="enm-install-progress" id="enm-install-progress" hidden>' +
                '<div class="enm-install-bar-wrap"><div class="enm-install-bar"></div></div>' +
                '<div class="enm-install-status">Idle</div>' +
            '</div>' +
            '<div class="enm-install-actions" id="enm-install-actions"></div>';
        this._body.appendChild(card);

        var actionsEl = card.querySelector('#enm-install-actions');
        var subLine = card.querySelector('#enm-install-sub');
        var progress = card.querySelector('#enm-install-progress');
        var bar = card.querySelector('.enm-install-bar');
        var status = card.querySelector('.enm-install-status');

        // Recovery: if binary already on disk, skip straight to keystore form.
        this.api.get('/setup/install-status/mainchain', { skipCache: true }).then(function (s) {
            if (!self._stillRendering(seq)) return;
            if (s && s.phase === 'done' && s.binaryPath) {
                subLine.textContent = 'Installed ' + (s.version || '');
                self._renderKeystoreForm(card, actionsEl);
            } else {
                actionsEl.appendChild(makeBtn('Install', 'primary', function (ev) {
                    ev.target.disabled = true;
                    self._beginInstall({ subLine: subLine, progress: progress, bar: bar, status: status, actionsEl: actionsEl, card: card });
                }));
            }
        }).catch(function () {
            if (!self._stillRendering(seq)) return;
            actionsEl.appendChild(makeBtn('Install', 'primary', function (ev) {
                ev.target.disabled = true;
                self._beginInstall({ subLine: subLine, progress: progress, bar: bar, status: status, actionsEl: actionsEl, card: card });
            }));
        });
    };

    SetupWizard.prototype._beginInstall = function (els) {
        var self = this;
        els.progress.hidden = false;
        els.subLine.textContent = 'Starting download...';

        function applyStatus(s) {
            if (!s) return;
            if (s.version) els.subLine.textContent = 'Version ' + s.version;
            var pct = (s.bytesTotal && s.bytesDownloaded)
                ? Math.min(100, Math.floor((s.bytesDownloaded / s.bytesTotal) * 100))
                : (s.phase === 'done' ? 100 : 0);
            els.bar.style.width = pct + '%';
            els.status.textContent = phaseLabel(s);
            if (s.phase === 'done') {
                els.subLine.textContent = 'Installed ' + (s.version || '');
                els.actionsEl.innerHTML = '';
                self._renderKeystoreForm(els.card, els.actionsEl);
            }
            if (s.phase === 'failed') {
                els.status.textContent = 'Failed: ' + (s.error || 'unknown error');
                els.actionsEl.innerHTML = '';
                els.actionsEl.appendChild(makeBtn('Retry', 'primary', function (ev) {
                    ev.target.disabled = true;
                    self._beginInstall(els);
                }));
            }
        }

        if (this.sse && typeof this.sse.subscribe === 'function') {
            if (this._unsubscribeInstall) this._unsubscribeInstall();
            this._unsubscribeInstall = this.sse.subscribe(
                'setup:install:mainchain',
                function (p) { applyStatus(p); },
            );
        }

        this.api.post('/setup/install/mainchain').then(function (resp) {
            applyStatus(resp && resp.status);
            (function poll() {
                if (!self.root.isConnected) return;
                self.api.get('/setup/install-status/mainchain', { skipCache: true }).then(function (s) {
                    applyStatus(s);
                    if (!s || (s.phase !== 'done' && s.phase !== 'failed')) {
                        setTimeout(poll, 2500);
                    }
                }).catch(function () { setTimeout(poll, 4000); });
            })();
        }).catch(function (err) {
            els.status.textContent = 'Install error: ' + (err.message || err);
            els.actionsEl.innerHTML = '';
            els.actionsEl.appendChild(makeBtn('Retry', 'primary', function (ev) {
                ev.target.disabled = true;
                self._beginInstall(els);
            }));
        });
    };

    SetupWizard.prototype._renderKeystoreForm = function (card, actionsEl) {
        var self = this;
        var existing = card.parentElement.querySelector('.enm-keystore-form');
        if (existing) return;

        var form = document.createElement('div');
        form.className = 'enm-keystore-form';
        form.innerHTML =
            '<h3>Producer keystore</h3>' +
            '<div class="enm-wizard-mode" id="enm-mode">' +
                '<label class="enm-wizard-mode-opt">' +
                    '<input type="radio" name="enm-mode" value="bpos" checked>' +
                    '<span><strong>BPoS supernode</strong>' +
                    '<span class="enm-wizard-mode-help">Earn rewards by signing blocks. Requires 2,000 ELA deposit (registered later).</span></span>' +
                '</label>' +
                '<label class="enm-wizard-mode-opt">' +
                    '<input type="radio" name="enm-mode" value="full">' +
                    '<span><strong>Full node</strong>' +
                    '<span class="enm-wizard-mode-help">Follow the chain only — no keystore, no deposit, no rewards.</span></span>' +
                '</label>' +
            '</div>' +
            '<div class="enm-wizard-pwcard" id="enm-pwcard">' +
                '<label><input type="radio" name="enm-pw" value="generate" checked> Generate a strong password for me</label>' +
                '<label><input type="radio" name="enm-pw" value="custom"> I’ll choose my own password</label>' +
                '<input type="password" id="enm-pw-input" placeholder="Choose a strong password (16+ chars)" autocomplete="new-password" hidden>' +
            '</div>';
        card.parentElement.appendChild(form);

        var modeRadios = form.querySelectorAll('input[name="enm-mode"]');
        var pwRadios = form.querySelectorAll('input[name="enm-pw"]');
        var pwInput = form.querySelector('#enm-pw-input');
        var pwcard = form.querySelector('#enm-pwcard');

        modeRadios.forEach(function (r) {
            r.addEventListener('change', function () {
                self._choices.mode = r.value;
                pwcard.hidden = r.value === 'full';
            });
        });
        pwRadios.forEach(function (r) {
            r.addEventListener('change', function () {
                self._choices.useGeneratedPassword = (r.value === 'generate');
                pwInput.hidden = self._choices.useGeneratedPassword;
            });
        });

        var nextActions = document.createElement('div');
        nextActions.className = 'enm-wizard-actions';
        var btn = makeBtn('Generate keystore', 'primary', function (ev) {
            ev.target.disabled = true;
            ev.target.textContent = 'Generating...';
            self._submitKeystore(ev.target, pwInput);
        });
        nextActions.appendChild(btn);
        form.appendChild(nextActions);
    };

    SetupWizard.prototype._submitKeystore = function (btn, pwInput) {
        var self = this;
        var enableArbiter = self._choices.mode !== 'full';
        var body = { enableArbiter: enableArbiter };
        if (enableArbiter && !self._choices.useGeneratedPassword) {
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
        this._body.innerHTML = '';
        this._body.appendChild(makeHeading('Save your keystore password'));
        this._body.appendChild(makePara(
            'Below is the password we generated for your keystore. Save it '
            + 'somewhere safe — a password manager, a printed copy in a '
            + 'fireproof place, anywhere that survives the loss of this server. '
            + 'We will not show it again.',
        ));

        if (resp.generatedPassword) {
            var reveal = document.createElement('div');
            reveal.className = 'enm-pw-reveal';
            reveal.innerHTML =
                '<code class="enm-pw-value"></code>' +
                '<button class="enm-btn enm-btn-secondary enm-pw-copy" type="button">Copy</button>' +
                '<button class="enm-btn enm-btn-secondary enm-pw-download" type="button">Download .txt</button>';
            reveal.querySelector('.enm-pw-value').textContent = resp.generatedPassword;
            reveal.querySelector('.enm-pw-copy').addEventListener('click', function () {
                navigator.clipboard.writeText(resp.generatedPassword)
                    .then(function () { self.notifications.info('Copied', 'Paste into your password manager NOW.'); })
                    .catch(function () { self.notifications.warning('Copy failed', 'Select the password and copy manually.'); });
            });
            reveal.querySelector('.enm-pw-download').addEventListener('click', function () {
                var blob = new Blob([
                    'Elastos Node Manager — keystore password\n',
                    'Generated: ' + new Date().toISOString() + '\n',
                    'Producer public key: ' + (resp.publicKey || '?') + '\n',
                    'Address: ' + (resp.address || '?') + '\n\n',
                    'PASSWORD: ' + resp.generatedPassword + '\n\n',
                    'Keep this file offline. If you lose this password the keystore is unrecoverable.\n',
                ], { type: 'text/plain' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url; a.download = 'elastos-keystore-password.txt';
                a.click(); URL.revokeObjectURL(url);
            });
            this._body.appendChild(reveal);
        } else {
            this._body.appendChild(makePara('You chose your own password. Make sure you have it saved before continuing.'));
        }

        var ack = document.createElement('label');
        ack.className = 'enm-pw-ack';
        ack.innerHTML = '<input type="checkbox"> I have saved the password somewhere safe.';
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
    // Step 3 — Confirm & Start
    // ===================================================================

    SetupWizard.prototype._render_confirm = function () {
        var self = this;
        this._body.appendChild(makeHeading('Ready to start'));
        this._body.appendChild(makePara(
            'Review the setup below. Clicking Start will write the chain config '
            + 'and launch the mainchain process.',
        ));

        // Pull the latest disk truth one more time.
        this.api.get('/setup/state', { skipCache: true }).then(function (s) {
            self._setupState = s || {};
            renderSummary();
        }).catch(function () { renderSummary(); });

        function renderSummary() {
            var s = self._setupState || {};
            var summary = document.createElement('dl');
            summary.className = 'enm-wizard-summary';
            var rows = [];
            rows.push(['Chain', 'mainchain (ELA)']);
            if (s.binaryVersion) rows.push(['Version', s.binaryVersion]);
            rows.push(['Mode', self._choices.mode === 'full' ? 'Full node' : 'BPoS supernode']);
            if (s.publicKey) rows.push(['Producer public key', truncMid(s.publicKey, 14, 14)]);
            if (s.address) rows.push(['Producer address', s.address]);
            rows.forEach(function (r) {
                var dt = document.createElement('dt'); dt.textContent = r[0];
                var dd = document.createElement('dd'); dd.textContent = r[1];
                summary.appendChild(dt); summary.appendChild(dd);
            });
            self._body.appendChild(summary);

            var actions = document.createElement('div');
            actions.className = 'enm-wizard-actions';
            var startBtn = makeBtn('Write config & start node', 'primary', function () {
                startBtn.disabled = true;
                startBtn.textContent = 'Saving config...';
                self.api.post('/setup/network', { mode: 'auto' }).then(function () {
                    return self.api.post('/setup/complete', {});
                }).then(function () {
                    startBtn.textContent = 'Starting node...';
                    return self.api.post('/chains/mainchain/start');
                }).then(function () {
                    self.notifications.info('Node started', 'Loading dashboard...');
                    self.onComplete();
                }).catch(function (err) {
                    if (err && err.body && Array.isArray(err.body.conflicts)) {
                        var blockers = err.body.conflicts
                            .filter(function (c) { return c.severity === 'CRITICAL'; })
                            .map(function (c) { return '• ' + c.description; })
                            .join('\n');
                        self.notifications.critical('Cannot start — host conflicts', blockers || err.message);
                    } else {
                        self.notifications.warning('Could not finish setup', err.message || String(err));
                    }
                    startBtn.disabled = false;
                    startBtn.textContent = 'Retry';
                });
            });
            actions.appendChild(startBtn);
            self._body.appendChild(actions);
        }
    };

    // ===================================================================
    // helpers
    // ===================================================================

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
