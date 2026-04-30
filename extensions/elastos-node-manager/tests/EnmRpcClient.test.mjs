/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmRpcClient tests — drive a real http.Server in-process so we exercise the
 * Basic-auth header construction, JSON-RPC envelope, timeout, and error type
 * branches without any network mocking library.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const http = require('node:http');

const {
    EnmRpcClient,
    RpcAuthError,
    RpcMethodError,
    RpcUnreachableError,
} = require('../lib/EnmRpcClient');

let server;
let port;
/** @type {(req: import('http').IncomingMessage, res: import('http').ServerResponse, body: string) => void} */
let handle;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', () => handle(req, res, body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});

afterAll(async () => {
    await new Promise((r) => server.close(r));
});

function client(opts) {
    return new EnmRpcClient({
        host: '127.0.0.1',
        port,
        user: 'ela',
        password: 'pw',
        timeoutMs: 1500,
        ...opts,
    });
}

describe('EnmRpcClient', () => {
    it('sends a well-formed JSON-RPC 2.0 request with Basic auth', async () => {
        let captured = null;
        handle = (req, res, body) => {
            captured = { headers: req.headers, body };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', result: 12345, id: 1 }));
        };
        const result = await client().getblockcount();
        expect(result).toBe(12345);
        const parsed = JSON.parse(captured.body);
        expect(parsed.jsonrpc).toBe('2.0');
        expect(parsed.method).toBe('getblockcount');
        expect(parsed.params).toEqual({});
        // Basic auth header: base64 of "ela:pw"
        expect(captured.headers.authorization).toBe(`Basic ${Buffer.from('ela:pw').toString('base64')}`);
    });

    it('passes params through verbatim', async () => {
        let captured;
        handle = (req, res, body) => {
            captured = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: 'ok' }));
        };
        await client().listproducers({ start: 0, limit: 5, state: 'active' });
        expect(captured.method).toBe('listproducers');
        expect(captured.params).toEqual({ start: 0, limit: 5, state: 'active' });
    });

    it('throws RpcAuthError on HTTP 401', async () => {
        handle = (req, res) => {
            res.writeHead(401);
            res.end('unauthorized');
        };
        await expect(client().getblockcount()).rejects.toBeInstanceOf(RpcAuthError);
    });

    it('throws RpcMethodError when response includes error.code', async () => {
        handle = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: -32601, message: 'method not found' } }));
        };
        await expect(client().call('nope'))
            .rejects.toMatchObject({ name: 'RpcMethodError', code: -32601 });
    });

    it('throws RpcUnreachableError when the port is closed', async () => {
        const dead = new EnmRpcClient({
            host: '127.0.0.1',
            port: 1, // privileged + unbound
            user: 'ela',
            password: 'pw',
            timeoutMs: 500,
        });
        await expect(dead.getblockcount()).rejects.toBeInstanceOf(RpcUnreachableError);
    });

    it('rejects invalid construction', () => {
        expect(() => new EnmRpcClient(null)).toThrow(TypeError);
        expect(() => new EnmRpcClient({ user: 'a', password: 'b', port: 99999 }))
            .toThrow(RangeError);
        expect(() => new EnmRpcClient({ user: 1, password: 'b' })).toThrow(TypeError);
    });
});
