/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ChainRegistry — singleton holding NativeProcessService + per-chain adapters.
 *
 * Created in main.js's `init` lifecycle hook and shared with route handlers
 * via a module-level reference. Avoids passing dependencies through every
 * route's closure.
 */

'use strict';

const { NativeProcessService } = require('./NativeProcessService');
const { SseHub } = require('./SseHub');
const { ProcessLogStreamer } = require('./ProcessLogStreamer');
const ElaMainChainAdapter = require('./ElaMainChainAdapter');
const { SelfHealingEngine } = require('./SelfHealingEngine');
const { HealthChecker } = require('./HealthChecker');
const { readNodeOwner } = require('../auth');
const { SyncTracker } = require('./SyncTracker');
const HostConflictScanner = require('./HostConflictScanner');
const { EnmBinaryDownloader } = require('./EnmBinaryDownloader');
const { EnmKeystoreService } = require('./EnmKeystoreService');
const ChainState = require('./ChainState');

let initialized = false;
let processService = null;
let sseHub = null;
let logStreamer = null;
let engine = null;
let healthChecker = null;
let syncTracker = null;
let binaryDownloader = null;
let keystoreService = null;
let extensionHandleRef = null;
/** @type {Map<string, import('./ChainAdapter')>} */
let adapters = new Map();

/**
 * Idempotent init. Called from main.js init hook with the extension handle.
 *
 * @param {object} extensionHandle
 */
function init(extensionHandle) {
    if (initialized) {
        return;
    }
    if (!extensionHandle) {
        throw new TypeError('ChainRegistry.init: extensionHandle required');
    }
    extensionHandleRef = extensionHandle;
    processService = new NativeProcessService({ extensionHandle });
    sseHub = new SseHub({ extensionHandle });
    // ProcessLogStreamer subscribes to processService events on construction.
    logStreamer = new ProcessLogStreamer({ processService, sseHub, extensionHandle });
    syncTracker = new SyncTracker();
    binaryDownloader = new EnmBinaryDownloader({ logger: extensionHandle.log, sseHub });
    keystoreService = new EnmKeystoreService({ logger: extensionHandle.log });
    adapters.set('mainchain', new ElaMainChainAdapter({ processService, extensionHandle }));

    // Clear SyncTracker's height-sample buffer + HostConflictScanner's
    // dedup map on chain exit so the next start sees a clean slate. Two
    // bugs the audit caught:
    //   - SyncTracker zombie velocity ("1150 blocks/min · Network
    //     height unknown")
    //   - HostConflictScanner silently swallowing "conflict resolved"
    //     signals because the 1h TTL was still hot
    processService.on('exit', ({ chainId }) => {
        syncTracker.clearForChain(chainId);
        HostConflictScanner.clearDedup(chainId);
    });

    // Boot self-heal: walk every known chain, reconcile in-memory state with
    // disk reality. Per Architectural Invariant #6, ENM recovers from kill -9
    // / DB loss / abandoned wizards without operator intervention.
    try {
        const summary = ChainState.reconcileOnBoot(
            Array.from(adapters.keys()),
            (level, msg) => {
                const fn = extensionHandle.log[level] || extensionHandle.log.info;
                fn(msg);
            },
        );
        extensionHandle.log.info(
            `[ENM] boot reconcile: ${summary.reconciled} chain(s), ${summary.stalePidsCleared} stale PID(s) cleared`
            + (summary.anomalies.length ? `, anomalies: ${summary.anomalies.join('; ')}` : ''),
        );
    } catch (err) {
        extensionHandle.log.warn(`[ENM] boot reconcile failed (non-fatal): ${err.message}`);
    }

    initialized = true;
}

function getBinaryDownloader() {
    if (!binaryDownloader) throw new Error('ChainRegistry: not initialized');
    return binaryDownloader;
}

function getKeystoreService() {
    if (!keystoreService) throw new Error('ChainRegistry: not initialized');
    return keystoreService;
}

