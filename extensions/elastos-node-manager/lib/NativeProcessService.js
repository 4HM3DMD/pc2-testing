/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * NativeProcessService — spawn, monitor, stop, and reattach to ela processes.
 *
 * Replaces the entire Docker stack from earlier plan revisions. Per Rev 9:
 * Ubuntu-only, native binary built by the operator, no Docker.
 *
 * Design (per Rev 6 audits):
 *   - `child_process.spawn(binaryPath, [], { cwd, detached:true })` so the
 *     ela process outlives PC2 if PC2 itself crashes (good for BPoS uptime).
 *   - `child.unref()` so PC2 can shut down cleanly without waiting for ela.
 *   - PID + metadata sidecar files at ${runDir}/ela-<chainId>.{pid,meta.json}
 *   - Stop: SIGTERM → wait 60s → SIGKILL (Rev 6: ela's leveldb close + peer
 *     disconnect is 2-8s typical, 60s gives ample slack).
 *   - Reattach on PC2 boot: read PID file, kill(pid, 0) liveness check. If
 *     alive, register the chain as "running" but logs come from on-disk
 *     files (we lost stdio after parent restart).
 *   - Exit code aware: F1 only fires on non-zero exit OR SIGTERM+enabled.
 *   - withChainLock around every mutation — no double-starts (Rev 6 finding).
 *
 * What this DOES NOT do:
 *   - Generate the chain's config.json (that's ChainAdapter.generateConfig)
 *   - Decrypt the keystore password (caller passes it in)
 *   - Decide healing actions (SelfHealingEngine, Phase 4)
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const EventEmitter = require('node:events');

const {
    ENM_LOG_PREFIX,
    PROCESS_STOP_GRACE_MS,
} = require('./EnmConstants');
const {
    chainDir,
    pidFilePath,
    runDir,
    atomicWrite,
} = require('./DataDir');
const { withChainLock } = require('./withChainLock');
const {
    isPidAlive,
    isOurProcess,
    metaFilePath,
    sleep,
    buildSafeChildEnv,
} = require('./processUtils');

/** @typedef {{ pid: number, binaryPath: string, startedAt: number, version?: string|null }} ProcessMeta */

class NativeProcessService extends EventEmitter {
    /**
     * @param {object} deps
     * @param {object} deps.extensionHandle
     */
    constructor(deps) {
        super();
        if (!deps || !deps.extensionHandle) {
            throw new TypeError('NativeProcessService: { extensionHandle } required');
        }
        this.extensionHandle = deps.extensionHandle;
        /** @type {Map<string, { child: import('node:child_process').ChildProcess, meta: ProcessMeta, manualStop: boolean }>} */
        this.handles = new Map();
    }

    /**
     * Synchronous status probe. Does NOT touch the network. Used by health
     * checker fast tick (5s).
     *
     * @param {string} chainId
     * @returns {{ alive: boolean, pid: number|null, attached: boolean }}
     */
    statusSync(chainId) {
        const handle = this.handles.get(chainId);
        if (handle) {
            // We have an in-process child — trust the kill(0) result. Cross-check
            // the binary path on Linux to defend against PID reuse (audit agent 4).
            const alive = isOurProcess(handle.meta.pid, handle.meta.binaryPath);
            return { alive, pid: handle.meta.pid, attached: true };
        }
        // Maybe a previous PC2 instance left a PID file (reattach not yet run).
        const pidPath = pidFilePath(chainId);
        let raw;
        try {
            raw = fs.readFileSync(pidPath, 'utf8');
        } catch (err) {
            // ENOENT or any read error — treat as not running.
            this.extensionHandle.log.debug(`${ENM_LOG_PREFIX} statusSync(${chainId}) read pid: ${err.message}`);
            return { alive: false, pid: null, attached: false };
        }
        const pid = parseInt(raw.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) {
            return { alive: false, pid: null, attached: false };
        }
        // Best-effort binary-path cross-check via the meta sidecar.
        let expectedBinary = null;
        try {
            const m = JSON.parse(fs.readFileSync(metaFilePath(chainId), 'utf8'));
            if (m && typeof m.binaryPath === 'string') {
                expectedBinary = m.binaryPath;
            }
        } catch (_) { /* meta missing → fall back to alive-only check */ }
        return { alive: isOurProcess(pid, expectedBinary), pid, attached: false };
    }

