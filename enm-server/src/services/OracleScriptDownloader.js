/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * OracleScriptDownloader — Wave v0.4.4 — fetch the upstream oracle
 * relayer scripts (crosschain_oracle.js / crosschain_eid.js /
 * crosschain_pg.js) that Class C (Oracle) adapters spawn against.
 *
 * Why this exists: the M4.1 OracleAdapter requires cfg.chains.<id>
 * .scriptPath to point at a directory containing crosschain_<X>.js,
 * and the M4.4 install-class-c endpoint refuses to write the cfg
 * entry unless the operator supplies that path. Without an automatic
 * download path, the operator has to manually clone the Elastos
 * Github repo and tell ENM where it landed — friction the Council
 * install wizard is meant to eliminate.
 *
 * UPSTREAM SOURCE
 *
 * node.sh's oracle_init function clones the relayer scripts from
 *   https://github.com/elastos/Elastos.ELA.SideChain.ESC.Oracle (ESC)
 *   https://github.com/elastos/Elastos.ELA.SideChain.EID.Oracle (EID)
 *   https://github.com/elastos/Elastos.ELA.SideChain.PG.Oracle  (PG — closed-mirror)
 *
 * Cloning a full git repo for one file is wasteful. We fetch the raw
 * file from GitHub's `raw.githubusercontent.com` instead:
 *
 *   https://raw.githubusercontent.com/elastos/<repo>/master/crosschain_<X>.js
 *
 * Stored under enmDataDir/_oracle-scripts/ so the path is stable +
 * outside the per-chain dirs (matches the layout NodeJsRuntime uses
 * for the runtime install).
 *
 * NO CHECKSUM verification today — same posture as
 * EnmBinaryDownloader: TLS + smoke-test ("require it and look at
 * exports"). A future task can layer the official Elastos Foundation
 * GPG signatures on top.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const { enmDataDir } = require('./DataDir');
const { ENM_LOG_PREFIX } = require('./EnmConstants');

// Map per-oracle scriptFilename → upstream raw URL. Mirrors the
// scriptFilename getters on EscOracleAdapter / EidOracleAdapter /
// PgOracleAdapter (M4.1 + M5.4). Single source of truth so adding
// a new oracle = add one row.
const ORACLE_SOURCES = Object.freeze({
    'esc-oracle': {
        scriptName: 'crosschain_oracle.js',
        url: 'https://raw.githubusercontent.com/elastos/Elastos.ELA.SideChain.ESC.Oracle/master/crosschain_oracle.js',
    },
    'eid-oracle': {
        scriptName: 'crosschain_eid.js',
        url: 'https://raw.githubusercontent.com/elastos/Elastos.ELA.SideChain.EID.Oracle/master/crosschain_eid.js',
    },
    'pg-oracle': {
        scriptName: 'crosschain_pg.js',
        // PG is closed-source per plan §11 risk #2; the raw URL may
        // 404 publicly. Operator can override via cfg/body.scriptPath
        // pointing at a manually-placed file.
        url: 'https://raw.githubusercontent.com/elastos/Elastos.ELA.SideChain.PG.Oracle/master/crosschain_pg.js',
    },
});

const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Resolve the local scripts directory. All three oracle scripts share
 * the same parent so install-class-c can point all 3 oracles at the
 * same scriptPath.
 *
 * @returns {string}
 */
function scriptsDir() {
    return path.join(enmDataDir(), '_oracle-scripts');
}

/**
 * @param {string} chainId  'esc-oracle' | 'eid-oracle' | 'pg-oracle'
 * @returns {string} absolute path where the script lives (whether or
 *   not it's been downloaded yet).
 */
function scriptPathFor(chainId) {
    const src = ORACLE_SOURCES[chainId];
    if (!src) {
        throw new Error(`OracleScriptDownloader: unknown oracle chainId "${chainId}"`);
    }
    return path.join(scriptsDir(), src.scriptName);
}

/**
 * Check if the script is already on disk + non-empty. Treat empty
 * files as "missing" — a previous failed download could leave a 0B
 * stub; better to re-download than mis-spawn.
 *
 * @param {string} chainId
 * @returns {boolean}
 */
function isInstalled(chainId) {
    try {
        const p = scriptPathFor(chainId);
        const st = fs.statSync(p);
        return st.isFile() && st.size > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Download one oracle script if not already present. Idempotent.
 * Returns the absolute path on success.
 *
 * @param {string} chainId
 * @param {object} [opts]
 * @param {(msg:string) => void} [opts.onProgress]
 * @returns {Promise<string>}
 */
async function downloadOne(chainId, opts) {
    const o = opts || {};
    const onProgress = o.onProgress || (() => {});
    if (isInstalled(chainId)) {
        onProgress(`already installed: ${chainId}`);
        return scriptPathFor(chainId);
    }
    const src = ORACLE_SOURCES[chainId];
    if (!src) {
        throw new Error(`OracleScriptDownloader: unknown oracle chainId "${chainId}"`);
    }
    await fsp.mkdir(scriptsDir(), { recursive: true, mode: 0o755 });
    const dest = scriptPathFor(chainId);
    onProgress(`fetching ${src.url}`);
    await downloadFile(src.url, dest);
    onProgress(`downloaded ${chainId} → ${dest}`);
    return dest;
}

/**
 * Download all 3 oracle scripts. Returns a map { chainId → path } or
 * throws on first failure (caller handles retry).
 *
 * @param {object} [opts]
 * @param {(msg:string) => void} [opts.onProgress]
 * @param {string[]} [opts.chainIds] — subset to download (default all)
 * @returns {Promise<Record<string, string>>}
 */
async function downloadAll(opts) {
    const o = opts || {};
    const chainIds = Array.isArray(o.chainIds) && o.chainIds.length > 0
        ? o.chainIds : Object.keys(ORACLE_SOURCES);
    const results = {};
    for (const cid of chainIds) {
        results[cid] = await downloadOne(cid, { onProgress: o.onProgress });
    }
    return results;
}

/** @private — HTTPS GET with redirect support, stream to disk. */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        function get(u, redirectsLeft) {
            const req = https.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) {
                        return reject(new Error('Too many redirects'));
                    }
                    return get(res.headers.location, redirectsLeft - 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
                }
                const out = fs.createWriteStream(destPath, { mode: 0o644 });
                res.pipe(out);
                out.on('finish', () => { out.close(resolve); });
                out.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
                req.destroy(new Error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS}ms`));
            });
        }
        get(url, 5);
    });
}

module.exports = {
    ORACLE_SOURCES,
    scriptsDir,
    scriptPathFor,
    isInstalled,
    downloadOne,
    downloadAll,
    DOWNLOAD_TIMEOUT_MS,
};
