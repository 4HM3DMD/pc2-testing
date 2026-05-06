/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAuditMiddleware — per-route HTTP audit with sensitive-field redaction.
 *
 * PC2's auditMiddleware (pc2-node/src/api/audit.ts) only audits routes in its
 * AUDITED_ENDPOINTS whitelist and its sanitizeBody redaction list does NOT
 * cover our sensitive fields (rpcPassword, signature, antiSnipePassword,
 * encryptedPassword) — verified Rev 6 audit.
 *
 * We're a pure extension and cannot extend PC2's middleware (Rev 7 additive-only),
 * so we provide our own here. Applies to all our /extensions/elastos-node-manager/api/*
 * routes via routes/index.js.
 *
 * Captures the same fields PC2 captures (method, endpoint, status, duration)
 * for parity with the operator's existing audit experience.
 */

'use strict';

const { ENM_LOG_PREFIX, AUDIT_DECISION, HEALING_TIERS } = require('./EnmConstants');
const { append: appendAudit, redactSensitive } = require('./EnmAuditLog');
const { readActorWallet } = require('../auth/OwnerCheckMiddleware');

/**
 * Build the middleware. We need the extension handle to access the DB.
 *
 * @param {object} extensionHandle PC2 extension global
 * @returns {import('express').RequestHandler}
 */
function build(extensionHandle) {
    let cachedDb = null;
    function getDb() {
        if (!cachedDb) {
            cachedDb = extensionHandle.import('data').db;
        }
        return cachedDb;
    }

    return function enmAuditMiddleware(req, res, next) {
        const start = Date.now();

        // Skip GET requests — read-only routes don't need audit-log entries.
        // (HTTP-level access can still be inferred from PC2's own auditMiddleware
        // if the operator enables it for our path.)
        if (req.method === 'GET') {
            return next();
        }

        // Capture body BEFORE the handler may mutate it.
        const requestBody = req.body ? redactSensitive(req.body) : null;

        // Hook into response finish to record outcome.
        res.on('finish', () => {
            const wallet = readActorWallet(req);
            if (!wallet) {
                // Anonymous mutation attempt — handler should have already 401'd.
                // Skip audit (we have no wallet to attribute to).
                return;
            }

            const durationMs = Date.now() - start;
            const success = res.statusCode >= 200 && res.statusCode < 400;

            // Asynchronous fire-and-forget. Audit failure must not propagate to the
            // user response (already sent).
            Promise.resolve().then(() => appendAudit(getDb(), {
                walletAddress: wallet,
                chainId: extractChainId(req) || 'system',
                ruleId: null,
                tier: HEALING_TIERS.HTTP_MUTATION,
                decision: success ? AUDIT_DECISION.EXECUTED : AUDIT_DECISION.FAILED,
                executor: wallet,
                outcome: success ? 'success' : 'failure',
                durationMs,
                payload: {
                    method: req.method,
                    endpoint: req.originalUrl || req.url,
                    statusCode: res.statusCode,
                    body: requestBody,
                },
            })).catch((err) => {
                extensionHandle.log.error(`${ENM_LOG_PREFIX} audit middleware write failed: ${err.message}`);
            });
        });

        return next();
    };
}

/**
 * Extract a chain id from the URL if present (e.g., /chains/mainchain/start).
 * Returns null if no chain context.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractChainId(req) {
    if (req.params && typeof req.params.chainId === 'string') {
        return req.params.chainId;
    }
    // Fallback: parse the URL path. Defence in depth — req.params depends on
    // the matched route shape.
    const url = req.originalUrl || req.url || '';
    const m = url.match(/\/chains\/([a-z0-9-]+)/i);
    return m ? m[1] : null;
}

module.exports = {
    build,
};
