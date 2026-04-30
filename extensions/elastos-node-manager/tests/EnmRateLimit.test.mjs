/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmRateLimit middleware tests — security-relevant. Verifies the limiter
 * actually rejects above-threshold requests, sets the X-RateLimit-* headers,
 * and isolates buckets by (scope + wallet + endpoint).
 *
 * We don't spin up an Express server — we drive the middleware function
 * directly with a minimal req/res shim. Lighter and faster than supertest.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';

const { limit, SCOPE_LIMITS, _resetForTests } = require('../lib/EnmRateLimit');

/**
 * Fake req/res. The limiter only reads req.actor.wallet_address (via
 * readActorWallet), req.ip, req.route.path, req.path. The rest is unused.
 */
function makeReq({ wallet, endpoint = '/test', ip = '127.0.0.1' } = {}) {
    return {
        actor: wallet ? { wallet_address: wallet } : undefined,
        ip,
        route: { path: endpoint },
        path: endpoint,
    };
}

function makeRes() {
    const headers = {};
    let statusCode = 200;
    let body = null;
    return {
        statusCode,
        setHeader(k, v) { headers[k] = v; },
        getHeader(k)    { return headers[k]; },
        status(code)    { statusCode = code; this.statusCode = code; return this; },
        json(payload)   { body = payload; return this; },
        get _body()     { return body; },
        get _headers()  { return headers; },
    };
}

beforeEach(() => {
    _resetForTests();
});

describe('EnmRateLimit.limit', () => {
    it('rejects unknown scope at construction time', () => {
        expect(() => limit('unknown')).toThrow(/unknown scope/);
    });

    it('emits X-RateLimit-* headers on every request', () => {
        const mw = limit('read');
        const req = makeReq({ wallet: '0x1' });
        const res = makeRes();
        let nextCalled = false;
        mw(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(res._headers['X-RateLimit-Limit']).toBe(String(SCOPE_LIMITS.read.max));
        expect(res._headers['X-RateLimit-Remaining']).toBe(String(SCOPE_LIMITS.read.max - 1));
        expect(res._headers['X-RateLimit-Reset']).toMatch(/^\d+$/);
    });

    it('returns 429 once over limit', () => {
        const mw = limit('admin'); // 10 req/min — easiest to exhaust
        const wallet = '0xover';
        let allowed = 0;
        let rejected = 0;
        for (let i = 0; i < SCOPE_LIMITS.admin.max + 5; i += 1) {
            const req = makeReq({ wallet });
            const res = makeRes();
            mw(req, res, () => { allowed += 1; });
            if (res.statusCode === 429) {
                rejected += 1;
            }
        }
        expect(allowed).toBe(SCOPE_LIMITS.admin.max);
        expect(rejected).toBe(5);
    });

    it('sets Retry-After when 429', () => {
        const mw = limit('admin');
        const wallet = '0xretry';
        for (let i = 0; i < SCOPE_LIMITS.admin.max; i += 1) {
            mw(makeReq({ wallet }), makeRes(), () => {});
        }
        const res = makeRes();
        mw(makeReq({ wallet }), res, () => {});
        expect(res.statusCode).toBe(429);
        const retry = parseInt(res._headers['Retry-After'], 10);
        expect(retry).toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(60);
        expect(res._body.success).toBe(false);
        expect(res._body.error).toMatch(/Rate limit/);
    });

    it('isolates buckets by wallet', () => {
        const mw = limit('admin');
        // Wallet A exhausts its budget.
        for (let i = 0; i < SCOPE_LIMITS.admin.max; i += 1) {
            mw(makeReq({ wallet: '0xa' }), makeRes(), () => {});
        }
        // Wallet B should still be allowed.
        const res = makeRes();
        let nextCalled = false;
        mw(makeReq({ wallet: '0xb' }), res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBe(200);
    });

    it('isolates buckets by endpoint', () => {
        const mw = limit('admin');
        const wallet = '0xc';
        for (let i = 0; i < SCOPE_LIMITS.admin.max; i += 1) {
            mw(makeReq({ wallet, endpoint: '/foo' }), makeRes(), () => {});
        }
        // Different endpoint → fresh bucket.
        const res = makeRes();
        let nextCalled = false;
        mw(makeReq({ wallet, endpoint: '/bar' }), res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBe(200);
    });

    it('falls back to anon:<ip> when no wallet', () => {
        const mw = limit('admin');
        // Two anonymous clients on the same IP exhaust together.
        for (let i = 0; i < SCOPE_LIMITS.admin.max; i += 1) {
            mw(makeReq({ ip: '203.0.113.1' }), makeRes(), () => {});
        }
        const res = makeRes();
        mw(makeReq({ ip: '203.0.113.1' }), res, () => {});
        expect(res.statusCode).toBe(429);
        // Different IP — fresh bucket.
        const res2 = makeRes();
        let nextCalled = false;
        mw(makeReq({ ip: '198.51.100.7' }), res2, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(res2.statusCode).toBe(200);
    });
});
