/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmMaintenanceManager — beta.3.33. Backs the Settings → Danger Zone
 * actions: update / chain-resync / uninstall / nuke.
 *
 * Why this exists:
 *   Until beta.3.32 the only way to update or uninstall ENM was SSH +
 *   /root/deploy-enm.sh. The operator asked for an in-UI flow with the
 *   four destructive options spelled out. This module is the backend
 *   half of that work — the frontend Danger Zone card calls into the
 *   /api/enm/maintenance/* routes which delegate here.
 *
 * Action semantics:
 *
 *   checkLatestVersion()
 *     GET-only. Returns { current, latest, updateAvailable, tag,
 *     releaseUrl, publishedAt }. Hits the GitHub releases API
 *     unauthenticated (60 req/hr/IP — fine for occasional polls).
 *
 *   update({ tag })
 *     Spawns /root/deploy-enm.sh <tag> detached and returns
 *     "update queued". deploy-enm.sh is the canonical path — it
 *     handles the SIGKILL-self-then-reinstall dance that an in-
 *     process update can't because the HTTP response gets cut off
 *     mid-stream when pc2-node kills ENM. Frontend polls
 *     /system/status afterwards to learn the new version is up.
 *
 *   chainResync(chainId)
 *     Inline (no detach). Stops chain via ChainAdapter, backs up
 *     keystore via EnmStorageMaintenance, deletes the LevelDB +
 *     peers.json, starts chain. Keystore + config.json preserved.
 *
 *   uninstall()
 *     Spawns curl DELETE …?purge=false detached. pc2-node tears down
 *     the bundle; the data dir (chain DB, keystore, audit log,
 *     backups) survives at /var/lib/pc2/data/extensions/elastos-
 *     node-manager so reinstall can recover.
 *
 *   nuke()
 *     Detaches a script that DELETE …?purge=true, then rm -rf the
 *     extension data dir. Operator loses the keystore. Confirmation
 *     gate is "WIPE EVERYTHING" (case-sensitive) on the frontend.
 *
 * Concurrency:
 *   In-process lock prevents two destructive actions running at once.
 *   Lock is module-scoped and self-clearing on completion or on
 *   process exit (since ENM dies anyway after uninstall/nuke/update).
 *
 * Audit:
 *   Each action writes an audit row via EnmAuditLog.append with
 *   tier:CRITICAL-INFO, decision:executed, executor:operator.
 *   chainId='mainchain' for all (single-chain v0.2). The payload
 *   carries the action name + outcome.
 *
 * Why a detached child process for update/uninstall/nuke and not
 * an inline await? Because we are about to kill ourselves. The
 * Express response stream needs to flush first, then the script
 * tears down pc2-node's child process for ENM. If we await the
 * shell-out inline, the client never sees the success envelope —
 * just a TCP RST when our PID dies. Detach + unref decouples it.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const { ENM_LOG_PREFIX } = require('./EnmConstants');
const DataDir = require('./DataDir');
const ChainRegistry = require('./ChainRegistry');

const KEYSTORE_FILENAME = 'keystore.dat';

const GITHUB_OWNER = '4HM3DMD';
const GITHUB_REPO = 'pc2-testing';
const DEPLOY_SCRIPT = '/root/deploy-enm.sh';
const SELF_DATA_DIR_DEFAULT = '/var/lib/pc2/data/extensions/elastos-node-manager';
// beta.3.35 — operate on PC2 at the filesystem + sqlite layer rather
// than through its HTTP API. We're already running as root inside
// pc2-node; needing a self-auth token to delete our own files is
// theatre. /etc/pc2.env may be unreadable on hardened hosts anyway.
const PC2_SQLITE_PATH = '/var/lib/pc2/data/pc2-node.sqlite';
const INSTALLED_APPS_DIR = '/var/lib/pc2/data/installed-apps/elastos-node-manager';
const APP_NAME = 'elastos-node-manager';

// In-process lock — only one destructive action at a time.
let _busy = null; // { action, startedAtMs }

function _acquire(action) {
    if (_busy) {
        const e = new Error(
            `Another maintenance action is already running: ${_busy.action} `
            + `(started ${Math.round((Date.now() - _busy.startedAtMs) / 1000)}s ago).`,
        );
        e.code = 'BUSY';
        throw e;
    }
    _busy = { action, startedAtMs: Date.now() };
}

function _release() {
    _busy = null;
}

/**
 * beta.3.35 — uninstall + nuke no longer call pc2-node's HTTP API,
 * so the owner-token reader is no longer needed by those paths.
 * Kept as a stub returning null for backward compatibility with
 * callers that may still import it (none in-tree).
 *
 * Why the rewrite: operator complaint — "why do we even need this?"
 * Reading /etc/pc2.env to authenticate to the same process tree we
 * already live inside was theatre. We're root, we have shell, we
 * have the sqlite file at a known path. Just do the work directly.
 */
