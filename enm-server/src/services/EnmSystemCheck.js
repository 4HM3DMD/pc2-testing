/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmSystemCheck — v0.4.7 — MANDATORY pre-install hardware gate.
 *
 * Why this exists:
 *   Prior to v0.4.7 the install wizard accepted any host that passed
 *   the soft OS/disk preflights, then half-installed on a Raspberry Pi
 *   with 4 GB RAM + spinning USB disk. Sync would crawl, BPoS would
 *   miss votes, the operator would blame ENM. v0.4.7 hard-blocks the
 *   install at Card 0 when the box can't physically run the workload.
 *
 *   Council = full multi-chain operator (ELA + ESC + EID + arbiter,
 *   optionally PG). 8 cores / 42 GB RAM (64 recommended) / 1 TB SSD.
 *
 *   BPoS = mainchain producer only. 4 cores / 8 GB RAM / 150 GB SSD.
 *   The 8 GB minimum is tight (mainchain peaks ~6 GB during sync) so
 *   on exactly-8-GB boxes we offer add-swap remediation.
 *
 * What it returns:
 *   { ts, path, checks[], canProceed, remediation? }
 *   severity:'required' blocks; severity:'recommended' warns only.
 *   `remediation['add-swap']` only present for BPoS with RAM === 8 GB.
 *
 * v0.4.7
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');

const { enmDataDir } = require('./DataDir');
const { ENM_LOG_PREFIX } = require('./EnmConstants');

const BYTES_PER_GB = 1024 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 10_000;
const SWAPFILE_PATH = '/swapfile';
const SWAPFILE_SIZE_MB = 4096; // 4 GB
const FSTAB_PATH = '/etc/fstab';
const FSTAB_ENTRY = '/swapfile none swap sw 0 0';

/**
 * Per-path thresholds. Frozen so tests can introspect without mutating.
 * `ramRecommendedGb` only triggers a 'recommended' warning when total
 * is in [min, recommended); `ramRemediableExactGb` triggers add-swap
 * (only the exact value — <8 GB is hopeless, >8 GB doesn't need it).
 *
 * beta.0.5.0 — opt-in dev relaxation. Setting
 * `ENM_DEV_RELAX_SYSCHECK=true` swaps the strict thresholds for a
 * relaxed set (council RAM 30 GB / disk 50 GB) so the wizard can run
 * on developer boxes. NOT FOR PRODUCTION — gated by an explicit env
 * flag + a stderr warning so it can't be enabled accidentally. The
 * exported `THRESHOLDS` name stays stable so callers and tests still
 * resolve.
 */
const RELAX = process.env.ENM_DEV_RELAX_SYSCHECK === 'true';
if (RELAX) {
    // Warning log so the operator sees this in journalctl
    // eslint-disable-next-line no-console
    console.warn('[EnmSystemCheck] ENM_DEV_RELAX_SYSCHECK=true — using relaxed thresholds. NOT FOR PRODUCTION.');
}
const THRESHOLDS_STRICT = Object.freeze({
    council: Object.freeze({
        cpuCoresMin: 8,
        ramMinGb: 42,
        ramRecommendedGb: 64,
        diskFreeGbMin: 1024,
        ramRemediableExactGb: null,
    }),
    bpos: Object.freeze({
        cpuCoresMin: 4,
        ramMinGb: 8,
        ramRecommendedGb: 8,
        diskFreeGbMin: 150,
        ramRemediableExactGb: 8,
    }),
});
const THRESHOLDS_RELAXED = Object.freeze({
    council: Object.freeze({
        cpuCoresMin: 8,
        ramMinGb: 30,
        ramRecommendedGb: 32,
        diskFreeGbMin: 50,
        ramRemediableExactGb: null,
    }),
    bpos: Object.freeze({
        cpuCoresMin: 4,
        ramMinGb: 8,
        ramRecommendedGb: 8,
        diskFreeGbMin: 50,
        ramRemediableExactGb: 8,
    }),
});
const THRESHOLDS = RELAX ? THRESHOLDS_RELAXED : THRESHOLDS_STRICT;

/**
 * Round bytes → whole GB. Truncate (Math.floor) so "31.9 GB" doesn't
 * round up past a 32 GB threshold; better to under-report than to let
 * a borderline box in.
 */
function bytesToGb(bytes) {
    return Math.floor(Number(bytes) / BYTES_PER_GB);
}

