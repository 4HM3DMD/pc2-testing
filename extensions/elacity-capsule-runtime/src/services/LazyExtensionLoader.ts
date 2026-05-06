/**
 * LazyExtensionLoader — registry + state machine for hybrid-capsule
 * backends, with crash-loop quarantine and a global safe-mode escape
 * hatch.
 *
 * The architectural goal is to make capsule INSTALL a pure file
 * operation — no PC2 restart, no interruption to other apps' sessions.
 * This loader supports that by:
 *
 *   1. CapsuleInstaller (M2) drops a backend at `extensions/<name>/`
 *      and the route registration ahead of time
 *   2. LazyExtensionLoader.register(name, dir, manifest) records the
 *      pending capsule WITHOUT requiring it
 *   3. On the first request to a route owned by that capsule, the
 *      integrating layer (M5) calls `ensureLoaded(name)`
 *   4. ensureLoaded probes in a child process FIRST (so a sync throw
 *      can't crash PC2), then if the probe passes, performs the actual
 *      `require()` in the main process
 *
 * Crash containment in v1:
 *   - The probe catches sync throws at module-load time (the most
 *     common bricking case)
 *   - The loader counts main-process load failures and runtime crashes
 *     reported via `recordCrash()`. After CRASH_THRESHOLD failures
 *     (default 3) within CRASH_WINDOW_MS, the capsule transitions to
 *     `quarantined`. Quarantined capsules don't re-load until the
 *     operator clears the quarantine
 *   - PC2_DISABLE_EXTENSIONS=1 in the env disables ALL loading. Used
 *     for emergency boot when even the probe isn't enough
 *
 * Per-extension subprocess isolation (the "real" answer per A1/A11/A19)
 * is v2 work. v1 keeps the publisher-trust model: a signed capsule that
 * makes it through the probe runs as trusted code in the main process.
 *
 * Out of scope for M3:
 *   - HTTP routing wire-up (the "first request triggers ensureLoaded"
 *     bit) — that lives in M5 alongside the integration with PC2's
 *     existing route table
 *   - Persistence of loader state across PC2 restarts — in-memory
 *     for v1; quarantine state resets on PC2 boot. The probe gates
 *     re-load anyway, so a persistent crash still gets caught
 *   - Constructing the real `extension` global — the integrating layer
 *     wires that, since it's PC2-side state (DB handle, request
 *     context, etc.). This loader is given the `require` boundary; the
 *     actual extension API surface is provided by the caller via
 *     `loadHook`
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

import { probeExtension, ProbeResult, ProbeOptions } from './ExtensionProbe.js';
import type { CapsuleManifest } from './CapsuleManifest.js';

const DEFAULT_CRASH_THRESHOLD = 3;
const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

// =============================================================================
// State machine
// =============================================================================

/**
 * Capsule lifecycle within the loader. Linear on the happy path
 * (registered → loading → loaded). Branches into failed/quarantined
 * on crash.
 *
 *   registered    just installed; require not yet attempted
 *   loading       ensureLoaded in flight (probe + require)
 *   loaded        require returned successfully; extension is live
 *   failed        last load attempt failed; will retry on next request
 *                 (until CRASH_THRESHOLD reached, then → quarantined)
 *   quarantined   sticky failure state; operator must clear
 *   safe-mode     PC2_DISABLE_EXTENSIONS=1; never loads
 */
export type LoaderState =
    | 'registered'
    | 'loading'
    | 'loaded'
    | 'failed'
    | 'quarantined'
    | 'safe-mode';

export interface CapsuleEntry {
    name: string;
    extensionDir: string;
    manifest: CapsuleManifest;
    state: LoaderState;
    /** Loaded module exports, populated only when state === 'loaded'. */
    module?: unknown;
    /** Recent crash timestamps within the rolling window. */
    crashTimestamps: number[];
    /** Total lifetime crash count (incl. those expired from the window). */
    lifetimeCrashes: number;
    /** Last failure reason (probe or load), human-readable. */
    lastFailureReason?: string;
    /** Wall-clock ms when state last changed. */
    stateChangedAt: number;
}

export interface LoadOutcome {
    ok: boolean;
    state: LoaderState;
    reason?: string;
    /** Loaded exports if `ok: true`. */
    module?: unknown;
    /** Probe result if a probe ran (omitted on cached / quarantined paths). */
    probe?: ProbeResult;
}

// =============================================================================
// Loader options
// =============================================================================

export interface LazyLoaderOptions {
    /**
     * Callback that performs the actual main-process require + integration.
     * The loader probes first; if the probe passes, it calls this hook.
     * The hook is responsible for constructing the real `extension` global,
     * running the extension's `init` lifecycle, and returning the loaded
     * exports.
     *
     * If the hook throws, the loader records a crash and transitions
     * the capsule to `failed` (or `quarantined` if threshold reached).
     */
    loadHook: (entry: CapsuleEntry) => Promise<unknown>;

