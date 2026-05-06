/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAuditLog — append-only event log writer.
 *
 * Writes ONLY on:
 *   - Healing decisions (proposed / confirmed / rejected / executed / failed)
 *   - State transitions (Healthy → Degraded → Critical → Healing → Healthy)
 *   - Config changes
 *   - Owner-confirms answered
 *   - Notifications acknowledged
 *
 * Does NOT write on every health-poll tick (Rev 4 audit: would generate ~17k
 * rows/day per chain and serve no purpose). Worst-case real volume: ~96 rows/day.
 *
 * Schema is in EnmDb.initSchema().
 *
 * Reads use a separate query helper for the audit-tab UI.
 */

'use strict';

const { AUDIT_DECISION, ENM_LOG_PREFIX } = require('./EnmConstants');

/**
 * @typedef {object} AuditEntry
 * @property {string} walletAddress  who triggered (operator wallet, lowercased EVM)
 * @property {string} chainId        e.g. "mainchain"
 * @property {string} [ruleId]       F1, F2, ..., or null for non-healing events
 * @property {string} tier           AUTOMATED-SAFE | OWNER-CONFIRMS | CRITICAL-NOTIFY | NEVER-AUTOMATIC
 * @property {string} decision       proposed | confirmed | rejected | executed | failed | manual-only
 * @property {string} executor       'system' or wallet DID
 * @property {string} [outcome]      'success' | 'failure' | 'timeout' | etc.
 * @property {number} [durationMs]
 * @property {object} [payload]      JSON-serializable extra context (redacted before write)
 */

/**
 * @param {object} db extension.import('data').db
 * @param {AuditEntry} entry
 * @returns {Promise<number>} inserted row id
 */
async function append(db, entry) {
    if (!db || typeof db.write !== 'function') {
        throw new Error('EnmAuditLog.append: invalid db handle');
    }
    if (!entry || !entry.walletAddress || !entry.chainId || !entry.tier || !entry.decision || !entry.executor) {
        throw new Error('EnmAuditLog.append: required fields: walletAddress, chainId, tier, decision, executor');
    }

    const ts = Date.now();
    const payloadJson = entry.payload ? JSON.stringify(redactSensitive(entry.payload)) : null;

    // Defence in depth: lowercase EVM-shaped wallet addresses so a future
    // caller passing mixed case can't accidentally produce a row that doesn't
    // match the lowercased query filter the audit-tab UI uses.
    const wallet = normalizeWallet(entry.walletAddress);

    const res = await db.write(
        `INSERT INTO enm_audit_logs (
            ts, wallet_address, chain_id, rule_id, tier, decision,
            executor, outcome, duration_ms, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            ts,
            wallet,
            String(entry.chainId),
            entry.ruleId || null,
            String(entry.tier),
            String(entry.decision),
            String(entry.executor),
            entry.outcome || null,
            Number.isInteger(entry.durationMs) ? entry.durationMs : null,
            payloadJson,
        ],
    );
    return (res && res.lastInsertRowid) || 0;
}

function normalizeWallet(addr) {
    const s = String(addr);
    if (s.length === 42 && s.startsWith('0x')) {
        return s.toLowerCase();
    }
    return s;
}

/**
 * Paginated read for the audit-tab UI. All filters optional.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.walletAddress]  scope by wallet (operator viewing own log)
 * @param {string} [opts.chainId]
 * @param {string} [opts.tier]
 * @param {number} [opts.fromTs]
 * @param {number} [opts.toTs]
 * @param {number} [opts.limit]   default 100, max 500
 * @param {number} [opts.offset]
 * @returns {Promise<Array<object>>}
 */
async function query(db, opts) {
    const o = opts || {};
    const where = [];
    const args = [];
    if (o.walletAddress) { where.push('wallet_address = ?'); args.push(o.walletAddress); }
    if (o.chainId)       { where.push('chain_id = ?');       args.push(o.chainId); }
    if (o.tier)          { where.push('tier = ?');           args.push(o.tier); }
    if (Number.isInteger(o.fromTs)) { where.push('ts >= ?'); args.push(o.fromTs); }
    if (Number.isInteger(o.toTs))   { where.push('ts <= ?'); args.push(o.toTs); }

    const limit = Math.min(Math.max(Number(o.limit) || 100, 1), 500);
    const offset = Math.max(Number(o.offset) || 0, 0);

    const sql = `SELECT id, ts, wallet_address, chain_id, rule_id, tier, decision,
                        executor, outcome, duration_ms, payload_json
                 FROM enm_audit_logs
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY ts DESC
                 LIMIT ? OFFSET ?`;
    args.push(limit, offset);
    const rows = await db.read(sql, args);
    return Array.isArray(rows) ? rows : [];
}

/**
 * Strip known-sensitive keys before serializing into payload_json. Defence in
 * depth — callers should already not pass these, but we make it impossible.
 *
 * @param {object} obj
 * @returns {object}
 */
function redactSensitive(obj) {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }
    const REDACTED = '[REDACTED]';
    const SENSITIVE_KEYS = [
        'password', 'rpcPassword', 'rpc_password',
        'antiSnipePassword', 'anti_snipe_password',
        'keystorePassword', 'keystore_password',
        'signature', 'privateKey', 'private_key',
        'secret', 'token', 'auth_token',
        'encryptedPassword', 'encrypted_password',
    ];
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.includes(k)) {
            out[k] = REDACTED;
        } else if (v && typeof v === 'object') {
            out[k] = redactSensitive(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

module.exports = {
    append,
    query,
    redactSensitive,
};
