/*
 * router-adapter.js — bridge between Express-style route files and
 * PC2's extension.get/post API.
 *
 * Each route file in `backend/routes/` exports a `build(extensionHandle)`
 * that returns an Express Router. Manually rewriting all 10 route files
 * (2,588 LOC) into the extension API would be high-risk for typos and
 * would diverge from the upstream enm-server source structure that
 * operators may have local patches against.
 *
 * Instead this adapter loads each route file with `require('express')`
 * stubbed to a capture-mode object that records every router.get/post
 * call into an array. After the route file's build() returns, the
 * adapter replays those captured calls into PC2's extension.get/post.
 *
 * Net effect: route file bodies stay unchanged; the only port-time
 * edit was swapping `require('../auth/OwnerCheckMiddleware')` to
 * `require('../auth')` (the shim that uses PC2's req.actor instead
 * of pc2-node's session DB directly).
 *
 * The express stub is scoped — `Module._load` is patched only for the
 * synchronous duration of the route file's `require()`. Concurrent
 * adaptations of different route files run sequentially; the patch
 * is restored in a `finally` block.
 *
 * Limits intentionally:
 *   - Doesn't support `router.use(middleware)` for sub-routing — the
 *     enm-server routes don't use it. Records the call but no-ops at
 *     replay time.
 *   - Sync-only route registration (Express convention). Async
 *     registration mid-build wouldn't be captured.
 *   - The captured handler is the LAST function in the .get/.post args;
 *     everything before it (functions only) is treated as middleware
 *     and passed to extension.<method>(path, { mw }, handler).
 */

'use strict';

const Module = require('module');

/**
 * Adapt a single Express-style route file into PC2 extension routes.
 *
 * @param {object} extension — PC2's extension API (from main.js)
 * @param {string} urlPrefix — prefix added under `/api/enm`, e.g. '/system'
 * @param {string} routeFilePath — absolute path to the route .js file
 * @param {object} extensionHandle — passed through to the route file's
 *                                    build() so existing code that uses
 *                                    `extensionHandle.log` etc. keeps
 *                                    working
 */
function adaptRoute(extension, urlPrefix, routeFilePath, extensionHandle) {
    if (typeof extension.get !== 'function' || typeof extension.post !== 'function') {
        throw new TypeError('adaptRoute: extension must expose get/post/etc.');
    }

    const captured = [];
    const captureRouter = makeCaptureRouter(captured);

    const stubExpress = {
        Router: () => captureRouter,
    };

    // Patch global require for the express module only, for the
    // duration of the route-file load. Restored in finally.
    const origLoad = Module._load;
    Module._load = function (id, parent, isMain) {
        if (id === 'express') return stubExpress;
        return origLoad.call(this, id, parent, isMain);
    };

    let buildFn;
    try {
        // Bust the cache so re-adapt works (useful in tests).
        delete require.cache[require.resolve(routeFilePath)];
        buildFn = require(routeFilePath);
    } finally {
        Module._load = origLoad;
    }

    // Route files export either:
    //   module.exports = function build(handle) {...}
    //   module.exports = { build }
    // Unwrap both shapes.
    if (typeof buildFn === 'object' && buildFn !== null && typeof buildFn.build === 'function') {
        buildFn = buildFn.build;
    }
    if (typeof buildFn !== 'function') {
        throw new Error(
            `route file ${routeFilePath} must export a build(extensionHandle) function ` +
            `(got ${typeof buildFn})`);
    }

    // Calling build() populates `captured` via the stub Router.
    buildFn(extensionHandle);

    // Replay into the extension API. Path becomes /api/enm + prefix + originalPath.
    for (const r of captured) {
        const fullPath = '/api/enm' + urlPrefix + (r.path === '/' ? '' : r.path);
        const args = r.args;
        if (args.length === 0) continue;
        const handler = args[args.length - 1];
        if (typeof handler !== 'function') {
            throw new Error(
                `route file ${routeFilePath} registered ${r.method} ${r.path} ` +
                `with no handler function in last arg`);
        }
        const mw = args.slice(0, -1).filter(x => typeof x === 'function');
        const opts = { subdomain: 'api', mw };
        extension[r.method.toLowerCase()](fullPath, opts, handler);
    }
}

function makeCaptureRouter(captured) {
    const router = {};
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
    for (const m of methods) {
        router[m] = (path, ...rest) => {
            captured.push({ method: m.toUpperCase(), path, args: rest });
            return router;
        };
    }
    // No-op .use() so route files that mount global middleware don't crash;
    // the per-route mw passed to .get/.post is still captured normally.
    router.use = () => router;
    return router;
}

module.exports = { adaptRoute, makeCaptureRouter };
