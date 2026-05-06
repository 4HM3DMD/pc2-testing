/**
 * SPEC: LazyExtensionLoader — registry + state machine + crash quarantine.
 *
 * Helper location:
 *   pc2-node/src/services/LazyExtensionLoader.ts
 *
 * Purpose:
 *   Track installed hybrid capsules with a state machine
 *   (registered → loading → loaded | failed | quarantined | safe-mode).
 *   On ensureLoaded(name): probe in child process, then call the
 *   integrating layer's loadHook to do the actual main-process require.
 *   Count crashes in a rolling window; quarantine after threshold.
 *
 *   Tests use stub probeFn + loadHook so they exercise the state
 *   machine in isolation (the real probe + child-process behaviour
 *   is covered by extension-probe.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HELPER_PATH = '../src/services/LazyExtensionLoader.js';
let LazyExtensionLoader, LoaderError;

try {
    ({ LazyExtensionLoader, LoaderError } = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] LazyExtensionLoader not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!LazyExtensionLoader) {
        t.skip('LazyExtensionLoader not yet implemented (Wave 7 / M3)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Test scaffolding: temp dirs + stub manifests / probes / load hooks
// ---------------------------------------------------------------------------

function makeFixtureDir() {
    return mkdtempSync(join(tmpdir(), 'pc2-loader-fixture-'));
}

function cleanup(dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function fixtureManifest(name = 'test-capsule') {
    return {
        name,
        version: '0.1.0',
        kind: 'hybrid',
        engines: { node: '>=20', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/',
            needsRestart: false,
            schemaVersion: 1,
            dataDir: `data/installed-apps/${name}/state/`,
        },
        distribution: {
            cid: 'bafy' + 'a'.repeat(50),
            manifestDigest: 'a'.repeat(64),
            signature: 'b'.repeat(128),
            signedBy: 'c'.repeat(64),
        },
    };
}

function alwaysProbeOk() {
    return Promise.resolve({ ok: true, durationMs: 1, exitCode: 0 });
}
function alwaysProbeFail(reason = 'stub failure') {
    return Promise.resolve({ ok: false, durationMs: 1, reason, exitCode: 5 });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('register: throws on duplicate name', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    assert.throws(() => loader.register('foo', dir, fixtureManifest('foo')),
        { name: 'LoaderError', message: /already registered/ });
});

test('register: throws if extensionDir does not exist', async (t) => {
    if (skipIfMissing(t)) return;
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    assert.throws(
        () => loader.register('foo', '/tmp/nope-' + Date.now(), fixtureManifest('foo')),
        { name: 'LoaderError', message: /does not exist/ });
});

test('register: state starts as "registered"', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    assert.equal(loader.getState('foo'), 'registered');
    assert.equal(loader.isRegistered('foo'), true);
    assert.equal(loader.isLoaded('foo'), false);
    assert.equal(loader.isQuarantined('foo'), false);
});

test('deregister: removes the capsule', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    assert.equal(loader.deregister('foo'), true);
    assert.equal(loader.deregister('foo'), false);
    assert.equal(loader.isRegistered('foo'), false);
});

// ---------------------------------------------------------------------------
// ensureLoaded — happy path
// ---------------------------------------------------------------------------

test('ensureLoaded: probe ok + hook returns → state="loaded", returns module', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const fakeModule = { hello: 'world' };
    const loader = new LazyExtensionLoader({
        loadHook: async () => fakeModule,
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    const result = await loader.ensureLoaded('foo');
    assert.equal(result.ok, true);
    assert.equal(result.state, 'loaded');
    assert.deepEqual(result.module, fakeModule);
    assert.equal(loader.isLoaded('foo'), true);
});

test('ensureLoaded: subsequent calls return cached module without re-loading', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    let probeCalls = 0;
    let hookCalls = 0;
    const loader = new LazyExtensionLoader({
        loadHook: async () => { hookCalls++; return { v: hookCalls }; },
        probeFn: async () => { probeCalls++; return { ok: true, durationMs: 1 }; },
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    const r1 = await loader.ensureLoaded('foo');
    const r2 = await loader.ensureLoaded('foo');
    const r3 = await loader.ensureLoaded('foo');
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);
    assert.equal(probeCalls, 1, 'probe should only run on first load');
    assert.equal(hookCalls, 1, 'hook should only run on first load');
});

test('ensureLoaded: concurrent calls coalesce to one load', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    let hookCalls = 0;
    let resolveHook;
    const hookPromise = new Promise(r => { resolveHook = r; });
    const loader = new LazyExtensionLoader({
        loadHook: async () => { hookCalls++; await hookPromise; return { v: 1 }; },
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    const p1 = loader.ensureLoaded('foo');
    const p2 = loader.ensureLoaded('foo');
    const p3 = loader.ensureLoaded('foo');
    resolveHook();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(hookCalls, 1, 'three concurrent calls should trigger one hook invocation');
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);
});

// ---------------------------------------------------------------------------
// ensureLoaded — failure paths
// ---------------------------------------------------------------------------

test('ensureLoaded: throws on unregistered name', async (t) => {
    if (skipIfMissing(t)) return;
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    await assert.rejects(() => loader.ensureLoaded('not-here'),
        { name: 'LoaderError', message: /not registered/ });
});

test('ensureLoaded: probe failure → state="failed", reason includes probe detail', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: () => alwaysProbeFail('require threw'),
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    const result = await loader.ensureLoaded('foo');
    assert.equal(result.ok, false);
    assert.equal(result.state, 'failed');
    assert.match(result.reason, /probe failed.*require threw/);
});

test('ensureLoaded: load hook throws → state="failed"', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => { throw new Error('init crashed'); },
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    const result = await loader.ensureLoaded('foo');
    assert.equal(result.ok, false);
    assert.equal(result.state, 'failed');
    assert.match(result.reason, /load hook threw.*init crashed/);
});

// ---------------------------------------------------------------------------
// Crash counter + quarantine
// ---------------------------------------------------------------------------

test('quarantine: triggers after threshold load failures within window', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => { throw new Error('keeps crashing'); },
        probeFn: alwaysProbeOk,
        crashThreshold: 3,
        crashWindowMs: 60_000,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    await loader.ensureLoaded('foo');
    assert.equal(loader.getState('foo'), 'failed');
    await loader.ensureLoaded('foo');
    assert.equal(loader.getState('foo'), 'failed');
    const r3 = await loader.ensureLoaded('foo');
    assert.equal(r3.state, 'quarantined');
    assert.equal(loader.isQuarantined('foo'), true);
});

test('quarantine: subsequent ensureLoaded returns quarantined without probing', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    let probeCalls = 0;
    const loader = new LazyExtensionLoader({
        loadHook: async () => { throw new Error('crash'); },
        probeFn: () => { probeCalls++; return alwaysProbeOk(); },
        crashThreshold: 2,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    await loader.ensureLoaded('foo');
    await loader.ensureLoaded('foo');
    assert.equal(loader.isQuarantined('foo'), true);

    const before = probeCalls;
    const r = await loader.ensureLoaded('foo');
    assert.equal(r.state, 'quarantined');
    assert.equal(probeCalls, before, 'probe must not run for quarantined capsule');
});

test('clearQuarantine: returns capsule to "registered", resets crash window', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    let throwCount = 2;
    const loader = new LazyExtensionLoader({
        loadHook: async () => {
            if (throwCount > 0) { throwCount--; throw new Error('crash'); }
            return { ok: true };
        },
        probeFn: alwaysProbeOk,
        crashThreshold: 2,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    await loader.ensureLoaded('foo');
    await loader.ensureLoaded('foo');
    assert.equal(loader.isQuarantined('foo'), true);

    assert.equal(loader.clearQuarantine('foo'), true);
    assert.equal(loader.getState('foo'), 'registered');

    // Now it should load OK (throwCount decremented to 0)
    const r = await loader.ensureLoaded('foo');
    assert.equal(r.ok, true);
    assert.equal(r.state, 'loaded');
});

test('clearQuarantine: returns false for non-quarantined capsule', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    assert.equal(loader.clearQuarantine('foo'), false);
    assert.equal(loader.clearQuarantine('not-here'), false);
});

test('recordCrash: bumps counter, quarantines at threshold', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({ ok: true }),
        probeFn: alwaysProbeOk,
        crashThreshold: 3,
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    await loader.ensureLoaded('foo');

    loader.recordCrash('foo', 'route handler threw');
    assert.equal(loader.getState('foo'), 'failed');
    loader.recordCrash('foo', 'route handler threw again');
    assert.equal(loader.getState('foo'), 'failed');
    loader.recordCrash('foo', 'route handler threw a third time');
    assert.equal(loader.getState('foo'), 'quarantined');
});

test('recordCrash: idempotent on unknown / already-quarantined name', async (t) => {
    if (skipIfMissing(t)) return;
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
    });
    // Should not throw
    loader.recordCrash('not-here', 'unknown');
});

test('crash counter: stale crashes outside window do not count', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({ ok: true }),
        probeFn: alwaysProbeOk,
        crashThreshold: 3,
        crashWindowMs: 50,   // very short window for the test
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    await loader.ensureLoaded('foo');

    loader.recordCrash('foo', 'crash 1');
    loader.recordCrash('foo', 'crash 2');
    // Wait beyond the window — first two crashes should expire
    await new Promise(r => setTimeout(r, 80));
    loader.recordCrash('foo', 'crash 3');
    // Only 1 crash within the rolling window now → still failed, NOT quarantined
    assert.notEqual(loader.getState('foo'), 'quarantined',
        `expected non-quarantined, got ${loader.getState('foo')}`);
});

// ---------------------------------------------------------------------------
// Safe-mode
// ---------------------------------------------------------------------------

test('safe-mode: ensureLoaded short-circuits without probing or loading', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    let probeCalls = 0; let hookCalls = 0;
    const loader = new LazyExtensionLoader({
        loadHook: async () => { hookCalls++; return {}; },
        probeFn: () => { probeCalls++; return alwaysProbeOk(); },
        isSafeMode: () => true,
    });
    loader.register('foo', dir, fixtureManifest('foo'));

    const r = await loader.ensureLoaded('foo');
    assert.equal(r.ok, false);
    assert.equal(r.state, 'safe-mode');
    assert.equal(probeCalls, 0);
    assert.equal(hookCalls, 0);
});

test('safe-mode: getState returns "safe-mode" for registered capsules', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeFixtureDir(); t.after(() => cleanup(dir));
    let safe = false;
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({}),
        probeFn: alwaysProbeOk,
        isSafeMode: () => safe,
    });
    loader.register('foo', dir, fixtureManifest('foo'));
    assert.equal(loader.getState('foo'), 'registered');
    safe = true;
    assert.equal(loader.getState('foo'), 'safe-mode');
});

// ---------------------------------------------------------------------------
// listAll
// ---------------------------------------------------------------------------

test('listAll: snapshot includes every registered capsule with current state', async (t) => {
    if (skipIfMissing(t)) return;
    const dir1 = makeFixtureDir(); t.after(() => cleanup(dir1));
    const dir2 = makeFixtureDir(); t.after(() => cleanup(dir2));
    const loader = new LazyExtensionLoader({
        loadHook: async () => ({ ok: true }),
        probeFn: alwaysProbeOk,
    });
    loader.register('a', dir1, fixtureManifest('a'));
    loader.register('b', dir2, fixtureManifest('b'));
    await loader.ensureLoaded('a');

    const snapshot = loader.listAll();
    assert.equal(snapshot.length, 2);
    const a = snapshot.find(s => s.name === 'a');
    const b = snapshot.find(s => s.name === 'b');
    assert.equal(a.state, 'loaded');
    assert.equal(b.state, 'registered');
});

// ---------------------------------------------------------------------------
// Constructor input validation
// ---------------------------------------------------------------------------

test('ctor: throws without loadHook', async (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new LazyExtensionLoader({}), { name: 'TypeError' });
    assert.throws(() => new LazyExtensionLoader({ loadHook: 'not a fn' }), { name: 'TypeError' });
});
