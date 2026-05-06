/*
 * elacity-capsule-runtime — PC2 extension that adds support for
 * `kind: "hybrid"` capsules.
 *
 * Loaded at PC2 boot from `extensions/elacity-capsule-runtime/`.
 * No PC2 platform-team changes required — uses the same extension
 * lifecycle hooks (`extension.on('init')`, `extension.get/post`,
 * etc.) that PC2 already supports for whoami, ipfs-storage, etc.
 *
 * What this extension does at boot:
 *   1. Construct CapsuleInstaller, LazyExtensionLoader, AssetFetcher,
 *      RevocationFetcher (the M1-M9 services).
 *   2. Start the RevocationFetcher heartbeat (hourly poll of the
 *      ElacityLabs revocation list at registry.ela.city).
 *   3. Register install/uninstall/preview routes under /api/capsules/*.
 *   4. Wire CapsuleInstallOrchestrator with the trusted publisher
 *      key set + revocation check.
 *
 * Operators install this extension to enable hybrid capsules. Operators
 * who don't want them never load any of this code — that's the
 * "workaround" path the operator approved 2026-05-06 (vs. the
 * clean-way path of waiting for PC2 platform team to add a toggle
 * + dispatch wiring inside pc2-node).
 *
 * BUILD STEP REQUIRED before installing this extension into PC2:
 *   The library sources are TypeScript (src/services/*.ts). PC2's
 *   extension loader is CJS Node. Run `npm run build` (tsc) to
 *   produce dist/services/*.js before deploying. The dev workflow
 *   uses tsx to run TS directly during testing.
 *
 * Trust note: the runtime invariant is that hybrid capsules run as
 * trusted code in PC2's main process — see project_wave7_hybrid_capsule
 * memory for the full publisher-trust framing. This extension is
 * the bouncer at the door, not a sandbox.
 */

'use strict';

// At dev time these resolve via tsx's runtime TS loading. At
// production deploy time, run `tsc` to compile to dist/, then
// flip these requires to './dist/services/...' (or commit a
// dist-aware loader in a future iteration).

let CapsuleInstaller, LazyExtensionLoader, AssetFetcher;
let RevocationFetcher, CapsuleInstallOrchestrator;
let setLogger;

// Service singletons — populated in init.
const services = {
    installer: null,
    loader:    null,
    fetcher:   null,
    revocationFetcher: null,
    orchestrator: null,
};

// Trusted publisher key set + revocation root. Wired from
// PC2's config in production; for dev/test the operator sets
// these via env vars before launching PC2.
const TRUSTED_PUBLISHERS = (process.env.PC2_TRUSTED_PUBLISHER_KEYS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
const REVOCATION_ROOT_KEY = process.env.PC2_REVOCATION_ROOT_KEY ?? '';
const REVOCATION_URL = process.env.PC2_REVOCATION_URL
    ?? 'https://registry.ela.city/revocations.json';

// ---- Lifecycle ----------------------------------------------------------

extension.on('init', async () => {
    extension.log.info('[capsule-runtime] booting…');

    if (TRUSTED_PUBLISHERS.length === 0) {
        extension.log.warn(
            '[capsule-runtime] PC2_TRUSTED_PUBLISHER_KEYS env var is empty — ' +
            'no hybrid capsule installs will succeed. Set this to a comma-' +
            'separated list of 64-hex Ed25519 publisher pubkeys (e.g. ' +
            'ElacityLabs production key).');
    }

    try {
        ({ CapsuleInstaller } = await import('./src/services/CapsuleInstaller.js'));
        ({ LazyExtensionLoader } = await import('./src/services/LazyExtensionLoader.js'));
        ({ AssetFetcher } = await import('./src/services/AssetFetcher.js'));
        ({ RevocationFetcher } = await import('./src/services/RevocationFetcher.js'));
        ({ CapsuleInstallOrchestrator } = await import('./src/services/CapsuleInstallOrchestrator.js'));
        ({ setLogger } = await import('./src/utils/logger.js'));
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

    // PC2's data root — the v0.3 doc convention is that capsule paths
    // are relative to this dir. PC2 typically mounts data at /data.
    const dataDir = process.env.PC2_DATA_DIR ?? '/data';
    const extensionsDir = process.env.PC2_EXTENSIONS_DIR
        ?? require('path').resolve(__dirname, '..');

    services.installer = new CapsuleInstaller({ dataDir, extensionsDir });
    services.fetcher = new AssetFetcher({ dataDir });

    // Loader's loadHook constructs the Extension global the capsule
    // backend needs at require time. Production wire-up wraps PC2's
    // real Extension class; for now the hook just requires the
    // backend module — capsule's main.js does the rest.
    services.loader = new LazyExtensionLoader({
        loadHook: async (entry) => {
            const path = require('path');
            const mainPath = path.join(entry.extensionDir, 'main.js');
            delete require.cache[require.resolve(mainPath)];
            // Capsule's main.js reads `extension` global — point it
            // at PC2's extension here.
            require(mainPath);
            return {};
        },
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
        loader: services.loader,
        fetcher: services.fetcher,
        trustedPublisherKeys: TRUSTED_PUBLISHERS.length
            ? TRUSTED_PUBLISHERS
            : ['0'.repeat(64)],   // schema requires non-empty; "all installs fail" is the right behavior here
        isPublisherRevoked: (key) => services.revocationFetcher
            ? services.revocationFetcher.isPublisherRevoked(key)
            : undefined,
        forceRevocationRefresh: services.revocationFetcher
            ? () => services.revocationFetcher.forceFetch()
            : undefined,
    });

    extension.log.info('[capsule-runtime] init complete');
});

extension.on('shutdown', async () => {
    if (services.revocationFetcher) {
        try { services.revocationFetcher.stop(); }
        catch (err) { extension.log.warn(`[capsule-runtime] stop: ${err.message}`); }
    }
    extension.log.info('[capsule-runtime] shutdown complete');
});

// ---- Routes -------------------------------------------------------------
//
// Three endpoints:
//   POST /api/capsules/preview-consent  — render consent screen
//   POST /api/capsules/install          — verify + install + register
//   POST /api/capsules/uninstall        — deregister + remove

extension.post('/api/capsules/preview-consent', { subdomain: 'api' }, async (req, res) => {
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

extension.post('/api/capsules/install', { subdomain: 'api' }, async (req, res) => {
    if (!services.orchestrator) {
        return res.status(503).json({ error: 'capsule_runtime_not_ready' });
    }
    if (!req.user || !req.user.wallet_address) {
        return res.status(401).json({ error: 'authentication_required' });
    }
    try {
        const manifest = req.body && req.body.manifest;
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

extension.post('/api/capsules/uninstall', { subdomain: 'api' }, async (req, res) => {
    if (!services.orchestrator) {
        return res.status(503).json({ error: 'capsule_runtime_not_ready' });
    }
    if (!req.user || !req.user.wallet_address) {
        return res.status(401).json({ error: 'authentication_required' });
    }
    try {
        const name = req.body && req.body.name;
        const deleteDataDir = !!(req.body && req.body.deleteDataDir);
        if (!name) return res.status(400).json({ error: 'name_required' });
        const summary = await services.orchestrator.uninstall(name, { deleteDataDir });
        return res.json({ ok: true, summary });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

extension.get('/api/capsules/health', { subdomain: 'api' }, (req, res) => {
    res.json({
        ok: services.orchestrator !== null,
        ready: services.orchestrator !== null,
        trustedPublishers: TRUSTED_PUBLISHERS.length,
        revocationActive: services.revocationFetcher !== null
            && services.revocationFetcher.getCurrentList() !== null,
    });
});
