/**
 * SPEC: AssetFetcher — fetch + verify + extract `manifest.assets[]`.
 *
 * Helper location:
 *   pc2-node/src/services/AssetFetcher.ts
 *
 * Purpose:
 *   For each declared asset, stream-download from the publisher's URL
 *   (or one of its mirrors), verify sha256 + Ed25519 signature against
 *   the publisher key, then either extract tarballs into the
 *   `extractTo` directory or place single files inside it.
 *
 *   Tests spin up a tiny http.createServer() so the full pipeline
 *   (download → hash → verify → extract) runs end-to-end. The
 *   AssetFetcher's HTTPS code path uses the same `httpFetcher` shape
 *   we inject for tests, so http vs https is a transport detail
 *   covered by integration tests not unit tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import * as http from 'http';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import nacl from 'tweetnacl';

const HELPER_PATH = '../../src/services/AssetFetcher.js';
let AssetFetcher, AssetFetchError, looksLikeTarball, verifyAssetSignature, defaultArchResolver;

try {
    ({ AssetFetcher, AssetFetchError, looksLikeTarball, verifyAssetSignature, defaultArchResolver }
        = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] AssetFetcher not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!AssetFetcher) {
        t.skip('AssetFetcher not yet implemented (Wave 7 / M4)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeDataDir() {
    return mkdtempSync(join(tmpdir(), 'pc2-asset-fetcher-test-'));
}

function cleanup(dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function signWithKey(secretKey, sha256Hex) {
    const digestBytes = Buffer.from(sha256Hex, 'hex');
    const sig = nacl.sign.detached(new Uint8Array(digestBytes), secretKey);
    return Buffer.from(sig).toString('hex');
}

function pubHex(kp) {
    return Buffer.from(kp.publicKey).toString('hex');
}

/**
 * Build a tarball buffer containing the given file layout.
 *   { 'bin/ela': 'hello-binary' }
 */
