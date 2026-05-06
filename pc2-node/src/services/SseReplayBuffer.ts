/**
 * SseReplayBuffer — per-topic ring buffer with monotonic IDs so SSE
 * clients reconnecting after a graceful restart (or any transient
 * disconnect) can replay missed events via the `Last-Event-ID`
 * header.
 *
 * Closes the A5 critique gap: PC2's existing SSE hub generates IDs
 * but doesn't honour `Last-Event-ID` on reconnect — every restart
 * silently loses events for connected clients. The full v0.3 drain
 * sequence broadcasts an "impending restart" warning over SSE, then
 * after PC2 comes back up, the browser's `EventSource` reconnects
 * with `Last-Event-ID: <last-id>` and this buffer replays whatever
 * the client missed.
 *
 * Design:
 *   - IDs are monotonic across ALL topics (one global counter).
 *     This lets a single Last-Event-ID disambiguate the boundary
 *     even when a client subscribes to multiple topics on one
 *     EventSource.
 *   - Per-topic cap (default 200 events) — bounds memory growth
 *     under high-frequency topics.
 *   - Total-bytes cap (default 10 MB) — bounds catastrophic memory
 *     growth across all topics combined; evicts oldest events
 *     globally (LRU by id) until under.
 *
 * Out of scope:
 *   - Persistence across restarts. The buffer is in-memory only.
 *     A client whose `Last-Event-ID` is older than the post-restart
 *     buffer's first id sees an empty replay (not a per-event
 *     "you missed N events" notice). Frontend can detect this gap
 *     by comparing the highest replayed id to the stored one.
 *   - Cross-PC2-instance fan-out. Single-process scope.
 */

const DEFAULT_MAX_EVENTS_PER_TOPIC = 200;
const DEFAULT_MAX_BYTES_TOTAL = 10 * 1024 * 1024;   // 10 MB

// =============================================================================
// Public types
// =============================================================================

export interface BufferedEvent {
    id: number;
    topic: string;
    payload: unknown;
    ts: number;
    /** Approximate JSON-serialised size of `payload`, in bytes. */
    bytes: number;
}

export interface SseReplayBufferOpts {
    maxEventsPerTopic?: number;
    maxBytesTotal?: number;
    /**
     * Optional clock override (returns ms since epoch). Tests inject
     * a controlled clock so timestamps are deterministic.
     */
    nowFn?: () => number;
}

export interface BufferStats {
    topics: number;
    events: number;
    bytes: number;
    nextId: number;
}

// =============================================================================
// Service
// =============================================================================

export class SseReplayBuffer {
    private readonly maxEventsPerTopic: number;
    private readonly maxBytesTotal: number;
    private readonly nowFn: () => number;

    private nextId = 1;
    private totalBytes = 0;
    /** topic → array of events, oldest first. */
    private readonly topics = new Map<string, BufferedEvent[]>();

    constructor(opts: SseReplayBufferOpts = {}) {
        const m = opts.maxEventsPerTopic ?? DEFAULT_MAX_EVENTS_PER_TOPIC;
        const b = opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
        if (!Number.isInteger(m) || m < 1) {
            throw new TypeError(`maxEventsPerTopic must be a positive integer; got ${m}`);
        }
        if (!Number.isInteger(b) || b < 1024) {
            throw new TypeError(`maxBytesTotal must be a positive integer ≥ 1024; got ${b}`);
        }
        this.maxEventsPerTopic = m;
        this.maxBytesTotal = b;
        this.nowFn = opts.nowFn ?? Date.now;
    }

