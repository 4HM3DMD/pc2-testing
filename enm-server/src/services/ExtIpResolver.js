/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ExtIpResolver — resolve the operator's external IPv4 address.
 *
 * Used to populate `Configuration.DPoSConfiguration.IPAddress` in ela's config
 * (Rev 5 audit, agent 10). The IP is advertised to DPoS peers — they need it
 * to dial back into our supernode.
 *
 * Mirrors node.sh's `extip()` (Rev 5 audit found it: `curl -s
 * https://checkip.amazonaws.com`). We use Node's built-in fetch (Node 18+).
 *
 * Caches successful results for 1 hour so we don't hammer the upstream on
 * every health-check tick. Operator can manual-override in Settings — that
 * value is stored in config and bypasses this resolver.
 */

'use strict';

const DEFAULT_ENDPOINT = 'https://checkip.amazonaws.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

let cache = null; // { ip, fetchedAt }

/**
 * @typedef {object} ExtIpResult
 * @property {boolean} ok
 * @property {string} [ip]      e.g. "203.0.113.5"
 * @property {string} source    "cache" | "endpoint" | "manual"
 * @property {string} [reason]  set when ok=false
 */

/**
 * Resolve the external IP. Returns cached value if fresh.
 *
 * @param {object} [opts]
 * @param {string} [opts.endpoint] override (default checkip.amazonaws.com)
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.force]   bypass cache
 * @returns {Promise<ExtIpResult>}
 */
async function resolve(opts) {
    const o = opts || {};

    if (!o.force && cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
        return { ok: true, ip: cache.ip, source: 'cache' };
    }

    const endpoint = o.endpoint || DEFAULT_ENDPOINT;
    const timeoutMs = Number.isInteger(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS;

    let controller;
    let timer;
    if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response;
    try {
        response = await fetch(endpoint, {
            method: 'GET',
            signal: controller ? controller.signal : undefined,
            redirect: 'follow',
            headers: { 'Accept': 'text/plain' },
        });
    } catch (_) {
        if (timer) {
            clearTimeout(timer);
        }
        // 0.5.115 audit Session 115 — replaced err.message interpolation
        // with a static fallback. Pre-0.5.115 we surfaced Node fetch
        // errno strings ("fetch failed", "getaddrinfo ENOTFOUND ...",
        // certificate errors) verbatim — the operator-actionable
        // recovery is the same regardless of which network-level
        // failure mode tripped, so the verbose errno added noise
        // without changing what the operator should do. Matches
        // Sessions 64/67/79/81-84 + 107-112 leak-sweep pattern.
        return {
            ok: false,
            source: 'endpoint',
            reason: 'External IP probe failed (network unreachable, DNS, or TLS error). '
                  + 'You can paste your IP manually in Settings → Network.',
        };
    }
    if (timer) {
        clearTimeout(timer);
    }

    if (!response.ok) {
        return {
            ok: false,
            source: 'endpoint',
            reason: `External IP probe returned HTTP ${response.status} from ${endpoint}.`,
        };
    }

    const text = (await response.text()).trim();
    if (!IPV4_REGEX.test(text)) {
        return {
            ok: false,
            source: 'endpoint',
            reason: `External IP probe returned a non-IPv4 string (${truncate(text, 64)}).`,
        };
    }

    cache = { ip: text, fetchedAt: Date.now() };
    return { ok: true, ip: text, source: 'endpoint' };
}

/**
 * Validate an operator-supplied IP or hostname. Hostnames are accepted because
 * DPoS supports DDNS (Rev 5 audit: `normalizeAddress` accepts FQDN).
 *
 * @param {string} value
 * @returns {{ ok: boolean, kind?: 'ipv4'|'hostname', reason?: string }}
 */
function validateOverride(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return { ok: false, reason: 'Override must be a non-empty string.' };
    }
    const trimmed = value.trim();
    if (IPV4_REGEX.test(trimmed)) {
        return { ok: true, kind: 'ipv4' };
    }
    // If the input *looks* like a dotted-quad (4 numeric parts) but failed the
    // strict IPv4 test above, reject — accepting it as a hostname would let
    // "999.999.999.999" pass since RFC 1123 permits all-digit labels.
    if (/^\d+(?:\.\d+){3}$/.test(trimmed)) {
        return { ok: false, reason: `"${truncate(trimmed, 32)}" is not a valid IPv4 address.` };
    }
    // Accept RFC 1123 hostnames (also covers DDNS like myhost.dyndns.org).
    if (/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/i.test(trimmed)) {
        return { ok: true, kind: 'hostname' };
    }
    return { ok: false, reason: `"${truncate(trimmed, 32)}" is not a valid IPv4 address or hostname.` };
}

function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** @internal — for tests only */
function _resetCacheForTests() { cache = null; }

module.exports = {
    resolve,
    validateOverride,
    _resetCacheForTests,
    DEFAULT_ENDPOINT,
    CACHE_TTL_MS,
};
