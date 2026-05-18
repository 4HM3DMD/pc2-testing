/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * NodeJsRuntime — Wave M4.3 (beta.0.3.3) — locate or install the
 * Node.js v23.10.0 interpreter the Class C Oracles need.
 *
 * Plan §12 Q1 recommended bundling (+50MB) but the bundle path is a
 * release-engineering concern — for the runtime side we ship two
 * resolution paths:
 *
 *   1. detectOnHost()  — search PATH + standard install locations for
 *      a node binary >= v23.10.0. Returns the absolute path + reported
 *      version, or null if nothing usable was found.
 *
 *   2. installLocal()  — download the official prebuilt tarball from
 *      nodejs.org/dist/<version>/node-<version>-linux-<arch>.tar.gz,
 *      extract to chains/_runtime/node-<version>/, return the resolved
 *      `bin/node` path. Idempotent (skip if already installed).
 *
 * NODE.SH PARITY (plan §17 Class C row + node.sh:nodejs_setenv)
 *
 * node.sh's nodejs_setenv (line 520) hardcodes v23.10.0 and downloads
 * from nodejs.org. ENM mirrors the download but installs under our
 * data dir (not /usr/local) so we don't need sudo. The version string
 * is the same single source of truth — operators with a host node 23.x
 * just have it auto-detected; everyone else gets the local install on
 * first oracle setup.
 *
 * Why not just `npm install` an SDK? The oracle scripts are
 * standalone Node binaries with their own dependency vendoring; they
 * just need an interpreter. No package manager / project layout.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { execFile } = require('node:child_process');

const { enmDataDir } = require('./DataDir');

// PINNED_VERSION is what installLocal() downloads as a LAST RESORT
// when the host doesn't have any usable Node.js. Matches node.sh:520
// for parity but is no longer the floor: any v18+ runtime works.
const PINNED_VERSION = 'v23.10.0';

// beta.0.4.1 (operator directive) — lowered MIN_MAJOR from 23 → 18.
// The oracle scripts use web3 + express + standard fs/net APIs that
// have wide Node.js compatibility. v18 is the same floor PC2 itself
// requires (enm-server/package.json engines: ">=20.18.0"), so any
// host running ENM already has a usable Node.js — no separate
// download needed in 99% of cases.
//
// resolveAny() now prefers HOST detection over LOCAL install so we
// reuse whatever Node.js PC2 brought to the host. installLocal stays
// as the last-resort fallback for stripped-down containers that
// somehow lack any usable Node.js.
const MIN_MAJOR = 18;

// Standard search paths for detectOnHost. PATH is searched first via
// `which node` (cheaper + canonical); these fall-back paths cover the
// "nvm install but not yet activated" case.
const HOST_SEARCH_PATHS = [
    '/usr/bin/node',
    '/usr/local/bin/node',
    '/opt/node/bin/node',
    path.join(os.homedir(), '.local/bin/node'),
    path.join(os.homedir(), '.nvm/versions/node/' + PINNED_VERSION + '/bin/node'),
];

// Where installLocal puts the runtime. _runtime/ is intentionally an
// underscore-prefixed sibling of chains/ so the chainId regex can't
// match it (defence against a malicious cfg.chains.*_runtime entry).
function runtimeRoot() {
    return path.join(enmDataDir(), '_runtime');
}

function archSuffix() {
    const a = os.arch();
    if (a === 'x64')   { return 'x64'; }
    if (a === 'arm64') { return 'arm64'; }
    if (a === 'arm')   { return 'armv7l'; }
    throw new Error(`NodeJsRuntime: unsupported arch ${a} (need x64/arm64/armv7l)`);
}

function platformSuffix() {
    const p = os.platform();
    if (p === 'linux')  { return 'linux'; }
    if (p === 'darwin') { return 'darwin'; }
    throw new Error(`NodeJsRuntime: unsupported platform ${p} (need linux/darwin)`);
}

/**
 * Build the canonical download URL for a given version.
 *
 * @param {string} version  e.g. 'v23.10.0'
 * @returns {string}
 */
function downloadUrl(version) {
    const v = String(version || PINNED_VERSION);
    return `https://nodejs.org/dist/${v}/node-${v}-${platformSuffix()}-${archSuffix()}.tar.gz`;
}

/**
 * Parse a `node --version` output line into a { major, minor, patch }
 * object. Returns null on parse failure (gracefully degrade vs throw
 * so the caller can swallow with "not usable").
 *
 * @param {string} stdout
 * @returns {{ major: number, minor: number, patch: number, raw: string }|null}
 */
function parseVersion(stdout) {
    const s = String(stdout || '').trim();
    const m = s.match(/^v(\d+)\.(\d+)\.(\d+)/);
    if (!m) { return null; }
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        raw: s,
    };
}

/**
 * Run `<bin> --version` with a short timeout. Returns parsed version
 * or null on any failure.
 *
 * @param {string} binPath
 * @returns {Promise<{major,minor,patch,raw}|null>}
 */
function probeVersion(binPath) {
    return new Promise((resolve) => {
        execFile(binPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
            if (err) { return resolve(null); }
            resolve(parseVersion(stdout));
        });
    });
}

/**
 * Find a usable node binary on the host. First tries `which node`
 * (which honours PATH); then falls back to HOST_SEARCH_PATHS. Returns
 * the first binary whose --version reports major >= MIN_MAJOR.
 *
 * @returns {Promise<{ path: string, version: {major,minor,patch,raw} } | null>}
 */
