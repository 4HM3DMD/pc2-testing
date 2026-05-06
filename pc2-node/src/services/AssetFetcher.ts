/**
 * AssetFetcher — fetch + verify + extract `manifest.assets[]` entries.
 *
 * Hybrid capsules keep their bundle small (under the 100 MB cap) by
 * declaring large binaries (e.g. the `ela` mainchain executable) as
 * separate `assets[]` fetched post-install. Each asset carries its own
 * sha256 + Ed25519 signature, chained from the manifest signature
 * (whose `signedBy` is the publisher key passed in here).
 *
 * Trust model — same as the manifest: publisher signature is the
 * boundary. PC2 does NOT trust the asset URL or its mirrors; an
 * attacker who controls a mirror can serve different bytes, but those
 * bytes won't sha256-match (and even if they did, won't Ed25519-verify
 * against the publisher's public key).
 *
 * Per-asset workflow:
 *   1. Skip if asset.arch doesn't match the host (e.g. arm64 asset on
 *      x64 box) — that's not a failure, just "not for this machine"
 *   2. Try primary URL, then each mirror in order
 *   3. Stream download to `<extractTo>/<basename>.partial` to defend
 *      against half-written files (Phase 5 atomic-write pattern)
 *   4. SHA-256 the streamed bytes; reject if mismatch (try next URL)
 *   5. Ed25519-verify signature against publisher key (hard-fail; a
 *      sig mismatch on bytes whose sha256 matched is an active attack
 *      worth surfacing, not retrying)
 *   6. If filename indicates a tarball (.tgz / .tar.gz), extract into
 *      `extractTo`. Otherwise write the single file there with its
 *      URL basename
 *   7. Always sweep the .partial on exit (success or failure)
 *
 * Out of scope for M4:
 *   - IPFS fetches (`ipfs://` mirrors are recognised but skipped — M7
 *     wires the Helia bridge once the registry surface is final)
 *   - Resume across restarts (.partial is per-attempt, not persistent)
 *   - Quota enforcement (asset.sizeBytes is checked against the cap
 *     and against actual download size, but no operator-set quota)
 */

import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { join, basename, resolve, dirname } from 'path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import nacl from 'tweetnacl';
import * as tar from 'tar';

import type { CapsuleAsset } from './CapsuleManifest.js';

// =============================================================================
// Constants + types
// =============================================================================

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min per asset attempt
const MAX_REDIRECTS = 3;
const MAX_BYTES_PER_ASSET = 500 * 1024 * 1024;      // 500 MB hard cap on any single asset
const TAR_EXTENSIONS = ['.tgz', '.tar.gz', '.tar'];

export type FetchPhase =
    | 'preflight'
    | 'connecting'
    | 'downloading'
    | 'hashing'
    | 'verifying-signature'
    | 'extracting'
    | 'committing'
    | 'done'
    | 'skipped';

export interface FetchProgress {
    (event: ProgressEvent): void;
}

export interface ProgressEvent {
    assetId: string;
    phase: FetchPhase;
    /** Bytes downloaded so far (this attempt). */
    bytesReceived?: number;
    /** Total bytes expected (Content-Length, if server gave one). */
    totalBytes?: number;
    /** Which mirror is being tried (`url` for primary, mirrors[N] for fallback). */
    source?: string;
    /** Failure detail when phase is on a retry path. */
    note?: string;
}

export interface FetchResult {
    assetId: string;
    /** Final on-disk location: tarball-extracted dir or single-file path. */
    extractedTo: string;
    /** Bytes actually downloaded (compressed; pre-extract for tarballs). */
    downloadedBytes: number;
    /** Which URL succeeded — primary or mirror N. */
    sourceUsed: string;
    /** True if this asset was skipped because asset.arch didn't match. */
    skipped: boolean;
    /** Reason for skip (when applicable). */
    skipReason?: string;
}

export class AssetFetchError extends Error {
    public readonly assetId: string;
    public readonly phase: FetchPhase;
    constructor(assetId: string, phase: FetchPhase, message: string) {
        super(`[asset:${assetId}][${phase}] ${message}`);
        this.name = 'AssetFetchError';
        this.assetId = assetId;
        this.phase = phase;
    }
}

// =============================================================================
// Service
// =============================================================================