/** Capitalize for friendlier copy ("council" → "Council"). */
function ucfirst(s) {
    if (!s) { return ''; }
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Run a command via execFile (no shell interpretation). Never throws —
 * resolves with { stdout, stderr, code } so the caller can inspect
 * even on failure.
 */
function execCapture(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args || [], {
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: 256 * 1024,
            env: { PATH: process.env.PATH || '/usr/sbin:/usr/bin:/sbin:/bin' },
        }, (err, stdout, stderr) => {
            resolve({
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
                code: err ? (err.code === undefined ? null : Number(err.code)) : 0,
            });
        });
    });
}

/**
 * Parse /etc/os-release. Inlined rather than calling OsPreflight so
 * the gate stays independent of the soft check.
 *
 * @returns {Object<string,string>|null}
 */
function readOsRelease() {
    let raw;
    try {
        raw = fs.readFileSync('/etc/os-release', 'utf8');
    } catch (_) {
        return null;
    }
    const out = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) { continue; }
        const key = trimmed.slice(0, eq);
        let value = trimmed.slice(eq + 1);
        if (value.length >= 2
            && (value[0] === '"' || value[0] === "'")
            && value[value.length - 1] === value[0]) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

/**
 * Check #1 — OS must be Ubuntu. Pure: pass a synthetic os-release map
 * from tests.
 *
 * @param {Object<string,string>|null} release
 * @returns {{ok:boolean, message:string}}
 */
function checkOs(release) {
    if (!release) {
        return { ok: false, message: 'Could not read /etc/os-release — Ubuntu required' };
    }
    const id = (release.ID || '').toLowerCase().trim();
    const pretty = release.PRETTY_NAME || release.NAME || id || 'unknown';
    if (id === 'ubuntu') {
        return { ok: true, message: pretty };
    }
    return { ok: false, message: `Detected ${id || 'unknown'} — Ubuntu required` };
}

/** Check #2 — CPU cores (logical, as Go's runtime.GOMAXPROCS would see). */
function checkCpu(actualCores, requiredCores, pathName) {
    if (actualCores >= requiredCores) {
        return { ok: true, message: `${actualCores} cores` };
    }
    return {
        ok: false,
        message: `Only ${actualCores} cores — ${ucfirst(pathName)} needs >=${requiredCores}`,
    };
}

/** Check #3a — RAM minimum (blocks install when below). */
function checkRam(totalGb, requiredGb, pathName) {
    if (totalGb >= requiredGb) {
        return { ok: true, message: `${totalGb} GB total` };
    }
    return {
        ok: false,
        message: `${totalGb} GB total — ${ucfirst(pathName)} needs >=${requiredGb} GB`,
    };
}

/** Check #3b — RAM recommended. Warning only; never blocks. */
function checkRamRecommended(totalGb, recommendedGb) {
    if (totalGb >= recommendedGb) {
        return { ok: true, message: `${totalGb} GB — recommended >=${recommendedGb} GB` };
    }
    return { ok: false, message: `${totalGb} GB — recommended ${recommendedGb} GB` };
}

/**
 * Check #4 — free disk in enmDataDir(). `bavail` is the conservative
 * "non-root usable" number; we run as root in production but bavail
 * never over-reports, which is what we want at a hard gate.
 */
async function checkDisk(dir, requiredGb, pathName) {
    let stats;
    try {
        stats = await fsp.statfs(dir);
    } catch (err) {
        return { ok: false, message: `Could not stat filesystem at ${dir}: ${err.message}` };
    }
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeGb = bytesToGb(freeBytes);
    if (freeGb >= requiredGb) {
        return { ok: true, message: `${freeGb} GB free`, freeGb };
    }
    return {
        ok: false,
        message: `${freeGb} GB free — ${ucfirst(pathName)} needs >=${requiredGb} GB`,
        freeGb,
    };
}

/**
 * Resolve the base block device backing /.
 *   - findmnt → /dev/sda1 | /dev/nvme0n1p1 | ...
 *   - strip /dev/
 *   - nvme<X>n<Y>p<Z> → nvme<X>n<Y>, flag isNvme=true
 *   - otherwise strip trailing partition digits (sda1 → sda)
 *
 * @returns {Promise<{device:string|null, isNvme:boolean, source:string|null}>}
 */
async function resolveRootDevice() {
    const r = await execCapture('findmnt', ['-n', '-o', 'SOURCE', '/']);
    if (r.code !== 0) {
        return { device: null, isNvme: false, source: null };
    }
    const source = r.stdout.trim();
    if (!source) {
        return { device: null, isNvme: false, source: null };
    }
    let name = source;
    if (name.startsWith('/dev/')) {
        name = name.slice('/dev/'.length);
    }
    if (name.startsWith('nvme')) {
        const m = name.match(/^(nvme\d+n\d+)(p\d+)?$/);
        if (m) {
            return { device: m[1], isNvme: true, source };
        }
        // Unrecognised nvme shape — still flag NVMe (avoids false
        // "spinning disk" classification on unusual drives).
        return { device: name, isNvme: true, source };
    }
    const base = name.replace(/\d+$/, '');
    return { device: base || name, isNvme: false, source };
}

