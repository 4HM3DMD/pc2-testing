/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmDb tests — pin the contract that every db.write() call passes a
 * params array (even if empty), so we never regress the bug where PC2's
 * SqliteDatabaseAccessService crashes on `undefined.map(...)`.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';

const { initSchema, cleanupOldAuditLogs } = require('../lib/EnmDb');

/**
 * Recording stub. Captures every call shape so the assertion can verify
 * each one passed (sql, params) where params is an array (possibly empty).
 */
function makeRecorder(opts) {
    const calls = [];
    const o = opts || {};
    return {
        calls,
        async write(sql, params) {
            calls.push({ method: 'write', sql, params });
            return { changes: o.writeChanges != null ? o.writeChanges : 0 };
        },
        async read(sql, params) {
            calls.push({ method: 'read', sql, params });
            return o.readRows || [];
        },
    };
}

describe('EnmDb.initSchema — params contract', () => {
    let db;
    beforeEach(() => { db = makeRecorder(); });

    it('issues every CREATE TABLE / CREATE INDEX with a params array', async () => {
        await initSchema(db);
        // PC2's wrapper does params.map(...) — so undefined or omitted args
        // crash with "Cannot read properties of undefined (reading 'map')".
        // Every call MUST pass at least an empty array.
        expect(db.calls.length).toBeGreaterThan(0);
        for (const c of db.calls) {
            if (!Array.isArray(c.params)) {
                throw new Error(
                    `db.${c.method}() called without a params array — PC2's wrapper would crash here.\n`
                    + `sql: ${c.sql}\nparams: ${JSON.stringify(c.params)}`,
                );
            }
        }
    });

    it('creates all three expected tables', async () => {
        await initSchema(db);
        const writes = db.calls.filter((c) => c.method === 'write').map((c) => c.sql);
        expect(writes.some((s) => s.includes('CREATE TABLE IF NOT EXISTS enm_audit_logs'))).toBe(true);
        expect(writes.some((s) => s.includes('CREATE TABLE IF NOT EXISTS enm_proposals'))).toBe(true);
        expect(writes.some((s) => s.includes('CREATE TABLE IF NOT EXISTS enm_setup_state'))).toBe(true);
    });

    it('throws on invalid db handle', async () => {
        await expect(initSchema(null)).rejects.toThrow();
        await expect(initSchema({})).rejects.toThrow();
    });
});

describe('EnmDb.cleanupOldAuditLogs — params contract', () => {
    it('passes params array on the DELETE batch', async () => {
        const db = makeRecorder({ writeChanges: 0 });
        await cleanupOldAuditLogs(db, 30);
        const deletes = db.calls.filter((c) => c.method === 'write' && /DELETE FROM enm_audit_logs/.test(c.sql));
        expect(deletes.length).toBeGreaterThanOrEqual(1);
        for (const d of deletes) {
            expect(Array.isArray(d.params)).toBe(true);
            expect(d.params.length).toBe(2);
            // [cutoff_ts, batch_size]
            expect(typeof d.params[0]).toBe('number');
            expect(typeof d.params[1]).toBe('number');
        }
    });

    it('returns 0 immediately when olderThanDays <= 0', async () => {
        const db = makeRecorder();
        expect(await cleanupOldAuditLogs(db, 0)).toBe(0);
        expect(await cleanupOldAuditLogs(db, -1)).toBe(0);
        expect(db.calls.length).toBe(0);
    });
});
