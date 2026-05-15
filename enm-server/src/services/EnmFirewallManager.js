/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmFirewallManager — beta.3.30. Auto-open the host firewall for
 * chain P2P ports at start time.
 *
 * Why this exists:
 *   On a fresh Ubuntu cloud install (Hostinger, DigitalOcean, et al.)
 *   `ufw` ships preinstalled but inactive by default. Some operator
 *   tooling (or a security-hardened image) enables `ufw` with default-
 *   deny inbound + a narrow allow list (typically just SSH). When ENM
 *   then runs ela bound to 0.0.0.0:20338, the socket is up but
 *   inbound TCP SYN packets are silently dropped at UFW INPUT — so
 *   the chain has outbound peers but zero inbound, accumulates missed
 *   votes if registered as BPoS, and the operator has no idea why.
 *
 *   Diagnosed on srv832310 (Hostinger) 2026-05-15: UFW active with
 *   only 22/4100/4180/4202 allowed. Manual `ufw allow 20338/tcp +
 *   20339/tcp` restored inbound peers within ~10 min.
 *
 *   This module makes that fix automatic. Called by ElaMainChainAdapter
 *   right before spawning ela.
 *
 * What it does:
 *   1. Detect UFW: `ufw status verbose` exit 0 + "Status: active"
 *      → eligible for management. Otherwise → no-op (other firewalls
 *      out of scope; if there's no UFW or it's inactive, we don't
 *      touch the host).
 *   2. Parse the allow list for each chain port (defaults: 20338 P2P,
 *      20339 DPoS p2p). RPC port (20336) intentionally stays closed —
 *      ela's RpcConfiguration.WhiteIPList=["127.0.0.1"] keeps it
 *      loopback-only inside ela, and ENM's own config never opens it
 *      to the network either.
 *   3. For any missing port, run `ufw allow <port>/tcp comment '...'`.
 *      Idempotent — UFW silently no-ops on duplicates anyway.
 *   4. Return a structured report so the caller can log + notify.
 *
 * Architectural notes:
 *   - We never call `ufw enable` (turning UFW on/off is an operator
 *     decision). We only ADD allow rules to an already-active firewall.
 *   - We never remove rules. Operator who wants to revoke can run
 *     `ufw delete allow 20338/tcp` themselves.
 *   - We only manage UFW. firewalld / nftables / raw iptables are out
 *     of scope. If the operator's host uses one of those, they'll see
 *     F18 fire as before and follow the alert's remediation copy.
 *   - We run as root (PC2 boots as root; verified on srv832310). If
 *     somehow we're not root, the `ufw allow` exec fails and we
 *     surface the error in the report — caller (chain start) treats
 *     it as warn-not-fail since ela can still run; the operator just
 *     won't get inbound peers.
 *
 * 0.2.0-beta.3.30.
 */

'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');

const { ENM_LOG_PREFIX } = require('./EnmConstants');

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run a command, capture stdout/stderr/exit. Doesn't throw on
 * non-zero exit — that's information the caller wants.
 *
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
function execCapture(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(cmd, args || [], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH || '/usr/sbin:/usr/bin:/sbin:/bin' },
        });
        const t = setTimeout(() => {
            if (settled) { return; }
            settled = true;
            try { child.kill('SIGKILL'); } catch (_) { /* idempotent */ }
            resolve({ stdout, stderr: stderr + '\n[timeout]', code: null });
        }, Number.isInteger(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', () => {
            if (settled) { return; }
            settled = true;
            clearTimeout(t);
            resolve({ stdout, stderr, code: null });
        });
        child.on('close', (code) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(t);
            resolve({ stdout, stderr, code });
        });
    });
}

/**
 * Detect UFW state on this host.
 *
 * @returns {Promise<{
 *   tool: 'ufw'|null,
 *   active: boolean,
 *   allowedTcp: Set<number>,  // ports with an `ALLOW IN  ... tcp` rule
 *   raw?: string
 * }>}
 */