/**
 * Check #5 — storage must be SSD/NVMe. Short-circuits:
 *   - device name starts with `nvme` → always NVMe
 *   - cannot resolve device → reject (better than silent pass on a
 *     spinning disk)
 * Otherwise read /sys/block/<dev>/queue/rotational (0=SSD, 1=spinning).
 */
async function checkStorageType() {
    const root = await resolveRootDevice();
    if (root.isNvme) {
        return { ok: true, message: `NVMe (${root.device})` };
    }
    if (!root.device) {
        return { ok: false, message: 'Could not resolve root block device — SSD/NVMe required' };
    }
    const rotPath = `/sys/block/${root.device}/queue/rotational`;
    let rot;
    try {
        rot = fs.readFileSync(rotPath, 'utf8').trim();
    } catch (err) {
        return {
            ok: false,
            message: `Could not read ${rotPath}: ${err.message} — SSD/NVMe required`,
        };
    }
    if (rot === '0') {
        return { ok: true, message: `SSD (${root.device})` };
    }
    if (rot === '1') {
        return {
            ok: false,
            message: `Spinning disk detected (${root.device}) — SSD/NVMe required`,
        };
    }
    return {
        ok: false,
        message: `Unrecognised rotational flag "${rot}" for ${root.device} — SSD/NVMe required`,
    };
}

/**
 * Compose the full report.
 *
 * @param {{path:'council'|'bpos'}} input
 * @returns {Promise<object>}
 */
async function runSystemCheck(input) {
    const pathName = (input && input.path) || 'council';
    if (pathName !== 'council' && pathName !== 'bpos') {
        throw new Error(`EnmSystemCheck.runSystemCheck: unknown path "${pathName}"`);
    }
    // beta.0.5.0 — synthetic pass when setup is already completed.
    // Lazy-require ConfigStore so test harnesses that import THRESHOLDS
    // without a configured data dir don't trip the load() side effect.
    try {
        const ConfigStore = require('./ConfigStore');
        const cfg = await ConfigStore.load();
        if (cfg && cfg.setup && cfg.setup.completed === true) {
            return {
                ts: Date.now(),
                path: pathName,
                previouslyVerified: true,
                checks: [{
                    id: 'setup-completed',
                    label: 'System check previously passed',
                    ok: true,
                    message: `Setup completed ${new Date(cfg.setup.completedAt || 0).toISOString()}`,
                    severity: 'required',
                }],
                canProceed: true,
            };
        }
    } catch (_) { /* not yet configured — run the real checks */ }
    const t = THRESHOLDS[pathName];

    const release = readOsRelease();
    const cores = os.cpus().length;
    const totalGb = bytesToGb(os.totalmem());
    const dataDir = enmDataDir();

    const [diskResult, storageResult] = await Promise.all([
        checkDisk(dataDir, t.diskFreeGbMin, pathName),
        checkStorageType(),
    ]);

    const osResult = checkOs(release);
    const cpuResult = checkCpu(cores, t.cpuCoresMin, pathName);
    const ramResult = checkRam(totalGb, t.ramMinGb, pathName);

    const checks = [
        { id: 'os', label: 'Operating system', ok: osResult.ok, message: osResult.message, severity: 'required' },
        { id: 'cpu', label: 'CPU cores', ok: cpuResult.ok, message: cpuResult.message, severity: 'required' },
        { id: 'ram', label: 'RAM (minimum)', ok: ramResult.ok, message: ramResult.message, severity: 'required' },
    ];

    // 'recommended' RAM row only when it differs from the min — on
    // BPoS the two are equal (8/8) so the row would be redundant.
    if (t.ramRecommendedGb > t.ramMinGb) {
        const rec = checkRamRecommended(totalGb, t.ramRecommendedGb);
        checks.push({
            id: 'ram-recommended',
            label: 'RAM (recommended)',
            ok: rec.ok,
            message: rec.message,
            severity: 'recommended',
        });
    }

    checks.push({
        id: 'disk',
        label: 'Free disk',
        ok: diskResult.ok,
        message: diskResult.message,
        severity: 'required',
    });
    checks.push({
        id: 'storage-type',
        label: 'Storage type',
        ok: storageResult.ok,
        message: storageResult.message,
        severity: 'required',
    });

    const canProceed = checks
        .filter((c) => c.severity === 'required')
        .every((c) => c.ok);

    const report = { ts: Date.now(), path: pathName, checks, canProceed };

    // Remediation only when applicable — don't emit an empty object.
    if (
        pathName === 'bpos'
        && t.ramRemediableExactGb
        && totalGb === t.ramRemediableExactGb
        && ramResult.ok
    ) {
        report.remediation = {
            'add-swap': {
                available: true,
                action: 'create 4GB swapfile',
                endpoint: 'POST /api/enm/setup/system/add-swap',
            },
        };
    }

    return report;
}

