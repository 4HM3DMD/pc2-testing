/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/system.js — system info endpoints (Phase 1b skeleton).
 *
 * Phase 1b: GET /api/system/status returns OS + disk + extension version.
 * Phase 5 expansion: CPU/RAM live stats, Docker daemon status (n/a since
 * Ubuntu-only native), orphan-process detection.
 */

'use strict';

const express = require('express');
const os = require('node:os');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { readActorWallet } = require('../auth/OwnerCheckMiddleware');
const osPreflight = require('../services/OsPreflight');
const diskPreflight = require('../services/DiskPreflight');
const { enmDataDir } = require('../services/DataDir');
const { round } = require('../services/EnmFormat');
const ExtIpResolver = require('../services/ExtIpResolver');

const PKG = require('../package.json');

/**
 * @param {object} extensionHandle
 * @returns {import('express').Router}
 */
function build(extensionHandle) {
    const router = express.Router();

    /**
     * GET /system/status
     * Aggregate health snapshot — what the dashboard polls every 30s.
     */
    router.get('/status', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const memTotalGb = os.totalmem() / (1024 ** 3);
            const memFreeGb = os.freemem() / (1024 ** 3);
            const loadAvg = os.loadavg();
            const disk = await diskPreflight.check(enmDataDir());
            const osCheck = osPreflight.check();

            return res.json(successBody({
                version: PKG.version,
                node: {
                    platform: os.platform(),
                    release: os.release(),
                    arch: os.arch(),
                    nodeVersion: process.version,
                    uptimeSec: Math.floor(process.uptime()),
                },
                cpu: {
                    cores: os.cpus().length,
                    loadAvg1m: loadAvg[0],
                    loadAvg5m: loadAvg[1],
                    loadAvg15m: loadAvg[2],
                },
                memory: {
                    totalGb: round(memTotalGb, 2),
                    freeGb: round(memFreeGb, 2),
                    usedPct: round(((memTotalGb - memFreeGb) / memTotalGb) * 100, 2),
                },
                disk,
                os: osCheck,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /system/status error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read system status.'));
        }
    });

    /**
     * GET /system/extip
     * Settings → Network → "Detect now". Hits checkip.amazonaws.com and
     * returns the resolved IP (with cache).
     */
    router.get('/extip', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const force = req.query && req.query.force === '1';
            const result = await ExtIpResolver.resolve({ force });
            return res.json(successBody(result));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /system/extip error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to resolve external IP.'));
        }
    });

    return router;
}

module.exports = {
    build,
};
