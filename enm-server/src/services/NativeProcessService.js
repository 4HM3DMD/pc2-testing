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

const { spawn, exec } = require('node:child_process');
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
            // 0.5.154 — BUG-C7: ENOENT (no pid file) is the NORMAL "chain
            // stopped" state. Logging it fired on every HealthChecker tick for
            // every stopped chain (7 sidechains/oracles/arbiter on a council
            // node) and flooded elastos-node-manager.log — noise that buried
            // the real BUG-C6 start error during diagnosis. Stay silent on
            // ENOENT; only log genuinely unexpected read errors (permissions,
            // corrupt fs) the operator might care about.
            if (err && err.code !== 'ENOENT') {
                this.extensionHandle.log.debug(`${ENM_LOG_PREFIX} statusSync(${chainId}) read pid: ${err.message}`);
            }
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
     * beta.3.84 — Wave E — mark every currently-tracked chain handle as
     * manualStop=true, synchronously, without sending any signal. Used
     * by the /teardown route + the ENM SIGTERM handler so that when
     * pc2-node tears us down (and our child ela processes get killed
     * as a side effect of the extension's process group dying), the
     * subsequent exit events are correctly classified as `manual=true`
     * instead of `manual=false`. Without this, every deploy looked
     * like an external killer in the logs — chased as a phantom bug
     * for the entire 2026-05-18 session until Wave B forensics proved
     * silence (no real external SIGTERM source existed).
     *
     * No await, no signal — purely a metadata flip.
     *
     * @returns {string[]} chainIds marked
     */
    markAllManualStop() {
        const marked = [];
        for (const [chainId, handle] of this.handles.entries()) {
            if (handle && !handle.manualStop) {
                handle.manualStop = true;
                marked.push(chainId);
            }
        }
        if (marked.length > 0) {
            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} markAllManualStop: ${marked.length} chain(s) marked: ${marked.join(', ')}`,
            );
        }
        return marked;
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

        // Defence: confirm cwd has the things the chain expects at startup.
        //
        // 0.5.154 — BUG-C6 fix. This config.json precondition is for
        // FILE-configured chains only: ela mainchain reads config.json at
        // startup (ElaMainChainAdapter writes it), and the arbiter likewise.
        // EVM sidechains (esc/eid/pg) configure via geth CLI flags in
        // chainConfig.spawnArgs and oracles (Class C) via chainConfig.spawnEnv
        // — neither reads a config.json and their adapters intentionally never
        // write one. Pre-0.5.154 this unconditional check threw "config.json
        // missing" for EVERY EVM/oracle start, so the Council install's
        // start-chains step failed each sidechain (caught as non-fatal warn)
        // and the operator saw "sidechains don't work / nothing changed".
        // Require config.json ONLY when the chain is neither arg- nor
        // env-configured (i.e. a file-configured chain like mainchain).
        const usesSpawnArgs = Array.isArray(chainConfig.spawnArgs)
            && chainConfig.spawnArgs.length > 0;
        const usesSpawnEnv = chainConfig.spawnEnv
            && typeof chainConfig.spawnEnv === 'object'
            && Object.keys(chainConfig.spawnEnv).length > 0;
        const configFile = path.join(cwd, 'config.json');
        if (!usesSpawnArgs && !usesSpawnEnv && !fs.existsSync(configFile)) {
            throw new Error(
                `NativeProcessService.start: ${configFile} missing — generate it before calling start()`,
            );
        }
        // Pre-create the chain's data subtree so ela doesn't trip on a
        // missing dir on its first write. ela mkdir's its data tree
        // itself in current versions, but that wasn't always true and
        // costs us nothing to ensure.
        try {
            fs.mkdirSync(path.join(cwd, 'elastos'), { recursive: true, mode: 0o700 });
        } catch (_) { /* swallow — best-effort */ }

        const startedAt = Date.now();
        // detached: true so the child survives if PC2 itself crashes.
        // unref() so PC2 doesn't wait for the child on its own shutdown.
        // env filtered: forward only PATH/HOME/locale (Phase 2 audit, agent 2 —
        // raw process.env could leak PC2 secrets to ela).
        //
        // beta.3.95 (Wave M3.1) — chainConfig.spawnArgs support. ela
        // mainchain takes no args (configures via config.json) so the
        // pre-3.95 hardcoded `[]` was correct. EVM sidechains (geth-
        // derived: ESC/EID/PG) need CLI flags like --datadir, --rpcport,
        // --miner.etherbase, --pbft.keystore. Adapters compute the array
        // in their start() override + pass it through chainConfig.
        // Validate to keep this primitive boring: array of strings only.
        var spawnArgs = [];
        if (Array.isArray(chainConfig.spawnArgs)) {
            for (var i = 0; i < chainConfig.spawnArgs.length; i += 1) {
                var arg = chainConfig.spawnArgs[i];
                if (typeof arg !== 'string') {
                    throw new TypeError(
                        'NativeProcessService.start: spawnArgs['
                        + i + '] must be string, got ' + typeof arg,
                    );
                }
                spawnArgs.push(arg);
            }
        }
        // beta.0.3.1 (Wave M4.1) — chainConfig.spawnEnv support. Oracles
        // (Class C) need env vars like ENM_PARENT_RPC + ENM_MAINCHAIN_RPC
        // since their script reads connectivity from env, not config
        // files. The safe env baseline (PATH/HOME/locale) stays as the
        // base; spawnEnv extras layer on top with same-key precedence
        // going to the explicit spawnEnv (so adapters can override TZ,
        // NODE_OPTIONS, etc.).
        var childEnv = buildSafeChildEnv();
        if (chainConfig.spawnEnv && typeof chainConfig.spawnEnv === 'object') {
            for (const k of Object.keys(chainConfig.spawnEnv)) {
                const v = chainConfig.spawnEnv[k];
                if (typeof v !== 'string') {
                    throw new TypeError(
                        'NativeProcessService.start: spawnEnv.' + k
                        + ' must be string, got ' + typeof v,
                    );
                }
                childEnv[k] = v;
            }
        }
        const child = spawn(binaryPath, spawnArgs, {
            cwd,
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        });
        child.unref();

        if (!child.pid) {
            throw new Error(`NativeProcessService.start: spawn returned no PID for ${binaryPath}`);
        }

        // beta.3.63 — Phase 7 Layer 1: harden ela against the Linux OOM
        // killer by lowering its oom_score_adj. Default for child processes
        // is 0; range is [-1000, 1000] where -1000 = "never kill" and
        // 1000 = "kill first". -500 gives strong resistance without making
        // ela completely OOM-immune (we still want the kernel to reclaim
        // memory if ela itself goes runaway).
        //
        // Why this matters: OOM-killing ela mid-write is the #1 trigger of
        // the DPoS-state-vs-block-ledger inconsistency that locks up the
        // chain. With this score, the kernel preferentially kills almost
        // any other userspace process before reaching for ela. Best-effort
        // only — non-root can't lower below 0, so this is no-op when ENM
        // runs unprivileged. Failure is silent.
        try {
            fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, '-500');
            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} ${chainId} oom_score_adj=-500 (OOM-resistant)`,
            );
        } catch (err) {
            // Non-fatal — silent unless debug. Common on non-Linux dev hosts
            // or when ENM lacks root. ela just runs with default OOM score.
            this.extensionHandle.log.debug(
                `${ENM_LOG_PREFIX} ${chainId} could not set oom_score_adj (${err.message}); ela runs at default OOM priority`,
            );
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
            const exitedPid = child.pid;
            this.handles.delete(chainId);
            // best-effort cleanup; don't await inside the listener
            this._unlinkSilent(pidFilePath(chainId)).catch(() => {});
            this._unlinkSilent(metaFilePath(chainId)).catch(() => {});

            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} ${chainId} exited (code=${code}, signal=${signal}, manual=${wasManual})`,
            );
            this.emit('exit', { chainId, code, signal, manualStop: wasManual });

            // beta.3.81 — Wave B item ⑧ — external SIGTERM forensics.
            // When ela exits via SIGTERM but ENM didn't initiate the
            // stop (wasManual=false), something outside ENM killed the
            // process. Operators on srv832310 hit this repeatedly:
            // chain dies every 30-90min, no audit row, no clue who's
            // sending the signal. Capture a forensic snapshot to the
            // server log so the next death event leaves a trail we
            // can read offline. Fire-and-forget — must not block the
            // exit handler or impact F1's restart latency.
            if (signal === 'SIGTERM' && !wasManual) {
                this._captureSigtermForensics(chainId, exitedPid).catch((err) => {
                    this.extensionHandle.log.debug(
                        `${ENM_LOG_PREFIX} ${chainId} SIGTERM forensics failed (non-fatal): ${err.message}`,
                    );
                });
            }
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
     * Write to a running child's stdin, then close the writeable side.
     * Used by ElaMainChainAdapter to feed the keystore password to ela on
     * its first prompt (per node.sh's `cat ~/.config/elastos/ela.txt | nohup
     * ./ela` pattern, build/skeleton/node.sh:866). Without this, ela hangs
     * forever waiting for input on a detached child.
     *
     * Returns true if we wrote something, false if the child is gone or
     * its stdin is already closed (e.g. after a reattach across restarts —
     * we have the PID but not the original handle).
     *
     * @param {string} chainId
     * @param {string} text   raw text; we append a newline so ela's prompt
     *                        reader treats it as a line.
     * @returns {boolean}
     */
    writeStdin(chainId, text) {
        const handle = this.handles.get(chainId);
        if (!handle || !handle.child || !handle.child.stdin || handle.child.stdin.destroyed) {
            return false;
        }
        try {
            handle.child.stdin.write(String(text));
            if (!String(text).endsWith('\n')) {
                handle.child.stdin.write('\n');
            }
            handle.child.stdin.end();
            return true;
        } catch (err) {
            this.extensionHandle.log.warn(
                `${ENM_LOG_PREFIX} ${chainId} writeStdin failed: ${err.message}`,
            );
            return false;
        }
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

    /**
     * beta.3.81 — Wave B item ⑧ — capture forensic context when ela
     * receives an external SIGTERM (manual=false). Goal: identify the
     * killer, which has been mystery on srv832310 for weeks.
     *
     * Strategy: collect the cheapest "what was happening around the
     * moment of death" signals available. All commands are bounded
     * (`tail`, time-windowed `journalctl --since`) so the worst-case
     * data volume is ~30KB per event. Fire-and-forget; nothing on
     * the F1 / restart hot path waits for this.
     *
     * Output: a single structured log line prefixed with
     * `external-sigterm-source` that operators can grep:
     *
     *     grep -A50 'external-sigterm-source' /var/lib/pc2/data/logs/elastos-node-manager.log
     *
     * @private
     * @param {string} chainId
     * @param {number} exitedPid
     */
    async _captureSigtermForensics(chainId, exitedPid) {
        const captureStart = Date.now();
        const log = this.extensionHandle.log;
        // Best-effort shell capture with hard timeouts. exec uses /bin/sh
        // which is dash on Ubuntu — keep the commands POSIX-y.
        const runCmd = (cmd, timeoutMs) => new Promise((resolve) => {
            exec(cmd, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
                if (err && err.killed) {
                    resolve(`<timed out after ${timeoutMs}ms>`);
                    return;
                }
                if (err && err.code) {
                    resolve(`<exit ${err.code}: ${(stderr || '').slice(0, 200)}>`);
                    return;
                }
                resolve(String(stdout || '').slice(0, 8 * 1024)); // cap each at 8KB
            });
        });

        // Five forensic probes in parallel. Each is bounded; combined
        // budget is ~5s wall-clock, almost always faster.
        const [dmesgTail, journalTail, psTree, parentInfo, ppidProbe] = await Promise.all([
            // dmesg: OOM kills + kernel-side signals show up here
            runCmd('dmesg --time-format iso 2>/dev/null | tail -20', 2000),
            // journalctl: catches systemd unit activity (e.g. another unit
            // that stops the process, or pc2-node restarting)
            runCmd(`journalctl --since "20 seconds ago" --no-pager 2>/dev/null | tail -60`, 3000),
            // ps tree: see who's alive, parent relationships
            runCmd('ps -ef --forest 2>/dev/null | head -80', 2000),
            // /proc/<pid> may be gone already (process exited), but a
            // partial read is informative if we win the race
            runCmd(`cat /proc/${exitedPid}/status 2>/dev/null | head -20 || echo '<proc gone>'`, 1000),
            // The PPID at time of exit. exec is async so PPID==1 usually;
            // we capture it for the record.
            runCmd(`ls -la /proc/${exitedPid} 2>/dev/null | head -5 || echo '<proc gone>'`, 1000),
        ]);

        const elapsedMs = Date.now() - captureStart;
        // Single structured log entry, JSON-on-one-line so operators can
        // pipe to jq if they want.
        const payload = {
            tag: 'external-sigterm-source',
            chainId,
            exitedPid,
            capturedAt: new Date().toISOString(),
            captureElapsedMs: elapsedMs,
            dmesgTail: dmesgTail.split('\n').slice(-20),
            journalTail: journalTail.split('\n').slice(-30),
            psTree: psTree.split('\n').slice(-40),
            procStatus: parentInfo.split('\n').slice(-10),
            procDir: ppidProbe.split('\n').slice(-5),
        };
        log.warn(
            `${ENM_LOG_PREFIX} ${chainId} external-sigterm-source forensic snapshot: ${JSON.stringify(payload)}`,
        );
        // Emit an event so SseHub / SelfHealingEngine can surface this
        // to operators as a CRITICAL_NOTIFY if they want. Decoupled
        // from this service so we don't have to know about SseHub here.
        this.emit('external-sigterm', { chainId, exitedPid, payload });
    }
}

module.exports = {
    NativeProcessService,
    // Re-export for backward compatibility — callers may have already imported
    // isPidAlive from this module.
    isPidAlive,
};
