/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/api.js — REST client for /api/* with TTL cache.
 *
 * Mirrors dao-dashboard's pattern (verified Rev 1 audit):
 *   - 10s per-request timeout (AbortController)
 *   - In-memory cache, default 30s TTL for GETs
 *   - Standard PC2 error format: { success, result } or { success, error }
 *
 * Mutations always bypass the cache and invalidate keys that share the same
 * resource prefix. Example: POST /chains/mainchain/start invalidates GET
 * /chains and GET /chains/mainchain.
 */

(function (root) {
    'use strict';

    var DEFAULT_TIMEOUT_MS = 10_000;
    var DEFAULT_CACHE_TTL_MS = 30_000;

    // ENM is now a PC2 app served from /apps/elastos-node-manager/, with its
    // backend running as a sidecar (enm-server) on port 4180. The desktop
    // launcher passes the operator's PC2 session token via the standard
    // ?puter.auth.token=... query param (matches pc2-node middleware.ts:100).
    // We forward it as a Bearer header on every request so enm-server's
    // OwnerCheckMiddleware can resolve it against pc2-node's session DB.
    function deriveBackendBase() {
        var port = (root.ENM_BACKEND_PORT && String(root.ENM_BACKEND_PORT)) || '4180';
        var loc = root.location || {};
        var host = loc.hostname || 'localhost';
        var protocol = (loc.protocol === 'https:') ? 'https:' : 'http:';
        return protocol + '//' + host + ':' + port + '/api/enm';
    }

    function deriveAuthToken() {
        var loc = root.location || {};
        var search = loc.search || '';
        var params;
        try { params = new URLSearchParams(search); }
        catch (_) { return null; }
        return params.get('puter.auth.token')
            || params.get('auth_token')
            || params.get('token')
            || null;
    }

    var API_BASE = deriveBackendBase();
    var AUTH_TOKEN = deriveAuthToken();

    function ApiClient(opts) {
        this.base = (opts && opts.base) || API_BASE;
        this.token = (opts && opts.token) || AUTH_TOKEN;
        this.timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
        this.cacheTtlMs = (opts && opts.cacheTtlMs) || DEFAULT_CACHE_TTL_MS;
        this._cache = new Map(); // key -> { value, expiresAt }
        // alpha.28.1 batch 17 (audit a4bcd049, finding #1): in-flight
        // dedup. Two get('/chains') 50ms apart used to fire two network
        // round-trips because the cache only populates on resolve. Now
        // the second call returns the same pending promise.
        this._inflight = new Map(); // key -> Promise
    }

    /**
     * GET with cache.
     * @param {string} path  e.g. '/chains' (no leading API_BASE)
     * @param {object} [opts]
     * @param {boolean} [opts.skipCache]
     * @returns {Promise<*>} resolves to the response's `result` field
     */
    ApiClient.prototype.get = function (path, opts) {
        var key = 'GET ' + path;
        var skipCache = !!(opts && opts.skipCache);
        if (!skipCache) {
            var cached = this._cache.get(key);
            if (cached && cached.expiresAt > Date.now()) {
                return Promise.resolve(cached.value);
            }
        }
        // In-flight dedup — any subsequent caller asking for the same
        // path while a fetch is pending gets the existing promise back.
        // Bypasses dedup when skipCache is true so callers that
        // explicitly want a fresh network roundtrip can still get one.
        if (!skipCache && this._inflight.has(key)) {
            return this._inflight.get(key);
        }
        var self = this;
        var p = this._fetch('GET', path).then(function (result) {
            self._cache.set(key, { value: result, expiresAt: Date.now() + self.cacheTtlMs });
            self._pruneCache();
            return result;
        }).finally(function () {
            self._inflight.delete(key);
        });
        if (!skipCache) { this._inflight.set(key, p); }
        return p;
    };

    /**
     * @private
     * Opportunistic prune — call after every successful insert. Drops
     * entries whose expiresAt is already in the past. Audit a4bcd049
     * finding #2 — without this the cache grows unboundedly as distinct
     * querystrings (e.g. /logs?since=…) each get a permanent slot.
     */
    ApiClient.prototype._pruneCache = function () {
        var now = Date.now();
        var toDrop = [];
        this._cache.forEach(function (entry, key) {
            if (entry.expiresAt <= now) { toDrop.push(key); }
        });
        for (var i = 0; i < toDrop.length; i += 1) {
            this._cache.delete(toDrop[i]);
        }
    };

    /**
     * POST a mutation. Invalidates cache entries whose keys start with the
     * same first segment (e.g. 'GET /chains' for any /chains/*).
     */
    ApiClient.prototype.post = function (path, body) {
        var self = this;
        return this._fetch('POST', path, body).then(function (result) {
            self._invalidateRelated(path);
            return result;
        });
    };

    ApiClient.prototype.put = function (path, body) {
        var self = this;
        return this._fetch('PUT', path, body).then(function (result) {
            self._invalidateRelated(path);
            return result;
        });
    };

    ApiClient.prototype.del = function (path) {
        var self = this;
        return this._fetch('DELETE', path).then(function (result) {
            self._invalidateRelated(path);
            return result;
        });
    };

    ApiClient.prototype.invalidate = function (path) {
        this._invalidateRelated(path);
    };

    /** @private */
    ApiClient.prototype._fetch = function (method, path, body) {
        var url = this.base + path;
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () {
            if (ctrl) ctrl.abort();
        }, this.timeoutMs);

        var init = {
            method: method,
            // Cross-origin to enm-server on :4180. credentials:'include' is
            // belt-and-suspenders — we explicitly send Bearer below, but
            // including credentials lets future cookie-based auth schemes
            // work without a second round of changes here.
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
            signal: ctrl ? ctrl.signal : undefined,
        };
        if (this.token) {
            init.headers['Authorization'] = 'Bearer ' + this.token;
        }
        if (body !== undefined && body !== null) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        return fetch(url, init).then(function (res) {
            clearTimeout(timer);
            return res.text().then(function (text) {
                // a4bcd049 finding #3 — proxy login pages return 200 OK
                // with text/html. Previously fell through to parsed=null
                // and the caller saw a "successful" empty result. Detect
                // the non-JSON content-type up front so the operator
                // gets a re-auth signal instead of mysteriously-empty
                // panels.
                var ct = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
                if (text && ct && ct.indexOf('application/json') === -1) {
                    var htmlErr = new Error('Non-JSON response from ' + path + ' (likely proxy/auth page)');
                    htmlErr.status = res.status;
                    htmlErr.code = 'NON_JSON';
                    htmlErr.body = text.slice(0, 200);
                    throw htmlErr;
                }
                var parsed = null;
                if (text) {
                    try { parsed = JSON.parse(text); } catch (_) { /* fall through */ }
                }
                if (!res.ok) {
                    var msg = (parsed && parsed.error) || ('HTTP ' + res.status + ' on ' + path);
                    var err = new Error(msg);
                    err.status = res.status;
                    err.body = parsed;
                    throw err;
                }
                if (parsed && parsed.success === false) {
                    // a4bcd049 finding #5 — previously threw a bare
                    // Error here, losing status + body. Callers couldn't
                    // distinguish a 200-with-success:false from a 500.
                    var lfErr = new Error(parsed.error || 'Request failed');
                    lfErr.status = res.status;
                    lfErr.body = parsed;
                    lfErr.code = 'LOGICAL_FAILURE';
                    throw lfErr;
                }
                return (parsed && parsed.result !== undefined) ? parsed.result : parsed;
            });
        }).catch(function (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                // a4bcd049 finding #4 — preserve abort semantics so
                // callers can `err.code === 'TIMEOUT'` instead of
                // string-matching the message.
                var timeoutErr = new Error('Request timeout (' + method + ' ' + path + ')');
                timeoutErr.code = 'TIMEOUT';
                timeoutErr.name = 'AbortError';
                throw timeoutErr;
            }
            throw err;
        });
    };

    /** @private */
    ApiClient.prototype._invalidateRelated = function (path) {
        // Drop every cache entry whose path starts with the same first segment.
        // /chains/mainchain/start → first seg /chains → invalidates /chains and /chains/*.
        //
        // a4bcd049 finding #7 — previous implementation used
        // `indexOf(' ' + first)` which is a substring match. Path
        // `/chainsx` would invalidate `/chains` (false positive).
        // Use a strict prefix match: key must equal `GET <first>` or
        // start with `GET <first>/`.
        var first = path.split('/').slice(0, 2).join('/'); // e.g. '/chains'
        var exact = 'GET ' + first;
        var prefix = 'GET ' + first + '/';
        var toDrop = [];
        this._cache.forEach(function (_v, key) {
            if (key === exact || key.indexOf(prefix) === 0) { toDrop.push(key); }
        });
        for (var i = 0; i < toDrop.length; i += 1) {
            this._cache.delete(toDrop[i]);
        }
    };

    /** Test/debug: clear all cached entries. */
    ApiClient.prototype.clearCache = function () { this._cache.clear(); };

    root.EnmApiClient = ApiClient;
    root.ENM_API_BASE = API_BASE;
}(typeof window !== 'undefined' ? window : globalThis));
