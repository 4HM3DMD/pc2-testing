/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmProposalStore tests — drives a fake db handle (write/read pair backed by
 * an in-memory Map keyed on row id). Tests the lifecycle FSM, sweep, and
 * wallet-scoped reads.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';

const Store = require('../lib/EnmProposalStore');

/**
 * Fake DB matching the surface ProposalStore consumes:
 *   db.write(sql, params)  → { lastInsertRowid, changes }
 *   db.read(sql, params)   → Array<row>
 *
 * Only the handful of statements ProposalStore issues are recognized.
 */
function fakeDb() {
    const rows = new Map();
    return {
        rows,
        async write(sql, args) {
            const t = sql.replace(/\s+/g, ' ').trim();
            if (t.startsWith('INSERT INTO enm_proposals')) {
                const [id, walletAddress, chainId, ruleId, type, status,
                    summaryAction, summaryReason, proposedAt, expiresAt, payloadJson] = args;
                rows.set(id, {
                    id, wallet_address: walletAddress, chain_id: chainId,
                    rule_id: ruleId, type, status,
                    summary_action: summaryAction, summary_reason: summaryReason,
                    proposed_at: proposedAt, expires_at: expiresAt,
                    approved_at: null, rejected_at: null, executed_at: null,
                    rejection_reason: null, outcome: null, payload_json: payloadJson,
                });
                return { lastInsertRowid: id, changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ?, approved_at = ?')) {
                const [newStatus, approvedAt, id, expectedStatus, now] = args;
                const r = rows.get(id);
                if (!r || r.status !== expectedStatus || r.expires_at <= now) return { changes: 0 };
                r.status = newStatus; r.approved_at = approvedAt;
                return { changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ?, rejected_at = ?, rejection_reason = ?')) {
                const [newStatus, rejectedAt, reason, id, expectedStatus] = args;
                const r = rows.get(id);
                if (!r || r.status !== expectedStatus) return { changes: 0 };
                r.status = newStatus; r.rejected_at = rejectedAt; r.rejection_reason = reason;
                return { changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ?, executed_at = ?, outcome = ?')) {
                const [newStatus, executedAt, outcome, id, expectedStatus] = args;
                const r = rows.get(id);
                if (!r || r.status !== expectedStatus) return { changes: 0 };
                r.status = newStatus; r.executed_at = executedAt; r.outcome = outcome;
                return { changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ? WHERE status = ? AND expires_at <= ?')) {
                const [newStatus, expectedStatus, cutoff] = args;
                let changed = 0;
                for (const r of rows.values()) {
                    if (r.status === expectedStatus && r.expires_at <= cutoff) {
                        r.status = newStatus;
                        changed += 1;
                    }
                }
                return { changes: changed };
            }
            throw new Error(`fakeDb.write: unhandled SQL ${t}`);
        },
        async read(sql, args) {
            const t = sql.replace(/\s+/g, ' ').trim();
            if (t.includes('FROM enm_proposals WHERE id = ?')) {
                const r = rows.get(args[0]);
                return r ? [{ ...r }] : [];
            }
            if (t.includes('FROM enm_proposals WHERE wallet_address = ? AND status = ?')) {
                const wallet = args[0]; const status = args[1];
                return Array.from(rows.values())
                    .filter((r) => r.wallet_address === wallet && r.status === status)
                    .sort((a, b) => b.proposed_at - a.proposed_at);
            }
            if (t.includes('FROM enm_proposals WHERE wallet_address = ? ORDER BY proposed_at DESC LIMIT ?')) {
                const wallet = args[0]; const lim = args[1];
                return Array.from(rows.values())
                    .filter((r) => r.wallet_address === wallet)
                    .sort((a, b) => b.proposed_at - a.proposed_at)
                    .slice(0, lim);
            }
            throw new Error(`fakeDb.read: unhandled SQL ${t}`);
        },
    };
}

describe('EnmProposalStore', () => {
    let db;

    beforeEach(() => {
        db = fakeDb();
    });

    it('rejects create() with missing fields', async () => {
        await expect(Store.create(db, { walletAddress: '0xa' })).rejects.toThrow();
    });

    it('creates a pending proposal', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xAbC',
            chainId: 'mainchain',
            ruleId: 'F4',
            type: 'enm.healing.f4',
            summaryAction: 'Restart mainchain',
            summaryReason: 'Stalled for 11 minutes',
            payload: { action: 'restart' },
        });
        expect(row).not.toBeNull();
        expect(row.status).toBe(Store.STATUS.PENDING);
        expect(row.wallet_address).toBe('0xabc'); // lowercased
        expect(row.id).toMatch(/^enm_/);
    });

    it('approve transitions pending → approved', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xa',
            chainId: 'mainchain',
            ruleId: 'F4',
            type: 'enm.healing.f4',
            summaryAction: 'Restart',
        });
        const updated = await Store.approve(db, row.id);
        expect(updated.status).toBe(Store.STATUS.APPROVED);
        expect(typeof updated.approved_at).toBe('number');
    });

    it('approve returns null when proposal already approved', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mainchain', ruleId: 'F4', type: 'x', summaryAction: 'y',
        });
        await Store.approve(db, row.id);
        const second = await Store.approve(db, row.id);
        expect(second).toBeNull();
    });

    it('reject transitions pending → rejected with reason', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mainchain', ruleId: 'F4', type: 'x', summaryAction: 'y',
        });
        const updated = await Store.reject(db, row.id, 'no thanks');
        expect(updated.status).toBe(Store.STATUS.REJECTED);
        expect(updated.rejection_reason).toBe('no thanks');
    });

    it('markExecuted transitions approved → executed on success', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mainchain', ruleId: 'F4', type: 'x', summaryAction: 'y',
        });
        await Store.approve(db, row.id);
        const updated = await Store.markExecuted(db, row.id, { success: true, outcome: 'restarted' });
        expect(updated.status).toBe(Store.STATUS.EXECUTED);
        expect(updated.outcome).toBe('restarted');
    });

    it('markExecuted records failure outcome', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mainchain', ruleId: 'F4', type: 'x', summaryAction: 'y',
        });
        await Store.approve(db, row.id);
        const updated = await Store.markExecuted(db, row.id, { success: false, outcome: 'spawn ENOENT' });
        expect(updated.status).toBe(Store.STATUS.FAILED);
        expect(updated.outcome).toBe('spawn ENOENT');
    });

    it('listPending returns pending rows scoped to wallet', async () => {
        await Store.create(db, { walletAddress: '0xA', chainId: 'mc', ruleId: 'F1', type: 'x', summaryAction: 'a' });
        await Store.create(db, { walletAddress: '0xB', chainId: 'mc', ruleId: 'F1', type: 'x', summaryAction: 'b' });
        const aPending = await Store.listPending(db, '0xA');
        expect(aPending.length).toBe(1);
        expect(aPending[0].wallet_address).toBe('0xa');
    });

    it('sweepExpired moves pending past TTL to expired', async () => {
        const row = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mc', ruleId: 'F1', type: 'x', summaryAction: 'y',
            ttlSec: 60,
        });
        // Force expires_at into the past.
        db.rows.get(row.id).expires_at = Date.now() - 1;
        const swept = await Store.sweepExpired(db);
        expect(swept).toBe(1);
        const after = await Store.getById(db, row.id);
        expect(after.status).toBe(Store.STATUS.EXPIRED);
    });

    it('decodePayload returns null for missing or bad JSON', () => {
        expect(Store.decodePayload(null)).toBeNull();
        expect(Store.decodePayload({ payload_json: 'not-json' })).toBeNull();
        expect(Store.decodePayload({ payload_json: '{"a":1}' })).toEqual({ a: 1 });
    });

    it('clamps ttlSec into [60, MAX]', async () => {
        const row1 = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mc', ruleId: 'F1', type: 'x', summaryAction: 'y', ttlSec: 5,
        });
        // Clamped up to 60s.
        expect(row1.expires_at - row1.proposed_at).toBe(60_000);

        const row2 = await Store.create(db, {
            walletAddress: '0xa', chainId: 'mc', ruleId: 'F2', type: 'x', summaryAction: 'y',
            ttlSec: Store.MAX_TTL_SEC * 2,
        });
        expect(row2.expires_at - row2.proposed_at).toBe(Store.MAX_TTL_SEC * 1000);
    });
});