async function buildTarballBuffer(layout) {
    const src = mkdtempSync(join(tmpdir(), 'pc2-asset-tar-'));
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
 * Spin up an HTTP server that serves a fixed map of pathname → response.
 *   responses['/binary.tgz'] = { status: 200, body: <Buffer> }
 *   responses['/redir']      = { status: 302, location: '/elsewhere' }
 *   responses['/down']       = { status: 500, body: 'oops' }
 *   responses['/slow']       = { status: 200, body: <Buffer>, delayBetweenChunksMs: 500 }
 *   responses['/hang']       = { hang: true }   // never responds
 */
async function startServer(responses) {
    const server = http.createServer((req, res) => {
        const r = responses[req.url];
        if (!r) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        if (r.hang) return;   // intentional infinite hang
        if (r.location) {
            res.statusCode = r.status ?? 302;
            res.setHeader('Location', r.location);
            res.end();
            return;
        }
        res.statusCode = r.status ?? 200;
        if (r.body) {
            res.setHeader('Content-Length', String(r.body.length));
            res.write(r.body);
        }
        res.end();
    });
    await new Promise(resolveP => server.listen(0, '127.0.0.1', resolveP));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    return { server, baseUrl, close: () => new Promise(r => server.close(r)) };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('looksLikeTarball: recognises .tgz, .tar.gz, .tar; rejects .bin', (t) => {
    if (skipIfMissing(t)) return;
    assert.equal(looksLikeTarball('https://example.com/foo.tgz'), true);
    assert.equal(looksLikeTarball('https://example.com/foo.tar.gz'), true);
    assert.equal(looksLikeTarball('https://example.com/FOO.TAR'), true);
    assert.equal(looksLikeTarball('https://example.com/foo.bin'), false);
    assert.equal(looksLikeTarball('https://example.com/foo'), false);
});

test('defaultArchResolver: returns <platform>-<arch> form', (t) => {
    if (skipIfMissing(t)) return;
    const result = defaultArchResolver();
    assert.match(result, /^(linux|darwin|win32|freebsd|openbsd|sunos|aix)-(x64|arm64|arm|ia32|ppc64|s390x|mips|mipsel)$/);
});

test('verifyAssetSignature: round-trip with fresh key passes', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const sha256 = sha256Hex(Buffer.from('test-binary'));
    const asset = {
        id: 'test', sha256, signature: signWithKey(kp.secretKey, sha256),
        url: 'x', arch: 'x', sizeBytes: 1, fetchOn: 'install', extractTo: 'x',
    };
    assert.doesNotThrow(() => verifyAssetSignature(asset, pubHex(kp)));
});

test('verifyAssetSignature: bad signature throws AssetFetchError', (t) => {
    if (skipIfMissing(t)) return;
    const kp = nacl.sign.keyPair();
    const sha256 = sha256Hex(Buffer.from('test-binary'));
    const asset = {
        id: 'test', sha256, signature: 'b'.repeat(128),
        url: 'x', arch: 'x', sizeBytes: 1, fetchOn: 'install', extractTo: 'x',
    };
    assert.throws(() => verifyAssetSignature(asset, pubHex(kp)),
        { name: 'AssetFetchError', phase: 'verifying-signature' });
});

test('verifyAssetSignature: wrong publisher key throws', (t) => {
    if (skipIfMissing(t)) return;
    const kpA = nacl.sign.keyPair();
    const kpB = nacl.sign.keyPair();
    const sha256 = sha256Hex(Buffer.from('test'));
    const asset = {
        id: 'test', sha256, signature: signWithKey(kpA.secretKey, sha256),
        url: 'x', arch: 'x', sizeBytes: 1, fetchOn: 'install', extractTo: 'x',
    };
    assert.throws(() => verifyAssetSignature(asset, pubHex(kpB)),
        { name: 'AssetFetchError', phase: 'verifying-signature' });
});

// ---------------------------------------------------------------------------
// Happy paths — real http server, end-to-end
// ---------------------------------------------------------------------------

test('fetchOne: tarball download → verify → extract → final files in extractTo', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const tarBuf = await buildTarballBuffer({
        'bin/ela': 'fake ela binary',
        'bin/ela-cli': 'fake ela-cli binary',
    });
    const sha = sha256Hex(tarBuf);
    const kp = nacl.sign.keyPair();
    const sig = signWithKey(kp.secretKey, sha);

    const srv = await startServer({ '/ela.tgz': { status: 200, body: tarBuf } });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({
        dataDir,
        archResolver: () => 'linux-x64',
    });

    const asset = {
        id: 'ela-binary',
        url: `${srv.baseUrl}/ela.tgz`,
        sha256: sha, signature: sig,
        arch: 'linux-x64', sizeBytes: tarBuf.length,
        fetchOn: 'install',
        extractTo: 'bin/',
    };

    const result = await fetcher.fetchOne(asset, pubHex(kp));
    assert.equal(result.skipped, false);
    assert.equal(result.sourceUsed, asset.url);
    assert.equal(result.downloadedBytes, tarBuf.length);
    assert.ok(existsSync(join(dataDir, 'bin', 'bin', 'ela')));
    assert.ok(existsSync(join(dataDir, 'bin', 'bin', 'ela-cli')));
    assert.equal(readFileSync(join(dataDir, 'bin', 'bin', 'ela'), 'utf8'), 'fake ela binary');
});

test('fetchOne: single file (non-tarball) → renamed to extractTo/<basename>', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('raw single binary content');
    const sha = sha256Hex(body);
    const kp = nacl.sign.keyPair();
    const sig = signWithKey(kp.secretKey, sha);

    const srv = await startServer({ '/single.bin': { status: 200, body } });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({
        dataDir,
        archResolver: () => 'linux-x64',
    });

    const asset = {
        id: 'single', url: `${srv.baseUrl}/single.bin`,
        sha256: sha, signature: sig,
        arch: 'linux-x64', sizeBytes: body.length,
        fetchOn: 'install', extractTo: 'misc/',
    };

    const result = await fetcher.fetchOne(asset, pubHex(kp));
    assert.equal(result.extractedTo, join(dataDir, 'misc', 'single.bin'));
    assert.equal(readFileSync(result.extractedTo, 'utf8'), 'raw single binary content');
});

