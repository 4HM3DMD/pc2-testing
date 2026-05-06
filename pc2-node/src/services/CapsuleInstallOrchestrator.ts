/**
 * CapsuleInstallOrchestrator — composes M1+M2+M3+M4 into the
 * top-level install/uninstall flows the dApp Centre invokes.
 *
 * Sits above the leaf services and below the HTTP route layer.
 * Owns the orchestration order, the trusted-publisher set, the
 * structured progress events the UI streams over SSE, and the
 * uninstall preview the consent-to-delete prompt needs.
 *
 * Single source of truth for "what does an install actually do":
 *
 *   1. Verify the manifest signature against the trusted set
 *      (M1 verifyManifestSignature). REJECT unknown publishers.
 *   2. Atomic two-target extraction of app/ + backend/
 *      (M2 CapsuleInstaller.install).
 *   3. Fetch + verify install-time assets (M4 AssetFetcher.fetchAll).
 *      first-run assets defer to lazy-load later.
 *   4. Register with the lazy loader (M3
 *      LazyExtensionLoader.register). The actual `require()` waits
 *      for the first request — install does NOT trigger it.
 *
 * On any failure between steps 2 and 4, the orchestrator rolls back
 * by uninstalling what was committed. So a partial install never
 * lingers — the operator either has a working capsule or no capsule.
 *
 * Out of scope for M6:
 *   - HTTP route wiring (caller's responsibility — registers a
 *     POST /api/capsules/install handler that calls this)
 *   - SSE plumbing (caller pipes orchestrator progress events to
 *     SseHub or whatever transport)
 *   - DB persistence of installed-capsule registry (M2 deliberately
 *     left this out; the orchestrator doesn't add it either — caller
 *     wires a hook if needed for v1)
 */

import {
    CapsuleManifest,
    validateCapsuleManifest,
} from './CapsuleManifest.js';
import { verifyManifestSignature } from './CapsuleSignature.js';
import { CapsuleInstaller, InstallResult, UninstallOptions } from './CapsuleInstaller.js';
import { LazyExtensionLoader, LoaderState } from './LazyExtensionLoader.js';
import { AssetFetcher, FetchResult } from './AssetFetcher.js';
import { describeConsent, ConsentDescription } from './CapsuleConsent.js';

// =============================================================================
// Types
// =============================================================================

export type OrchestratorPhase =
    | 'validating-manifest'
    | 'verifying-signature'
    | 'installing-bundle'
    | 'fetching-assets'
    | 'registering'
    | 'rolling-back'
    | 'done';

export interface OrchestratorProgress {
    (event: OrchestratorEvent): void;
}

export interface OrchestratorEvent {
    capsule: string;
    phase: OrchestratorPhase;
    /** 0-100 progress estimate. Coarse — fine progress lives in the leaf event. */
    pct: number;
    /** Plain-English status line for the UI. */
    detail?: string;
    /**
     * Pass-through of a leaf service's progress event when relevant
     * (CapsuleInstaller, AssetFetcher). UI renders it as a nested
     * progress bar.
     */
    leaf?: unknown;
}

export interface InstallRequest {
    manifest: CapsuleManifest;
    bundleBuffer: Buffer;
}

export interface InstallSummary {
    capsule: string;
    install: InstallResult;
    assets: FetchResult[];
    consent: ConsentDescription;
    /** Loader state immediately after register() — almost always 'registered'. */
    loaderState: LoaderState;
}

export interface UninstallSummary {
    capsule: string;
    appDirRemoved: boolean;
    extensionDirRemoved: boolean;
    dataDirRemoved: boolean;
    /** Loader was deregistered (true if we found a registration). */
    loaderDeregistered: boolean;
}

export interface UninstallPreview {
    capsule: string;
    /** Estimated bytes that would be removed if the capsule is uninstalled. */
    estimatedBytesRemoved: number;
    /** What the dataDir contains right now (best-effort sample, not exhaustive). */
    dataDirHasState: boolean;
    /** Plain-English warning text for the keep-vs-delete prompt. */
    deleteWarning: string;
}

export class OrchestratorError extends Error {
    public readonly capsule: string;
    public readonly phase: OrchestratorPhase;
    constructor(capsule: string, phase: OrchestratorPhase, message: string) {
        super(`[capsule:${capsule}][${phase}] ${message}`);
        this.name = 'OrchestratorError';
        this.capsule = capsule;
        this.phase = phase;
    }
}

// =============================================================================
// Service
// =============================================================================

