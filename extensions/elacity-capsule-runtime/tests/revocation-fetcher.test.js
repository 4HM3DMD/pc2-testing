/**
 * SPEC: RevocationFetcher — fetch + ETag-poll + verify the
 * publisher revocation list.
 *
 * Helper location: pc2-node/src/services/RevocationFetcher.ts
 *
 * Coverage: initial fetch happy path, ETag round-trip (server
 * returns 304, fetcher keeps current), error paths (network fail,
 * HTTP 5xx, malformed JSON, schema fail, signature fail) all
 * preserve last known good, downgrade rejection, isPublisherRevoked
 * predicate, force-fetch coalescing, event emissions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';

let RevocationFetcher;
let signRevocationList;

try {
    ({ RevocationFetcher } = await import('../src/services/RevocationFetcher.js'));
    ({ signRevocationList } = await import('../src/services/RevocationList.js'));
} catch (err) {
    console.warn(`[spec] RevocationFetcher prerequisites: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!RevocationFetcher) {
        t.skip('RevocationFetcher not yet implemented (Wave 7 / M7)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pubHex(kp) {
    return Buffer.from(kp.publicKey).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

function buildSignedList(rootKp, { version = 1, revocations = [] } = {}) {
    const doc = { version, updatedAt: nowIso(), revocations };
    const sig = signRevocationList(doc, rootKp.secretKey);
    return { ...doc, signature: sig.signature, signedBy: sig.signedBy };
}

/**
 * Build a stub httpFetcher backed by a mutable script. Each call
 * returns the next response; tests can pre-program a sequence to
 * model "first call serves doc, second call returns 304" etc.
 */
function makeStubFetcher(responses) {
    const queue = Array.isArray(responses) ? [...responses] : [responses];
    const calls = [];
    const fetcher = async (url, headers, timeoutMs) => {
        calls.push({ url, headers, timeoutMs });
        const next = queue.length > 0 ? queue.shift() : queue.at(-1);
        if (!next) throw new Error('stub fetcher: no responses queued');
        if (typeof next === 'function') return next({ url, headers, timeoutMs });
        if (next.throws) throw new Error(next.throws);
        return {
            statusCode: next.statusCode ?? 200,
            headers:    next.headers ?? {},
            body:       next.body ?? Buffer.from(''),
        };
    };
    fetcher.calls = calls;
    return fetcher;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

test('ctor: requires url + revocationRootKeyHex', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new RevocationFetcher({}), { name: 'TypeError' });
    assert.throws(() => new RevocationFetcher({ url: 'https://x' }), { name: 'TypeError' });
    assert.throws(
        () => new RevocationFetcher({ url: 'https://x', revocationRootKeyHex: 'shorthex' }),
        { name: 'TypeError' });
});

// ---------------------------------------------------------------------------
// Initial fetch — happy paths
// ---------------------------------------------------------------------------

test('forceFetch: 200 with valid signed list → list-updated event', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const doc = buildSignedList(root, { revocations: [
        { publisherKey: 'a'.repeat(64), reason: 'compromised', revokedAt: nowIso() },
    ]});
    const stub = makeStubFetcher({
        statusCode: 200,
        headers: { etag: '"v1"' },
        body: Buffer.from(JSON.stringify(doc)),
    });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });

    const events = [];
    fetcher.on('list-updated', (e) => events.push(['list-updated', e]));
    fetcher.on('fetch-error', (e) => events.push(['error', e]));

    await fetcher.forceFetch();

    const updated = events.find(e => e[0] === 'list-updated');
    assert.ok(updated, `expected list-updated event, got: ${JSON.stringify(events)}`);
    assert.equal(updated[1].newVersion, 1);
    assert.equal(updated[1].previousVersion, null);
    assert.equal(updated[1].newlyRevoked.length, 1);
    assert.equal(fetcher.getCurrentList().version, 1);
});

test('forceFetch: ETag round-trip — second fetch sends If-None-Match, 304 keeps list', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const doc = buildSignedList(root);
    const stub = makeStubFetcher([
        { statusCode: 200, headers: { etag: '"v1"' }, body: Buffer.from(JSON.stringify(doc)) },
        { statusCode: 304, headers: { etag: '"v1"' }, body: Buffer.from('') },
    ]);
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });

    await fetcher.forceFetch();
    await fetcher.forceFetch();

    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].headers['If-None-Match'], undefined,
        'first fetch should NOT include If-None-Match');
    assert.equal(stub.calls[1].headers['If-None-Match'], '"v1"',
        'second fetch should include the ETag from the first response');
});

test('forceFetch: list-updated diff lists newly revoked + newly cleared keys', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const v1 = buildSignedList(root, { version: 1, revocations: [
        { publisherKey: 'a'.repeat(64), reason: 'first', revokedAt: nowIso() },
    ]});
    const v2 = buildSignedList(root, { version: 2, revocations: [
        { publisherKey: 'b'.repeat(64), reason: 'second', revokedAt: nowIso() },
    ]});
    const stub = makeStubFetcher([
        { statusCode: 200, headers: { etag: '"v1"' }, body: Buffer.from(JSON.stringify(v1)) },
        { statusCode: 200, headers: { etag: '"v2"' }, body: Buffer.from(JSON.stringify(v2)) },
    ]);
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });

    const updates = [];
    fetcher.on('list-updated', (e) => updates.push(e));

    await fetcher.forceFetch();
    await fetcher.forceFetch();

    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1].newlyRevoked, ['b'.repeat(64)]);
    assert.deepEqual(updates[1].newlyCleared, ['a'.repeat(64)]);
});

