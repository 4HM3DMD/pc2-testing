/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/logs.js — HTTP polling endpoint for log tails.
 *
 *   GET /api/logs/:chainId/tail?n=200
 *
 * Phase 3 ships a simple file-tail implementation. Full live streaming uses
 * the SSE endpoint at /api/events?topic=chains:<id>:logs (powered by
 * ProcessLogStreamer). This endpoint is for:
 *   - Initial page load — fetch recent history
 *   - Reattached chains — we don't have stdout pipes, only files on disk
 *   - Frontend reconnect — fetch missed window between SSE drops
 *
 * ela writes structured logs to <dataDir>/elastos/logs/{node,dpos}/ rotated
 * by ela itself (Rev 7 audit). We tail the most recent file.
 */

'use strict';

const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { readActorWallet } = require('../auth/OwnerCheckMiddleware');
const { chainDir } = require('../services/DataDir');

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 5000;
const TAIL_BYTE_BUDGET = 2 * 1024 * 1024; // 2 MiB read cap to bound memory

/**
 * @param {object} deps
 * @param {object} deps.extensionHandle
 * @returns {import('express').Router}
 */
function build(deps) {
    const { extensionHandle } = deps;
    const router = express.Router();

    /**
     * GET /:chainId/tail?n=200
     * Returns the last `n` lines of the chain's node log file.
     */
    router.get('/:chainId/tail', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        const chainId = req.params.chainId;
        if (!/^[a-z0-9-]+$/.test(chainId)) {
            return res.status(400).json(errorBody(`Invalid chainId "${chainId}".`));
        }

        const requested = parseInt(req.query.n, 10);
        const n = Number.isInteger(requested) && requested > 0
            ? Math.min(requested, MAX_TAIL_LINES)
            : DEFAULT_TAIL_LINES;

        try {
            const lines = await tailLogFile(chainId, n);
            return res.json(successBody({ chainId, lines }));
        } catch (err) {
            if (err.code === 'ENOENT') {
                // No log file yet — chain hasn't started or hasn't logged.
                return res.json(successBody({ chainId, lines: [] }));
            }
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} GET /logs/${chainId}/tail failed: ${err.message}`,
            );
            return res.status(500).json(errorBody('Failed to read log file.'));
        }
    });

    return router;
}

/**
 * Find the most recent node log file under the chain dir and return its last
 * `n` lines. ela writes to elastos/logs/node/<timestamp>.log rotating at 20MB
 * per file (Rev 7 audit).
 *
 * @param {string} chainId
 * @param {number} n
 * @returns {Promise<Array<{ stream: 'file', line: string, ts: number }>>}
 */
async function tailLogFile(chainId, n) {
    const logDir = path.join(chainDir(chainId), 'elastos', 'logs', 'node');
    let entries;
    try {
        entries = await fs.readdir(logDir, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }

    const candidates = entries
        .filter((e) => e.isFile() && e.name.endsWith('.log'))
        .map((e) => path.join(logDir, e.name));
    if (candidates.length === 0) {
        return [];
    }

    // Sort by mtime descending — most recent first.
    const stats = await Promise.all(candidates.map(async (p) => ({ p, stat: await fs.stat(p) })));
    stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const newest = stats[0];

    // Read up to TAIL_BYTE_BUDGET bytes from the END of the file. For simplicity
    // we read the whole file when small; for big files we slice. Bounded so
    // operators don't trigger an OOM on a 20 MB log file.
    const readBytes = Math.min(newest.stat.size, TAIL_BYTE_BUDGET);
    const handle = await fs.open(newest.p, 'r');
    try {
        const buf = Buffer.alloc(readBytes);
        const offset = Math.max(0, newest.stat.size - readBytes);
        await handle.read(buf, 0, readBytes, offset);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        // Drop the first line if we sliced mid-file — it's likely truncated.
        if (offset > 0 && lines.length > 0) {
            lines.shift();
        }
        const last = lines.slice(-n).filter((l) => l.length > 0);
        const ts = Date.now();
        return last.map((line) => ({ stream: 'file', line, ts }));
    } finally {
        await handle.close();
    }
}

module.exports = {
    build,
    tailLogFile,
    DEFAULT_TAIL_LINES,
    MAX_TAIL_LINES,
};
