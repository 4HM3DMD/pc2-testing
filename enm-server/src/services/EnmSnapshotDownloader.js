/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmSnapshotDownloader — Wave v0.4.7 — fetch official Elastos chain
 * data snapshots so a freshly-installed Council node can skip the
 * multi-day initial sync and come online inside an hour.
 *
 * Why this exists: a virgin mainchain (ELA) node needs to replay
 * ~3M blocks from genesis; ESC/EID/PG behave the same way at their
 * own scale. Operators staring at 5+ days of "Card C: syncing 12%"
 * abandon the install. node.sh has shipped a snapshot-download path
 * since 2020 — we mirror it in-process so the Council install wizard
 * (Card D) can run before the binaries even start.
 *
 * UPSTREAM SOURCE
 *
 * Elastos Foundation publishes nightly snapshots at
 * https://node-data.elastos.io/<chain>/<chain>-data-latest.tgz —
 * verified 2026-05-19 via HEAD probe against each URL. Each tarball
 * extracts into the chain's data directory (the layout matches what
 * the binary writes itself when syncing from scratch).
 *
 * Snapshots are LARGE (5-15 GB compressed each). We stream them to
 * disk and unpack on-the-fly with system `tar -xzf` — the same shape
 * EnmBinaryDownloader uses to avoid pulling a new npm dependency.
 *
 * INVARIANT: ECO snapshot URLs exist at /eco/ but are forbidden per
 * the H3 ENM scope rule (ECO is OUT OF SCOPE forever). Do NOT add an
 * `eco` entry to SNAPSHOT_SOURCES — a future contributor seeing the
 * pattern might assume completeness; this comment is the load-bearing
 * gate.
 *
 * NO CHECKSUM verification today — same posture as
 * OracleScriptDownloader / EnmBinaryDownloader: TLS + a non-empty
 * extracted directory smoke test. TODO: layer Elastos Foundation
 * GPG signatures once the upstream publishes them (tracked under
 * the v0.4.x M5.1 follow-up).
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const { enmDataDir } = require('./DataDir');

// Catalog of supported chains. Each entry holds the canonical
// upstream tarball URL plus a rough operator-facing size estimate
// (used by the Card D pre-flight to warn about disk free space
// before kicking off the download).
//
// SNAPSHOT_SOURCES intentionally contains FOUR chains: mainchain,
// esc, eid, pg. ECO is omitted on purpose — see file header H3
// invariant.
const SNAPSHOT_SOURCES = Object.freeze({
    mainchain: {
        url: 'https://node-data.elastos.io/ela/ela-data-latest.tgz',
        sizeEstimateGb: 10,
    },
    esc: {
        url: 'https://node-data.elastos.io/esc/esc-data-latest.tgz',
        sizeEstimateGb: 15,
    },
    eid: {
        url: 'https://node-data.elastos.io/eid/eid-data-latest.tgz',
        sizeEstimateGb: 8,
    },
    pg: {
        url: 'https://node-data.elastos.io/pgp/pgp-data-latest.tgz',
        sizeEstimateGb: 12,
    },
});

// 30 minutes per-request. Snapshots are big; 60s (the Oracle script
// timeout) would always trip. The TCP socket-level timeout fires on
// inactivity, so a healthy 200MB/s pipe still finishes inside this
// window for the largest (ESC ~15GB) tarball.
const DOWNLOAD_TIMEOUT_MS = 1_800_000;

// Progress callback throttle. Emitting on every TCP chunk would
// flood the SSE bus + log file; 500ms matches what the Card D UI
// renders.
const PROGRESS_THROTTLE_MS = 500;

// Max redirect hops. download.elastos.io / node-data.elastos.io
// historically redirect once (HTTP→HTTPS) but we follow up to 5
// in case the CDN inserts more in front of us.
const MAX_REDIRECTS = 5;

/**
 * Resolve the staging directory where in-flight .tgz tarballs land
 * before extraction. Sibling of _oracle-scripts/ for consistency.
 *
 * @returns {string}
 */
function snapshotsDir() {
    return path.join(enmDataDir(), '_snapshots');
}

/**
 * Heuristic "is this chain already populated?" check. Used by
 * downloadAndExtract to short-circuit when the operator has either
 * (a) already run this flow, or (b) restored the data dir manually.
 *
 * True iff targetDataDir exists, is a directory, and has at least
 * one child entry. Empty dirs (just-mkdir'd by some prior step) are
 * treated as NOT applied so the snapshot still installs into them.
 *
 * Synchronous on purpose — this fires inside the install wizard
 * critical path and the syscalls are O(1) on a populated dir.
 *
 * @param {string} targetDataDir
 * @returns {boolean}
 */
