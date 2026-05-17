/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmStateSnapshot — Phase 7 Layer 2: periodic backup of ela's DPoS/CR/txPool
 * state files so the auto-heal layer can roll forward to a recent known-good
 * state when the live default.dcp gets out-of-sync with the block ledger.
 *
 * Why this exists:
 *   ela writes its block ledger every block (~2s) but writes the live state
 *   file (cp_dpos/default.dcp) only every SavePeriod blocks (~24min). Between
 *   saves, the on-disk roster is stale relative to the ledger. If ela exits
 *   non-gracefully (OOM, host reboot, deploy bounce) in that window, the next
 *   restart loads an inconsistent default.dcp; replay of the in-between blocks
 *   often fails — F1/F2/F4 fire but a restart can't fix what restart can't
 *   reconstruct. Bootstrap-snapshot fixes it but costs 10GB + ~30min downtime.
 *
 *   This service maintains a rolling N copies of those state files on its
 *   own cadence (configurable, default hourly). When the auto-heal layer
 *   (services/EnmStateSnapshot.restore + new rule F22) detects the desync
 *   signature, it can swap in the most-recent snapshot and let ela re-fetch
 *   the small delta from peers. Recovery time: ~3-5 min, fully automatic.
 *
 * Storage layout:
 *   <enmDataDir>/.state-snapshots/<chainId>/<ISO-timestamp>/
 *     ├── default.dcp       (copy of cp_dpos/default.dcp at snapshot time)
 *     ├── default.cr        (copy of cp_cr/default.cr; if present)
 *     └── default.txpcp     (copy of cp_txPool/default.txpcp; if present)
 *     └── meta.json         { chainHeadAt, takenAt, sizeBytes }
 *
 * Retention:
 *   Default: keep last 24 snapshots (one day rolling at hourly cadence).
 *   Pruning runs on each take(); oldest beyond limit get rm -rf'd.
 *
 * Cadence:
 *   Default: take() fires every 60 minutes from service start.
 *   Tunable via cfg.global.stateSnapshot.intervalSec (Phase 7 schema add).
 *
 * Safety:
 *   - take() ONLY runs when chain is alive + RPC reachable + height stable
 *     (no in-flux state). This guarantees the snapshot is internally consistent.
 *   - Uses streamed copy via fsp.copyFile, atomic per-file. No write-into-
 *     destination semantics; each snapshot dir is built up entirely in a
 *     .partial sibling and renamed when complete.
 *   - Failure to snapshot is non-fatal; logs at warn level, skips this cycle.
 *
 * Restore (Layer 4 caller):
 *   restore(chainId) — picks the most recent valid snapshot, copies its files
 *   over the live cp_xxx/default.xxx targets, returns paths restored. Caller
 *   (SelfHealingEngine._actStateRestore) is responsible for stopping ela
 *   before calling restore and starting ela after.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ENM_LOG_PREFIX } = require('./EnmConstants');
const DataDir = require('./DataDir');

// 60-minute default cadence. Operator can lower if they prefer more frequent
// snapshots (each snapshot is ~6MB so cost is bounded even at 5-min cadence).
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_RETENTION = 24;
// Minimum chain uptime before we trust the on-disk state is settled enough
// to snapshot. Pre-3.62 fast-tick reset bug showed F2 could fire 25s after
// start with stale firstRpcDownAt; we want the chain to be SOLIDLY up
// before we copy state.
const MIN_UPTIME_BEFORE_FIRST_SNAPSHOT_MS = 5 * 60_000;

const SNAPSHOT_ROOT_NAME = '.state-snapshots';
const STATE_FILES = [
    // (sourceRelative, snapshotFilename)
    { src: ['elastos', 'data', 'checkpoints', 'cp_dpos', 'default.dcp'],  dst: 'default.dcp'  },
    { src: ['elastos', 'data', 'checkpoints', 'cp_cr', 'default.cr'],     dst: 'default.cr'   },
    { src: ['elastos', 'data', 'checkpoints', 'cp_txPool', 'default.txpcp'], dst: 'default.txpcp' },
];

