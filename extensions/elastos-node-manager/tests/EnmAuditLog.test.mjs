/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAuditLog tests — exercises append() against an in-memory better-sqlite3
 * shaped to look like extension.import('data').db.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';

const audit = require('../lib/EnmAuditLog');
const { initSchema } = require('../lib/EnmDb');

/**
 * Minimal db wrapper that mimics the extension data API on top of a plain
 * in-memory SQLite. Only good for tests — production uses extension.import.
 */
function makeMemoryDb() {
    let Database;
    try {
        // Optional dep — installed transitively via PC2 in production. Tests skip
        // gracefully if it's not present in the local node_modules.
        // eslint-disable-next-line global-require
        Database = require('better-sqlite3');
    } catch {
        return null;
    }
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return {
        async write(sql, args) {
            const stmt = db.prepare(sql);
            const res = args ? stmt.run(args) : stmt.run();
            return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
        },
        async read(sql, args) {
            const stmt = db.prepare(sql);
            const reader = stmt.reader === undefined ? true : stmt.reader;
            return reader ? (args ? stmt.all(args) : stmt.all()) : [];
        },
        _raw: db,
    };
}

describe('EnmAuditLog', () => {
    let db;

    beforeEach(async () => {
        db = makeMemoryDb();
        if (!db) {
            return;
        }
        await initSchema(db);
    });

    it('redactSensitive scrubs known fields', () => {
        const input = {
            method: 'POST',
            body: {
                rpcPassword: 'secret-leak',
                publicField: 'visible',
                nested: { signature: 'sig-bytes', okField: 1 },
            },
        };
        const out = audit.redactSensitive(input);
        expect(out.body.rpcPassword).toBe('[REDACTED]');
        expect(out.body.nested.signature).toBe('[REDACTED]');
        expect(out.body.publicField).toBe('visible');
        expect(out.body.nested.okField).toBe(1);
    });

    it('append + query round-trip', async () => {
        if (!db) {
            return; // better-sqlite3 not installed locally; skip
        }
        await audit.append(db, {
            walletAddress: '0xabc',
            chainId: 'mainchain',
            ruleId: 'F1',
            tier: 'AUTOMATED-SAFE',
            decision: 'executed',
            executor: 'system',
            outcome: 'success',
            durationMs: 42,
            payload: { method: 'POST', body: { rpcPassword: 'should-be-redacted' } },
        });
        const rows = await audit.query(db, { walletAddress: '0xabc' });
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.rule_id).toBe('F1');
        expect(row.tier).toBe('AUTOMATED-SAFE');
        expect(row.decision).toBe('executed');
        expect(row.duration_ms).toBe(42);
        const payload = JSON.parse(row.payload_json);
        expect(payload.body.rpcPassword).toBe('[REDACTED]');
    });

    it('rejects entries missing required fields', async () => {
        if (!db) {
            return;
        }
        await expect(audit.append(db, { walletAddress: '0xabc' }))
            .rejects.toThrow(/required fields/);
    });
});
