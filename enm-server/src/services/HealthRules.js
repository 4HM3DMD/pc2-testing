/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * HealthRules — F1-F10 detection logic.
 *
 * Pure functions: each rule receives a snapshot of inputs and returns either
 * null (no fire) or a detection object the SelfHealingEngine can act on. The
 * checker module collects snapshots (process state, RPC results, disk free,
 * config validation) and feeds rules in order.
 *
 * Rules are stateless. State that drifts over time (height-unchanged-for-10-min,
 * peer-zero-for-5-min, restart-attempt-counts) is held in HealthChecker so the
 * rules themselves stay easy to test. Each rule receives the relevant slice of
 * timeline + the current snapshot.
 *
 * Tier mapping per Rev 9 plan, "Self-healing engine":
 *   F1, F2, F3            AUTOMATED-SAFE  (engine acts; logs to audit)
 *   F4, F5, F6, F7, F8, F9, F10  OWNER-CONFIRMS  (engine creates a proposal)
 *
 * F11-F15 (BPoS, clock skew, daemon, audit corruption) are Phase 5+.
 */

'use strict';

const { HEALING_TIERS, MAX_INACTIVE_ROUNDS } = require('./EnmConstants');

// Thresholds — beta.3.19 made these mutable so HealthChecker can push
// operator-tuned values in from cfg.global.notifications.thresholds at
// each tick. Defaults match the alpha.28 hardcoded values so behavior
// is identical when no override is configured. RPC_UNREACHABLE_GRACE_MS
// stays a const for now — operator audit didn't flag it as a knob worth
// exposing and the 2-min grace is well-calibrated.
let PEER_ZERO_GRACE_MS         = 5 * 60_000;
const RPC_UNREACHABLE_GRACE_MS = 2 * 60_000;
let HEIGHT_STALL_GRACE_MS      = 10 * 60_000;
let DISK_CRITICAL_GB           = 5;
let DISK_WARN_GB               = 20;

/**
 * beta.3.19 — apply operator-tuned thresholds from
 * cfg.global.notifications.thresholds. Called by HealthChecker on
 * every tick (cheap, idempotent). Unset / invalid fields are
 * ignored — they fall back to the defaults above. Cross-field
 * validation (criticalGb < warnGb) is enforced upstream in the Joi
 * schema; this function trusts its input.
 *
 * @param {{diskFreeWarnGb?:number, diskFreeCriticalGb?:number,
 *          peerZeroGraceMin?:number, syncStallGraceMin?:number}} overrides
 */
function setThresholds(overrides) {
    if (!overrides || typeof overrides !== 'object') { return; }
    if (Number.isFinite(overrides.diskFreeWarnGb)) {
        DISK_WARN_GB = overrides.diskFreeWarnGb;
    }
    if (Number.isFinite(overrides.diskFreeCriticalGb)) {
        DISK_CRITICAL_GB = overrides.diskFreeCriticalGb;
    }
    if (Number.isFinite(overrides.peerZeroGraceMin)) {
        PEER_ZERO_GRACE_MS = overrides.peerZeroGraceMin * 60_000;
    }
    if (Number.isFinite(overrides.syncStallGraceMin)) {
        HEIGHT_STALL_GRACE_MS = overrides.syncStallGraceMin * 60_000;
    }
}

/** beta.3.19 — current effective threshold values (used by tests + the
 *  frontend Alerts section's GET round-trip to read what's live). */
function getThresholds() {
    return {
        diskFreeWarnGb:     DISK_WARN_GB,
        diskFreeCriticalGb: DISK_CRITICAL_GB,
        peerZeroGraceMin:   PEER_ZERO_GRACE_MS / 60_000,
        syncStallGraceMin:  HEIGHT_STALL_GRACE_MS / 60_000,
    };
}

// Phase 5 thresholds.
const PEER_ZERO_FALLBACK_MS      = 10 * 60_000;       // F16 — promote to fallback peer suggestion
const NO_INBOUND_GRACE_MS        = 5 * 60_000;        // F18 — BPoS needs inbound peers
const CLOCK_SKEW_WARN_MS         = 2_000;             // F13 — well below ELA's 4.2s tolerance
const PRODUCER_INACTIVE_WARN     = 720;               // F12 — inactiveRounds approaching MAX_INACTIVE_ROUNDS/2
const PRODUCER_INACTIVE_CRITICAL = 1300;              // F12 — close to forced-inactive at 1440

