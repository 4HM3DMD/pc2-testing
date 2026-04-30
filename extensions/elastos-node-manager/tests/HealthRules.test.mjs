/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * HealthRules tests — pure functions, fed minimal snapshots.
 * Verifies F1-F10 fire on the right inputs and stay quiet otherwise.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect } from 'vitest';

const HR = require('../lib/HealthRules');

function snap(overrides) {
    return Object.assign({
        chainId: 'mainchain',
        processStatus: { alive: true, pid: 100, attached: true },
        processExit: null,
        rpcSummary: null,
        diskInfo: null,
        ports: null,
        configValidation: null,
        chainConfig: { enabled: true, binaryPath: '/usr/local/bin/ela', binaryVersion: 'v0.9.9.5', rpc: { passwordEncrypted: 'x' } },
        ruleState: {
            firstPeerZeroAt: null,
            firstRpcDownAt: null,
            firstHeightStallAt: null,
            lastHeight: null,
            lastBinaryVersion: null,
            lastExit: null,
            restartAttempts: 0,
        },
    }, overrides);
}

describe('HealthRules.detectF1 — process exited unexpectedly', () => {
    it('fires when dead + non-zero exit + not manual stop', () => {
        const det = HR.detectF1(snap({
            processStatus: { alive: false, pid: null, attached: false },
            processExit: { code: 1, signal: null, manualStop: false, at: Date.now() },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F1');
        expect(det.tier).toBe('AUTOMATED-SAFE');
        expect(det.payload.action).toBe('restart');
    });

    it('does not fire on clean manualStop', () => {
        const det = HR.detectF1(snap({
            processStatus: { alive: false, pid: null, attached: false },
            processExit: { code: 0, signal: null, manualStop: true, at: Date.now() },
        }));
        expect(det).toBeNull();
    });

    it('does not fire on clean code-0 exit (operator-initiated SIGTERM)', () => {
        const det = HR.detectF1(snap({
            processStatus: { alive: false, pid: null, attached: false },
            processExit: { code: 0, signal: null, manualStop: false, at: Date.now() },
        }));
        expect(det).toBeNull();
    });

    it('does not fire while alive', () => {
        const det = HR.detectF1(snap({}));
        expect(det).toBeNull();
    });

    it('does not fire when chain is disabled (operator silenced it)', () => {
        const det = HR.detectF1(snap({
            chainConfig: { enabled: false },
            processStatus: { alive: false, pid: null, attached: false },
            processExit: { code: 137, signal: 'SIGKILL', manualStop: false, at: Date.now() },
        }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF2 — RPC unreachable >2 min', () => {
    it('fires after RPC_UNREACHABLE_GRACE_MS', () => {
        const det = HR.detectF2(snap({
            rpcSummary: { ok: false, errCode: 'RpcUnreachableError' },
            ruleState: { firstRpcDownAt: Date.now() - HR.RPC_UNREACHABLE_GRACE_MS - 10 },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F2');
    });

    it('does not fire within grace window', () => {
        const det = HR.detectF2(snap({
            rpcSummary: { ok: false, errCode: 'RpcUnreachableError' },
            ruleState: { firstRpcDownAt: Date.now() - 10_000 },
        }));
        expect(det).toBeNull();
    });

    it('does not fire if RPC ok', () => {
        const det = HR.detectF2(snap({ rpcSummary: { ok: true } }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF3 — peers=0 >5 min', () => {
    it('fires when peers=0 sustained beyond grace window', () => {
        const det = HR.detectF3(snap({
            rpcSummary: { ok: true, peers: 0 },
            ruleState: { firstPeerZeroAt: Date.now() - HR.PEER_ZERO_GRACE_MS - 1 },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F3');
    });

    it('does not fire if peers > 0', () => {
        const det = HR.detectF3(snap({
            rpcSummary: { ok: true, peers: 4 },
            ruleState: { firstPeerZeroAt: null },
        }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF4 — sync stalled >10 min', () => {
    it('fires when height unchanged across grace window', () => {
        const det = HR.detectF4(snap({
            rpcSummary: { ok: true, height: 100, peers: 5 },
            ruleState: { firstHeightStallAt: Date.now() - HR.HEIGHT_STALL_GRACE_MS - 1, lastHeight: 100 },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F4');
        expect(det.tier).toBe('OWNER-CONFIRMS');
    });

    it('does not fire when peers=0 (F3 owns that case)', () => {
        const det = HR.detectF4(snap({
            rpcSummary: { ok: true, height: 100, peers: 0 },
            ruleState: { firstHeightStallAt: Date.now() - HR.HEIGHT_STALL_GRACE_MS - 1 },
        }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF5 — disk free', () => {
    it('fires CRITICAL severity below DISK_CRITICAL_GB', () => {
        const det = HR.detectF5(snap({ diskInfo: { freeGb: 2.0, totalGb: 100 } }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F5');
        expect(det.severity).toBe('CRITICAL');
    });

    it('fires WARNING severity in 5-20 GB band', () => {
        const det = HR.detectF5(snap({ diskInfo: { freeGb: 12.0, totalGb: 100 } }));
        expect(det).not.toBeNull();
        expect(det.severity).toBe('WARNING');
    });

    it('quiet above warn threshold', () => {
        const det = HR.detectF5(snap({ diskInfo: { freeGb: 200, totalGb: 1000 } }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF6 — OOM SIGKILL', () => {
    it('fires when process was SIGKILLed and not manually stopped', () => {
        const det = HR.detectF6(snap({
            processExit: { code: null, signal: 'SIGKILL', manualStop: false, at: Date.now() },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F6');
        expect(det.payload.action).toBe('oom-suggestion');
    });

    it('does not fire on operator manualStop', () => {
        const det = HR.detectF6(snap({
            processExit: { code: null, signal: 'SIGKILL', manualStop: true, at: Date.now() },
        }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF7 — port conflict', () => {
    it('fires when ports.conflicting non-empty', () => {
        const det = HR.detectF7(snap({
            ports: { conflicting: [{ port: 20336, role: 'rpc' }] },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F7');
    });

    it('quiet when no conflicts', () => {
        const det = HR.detectF7(snap({ ports: { conflicting: [] } }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF8 — binary version drift', () => {
    it('fires when actual differs from expected', () => {
        const det = HR.detectF8(snap({
            chainConfig: { binaryVersion: 'v0.9.9.5', binaryPath: '/x' },
            ruleState: { lastBinaryVersion: 'v0.9.9.6' },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F8');
    });

    it('quiet when versions match', () => {
        const det = HR.detectF8(snap({
            chainConfig: { binaryVersion: 'v0.9.9.5', binaryPath: '/x' },
            ruleState: { lastBinaryVersion: 'v0.9.9.5' },
        }));
        expect(det).toBeNull();
    });

    it('quiet when actual version not yet known', () => {
        const det = HR.detectF8(snap({
            chainConfig: { binaryVersion: 'v0.9.9.5', binaryPath: '/x' },
            ruleState: { lastBinaryVersion: null },
        }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF9 — config validation failed', () => {
    it('fires with rollback suggestion when validation fails', () => {
        const det = HR.detectF9(snap({ configValidation: { ok: false, error: 'port out of range' } }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F9');
        expect(det.payload.action).toBe('config-rollback');
    });

    it('quiet when validation ok', () => {
        const det = HR.detectF9(snap({ configValidation: { ok: true } }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF10 — RPC password unset', () => {
    it('fires when rpc.passwordEncrypted is missing', () => {
        const det = HR.detectF10(snap({
            chainConfig: { rpc: { passwordEncrypted: '' } },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F10');
    });

    it('quiet when password is set', () => {
        const det = HR.detectF10(snap({
            chainConfig: { rpc: { passwordEncrypted: 'aes256gcm-blob' } },
        }));
        expect(det).toBeNull();
    });
});

describe('HealthRules.detectF11 — BPoS arbiter rotation stuck', () => {
    it('fires CRITICAL when bpos.rotationStuck is true', () => {
        const det = HR.detectF11(snap({ bpos: { rotationStuck: true, producer: null } }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F11');
        expect(det.tier).toBe('CRITICAL-NOTIFY');
        expect(det.severity).toBe('CRITICAL');
    });
    it('quiet when not stuck', () => {
        expect(HR.detectF11(snap({ bpos: { rotationStuck: false, producer: null } }))).toBeNull();
    });
    it('quiet when bpos absent (non-arbiter mode)', () => {
        expect(HR.detectF11(snap({}))).toBeNull();
    });
});

describe('HealthRules.detectF12 — BPoS producer Inactive', () => {
    it('quiet when state is Active', () => {
        expect(HR.detectF12(snap({
            bpos: { producer: { state: 'Active', inactiveRounds: null } },
        }))).toBeNull();
    });
    it('quiet when inactiveRounds below WARN threshold', () => {
        expect(HR.detectF12(snap({
            bpos: { producer: { state: 'Inactive', inactiveRounds: 100 } },
        }))).toBeNull();
    });
    it('fires WARNING in 720..1300 band', () => {
        const det = HR.detectF12(snap({
            bpos: { producer: { state: 'Inactive', inactiveRounds: 800 } },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F12');
        expect(det.tier).toBe('NEVER-AUTOMATIC');
        expect(det.severity).toBe('WARNING');
    });
    it('fires CRITICAL above 1300', () => {
        const det = HR.detectF12(snap({
            bpos: { producer: { state: 'Inactive', inactiveRounds: 1400 } },
        }));
        expect(det.severity).toBe('CRITICAL');
    });
});

describe('HealthRules.detectF13 — clock skew', () => {
    it('quiet under threshold', () => {
        expect(HR.detectF13(snap({ clockSkew: { ok: true, skewMs: 500 } }))).toBeNull();
    });
    it('fires above CLOCK_SKEW_WARN_MS in either direction', () => {
        const fwd = HR.detectF13(snap({ clockSkew: { ok: true, skewMs: 5_000 } }));
        const back = HR.detectF13(snap({ clockSkew: { ok: true, skewMs: -3_000 } }));
        expect(fwd).not.toBeNull();
        expect(back).not.toBeNull();
        expect(fwd.ruleId).toBe('F13');
    });
    it('fail-soft when ok=false (no internet)', () => {
        expect(HR.detectF13(snap({ clockSkew: { ok: false, reason: 'offline' } }))).toBeNull();
    });
});

describe('HealthRules.detectF16 — peer count zero >= 10 min', () => {
    it('fires after PEER_ZERO_FALLBACK_MS', () => {
        const det = HR.detectF16(snap({
            rpcSummary: { ok: true, peers: 0 },
            ruleState: { firstPeerZeroAt: Date.now() - HR.PEER_ZERO_FALLBACK_MS - 1 },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F16');
        expect(det.tier).toBe('CRITICAL-NOTIFY');
    });
    it('quiet within F3 band (under 10 min)', () => {
        expect(HR.detectF16(snap({
            rpcSummary: { ok: true, peers: 0 },
            ruleState: { firstPeerZeroAt: Date.now() - 2 * 60_000 },
        }))).toBeNull();
    });
});

describe('HealthRules.detectF18 — no inbound peers', () => {
    it('fires when outbound>0 but inbound=0 sustained', () => {
        const det = HR.detectF18(snap({
            rpcSummary: { ok: true, peers: 4, inboundCount: 0, outboundCount: 4 },
            ruleState: { firstNoInboundAt: Date.now() - HR.NO_INBOUND_GRACE_MS - 1 },
        }));
        expect(det).not.toBeNull();
        expect(det.ruleId).toBe('F18');
        expect(det.tier).toBe('CRITICAL-NOTIFY');
    });
    it('quiet when inbound > 0', () => {
        expect(HR.detectF18(snap({
            rpcSummary: { ok: true, peers: 4, inboundCount: 1, outboundCount: 3 },
            ruleState: { firstNoInboundAt: Date.now() - HR.NO_INBOUND_GRACE_MS - 1 },
        }))).toBeNull();
    });
    it('quiet when outbound=0 (F3 owns it)', () => {
        expect(HR.detectF18(snap({
            rpcSummary: { ok: true, peers: 0, inboundCount: 0, outboundCount: 0 },
            ruleState: { firstNoInboundAt: Date.now() - HR.NO_INBOUND_GRACE_MS - 1 },
        }))).toBeNull();
    });
});

describe('HealthRules.runAll', () => {
    it('returns detections in declaration order', () => {
        const dets = HR.runAll(snap({
            processStatus: { alive: false, pid: null, attached: false },
            processExit: { code: 137, signal: 'SIGKILL', manualStop: false, at: Date.now() },
            diskInfo: { freeGb: 2, totalGb: 100 },
            ports: { conflicting: [{ port: 20336, role: 'rpc' }] },
        }));
        // F1 should come before F5 / F6 / F7 in the array.
        const ids = dets.map((d) => d.ruleId);
        const idxF1 = ids.indexOf('F1');
        const idxF6 = ids.indexOf('F6');
        const idxF5 = ids.indexOf('F5');
        const idxF7 = ids.indexOf('F7');
        expect(idxF1).toBeGreaterThanOrEqual(0);
        expect(idxF5).toBeGreaterThan(idxF1);
        expect(idxF6).toBeGreaterThan(idxF5);
        expect(idxF7).toBeGreaterThan(idxF6);
    });
});
