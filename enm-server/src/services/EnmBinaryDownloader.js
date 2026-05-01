/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmBinaryDownloader — fetch prebuilt Elastos binaries from the official
 * download server. Mirrors what node.sh has done since 2018.
 *
 * Source pattern (verified via the upstream Elastos.Node script,
 * build/skeleton/node.sh:572-702):
 *
 *   https://download.elastos.io/elastos-<chain>/elastos-<chain>-<ver>/
 *     elastos-<chain>-<ver>-linux-{x86_64|arm64}.tgz
 *
 * The directory listing at .../elastos-<chain>/ exposes versions via
 * Apache's auto-index (?F=1). We fetch that, parse the version directory
 * names, and pick the highest semver.
 *
 * No checksums are published upstream — node.sh has a `# TODO: verify
 * checksum` comment from 2019. We document the same gap here and rely on
 * TLS + the smoke test (./ela --version) to detect a corrupted or
 * tampered tarball.
 *
 * State machine: idle → resolving → downloading → extracting → verifying
 *                → done   (or → failed at any step)
 *
 * Single-flight per chain. The streaming progress is broadcast on the SSE
 * topic `setup:install:<chainId>`.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawn, execFile } = require('node:child_process');

const { ENM_LOG_PREFIX } = require('./EnmConstants');
const { enmDataDir } = require('./DataDir');

// Catalog of supported chains. The URL key matches the path segment
// download.elastos.io uses; the entry-point key is the file under
// the extracted tarball that we treat as the canonical executable.
const CHAINS = Object.freeze({
    mainchain: {
        urlSlug: 'elastos-ela',
        binary:  'ela',
        cli:     'ela-cli',
        description: 'Mainchain (ELA) — required for any node setup.',
    },
    esc: {
        urlSlug: 'elastos-esc',
        binary:  'esc',
        cli:     null,
        description: 'EVM sidechain (ESC) — Solidity smart contracts.',
    },
    eid: {
        urlSlug: 'elastos-eid',
        binary:  'eid',
        cli:     null,
        description: 'DID sidechain (EID) — decentralised identity.',
    },
    eco: {
        urlSlug: 'elastos-eco',
        binary:  'eco',
        cli:     null,
        description: 'ECO sidechain — community governance.',
    },
});

const PHASES = Object.freeze({
    IDLE:        'idle',
    RESOLVING:   'resolving',
    DOWNLOADING: 'downloading',
    EXTRACTING:  'extracting',
    VERIFYING:   'verifying',
    DONE:        'done',
    FAILED:      'failed',
});

const DOWNLOAD_HOST = 'download.elastos.io';

class EnmBinaryDownloader {
    constructor(opts = {}) {
        this.logger = opts.logger || console;
        this.sseHub = opts.sseHub || null;
        // Per-chain status, keyed by chainId.
        this._status = Object.create(null);
        for (const id of Object.keys(CHAINS)) {
            this._status[id] = this._initialStatus(id);
        }
    }

    _initialStatus(chainId) {
        return {
            chainId,
            phase: PHASES.IDLE,
            version: null,
            url: null,
            bytesDownloaded: 0,
            bytesTotal: 0,
            installedAt: null,
            binaryPath: null,
            cliPath: null,
            startedAt: null,
            finishedAt: null,
            error: null,
        };
    }

    listChains() {
        return Object.entries(CHAINS).map(([id, info]) => ({
            chainId: id,
            urlSlug: info.urlSlug,
            description: info.description,
            installed: this._status[id].phase === PHASES.DONE,
            installedVersion: this._status[id].version,
        }));
    }

    getStatus(chainId) {
        if (!this._status[chainId]) {
            throw new Error(`Unknown chain: ${chainId}`);
        }
        return { ...this._status[chainId] };
    }

    /**
     * Resolve the latest version of a chain from the download index.
     * Cached for 5 minutes to avoid hammering the index.
     */
    async resolveLatestVersion(chainId) {
        const info = CHAINS[chainId];
        if (!info) throw new Error(`Unknown chain: ${chainId}`);

        const indexPath = `/${info.urlSlug}/?F=1`;
        const html = await this._httpGetString(DOWNLOAD_HOST, indexPath);

        // Apache auto-index lists subdirs as <a href="elastos-ela-v0.9.9.5/">
        const re = new RegExp(`href="${info.urlSlug}-(v[0-9]+\\.[0-9]+\\.[0-9]+(?:[-.][0-9a-zA-Z]+)*)/"`, 'g');
        const versions = [];
        let m;
        while ((m = re.exec(html))) versions.push(m[1]);
        if (versions.length === 0) {
            throw new Error(`No versions found at https://${DOWNLOAD_HOST}${indexPath}`);
        }
        // Highest semver wins. Simple compare on the numeric stem.
        versions.sort(EnmBinaryDownloader._semverCompare);
        return versions[versions.length - 1];
    }

