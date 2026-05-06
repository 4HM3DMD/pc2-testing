/**
 * RevocationFetcher — fetch + ETag-poll the publisher revocation
 * list, hold the most recent verified copy in memory, expose a
 * predicate the install pipeline calls before each preview/install.
 *
 * Behaviour:
 *   - On start(), fetches immediately, then schedules hourly polls.
 *   - Each fetch sends `If-None-Match: <last ETag>`. 304 means
 *     keep the current list.
 *   - On 200, parses the body, validates the schema (M7
 *     RevocationList.validateRevocationDoc), verifies the
 *     signature against the configured revocation root pubkey
 *     (M7 RevocationList.verifyRevocationList).
 *   - On any failure (network, parse, signature) the fetcher
 *     KEEPS THE LAST KNOWN GOOD list. A bad supernode response
 *     never silently revokes nothing — operators stay protected
 *     by the last verified state until a fresh good list arrives.
 *   - Emits structured events for observability (fetched, verified,
 *     error, no-change). dApp Centre subscribes to render the
 *     "Publisher key revoked" red banner on update events.
 *
 * Trust note: the fetcher is stateless about what's revoked. It
 * just maintains the current verified list. The orchestrator
 * (M7-extended CapsuleInstallOrchestrator) does the actual
 * "is this publisher revoked?" check at install/preview time
 * by calling `getCurrentList()` then `isPublisherRevoked()`.
 *
 * What's deliberately omitted in v1:
 *   - Persistence across PC2 restarts. In-memory only. PC2 boots,
 *     fetches the list once, then heartbeats. A 1-hour blind spot
 *     between PC2 boot and the first successful fetch is acceptable
 *     because the install path will force-fetch before each install
 *     (so the operator can never approve a revoked publisher even
 *     in the blind spot, as long as the network reaches the
 *     revocations URL at install time).
 *   - Mesh / federation across multiple supernodes. v1 = one
 *     well-known URL. Federation lands once we have >1 publisher.
 *   - Operator override (manual revocation entries). v1 = trust
 *     ElacityLabs's revocation root only.
 */

import * as https from 'https';
import * as http from 'http';
import { EventEmitter } from 'events';

import {
    RevocationListDoc,
    RevocationEntry,
    validateRevocationDoc,
    verifyRevocationList,
    isPublisherRevoked as isRevokedInList,
} from './RevocationList.js';

const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000;   // 1 hour
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;            // 1 MB hard cap on revocation body

// =============================================================================
// Public types
// =============================================================================

export interface FetcherEvents {
    /** Emitted whenever a fetch attempt completes (success or failure). */
    'fetch-attempt': (info: FetchAttemptInfo) => void;
    /** Emitted when a fetched + verified list is INSTALLED as the current. */
    'list-updated': (info: ListUpdatedInfo) => void;
    /** Server returned 304 Not Modified — list unchanged, no event for "no diff". */
    'unchanged': (etag: string) => void;
    /** Hard error — keeping last known good. */
    'fetch-error': (info: FetchErrorInfo) => void;
}

export interface FetchAttemptInfo {
    url: string;
    durationMs: number;
    statusCode?: number;
    eTag?: string;
}

export interface ListUpdatedInfo {
    /** Previous version number (or null on first successful fetch). */
    previousVersion: number | null;
    newVersion: number;
    /** Publisher keys NEW in this version (added since the previous list). */
    newlyRevoked: string[];
    /** Publisher keys REMOVED in this version (un-revoked? rare; surfaced for audit). */
    newlyCleared: string[];
    /** Total revocations after the update. */
    totalRevoked: number;
}

export interface FetchErrorInfo {
    url: string;
    reason: string;
    /** Are we still serving a previous good list? */
    haveLastGood: boolean;
}

export interface RevocationFetcherOpts {
    /** Well-known URL to GET the revocation list from. */
    url: string;
    /** Hex pubkey of the trusted revocation root. */
    revocationRootKeyHex: string;
    /** Poll interval in ms (default 1 hour). */
    pollIntervalMs?: number;
    /** Per-fetch timeout in ms (default 30s). */
    fetchTimeoutMs?: number;
    /**
     * Override the http(s) request function. Tests inject a stub.
     * Default uses node:https for `https://` and node:http for `http://`.
     */
    httpFetcher?: HttpFetcher;
}