    /** Number of crashes within CRASH_WINDOW_MS that triggers quarantine. */
    crashThreshold?: number;
    /** Rolling window for crash counting, ms. */
    crashWindowMs?: number;
    /** Probe timeout passed to ExtensionProbe. */
    probeTimeoutMs?: number;
    /**
     * Override the probe function. Tests use this to skip the real fork
     * (which is exercised by ExtensionProbe's own tests). Production
     * callers should leave undefined.
     */
    probeFn?: (dir: string, opts?: ProbeOptions) => Promise<ProbeResult>;
    /**
     * Override the safe-mode env-var lookup. Tests use this to flip
     * safe-mode on without touching `process.env`. Defaults to reading
     * `process.env.PC2_DISABLE_EXTENSIONS`.
     */
    isSafeMode?: () => boolean;
}

// =============================================================================
// Errors
// =============================================================================

export class LoaderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LoaderError';
    }
}

// =============================================================================
// Loader
// =============================================================================

export class LazyExtensionLoader {
    private readonly entries = new Map<string, CapsuleEntry>();
    private readonly inFlight = new Map<string, Promise<LoadOutcome>>();
    private readonly loadHook: (entry: CapsuleEntry) => Promise<unknown>;
    private readonly crashThreshold: number;
    private readonly crashWindowMs: number;
    private readonly probeTimeoutMs: number;
    private readonly probeFn: (dir: string, opts?: ProbeOptions) => Promise<ProbeResult>;
    private readonly isSafeModeFn: () => boolean;

    constructor(opts: LazyLoaderOptions) {
        if (!opts || typeof opts.loadHook !== 'function') {
            throw new TypeError('LazyExtensionLoader: { loadHook } required');
        }
        this.loadHook = opts.loadHook;
        this.crashThreshold = opts.crashThreshold ?? DEFAULT_CRASH_THRESHOLD;
        this.crashWindowMs = opts.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
        this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        this.probeFn = opts.probeFn ?? probeExtension;
        this.isSafeModeFn = opts.isSafeMode
            ?? (() => Boolean(process.env.PC2_DISABLE_EXTENSIONS));
    }