function isSnapshotApplied(targetDataDir) {
    try {
        const st = fs.statSync(targetDataDir);
        if (!st.isDirectory()) return false;
        const entries = fs.readdirSync(targetDataDir);
        return entries.length > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Download one chain snapshot and unpack it into targetDataDir.
 * Idempotent: returns `{ skipped: true }` if the target already has
 * data so re-running the install wizard never clobbers a working
 * node.
 *
 * Progress callback shape:
 *   onProgress({
 *     chainId,
 *     phase:           'download' | 'extract',
 *     bytesDownloaded: number,
 *     totalBytes:      number,    // 0 if Content-Length absent
 *     percent:         number,    // 0-100, 0 during extract phase
 *   })
 *
 * @param {string} chainId   key of SNAPSHOT_SOURCES
 * @param {string} targetDataDir absolute path to e.g. /var/lib/pc2/data/chains/mainchain/data/
 * @param {object} [opts]
 * @param {(p:object) => void} [opts.onProgress]
 * @returns {Promise<{chainId:string, targetDataDir:string, bytesDownloaded:number, durationMs:number} | {skipped:true, reason:string}>}
 */
async function downloadAndExtract(chainId, targetDataDir, opts) {
    const o = opts || {};
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};

    if (isSnapshotApplied(targetDataDir)) {
        return { skipped: true, reason: 'already applied' };
    }

    const src = SNAPSHOT_SOURCES[chainId];
    if (!src) {
        throw new Error(`EnmSnapshotDownloader: unknown chainId "${chainId}"`);
    }

    await fsp.mkdir(snapshotsDir(), { recursive: true, mode: 0o755 });
    await fsp.mkdir(targetDataDir, { recursive: true, mode: 0o755 });

    const tarballPath = path.join(snapshotsDir(), `${chainId}-data-latest.tgz`);
    const startedAt = Date.now();

    let bytesDownloaded = 0;

    try {
        // --- Phase 1: stream .tgz to disk -----------------------------------
        bytesDownloaded = await streamDownload(src.url, tarballPath, (got, total) => {
            const percent = total > 0 ? Math.floor((got / total) * 100) : 0;
            onProgress({
                chainId,
                phase: 'download',
                bytesDownloaded: got,
                totalBytes: total,
                percent,
            });
        });

        // --- Phase 2: extract via system tar --------------------------------
        onProgress({
            chainId,
            phase: 'extract',
            bytesDownloaded,
            totalBytes: bytesDownloaded,
            percent: 0,
        });
        await extractTarball(tarballPath, targetDataDir);

        // --- Phase 3: verify extraction non-empty ---------------------------
        const populated = fs.readdirSync(targetDataDir);
        if (populated.length === 0) {
            throw new Error(
                `extraction left "${targetDataDir}" empty — upstream tarball may be malformed`,
            );
        }

        // Drop the staging tarball — it has done its job and would
        // chew disk space the operator needs for live chain growth.
        await fsp.rm(tarballPath, { force: true });

        return {
            chainId,
            targetDataDir,
            bytesDownloaded,
            durationMs: Date.now() - startedAt,
        };
    } catch (err) {
        // Best-effort cleanup of any partial tarball + .partial
        // sibling left by streamDownload. We deliberately do NOT
        // wipe targetDataDir — extraction may have written a few
        // files before failing, and the operator can inspect them.
        await fsp.rm(tarballPath, { force: true }).catch(() => {});
        await fsp.rm(`${tarballPath}.partial`, { force: true }).catch(() => {});
        const wrapped = new Error(
            `EnmSnapshotDownloader[${chainId}]: ${err && err.message ? err.message : String(err)}`,
        );
        if (err && err.stack) wrapped.stack = err.stack;
        throw wrapped;
    }
}

/**
 * Download every snapshot in `chainIds` concurrently. Uses
 * Promise.allSettled so one failed chain doesn't kill the others —
 * Card D surfaces the per-chain status separately.
 *
 * @param {Record<string,string>} targetDirsByChain map chainId → absolute dir
 * @param {object} [opts]
 * @param {string[]} [opts.chainIds] subset (default: all of SNAPSHOT_SOURCES)
 * @param {(p:object) => void} [opts.onProgress]
 * @returns {Promise<{results: Record<string, object>, durationMs:number}>}
 */
async function downloadAll(targetDirsByChain, opts) {
    const o = opts || {};
    const chainIds = Array.isArray(o.chainIds) && o.chainIds.length > 0
        ? o.chainIds
        : Object.keys(SNAPSHOT_SOURCES);
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};

    const startedAt = Date.now();
    const tasks = chainIds.map((cid) => {
        const target = targetDirsByChain && targetDirsByChain[cid];
        if (!target) {
            return Promise.reject(new Error(
                `EnmSnapshotDownloader.downloadAll: missing target dir for "${cid}"`,
            ));
        }
        return downloadAndExtract(cid, target, { onProgress });
    });

    const settled = await Promise.allSettled(tasks);
    const results = {};
    settled.forEach((s, i) => {
        const cid = chainIds[i];
        if (s.status === 'fulfilled') {
            results[cid] = s.value;
        } else {
            const e = s.reason;
            results[cid] = {
                error: e && e.message ? e.message : String(e),
            };
        }
    });

    return { results, durationMs: Date.now() - startedAt };
}

