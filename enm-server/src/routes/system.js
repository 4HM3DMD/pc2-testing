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
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// beta.3.20 — synchronous fs used for the existsSync probe in
// GET /system/storage. Wrapped in a function so the module can be
// loaded in environments that mock `fs` (the test-server build).
function fsSync() { return fs; }

/**
 * beta.3.20 — recursive directory size in bytes. Catches every
 * stat/readdir error and returns 0 for that branch so a single
 * unreadable file doesn't fail the whole walk. Bounded depth (32)
 * to defeat symlink loops; bounded entries (50k) to keep the walk
 * cheap on pathological dirs.
 */
async function dirSizeSafe(p, depth) {
    if (typeof p !== 'string' || p.length === 0) { return 0; }
    if ((depth || 0) > 32) { return 0; }
    let stat;
    try { stat = await fsp.stat(p); }
    catch (_) { return 0; }
    if (stat.isFile()) { return stat.size; }
    if (!stat.isDirectory()) { return 0; }
    let entries;
    try { entries = await fsp.readdir(p); }
    catch (_) { return 0; }
    let total = 0;
    let count = 0;
    for (const name of entries) {
        if (++count > 50_000) { break; }
        total += await dirSizeSafe(path.join(p, name), (depth || 0) + 1);
    }
    return total;
}

async function fileSizeSafe(p) {
    if (typeof p !== 'string' || p.length === 0) { return 0; }
    try {
        const s = await fsp.stat(p);
        return s.isFile() ? s.size : 0;
    } catch (_) { return 0; }
}

function bytesToMb(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) { return 0; }
    return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

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