    /**
     * Append an event to the buffer for `topic`. Returns the assigned
     * monotonic id and event metadata. Evicts oldest events if either
     * the per-topic cap or the global byte cap is exceeded.
     */
    publish(topic: string, payload: unknown): BufferedEvent {
        if (typeof topic !== 'string' || topic.length === 0) {
            throw new TypeError('topic must be a non-empty string');
        }
        const bytes = approxByteSize(payload);
        const event: BufferedEvent = {
            id: this.nextId++,
            topic,
            payload,
            ts: this.nowFn(),
            bytes,
        };
        const arr = this.topics.get(topic);
        if (arr) {
            arr.push(event);
            if (arr.length > this.maxEventsPerTopic) {
                const removed = arr.shift()!;
                this.totalBytes -= removed.bytes;
            }
        } else {
            this.topics.set(topic, [event]);
        }
        this.totalBytes += bytes;
        this.evictUntilUnderByteCap();
        return event;
    }

    /**
     * Return events for `topic` with id > sinceId. If sinceId is
     * undefined or < 0, returns the entire current buffer for the
     * topic.
     *
     * Does NOT mutate state — purely a read.
     */
    replay(topic: string, sinceId?: number): BufferedEvent[] {
        const arr = this.topics.get(topic);
        if (!arr || arr.length === 0) return [];
        if (sinceId === undefined || sinceId === null || sinceId < 0) {
            return arr.slice();
        }
        const cut = sinceId;
        // Common case: sinceId is below all events in the buffer →
        // return the whole array. Bail-fast on the head check.
        if (arr[0].id > cut) return arr.slice();
        // Linear scan — buffers are small (≤ maxEventsPerTopic). For
        // very large buffers we could binary-search by id, but that's
        // premature for v1.
        const out: BufferedEvent[] = [];
        for (const e of arr) {
            if (e.id > cut) out.push(e);
        }
        return out;
    }

    /**
     * Get the highest event id currently in the buffer for `topic`,
     * or 0 if the topic has no events.
     */
    headId(topic: string): number {
        const arr = this.topics.get(topic);
        if (!arr || arr.length === 0) return 0;
        return arr[arr.length - 1].id;
    }

    /** Snapshot of memory usage for monitoring + tests. */
    stats(): BufferStats {
        let events = 0;
        for (const arr of this.topics.values()) events += arr.length;
        return {
            topics: this.topics.size,
            events,
            bytes: this.totalBytes,
            nextId: this.nextId,
        };
    }

    /** Drop all events for one topic. Returns the number removed. */
    clearTopic(topic: string): number {
        const arr = this.topics.get(topic);
        if (!arr) return 0;
        const removed = arr.length;
        for (const e of arr) this.totalBytes -= e.bytes;
        this.topics.delete(topic);
        return removed;
    }

    /** Drop everything. Used at PC2 boot if persistence is added later. */
    clearAll(): void {
        this.topics.clear();
        this.totalBytes = 0;
    }

    // =========================================================================
    // Internals
    // =========================================================================

    /**
     * If totalBytes exceeds maxBytesTotal, evict the globally-oldest
     * event (lowest id across all topics) until under. Defends against
     * a single high-volume topic exhausting memory; cap on per-topic
     * size already bounds individual topics.
     */
    private evictUntilUnderByteCap(): void {
        while (this.totalBytes > this.maxBytesTotal) {
            // Find the topic whose head event has the lowest id.
            let minTopic: string | null = null;
            let minId = Infinity;
            for (const [topic, arr] of this.topics) {
                if (arr.length === 0) continue;
                if (arr[0].id < minId) {
                    minId = arr[0].id;
                    minTopic = topic;
                }
            }
            if (minTopic === null) break;   // shouldn't happen — defensive
            const arr = this.topics.get(minTopic)!;
            const removed = arr.shift()!;
            this.totalBytes -= removed.bytes;
            if (arr.length === 0) this.topics.delete(minTopic);
        }
    }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Approximate the JSON-serialised size of an event payload. Avoids
 * the cost of double-serialising (real JSON.stringify happens at
 * write time on the SSE wire). Good-enough for byte-cap accounting.
 */
function approxByteSize(payload: unknown): number {
    if (payload === null || payload === undefined) return 4;
    if (typeof payload === 'number') return 8;
    if (typeof payload === 'boolean') return 5;
    if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf-8') + 2;
    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf-8');
    } catch {
        return 64;   // fallback for circular refs etc.
    }
}
