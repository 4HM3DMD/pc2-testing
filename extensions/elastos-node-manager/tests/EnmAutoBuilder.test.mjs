/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAutoBuilder tests — exercise the state machine + SSE plumbing without
 * actually invoking git/make/tar/https. We construct an instance, reach
 * into the private state, and validate the public surface.
 *
 * Real-network/real-build tests live in the manual Phase 6 acceptance
 * suite — running git clone + make all in CI takes >5 min and burns
 * GitHub Actions minutes for marginal value over what we cover here.
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
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-autobuild-'));
    process.env.PC2_DATA_DIR = tmpRoot;
    process.env.ENM_DATA_DIR = path.join(tmpRoot, 'extensions', 'elastos-node-manager');
    fs.mkdirSync(process.env.ENM_DATA_DIR, { recursive: true });
});
afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/DataDir')];
    delete require.cache[require.resolve('../lib/EnmAutoBuilder')];
});

const fakeExt = { log: { info() {}, warn() {}, error() {}, debug() {} } };

function makeBuilder(sseHub) {
    const { EnmAutoBuilder } = require('../lib/EnmAutoBuilder');
    return new EnmAutoBuilder({ extensionHandle: fakeExt, sseHub: sseHub || null });
}

describe('EnmAutoBuilder — construction', () => {
    it('rejects missing extensionHandle', () => {
        const { EnmAutoBuilder } = require('../lib/EnmAutoBuilder');
        expect(() => new EnmAutoBuilder({})).toThrow(TypeError);
    });

    it('starts in idle phase with empty log', () => {
        const b = makeBuilder();
        const s = b.getStatus();
        expect(s.phase).toBe('idle');
        expect(s.logTail).toEqual([]);
        expect(s.error).toBeNull();
    });
});

describe('EnmAutoBuilder — state machine', () => {
    it('start() returns alreadyRunning=false on first call, true on second', () => {
        const b = makeBuilder();
        const r1 = b.start();
        expect(r1.alreadyRunning).toBe(false);
        const r2 = b.start();
        expect(r2.alreadyRunning).toBe(true);
        // Cancel so the background pipeline doesn't actually try to run.
        b.cancel();
    });

    it('cancel() transitions to cancelled phase', () => {
        const b = makeBuilder();
        b.start();
        b.cancel();
        expect(b.getStatus().phase).toBe('cancelled');
    });

    it('cancel() is idempotent on idle/done states', () => {
        const b = makeBuilder();
        // No build in flight — cancel should no-op without throwing.
        expect(() => b.cancel()).not.toThrow();
        expect(b.getStatus().phase).toBe('idle');
    });

    it('start() after a previous run resets state', () => {
        const b = makeBuilder();
        b.start();
        b.cancel();
        const r2 = b.start();
        expect(r2.alreadyRunning).toBe(false);
        expect(b.getStatus().error).toBeNull();
        b.cancel();
    });
});

describe('EnmAutoBuilder — SSE publishing', () => {
    it('publishes phase changes to setup:build topic', async () => {
        const events = [];
        const sseHub = {
            publish(topic, payload) { events.push({ topic, payload }); },
            publishToWallet(wallet, topic, payload) { events.push({ wallet, topic, payload }); },
        };
        const b = makeBuilder(sseHub);
        b.start();
        // The pipeline progressed at least to PREPARING and emitted 'Build started'.
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.every((e) => e.topic === 'setup:build')).toBe(true);
        b.cancel();
    });

    it('routes to publishToWallet when ownerWallet provided', () => {
        const events = [];
        const sseHub = {
            publish() { events.push({ kind: 'broadcast' }); },
            publishToWallet(wallet) { events.push({ kind: 'scoped', wallet }); },
        };
        const b = makeBuilder(sseHub);
        b.start({ ownerWallet: '0xowner' });
        const scoped = events.filter((e) => e.kind === 'scoped');
        expect(scoped.length).toBeGreaterThanOrEqual(1);
        expect(scoped[0].wallet).toBe('0xowner');
        b.cancel();
    });
});

describe('EnmAutoBuilder — exports', () => {
    it('exports PHASES, ELA_TAG, GO_VERSION, MIN_GO_VERSION', () => {
        const M = require('../lib/EnmAutoBuilder');
        expect(M.PHASES).toBeDefined();
        expect(M.PHASES.IDLE).toBe('idle');
        expect(M.PHASES.DONE).toBe('done');
        expect(typeof M.ELA_TAG).toBe('string');
        expect(M.ELA_TAG).toMatch(/^v\d+\.\d+\.\d+/);
        expect(typeof M.GO_VERSION).toBe('string');
        expect(typeof M.MIN_GO_VERSION).toBe('string');
    });
});
