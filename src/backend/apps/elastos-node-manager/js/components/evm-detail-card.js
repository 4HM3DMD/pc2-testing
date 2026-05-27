/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/evm-detail-card.js — Council Node UX Phase 3 (v0.5.187).
 *
 * Additive per-chain dashboard card for EVM sidechains (Class B: esc / eid /
 * pg). It mounts BELOW the shared chain-card hero, which already shows
 * height / state / sync / health / start-stop-restart for every class. The
 * chain-card is the Main Chain (Class A) reference and is intentionally left
 * untouched — this card lives alongside it for Class B only, so the Class-A
 * render path is byte-for-byte unchanged.
 *
 * Surfaces the three EVM-specific values the generic hero never shows and
 * that an operator most wants to verify:
 *   1. Validator status           (derived from miner.chainState — backed
 *                                  by detectProducerRole against the
 *                                  on-chain CR-Council / DPoS arbiter
 *                                  slate; NOT an operator toggle)
 *   2. EVM account address        (the geth keystore account — evmKeystoreAddr)
 *   3. Block-reward address       (operator-supplied — miner.rewardAddress)
 *
 * Data source: GET /api/enm/chains/:id → .miner { enabled, evmKeystoreAddr,
 * rewardAddress } (added in Phase 1, P1.1). Real-data-only: a null field
 * renders as "—", never a fabricated address. The encrypted account password
 * is never sent by the backend and is never shown here.
 *
 * The per-EVM-chain binary Update flow is Phase 5, not here. Node output
 * lives in the Logs tab; this card does not invent an error line.
 *
 * Polling: 60 s, visibility-paused (addresses + the mining flag change
 * rarely). alpha.28 invariants preserved: _destroyed guard on async
 * resolves, 401-suppress on the background fetch, enmCopyButton for copy,
 * aria-labelledby on the card root. Copy is inline English to match the
 * peer node-identity-card (pending any future bulk i18n pass).
 *
 * v0.5.228 — Block-reward address is operator-editable inline. EIP-55
 * client-side validation via enmEthAddress.check; PUT
 * /chains/:id/class-b-config writes miner.rewardAddress; on success a
 * "restart to apply" hint surfaces with an inline restart-now button when
 * the chain is currently running (so the new --pbft.miner.address takes
 * effect on the relaunched geth process). The EVM account row stays
 * read-only — that's the auto-generated local keystore account and
 * changing it would orphan the geth keystore.
 */

