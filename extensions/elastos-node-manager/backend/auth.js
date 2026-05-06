/*
 * auth.js — thin shim that replaces the deleted
 * `enm-server/src/auth/OwnerCheckMiddleware.js` (per A18). Same
 * exports, but the read paths use PC2's req.actor / req.user.wallet_address
 * + extension.import() instead of querying pc2-node's session DB
 * directly (PC2 already populates those fields in the request before
 * any extension's route handler runs).
 *
 * Used by:
 *   - services/ChainRegistry.js  → readNodeOwner() for healing-engine
 *                                   audit attribution
 *   - services/EnmAuditMiddleware.js → readActorWallet(req)
 *   - services/EnmRateLimit.js   → readActorWallet(req)
 *
 * Routes that need ownership enforcement use an inline check:
 *
 *   if (!isOperator(req)) return res.status(403).json({error:'owner_only'});
 *
 * (See backend/main.js for the inline isOperator helper.)
 */

'use strict';

/**
 * Return the wallet address of the request's actor, or null if
 * unauthenticated. PC2's auth middleware populates these fields
 * before the request reaches an extension handler.
 *
 * @param {object} req Express-style request
 * @returns {string|null} lowercased wallet hex, or null
 */
function readActorWallet(req) {
    if (!req) return null;
    if (req.user && typeof req.user.wallet_address === 'string') {
        return req.user.wallet_address.toLowerCase();
    }
    if (req.actor && typeof req.actor.wallet_address === 'string') {
        return req.actor.wallet_address.toLowerCase();
    }
    if (req.actorWallet && typeof req.actorWallet === 'string') {
        return req.actorWallet.toLowerCase();
    }
    return null;
}

/**
 * Return the PC2 owner wallet — the wallet that claimed this PC2
 * node during setup. Used by the healing engine for audit-log
 * attribution when an automated rule fires (no req available, so
 * we attribute to the operator, not a request actor).
 *
 * In the capsule format, this comes from PC2's user service.
 * If extension.import() isn't available (test harness), falls back
 * to the PC2_OPERATOR_WALLET env var so dev builds still work.
 *
 * @returns {string|null}
 */
function readNodeOwner() {
    try {
        if (typeof extension !== 'undefined' && typeof extension.import === 'function') {
            const userSvc = extension.import('service:user');
            if (userSvc && typeof userSvc.getOwnerWallet === 'function') {
                const w = userSvc.getOwnerWallet();
                return typeof w === 'string' ? w.toLowerCase() : null;
            }
        }
    } catch { /* fall through to env-var fallback */ }
    const envWallet = process.env.PC2_OPERATOR_WALLET;
    return typeof envWallet === 'string' && envWallet.length > 0
        ? envWallet.toLowerCase()
        : null;
}

module.exports = { readActorWallet, readNodeOwner };