export interface AssetFetcherOpts {
    /** PC2 data root — extractTo paths resolve against this. */
    dataDir: string;
    /** Per-attempt connect timeout (ms). */
    connectTimeoutMs?: number;
    /** Per-attempt total request timeout (ms). */
    requestTimeoutMs?: number;
    /**
     * Override for arch detection. Tests inject a fixed value so they
     * don't depend on the host's actual platform. Default uses
     * `${os.platform()}-${os.arch()}` mapped to the same convention
     * the manifest uses (linux-x64, linux-arm64).
     */
    archResolver?: () => string;
    /**
     * Inject the HTTP(S) request function. Lets tests use http (no
     * TLS) instead of https. Default uses node:https for `https://`
     * URLs and node:http for `http://` (test-only).
     */
    httpFetcher?: HttpFetcher;
}

export type HttpFetcher = (
    url: string,
    opts: { timeoutMs: number },
) => Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; stream: Readable; }>;

export class AssetFetcher {
    private readonly dataDir: string;
    private readonly connectTimeoutMs: number;
    private readonly requestTimeoutMs: number;
    private readonly archResolver: () => string;
    private readonly httpFetcher: HttpFetcher;

    constructor(opts: AssetFetcherOpts) {
        if (!opts || !opts.dataDir) {
            throw new TypeError('AssetFetcher: { dataDir } required');
        }
        this.dataDir = resolve(opts.dataDir);
        this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.archResolver = opts.archResolver ?? defaultArchResolver;
        this.httpFetcher = opts.httpFetcher ?? defaultHttpFetcher;
    }

    /**
     * Fetch every asset whose arch matches the host. Returns one
     * `FetchResult` per asset (including ones marked `skipped: true`
     * for arch mismatch).
     *
     * Stops on the FIRST hard failure — partial state from earlier
     * successful assets is left on disk because the install flow
     * (CapsuleInstaller has already committed the app + backend dirs)
     * handles rollback at a higher level.
     */
    async fetchAll(
        assets: CapsuleAsset[],
        publisherKeyHex: string,
        onProgress?: FetchProgress,
    ): Promise<FetchResult[]> {
        const out: FetchResult[] = [];
        for (const asset of assets) {
            out.push(await this.fetchOne(asset, publisherKeyHex, onProgress));
        }
        return out;
    }

    /**
     * Fetch + verify + extract a single asset. See module header for
     * the per-step flow. Throws `AssetFetchError` (with phase + assetId)
     * on hard failure; returns `{skipped: true}` for arch mismatch.
     */
    async fetchOne(
        asset: CapsuleAsset,
        publisherKeyHex: string,
        onProgress?: FetchProgress,
    ): Promise<FetchResult> {
        this.validateInputs(asset, publisherKeyHex);

        // Arch gate — not a failure, just "not for this host"
        const hostArch = this.archResolver();
        if (asset.arch !== hostArch) {
            this.emit(onProgress, {
                assetId: asset.id, phase: 'skipped',
                note: `arch mismatch (asset=${asset.arch}, host=${hostArch})`,
            });
            return {
                assetId: asset.id, extractedTo: '', downloadedBytes: 0, sourceUsed: '',
                skipped: true,
                skipReason: `host arch ${hostArch} does not match asset arch ${asset.arch}`,
            };
        }

        // Resolve destination
        const extractToAbs = resolve(this.dataDir, asset.extractTo);
        if (!existsSync(extractToAbs)) {
            mkdirSync(extractToAbs, { recursive: true, mode: 0o700 });
        }

        // Build the source list: primary first, then mirrors. Skip ipfs://
        // mirrors in v1 — they need the Helia bridge from M7.
        const sources: string[] = [asset.url];
        if (asset.mirrors) {
            for (const m of asset.mirrors) {
                if (m.startsWith('https://') || m.startsWith('http://')) {
                    sources.push(m);
                }
            }
        }

        // Per-source attempt with sha256 retry on the next mirror.
        // Signature failure on bytes that sha256-matched is hard-fail
        // (active attack, not a transport hiccup).
        const failures: string[] = [];
        for (const source of sources) {
            try {
                const result = await this.attemptFetch(asset, publisherKeyHex, source, extractToAbs, onProgress);
                this.emit(onProgress, { assetId: asset.id, phase: 'done', source });
                return result;
            } catch (err) {
                const e = err as AssetFetchError | Error;
                failures.push(`${source}: ${e.message}`);
                // Hard-fail on signature mismatch — DON'T try mirrors.
                if ((e as AssetFetchError).phase === 'verifying-signature') {
                    throw new AssetFetchError(asset.id, 'verifying-signature',
                        `signature INVALID for sha256-matching bytes from ${source} ` +
                        `(active tamper or wrong publisher key); refusing to try mirrors`);
                }
                // Otherwise (sha256 mismatch, network error, http 5xx, timeout),
                // try the next source.
                this.emit(onProgress, {
                    assetId: asset.id, phase: 'connecting', source,
                    note: `attempt failed: ${e.message}; trying next source`,
                });
            }
        }

        throw new AssetFetchError(asset.id, 'preflight',
            `all ${sources.length} source(s) failed:\n  ` + failures.join('\n  '));
    }

