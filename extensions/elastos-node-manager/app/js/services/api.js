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

    // ENM v0.5 (Wave 7 / M8 sub-phase 5): same-origin under the
    // capsule's install path. Backend runs as a PC2 hybrid-capsule
    // extension at /api/enm/* (relative). No sidecar, no :4180.
    // PC2 already populates req.user via its own auth middleware
    // before extension routes run, so we don't need to re-forward
    // the session token from a query param.
    //
    // For dev / sideload from a different origin, set
    // window.ENM_BACKEND_OVERRIDE = 'http://host:port/api/enm'
    // before any service script loads.
    function deriveBackendBase() {
        if (root.ENM_BACKEND_OVERRIDE) return String(root.ENM_BACKEND_OVERRIDE);
        return '/api/enm';
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
        var self = this;
        return this._fetch('GET', path).then(function (result) {
            self._cache.set(key, { value: result, expiresAt: Date.now() + self.cacheTtlMs });
            return result;
        });
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
                    throw new Error(parsed.error || 'Request failed');
                }
                return (parsed && parsed.result !== undefined) ? parsed.result : parsed;
            });
        }).catch(function (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') {
                throw new Error('Request timeout (' + method + ' ' + path + ')');
            }
            throw err;
        });
    };

    /** @private */
    ApiClient.prototype._invalidateRelated = function (path) {
        // Drop every cache entry whose path starts with the same first segment.
        // /chains/mainchain/start → first seg /chains → invalidates /chains and /chains/*.
        var first = path.split('/').slice(0, 2).join('/'); // ['', 'chains']
        for (var key of Array.from(this._cache.keys())) {
            if (key.indexOf(' ' + first) !== -1) {
                this._cache.delete(key);
            }
        }
    };

    /** Test/debug: clear all cached entries. */
    ApiClient.prototype.clearCache = function () { this._cache.clear(); };

    root.EnmApiClient = ApiClient;
    root.ENM_API_BASE = API_BASE;
}(typeof window !== 'undefined' ? window : globalThis));