async function detectOnHost() {
    // 1. PATH lookup via `which`.
    const whichResult = await new Promise((resolve) => {
        execFile('which', ['node'], { timeout: 3000 }, (err, stdout) => {
            if (err) { return resolve(null); }
            const p = String(stdout || '').trim();
            resolve(p || null);
        });
    });
    if (whichResult) {
        const v = await probeVersion(whichResult);
        if (v && v.major >= MIN_MAJOR) {
            return { path: whichResult, version: v };
        }
    }
    // 2. Standard install locations.
    for (const candidate of HOST_SEARCH_PATHS) {
        if (!fs.existsSync(candidate)) { continue; }
        const v = await probeVersion(candidate);
        if (v && v.major >= MIN_MAJOR) {
            return { path: candidate, version: v };
        }
    }
    return null;
}

/**
 * Resolve the locally-installed runtime path. Returns the path if a
 * prior installLocal() finished successfully + the binary is still
 * present + still reports a usable version. null otherwise.
 *
 * @param {string} [version=PINNED_VERSION]
 * @returns {Promise<{ path: string, version: {major,minor,patch,raw} } | null>}
 */
async function detectLocal(version) {
    const v = version || PINNED_VERSION;
    const expectedDir = path.join(
        runtimeRoot(),
        `node-${v}-${platformSuffix()}-${archSuffix()}`,
    );
    const bin = path.join(expectedDir, 'bin', 'node');
    if (!fs.existsSync(bin)) { return null; }
    const probed = await probeVersion(bin);
    if (probed && probed.major >= MIN_MAJOR) {
        return { path: bin, version: probed };
    }
    return null;
}

/**
 * Combined resolver. beta.0.4.1 (operator directive) — flipped to
 * prefer HOST detection over LOCAL install. Rationale: PC2 itself
 * requires Node v20+ (enm-server/package.json engines), so the host
 * is guaranteed to have a usable runtime in normal deployments. No
 * point downloading our own +50MB tarball when there's already a
 * perfectly good interpreter on PATH.
 *
 * Order of preference:
 *   1. detectOnHost — whatever PC2 already uses (zero extra disk)
 *   2. detectLocal  — a previous installLocal call's result
 *   3. null         — caller (OracleAdapter.start) refuses to spawn
 *
 * The installLocal endpoint is still useful for stripped-down
 * containers that lack Node.js entirely, but the common case never
 * needs it.
 *
 * @returns {Promise<{ path: string, version: object, source: 'local'|'host' } | null>}
 */
async function resolveAny() {
    const host = await detectOnHost();
    if (host) { return { ...host, source: 'host' }; }
    const local = await detectLocal(PINNED_VERSION);
    if (local) { return { ...local, source: 'local' }; }
    return null;
}

/**
 * Download the official nodejs.org prebuilt tarball + extract it
 * under runtimeRoot(). Returns the resolved bin path.
 *
 * Idempotent — if the target already exists + works, returns it
 * without re-downloading.
 *
 * The tarball is fetched over HTTPS (the official endpoint signs +
 * CDN-distributes; we trust TLS + the smoke test). No checksum here
 * because nodejs.org's SHASUMS256.txt is published alongside but
 * unsigned; verifying just the SHA256 doesn't add tamper resistance
 * over TLS. A future M-task can integrate the Node.js Foundation
 * GPG signatures if needed.
 *
 * @param {object} [opts]
 * @param {string} [opts.version=PINNED_VERSION]
 * @param {(msg:string) => void} [opts.onProgress]
 * @returns {Promise<{ path: string, version: object }>}
 */
async function installLocal(opts) {
    const o = opts || {};
    const version = o.version || PINNED_VERSION;
    const onProgress = o.onProgress || (() => {});

    // Idempotent check.
    const existing = await detectLocal(version);
    if (existing) {
        onProgress('Already installed.');
        return existing;
    }

    await fsp.mkdir(runtimeRoot(), { recursive: true, mode: 0o755 });
    const url = downloadUrl(version);
    const tarballName = path.basename(url);
    const tarballPath = path.join(runtimeRoot(), tarballName);

    onProgress('Downloading ' + url);
    await downloadFile(url, tarballPath);
    onProgress('Extracting ' + tarballName);
    await extractTarball(tarballPath, runtimeRoot());
    // Clean up the tarball — saves disk for what's already extracted.
    try { await fsp.unlink(tarballPath); } catch (_) { /* best-effort */ }

    const detected = await detectLocal(version);
    if (!detected) {
        throw new Error(
            'NodeJsRuntime.installLocal: extracted but no usable node binary found. '
            + 'Check ' + runtimeRoot() + ' for unexpected layout.',
        );
    }
    onProgress('Installed ' + detected.version.raw + ' at ' + detected.path);
    return detected;
}

/** @private — HTTPS GET with redirect support, stream to disk. */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        function get(u, redirectsLeft) {
            const req = https.get(u, (res) => {
                // Follow 30x redirects.
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) {
                        return reject(new Error('Too many redirects'));
                    }
                    return get(res.headers.location, redirectsLeft - 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error('HTTP ' + res.statusCode + ' from ' + u));
                }
                const out = fs.createWriteStream(destPath, { mode: 0o644 });
                res.pipe(out);
                out.on('finish', () => { out.close(resolve); });
                out.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(120_000, () => {
                req.destroy(new Error('Download timeout after 120s'));
            });
        }
        get(url, 5);
    });
}

/** @private — extract via `tar -xzf`. */
function extractTarball(tarPath, destDir) {
    return new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', tarPath, '-C', destDir], { timeout: 120_000 }, (err) => {
            if (err) { return reject(err); }
            resolve();
        });
    });
}

module.exports = {
    PINNED_VERSION,
    MIN_MAJOR,
    detectOnHost,
    detectLocal,
    resolveAny,
    installLocal,
    // exported for tests
    _internal: { parseVersion, probeVersion, downloadUrl, runtimeRoot, archSuffix, platformSuffix },
};