    // =========================================================================
    // Per-attempt internals
    // =========================================================================

    private async attemptFetch(
        asset: CapsuleAsset,
        publisherKeyHex: string,
        source: string,
        extractToAbs: string,
        onProgress?: FetchProgress,
    ): Promise<FetchResult> {
        const partialPath = join(extractToAbs, basename(source) + '.partial');
        const finalSingleFilePath = join(extractToAbs, basename(source));

        // Pre-clean any stale .partial from a previous failed attempt.
        try { rmSync(partialPath, { force: true }); } catch { /* ignore */ }

        try {
            this.emit(onProgress, { assetId: asset.id, phase: 'connecting', source });

            const downloadResult = await this.downloadWithRedirects(
                source, partialPath, asset, onProgress,
            );

            this.emit(onProgress, { assetId: asset.id, phase: 'hashing', source });
            if (downloadResult.sha256 !== asset.sha256.toLowerCase()) {
                throw new AssetFetchError(asset.id, 'hashing',
                    `sha256 mismatch: declared ${asset.sha256.slice(0, 12)}…, ` +
                    `got ${downloadResult.sha256.slice(0, 12)}…`);
            }

            this.emit(onProgress, { assetId: asset.id, phase: 'verifying-signature', source });
            verifyAssetSignature(asset, publisherKeyHex);

            // Decide: extract (tarball) or single-file rename
            let extractedTo: string;
            if (looksLikeTarball(source)) {
                this.emit(onProgress, { assetId: asset.id, phase: 'extracting', source });
                await extractTarballAtomically(partialPath, extractToAbs, asset.id);
                extractedTo = extractToAbs;
                rmSync(partialPath, { force: true });
            } else {
                this.emit(onProgress, { assetId: asset.id, phase: 'committing', source });
                renameSync(partialPath, finalSingleFilePath);
                extractedTo = finalSingleFilePath;
            }

            return {
                assetId: asset.id,
                extractedTo,
                downloadedBytes: downloadResult.bytes,
                sourceUsed: source,
                skipped: false,
            };
        } catch (err) {
            // Clean partial on any failure
            try { rmSync(partialPath, { force: true }); } catch { /* ignore */ }
            throw err;
        }
    }

    /**
     * Stream a URL to disk, computing sha256 in the same pass. Follows
     * up to MAX_REDIRECTS hops. Caps total bytes at MAX_BYTES_PER_ASSET
     * to defend against a malicious server feeding an infinite stream.
     */
    private async downloadWithRedirects(
        url: string,
        destPath: string,
        asset: CapsuleAsset,
        onProgress?: FetchProgress,
    ): Promise<{ sha256: string; bytes: number }> {
        let currentUrl = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const res = await this.httpFetcher(currentUrl, { timeoutMs: this.requestTimeoutMs });
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const loc = Array.isArray(res.headers.location)
                    ? res.headers.location[0] : res.headers.location;
                if (typeof loc !== 'string') {
                    throw new AssetFetchError(asset.id, 'connecting',
                        `${currentUrl} → redirect with non-string Location`);
                }
                currentUrl = new URL(loc, currentUrl).toString();
                continue;
            }
            if (res.statusCode !== 200) {
                throw new AssetFetchError(asset.id, 'connecting',
                    `${currentUrl} → HTTP ${res.statusCode}`);
            }

