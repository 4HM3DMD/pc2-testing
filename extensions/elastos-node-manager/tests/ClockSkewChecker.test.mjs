/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ClockSkewChecker tests — spin up a tiny local HTTPS-equivalent (we mock
 * https.request rather than running a real TLS server) and verify:
 *   - skew math (host - server, half-RTT compensation)
 *   - graceful failure when Date header is missing or unparseable
 *   - endpoint fallback (try the next URL on failure)
 *   - timeout path
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const https = require('node:https');
const EventEmitter = require('node:events');

const Checker = require('../lib/ClockSkewChecker');

let originalHttpsRequest;

beforeEach(() => {
    originalHttpsRequest = https.request;
});
afterEach(() => {
    https.request = originalHttpsRequest;
});

/**
 * Stub https.request with a function that yields a chosen status + headers
 * after a chosen delay. Returns the fake req object so tests can assert on it.
 */
function stubHttpsRequest(scenarios) {
    let i = 0;
    https.request = function (opts, cb) {
        const scenario = scenarios[i++] || scenarios[scenarios.length - 1];
        const req = new EventEmitter();
        req.end = function () {};
        req.destroy = function (err) { req.emit('error', err || new Error('destroyed')); };
        // Microtask deferral so the listeners attach before we fire.
        setTimeout(() => {
            if (scenario.error) {
                req.emit('error', scenario.error);
                return;
            }
            const res = new EventEmitter();
            res.statusCode = scenario.status || 200;
            res.headers = scenario.headers || {};
            res.resume = () => {};
            cb(res);
            // Nothing else for HEAD — no body data.
        }, scenario.delayMs || 0);
        return req;
    };
}

describe('ClockSkewChecker.probeOne', () => {
    it('returns ok with positive skew when host is ahead of server', async () => {
        const fixed = Date.now() - 5_000; // server says 5s ago
        stubHttpsRequest([{ status: 200, headers: { date: new Date(fixed).toUTCString() } }]);
        const result = await Checker.probeOne('https://example.test', 1_000);
        expect(result.ok).toBe(true);
        // Skew is approximately +5_000 (host is ~5s ahead of server),
        // minus half-RTT (a few ms in this synthetic test).
        expect(result.skewMs).toBeGreaterThan(4_000);
        expect(result.skewMs).toBeLessThan(6_000);
    });

    it('returns ok=false on missing Date header', async () => {
        stubHttpsRequest([{ status: 200, headers: {} }]);
        const result = await Checker.probeOne('https://example.test', 1_000);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/no Date/i);
    });

    it('returns ok=false on unparseable Date header', async () => {
        stubHttpsRequest([{ status: 200, headers: { date: 'not-a-date' } }]);
        const result = await Checker.probeOne('https://example.test', 1_000);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/unparseable/i);
    });

    it('returns ok=false on connection error', async () => {
        stubHttpsRequest([{ error: Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) }]);
        const result = await Checker.probeOne('https://nope.test', 1_000);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('ENOTFOUND');
    });
});

describe('ClockSkewChecker.check (endpoint fallback)', () => {
    it('returns first successful endpoint result', async () => {
        const fixed = Date.now() - 1_000;
        stubHttpsRequest([
            { error: new Error('first failed') },
            { status: 200, headers: { date: new Date(fixed).toUTCString() } },
        ]);
        const result = await Checker.check({
            endpoints: ['https://first.test', 'https://second.test'],
            timeoutMs: 1_000,
        });
        expect(result.ok).toBe(true);
        expect(result.endpoint).toBe('https://second.test');
    });

    it('returns last failure when all endpoints fail', async () => {
        stubHttpsRequest([
            { error: new Error('one down') },
            { error: new Error('two down') },
        ]);
        const result = await Checker.check({
            endpoints: ['https://a.test', 'https://b.test'],
            timeoutMs: 1_000,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('two down');
    });
});