export interface CapsuleInstallOrchestratorOpts {
    installer: CapsuleInstaller;
    loader: LazyExtensionLoader;
    fetcher: AssetFetcher;
    /**
     * Set of publisher pubkeys (lowercase hex) we accept. M6 v1: just
     * ElacityLabs. Caller passes from the trusted-publisher registry
     * (M7 will wire that to the revocation transport).
     */
    trustedPublisherKeys: Iterable<string>;
    /**
     * Optional lookup: pubkey hex → display name shown on consent
     * screen. If absent or returns undefined, consent shows
     * "Unknown publisher (key: <truncated>)".
     */
    publisherDisplayName?: (publisherKeyHex: string) => string | undefined;
}

export class CapsuleInstallOrchestrator {
    private readonly installer: CapsuleInstaller;
    private readonly loader: LazyExtensionLoader;
    private readonly fetcher: AssetFetcher;
    private readonly trustedKeys: Set<string>;
    private readonly publisherDisplayName: (k: string) => string | undefined;

    constructor(opts: CapsuleInstallOrchestratorOpts) {
        if (!opts || !opts.installer || !opts.loader || !opts.fetcher) {
            throw new TypeError(
                'CapsuleInstallOrchestrator: { installer, loader, fetcher } required');
        }
        this.installer = opts.installer;
        this.loader = opts.loader;
        this.trustedKeys = normaliseKeys(opts.trustedPublisherKeys);
        this.fetcher = opts.fetcher;
        this.publisherDisplayName = opts.publisherDisplayName ?? (() => undefined);
    }

    /**
     * Top-level install. Verifies, installs, fetches assets, registers.
     * Rolls back on failure so partial state never lingers.
     */
    async install(
        req: InstallRequest,
        onProgress?: OrchestratorProgress,
    ): Promise<InstallSummary> {
        const { manifest, bundleBuffer } = req;
        const name = manifest?.name ?? '(unknown)';

        // Phase 1: schema validation.
        this.emit(onProgress, name, 'validating-manifest', 5);
        validateCapsuleManifest(manifest);

        // Phase 2: signature verification against trusted publisher set.
        this.emit(onProgress, name, 'verifying-signature', 10);
        const verify = verifyManifestSignature(manifest, this.trustedKeys);
        if (!verify.valid) {
            throw new OrchestratorError(name, 'verifying-signature',
                `signature verification failed: ${verify.reason}`);
        }

        // Build the consent descriptor now so the caller can also use it
        // (e.g. log "operator accepted consent for these capabilities").
        const consent = describeConsent(manifest, {
            publisherDisplayName:
                this.publisherDisplayName(manifest.distribution.signedBy.toLowerCase()),
        });

        // Phase 3: atomic two-target extraction. M2 owns rollback if THIS
        // step fails partway. After it returns, the orchestrator owns
        // rollback for any subsequent failures.
        this.emit(onProgress, name, 'installing-bundle', 20);
        let installResult: InstallResult;
        try {
            installResult = await this.installer.install(manifest, bundleBuffer, (stage, pct, meta) => {
                this.emit(onProgress, name, 'installing-bundle',
                    20 + Math.floor(pct * 0.4),  // 20–60% band
                    `installer: ${stage}`,
                    { stage, pct, meta });
            });
        } catch (err) {
            const e = err as Error;
            throw new OrchestratorError(name, 'installing-bundle',
                `bundle install failed: ${e.message}`);
        }

        // Phase 4: fetch install-time assets. first-run assets are deferred
        // (the lazy loader pulls them at first request).
        let assetResults: FetchResult[] = [];
        const installTimeAssets = (manifest.assets ?? []).filter(a => a.fetchOn === 'install');
        if (installTimeAssets.length > 0) {
            this.emit(onProgress, name, 'fetching-assets', 60,
                `fetching ${installTimeAssets.length} asset(s)`);
            try {
                assetResults = await this.fetcher.fetchAll(
                    installTimeAssets,
                    manifest.distribution.signedBy.toLowerCase(),
                    (event) => {
                        this.emit(onProgress, name, 'fetching-assets',
                            60 + Math.floor(((event.bytesReceived ?? 0)
                                / Math.max(1, event.totalBytes ?? 1)) * 25),
                            `${event.assetId}: ${event.phase}`,
                            event);
                    },
                );
            } catch (err) {
                const e = err as Error;
                await this.rollback(name, onProgress);
                throw new OrchestratorError(name, 'fetching-assets',
                    `asset fetch failed: ${e.message}`);
            }
        }

        // Phase 5: register with lazy loader. We do NOT call ensureLoaded —
        // the first request triggers the require, keeping install
        // restart-free.
        this.emit(onProgress, name, 'registering', 90);
        try {
            this.loader.register(name, installResult.extensionDir, manifest);
        } catch (err) {
            const e = err as Error;
            await this.rollback(name, onProgress);
            throw new OrchestratorError(name, 'registering',
                `loader registration failed: ${e.message}`);
        }

        const loaderState = this.loader.getState(name) ?? 'registered';
        this.emit(onProgress, name, 'done', 100,
            `installed; backend will load on first request`);

        return {
            capsule: name,
            install: installResult,
            assets: assetResults,
            consent,
            loaderState,
        };
    }