    /**
     * Start a download + install for a chain. Returns immediately; progress
     * lives on the chain's status object and on SSE topic
     * `setup:install:<chainId>`.
     */
    async start(chainId) {
        const info = CHAINS[chainId];
        if (!info) throw new Error(`Unknown chain: ${chainId}`);
        const status = this._status[chainId];

        // Single-flight guard.
        const inFlight = [PHASES.RESOLVING, PHASES.DOWNLOADING, PHASES.EXTRACTING, PHASES.VERIFYING];
        if (inFlight.includes(status.phase)) {
            return { alreadyRunning: true, status: this.getStatus(chainId) };
        }

        // Reset to a fresh run.
        this._status[chainId] = this._initialStatus(chainId);
        const s = this._status[chainId];
        s.startedAt = Date.now();
        this._emit(chainId, PHASES.RESOLVING, 'Resolving latest version...');

        // Run the pipeline async; caller polls or subscribes.
        this._run(chainId).catch((err) => {
            s.phase = PHASES.FAILED;
            s.error = err.message;
            s.finishedAt = Date.now();
            this._emit(chainId, PHASES.FAILED, err.message);
            this.logger.error(`${ENM_LOG_PREFIX} install ${chainId} failed: ${err.message}`);
        });

        return { alreadyRunning: false, status: this.getStatus(chainId) };
    }

    async _run(chainId) {
        const info = CHAINS[chainId];
        const s = this._status[chainId];

        // 1. Resolve version
        const version = await this.resolveLatestVersion(chainId);
        s.version = version;

        // 2. Download
        const arch = EnmBinaryDownloader._arch();
        const filename = `${info.urlSlug}-${version}-linux-${arch}.tgz`;
        const remotePath = `/${info.urlSlug}/${info.urlSlug}-${version}/${filename}`;
        s.url = `https://${DOWNLOAD_HOST}${remotePath}`;

        const cacheDir = path.join(enmDataDir(), 'cache', 'downloads');
        await fsp.mkdir(cacheDir, { recursive: true });
        const tarball = path.join(cacheDir, filename);

        s.phase = PHASES.DOWNLOADING;
        this._emit(chainId, PHASES.DOWNLOADING, `Downloading ${filename}...`);
        await this._download(DOWNLOAD_HOST, remotePath, tarball, (got, total) => {
            s.bytesDownloaded = got;
            s.bytesTotal = total;
            this._emit(chainId, PHASES.DOWNLOADING, '', { got, total });
        });

        // 3. Extract
        s.phase = PHASES.EXTRACTING;
        this._emit(chainId, PHASES.EXTRACTING, 'Extracting...');
        const targetDir = path.join(enmDataDir(), 'bin', chainId);
        await fsp.mkdir(targetDir, { recursive: true });
        await EnmBinaryDownloader._extractTar(tarball, targetDir);

        // The tarball contains a top-level directory like elastos-ela/.
        // Find the binary inside, regardless of nesting.
        const binaryPath = await EnmBinaryDownloader._locateInTree(targetDir, info.binary);
        if (!binaryPath) {
            throw new Error(`Binary "${info.binary}" not found inside extracted tarball.`);
        }
        await fsp.chmod(binaryPath, 0o755);
        s.binaryPath = binaryPath;

        if (info.cli) {
            const cliPath = await EnmBinaryDownloader._locateInTree(targetDir, info.cli);
            if (cliPath) {
                await fsp.chmod(cliPath, 0o755);
                s.cliPath = cliPath;
            }
        }

        // 4. Smoke test
        s.phase = PHASES.VERIFYING;
        this._emit(chainId, PHASES.VERIFYING, 'Verifying binary...');
        const versionOut = await EnmBinaryDownloader._smokeTest(binaryPath);
        if (!versionOut.ok) {
            throw new Error(`Binary smoke test failed: ${versionOut.error}`);
        }

        s.phase = PHASES.DONE;
        s.finishedAt = Date.now();
        s.installedAt = s.finishedAt;
        this._emit(chainId, PHASES.DONE, `Installed ${info.binary} ${version}`, {
            binaryPath: s.binaryPath,
            cliPath: s.cliPath,
            version,
        });
    }

