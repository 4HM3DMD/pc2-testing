/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmProposalStore — own table for OWNER-CONFIRMS healings.
 *
 * Replaces the agent_proposals reuse considered in Rev 6 — Rev 7 mandated a
 * pure extension, so we cannot depend on PC2's proposal modal or schema.
 *
 * Lifecycle (state field):
 *   pending_approval → approved → executed   (success path)
 *                    ↘ rejected               (operator says no)
 *                    ↘ expired                (TTL elapsed without action)
 *                                ↘ failed     (post-approve execution error)
 *
 * Schema lives in EnmDb.initSchema (table `enm_proposals`).
 *
 * Status transitions are guarded server-side. The frontend modal mutates only
 * via /api/healing/confirm/:id and /api/healing/reject/:id. Direct row writes
 * outside this module are forbidden.
 */

'use strict';

const crypto = require('node:crypto');

const STATUS = Object.freeze({
    PENDING:  'pending_approval',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    EXECUTED: 'executed',
    EXPIRED:  'expired',
    FAILED:   'failed',
});

const DEFAULT_TTL_SEC = 3600;
const MAX_TTL_SEC = 7 * 24 * 3600;

/**
 * @typedef {object} ProposalInput
 * @property {string} walletAddress  owner wallet (lowercased EVM)
 * @property {string} chainId        e.g. "mainchain"
 * @property {string} ruleId         F1, F4, ...
 * @property {string} type           "enm.healing.<rule>" namespace
 * @property {string} summaryAction  short imperative ("Restart mainchain")
 * @property {string} [summaryReason] longer paragraph explaining the proposal
 * @property {object} [payload]      action params consumed by SelfHealingEngine.execute
 * @property {number} [ttlSec]       time-to-live, default 3600 (clamped to MAX_TTL_SEC)
 */

/**
 * @typedef {object} ProposalRow
 * @property {string} id
 * @property {string} wallet_address
 * @property {string} chain_id
 * @property {string} rule_id
 * @property {string} type
 * @property {string} status
 * @property {string} summary_action
 * @property {string|null} summary_reason
 * @property {number} proposed_at
 * @property {number} expires_at
 * @property {number|null} approved_at
 * @property {number|null} rejected_at
 * @property {number|null} executed_at
 * @property {string|null} rejection_reason
 * @property {string|null} outcome
 * @property {string|null} payload_json
 */

/**
 * Insert a new proposal in pending_approval state.
 *
 * @param {object} db
 * @param {ProposalInput} input
 * @returns {Promise<ProposalRow>}
 */
async function create(db, input) {
    if (!db || typeof db.write !== 'function') {
        throw new Error('EnmProposalStore.create: invalid db handle');
    }
    if (!input || !input.walletAddress || !input.chainId || !input.ruleId
        || !input.type || !input.summaryAction) {
        throw new Error(
            'EnmProposalStore.create: required: walletAddress, chainId, ruleId, type, summaryAction',
        );
    }

    const id = `enm_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const ttlSec = clampTtl(input.ttlSec);
    const expiresAt = now + (ttlSec * 1000);

    await db.write(
        `INSERT INTO enm_proposals (
            id, wallet_address, chain_id, rule_id, type, status,
            summary_action, summary_reason, proposed_at, expires_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            String(input.walletAddress).toLowerCase(),
            String(input.chainId),
            String(input.ruleId),
            String(input.type),
            STATUS.PENDING,
            String(input.summaryAction),
            input.summaryReason || null,
            now,
            expiresAt,
            input.payload ? JSON.stringify(input.payload) : null,
        ],
    );

    return getById(db, id);
}

/**
 * @param {object} db
 * @param {string} id
 * @returns {Promise<ProposalRow|null>}
 */