test('fetchOne: progress callbacks fire through the phases', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const tarBuf = await buildTarballBuffer({ 'bin/ela': 'x' });
    const sha = sha256Hex(tarBuf);
    const kp = nacl.sign.keyPair();
    const srv = await startServer({ '/x.tgz': { status: 200, body: tarBuf } });
    t.after(() => srv.close());
    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });

    const phases = [];
    await fetcher.fetchOne({
        id: 'a', url: `${srv.baseUrl}/x.tgz`,
        sha256: sha, signature: signWithKey(kp.secretKey, sha),
        arch: 'linux-x64', sizeBytes: tarBuf.length,
        fetchOn: 'install', extractTo: 'bin/',
    }, pubHex(kp), (ev) => {
        if (!phases.includes(ev.phase)) phases.push(ev.phase);
    });

    // Order isn't strict (downloading fires multiple times) but key
    // phases must all appear in the right relative order.
    const idxOf = p => phases.indexOf(p);
    assert.ok(idxOf('connecting') >= 0);
    assert.ok(idxOf('downloading') > idxOf('connecting'));
    assert.ok(idxOf('hashing') > idxOf('downloading'));
    assert.ok(idxOf('verifying-signature') > idxOf('hashing'));
    assert.ok(idxOf('extracting') > idxOf('verifying-signature'));
    assert.ok(idxOf('done') > idxOf('extracting'));
});

// ---------------------------------------------------------------------------
// Skip path: arch mismatch
// ---------------------------------------------------------------------------

test('fetchOne: arch mismatch → skipped (not failed)', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    const result = await fetcher.fetchOne({
        id: 'arm-only', url: 'https://nowhere.invalid/foo.tgz',
        sha256: 'a'.repeat(64), signature: 'b'.repeat(128),
        arch: 'linux-arm64', sizeBytes: 1,
        fetchOn: 'install', extractTo: 'bin/',
    }, 'c'.repeat(64));
    assert.equal(result.skipped, true);
    assert.match(result.skipReason, /arch.*linux-x64.*linux-arm64/);
});

// ---------------------------------------------------------------------------
// Failure paths — sha256 mismatch, signature tamper, http errors
// ---------------------------------------------------------------------------

test('fetchOne: server serves different bytes → sha256 mismatch → failed (no mirrors)', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const declared = sha256Hex(Buffer.from('declared content'));
    const kp = nacl.sign.keyPair();
    const srv = await startServer({
        '/x.tgz': { status: 200, body: Buffer.from('actual served content (different)') },
    });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'mismatch', url: `${srv.baseUrl}/x.tgz`,
            sha256: declared, signature: signWithKey(kp.secretKey, declared),
            arch: 'linux-x64', sizeBytes: 100,
            fetchOn: 'install', extractTo: 'bin/',
        }, pubHex(kp)),
        (err) => err.name === 'AssetFetchError' && /all 1 source/.test(err.message),
    );
});

test('fetchOne: signature mismatch on sha256-matching bytes → HARD fail (no mirror retry)', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('valid content');
    const sha = sha256Hex(body);
    const kpReal = nacl.sign.keyPair();
    const kpAttacker = nacl.sign.keyPair();
    const srv = await startServer({
        '/primary': { status: 200, body },
        '/mirror':  { status: 200, body },
    });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    // Asset declares the REAL publisher's key; mirror delivers correct
    // bytes BUT we supply a signature signed by attacker's key.
    // verifyAssetSignature must fail; mirror must NOT be tried.
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'attack', url: `${srv.baseUrl}/primary`,
            mirrors: [`${srv.baseUrl}/mirror`],
            sha256: sha,
            signature: signWithKey(kpAttacker.secretKey, sha),  // wrong key signed
            arch: 'linux-x64', sizeBytes: body.length,
            fetchOn: 'install', extractTo: 'bin/',
        }, pubHex(kpReal)),
        (err) => err.phase === 'verifying-signature' && /refusing to try mirrors/.test(err.message),
    );
});

test('fetchOne: primary 500 → falls back to mirror and succeeds', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('mirrored content');
    const sha = sha256Hex(body);
    const kp = nacl.sign.keyPair();
    const srv = await startServer({
        '/primary': { status: 500, body: Buffer.from('oops') },
        '/mirror':  { status: 200, body },
    });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    const result = await fetcher.fetchOne({
        id: 'm', url: `${srv.baseUrl}/primary`,
        mirrors: [`${srv.baseUrl}/mirror`],
        sha256: sha, signature: signWithKey(kp.secretKey, sha),
        arch: 'linux-x64', sizeBytes: body.length,
        fetchOn: 'install', extractTo: 'misc/',
    }, pubHex(kp));
    assert.equal(result.sourceUsed, `${srv.baseUrl}/mirror`);
});

