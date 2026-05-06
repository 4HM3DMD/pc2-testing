/**
 * CapsuleConsent — render a hybrid capsule's manifest into the
 * structured + plain-English description that dApp Centre shows on
 * the install consent screen.
 *
 * Per the v0.3 trust model: capabilities are DISCLOSURE, not enforced
 * allow-lists. The consent screen's job is to make the publisher's
 * stated behaviour readable so the operator can decide whether to
 * trust them. This module produces:
 *
 *   - A `ConsentDescription` object — structured fields the UI binds
 *     to (publisher pubkey + truncated display, capability summaries,
 *     asset list, total download size, trust notice).
 *   - A canonical trust headline + caveat paragraph that's identical
 *     across capsules (operators learn one piece of language, not a
 *     per-capsule variation publishers can soften).
 *
 * Pure / no I/O. Caller passes a validated manifest (M1's
 * `validateCapsuleManifest` upstream); this module renders, doesn't
 * verify signatures.
 *
 * Frontend wire-up (dApp Centre HTML/JS) consumes this output.
 * Server-side install routes (CapsuleInstallOrchestrator, M6 next)
 * also use this when streaming install metadata over SSE.
 */

import type {
    CapsuleManifest,
    CapsuleAsset,
    CapsuleCapabilities,
} from './CapsuleManifest.js';

// =============================================================================
// Public types
// =============================================================================

export interface ConsentDescription {
    publisher: {
        keyHex: string;
        /** Truncated for display ("7f3a…d8e4") */
        keyDisplay: string;
        /**
         * Optional human-readable name from the trusted-publisher
         * registry. Caller passes via opts.publisherDisplayName.
         * Defaults to "Unknown publisher (key: <truncated>)".
         */
        displayName: string;
    };
    capsule: {
        name: string;
        title: string;
        version: string;
        kind: 'hybrid';
        channel?: 'stable' | 'beta' | 'nightly';
    };
    capabilities: ConsentCapability[];
    assets: ConsentAssetItem[];
    /** Sum of `asset.sizeBytes` across all install-time assets. */
    totalDownloadBytes: number;
    /** Friendly form, e.g. "~40 MB" */
    totalDownloadDisplay: string;
    /**
     * One-sentence trust headline. Identical wording across all
     * capsules so operators learn one phrase, not per-capsule
     * publisher-soothed variants.
     */
    trustHeadline: string;
    /**
     * The "PC2 will not prevent this code from doing more than it
     * claims" caveat. Verbatim from the v0.3 doc; do not parameterise.
     */
    trustCaveat: string;
}

export interface ConsentCapability {
    kind: 'spawnProcesses' | 'filesystem' | 'ports' | 'env' | 'imports';
    /** Plain-English single-line summary, e.g. "runs `ela` and `ela-cli`". */
    summary: string;
    /** Optional bullet detail lines (paths, port numbers, etc.). */
    detail: string[];
}

export interface ConsentAssetItem {
    id: string;
    /** The HTTPS URL the asset will be fetched from. */
    url: string;
    sizeBytes: number;
    /** Friendly form ("~40 MB") */
    sizeDisplay: string;
    arch: string;
    fetchOn: 'install' | 'first-run';
    /** Plain-English description ("downloads ~40 MB from download.elastos.io after install") */
    englishDescription: string;
    /** Hostname extracted from the URL for at-a-glance source check */
    sourceHost: string;
}

export interface DescribeConsentOpts {
    /**
     * Human-readable publisher name. Caller looks this up in the
     * trusted-publisher registry by `manifest.distribution.signedBy`.
     * Falls back to "Unknown publisher (key: …)" if absent.
     */
    publisherDisplayName?: string;
    /**
     * Override the host's arch so the consent screen reflects what
     * WILL be downloaded for THIS host (skips arch-mismatch assets
     * from totals + listing). Defaults to the running platform.
     */
    hostArch?: string;
}

// =============================================================================
// Public API
// =============================================================================

const TRUST_HEADLINE =
    'Installing means trusting the publisher. PC2 will not prevent ' +
    'this code from doing more than it claims; revoking the publisher\'s ' +
    'signature is the only way to block future updates.';

const TRUST_CAVEAT =
    'Once installed, this app runs as trusted code on your PC2 with ' +
    'full host privileges. The capability list below is what the ' +
    'publisher SAYS the code will do — not a runtime guarantee.';

export function describeConsent(
    manifest: CapsuleManifest,
    opts: DescribeConsentOpts = {},
): ConsentDescription {
    const signedBy = manifest.distribution.signedBy.toLowerCase();
    const keyDisplay = truncateKey(signedBy);
    const displayName = opts.publisherDisplayName
        ?? `Unknown publisher (key: ${keyDisplay})`;

    const hostArch = opts.hostArch ?? `${getPlatform()}-${getArch()}`;
    const installAssets = (manifest.assets ?? []).filter(a => a.arch === hostArch);

    const capabilities = describeCapabilities(manifest.backend.capabilities);
    const assets = installAssets.map(a => describeAsset(a));
    const totalDownloadBytes = installAssets
        .filter(a => a.fetchOn === 'install')
        .reduce((sum, a) => sum + a.sizeBytes, 0);

    return {
        publisher: { keyHex: signedBy, keyDisplay, displayName },
        capsule: {
            name: manifest.name,
            title: manifest.title ?? manifest.name,
            version: manifest.version,
            kind: 'hybrid',
            channel: manifest.channel,
        },
        capabilities,
        assets,
        totalDownloadBytes,
        totalDownloadDisplay: formatBytes(totalDownloadBytes),
        trustHeadline: TRUST_HEADLINE,
        trustCaveat: TRUST_CAVEAT,
    };
}