(function (root) {
    'use strict';

    var POLL_INTERVAL_MS = 60_000;
    // v0.5.228 — chain states the backend reports for a *running* EVM chain
    // (synced / actively-syncing / starting). When the chain is in one of
    // these, a reward-address change needs a restart to take effect; when
    // it's stopped / unconfigured / disabled, the change is picked up
    // automatically on next start. Treats v1 aliases (running / healthy)
    // as alive too in case enmStateVocab isn't loaded.
    var ALIVE_STATES = ['synced', 'syncing', 'starting', 'stalled', 'running', 'healthy'];
    function isChainAlive(state) {
        if (root.enmStateVocab && typeof root.enmStateVocab.isAlive === 'function') {
            return !!root.enmStateVocab.isAlive(state);
        }
        return state ? ALIVE_STATES.indexOf(String(state)) >= 0 : false;
    }

    function EvmDetailCard(opts) {
        if (!opts || !opts.api) { throw new TypeError('EnmEvmDetailCard: { api } required'); }
        if (!opts.chainId)      { throw new TypeError('EnmEvmDetailCard: { chainId } required'); }
        this.api           = opts.api;
        this.chainId       = opts.chainId;
        this.notifications = opts.notifications || null;

        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-section-card enm-evm-detail-card';
        this.root.setAttribute('role', 'region');
        this._titleId = 'enm-evm-detail-title-' + Math.random().toString(36).slice(2, 8);
        this.root.setAttribute('aria-labelledby', this._titleId);
        this.root.innerHTML =
            '<header class="enm-section-card-head">'
            + '<div class="enm-section-card-headbody">'
            +   '<div class="enm-section-card-title" id="' + this._titleId + '">Mining &amp; rewards</div>'
            +   '<div class="enm-section-card-help">Reading EVM mining configuration…</div>'
            + '</div>'
            + '</header>';

        this._destroyed  = false;
        this._pollPauser = null;
        this._pollTimer  = null;
        this._lastMiner  = null;
        this._lastState  = null;  // v0.5.228 — most-recent chain state for restart-now affordance
        this._lastHtml   = null;  // v0.5.191 — render-dedup cache
        // v0.5.228 — reward-address inline editor state. While editing,
        // background polls stash new data into _lastMiner but do NOT
        // rebuild the DOM (would wipe the operator's in-flight input).
        this._editingReward       = false;
        this._editingValue        = '';
        this._editorMsg           = '';
        this._editorMsgKind       = '';   // '' | 'ok' | 'err' | 'warn'
        this._pendingRestartHint  = false;  // set true after save; cleared after restart-now
    }

    EvmDetailCard.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        var self = this;
        this._poll();
        if (typeof root.enmUseVisibilityPause === 'function') {
            this._pollPauser = root.enmUseVisibilityPause(function () { self._poll(); }, POLL_INTERVAL_MS);
        } else {
            this._pollTimer = setInterval(function () { self._poll(); }, POLL_INTERVAL_MS);
        }
        return this;
    };

    EvmDetailCard.prototype.refresh = function () { this._poll(); };

    EvmDetailCard.prototype.destroy = function () {
        this._destroyed = true;
        if (this._pollPauser) {
            try { this._pollPauser.stop(); } catch (_) { /* idempotent */ }
            this._pollPauser = null;
        }
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
    };

    /** @private */
    EvmDetailCard.prototype._poll = function () {
        var self = this;
        this.api.get('/chains/' + this.chainId).then(function (env) {
            if (self._destroyed) { return; }
            var d = (env && env.result) || (env && env.data) || env || {};
            self._lastMiner = d.miner || null;
            self._lastState = (d && d.state) || null;
            // v0.5.228 — never rebuild the DOM while the operator is mid-edit
            // (would wipe their typed input). The latest data is stashed in
            // _lastMiner/_lastState and will be used by the next render after
            // the editor exits.
            if (self._editingReward) { return; }
            self._render(d);
        }).catch(function (err) {
            if (self._destroyed) { return; }
            if (err && err.status === 401) { return; }  // boot path owns re-auth
            // Keep the last good render; only show an error sub if we never had one.
            if (!self._lastMiner) {
                var help = self.root.querySelector('.enm-section-card-help');
                if (help) { help.textContent = 'Couldn’t read mining configuration — retrying every 60s.'; }
            }
        });
    };

    /** @private */
    EvmDetailCard.prototype._render = function (d) {
        var miner = d && d.miner ? d.miner : null;
        var evmAddr = miner && miner.evmKeystoreAddr ? miner.evmKeystoreAddr : null;
        var rewardAddr = miner && miner.rewardAddress ? miner.rewardAddress : null;
        var chainState = (d && d.state) || this._lastState;
        var chainAlive = isChainAlive(chainState);

        // v0.5.228d (audit F4/F5/F6) — read the DERIVED validator state
        // from the new miner.chainState field (now returned by GET
        // /chains/:id alongside miner.enabled). Pre-228d the header tag
        // read cfg.miner.enabled which is the on-disk operator-set
        // value; after a real Council binding the spawn path's
        // in-memory override of miner.enabled is NOT persisted, so the
        // disk value stayed stale and the dashboard tag could disagree
        // with the live badge in Settings. miner.chainState comes from
        // the same chainStateFromRole helper the /system/council-status
        // endpoint uses, so both surfaces always agree.
        //
        // Fallback to the legacy miner.enabled if chainState is missing
        // (older backend version, mainchain RPC down, fresh install
        // before first detect). This keeps the tag rendering even when
        // the derived data is unavailable.
        var validatorState = (miner && miner.chainState) ? miner.chainState : null;
        if (!validatorState && miner) {
            validatorState = miner.enabled ? 'on-duty' : 'inactive';
        }
        var mining = validatorState === 'on-duty';
        var TAG_LABELS = {
            'on-duty':  { cls: 'success', text: 'Validator · On-duty' },
            'standby':  { cls: 'warn',    text: 'Validator · Standby' },
            'inactive': { cls: 'muted',   text: 'Validator · Inactive' },
            'unknown':  { cls: 'muted',   text: 'Validator · Detecting' },
            'follower': { cls: 'muted',   text: 'Validator · Follower' },
        };
        var tagMeta = TAG_LABELS[validatorState] || TAG_LABELS.inactive;
        var tag = '<span class="enm-section-card-tag ' + tagMeta.cls + '">'
            + tagMeta.text + '</span>';

        // v0.5.228 patch — re-ordered so reward address (operator-supplied,
        // the thing they configured at setup) shows FIRST, and the auto-
        // generated EVM account second. Pre-patch the operator's eye landed
        // on "EVM account: —" (which is blank only because this node isn't
        // mining yet — the geth keystore is lazily created on first mining
        // start) and read "no mining address". The reward address — the
        // one they actually entered — was below the fold of the value
        // stack. Reordering + tighter EVM-account hint copy resolves it.
        var evmAccountHint = mining
            ? 'Local geth keystore account this node mines with. Auto-generated; never operator-supplied.'
            : 'Local geth keystore account — only created the first time this node mines. Blank here doesn\'t affect rewards (those go to the address below).';
        var html = ''
            + '<header class="enm-section-card-head">'
            +   '<div class="enm-section-card-headbody">'
            +     '<div class="enm-section-card-title" id="' + this._titleId + '">Mining &amp; rewards</div>'
            +     '<div class="enm-section-card-help">'
            +       (mining
                       ? 'This node produces blocks for the sidechain. Block rewards are credited to the reward address below.'
                       : 'This node is a follower (not producing blocks). The reward address stays configured for if you ever turn mining on — followers don\'t earn EVM block rewards.')
            +     '</div>'
            +   '</div>'
            +   tag
            + '</header>'
            + '<div class="enm-section-card-body">'
            +   '<div class="enm-detail-list">'
            +     this._addrRow('Block reward address',
                    'Where this node\'s block rewards are credited (geth flag --pbft.miner.address). '
                    + 'You can change this safely; the new address applies on next chain start.',
                    rewardAddr, 'reward', { editable: true })
            +     this._addrRow('EVM account', evmAccountHint, evmAddr, 'evm-account', { editable: false })
            +   '</div>'
            + '</div>'
            + '<div class="enm-section-card-foot">'
            +   '<span class="enm-section-card-foot-status">Node output is in the Logs tab.</span>'
            + '</div>';

        // v0.5.191 perf — skip the rebuild when the 60s poll produced identical
        // markup (the common steady state — addresses + the mining flag rarely
        // change). MUST early-return before the copy-button mount below, which
        // appends (not replaces) — re-running it on unchanged DOM would stack
        // duplicate copy buttons. Every render-relevant value (mining flag,
        // both addresses via data-copy-value + is-empty) is in `html`.
        if (html === this._lastHtml) {
            // Still need to refresh the post-save editor msg / restart-now
            // hint without rebuilding the whole card.
            this._refreshEditorBanner(chainAlive);
            return;
        }
        this._lastHtml = html;
        this.root.innerHTML = html;

        // Fill long monospace values via textContent (deterministic copy-by-selection).
        var fillEvm = this.root.querySelector('[data-fill="evm-account"]');
        if (fillEvm) { fillEvm.textContent = evmAddr || '—'; }
        var fillReward = this.root.querySelector('[data-fill="reward"]');
        if (fillReward) { fillReward.textContent = rewardAddr || '—'; }

        // Mount copy buttons only for rows that have a real value.
        if (typeof root.enmCopyButton === 'function') {
            var slots = this.root.querySelectorAll('.enm-detail-copy-slot');
            for (var i = 0; i < slots.length; i++) {
                (function (slot) {
                    var value = slot.getAttribute('data-copy-value') || '';
                    if (!value) { return; }
                    var btn = root.enmCopyButton({
                        value: value,
                        label: 'Copy',
                        ariaLabel: 'Copy ' + (slot.dataset.copy || 'value'),
                        notifications: null,
                        className: 'enm-detail-copy-btn',
                    });
                    slot.appendChild(btn);
                })(slots[i]);
            }
        }

        // v0.5.228 — wire the reward-address Edit button + render any
        // post-save editor banner / restart-now affordance.
        this._wireRewardEditor();
        this._refreshEditorBanner(chainAlive);
    };

    /** @private — wire the Edit button on the reward row.
     * Clicking it swaps the value cell for an inline editor (input +
     * Save + Cancel + status line). The card-level _editingReward flag
     * pauses background re-renders so the operator's typed input is
     * never wiped under their fingers by a 60s poll. */
    EvmDetailCard.prototype._wireRewardEditor = function () {
        var self = this;
        var editBtn = this.root.querySelector('[data-edit="reward"]');
        if (!editBtn) { return; }
        editBtn.addEventListener('click', function () { self._enterRewardEdit(); });
    };

    /** @private — render or remove the post-save banner that tells the
     * operator a restart is required to apply the new address. Idempotent
     * so we can call it from both the dedup-skip and full-rebuild paths. */
    EvmDetailCard.prototype._refreshEditorBanner = function (chainAlive) {
        // Banner lives at the top of the card body so it sits near the
        // addresses without disturbing the row layout.
        var body = this.root.querySelector('.enm-section-card-body');
        if (!body) { return; }
        var existing = body.querySelector('.enm-evm-reward-banner');
        if (!this._pendingRestartHint) {
            if (existing) { existing.parentNode.removeChild(existing); }
            return;
        }
        var html = ''
            + '<div class="enm-evm-reward-banner" role="status" aria-live="polite">'
            +   '<div class="enm-evm-reward-banner-msg">'
            +     (chainAlive
                    ? 'Reward address saved. The currently running chain still uses the previous address — restart it to apply the change.'
                    : 'Reward address saved. The new address will be used the next time this chain is started.')
            +   '</div>'
            +   (chainAlive
                  ? '<button type="button" class="enm-btn enm-btn-primary enm-btn-sm" data-action="reward-restart">Restart chain now</button>'
                  : '<button type="button" class="enm-btn enm-btn-sm" data-action="reward-dismiss">Got it</button>')
            + '</div>';
        if (existing) {
            existing.outerHTML = html;
        } else {
            body.insertAdjacentHTML('afterbegin', html);
        }
        var self = this;
        var restartBtn = body.querySelector('[data-action="reward-restart"]');
        if (restartBtn) {
            restartBtn.addEventListener('click', function () { self._restartChainAfterSave(restartBtn); });
        }
        var dismissBtn = body.querySelector('[data-action="reward-dismiss"]');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', function () {
                self._pendingRestartHint = false;
                self._refreshEditorBanner(false);
            });
        }
    };

    /** @private — swap the reward value cell with an inline editor. */
    EvmDetailCard.prototype._enterRewardEdit = function () {
        if (this._editingReward) { return; }  // already open
        this._editingReward = true;
        this._editingValue = (this._lastMiner && this._lastMiner.rewardAddress) || '';
        this._editorMsg = '';
        this._editorMsgKind = '';
        this._renderRewardEditor();
    };

    /** @private — close the editor without saving. */
    EvmDetailCard.prototype._exitRewardEdit = function () {
        this._editingReward = false;
        this._editingValue = '';
        this._editorMsg = '';
        this._editorMsgKind = '';
        // Force a re-render of the row by invalidating the dedup cache; the
        // next _render() call from a poll OR our immediate trigger below
        // will rebuild the row with the latest backend value.
        this._lastHtml = null;
        this._poll();
    };

    /** @private — render the inline editor over the reward row. We keep
     * the rest of the card intact and only replace the row contents. */
    EvmDetailCard.prototype._renderRewardEditor = function () {
        var row = this.root.querySelector('.enm-detail-addr-row[data-key="reward"]');
        if (!row) { return; }
        row.classList.add('is-editing');
        // Preserve the row head (label + hint); only swap the value stack.
        var stack = row.querySelector('.enm-detail-value-stack');
        if (!stack) { return; }
        var v = this._editingValue || '';
        var inputId = 'enm-evm-reward-edit-' + Math.random().toString(36).slice(2, 8);
        var msgClass = this._editorMsgKind ? (' is-' + this._editorMsgKind) : '';
        stack.outerHTML = ''
            + '<div class="enm-detail-edit-row" role="group" aria-label="Edit reward address">'
            +   '<label class="enm-sr-only" for="' + inputId + '">Reward address</label>'
            +   '<input type="text" id="' + inputId
            +     '" class="enm-input enm-detail-edit-input"'
            +     ' autocomplete="off" spellcheck="false" inputmode="text"'
            +     ' placeholder="0x… (40 hex characters)"'
            +     ' value="' + esc(v) + '">'
            +   '<div class="enm-detail-edit-actions">'
            +     '<button type="button" class="enm-btn enm-btn-sm" data-action="reward-cancel">Cancel</button>'
            +     '<button type="button" class="enm-btn enm-btn-primary enm-btn-sm" data-action="reward-save">Save</button>'
            +   '</div>'
            +   '<div class="enm-detail-edit-msg' + msgClass + '" role="status" aria-live="polite">'
            +     esc(this._editorMsg || '')
            +   '</div>'
            + '</div>';

        var input = row.querySelector('.enm-detail-edit-input');
        var saveBtn = row.querySelector('[data-action="reward-save"]');
        var cancelBtn = row.querySelector('[data-action="reward-cancel"]');
        var self = this;
        if (input) {
            input.addEventListener('input', function () { self._editingValue = input.value; });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); self._saveReward(saveBtn); }
                else if (e.key === 'Escape') { e.preventDefault(); self._exitRewardEdit(); }
            });
            // Focus + select-all so the operator can immediately overwrite or copy-paste.
            setTimeout(function () {
                if (self._destroyed) { return; }
                try { input.focus(); input.select(); } catch (_) {}
            }, 0);
        }
        if (cancelBtn) { cancelBtn.addEventListener('click', function () { self._exitRewardEdit(); }); }
        if (saveBtn) { saveBtn.addEventListener('click', function () { self._saveReward(saveBtn); }); }
    };

    /** @private — validate + PUT the new reward address. */
    EvmDetailCard.prototype._saveReward = function (saveBtn) {
        var self = this;
        var raw = String(this._editingValue || '').trim();
        // Empty value clears the operator-supplied reward address (rewards
        // then fall back to the geth keystore default per FIX-C12b). Treat
        // explicit-empty as a valid intent.
        var payload;
        if (raw === '') {
            payload = '';
        } else {
            var check = (root.enmEthAddress && typeof root.enmEthAddress.check === 'function')
                ? root.enmEthAddress.check(raw)
                : null;
            if (!check) {
                this._editorMsg = 'Address validator unavailable. Refresh the page.';
                this._editorMsgKind = 'err';
                this._renderRewardEditor();
                return;
            }
            if (!check.ok) {
                if (check.error === 'missing_0x') {
                    this._editorMsg = 'Missing "0x" prefix. Suggested: ' + check.suggested;
                } else if (check.error === 'format') {
                    this._editorMsg = 'Not a valid Ethereum address (need 0x + 40 hex characters).';
                } else if (check.error === 'eip55_checksum') {
                    // Soft offer the corrected form rather than block.
                    this._editorMsg = 'EIP-55 checksum mismatch. Did you mean ' + check.suggested + ' ?';
                } else {
                    this._editorMsg = 'Invalid address.';
                }
                this._editorMsgKind = 'err';
                this._renderRewardEditor();
                return;
            }
            payload = check.normalized;
        }
        // Spinner + disable while in flight.
        var doSave = function () {
            return self.api.put('/chains/' + self.chainId + '/class-b-config', {
                miner: { rewardAddress: payload },
            }).then(function () {
                if (self._destroyed) { return; }
                self._editingReward = false;
                self._editorMsg = '';
                self._editorMsgKind = '';
                self._pendingRestartHint = true;  // surfaces the banner on next render
                // Refresh: pull updated cfg.miner; the banner will mention
                // restart-required iff the chain is currently alive.
                self._lastHtml = null;
                self._poll();
            }).catch(function (err) {
                if (self._destroyed) { return; }
                var msg = (err && err.body && err.body.error && err.body.error.message)
                    || (err && err.message)
                    || 'Save failed.';
                self._editorMsg = msg;
                self._editorMsgKind = 'err';
                // Re-render editor so the operator can correct + retry.
                self._renderRewardEditor();
            });
        };
        if (typeof root.enmRunOnce === 'function' && saveBtn) {
            root.enmRunOnce(saveBtn, 'Saving…', doSave);
        } else {
            doSave();
        }
    };

    /** @private — call POST /chains/:id/restart from the post-save banner. */
    EvmDetailCard.prototype._restartChainAfterSave = function (btn) {
        var self = this;
        var doRestart = function () {
            return self.api.post('/chains/' + self.chainId + '/restart').then(function () {
                if (self._destroyed) { return; }
                self._pendingRestartHint = false;
                self._lastHtml = null;
                self._poll();
            }).catch(function (err) {
                if (self._destroyed) { return; }
                // Surface the failure in the banner area without blowing
                // away the card.
                var body = self.root.querySelector('.enm-section-card-body');
                if (!body) { return; }
                var existing = body.querySelector('.enm-evm-reward-banner');
                var msg = (err && err.body && err.body.error && err.body.error.message)
                    || (err && err.message) || 'Restart failed.';
                if (existing) {
                    existing.innerHTML = ''
                        + '<div class="enm-evm-reward-banner-msg is-err">'
                        +   'Restart failed: ' + esc(msg)
                        + '</div>'
                        + '<button type="button" class="enm-btn enm-btn-primary enm-btn-sm" data-action="reward-restart">Try again</button>';
                    var retry = existing.querySelector('[data-action="reward-restart"]');
                    if (retry) {
                        retry.addEventListener('click', function () { self._restartChainAfterSave(retry); });
                    }
                }
            });
        };
        if (typeof root.enmRunOnce === 'function' && btn) {
            root.enmRunOnce(btn, 'Restarting…', doRestart);
        } else {
            doRestart();
        }
    };

    /** @private — stacked label + hint + monospace address value + copy button.
     * When the value is unknown we render "—" and omit the copy button (nothing
     * to copy) — never a fabricated address.
     *
     * v0.5.228 — opts.editable=true adds an Edit button to the value stack;
     * the row also gets data-key so the inline editor can find it on swap.
     * "Set address" is the empty-state label so an unset row is still a
     * discoverable affordance, not a dead-end "—". */
    EvmDetailCard.prototype._addrRow = function (label, hint, value, key, opts) {
        var copySlot = value
            ? '<span class="enm-detail-copy-slot" data-copy="' + esc(key) + '" data-copy-value="' + esc(value) + '"></span>'
            : '';
        var editable = opts && opts.editable === true;
        var editSlot = '';
        if (editable) {
            var editLabel = value ? 'Edit' : 'Set address';
            editSlot = ''
                + '<button type="button" class="enm-btn enm-btn-sm enm-detail-edit-btn"'
                +   ' data-edit="' + esc(key) + '"'
                +   ' aria-label="' + esc(editLabel + ' ' + label) + '">'
                +   esc(editLabel)
                + '</button>';
        }
        return '<div class="enm-detail-addr-row' + (value ? '' : ' is-empty') + '"'
            + ' data-key="' + esc(key) + '">'
            + '<div class="enm-detail-row-head">'
            +   '<span class="enm-detail-label">' + esc(label) + '</span>'
            +   '<span class="enm-detail-hint">' + esc(hint) + '</span>'
            + '</div>'
            + '<div class="enm-detail-value-stack">'
            +   '<code class="enm-detail-addr" data-fill="' + esc(key) + '"></code>'
            +   copySlot
            +   editSlot
            + '</div>'
            + '</div>';
    };

    /** @private — HTML-escape displayed strings */
    function esc(s) {
        if (s == null) { return ''; }
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    root.EnmEvmDetailCard = EvmDetailCard;
}(typeof window !== 'undefined' ? window : globalThis));
