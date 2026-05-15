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
const PC2_LOCAL_URL = 'http://127.0.0.1:4202';
const DEPLOY_SCRIPT = '/root/deploy-enm.sh';
const PC2_ENV_FILE = '/etc/pc2.env';
const SELF_DATA_DIR_DEFAULT = '/var/lib/pc2/data/extensions/elastos-node-manager';

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
 * Read PC2_OWNER_TOKEN from /etc/pc2.env (the same file the deploy
 * script reads). Memoized — file is set once at PC2 install time.
 *
 * Returns null if unreadable; callers must handle that — the
 * `update / uninstall / nuke` paths all need it.
 */
let _ownerTokenCache = null;
function readOwnerToken() {
    if (_ownerTokenCache !== null) {
        return _ownerTokenCache || null;
    }
    try {
        const txt = fs.readFileSync(PC2_ENV_FILE, 'utf8');
        const m = txt.match(/^\s*PC2_OWNER_TOKEN\s*=\s*"?([a-fA-F0-9]{32,128})"?\s*$/m);
        if (m && m[1]) {
            _ownerTokenCache = m[1];
            return m[1];
        }
    } catch (_) {
        // ENOENT or permission denied — caller will surface a useful error.
    }
    _ownerTokenCache = '';
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
 * on disk. Caller must respond to the HTTP client BEFORE awaiting this
 * (the spawn is detached so we don't block; but pc2-node will SIGKILL
 * us once it processes the DELETE).
 *
 * @param {{ log?: object }} opts
 * @returns {Promise<{ action: 'uninstall', logFile: string }>}
 */
async function uninstall(opts) {
    _acquire('uninstall');
    const log = (opts && opts.log) || _noopLog();
    try {
        const token = readOwnerToken();
        if (!token) {
            throw Object.assign(
                new Error(`Owner token not readable from ${PC2_ENV_FILE}`),
                { code: 'NO_TOKEN' },
            );
        }
        const dataDir = _dataDirSafe();
        const logFile = path.join(dataDir, `uninstall-${Date.now()}.log`);

        // Use bash heredoc-style script so we can sleep briefly before
        // firing the DELETE — that gives Express time to flush our 200
        // response back to the operator before ENM gets SIGKILLed.
        const sh =
            `(\n`
            + `  sleep 2\n`
            + `  echo "[uninstall $(date -u +%FT%TZ)] DELETE elastos-node-manager purge=false"\n`
            + `  curl -sS -X DELETE -H 'Authorization: Bearer ${_shellEscape(token)}' \\\n`
            + `       '${PC2_LOCAL_URL}/api/installed-apps/elastos-node-manager?purge=false' || true\n`
            + `  echo "[uninstall $(date -u +%FT%TZ)] done"\n`
            + `) > '${_shellEscape(logFile)}' 2>&1 &\n`
            + `disown\n`;
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
        const token = readOwnerToken();
        if (!token) {
            throw Object.assign(
                new Error(`Owner token not readable from ${PC2_ENV_FILE}`),
                { code: 'NO_TOKEN' },
            );
        }
        const dataDir = _dataDirSafe();
        // Capture the path BEFORE we rm it — we still write the log to
        // /tmp instead of inside the doomed dir so the artifact survives.
        const logFile = `/tmp/enm-nuke-${Date.now()}.log`;
        const sh =
            `(\n`
            + `  sleep 2\n`
            + `  echo "[nuke $(date -u +%FT%TZ)] DELETE elastos-node-manager purge=true"\n`
            + `  curl -sS -X DELETE -H 'Authorization: Bearer ${_shellEscape(token)}' \\\n`
            + `       '${PC2_LOCAL_URL}/api/installed-apps/elastos-node-manager?purge=true' || true\n`
            + `  echo "[nuke $(date -u +%FT%TZ)] waiting for ENM PID to die..."\n`
            + `  for i in 1 2 3 4 5 6 7 8 9 10; do\n`
            + `    if ! pgrep -f 'elastos-node-manager.*server.js' > /dev/null; then break; fi\n`
            + `    sleep 1\n`
            + `  done\n`
            + `  echo "[nuke $(date -u +%FT%TZ)] rm -rf ${_shellEscape(dataDir)}"\n`
            + `  rm -rf '${_shellEscape(dataDir)}' || true\n`
            + `  echo "[nuke $(date -u +%FT%TZ)] done"\n`
            + `) > '${_shellEscape(logFile)}' 2>&1 &\n`
            + `disown\n`;
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
