/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmRpcClient — JSON-RPC 2.0 client for ELA mainchain.
 *
 * Talks to the operator's local ela process at 127.0.0.1:<rpcPort>. Auth is
 * HTTP Basic per servers/httpjsonrpc/server.go:258-281 (verified Rev 1 audit).
 *
 * Implementation choices:
 *   - Node's built-in `http` module — no extra dep
 *   - 10-second per-request timeout (matches dao-dashboard's pattern, Rev 5 audit)
 *   - No retries here; the SelfHealingEngine decides retry policy based on
 *     which failure mode (F2 RPC unreachable) the timeout hits
 *   - Single integer id per call (timestamp-based — fine for stateless RPC)
 *
 * RPC methods implemented (per Rev 1+3 audits, lines verified in
 * Elastos.ELA/servers/interfaces.go):
 *   - getblockcount        line 1269
 *   - getconnectioncount   line 1038
 *   - getnodestate         line 191  (replaces getpeers — does not exist)
 *   - getinfo              line 930
 *   - getbestblockhash     line 1261
 *   - getmininginfo        line 963
 *   - getrawmempool        line 1042
 *   - listproducers        line 2373
 *   - getproducerinfo      line 556
 *   - getarbitratorgroupbyheight line 1338
 */

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} RpcClientConfig
 * @property {string} host        defaults to '127.0.0.1'
 * @property {number} port        defaults to 20336
 * @property {string} user        HTTP Basic username (rpcuser from config.json)
 * @property {string} password    HTTP Basic password (decrypted before passing in)
 * @property {number} [timeoutMs] per-request timeout, default 10s
 */

class EnmRpcClient {
    /**
     * @param {RpcClientConfig} config
     */
    constructor(config) {
        if (!config || typeof config !== 'object') {
            throw new TypeError('EnmRpcClient: config object is required');
        }
        this.host = config.host || '127.0.0.1';
        this.port = config.port || 20336;
        if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
            throw new RangeError(`EnmRpcClient: invalid port ${this.port}`);
        }
        if (typeof config.user !== 'string' || typeof config.password !== 'string') {
            throw new TypeError('EnmRpcClient: user and password must be strings');
        }
        this.user = config.user;
        this.password = config.password;
        this.timeoutMs = Number.isInteger(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
        this._authHeader = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
    }