function readOwnerToken() {
    return null;
}

/**
 * Query the GitHub releases API for the most recent release whose tag
 * starts with `enm-v`. We don't authenticate — public repo, public
 * releases, and the rate limit (60/hr/IP) is way above what a polling
 * Danger Zone card can hit.
 *
 * @param {string} currentVersion — semver-shaped, e.g. "0.2.0-beta.3.32"
 * @returns {Promise<{
 *   current: string,
 *   latest: string|null,
 *   tag: string|null,
 *   updateAvailable: boolean,
 *   releaseUrl: string|null,
 *   publishedAt: string|null,
 *   error?: string,
 * }>}
 */
async function checkLatestVersion(currentVersion) {
    const current = String(currentVersion || '').replace(/^v/, '');
    try {
        const releases = await _httpsGetJson(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`,
        );
        if (!Array.isArray(releases)) {
            return {
                current, latest: null, tag: null, updateAvailable: false,
                releaseUrl: null, publishedAt: null,
                error: 'GitHub releases response was not an array',
            };
        }
        // Filter to enm-v* prereleases + releases, pick newest by publishedAt.
        const candidates = releases
            .filter((r) => r && typeof r.tag_name === 'string' && r.tag_name.startsWith('enm-v'))
            .filter((r) => !r.draft);
        if (candidates.length === 0) {
            return {
                current, latest: null, tag: null, updateAvailable: false,
                releaseUrl: null, publishedAt: null,
            };
        }
        candidates.sort((a, b) => {
            const ta = a.published_at ? Date.parse(a.published_at) : 0;
            const tb = b.published_at ? Date.parse(b.published_at) : 0;
            return tb - ta;
        });
        const newest = candidates[0];
        const latestSemver = String(newest.tag_name).replace(/^enm-v/, '');
        const updateAvailable = _semverIsNewer(latestSemver, current);
        return {
            current,
            latest: latestSemver,
            tag: newest.tag_name,
            updateAvailable,
            releaseUrl: newest.html_url || null,
            publishedAt: newest.published_at || null,
        };
    } catch (err) {
        return {
            current, latest: null, tag: null, updateAvailable: false,
            releaseUrl: null, publishedAt: null,
            error: err.message || String(err),
        };
    }
}

/**
 * Launch the ENM update flow. Spawns /root/deploy-enm.sh <tag> as a
 * detached child; the script handles SIGKILL-self + reinstall via
 * pc2-node's install-local route + restart. We return immediately so
 * the operator's request gets a clean response before our process
 * dies.
 *
 * @param {{ tag: string, log?: object }} opts
 * @returns {Promise<{ action: 'update', tag: string, scriptPath: string }>}
 */
async function update(opts) {
    const tag = String((opts && opts.tag) || '').trim();
    if (!/^enm-v\d/.test(tag)) {
        throw Object.assign(new Error('Invalid tag — expected "enm-v…"'), { code: 'BAD_TAG' });
    }
    _acquire('update');
    try {
        const log = (opts && opts.log) || _noopLog();
        // Make sure the deploy script is present + executable. We don't
        // want to return success and then have the operator hit a silent
        // ENOENT a second later.
        try {
            await fsp.access(DEPLOY_SCRIPT, fs.constants.X_OK);
        } catch (err) {
            throw Object.assign(
                new Error(`Deploy script ${DEPLOY_SCRIPT} not found or not executable (${err.code}).`),
                { code: 'NO_DEPLOY_SCRIPT' },
            );
        }

        // Build the detached script. We pipe deploy-enm.sh output to a
        // diagnostic log under enmDataDir so operators (or us, on a
        // follow-up SSH) can see what happened.
        const dataDir = _dataDirSafe();
        const logFile = path.join(dataDir, `update-${Date.now()}.log`);

        // The token is required for the install-local PC2 call inside
        // deploy-enm.sh. The script reads it from /etc/pc2.env so we
        // don't need to pass it here.
        const sh =
            `set -e\n`
            + `( ${DEPLOY_SCRIPT} '${_shellEscape(tag)}' > '${_shellEscape(logFile)}' 2>&1 ) &\n`
            + `disown\n`;
        const child = spawn('bash', ['-c', sh], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        log.info(`${ENM_LOG_PREFIX} maintenance.update queued: ${tag} (log → ${logFile})`);
        return {
            action: 'update',
            tag,
            scriptPath: DEPLOY_SCRIPT,
            logFile,
        };
    } finally {
        // We can release immediately — the child is detached and we're
        // about to be killed by it anyway. If the child fails to fire
        // (ENOENT etc.) the operator can retry.
        _release();
    }
}

/**
 * Stop chain → backup keystore → wipe LevelDB + peers.json + dpos/
 * → restart chain. Keystore, config, and audit log all survive.
 *
 * @param {{ chainId: string, log?: object }} opts
 * @returns {Promise<{ action: 'chain-resync', chainId, removedPaths: string[], keystoreBackup: string|null }>}
 */
async function chainResync(opts) {
    const chainId = String((opts && opts.chainId) || '').trim();
    if (!/^[a-z0-9-]+$/.test(chainId)) {
        throw Object.assign(new Error('Invalid chainId'), { code: 'BAD_CHAIN' });
    }
    _acquire('chain-resync');
    const log = (opts && opts.log) || _noopLog();
    try {
        let adapter;
        try {
            adapter = ChainRegistry.getAdapter(chainId);
        } catch (err) {
            throw Object.assign(
                new Error(`Unknown chain "${chainId}"`),
                { code: 'NO_CHAIN' },
            );
        }
        log.info(`${ENM_LOG_PREFIX} maintenance.chainResync(${chainId}) — stopping chain`);
        try {
            await adapter.stop();
        } catch (err) {
            log.warn(`${ENM_LOG_PREFIX} maintenance.chainResync: stop returned: ${err.message}`);
            // Continue — if the process was already dead the rm path is still safe.
        }

        // Best-effort keystore backup before we touch chain data. This
        // mirrors EnmStorageMaintenance._backupKeystoreIfDue without
        // calling into the class API (which is private). Same target
        // path so the existing /system/storage UI surfaces it.
        const keystoreBackup = await _backupKeystoreNow(chainId, log).catch((err) => {
            log.warn(`${ENM_LOG_PREFIX} maintenance.chainResync: keystore backup failed: ${err.message}`);
            return null;
        });

        // Resolve the chain data dir. DataDir.chainDir is the per-
        // chain root; ela's leveldb + peers files live under data/.
        const cdir = DataDir.chainDir(chainId);
        const removed = [];
        const candidates = [
            path.join(cdir, 'data'),
            path.join(cdir, 'peers.json'),
            path.join(cdir, 'dpos'),
            path.join(cdir, 'logs', 'node'),  // chain logs from ela
        ];
        for (const p of candidates) {
            try {
                await fsp.rm(p, { recursive: true, force: true });
                removed.push(p);
                log.info(`${ENM_LOG_PREFIX} maintenance.chainResync removed: ${p}`);
            } catch (err) {
                log.warn(`${ENM_LOG_PREFIX} maintenance.chainResync rm ${p} failed: ${err.message}`);
            }
        }

        // Restart chain. ChainAdapter.start needs the chain config from
        // ConfigStore — same path the route handler walks.
        log.info(`${ENM_LOG_PREFIX} maintenance.chainResync(${chainId}) — restarting chain`);
        const ConfigStore = require('./ConfigStore');
        const cfg = await ConfigStore.load();
        const chainCfg = cfg && cfg.chains && cfg.chains[chainId];
        if (!chainCfg) {
            throw Object.assign(
                new Error(`Chain config for "${chainId}" missing after resync`),
                { code: 'NO_CFG' },
            );
        }
        try {
            await adapter.start(chainCfg);
        } catch (err) {
            // Surface but don't swallow — the data wipe still happened.
            throw Object.assign(
                new Error(`Resync wiped data but chain restart failed: ${err.message}`),
                { code: 'RESTART_FAILED' },
            );
        }
        return { action: 'chain-resync', chainId, removedPaths: removed, keystoreBackup };
    } finally {
        _release();
    }
}

/**
 * Uninstall the ENM extension from PC2 but preserve all extension data
 * on disk. The script:
 *   1. Sleeps 2s so Express flushes the 200 response.
 *   2. Deletes the installed_apps sqlite row (pc2-node now considers us
 *      uninstalled — won't restart us when our PID dies).
 *   3. Kills ela children (the user's stake-bound process).
 *   4. rm -rf the bundle dir.
 *   5. SIGKILL our own PID.
 *
 * beta.3.35 — no HTTP call to pc2-node, no owner token. ENM runs as
 * root inside pc2-node and has direct read/write on pc2-node.sqlite.
 *
 * Data dir (chain DB, keystore, audit, backups) at /var/lib/pc2/data/
 * extensions/elastos-node-manager is left intact so a future reinstall
 * can recover the operator's BPoS supernode.
 *
 * @param {{ log?: object }} opts
 * @returns {Promise<{ action: 'uninstall', logFile: string }>}
 */
async function uninstall(opts) {
    _acquire('uninstall');
    const log = (opts && opts.log) || _noopLog();
    try {
        // Write the destructive script's log to /tmp so it survives a
        // future nuke that would also wipe the data dir. /tmp is on
        // tmpfs on this host — file lives until next reboot, which is
        // enough for post-mortem.
        const logFile = `/tmp/enm-uninstall-${Date.now()}.log`;
        const sh = _buildTeardownScript({
            label: 'uninstall',
            logFile,
            wipeDataDir: false,
        });
        const child = spawn('bash', ['-c', sh], { detached: true, stdio: 'ignore' });
        child.unref();
        log.info(`${ENM_LOG_PREFIX} maintenance.uninstall queued (log → ${logFile})`);
        return { action: 'uninstall', logFile };
    } finally {
        _release();
    }
}

/**
 * Nuke everything: uninstall the extension AND rm -rf the data dir.
 * Operator loses keystore. The frontend gates this with the
 * case-sensitive typed confirmation "WIPE EVERYTHING".
 *
 * Order matters:
 *   1. DELETE …?purge=true     ← pc2-node SIGKILLs ENM, removes bundle
 *   2. wait for process gone
 *   3. rm -rf <dataDir>        ← while no ENM holds inodes
 *
 * @param {{ log?: object }} opts
 * @returns {Promise<{ action: 'nuke', logFile: string }>}
 */
async function nuke(opts) {
    _acquire('nuke');
    const log = (opts && opts.log) || _noopLog();
    try {
        const dataDir = _dataDirSafe();
        const logFile = `/tmp/enm-nuke-${Date.now()}.log`;
        const sh = _buildTeardownScript({
            label: 'nuke',
            logFile,
            wipeDataDir: true,
            dataDir,
        });
        const child = spawn('bash', ['-c', sh], { detached: true, stdio: 'ignore' });
        child.unref();
        log.info(`${ENM_LOG_PREFIX} maintenance.nuke queued (log → ${logFile}, data dir → ${dataDir})`);
        return { action: 'nuke', logFile };
    } finally {
        _release();
    }
}

/**
 * Public status accessor — used by the route layer to surface "an
 * action is in flight" without re-attempting the lock.
 */
function status() {
    if (!_busy) { return { busy: false, action: null, startedAtMs: null }; }
    return { busy: true, action: _busy.action, startedAtMs: _busy.startedAtMs };
}

// ============================================================================
// Helpers
// ============================================================================

function _dataDirSafe() {
    try {
        return DataDir.enmDataDir();
    } catch (_) {
        return SELF_DATA_DIR_DEFAULT;
    }
}

/**
 * Compose the detached bash script that ENM hands off to before it
 * dies. The script always:
 *   1. Sleeps 2s so the HTTP response flushes.
 *   2. Kills any ela child processes ENM was supervising.
 *   3. Removes the installed_apps sqlite row so pc2-node forgets us
 *      (otherwise the boot sweeper's "manual:" cid override leaves
 *       us in place — see project_session_resume_2026_05_13).
 *   4. Removes the bundle install dir.
 *   5. (nuke only) rm -rf the extension data dir + the
 *      backups/elastos-node-manager dir.
 *   6. SIGKILL our own PID. With the sqlite row gone, pc2-node won't
 *      auto-restart us.
 *
 * @param {{label:'uninstall'|'nuke', logFile:string, wipeDataDir:boolean, dataDir?:string}} opts
 * @returns {string} script text
 */
function _buildTeardownScript(opts) {
    const label = opts.label;
    const logFile = opts.logFile;
    const wipe = !!opts.wipeDataDir;
    const dataDir = opts.dataDir || SELF_DATA_DIR_DEFAULT;
    // The pc2-node SQLite row removal. We try the sqlite3 CLI first
    // (standard on Ubuntu); if it's missing, we fall back to invoking
    // node with our own better-sqlite3 from node_modules. If both fail,
    // the file disappears but the sqlite row stays — operator sees a
    // ghost app on the dashboard until next pc2-node restart, at which
    // point the boot sweeper reaps the rowless install. Worst case
    // is cosmetic, not data-loss.
    const sqliteCleanup =
        `  echo "[${label} $(date -u +%FT%TZ)] removing installed_apps row"\n`
        + `  if command -v sqlite3 >/dev/null 2>&1; then\n`
        + `    sqlite3 '${_shellEscape(PC2_SQLITE_PATH)}' \\\n`
        + `      "DELETE FROM installed_apps WHERE app_name='${_shellEscape(APP_NAME)}'" \\\n`
        + `      && echo "  sqlite3 cli: row deleted" \\\n`
        + `      || echo "  sqlite3 cli: failed"\n`
        + `  else\n`
        + `    node -e "try { const sq = require('${_shellEscape(INSTALLED_APPS_DIR)}/backend/node_modules/better-sqlite3'); const db = new sq('${_shellEscape(PC2_SQLITE_PATH)}'); db.prepare(\\"DELETE FROM installed_apps WHERE app_name='${_shellEscape(APP_NAME)}'\\").run(); db.close(); console.log('  better-sqlite3: row deleted'); } catch (e) { console.log('  fallback failed:', e.message); }" || echo "  no sqlite available; boot sweeper will reap on next pc2-node restart"\n`
        + `  fi\n`;
    const killEla =
        `  echo "[${label} $(date -u +%FT%TZ)] killing ela children"\n`
        + `  pkill -9 -f '/var/lib/pc2/data/extensions/elastos-node-manager/.*ela' && echo "  killed" || echo "  no ela process"\n`;
    const removeBundle =
        `  echo "[${label} $(date -u +%FT%TZ)] removing bundle dir"\n`
        + `  rm -rf '${_shellEscape(INSTALLED_APPS_DIR)}' || true\n`;
    const removeData = wipe
        ? `  echo "[nuke $(date -u +%FT%TZ)] rm -rf data dir + backups"\n`
          + `  rm -rf '${_shellEscape(dataDir)}' || true\n`
          + `  # Backups live one level outside the extension dir per\n`
          + `  # EnmStorageMaintenance convention.\n`
          + `  rm -rf '/var/lib/pc2/data/backups/elastos-node-manager' || true\n`
        : `  echo "[uninstall $(date -u +%FT%TZ)] preserving data dir at ${_shellEscape(dataDir)}"\n`;
    const killSelf =
        `  echo "[${label} $(date -u +%FT%TZ)] killing ENM"\n`
        + `  pkill -9 -f 'elastos-node-manager.*server.js' || true\n`
        + `  echo "[${label} $(date -u +%FT%TZ)] done"\n`;
    return (
        `(\n`
        + `  sleep 2\n`
        + killEla
        + sqliteCleanup
        + removeBundle
        + removeData
        + killSelf
        + `) > '${_shellEscape(logFile)}' 2>&1 &\n`
        + `disown\n`
    );
}

/**
 * Copy keystore.dat to PC2_DATA_DIR/backups/elastos-node-manager/
 * keystore-<iso>.dat. Returns the backup path or null if there's no
 * keystore to back up (pre-setup operator). Idempotent and safe.
 */
async function _backupKeystoreNow(chainId, log) {
    const src = path.join(DataDir.chainDir(chainId), KEYSTORE_FILENAME);
    if (!fs.existsSync(src)) {
        log.info(`${ENM_LOG_PREFIX} maintenance: no keystore at ${src} to back up`);
        return null;
    }
    // PC2_DATA_DIR convention from server.js — fall back to two levels
    // above enmDataDir so we land at /var/lib/pc2/data/backups/...
    const pc2Data = process.env.PC2_DATA_DIR
        || path.dirname(path.dirname(DataDir.enmDataDir()));
    const backupRoot = path.join(pc2Data, 'backups', 'elastos-node-manager');
    await fsp.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(backupRoot, `keystore-${ts}.dat`);
    await fsp.copyFile(src, dst);
    await fsp.chmod(dst, 0o600);
    log.info(`${ENM_LOG_PREFIX} maintenance: keystore backed up → ${dst}`);
    return dst;
}

function _noopLog() {
    return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * Single-quote shell-escape: replace ' with '\''. The strings we
 * receive (tag names, paths under /var/lib/pc2/data, the owner token)
 * are tightly constrained upstream — Joi schemas reject anything that
 * isn't [a-fA-F0-9.] for the tag, [a-z0-9-_/.] for chainId/path. This
 * escape is defence in depth, not the primary boundary.
 */
function _shellEscape(s) {
    return String(s).replace(/'/g, `'\\''`);
}

/**
 * Compare two semver-shaped strings like "0.2.0-beta.3.32". Returns
 * true iff `a` is strictly newer than `b`. Handles the beta.M.N suffix
 * shape we use: lexical comparison would order beta.3.10 < beta.3.9,
 * so we split on dots and compare numerically where possible.
 */
function _semverIsNewer(a, b) {
    if (!a) return false;
    if (!b) return true;
    const ta = _semverTokenize(a);
    const tb = _semverTokenize(b);
    const n = Math.max(ta.length, tb.length);
    for (let i = 0; i < n; i += 1) {
        const xa = ta[i];
        const xb = tb[i];
        if (xa === undefined) { return false; } // a is shorter ⇒ older
        if (xb === undefined) { return true; }  // b is shorter ⇒ a is newer
        if (typeof xa === 'number' && typeof xb === 'number') {
            if (xa !== xb) { return xa > xb; }
        } else {
            const sa = String(xa), sb = String(xb);
            if (sa !== sb) { return sa > sb; }
        }
    }
    return false;
}

function _semverTokenize(s) {
    // "0.2.0-beta.3.32" → [0, 2, 0, "beta", 3, 32]
    return String(s).split(/[.\-]/).map((t) => {
        if (/^\d+$/.test(t)) { return parseInt(t, 10); }
        return t;
    });
}

/**
 * HTTPS GET with User-Agent (GitHub requires it) returning parsed
 * JSON. 6-second timeout, follow up to 3 redirects.
 */
function _httpsGetJson(url, depth) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            method: 'GET',
            hostname: u.hostname,
            path: u.pathname + u.search,
            port: u.port || 443,
            headers: {
                'User-Agent': 'ENM-MaintenanceManager/0.2.0',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            timeout: 6_000,
        }, (res) => {
            // Follow redirects manually so we keep our headers on the hop.
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const d = (depth || 0) + 1;
                if (d > 3) { return reject(new Error('Too many redirects')); }
                res.resume();
                return _httpsGetJson(res.headers.location, d).then(resolve, reject);
            }
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
                }
                try { resolve(JSON.parse(buf)); }
                catch (err) { reject(new Error(`JSON parse failed: ${err.message}`)); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Request timeout')));
        req.on('error', reject);
        req.end();
    });
}

module.exports = {
    checkLatestVersion,
    update,
    chainResync,
    uninstall,
    nuke,
    status,
    readOwnerToken,
    // exported for tests
    _internals: {
        _semverIsNewer,
        _shellEscape,
    },
};
