/*
 * elacity-capsule-runtime — PC2 extension that adds support for
 * `kind: "hybrid"` capsules.
 *
 * Loaded at boot from extensions/elacity-capsule-runtime/ by Puter's
 * ExtensionService (src/backend/src/Extension.js + ExtensionService.js
 * upstream), which is the same loader that runs whoami, ipfs-storage,
 * metering, etc. PC2 here is a Puter fork — see .is_puter_repository
 * at the repo root.
 *
 * What this extension does at boot:
 *   1. Construct CapsuleInstaller, LazyExtensionLoader, AssetFetcher,
 *      RevocationFetcher, CapsuleInstallOrchestrator (the M1–M9 services).
 *   2. Start the RevocationFetcher heartbeat (hourly poll of the
 *      ElacityLabs revocation list at registry.ela.city by default).
 *   3. Register install/uninstall/preview/health routes under
 *      /api/capsules/* (subdomain: 'api').
 *   4. Wire the orchestrator with the trusted publisher key set + the
 *      revocation lookup.
 *
 * Operators install this extension to enable hybrid capsules. Operators
 * who don't want them never load any of this code — that's the
 * "workaround" path the operator approved 2026-05-06 (vs. the
 * clean-way path of waiting for the platform team to add a toggle +
 * dispatch wiring inside pc2-node).
 *
 * BUILD STEP REQUIRED before installing this extension:
 *   The library sources are TypeScript (src/services/*.ts, src/utils/*.ts).
 *   Run `npm run build` (tsc) to produce dist/services/*.js and
 *   dist/utils/*.js — main.js dynamically imports from dist/. The dev
 *   workflow uses tsx to run TS directly during testing
 *   (`npx tsx --test tests/*.test.js`).
 *
 * Trust note: the runtime invariant is that hybrid capsules run as
 * trusted code in PC2's main process — see project_wave7_hybrid_capsule
 * memory for the full publisher-trust framing. This extension is the
 * bouncer at the door, not a sandbox.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const _require   = createRequire(import.meta.url);

// Service singletons — populated in init.
const services = {
    installer: null,
    loader:    null,
    fetcher:   null,
    revocationFetcher: null,
    orchestrator: null,
};

// Trusted publisher key set + revocation root. Read from PC2's env at
// boot — the operator sets these before launching PC2.
const TRUSTED_PUBLISHERS = (process.env.PC2_TRUSTED_PUBLISHER_KEYS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
const REVOCATION_ROOT_KEY = process.env.PC2_REVOCATION_ROOT_KEY ?? '';
const REVOCATION_URL = process.env.PC2_REVOCATION_URL
    ?? 'https://registry.ela.city/revocations.json';

// ---- Lifecycle ----------------------------------------------------------
//
// Puter's extension framework emits: install, preinit, construct, init,
// activate, ready (see src/backend/src/ExtensionService.js). It does NOT
// emit a 'shutdown' event — the RevocationFetcher's hourly timer is
// unref'd, so it does not block process exit; on real termination Node
// tears down anyway. If the framework ever adds a shutdown hook
// upstream, wire services.revocationFetcher.stop() into it here.

extension.on('init', async () => {
    extension.log.info('[capsule-runtime] booting…');

    if (TRUSTED_PUBLISHERS.length === 0) {
        extension.log.warn(
            '[capsule-runtime] PC2_TRUSTED_PUBLISHER_KEYS env var is empty — ' +
            'no hybrid capsule installs will succeed. Set this to a comma-' +
            'separated list of 64-hex Ed25519 publisher pubkeys (e.g. ' +
            'ElacityLabs production key).');
    }

    let CapsuleInstaller, LazyExtensionLoader, AssetFetcher;
    let RevocationFetcher, CapsuleInstallOrchestrator;
    let loadCapsule;
    let setLogger;

    try {
        ({ CapsuleInstaller }            = await import('./dist/services/CapsuleInstaller.js'));
        ({ LazyExtensionLoader }         = await import('./dist/services/LazyExtensionLoader.js'));
        ({ AssetFetcher }                = await import('./dist/services/AssetFetcher.js'));
        ({ RevocationFetcher }           = await import('./dist/services/RevocationFetcher.js'));
        ({ CapsuleInstallOrchestrator }  = await import('./dist/services/CapsuleInstallOrchestrator.js'));
        ({ loadCapsule }                 = await import('./dist/services/CapsuleExtensionHost.js'));
        ({ setLogger }                   = await import('./dist/utils/logger.js'));
    } catch (err) {
        extension.log.error(
            `[capsule-runtime] library load failed: ${err.message} — ` +
            `did you run \`npm run build\`?`);
        return;
    }

    // Wire the library's logger into PC2's extension log so capsule
    // events show up in the same stream as the rest of PC2.
    setLogger((level, tag, msg) => {
        const line = `[${tag}] ${msg}`;
        if (level === 'error') extension.log.error(line);
        else if (level === 'warn') extension.log.warn(line);
        else extension.log.info(line);
    });

    // PC2's data root and where installed-extension files land. The v0.3
    // doc convention is that capsule paths in the manifest are relative
    // to dataDir.
    //
    // Default `/data` matches PC2's container image but DOES NOT exist
    // on bare-metal/dev hosts. Operators on those hosts must set
    // PC2_DATA_DIR explicitly — otherwise CapsuleInstaller's mkdirSync
    // fails (ENOENT or EACCES) and we 503 every install request.
    const dataDir       = process.env.PC2_DATA_DIR       ?? '/data';
    const extensionsDir = process.env.PC2_EXTENSIONS_DIR ?? path.resolve(__dirname, '..');

    // Service construction is wrapped so a config error (typically an
    // unwritable PC2_DATA_DIR) doesn't crash PC2's boot lifecycle with
    // an unhandled rejection. On failure we log a clear, actionable
    // error and leave services.orchestrator = null — every route
    // handler already 503s on that condition.
    try {
        services.installer = new CapsuleInstaller({ dataDir, extensionsDir });
        services.fetcher   = new AssetFetcher({ dataDir });

        // Loader's loadHook brings the capsule's backend into the process.
        // The capsule's main.js references `extension` as a free variable;
        // CapsuleExtensionHost.loadCapsule injects a per-capsule shim into
        // globalThis.extension so those references resolve. See that
        // module's docblock for the single-capsule trade-off.
        services.loader = new LazyExtensionLoader({
            loadHook: async (entry) => loadCapsule(entry, extension, _require),
        });

        if (REVOCATION_ROOT_KEY) {
            services.revocationFetcher = new RevocationFetcher({
                url: REVOCATION_URL,
                revocationRootKeyHex: REVOCATION_ROOT_KEY,
            });
            try {
                await services.revocationFetcher.start();
                extension.log.info(
                    `[capsule-runtime] revocation fetcher started (${REVOCATION_URL})`);
            } catch (err) {
                extension.log.warn(
                    `[capsule-runtime] revocation fetcher start failed: ${err.message}`);
            }
        } else {
            extension.log.warn(
                '[capsule-runtime] PC2_REVOCATION_ROOT_KEY not set — revocation ' +
                'list will not be polled. Hybrid capsule publishers cannot be ' +
                'revoked at runtime until this is configured.');
        }

        services.orchestrator = new CapsuleInstallOrchestrator({
            installer: services.installer,
            loader:    services.loader,
            fetcher:   services.fetcher,
            trustedPublisherKeys: TRUSTED_PUBLISHERS.length
                ? TRUSTED_PUBLISHERS
                : ['0'.repeat(64)],   // schema requires non-empty; "all installs fail" is the right behaviour here
            isPublisherRevoked: (key) => services.revocationFetcher
                ? services.revocationFetcher.isPublisherRevoked(key)
                : undefined,
            forceRevocationRefresh: services.revocationFetcher
                ? () => services.revocationFetcher.forceFetch()
                : undefined,
        });
    } catch (err) {
        // Roll back partially-constructed services so route handlers
        // see a fully-null state and 503 cleanly.
        services.installer        = null;
        services.fetcher          = null;
        services.loader           = null;
        services.revocationFetcher = null;
        services.orchestrator     = null;

        const isFsErr = err && (err.code === 'ENOENT' || err.code === 'EACCES'
                                || err.code === 'EPERM' || err.code === 'ENOTDIR'
                                || err.code === 'EISDIR' || err.code === 'EROFS');
        extension.log.error(
            `[capsule-runtime] init failed — capsule install routes will ` +
            `return 503. Cause: ${err.message}` +
            (isFsErr
                ? ` — most likely PC2_DATA_DIR ("${dataDir}") is missing or ` +
                  `unwritable. The default "/data" exists in PC2's container ` +
                  `image but not on bare-metal hosts; set PC2_DATA_DIR to a ` +
                  `writable path before booting.`
                : ''));
        return;
    }

    extension.log.info('[capsule-runtime] init complete');
});

// ---- Routes -------------------------------------------------------------
//
//   POST /api/capsules/preview-consent  — render consent screen
//   POST /api/capsules/install          — verify + install + register
//   POST /api/capsules/uninstall        — deregister + remove
//   GET  /api/capsules/health           — readiness + status
//
// All routes are auth-gated: req.user.wallet_address is populated by
// Puter's auth middleware (whoami uses the same field).

extension.post('/capsules/preview-consent', { subdomain: 'api' }, async (req, res) => {
    if (!services.orchestrator) {
        return res.status(503).json({ error: 'capsule_runtime_not_ready' });
    }
    if (!req.user || !req.user.wallet_address) {
        return res.status(401).json({ error: 'authentication_required' });
    }
    try {
        const manifest = req.body && req.body.manifest;
        if (!manifest) return res.status(400).json({ error: 'manifest_required' });
        const consent = await services.orchestrator.previewConsent(manifest);
        return res.json({ consent });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

extension.post('/capsules/install', { subdomain: 'api' }, async (req, res) => {
    if (!services.orchestrator) {
        return res.status(503).json({ error: 'capsule_runtime_not_ready' });
    }
    if (!req.user || !req.user.wallet_address) {
        return res.status(401).json({ error: 'authentication_required' });
    }
    try {
        const manifest     = req.body && req.body.manifest;
        const bundleBase64 = req.body && req.body.bundleBase64;
        if (!manifest || !bundleBase64) {
            return res.status(400).json({ error: 'manifest_and_bundle_required' });
        }
        const bundleBuffer = Buffer.from(bundleBase64, 'base64');
        const summary = await services.orchestrator.install({ manifest, bundleBuffer });
        return res.json({ ok: true, summary });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

extension.post('/capsules/uninstall', { subdomain: 'api' }, async (req, res) => {
    if (!services.orchestrator) {
        return res.status(503).json({ error: 'capsule_runtime_not_ready' });
    }
    if (!req.user || !req.user.wallet_address) {
        return res.status(401).json({ error: 'authentication_required' });
    }
    try {
        const name           = req.body && req.body.name;
        const deleteDataDir  = !!(req.body && req.body.deleteDataDir);
        if (!name) return res.status(400).json({ error: 'name_required' });
        const summary = await services.orchestrator.uninstall(name, { deleteDataDir });
        return res.json({ ok: true, summary });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

extension.get('/capsules/health', { subdomain: 'api', noauth: true }, (req, res) => {
    res.json({
        ok:                services.orchestrator !== null,
        ready:             services.orchestrator !== null,
        trustedPublishers: TRUSTED_PUBLISHERS.length,
        revocationActive:  services.revocationFetcher !== null
                            && services.revocationFetcher.getCurrentList() !== null,
    });
});
