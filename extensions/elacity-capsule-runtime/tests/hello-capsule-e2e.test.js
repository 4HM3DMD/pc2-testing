/**
 * SPEC: Hello-world capsule end-to-end integration test.
 *
 * This is the M5 integration moment. Validates that M1 (manifest +
 * signature), M2 (atomic extraction), M3 (lazy loader + probe), and
 * M4 (asset fetcher) compose into a working install pipeline:
 *
 *   1. Build a signed hybrid capsule in-memory (publisher = test key)
 *   2. Verify the manifest (M1 verifyManifestSignature)
 *   3. Install via CapsuleInstaller (M2) — atomic two-target extract
 *   4. Optionally fetch declared assets via AssetFetcher (M4)
 *   5. Register + lazy-load the backend via LazyExtensionLoader (M3)
 *   6. Confirm the backend's exports are reachable from the loader
 *   7. Uninstall + deregister, confirm clean state
 *
 * The loadHook used by the loader is a tight version of what the
 * production wire-up (M5+) will eventually do: construct a stub
 * `extension` global, require the backend's main file, capture
 * `extension.exports`. Tests assert on the captured exports so we
 * know the require actually executed and the module state is live.
 *
 * If the architecture is wrong, this test fails with a clear stage
 * marker. If everything passes, M1-M4 are integration-correct and
 * the remaining milestones (UI, revocation, ENM port, drain) are
 * additive layers on a working foundation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as http from 'http';
import * as tar from 'tar';
import nacl from 'tweetnacl';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let validateCapsuleManifest, signManifest, verifyManifestSignature;
let CapsuleInstaller, LazyExtensionLoader, AssetFetcher;

try {
    ({ validateCapsuleManifest } = await import('../src/services/CapsuleManifest.js'));
    ({ signManifest, verifyManifestSignature } = await import('../src/services/CapsuleSignature.js'));
    ({ CapsuleInstaller } = await import('../src/services/CapsuleInstaller.js'));
    ({ LazyExtensionLoader } = await import('../src/services/LazyExtensionLoader.js'));
    ({ AssetFetcher } = await import('../src/services/AssetFetcher.js'));
} catch (err) {
    console.warn(`[spec] hello-capsule-e2e prerequisites missing: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!CapsuleInstaller || !LazyExtensionLoader || !AssetFetcher
        || !signManifest || !validateCapsuleManifest) {
        t.skip('M1-M4 prerequisites not yet implemented');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeTestRoot() {
    const root = mkdtempSync(join(tmpdir(), 'pc2-hello-e2e-'));
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

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a tar.gz buffer from a layout dict, mirroring the shape
 * CapsuleInstaller expects (`app/` + `backend/` + `app.json` at root).
 */
async function buildCapsuleBundle(layout) {
    const src = mkdtempSync(join(tmpdir(), 'pc2-hello-fixture-'));
    try {
        for (const [rel, content] of Object.entries(layout)) {
            const full = join(src, rel);
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, content);
        }
        const topLevel = Array.from(new Set(Object.keys(layout).map(p => p.split('/')[0])));
        const chunks = [];
        await pipeline(
            tar.c({ gzip: true, cwd: src }, topLevel),
            new Writable({ write(chunk, _, cb) { chunks.push(chunk); cb(); } }),
        );
        return Buffer.concat(chunks);
    } finally {
        rmSync(src, { recursive: true, force: true });
    }
}

/**
 * Construct a minimum-viable `extension` stub that an installed
 * backend's `require` can execute against. Records routes,
 * lifecycle hooks, and exports so the test can assert on what the
 * extension actually did.
 *
 * This mirrors what the production loader (M5+ wire-up) will do
 * once it integrates with PC2's real Extension class. For M5 the
 * stub is enough to validate the LOADER fires the require and
 * captures the resulting module state.
 */
