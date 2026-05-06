/**
 * SPEC: ENM capsule end-to-end (Wave 7 / M8 scaffolding).
 *
 * Reads the on-disk capsule source at extensions/elastos-node-manager/,
 * bundles it into a tar.gz, signs with a fresh test publisher key,
 * runs through the full M1-M7 pipeline:
 *
 *   1. CapsuleManifest schema validation (M1)
 *   2. Manifest signature verify (M1)
 *   3. CapsuleInstaller atomic two-target extract (M2)
 *   4. LazyExtensionLoader register (M3) — load triggered on first
 *      ensureLoaded call
 *   5. ENM backend's exports become reachable
 *   6. Routes registered, /health + /version respond, owner-only
 *      route enforced
 *   7. Shutdown hook fires, exports flip to not-ready
 *   8. CapsuleInstaller uninstall removes both halves
 *
 * What this test PROVES: the full Wave 7 pipeline works against a
 * REAL capsule sourced from on-disk files, not just synthetic
 * fixtures. It's the integration moment — earlier hello-capsule
 * e2e built fixtures in-test; this one consumes the actual capsule
 * the dev signing utility (make-test-capsule.mjs) would produce.
 *
 * What this test DOES NOT prove (sub-phases of M8 deferred):
 * - The 37 enm-server services don't actually run yet (stubbed)
 * - The 10 enm-server routes haven't been ported yet
 * - The better-sqlite3 ABI decision hasn't been made
 * - The real ENM v0.5 frontend bundle isn't packaged in `app/` yet
 *
 * The scaffolding's `/health`, `/version`, `/chains/:id` routes
 * exercise the same lazy-loader + extension-API plumbing that the
 * full port will use, so this is a high-signal integration check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { tmpdir } from 'os';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import nacl from 'tweetnacl';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let validateCapsuleManifest, signManifest, verifyManifestSignature;
let CapsuleInstaller, LazyExtensionLoader;

try {
    ({ validateCapsuleManifest } = await import('../../src/services/CapsuleManifest.js'));
    ({ signManifest, verifyManifestSignature } = await import('../../src/services/CapsuleSignature.js'));
    ({ CapsuleInstaller } = await import('../../src/services/CapsuleInstaller.js'));
    ({ LazyExtensionLoader } = await import('../../src/services/LazyExtensionLoader.js'));
} catch (err) {
    console.warn(`[spec] enm-capsule-e2e prerequisites missing: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!CapsuleInstaller || !LazyExtensionLoader) {
        t.skip('M1-M3 prerequisites not yet implemented');
        return true;
    }
    return false;
}

const ENM_SOURCE_DIR = resolve(import.meta.dirname, '../../../extensions/elastos-node-manager');

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeTestRoot() {
    const root = mkdtempSync(join(tmpdir(), 'pc2-enm-e2e-'));
    const dataDir = join(root, 'data');
    const extensionsDir = join(root, 'extensions');
    const stagingDir = join(root, 'staging');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(extensionsDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    return { root, dataDir, extensionsDir, stagingDir };
}

function cleanup(root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function pubHex(kp) {
    return Buffer.from(kp.publicKey).toString('hex');
}

/**
 * Bundle the actual on-disk extensions/elastos-node-manager/ source
 * into a tar.gz buffer ready for CapsuleInstaller.
 *
 * Walks the source dir recursively to pick up nested files (frontend
 * may have js/css subtrees later, backend may have services/ subtree
 * once the full port lands).
 */
async function bundleEnmSource() {
    const chunks = [];
    await pipeline(
        tar.c({ gzip: true, cwd: ENM_SOURCE_DIR }, ['app', 'backend', 'app.json']),
        new Writable({ write(c, _, cb) { chunks.push(c); cb(); } }),
    );
    return Buffer.concat(chunks);
}

/**
 * Sign the on-disk app.json with a fresh keypair. Replaces the
 * "PLACEHOLDER" distribution fields with real values. The signature
 * commits to the FULLY-FILLED manifest so verify-time recomputes
 * the same digest.
 */
function signedManifestFromDisk(kp) {
    const raw = JSON.parse(readFileSync(join(ENM_SOURCE_DIR, 'app.json'), 'utf8'));
    // app.json on disk has "PLACEHOLDER" — clear before signing
    raw.distribution = { cid: '', manifestDigest: '', signature: '', signedBy: '' };
    // CID is faked here — production publisher pins to IPFS first then
    // writes the real CID into the manifest before signing
    raw.distribution.cid = 'bafy' + 'a'.repeat(50);
    const sig = signManifest(raw, kp.secretKey);
    raw.distribution.manifestDigest = sig.manifestDigest;
    raw.distribution.signature = sig.signature;
    raw.distribution.signedBy = sig.signedBy;
    return raw;
}

/**
 * Construct a stub Extension global the loader hands the backend
 * during require(). Mirrors what the production loader (M5+ wire-up)
 * will do once it integrates with PC2's real Extension class.
 */
