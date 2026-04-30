/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * HealthChecker tests — drives the orchestrator with fake processService,
 * engine, and loadConfig so we can exercise the timeline state machine
 * without disk I/O or RPC. Verifies:
 *   - state initialization on first tick
 *   - firstPeerZeroAt set on peers=0, cleared on peers>0
 *   - firstHeightStallAt set on unchanged height, cleared on advance
 *   - manualStop captured via processService 'exit' event
 *   - tickNow drives all three buckets
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';
const EventEmitter = require('node:events');

const { HealthChecker } = require('../lib/HealthChecker');

const fakeExt = { log: { info() {}, warn() {}, error() {}, debug() {} } };

function fakeProc({ alive = true } = {}) {
    const ee = new EventEmitter();
    ee.statusSync = () => ({ alive, pid: alive ? 99 : null, attached: alive });
    return ee;
}

function fakeEngine() {
    return {
        applied: [],
        async apply(chainId, dets, cfg) {
            this.applied.push({ chainId, dets, cfg });
        },
    };
}

function fakeAdapter({ blockcount = 100, peers = 4, fail = false }) {
    const state = { blockcount, peers, fail };
    return {
        chainId: 'mainchain',
        rpcClient() {
            return {
                async getblockcount() {
                    if (state.fail) throw Object.assign(new Error('refused'), { name: 'RpcUnreachableError' });
                    return state.blockcount;
                },
                async getconnectioncount() {
                    if (state.fail) throw new Error('refused');
                    return state.peers;
                },
            };
        },
        _state: state,
    };
}

describe('HealthChecker', () => {
    let proc; let engine; let adapter; let checker;

    beforeEach(() => {
        proc = fakeProc();
        engine = fakeEngine();
        adapter = fakeAdapter({ blockcount: 100, peers: 4 });
        checker = new HealthChecker({
            extensionHandle: fakeExt,
            processService: proc,
            engine,
            listChains: () => [{ chainId: 'mainchain' }],
            getAdapter: () => adapter,
            loadConfig: async () => ({
                chains: {
                    mainchain: {
                        enabled: true,
                        binaryPath: '/usr/local/bin/ela',
                        binaryVersion: 'v0.9.9.5',
                        rpc: { passwordEncrypted: 'aes' },
                    },
                },
            }),
        });
    });

    it('rejects construction with missing deps', () => {
        expect(() => new HealthChecker({})).toThrow(TypeError);
    });

    it('initializes per-chain state lazily and records exit events', () => {
        proc.emit('exit', { chainId: 'mainchain', code: 0, signal: null, manualStop: true });
        const s = checker.state.get('mainchain');
        expect(s).toBeDefined();
        expect(s.lastExit).toEqual(expect.objectContaining({ code: 0, manualStop: true }));
    });

    it('sets firstPeerZeroAt when peers=0 in mediumTick, clears on >0', async () => {
        adapter._state.peers = 0;
        await checker.tickNow();
        const s1 = checker.state.get('mainchain');
        expect(s1.firstPeerZeroAt).toBeTypeOf('number');

        adapter._state.peers = 5;
        await checker.tickNow();
        expect(checker.state.get('mainchain').firstPeerZeroAt).toBeNull();
    });

    it('sets firstHeightStallAt when height unchanged across ticks, clears on advance', async () => {
        await checker.tickNow();
        // First tick recorded lastHeight=100. Second tick with same height arms stall.
        await checker.tickNow();
        const s1 = checker.state.get('mainchain');
        expect(s1.firstHeightStallAt).toBeTypeOf('number');

        adapter._state.blockcount = 101;
        await checker.tickNow();
        const s2 = checker.state.get('mainchain');
        expect(s2.firstHeightStallAt).toBeNull();
        expect(s2.lastHeight).toBe(101);
    });

    it('tickNow on disabled chain does not call engine.apply', async () => {
        checker.loadConfig = async () => ({
            chains: { mainchain: { enabled: false, binaryPath: '/x', rpc: { passwordEncrypted: 'a' } } },
        });
        await checker.tickNow();
        expect(engine.applied.length).toBe(0);
    });

    it('start/stop sets and clears interval timers idempotently', () => {
        checker.start();
        expect(checker._timers.fast).not.toBeNull();
        // Calling start again is a no-op (no double timers).
        checker.start();
        expect(checker._running).toBe(true);
        checker.stop();
        expect(checker._timers.fast).toBeNull();
        // Second stop is a no-op.
        checker.stop();
    });
});
