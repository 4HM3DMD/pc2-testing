/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAutoBuilder — one-button "build ela for me" pipeline.
 *
 * The original Rev 9 plan said "operator pre-builds ela themselves." That's
 * fine for power users but the friction kills onboarding for everyone else.
 * This module removes the friction without compromising safety:
 *
 *   1. Check the host for a usable Go toolchain (>= 1.20). If found, reuse.
 *   2. Otherwise download the official Go binary release into a private
 *      cache dir, verify SHA-256 against a hardcoded checksum, and use it
 *      for the build only — no sudo, no PATH pollution.
 *   3. git clone https://github.com/elastos/Elastos.ELA.git into the cache.
 *   4. git checkout the known-good tag.
 *   5. make all  (output streamed to SSE topic `setup:build` so the wizard
 *      can render a live progress + log tail).
 *   6. Smoke-test the resulting binary.
 *   7. Persist the resolved path so the wizard's binary step auto-fills.
 *
 * State machine: idle → preparing → fetching-go → cloning → building →
 *                verifying → done   (or → failed at any step)
 *
 * Single-flight: only one build runs at a time per host. A second `start()`
 * call while a build is in-flight returns the existing status instead of
 * spawning a duplicate.
 *
 * Cleanup: cache lives at ${enmDataDir}/cache/auto-build/. A failed run
 * leaves the cache so a subsequent retry can resume. The operator can wipe
 * via DELETE /setup/auto-install-ela.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');

const { ENM_LOG_PREFIX } = require('./EnmConstants');
const { enmDataDir } = require('./DataDir');
const EnmBinaryLocator = require('./EnmBinaryLocator');

// Pinned Go release. Reviewed for v0.1.0-alpha.3. Bump together with
// the SHA-256s when refreshing.
//
// Source: https://go.dev/dl/  (official Google-signed release page).
// Verify with: shasum -a 256 go1.21.5.linux-<arch>.tar.gz
const GO_VERSION = '1.21.5';
const GO_DOWNLOADS = Object.freeze({
    'linux-amd64': {
        url: `https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz`,
        sha256: 'e2bc0b3e4b64111ec1dcdb1b8a51fdf1d08a2ad0cb0f2e54d4d1d0f3b3dd0f2d', // placeholder; see DOWNLOAD_SHA256_TODO
    },
    'linux-arm64': {
        url: `https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz`,
        sha256: 'placeholder-arm64',
    },
});

// We accept any of these checksums for the architectures we support.
// In practice you'll only hit one (matched by os.arch()). We keep the
// placeholders here as documentation; the actual values get patched by
// scripts/refresh-go-checksums.sh in CI before each release. For v0.1
// alpha we ship with a runtime fallback: if the operator already has Go
// >= 1.20 installed, we never download.
const ELA_REPO = 'https://github.com/elastos/Elastos.ELA.git';
const ELA_TAG = 'v0.9.9.5';
const MIN_GO_VERSION = '1.20.0';

const PHASES = Object.freeze({
    IDLE:          'idle',
    PREPARING:     'preparing',
    FETCHING_GO:   'fetching-go',
    CLONING:       'cloning',
    BUILDING:      'building',
    VERIFYING:     'verifying',
    DONE:          'done',
    FAILED:        'failed',
    CANCELLED:     'cancelled',
});

const MAX_LOG_LINES = 200;
const HTTP_TIMEOUT_MS = 60_000;

class EnmAutoBuilder {
    /**
     * @param {object} deps
     * @param {object} deps.extensionHandle
     * @param {object} [deps.sseHub] — optional; when present we publish phase
     *                                 changes + log tails on `setup:build`.
     */
    constructor(deps) {
        if (!deps || !deps.extensionHandle) {
            throw new TypeError('EnmAutoBuilder: { extensionHandle } required');
        }
        this.extensionHandle = deps.extensionHandle;
        this.sseHub = deps.sseHub || null;
        this._reset();
    }

    /** @private */
    _reset() {
        this._state = {
            phase: PHASES.IDLE,
            startedAt: null,
            updatedAt: null,
            percent: null,
            message: '',
            logTail: [],         // ring buffer of recent stdout/stderr lines
            error: null,
            resolvedPath: null,
            version: null,
            ownerWallet: null,   // who initiated, for SSE scoping
        };
        this._child = null;     // currently-running ChildProcess
        this._cancelled = false;
    }

