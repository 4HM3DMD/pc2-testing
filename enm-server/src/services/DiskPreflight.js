/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * DiskPreflight — free-disk-space check for the chain data dir.
 *
 * Mainnet DB grows 50–80 GB initial sync + 2–5 GB/month (Rev 4 audit).
 *
 * Thresholds (from package.json `enm.minDiskFreeGb` / `warnDiskFreeGb`):
 *   < 50 GB free   → hard stop, refuse setup
 *   < 100 GB free  → warning, allow with explicit ack
 *   ≥ 100 GB free  → ok
 *
 * Uses fs.statfs (Node 18.15+, native — no extra dep). Path can be the chain
 * data dir or any directory on the same filesystem.
 */

'use strict';

const fsp = require('node:fs/promises');

const { gbDisplay } = require('./EnmFormat');

const HARD_STOP_GB = 50;
const WARN_GB = 100;
const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * @typedef {object} DiskPreflightResult
 * @property {boolean} ok
 * @property {'critical'|'warning'|'good'} status
 * @property {number} freeGb
 * @property {number} totalGb
 * @property {string} [reason]
 */

/**
 * @param {string} dirPath
 * @returns {Promise<DiskPreflightResult>}
 */
async function check(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') {
        throw new TypeError('DiskPreflight.check: dirPath required');
    }

    let stats;
    try {
        stats = await fsp.statfs(dirPath);
    } catch (err) {
        return {
            ok: false,
            status: 'critical',
            freeGb: 0,
            totalGb: 0,
            reason: `Could not stat filesystem at ${dirPath}: ${err.message}`,
        };
    }

    // bavail = blocks available to non-root user (the safe choice for our use case).
    // We're running as the same user PC2 runs as, NOT root.
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeGb = freeBytes / BYTES_PER_GB;
    const totalGb = totalBytes / BYTES_PER_GB;

    if (freeGb < HARD_STOP_GB) {
        return {
            ok: false,
            status: 'critical',
            freeGb,
            totalGb,
            reason: `Less than ${HARD_STOP_GB} GB free on ${dirPath} (${gbDisplay(freeGb)} GB available). Mainnet DB requires ~50–80 GB initial sync plus 2–5 GB/month growth.`,
        };
    }
    if (freeGb < WARN_GB) {
        return {
            ok: true,
            status: 'warning',
            freeGb,
            totalGb,
            reason: `${gbDisplay(freeGb)} GB free — recommended minimum is ${WARN_GB} GB for ~10 months of chain growth headroom.`,
        };
    }
    return { ok: true, status: 'good', freeGb, totalGb };
}

module.exports = {
    check,
    HARD_STOP_GB,
    WARN_GB,
};
