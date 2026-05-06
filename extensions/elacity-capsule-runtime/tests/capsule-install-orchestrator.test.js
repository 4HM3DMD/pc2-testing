/**
 * SPEC: CapsuleInstallOrchestrator — top-level install/uninstall flows.
 *
 * Helper location:
 *   pc2-node/src/services/CapsuleInstallOrchestrator.ts
 *
 * Purpose:
 *   Composes M1 (verify) + M2 (install) + M4 (assets) + M3 (loader)
 *   into the install/uninstall pipelines the dApp Centre HTTP routes
 *   call. Owns rollback semantics, structured progress events, and
 *   the trusted-publisher set.
 *
 *   Tests use real M1+M2+M3+M4 services with temp dirs (so the
 *   orchestration order + error propagation is exercised end-to-end),
 *   plus an in-process http.createServer for asset fetching.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'crypto';
import * as tar from 'tar';
import nacl from 'tweetnacl';

let CapsuleInstallOrchestrator, OrchestratorError, signManifest;
let CapsuleInstaller, LazyExtensionLoader, AssetFetcher;

try {
    ({ CapsuleInstallOrchestrator, OrchestratorError } =
        await import('../src/services/CapsuleInstallOrchestrator.js'));
    ({ signManifest } = await import('../src/services/CapsuleSignature.js'));
    ({ CapsuleInstaller } = await import('../src/services/CapsuleInstaller.js'));
    ({ LazyExtensionLoader } = await import('../src/services/LazyExtensionLoader.js'));
    ({ AssetFetcher } = await import('../src/services/AssetFetcher.js'));
} catch (err) {
    console.warn(`[spec] CapsuleInstallOrchestrator prerequisites: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!CapsuleInstallOrchestrator || !signManifest) {
        t.skip('CapsuleInstallOrchestrator not yet implemented (Wave 7 / M6)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeRoot() {
    const root = mkdtempSync(join(tmpdir(), 'pc2-orch-test-'));
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

async function buildBundle(layout) {
    const src = mkdtempSync(join(tmpdir(), 'pc2-orch-fixture-'));
    try {
        for (const [rel, content] of Object.entries(layout)) {
            const full = join(src, rel);
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, content);
        }
        const top = Array.from(new Set(Object.keys(layout).map(p => p.split('/')[0])));
        const chunks = [];
        await pipeline(
            tar.c({ gzip: true, cwd: src }, top),
            new Writable({ write(c, _, cb) { chunks.push(c); cb(); } }),
        );
        return Buffer.concat(chunks);
    } finally {
        rmSync(src, { recursive: true, force: true });
    }
}

function helloLayout() {
    return {
        'app/index.html': '<html>hello</html>',
        'backend/package.json': JSON.stringify({ name: 'hello', main: 'main.js' }),
        'backend/main.js': `extension.exports.greeting = 'world';`,
    };
}

function helloManifest(name = 'hello') {
    return {
        name, version: '0.1.0', kind: 'hybrid',
        engines: { node: '>=20', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/', needsRestart: false, schemaVersion: 1,
            dataDir: `data/installed-apps/${name}/state/`,
            capabilities: { spawnProcesses: ['ela'] },
        },
        distribution: {
            cid: 'bafy' + 'a'.repeat(50),
            manifestDigest: '', signature: '', signedBy: '',
        },
    };
}

async function buildSignedHello(name = 'hello') {
    const kp = nacl.sign.keyPair();
    const m = helloManifest(name);
    const buf = await buildBundle(helloLayout());
    const sig = signManifest(m, kp.secretKey);
    Object.assign(m.distribution, sig);
    return { manifest: m, bundleBuffer: buf, kp };
}

function buildOrchestrator(dirs, trustedKeys, opts = {}) {
    return new CapsuleInstallOrchestrator({
        installer: new CapsuleInstaller(dirs),
        loader: new LazyExtensionLoader({
            loadHook: opts.loadHook ?? (async () => ({})),
            probeFn: opts.probeFn ?? (async () => ({ ok: true, durationMs: 1 })),
        }),
        fetcher: new AssetFetcher({
            dataDir: dirs.dataDir,
            archResolver: opts.archResolver ?? (() => 'linux-x64'),
            httpFetcher: opts.httpFetcher,
        }),
        trustedPublisherKeys: trustedKeys,
        publisherDisplayName: opts.publisherDisplayName,
    });
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

test('ctor: requires installer + loader + fetcher', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new CapsuleInstallOrchestrator({}),
        { name: 'TypeError' });
});

test('ctor: requires at least one valid trusted key', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    assert.throws(() => new CapsuleInstallOrchestrator({
        installer: new CapsuleInstaller(dirs),
        loader: new LazyExtensionLoader({ loadHook: async () => ({}) }),
        fetcher: new AssetFetcher({ dataDir: dirs.dataDir }),
        trustedPublisherKeys: [],
    }), { name: 'TypeError' });
});

// ---------------------------------------------------------------------------
// install — happy path
// ---------------------------------------------------------------------------

test('install: validates → verifies → installs → registers; emits ordered phases', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    const phases = [];
    const summary = await orch.install({ manifest, bundleBuffer }, (event) => {
        if (!phases.includes(event.phase)) phases.push(event.phase);
    });

    assert.equal(summary.capsule, 'hello');
    assert.equal(summary.loaderState, 'registered',
        'loader should NOT auto-load — first request triggers');
    assert.ok(existsSync(summary.install.appDir));
    assert.ok(existsSync(summary.install.extensionDir));
    assert.equal(summary.assets.length, 0);   // no install-time assets

    // Phases must include validation → verify → install → register → done
    const idx = (p) => phases.indexOf(p);
    assert.ok(idx('validating-manifest') >= 0);
    assert.ok(idx('verifying-signature') > idx('validating-manifest'));
    assert.ok(idx('installing-bundle') > idx('verifying-signature'));
    assert.ok(idx('registering') > idx('installing-bundle'));
    assert.ok(idx('done') > idx('registering'));
});

test('install: rejects unsigned/wrong-publisher manifest', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    const otherTrusted = nacl.sign.keyPair();
    const orch = buildOrchestrator(dirs, [pubHex(otherTrusted)]);

    await assert.rejects(
        () => orch.install({ manifest, bundleBuffer }),
        (err) => err.name === 'OrchestratorError' && err.phase === 'verifying-signature',
    );
    // No install side-effects
    assert.equal(existsSync(join(dirs.dataDir, 'installed-apps', 'hello')), false);
    assert.equal(existsSync(join(dirs.extensionsDir, 'hello')), false);
});

test('install: rejects manifest with tampered capabilities', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    // Attacker mutates after sign
    manifest.backend.capabilities.spawnProcesses.push('bash');
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    await assert.rejects(
        () => orch.install({ manifest, bundleBuffer }),
        (err) => err.phase === 'verifying-signature',
    );
});

test('install: validation failure surfaces as CapsuleManifestError (no rollback needed)', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    manifest.kind = 'web';   // schema rejects non-hybrid
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    await assert.rejects(
        () => orch.install({ manifest, bundleBuffer }),
        (err) => err.name === 'CapsuleManifestError',
    );
});

// ---------------------------------------------------------------------------
// install — asset fetch + rollback on failure
// ---------------------------------------------------------------------------

test('install: rolls back when asset fetch fails', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));

    const kp = nacl.sign.keyPair();
    const layout = helloLayout();
    const buf = await buildBundle(layout);
    const m = helloManifest('rollback-test');

    // Add an asset that WILL fail to fetch (httpFetcher always 500s)
    m.assets = [{
        id: 'doomed',
        url: 'https://nope.invalid/x.tgz',
        sha256: 'a'.repeat(64),
        signature: 'b'.repeat(128),
        arch: 'linux-x64',
        sizeBytes: 100,
        fetchOn: 'install',
        extractTo: 'data/installed-apps/rollback-test/bin/',
    }];
    const sig = signManifest(m, kp.secretKey);
    Object.assign(m.distribution, sig);

    const orch = buildOrchestrator(dirs, [pubHex(kp)], {
        archResolver: () => 'linux-x64',
        httpFetcher: async () => ({
            statusCode: 500, headers: {}, stream: Readable.from(['x']),
        }),
    });

    const phases = [];
    await assert.rejects(
        () => orch.install({ manifest: m, bundleBuffer: buf }, (event) => {
            phases.push(event.phase);
        }),
        (err) => err.phase === 'fetching-assets',
    );

    assert.ok(phases.includes('rolling-back'));
    // After rollback: install + extension dirs should be empty
    assert.equal(existsSync(join(dirs.dataDir, 'installed-apps', 'rollback-test')), false);
    assert.equal(existsSync(join(dirs.extensionsDir, 'rollback-test')), false);
});

test('install: install-time assets fetched; first-run assets deferred', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));

    // Build a tarball asset
    const assetTar = await buildBundle({ 'thing': 'binary content' });
    const assetSha = sha256Hex(assetTar);
    const kp = nacl.sign.keyPair();

    let stubFetcherCalls = 0;
    const stubHttpFetcher = async (url) => {
        stubFetcherCalls++;
        if (url === 'https://test.invalid/install-time.tgz') {
            return { statusCode: 200, headers: { 'content-length': String(assetTar.length) },
                     stream: Readable.from([assetTar]) };
        }
        throw new Error(`unexpected URL: ${url}`);
    };

    const m = helloManifest('asset-test');
    m.assets = [
        {
            id: 'install-time',
            url: 'https://test.invalid/install-time.tgz',
            sha256: assetSha,
            signature: Buffer.from(nacl.sign.detached(
                new Uint8Array(Buffer.from(assetSha, 'hex')), kp.secretKey)).toString('hex'),
            arch: 'linux-x64',
            sizeBytes: assetTar.length,
            fetchOn: 'install',
            extractTo: 'data/installed-apps/asset-test/bin/',
        },
        {
            id: 'first-run-deferred',
            url: 'https://test.invalid/should-not-fetch-yet.tgz',
            sha256: 'c'.repeat(64),
            signature: 'd'.repeat(128),
            arch: 'linux-x64',
            sizeBytes: 100,
            fetchOn: 'first-run',
            extractTo: 'data/installed-apps/asset-test/extras/',
        },
    ];
    const sig = signManifest(m, kp.secretKey);
    Object.assign(m.distribution, sig);

    const buf = await buildBundle(helloLayout());
    const orch = buildOrchestrator(dirs, [pubHex(kp)], {
        archResolver: () => 'linux-x64',
        httpFetcher: stubHttpFetcher,
    });

    const summary = await orch.install({ manifest: m, bundleBuffer: buf });
    assert.equal(summary.assets.length, 1, 'only install-time assets fetched');
    assert.equal(summary.assets[0].assetId, 'install-time');
    assert.equal(stubFetcherCalls, 1, 'first-run asset must NOT be fetched');
});

// ---------------------------------------------------------------------------
// previewConsent
// ---------------------------------------------------------------------------

test('previewConsent: returns consent description for a verified manifest', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, kp } = await buildSignedHello();
    const orch = buildOrchestrator(dirs, [pubHex(kp)], {
        publisherDisplayName: () => 'ElacityLabs',
    });

    const consent = await orch.previewConsent(manifest);
    assert.equal(consent.publisher.displayName, 'ElacityLabs');
    assert.equal(consent.capsule.name, 'hello');
    assert.match(consent.trustHeadline, /trusting the publisher/i);
});

test('previewConsent: rejects for unverified manifest', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, kp } = await buildSignedHello();
    const otherTrusted = nacl.sign.keyPair();
    const orch = buildOrchestrator(dirs, [pubHex(otherTrusted)]);

    await assert.rejects(() => orch.previewConsent(manifest),
        { name: 'OrchestratorError', phase: 'verifying-signature' });
});

// ---------------------------------------------------------------------------
// uninstall + getUninstallPreview
// ---------------------------------------------------------------------------

test('uninstall: removes app + extension dirs, deregisters loader', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    const installed = await orch.install({ manifest, bundleBuffer });
    const result = await orch.uninstall('hello');
    assert.equal(result.appDirRemoved, true);
    assert.equal(result.extensionDirRemoved, true);
    assert.equal(result.dataDirRemoved, false, 'default keeps dataDir');
    assert.equal(result.loaderDeregistered, true);
    assert.equal(existsSync(installed.install.appDir), false);
    assert.equal(existsSync(installed.install.extensionDir), false);
});

test('uninstall: idempotent — second uninstall is a no-op', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    await orch.install({ manifest, bundleBuffer });
    await orch.uninstall('hello');
    const second = await orch.uninstall('hello');
    assert.equal(second.appDirRemoved, false);
    assert.equal(second.extensionDirRemoved, false);
    assert.equal(second.loaderDeregistered, false);
});

test('getUninstallPreview: surfaces the keep-vs-delete warning', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    await orch.install({ manifest, bundleBuffer });
    const preview = orch.getUninstallPreview('hello');
    assert.equal(preview.capsule, 'hello');
    assert.match(preview.deleteWarning, /erase any encryption keys/i);
    assert.match(preview.deleteWarning, /not recoverable/i);
});

test('getUninstallPreview: returns "not installed" for unknown name', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { kp } = await buildSignedHello();
    const orch = buildOrchestrator(dirs, [pubHex(kp)]);

    const preview = orch.getUninstallPreview('nope');
    assert.match(preview.deleteWarning, /not installed/);
});

// ---------------------------------------------------------------------------
// M7 revocation integration
// ---------------------------------------------------------------------------

test('install: rejected when isPublisherRevoked returns truthy (revocation hook)', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();

    const orch = buildOrchestrator(dirs, [pubHex(kp)], {});
    // Patch in the revocation check — buildOrchestrator's helper doesn't
    // wire this by default, so we re-construct.
    const orchWithRevocation = new CapsuleInstallOrchestrator({
        installer: new CapsuleInstaller(dirs),
        loader: new LazyExtensionLoader({
            loadHook: async () => ({}),
            probeFn: async () => ({ ok: true, durationMs: 1 }),
        }),
        fetcher: new AssetFetcher({ dataDir: dirs.dataDir, archResolver: () => 'linux-x64' }),
        trustedPublisherKeys: [pubHex(kp)],
        isPublisherRevoked: (k) =>
            k === pubHex(kp).toLowerCase() ? 'key compromised in audit' : undefined,
    });

    await assert.rejects(
        () => orchWithRevocation.install({ manifest, bundleBuffer }),
        (err) => err.name === 'OrchestratorError'
            && err.phase === 'verifying-signature'
            && /revoked/.test(err.message)
            && /key compromised/.test(err.message),
    );
    // No install side effects
    assert.equal(existsSync(join(dirs.dataDir, 'installed-apps', 'hello')), false);
});

test('previewConsent: rejected when isPublisherRevoked returns truthy', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, kp } = await buildSignedHello();

    const orchWithRevocation = new CapsuleInstallOrchestrator({
        installer: new CapsuleInstaller(dirs),
        loader: new LazyExtensionLoader({
            loadHook: async () => ({}),
            probeFn: async () => ({ ok: true, durationMs: 1 }),
        }),
        fetcher: new AssetFetcher({ dataDir: dirs.dataDir, archResolver: () => 'linux-x64' }),
        trustedPublisherKeys: [pubHex(kp)],
        isPublisherRevoked: () => true,
    });

    await assert.rejects(
        () => orchWithRevocation.previewConsent(manifest),
        (err) => err.phase === 'verifying-signature' && /revoked/.test(err.message),
    );
});

test('install: forceRevocationRefresh called BEFORE checking revocation', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();

    const callOrder = [];
    const orchWithRevocation = new CapsuleInstallOrchestrator({
        installer: new CapsuleInstaller(dirs),
        loader: new LazyExtensionLoader({
            loadHook: async () => ({}),
            probeFn: async () => ({ ok: true, durationMs: 1 }),
        }),
        fetcher: new AssetFetcher({ dataDir: dirs.dataDir, archResolver: () => 'linux-x64' }),
        trustedPublisherKeys: [pubHex(kp)],
        forceRevocationRefresh: async () => { callOrder.push('refresh'); },
        isPublisherRevoked: () => { callOrder.push('check'); return undefined; },
    });

    await orchWithRevocation.install({ manifest, bundleBuffer });
    assert.deepEqual(callOrder, ['refresh', 'check']);
});

test('install: forceRevocationRefresh failure is swallowed (last-good fallback)', async (t) => {
    if (skipIfMissing(t)) return;
    const dirs = makeRoot(); t.after(() => cleanup(dirs.root));
    const { manifest, bundleBuffer, kp } = await buildSignedHello();

    const orchWithRevocation = new CapsuleInstallOrchestrator({
        installer: new CapsuleInstaller(dirs),
        loader: new LazyExtensionLoader({
            loadHook: async () => ({}),
            probeFn: async () => ({ ok: true, durationMs: 1 }),
        }),
        fetcher: new AssetFetcher({ dataDir: dirs.dataDir, archResolver: () => 'linux-x64' }),
        trustedPublisherKeys: [pubHex(kp)],
        forceRevocationRefresh: async () => { throw new Error('supernode unreachable'); },
        isPublisherRevoked: () => undefined,
    });

    // Install proceeds — refresh failure is non-fatal, last-good list is used
    const summary = await orchWithRevocation.install({ manifest, bundleBuffer });
    assert.equal(summary.capsule, 'hello');
});