/**
 * @typedef {object} HealthSnapshot
 * @property {string} chainId
 * @property {object} processStatus  { alive: boolean, pid: number|null, attached: boolean }
 * @property {object} processExit    { code: number|null, signal: string|null, manualStop: boolean }|null
 *                                   — populated by HealthChecker on most-recent exit
 * @property {object|null} rpcSummary { ok: boolean, errCode?: string, height?: number,
 *                                       peers?: number, latencyMs?: number }
 * @property {object|null} diskInfo  { freeGb: number, totalGb: number }
 * @property {object|null} ports     { conflicting: Array<{port:number, role:string}> }
 * @property {object|null} configValidation { ok: boolean, error?: string }
 * @property {object|null} chainConfig
 * @property {object} ruleState      timeline state from HealthChecker:
 *   { firstPeerZeroAt, firstRpcDownAt, firstHeightStallAt, lastHeight, restartAttempts, lastBinaryVersion }
 */

/**
 * @typedef {object} Detection
 * @property {string} ruleId        F1, F2, ...
 * @property {string} tier          AUTOMATED-SAFE | OWNER-CONFIRMS | CRITICAL-NOTIFY
 * @property {string} summaryAction short imperative for the proposal card
 * @property {string} [summaryReason] more detail (1-2 sentences)
 * @property {object} [payload]     opaque to the engine; consumed by execute()
 * @property {string} [severity]    optional — defaults to severity-by-tier
 */

/**
 * F1 — process exited unexpectedly.
 * Detection: process is dead, last exit was non-zero or SIGKILL, AND the user
 * did not manually stop it.
 */
function detectF1(snap) {
    if (!snap || !snap.processStatus) return null;
    if (snap.processStatus.alive) return null;
    if (!snap.chainConfig || snap.chainConfig.enabled !== true) {
        // Operator disabled the chain — silence is correct.
        return null;
    }

    const exit = snap.processExit;
    // No exit info means we never observed the process die — first-boot or
    // pre-reattach. Treat as not-yet-known; we do NOT fire F1 in that case.
    if (!exit) return null;
    if (exit.manualStop) return null;

    // exit code 0 + no signal: clean operator-initiated shutdown via SIGTERM
    // that the process handled gracefully. Skip — same intent as manualStop.
    const cleanlyExited = exit.code === 0 && !exit.signal;
    if (cleanlyExited) return null;

    return {
        ruleId: 'F1',
        tier: HEALING_TIERS.AUTOMATED_SAFE,
        summaryAction: `Restart ${snap.chainId}`,
        summaryReason: `Process exited (code=${exit.code}, signal=${exit.signal || 'none'}) — auto-restart.`,
        payload: { action: 'restart', chainId: snap.chainId },
    };
}

/**
 * F2 — RPC unreachable for >= 2 minutes despite process being alive.
 * Common causes: ela startup not finished, RPC binding failure, port hijack.
 */
function detectF2(snap) {
    if (!snap || !snap.processStatus || !snap.processStatus.alive) return null;
    if (!snap.rpcSummary) return null;
    if (snap.rpcSummary.ok) return null;

    // We need at least RPC_UNREACHABLE_GRACE_MS of continuous failure.
    const firstDown = snap.ruleState && snap.ruleState.firstRpcDownAt;
    if (!firstDown) return null;
    if (Date.now() - firstDown < RPC_UNREACHABLE_GRACE_MS) return null;

    return {
        ruleId: 'F2',
        tier: HEALING_TIERS.AUTOMATED_SAFE,
        summaryAction: `Restart ${snap.chainId} (RPC unreachable)`,
        summaryReason: `RPC has been unreachable for >2 minutes (${snap.rpcSummary.errCode || 'unknown'}).`,
        payload: { action: 'restart', chainId: snap.chainId },
    };
}

/**
 * F3 — peer count zero for >= 5 minutes.
 * Heals by restarting networking (i.e., restart the chain — ela reseeds peers
 * from DNS on startup per p2p/server/seed.go:80).
 */
function detectF3(snap) {
    if (!snap || !snap.processStatus || !snap.processStatus.alive) return null;
    if (!snap.rpcSummary || !snap.rpcSummary.ok) return null;
    if (snap.rpcSummary.peers !== 0) return null;

    const firstZero = snap.ruleState && snap.ruleState.firstPeerZeroAt;
    if (!firstZero) return null;
    if (Date.now() - firstZero < PEER_ZERO_GRACE_MS) return null;

    return {
        ruleId: 'F3',
        tier: HEALING_TIERS.AUTOMATED_SAFE,
        summaryAction: `Restart ${snap.chainId} (no peers)`,
        summaryReason: 'Peer count has been 0 for >5 minutes. Restarting reseeds from DNS.',
        payload: { action: 'restart', chainId: snap.chainId },
    };
}

/**
 * F4 — sync stalled. Height has not advanced for >= 10 minutes despite RPC
 * being healthy and peers connected.
 */