async function detect() {
    if (os.platform() !== 'linux') {
        return { tool: null, active: false, allowedTcp: new Set() };
    }
    const probe = await execCapture('ufw', ['status', 'verbose']);
    // exit 0 only when UFW is installed AND the user has perms to read state.
    // exit 1 / EACCES → we can't determine. Treat as "not eligible".
    if (probe.code !== 0) {
        return { tool: null, active: false, allowedTcp: new Set(), raw: probe.stderr };
    }
    const out = probe.stdout || '';
    const active = /Status:\s*active/i.test(out);
    if (!active) {
        return { tool: 'ufw', active: false, allowedTcp: new Set(), raw: out };
    }
    // Parse allowed TCP ports. Match lines like:
    //   22/tcp                     ALLOW IN    Anywhere
    //   20338/tcp                  ALLOW IN    Anywhere                   # ela P2P
    //   80,443/tcp                 ALLOW IN    Anywhere
    // We ignore (v6) duplicates — UFW emits a v4 line and a v6 line per rule.
    const allowed = new Set();
    const lineRe = /^([\d,\s]+)\/tcp(?:\s*\([\w]+\))?\s+ALLOW IN\b/i;
    out.split(/\r?\n/).forEach((line) => {
        const m = lineRe.exec(line.trim());
        if (!m) { return; }
        m[1].split(',').forEach((p) => {
            const n = parseInt(p.trim(), 10);
            if (Number.isInteger(n) && n > 0 && n < 65536) { allowed.add(n); }
        });
    });
    return { tool: 'ufw', active: true, allowedTcp: allowed, raw: out };
}

/**
 * Ensure the given TCP ports are allowed inbound. Only acts when UFW
 * is active. No-op otherwise.
 *
 * @param {number[]} ports     TCP ports to ensure are allowed
 * @param {object} [opts]
 * @param {string} [opts.comment]  comment to attach to added rules
 * @param {object} [opts.logger]   logger with info/warn/error methods
 * @returns {Promise<{
 *   tool: 'ufw'|null,
 *   active: boolean,
 *   alreadyAllowed: number[],
 *   added: number[],
 *   errors: Array<{port: number, message: string}>,
 *   skipped: boolean,                // true when no-op (no UFW / inactive)
 *   reason?: string,
 * }>}
 */
async function ensureAllowed(ports, opts) {
    const logger = (opts && opts.logger) || { info() {}, warn() {}, error() {} };
    const comment = (opts && opts.comment) || 'ENM auto';
    const portList = (Array.isArray(ports) ? ports : [])
        .map((p) => parseInt(p, 10))
        .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

    const state = await detect();
    if (!state.tool) {
        return {
            tool: null, active: false,
            alreadyAllowed: [], added: [], errors: [],
            skipped: true, reason: 'ufw not installed / not detectable',
        };
    }
    if (!state.active) {
        return {
            tool: 'ufw', active: false,
            alreadyAllowed: [], added: [], errors: [],
            skipped: true, reason: 'ufw installed but inactive',
        };
    }

    const alreadyAllowed = portList.filter((p) => state.allowedTcp.has(p));
    const missing = portList.filter((p) => !state.allowedTcp.has(p));
    const added = [];
    const errors = [];

    for (const port of missing) {
        // `ufw allow <port>/tcp comment '...'` requires the comment to
        // be a single shell-quoted token. We pass argv directly via
        // spawn so the shell never gets involved — no quoting hazards.
        const args = ['allow', `${port}/tcp`, 'comment', `${comment} (port ${port})`];
        const r = await execCapture('ufw', args, 8_000);
        if (r.code === 0) {
            added.push(port);
            logger.info(`${ENM_LOG_PREFIX} ufw allow ${port}/tcp added (${comment})`);
        } else {
            errors.push({
                port,
                message: (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0],
            });
            logger.warn(
                `${ENM_LOG_PREFIX} ufw allow ${port}/tcp failed: `
                + ((r.stderr || r.stdout || `exit ${r.code}`).trim()),
            );
        }
    }

    return {
        tool: 'ufw', active: true,
        alreadyAllowed, added, errors,
        skipped: false,
    };
}

module.exports = {
    detect,
    ensureAllowed,
    DEFAULT_TIMEOUT_MS,
    // exported for tests
    _execCapture: execCapture,
};