    /**
     * Top-level uninstall. Order:
     *   1. Deregister from loader (so subsequent requests don't try to
     *      use a backend whose files are about to disappear).
     *   2. Remove app + extension dirs (M2 CapsuleInstaller.uninstall).
     *   3. Optionally remove dataDir per the operator's decision.
     */
    async uninstall(
        name: string,
        opts: UninstallOptions = {},
    ): Promise<UninstallSummary> {
        const loaderDeregistered = this.loader.deregister(name);
        const installerResult = await this.installer.uninstall(name, opts);

        return {
            capsule: name,
            appDirRemoved: installerResult.appDirRemoved,
            extensionDirRemoved: installerResult.extensionDirRemoved,
            dataDirRemoved: installerResult.dataDirRemoved,
            loaderDeregistered,
        };
    }

    /**
     * Build the structured "what would happen if we delete this" payload
     * the consent-to-delete prompt shows the operator. Doesn't actually
     * delete anything.
     *
     * The detail comes from M2's installer behaviour: by default,
     * dataDir is preserved (encryption keys, chain data, audit log
     * could all live there — silent deletion is data loss). The
     * operator opts in via `deleteDataDir: true`.
     */
    getUninstallPreview(name: string): UninstallPreview {
        const entry = this.loader.listAll().find(e => e.name === name);
        if (!entry) {
            return {
                capsule: name,
                estimatedBytesRemoved: 0,
                dataDirHasState: false,
                deleteWarning: `Capsule "${name}" is not installed.`,
            };
        }

        // The dataDir size + state-introspection are caller concerns
        // (they know the filesystem layout). For M6 we surface intent
        // and warning text only.
        return {
            capsule: name,
            estimatedBytesRemoved: -1,   // caller can fill in via dirSize()
            dataDirHasState: true,       // assume yes; operator chooses
            deleteWarning:
                `Delete saved state? This will erase any encryption keys, ` +
                `keystore files, and persisted state for "${name}". ` +
                `If the capsule is reinstalled later, it will start fresh — ` +
                `state is not recoverable after deletion.`,
        };
    }

    /**
     * Generate the consent description for a manifest WITHOUT installing.
     * The dApp Centre calls this to render the install consent screen
     * before the operator clicks Install.
     *
     * Verifies the signature first — if the manifest is unsigned or
     * signed by an unknown publisher, throws (don't show consent for
     * untrusted code).
     */
    previewConsent(manifest: CapsuleManifest): ConsentDescription {
        validateCapsuleManifest(manifest);
        const verify = verifyManifestSignature(manifest, this.trustedKeys);
        if (!verify.valid) {
            throw new OrchestratorError(manifest.name, 'verifying-signature',
                `cannot show consent for unverified manifest: ${verify.reason}`);
        }
        return describeConsent(manifest, {
            publisherDisplayName:
                this.publisherDisplayName(manifest.distribution.signedBy.toLowerCase()),
        });
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private async rollback(
        name: string,
        onProgress?: OrchestratorProgress,
    ): Promise<void> {
        this.emit(onProgress, name, 'rolling-back', 95,
            `rolling back partial install`);
        // Best-effort: don't throw further, we're already in an error path
        try {
            this.loader.deregister(name);
        } catch { /* ignore */ }
        try {
            await this.installer.uninstall(name, { deleteDataDir: false });
        } catch { /* ignore */ }
    }

    private emit(
        cb: OrchestratorProgress | undefined,
        capsule: string,
        phase: OrchestratorPhase,
        pct: number,
        detail?: string,
        leaf?: unknown,
    ): void {
        if (!cb) return;
        try { cb({ capsule, phase, pct, detail, leaf }); } catch { /* swallow */ }
    }
}

// =============================================================================
// Helpers
// =============================================================================

function normaliseKeys(raw: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const k of raw) {
        if (typeof k !== 'string') continue;
        const lower = k.toLowerCase();
        if (/^[0-9a-f]{64}$/.test(lower)) out.add(lower);
    }
    if (out.size === 0) {
        throw new TypeError(
            'CapsuleInstallOrchestrator: trustedPublisherKeys must contain at least one valid 64-hex key');
    }
    return out;
}
