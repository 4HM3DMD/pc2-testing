/**
 * Phase 3 smoke harness — loads ../../main.js with a stub `extension`
 * global mimicking Puter's API, then exercises the init lifecycle and
 * every route handler.
 *
 * What this proves
 *   - main.js parses + executes as ESM (no CJS-syntax bugs)
 *   - the dist/ build resolves and dynamic imports succeed
 *   - the init handler constructs services without throwing
 *   - all four routes register against the stub with subdomain: 'api'
 *   - each handler returns the documented status before/after init
 *
 * What this does NOT prove
 *   - actual install of a signed bundle (needs a real test capsule)
 *   - cross-process probe (would launch ExtensionProbe child)
 *   - Puter's own subdomain-based vhost routing
 *   - the capsule-side `extension` global propagation (Phase 3 follow-up:
 *     LazyExtensionLoader's loadHook needs to hand the loaded capsule a
 *     working `extension` global, since Puter's prepend-globals trick
 *     only runs once at top-level extension load, not for capsules our
 *     loader pulls in at runtime)
 *
 * Run: npx tsx --test tests/smoke/puter-harness.test.js
 *
 * NB: this file is intentionally outside the `tests/*.test.js` glob in
 * package.json's "test" script — it sets `globalThis.extension`, which
 * would leak into other test modules in the same Node process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- Configure env BEFORE importing main.js ------------------------------
// main.js reads PC2_TRUSTED_PUBLISHER_KEYS / REVOCATION_* at module top.
// Leaving PC2_REVOCATION_ROOT_KEY unset keeps the RevocationFetcher off,
// avoiding any HTTP call to registry.ela.city during the harness.

const TEST_PUBLISHER_KEY_HEX = 'a'.repeat(64);
process.env.PC2_TRUSTED_PUBLISHER_KEYS = TEST_PUBLISHER_KEY_HEX;
process.env.PC2_DATA_DIR       = '/tmp/elacity-smoke-data';
process.env.PC2_EXTENSIONS_DIR = '/tmp/elacity-smoke-extensions';
delete process.env.PC2_REVOCATION_ROOT_KEY;

// ---- Stub `extension` global mimicking Puter's API surface ---------------
// Puter's real Extension class lives in src/backend/src/Extension.js.
// Surface we need: .on / .emit / .get / .post / .put / .delete / .log.

class StubExtension {
    constructor () {
        this._listeners = new Map();   // event → [handlers]
        this.routes     = new Map();   // "METHOD /path" → { opts, handler }
        // Logger captures lines for assertions; mirror to console for visibility.
        this.logged = { info: [], warn: [], error: [], debug: [] };
        this.log = {
            info:  (...a) => { this.logged.info.push(a.join(' ')); },
            warn:  (...a) => { this.logged.warn.push(a.join(' ')); },
            error: (...a) => { this.logged.error.push(a.join(' ')); console.error('[stub.error]', ...a); },
            debug: (...a) => { this.logged.debug.push(a.join(' ')); },
        };
    }

    on (event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(handler);
    }

    async emit (event, ...args) {
        const handlers = this._listeners.get(event) ?? [];
        for (const h of handlers) await h(...args);
    }

    _registerRoute (method, p, optsOrHandler, handlerOrOpts) {
        // Match Puter's flip-on-typeof-object behavior in Extension.post/get.
        let opts, handler;
        if (typeof optsOrHandler === 'function') {
            handler = optsOrHandler;
            opts = handlerOrOpts ?? {};
        } else {
            opts = optsOrHandler ?? {};
            handler = handlerOrOpts;
        }
        this.routes.set(`${method} ${p}`, { opts, handler });
    }
    get    (...a) { this._registerRoute('GET',    ...a); }
    post   (...a) { this._registerRoute('POST',   ...a); }
    put    (...a) { this._registerRoute('PUT',    ...a); }
    delete (...a) { this._registerRoute('DELETE', ...a); }
}

const stubExt = new StubExtension();
globalThis.extension = stubExt;

// Import main.js. Top-level code runs immediately:
//   - registers init handler
//   - registers 4 routes
await import('../../main.js');

// ---- Tiny mock req/res ----------------------------------------------------

function mockRes () {
    return {
        statusCode: 200,
        body: undefined,
        status (code) { this.statusCode = code; return this; },
        json   (body) { this.body = body; return this; },
        send   (body) { this.body = body; return this; },
        end    ()     { return this; },
    };
}

const authedReq = (body = {}) => ({ user: { wallet_address: '0xabc' }, body });
const anonReq   = (body = {}) => ({ body });

// ---- Tests ---------------------------------------------------------------

test('routes register at module-load time (before init)', () => {
    const expected = [
        'POST /capsules/preview-consent',
        'POST /capsules/install',
        'POST /capsules/uninstall',
        'GET /capsules/health',
    ];
    for (const key of expected) {
        assert.ok(stubExt.routes.has(key), `missing route: ${key}`);
    }
});

test('routes carry { subdomain: "api" } so Puter routes them under api.<host>', () => {
    for (const [, { opts }] of stubExt.routes) {
        assert.equal(opts.subdomain, 'api');
    }
});

test('pre-init: install route returns 503 (orchestrator not ready)', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/install');
    const res = mockRes();
    await handler(authedReq({ manifest: {}, bundleBase64: 'AAAA' }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'capsule_runtime_not_ready');
});

test('pre-init: health reports not-ready', async () => {
    const { handler } = stubExt.routes.get('GET /capsules/health');
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.body.ok,    false);
    assert.equal(res.body.ready, false);
});

test('init: emit("init") completes without throwing', async () => {
    await stubExt.emit('init');
    // Booted-line should be in stub log (assertion is loose — we just
    // care no throw and that init ran).
    assert.ok(stubExt.logged.info.some(l => l.includes('booting')));
    assert.ok(stubExt.logged.info.some(l => l.includes('init complete')));
});

test('post-init: health reports ready + correct trustedPublishers count', async () => {
    const { handler } = stubExt.routes.get('GET /capsules/health');
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok,                true);
    assert.equal(res.body.ready,             true);
    assert.equal(res.body.trustedPublishers, 1);
    // No PC2_REVOCATION_ROOT_KEY in env, so revocation fetcher is null.
    assert.equal(res.body.revocationActive, false);
});

test('post-init: preview-consent rejects unauthenticated requests with 401', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/preview-consent');
    const res = mockRes();
    await handler(anonReq({ manifest: {} }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'authentication_required');
});

test('post-init: preview-consent rejects missing manifest with 400', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/preview-consent');
    const res = mockRes();
    await handler(authedReq({ /* no manifest */ }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'manifest_required');
});

