/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/proposal-card.js — own simple OWNER-CONFIRMS proposal review.
 *
 * Replaces PC2's UIWindowTransactionConfirm reuse (Rev 7 architecture: pure
 * extension, can't depend on PC2's modal). Phase 4 wires up the actual
 * proposal store + healing engine; Phase 3 ships the UI primitives.
 *
 * UX (Rev 1+4 audits):
 *   - 4-second cooldown on Confirm button (prevents accidental clicks)
 *   - Required checkbox: "I understand this will [action]"
 *   - Optional anti-snipe password prompt if nodeConfig.antiSnipePasswordHash is set
 *   - Reject button immediately enabled with optional reason
 *   - Modal overlay; ESC closes (treats as reject without reason)
 */

(function (root) {
    'use strict';

    var COOLDOWN_SEC = 4;

    function ProposalCard(opts) {
        if (!opts || !opts.proposal || !opts.api || !opts.notifications) {
            throw new TypeError('ProposalCard: { proposal, api, notifications } required');
        }
        this.proposal = opts.proposal;
        this.api = opts.api;
        this.notifications = opts.notifications;
        this.onClose = typeof opts.onClose === 'function' ? opts.onClose : function () {};
        // alpha.28.1 batch 22 — onActioned hook so app.js can broadcast
        // a `proposal-actioned` BC event after a successful confirm/
        // reject. Peer windows then dismiss their own copy of the modal
        // silently instead of catching a stale 404/409 from the
        // already-actioned proposal. (Multi-window audit ac31f3a08.)
        this.onActioned = typeof opts.onActioned === 'function' ? opts.onActioned : function () {};
        this._cooldownTimer = null;
        this._closed = false;

        this.root = document.createElement('div');
        this.root.className = 'enm-proposal-overlay';
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-modal', 'true');
        this.root.setAttribute('aria-labelledby', 'enm-prop-heading-' + this.proposal.id);

        this._renderShell();
    }

    ProposalCard.prototype.mount = function (parent) {
        // Remember what the operator was focused on so we can restore it on close
        // (WCAG 2.4.3 Focus Order). Without this, focus jumps to <body> after
        // the dialog closes and a screen reader loses context.
        this._previousFocus = document.activeElement;
        parent.appendChild(this.root);
        this._startCooldown();
        this._installEscHandler();
        this._installFocusTrap();
        // Move focus into the dialog. The ack checkbox is the natural entry
        // point because the Confirm button is disabled during the cooldown.
        var firstFocusable = this._checkbox || this.root.querySelector('button, input, [tabindex]');
        if (firstFocusable && typeof firstFocusable.focus === 'function') {
            setTimeout(function () { firstFocusable.focus(); }, 0);
        }
        return this;
    };

    ProposalCard.prototype.close = function () {
        if (this._closed) { return; }
        this._closed = true;
        if (this._cooldownTimer) { clearInterval(this._cooldownTimer); this._cooldownTimer = null; }
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        if (this._trapHandler) {
            document.removeEventListener('keydown', this._trapHandler, true);
            this._trapHandler = null;
        }
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
        // Return focus to wherever the operator was before the dialog opened.
        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            try { this._previousFocus.focus(); } catch (_) { /* element may be gone */ }
        }
        this.onClose();
    };

    // Alias for symmetry with other components — some parents call destroy()
    // unconditionally during teardown. Idempotent via the _closed guard.
    ProposalCard.prototype.destroy = function () { this.close(); };

    /** @private */
    ProposalCard.prototype._renderShell = function () {
        var t = root.enmTOrFallback;
        var p = this.proposal;

        var card = document.createElement('div');
        card.className = 'enm-proposal-card';

        var heading = document.createElement('h2');
        heading.id = 'enm-prop-heading-' + p.id;
        heading.className = 'enm-proposal-heading';
        heading.textContent = t('proposal.heading');
        card.appendChild(heading);

        // alpha.28.1 batch 69 (Round-19B audit finding #4) — provide a
        // non-empty fallback when BOTH summary_action and summaryAction
        // are absent. The acknowledgment ceremony is the ENTIRE point
        // of this card: "I understand this will <ACTION>" with the
        // operator's deliberate click confirming a destructive op. An
        // empty action label silently defeats that ceremony — the ack
        // text reads "I understand this will " (trailing space, no
        // action), and the post-action notifications fire "Confirmed" /
        // "Rejected" with empty bodies, leaving the operator with NO
        // record of what they just confirmed. Falling back to the i18n
        // 'proposal.fallback_action' key — or a hard-coded English
        // string if strings.js isn't loaded — keeps the ceremony intact.
        var actionLabel = p.summary_action || p.summaryAction
            || t('proposal.fallback_action')
            || 'this operation';
        // Stash on `this` so _handleConfirm / _handleReject can reuse
        // the same resolved label in their post-action notifications.
        this._actionLabel = actionLabel;
        var summary = document.createElement('p');
        summary.className = 'enm-proposal-summary';
        summary.textContent = actionLabel;
        card.appendChild(summary);

        if (p.summary_reason || p.summaryReason) {
            var reason = document.createElement('p');
            reason.className = 'enm-proposal-reason';
            reason.textContent = p.summary_reason || p.summaryReason;
            card.appendChild(reason);
        }

        // Checkbox: "I understand this will [action]"
        var checkboxWrap = document.createElement('label');
        checkboxWrap.className = 'enm-proposal-ack';
        this._checkbox = document.createElement('input');
        this._checkbox.type = 'checkbox';
        var self = this;
        this._checkbox.addEventListener('change', function () { self._refreshConfirmEnabled(); });
        checkboxWrap.appendChild(this._checkbox);
        var ackText = document.createElement('span');
        ackText.textContent = t('proposal.confirm_label', { summary: actionLabel });
        checkboxWrap.appendChild(ackText);
        card.appendChild(checkboxWrap);

        // Optional anti-snipe input (Phase 4 wiring decides whether to show).
        if (p.requireAntiSnipe) {
            this._antiSnipe = document.createElement('input');
            this._antiSnipe.type = 'password';
            this._antiSnipe.className = 'enm-proposal-anti-snipe';
            // alpha.28.1 batch 37 — strings.js sourced for locale parity.
            var antiLabel = root.enmTOrFallback('proposal.anti_snipe_label');
            this._antiSnipe.placeholder = antiLabel;
            this._antiSnipe.setAttribute('aria-label', antiLabel);
            // SAFETY: never use current-password here. Healing proposal
            // confirmation is destructive — autocomplete="current-password"
            // would let a password manager auto-fill this field on render
            // and the length check at _refreshConfirmEnabled would then
            // silently enable Confirm without operator intent (a "drive-
            // by confirm" on autofill). off + 'one-time-code' both block
            // PM autofill across Chrome/Safari/Firefox/1Password.
            this._antiSnipe.setAttribute('autocomplete', 'off');
            this._antiSnipe.setAttribute('autocorrect', 'off');
            this._antiSnipe.setAttribute('autocapitalize', 'off');
            this._antiSnipe.setAttribute('spellcheck', 'false');
            this._antiSnipe.addEventListener('input', function (ev) {
                // Belt-and-braces: only honour InputEvents that came from
                // real keystrokes / paste. A programmatic .value= from a
                // password manager fires `change` but `inputType` is
                // empty or 'insertReplacementText'. Require a known
                // keystroke type so synthesised fills can't sneak past.
                if (ev && ev.inputType
                    && ev.inputType !== 'insertText'
                    && ev.inputType !== 'insertFromPaste'
                    && ev.inputType !== 'deleteContentBackward'
                    && ev.inputType !== 'deleteContentForward'
                    && ev.inputType !== 'insertCompositionText') {
                    return;
                }
                self._refreshConfirmEnabled();
            });
            card.appendChild(this._antiSnipe);
        }

        // Action buttons.
        var actions = document.createElement('div');
        actions.className = 'enm-proposal-actions';

        this._cooldownLabel = document.createElement('span');
        this._cooldownLabel.className = 'enm-proposal-cooldown';
        this._cooldownLabel.textContent = t('proposal.cooldown_pending', { seconds: COOLDOWN_SEC });
        actions.appendChild(this._cooldownLabel);

        this._confirmBtn = document.createElement('button');
        this._confirmBtn.type = 'button';
        this._confirmBtn.className = 'enm-btn enm-btn-primary';
        this._confirmBtn.textContent = t('proposal.confirm_button');
        this._confirmBtn.disabled = true;
        this._confirmBtn.addEventListener('click', function () { self._handleConfirm(); });
        actions.appendChild(this._confirmBtn);

        this._rejectBtn = document.createElement('button');
        this._rejectBtn.type = 'button';
        this._rejectBtn.className = 'enm-btn enm-btn-secondary';
        this._rejectBtn.textContent = t('proposal.reject_button');
        this._rejectBtn.addEventListener('click', function () { self._handleReject(); });
        actions.appendChild(this._rejectBtn);

        card.appendChild(actions);

        // Optional reject-reason input (collapsed by default).
        this._rejectReason = document.createElement('input');
        this._rejectReason.type = 'text';
        this._rejectReason.className = 'enm-proposal-reject-reason';
        this._rejectReason.placeholder = t('proposal.reject_reason_placeholder');
        this._rejectReason.setAttribute('aria-label', t('proposal.reject_reason_placeholder'));
        card.appendChild(this._rejectReason);

        this.root.appendChild(card);
    };

    /** @private */
    ProposalCard.prototype._startCooldown = function () {
        var self = this;
        var remaining = COOLDOWN_SEC;
        var t = root.enmTOrFallback;
        this._cooldownLabel.textContent = t('proposal.cooldown_pending', { seconds: remaining });
        this._cooldownTimer = setInterval(function () {
            remaining -= 1;
            if (remaining <= 0) {
                clearInterval(self._cooldownTimer);
                self._cooldownTimer = null;
                self._cooldownLabel.textContent = '';
                self._refreshConfirmEnabled();
                return;
            }
            self._cooldownLabel.textContent = t('proposal.cooldown_pending', { seconds: remaining });
        }, 1000);
    };

    /** @private */
    ProposalCard.prototype._refreshConfirmEnabled = function () {
        var cooldownDone = !this._cooldownTimer;
        var ack = this._checkbox.checked;
        var pw = !this._antiSnipe || this._antiSnipe.value.length > 0;
        this._confirmBtn.disabled = !(cooldownDone && ack && pw);
    };

    /** @private */
    ProposalCard.prototype._handleConfirm = function () {
        var self = this;
        this._confirmBtn.disabled = true;
        var body = {};
        if (this._antiSnipe) { body.antiSnipePassword = this._antiSnipe.value; }
        // alpha.28.1 batch 69 (Round-19C audit finding #2) —
        // encodeURIComponent on the proposal.id path segment. proposal.id
        // sources from a backend response (GET /healing/suggestions); a
        // malicious/buggy backend returning "x/../delete" could pivot the
        // call to a different endpoint. Backend-compromise only, but
        // every other dynamic path segment in audit-tab uses
        // encodeURIComponent (lines 157-158) so this is consistency too.
        this.api.post('/healing/confirm/' + encodeURIComponent(this.proposal.id), body).then(function () {
            self.notifications.info('Confirmed', self._actionLabel || '');
            try { self.onActioned('confirmed'); } catch (_) { /* host hook threw */ }
            self.close();
        }).catch(function (err) {
            if (self._closed) { return; }
            // alpha.28.1 batch 53 — 401 suppression. Boot owns re-auth.
            if (err && err.status === 401) {
                self._refreshConfirmEnabled();
                return;
            }
            self.notifications.warning(
                'Confirmation failed',
                err && err.message ? err.message : String(err),
            );
            // Re-enable Confirm via the full validation path (cooldown +
            // ack checkbox + anti-snipe length) instead of an
            // unconditional disabled=false. Without _refreshConfirmEnabled
            // the catch path could re-arm Confirm even when the cooldown
            // is still running, the ack was unticked, or the anti-snipe
            // input was cleared between click and error response.
            // (Race-conditions audit aaf1f87d, finding B8.)
            self._refreshConfirmEnabled();
        });
    };

    /** @private */
    ProposalCard.prototype._handleReject = function () {
        var self = this;
        this._rejectBtn.disabled = true;
        this._confirmBtn.disabled = true;
        var body = { reason: this._rejectReason.value || '' };
        // Batch 69 — encodeURIComponent on proposal.id (same rationale
        // as the confirm path above).
        this.api.post('/healing/reject/' + encodeURIComponent(this.proposal.id), body).then(function () {
            self.notifications.info('Rejected', self._actionLabel || '');
            try { self.onActioned('rejected'); } catch (_) { /* host hook threw */ }
            self.close();
        }).catch(function (err) {
            // alpha.28.1 batch 53 — 401 suppression. Boot owns re-auth.
            // Reject button stays enabled either way so the operator
            // can retry once re-authed.
            if (err && err.status === 401) {
                // alpha.28.1 batch 61 (Round-18 audit) — _handleReject
                // disables BOTH _rejectBtn and _confirmBtn at start
                // (lines 269-270). The previous 401 branch only
                // re-enabled _rejectBtn, leaving Confirm permanently
                // disabled until the parent re-mounted the card. The
                // operator could no longer confirm OR reject anything
                // from this dialog. Symmetrical with _handleConfirm's
                // 401 path which calls _refreshConfirmEnabled.
                self._rejectBtn.disabled = false;
                self._refreshConfirmEnabled();
                return;
            }
            self.notifications.warning(
                'Reject failed',
                err && err.message ? err.message : String(err),
            );
            self._rejectBtn.disabled = false;
            // Same fix in the generic-error branch — _confirmBtn was
            // disabled at line 270 and never re-enabled.
            self._refreshConfirmEnabled();
        });
    };

    /** @private */
    ProposalCard.prototype._installEscHandler = function () {
        var self = this;
        this._escHandler = function (ev) {
            if (ev.key !== 'Escape') { return; }
            // Topmost-overlay guard — Esc-as-Reject is an irreversible
            // POST /healing/reject/{id}. If a settings drawer or
            // tools-update modal opened on top, those should win the
            // Esc and the proposal should stay put. The drawer flags
            // itself with .enm-drawer-open while visible; the tools-
            // update modal is only mounted while open.
            var drawerOpen = document.querySelector('.enm-drawer-root.enm-drawer-open');
            var updateModal = document.querySelector('.enm-tools-update-modal');
            if (drawerOpen || updateModal) { return; }
            self._handleReject();
        };
        document.addEventListener('keydown', this._escHandler);
    };

    /**
     * @private
     * Focus trap: Tab and Shift+Tab cycle within the dialog only. Without this,
     * keyboard focus can escape onto elements behind the overlay, violating
     * WCAG 2.4.3 (Focus Order) for modal dialogs. The handler runs on capture
     * so it sees the keydown before any inner element can intercept it.
     */
    ProposalCard.prototype._installFocusTrap = function () {
        var self = this;
        this._trapHandler = function (ev) {
            if (ev.key !== 'Tab' || self._closed) { return; }
            // Re-query each press because cooldown enables Confirm mid-lifecycle.
            var focusables = self.root.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
            if (focusables.length === 0) { return; }
            var first = focusables[0];
            var last  = focusables[focusables.length - 1];
            if (ev.shiftKey && document.activeElement === first) {
                ev.preventDefault();
                last.focus();
            } else if (!ev.shiftKey && document.activeElement === last) {
                ev.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', this._trapHandler, true);
    };

    root.EnmProposalCard = ProposalCard;
}(typeof window !== 'undefined' ? window : globalThis));
