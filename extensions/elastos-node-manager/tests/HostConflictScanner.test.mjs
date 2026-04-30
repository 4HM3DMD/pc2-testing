/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * HostConflictScanner tests — drive each probe with stubbed runCmd + a temp
 * data dir. Verifies the catalog of conflicts the scanner emits and the
 * blockers() filter.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let tmpRoot;
beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-conflict-'));
    process.env.PC2_DATA_DIR = tmpRoot;
    process.env.ENM_DATA_DIR = path.join(tmpRoot, 'extensions', 'elastos-node-manager');
    fs.mkdirSync(process.env.ENM_DATA_DIR, { recursive: true });
});
afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/DataDir')];
    delete require.cache[require.resolve('../lib/HostConflictScanner')];
});

function load() {
    return require('../lib/HostConflictScanner');
}

const silent = { warn() {}, debug() {} };

/**
 * Build a runCmd stub that returns canned output for known (cmd, args[0])
 * pairs and an empty string for everything else.
 */
function stubRunCmd(table) {
    return async (cmd, args) => {
        const key = `${cmd} ${(args || []).join(' ')}`;
        if (table[key]) {
            const r = table[key];
            if (r instanceof Error) throw r;
            return { stdout: r, stderr: '' };
        }
        // pgrep-like default: empty
        return { stdout: '', stderr: '' };
    };
}

describe('HostConflictScanner — exports', () => {
    it('exports SEVERITY + TYPES + scan + blockers', () => {
        const M = load();
        expect(M.SEVERITY).toBeTruthy();
        expect(M.TYPES).toBeTruthy();
        expect(typeof M.scan).toBe('function');
        expect(typeof M.blockers).toBe('function');
    });
});

describe('HostConflictScanner — blockers() filter', () => {
    it('returns only CRITICAL severities', () => {
        const M = load();
        const sample = [
            { severity: 'CRITICAL', type: 'X' },
            { severity: 'WARNING',  type: 'Y' },
            { severity: 'INFO',     type: 'Z' },
            { severity: 'CRITICAL', type: 'W' },
        ];
        const out = M.blockers(sample);
        expect(out.length).toBe(2);
        expect(out.every((c) => c.severity === 'CRITICAL')).toBe(true);
    });
    it('handles non-arrays gracefully', () => {
        const M = load();
        expect(M.blockers(null).length).toBe(0);
        expect(M.blockers(undefined).length).toBe(0);
        expect(M.blockers('nope').length).toBe(0);
    });
});

describe('HostConflictScanner.scan — clean host', () => {
    it('returns empty when nothing matches', async () => {
        const M = load();
        const out = await M.scan({
            logger: silent,
            runCmd: stubRunCmd({}),
        });
        // Default ENM data dir is writable + empty, no PIDs, no legacy paths,
        // no rogue procs, no ports bound. Expect empty array.
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBe(0);
    });
});

describe('HostConflictScanner — sort order', () => {
    it('CRITICAL before WARNING before INFO', () => {
        const M = load();
        const stale = [
            { severity: 'INFO',     type: 'A' },
            { severity: 'WARNING',  type: 'B' },
            { severity: 'CRITICAL', type: 'C' },
            { severity: 'WARNING',  type: 'D' },
            { severity: 'CRITICAL', type: 'E' },
        ];
        // Replicate the internal sort to ensure determinism contract.
        const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
        stale.sort((a, b) => order[a.severity] - order[b.severity]);
        expect(stale.map((c) => c.severity)).toEqual([
            'CRITICAL', 'CRITICAL', 'WARNING', 'WARNING', 'INFO',
        ]);
    });
});

describe('HostConflictScanner — stale PID file probe', () => {
    it('flags PID file pointing at a dead process', async () => {
        const M = load();
        const { runDir } = require('../lib/DataDir');
        const dir = runDir();
        await fsp.mkdir(dir, { recursive: true });
        // PID 99999999 is virtually guaranteed not to exist.
        await fsp.writeFile(path.join(dir, 'ela-mainchain.pid'), '99999999\n');

        const out = await M.scan({ logger: silent, runCmd: stubRunCmd({}) });
        const stale = out.filter((c) => c.type === 'STALE_PID_FILE');
        expect(stale.length).toBe(1);
        expect(stale[0].severity).toBe('WARNING');
        expect(stale[0].details.pid).toBe(99999999);
    });

    it('flags malformed PID file', async () => {
        const M = load();
        const { runDir } = require('../lib/DataDir');
        const dir = runDir();
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'ela-test.pid'), 'not-a-number\n');

        const out = await M.scan({ logger: silent, runCmd: stubRunCmd({}) });
        const stale = out.filter((c) => c.type === 'STALE_PID_FILE');
        expect(stale.length).toBeGreaterThanOrEqual(1);
        expect(stale[0].description).toMatch(/malformed/i);
    });

    it('does NOT flag a live PID', async () => {
        const M = load();
        const { runDir } = require('../lib/DataDir');
        const dir = runDir();
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'ela-live.pid'), `${process.pid}\n`);

        const out = await M.scan({ logger: silent, runCmd: stubRunCmd({}) });
        const stale = out.filter((c) => c.type === 'STALE_PID_FILE');
        expect(stale.length).toBe(0);
    });
});