// =============================================================================
// Capability rendering
// =============================================================================

function describeCapabilities(
    caps: CapsuleCapabilities | undefined,
): ConsentCapability[] {
    const out: ConsentCapability[] = [];
    if (!caps) return out;

    if (caps.spawnProcesses && caps.spawnProcesses.length > 0) {
        const procs = caps.spawnProcesses.map(p => `\`${p}\``).join(', ');
        out.push({
            kind: 'spawnProcesses',
            summary: `runs ${procs} as a child process`,
            detail: caps.spawnProcesses.map(p => `\`${p}\` — host binary, spawned by the backend`),
        });
    }

    if (caps.filesystem) {
        const reads = caps.filesystem.read ?? [];
        const writes = caps.filesystem.write ?? [];
        const merged = mergeFsGlobs(reads, writes);
        if (merged.length > 0) {
            out.push({
                kind: 'filesystem',
                summary: `reads and writes inside ${prettyFsSummary(merged)}`,
                detail: merged.map(({ path, mode }) => `\`${path}\` (${mode})`),
            });
        }
    }

    if (caps.ports && caps.ports.tcp && caps.ports.tcp.length > 0) {
        const portList = caps.ports.tcp.join(', ');
        const publishNote = caps.ports.publish
            ? ' (will be reachable from outside this PC2)'
            : ' (loopback / inside-PC2 only)';
        out.push({
            kind: 'ports',
            summary: `listens on TCP ${caps.ports.tcp.length === 1 ? 'port' : 'ports'} ${portList}${publishNote}`,
            detail: caps.ports.tcp.map(p =>
                `TCP ${p}${caps.ports!.publish ? ' (host-published)' : ''}`),
        });
    }

    if (caps.env && caps.env.length > 0) {
        out.push({
            kind: 'env',
            summary: `reads environment ${caps.env.length === 1 ? 'variable' : 'variables'}: ${caps.env.join(', ')}`,
            detail: caps.env.map(v => `\`${v}\``),
        });
    }

    if (caps.imports && caps.imports.length > 0) {
        const services = caps.imports.map(i => i.replace(/^service:/, ''));
        out.push({
            kind: 'imports',
            summary: `uses PC2 service${services.length === 1 ? '' : 's'}: ${services.join(', ')}`,
            detail: services.map(s => `PC2 service \`${s}\``),
        });
    }

    return out;
}

interface MergedFsGlob {
    path: string;
    mode: 'read-only' | 'write' | 'read+write';
}

function mergeFsGlobs(reads: string[], writes: string[]): MergedFsGlob[] {
    const map = new Map<string, MergedFsGlob['mode']>();
    for (const r of reads) map.set(r, 'read-only');
    for (const w of writes) {
        map.set(w, map.has(w) ? 'read+write' : 'write');
    }
    return Array.from(map.entries()).map(([path, mode]) => ({ path, mode }));
}

function prettyFsSummary(merged: MergedFsGlob[]): string {
    if (merged.length === 1) return `\`${merged[0].path}\``;
    if (merged.length === 2) return `\`${merged[0].path}\` and \`${merged[1].path}\``;
    return `${merged.length} paths under the capsule's data dir`;
}

// =============================================================================
// Asset rendering
// =============================================================================

function describeAsset(asset: CapsuleAsset): ConsentAssetItem {
    let host = 'unknown source';
    try {
        host = new URL(asset.url).hostname;
    } catch { /* malformed URL — caught upstream by M1, but defensive */ }

    const sizeDisplay = formatBytes(asset.sizeBytes);
    const whenSuffix = asset.fetchOn === 'install' ? 'after install' : 'on first run';

    return {
        id: asset.id,
        url: asset.url,
        sizeBytes: asset.sizeBytes,
        sizeDisplay,
        arch: asset.arch,
        fetchOn: asset.fetchOn,
        englishDescription: `downloads ${sizeDisplay} from ${host} ${whenSuffix}`,
        sourceHost: host,
    };
}

// =============================================================================
// Helpers (pure)
// =============================================================================

export function truncateKey(hex: string): string {
    if (hex.length <= 12) return hex;
    return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

export function formatBytes(n: number): string {
    if (n < 0) return '0 B';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0;
    let val = n;
    while (val >= 1024 && unit < units.length - 1) {
        val /= 1024;
        unit++;
    }
    if (unit === 0) return `${val} B`;
    return `~${val.toFixed(val < 10 ? 1 : 0)} ${units[unit]}`;
}

// Indirection so tests can override the platform/arch resolution
// without monkey-patching `os` directly. Runtime-platform-aware so
// the describe output reflects what WILL actually fetch.
let getPlatform = (): string => process.platform;
let getArch = (): string => process.arch;

/** @internal — for tests only */
export function _setPlatformResolver(fn: () => string): void { getPlatform = fn; }
/** @internal — for tests only */
export function _setArchResolver(fn: () => string): void { getArch = fn; }