function makeStubExtension() {
    const routes = [];
    const lifecycle = {};
    const stubLog = function () { /* silent */ };
    ['info', 'warn', 'debug', 'error', 'tick', 'noticeme', 'system'].forEach(lvl => {
        stubLog[lvl] = function () { /* silent */ };
    });
    const ext = {
        exports: {},
        on(event, handler) { lifecycle[event] = handler; },
        once(event, handler) { lifecycle[event] = handler; },
        get(path, opts, handler) { routes.push({ method: 'GET', path, opts, handler }); },
        post(path, opts, handler) { routes.push({ method: 'POST', path, opts, handler }); },
        put(path, opts, handler) { routes.push({ method: 'PUT', path, opts, handler }); },
        delete(path, opts, handler) { routes.push({ method: 'DELETE', path, opts, handler }); },
        patch(path, opts, handler) { routes.push({ method: 'PATCH', path, opts, handler }); },
        log: stubLog, LOG: stubLog,
        import(name) {
            if (name === 'data') return { db: null, kv: null, cache: null };
            if (name === 'core') return { util: { helpers: {} } };
            return null;
        },
    };
    return { ext, routes, lifecycle };
}

function makeLoadHook(stubHolder) {
    return async function loadHook(entry) {
        const { ext, routes, lifecycle } = makeStubExtension();
        stubHolder.stub = { ext, routes, lifecycle };

        const prevExt = global.extension;
        const prevConfig = global.config;
        const prevGlobalConfig = global.global_config;

        global.extension = ext;
        global.config = {};
        global.global_config = {};

        try {
            const mainPath = join(entry.extensionDir, 'main.js');
            delete require.cache[require.resolve(mainPath)];
            require(mainPath);
            // Run the init hook the loaded main.js registered
            if (typeof lifecycle.init === 'function') {
                await lifecycle.init();
            }
            return ext.exports;
        } finally {
            global.extension = prevExt;
            global.config = prevConfig;
            global.global_config = prevGlobalConfig;
        }
    };
}

/**
 * Mock Express response — captures status + body so route handler
 * tests can assert on what was returned. Mirrors the subset of
 * `res.status().json()` the routes use.
 */
function mockRes() {
    const r = {
        statusCode: 200,
        body: undefined,
        status(code) { r.statusCode = code; return r; },
        json(payload) { r.body = payload; return r; },
    };
    return r;
}

// ---------------------------------------------------------------------------
// On-disk source sanity checks (cheap fail-fast before pipeline)
// ---------------------------------------------------------------------------

test('source dir exists with expected structure', (t) => {
    if (skipIfMissing(t)) return;
    assert.ok(existsSync(ENM_SOURCE_DIR), `ENM source dir missing: ${ENM_SOURCE_DIR}`);
    assert.ok(existsSync(join(ENM_SOURCE_DIR, 'app.json')));
    assert.ok(existsSync(join(ENM_SOURCE_DIR, 'app/index.html')));
    assert.ok(existsSync(join(ENM_SOURCE_DIR, 'backend/main.js')));
    assert.ok(existsSync(join(ENM_SOURCE_DIR, 'backend/package.json')));
});

test('on-disk manifest passes M1 schema validation', (t) => {
    if (skipIfMissing(t)) return;
    const raw = JSON.parse(readFileSync(join(ENM_SOURCE_DIR, 'app.json'), 'utf8'));
    // Patch placeholders with valid-shape strings so the schema check
    // doesn't reject them; this is the same thing make-test-capsule.mjs
    // does at sign time.
    raw.distribution = {
        cid: 'bafy' + 'a'.repeat(50),
        manifestDigest: 'a'.repeat(64),
        signature: 'b'.repeat(128),
        signedBy: 'c'.repeat(64),
    };
    assert.doesNotThrow(() => validateCapsuleManifest(raw));
});

// ---------------------------------------------------------------------------
// Full pipeline: sign → verify → install → register → load → routes work
// ---------------------------------------------------------------------------