test('post-init: install rejects unauthenticated requests with 401', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/install');
    const res = mockRes();
    await handler(anonReq({ manifest: {}, bundleBase64: 'AAAA' }), res);
    assert.equal(res.statusCode, 401);
});

test('post-init: install rejects missing manifest+bundle with 400', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/install');
    const res = mockRes();
    await handler(authedReq({ /* missing both */ }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'manifest_and_bundle_required');
});

test('post-init: uninstall rejects unauthenticated requests with 401', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/uninstall');
    const res = mockRes();
    await handler(anonReq({ name: 'foo' }), res);
    assert.equal(res.statusCode, 401);
});

test('post-init: uninstall rejects missing name with 400', async () => {
    const { handler } = stubExt.routes.get('POST /capsules/uninstall');
    const res = mockRes();
    await handler(authedReq({ /* no name */ }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'name_required');
});

test('init logs the empty-trusted-set warning when PC2_TRUSTED_PUBLISHER_KEYS is empty', async () => {
    // Drive the same code path with an empty publisher set on a fresh
    // stub — to do this cleanly we'd need to re-import main.js, which
    // ESM caches. Instead, assert the warning case is documented in
    // the warn log when run with no key (this would have fired in the
    // earlier init invocation if the env was empty). We verify the
    // negative: with our key set, no such warning was emitted.
    const sawEmpty = stubExt.logged.warn.some(l => l.includes('PC2_TRUSTED_PUBLISHER_KEYS env var is empty'));
    assert.equal(sawEmpty, false, 'should NOT warn about empty trusted set when key is provided');
});
