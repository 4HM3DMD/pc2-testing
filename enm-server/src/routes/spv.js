/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/spv.js — SPV Module endpoints (v0.5.168, Phase 2).
 *
 *   GET /spv             aggregate SPV status + per-sidechain detail
 *   GET /spv/:id/logs    tail the newest embedded-SPV log for one EVM sidechain
 *
 * WHY this module exists: SPV (class E in the taxonomy) is NOT a standalone
 * process. node.sh embeds it inside the EVM sidechains (esc/eid/pg keep their
 * own light-client state under data/logs-spv) and inside the arbiter (which
 * exposes getspvheight for its own SPV view + getsidechainblockheight for each
 * bridged sidechain — node.sh:5060,5073-5145). The frontend "SPV Module" tile
 * needs ONE place to read all of that. This route aggregates:
 *
 *   - the arbiter's own SPV height (the headline number), and
 *   - per-sidechain: the arbiter's SPV-tracked block height for that chain
 *     (RPC, reliable + structured) + whether its on-disk logs-spv exists.
 *
 * Read-only: like GET /chains/:id it requires an authenticated actor but no
 * owner gate (no mutation). Every probe is best-effort — a missing arbiter or
 * an unreachable RPC resolves to null so the UI renders "—" honestly.
 */

'use strict';

const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { readActorWallet } = require('../auth/OwnerCheckMiddleware');
const ChainRegistry = require('../services/ChainRegistry');
const ConfigStore = require('../services/ConfigStore');
const { chainSpvLogDir } = require('../services/DataDir');
const ArbiterAdapter = require('../services/ArbiterAdapter');

// The EVM sidechains the arbiter bridges + tracks via SPV. Mirrors
// ArbiterAdapter.SIDECHAINS_REQUIRED minus the mainchain (which is the
// arbiter's MainNode, not a side node).
const SPV_SIDECHAINS = Object.freeze(['esc', 'eid', 'pg']);

// Bound the per-log read so a multi-GB logs-spv file can never blow memory.
const SPV_LOG_TAIL_BYTE_CAP = 256 * 1024;
const SPV_LOG_TAIL_MAX_LINES = 500;
const SPV_LOG_TAIL_DEFAULT_LINES = 200;

/**
 * Coerce an RPC result that may be a raw number or a { result } envelope into
 * a Number or null. ela/arbiter JSON-RPC sometimes returns the unwrapped value
 * (EnmRpcClient.call already unwraps .result), but stay defensive either way.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function asHeight(v) {
    if (typeof v === 'number') { return v; }
    if (v && typeof v.result === 'number') { return v.result; }
    return null;
}

/**
 * @param {object} extensionHandle
 * @returns {import('express').Router}
 */