// v0.5.203 — per-chain disk-usage cache for /system/usage. dirSizeSafe walks
// the on-disk tree which is cheap for empty chains and ~150ms for a populated
// mainchain (~30GB extracted snapshot). 30s TTL is plenty for an
// operator-facing display — chain data grows by megabytes per minute, not GB.
let _perChainDiskCache = { ts: 0, data: {} };
async function getPerChainDiskMb() {
    const now = Date.now();
    if (now - _perChainDiskCache.ts < 30_000) {
        return _perChainDiskCache.data;
    }
    const out = {};
    const chainsRoot = path.join(enmDataDir(), 'chains');
    let chainIds;
    try {
        chainIds = (await fsp.readdir(chainsRoot)).filter((n) => !n.startsWith('.'));
    } catch (_) {
        // No chains/ dir yet — fresh install. Return empty map; the cache
        // refreshes once the dir exists.
        _perChainDiskCache = { ts: now, data: {} };
        return out;
    }
    await Promise.all(chainIds.map(async (cid) => {
        try {
            const bytes = await dirSizeSafe(path.join(chainsRoot, cid));
            out[cid] = Math.round((bytes / (1024 * 1024)) * 10) / 10;
        } catch (_) { out[cid] = null; }
    }));
    _perChainDiskCache = { ts: now, data: out };
    return out;
}

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

            let producer = null;

            // Only try RPC when we have a node public key AND the chain
            // is alive. beta.3.15: dropped the keystore-address balance
            // lookup entirely — the node signing address never holds
            // funds (verified at dpos/state/arbitrators.go:732-801), so
            // surfacing its balance was both misleading and broken
            // (getbalancebyaddr isn't on the JSON-RPC interface anyway).
            if (publicKey) {
                try {
                    const cfg = await ConfigStore.load();
                    const chainCfg = cfg.chains && cfg.chains.mainchain;
                    const chainAlive = ChainRegistry.getProcessService()
                        .statusSync('mainchain');
                    if (chainCfg && chainAlive && chainAlive.alive) {
                        const adapter = ChainRegistry.getAdapter('mainchain');
                        const rpc = adapter.rpcClient(chainCfg);

                        const pi = await rpc.getproducerinfo(publicKey)
                            .catch(() => null);
                        if (pi && (pi.state || pi.ownerpublickey || pi.nickname)) {
                            // Deposit is keyed by OWNER public key (the
                            // Essentials wallet). We have it from
                            // getproducerinfo.ownerpublickey.
                            const ownerPubkey = pi.ownerpublickey || null;
                            const deposit = ownerPubkey
                                ? await rpc.getdepositcoin(ownerPubkey).catch(() => null)
                                : null;

                            // Rewards are keyed by OWNER address; we don't
                            // derive that here (the chain's stake-prefix
                            // address conversion is non-trivial without
                            // pulling in crypto primitives). The Essentials
                            // app surfaces this — operator can check there.
                            // Leaving rewards null until we add an address
                            // derivation helper or operators ask for it.
                            producer = {
                                state: pi.state || null,
                                nickname: pi.nickname || null,
                                url: pi.url || null,
                                votes: pi.votes || null,
                                dposv2votes: pi.dposv2votes || null,
                                registerheight: pi.registerheight || null,
                                illegalheight: pi.illegalheight || null,
                                inactiveheight: pi.inactiveheight || null,
                                ownerPublicKey: ownerPubkey,
                                deposit: deposit && (deposit.available || deposit) || null,
                            };
                        }
                    }
                } catch (_) { /* graceful degrade — leave producer null */ }
            }

            // beta.3.52 — `walletAddress` removed from response. ENM's identity
            // is the keystore (ELA mainchain producer), NOT the PC2 owner wallet.
            // The two are completely separate concerns:
            //   - PC2 wallet authenticates the request (handled by requireOwner)
            //   - ENM keystore is what this node represents on-chain
            // Returning the PC2 wallet here implied they were coupled.
            return res.json(successBody({
                keystore: {
                    exists: keystoreExists,
                    publicKey,
                    address,
                },
                producer,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /system/identity error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read node identity.'));
        }
    });

    /**
     * GET /system/storage
     *
     * beta.3.20 (Phase 3) — disk-usage breakdown + auto-backup
     * status for the Settings Storage section. Read-only; aggregates
     * directory sizes from the chain data dir, log subdirs, the ENM
     * SQLite DB, and the keystore-backup root.
     *
     * Output shape:
     * {
     *   diskMb: {
     *     chainData: number,   // chains/<id>/elastos minus logs
     *     logs:      number,   // chains/<id>/elastos/logs
     *     auditDb:   number,   // enm.db
     *     backups:   number,   // backups/elastos-node-manager
     *     total:     number,
     *   },
     *   backup: {
     *     lastAt:        number|null,   // epoch ms
     *     lastPath:      string|null,
     *     intervalDays:  number,
     *     keepCount:     number,
     *     keystorePresent: boolean,     // true iff chains/<id>/keystore.dat exists
     *   },
     *   logRotation: { gzipAfterDays, purgeAfterDays },
     * }
     */
    router.get('/storage', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const cfg = await ConfigStore.load();
            const chainsDir = path.join(enmDataDir(), 'chains');
            const mainchainRoot = chainDir('mainchain');
            const elastosRoot = path.join(mainchainRoot, 'elastos');
            const logsRoot = path.join(elastosRoot, 'logs');
            const dbPath = path.join(enmDataDir(), 'enm.db');
            const pc2Data = process.env.PC2_DATA_DIR
                || path.dirname(path.dirname(enmDataDir()));
            const backupRoot = path.join(pc2Data, 'backups', 'elastos-node-manager');

            // Walk sizes in parallel. Each walk catches its own errors
            // so a missing dir (pre-setup) returns 0 instead of
            // throwing the whole request.
            const [elastosBytes, logsBytes, dbBytes, backupsBytes] = await Promise.all([
                dirSizeSafe(elastosRoot),
                dirSizeSafe(logsRoot),
                fileSizeSafe(dbPath),
                dirSizeSafe(backupRoot),
            ]);
            // Chain data = elastos minus logs (don't double-count).
            const chainDataBytes = Math.max(0, elastosBytes - logsBytes);

            const keystoreSrc = path.join(mainchainRoot, 'keystore.dat');
            const keystorePresent = fsSync().existsSync(keystoreSrc);

            const g = (cfg && cfg.global) || {};
            const b = (g.backup) || {};
            const lr = (g.logRotation) || {};

            const diskMb = {
                chainData: bytesToMb(chainDataBytes),
                logs:      bytesToMb(logsBytes),
                auditDb:   bytesToMb(dbBytes),
                backups:   bytesToMb(backupsBytes),
                total:     bytesToMb(chainDataBytes + logsBytes + dbBytes + backupsBytes),
            };
            const backup = {
                lastAt:          Number.isFinite(b.lastKeystoreBackupAt) ? b.lastKeystoreBackupAt : null,
                lastPath:        typeof b.lastKeystoreBackupPath === 'string' ? b.lastKeystoreBackupPath : null,
                intervalDays:    Number.isFinite(b.keystoreIntervalDays) ? b.keystoreIntervalDays : 7,
                keepCount:       Number.isFinite(b.keystoreKeepCount) ? b.keystoreKeepCount : 4,
                keystorePresent,
                backupDir:       backupRoot,
            };
            const logRotation = {
                gzipAfterDays:  Number.isFinite(lr.gzipAfterDays) ? lr.gzipAfterDays : 7,
                purgeAfterDays: Number.isFinite(lr.purgeAfterDays) ? lr.purgeAfterDays : 30,
            };

            return res.json(successBody({ diskMb, backup, logRotation }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /system/storage error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read storage status.'));
        }
    });

    /**
     * v0.5.203 — GET /system/usage
     *
     * The multi-chain overview's top-row "usage cards" data source. Returns
     * a single compact snapshot of host-level CPU + memory + disk + a
     * per-chain disk breakdown.
     *
     * Why a separate endpoint from /system/status: /status is broad (OS +
     * preflight + node version) and predates the overview redesign. /usage
     * is shaped for the four cards exactly + adds the per-chain disk
     * breakdown (the previous /storage endpoint only carries top-level
     * totals).
     *
     * Cost: cheap. CPU + memory are O(1) `os.*` calls. Disk-free is one
     * statfs. Per-chain disk uses a 30-second module-level cache so the 1s
     * overview tick doesn't trigger a `du`-walk every second.
     */
    router.get('/usage', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const memTotalGb = os.totalmem() / (1024 ** 3);
            const memFreeGb = os.freemem() / (1024 ** 3);
            const memUsedGb = memTotalGb - memFreeGb;
            const loadAvg = os.loadavg();
            const cpuCores = os.cpus().length;

            // Disk — total / used / free at the ENM data dir mountpoint.
            const dataDir = enmDataDir();
            await fsp.mkdir(dataDir, { recursive: true });
            let diskTotalGb = null, diskFreeGb = null, diskUsedGb = null;
            try {
                if (typeof fsp.statfs === 'function') {
                    const sf = await fsp.statfs(dataDir);
                    diskTotalGb = (sf.blocks * sf.bsize) / (1024 ** 3);
                    diskFreeGb = (sf.bavail * sf.bsize) / (1024 ** 3);
                    diskUsedGb = diskTotalGb - diskFreeGb;
                }
            } catch (_) { /* statfs unavailable — render '—' */ }

            // Per-chain disk usage with 30-second cache. The chain-data tree
            // grows slowly (chain blocks land 1/4s for mainchain, slower for
            // sidechains); a 30s stale cache is well within "visibly current"
            // for the operator.
            const perChainDiskMb = await getPerChainDiskMb();

            return res.json(successBody({
                ts: Date.now(),
                cpu: {
                    cores: cpuCores,
                    loadAvg1m:  loadAvg[0],
                    loadAvg5m:  loadAvg[1],
                    loadAvg15m: loadAvg[2],
                    // Rough "system busyness" pct = (load1 / cores) × 100,
                    // capped at 100. A box at load 8.0 on 8 cores reads ~100%;
                    // at load 4.0 on 8 cores ~50%. Not the same as
                    // sum-of-process-CPU% but it's the standard Linux signal
                    // the operator already understands from `top`.
                    loadPct: cpuCores > 0 ? Math.min(100, Math.round((loadAvg[0] / cpuCores) * 100)) : null,
                },
                memory: {
                    totalGb: round(memTotalGb, 2),
                    usedGb:  round(memUsedGb, 2),
                    freeGb:  round(memFreeGb, 2),
                    usedPct: round((memUsedGb / memTotalGb) * 100, 1),
                },
                disk: {
                    totalGb: diskTotalGb != null ? round(diskTotalGb, 2) : null,
                    usedGb:  diskUsedGb  != null ? round(diskUsedGb,  2) : null,
                    freeGb:  diskFreeGb  != null ? round(diskFreeGb,  2) : null,
                    usedPct: (diskTotalGb && diskTotalGb > 0)
                        ? round((diskUsedGb / diskTotalGb) * 100, 1) : null,
                    perChainMb: perChainDiskMb,
                },
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /system/usage error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to read system usage.'));
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