    /**
     * Start the chain. Locked per chainId. Idempotent: if already running,
     * returns the existing PID without spawning twice.
     *
     * Caller must:
     *   1. Have already validated the binary path (EnmBinaryLocator.smokeTest).
     *   2. Have already written the chain's config.json + keystore.dat to chainDir.
     *
     * @param {string} chainId
     * @param {object} chainConfig
     * @returns {Promise<{ pid: number, startedAt: number, alreadyRunning?: boolean }>}
     */
    start(chainId, chainConfig) {
        return withChainLock(chainId, async () => {
            const existing = this.statusSync(chainId);
            if (existing.alive) {
                return {
                    pid: existing.pid,
                    startedAt: 0,
                    alreadyRunning: true,
                };
            }
            // Stale PID file from crashed previous run — clean up.
            if (existing.pid) {
                await this._unlinkSilent(pidFilePath(chainId));
            }

            return this._spawnLocked(chainId, chainConfig);
        });
    }

    /**
     * Stop the chain. SIGTERM → wait grace → SIGKILL. Marks as user-initiated
     * so F1 honors the stop and doesn't try to restart. Locked per chainId.
     *
     * @param {string} chainId
     * @returns {Promise<{ exitCode: number|null, signal: string|null, killed?: boolean }>}
     */
    stop(chainId) {
        return withChainLock(chainId, async () => {
            const handle = this.handles.get(chainId);
            const pidPath = pidFilePath(chainId);

            if (!handle) {
                // Maybe a reattached process — try to signal by PID file.
                let pid = null;
                try {
                    pid = parseInt((await fsp.readFile(pidPath, 'utf8')).trim(), 10);
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                }
                if (!pid || !isPidAlive(pid)) {
                    await this._unlinkSilent(pidPath);
                    return { exitCode: null, signal: null };
                }
                return this._signalAndWait(pid, chainId);
            }

            handle.manualStop = true;
            const result = await this._signalAndWait(handle.meta.pid, chainId);
            this.handles.delete(chainId);
            await this._unlinkSilent(pidPath);
            await this._unlinkSilent(metaFilePath(chainId));
            return result;
        });
    }

    /**
     * Restart = stop then start. Locked atomically — no other action can race.
     *
     * @param {string} chainId
     * @param {object} chainConfig
     * @returns {Promise<{ pid: number, startedAt: number }>}
     */
    restart(chainId, chainConfig) {
        return withChainLock(chainId, async () => {
            const status = this.statusSync(chainId);
            if (status.alive && status.pid) {
                if (this.handles.has(chainId)) {
                    this.handles.get(chainId).manualStop = false; // F1 may re-start; we want to count this as auto
                }
                await this._signalAndWait(status.pid, chainId);
                this.handles.delete(chainId);
                await this._unlinkSilent(pidFilePath(chainId));
                await this._unlinkSilent(metaFilePath(chainId));
            }
            return this._spawnLocked(chainId, chainConfig);
        });
    }