function detectF4(snap) {
    if (!snap || !snap.processStatus || !snap.processStatus.alive) return null;
    if (!snap.rpcSummary || !snap.rpcSummary.ok) return null;
    if (typeof snap.rpcSummary.height !== 'number') return null;
    if (snap.rpcSummary.peers === 0) return null;  // F3 owns this case

    const firstStall = snap.ruleState && snap.ruleState.firstHeightStallAt;
    if (!firstStall) return null;
    if (Date.now() - firstStall < HEIGHT_STALL_GRACE_MS) return null;

    return {
        ruleId: 'F4',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        summaryAction: `Restart ${snap.chainId} to clear sync stall`,
        summaryReason: `Block height ${snap.rpcSummary.height} has not advanced for >10 minutes.`,
        // beta.3.57 — stuckHeight in payload so the auto-resolve sweep
        // can tell "F4 cleared" (height advanced past stuckHeight) from
        // "still stuck" (height same as when proposed). Without it the
        // sweep resolved every F4 instantly because the rule's own
        // precondition (alive + RPC + peers) looked like "healthy".
        payload: { action: 'restart', chainId: snap.chainId, stuckHeight: snap.rpcSummary.height },
    };
}

/**
 * F5 — disk space low.
 * Fires at <5 GB free as CRITICAL-tier OWNER-CONFIRMS; the action is a
 * suggestion, not an automated prune (we never delete operator data).
 */
function detectF5(snap) {
    if (!snap || !snap.diskInfo) return null;
    const free = snap.diskInfo.freeGb;
    if (typeof free !== 'number') return null;
    if (free >= DISK_WARN_GB) return null;

    if (free < DISK_CRITICAL_GB) {
        return {
            ruleId: 'F5',
            tier: HEALING_TIERS.OWNER_CONFIRMS,
            severity: 'CRITICAL',
            summaryAction: `Free disk space on ${snap.chainId} data dir`,
            summaryReason: `Only ${free.toFixed(1)} GB free — chain may halt below ~1 GB. Action: enable archive prune or move dataDir to a larger volume.`,
            payload: { action: 'prune-suggestion', chainId: snap.chainId, freeGb: free },
        };
    }

    // Warn band (5-20 GB) — we surface it as a low-priority OWNER-CONFIRMS
    // instead of auto-firing every poll. SelfHealingEngine deduplicates so
    // the operator doesn't see this every 5 minutes.
    return {
        ruleId: 'F5',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        severity: 'WARNING',
        summaryAction: `Disk space getting low (${free.toFixed(1)} GB free)`,
        summaryReason: `Below the ${DISK_WARN_GB} GB warn threshold. Plan a prune or volume migration before it crosses ${DISK_CRITICAL_GB} GB.`,
        payload: { action: 'prune-suggestion', chainId: snap.chainId, freeGb: free },
    };
}

/**
 * F6 — process killed by OOM (SIGKILL with no manual stop).
 * Distinct from F1 because the action is "raise memory limit", not "restart".
 *
 * Linux OOM-killer sends SIGKILL (signal 9). Node receives this as
 * `signal === 'SIGKILL'` on the exit event. We use the most-recent exit
 * snapshot from HealthChecker; if F1 already restarted, that doesn't matter —
 * F6 still wants to surface the cause to the operator.
 */
function detectF6(snap) {
    if (!snap || !snap.processExit) return null;
    if (snap.processExit.manualStop) return null;
    if (snap.processExit.signal !== 'SIGKILL') return null;

    return {
        ruleId: 'F6',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        summaryAction: `Investigate OOM-kill on ${snap.chainId}`,
        summaryReason: 'Process was SIGKILLed — most likely the Linux OOM-killer. Increase memoryLimitMB or free RAM on the host.',
        payload: { action: 'oom-suggestion', chainId: snap.chainId },
    };
}

/**
 * F7 — port conflict on start. Fires when chains route's PortManager check
 * finds one of our ports already bound by something else.
 */
function detectF7(snap) {
    if (!snap || !snap.ports || !Array.isArray(snap.ports.conflicting)) return null;
    if (snap.ports.conflicting.length === 0) return null;

    const ports = snap.ports.conflicting.map((p) => `${p.port} (${p.role})`).join(', ');
    return {
        ruleId: 'F7',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        summaryAction: `Reassign conflicting ports on ${snap.chainId}`,
        summaryReason: `Ports already bound by other processes: ${ports}. Open Settings → Advanced and pick free ports, or stop the conflicting service.`,
        payload: { action: 'port-conflict', chainId: snap.chainId, conflicting: snap.ports.conflicting },
    };
}