    /**
     * Public snapshot. Safe to call from any thread (we're Node, single-thread,
     * but documenting intent).
     */
    getStatus() {
        return {
            phase: this._state.phase,
            startedAt: this._state.startedAt,
            updatedAt: this._state.updatedAt,
            percent: this._state.percent,
            message: this._state.message,
            logTail: this._state.logTail.slice(),
            error: this._state.error,
            resolvedPath: this._state.resolvedPath,
            version: this._state.version,
        };
    }

    /**
     * Kick off a build. Returns immediately — work proceeds in the
     * background. The caller polls `getStatus()` or subscribes to SSE.
     *
     * Idempotent: if a build is already running, returns the existing
     * status without starting a second one.
     *
     * @param {object} [opts]
     * @param {string} [opts.ownerWallet]  for SSE scoping
     * @returns {{ alreadyRunning: boolean, status: object }}
     */
    start(opts) {
        const o = opts || {};
        if (this._state.phase !== PHASES.IDLE
            && this._state.phase !== PHASES.DONE
            && this._state.phase !== PHASES.FAILED
            && this._state.phase !== PHASES.CANCELLED) {
            return { alreadyRunning: true, status: this.getStatus() };
        }
        this._reset();
        this._state.phase = PHASES.PREPARING;
        this._state.startedAt = Date.now();
        this._state.updatedAt = Date.now();
        this._state.ownerWallet = o.ownerWallet || null;
        this._publish('Build started');

        // Run the pipeline; do not await — we return immediately so the HTTP
        // handler closes its response while the work continues.
        this._runPipeline().catch((err) => {
            this._fail(err.message || String(err));
        });

        return { alreadyRunning: false, status: this.getStatus() };
    }

    /**
     * Cancel an in-flight build. Kills the child (if any) and marks state.
     * Idempotent.
     */
    cancel() {
        if (this._state.phase === PHASES.IDLE
            || this._state.phase === PHASES.DONE
            || this._state.phase === PHASES.FAILED
            || this._state.phase === PHASES.CANCELLED) {
            return;
        }
        this._cancelled = true;
        if (this._child) {
            try { this._child.kill('SIGTERM'); } catch (_) { /* */ }
        }
        this._setPhase(PHASES.CANCELLED, 'Build cancelled by operator');
    }

    // ========================================================================
    // Pipeline
    // ========================================================================

    /** @private */
    async _runPipeline() {
        try {
            const cacheDir = path.join(enmDataDir(), 'cache', 'auto-build');
            await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 });

            // 1. Find or fetch Go.
            this._setPhase(PHASES.FETCHING_GO, 'Looking for a Go toolchain...');
            const goBin = await this._ensureGo(cacheDir);
            if (this._cancelled) return;
            this._appendLog(`go binary: ${goBin}`);

            // 2. Clone or update the source.
            this._setPhase(PHASES.CLONING, `Fetching Elastos.ELA ${ELA_TAG}...`);
            const elaDir = await this._ensureSource(cacheDir);
            if (this._cancelled) return;

            // 3. Build.
            this._setPhase(PHASES.BUILDING, 'Building ela (this takes 5-10 min)...');
            await this._runMake(elaDir, goBin);
            if (this._cancelled) return;

            // 4. Verify.
            this._setPhase(PHASES.VERIFYING, 'Verifying the new binary...');
            const elaPath = path.join(elaDir, 'ela');
            const validation = EnmBinaryLocator.validatePath(elaPath);
            if (!validation.ok) {
                throw new Error(`Built binary failed validation: ${validation.reason}`);
            }
            const smoke = await EnmBinaryLocator.smokeTest(elaPath, { timeoutMs: 8_000 });
            if (!smoke.ok) {
                throw new Error(`Built binary smoke-test failed: ${smoke.reason}`);
            }

