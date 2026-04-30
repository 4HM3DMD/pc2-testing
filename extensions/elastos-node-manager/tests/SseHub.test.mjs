/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * SseHub tests — drive the hub against a fake Express response (PassThrough
 * stream that captures writes). Verifies subscribe / publish / fan-out /
 * cleanup-on-close / heartbeat / topic validation.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach, vi } from 'vitest';
const EventEmitter = require('node:events');

const { SseHub } = require('../lib/SseHub');

const fakeExt = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
};

/**
 * Minimal Express response shim. Captures every chunk written so tests can
 * assert on the wire format. Implements `on` for 'close' / 'error' so
 * SseHub's cleanup wiring works.
 */
function fakeRes() {
    const ee = new EventEmitter();
    const chunks = [];
    return {
        headers: {},
        chunks,
        ended: false,
        setHeader(k, v) { this.headers[k] = v; },
        flushHeaders() { /* no-op */ },
        write(s) { if (this.ended) throw new Error('write after end'); chunks.push(s); return true; },
        end() { this.ended = true; ee.emit('close'); },
        on: ee.on.bind(ee),
        emit: ee.emit.bind(ee),
        // Handy for tests:
        joinedText() { return chunks.join(''); },
    };
}

describe('SseHub', () => {
    let hub;

    beforeEach(() => {
        if (hub) { hub.close(); }
        hub = new SseHub({ extensionHandle: fakeExt });
    });

    it('rejects construction without extensionHandle', () => {
        expect(() => new SseHub({})).toThrow(TypeError);
    });

    it('subscribes a response and emits the connected greeting', () => {
        const res = fakeRes();
        hub.subscribe(res, { topics: ['system'], walletAddress: '0xabc' });
        expect(res.headers['Content-Type']).toBe('text/event-stream');
        expect(res.headers['Cache-Control']).toMatch(/no-cache/);
        expect(res.joinedText()).toMatch(/^: connected /);
        expect(hub.connectionCount()).toBe(1);
        expect(hub.subscriberCount('system')).toBe(1);
    });

    it('rejects invalid topic names', () => {
        const res = fakeRes();
        expect(() => hub.subscribe(res, { topics: ['BAD UPPER'] })).toThrow(TypeError);
        expect(() => hub.subscribe(res, { topics: ['has spaces'] })).toThrow(TypeError);
    });

    it('rejects too-many topics in one request', () => {
        const res = fakeRes();
        const tooMany = [];
        for (let i = 0; i < 32; i += 1) {
            tooMany.push('chains:c' + i + ':logs');
        }
        expect(() => hub.subscribe(res, { topics: tooMany })).toThrow(RangeError);
    });

    it('rejects empty topic list', () => {
        const res = fakeRes();
        expect(() => hub.subscribe(res, { topics: [] })).toThrow(RangeError);
    });

    it('publishes to all subscribers of a topic', () => {
        const a = fakeRes();
        const b = fakeRes();
        const c = fakeRes(); // different topic
        hub.subscribe(a, { topics: ['notifications'] });
        hub.subscribe(b, { topics: ['notifications', 'system'] });
        hub.subscribe(c, { topics: ['system'] });

        hub.publish('notifications', { hello: 'world' });

        expect(a.joinedText()).toMatch(/event: notifications/);
        expect(a.joinedText()).toMatch(/data: \{"hello":"world"\}/);
        expect(b.joinedText()).toMatch(/event: notifications/);
        expect(c.joinedText()).not.toMatch(/event: notifications/);
    });

    it('uses monotonic event ids', () => {
        const a = fakeRes();
        hub.subscribe(a, { topics: ['system'] });
        hub.publish('system', { n: 1 });
        hub.publish('system', { n: 2 });
        const text = a.joinedText();
        expect(text).toMatch(/id: 1\n/);
        expect(text).toMatch(/id: 2\n/);
    });

    it('drops subscribers whose write throws', () => {
        const a = fakeRes();
        hub.subscribe(a, { topics: ['system'] });
        // Force write to throw on next publish.
        a.write = () => { throw new Error('broken pipe'); };
        hub.publish('system', { x: 1 });
        // Subscriber should be cleaned up.
        expect(hub.subscriberCount('system')).toBe(0);
    });

    it('cleans up on response close', () => {
        const a = fakeRes();
        hub.subscribe(a, { topics: ['system', 'notifications'] });
        expect(hub.connectionCount()).toBe(1);
        a.end(); // emits 'close'
        expect(hub.connectionCount()).toBe(0);
        expect(hub.subscriberCount('system')).toBe(0);
        expect(hub.subscriberCount('notifications')).toBe(0);
    });

    it('close() ends every connection and clears state', () => {
        const a = fakeRes();
        const b = fakeRes();
        hub.subscribe(a, { topics: ['system'] });
        hub.subscribe(b, { topics: ['system'] });
        hub.close();
        expect(a.ended).toBe(true);
        expect(b.ended).toBe(true);
        expect(hub.connectionCount()).toBe(0);
    });

    it('publish to a topic with no subscribers is a no-op', () => {
        // Smoke: should not throw, should not increment any counters.
        expect(() => hub.publish('notifications', { x: 1 })).not.toThrow();
    });

    it('publishToWallet only writes to subscribers with matching wallet', () => {
        // Phase 4 audit, agent 2: healing notifications carry proposalIds and
        // must not fan out across wallets. Two operators connect; engine emits
        // a notification scoped to operator A — only A receives it.
        const a = fakeRes();
        const b = fakeRes();
        hub.subscribe(a, { topics: ['notifications'], walletAddress: '0xaaaa' });
        hub.subscribe(b, { topics: ['notifications'], walletAddress: '0xbbbb' });

        hub.publishToWallet('0xaaaa', 'notifications', { proposalId: 'enm_x' });
        expect(a.joinedText()).toContain('enm_x');
        expect(b.joinedText()).not.toContain('enm_x');
    });

    it('publishToWallet skips subscribers without a recorded wallet', () => {
        const anon = fakeRes();
        hub.subscribe(anon, { topics: ['notifications'] }); // walletAddress undefined
        hub.publishToWallet('0xaaaa', 'notifications', { proposalId: 'p1' });
        expect(anon.joinedText()).not.toContain('p1');
    });

    it('publishToWallet without a wallet arg is a no-op', () => {
        const a = fakeRes();
        hub.subscribe(a, { topics: ['notifications'], walletAddress: '0xaaaa' });
        hub.publishToWallet(null, 'notifications', { x: 1 });
        expect(a.joinedText()).not.toContain('"x":1');
    });
});