/**
 * F8 — binary version mismatch. The on-disk ela --version reports something
 * different from what ConfigStore recorded. Don't auto-restart — the operator
 * may have intentionally rebuilt; just surface for confirmation.
 */
function detectF8(snap) {
    if (!snap || !snap.chainConfig) return null;
    const expected = snap.chainConfig.binaryVersion;
    const actual = snap.ruleState && snap.ruleState.lastBinaryVersion;
    if (!expected || !actual) return null;
    if (expected === actual) return null;

    return {
        ruleId: 'F8',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        summaryAction: `Binary version changed (${expected} → ${actual})`,
        summaryReason: `The ela binary at ${snap.chainConfig.binaryPath} now reports ${actual}; ENM expected ${expected}. Confirm to update the recorded version.`,
        payload: { action: 'version-record', chainId: snap.chainId, version: actual },
    };
}

/**
 * F9 — config file failed validation. Joi error from ConfigStore.load.
 * Action: offer rollback to the .bak file produced on the previous save.
 */
function detectF9(snap) {
    if (!snap || !snap.configValidation) return null;
    if (snap.configValidation.ok) return null;

    return {
        ruleId: 'F9',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        summaryAction: 'Rollback config to previous version',
        summaryReason: `Validation failed: ${snap.configValidation.error || 'unknown'}. The previous .bak version is still on disk.`,
        payload: { action: 'config-rollback', chainId: snap.chainId },
    };
}

/**
 * F10 — RPC password not set. The chain config exists but rpc.passwordEncrypted
 * is missing or empty. Without it we cannot start the chain.
 */
function detectF10(snap) {
    if (!snap || !snap.chainConfig || !snap.chainConfig.rpc) return null;
    const enc = snap.chainConfig.rpc.passwordEncrypted;
    if (typeof enc === 'string' && enc.length > 0) return null;

    return {
        ruleId: 'F10',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        summaryAction: `Set RPC password for ${snap.chainId}`,
        summaryReason: 'RPC password is unset. Open Settings → Mainchain Advanced and provide one.',
        payload: { action: 'open-settings', chainId: snap.chainId, deepLink: 'settings.mainchain.advanced.rpc' },
    };
}

/**
 * F11 — BPoS: arbiter rotation stuck.
 *
 * Detection: snap.bpos.rotationStuck is set by the slow-tick when comparing
 * `getarbitratorgroupbyheight` results across consecutive rounds. The actual
 * compare lives in HealthChecker so this rule stays pure.
 *
 * Tier CRITICAL_NOTIFY — the operator must investigate; we never automate.
 */
function detectF11(snap) {
    if (!snap || !snap.bpos) return null;
    if (!snap.bpos.rotationStuck) return null;
    return {
        ruleId: 'F11',
        tier: HEALING_TIERS.CRITICAL_NOTIFY,
        severity: 'CRITICAL',
        summaryAction: `BPoS arbiter rotation stuck on ${snap.chainId}`,
        summaryReason:
            'getarbitratorgroupbyheight reports the same on-duty arbiter index '
            + 'across consecutive heights with our node listed in the empty slot. '
            + 'Investigate consensus state — Node Manager will not auto-recover.',
        payload: { action: 'bpos-rotation-investigate', chainId: snap.chainId, bpos: snap.bpos },
    };
}

/**
 * F12 — BPoS: producer in Inactive state, approaching forced-inactive penalty.
 *
 * Detection: getproducerinfo(ourPubkey) returned state="Inactive" in the slow
 * tick. We compute (currentHeight - inactiveheight); warn at >720 rounds, fire
 * CRITICAL_NOTIFY at >1300 (~10% slack from MAX_INACTIVE_ROUNDS=1440 before
 * permanent penalty).
 *
 * Action: NEVER_AUTOMATIC. ActivateProducer requires the operator's owner
 * key, which Node Manager intentionally does not hold (Rev 6 RNG findings).
 * The summary points the operator at ela-cli.
 */