class EnmStateSnapshot {
    /**
     * @param {object} deps
     * @param {object} deps.extensionHandle
     * @param {object} deps.processService
     * @param {(chainId:string) => object} deps.getAdapter
     * @param {() => Array<{chainId:string}>} deps.listChains
     */
    constructor(deps) {
        if (!deps || !deps.extensionHandle || !deps.processService
            || typeof deps.getAdapter !== 'function'
            || typeof deps.listChains !== 'function') {
            throw new TypeError(
                'EnmStateSnapshot: { extensionHandle, processService, getAdapter, listChains } required',
            );
        }
        this.extensionHandle = deps.extensionHandle;
        this.processService = deps.processService;
        this.getAdapter = deps.getAdapter;
        this.listChains = deps.listChains;
        this._timer = null;
        this._intervalMs = DEFAULT_INTERVAL_MS;
        this._retention = DEFAULT_RETENTION;
    }

    /**
     * Wire the configurable knobs from cfg.global.stateSnapshot. Idempotent —
     * caller can re-apply if config changes at runtime.
     * @param {object} cfg
     */
    applyConfig(cfg) {
        const opts = cfg && cfg.global && cfg.global.stateSnapshot;
        if (!opts) { return; }
        if (Number.isInteger(opts.intervalSec) && opts.intervalSec >= 60) {
            this._intervalMs = opts.intervalSec * 1000;
        }
        if (Number.isInteger(opts.retention) && opts.retention >= 1 && opts.retention <= 168) {
            this._retention = opts.retention;
        }
    }

