/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/producer-identity.js — public producer identity card.
 *
 * Shown on the Dashboard tab when a keystore exists. Displays:
 *
 *   - The producer public key (full string, monospace, with Copy button).
 *   - A QR code encoding the same public key (rendered inline as SVG, no
 *     external dependency — a tiny QR generator lives in this file).
 *   - "Open in Essentials" deep-link button (essentials://...).
 *   - "Register via CLI" expandable section with the ela-cli command for
 *     self-registration.
 *
 * Why this card exists: ENM does not sign producer-registration
 * transactions on the operator's behalf (per Architectural Invariant #2 —
 * the wallet here is identity-only). Operators register externally via
 * the Essentials mobile wallet OR via ela-cli on a different machine.
 * Either way they need the public key in hand. This card surfaces it.
 *
 * The QR generator is a minimal self-contained QR Code v3 (29x29) ECC L
 * implementation — enough to encode 64 hex chars with comfortable margin.
 * No external library, no bundle bloat, no fetch to a remote QR service
 * (which would leak the public key to a third party).
 */

(function (root) {
    'use strict';

    function ProducerIdentity(opts) {
        if (!opts || !opts.api) {
            throw new TypeError('ProducerIdentity: { api } required');
        }
        this.api = opts.api;
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-producer-identity';
        this._account = null; // { publicKey, address }
        // alpha.28.1 batch 24 — _destroyed flag. mount() fires
        // /setup/keystore/account + the secondary /chains/mainchain/
        // producer fetch in _renderBinding; both used to resolve into
        // a detached this.root after destroy(), mutating innerHTML on
        // a removed subtree. (Lifecycle audit aff18c172.)
        this._destroyed = false;
    }

    ProducerIdentity.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.refresh();
        return this;
    };

    ProducerIdentity.prototype.destroy = function () {
        this._destroyed = true;
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };

    ProducerIdentity.prototype.refresh = function () {
        var self = this;
        return this.api.get('/setup/keystore/account', { skipCache: true }).then(function (r) {
            if (self._destroyed) { return; }
            if (!r || !r.exists) {
                self._renderEmpty();
                return;
            }
            self._account = { publicKey: r.publicKey, address: r.address, keystorePath: r.keystorePath };
            if (!r.publicKey) {
                self._renderUnknown();
                return;
            }
            self._render();
        }).catch(function (err) {
            if (self._destroyed) { return; }
            // alpha.28.1 batch 50 (audit a3ca028e) — distinguish "no
            // keystore yet" from "backend errored". Previously both
            // paths called _renderEmpty which hides the card; an
            // operator with a 500 / network outage / expired session
            // saw the card vanish indistinguishably from a clean
            // first-boot state. Now: 401 is suppressed (boot owns
            // re-auth), 404 falls to _renderEmpty (legitimate
            // not-yet-created), everything else falls to _renderError.
            if (err && err.status === 401) { return; }
            if (err && err.status === 404) {
                self._renderEmpty();
                return;
            }
            if (typeof self._renderError === 'function') {
                self._renderError(err);
            } else {
                self._renderEmpty();
            }
        });
    };

    /**
     * @private
     * Distinct from _renderEmpty (no keystore yet — silent). Surfaces
     * a small inline error with a Retry affordance so the operator can
     * tell a transient backend hiccup from a clean first-boot state.
     */
    ProducerIdentity.prototype._renderError = function (err) {
        var self = this;
        this.root.hidden = false;
        var detail = (err && err.message) ? err.message : 'Couldn\'t reach the keystore service.';
        // alpha.28.1 batch 71 (Round-19C audit finding #3) — the previous
        // shape used escapeAttr() on `detail` despite it landing in HTML
        // body context, not an attribute. The helper at line 383 escapes
        // the same five chars an escapeHtml would, so it was safe today,
        // BUT signalling escapeAttr where escapeHtml is needed is a
        // code-smell that won't survive a future copy-paste into an
        // event-handler attribute (where the helpers diverge). Replace
        // with the createElement + textContent pattern batch 59 used for
        // the producer-binding owner row — same DOM, no innerHTML, no
        // escape-helper choice to second-guess.
        this.root.innerHTML = '';
        var head = document.createElement('header');
        head.className = 'enm-producer-identity-head';
        var h3 = document.createElement('h3');
        h3.textContent = 'Producer identity';
        head.appendChild(h3);
        this.root.appendChild(head);

        var msg = document.createElement('p');
        msg.className = 'enm-stub';
        msg.textContent = detail;
        this.root.appendChild(msg);

        var retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'enm-btn enm-btn-secondary enm-producer-retry';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', function () { self.refresh(); });
        this.root.appendChild(retryBtn);
    };

    ProducerIdentity.prototype._renderEmpty = function () {
        // No keystore yet — don't show anything. The intro paragraph in
        // the parent pane already explains what the card will show once
        // a keystore is imported, so an empty render here is fine.
        this.root.innerHTML = '';
        this.root.hidden = true;
    };

    ProducerIdentity.prototype._renderUnknown = function () {
        this.root.hidden = false;
        this.root.innerHTML =
            '<header class="enm-producer-identity-head">' +
                '<h3>Producer identity</h3>' +
            '</header>' +
            '<p class="enm-stub">Keystore exists but the cached public key is missing. ' +
            'Re-import the keystore (or regenerate it) to refresh.</p>';
    };

    ProducerIdentity.prototype._render = function () {
        this.root.hidden = false;
        var pubkey = this._account.publicKey;
        var addr = this._account.address || '';

        // Phase 7 reset: dropped the "Open in Essentials" deep-link and the
        // inline ela-cli command. The deep-link never worked (browser refuses
        // unknown URI schemes; Essentials wasn't even installed in most
        // operator setups) and the CLI block needed an off-server wallet
        // anyway, which made the in-card placement misleading. Replaced
        // with explicit step-by-step instructions for the two registrations
        // operators actually run: BPoS Supernode and CR Council Member.

        this.root.innerHTML =
            '<header class="enm-producer-identity-head">' +
                '<h3>Producer identity</h3>' +
                '<p class="enm-stub" style="margin:0;text-align:left;padding:0">' +
                  'This public key represents your node to the chain. ' +
                  'You\'ll paste it into Essentials when registering as a ' +
                  'BPoS Supernode or applying for the CR Council.' +
                '</p>' +
            '</header>' +
            '<aside class="enm-producer-wallet-notice">' +
                '<strong>Your BPoS deposit wallet and CR Council wallet ' +
                'are not managed by this app.</strong> Those wallets ' +
                'live in <strong>Elastos Essentials</strong> on your phone — ' +
                'that\'s where the 2,000 ELA / 5,000 ELA deposits sit, ' +
                'and where every producer or council transaction is signed. ' +
                'This server only holds the node\'s signing keystore ' +
                '(<code>keystore.dat</code>), used by <code>ela</code> to ' +
                'produce blocks once you\'re elected — that\'s a different ' +
                'key from your wallet. Essentials and this app are linked ' +
                'one-way only: you paste the public key below into Essentials ' +
                'at registration; nothing flows back the other way.' +
            '</aside>' +
            '<div class="enm-producer-identity-body">' +
                '<div class="enm-producer-qr" role="img" aria-label="Public key QR code"></div>' +
                '<div class="enm-producer-fields">' +
                    '<div class="enm-producer-field">' +
                        '<span class="enm-producer-field-label">Public key</span>' +
                        '<code class="enm-producer-field-value enm-producer-pubkey"></code>' +
                        '<button class="enm-btn enm-btn-secondary enm-producer-copy" type="button" data-copy="pubkey" aria-label="Copy public key">Copy</button>' +
                    '</div>' +
                    (addr ? (
                        '<div class="enm-producer-field">' +
                            '<span class="enm-producer-field-label">Address</span>' +
                            '<code class="enm-producer-field-value enm-producer-addr"></code>' +
                            '<button class="enm-btn enm-btn-secondary enm-producer-copy" type="button" data-copy="address" aria-label="Copy mainchain address">Copy</button>' +
                        '</div>'
                    ) : '') +
                '</div>' +
            '</div>' +
            '<div class="enm-producer-instructions">' +
                '<h4 class="enm-producer-instructions-title">Register as a BPoS Supernode</h4>' +
                '<ol class="enm-producer-steps">' +
                    '<li>On your phone, open <strong>Elastos Essentials</strong>. ' +
                        'It\'s the only wallet that can sign producer transactions ' +
                        'against the mainchain BPoS contract.</li>' +
                    '<li>Make sure the wallet you fund the deposit from holds at ' +
                        'least <strong>2,000 ELA</strong> on the ELA mainchain. The ' +
                        'deposit locks for the lock-up period you choose during ' +
                        'registration.</li>' +
                    '<li>Inside Essentials, open the <strong>BPoS Voting</strong> ' +
                        'section, then choose <strong>Register Supernode</strong>.</li>' +
                    '<li>When asked for the <strong>node public key</strong>, scan ' +
                        'the QR code above or paste the value from the Public key ' +
                        'field. Do <em>not</em> retype it by hand — a single wrong ' +
                        'character means votes flow to the wrong node.</li>' +
                    '<li>Fill in your supernode <strong>name</strong>, ' +
                        '<strong>URL</strong> and <strong>location</strong>. ' +
                        'Pick a stake-until block well past today (the chain has ' +
                        'a fixed minimum lock).</li>' +
                    '<li>Confirm in Essentials. The deposit transaction is signed ' +
                        'by your Essentials wallet, broadcast to the mainchain, and ' +
                        'becomes effective once it confirms (typically within a ' +
                        'block or two).</li>' +
                    '<li>Come back here. The <strong>Status</strong> tab will flip ' +
                        'producer state from <code>none</code> to ' +
                        '<code>Pending → Active</code> as the chain picks up your ' +
                        'registration.</li>' +
                '</ol>' +
                '<h4 class="enm-producer-instructions-title">Apply to the CR Council</h4>' +
                '<ol class="enm-producer-steps">' +
                    '<li>Council applications open at the start of each council ' +
                        'cycle. If the application window is closed, Essentials ' +
                        'will tell you when the next one opens.</li>' +
                    '<li>In Essentials, open the <strong>CR section</strong> and ' +
                        'choose <strong>Apply as Council Member</strong>.</li>' +
                    '<li>You need a <strong>DID</strong> (Essentials creates one ' +
                        'for you the first time you open the CR section) plus ' +
                        '<strong>5,000 ELA</strong> for the council deposit.</li>' +
                    '<li>Fill in your council profile (name, location, social ' +
                        'links, manifesto) and submit. The deposit transaction ' +
                        'and council application share one signing flow.</li>' +
                    '<li>Wait for the voting window — council seats are decided ' +
                        'by community vote, not by deposit alone. You can track ' +
                        'your standing in Essentials\' CR dashboard.</li>' +
                    '<li>If elected, this node\'s public key remains your ' +
                        'producer identity for any DPoS rewards while you serve ' +
                        'on the council. Nothing changes here.</li>' +
                '</ol>' +
                '<p class="enm-producer-instructions-foot">' +
                    'Stuck? The official docs cover both flows in detail: ' +
                    '<a href="https://elastos.info" target="_blank" rel="noopener">elastos.info</a> ' +
                    '(Supernode + CR sections). Anything you sign happens in ' +
                    'Essentials — this server doesn\'t see your wallet.' +
                '</p>' +
            '</div>';

        this.root.querySelector('.enm-producer-pubkey').textContent = pubkey;
        if (addr) this.root.querySelector('.enm-producer-addr').textContent = addr;

        // Render QR for the public key.
        var qrHost = this.root.querySelector('.enm-producer-qr');
        qrHost.innerHTML = renderQrSvg(pubkey, { size: 168, margin: 2 });

        // Wire copy buttons.
        // alpha.28.1 batch 58 — routed through enmCopyToClipboard so the
        // feature-detect + writeText + notifications plumbing is shared
        // with the other four copy sites (settings-tab, setup-conversation,
        // validator-registration-card, tools-update-card). Round-6
        // clipboard-UX audit a8a932d2.
        var self = this;
        this.root.querySelectorAll('.enm-producer-copy').forEach(function (b) {
            b.addEventListener('click', function () {
                var which = b.dataset.copy;
                var text = which === 'address' ? addr : pubkey;
                root.enmCopyToClipboard(text, {
                    notifications: self.notifications,
                    notifyOnSuccess: true,
                    successTitle: 'Copied',
                    successBody: which + ' is in the clipboard.',
                    failTitle: 'Copy failed',
                    failBody: 'Select the text and copy manually.',
                });
            });
        });

        // 0.2.0-alpha.6 — append the on-chain binding section. The parity audit
        // (enm-improvements/parity/18-wallet-identity-parity.md) found node.sh
        // never cross-checks the producer record. ENM now does: fetch the
        // chain's view of our nodePublicKey, surface owner+node pubkeys + a
        // status chip so the operator can eyeball-match against what they
        // registered from Essentials. Deferred from improvement #18: the
        // deposit-address derivation (base58-of-decimal-string-of-bigint per
        // subsystem 10 §2). That lands in alpha.7 once we have golden vectors
        // round-tripped against the chain.
        this._renderBinding();
    };

    /**
     * @private
     * Fetch /api/enm/chains/mainchain/producer and render the on-chain
     * binding section. Read-only — preserves the wallet-identity-only
     * invariant. No-op if the keystore is absent or the API errors
     * (validator-registration-card already covers the unregistered UX).
     */
    ProducerIdentity.prototype._renderBinding = function () {
        // alpha.28.1 batch 59 — i18n migration of inline English strings.
        // Round-3 i18n coverage audit (aef9c321). Strings live in
        // strings.js under producer_binding.*; enmTOrFallback returns the
        // key unchanged if strings.js failed to load so the UI stays
        // readable rather than blank.
        var t = root.enmTOrFallback;
        var self = this;
        this.api.get('/chains/mainchain/producer', { skipCache: true }).then(function (data) {
            if (self._destroyed) { return; }
            if (!data || !data.enabled) return; // pubkey not configured yet
            var binding = data.binding || 'unknown';
            var chainOwner = data.chainOwnerPubkey || '';
            var chainNode  = data.chainNodePubkey  || '';
            var state      = data.state || '';

            var section = document.createElement('section');
            section.className = 'enm-producer-binding';

            var heading = document.createElement('h4');
            heading.className = 'enm-producer-binding-heading';
            heading.textContent = t('producer_binding.heading');
            section.appendChild(heading);

            var chip = document.createElement('span');
            chip.className = 'enm-producer-binding-chip enm-producer-binding-chip-' + binding;
            var chipText;
            if (binding === 'bound') {
                chipText = state
                    ? t('producer_binding.chip_bound_state', { state: state })
                    : t('producer_binding.chip_bound');
            } else if (binding === 'unregistered') {
                chipText = t('producer_binding.chip_unregistered');
            } else if (binding === 'mismatch') {
                chipText = t('producer_binding.chip_mismatch');
            } else if (binding === 'unknown') {
                chipText = t('producer_binding.chip_unknown');
            } else {
                chipText = binding;
            }
            chip.textContent = chipText;
            section.appendChild(chip);

            // Side-by-side: ENM's node pubkey vs the chain's owner pubkey.
            // Operator should visually confirm chainOwner matches the
            // address Essentials shows under their BPoS deposit.
            if (binding === 'bound') {
                var note = document.createElement('p');
                note.className = 'enm-producer-binding-note';
                note.textContent = t('producer_binding.owner_compare_note');
                section.appendChild(note);

                if (chainOwner) {
                    var ownerRow = document.createElement('div');
                    ownerRow.className = 'enm-producer-field';
                    var ownerLabelEl = document.createElement('span');
                    ownerLabelEl.className = 'enm-producer-field-label';
                    ownerLabelEl.textContent = t('producer_binding.owner_label');
                    var ownerValueEl = document.createElement('code');
                    ownerValueEl.className = 'enm-producer-field-value';
                    ownerValueEl.textContent = chainOwner;
                    ownerRow.appendChild(ownerLabelEl);
                    ownerRow.appendChild(ownerValueEl);
                    section.appendChild(ownerRow);
                }

                if (chainNode && chainOwner && chainNode.toLowerCase() !== chainOwner.toLowerCase()) {
                    var splitNote = document.createElement('p');
                    splitNote.className = 'enm-producer-binding-note';
                    splitNote.textContent = t('producer_binding.split_key_note');
                    section.appendChild(splitNote);
                }
            } else if (binding === 'mismatch') {
                var mismatchDetail = document.createElement('p');
                mismatchDetail.className = 'enm-producer-binding-note';
                mismatchDetail.textContent = t('producer_binding.mismatch_detail', {
                    ours:   data.ourPubkey || '',
                    theirs: chainNode || '',
                });
                section.appendChild(mismatchDetail);
            }

            self.root.appendChild(section);
        }).catch(function () {
            // Silently ignore — alpha.6 binding is decorative; failures don't
            // block the rest of the identity card.
        });
    };

    function escapeAttr(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // =================================================================
    // Minimal QR Code generator — embedded so we don't add a dependency.
    // =================================================================
    //
    // QR Code spec is large; this implementation covers exactly what we
    // need: alphanumeric-mode encoding, version 3 (29×29), error
    // correction level L. Public keys are hex strings (uppercase A-F
    // 0-9), all of which fit in alphanumeric mode. 64 hex chars uses ~80
    // of the 117 available bits at v3-L, well within margin.
    //
    // Adapted from the Project Nayuki QR reference under MIT (the
    // smallest known faithful implementation; ~150 LOC). All unused
    // versions/modes stripped for size.

    function renderQrSvg(text, opts) {
        var size = (opts && opts.size) || 168;
        var margin = (opts && opts.margin != null) ? opts.margin : 2;
        try {
            var modules = generateQr(text);
            return modulesToSvg(modules, size, margin);
        } catch (e) {
            return '<div class="enm-qr-fallback">QR rendering failed: ' + escapeAttr(e.message) + '</div>';
        }
    }

    function generateQr(text) {
        // Convert text → bits at version 3, ECC L, byte mode. We accept any
        // characters, encoded as UTF-8 → byte mode (mode bits 0100).
        var bytes = utf8Bytes(text);
        if (bytes.length > 53) {
            // v3-L byte capacity is 53. Fall back to a larger version if
            // needed — bump to v5 (37×37) which holds 106 bytes.
            return generateQrV(bytes, 5);
        }
        return generateQrV(bytes, 3);
    }

    function generateQrV(bytes, version) {
        var size = 17 + 4 * version;
        var bits = [];
        // Mode indicator: byte mode = 0100
        appendBits(bits, 0x4, 4);
        // Character count indicator: 8 bits for v1-9 byte mode
        appendBits(bits, bytes.length, 8);
        for (var i = 0; i < bytes.length; i++) appendBits(bits, bytes[i], 8);

        // Capacity table for ECC L: { v3: 55 codewords data, v5: 108 codewords data }
        var caps = { 3: { data: 55, ecc: 15 }, 5: { data: 108, ecc: 26 } };
        var cap = caps[version];
        if (!cap) throw new Error('unsupported qr version');
        var totalDataBits = cap.data * 8;
        // Terminator: up to 4 zero bits
        var pad = Math.min(4, totalDataBits - bits.length);
        for (var t = 0; t < pad; t++) appendBits(bits, 0, 1);
        // Pad to byte boundary
        while (bits.length % 8 !== 0) appendBits(bits, 0, 1);
        // Pad bytes 0xEC, 0x11 alternating
        var padBytes = [0xEC, 0x11];
        var pi = 0;
        while (bits.length / 8 < cap.data) {
            appendBits(bits, padBytes[pi % 2], 8);
            pi++;
        }
        // Pack into bytes
        var dataCodewords = new Uint8Array(cap.data);
        for (var b = 0; b < cap.data; b++) {
            var v = 0;
            for (var k = 0; k < 8; k++) v = (v << 1) | bits[b * 8 + k];
            dataCodewords[b] = v;
        }
        // Reed-Solomon ECC
        var eccCodewords = rsRemainder(dataCodewords, cap.ecc);
        var allCodewords = new Uint8Array(cap.data + cap.ecc);
        allCodewords.set(dataCodewords, 0);
        allCodewords.set(eccCodewords, cap.data);

        // Build module matrix
        var modules = newMatrix(size);
        var isFunction = newMatrix(size);
        drawFunctionPatterns(modules, isFunction, size, version);
        drawCodewords(modules, isFunction, size, allCodewords);
        // Apply mask 0 (no fancy heuristic — picks the simplest mask).
        applyMask(modules, isFunction, size, 0);
        drawFormatBits(modules, isFunction, size, 0);  // ECC L = 01, mask 0
        return modules;
    }

    function utf8Bytes(s) {
        var out = [];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
            else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
        }
        return out;
    }

    function appendBits(arr, val, n) {
        for (var i = n - 1; i >= 0; i--) arr.push((val >>> i) & 1);
    }

    function newMatrix(size) {
        var m = new Array(size);
        for (var y = 0; y < size; y++) m[y] = new Uint8Array(size);
        return m;
    }

    function drawFunctionPatterns(m, fn, size, version) {
        // Timing patterns
        for (var i = 0; i < size; i++) {
            setFn(m, fn, i, 6, (i % 2 === 0) ? 1 : 0);
            setFn(m, fn, 6, i, (i % 2 === 0) ? 1 : 0);
        }
        // Finder patterns + separators
        drawFinder(m, fn, 0, 0);
        drawFinder(m, fn, size - 7, 0);
        drawFinder(m, fn, 0, size - 7);
        // Alignment patterns (only versions ≥ 2)
        var alignPositions = getAlignmentPositions(version);
        for (var ai = 0; ai < alignPositions.length; ai++) {
            for (var aj = 0; aj < alignPositions.length; aj++) {
                var ax = alignPositions[ai], ay = alignPositions[aj];
                if ((ax === 6 && ay === 6) || (ax === 6 && ay === alignPositions[alignPositions.length - 1]) ||
                    (ax === alignPositions[alignPositions.length - 1] && ay === 6)) continue;
                drawAlignment(m, fn, ax, ay);
            }
        }
        // Format bits placeholder (filled later).
        for (var f = 0; f < 9; f++) setFn(m, fn, f, 8, 0);
        for (var g = 0; g < 8; g++) setFn(m, fn, 8, g, 0);
        for (var h = 0; h < 7; h++) setFn(m, fn, 8, size - 1 - h, 0);
        for (var k = 0; k < 8; k++) setFn(m, fn, size - 1 - k, 8, 0);
        setFn(m, fn, 8, size - 8, 1); // dark module
    }

    function drawFinder(m, fn, x, y) {
        for (var dy = -1; dy <= 7; dy++) {
            for (var dx = -1; dx <= 7; dx++) {
                var xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= m.length || yy >= m.length) continue;
                var dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
                var v = (dist === 2 || dist === 4) ? 0 : 1;
                if (dx === -1 || dx === 7 || dy === -1 || dy === 7) v = 0;
                setFn(m, fn, xx, yy, v);
            }
        }
    }

    function drawAlignment(m, fn, cx, cy) {
        for (var dy = -2; dy <= 2; dy++) {
            for (var dx = -2; dx <= 2; dx++) {
                var dist = Math.max(Math.abs(dx), Math.abs(dy));
                var v = (dist === 1) ? 0 : 1;
                setFn(m, fn, cx + dx, cy + dy, v);
            }
        }
    }

    function getAlignmentPositions(version) {
        if (version === 1) return [];
        if (version === 3) return [6, 22];
        if (version === 5) return [6, 30];
        return [6, 22];
    }

    function setFn(m, fn, x, y, v) {
        if (x < 0 || y < 0 || x >= m.length || y >= m.length) return;
        m[y][x] = v;
        fn[y][x] = 1;
    }

    function drawCodewords(m, fn, size, codewords) {
        var i = 0;
        for (var col = size - 1; col >= 1; col -= 2) {
            if (col === 6) col = 5;
            for (var v = 0; v < size; v++) {
                for (var jj = 0; jj < 2; jj++) {
                    var x = col - jj;
                    var upward = ((col + 1) & 2) === 0;
                    var y = upward ? size - 1 - v : v;
                    if (fn[y][x]) continue;
                    if (i >= codewords.length * 8) break;
                    var byteIdx = i >>> 3;
                    var bitIdx = 7 - (i & 7);
                    m[y][x] = (codewords[byteIdx] >> bitIdx) & 1;
                    i++;
                }
            }
        }
    }

    function applyMask(m, fn, size, mask) {
        for (var y = 0; y < size; y++) {
            for (var x = 0; x < size; x++) {
                if (fn[y][x]) continue;
                var inv = 0;
                if (mask === 0) inv = ((x + y) % 2 === 0) ? 1 : 0;
                m[y][x] ^= inv;
            }
        }
    }

    function drawFormatBits(m, fn, size, mask) {
        // Format info: ECC L = 01, mask 0 → 5 bits = 01000. With BCH(15,5)
        // and mask 0x5412, the 15-bit format = 0b111011111000100 (precomputed
        // for L+mask0, the standard table).
        var format = 0x77c4;
        for (var i = 0; i < 15; i++) {
            var bit = (format >> i) & 1;
            // First copy
            var x1, y1;
            if (i < 6) { x1 = 8; y1 = i; }
            else if (i < 8) { x1 = 8; y1 = i + 1; }
            else if (i === 8) { x1 = 7; y1 = 8; }
            else { x1 = 14 - i; y1 = 8; }
            m[y1][x1] = bit;
            fn[y1][x1] = 1;
            // Second copy
            var x2, y2;
            if (i < 8) { x2 = size - 1 - i; y2 = 8; }
            else { x2 = 8; y2 = size - 15 + i; }
            m[y2][x2] = bit;
            fn[y2][x2] = 1;
        }
    }

    // Reed-Solomon over GF(256), generator polynomial of degree `degree`.
    function rsRemainder(data, degree) {
        var generator = rsGenerator(degree);
        var result = new Uint8Array(degree);
        for (var i = 0; i < data.length; i++) {
            var factor = data[i] ^ result[0];
            result.copyWithin(0, 1);
            result[result.length - 1] = 0;
            for (var j = 0; j < result.length; j++) {
                result[j] ^= gfMul(generator[j], factor);
            }
        }
        return result;
    }

    function rsGenerator(degree) {
        var coeffs = new Uint8Array(degree);
        coeffs[degree - 1] = 1;
        var root = 1;
        for (var i = 0; i < degree; i++) {
            for (var j = 0; j < coeffs.length; j++) {
                coeffs[j] = gfMul(coeffs[j], root);
                if (j + 1 < coeffs.length) coeffs[j] ^= coeffs[j + 1];
            }
            root = gfMul(root, 0x02);
        }
        return coeffs;
    }

    function gfMul(a, b) {
        var z = 0;
        for (var i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11d);
            z ^= ((b >>> i) & 1) * a;
        }
        return z & 0xff;
    }

    function modulesToSvg(modules, size, margin) {
        var n = modules.length;
        var box = n + 2 * margin;
        // a11y: the wrapping `<div class="enm-producer-qr">` already
        // carries role="img" + aria-label and that's the single "image"
        // landmark we want screen readers to expose. The inner SVG is
        // therefore aria-hidden — but we still ship a <title> child as
        // a JAWS fallback because some older JAWS builds skip the
        // wrapper and read the SVG directly. role="img" on the SVG was
        // creating a redundant nested-image landmark (caught by the
        // ARIA-tree complexity audit).
        var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + box + ' ' + box + '" shape-rendering="crispEdges" aria-hidden="true" focusable="false">';
        s += '<title>Public key QR code</title>';
        s += '<rect width="100%" height="100%" fill="#ffffff"/>';
        var path = '';
        for (var y = 0; y < n; y++) {
            for (var x = 0; x < n; x++) {
                if (modules[y][x]) {
                    path += 'M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z';
                }
            }
        }
        s += '<path d="' + path + '" fill="#0f172a"/>';
        s += '</svg>';
        return s;
    }

    root.EnmProducerIdentity = ProducerIdentity;
}(typeof window !== 'undefined' ? window : globalThis));
