/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ProcessLogStreamer tests — drives a fake NativeProcessService (just an
 * EventEmitter) and a fake SseHub, then asserts on what gets published.
 *
 * Specifically verifies:
 *   - Per-line buffering: partial lines are held until a newline arrives
 *   - Batch flush on threshold (50 lines) AND on timer (100ms)
 *   - 4 KB cap per line with truncation suffix
 *   - Final flush on chain exit
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const EventEmitter = require('node:events');

const {
    ProcessLogStreamer,
    FLUSH_INTERVAL_MS,
    FLUSH_LINE_THRESHOLD,
    MAX_LINE_BYTES,
} = require('../lib/ProcessLogStreamer');

const fakeExt = { log: { info() {}, warn() {}, error() {}, debug() {} } };

function fakeProcessService() {
    const ee = new EventEmitter();
    return ee;
}

function fakeSseHub() {
    const published = [];
    return {
        published,
        publish(topic, data) { published.push({ topic, data }); },
        // Other methods unused in this test.
    };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('ProcessLogStreamer', () => {
    let proc;
    let hub;
    let streamer;

    /**
     * Simulate the lifecycle: started → ...chunks... → exit.
     * State is initialized only after `started`, mirroring real
     * NativeProcessService behavior (Phase 3 audit fix).
     */
    function startChain(chainId) {
        proc.emit('started', { chainId, pid: 1234, startedAt: Date.now() });
    }

    beforeEach(() => {
        proc = fakeProcessService();
        hub = fakeSseHub();
        streamer = new ProcessLogStreamer({
            processService: proc,
            sseHub: hub,
            extensionHandle: fakeExt,
        });
    });

    afterEach(() => {
        streamer.flushAll();
    });

    it('rejects construction with missing deps', () => {
        expect(() => new ProcessLogStreamer({})).toThrow(TypeError);
    });

    it('buffers a partial line until newline arrives', async () => {
        startChain('mainchain');
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from('partial') });
        await sleep(FLUSH_INTERVAL_MS + 30);
        expect(hub.published).toEqual([]);

        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from(' line\n') });
        await sleep(FLUSH_INTERVAL_MS + 30);
        expect(hub.published.length).toBe(1);
        expect(hub.published[0].topic).toBe('chains:mainchain:logs');
        expect(hub.published[0].data.chainId).toBe('mainchain');
        expect(hub.published[0].data.lines.length).toBe(1);
        expect(hub.published[0].data.lines[0].line).toBe('partial line');
    });

    it('flushes when the line threshold is reached', async () => {
        startChain('mainchain');
        const N = FLUSH_LINE_THRESHOLD;
        const blob = Array.from({ length: N }, (_, i) => 'line ' + i).join('\n') + '\n';
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from(blob) });
        // Threshold flush is synchronous after the chunk processing.
        await sleep(0);
        expect(hub.published.length).toBeGreaterThanOrEqual(1);
        const firstBatch = hub.published[0].data.lines;
        expect(firstBatch.length).toBeGreaterThanOrEqual(N);
    });

    it('flushes on the 100ms timer when below threshold', async () => {
        startChain('mainchain');
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from('only one\n') });
        await sleep(FLUSH_INTERVAL_MS + 30);
        expect(hub.published.length).toBe(1);
    });

    it('truncates lines longer than MAX_LINE_BYTES', async () => {
        startChain('mainchain');
        const huge = 'X'.repeat(MAX_LINE_BYTES + 200) + '\n';
        proc.emit('stderr', { chainId: 'mainchain', chunk: Buffer.from(huge) });
        await sleep(FLUSH_INTERVAL_MS + 30);
        expect(hub.published.length).toBe(1);
        const line = hub.published[0].data.lines[0].line;
        expect(line.length).toBeLessThanOrEqual(MAX_LINE_BYTES + 100);
        expect(line.endsWith('[...truncated]')).toBe(true);
    });

    it('separates stdout vs stderr into per-line entries', async () => {
        startChain('mainchain');
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from('out1\nout2\n') });
        proc.emit('stderr', { chainId: 'mainchain', chunk: Buffer.from('err1\n') });
        await sleep(FLUSH_INTERVAL_MS + 30);
        const all = hub.published.flatMap((p) => p.data.lines);
        const streams = all.map((l) => l.stream).sort();
        expect(streams).toEqual(['stderr', 'stdout', 'stdout']);
    });

    it('flushes remaining buffer on chain exit', async () => {
        startChain('mainchain');
        // Half-line: no newline yet.
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from('half') });
        proc.emit('exit', { chainId: 'mainchain', code: 0, signal: null, manualStop: true });
        await sleep(0);
        // The exit handler flushes both queue + tail-buffer.
        const all = hub.published.flatMap((p) => p.data.lines);
        expect(all.find((l) => l.line === 'half')).toBeTruthy();
    });

    it('drops chunks arriving after exit (no zombie state)', async () => {
        startChain('mainchain');
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from('before\n') });
        proc.emit('exit', { chainId: 'mainchain', code: 0, signal: null, manualStop: false });
        await sleep(FLUSH_INTERVAL_MS + 30);
        const beforeCount = hub.published.length;

        // Late chunk after exit — Node sometimes flushes child stdio asynchronously.
        proc.emit('stdout', { chainId: 'mainchain', chunk: Buffer.from('after-exit\n') });
        await sleep(FLUSH_INTERVAL_MS + 30);

        // No additional publish should happen — the post-exit chunk is dropped.
        expect(hub.published.length).toBe(beforeCount);
        const all = hub.published.flatMap((p) => p.data.lines);
        expect(all.find((l) => l.line === 'after-exit')).toBeFalsy();
    });

    it('drops chunks for chains that never started', async () => {
        // No `startChain` call — state never initialized.
        proc.emit('stdout', { chainId: 'never-started', chunk: Buffer.from('phantom\n') });
        await sleep(FLUSH_INTERVAL_MS + 30);
        expect(hub.published).toEqual([]);
    });
});