export type HttpFetcher = (
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
) => Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}>;

// =============================================================================
// Service
// =============================================================================

export class RevocationFetcher extends EventEmitter {
    private readonly url: string;
    private readonly revocationRootKey: string;
    private readonly pollIntervalMs: number;
    private readonly fetchTimeoutMs: number;
    private readonly httpFetcher: HttpFetcher;

    private currentList: RevocationListDoc | null = null;
    private currentETag: string | undefined = undefined;
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<void> | null = null;

    constructor(opts: RevocationFetcherOpts) {
        super();
        if (!opts || typeof opts.url !== 'string' || opts.url.length === 0) {
            throw new TypeError('RevocationFetcher: { url } required');
        }
        if (typeof opts.revocationRootKeyHex !== 'string'
            || !/^[0-9a-fA-F]{64}$/.test(opts.revocationRootKeyHex)) {
            throw new TypeError(
                'RevocationFetcher: { revocationRootKeyHex } must be 64 hex chars');
        }
        this.url = opts.url;
        this.revocationRootKey = opts.revocationRootKeyHex.toLowerCase();
        this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
        this.httpFetcher = opts.httpFetcher ?? defaultHttpFetcher;
    }

    /**
     * Start the heartbeat. Triggers an immediate fetch then schedules
     * subsequent fetches at pollIntervalMs. Idempotent — if already
     * started, this is a no-op.
     *
     * Returns the immediate first-fetch promise so callers can `await`
     * it for "PC2 boot is ready to install capsules" sequencing.
     */
    async start(): Promise<void> {
        if (this.timer) return;   // already running
        this.timer = setInterval(() => {
            this.fetchOnce().catch(() => { /* swallow — emit handles surfacing */ });
        }, this.pollIntervalMs);
        // Don't keep the process alive just for the heartbeat.
        if (typeof this.timer.unref === 'function') this.timer.unref();
        await this.fetchOnce();
    }