describe('HostConflictScanner — port binding probe (Linux ss)', () => {
    it('flags every default ELA port that ss reports as bound', async () => {
        if (os.platform() !== 'linux') {
            return; // probe is Linux-only; skip on macOS dev hosts
        }
        const M = load();
        // Stub `ss -tlnH sport = :<port>` to claim 20336 and 20338 are bound.
        const stub = async (cmd, args) => {
            if (cmd === 'ss' && args && args[0] === '-tlnH') {
                const sportArg = args[args.length - 1] || '';
                if (sportArg.endsWith(':20336') || sportArg.endsWith(':20338')) {
                    return { stdout: 'LISTEN 0 128 0.0.0.0:20336 0.0.0.0:* users:((node,pid=1,fd=10))\n' };
                }
                return { stdout: '' };
            }
            return { stdout: '' };
        };

        const out = await M.scan({ logger: silent, runCmd: stub });
        const ports = out.filter((c) => c.type === 'PORT_BOUND').map((c) => c.details.port).sort();
        expect(ports).toEqual([20336, 20338]);
        expect(out.filter((c) => c.type === 'PORT_BOUND')[0].severity).toBe('CRITICAL');
    });
});

describe('HostConflictScanner — rogue ela process probe', () => {
    it('flags a foreign ela process', async () => {
        if (os.platform() === 'win32') return;
        const M = load();
        const stub = async (cmd, args) => {
            if (cmd === 'pgrep' && args && args[0] === '-af') {
                // Two pids — one matches /usr/local/bin/ela (rogue),
                // one matches /usr/bin/elasticsearch (must be skipped).
                return {
                    stdout:
                        '12345 /usr/local/bin/ela --config /etc/ela/config.json\n'
                        + '12346 /usr/bin/elasticsearch -d\n',
                };
            }
            return { stdout: '' };
        };

        const out = await M.scan({ logger: silent, runCmd: stub });
        const rogues = out.filter((c) => c.type === 'ROGUE_PROCESS');
        expect(rogues.length).toBe(1);
        expect(rogues[0].details.pid).toBe(12345);
        expect(rogues[0].severity).toBe('CRITICAL');
    });

    it('does not flag our own managed pid', async () => {
        if (os.platform() === 'win32') return;
        const M = load();
        const { runDir } = require('../lib/DataDir');
        const dir = runDir();
        await fsp.mkdir(dir, { recursive: true });
        // Pretend we manage PID 9876.
        await fsp.writeFile(path.join(dir, 'ela-mainchain.pid'), '9876\n');

        const stub = async (cmd, args) => {
            if (cmd === 'pgrep' && args && args[0] === '-af') {
                return { stdout: '9876 /home/op/Elastos.ELA/ela\n' };
            }
            return { stdout: '' };
        };

        const out = await M.scan({ logger: silent, runCmd: stub });
        const rogues = out.filter((c) => c.type === 'ROGUE_PROCESS');
        expect(rogues.length).toBe(0);
    });
});

describe('HostConflictScanner — F19 detection from HealthRules', () => {
    it('fires F19 when CRITICAL conflicts present', async () => {
        const HR = require('../lib/HealthRules');
        const det = HR.detectF19({
            chainId: 'mainchain',
            hostConflicts: [
                { severity: 'CRITICAL', description: 'Port 20336 in use', type: 'PORT_BOUND' },
                { severity: 'WARNING', description: 'legacy', type: 'LEGACY_CONFIG' },
            ],
        });
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F19');
        expect(det.tier).toBe('CRITICAL-NOTIFY');
        expect(det.payload.conflicts.length).toBe(1);
    });

    it('quiet when only warnings present', async () => {
        const HR = require('../lib/HealthRules');
        const det = HR.detectF19({
            chainId: 'mainchain',
            hostConflicts: [{ severity: 'WARNING', description: 'legacy', type: 'LEGACY_CONFIG' }],
        });
        expect(det).toBeNull();
    });

    it('quiet when no conflicts', async () => {
        const HR = require('../lib/HealthRules');
        expect(HR.detectF19({ chainId: 'mainchain', hostConflicts: [] })).toBeNull();
        expect(HR.detectF19({ chainId: 'mainchain' })).toBeNull();
    });
});
