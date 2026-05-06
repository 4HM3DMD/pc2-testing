/**
 * Smoke regression — init must NOT throw an unhandled rejection when
 * PC2_DATA_DIR is unwritable. Originally found running against real
 * PC2 (CapsuleInstaller's mkdirSync threw ENOENT on the default
 * "/data", which doesn't exist on bare-metal hosts). The fix wraps
 * service construction in a try/catch and 503s every install route.
 *
 * Lives in its own file so each test runs in a fresh node:test worker
 * — main.js is ESM and caches once per process; we need a clean
 * import to set the failing env vars BEFORE the module body executes.
 *
 * Run: npx tsx --test tests/smoke/init-failure.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Force CapsuleInstaller's mkdirSync to fail. /dev/null is a character
// device on every Unix; mkdir under it returns ENOTDIR consistently.
process.env.PC2_DATA_DIR = '/dev/null/elacity-init-failure';
process.env.PC2_TRUSTED_PUBLISHER_KEYS = 'a'.repeat(64);
delete process.env.PC2_REVOCATION_ROOT_KEY;

class StubExtension {
    constructor () {
        this._listeners = new Map();
        this.routes     = new Map();
        this.errored    = [];
        this.log = {
            info:  () => {},
            warn:  () => {},
            error: (msg) => { this.errored.push(String(msg)); },
            debug: () => {},
        };
    }
    on (event, h) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(h);
    }
    async emit (event, ...args) {
        for (const h of this._listeners.get(event) ?? []) await h(...args);
    }
    _route (method, p, optsOrHandler, handlerOrOpts) {
        let opts, handler;
        if (typeof optsOrHandler === 'function') { handler = optsOrHandler; opts = handlerOrOpts ?? {}; }
        else { opts = optsOrHandler ?? {}; handler = handlerOrOpts; }
        this.routes.set(`${method} ${p}`, { opts, handler });
    }
    get   (...a) { this._route('GET',    ...a); }
    post  (...a) { this._route('POST',   ...a); }
    put   (...a) { this._route('PUT',    ...a); }
    delete(...a) { this._route('DELETE', ...a); }
}

const stub = new StubExtension();
globalThis.extension = stub;

await import('../../main.js');

function mockRes () {
    return {
        statusCode: 200,
        body: undefined,
        status (c) { this.statusCode = c; return this; },
        json   (b) { this.body = b; return this; },
    };
}

test('init does not throw — emit("init") resolves cleanly even with unwritable PC2_DATA_DIR', async () => {
    await stub.emit('init');
});

test('init logged a clear error mentioning PC2_DATA_DIR', () => {
    const matched = stub.errored.find(line =>
        line.includes('init failed') && line.includes('PC2_DATA_DIR'));
    assert.ok(matched,
        `expected an error log mentioning init failure + PC2_DATA_DIR; got: ${JSON.stringify(stub.errored)}`);
});

test('post-init: health reports not-ready (orchestrator stayed null)', async () => {
    const { handler } = stub.routes.get('GET /capsules/health');
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.body.ok,    false);
    assert.equal(res.body.ready, false);
});

test('post-init: install route returns 503 (capsule_runtime_not_ready)', async () => {
    const { handler } = stub.routes.get('POST /capsules/install');
    const res = mockRes();
    await handler(
        { user: { wallet_address: '0xabc' }, body: { manifest: {}, bundleBase64: 'AAAA' } },
        res,
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'capsule_runtime_not_ready');
});