            const totalBytes = parseInt(asArrayHeader(res.headers['content-length'])[0] ?? '0', 10) || undefined;
            const hash = createHash('sha256');
            let bytesReceived = 0;

            const writeStream = createWriteStream(destPath, { mode: 0o600 });
            const stream = res.stream;
            stream.on('data', (chunk: Buffer) => {
                bytesReceived += chunk.length;
                if (bytesReceived > MAX_BYTES_PER_ASSET) {
                    stream.destroy(new Error(
                        `asset exceeded ${MAX_BYTES_PER_ASSET} hard cap`));
                    return;
                }
                hash.update(chunk);
                if (onProgress) {
                    onProgress({ assetId: asset.id, phase: 'downloading',
                        bytesReceived, totalBytes, source: currentUrl });
                }
            });

            try {
                await pipeline(stream, writeStream);
            } catch (err) {
                const e = err as Error;
                throw new AssetFetchError(asset.id, 'downloading',
                    `download interrupted: ${e.message}`);
            }

            // Sanity: declared sizeBytes vs actual. Allow modest overshoot
            // (Content-Length isn't always exact across compression layers)
            // but reject obvious mismatches.
            if (asset.sizeBytes && bytesReceived > 0 && Math.abs(bytesReceived - asset.sizeBytes) > 1024 * 1024) {
                throw new AssetFetchError(asset.id, 'downloading',
                    `downloaded ${bytesReceived} bytes, manifest declared ${asset.sizeBytes} ` +
                    `(>1MB delta — possible MITM / wrong file)`);
            }

            return { sha256: hash.digest('hex'), bytes: bytesReceived };
        }
        throw new AssetFetchError(asset.id, 'connecting',
            `too many redirects (>${MAX_REDIRECTS}) starting at ${url}`);
    }

    private validateInputs(asset: CapsuleAsset, publisherKeyHex: string): void {
        if (!asset || typeof asset.id !== 'string') {
            throw new AssetFetchError(asset?.id ?? '?', 'preflight', 'asset is missing or has no id');
        }
        if (!/^[0-9a-fA-F]{64}$/.test(publisherKeyHex)) {
            throw new AssetFetchError(asset.id, 'preflight',
                `publisherKeyHex must be 64 hex chars; got length ${publisherKeyHex?.length}`);
        }
        if (asset.sizeBytes > MAX_BYTES_PER_ASSET) {
            throw new AssetFetchError(asset.id, 'preflight',
                `declared sizeBytes ${asset.sizeBytes} exceeds ${MAX_BYTES_PER_ASSET} cap`);
        }
    }

    private emit(cb: FetchProgress | undefined, event: ProgressEvent): void {
        if (!cb) return;
        try { cb(event); } catch { /* swallow */ }
    }
}

// =============================================================================
// Pure helpers (exported for unit tests)
// =============================================================================

export function defaultArchResolver(): string {
    const p = os.platform();   // 'linux' | 'darwin' | 'win32' | ...
    const a = os.arch();       // 'x64' | 'arm64' | 'arm' | ...
    return `${p}-${a}`;
}