/**
 * Idempotent fstab check — match the path as the first whitespace
 * field on any non-comment line (more robust than substring search).
 */
function fstabAlreadyHasSwapfile() {
    let raw;
    try {
        raw = fs.readFileSync(FSTAB_PATH, 'utf8');
    } catch (_) {
        return false;
    }
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        const firstField = trimmed.split(/\s+/)[0];
        if (firstField === SWAPFILE_PATH) { return true; }
    }
    return false;
}

/**
 * addSwap — create + enable + persist a 4 GB swapfile. Idempotent;
 * safe to call again (dd truncates, fstab append is gated).
 *
 * Steps (each wrapped, structured failure on any step):
 *   1. dd if=/dev/zero of=/swapfile bs=1M count=4096
 *   2. chmod 0600 /swapfile  (mkswap refuses world-readable swap)
 *   3. mkswap /swapfile
 *   4. swapon /swapfile
 *   5. append /swapfile entry to /etc/fstab if not present
 *
 * Requires root. PC2 boots as root in production; otherwise step 1
 * fails and we surface the error.
 *
 * @returns {Promise<{ok:true, freeGbAfter:number} | {ok:false, error:string}>}
 */
async function addSwap() {
    try {
        const dd = await execCapture('dd', [
            'if=/dev/zero',
            `of=${SWAPFILE_PATH}`,
            'bs=1M',
            `count=${SWAPFILE_SIZE_MB}`,
        ]);
        if (dd.code !== 0) {
            return {
                ok: false,
                error: `dd failed (code ${dd.code}): ${(dd.stderr || dd.stdout).trim()}`,
            };
        }

        try {
            await fsp.chmod(SWAPFILE_PATH, 0o600);
        } catch (err) {
            return { ok: false, error: `chmod 0600 ${SWAPFILE_PATH}: ${err.message}` };
        }

        const mkswap = await execCapture('mkswap', [SWAPFILE_PATH]);
        if (mkswap.code !== 0) {
            return {
                ok: false,
                error: `mkswap failed (code ${mkswap.code}): ${(mkswap.stderr || mkswap.stdout).trim()}`,
            };
        }

        const swapon = await execCapture('swapon', [SWAPFILE_PATH]);
        if (swapon.code !== 0) {
            return {
                ok: false,
                error: `swapon failed (code ${swapon.code}): ${(swapon.stderr || swapon.stdout).trim()}`,
            };
        }

        if (!fstabAlreadyHasSwapfile()) {
            try {
                // Leading newline guards against fstab files that
                // don't end with one (rare but real on edited hosts).
                await fsp.appendFile(FSTAB_PATH, `\n${FSTAB_ENTRY}\n`, { mode: 0o644 });
            } catch (err) {
                return { ok: false, error: `append ${FSTAB_PATH}: ${err.message}` };
            }
        }

        const freeGbAfter = bytesToGb(os.freemem());
        // eslint-disable-next-line no-console
        console.log(`${ENM_LOG_PREFIX} addSwap: 4 GB swapfile active at ${SWAPFILE_PATH}`);
        return { ok: true, freeGbAfter };
    } catch (err) {
        return { ok: false, error: `unexpected: ${err && err.message ? err.message : String(err)}` };
    }
}

module.exports = {
    runSystemCheck,
    addSwap,
    // Exported for tests + introspection (frontend wizard reads
    // THRESHOLDS to render "this path requires X" BEFORE the check
    // runs; individual check helpers let unit tests drive them with
    // synthetic inputs without spawning subprocesses).
    THRESHOLDS,
    checkOs,
    checkCpu,
    checkRam,
    checkRamRecommended,
    checkDisk,
    checkStorageType,
    resolveRootDevice,
    fstabAlreadyHasSwapfile,
    bytesToGb,
};

// Inline manual test. Operators can run on the target box:
//   ENM_INLINE_TEST=1 node enm-server/src/services/EnmSystemCheck.js
// Gated on the env var so the module stays import-safe.
if (process.env.ENM_INLINE_TEST === '1' && require.main === module) {
    (async function __test_inline() {
        try {
            const report = await runSystemCheck({ path: 'council' });
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(report, null, 2));
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`${ENM_LOG_PREFIX} inline test failed:`, err);
            process.exit(1);
        }
    })();
}