function makeStubExtension() {
    const routes = [];
    const lifecycle = {};
    const stubLog = function (...args) { /* silent in tests */ };
    ['info', 'warn', 'debug', 'error', 'tick', 'noticeme', 'system'].forEach(lvl => {
        stubLog[lvl] = function (...args) { /* silent */ };
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

/**
 * Build a make-loader hook that takes the production-style "require
 * the backend's main file with a stub extension global" approach.
 * Captures the stub so the test can inspect routes + lifecycle + exports.
 */
function makeLoadHook(stubHolder) {
    return async function loadHook(entry) {
        const { ext, routes, lifecycle } = makeStubExtension();
        stubHolder.stub = { ext, routes, lifecycle };

        // Save existing globals so we restore on exit
        const prevExt = global.extension;
        const prevConfig = global.config;
        const prevGlobalConfig = global.global_config;

        global.extension = ext;
        global.config = {};
        global.global_config = {};

        try {
            // Use createRequire so the test's ESM context can require the
            // CJS-style backend main file. Bust the require cache so
            // multiple tests can re-load the same path freshly.
            const mainPath = join(entry.extensionDir, 'main.js');
            delete require.cache[require.resolve(mainPath)];
            require(mainPath);
            return ext.exports;
        } finally {
            global.extension = prevExt;
            global.config = prevConfig;
            global.global_config = prevGlobalConfig;
        }
    };
}

/**
 * Build a fully-signed hello-world capsule. Returns
 * { manifest, bundleBuffer, publisherKey } — caller installs.
 */
async function buildSignedHelloCapsule({ withAssets } = {}) {
    const kp = nacl.sign.keyPair();
    const layout = {
        'app/index.html': '<html><body>Hello from the capsule</body></html>',
        'backend/package.json': JSON.stringify({ name: 'hello-capsule', main: 'main.js' }),
        'backend/main.js': `
            extension.exports.greeting = 'hello world';
            extension.exports.timestamp = Date.now();
            extension.on('init', () => { extension.exports.initialised = true; });
            extension.get('/hello', { subdomain: 'api' }, (req, res) => {
                res.json({ ok: true });
            });
        `,
    };

    const bundleBuffer = await buildCapsuleBundle(layout);

    const manifest = {
        name: 'hello-capsule',
        version: '0.1.0',
        kind: 'hybrid',
        title: 'Hello Capsule',
        engines: { node: '>=20', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/',
            needsRestart: false,
            schemaVersion: 1,
            dataDir: 'data/installed-apps/hello-capsule/state/',
            shutdownTimeoutMs: 5000,
            capabilities: {
                spawnProcesses: [],
                ports: { tcp: [], publish: false },
            },
        },
        distribution: {
            cid: 'bafy' + 'a'.repeat(50),
            manifestDigest: '',
            signature: '',
            signedBy: '',
        },
    };

    if (withAssets) {
        manifest.assets = [
            // Filled in by the asset-flavoured test below — needs a
            // running http server before we can compute sha256.
        ];
    }

    const sig = signManifest(manifest, kp.secretKey);
    manifest.distribution.manifestDigest = sig.manifestDigest;
    manifest.distribution.signature = sig.signature;
    manifest.distribution.signedBy = sig.signedBy;

    return { manifest, bundleBuffer, publisherKey: kp };
}

// ---------------------------------------------------------------------------
// E2E: install + lazy-load + verify exports + uninstall
// ---------------------------------------------------------------------------

test('e2e: sign → verify → install → register → lazy-load → exports live', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    const { manifest, bundleBuffer, publisherKey } = await buildSignedHelloCapsule();

    // Stage 1: schema validation passes
    assert.doesNotThrow(() => validateCapsuleManifest(manifest));

    // Stage 2: signature verifies against the publisher pubkey
    const verify = verifyManifestSignature(manifest, [pubHex(publisherKey)]);
    assert.equal(verify.valid, true,
        `manifest verify failed: ${verify.reason}`);

    // Stage 3: install via M2
    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);
    assert.equal(installResult.appDir, join(dirs.dataDir, 'installed-apps', 'hello-capsule'));
    assert.equal(installResult.extensionDir, join(dirs.extensionsDir, 'hello-capsule'));
    assert.ok(existsSync(join(installResult.appDir, 'index.html')));
    assert.ok(existsSync(join(installResult.extensionDir, 'main.js')));

    // Stage 4: register + lazy-load via M3
    // Use the real probe (which forks a child process) for full coverage.
    const stubHolder = {};
    const loader = new LazyExtensionLoader({
        loadHook: makeLoadHook(stubHolder),
    });
    loader.register('hello-capsule', installResult.extensionDir, manifest);
    assert.equal(loader.getState('hello-capsule'), 'registered');

    const outcome = await loader.ensureLoaded('hello-capsule');
    assert.equal(outcome.ok, true,
        `ensureLoaded failed: ${outcome.reason}`);
    assert.equal(outcome.state, 'loaded');
    assert.equal(loader.isLoaded('hello-capsule'), true);

    // Stage 5: backend exports are live (require executed in main process)
    assert.equal(outcome.module.greeting, 'hello world');
    assert.ok(typeof outcome.module.timestamp === 'number');

    // Stage 6: stub captured the route + lifecycle registrations
    assert.equal(stubHolder.stub.routes.length, 1);
    assert.equal(stubHolder.stub.routes[0].method, 'GET');
    assert.equal(stubHolder.stub.routes[0].path, '/hello');
    assert.ok(typeof stubHolder.stub.lifecycle.init === 'function');

    // Stage 7: uninstall removes both halves; loader deregisters cleanly
    loader.deregister('hello-capsule');
    const uninstallResult = await installer.uninstall('hello-capsule');
    assert.equal(uninstallResult.appDirRemoved, true);
    assert.equal(uninstallResult.extensionDirRemoved, true);
    assert.equal(existsSync(installResult.appDir), false);
    assert.equal(existsSync(installResult.extensionDir), false);
    assert.equal(loader.isRegistered('hello-capsule'), false);
});

// ---------------------------------------------------------------------------
// E2E: install + asset fetch (M4 in the loop)
// ---------------------------------------------------------------------------

test('e2e: install + asset fetch via http server → asset lands in extractTo', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    // Build a tiny "binary" tarball that the asset declaration points at.
    const assetTarball = await (async () => {
        const src = mkdtempSync(join(tmpdir(), 'pc2-hello-asset-src-'));
        try {
            mkdirSync(join(src, 'bin'), { recursive: true });
            writeFileSync(join(src, 'bin/hello-bin'), 'pretend this is a binary');
            const chunks = [];
            await pipeline(
                tar.c({ gzip: true, cwd: src }, ['bin']),
                new Writable({ write(c, _, cb) { chunks.push(c); cb(); } }),
            );
            return Buffer.concat(chunks);
        } finally {
            rmSync(src, { recursive: true, force: true });
        }
    })();

    const assetSha = sha256Hex(assetTarball);

    // The MANIFEST declares an https:// URL (M1 schema requires it for
    // production assets). For the test we don't run a TLS server — we
    // inject a custom httpFetcher into AssetFetcher that intercepts the
    // declared URL and returns the test bytes. The publisher signature
    // commits to the declared URL; a real install would resolve that
    // URL via the normal fetcher. This lets us exercise the full
    // sign/verify/install/fetch chain without TLS plumbing.
    const assetUrl = 'https://test.invalid/hello-bin.tgz';
    const stubHttpFetcher = async (url, opts) => {
        if (url !== assetUrl) {
            throw new Error(`stub httpFetcher: unexpected URL ${url}`);
        }
        const { Readable } = await import('node:stream');
        return {
            statusCode: 200,
            headers: { 'content-length': String(assetTarball.length) },
            stream: Readable.from([assetTarball]),
        };
    };

    // Build the capsule manifest WITH an asset declaration. The publisher
    // key signs both the manifest digest AND the asset's sha256.
    const kp = nacl.sign.keyPair();
    const layout = {
        'app/index.html': '<html>asset capsule</html>',
        'backend/package.json': JSON.stringify({ name: 'asset-capsule', main: 'main.js' }),
        'backend/main.js': `extension.exports.ready = true;`,
    };
    const bundleBuffer = await buildCapsuleBundle(layout);

    const manifest = {
        name: 'asset-capsule',
        version: '0.1.0',
        kind: 'hybrid',
        engines: { node: '>=20', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/',
            needsRestart: false,
            schemaVersion: 1,
            dataDir: 'data/installed-apps/asset-capsule/state/',
        },
        assets: [
            {
                id: 'hello-binary',
                url: assetUrl,
                sha256: assetSha,
                signature: Buffer.from(
                    nacl.sign.detached(
                        new Uint8Array(Buffer.from(assetSha, 'hex')),
                        kp.secretKey,
                    ),
                ).toString('hex'),
                arch: 'linux-x64',     // overridden by archResolver below
                sizeBytes: assetTarball.length,
                fetchOn: 'install',
                extractTo: 'data/installed-apps/asset-capsule/bin/',
            },
        ],
        distribution: {
            cid: 'bafy' + 'b'.repeat(50),
            manifestDigest: '',
            signature: '',
            signedBy: '',
        },
    };
    const sig = signManifest(manifest, kp.secretKey);
    manifest.distribution.manifestDigest = sig.manifestDigest;
    manifest.distribution.signature = sig.signature;
    manifest.distribution.signedBy = sig.signedBy;

    // Sanity: manifest verifies
    const verify = verifyManifestSignature(manifest, [pubHex(kp)]);
    assert.equal(verify.valid, true, `manifest verify failed: ${verify.reason}`);

    // Install via M2
    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);

    // Fetch the asset via M4. Use a fixed archResolver so the test
    // doesn't depend on the host's actual platform; inject the stub
    // httpFetcher so the https:// URL in the (signed) manifest can be
    // served by an in-process function instead of needing real TLS.
    const fetcher = new AssetFetcher({
        dataDir: dirs.dataDir,
        archResolver: () => 'linux-x64',
        httpFetcher: stubHttpFetcher,
    });
    const fetched = await fetcher.fetchAll(manifest.assets, manifest.distribution.signedBy);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].skipped, false,
        `asset was unexpectedly skipped: ${fetched[0].skipReason}`);
    assert.equal(fetched[0].sourceUsed, assetUrl);

    // Asset should have extracted into the per-capsule install root
    const expectedAssetPath = join(
        dirs.dataDir, 'installed-apps', 'asset-capsule', 'bin', 'bin', 'hello-bin',
    );
    assert.ok(existsSync(expectedAssetPath),
        `expected asset at ${expectedAssetPath} but not found`);
    assert.equal(readFileSync(expectedAssetPath, 'utf8'), 'pretend this is a binary');

    // Cleanup
    await installer.uninstall('asset-capsule');
});

