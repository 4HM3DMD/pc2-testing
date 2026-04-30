/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ClockSkewChecker — host-clock vs. internet-clock comparison (F13).
 *
 * Why this matters (Rev 5 audit, agent 11):
 *   ELA's Schnorr signing fails silently if host clock skew exceeds 4.2s. The
 *   producer signs a block but the consensus partners reject the signature as
 *   out-of-window — the operator scores a missed-vote without warning. We
 *   measure skew long before the 4.2s threshold (>2s threshold) so the operator
 *   can fix NTP before they get penalized.
 *
 * How (per Rev 5):
 *   HTTPS HEAD to a known reliable endpoint; parse the `Date:` response header;
 *   compare to Date.now(). HTTPS HEAD is small (~1 KB) and tolerates network
 *   latency well — we add ½ RTT compensation per simple NTP-style approximation.
 *
 * Fail-soft: if egress fails (no internet, captive portal, firewall), we log
 *   a warning but DO NOT escalate to CRITICAL. F13 is "host clock vs. wall
 *   clock"; it's irrelevant if there's no wall clock to compare against.
 */

'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_ENDPOINTS = Object.freeze([
    'https://www.google.com',
    'https://cloudflare.com',
    'https://www.cloudflare.com',
]);
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} SkewResult
 * @property {boolean} ok            true if we got a server time
 * @property {number} [skewMs]       host - server (positive = host ahead)
 * @property {number} [serverMs]
 * @property {number} [rtt]
 * @property {string} [endpoint]     which endpoint answered
 * @property {string} [reason]       set when ok=false
 */

/**
 * Probe one endpoint with HTTPS HEAD. Returns { ok, ... } on success or
 * { ok: false, reason } on failure.
 *
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<SkewResult>}
 */
function probeOne(endpoint, timeoutMs) {
    return new Promise((resolve) => {
        const url = new URL(endpoint);
        const t0 = Date.now();
        let settled = false;
        const finish = (out) => {
            if (settled) return;
            settled = true;
            resolve(out);
        };
        const req = https.request({
            host: url.hostname,
            port: url.port || 443,
            path: url.pathname || '/',
            method: 'HEAD',
            timeout: timeoutMs,
            // Most robust: don't pin a specific TLS protocol — let Node negotiate.
        }, (res) => {
            const dateHeader = res.headers && res.headers.date;
            const t1 = Date.now();
            res.resume(); // drain

            if (!dateHeader) {
                return finish({
                    ok: false,
                    endpoint,
                    reason: `${endpoint}: no Date response header`,
                });
            }
            const serverMs = Date.parse(dateHeader);
            if (Number.isNaN(serverMs)) {
                return finish({
                    ok: false,
                    endpoint,
                    reason: `${endpoint}: unparseable Date header "${dateHeader}"`,
                });
            }
            // Approximate the actual server-clock-at-our-receive-time by
            // shifting the Date header forward by half the RTT (the response
            // is in flight for half the round trip, then we read it).
            const rtt = t1 - t0;
            const serverAtReceive = serverMs + Math.floor(rtt / 2);
            const skewMs = t1 - serverAtReceive;
            return finish({ ok: true, skewMs, serverMs, rtt, endpoint });
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (err) => {
            finish({ ok: false, endpoint, reason: `${endpoint}: ${err.message}` });
        });
        req.end();
    });
}

/**
 * Public probe — tries each default endpoint in order, returns the first
 * success. If all endpoints fail, returns ok=false with the last reason.
 * Caller decides whether to escalate (we recommend WARNING tier — see header).
 *
 * @param {object} [opts]
 * @param {Array<string>} [opts.endpoints]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<SkewResult>}
 */
async function check(opts) {
    const endpoints = (opts && Array.isArray(opts.endpoints) && opts.endpoints.length > 0)
        ? opts.endpoints : DEFAULT_ENDPOINTS;
    const timeout = (opts && Number.isInteger(opts.timeoutMs)) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    let last = null;
    for (const ep of endpoints) {
        // eslint-disable-next-line no-await-in-loop
        const res = await probeOne(ep, timeout);
        last = res;
        if (res.ok) {
            return res;
        }
    }
    return last || { ok: false, reason: 'no endpoints' };
}

module.exports = {
    check,
    probeOne,
    DEFAULT_ENDPOINTS,
    DEFAULT_TIMEOUT_MS,
};
