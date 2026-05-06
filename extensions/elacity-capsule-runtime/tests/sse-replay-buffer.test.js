/**
 * SPEC: SseReplayBuffer — per-topic ring buffer with monotonic IDs
 * for SSE Last-Event-ID replay.
 *
 * Coverage: publish/replay round-trip, monotonic IDs across topics,
 * sinceId filtering, per-topic cap, total-bytes cap with cross-topic
 * eviction, multi-topic independence, stats accuracy, clearTopic +
 * clearAll, constructor validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../src/services/SseReplayBuffer.js';
let SseReplayBuffer;

try {
    ({ SseReplayBuffer } = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] SseReplayBuffer not yet implemented: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!SseReplayBuffer) {
        t.skip('SseReplayBuffer not yet implemented (Wave 7 / M9)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Publish + replay basics
// ---------------------------------------------------------------------------

test('publish: assigns monotonic ids starting at 1', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    const e1 = buf.publish('chains:mainchain:logs', { line: 'hello' });
    const e2 = buf.publish('chains:mainchain:logs', { line: 'world' });
    assert.equal(e1.id, 1);
    assert.equal(e2.id, 2);
});

test('publish: ids are monotonic ACROSS topics', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    const a = buf.publish('topic-a', { x: 1 });
    const b = buf.publish('topic-b', { x: 2 });
    const c = buf.publish('topic-a', { x: 3 });
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(c.id, 3);
});

test('replay: returns all events when sinceId is undefined', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic', { n: 1 });
    buf.publish('topic', { n: 2 });
    const replayed = buf.replay('topic');
    assert.equal(replayed.length, 2);
    assert.equal(replayed[0].payload.n, 1);
});

test('replay: returns events with id > sinceId', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic', { n: 1 });
    const second = buf.publish('topic', { n: 2 });
    buf.publish('topic', { n: 3 });
    const replayed = buf.replay('topic', second.id);
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].payload.n, 3);
});

test('replay: returns empty when sinceId is at head', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic', { n: 1 });
    const second = buf.publish('topic', { n: 2 });
    assert.deepEqual(buf.replay('topic', second.id), []);
});

test('replay: returns empty for unknown topic', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic-a', { n: 1 });
    assert.deepEqual(buf.replay('topic-b'), []);
});

test('replay: sinceId < first event returns full buffer', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic', { n: 1 });
    buf.publish('topic', { n: 2 });
    assert.equal(buf.replay('topic', 0).length, 2);
    assert.equal(buf.replay('topic', -1).length, 2);
});

test('replay: does NOT mutate buffer state', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic', { n: 1 });
    buf.publish('topic', { n: 2 });
    buf.replay('topic');
    buf.replay('topic', 1);
    assert.equal(buf.stats().events, 2, 'replay should be a pure read');
});

// ---------------------------------------------------------------------------
// Per-topic cap
// ---------------------------------------------------------------------------

test('cap: per-topic cap evicts oldest in FIFO order', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer({ maxEventsPerTopic: 3 });
    buf.publish('topic', { n: 1 });
    buf.publish('topic', { n: 2 });
    buf.publish('topic', { n: 3 });
    buf.publish('topic', { n: 4 });   // pushes out n:1
    const replayed = buf.replay('topic');
    assert.equal(replayed.length, 3);
    assert.deepEqual(replayed.map(e => e.payload.n), [2, 3, 4]);
});

test('cap: per-topic cap is independent per topic', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer({ maxEventsPerTopic: 2 });
    buf.publish('a', { x: 1 });
    buf.publish('a', { x: 2 });
    buf.publish('a', { x: 3 });   // evicts a's x:1
    buf.publish('b', { y: 1 });
    buf.publish('b', { y: 2 });   // b not capped yet
    assert.equal(buf.replay('a').length, 2);
    assert.equal(buf.replay('b').length, 2);
});

// ---------------------------------------------------------------------------
// Total-bytes cap (cross-topic eviction)
// ---------------------------------------------------------------------------

test('cap: total-bytes cap evicts globally-oldest across all topics', (t) => {
    if (skipIfMissing(t)) return;
    // Tight byte cap so we can force eviction with small payloads.
    // Each `Hello world!` (12 bytes + 2 quotes = 14) exceeds the
    // 30-byte cap after a couple of writes.
    const buf = new SseReplayBuffer({ maxBytesTotal: 1024, maxEventsPerTopic: 100 });
    // Push a big payload to topic-a, then to topic-b, then more to a.
    // The byte cap should evict the oldest globally.
    const big = 'X'.repeat(500);
    buf.publish('topic-a', big);
    buf.publish('topic-b', big);
    buf.publish('topic-a', big);    // should evict topic-a's first event (oldest id)
    assert.equal(buf.replay('topic-a').length, 1, 'topic-a should have 1 event after eviction');
    assert.equal(buf.replay('topic-b').length, 1, 'topic-b should still have its event');
});

test('cap: byte-cap eviction removes empty topics from the map', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer({ maxBytesTotal: 1024, maxEventsPerTopic: 100 });
    const big = 'X'.repeat(800);
    buf.publish('temp-topic', big);
    buf.publish('persistent', big);
    buf.publish('persistent', big);   // evicts temp-topic's only event
    assert.equal(buf.stats().topics, 1, 'empty topic should be removed from map');
    assert.deepEqual(buf.replay('temp-topic'), []);
});

// ---------------------------------------------------------------------------
// Stats + headId + clear
// ---------------------------------------------------------------------------

test('stats: tracks topics + events + bytes + nextId', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    assert.deepEqual(buf.stats(), { topics: 0, events: 0, bytes: 0, nextId: 1 });
    buf.publish('a', { x: 1 });
    buf.publish('b', { y: 2 });
    const stats = buf.stats();
    assert.equal(stats.topics, 2);
    assert.equal(stats.events, 2);
    assert.ok(stats.bytes > 0);
    assert.equal(stats.nextId, 3);
});

test('headId: returns highest id for topic, 0 for empty', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    assert.equal(buf.headId('nope'), 0);
    buf.publish('topic', { n: 1 });
    const e2 = buf.publish('topic', { n: 2 });
    assert.equal(buf.headId('topic'), e2.id);
});

test('clearTopic: removes only that topic', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('a', { x: 1 });
    buf.publish('b', { y: 2 });
    const removed = buf.clearTopic('a');
    assert.equal(removed, 1);
    assert.deepEqual(buf.replay('a'), []);
    assert.equal(buf.replay('b').length, 1);
});

test('clearTopic: returns 0 for unknown topic', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    assert.equal(buf.clearTopic('nope'), 0);
});

test('clearAll: drops every topic + bytes back to 0', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('a', { x: 1 });
    buf.publish('b', { y: 2 });
    buf.clearAll();
    assert.deepEqual(buf.stats(), { topics: 0, events: 0, bytes: 0, nextId: 3 });
});

test('clearAll: nextId is preserved (replay never resurrects an old id)', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    buf.publish('topic', { n: 1 });
    buf.publish('topic', { n: 2 });
    buf.clearAll();
    const next = buf.publish('topic', { n: 3 });
    assert.ok(next.id > 2, `expected new id > 2, got ${next.id}`);
});

// ---------------------------------------------------------------------------
// Event metadata
// ---------------------------------------------------------------------------

test('publish: event has topic + payload + ts + bytes + id', (t) => {
    if (skipIfMissing(t)) return;
    const fixedTs = 1700000000000;
    const buf = new SseReplayBuffer({ nowFn: () => fixedTs });
    const e = buf.publish('topic', { hello: 'world' });
    assert.equal(e.topic, 'topic');
    assert.deepEqual(e.payload, { hello: 'world' });
    assert.equal(e.ts, fixedTs);
    assert.ok(e.bytes > 0);
    assert.equal(e.id, 1);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test('ctor: rejects non-positive maxEventsPerTopic', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new SseReplayBuffer({ maxEventsPerTopic: 0 }), { name: 'TypeError' });
    assert.throws(() => new SseReplayBuffer({ maxEventsPerTopic: -5 }), { name: 'TypeError' });
    assert.throws(() => new SseReplayBuffer({ maxEventsPerTopic: 1.5 }), { name: 'TypeError' });
});

test('ctor: rejects unreasonably small maxBytesTotal', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => new SseReplayBuffer({ maxBytesTotal: 100 }), { name: 'TypeError' });
});

test('publish: rejects empty topic', (t) => {
    if (skipIfMissing(t)) return;
    const buf = new SseReplayBuffer();
    assert.throws(() => buf.publish('', { x: 1 }), { name: 'TypeError' });
});