function detectF12(snap) {
    if (!snap || !snap.bpos || !snap.bpos.producer) return null;
    const p = snap.bpos.producer;

    // Producer state machine has 6 values (Pending/Active/Inactive/Canceled/
    // Illegal/Returned per dpos/state/state.go:36-60). Inactive is the only
    // recoverable-by-operator state — Canceled means the operator already
    // signed CancelProducer and the deposit is frozen until the timelock
    // expires. Returned means the deposit was already withdrawn. Illegal
    // means the producer was caught misbehaving and forfeited the deposit.
    // None of those are actionable here, so we stay silent and let the
    // operator see the state in the chain card without an alert.
    if (p.state !== 'Inactive') return null;

    const inactiveRounds = (typeof p.inactiveRounds === 'number') ? p.inactiveRounds : null;
    if (inactiveRounds == null) return null;

    if (inactiveRounds < PRODUCER_INACTIVE_WARN) {
        return null;
    }

    const isCritical = inactiveRounds >= PRODUCER_INACTIVE_CRITICAL;
    return {
        ruleId: 'F12',
        tier: HEALING_TIERS.NEVER_AUTOMATIC,
        severity: isCritical ? 'CRITICAL' : 'WARNING',
        summaryAction: `Producer Inactive — run ActivateProducer (${inactiveRounds}/${MAX_INACTIVE_ROUNDS} rounds)`,
        summaryReason:
            `Your producer is in Inactive state. ${isCritical ? 'Critical: ' : ''}`
            + `${inactiveRounds} rounds elapsed (${MAX_INACTIVE_ROUNDS} = forced inactive). `
            + 'Sign and submit an ActivateProducer transaction via ela-cli within the '
            + '6-block window — Node Manager cannot do this for you.',
        payload: {
            action: 'bpos-activate-producer',
            chainId: snap.chainId,
            inactiveRounds,
            inactiveHeight: p.inactiveHeight,
        },
    };
}

/**
 * F13 — host clock skew exceeds CLOCK_SKEW_WARN_MS.
 *
 * Detection: snap.clockSkew is set by the slow-tick from ClockSkewChecker.
 * Fail-soft: when ok=false (no internet, captive portal), we don't fire
 * CRITICAL — the operator may legitimately be on an air-gapped network.
 */
function detectF13(snap) {
    if (!snap || !snap.clockSkew) return null;
    if (!snap.clockSkew.ok) return null;
    const abs = Math.abs(snap.clockSkew.skewMs);
    if (abs <= CLOCK_SKEW_WARN_MS) return null;

    return {
        ruleId: 'F13',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        severity: 'WARNING',
        summaryAction: `Host clock drift detected (${abs} ms)`,
        summaryReason:
            `Host clock differs from ${snap.clockSkew.endpoint || 'reference'} by ${abs} ms. `
            + 'ELA Schnorr signing fails silently above ~4.2 s — fix NTP before that. '
            + 'Linux: sudo systemctl restart chrony  (or: sudo ntpdate -s pool.ntp.org).',
        payload: { action: 'ntp-suggestion', chainId: snap.chainId, skewMs: snap.clockSkew.skewMs },
    };
}

/**
 * F16 — peer count zero >= 10 minutes (extends F3's 5 min auto-restart).
 * If F3's auto-restart didn't recover the peer set, the DNS seeds may be down
 * or our network egress is broken. Surface a CRITICAL with fallback peer
 * config suggestions; engine should NOT auto-restart again.
 */
function detectF16(snap) {
    if (!snap || !snap.processStatus || !snap.processStatus.alive) return null;
    if (!snap.rpcSummary || !snap.rpcSummary.ok) return null;
    if (snap.rpcSummary.peers !== 0) return null;

    const firstZero = snap.ruleState && snap.ruleState.firstPeerZeroAt;
    if (!firstZero) return null;
    if (Date.now() - firstZero < PEER_ZERO_FALLBACK_MS) return null;

    return {
        ruleId: 'F16',
        tier: HEALING_TIERS.CRITICAL_NOTIFY,
        severity: 'CRITICAL',
        summaryAction: `${snap.chainId}: still zero peers after auto-restart`,
        summaryReason:
            'Peer count has been 0 for >10 minutes. F3 auto-restart did not help. '
            + 'DNS seeds may be unreachable. Open Settings → Network → Permanent peers '
            + 'and add a fallback list (foundation/community-operated nodes).',
        payload: { action: 'fallback-peers', chainId: snap.chainId },
    };
}

/**
 * F18 — outbound peers > 0 but inbound peers = 0 for >= 5 minutes.
 *
 * BPoS supernodes must accept inbound P2P (port 20338) AND DPoS p2p (20339).
 * If we see only outbound, the operator's NAT/UPnP isn't forwarding ports —
 * we'll silently get penalized for missed votes despite the chain "looking
 * fine" by other metrics.
 *
 * snap.rpcSummary.inboundCount and outboundCount are populated by HealthChecker
 * from `getnodestate.Neighbors[].Inbound`.
 */
