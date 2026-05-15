/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/identity.js — Settings → Identity tab (beta.3.43).
 *
 *   GET  /identity                       owner-read — current cached identity + producer state
 *   POST /identity/unlock                owner — smoke-test password, refresh cache
 *   GET  /identity/backup                owner — stream keystore.dat for download
 *   POST /identity/import                owner — replace keystore.dat with uploaded file
 *   POST /identity/reset                 owner — wipe + regenerate keystore + new password
 *
 * Producer-state guard: the destructive routes (import / reset) check
 * the on-chain producer record BEFORE touching disk. If state is
 * Active/Pending and force!=true, return 412 PRECONDITION_REQUIRED so
 * the UI can surface the slashing-risk modal. Operator must re-submit
 * with force=true to acknowledge.
 *
 * Audit: every action emits an EnmAuditLog row with tier
 * "CRITICAL-INFO", decision "executed"/"failed", executor "operator".
 * Passwords are redacted out via the existing redactSensitive list
 * (Joi-validated body, audit middleware applies redactSensitive
 * BEFORE persisting the payload).
 *
 * Anti-snipe: /identity/reset honours cfg.global.antiSnipePasswordHash
 * the same way SelfHealingEngine's protected proposals do. Mirrors the
 * pattern in beta.3.10's anti-snipe wiring.
 */

'use strict';

const express = require('express');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../auth/OwnerCheckMiddleware');
const RequestSchemas = require('../services/EnmRequestSchemas');
const KeystoreIdentity = require('../services/EnmKeystoreIdentity');
const AuditLog = require('../services/EnmAuditLog');
const ConfigStore = require('../services/ConfigStore');

// Producer states that imply the operator is locked in to a specific
// NodePublicKey on chain. Destructive ops while in these states require
// explicit force=true acknowledgement.
const LOCKED_IN_PRODUCER_STATES = new Set([
    'Active', 'Pending',
    // "Inactive" producers can still recover by signing again before
    // the slashing threshold — they're locked in too.
    'Inactive',
]);

const CHAIN_ID = 'mainchain';
const RESET_CONFIRM_PHRASE = 'reset keystore';
const IMPORT_CONFIRM_PHRASE = 'import';
const MAX_IMPORT_BYTES = 10 * 1024;

/**
 * @param {object} deps
 * @param {object} deps.extensionHandle
 * @param {() => object} deps.getDb
 * @returns {import('express').Router}
 */