async function getById(db, id) {
    if (!db || !id) {
        return null;
    }
    const rows = await db.read(
        `SELECT id, wallet_address, chain_id, rule_id, type, status,
                summary_action, summary_reason, proposed_at, expires_at,
                approved_at, rejected_at, executed_at, rejection_reason,
                outcome, payload_json
         FROM enm_proposals WHERE id = ? LIMIT 1`,
        [id],
    );
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * List pending (non-expired) proposals scoped to a wallet. Sweeps expired ones
 * lazily on call so the dashboard never sees a stale entry.
 *
 * @param {object} db
 * @param {string} walletAddress
 * @returns {Promise<Array<ProposalRow>>}
 */
async function listPending(db, walletAddress) {
    if (!db || !walletAddress) {
        return [];
    }
    await sweepExpired(db);
    const rows = await db.read(
        `SELECT id, wallet_address, chain_id, rule_id, type, status,
                summary_action, summary_reason, proposed_at, expires_at,
                approved_at, rejected_at, executed_at, rejection_reason,
                outcome, payload_json
         FROM enm_proposals
         WHERE wallet_address = ? AND status = ?
         ORDER BY proposed_at DESC`,
        [String(walletAddress).toLowerCase(), STATUS.PENDING],
    );
    return Array.isArray(rows) ? rows : [];
}

/**
 * Recent history (any status) for the audit-tab UI.
 *
 * @param {object} db
 * @param {string} walletAddress
 * @param {number} [limit] default 50
 * @returns {Promise<Array<ProposalRow>>}
 */
async function listRecent(db, walletAddress, limit) {
    if (!db || !walletAddress) {
        return [];
    }
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = await db.read(
        `SELECT id, wallet_address, chain_id, rule_id, type, status,
                summary_action, summary_reason, proposed_at, expires_at,
                approved_at, rejected_at, executed_at, rejection_reason,
                outcome, payload_json
         FROM enm_proposals
         WHERE wallet_address = ?
         ORDER BY proposed_at DESC
         LIMIT ?`,
        [String(walletAddress).toLowerCase(), lim],
    );
    return Array.isArray(rows) ? rows : [];
}

/**
 * Move from pending → approved. Returns the updated row, or null if the
 * proposal was already settled (approved/rejected/executed/expired/failed) —
 * the caller surfaces this to the operator as "no longer pending".
 *
 * @param {object} db
 * @param {string} id
 * @returns {Promise<ProposalRow|null>}
 */
async function approve(db, id) {
    const now = Date.now();
    // Guarded UPDATE: only flips status if still pending AND not expired. The
    // sweep would have already moved expired rows, but this is a belt-and-braces
    // check against TTL races between sweep and approve.
    const res = await db.write(
        `UPDATE enm_proposals
            SET status = ?, approved_at = ?
          WHERE id = ? AND status = ? AND expires_at > ?`,
        [STATUS.APPROVED, now, id, STATUS.PENDING, now],
    );
    if (!res || (res.changes != null && res.changes === 0)) {
        return null;
    }
    return getById(db, id);
}

/**
 * Move from pending → rejected. Optional operator-supplied reason.
 *
 * @param {object} db
 * @param {string} id
 * @param {string} [reason]
 * @returns {Promise<ProposalRow|null>}
 */
async function reject(db, id, reason) {
    const now = Date.now();
    const res = await db.write(
        `UPDATE enm_proposals
            SET status = ?, rejected_at = ?, rejection_reason = ?
          WHERE id = ? AND status = ?`,
        [STATUS.REJECTED, now, reason ? String(reason).slice(0, 500) : null, id, STATUS.PENDING],
    );
    if (!res || (res.changes != null && res.changes === 0)) {
        return null;
    }
    return getById(db, id);
}

/**
 * Move from approved → executed (success or failed).
 *
 * @param {object} db
 * @param {string} id
 * @param {{ success: boolean, outcome?: string }} result
 * @returns {Promise<ProposalRow|null>}
 */
async function markExecuted(db, id, result) {
    const now = Date.now();
    const status = (result && result.success) ? STATUS.EXECUTED : STATUS.FAILED;
    const outcome = (result && typeof result.outcome === 'string') ? result.outcome.slice(0, 500) : null;
    const res = await db.write(
        `UPDATE enm_proposals
            SET status = ?, executed_at = ?, outcome = ?
          WHERE id = ? AND status = ?`,
        [status, now, outcome, id, STATUS.APPROVED],
    );
    if (!res || (res.changes != null && res.changes === 0)) {
        return null;
    }
    return getById(db, id);
}

/**
 * Bulk-mark expired pending rows. Called from listPending and from a 1-min
 * sweep timer in main.js (Phase 4 wiring).
 *
 * @param {object} db
 * @returns {Promise<number>} rows touched
 */
async function sweepExpired(db) {
    const now = Date.now();
    const res = await db.write(
        `UPDATE enm_proposals
            SET status = ?
          WHERE status = ? AND expires_at <= ?`,
        [STATUS.EXPIRED, STATUS.PENDING, now],
    );
    return (res && typeof res.changes === 'number') ? res.changes : 0;
}

/**
 * @param {number|undefined} ttlSec
 * @returns {number}
 */
function clampTtl(ttlSec) {
    const n = Number(ttlSec);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_TTL_SEC;
    }
    return Math.min(Math.max(Math.floor(n), 60), MAX_TTL_SEC);
}

/**
 * Decode payload_json back to an object. Returns null on malformed payloads
 * rather than throwing, so a single bad row doesn't break the dashboard.
 *
 * @param {ProposalRow} row
 * @returns {object|null}
 */
function decodePayload(row) {
    if (!row || typeof row.payload_json !== 'string') {
        return null;
    }
    try {
        return JSON.parse(row.payload_json);
    } catch {
        return null;
    }
}

module.exports = {
    STATUS,
    DEFAULT_TTL_SEC,
    MAX_TTL_SEC,
    create,
    getById,
    listPending,
    listRecent,
    approve,
    reject,
    markExecuted,
    sweepExpired,
    decodePayload,
};