test('fetchOne: primary serves wrong sha256 → tries mirror', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const goodBody = Buffer.from('correct content');
    const sha = sha256Hex(goodBody);
    const kp = nacl.sign.keyPair();
    const srv = await startServer({
        '/primary': { status: 200, body: Buffer.from('wrong content') },
        '/mirror':  { status: 200, body: goodBody },
    });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    const result = await fetcher.fetchOne({
        id: 'm', url: `${srv.baseUrl}/primary`,
        mirrors: [`${srv.baseUrl}/mirror`],
        sha256: sha, signature: signWithKey(kp.secretKey, sha),
        arch: 'linux-x64', sizeBytes: goodBody.length,
        fetchOn: 'install', extractTo: 'misc/',
    }, pubHex(kp));
    assert.equal(result.sourceUsed, `${srv.baseUrl}/mirror`);
});

test('fetchOne: all sources fail → reports all in error', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const srv = await startServer({
        '/p1': { status: 500 },
        '/p2': { status: 503 },
    });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'failall', url: `${srv.baseUrl}/p1`,
            mirrors: [`${srv.baseUrl}/p2`],
            sha256: 'a'.repeat(64), signature: 'b'.repeat(128),
            arch: 'linux-x64', sizeBytes: 100,
            fetchOn: 'install', extractTo: 'misc/',
        }, 'c'.repeat(64)),
        (err) => err.name === 'AssetFetchError'
            && /all 2 source/.test(err.message)
            && /500/.test(err.message)
            && /503/.test(err.message),
    );
});

test('fetchOne: ipfs:// mirrors are skipped (v1 placeholder)', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('content');
    const sha = sha256Hex(body);
    const kp = nacl.sign.keyPair();
    const srv = await startServer({ '/ok': { status: 200, body } });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    // Primary fails, ipfs:// mirror is silently skipped, http mirror succeeds.
    const result = await fetcher.fetchOne({
        id: 'm', url: `${srv.baseUrl}/missing-404`,
        mirrors: ['ipfs://bafyaaa', `${srv.baseUrl}/ok`],
        sha256: sha, signature: signWithKey(kp.secretKey, sha),
        arch: 'linux-x64', sizeBytes: body.length,
        fetchOn: 'install', extractTo: 'misc/',
    }, pubHex(kp));
    assert.equal(result.sourceUsed, `${srv.baseUrl}/ok`);
});

test('fetchOne: redirects followed up to MAX_REDIRECTS', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('redirected content');
    const sha = sha256Hex(body);
    const kp = nacl.sign.keyPair();
    const responses = {
        '/start':  { status: 302, location: '/hop1' },
        '/hop1':   { status: 302, location: '/hop2' },
        '/hop2':   { status: 200, body },
    };
    const srv = await startServer(responses);
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    const result = await fetcher.fetchOne({
        id: 'r', url: `${srv.baseUrl}/start`,
        sha256: sha, signature: signWithKey(kp.secretKey, sha),
        arch: 'linux-x64', sizeBytes: body.length,
        fetchOn: 'install', extractTo: 'misc/',
    }, pubHex(kp));
    assert.equal(result.skipped, false);
});

test('fetchOne: too many redirects → fails', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    // 5 hops > MAX_REDIRECTS (3)
    const responses = {
        '/0': { status: 302, location: '/1' },
        '/1': { status: 302, location: '/2' },
        '/2': { status: 302, location: '/3' },
        '/3': { status: 302, location: '/4' },
        '/4': { status: 302, location: '/5' },
        '/5': { status: 200, body: Buffer.from('finally') },
    };
    const srv = await startServer(responses);
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'r', url: `${srv.baseUrl}/0`,
            sha256: 'a'.repeat(64), signature: 'b'.repeat(128),
            arch: 'linux-x64', sizeBytes: 100,
            fetchOn: 'install', extractTo: 'misc/',
        }, 'c'.repeat(64)),
        (err) => /too many redirects|HTTP 302/.test(err.message),
    );
});

// ---------------------------------------------------------------------------
// Atomic write — partial cleanup on failure
// ---------------------------------------------------------------------------

test('fetchOne: failed download leaves no .partial file behind', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const srv = await startServer({ '/x': { status: 500 } });
    t.after(() => srv.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'p', url: `${srv.baseUrl}/x`,
            sha256: 'a'.repeat(64), signature: 'b'.repeat(128),
            arch: 'linux-x64', sizeBytes: 1, fetchOn: 'install', extractTo: 'p/',
        }, 'c'.repeat(64)),
    );

    const pDir = join(dataDir, 'p');
    if (existsSync(pDir)) {
        const partials = readdirSync(pDir).filter(f => f.endsWith('.partial'));
        assert.equal(partials.length, 0, `expected no .partial files; got ${partials.join(',')}`);
    }
});