function detectF18(snap) {
    if (!snap || !snap.processStatus || !snap.processStatus.alive) return null;
    if (!snap.rpcSummary || !snap.rpcSummary.ok) return null;
    if (typeof snap.rpcSummary.inboundCount !== 'number') return null;
    if (typeof snap.rpcSummary.outboundCount !== 'number') return null;
    if (snap.rpcSummary.inboundCount > 0) return null;
    if (snap.rpcSummary.outboundCount === 0) return null; // F3 owns the no-peers case

    const firstNoInbound = snap.ruleState && snap.ruleState.firstNoInboundAt;
    if (!firstNoInbound) return null;
    if (Date.now() - firstNoInbound < NO_INBOUND_GRACE_MS) return null;

    // beta.3.27 — gate severity on whether the operator is actually a
    // BPoS supernode. The "missed votes accumulate silently" framing
    // only applies if the node is registered as a producer. On a
    // follower / observer node the same condition is technically true
    // (cloud hosters typically block inbound by default) but the
    // consequence is just less peer diversity, not slashing risk.
    // Operator on srv832310 (Hostinger, no BPoS registration) hit
    // this as a CRITICAL alert with copy that didn't match their
    // situation. Downgrade for non-BPoS; keep the urgent shape for
    // BPoS operators where ports actually matter.
    const isBpos = !!(snap.chainConfig && snap.chainConfig.dpos
        && snap.chainConfig.dpos.enableArbiter);

    if (isBpos) {
        return {
            ruleId: 'F18',
            tier: HEALING_TIERS.CRITICAL_NOTIFY,
            severity: 'CRITICAL',
            summaryAction: `${snap.chainId}: no inbound peers — firewall blocking 20338/20339?`,
            summaryReason:
                'Outbound peers > 0 but inbound = 0. BPoS requires inbound on P2P (20338) '
                + 'and DPoS p2p (20339) to receive consensus messages. On a hosted VPS the '
                + 'usual cause is the host firewall: run `sudo ufw allow 20338/tcp && '
                + 'sudo ufw allow 20339/tcp` (verified fix on srv832310, 2026-05-15). At '
                + 'home behind a router: forward those ports or enable UPnP. Either way, '
                + 'missed votes accumulate silently.',
            payload: {
                action: 'nat-forward',
                chainId: snap.chainId,
                ports: [20338, 20339],
            },
        };
    }

    return {
        ruleId: 'F18',
        tier: HEALING_TIERS.OWNER_CONFIRMS,
        severity: 'INFO',
        summaryAction: `${snap.chainId}: no inbound peers (firewall blocking 20338/20339)`,
        summaryReason:
            'Your node has outbound peers but isn’t reachable from the network. Common '
            + 'cause on a hosted VPS: host firewall (UFW) is active and doesn’t allow '
            + '20338 / 20339 inbound. Quick check: `sudo ufw status verbose` — if active '
            + 'and the chain ports aren’t in the allow list, run `sudo ufw allow 20338/tcp '
            + '&& sudo ufw allow 20339/tcp`. Otherwise harmless for a follower node, but '
            + 'mandatory before you register as a BPoS supernode.',
        payload: {
            action: 'nat-forward-info',
            chainId: snap.chainId,
            ports: [20338, 20339],
        },
    };
}

/**
 * F19 — host conflict detected at runtime.
 *
 * Mirrors the setup-time scanner but fires inside the slow tick so a
 * conflict introduced AFTER setup (e.g., operator manually started node.sh,
 * or systemd auto-started a stale unit on reboot) gets surfaced even though
 * setup completed successfully.
 *
 * snap.hostConflicts is populated by HealthChecker via HostConflictScanner.
 * Only CRITICAL conflicts fire the rule; warnings stay quiet to avoid
 * notification spam — they're visible in the dashboard banner instead.
 */
function detectF19(snap) {
    if (!snap || !Array.isArray(snap.hostConflicts)) return null;
    const blockers = snap.hostConflicts.filter((c) => c && c.severity === 'CRITICAL');
    if (blockers.length === 0) return null;

    // Pick the most-actionable type to put in the title; the full list lives
    // in the proposal payload so the operator can read every entry.
    const titles = blockers.map((c) => c.description).slice(0, 3);
    const summary = `Host conflict on ${snap.chainId}: ${titles[0]}`;
    return {
        ruleId: 'F19',
        tier: HEALING_TIERS.CRITICAL_NOTIFY,
        severity: 'CRITICAL',
        summaryAction: summary,
        summaryReason:
            (titles.length > 1
                ? `Plus ${blockers.length - 1} more conflict(s). `
                : '')
            + 'Open the Conflicts panel to resolve before the next restart.',
        payload: {
            action: 'host-conflict',
            chainId: snap.chainId,
            conflicts: blockers,
        },
    };
}