export function looksLikeTarball(urlOrPath: string): boolean {
    const lower = urlOrPath.toLowerCase();
    return TAR_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Verify the asset's Ed25519 signature against the publisher pubkey.
 * The signature is over the SHA-256 bytes of the asset content (NOT
 * over the manifest). Throws AssetFetchError on any failure.
 */
export function verifyAssetSignature(asset: CapsuleAsset, publisherKeyHex: string): void {
    let pubKey: Buffer;
    let sig: Buffer;
    let digest: Buffer;
    try {
        pubKey = Buffer.from(publisherKeyHex, 'hex');
        sig = Buffer.from(asset.signature, 'hex');
        digest = Buffer.from(asset.sha256, 'hex');
    } catch (err) {
        const e = err as Error;
        throw new AssetFetchError(asset.id, 'verifying-signature',
            `hex decoding failed: ${e.message}`);
    }
    if (pubKey.length !== nacl.sign.publicKeyLength) {
        throw new AssetFetchError(asset.id, 'verifying-signature',
            `publisher key length ${pubKey.length}, expected ${nacl.sign.publicKeyLength}`);
    }
    if (sig.length !== nacl.sign.signatureLength) {
        throw new AssetFetchError(asset.id, 'verifying-signature',
            `signature length ${sig.length}, expected ${nacl.sign.signatureLength}`);
    }
    if (digest.length !== 32) {
        throw new AssetFetchError(asset.id, 'verifying-signature',
            `sha256 length ${digest.length}, expected 32`);
    }
    const ok = nacl.sign.detached.verify(
        new Uint8Array(digest), new Uint8Array(sig), new Uint8Array(pubKey),
    );
    if (!ok) {
        throw new AssetFetchError(asset.id, 'verifying-signature',
            `Ed25519.verify returned false (signature does not match publisher key over sha256)`);
    }
}

// =============================================================================
// Default HTTP fetcher (production)
// =============================================================================

const defaultHttpFetcher: HttpFetcher = (url, opts) => {
    return new Promise((resolveP, rejectP) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch (err) {
            rejectP(new Error(`invalid URL: ${url}`));
            return;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            rejectP(new Error(`unsupported protocol: ${parsed.protocol}`));
            return;
        }
        const driver = parsed.protocol === 'https:' ? https : http;
        const req = driver.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: opts.timeoutMs,
            headers: { 'User-Agent': 'pc2-asset-fetcher/0.3' },
        }, (res) => {
            resolveP({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                stream: res,
            });
        });
        req.on('error', rejectP);
        req.on('timeout', () => req.destroy(new Error(`request timed out after ${opts.timeoutMs}ms`)));
        req.end();
    });
};

function asArrayHeader(v: string | string[] | undefined): string[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * Extract a tarball into targetDir using the same defensive filter
 * the rest of the codebase applies (path traversal rejected, symlinks
 * rejected, entry-count + total-bytes capped).
 *
 * Atomic-ish: extracts in place. Caller is expected to have already
 * pre-cleaned targetDir if it requires "either fully extracted or
 * empty" semantics — for assets, we tolerate partial directory
 * contents because the .partial sweep + retry will re-run.
 */
async function extractTarballAtomically(
    tarballPath: string,
    targetDir: string,
    assetId: string,
): Promise<void> {
    const resolvedTarget = resolve(targetDir);
    const targetWithSep = resolvedTarget.endsWith('/') ? resolvedTarget : resolvedTarget + '/';
    let entryCount = 0;
    let totalBytes = 0;
    let violation: string | null = null;
    const recordViolation = (reason: string): false => {
        if (!violation) violation = reason;
        return false;
    };

    await tar.x({
        cwd: resolvedTarget,
        strict: true,
        preservePaths: false,
        preserveOwner: false,
        file: tarballPath,
        // tar's filter is overloaded as (path, entry: Stats | ReadEntry)
        // because the same callback shape is used at create-time too.
        // At extract-time we always get a ReadEntry; cast accordingly.
        filter: (entryPath, entry) => {
            if (violation) return false;
            const readEntry = entry as tar.ReadEntry;
            if (readEntry.type !== 'File' && readEntry.type !== 'Directory') {
                return recordViolation(`disallowed entry type "${readEntry.type}" at ${entryPath}`);
            }
            const candidate = resolve(resolvedTarget, entryPath);
            if (candidate !== resolvedTarget && !candidate.startsWith(targetWithSep)) {
                return recordViolation(`path escapes asset extractTo: ${entryPath}`);
            }
            return true;
        },
        onentry: (entry) => {
            if (violation) return;
            entryCount++;
            if (entryCount > 10_000) {
                violation = `tarball entry count exceeded 10000`;
                return;
            }
            totalBytes += entry.size ?? 0;
            if (totalBytes > MAX_BYTES_PER_ASSET) {
                violation = `tarball uncompressed bytes exceeded cap`;
            }
        },
    });

    if (violation) {
        throw new AssetFetchError(assetId, 'extracting',
            `tarball extraction rejected: ${violation}`);
    }
}

// Re-export the directory-creation helper used by tests in setup.
export function ensureDir(p: string): void {
    if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 });
}
// `dirname` is used in extractTarballAtomically's helper — silence the
// "unused" linter without removing the import (kept for future use).
void dirname;
void statSync;