test('fetchOne: stale .partial from prior attempt is cleaned before retry', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('content');
    const sha = sha256Hex(body);
    const kp = nacl.sign.keyPair();
    const srv = await startServer({ '/x.tgz': { status: 200, body: await buildTarballBuffer({ 'a': 'x' }) } });
    t.after(() => srv.close());

    // Pre-plant a stale partial in the destination
    const extractDir = join(dataDir, 'misc');
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(join(extractDir, 'x.tgz.partial'), 'STALE_GARBAGE_FROM_PREVIOUS_RUN');

    const tarBuf = await buildTarballBuffer({ 'a': 'real-content' });
    const realSha = sha256Hex(tarBuf);

    // Stop the existing server, restart with the right body
    await srv.close();
    const srv2 = await startServer({ '/x.tgz': { status: 200, body: tarBuf } });
    t.after(() => srv2.close());

    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await fetcher.fetchOne({
        id: 's', url: `${srv2.baseUrl}/x.tgz`,
        sha256: realSha, signature: signWithKey(kp.secretKey, realSha),
        arch: 'linux-x64', sizeBytes: tarBuf.length,
        fetchOn: 'install', extractTo: 'misc/',
    }, pubHex(kp));

    // Stale .partial should be gone (or replaced); real file should be in place
    assert.ok(!existsSync(join(extractDir, 'x.tgz.partial')), 'stale .partial was not cleaned');
    assert.ok(existsSync(join(extractDir, 'a')), 'tarball should have extracted');
    assert.equal(readFileSync(join(extractDir, 'a'), 'utf8'), 'real-content');
});

// ---------------------------------------------------------------------------
// Constructor + input validation
// ---------------------------------------------------------------------------

test('ctor: throws without dataDir', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new AssetFetcher({}), { name: 'TypeError' });
});

test('fetchOne: rejects bad publisher key shape', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'k', url: 'https://nowhere.invalid/x',
            sha256: 'a'.repeat(64), signature: 'b'.repeat(128),
            arch: 'linux-x64', sizeBytes: 1, fetchOn: 'install', extractTo: 'p/',
        }, 'not-hex'),
        (err) => err.phase === 'preflight' && /publisherKeyHex/.test(err.message),
    );
});

test('fetchOne: rejects asset claiming sizeBytes above hard cap', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });
    await assert.rejects(
        () => fetcher.fetchOne({
            id: 'b', url: 'https://nowhere.invalid/x',
            sha256: 'a'.repeat(64), signature: 'b'.repeat(128),
            arch: 'linux-x64', sizeBytes: 10 * 1024 * 1024 * 1024,  // 10 GB
            fetchOn: 'install', extractTo: 'p/',
        }, 'c'.repeat(64)),
        (err) => err.phase === 'preflight' && /cap/.test(err.message),
    );
});

// ---------------------------------------------------------------------------
// fetchAll
// ---------------------------------------------------------------------------

test('fetchAll: iterates every asset; returns one result per asset (incl. skipped)', async (t) => {
    if (skipIfMissing(t)) return;
    const dataDir = makeDataDir(); t.after(() => cleanup(dataDir));
    const body = Buffer.from('content');
    const sha = sha256Hex(body);
    const kp = nacl.sign.keyPair();
    const srv = await startServer({ '/a.bin': { status: 200, body } });
    t.after(() => srv.close());
    const fetcher = new AssetFetcher({ dataDir, archResolver: () => 'linux-x64' });

    const results = await fetcher.fetchAll([
        { id: 'a', url: `${srv.baseUrl}/a.bin`, sha256: sha,
          signature: signWithKey(kp.secretKey, sha), arch: 'linux-x64',
          sizeBytes: body.length, fetchOn: 'install', extractTo: 'a/' },
        { id: 'b', url: 'https://nowhere.invalid/b', sha256: 'd'.repeat(64),
          signature: 'e'.repeat(128), arch: 'linux-arm64',
          sizeBytes: 1, fetchOn: 'install', extractTo: 'b/' },
    ], pubHex(kp));

    assert.equal(results.length, 2);
    assert.equal(results[0].skipped, false);
    assert.equal(results[1].skipped, true);
});
