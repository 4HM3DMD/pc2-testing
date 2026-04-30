/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Diagnostics tests — feed runFullDiagnose with stub deps and assert the
 * resulting findings array. Each scenario exercises a different finding so
 * the diagnose UI gets the right signal.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let tmpRoot;
beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-diag-'));
    process.env.PC2_DATA_DIR = tmpRoot;
    process.env.ENM_DATA_DIR = path.join(tmpRoot, 'extensions', 'elastos-node-manager');
    fs.mkdirSync(process.env.ENM_DATA_DIR, { recursive: true });
});
afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/DataDir')];
    delete require.cache[require.resolve('../lib/Diagnostics')];
});

const fakeProc = { statusSync: () => ({ alive: false, pid: null, attached: false }) };
const fakeAdapter = {
    chainId: 'mainchain',
    rpcClient: () => ({
        async getblockcount() { return 100; },
        async getconnectioncount() { return 0; },
    }),
};

describe('Diagnostics.runFullDiagnose', () => {
    it('reports config-missing when chainConfig is null', async () => {
        const { runFullDiagnose, STATUS } = require('../lib/Diagnostics');
        const out = await runFullDiagnose({
            chainId: 'mainchain',
            chainConfig: null,
            processService: fakeProc,
            adapter: fakeAdapter,
        });
        expect(out.findings.length).toBe(1);
        expect(out.findings[0].status).toBe(STATUS.FAIL);
        expect(out.findings[0].id).toBe('config-missing');
    });

    it('reports binary-path FAIL when binaryPath is missing', async () => {
        const { runFullDiagnose, STATUS } = require('../lib/Diagnostics');
        const out = await runFullDiagnose({
            chainId: 'mainchain',
            chainConfig: {
                enabled: true,
                binaryPath: '/nonexistent/path/to/ela',
                rpc: { passwordEncrypted: 'x', user: 'ela' },
                ports: {
                    rpc: 20336, nodePort: 20338, httpInfo: 20333,
                    httpRest: 20334, httpWs: 20335, dpos: 20339,
                },
                dpos: { enableArbiter: false, ipAddressMode: 'auto' },
                dataDir: '/tmp',
                memoryLimitMb: 4096,
                logLevel: 'info',
            },
            processService: fakeProc,
            adapter: fakeAdapter,
        });
        const binFinding = out.findings.find((f) => f.id === 'binary-path');
        expect(binFinding).toBeDefined();
        expect(binFinding.status).toBe(STATUS.FAIL);
    });

    it('reports process-state FAIL with restart auto-fix when enabled but dead', async () => {
        const { runFullDiagnose, STATUS, AUTO_FIX_ACTIONS } = require('../lib/Diagnostics');
        // Use a real existing executable so the binary check passes.
        const out = await runFullDiagnose({
            chainId: 'mainchain',
            chainConfig: {
                enabled: true,
                binaryPath: '/bin/sh', // real, executable, passes static check
                rpc: { passwordEncrypted: 'x', user: 'ela' },
                ports: {
                    rpc: 20336, nodePort: 20338, httpInfo: 20333,
                    httpRest: 20334, httpWs: 20335, dpos: 20339,
                },
                dpos: { enableArbiter: false, ipAddressMode: 'auto' },
                dataDir: '/tmp',
                memoryLimitMb: 4096,
                logLevel: 'info',
            },
            processService: fakeProc,
            adapter: fakeAdapter,
        });
        const procFinding = out.findings.find((f) => f.id === 'process-state');
        expect(procFinding).toBeDefined();
        expect(procFinding.status).toBe(STATUS.FAIL);
        expect(procFinding.autoFix).toBe(AUTO_FIX_ACTIONS.RESTART_CHAIN);
    });

    it('reports zero-peers FAIL when alive but peers=0', async () => {
        const { runFullDiagnose, STATUS, AUTO_FIX_ACTIONS } = require('../lib/Diagnostics');
        const aliveProc = { statusSync: () => ({ alive: true, pid: 99, attached: true }) };
        const out = await runFullDiagnose({
            chainId: 'mainchain',
            chainConfig: {
                enabled: true,
                binaryPath: '/bin/sh',
                rpc: { passwordEncrypted: 'x', user: 'ela' },
                ports: {
                    rpc: 20336, nodePort: 20338, httpInfo: 20333,
                    httpRest: 20334, httpWs: 20335, dpos: 20339,
                },
                dpos: { enableArbiter: false, ipAddressMode: 'auto' },
                dataDir: '/tmp',
                memoryLimitMb: 4096,
                logLevel: 'info',
            },
            processService: aliveProc,
            adapter: fakeAdapter,
        });
        const peerFinding = out.findings.find((f) => f.id === 'peer-count');
        expect(peerFinding).toBeDefined();
        expect(peerFinding.status).toBe(STATUS.FAIL);
        expect(peerFinding.autoFix).toBe(AUTO_FIX_ACTIONS.RESTART_CHAIN);
    });

    it('summary counts all status buckets', async () => {
        const { runFullDiagnose } = require('../lib/Diagnostics');
        const out = await runFullDiagnose({
            chainId: 'mainchain',
            chainConfig: null,
            processService: fakeProc,
            adapter: fakeAdapter,
        });
        expect(out.summary).toBeDefined();
        expect(out.summary.fail).toBeGreaterThanOrEqual(1);
    });
});

describe('Diagnostics.AUTO_FIX_ACTIONS', () => {
    it('exposes the whitelist as constants (so route can validate)', () => {
        const { AUTO_FIX_ACTIONS } = require('../lib/Diagnostics');
        expect(AUTO_FIX_ACTIONS.REMOVE_STALE_PID).toBe('remove-stale-pid');
        expect(AUTO_FIX_ACTIONS.RESTART_CHAIN).toBe('restart-chain');
        expect(AUTO_FIX_ACTIONS.CONFIG_ROLLBACK).toBe('config-rollback');
        expect(AUTO_FIX_ACTIONS.CLEAR_LEVELDB_LOCK).toBe('clear-leveldb-lock');
        expect(Object.values(AUTO_FIX_ACTIONS).length).toBe(4);
    });
});