test('full pipeline: ENM capsule installs through M1-M7, exports + routes live', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    const kp = nacl.sign.keyPair();
    const manifest = signedManifestFromDisk(kp);
    const bundleBuffer = await bundleEnmSource();

    // M1: schema valid
    assert.doesNotThrow(() => validateCapsuleManifest(manifest));

    // M1: signature verifies
    const verify = verifyManifestSignature(manifest, [pubHex(kp)]);
    assert.equal(verify.valid, true, `manifest verify failed: ${verify.reason}`);

    // M2: install lands in correct destinations
    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);
    assert.ok(existsSync(join(installResult.appDir, 'index.html')));
    assert.ok(existsSync(join(installResult.extensionDir, 'main.js')));
    assert.ok(existsSync(join(installResult.extensionDir, 'package.json')));

    // M3: register + lazy-load triggers init
    const stubHolder = {};
    const loader = new LazyExtensionLoader({
        loadHook: makeLoadHook(stubHolder),
    });
    loader.register('elastos-node-manager', installResult.extensionDir, manifest);
    assert.equal(loader.getState('elastos-node-manager'), 'registered');

    const outcome = await loader.ensureLoaded('elastos-node-manager');
    assert.equal(outcome.ok, true,
        `ensureLoaded failed: ${outcome.reason}`);
    assert.equal(outcome.state, 'loaded');

    // ENM exports surface
    assert.equal(outcome.module.greeting, 'Elastos Node Manager');
    assert.equal(outcome.module.version, '0.5.0');
    assert.equal(outcome.module.isReady(), true);
    assert.ok(typeof outcome.module.startedAt === 'number');
    assert.equal(outcome.module.getStats().requestCount, 0);

    // Routes registered (3 routes in scaffolding: /health, /version, /chains/:id)
    assert.equal(stubHolder.stub.routes.length, 3);
    assert.deepEqual(
        stubHolder.stub.routes.map(r => r.method + ' ' + r.path).sort(),
        ['GET /api/enm/chains/:chainId', 'GET /api/enm/health', 'GET /api/enm/version'],
    );

    // Run the /health route handler — proves the loaded module is callable
    const healthRoute = stubHolder.stub.routes.find(r => r.path === '/api/enm/health');
    const healthRes = mockRes();
    healthRoute.handler({ user: null, actor: null }, healthRes);
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.body.ok, true);
    assert.equal(healthRes.body.version, '0.5.0');
    assert.ok(healthRes.body.scaffolding);

    // /version route
    const versionRoute = stubHolder.stub.routes.find(r => r.path === '/api/enm/version');
    const versionRes = mockRes();
    versionRoute.handler({}, versionRes);
    assert.equal(versionRes.body.name, 'elastos-node-manager');
    assert.equal(versionRes.body.version, '0.5.0');

    // recordRequest + getStats updated by route hits
    const stats = outcome.module.getStats();
    assert.equal(stats.requestCount, 2, 'health + version each bumped the counter');
});

test('owner-only route: rejects unauthenticated request', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    const kp = nacl.sign.keyPair();
    const manifest = signedManifestFromDisk(kp);
    const bundleBuffer = await bundleEnmSource();

    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);

    const stubHolder = {};
    const loader = new LazyExtensionLoader({
        loadHook: makeLoadHook(stubHolder),
    });
    loader.register('elastos-node-manager', installResult.extensionDir, manifest);
    await loader.ensureLoaded('elastos-node-manager');

    const chainsRoute = stubHolder.stub.routes.find(r => r.path === '/api/enm/chains/:chainId');

    // No auth → 403
    const r1 = mockRes();
    chainsRoute.handler({ user: null, actor: null, params: { chainId: 'mainchain' } }, r1);
    assert.equal(r1.statusCode, 403);
    assert.equal(r1.body.error, 'owner_only');

    // With auth → returns the (stubbed) chain state
    const r2 = mockRes();
    chainsRoute.handler({
        user: { wallet_address: '0xowner' },
        params: { chainId: 'mainchain' },
    }, r2);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.body.chainId, 'mainchain');
    assert.equal(r2.body.state, 'unconfigured');

    // Unknown chain → 404
    const r3 = mockRes();
    chainsRoute.handler({
        user: { wallet_address: '0xowner' },
        params: { chainId: 'unknown' },
    }, r3);
    assert.equal(r3.statusCode, 404);
});

test('shutdown hook fires; exports flip to not-ready', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    const kp = nacl.sign.keyPair();
    const manifest = signedManifestFromDisk(kp);
    const bundleBuffer = await bundleEnmSource();

    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);

    const stubHolder = {};
    const loader = new LazyExtensionLoader({
        loadHook: makeLoadHook(stubHolder),
    });
    loader.register('elastos-node-manager', installResult.extensionDir, manifest);
    const outcome = await loader.ensureLoaded('elastos-node-manager');
    assert.equal(outcome.module.isReady(), true);

    // Run the shutdown hook. Production loaders re-set the extension
    // global around every lifecycle invocation since the hook's body
    // looks up `extension` via the global scope chain. Mirror that
    // here so the test exercises the same call path.
    assert.ok(typeof stubHolder.stub.lifecycle.shutdown === 'function');
    const prevExt = global.extension;
    global.extension = stubHolder.stub.ext;
    try {
        await stubHolder.stub.lifecycle.shutdown();
    } finally {
        global.extension = prevExt;
    }

    assert.equal(outcome.module.isReady(), false,
        'isReady should flip to false after shutdown hook');
});

test('uninstall: removes both halves cleanly', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    const kp = nacl.sign.keyPair();
    const manifest = signedManifestFromDisk(kp);
    const bundleBuffer = await bundleEnmSource();

    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);

    const result = await installer.uninstall('elastos-node-manager');
    assert.equal(result.appDirRemoved, true);
    assert.equal(result.extensionDirRemoved, true);
    assert.equal(result.dataDirRemoved, false, 'default keeps dataDir for safety');
    assert.equal(existsSync(installResult.appDir), false);
    assert.equal(existsSync(installResult.extensionDir), false);
});
