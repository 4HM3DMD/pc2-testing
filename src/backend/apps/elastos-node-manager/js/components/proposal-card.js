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
        parent.appendChild(this.root);
        this._startCooldown();
        this._installEscHandler();
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
        if (this.root.parentNode) { this.root.parentNode.removeChild(this.root); }
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

        var summary = document.createElement('p');
        summary.className = 'enm-proposal-summary';
        summary.textContent = p.summary_action || p.summaryAction || '';
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
        ackText.textContent = t('proposal.confirm_label', { summary: p.summary_action || p.summaryAction || '' });
        checkboxWrap.appendChild(ackText);
        card.appendChild(checkboxWrap);

        // Optional anti-snipe input (Phase 4 wiring decides whether to show).
        if (p.requireAntiSnipe) {
            this._antiSnipe = document.createElement('input');
            this._antiSnipe.type = 'password';
            this._antiSnipe.className = 'enm-proposal-anti-snipe';
            this._antiSnipe.placeholder = 'Anti-snipe password';
            this._antiSnipe.autocomplete = 'current-password';
            this._antiSnipe.addEventListener('input', function () { self._refreshConfirmEnabled(); });
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
        this.api.post('/healing/confirm/' + this.proposal.id, body).then(function () {
            self.notifications.info('Confirmed', self.proposal.summary_action || self.proposal.summaryAction || '');
            self.close();
        }).catch(function (err) {
            self.notifications.warning(
                'Confirmation failed',
                err && err.message ? err.message : String(err),
            );
            self._confirmBtn.disabled = false;
        });
    };

    /** @private */
    ProposalCard.prototype._handleReject = function () {
        var self = this;
        this._rejectBtn.disabled = true;
        this._confirmBtn.disabled = true;
        var body = { reason: this._rejectReason.value || '' };
        this.api.post('/healing/reject/' + this.proposal.id, body).then(function () {
            self.notifications.info('Rejected', self.proposal.summary_action || self.proposal.summaryAction || '');
            self.close();
        }).catch(function (err) {
            self.notifications.warning(
                'Reject failed',
                err && err.message ? err.message : String(err),
            );
            self._rejectBtn.disabled = false;
        });
    };

    /** @private */
    ProposalCard.prototype._installEscHandler = function () {
        var self = this;
        this._escHandler = function (ev) {
            if (ev.key === 'Escape') { self._handleReject(); }
        };
        document.addEventListener('keydown', this._escHandler);
    };

    root.EnmProposalCard = ProposalCard;
}(typeof window !== 'undefined' ? window : globalThis));