    /**
     * Record an installed capsule. After register(), routes can be
     * mapped to this capsule's name; the actual require() doesn't
     * happen until ensureLoaded() is called.
     *
     * Throws if the capsule is already registered (caller must
     * deregister first to replace).
     */
    register(name: string, extensionDir: string, manifest: CapsuleManifest): void {
        if (this.entries.has(name)) {
            throw new LoaderError(`capsule "${name}" already registered`);
        }
        const resolved = resolve(extensionDir);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new LoaderError(
                `extensionDir does not exist or is not a directory: ${resolved}`,
            );
        }
        this.entries.set(name, {
            name,
            extensionDir: resolved,
            manifest,
            state: 'registered',
            crashTimestamps: [],
            lifetimeCrashes: 0,
            stateChangedAt: Date.now(),
        });
    }

    /**
     * Remove a capsule from the loader. If currently loaded, the
     * caller is responsible for invoking the extension's `shutdown`
     * hook before deregistering — the loader doesn't run lifecycle.
     */
    deregister(name: string): boolean {
        return this.entries.delete(name);
    }

    isRegistered(name: string): boolean {
        return this.entries.has(name);
    }

    isLoaded(name: string): boolean {
        return this.entries.get(name)?.state === 'loaded';
    }

    isQuarantined(name: string): boolean {
        return this.entries.get(name)?.state === 'quarantined';
    }

    getState(name: string): LoaderState | undefined {
        if (this.isSafeModeFn()) {
            // Safe-mode masks all entries — surface that explicitly.
            return this.entries.has(name) ? 'safe-mode' : undefined;
        }
        return this.entries.get(name)?.state;
    }

    /**
     * Snapshot of all registered capsules + their loader state. Cheap
     * — used by dApp Centre listings and operator-facing diagnostics.
     */
    listAll(): Array<Pick<CapsuleEntry,
        'name' | 'state' | 'lifetimeCrashes' | 'lastFailureReason' | 'stateChangedAt'>> {
        const safeMode = this.isSafeModeFn();
        return Array.from(this.entries.values()).map(e => ({
            name: e.name,
            state: safeMode ? ('safe-mode' as LoaderState) : e.state,
            lifetimeCrashes: e.lifetimeCrashes,
            lastFailureReason: e.lastFailureReason,
            stateChangedAt: e.stateChangedAt,
        }));
    }

    /**
     * Load the capsule if not already loaded; return the cached module
     * if it is. Coalesces concurrent calls so two requests landing on
     * an unloaded capsule don't both try to require().
     *
     * Resolves to a structured outcome — never throws on capsule code
     * errors. Throws only on programmer error (unregistered name).
     */
    async ensureLoaded(name: string): Promise<LoadOutcome> {
        if (this.isSafeModeFn()) {
            return {
                ok: false,
                state: 'safe-mode',
                reason: 'PC2 is in extension safe-mode (PC2_DISABLE_EXTENSIONS set)',
            };
        }

        const entry = this.entries.get(name);
        if (!entry) {
            throw new LoaderError(`capsule "${name}" is not registered`);
        }

        if (entry.state === 'loaded') {
            return { ok: true, state: 'loaded', module: entry.module };
        }
        if (entry.state === 'quarantined') {
            return {
                ok: false,
                state: 'quarantined',
                reason: entry.lastFailureReason ??
                    `quarantined after ${entry.lifetimeCrashes} crashes`,
            };
        }

        // Coalesce concurrent ensureLoaded calls
        const existing = this.inFlight.get(name);
        if (existing) return existing;

        const loadPromise = this.doLoad(entry);
        this.inFlight.set(name, loadPromise);
        try {
            return await loadPromise;
        } finally {
            this.inFlight.delete(name);
        }
    }

    /**
     * Notify the loader that an already-loaded capsule's runtime threw
     * (e.g. a route handler crashed, an `init` async error fired). The
     * integrating layer (HTTP middleware / lifecycle) calls this; the
     * loader bumps the crash counter and quarantines if threshold met.
     *
     * Idempotent on unknown / already-quarantined names.
     */
    recordCrash(name: string, reason: string): void {
        const entry = this.entries.get(name);
        if (!entry || entry.state === 'quarantined') return;

        const now = Date.now();
        entry.lifetimeCrashes += 1;
        entry.lastFailureReason = reason;
        entry.crashTimestamps.push(now);
        // Drop timestamps outside the rolling window.
        entry.crashTimestamps = entry.crashTimestamps.filter(
            ts => now - ts <= this.crashWindowMs,
        );

        if (entry.crashTimestamps.length >= this.crashThreshold) {
            entry.state = 'quarantined';
            entry.stateChangedAt = now;
            // Drop the cached module — quarantined capsules don't get
            // their handlers invoked. Caller's HTTP middleware should
            // 503 incoming requests for quarantined capsules.
            entry.module = undefined;
        } else if (entry.state === 'loaded') {
            entry.state = 'failed';
            entry.stateChangedAt = now;
        }
    }

    /**
     * Operator-initiated: clear quarantine + crash history so the
     * capsule can attempt to load again on the next request.
     *
     * Returns true if the capsule was quarantined (and is now
     * registered), false otherwise.
     */
    clearQuarantine(name: string): boolean {
        const entry = this.entries.get(name);
        if (!entry || entry.state !== 'quarantined') return false;
        entry.state = 'registered';
        entry.crashTimestamps = [];
        entry.lastFailureReason = undefined;
        entry.stateChangedAt = Date.now();
        return true;
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private async doLoad(entry: CapsuleEntry): Promise<LoadOutcome> {
        entry.state = 'loading';
        entry.stateChangedAt = Date.now();

        // 1. Probe in a child process. Sync throws die safely there.
        let probe: ProbeResult;
        try {
            probe = await this.probeFn(entry.extensionDir, {
                timeoutMs: this.probeTimeoutMs,
            });
        } catch (err) {
            const e = err as Error;
            return this.markFailure(entry, `probe invocation failed: ${e.message}`, undefined);
        }

        if (!probe.ok) {
            return this.markFailure(
                entry,
                `pre-load probe failed: ${probe.reason ?? 'unknown'}`,
                probe,
            );
        }

        // 2. Actual main-process load via the integrating layer's hook.
        try {
            const exports = await this.loadHook(entry);
            entry.module = exports;
            entry.state = 'loaded';
            entry.stateChangedAt = Date.now();
            entry.lastFailureReason = undefined;
            // A fresh successful load doesn't reset the crash counter —
            // we want repeated load-then-crash cycles to still trip the
            // quarantine threshold. A successful load AFTER quarantine
            // would only happen via clearQuarantine() which resets.
            return { ok: true, state: 'loaded', module: exports, probe };
        } catch (err) {
            const e = err as Error;
            return this.markFailure(
                entry,
                `load hook threw: ${e.message}`,
                probe,
            );
        }
    }

    private markFailure(
        entry: CapsuleEntry,
        reason: string,
        probe?: ProbeResult,
    ): LoadOutcome {
        const now = Date.now();
        entry.lifetimeCrashes += 1;
        entry.crashTimestamps.push(now);
        entry.crashTimestamps = entry.crashTimestamps.filter(
            ts => now - ts <= this.crashWindowMs,
        );
        entry.lastFailureReason = reason;

        if (entry.crashTimestamps.length >= this.crashThreshold) {
            entry.state = 'quarantined';
            entry.stateChangedAt = now;
            entry.module = undefined;
            return {
                ok: false,
                state: 'quarantined',
                reason: `${reason} — quarantined after ${entry.crashTimestamps.length} ` +
                        `failures within ${this.crashWindowMs}ms`,
                probe,
            };
        }

        entry.state = 'failed';
        entry.stateChangedAt = now;
        return { ok: false, state: 'failed', reason, probe };
    }
}