// ---------------------------------------------------------------------------
// E2E: bad publisher key rejected at the verify step
// ---------------------------------------------------------------------------

test('e2e: install rejected when publisher not in trusted set', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, publisherKey } = await buildSignedHelloCapsule();

    // Generate a DIFFERENT trusted publisher — the manifest is signed by
    // someone we don't trust. Verify must fail.
    const trustedOther = nacl.sign.keyPair();
    const verify = verifyManifestSignature(manifest, [pubHex(trustedOther)]);
    assert.equal(verify.valid, false);
    assert.match(verify.reason, /not in trusted set/);
});

// ---------------------------------------------------------------------------
// E2E: install rejected when manifest tampered after signing
// ---------------------------------------------------------------------------

test('e2e: capabilities tampered after sign → verify fails before install', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, publisherKey } = await buildSignedHelloCapsule();

    // Attacker modifies the manifest after the publisher signed it
    manifest.backend.capabilities.spawnProcesses = ['ela', 'bash'];

    const verify = verifyManifestSignature(manifest, [pubHex(publisherKey)]);
    assert.equal(verify.valid, false);
    assert.match(verify.reason, /[Dd]igest mismatch/);
});

// ---------------------------------------------------------------------------
// E2E: lazy-load skipped when capsule's backend is broken
// ---------------------------------------------------------------------------