/**
 * @private
 * Stream-download `url` to `${destPath}.partial`, rename to
 * destPath on a clean finish. Follows HTTPS redirects up to
 * MAX_REDIRECTS hops. Reports byte progress via throttled
 * onByteProgress(got, total). Resolves with the final byte count.
 *
 * Atomic-ish: a torn-down download leaves only the .partial sibling;
 * the next attempt cleans it up before re-streaming.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {(got:number, total:number) => void} onByteProgress
 * @returns {Promise<number>}
 */
function streamDownload(url, destPath, onByteProgress) {
    const tmp = `${destPath}.partial`;
    return new Promise((resolve, reject) => {
        fs.rm(tmp, { force: true }, () => {
            let lastEmittedAt = 0;

            function attempt(currentUrl, hops) {
                if (hops > MAX_REDIRECTS) {
                    return reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`));
                }
                const req = https.get(currentUrl, {
                    headers: { 'User-Agent': 'enm-server/0.4.7-snapshot' },
                    timeout: 60_000,
                }, (res) => {
                    const status = res.statusCode || 0;
                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.resume();
                        let next;
                        try {
                            next = new URL(res.headers.location, currentUrl).toString();
                        } catch (e) {
                            return reject(new Error(`Bad redirect Location: ${res.headers.location}`));
                        }
                        return attempt(next, hops + 1);
                    }
                    if (status < 200 || status >= 300) {
                        res.resume();
                        return reject(new Error(`HTTP ${status} from ${currentUrl}`));
                    }

                    const total = parseInt(res.headers['content-length'] || '0', 10);
                    let got = 0;
                    const fileStream = fs.createWriteStream(tmp, { mode: 0o644 });

                    res.on('data', (chunk) => {
                        got += chunk.length;
                        const now = Date.now();
                        if (now - lastEmittedAt >= PROGRESS_THROTTLE_MS) {
                            lastEmittedAt = now;
                            try { onByteProgress(got, total); } catch (_) { /* swallow */ }
                        }
                    });

                    res.pipe(fileStream);

                    fileStream.on('finish', () => {
                        fileStream.close(() => {
                            // Emit a final tick at 100% so SSE consumers
                            // don't get stuck on the last throttled value.
                            try { onByteProgress(got, total || got); } catch (_) {}
                            fs.rename(tmp, destPath, (renameErr) => {
                                if (renameErr) {
                                    fs.rm(tmp, { force: true }, () => reject(renameErr));
                                    return;
                                }
                                resolve(got);
                            });
                        });
                    });
                    fileStream.on('error', (err) => {
                        fs.rm(tmp, { force: true }, () => reject(err));
                    });
                    res.on('error', (err) => {
                        fs.rm(tmp, { force: true }, () => reject(err));
                    });
                });
                req.on('error', reject);
                req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
                    req.destroy(new Error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS}ms`));
                });
            }

            attempt(url, 0);
        });
    });
}

/**
 * @private
 * Extract a .tgz tarball into targetDir using system `tar -xzf`.
 * Matches EnmBinaryDownloader._extractTar — we deliberately do NOT
 * add a JS tar package to keep enm-server's dependency surface
 * minimal; every Ubuntu/Debian we support ships GNU tar in the
 * default OS image.
 *
 * `--strip-components` is intentionally NOT used. The upstream
 * tarballs are packed at the top level with the chain data files
 * directly inside (no wrapper dir), so a plain `-xzf -C` lands
 * everything in targetDir as expected.
 *
 * @param {string} tarballPath
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
function extractTarball(tarballPath, targetDir) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'tar',
            ['-xzf', tarballPath, '-C', targetDir],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) return resolve();
            reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
        });
    });
}

module.exports = {
    SNAPSHOT_SOURCES,
    DOWNLOAD_TIMEOUT_MS,
    snapshotsDir,
    isSnapshotApplied,
    downloadAndExtract,
    downloadAll,
};
