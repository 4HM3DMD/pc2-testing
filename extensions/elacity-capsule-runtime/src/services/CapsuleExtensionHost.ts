/**
 * CapsuleExtensionHost — bridges a hybrid capsule's `extension` global
 * to the runtime's parent extension instance (Puter's).
 *
 * Why this exists
 *   Puter's extension framework auto-prepends `const extension = ...`
 *   to every JS file in `extensions/<name>/` at boot (see Kernel.js's
 *   `prependToJSFiles`). That mechanism only runs once, against
 *   top-level extension files. It does NOT run against capsule files
 *   that LazyExtensionLoader pulls in at install-time. So when our
 *   loader does `_require(capsule/main.js)`, the capsule's free
 *   `extension` references resolve to nothing → ReferenceError.
 *
 *   This module provides the fix: build a per-capsule extension shim,
 *   inject it into `globalThis.extension` for the duration of the
 *   capsule's load, then leave it set so the capsule's registered
 *   handlers (which look up `extension` via globalThis at call time)
 *   keep working.
 *
 * Trade-off — single-capsule restriction (today)
 *   `globalThis.extension` is a single slot. Two concurrent hybrid
 *   capsules would collide. ENM is the only hybrid capsule planned
 *   today, so this is acceptable. Multi-capsule support requires
 *   source-level rewriting per capsule (mirror Puter's prepend trick
 *   but with per-capsule namespacing) — deferred until a second
 *   hybrid capsule lands.
 *
 * What the shim provides to capsules
 *   - `extension.log` — routed to the parent's log
 *   - `extension.on / .emit` — local event bus (capsule-scoped)
 *   - `extension.get / .post / .put / .delete` — passthrough to parent
 *     (capsule owns its own path namespace; M8 ENM uses `/api/enm/*`)
 *   - `extension.import('data' | 'core')` — minimal stubs; for ENM
 *     today the capsule degrades gracefully when these return null-ish
 *   - `extension.exports` — empty object the capsule populates
 *   - `extension.name` — capsule's name from the manifest
 *
 * What the shim does NOT provide
 *   - Real DB / KV / cache (Puter's `extension.import('data')` returns
 *     a wrapped better-sqlite3). Hooks for these are runtime-extension
 *     follow-ups when capsule data persistence becomes load-bearing.
 *   - The full RuntimeModule machinery (registry, runtime, etc.) —
 *     hybrid capsules don't currently use it.
 */

// Minimal subset of Puter's Extension API we route capsule calls to.
export interface ParentExtensionLike {
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void;
           error: (...a: unknown[]) => void; debug: (...a: unknown[]) => void };
    LOG?: (...a: unknown[]) => void;
    get   (path: string, ...rest: unknown[]): void;
    post  (path: string, ...rest: unknown[]): void;
    put   (path: string, ...rest: unknown[]): void;
    delete(path: string, ...rest: unknown[]): void;
}

// Minimal entry shape the host needs from LazyExtensionLoader.
export interface CapsuleEntryRef {
    name: string;
    extensionDir: string;
}

// What a CJS-style require-with-cache-bust looks like to us.
export interface RequireLike {
    (id: string): unknown;
    resolve(id: string): string;
    cache: Record<string, unknown>;
}

export interface CapsuleExtensionShim {
    name: string;
    exports: Record<string, unknown>;
    log: ParentExtensionLike['log'];
    LOG: (...a: unknown[]) => void;
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
    emit(event: string, ...args: unknown[]): Promise<void>;
    // Returns 'data' / 'core' shapes for those keys; null for everything
    // else. Caller-side narrowing handles the specifics — the host is
    // only there to keep capsule code from hard-failing on import().
    import(module: string): unknown;
    get   (path: string, ...rest: unknown[]): void;
    post  (path: string, ...rest: unknown[]): void;
    put   (path: string, ...rest: unknown[]): void;
    delete(path: string, ...rest: unknown[]): void;
}

/**
 * Build a per-capsule extension shim. The returned object is what the
 * capsule's main.js will see as the `extension` global once injected.
 */
export function createCapsuleExtension(
    entry: CapsuleEntryRef,
    parent: ParentExtensionLike,
): CapsuleExtensionShim {
    const listeners = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();

    const passthrough = (method: 'get' | 'post' | 'put' | 'delete') =>
        (path: string, ...rest: unknown[]) => {
            // Capsule owns its own path namespace. Production worry:
            // path collisions across capsules. With one hybrid capsule
            // today (ENM), the concern is theoretical.
            parent[method](path, ...rest);
        };

    return {
        name: entry.name,
        exports: {},
        log: parent.log,
        LOG: (parent.LOG ?? parent.log.info).bind(parent),
        on (event, handler) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event)!.push(handler);
        },
        async emit (event, ...args) {
            const hs = listeners.get(event) ?? [];
            for (const h of hs) await h(...args);
        },
        import (module: string): unknown {
            // Capsule-side stubs. ENM checks `db ?? null` shape.
            if (module === 'data') return { db: null, kv: null, cache: null };
            if (module === 'core') return { util: { helpers: {} } };
            return null;
        },
        get:    passthrough('get'),
        post:   passthrough('post'),
        put:    passthrough('put'),
        delete: passthrough('delete'),
    };
}

/**
 * Load a capsule's main.js with the `extension` global injected via
 * globalThis. This is what `LazyExtensionLoader.loadHook` calls.
 *
 * Sequence
 *   1. Capture parent extension (current globalThis.extension).
 *   2. Build per-capsule shim and stash on globalThis.extension.
 *   3. Bust the require cache for the capsule's main file (so a
 *      reload after uninstall+install reads the new bytes, not a
 *      stale cached module).
 *   4. require() the capsule's main.js — its top-level code runs
 *      with `extension` resolving to the shim.
 *   5. Fire 'init' on the shim — capsule's registered init handler
 *      runs (mirrors Puter's lifecycle for top-level extensions).
 *   6. On any error, restore the previous globalThis.extension.
 *      On success, leave the shim in place so capsule handlers
 *      registered for late events keep resolving.
 *
 * Returns the capsule's `extension.exports` object (whatever the
 * capsule populated during load + init).
 */
export async function loadCapsule (
    entry: CapsuleEntryRef,
    parent: ParentExtensionLike,
    cjsRequire: RequireLike,
    capsuleEntryFileName: string = 'main.js',
): Promise<Record<string, unknown>> {
    const path = await import('node:path');
    const mainPath = path.join(entry.extensionDir, capsuleEntryFileName);

    const shim = createCapsuleExtension(entry, parent);

    // Snapshot the previous global so we can restore on failure.
    const g = globalThis as unknown as { extension?: unknown };
    const prevExtension = g.extension;
    g.extension = shim;

    try {
        // Cache-bust so re-installs see fresh bytes.
        const resolved = cjsRequire.resolve(mainPath);
        delete cjsRequire.cache[resolved];
        cjsRequire(mainPath);

        // Fire the capsule's init lifecycle. Mirrors what Puter's
        // ExtensionService does for top-level extensions in
        // `__on_boot.consolidation` (see src/backend/src/ExtensionService.js:159).
        await shim.emit('init');
    } catch (err) {
        g.extension = prevExtension;
        throw err;
    }

    // On success: leave g.extension = shim so capsule handlers
    // registered for late events (e.g. 'shutdown') keep resolving.
    // The runtime's main.js does NOT reference `extension` post-init,
    // so the swap is observably safe for it.

    return shim.exports;
}