test('e2e: broken backend (sync throw) → loader probe fails → state="failed"', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeTestRoot(); t.after(() => cleanup(dirs.root));

    // Build a capsule whose backend throws at module-load
    const kp = nacl.sign.keyPair();
    const layout = {
        'app/index.html': '<html>broken</html>',
        'backend/package.json': JSON.stringify({ name: 'broken', main: 'main.js' }),
        'backend/main.js': `throw new Error('intentional boom from broken backend');`,
    };
    const bundleBuffer = await buildCapsuleBundle(layout);
    const manifest = {
        name: 'broken-capsule', version: '0.1.0', kind: 'hybrid',
        engines: { node: '>=20', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/', needsRestart: false, schemaVersion: 1,
            dataDir: 'data/installed-apps/broken-capsule/state/',
        },
        distribution: {
            cid: 'bafy' + 'c'.repeat(50),
            manifestDigest: '', signature: '', signedBy: '',
        },
    };
    const sig = signManifest(manifest, kp.secretKey);
    Object.assign(manifest.distribution, sig);

    const installer = new CapsuleInstaller({
        dataDir: dirs.dataDir,
        extensionsDir: dirs.extensionsDir,
        stagingDir: dirs.stagingDir,
    });
    const installResult = await installer.install(manifest, bundleBuffer);

    // Real probe should catch the sync throw safely in a child process
    const stubHolder = {};
    const loader = new LazyExtensionLoader({
        loadHook: makeLoadHook(stubHolder),
        crashThreshold: 5,   // enough headroom to not quarantine on first try
    });
    loader.register('broken-capsule', installResult.extensionDir, manifest);

    const outcome = await loader.ensureLoaded('broken-capsule');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state, 'failed');
    assert.match(outcome.reason, /probe failed/);
    // PC2 main process is still alive (this assertion line is only reached
    // because the probe contained the throw in a child process)
    assert.ok(true, 'PC2 main process survived broken capsule load');
});
