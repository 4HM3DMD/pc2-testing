/**
 * Phase 3 follow-up smoke test — verifies CapsuleExtensionHost actually
 * does what main.js's loadHook needs:
 *   - injects a per-capsule `extension` shim into globalThis before
 *     `require()` runs the capsule's main.js
 *   - the capsule's free `extension` references resolve to the shim
 *   - shim routes forward to the parent extension
 *   - shim 'init' lifecycle fires after module load
 *   - on capsule-load throw, globalThis.extension is restored
 *
 * Run: npx tsx --test tests/smoke/capsule-host.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import { loadCapsule, createCapsuleExtension }
    from '../../dist/services/CapsuleExtensionHost.js';

const cjsRequire = createRequire(import.meta.url);

// ---- helpers --------------------------------------------------------------

function buildFixture (mainJsSource) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elacity-host-fixture-'));
    fs.writeFileSync(path.join(dir, 'main.js'), mainJsSource);
    return dir;
}

function makeParentStub () {
    const routes = new Map();
    const logs   = [];
    return {
        log: {
            info:  (...a) => logs.push(['info',  a.join(' ')]),
            warn:  (...a) => logs.push(['warn',  a.join(' ')]),
            error: (...a) => { logs.push(['error', a.join(' ')]); console.error('[parent.error]', ...a); },
            debug: (...a) => logs.push(['debug', a.join(' ')]),
        },
        get   (p) { routes.set(`GET ${p}`,    true); },
        post  (p) { routes.set(`POST ${p}`,   true); },
        put   (p) { routes.set(`PUT ${p}`,    true); },
        delete(p) { routes.set(`DELETE ${p}`, true); },
        _routes: routes,
        _logs:   logs,
    };
}

// ---- createCapsuleExtension (pure) ---------------------------------------

test('createCapsuleExtension: shim has the expected surface', () => {
    const parent = makeParentStub();
    const shim   = createCapsuleExtension({ name: 't', extensionDir: '/tmp' }, parent);
    assert.equal(shim.name, 't');
    assert.deepEqual(shim.exports, {});
    for (const m of ['on', 'emit', 'import', 'get', 'post', 'put', 'delete']) {
        assert.equal(typeof shim[m], 'function', `shim.${m} should be a function`);
    }
});

test('createCapsuleExtension: shim.import("data") yields { db, kv, cache } all null', () => {
    const parent = makeParentStub();
    const shim   = createCapsuleExtension({ name: 't', extensionDir: '/tmp' }, parent);
    assert.deepEqual(shim.import('data'), { db: null, kv: null, cache: null });
});

test('createCapsuleExtension: shim.on/.emit dispatches local handlers', async () => {
    const parent = makeParentStub();
    const shim   = createCapsuleExtension({ name: 't', extensionDir: '/tmp' }, parent);
    let fired = 0;
    shim.on('boom', () => { fired++; });
    shim.on('boom', () => { fired++; });
    await shim.emit('boom');
    assert.equal(fired, 2);
});

test('createCapsuleExtension: shim.post forwards path to parent', () => {
    const parent = makeParentStub();
    const shim   = createCapsuleExtension({ name: 't', extensionDir: '/tmp' }, parent);
    shim.post('/api/x/ping', { subdomain: 'api' }, () => {});
    assert.ok(parent._routes.has('POST /api/x/ping'),
        'capsule POST should forward to parent extension');
});

// ---- loadCapsule (load + inject + init) ----------------------------------

test('loadCapsule: capsule main.js sees `extension` as shim, init fires, routes forward', async () => {
    const parent = makeParentStub();
    const dir = buildFixture(`
        extension.log.info('capsule top-level loaded');
        extension.exports.greeting = 'hello-from-capsule';
        extension.on('init', () => {
            extension.exports.initRan = true;
            extension.log.info('capsule init fired');
        });
        extension.get('/api/cap/ping', { subdomain: 'api' }, (req, res) => res.json({ pong: true }));
    `);

    const exports = await loadCapsule(
        { name: 'cap-good', extensionDir: dir },
        parent,
        cjsRequire,
    );

    assert.equal(exports.greeting, 'hello-from-capsule', 'top-level set');
    assert.equal(exports.initRan,  true,                 'init handler fired after load');
    assert.ok(parent._routes.has('GET /api/cap/ping'),   'capsule GET forwarded to parent');
    assert.ok(parent._logs.some(([lvl, line]) => lvl === 'info' && line.includes('capsule top-level loaded')),
        'capsule log went through parent.log');
    assert.ok(parent._logs.some(([lvl, line]) => lvl === 'info' && line.includes('capsule init fired')),
        'init-time log went through parent.log');
});

test('loadCapsule: globalThis.extension is set to the capsule shim after success', async () => {
    const parent = makeParentStub();
    const dir = buildFixture(`extension.exports.marker = 1;`);
    await loadCapsule({ name: 'cap-marker', extensionDir: dir }, parent, cjsRequire);
    // After success the runtime intentionally leaves globalThis.extension
    // as the shim so capsule handlers registered for late events keep
    // resolving (see CapsuleExtensionHost docblock).
    assert.equal(globalThis.extension.name, 'cap-marker');
});

test('loadCapsule: globalThis.extension is restored on capsule throw', async () => {
    const parent = makeParentStub();
    const sentinel = { name: 'sentinel-parent' };
    globalThis.extension = sentinel;

    const dir = buildFixture(`throw new Error('capsule blew up at module-load');`);
    await assert.rejects(
        () => loadCapsule({ name: 'cap-broken', extensionDir: dir }, parent, cjsRequire),
        /capsule blew up at module-load/,
    );
    assert.equal(globalThis.extension, sentinel,
        'globalThis.extension should roll back to the previous value when capsule throws');
});

test('loadCapsule: cache-bust lets a re-install pick up new capsule bytes', async () => {
    const parent = makeParentStub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elacity-host-rebuild-'));
    fs.writeFileSync(path.join(dir, 'main.js'),
        `extension.exports.version = 'v1';`);
    let exports = await loadCapsule({ name: 'cap-rebuild', extensionDir: dir }, parent, cjsRequire);
    assert.equal(exports.version, 'v1');

    // Re-write main.js, re-load — without cache-bust we'd see 'v1' again.
    fs.writeFileSync(path.join(dir, 'main.js'),
        `extension.exports.version = 'v2';`);
    exports = await loadCapsule({ name: 'cap-rebuild', extensionDir: dir }, parent, cjsRequire);
    assert.equal(exports.version, 'v2',
        'cache-bust should let a new install replace the old module');
});
