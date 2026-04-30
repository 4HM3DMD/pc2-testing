/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ExtIpResolver tests — drive a local http.Server as the IP-probe endpoint
 * so we don't depend on the live internet.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const http = require('node:http');

const ExtIpResolver = require('../lib/ExtIpResolver');

let server;
let endpoint;
/** @type {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void} */
let respond;

beforeAll(async () => {
    server = http.createServer((req, res) => respond(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    endpoint = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
    await new Promise((r) => server.close(r));
});

beforeEach(() => {
    ExtIpResolver._resetCacheForTests();
});

describe('ExtIpResolver.resolve', () => {
    it('parses a clean IPv4 response', async () => {
        respond = (req, res) => { res.writeHead(200); res.end('203.0.113.5\n'); };
        const r = await ExtIpResolver.resolve({ endpoint, force: true });
        expect(r.ok).toBe(true);
        expect(r.ip).toBe('203.0.113.5');
        expect(r.source).toBe('endpoint');
    });

    it('returns cached result on second call', async () => {
        respond = (req, res) => { res.writeHead(200); res.end('198.51.100.7\n'); };
        const a = await ExtIpResolver.resolve({ endpoint, force: true });
        respond = (req, res) => { res.writeHead(500); res.end('should not be called'); };
        const b = await ExtIpResolver.resolve({ endpoint });
        expect(b.ok).toBe(true);
        expect(b.ip).toBe(a.ip);
        expect(b.source).toBe('cache');
    });

    it('rejects non-IPv4 responses', async () => {
        respond = (req, res) => { res.writeHead(200); res.end('not-an-ip'); };
        const r = await ExtIpResolver.resolve({ endpoint, force: true });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/non-IPv4/);
    });

    it('reports endpoint failure with helpful message', async () => {
        respond = (req, res) => { res.writeHead(503); res.end('busy'); };
        const r = await ExtIpResolver.resolve({ endpoint, force: true });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/HTTP 503/);
    });

    it('honors timeout', async () => {
        respond = (req, res) => {
            // Hang forever — the timeout should abort us.
            // (No res.end.)
        };
        const r = await ExtIpResolver.resolve({ endpoint, force: true, timeoutMs: 200 });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/probe failed/);
    });
});

describe('ExtIpResolver.validateOverride', () => {
    it('accepts valid IPv4', () => {
        expect(ExtIpResolver.validateOverride('203.0.113.5')).toEqual({ ok: true, kind: 'ipv4' });
    });

    it('accepts hostnames and DDNS labels', () => {
        expect(ExtIpResolver.validateOverride('myhost.dyndns.org')).toEqual({ ok: true, kind: 'hostname' });
        expect(ExtIpResolver.validateOverride('example.com')).toEqual({ ok: true, kind: 'hostname' });
        expect(ExtIpResolver.validateOverride('a-b.c-d.e')).toEqual({ ok: true, kind: 'hostname' });
    });

    it('rejects empty / non-string', () => {
        expect(ExtIpResolver.validateOverride('').ok).toBe(false);
        expect(ExtIpResolver.validateOverride(null).ok).toBe(false);
    });

    it('rejects nonsense', () => {
        expect(ExtIpResolver.validateOverride('not valid!').ok).toBe(false);
        expect(ExtIpResolver.validateOverride('999.999.999.999').ok).toBe(false);
    });
});
