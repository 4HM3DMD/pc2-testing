/**
 * SPEC: GracefulRestart — drain orchestrator for hybrid-capsule
 * update flows.
 *
 * Coverage: phase ordering, broadcast eta wait, drain timeout
 * propagation, all hooks invoked even when one throws (best-effort
 * teardown), report shape, coalescing concurrent restart calls,
 * skipBroadcastWait fast-path, exit hook called last, constructor
 * validation, clamp ranges.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../../src/services/GracefulRestart.js';
let GracefulRestart, GracefulRestartError;

try {
    ({ GracefulRestart, GracefulRestartError } = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] GracefulRestart not yet implemented: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!GracefulRestart) {
        t.skip('GracefulRestart not yet implemented (Wave 7 / M9)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeStubHooks(overrides = {}) {
    const log = [];
    const stub = {
        log,
        onBroadcast: async (eta, cause) => { log.push({ phase: 'broadcast', eta, cause }); },
        onStopAcceptingConnections: async () => { log.push({ phase: 'stop-accepting' }); },
        waitForInFlight: async (deadlineMs) => {
            log.push({ phase: 'drain-in-flight', deadlineMs });
            return { drained: true, pending: 0 };
        },
        onCloseSseConnections: async () => { log.push({ phase: 'close-sse' }); },
        onCloseWebSockets: async () => { log.push({ phase: 'close-ws' }); },
        onExit: () => { log.push({ phase: 'exit' }); },
        ...overrides,
    };
    return stub;
}

// ---------------------------------------------------------------------------
// Phase ordering — the load-bearing invariant
// ---------------------------------------------------------------------------

test('restart: phases fire in correct order', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);

    const report = await orch.restart({
        cause: 'test:basic',
        broadcastEtaSeconds: 0,   // skip the wait
        finalSettleMs: 0,
    });

    assert.deepEqual(
        hooks.log.map(e => e.phase),
        [
            'broadcast',
            'stop-accepting',
            'drain-in-flight',
            'close-sse',
            'close-ws',
            'exit',
        ],
    );
    assert.equal(report.cause, 'test:basic');
    assert.equal(report.exitCalled, true);
    assert.equal(report.drained, true);
    assert.equal(report.pendingAtDeadline, 0);
});

test('restart: broadcast hook receives eta + cause', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);

    await orch.restart({ cause: 'update:enm', broadcastEtaSeconds: 0, finalSettleMs: 0 });
    const broadcast = hooks.log.find(e => e.phase === 'broadcast');
    assert.equal(broadcast.eta, 0);
    assert.equal(broadcast.cause, 'update:enm');
});

test('restart: waitForInFlight gets drainTimeoutMs', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, drainTimeoutMs: 7000, finalSettleMs: 0,
    });
    const drain = hooks.log.find(e => e.phase === 'drain-in-flight');
    assert.equal(drain.deadlineMs, 7000);
});

// ---------------------------------------------------------------------------
// Broadcast eta wait
// ---------------------------------------------------------------------------

test('restart: actually waits broadcastEtaSeconds before stop-accepting', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    const start = Date.now();
    await orch.restart({
        cause: 'x', broadcastEtaSeconds: 1, finalSettleMs: 0,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 950, `expected ≥1s, got ${elapsed}ms`);
});

test('restart: skipBroadcastWait skips the eta delay', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    const start = Date.now();
    await orch.restart({
        cause: 'emergency', broadcastEtaSeconds: 5, skipBroadcastWait: true,
        finalSettleMs: 0,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Best-effort teardown — hooks that throw don't abort the sequence
// ---------------------------------------------------------------------------

test('restart: continues sequence even if a middle hook throws', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks({
        onCloseSseConnections: async () => { throw new Error('SSE close failed'); },
    });
    const orch = new GracefulRestart(hooks);
    const report = await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, finalSettleMs: 0,
    });
    // close-ws + exit should still have fired
    assert.ok(hooks.log.some(e => e.phase === 'close-ws'));
    assert.equal(report.exitCalled, true);
});

test('restart: surfaces drained=false when waitForInFlight reports timeout', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks({
        waitForInFlight: async () => ({ drained: false, pending: 3 }),
    });
    const orch = new GracefulRestart(hooks);
    const report = await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, finalSettleMs: 0,
    });
    assert.equal(report.drained, false);
    assert.equal(report.pendingAtDeadline, 3);
});

// ---------------------------------------------------------------------------
// Coalescing — concurrent restart calls share one teardown
// ---------------------------------------------------------------------------

test('restart: concurrent calls coalesce to one teardown', async (t) => {
    if (skipIfMissing(t)) return;
    let exitCalls = 0;
    const hooks = makeStubHooks({
        onExit: () => { exitCalls++; },
    });
    const orch = new GracefulRestart(hooks);

    const [a, b, c] = await Promise.all([
        orch.restart({ cause: 'a', broadcastEtaSeconds: 0, finalSettleMs: 0 }),
        orch.restart({ cause: 'b', broadcastEtaSeconds: 0, finalSettleMs: 0 }),
        orch.restart({ cause: 'c', broadcastEtaSeconds: 0, finalSettleMs: 0 }),
    ]);

    assert.equal(exitCalls, 1, 'three concurrent calls should trigger one exit');
    assert.equal(a.cause, b.cause);
    assert.equal(b.cause, c.cause);
    assert.equal(a.cause, 'a', 'first caller wins the cause');
});

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

test('report: includes per-phase elapsed times', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    const report = await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, finalSettleMs: 0,
    });
    const phaseNames = report.phases.map(p => p.phase);
    assert.deepEqual(phaseNames, [
        'broadcast', 'stop-accepting', 'drain-in-flight',
        'close-sse', 'close-ws', 'exit',
    ]);
    for (const p of report.phases) {
        assert.ok(typeof p.ms === 'number', `phase ${p.phase} should have numeric ms`);
        assert.ok(p.ms >= 0);
    }
});

test('report: durationMs reflects total elapsed', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    const start = Date.now();
    const report = await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, finalSettleMs: 50,
    });
    const elapsed = Date.now() - start;
    assert.ok(report.durationMs >= 50, `durationMs ${report.durationMs} should be ≥50`);
    assert.ok(Math.abs(report.durationMs - elapsed) < 100,
        `durationMs ${report.durationMs} should be close to actual elapsed ${elapsed}`);
});

// ---------------------------------------------------------------------------
// Final-settle window
// ---------------------------------------------------------------------------

test('restart: finalSettleMs runs after close-ws, before exit', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    const report = await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, finalSettleMs: 50,
    });
    // settle phase appears between close-ws and exit
    const order = report.phases.map(p => p.phase);
    const settleIdx = order.indexOf('settle');
    const closeWsIdx = order.indexOf('close-ws');
    const exitIdx = order.indexOf('exit');
    assert.ok(settleIdx > closeWsIdx);
    assert.ok(settleIdx < exitIdx);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test('ctor: throws if any of the 6 hooks is missing', (t) => {
    if (skipIfMissing(t)) return;
    const full = makeStubHooks();
    for (const k of ['onBroadcast', 'onStopAcceptingConnections', 'waitForInFlight',
                     'onCloseSseConnections', 'onCloseWebSockets', 'onExit']) {
        const partial = { ...full };
        delete partial[k];
        assert.throws(() => new GracefulRestart(partial), { name: 'TypeError' },
            `missing ${k} should throw`);
    }
});

test('ctor: throws when called with no hooks', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new GracefulRestart(), { name: 'TypeError' });
    assert.throws(() => new GracefulRestart(null), { name: 'TypeError' });
    assert.throws(() => new GracefulRestart({}), { name: 'TypeError' });
});

// ---------------------------------------------------------------------------
// Clamp ranges
// ---------------------------------------------------------------------------

test('restart: broadcastEtaSeconds capped at MAX (60)', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    // Pass an absurd value with skipBroadcastWait so the wait is skipped
    // (otherwise the test would actually wait 60s). Verify the broadcast
    // hook still gets the clamped value.
    await orch.restart({
        cause: 'x', broadcastEtaSeconds: 9999, skipBroadcastWait: true,
        finalSettleMs: 0,
    });
    const broadcast = hooks.log.find(e => e.phase === 'broadcast');
    assert.equal(broadcast.eta, 60);
});

test('restart: drainTimeoutMs negative becomes 0', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, drainTimeoutMs: -100, finalSettleMs: 0,
    });
    const drain = hooks.log.find(e => e.phase === 'drain-in-flight');
    assert.equal(drain.deadlineMs, 0);
});

test('restart: finalSettleMs of 0 skips the settle phase', async (t) => {
    if (skipIfMissing(t)) return;
    const hooks = makeStubHooks();
    const orch = new GracefulRestart(hooks);
    const report = await orch.restart({
        cause: 'x', broadcastEtaSeconds: 0, finalSettleMs: 0,
    });
    const phases = report.phases.map(p => p.phase);
    assert.ok(!phases.includes('settle'));
});
