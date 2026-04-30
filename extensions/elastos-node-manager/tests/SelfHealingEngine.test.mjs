/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * SelfHealingEngine tests — fakes db, processService, sseHub.
 *
 * Verifies:
 *   - AUTOMATED-SAFE detections trigger processService.restart + audit row
 *   - OWNER-CONFIRMS detections create a proposal (no restart) + audit row
 *   - Restart-budget escalates the 4th attempt to OWNER-CONFIRMS
 *   - executeApproved enforces wallet ownership + status guard
 *   - rejectProposal records rejection_reason in audit
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';
const EventEmitter = require('node:events');

const { SelfHealingEngine } = require('../lib/SelfHealingEngine');
const Store = require('../lib/EnmProposalStore');

const fakeExt = { log: { info() {}, warn() {}, error() {}, debug() {} } };

function fakeDb() {
    const proposals = new Map();
    const audits = [];
    return {
        proposals, audits,
        async write(sql, args) {
            const t = sql.replace(/\s+/g, ' ').trim();
            if (t.startsWith('INSERT INTO enm_audit_logs')) {
                const [ts, wallet, chain, rule, tier, decision, executor, outcome, dur, payload] = args;
                audits.push({
                    id: audits.length + 1,
                    ts, wallet_address: wallet, chain_id: chain, rule_id: rule,
                    tier, decision, executor, outcome, duration_ms: dur, payload_json: payload,
                });
                return { lastInsertRowid: audits.length, changes: 1 };
            }
            if (t.startsWith('INSERT INTO enm_proposals')) {
                const [id, wallet, chain, rule, type, status, sa, sr, pa, ea, pj] = args;
                proposals.set(id, {
                    id, wallet_address: wallet, chain_id: chain, rule_id: rule,
                    type, status, summary_action: sa, summary_reason: sr,
                    proposed_at: pa, expires_at: ea, approved_at: null, rejected_at: null,
                    executed_at: null, rejection_reason: null, outcome: null, payload_json: pj,
                });
                return { lastInsertRowid: id, changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ?, approved_at = ?')) {
                const [newStatus, approvedAt, id, expectedStatus, now] = args;
                const r = proposals.get(id);
                if (!r || r.status !== expectedStatus || r.expires_at <= now) return { changes: 0 };
                r.status = newStatus; r.approved_at = approvedAt;
                return { changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ?, rejected_at = ?')) {
                const [newStatus, rejectedAt, reason, id, expectedStatus] = args;
                const r = proposals.get(id);
                if (!r || r.status !== expectedStatus) return { changes: 0 };
                r.status = newStatus; r.rejected_at = rejectedAt; r.rejection_reason = reason;
                return { changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ?, executed_at = ?, outcome = ?')) {
                const [newStatus, executedAt, outcome, id, expectedStatus] = args;
                const r = proposals.get(id);
                if (!r || r.status !== expectedStatus) return { changes: 0 };
                r.status = newStatus; r.executed_at = executedAt; r.outcome = outcome;
                return { changes: 1 };
            }
            if (t.startsWith('UPDATE enm_proposals SET status = ? WHERE status = ? AND expires_at <= ?')) {
                return { changes: 0 };
            }
            throw new Error('fakeDb.write unhandled SQL: ' + t);
        },
        async read(sql, args) {
            const t = sql.replace(/\s+/g, ' ').trim();
            if (t.includes('FROM enm_proposals WHERE id = ?')) {
                const r = proposals.get(args[0]);
                return r ? [{ ...r }] : [];
            }
            if (t.includes('FROM enm_proposals WHERE wallet_address = ? AND status = ?')) {
                return Array.from(proposals.values())
                    .filter((r) => r.wallet_address === args[0] && r.status === args[1]);
            }
            return [];
        },
    };
}

function fakeProcessService() {
    const ee = new EventEmitter();
    ee.calls = { restart: [], start: [], stop: [] };
    ee.restart = async (chainId, cfg) => {
        ee.calls.restart.push({ chainId, cfg });
        return { pid: 999, startedAt: Date.now() };
    };
    return ee;
}

function fakeSseHub() {
    const published = [];
    return {
        published,
        publish(topic, data) { published.push({ topic, data }); },
    };
}

describe('SelfHealingEngine', () => {
    let db; let proc; let hub; let engine;

    beforeEach(() => {
        db = fakeDb();
        proc = fakeProcessService();
        hub = fakeSseHub();
        engine = new SelfHealingEngine({
            extensionHandle: fakeExt,
            getDb: () => db,
            processService: proc,
            sseHub: hub,
            ownerWallet: '0xowner',
        });
    });

    it('rejects construction with missing deps', () => {
        expect(() => new SelfHealingEngine({})).toThrow(TypeError);
    });

    it('AUTOMATED-SAFE detection calls processService.restart and audits success', async () => {
        await engine.apply('mainchain', [{
            ruleId: 'F1',
            tier: 'AUTOMATED-SAFE',
            summaryAction: 'Restart mainchain',
            payload: { action: 'restart', chainId: 'mainchain' },
        }], { binaryPath: '/x' });
        expect(proc.calls.restart.length).toBe(1);
        expect(db.audits.length).toBe(1);
        expect(db.audits[0].decision).toBe('executed');
        expect(db.audits[0].executor).toBe('system');
        expect(hub.published.length).toBe(1);
        expect(hub.published[0].topic).toBe('notifications');
    });

    it('OWNER-CONFIRMS detection creates a proposal but does NOT restart', async () => {
        await engine.apply('mainchain', [{
            ruleId: 'F4',
            tier: 'OWNER-CONFIRMS',
            summaryAction: 'Restart to clear stall',
            summaryReason: 'Stalled 11m',
            payload: { action: 'restart', chainId: 'mainchain' },
        }], { binaryPath: '/x' });
        expect(proc.calls.restart.length).toBe(0);
        expect(db.proposals.size).toBe(1);
        const [proposal] = db.proposals.values();
        expect(proposal.status).toBe(Store.STATUS.PENDING);
        expect(proposal.rule_id).toBe('F4');
        expect(db.audits.length).toBe(1);
        expect(db.audits[0].decision).toBe('proposed');
        expect(hub.published.length).toBe(1);
        expect(hub.published[0].data.proposalId).toBe(proposal.id);
    });

    it('does not duplicate a proposal for the same chain+rule while pending', async () => {
        const det = {
            ruleId: 'F4', tier: 'OWNER-CONFIRMS',
            summaryAction: 'Restart', payload: { action: 'restart', chainId: 'mainchain' },
        };
        await engine.apply('mainchain', [det], {});
        await engine.apply('mainchain', [det], {});
        expect(db.proposals.size).toBe(1);
    });

    it('escalates 4th restart attempt to OWNER-CONFIRMS', async () => {
        const det = {
            ruleId: 'F1', tier: 'AUTOMATED-SAFE',
            summaryAction: 'Restart',
            payload: { action: 'restart', chainId: 'mainchain' },
        };
        // First 3 attempts succeed inline.
        await engine.apply('mainchain', [det], {});
        await engine.apply('mainchain', [det], {});
        await engine.apply('mainchain', [det], {});
        // 4th — budget exhausted, becomes proposal.
        await engine.apply('mainchain', [det], {});
        expect(proc.calls.restart.length).toBe(3);
        expect(db.proposals.size).toBe(1);
    });

    it('skips automated apply when no owner wallet (still audits)', async () => {
        engine.setOwnerWallet(null);
        await engine.apply('mainchain', [{
            ruleId: 'F1', tier: 'AUTOMATED-SAFE',
            summaryAction: 'Restart', payload: { action: 'restart', chainId: 'mainchain' },
        }], {});
        expect(proc.calls.restart.length).toBe(0);
        expect(db.audits.length).toBe(1);
        expect(db.audits[0].outcome).toBe('no-owner-skip');
    });

    it('executeApproved rejects mismatched wallet', async () => {
        const proposalId = await proposeAndGetId(engine, db);
        const result = await engine.executeApproved(proposalId, '0xnotowner');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/does not belong/i);
    });

    it('executeApproved succeeds for the owner and runs the action', async () => {
        const proposalId = await proposeAndGetId(engine, db);
        const result = await engine.executeApproved(proposalId, '0xowner');
        expect(result.ok).toBe(true);
        const after = db.proposals.get(proposalId);
        // Suggestion-type payloads return success without performing a side-effect.
        expect(after.status).toBe(Store.STATUS.EXECUTED);
        const auditExec = db.audits.filter((a) => a.decision === 'executed' && a.executor === '0xowner');
        expect(auditExec.length).toBe(1);
    });

    it('rejectProposal records reason and audit row', async () => {
        const proposalId = await proposeAndGetId(engine, db);
        const result = await engine.rejectProposal(proposalId, '0xowner', 'will fix manually');
        expect(result.ok).toBe(true);
        expect(db.proposals.get(proposalId).status).toBe(Store.STATUS.REJECTED);
        expect(db.proposals.get(proposalId).rejection_reason).toBe('will fix manually');
        const auditRej = db.audits.filter((a) => a.decision === 'rejected');
        expect(auditRej.length).toBe(1);
    });

    it('executeApproved on already-executed proposal returns settled error', async () => {
        const proposalId = await proposeAndGetId(engine, db);
        await engine.executeApproved(proposalId, '0xowner');
        const second = await engine.executeApproved(proposalId, '0xowner');
        expect(second.ok).toBe(false);
        expect(second.error).toMatch(/no longer pending/i);
    });

    it('AUTOMATED-SAFE failure path writes FAILED audit and WARNING notification', async () => {
        proc.restart = async () => { throw new Error('spawn ENOENT'); };
        await engine.apply('mainchain', [{
            ruleId: 'F1', tier: 'AUTOMATED-SAFE',
            summaryAction: 'Restart mainchain',
            payload: { action: 'restart', chainId: 'mainchain' },
        }], { binaryPath: '/x' });

        const failedAudits = db.audits.filter((a) => a.decision === 'failed');
        expect(failedAudits.length).toBe(1);
        expect(failedAudits[0].outcome).toBe('spawn ENOENT');
        // Notification severity falls back to WARNING when the auto-heal failed.
        expect(hub.published.length).toBe(1);
        expect(hub.published[0].data.severity).toBe('WARNING');
    });
});

/**
 * Helper: send an OWNER-CONFIRMS detection through engine.apply and return
 * the proposal id it created.
 */
async function proposeAndGetId(engine, db) {
    await engine.apply('mainchain', [{
        ruleId: 'F5', tier: 'OWNER-CONFIRMS',
        summaryAction: 'Free disk space',
        summaryReason: '4 GB free',
        payload: { action: 'prune-suggestion', chainId: 'mainchain', freeGb: 4 },
    }], { binaryPath: '/x' });
    const [proposal] = db.proposals.values();
    return proposal.id;
}
