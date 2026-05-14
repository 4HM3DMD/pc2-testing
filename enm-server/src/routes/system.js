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
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { readActorWallet } = require('../auth/OwnerCheckMiddleware');
const osPreflight = require('../services/OsPreflight');
const diskPreflight = require('../services/DiskPreflight');
const { enmDataDir, chainDir } = require('../services/DataDir');
const { round } = require('../services/EnmFormat');
const ExtIpResolver = require('../services/ExtIpResolver');
const ChainRegistry = require('../services/ChainRegistry');
const ConfigStore = require('../services/ConfigStore');

const PKG = require('../../package.json');

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
     * GET /system/identity
     *
     * beta.3.13 — single source for the Node-identity dashboard card.
     * Joins three concepts the operator needs to see in one place:
     *
     *   1. walletAddress  — PC2 session wallet. The operator's login
     *      identity for ENM (authorization, audit log attribution).
     *      ENM never asks this wallet to sign chain transactions.
     *
     *   2. keystore       — the ELA producer keystore stored on this
     *      server. publicKey is what operators paste into Essentials
     *      to register a producer; address is the on-chain ELA address
     *      derived from that keystore (signs blocks + receives BPoS
     *      rewards). balanceEla is best-effort via getbalancebyaddr.
     *
     *   3. producer       — when registered, surface state + votes +
     *      deposit + claimable rewards so the operator gets a single-
     *      glance "this is my node on-chain" view. null when the
     *      pubkey isn't registered yet OR the chain isn't running.
     *
     * Best-effort: any RPC failure degrades that section to null
     * without failing the whole response (the dashboard card already
     * has to render before the chain is up).
     */
    router.get('/identity', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const ks = ChainRegistry.getKeystoreService();
            const keystoreExists = await ks.exists();

            let publicKey = null;
            let address = null;
            if (keystoreExists) {
                const identityPath = path.join(chainDir('mainchain'), 'keystore-account.json');
                try {
                    const raw = await fsp.readFile(identityPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    publicKey = parsed.publicKey || null;
                    address = parsed.address || null;
                } catch (_) { /* missing cache — surface as null */ }
            }

            let balanceEla = null;
            let producer = null;

            // Only try RPC when we have an address (balance) or pubkey
            // (producer info), AND the chain is alive. Avoids hammering
            // RPC when the node hasn't started yet.
            if (publicKey || address) {
                try {
                    const cfg = await ConfigStore.load();
                    const chainCfg = cfg.chains && cfg.chains.mainchain;
                    const chainAlive = ChainRegistry.getProcessService()
                        .statusSync('mainchain');
                    if (chainCfg && chainAlive && chainAlive.alive) {
                        const adapter = ChainRegistry.getAdapter('mainchain');
                        const rpc = adapter.rpcClient(chainCfg);

                        if (address) {
                            balanceEla = await rpc.getbalancebyaddr(address)
                                .catch(() => null);
                        }

                        if (publicKey) {
                            const pi = await rpc.getproducerinfo(publicKey)
                                .catch(() => null);
                            if (pi && (pi.state || pi.ownerpublickey || pi.nickname)) {
                                const deposit = await rpc.getdepositcoin(publicKey)
                                    .catch(() => null);
                                const rewards = await rpc.getdposrewards(publicKey)
                                    .catch(() => null);
                                producer = {
                                    state: pi.state || null,
                                    nickname: pi.nickname || null,
                                    url: pi.url || null,
                                    votes: pi.votes || null,
                                    dposv2votes: pi.dposv2votes || null,
                                    registerheight: pi.registerheight || null,
                                    illegalheight: pi.illegalheight || null,
                                    inactiveheight: pi.inactiveheight || null,
                                    deposit: deposit && (deposit.available || deposit) || null,
                                    rewards: rewards && (rewards.claimable || rewards) || null,
                                };
                            }
                        }
                    }
                } catch (_) { /* graceful degrade — leave balance/producer null */ }
            }

            return res.json(successBody({
                walletAddress: wallet,
                keystore: {
                    exists: keystoreExists,
                    publicKey,
                    address,
                    balanceEla,
                },
                producer,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /system/identity error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read node identity.'));
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