function getSyncTracker() {
    if (!syncTracker) {
        throw new Error('ChainRegistry: not initialized');
    }
    return syncTracker;
}

/**
 * Disk-derived snapshot of every known chain. Cheap; safe to call per-request.
 * Returns the same shape as ChainState.snapshot but with one entry per chain.
 *
 * @returns {object[]} array of ChainState snapshots
 */
function snapshots() {
    if (!initialized) return [];
    return Array.from(adapters.keys()).map((id) => ChainState.snapshot(id));
}

/**
 * Lazy build the healing engine + health checker. Called from main.js `ready`
 * (NOT init) because the data API is reliably available by then and the owner
 * wallet has been claimed in PC2's setup flow.
 *
 * @param {() => object} getDb  lazy db handle accessor (extension.import('data').db)
 */
function initHealing(getDb) {
    if (!initialized) {
        throw new Error('ChainRegistry: must call init() before initHealing()');
    }
    if (engine) {
        return;
    }
    if (typeof getDb !== 'function') {
        throw new TypeError('ChainRegistry.initHealing: getDb required');
    }
    let owner = null;
    try {
        owner = readNodeOwner();
    } catch (err) {
        // Owner read failure shouldn't block boot — engine starts in no-owner
        // mode and gates all proposals. Operator can complete setup later.
        extensionHandleRef.log.warn(`[ENM] readNodeOwner failed during initHealing: ${err.message}`);
    }
    engine = new SelfHealingEngine({
        extensionHandle: extensionHandleRef,
        getDb,
        processService,
        sseHub,
        ownerWallet: owner,
    });
    healthChecker = new HealthChecker({
        extensionHandle: extensionHandleRef,
        processService,
        engine,
        listChains,
        getAdapter,
        syncTracker,
    });
}

function getEngine() {
    if (!engine) {
        throw new Error('ChainRegistry: healing not initialized — call initHealing() in extension ready hook');
    }
    return engine;
}

function getHealthChecker() {
    if (!healthChecker) {
        throw new Error('ChainRegistry: healing not initialized');
    }
    return healthChecker;
}

function getProcessService() {
    if (!processService) {
        throw new Error('ChainRegistry: not initialized — call init() in extension init hook first');
    }
    return processService;
}

function getSseHub() {
    if (!sseHub) {
        throw new Error('ChainRegistry: not initialized');
    }
    return sseHub;
}

function getLogStreamer() {
    if (!logStreamer) {
        throw new Error('ChainRegistry: not initialized');
    }
    return logStreamer;
}

/**
 * @param {string} chainId
 * @returns {import('./ChainAdapter')}
 */
function getAdapter(chainId) {
    if (!initialized) {
        throw new Error('ChainRegistry: not initialized');
    }
    const adapter = adapters.get(chainId);
    if (!adapter) {
        throw new Error(`ChainRegistry: unknown chainId "${chainId}"`);
    }
    return adapter;
}

/**
 * @returns {Array<{ chainId: string, displayName: string }>}
 */
function listChains() {
    if (!initialized) {
        return [];
    }
    return Array.from(adapters.values()).map((a) => ({
        chainId: a.chainId,
        displayName: a.displayName,
    }));
}

/** @internal — for tests only */
function _resetForTests() {
    if (sseHub) {
        try { sseHub.close(); } catch (_) { /* swallow */ }
    }
    if (healthChecker) {
        try { healthChecker.stop(); } catch (_) { /* swallow */ }
    }
    initialized = false;
    extensionHandleRef = null;
    processService = null;
    sseHub = null;
    logStreamer = null;
    engine = null;
    healthChecker = null;
    syncTracker = null;
    binaryDownloader = null;
    keystoreService = null;
    adapters = new Map();
}

module.exports = {
    init,
    initHealing,
    getProcessService,
    getSseHub,
    getLogStreamer,
    getAdapter,
    getEngine,
    getHealthChecker,
    getSyncTracker,
    getBinaryDownloader,
    getKeystoreService,
    listChains,
    snapshots,
    _resetForTests,
};