    /**
     * Generic JSON-RPC call. Throws on transport, HTTP, or RPC-level errors.
     *
     * @param {string} method
     * @param {object|Array} [params]
     * @returns {Promise<unknown>} result field of the RPC response
     */
    call(method, params) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                jsonrpc: '2.0',
                method,
                params: params == null ? {} : params,
                id: Date.now(),
            });

            const req = http.request({
                host: this.host,
                port: this.port,
                method: 'POST',
                path: '/',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Authorization': this._authHeader,
                },
                timeout: this.timeoutMs,
            }, (res) => {
                let chunks = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { chunks += c; });
                res.on('end', () => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        return reject(new RpcAuthError(
                            `RPC auth rejected (HTTP ${res.statusCode}). Check rpcuser/rpcpassword in config.json.`,
                        ));
                    }
                    if (res.statusCode === undefined || res.statusCode >= 500) {
                        return reject(new RpcTransportError(
                            `RPC server error: HTTP ${res.statusCode}`,
                        ));
                    }
                    let parsed;
                    try {
                        parsed = JSON.parse(chunks);
                    } catch (err) {
                        return reject(new RpcTransportError(
                            `RPC response was not JSON (HTTP ${res.statusCode}): ${err.message}`,
                        ));
                    }
                    if (parsed && parsed.error) {
                        return reject(new RpcMethodError(
                            (parsed.error && parsed.error.message) || 'RPC method error',
                            parsed.error.code,
                        ));
                    }
                    return resolve(parsed && parsed.result);
                });
            });

            req.on('timeout', () => {
                req.destroy(new RpcTransportError(`RPC timeout after ${this.timeoutMs}ms (method=${method})`));
            });
            req.on('error', (err) => {
                // ECONNREFUSED is the canonical "node not running" signal — F1/F2 cares about it.
                if (err && err.code === 'ECONNREFUSED') {
                    return reject(new RpcUnreachableError(`RPC connection refused at ${this.host}:${this.port}`));
                }
                reject(new RpcTransportError(err.message));
            });
            req.write(body);
            req.end();
        });
    }

    // --- Convenience wrappers around the v0.1 method set (Rev 1+3 audits) ---

    getblockcount() { return this.call('getblockcount'); }
    getconnectioncount() { return this.call('getconnectioncount'); }
    getnodestate() { return this.call('getnodestate'); }
    getinfo() { return this.call('getinfo'); }
    getbestblockhash() { return this.call('getbestblockhash'); }
    getmininginfo() { return this.call('getmininginfo'); }
    getrawmempool() { return this.call('getrawmempool'); }

    /**
     * Returns block header by hash. The header includes timestamp, which we
     * use to detect "synced" — if the latest block is within ~5 min of now,
     * the chain is fully caught up regardless of whether we can resolve the
     * network's tip from peers.
     *
     * @param {string} hash       hex block hash
     * @param {number} [verbose]  0 = raw bytes hex, 2 = decoded object (default)
     */
    getblockheader(hash, verbose = 2) {
        return this.call('getblockheader', { blockhash: hash, verbosity: verbose });
    }

    /**
     * Returns each connected peer's known best block height. We take the
     * max of these as the network's reference tip when computing sync
     * progress — more reliable than guessing from local-height drift,
     * because peers handshake quickly after start.
     *
     * Schema (per ela JSON-RPC docs): result is an array of objects
     * containing fields including `height` and `services`.
     */
    getpeerinfo() { return this.call('getpeerinfo'); }

    /**
     * @param {{ start?: number, limit?: number, state?: string }} [params]
     */
    listproducers(params) { return this.call('listproducers', params || { state: 'all' }); }

    /**
     * @param {string} publicKey  hex-encoded compressed pubkey (66 chars)
     */
    getproducerinfo(publicKey) { return this.call('getproducerinfo', { publickey: publicKey }); }

    /**
     * @param {number} height  uint32 block height
     */
    getarbitratorgroupbyheight(height) { return this.call('getarbitratorgroupbyheight', { height }); }

    /**
     * 0.2.0-alpha.7 — current DPoS rotation snapshot.
     *   ondutyarbiter:           hex of the producer signing the current round
     *   currentturnstartheight:  first height of the current rotation turn
     *   nextturnstartheight:     first height of the next rotation turn
     *   currentarbiters:         hex[] of producers in the active slate
     *   nextarbiters:            hex[] of producers queued for the next slate
     *   currentcandidates / nextcandidates: backup pool
     * No auth gate; same rate-limit bucket as getproducerinfo.
     */
    getarbitersinfo() { return this.call('getarbitersinfo', {}); }
}

// --- Error types — let the caller distinguish failure modes for healing rules. ---

class RpcError extends Error {
    constructor(message) { super(message); this.name = 'RpcError'; }
}
class RpcUnreachableError extends RpcError {
    constructor(message) { super(message); this.name = 'RpcUnreachableError'; }
}
class RpcTransportError extends RpcError {
    constructor(message) { super(message); this.name = 'RpcTransportError'; }
}
class RpcAuthError extends RpcError {
    constructor(message) { super(message); this.name = 'RpcAuthError'; }
}
class RpcMethodError extends RpcError {
    constructor(message, code) { super(message); this.name = 'RpcMethodError'; this.code = code; }
}

module.exports = {
    EnmRpcClient,
    RpcError,
    RpcUnreachableError,
    RpcTransportError,
    RpcAuthError,
    RpcMethodError,
    DEFAULT_TIMEOUT_MS,
};