/**
 * Per-rule enable defaults. Per Architectural Invariant #7, healing ships
 * with F1 (auto-restart on unexpected exit) only. F2-F19 are off until
 * the operator opts in via /api/enm/healing/rules/:ruleId/enable.
 *
 * Why: prior versions ran every rule on every tick, producing 12 audit-log
 * events per hour for the same conflict (the operator's F4/F19 spam). With
 * F1-only, default installs see exactly one event per actual incident.
 *
 * Operators who want the full healing suite back can either flip these in
 * code or hit the per-rule enable endpoint. The detection logic stays
 * intact — we only gate which detectors actually run.
 */
/**
 * beta.3.21 — static metadata for the Settings → Security "What
 * auto-runs" panel. The detect functions construct tier + summary
 * at runtime when they fire, but the UI needs to list the rules
 * BEFORE any of them fires so the operator can see what the toggle
 * actually controls. The tier here MUST match what each detect
 * function returns; the description is operator-facing copy.
 */
const RULE_METADATA = Object.freeze({
    F1:  { tier: 'AUTOMATED_SAFE',  title: 'Auto-restart on crash',
           description: 'If the ela process exits unexpectedly (non-zero or SIGKILL) and the operator didn’t manually stop it, restart it.' },
    F2:  { tier: 'AUTOMATED_SAFE',  title: 'Restart on stuck RPC',
           description: 'If the chain’s RPC stops responding for over 2 minutes while the process is alive, restart it.' },
    F3:  { tier: 'AUTOMATED_SAFE',  title: 'Restart on peer-zero',
           description: 'If peer count stays at 0 longer than your alert threshold, restart so ela reseeds peers from DNS.' },
    F4:  { tier: 'OWNER_CONFIRMS',  title: 'Restart on sync stall',
           description: 'If block height hasn’t advanced for over your sync-stall threshold despite peers, ask the operator before restarting.' },
    F5:  { tier: 'OWNER_CONFIRMS',  title: 'Disk space low',
           description: 'Surface a notice when free disk drops below the warn / critical thresholds in the Alerts section. Action stays operator-driven (ENM never deletes operator data).' },
    F6:  { tier: 'OWNER_CONFIRMS',  title: 'Process killed by OOM',
           description: 'If ela was SIGKILL’d (Linux OOM), suggest raising the memory limit instead of just restarting blindly.' },
    F7:  { tier: 'OWNER_CONFIRMS',  title: 'Binary version drift',
           description: 'Notice when the binary on disk differs from the last-known-good version recorded at install.' },
    F8:  { tier: 'OWNER_CONFIRMS',  title: 'Height regression',
           description: 'If the chain rolls back blocks (rare; reorg or DB corruption), surface a notice for owner attention.' },
    F9:  { tier: 'OWNER_CONFIRMS',  title: 'Config drift on disk',
           description: 'Notice when ela.conf on disk has been edited outside of ENM (manual operator change).' },
    F10: { tier: 'OWNER_CONFIRMS',  title: 'RPC password rotation reminder',
           description: 'Periodic suggestion to rotate the RPC password.' },
    F11: { tier: 'CRITICAL_NOTIFY', title: 'BPoS deposit drift',
           description: 'On-chain locked deposit no longer matches the original 2,000 ELA stake — surface a critical alert.' },
    F12: { tier: 'NEVER_AUTOMATIC', title: 'Producer inactiveRounds rising',
           description: 'Producer is missing rounds and approaching the forced-inactive penalty at 1,440. Manual investigation only.' },
    F13: { tier: 'OWNER_CONFIRMS',  title: 'Clock skew',
           description: 'NTP skew above 2 s — close to ela’s 4.2 s tolerance for block validation. Suggest fixing systemd-timesyncd.' },
    F16: { tier: 'CRITICAL_NOTIFY', title: 'Peer-zero fallback',
           description: 'Promotes a peer-zero condition to a fallback peer suggestion when restart-by-restart hasn’t helped.' },
    F18: { tier: 'CRITICAL_NOTIFY', title: 'BPoS no-inbound',
           description: 'BPoS needs inbound peers to publish proposals. Surface a critical alert if there have been none for 5 minutes.' },
    F19: { tier: 'CRITICAL_NOTIFY', title: 'Host port conflict',
           description: 'Another process on this host is bound to a port ela needs (20338 / 20339 / 20336). Surface critical for operator triage.' },
});

