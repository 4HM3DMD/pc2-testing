/*
 * probe-runner.cjs — child-process wrapper for ExtensionProbe.
 *
 * Run by `child_process.fork(this, [extensionDir])`. Stubs the `extension`
 * global (so the require() doesn't NPE on `extension.on(...)`), then
 * requires the extension's main file. Exits 0 on clean require, non-zero
 * with a clear stderr message otherwise.
 *
 * Why a separate .cjs file (not inline `node -e ...`):
 *   - Stack traces stay readable instead of getting smushed into one line
 *   - Child can use require() without the project's "type": "module"
 *     forcing ESM (the probe is ABI-isolated from PC2's main-process
 *     module choices)
 *   - Easier to extend later (e.g. add an init-hook timeout in M5)
 *
 * Exit codes — kept small + descriptive for telemetry:
 *   0  = require() returned without throwing (the probe passes)
 *   2  = missing target-dir argument
 *   3  = malformed package.json in target dir
 *   4  = main file (per package.json `main`, or default main.js) missing
 *   5  = require() threw synchronously
 *   6  = uncaughtException after require()
 *   7  = unhandledRejection after require()
 */

'use strict';
const path = require('path');
const fs = require('fs');

// =============================================================================
// Stub `extension` global so an extension's top-level
// `extension.on('init', ...)` etc. don't NPE before we even get to the
// real load. The stub records nothing; it just absorbs calls.
// =============================================================================

function noop() { /* swallow */ }
function noopReturn() { return undefined; }

const stubLog = function (...args) { console.log('[probe.log]', ...args); };
['info', 'warn', 'debug', 'error', 'tick', 'noticeme', 'system'].forEach(lvl => {
    stubLog[lvl] = function (...args) { console.log(`[probe.log.${lvl}]`, ...args); };
});

const stubExtension = {
    exports: {},
    on: noop,
    once: noop,
    off: noop,
    get: noop,
    post: noop,
    put: noop,
    delete: noop,
    patch: noop,
    use: noop,
    log: stubLog,
    LOG: stubLog,
    // Imports return shaped placeholders so destructuring like
    //   const { db } = extension.import('data');
    // doesn't throw on the stub.
    import(moduleName) {
        switch (moduleName) {
            case 'data':
                return { db: null, kv: null, cache: null };
            case 'core':
                return { util: { helpers: {} } };
            case 'fs':
                return { FSNodeContext: null, selectors: null };
            case 'extensionController':
                return {};
            default:
                if (typeof moduleName === 'string' && moduleName.startsWith('service:')) {
                    return null;
                }
                return null;
        }
    },
    services: { get: noopReturn },
    db: null,
    registry: {
        register: noop,
        of: () => ({ named: () => undefined, all: () => [] }),
    },
};

global.extension = stubExtension;
global.config = {};
global.global_config = {};

// =============================================================================
// Resolve target dir + main file
// =============================================================================

const targetDir = process.argv[2];
if (!targetDir) {
    console.error('probe-runner: missing target dir argument');
    process.exit(2);
}

const resolved = path.resolve(targetDir);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`probe-runner: target dir does not exist or is not a directory: ${resolved}`);
    process.exit(4);
}

let mainFile = 'main.js';
const pkgJsonPath = path.join(resolved, 'package.json');
if (fs.existsSync(pkgJsonPath)) {
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (typeof pkg.main === 'string' && pkg.main.length > 0) {
            mainFile = pkg.main;
        }
    } catch (e) {
        console.error(`probe-runner: malformed package.json at ${pkgJsonPath}: ${e.message}`);
        process.exit(3);
    }
}

const mainPath = path.join(resolved, mainFile);
if (!fs.existsSync(mainPath)) {
    console.error(`probe-runner: main file "${mainFile}" not found in ${resolved}`);
    process.exit(4);
}

// =============================================================================
// Catch async failures that happen AFTER require() but inside any
// synchronous-tail or microtask-resolution side effects of the load.
// We hold the process open briefly (100ms) before exiting to give those
// a chance to surface.
// =============================================================================

let asyncFailureReason = null;
process.on('uncaughtException', (e) => {
    asyncFailureReason = `uncaughtException: ${e.message}`;
    console.error(`probe-runner: ${asyncFailureReason}\n${e.stack}`);
    process.exit(6);
});
process.on('unhandledRejection', (reason) => {
    asyncFailureReason = `unhandledRejection: ${String(reason)}`;
    console.error(`probe-runner: ${asyncFailureReason}`);
    process.exit(7);
});

// =============================================================================
// The actual require — main-line of the probe.
// =============================================================================

try {
    require(mainPath);
} catch (e) {
    console.error(`probe-runner: require threw: ${e.message}\n${e.stack}`);
    process.exit(5);
}

// Drain microtasks / settle any sync-but-deferred side effects of the
// require, then exit clean. The handlers above will fire if anything
// throws during the drain window.
setTimeout(() => {
    if (asyncFailureReason) {
        process.exit(8);   // belt-and-braces — handlers above should have already exited
    }
    process.exit(0);
}, 100);