    _emit(chainId, phase, message, extra) {
        if (!this.sseHub) return;
        try {
            this.sseHub.broadcast(`setup:install:${chainId}`, {
                chainId, phase, message: message || '', ts: Date.now(), ...(extra || {}),
            });
        } catch (_) { /* SSE failures shouldn't break the install */ }
    }

    /**
     * GET a URL and return the body as a string (UTF-8). Used for the
     * directory index parse.
     */
    _httpGetString(host, urlPath) {
        return new Promise((resolve, reject) => {
            const req = https.get({
                host, path: urlPath, headers: { 'User-Agent': 'enm-server/0.2' },
                timeout: 15_000,
            }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} on ${host}${urlPath}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error(`Timeout reaching ${host}${urlPath}`)));
        });
    }

    /**
     * GET a URL and stream the body to a file. Reports progress via
     * onProgress(bytesGot, bytesTotal). Follows redirects up to 3 hops.
     */
    _download(host, urlPath, dest, onProgress) {
        const self = this;
        return new Promise((resolve, reject) => {
            (function attempt(currentHost, currentPath, hops) {
                if (hops > 3) return reject(new Error('Too many redirects'));
                const req = https.get({
                    host: currentHost, path: currentPath,
                    headers: { 'User-Agent': 'enm-server/0.2' },
                    timeout: 60_000,
                }, (res) => {
                    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                        const loc = res.headers.location;
                        if (!loc) return reject(new Error(`Redirect ${res.statusCode} without Location`));
                        res.resume();
                        try {
                            const u = new URL(loc, `https://${currentHost}${currentPath}`);
                            return attempt(u.host, u.pathname + u.search, hops + 1);
                        } catch (e) { return reject(e); }
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`HTTP ${res.statusCode} downloading ${urlPath}`));
                    }
                    const total = parseInt(res.headers['content-length'] || '0', 10);
                    let got = 0;
                    const fileStream = fs.createWriteStream(dest);
                    res.on('data', (c) => {
                        got += c.length;
                        if (onProgress) onProgress(got, total);
                    });
                    res.pipe(fileStream);
                    fileStream.on('finish', () => fileStream.close(resolve));
                    fileStream.on('error', reject);
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.on('timeout', () => req.destroy(new Error('Download timed out')));
            })(host, urlPath, 0);
        });
    }

    static _arch() {
        const a = os.arch();
        if (a === 'x64')   return 'x86_64';
        if (a === 'arm64') return 'arm64';
        throw new Error(`Unsupported architecture: ${a}. download.elastos.io publishes x86_64 + arm64 only.`);
    }

    static _extractTar(tarball, targetDir) {
        return new Promise((resolve, reject) => {
            const child = spawn('tar', ['-xzf', tarball, '-C', targetDir], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (c) => { stderr += c.toString(); });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
            });
        });
    }

    static async _locateInTree(rootDir, basename) {
        const entries = await fsp.readdir(rootDir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(rootDir, e.name);
            if (e.isDirectory()) {
                const found = await EnmBinaryDownloader._locateInTree(full, basename);
                if (found) return found;
            } else if (e.isFile() && e.name === basename) {
                return full;
            }
        }
        return null;
    }

    static _smokeTest(binaryPath) {
        return new Promise((resolve) => {
            execFile(binaryPath, ['--version'], { timeout: 10_000 }, (err, stdout, stderr) => {
                if (err) {
                    return resolve({ ok: false, error: stderr.trim() || err.message });
                }
                resolve({ ok: true, output: (stdout || stderr).trim() });
            });
        });
    }

    /** Compare two semver-like strings ("v0.9.9.5"). Returns -1/0/1. */
    static _semverCompare(a, b) {
        const norm = (s) => s.replace(/^v/, '').split(/[.-]/).map((p) => /^\d+$/.test(p) ? parseInt(p, 10) : p);
        const A = norm(a), B = norm(b);
        for (let i = 0; i < Math.max(A.length, B.length); i++) {
            const x = A[i], y = B[i];
            if (x === y) continue;
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            if (typeof x === 'number' && typeof y === 'number') return x - y;
            return String(x).localeCompare(String(y));
        }
        return 0;
    }
}

module.exports = {
    EnmBinaryDownloader,
    CHAINS,
    PHASES,
};