// beta.3.22 — every rule is enabled by default. The operator-facing
// audit found EVERY rule except F1 was sitting off, which made the
// "Auto-execute safe healing" toggle nearly meaningless: even the
// alerts that just notify (CRITICAL_NOTIFY tier) never fired. Per
// directive #4 ("automatic for the user"), the healing system should
// work out-of-the-box without the operator hand-toggling 15
// detectors. Grace periods on each detect function (peer-zero ≥5min,
// RPC unreachable ≥2min, height stall ≥10min, etc.) absorb normal
// startup / transient conditions, so flipping the default to true is
// safe — false positives during boot are gated by the grace timers,
// not by the rule being off.
const DEFAULT_ENABLED = Object.freeze({
    F1: true,   // process exited unexpectedly → auto-restart
    F2: true,   // RPC unreachable (2-min grace)
    F3: true,   // peer count zero (5-min grace, operator-tunable)
    F4: true,   // sync stalled (10-min grace, operator-tunable)
    F5: true,   // disk space (operator-tunable thresholds)
    F6: true,   // OOM killed
    F7: true,   // binary version drift
    F8: true,   // height regression
    F9: true,   // config drift on disk
    F10: true,  // RPC password rotation reminder
    F11: true,  // BPoS deposit drift
    F12: true,  // producer inactiveRounds (NEVER_AUTOMATIC; alert only)
    F13: true,  // clock skew
    F16: true,  // peer-zero fallback
    F18: true,  // BPoS no-inbound
    F19: true,  // host conflict (HostConflictScanner has its own dedup)
});

const _enabledOverrides = new Map();
function setRuleEnabled(ruleId, enabled) {
    _enabledOverrides.set(ruleId, !!enabled);
}
function isRuleEnabled(ruleId) {
    if (_enabledOverrides.has(ruleId)) return _enabledOverrides.get(ruleId);
    return !!DEFAULT_ENABLED[ruleId];
}
function listRuleStates() {
    const all = Object.keys(DEFAULT_ENABLED);
    return all.map((ruleId) => ({
        ruleId,
        defaultEnabled: DEFAULT_ENABLED[ruleId],
        currentlyEnabled: isRuleEnabled(ruleId),
        overridden: _enabledOverrides.has(ruleId),
    }));
}

/**
 * beta.3.21 — full metadata + state per rule for the Settings →
 * Security visibility panel. Combines RULE_METADATA (static
 * description + tier) with DEFAULT_ENABLED + override state so the
 * UI can render the operator-facing "what would auto-run" list in
 * one round trip.
 */
function listRulesMetadata() {
    const all = Object.keys(DEFAULT_ENABLED);
    return all.map((ruleId) => {
        const meta = RULE_METADATA[ruleId] || {};
        return {
            ruleId,
            tier: meta.tier || 'OWNER_CONFIRMS',
            title: meta.title || ruleId,
            description: meta.description || '',
            defaultEnabled: !!DEFAULT_ENABLED[ruleId],
            currentlyEnabled: isRuleEnabled(ruleId),
            overridden: _enabledOverrides.has(ruleId),
        };
    });
}

/**
 * Run F1-F19 in declaration order. Engine consumes the array as a queue —
 * higher-priority rules (F1 process-dead) appear first so a single tick
 * doesn't propose conflicting actions.
 *
 * @param {HealthSnapshot} snap
 * @returns {Array<Detection>}
 */
function runAll(snap) {
    /** @type {Array<Detection>} */
    const out = [];
    const detectors = [
        ['F1',  detectF1],  ['F2',  detectF2],  ['F3',  detectF3],
        ['F4',  detectF4],  ['F5',  detectF5],  ['F6',  detectF6],
        ['F7',  detectF7],  ['F8',  detectF8],  ['F9',  detectF9],
        ['F10', detectF10], ['F11', detectF11], ['F12', detectF12],
        ['F13', detectF13], ['F16', detectF16], ['F18', detectF18],
        ['F19', detectF19],
    ];
    for (const [ruleId, fn] of detectors) {
        if (!isRuleEnabled(ruleId)) continue;
        const d = fn(snap);
        if (d) out.push(d);
    }
    return out;
}

module.exports = {
    runAll,
    DEFAULT_ENABLED,
    setRuleEnabled,
    isRuleEnabled,
    listRuleStates,
    listRulesMetadata,
    RULE_METADATA,
    // beta.3.19 — operator-tunable thresholds (Phase 2 Alerts section).
    setThresholds,
    getThresholds,
    detectF1, detectF2, detectF3, detectF4, detectF5,
    detectF6, detectF7, detectF8, detectF9, detectF10,
    detectF11, detectF12, detectF13, detectF16, detectF18,
    detectF19,
    PEER_ZERO_GRACE_MS,
    RPC_UNREACHABLE_GRACE_MS,
    HEIGHT_STALL_GRACE_MS,
    DISK_CRITICAL_GB,
    DISK_WARN_GB,
    PEER_ZERO_FALLBACK_MS,
    NO_INBOUND_GRACE_MS,
    CLOCK_SKEW_WARN_MS,
    PRODUCER_INACTIVE_WARN,
    PRODUCER_INACTIVE_CRITICAL,
};