    /**
     * Reattach to all chains whose PID files reference live processes. Called
     * once at extension boot (via main.js 'ready' lifecycle hook in Phase 2+).
     *
     * After reattach, we know the PID is alive but we DO NOT have the child
     * handle (its stdio was inherited by the previous PC2 process). Logs must
     * come from on-disk files (Rev 9 architecture note).
     *
     * @returns {Promise<Array<{ chainId: string, pid: number }>>}
     */
    async reattach() {
        const dir = runDir();
        const files = await fsp.readdir(dir).catch(() => []);
        const reattached = [];
        for (const fname of files) {
            const m = fname.match(/^ela-([a-z0-9-]+)\.pid$/);
            if (!m) continue;
            const chainId = m[1];
            const pidPath = path.join(dir, fname);
            let pid;
            try {
                const raw = await fsp.readFile(pidPath, 'utf8');
                pid = parseInt(raw.trim(), 10);
            } catch {
                continue;
            }
            if (!Number.isInteger(pid) || pid <= 0) {
                await this._unlinkSilent(pidPath);
                await this._unlinkSilent(metaFilePath(chainId));
                continue;
            }
            // Best-effort metadata read — non-fatal if missing.
            const meta = await this._readMetaSafe(chainId);
            const expectedBinary = (meta && typeof meta.binaryPath === 'string') ? meta.binaryPath : null;
            // Cross-check against /proc/<pid>/exe so we don't reattach to a
            // recycled-PID stranger (Phase 2 audit, agent 4).
            if (!isOurProcess(pid, expectedBinary)) {
                this.extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} reattach(${chainId}): pid=${pid} did not match expected binary "${expectedBinary || '<unknown>'}" — cleaning stale state`,
                );
                await this._unlinkSilent(pidPath);
                await this._unlinkSilent(metaFilePath(chainId));
                continue;
            }
            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} reattached to running ${chainId} (pid=${pid})`,
            );
            this.emit('reattached', { chainId, pid, meta });
            reattached.push({ chainId, pid });
        }
        return reattached;
    }

    // ========================================================================
    // Private — must run inside withChainLock
    // ========================================================================

    /**
     * @private
     * @param {string} chainId
     * @param {object} chainConfig
     */
    async _spawnLocked(chainId, chainConfig) {
        if (!chainConfig || typeof chainConfig.binaryPath !== 'string') {
            throw new TypeError('NativeProcessService.start: chainConfig.binaryPath required');
        }
        const cwd = chainDir(chainId);
        const binaryPath = chainConfig.binaryPath;

        // Defence: confirm cwd has the things ela expects to read at startup.
        const configFile = path.join(cwd, 'config.json');
        if (!fs.existsSync(configFile)) {
            throw new Error(
                `NativeProcessService.start: ${configFile} missing — generate it before calling start()`,
            );
        }

        const startedAt = Date.now();
        // detached: true so the child survives if PC2 itself crashes.
        // unref() so PC2 doesn't wait for the child on its own shutdown.
        // env filtered: forward only PATH/HOME/locale (Phase 2 audit, agent 2 —
        // raw process.env could leak PC2 secrets to ela).
        const child = spawn(binaryPath, [], {
            cwd,
            env: buildSafeChildEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        });
        child.unref();

        if (!child.pid) {
            throw new Error(`NativeProcessService.start: spawn returned no PID for ${binaryPath}`);
        }

        // ela reads its keystore password from stdin per node.sh:878 (Rev 1 audit).
        // The caller (ElaMainChainAdapter) is responsible for piping the plaintext
        // password via the child stdin if BPoS arbiter mode is enabled. This
        // primitive stays chain-agnostic.

        // Persist PID + metadata for reattach across PC2 restarts. If either
        // write fails we kill the orphan rather than leak an unmanaged process
        // (Phase 2 audit, agent 4: spawn-failure rollback).
        const meta = {
            pid: child.pid,
            binaryPath,
            startedAt,
            version: chainConfig.binaryVersion || null,
        };
        try {
            await atomicWrite(pidFilePath(chainId), `${child.pid}\n`, { mode: 0o600 });
            await atomicWrite(metaFilePath(chainId), JSON.stringify(meta, null, 2), { mode: 0o600 });
        } catch (writeErr) {
            this.extensionHandle.log.error(
                `${ENM_LOG_PREFIX} ${chainId} PID/meta write failed (${writeErr.message}); killing orphan child pid=${child.pid}`,
            );
            try { process.kill(child.pid, 'SIGKILL'); } catch (_) { /* already dead */ }
            await this._unlinkSilent(pidFilePath(chainId));
            await this._unlinkSilent(metaFilePath(chainId));
            throw writeErr;
        }

        const handle = { child, meta, manualStop: false };
        this.handles.set(chainId, handle);

        // Wire up exit handler. We swallow the close event silently if it's a
        // managed stop; otherwise emit so SelfHealingEngine can fire F1.
        child.on('exit', (code, signal) => {
            const wasManual = handle.manualStop;
            this.handles.delete(chainId);
            // best-effort cleanup; don't await inside the listener
            this._unlinkSilent(pidFilePath(chainId)).catch(() => {});
            this._unlinkSilent(metaFilePath(chainId)).catch(() => {});

            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} ${chainId} exited (code=${code}, signal=${signal}, manual=${wasManual})`,
            );
            this.emit('exit', { chainId, code, signal, manualStop: wasManual });
        });
        child.on('error', (err) => {
            this.extensionHandle.log.error(`${ENM_LOG_PREFIX} ${chainId} child error: ${err.message}`);
            this.emit('child-error', { chainId, error: err });
        });

        // Bubble stdio up so the log streamer (Phase 3) can subscribe.
        if (child.stdout) {
            child.stdout.on('data', (chunk) => this.emit('stdout', { chainId, chunk }));
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => this.emit('stderr', { chainId, chunk }));
        }

        this.extensionHandle.log.info(
            `${ENM_LOG_PREFIX} ${chainId} started (pid=${child.pid}, bin=${binaryPath})`,
        );
        this.emit('started', { chainId, pid: child.pid, startedAt });

        return { pid: child.pid, startedAt };
    }

    /**
     * @private
     * Send SIGTERM, wait up to PROCESS_STOP_GRACE_MS, then SIGKILL.
     */
    async _signalAndWait(pid, chainId) {
        if (!isPidAlive(pid)) {
            return { exitCode: null, signal: null };
        }

        try {
            process.kill(pid, 'SIGTERM');
        } catch (err) {
            // ESRCH = no such process; already dead — treat as success.
            if (err.code !== 'ESRCH') {
                throw err;
            }
            return { exitCode: null, signal: 'SIGTERM' };
        }

        const start = Date.now();
        const handle = this.handles.get(chainId);

        while (Date.now() - start < PROCESS_STOP_GRACE_MS) {
            if (!isPidAlive(pid)) {
                return {
                    exitCode: handle && handle.child && handle.child.exitCode != null ? handle.child.exitCode : null,
                    signal: handle && handle.child && handle.child.signalCode ? handle.child.signalCode : 'SIGTERM',
                };
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(200);
        }

        // Grace expired — SIGKILL.
        this.extensionHandle.log.warn(
            `${ENM_LOG_PREFIX} ${chainId} did not exit within ${PROCESS_STOP_GRACE_MS}ms — sending SIGKILL`,
        );
        try {
            process.kill(pid, 'SIGKILL');
        } catch (err) {
            if (err.code !== 'ESRCH') throw err;
        }
        // SIGKILL is delivered immediately, but reaping is a separate beat.
        await sleep(100);
        return { exitCode: null, signal: 'SIGKILL', killed: true };
    }

    /** @private */
    async _readMetaSafe(chainId) {
        try {
            const raw = await fsp.readFile(metaFilePath(chainId), 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /** @private */
    async _unlinkSilent(p) {
        try {
            await fsp.unlink(p);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.extensionHandle.log.debug(`${ENM_LOG_PREFIX} unlink ${p} failed: ${err.message}`);
            }
        }
    }
}

module.exports = {
    NativeProcessService,
    // Re-export for backward compatibility — callers may have already imported
    // isPidAlive from this module.
    isPidAlive,
};
