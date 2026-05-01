/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Shared constants for the Elastos Node Manager extension.
 *
 * One source of truth — change here, never duplicate.
 */

'use strict';

const ENM_NAME = 'elastos-node-manager';
const ENM_LOG_PREFIX = '[ENM]';
const ENM_ROUTE_PREFIX = `/extensions/${ENM_NAME}`;
const ENM_API_PREFIX = `${ENM_ROUTE_PREFIX}/api`;

// Default ports for ELA mainchain (per common/config/config.go:127,174,266-269).
// Operator can override in Settings → Advanced.
const ELA_DEFAULT_PORTS = Object.freeze({
    rpc: 20336,        // HttpJsonPort — JSON-RPC (HTTP Basic auth)
    nodePort: 20338,   // NodePort — P2P
    httpInfo: 20333,   // HttpInfoPort — REST info (NO auth, used for --health-cmd)
    httpRest: 20334,   // HttpRestPort — REST API
    httpWs: 20335,     // HttpWsPort — WebSocket
    dpos: 20339,       // DPoSPort — DPoS p2p (BPoS only)
});

// MaxInactiveRounds (consensus penalty threshold) per common/config/config.go:192.
// At ~2 min/block, 1440 blocks ≈ 48h continuous miss before forced inactive state.
const MAX_INACTIVE_ROUNDS = 1440;

// BPoS deposit threshold per cr/state/state.go:26-27.
const MIN_DPOSV2_DEPOSIT_ELA = 2000;

// Producer state machine per dpos/state/state.go:36-60.
// Six states (Rev 1 audit corrected initial 5-state assumption).
const PRODUCER_STATES = Object.freeze([
    'Pending', 'Active', 'Inactive', 'Canceled', 'Illegal', 'Returned',
]);

// Hardcoded mainnet DNS seeds per common/config/config.go:128-133.
// Last updated 2023-03-25 in Elastos.ELA — F16 watches for prolonged peer-zero state.
const MAINNET_DNS_SEEDS = Object.freeze([
    '52.74.28.202:20338',
    '52.62.113.83:20338',
    '35.156.51.127:20338',
    '35.177.89.244:20338',
]);

// Healing decision tiers (Rev 1 plan, mapped per F-rule).
const HEALING_TIERS = Object.freeze({
    AUTOMATED_SAFE: 'AUTOMATED-SAFE',
    OWNER_CONFIRMS: 'OWNER-CONFIRMS',
    CRITICAL_NOTIFY: 'CRITICAL-NOTIFY',
    NEVER_AUTOMATIC: 'NEVER-AUTOMATIC',
    // Synthetic tier for the per-route HTTP audit middleware. Distinct from
    // the four healing tiers so the audit-tab UI can filter healing decisions
    // separately from raw HTTP mutation logs (Phase 4 audit, agent 1).
    HTTP_MUTATION: 'HTTP-MUTATION',
});

// Severity levels for notifications + audit log.
const SEVERITY = Object.freeze({
    INFO: 'INFO',
    WARNING: 'WARNING',
    CRITICAL: 'CRITICAL',
    HEALING: 'HEALING',
});

// Chain states for the dashboard UI (color tokens defined in CSS).
const CHAIN_STATES = Object.freeze([
    'healthy', 'syncing', 'stalled', 'stopped', 'error', 'recovering',
]);

// Health-check polling buckets (Rev 1 plan: fast/medium/slow).
const HEALTH_TICK_MS = Object.freeze({
    FAST: 5_000,    // process alive, RPC reachable
    MEDIUM: 30_000, // peer count, height delta, RPC latency
    SLOW: 300_000,  // disk usage, BPoS state, arbiter rotation, clock skew
});

// Process lifecycle constants (Rev 8/9 — native binary).
const PROCESS_STOP_GRACE_MS = 60_000;       // SIGTERM → wait → SIGKILL
const PROCESS_RESTART_COOLDOWN_MS = 30_000; // between F1 attempts
const PROCESS_MAX_RESTART_ATTEMPTS = 3;     // before escalating to OWNER_CONFIRMS
// Rolling window for the budget. Per Rev 9 plan ("F1/F2/F3 escalate to
// OWNER-CONFIRMS after 3 attempts in 10 min"), this is independent of the
// cooldown — set it conservatively so we don't loop a chain that's broken at
// a deeper layer than restart can heal.
const PROCESS_RESTART_BUDGET_WINDOW_MS = 10 * 60 * 1000;

// Audit log tier labels (matches HEALING_TIERS but flat strings for SQL).
const AUDIT_DECISION = Object.freeze({
    PROPOSED: 'proposed',
    CONFIRMED: 'confirmed',
    REJECTED: 'rejected',
    EXECUTED: 'executed',
    FAILED: 'failed',
    MANUAL_ONLY: 'manual-only',
});

// HTTP error format (matches PC2 convention from Rev 4 audit:
// inline try/catch + res.status().json({ success: false, error: '...' })).
function errorBody(message) {
    return { success: false, error: String(message) };
}

function successBody(result) {
    return { success: true, result };
}

module.exports = {
    ENM_NAME,
    ENM_LOG_PREFIX,
    ENM_ROUTE_PREFIX,
    ENM_API_PREFIX,
    ELA_DEFAULT_PORTS,
    MAX_INACTIVE_ROUNDS,
    MIN_DPOSV2_DEPOSIT_ELA,
    PRODUCER_STATES,
    MAINNET_DNS_SEEDS,
    HEALING_TIERS,
    SEVERITY,
    CHAIN_STATES,
    HEALTH_TICK_MS,
    PROCESS_STOP_GRACE_MS,
    PROCESS_RESTART_COOLDOWN_MS,
    PROCESS_MAX_RESTART_ATTEMPTS,
    PROCESS_RESTART_BUDGET_WINDOW_MS,
    AUDIT_DECISION,
    errorBody,
    successBody,
};
