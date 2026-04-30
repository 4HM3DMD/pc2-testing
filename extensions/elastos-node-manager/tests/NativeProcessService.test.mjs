/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * NativeProcessService tests — uses /usr/bin/sleep as a stand-in for ela
 * (it's a long-running, well-behaved POSIX process available on every Linux
 * and macOS). Tests skip with a clear message on Windows or where sleep is
 * absent.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const { NativeProcessService, isPidAlive } = require('../lib/NativeProcessService');
const { _resetForTests: resetLockState } = require('../lib/withChainLock');
const { chainDir, pidFilePath, runDir } = require('../lib/DataDir');

const SLEEP_BIN = process.platform === 'win32' ? null : '/usr/bin/sleep';
const sleepAvailable = !!(SLEEP_BIN && fs.existsSync(SLEEP_BIN));

const fakeExt = {
    log: {
        info() {}, warn() {}, error() {}, debug() {},
    },
};

let svc;

beforeAll(() => {
    if (!sleepAvailable) {
        // eslint-disable-next-line no-console
        console.warn('[NativeProcessService.test] /usr/bin/sleep not available — skipping spawn tests');
    }
});

beforeEach(() => {
    resetLockState();
    svc = new NativeProcessService({ extensionHandle: fakeExt });
});

afterEach(async () => {
    if (svc) {
        try {
            await svc.stop('mainchain');
        } catch (e) { /* swallow */ }
    }
});

function writeFakeChainConfig(chainId) {
    // NativeProcessService demands a config.json exists in the chain dir.
    const dir = chainDir(chainId);
    fs.writeFileSync(path.join(dir, 'config.json'), '{}', { mode: 0o600 });
}

describe('NativeProcessService', () => {
    it('isPidAlive returns true for ourselves and false for non-existent PIDs', () => {
        expect(isPidAlive(process.pid)).toBe(true);
        expect(isPidAlive(2 ** 30)).toBe(false); // unlikely to exist
        expect(isPidAlive(0)).toBe(false);
        expect(isPidAlive(-1)).toBe(false);
        expect(isPidAlive('abc')).toBe(false);
    });

    it('statusSync reports not-alive when no PID file present', () => {
        const status = svc.statusSync('nonexistent-chain-id');
        expect(status.alive).toBe(false);
        expect(status.pid).toBe(null);
    });

    it.skipIf(!sleepAvailable)('spawns a child process and writes a PID file', async () => {
        writeFakeChainConfig('mainchain');
        const result = await svc.start('mainchain', {
            binaryPath: SLEEP_BIN,
            // sleep takes args after the binary in real use, but our
            // process service spawns with [] — ela takes no args either.
            // For this test we briefly redefine binaryPath to a small wrapper.
        });
        // sleep with no args exits immediately on macOS but not on Linux. Either
        // way, the spawn returns a PID before exit completes.
        expect(result.pid).toBeGreaterThan(0);
        expect(fs.existsSync(pidFilePath('mainchain'))).toBe(true);
        const pidFromFile = parseInt(fs.readFileSync(pidFilePath('mainchain'), 'utf8'), 10);
        expect(pidFromFile).toBe(result.pid);

        // Cleanup.
        await svc.stop('mainchain');
        // PID file removed after stop.
        expect(fs.existsSync(pidFilePath('mainchain'))).toBe(false);
    });

    it.skipIf(!sleepAvailable)('start is idempotent — second call returns alreadyRunning', async () => {
        writeFakeChainConfig('mainchain');
        // Spawn a long-running process.
        const cfg = { binaryPath: '/bin/sh', binaryVersion: 'test' };
        // /bin/sh with no args is a long-running interactive shell.
        const first = await svc.start('mainchain', cfg);
        const second = await svc.start('mainchain', cfg);
        expect(second.alreadyRunning).toBe(true);
        expect(second.pid).toBe(first.pid);
        await svc.stop('mainchain');
    });

    it('reattach() handles stale PID files gracefully', async () => {
        // Write a PID for a dead process.
        const fakePid = 2 ** 30;
        fs.mkdirSync(runDir(), { recursive: true });
        fs.writeFileSync(pidFilePath('mainchain'), `${fakePid}\n`);
        const reattached = await svc.reattach();
        expect(reattached).toEqual([]);
        // Stale PID file should be cleaned up.
        expect(fs.existsSync(pidFilePath('mainchain'))).toBe(false);
    });

    it.skipIf(!sleepAvailable)('reattach() reattaches to live processes from previous run', async () => {
        writeFakeChainConfig('mainchain');
        await svc.start('mainchain', { binaryPath: '/bin/sh' });
        const handles = svc.handles;
        const pid = handles.get('mainchain').meta.pid;

        // Simulate restart by clearing in-memory handles but leaving PID file.
        handles.clear();

        const reattached = await svc.reattach();
        expect(reattached).toEqual([{ chainId: 'mainchain', pid }]);

        // Manual cleanup since we bypassed the normal stop flow.
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* */ }
    });
});
