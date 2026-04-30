/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Elastos Node Manager — PC2 extension entry point.
 *
 * Lifecycle hook order (per Kernel.js:228-496 + WebServerService.js:74):
 *   construct → preinit → init → install.routes → activate → ready
 *
 * NOTE: install.services is declared in PC2 but NOT emitted by core (verified in
 * Rev 6 audit). We register own services there for v0.2 readiness only.
 *
 * NOTE: event.app is the Express instance (NOT event.router — pc2-node has
 * a typo there that we explicitly avoid).
 */

'use strict';

const { ENM_LOG_PREFIX } = require('./lib/EnmConstants');
const { initSchema, cleanupOldAuditLogs } = require('./lib/EnmDb');
const { mountRoutes } = require('./routes');
const ChainRegistry = require('./lib/ChainRegistry');
const ProposalStore = require('./lib/EnmProposalStore');
const ConfigStore = require('./lib/ConfigStore');

const AUDIT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const PROPOSAL_SWEEP_INTERVAL_MS = 60 * 1000;        // 1m
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

let auditSweepTimer = null;
let proposalSweepTimer = null;

extension.on('preinit', () => {
    extension.log.info(`${ENM_LOG_PREFIX} preinit`);
});

extension.on('init', async () => {
    extension.log.info(`${ENM_LOG_PREFIX} init — creating own DB tables + chain registry`);

    try {
        const { db } = extension.import('data');
        await initSchema(db);
        extension.log.info(`${ENM_LOG_PREFIX} schema ready`);
    } catch (err) {
        // Schema init failure is fatal: subsequent route handlers depend on the tables.
        extension.log.error(`${ENM_LOG_PREFIX} schema init failed: ${err.message}`);
        throw err;
    }

    // Build the chain registry (NativeProcessService + adapters). Idempotent.
    ChainRegistry.init(extension);
});

extension.on('install.routes', (event) => {
    extension.log.info(`${ENM_LOG_PREFIX} install.routes — mounting /extensions/elastos-node-manager`);

    if (!event || !event.app) {
        // Defend against the documented PC2 bug where pc2-node uses event.router.
        // If we hit this, the extension framework changed shape — fail loud, not silent.
        extension.log.error(`${ENM_LOG_PREFIX} install.routes event missing 'app' — extension cannot mount`);
        return;
    }

    mountRoutes(event.app, extension);
});

extension.on('install.services', (event) => {
    // Reserved for v0.2 (cross-extension service consumption). No-op in v0.1.
    extension.log.info(`${ENM_LOG_PREFIX} install.services (v0.2 reserved, no-op)`);
});

extension.on('create.permissions', () => {
    // We don't grant cross-extension permissions in v0.1.
    // All access is gated by our own OwnerCheckMiddleware on each route.
});

extension.on('ready', async () => {
    extension.log.info(`${ENM_LOG_PREFIX} ready — scanning for orphaned ela processes to reattach`);
    try {
        const reattached = await ChainRegistry.getProcessService().reattach();
        if (reattached.length > 0) {
            extension.log.info(`${ENM_LOG_PREFIX} reattached ${reattached.length} chain(s): ${reattached.map((r) => r.chainId).join(', ')}`);
        }
    } catch (err) {
        // Reattach failure shouldn't block extension boot — operator can manually
        // start chains from the dashboard if their PID file is corrupted.
        extension.log.error(`${ENM_LOG_PREFIX} reattach scan failed: ${err.message}`);
    }

    // Wire the self-healing engine + start the health checker. We do this in
    // 'ready' (not 'init') so the data API and the owner wallet have settled.
    try {
        ChainRegistry.initHealing(() => extension.import('data').db);
        ChainRegistry.getHealthChecker().start();
    } catch (err) {
        extension.log.error(`${ENM_LOG_PREFIX} healing init failed: ${err.message}`);
    }

    // Audit log retention: sweep on boot + every 24h.
    scheduleAuditSweeps();
    // Proposal expiry sweep: every minute (cheap update; no row scan unless
    // there are pending proposals past their TTL).
    scheduleProposalSweeps();

    extension.log.info(`${ENM_LOG_PREFIX} ready ✓`);
});

/**
 * Run the audit retention cleanup once now and schedule recurring sweeps.
 * Pulls retention days from the operator config; falls back to the default if
 * the config hasn't been loaded yet.
 */
function scheduleAuditSweeps() {
    const runOnce = async () => {
        try {
            const cfg = await ConfigStore.load();
            const days = cfg && cfg.global && cfg.global.audit
                && Number.isFinite(cfg.global.audit.retentionDays)
                ? cfg.global.audit.retentionDays : DEFAULT_AUDIT_RETENTION_DAYS;
            const removed = await cleanupOldAuditLogs(extension.import('data').db, days);
            if (removed > 0) {
                extension.log.info(`${ENM_LOG_PREFIX} audit sweep removed ${removed} rows older than ${days}d`);
            }
        } catch (err) {
            extension.log.warn(`${ENM_LOG_PREFIX} audit sweep failed: ${err.message}`);
        }
    };
    runOnce();
    if (auditSweepTimer) clearInterval(auditSweepTimer);
    auditSweepTimer = setInterval(runOnce, AUDIT_SWEEP_INTERVAL_MS);
    auditSweepTimer.unref?.();
}

function scheduleProposalSweeps() {
    const runOnce = async () => {
        try {
            await ProposalStore.sweepExpired(extension.import('data').db);
        } catch (err) {
            extension.log.debug(`${ENM_LOG_PREFIX} proposal sweep failed: ${err.message}`);
        }
    };
    if (proposalSweepTimer) clearInterval(proposalSweepTimer);
    proposalSweepTimer = setInterval(runOnce, PROPOSAL_SWEEP_INTERVAL_MS);
    proposalSweepTimer.unref?.();
}