    /**
     * Start the periodic snapshot timer. Two phases:
     *   - "kick" snapshot ~10 min after start so a backup exists ASAP
     *     (before the first regular tick). Without this, a fresh install
     *     or post-deploy restart had no snapshot available for the F22
     *     auto-heal during its first hour of life — operator's chain
     *     could corrupt within that window and we'd have nothing to
     *     restore from.
     *   - regular interval after that (default 60 min) for ongoing
     *     rolling backups. Existing snapshots accumulate up to retention.
     * The 10-min kick is past the MIN_UPTIME_BEFORE_FIRST_SNAPSHOT_MS
     * threshold so it'll actually take a snapshot rather than skip
     * with "chain-too-young".
     */
    start() {
        if (this._timer) { return; }
        const log = this.extensionHandle.log;
        log.info(
            `${ENM_LOG_PREFIX} EnmStateSnapshot: kick in 10min, then cadence=${this._intervalMs / 60_000}min, retention=${this._retention}`,
        );
        // Initial kick — 10 min after start (10 min > MIN_UPTIME 5 min).
        this._kickTimeout = setTimeout(() => {
            this._tick().catch((err) => {
                log.warn(`${ENM_LOG_PREFIX} EnmStateSnapshot kick failed (non-fatal): ${err.message}`);
            });
        }, 10 * 60_000);
        this._timer = setInterval(() => {
            this._tick().catch((err) => {
                log.warn(`${ENM_LOG_PREFIX} EnmStateSnapshot tick failed (non-fatal): ${err.message}`);
            });
        }, this._intervalMs);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._kickTimeout) {
            clearTimeout(this._kickTimeout);
            this._kickTimeout = null;
        }
    }

    /** @private */
    async _tick() {
        for (const chainInfo of this.listChains()) {
            await this.takeSnapshot(chainInfo.chainId).catch((err) => {
                this.extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} EnmStateSnapshot ${chainInfo.chainId}: ${err.message}`,
                );
            });
        }
    }

    /**
     * Take one snapshot for `chainId`. Safe to call from outside the tick
     * (tests, manual trigger via future POST /chains/:id/snapshot route).
     *
     * Skips and returns { skipped: true, reason } when chain isn't in a
     * snapshottable state. Returns { ok: true, path, files } on success.
     *
     * @param {string} chainId
     * @returns {Promise<object>}
     */
    async takeSnapshot(chainId) {
        const log = this.extensionHandle.log;
        // Don't snapshot a dead/unhealthy chain — the on-disk state may be
        // mid-write or already inconsistent.
        const status = this.processService.statusSync(chainId);
        if (!status || !status.alive) {
            return { skipped: true, reason: 'chain-not-alive' };
        }
        const startedAt = status.startedAt || 0;
        if (startedAt && (Date.now() - startedAt) < MIN_UPTIME_BEFORE_FIRST_SNAPSHOT_MS) {
            return { skipped: true, reason: 'chain-too-young' };
        }
        // RPC reachability gates this too. A chain that's alive but RPC-
        // unresponsive is suspect — its state may be partially flushed.
        const adapter = this.getAdapter(chainId);
        if (adapter && typeof adapter.rpcClient === 'function') {
            try {
                const ConfigStore = require('./ConfigStore');
                const cfg = await ConfigStore.load();
                const chainCfg = cfg && cfg.chains && cfg.chains[chainId];
                if (!chainCfg) {
                    return { skipped: true, reason: 'chain-not-configured' };
                }
                const rpc = adapter.rpcClient(chainCfg);
                const height = await rpc.getblockcount().catch(() => null);
                if (typeof height !== 'number' || height < 100_000) {
                    // Either RPC didn't answer or chain is way behind canonical
                    // tip — don't trust this state.
                    return { skipped: true, reason: 'rpc-unhealthy-or-not-synced' };
                }
            } catch (err) {
                return { skipped: true, reason: 'rpc-check-failed: ' + err.message };
            }
        }

        // Verify all source state files exist before starting the copy.
        const chainDir = DataDir.chainDir(chainId);
        const snapshotsRoot = path.join(DataDir.enmDataDir(), SNAPSHOT_ROOT_NAME, chainId);
        await fsp.mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const finalDir = path.join(snapshotsRoot, ts);
        const partialDir = `${finalDir}.partial`;
        await fsp.rm(partialDir, { recursive: true, force: true });
        await fsp.mkdir(partialDir, { recursive: true, mode: 0o700 });

        const copied = [];
        let totalBytes = 0;
        for (const f of STATE_FILES) {
            const srcPath = path.join(chainDir, ...f.src);
            const dstPath = path.join(partialDir, f.dst);
            try {
                const stat = await fsp.stat(srcPath);
                await fsp.copyFile(srcPath, dstPath);
                copied.push({ name: f.dst, sizeBytes: stat.size });
                totalBytes += stat.size;
            } catch (err) {
                if (err.code === 'ENOENT') {
                    // Some chains don't have every checkpoint file (e.g.,
                    // freshly-bootstrapped chain may lack cp_cr until first
                    // proposal lands). Note but continue — we restore only
                    // what we have.
                    log.debug(
                        `${ENM_LOG_PREFIX} EnmStateSnapshot ${chainId}: ${f.dst} not present at source, skipping`,
                    );
                    continue;
                }
                // Abort this snapshot, clean up partial. Next tick retries.
                await fsp.rm(partialDir, { recursive: true, force: true });
                throw err;
            }
        }
        if (copied.length === 0) {
            await fsp.rm(partialDir, { recursive: true, force: true });
            return { skipped: true, reason: 'no-state-files-present' };
        }

        // Write meta last so a partial dir without meta is a "did not finish"
        // signal for restore() to skip the partial.
        const meta = {
            chainId,
            takenAt: Date.now(),
            takenAtIso: ts,
            files: copied,
            totalBytes,
        };
        await fsp.writeFile(
            path.join(partialDir, 'meta.json'),
            JSON.stringify(meta, null, 2),
            { mode: 0o600 },
        );

        // Atomic: rename .partial → final
        await fsp.rename(partialDir, finalDir);
        log.info(
            `${ENM_LOG_PREFIX} EnmStateSnapshot ${chainId}: captured ${copied.length} file(s), ${Math.round(totalBytes / 1024)}KB at ${ts}`,
        );

        // Prune oldest beyond retention
        await this._prune(chainId).catch((err) => {
            log.warn(`${ENM_LOG_PREFIX} EnmStateSnapshot ${chainId} prune: ${err.message}`);
        });

        return { ok: true, path: finalDir, files: copied, sizeBytes: totalBytes };
    }

    /**
     * @private
     * Keep the most-recent `_retention` snapshots; rm -rf the rest.
     */
    async _prune(chainId) {
        const snapshotsRoot = path.join(DataDir.enmDataDir(), SNAPSHOT_ROOT_NAME, chainId);
        const all = await this._listSnapshots(chainId);
        if (all.length <= this._retention) { return; }
        const toDelete = all.slice(this._retention);
        for (const s of toDelete) {
            try {
                await fsp.rm(path.join(snapshotsRoot, s.name), { recursive: true, force: true });
                this.extensionHandle.log.info(
                    `${ENM_LOG_PREFIX} EnmStateSnapshot ${chainId}: pruned ${s.name}`,
                );
            } catch (err) {
                this.extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} EnmStateSnapshot ${chainId}: prune ${s.name} failed: ${err.message}`,
                );
            }
        }
    }

    /**
     * List snapshots for a chain, newest first. Each entry includes parsed
     * meta when readable. Internal use + Layer 4 restore picker.
     *
     * @param {string} chainId
     * @returns {Promise<Array<{name: string, takenAt: number, meta: object|null}>>}
     */
    async _listSnapshots(chainId) {
        const snapshotsRoot = path.join(DataDir.enmDataDir(), SNAPSHOT_ROOT_NAME, chainId);
        let entries;
        try {
            entries = await fsp.readdir(snapshotsRoot);
        } catch (err) {
            if (err.code === 'ENOENT') { return []; }
            throw err;
        }
        const results = [];
        for (const name of entries) {
            // Skip .partial dirs — those are in-flight or aborted.
            if (name.endsWith('.partial')) { continue; }
            const metaPath = path.join(snapshotsRoot, name, 'meta.json');
            let meta = null;
            try {
                const raw = await fsp.readFile(metaPath, 'utf8');
                meta = JSON.parse(raw);
            } catch (_) { /* malformed meta → still listed but no meta */ }
            const takenAt = (meta && meta.takenAt) || 0;
            results.push({ name, takenAt, meta });
        }
        results.sort((a, b) => b.takenAt - a.takenAt);
        return results;
    }

    /**
     * List recent snapshots — public surface for routes/tests.
     * @param {string} chainId
     */
    async listSnapshots(chainId) {
        return this._listSnapshots(chainId);
    }

    /**
     * Restore a snapshot over the live state files.
     * Caller MUST have already stopped the chain process before calling.
     *
     * Files are restored with the same atomic pattern as snapshot creation:
     * copy each source to dest.tmp, fsync, rename. So a crash mid-restore
     * leaves either the OLD live file or the NEW restored file, never half-
     * written content.
     *
     * beta.3.76 — accepts optional `snapshotName` to restore a specific
     * snapshot by ID. When omitted, restores the newest (preserves the
     * pre-3.76 latest-only behaviour the autonomous F22 path relies on).
     *
     * @param {string} chainId
     * @param {string} [snapshotName] — optional ISO-timestamp name of the
     *   snapshot to restore. If omitted, the newest is used.
     * @returns {Promise<{ok: boolean, snapshotName: string, restoredFiles: string[]}>}
     */
    async restore(chainId, snapshotName) {
        const status = this.processService.statusSync(chainId);
        if (status && status.alive) {
            throw new Error('EnmStateSnapshot.restore: chain must be stopped before restore.');
        }
        const snapshots = await this._listSnapshots(chainId);
        if (snapshots.length === 0) {
            throw new Error('EnmStateSnapshot.restore: no snapshots available to restore from.');
        }
        let chosen;
        if (snapshotName) {
            // Caller wants a specific snapshot. _listSnapshots only returns
            // entries with a valid meta.json, so a match here means the
            // snapshot is restorable.
            chosen = snapshots.find((s) => s.name === snapshotName);
            if (!chosen) {
                throw new Error(
                    `EnmStateSnapshot.restore: snapshot "${snapshotName}" not found in inventory for ${chainId}.`,
                );
            }
        } else {
            chosen = snapshots[0]; // newest
        }
        const snapshotDir = path.join(DataDir.enmDataDir(), SNAPSHOT_ROOT_NAME, chainId, chosen.name);
        const chainDir = DataDir.chainDir(chainId);
        const restored = [];
        for (const f of STATE_FILES) {
            const srcPath = path.join(snapshotDir, f.dst);
            const dstPath = path.join(chainDir, ...f.src);
            try {
                await fsp.access(srcPath);
            } catch (_) {
                continue; // file wasn't in this snapshot
            }
            await fsp.mkdir(path.dirname(dstPath), { recursive: true });
            const tmpDst = `${dstPath}.restoring`;
            await fsp.copyFile(srcPath, tmpDst);
            await fsp.rename(tmpDst, dstPath);
            restored.push(dstPath);
        }
        this.extensionHandle.log.info(
            `${ENM_LOG_PREFIX} EnmStateSnapshot.restore ${chainId}: restored ${restored.length} file(s) from ${chosen.name}`,
        );
        return { ok: true, snapshotName: chosen.name, restoredFiles: restored };
    }
}

module.exports = {
    EnmStateSnapshot,
    // exported for tests
    _internal: { DEFAULT_INTERVAL_MS, DEFAULT_RETENTION, STATE_FILES },
};