    /** Stop the heartbeat. Safe to call multiple times. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Force an out-of-band fetch — used by the install pipeline to
     * defeat the blind spot between hourly heartbeats. Coalesced:
     * a fetch in flight is shared with subsequent callers.
     */
    async forceFetch(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.fetchOnce();
        try {
            await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    /**
     * Return the current verified revocation list, or null if none
     * has been fetched yet. dApp Centre + the install pipeline call
     * this every time they need to make a trust decision.
     */
    getCurrentList(): RevocationListDoc | null {
        return this.currentList;
    }

    /**
     * Predicate: is the given publisher key revoked according to the
     * current verified list? Returns the revocation entry on hit,
     * undefined on miss or when no list has been fetched yet.
     *
     * Caller pattern:
     *   const r = fetcher.isPublisherRevoked(signedBy);
     *   if (r) showRedBanner(r.reason);
     */
    isPublisherRevoked(publisherKeyHex: string): RevocationEntry | undefined {
        if (!this.currentList) return undefined;
        return isRevokedInList(this.currentList, publisherKeyHex);
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private async fetchOnce(): Promise<void> {
        const start = Date.now();
        const headers: Record<string, string> = {
            'User-Agent': 'pc2-revocation-fetcher/0.3',
            'Accept':     'application/json',
        };
        if (this.currentETag) {
            headers['If-None-Match'] = this.currentETag;
        }

        let res;
        try {
            res = await this.httpFetcher(this.url, headers, this.fetchTimeoutMs);
        } catch (err) {
            const e = err as Error;
            this.emit('fetch-attempt', { url: this.url, durationMs: Date.now() - start });
            this.emit('fetch-error', {
                url: this.url,
                reason: `fetch failed: ${e.message}`,
                haveLastGood: this.currentList !== null,
            });
            return;
        }

        const eTag = headerString(res.headers['etag']);

        if (res.statusCode === 304) {
            // Server confirmed list hasn't changed — keep what we have.
            this.emit('fetch-attempt', { url: this.url, durationMs: Date.now() - start, statusCode: 304, eTag });
            this.emit('unchanged', this.currentETag ?? '');
            return;
        }

        if (res.statusCode !== 200) {
            this.emit('fetch-attempt', { url: this.url, durationMs: Date.now() - start, statusCode: res.statusCode });
            this.emit('fetch-error', {
                url: this.url,
                reason: `HTTP ${res.statusCode}`,
                haveLastGood: this.currentList !== null,
            });
            return;
        }

        if (res.body.length > MAX_BODY_BYTES) {
            this.emit('fetch-error', {
                url: this.url,
                reason: `body ${res.body.length} bytes exceeds ${MAX_BODY_BYTES} cap (DoS guard)`,
                haveLastGood: this.currentList !== null,
            });
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(res.body.toString('utf-8'));
        } catch (err) {
            const e = err as Error;
            this.emit('fetch-error', {
                url: this.url,
                reason: `JSON parse failed: ${e.message}`,
                haveLastGood: this.currentList !== null,
            });
            return;
        }

        let validated: RevocationListDoc;
        try {
            validated = validateRevocationDoc(parsed);
        } catch (err) {
            const e = err as Error;
            this.emit('fetch-error', {
                url: this.url,
                reason: `schema validation failed: ${e.message}`,
                haveLastGood: this.currentList !== null,
            });
            return;
        }

        const verify = verifyRevocationList(validated, this.revocationRootKey);
        if (!verify.valid) {
            this.emit('fetch-error', {
                url: this.url,
                reason: `signature verification failed: ${verify.reason}`,
                haveLastGood: this.currentList !== null,
            });
            return;
        }

        // Defence-in-depth: refuse downgrades. A signed older list could
        // be replayed by an attacker who once had the root key. Not a
        // strong defence (the root ALSO signed the older list) but
        // makes a confused-deputy supernode setup less dangerous.
        if (this.currentList && validated.version < this.currentList.version) {
            this.emit('fetch-error', {
                url: this.url,
                reason: `received version ${validated.version} < current ${this.currentList.version}; rejecting downgrade`,
                haveLastGood: true,
            });
            return;
        }

        const previousVersion = this.currentList?.version ?? null;
        const previousKeys = new Set((this.currentList?.revocations ?? []).map(e => e.publisherKey.toLowerCase()));
        const newKeys = new Set(validated.revocations.map(e => e.publisherKey.toLowerCase()));
        const newlyRevoked = Array.from(newKeys).filter(k => !previousKeys.has(k));
        const newlyCleared = Array.from(previousKeys).filter(k => !newKeys.has(k));

        this.currentList = validated;
        this.currentETag = eTag;
        this.emit('fetch-attempt', { url: this.url, durationMs: Date.now() - start, statusCode: 200, eTag });
        this.emit('list-updated', {
            previousVersion,
            newVersion: validated.version,
            newlyRevoked,
            newlyCleared,
            totalRevoked: validated.revocations.length,
        });
    }
}

// =============================================================================
// Default HTTP fetcher
// =============================================================================

const defaultHttpFetcher: HttpFetcher = (url, headers, timeoutMs) => {
    return new Promise((resolveP, rejectP) => {
        let parsed: URL;
        try { parsed = new URL(url); }
        catch (err) { rejectP(new Error(`invalid URL: ${url}`)); return; }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            rejectP(new Error(`unsupported protocol: ${parsed.protocol}`));
            return;
        }
        const driver = parsed.protocol === 'https:' ? https : http;
        const req = driver.request({
            hostname: parsed.hostname,
            port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method:   'GET',
            timeout:  timeoutMs,
            headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (c: Buffer) => {
                total += c.length;
                if (total > MAX_BODY_BYTES + 1024) {
                    res.destroy(new Error(`body exceeded ${MAX_BODY_BYTES} cap`));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => {
                resolveP({
                    statusCode: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
            res.on('error', rejectP);
        });
        req.on('error', rejectP);
        req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
        req.end();
    });
};

function headerString(v: string | string[] | undefined): string | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
}
