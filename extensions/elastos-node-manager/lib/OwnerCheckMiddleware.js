/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * OwnerCheckMiddleware — own requireOwner equivalent.
 *
 * PC2's requireOwner middleware (pc2-node/src/api/middleware.ts:406-437) is NOT
 * exposed to extensions (verified Rev 7, agent 2). We implement our own using
 * the same model: read the authenticated user from req.actor / req.user (set
 * by PC2's auth middleware) and compare against the node's owner wallet.
 *
 * Owner-wallet source: PC2 stores it in node-config.json on disk. We read it
 * via PC2's database service if available, falling back to the file. Either
 * source is owner-settable, never operator-settable from the wire.
 *
 * Address comparison uses the same EVM-lowercase / Solana-case-sensitive rules
 * PC2 itself uses (per Rev 5, agent 9 — confirmed wallet-agnostic).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ENM_LOG_PREFIX, errorBody } = require('./EnmConstants');
const { pc2DataDir } = require('./DataDir');

const NODE_CONFIG_FILENAME = 'node-config.json';

/** @type {{ ownerWallet: string|null, mtimeMs: number, loadedAt: number }} */
let cachedOwner = null;
const CACHE_TTL_MS = 30_000;

/**
 * Express middleware. Use as: router.post('/foo', requireOwner, handler).
 * Returns 401 if no user, 403 if user wallet doesn't match node owner.
 */
function requireOwner(req, res, next) {
    const wallet = readActorWallet(req);
    if (!wallet) {
        return res.status(401).json(errorBody('Authentication required.'));
    }

    let owner;
    try {
        owner = readNodeOwner();
    } catch (err) {
        return res.status(500).json(errorBody(`Owner check failed: ${err.message}`));
    }

    if (!owner) {
        return res.status(403).json(errorBody('Node has no owner set. Complete PC2 setup first.'));
    }

    if (!compareAddresses(wallet, owner)) {
        return res.status(403).json(errorBody('Forbidden: only the node owner can perform this action.'));
    }

    // Stash for downstream handlers.
    req.enmOwnerWallet = owner;
    return next();
}

/**
 * Extract the wallet address from the authenticated request. PC2 sets either
 * req.actor or req.user (both supported per Rev 7 audit).
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function readActorWallet(req) {
    if (req.actor && typeof req.actor.wallet_address === 'string') {
        return req.actor.wallet_address;
    }
    if (req.user && typeof req.user.wallet_address === 'string') {
        return req.user.wallet_address;
    }
    return null;
}

/**
 * Read the node's owner wallet from node-config.json. Cached for 30s to avoid
 * disk I/O on every authenticated request, but invalidated when the file mtime
 * changes (so ownership claim takes effect immediately).
 *
 * @returns {string|null}
 */
function readNodeOwner() {
    const configPath = path.join(pc2DataDir(), NODE_CONFIG_FILENAME);
    let stat;
    try {
        stat = fs.statSync(configPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }

    const now = Date.now();
    if (cachedOwner
        && cachedOwner.mtimeMs === stat.mtimeMs
        && (now - cachedOwner.loadedAt) < CACHE_TTL_MS) {
        return cachedOwner.ownerWallet;
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        throw new Error(`Could not parse ${NODE_CONFIG_FILENAME}: ${err.message}`);
    }

    const owner = (parsed && typeof parsed.ownerWallet === 'string') ? parsed.ownerWallet : null;
    cachedOwner = { ownerWallet: owner, mtimeMs: stat.mtimeMs, loadedAt: now };
    return owner;
}

/**
 * Compare two wallet addresses. EVM addresses (0x-prefixed, 42 chars) are
 * compared case-insensitively. Other formats (Solana, etc.) compare exactly.
 * Different formats never compare equal.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function compareAddresses(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    if (looksLikeEvm(a) && looksLikeEvm(b)) {
        return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
}

function looksLikeEvm(addr) {
    return typeof addr === 'string'
        && addr.length === 42
        && addr.startsWith('0x');
}

/** @internal — for tests only */
function _resetCacheForTests() {
    cachedOwner = null;
}

module.exports = {
    requireOwner,
    compareAddresses,
    readActorWallet,
    readNodeOwner,
    _resetCacheForTests,
};
