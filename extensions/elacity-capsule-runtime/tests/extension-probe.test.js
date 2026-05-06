/**
 * SPEC: ExtensionProbe — child-process pre-load validation.
 *
 * Helper location:
 *   pc2-node/src/services/ExtensionProbe.ts (calls probe-runner.cjs)
 *
 * Purpose:
 *   Spawn a child Node process that requires an extension's main file
 *   with a stub `extension` global. Reports back whether the require
 *   succeeded — sync throws, async failures during a 100ms drain window,
 *   and timeouts all surface as `{ ok: false, reason, exitCode? }`.
 *   Wrapper script never throws; even bad input becomes a structured
 *   ProbeResult.
 *
 *   Tests build fixture extensions on disk (a clean one, a syncthrow,
 *   an async-throw, an infinite loop, missing main, malformed pkg.json)
 *   and assert the probe surfaces each correctly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HELPER_PATH = '../src/services/ExtensionProbe.js';
let probeExtension;

try {
    ({ probeExtension } = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] ExtensionProbe not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!probeExtension) {
        t.skip('ExtensionProbe not yet implemented (Wave 7 / M3)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Fixture builder: write a temp extension dir with given main.js content
// ---------------------------------------------------------------------------

function makeExtensionDir(layout) {
    const dir = mkdtempSync(join(tmpdir(), 'pc2-probe-fixture-'));
    for (const [relPath, content] of Object.entries(layout)) {
        const full = join(dir, relPath);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
    }
    return dir;
}

function cleanup(dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('probe: clean main.js → ok=true', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `extension.on('init', () => {});\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, true, `expected ok, got: ${result.reason}`);
    assert.equal(result.exitCode, 0);
    assert.ok(result.durationMs >= 0);
});

test('probe: respects package.json `main` field', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'package.json': JSON.stringify({ name: 'fixture', main: 'entry.js' }),
        'entry.js': `extension.on('init', () => {});\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, true, `expected ok, got: ${result.reason}`);
});

test('probe: extension can call extension.import + extension.get without throwing', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `
            const data = extension.import('data');
            extension.get('/health', { subdomain: 'api' }, (req, res) => res.json({ ok: true }));
            extension.on('init', () => extension.log('ready'));
        `,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, true, `expected ok, got: ${result.reason}\n${result.stderr ?? ''}`);
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test('probe: sync throw at module-load → ok=false, exit 5', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `throw new Error('boom-at-load');\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 5);
    assert.match(result.stderr ?? '', /boom-at-load/);
});

test('probe: throw inside setImmediate → caught by uncaughtException handler', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `setImmediate(() => { throw new Error('async-boom'); });\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, false);
    // Exit code should indicate async catch (6 = uncaughtException, 8 = drain)
    assert.ok(result.exitCode === 6 || result.exitCode === 8,
        `expected exit 6 or 8 for async throw, got ${result.exitCode}`);
    assert.match(result.stderr ?? '', /async-boom/);
});

test('probe: unhandled promise rejection → caught by handler', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `Promise.reject(new Error('promise-boom'));\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, false);
    assert.ok(result.exitCode === 7 || result.exitCode === 8,
        `expected exit 7 or 8 for promise rejection, got ${result.exitCode}`);
    assert.match(result.stderr ?? '', /promise-boom/);
});

test('probe: missing main.js → exit 4', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({});  // no files at all
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 4);
    assert.match(result.reason ?? '', /main file not found/);
});

test('probe: missing main file referenced by package.json → exit 4', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'package.json': JSON.stringify({ name: 'fixture', main: 'does-not-exist.js' }),
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 4);
});

test('probe: malformed package.json → exit 3', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'package.json': 'not { valid: json',
        'main.js': `extension.on('init', () => {});`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.match(result.reason ?? '', /malformed package.json/);
});

test('probe: target dir does not exist → exit 4', async (t) => {
    if (skipIfMissing(t)) return;
    const result = await probeExtension('/tmp/this-path-definitely-does-not-exist-' + Date.now());
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 4);
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

test('probe: hangs forever → killed by timeout, ok=false', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        // Block the event loop with a busy loop so the probe can't exit
        'main.js': `while (true) { /* spin */ }\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir, { timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.signal, 'SIGKILL');
    assert.match(result.reason ?? '', /timed out/);
    // Duration should be close to timeoutMs, with a generous upper bound
    // for kill latency.
    assert.ok(result.durationMs >= 500, `expected ≥500ms, got ${result.durationMs}`);
    assert.ok(result.durationMs < 5000, `expected <5000ms, got ${result.durationMs}`);
});

test('probe: pending async work without throw → eventually exits cleanly', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `setTimeout(() => extension.log('late'), 50);\n`,
    });
    t.after(() => cleanup(dir));

    const result = await probeExtension(dir, { timeoutMs: 2000 });
    assert.equal(result.ok, true, `expected ok, got: ${result.reason}`);
});

// ---------------------------------------------------------------------------
// Resource isolation
// ---------------------------------------------------------------------------

test('probe: child process env is sanitised (no PC2 secrets leak)', async (t) => {
    if (skipIfMissing(t)) return;
    // ALLOWED is what the probe explicitly forwards via fork({ env }).
    // Core Foundation on macOS auto-injects __CF_USER_TEXT_ENCODING into
    // every spawned child regardless of the parent's `env` option — that
    // pre-dates Node and isn't a leak from PC2's address space; allowlist
    // it so this test isn't flaky cross-platform.
    const dir = makeExtensionDir({
        'main.js': `
            const ALLOWED = new Set([
                'PATH', 'HOME', 'LANG', 'NODE_OPTIONS',
                '__CF_USER_TEXT_ENCODING',  // macOS Core Foundation auto-inject
            ]);
            const leaked = Object.keys(process.env).filter(k => !ALLOWED.has(k));
            if (leaked.length > 0) {
                console.error('UNEXPECTED ENV: ' + leaked.join(','));
                process.exit(99);
            }
        `,
    });
    t.after(() => cleanup(dir));

    process.env.PC2_FAKE_SECRET = 'should-not-leak';
    try {
        const result = await probeExtension(dir);
        assert.equal(result.ok, true,
            `expected ok (env sanitised), got exitCode=${result.exitCode} stderr="${result.stderr}"`);
    } finally {
        delete process.env.PC2_FAKE_SECRET;
    }
});

test('probe: many concurrent invocations all complete', async (t) => {
    if (skipIfMissing(t)) return;
    const dir = makeExtensionDir({
        'main.js': `extension.on('init', () => {});\n`,
    });
    t.after(() => cleanup(dir));

    const results = await Promise.all(
        Array.from({ length: 5 }, () => probeExtension(dir, { timeoutMs: 5000 })),
    );
    for (const r of results) {
        assert.equal(r.ok, true, `concurrent probe failed: ${r.reason}`);
    }
});
