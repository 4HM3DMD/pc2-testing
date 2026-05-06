/**
 * SPEC: CapsuleConsent — manifest → consent description.
 *
 * Helper location:
 *   pc2-node/src/services/CapsuleConsent.ts
 *
 * Purpose:
 *   Pure rendering function that turns a validated capsule manifest
 *   into the structured + plain-English description dApp Centre shows
 *   on the install consent screen. Per the v0.3 trust model:
 *   capabilities are DISCLOSURE, not enforced limits — the language
 *   has to be honest about that.
 *
 *   Tests cover capability rendering for every kind, asset
 *   aggregation, byte formatting, key truncation, the fixed trust
 *   headline + caveat (these MUST be identical across all capsules
 *   so operators learn one phrase), and arch filtering.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../src/services/CapsuleConsent.js';
let describeConsent, truncateKey, formatBytes, _setPlatformResolver, _setArchResolver;

try {
    ({ describeConsent, truncateKey, formatBytes, _setPlatformResolver, _setArchResolver }
        = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] CapsuleConsent not yet implemented: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!describeConsent) {
        t.skip('CapsuleConsent helper not yet implemented (Wave 7 / M6)');
        return true;
    }
    return false;
}

// Pin the host arch for deterministic tests (otherwise asset filtering
// depends on the runner's actual platform).
function withArch(linuxOrDarwinX64 = 'linux-x64', cb) {
    const [platform, arch] = linuxOrDarwinX64.split('-');
    _setPlatformResolver(() => platform);
    _setArchResolver(() => arch);
    try { return cb(); }
    finally {
        _setPlatformResolver(() => process.platform);
        _setArchResolver(() => process.arch);
    }
}

function validManifest() {
    return {
        name: 'elastos-node-manager',
        version: '0.5.0',
        kind: 'hybrid',
        title: 'Elastos Node Manager',
        engines: { node: '>=20', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/',
            needsRestart: false,
            schemaVersion: 1,
            dataDir: 'data/installed-apps/elastos-node-manager/state/',
            capabilities: {
                spawnProcesses: ['ela', 'ela-cli'],
                filesystem: {
                    read: ['data/installed-apps/elastos-node-manager/state/**'],
                    write: ['data/installed-apps/elastos-node-manager/state/**'],
                },
                ports: { tcp: [20336, 20338], publish: true },
                env: ['PATH', 'HOME', 'LANG'],
                imports: ['service:database', 'service:audit'],
            },
        },
        assets: [
            {
                id: 'ela-binary',
                url: 'https://download.elastos.io/ela/0.9.9.5/ela-linux-x64.tgz',
                sha256: 'a'.repeat(64),
                signature: 'b'.repeat(128),
                arch: 'linux-x64',
                sizeBytes: 41943040,   // ~40 MB
                fetchOn: 'install',
                extractTo: 'data/installed-apps/elastos-node-manager/bin/',
            },
        ],
        distribution: {
            cid: 'bafy' + 'c'.repeat(50),
            manifestDigest: 'd'.repeat(64),
            signature: 'e'.repeat(128),
            signedBy: '7f3a' + 'f'.repeat(56) + 'd8e4',
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('truncateKey: shortens to ~10-char display', (t) => {
    if (skipIfMissing(t)) return;
    assert.equal(truncateKey('7f3a' + 'f'.repeat(56) + 'd8e4'), '7f3a…d8e4');
    assert.equal(truncateKey('abc'), 'abc');   // short keys passed through
});

test('formatBytes: KB/MB/GB output', (t) => {
    if (skipIfMissing(t)) return;
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(1024), '~1.0 KB');
    assert.equal(formatBytes(1024 * 1024), '~1.0 MB');
    assert.equal(formatBytes(40 * 1024 * 1024), '~40 MB');
    assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '~1.5 GB');
});

// ---------------------------------------------------------------------------
// describeConsent — full output shape
// ---------------------------------------------------------------------------

test('describeConsent: returns publisher block with truncated key', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        assert.equal(desc.publisher.keyHex, '7f3a' + 'f'.repeat(56) + 'd8e4');
        assert.equal(desc.publisher.keyDisplay, '7f3a…d8e4');
        assert.match(desc.publisher.displayName, /Unknown publisher/);
    });
});

test('describeConsent: uses opts.publisherDisplayName when provided', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest(), {
            publisherDisplayName: 'ElacityLabs',
        });
        assert.equal(desc.publisher.displayName, 'ElacityLabs');
    });
});

test('describeConsent: capsule block has name + title + version + kind', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        assert.equal(desc.capsule.name, 'elastos-node-manager');
        assert.equal(desc.capsule.title, 'Elastos Node Manager');
        assert.equal(desc.capsule.version, '0.5.0');
        assert.equal(desc.capsule.kind, 'hybrid');
    });
});

test('describeConsent: title falls back to name if absent', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest(); delete m.title;
        const desc = describeConsent(m);
        assert.equal(desc.capsule.title, m.name);
    });
});

test('describeConsent: trust headline + caveat are identical across capsules', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m1 = validManifest(); m1.name = 'capsule-a';
        const m2 = validManifest(); m2.name = 'capsule-b';
        m2.distribution.signedBy = 'aaaa' + 'b'.repeat(56) + 'cccc';
        const d1 = describeConsent(m1);
        const d2 = describeConsent(m2);
        assert.equal(d1.trustHeadline, d2.trustHeadline);
        assert.equal(d1.trustCaveat, d2.trustCaveat);
        assert.match(d1.trustHeadline, /trusting the publisher/i);
        // The caveat reinforces "this is publisher-stated, not enforced"
        // — operators learn "PC2 will not prevent" once via the headline,
        // and the caveat re-anchors with "not a runtime guarantee".
        assert.match(d1.trustCaveat, /not a runtime guarantee/i);
    });
});

// ---------------------------------------------------------------------------
// Capability rendering — every kind
// ---------------------------------------------------------------------------

test('capabilities: spawnProcesses summarised with backticked names', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        const spawn = desc.capabilities.find(c => c.kind === 'spawnProcesses');
        assert.ok(spawn, 'spawnProcesses capability should appear');
        assert.match(spawn.summary, /`ela`/);
        assert.match(spawn.summary, /`ela-cli`/);
        assert.equal(spawn.detail.length, 2);
    });
});

test('capabilities: filesystem merges read+write into mode markers', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        const fs = desc.capabilities.find(c => c.kind === 'filesystem');
        assert.ok(fs);
        assert.equal(fs.detail.length, 1);
        assert.match(fs.detail[0], /read\+write/);
    });
});

test('capabilities: ports renders host-published vs loopback distinction', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest();
        const desc1 = describeConsent(m);
        const ports1 = desc1.capabilities.find(c => c.kind === 'ports');
        assert.match(ports1.summary, /will be reachable from outside/);

        m.backend.capabilities.ports.publish = false;
        const desc2 = describeConsent(m);
        const ports2 = desc2.capabilities.find(c => c.kind === 'ports');
        assert.match(ports2.summary, /loopback/);
    });
});

test('capabilities: env lists variables', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        const env = desc.capabilities.find(c => c.kind === 'env');
        assert.ok(env);
        assert.match(env.summary, /PATH/);
        assert.match(env.summary, /HOME/);
        assert.match(env.summary, /LANG/);
    });
});

test('capabilities: imports lists service names', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        const imp = desc.capabilities.find(c => c.kind === 'imports');
        assert.ok(imp);
        assert.match(imp.summary, /database/);
        assert.match(imp.summary, /audit/);
    });
});

test('capabilities: empty when manifest has no capabilities block', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest(); delete m.backend.capabilities;
        const desc = describeConsent(m);
        assert.equal(desc.capabilities.length, 0);
    });
});

test('capabilities: only includes the kinds actually declared', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest();
        m.backend.capabilities = { spawnProcesses: ['foo'] };  // ports etc. omitted
        const desc = describeConsent(m);
        assert.equal(desc.capabilities.length, 1);
        assert.equal(desc.capabilities[0].kind, 'spawnProcesses');
    });
});

// ---------------------------------------------------------------------------
// Asset rendering
// ---------------------------------------------------------------------------

test('assets: filtered by host arch', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-arm64', () => {
        // x64 asset is hidden when host is arm64
        const desc = describeConsent(validManifest());
        assert.equal(desc.assets.length, 0,
            'x64 asset should not appear in consent for arm64 host');
        assert.equal(desc.totalDownloadBytes, 0);
    });
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        assert.equal(desc.assets.length, 1);
    });
});

test('assets: english description includes size + source host + when', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const desc = describeConsent(validManifest());
        const asset = desc.assets[0];
        assert.match(asset.englishDescription, /~40 MB/);
        assert.match(asset.englishDescription, /download\.elastos\.io/);
        assert.match(asset.englishDescription, /after install/);
        assert.equal(asset.sourceHost, 'download.elastos.io');
    });
});

test('assets: first-run assets show "on first run" text', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest();
        m.assets[0].fetchOn = 'first-run';
        const desc = describeConsent(m);
        assert.match(desc.assets[0].englishDescription, /on first run/);
    });
});

test('totalDownloadBytes: sums only install-time assets', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest();
        m.assets.push({
            id: 'first-run-binary',
            url: 'https://download.elastos.io/extra/x.tgz',
            sha256: 'a'.repeat(64),
            signature: 'b'.repeat(128),
            arch: 'linux-x64',
            sizeBytes: 10 * 1024 * 1024,   // 10 MB, but first-run
            fetchOn: 'first-run',
            extractTo: 'data/installed-apps/elastos-node-manager/extra/',
        });
        const desc = describeConsent(m);
        // Only the original 40 MB install-time asset counts
        assert.equal(desc.totalDownloadBytes, 41943040);
        assert.equal(desc.totalDownloadDisplay, '~40 MB');
    });
});

test('assets: empty list when manifest has no assets', (t) => {
    if (skipIfMissing(t)) return;
    withArch('linux-x64', () => {
        const m = validManifest(); delete m.assets;
        const desc = describeConsent(m);
        assert.equal(desc.assets.length, 0);
        assert.equal(desc.totalDownloadBytes, 0);
        assert.equal(desc.totalDownloadDisplay, '0 B');
    });
});

// ---------------------------------------------------------------------------
// hostArch override
// ---------------------------------------------------------------------------

test('describeConsent: opts.hostArch overrides platform detection', (t) => {
    if (skipIfMissing(t)) return;
    // Without setting the resolver — pass via opts directly
    const desc = describeConsent(validManifest(), { hostArch: 'linux-x64' });
    assert.equal(desc.assets.length, 1);
    const desc2 = describeConsent(validManifest(), { hostArch: 'darwin-arm64' });
    assert.equal(desc2.assets.length, 0);
});