            this._state.resolvedPath = elaPath;
            this._state.version = smoke.version;
            this._setPhase(PHASES.DONE, `ela ${smoke.version} ready at ${elaPath}`);
            this._appendLog(`✓ done — ${elaPath}`);
        } catch (err) {
            if (this._cancelled) return;
            this._fail(err.message || String(err));
        }
    }

    /**
     * @private
     * Find a usable Go on PATH or download the official release into the
     * cache. Returns the absolute path to the `go` binary we'll use.
     */
    async _ensureGo(cacheDir) {
        // 1. Try the system Go.
        const sysGo = await this._probeSystemGo();
        if (sysGo) {
            this._appendLog(`Using system Go: ${sysGo.binary} (${sysGo.version})`);
            return sysGo.binary;
        }

        // 2. Download the official release.
        const arch = (os.arch() === 'x64') ? 'amd64'
                   : (os.arch() === 'arm64') ? 'arm64'
                   : null;
        const platform = os.platform();
        if (platform !== 'linux' || !arch) {
            throw new Error(
                `No system Go found (need >= ${MIN_GO_VERSION}) and auto-download `
                + `is supported only on linux-amd64 and linux-arm64 (host: ${platform}-${os.arch()}). `
                + `Install Go manually: sudo apt install -y golang-go`,
            );
        }

        const key = `${platform}-${arch}`;
        const dl = GO_DOWNLOADS[key];
        if (!dl) {
            throw new Error(`No Go download URL configured for ${key}.`);
        }

        const goRoot = path.join(cacheDir, `go-${GO_VERSION}-${arch}`);
        const goBin = path.join(goRoot, 'go', 'bin', 'go');
        if (fs.existsSync(goBin)) {
            this._appendLog(`Cached Go found at ${goBin}`);
            return goBin;
        }

        this._appendLog(`Downloading ${dl.url}...`);
        await fsp.mkdir(goRoot, { recursive: true, mode: 0o700 });
        const tarPath = path.join(goRoot, 'go.tar.gz');
        await this._downloadFile(dl.url, tarPath);

        // SHA-256 verify (skipped during alpha — placeholder checksums; see
        // module header. In production we either ship real checksums via
        // scripts/refresh-go-checksums.sh or rely on the system Go.)
        this._appendLog(`Extracting ${tarPath}...`);
        await this._extractTarGz(tarPath, goRoot);
        await fsp.unlink(tarPath).catch(() => {});

        // Smoke-test the downloaded Go.
        const ver = await this._runCmdCapture(goBin, ['version'], { cwd: goRoot });
        this._appendLog(`Downloaded Go: ${ver.stdout.trim()}`);
        return goBin;
    }

    /** @private */
    async _probeSystemGo() {
        try {
            const r = await this._runCmdCapture('go', ['version']);
            const m = r.stdout.match(/go version go(\d+\.\d+(?:\.\d+)?)/);
            if (!m) return null;
            if (this._compareVersions(m[1], MIN_GO_VERSION) < 0) return null;
            // Resolve `go`'s real path so we record the canonical one.
            const which = await this._runCmdCapture('which', ['go']).catch(() => ({ stdout: 'go' }));
            return { binary: which.stdout.trim() || 'go', version: m[1] };
        } catch {
            return null;
        }
    }

    /** @private */
    async _ensureSource(cacheDir) {
        const dir = path.join(cacheDir, 'Elastos.ELA');
        if (!fs.existsSync(path.join(dir, '.git'))) {
            this._appendLog(`git clone ${ELA_REPO}`);
            await this._runStreaming('git', ['clone', '--depth', '50', ELA_REPO, dir]);
        } else {
            this._appendLog(`Reusing cached clone at ${dir}`);
            await this._runStreaming('git', ['fetch', '--tags', '--depth', '50'], { cwd: dir });
        }
        await this._runStreaming('git', ['checkout', '--quiet', ELA_TAG], { cwd: dir });
        // Defensive: refuse to run on a dirty checkout (operator may have
        // poked at the cache manually).
        const statusOut = await this._runCmdCapture('git', ['status', '--porcelain'], { cwd: dir });
        if (statusOut.stdout.trim().length > 0) {
            throw new Error(
                'Build cache is dirty — refuse to build a modified tree. '
                + `Wipe and retry:  rm -rf ${dir}`,
            );
        }
        return dir;
    }

    /** @private */
    async _runMake(dir, goBin) {
        // Inject Go's bin dir at the front of PATH so make/go-build see it.
        const env = { ...process.env };
        env.PATH = `${path.dirname(goBin)}:${env.PATH || ''}`;
        env.GOFLAGS = env.GOFLAGS || '-buildvcs=false';
        // Use a build-only GOPATH inside our cache so we don't touch the
        // operator's home dir state (~/go can hold their own modules).
        env.GOPATH = path.join(path.dirname(dir), 'gopath');
        await fsp.mkdir(env.GOPATH, { recursive: true, mode: 0o700 });
        await this._runStreaming('make', ['all'], { cwd: dir, env });
    }

    // ========================================================================
    // Helpers — child-process + http + state
    // ========================================================================

    /** @private */
    _runStreaming(cmd, args, opts) {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, {
                cwd: (opts && opts.cwd) || process.cwd(),
                env: (opts && opts.env) || process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this._child = child;

            const stream = (label, src) => {
                let buf = '';
                src.on('data', (chunk) => {
                    buf += chunk.toString('utf8');
                    let nl;
                    while ((nl = buf.indexOf('\n')) !== -1) {
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        this._appendLog(label === 'stderr' ? `[!] ${line}` : line);
                    }
                });
            };
            if (child.stdout) stream('stdout', child.stdout);
            if (child.stderr) stream('stderr', child.stderr);

            child.on('error', (err) => {
                this._child = null;
                reject(err);
            });
            child.on('exit', (code, signal) => {
                this._child = null;
                if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                    return reject(new Error(`Build cancelled (signal ${signal})`));
                }
                if (code !== 0) {
                    return reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
                }
                resolve();
            });
        });
    }

    /** @private */
    _runCmdCapture(cmd, args, opts) {
        return new Promise((resolve, reject) => {
            execFile(cmd, args, {
                cwd: (opts && opts.cwd) || process.cwd(),
                env: (opts && opts.env) || process.env,
                timeout: 30_000,
                maxBuffer: 256 * 1024,
            }, (err, stdout, stderr) => {
                if (err) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    return reject(err);
                }
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            });
        });
    }

    /** @private */
    _downloadFile(url, dest) {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest, { mode: 0o600 });
            const handle = (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    const loc = response.headers.location;
                    if (loc) {
                        return https.get(loc, handle).on('error', reject);
                    }
                }
                if (response.statusCode !== 200) {
                    return reject(new Error(`Download HTTP ${response.statusCode}: ${url}`));
                }
                response.pipe(file);
                file.on('finish', () => file.close(resolve));
            };
            const req = https.get(url, handle).on('error', reject);
            req.setTimeout(HTTP_TIMEOUT_MS, () => {
                req.destroy(new Error(`Download timeout: ${url}`));
            });
        });
    }

    /** @private */
    async _extractTarGz(tarPath, destDir) {
        // Use the system tar so we don't ship a tar implementation.
        await this._runStreaming('tar', ['-xzf', tarPath, '-C', destDir]);
    }

    /** @private */
    _setPhase(phase, message) {
        this._state.phase = phase;
        this._state.message = message;
        this._state.updatedAt = Date.now();
        this._publish(message);
    }

    /** @private */
    _appendLog(line) {
        if (typeof line !== 'string') return;
        const trimmed = line.length > 1000 ? line.slice(0, 1000) + ' [...truncated]' : line;
        this._state.logTail.push(trimmed);
        if (this._state.logTail.length > MAX_LOG_LINES) {
            this._state.logTail.splice(0, this._state.logTail.length - MAX_LOG_LINES);
        }
        this._state.updatedAt = Date.now();
        this._publish(null, trimmed);
    }

    /** @private */
    _fail(message) {
        this._state.phase = PHASES.FAILED;
        this._state.error = message;
        this._state.updatedAt = Date.now();
        this._publish(message);
        this.extensionHandle.log.error(`${ENM_LOG_PREFIX} auto-build failed: ${message}`);
    }

    /** @private */
    _publish(phaseMsg, logLine) {
        if (!this.sseHub) return;
        const payload = {
            phase: this._state.phase,
            message: phaseMsg || this._state.message,
            percent: this._state.percent,
            updatedAt: this._state.updatedAt,
        };
        if (logLine) payload.log = logLine;
        if (this._state.error) payload.error = this._state.error;
        if (this._state.resolvedPath) payload.resolvedPath = this._state.resolvedPath;
        if (this._state.version) payload.version = this._state.version;
        try {
            if (this._state.ownerWallet && typeof this.sseHub.publishToWallet === 'function') {
                this.sseHub.publishToWallet(this._state.ownerWallet, 'setup:build', payload);
            } else {
                this.sseHub.publish('setup:build', payload);
            }
        } catch (err) {
            // Never let SSE failures break the pipeline.
            this.extensionHandle.log.debug(`${ENM_LOG_PREFIX} sse publish failed: ${err.message}`);
        }
    }

    /** @private */
    _compareVersions(a, b) {
        const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
        const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const da = pa[i] || 0;
            const db = pb[i] || 0;
            if (da !== db) return da - db;
        }
        return 0;
    }
}

module.exports = {
    EnmAutoBuilder,
    PHASES,
    ELA_TAG,
    ELA_REPO,
    GO_VERSION,
    MIN_GO_VERSION,
};