function build(deps) {
    if (!deps || !deps.extensionHandle || typeof deps.getDb !== 'function') {
        throw new Error('routes/identity.build: { extensionHandle, getDb } required');
    }
    const { extensionHandle, getDb } = deps;
    const router = express.Router();

    // GET /identity
    router.get('/', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const cached = await KeystoreIdentity.getCachedIdentity(CHAIN_ID);
            const producer = await KeystoreIdentity.getProducerState(CHAIN_ID);
            const ks = require('../services/ChainRegistry').getKeystoreService();
            const exists = await ks.exists();
            return res.json(successBody({
                chainId: CHAIN_ID,
                keystoreExists: exists,
                identity: cached || null,
                producer: producer || null,
                // Convenience flag the UI uses to decide whether to
                // show the Unlock card.
                identityCacheMissing: exists && !cached,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /identity: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // POST /identity/unlock
    router.post('/unlock', limit('admin'), requireOwner, async (req, res) => {
        const { value, details } = RequestSchemas.validateBody(
            RequestSchemas.identityUnlockBody, req.body,
        );
        if (details) {
            return res.status(400).json({
                ...errorBody('Invalid request body.'),
                details,
            });
        }
        const wallet = readActorWallet(req);
        try {
            const r = await KeystoreIdentity.unlock(CHAIN_ID, value.password);
            if (!r.ok) {
                await _audit(getDb, extensionHandle.log, {
                    walletAddress: wallet,
                    decision: 'failed',
                    outcome: `Identity unlock failed: ${r.error}`,
                    payload: { action: 'identity-unlock' },
                });
                return res.status(400).json(errorBody(r.error));
            }
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                decision: 'executed',
                outcome: `Identity unlocked: pubkey ${r.publicKey.slice(0, 10)}…${r.publicKey.slice(-6)}`,
                payload: { action: 'identity-unlock', publicKey: r.publicKey, address: r.address },
            });
            return res.json(successBody({
                publicKey: r.publicKey,
                address: r.address,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /identity/unlock: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    // GET /identity/backup
    //
    // Streams the on-disk keystore.dat. Owner-only because the file is
    // operationally sensitive even when encrypted (loss of the file
    // means loss of the producer key if you also lose the password).
    router.get('/backup', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        try {
            const r = await KeystoreIdentity.readBackup(CHAIN_ID);
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                decision: 'executed',
                outcome: `Identity backup downloaded: ${r.filename} (${r.buffer.length} bytes)`,
                payload: { action: 'identity-backup', filename: r.filename, size: r.buffer.length },
            });
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition',
                'attachment; filename="' + r.filename.replace(/"/g, '') + '"');
            res.setHeader('Content-Length', String(r.buffer.length));
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.end(r.buffer);
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /identity/backup: ${err.message}`);
            const status = err.code === 'NO_KEYSTORE' ? 404 : 500;
            return res.status(status).json(errorBody(err.message));
        }
    });

    // POST /identity/import
    //
    // Body: raw keystore.dat bytes (Content-Type: application/octet-
    // stream). Password + confirm + force passed as headers
    // (X-Keystore-Password, X-Keystore-Confirm, X-Keystore-Force). We
    // avoid multipart to keep the route lean; keystore.dat is <10 KB
    // so a single buffer is fine.
    router.post('/import',
        limit('admin'),
        requireOwner,
        express.raw({ type: '*/*', limit: MAX_IMPORT_BYTES + 1024 }),
        async (req, res) => {
            const wallet = readActorWallet(req);
            const password = String(req.get('x-keystore-password') || '');
            const confirm = String(req.get('x-keystore-confirm') || '');
            const force = req.get('x-keystore-force') === 'true';
            if (!password) {
                return res.status(400).json(errorBody('X-Keystore-Password header is required.'));
            }
            if (confirm !== IMPORT_CONFIRM_PHRASE) {
                return res.status(400).json(errorBody(
                    `X-Keystore-Confirm header must be "${IMPORT_CONFIRM_PHRASE}".`,
                ));
            }
            const buf = (req.body instanceof Buffer) ? req.body : null;
            if (!buf || buf.length === 0) {
                return res.status(400).json(errorBody('No keystore bytes received.'));
            }
            // Producer-state guard.
            const producer = await KeystoreIdentity.getProducerState(CHAIN_ID);
            if (producer && LOCKED_IN_PRODUCER_STATES.has(producer.state) && !force) {
                return res.status(412).json({
                    ...errorBody(
                        `Producer is ${producer.state}. Importing a different keystore risks slashing. `
                        + 'Re-submit with X-Keystore-Force: true to acknowledge.',
                    ),
                    code: 'PRODUCER_LOCKED_IN',
                    producerState: producer.state,
                });
            }
            try {
                const r = await KeystoreIdentity.importKeystore(CHAIN_ID, buf, password, {
                    log: extensionHandle.log,
                });
                if (!r.ok) {
                    await _audit(getDb, extensionHandle.log, {
                        walletAddress: wallet,
                        decision: 'failed',
                        outcome: `Identity import failed: ${r.error}`,
                        payload: { action: 'identity-import' },
                    });
                    return res.status(400).json(errorBody(r.error));
                }
                await _audit(getDb, extensionHandle.log, {
                    walletAddress: wallet,
                    decision: 'executed',
                    outcome: `Identity imported: pubkey ${r.publicKey.slice(0, 10)}…${r.publicKey.slice(-6)} (archived → ${r.archivedTo || 'none'})`,
                    payload: {
                        action: 'identity-import',
                        publicKey: r.publicKey,
                        address: r.address,
                        archivedTo: r.archivedTo,
                    },
                });
                return res.json(successBody({
                    publicKey: r.publicKey,
                    address: r.address,
                    archivedTo: r.archivedTo,
                }));
            } catch (err) {
                extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /identity/import: ${err.message}`);
                return res.status(500).json(errorBody(err.message));
            }
        });

    // POST /identity/reset
    router.post('/reset', limit('admin'), requireOwner, async (req, res) => {
        const { value, details } = RequestSchemas.validateBody(
            RequestSchemas.identityResetBody, req.body,
        );
        if (details) {
            return res.status(400).json({
                ...errorBody('Invalid request body.'),
                details,
            });
        }
        const wallet = readActorWallet(req);
        if (value.confirm !== RESET_CONFIRM_PHRASE) {
            return res.status(400).json(errorBody(
                `Confirmation must be exactly "${RESET_CONFIRM_PHRASE}".`,
            ));
        }
        // Anti-snipe gate, mirroring SelfHealingEngine's pattern.
        try {
            const cfg = await ConfigStore.load();
            const hash = cfg && cfg.global && cfg.global.antiSnipePasswordHash;
            if (typeof hash === 'string' && hash.length > 0) {
                if (!value.antiSnipePassword) {
                    return res.status(412).json(errorBody(
                        'Anti-snipe password required. The Settings → Security tab has it set.',
                    ));
                }
                const ok = await _verifyAntiSnipe(hash, value.antiSnipePassword);
                if (!ok) {
                    return res.status(401).json(errorBody('Anti-snipe password incorrect.'));
                }
            }
        } catch (err) {
            return res.status(500).json(errorBody(`Anti-snipe verify failed: ${err.message}`));
        }
        // Producer-state guard.
        const producer = await KeystoreIdentity.getProducerState(CHAIN_ID);
        if (producer && LOCKED_IN_PRODUCER_STATES.has(producer.state) && !value.force) {
            return res.status(412).json({
                ...errorBody(
                    `Producer is ${producer.state}. Resetting the keystore generates a new pubkey, `
                    + 'orphaning the on-chain registration. Re-submit with force=true to acknowledge.',
                ),
                code: 'PRODUCER_LOCKED_IN',
                producerState: producer.state,
            });
        }
        try {
            const r = await KeystoreIdentity.resetKeystore(CHAIN_ID, {
                log: extensionHandle.log,
            });
            if (!r.ok) {
                await _audit(getDb, extensionHandle.log, {
                    walletAddress: wallet,
                    decision: 'failed',
                    outcome: `Identity reset failed: ${r.error}`,
                    payload: { action: 'identity-reset' },
                });
                return res.status(500).json(errorBody(r.error));
            }
            await _audit(getDb, extensionHandle.log, {
                walletAddress: wallet,
                decision: 'executed',
                outcome: `Identity reset: new pubkey ${r.publicKey.slice(0, 10)}…${r.publicKey.slice(-6)} (archived → ${r.archivedTo || 'none'})`,
                payload: {
                    action: 'identity-reset',
                    publicKey: r.publicKey,
                    address: r.address,
                    archivedTo: r.archivedTo,
                },
            });
            return res.json(successBody({
                publicKey: r.publicKey,
                address: r.address,
                // Returned ONCE — caller (the operator) is responsible
                // for showing + having the operator acknowledge save.
                generatedPassword: r.generatedPassword,
                archivedTo: r.archivedTo,
                keystorePath: r.keystorePath,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} POST /identity/reset: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    return router;
}

/**
 * scrypt verify against `scrypt$<saltHex>$<derivedHex>` shape produced
 * by beta.3.10's anti-snipe setter route.
 */
function _verifyAntiSnipe(stored, attempt) {
    const crypto = require('node:crypto');
    return new Promise((resolve) => {
        const m = /^scrypt\$([a-fA-F0-9]+)\$([a-fA-F0-9]+)$/.exec(stored);
        if (!m) { return resolve(false); }
        const salt = Buffer.from(m[1], 'hex');
        const want = Buffer.from(m[2], 'hex');
        crypto.scrypt(attempt, salt, want.length, (err, derived) => {
            if (err) { return resolve(false); }
            try { resolve(crypto.timingSafeEqual(derived, want)); }
            catch (_) { resolve(false); }
        });
    });
}

/**
 * Best-effort audit write. Never blocks the action — operator already
 * authorised, losing the audit row is preferable to a 500 that leaves
 * them unsure whether the action ran.
 */
async function _audit(getDb, log, entry) {
    try {
        const db = getDb();
        await AuditLog.append(db, {
            walletAddress: entry.walletAddress || '0x0',
            chainId: CHAIN_ID,
            ruleId: null,
            tier: 'CRITICAL-INFO',
            decision: entry.decision,
            executor: 'operator',
            outcome: entry.outcome,
            payload: entry.payload,
        });
    } catch (err) {
        log.warn(`${ENM_LOG_PREFIX} identity audit append failed: ${err.message}`);
    }
}

module.exports = { build };