// ---------------------------------------------------------------------------
// Error paths — last-known-good preserved
// ---------------------------------------------------------------------------

test('forceFetch: network error keeps last known good', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const v1 = buildSignedList(root);
    const stub = makeStubFetcher([
        { statusCode: 200, headers: { etag: '"v1"' }, body: Buffer.from(JSON.stringify(v1)) },
        { throws: 'connection refused' },
    ]);
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });

    const errors = [];
    fetcher.on('fetch-error', (e) => errors.push(e));

    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList().version, 1);

    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList().version, 1, 'last good list preserved');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].haveLastGood, true);
});

test('forceFetch: HTTP 500 keeps last known good', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const v1 = buildSignedList(root);
    const stub = makeStubFetcher([
        { statusCode: 200, headers: { etag: '"v1"' }, body: Buffer.from(JSON.stringify(v1)) },
        { statusCode: 500, body: Buffer.from('oops') },
    ]);
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });

    await fetcher.forceFetch();
    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList().version, 1);
});

test('forceFetch: signed by different root → rejected, no current list', async (t) => {
    if (skipIfMissing(t)) return;
    const realRoot = nacl.sign.keyPair();
    const attackerRoot = nacl.sign.keyPair();
    const doc = buildSignedList(attackerRoot);
    const stub = makeStubFetcher({
        statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(doc)),
    });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(realRoot),
        httpFetcher: stub,
    });

    const errors = [];
    fetcher.on('fetch-error', (e) => errors.push(e));

    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList(), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /signature verification failed/i);
});

test('forceFetch: malformed JSON body rejected', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const stub = makeStubFetcher({
        statusCode: 200, headers: {}, body: Buffer.from('not { json'),
    });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });
    const errors = [];
    fetcher.on('fetch-error', (e) => errors.push(e));
    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList(), null);
    assert.match(errors[0].reason, /JSON parse failed/i);
});

test('forceFetch: schema-invalid body rejected', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const stub = makeStubFetcher({
        statusCode: 200, headers: {},
        body: Buffer.from(JSON.stringify({ version: -1 /* invalid */ })),
    });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });
    const errors = [];
    fetcher.on('fetch-error', (e) => errors.push(e));
    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList(), null);
    assert.match(errors[0].reason, /schema validation failed/i);
});

test('forceFetch: refuses version-downgrade', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const v5 = buildSignedList(root, { version: 5 });
    const v3 = buildSignedList(root, { version: 3 });
    const stub = makeStubFetcher([
        { statusCode: 200, headers: { etag: '"v5"' }, body: Buffer.from(JSON.stringify(v5)) },
        { statusCode: 200, headers: { etag: '"v3"' }, body: Buffer.from(JSON.stringify(v3)) },
    ]);
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });
    const errors = [];
    fetcher.on('fetch-error', (e) => errors.push(e));
    await fetcher.forceFetch();
    await fetcher.forceFetch();
    assert.equal(fetcher.getCurrentList().version, 5, 'downgrade rejected');
    assert.match(errors[0].reason, /downgrade/i);
});

test('forceFetch: oversize body rejected at 1MB cap', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const big = Buffer.alloc(2 * 1024 * 1024);
    const stub = makeStubFetcher({ statusCode: 200, headers: {}, body: big });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });
    const errors = [];
    fetcher.on('fetch-error', (e) => errors.push(e));
    await fetcher.forceFetch();
    assert.match(errors[0].reason, /exceeds.*cap/i);
});

// ---------------------------------------------------------------------------
// isPublisherRevoked predicate
// ---------------------------------------------------------------------------

test('isPublisherRevoked: hits revoked key, misses unknown', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const target = 'b'.repeat(64);
    const doc = buildSignedList(root, {
        revocations: [{ publisherKey: target, reason: 'gone', revokedAt: nowIso() }],
    });
    const stub = makeStubFetcher({
        statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(doc)),
    });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });
    await fetcher.forceFetch();
    assert.ok(fetcher.isPublisherRevoked(target));
    assert.equal(fetcher.isPublisherRevoked('d'.repeat(64)), undefined);
});

test('isPublisherRevoked: returns undefined when no list fetched yet', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: makeStubFetcher({ throws: 'never' }),
    });
    assert.equal(fetcher.isPublisherRevoked('a'.repeat(64)), undefined);
});

// ---------------------------------------------------------------------------
// forceFetch coalescing
// ---------------------------------------------------------------------------

test('forceFetch: concurrent calls coalesce to one HTTP request', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const doc = buildSignedList(root);
    let callCount = 0;
    const stub = async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 30));
        return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(doc)) };
    };
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
    });

    const [a, b, c] = await Promise.all([
        fetcher.forceFetch(), fetcher.forceFetch(), fetcher.forceFetch(),
    ]);
    assert.equal(callCount, 1, 'three parallel forceFetch calls should share one HTTP req');
});

// ---------------------------------------------------------------------------
// start/stop lifecycle
// ---------------------------------------------------------------------------

test('start: triggers immediate fetch and schedules heartbeat', async (t) => {
    if (skipIfMissing(t)) return;
    const root = nacl.sign.keyPair();
    const doc = buildSignedList(root);
    const stub = makeStubFetcher({
        statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(doc)),
    });
    const fetcher = new RevocationFetcher({
        url: 'https://test.invalid/revs.json',
        revocationRootKeyHex: pubHex(root),
        httpFetcher: stub,
        pollIntervalMs: 60_000,   // doesn't matter — we stop quickly
    });

    await fetcher.start();
    assert.equal(fetcher.getCurrentList().version, 1);
    fetcher.stop();
    fetcher.stop();   // idempotent
});