function build(extensionHandle) {
    const router = express.Router();

    // --- aggregate SPV status + per-sidechain detail ---
    router.get('/', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const cfg = await ConfigStore.load();
            const chains = (cfg && cfg.chains) || {};
            const net = (((chains.arbiter && chains.arbiter.activeNet) || 'mainnet') === 'testnet')
                ? 'testnet' : 'mainnet';
            const sideDefs = (ArbiterAdapter._internal
                && ArbiterAdapter._internal.ARBITER_SIDE_NODE_DEFS
                && ArbiterAdapter._internal.ARBITER_SIDE_NODE_DEFS[net]) || {};
            const ps = ChainRegistry.getProcessService();

            // ---- Arbiter aggregate (the headline SPV height) ----
            let arbiterAdapter = null;
            try { arbiterAdapter = ChainRegistry.getAdapter('arbiter'); }
            catch (_) { /* arbiter not configured — leave null */ }
            const arbiterRunning = !!(ps.statusSync('arbiter').alive);
            let arbiterRpc = null;
            let arbiterSpvHeight = null;
            if (arbiterAdapter && arbiterRunning && chains.arbiter) {
                try {
                    arbiterRpc = arbiterAdapter.rpcClient(chains.arbiter);
                    arbiterSpvHeight = asHeight(await arbiterRpc.getspvheight());
                } catch (_) { /* arbiter RPC not ready; spvHeight stays null */ }
            }

            // ---- Per-sidechain SPV detail ----
            const sidechains = [];
            for (const chainId of SPV_SIDECHAINS) {
                if (!chains[chainId]) { continue; }   // not installed
                let displayName = chainId.toUpperCase();
                try { displayName = ChainRegistry.getAdapter(chainId).displayName; }
                catch (_) { /* fall back to upper-cased id */ }
                const def = sideDefs[chainId] || {};
                const genesisBlock = def.GenesisBlock || null;
                const running = !!(ps.statusSync(chainId).alive);
                // The arbiter's SPV-tracked height for THIS sidechain
                // (node.sh:5073-5145). Only resolvable while the arbiter RPC
                // is reachable; otherwise null.
                let spvBlockHeight = null;
                if (arbiterRpc && genesisBlock) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        spvBlockHeight = asHeight(await arbiterRpc.getsidechainblockheight(genesisBlock));
                    } catch (_) { /* leave null */ }
                }
                // logs-spv presence — cheap evidence the embedded SPV is active.
                let logsSpvPresent = false;
                try { logsSpvPresent = fs.existsSync(chainSpvLogDir(chainId)); }
                catch (_) { /* leave false */ }
                sidechains.push({
                    chainId, displayName, genesisBlock, running, spvBlockHeight, logsSpvPresent,
                });
            }

            return res.json(successBody({
                arbiter: {
                    configured: !!chains.arbiter,
                    running: arbiterRunning,
                    spvHeight: arbiterSpvHeight,
                },
                sidechains,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} GET /spv: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read SPV status.'));
        }
    });

    // --- tail the newest embedded-SPV log for one EVM sidechain ---
    router.get('/:chainId/logs', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        const { chainId } = req.params;
        if (!SPV_SIDECHAINS.includes(chainId)) {
            return res.status(404).json(errorBody(`No embedded SPV logs for "${chainId}".`));
        }
        try {
            const requested = parseInt(req.query.lines, 10);
            const n = Math.max(1, Math.min(
                SPV_LOG_TAIL_MAX_LINES,
                Number.isInteger(requested) ? requested : SPV_LOG_TAIL_DEFAULT_LINES,
            ));
            const lines = await tailSpvLog(chainId, n);
            return res.json(successBody({ chainId, lines }));
        } catch (err) {
            extensionHandle.log.debug(`${ENM_LOG_PREFIX} GET /spv/${chainId}/logs: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read SPV logs.'));
        }
    });

    return router;
}

/**
 * Tail the newest file in a sidechain's logs-spv directory. The geth fork
 * rotates SPV logs into that dir, so we pick the most-recently-modified
 * regular file and return its last `n` non-empty lines. Reads at most
 * SPV_LOG_TAIL_BYTE_CAP from the tail so a huge log can't exhaust memory.
 * Returns [] when the dir or any file is missing/unreadable.
 *
 * @param {string} chainId
 * @param {number} n
 * @returns {Promise<string[]>}
 */
async function tailSpvLog(chainId, n) {
    const dir = chainSpvLogDir(chainId);
    let entries;
    try { entries = await fsp.readdir(dir); }
    catch (_) { return []; }            // dir absent — SPV not active yet
    if (!entries || entries.length === 0) { return []; }

    let newest = null;
    for (const name of entries) {
        const full = path.join(dir, name);
        try {
            // eslint-disable-next-line no-await-in-loop
            const st = await fsp.stat(full);
            if (st.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) {
                newest = { full, mtimeMs: st.mtimeMs, size: st.size };
            }
        } catch (_) { /* skip unreadable entry */ }
    }
    if (!newest) { return []; }

    const start = Math.max(0, newest.size - SPV_LOG_TAIL_BYTE_CAP);
    const len = newest.size - start;
    if (len <= 0) { return []; }
    const fh = await fsp.open(newest.full, 'r');
    try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        return buf.toString('utf8')
            .split(/\r?\n/)
            .filter((l) => l.length > 0)
            .slice(-n);
    } finally {
        await fh.close();
    }
}

module.exports = {
    build,
    // Exported for tests.
    _internal: { SPV_SIDECHAINS, tailSpvLog, asHeight },
};
