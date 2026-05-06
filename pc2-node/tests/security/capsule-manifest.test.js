/**
 * SPEC: CapsuleManifest validator
 *
 * Helper location:
 *   pc2-node/src/services/CapsuleManifest.ts
 *
 * Purpose:
 *   Validates raw JSON-parsed input against the v0.3 hybrid capsule
 *   manifest schema. Returns the typed manifest on success; throws
 *   CapsuleManifestError (with `field` location) on any violation.
 *
 *   Tested cases below cover: required-field presence, format checks,
 *   reserved-path denylist, privileged-port denylist, glob containment
 *   inside dataDir, and capability shape.
 *
 *   Foundation for M2 (atomic extraction) which consumes the typed
 *   manifest and trusts the schema-level invariants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HELPER_PATH = '../../src/services/CapsuleManifest.js';
let validateCapsuleManifest, CapsuleManifestError, RESERVED_DATADIR_ROOTS, PRIVILEGED_PORTS;

try {
    ({
        validateCapsuleManifest,
        CapsuleManifestError,
        RESERVED_DATADIR_ROOTS,
        PRIVILEGED_PORTS,
    } = await import(HELPER_PATH));
} catch (err) {
    console.warn(`[spec] CapsuleManifest not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
    if (!validateCapsuleManifest) {
        t.skip('CapsuleManifest helper not yet implemented (Wave 7 / M1)');
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validManifest() {
    return {
        name: 'elastos-node-manager',
        version: '0.5.0',
        kind: 'hybrid',
        channel: 'stable',
        title: 'Elastos Node Manager',
        engines: { node: '>=20 <23', pc2: '^1.2' },
        frontend: { entry: 'app/index.html' },
        backend: {
            path: 'backend/',
            needsRestart: false,
            schemaVersion: 1,
            dataDir: 'data/installed-apps/elastos-node-manager/state/',
            shutdownTimeoutMs: 30000,
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
                url: 'https://download.elastos.io/ela/0.9.9.5/ela-0.9.9.5-linux-x64.tgz',
                mirrors: ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
                sha256: 'a'.repeat(64),
                signature: 'b'.repeat(128),
                arch: 'linux-x64',
                sizeBytes: 41943040,
                fetchOn: 'install',
                extractTo: 'data/installed-apps/elastos-node-manager/bin/',
            },
        ],
        distribution: {
            cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
            mirrors: ['https://download.elastos.io/ext/0.5.0.tar.gz'],
            manifestDigest: 'c'.repeat(64),
            signature: 'd'.repeat(128),
            signedBy: 'e'.repeat(64),
        },
    };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('valid manifest passes and returns the same object', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    const result = validateCapsuleManifest(m);
    assert.equal(result.name, 'elastos-node-manager');
    assert.equal(result.kind, 'hybrid');
    assert.equal(result.backend.capabilities.spawnProcesses[0], 'ela');
});

test('minimal manifest (no optional fields) passes', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    delete m.channel; delete m.title; delete m.assets;
    delete m.backend.shutdownTimeoutMs; delete m.backend.capabilities;
    delete m.distribution.mirrors;
    assert.doesNotThrow(() => validateCapsuleManifest(m));
});

// ---------------------------------------------------------------------------
// Required-field rejections
// ---------------------------------------------------------------------------

test('rejects null/undefined/array root', (t) => {
    if (skipIfMissing(t)) return;
    assert.throws(() => validateCapsuleManifest(null), { name: 'CapsuleManifestError', field: '(root)' });
    assert.throws(() => validateCapsuleManifest(undefined), { name: 'CapsuleManifestError' });
    assert.throws(() => validateCapsuleManifest([]), { name: 'CapsuleManifestError' });
    assert.throws(() => validateCapsuleManifest('not-an-object'), { name: 'CapsuleManifestError' });
});

test('rejects missing name', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); delete m.name;
    assert.throws(() => validateCapsuleManifest(m), { field: 'name' });
});

test('rejects malformed name (uppercase, leading hyphen, etc.)', (t) => {
    if (skipIfMissing(t)) return;
    for (const bad of ['Capsule', '-capsule', 'capsule-', 'cap_sule', 'cap sule', '']) {
        const m = validManifest(); m.name = bad;
        assert.throws(() => validateCapsuleManifest(m), { field: 'name' }, `should reject name="${bad}"`);
    }
});

test('rejects non-semver version', (t) => {
    if (skipIfMissing(t)) return;
    for (const bad of ['1', '1.0', '1.0.0.0', 'v1.0.0', 'latest', '']) {
        const m = validManifest(); m.version = bad;
        assert.throws(() => validateCapsuleManifest(m), { field: 'version' }, `should reject version="${bad}"`);
    }
});

test('rejects unknown kind', (t) => {
    if (skipIfMissing(t)) return;
    for (const bad of ['web', 'wasm', 'data', 'microvm', 'agent', '', null]) {
        const m = validManifest(); m.kind = bad;
        assert.throws(() => validateCapsuleManifest(m), { field: 'kind' }, `should reject kind=${JSON.stringify(bad)}`);
    }
});

test('rejects unknown channel', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.channel = 'experimental';
    assert.throws(() => validateCapsuleManifest(m), { field: 'channel' });
});

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

test('rejects missing engines', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); delete m.engines;
    assert.throws(() => validateCapsuleManifest(m), { field: 'engines' });
});

test('rejects engines without node or pc2', (t) => {
    if (skipIfMissing(t)) return;
    const m1 = validManifest(); delete m1.engines.node;
    assert.throws(() => validateCapsuleManifest(m1), { field: 'engines.node' });
    const m2 = validManifest(); delete m2.engines.pc2;
    assert.throws(() => validateCapsuleManifest(m2), { field: 'engines.pc2' });
});

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

test('rejects missing frontend.entry', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.frontend = {};
    assert.throws(() => validateCapsuleManifest(m), { field: 'frontend.entry' });
});

test('rejects path traversal in frontend.entry', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.frontend.entry = '../../../etc/passwd';
    assert.throws(() => validateCapsuleManifest(m), { field: 'frontend.entry' });
});

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

test('rejects backend without required fields', (t) => {
    if (skipIfMissing(t)) return;
    for (const field of ['path', 'needsRestart', 'schemaVersion', 'dataDir']) {
        const m = validManifest(); delete m.backend[field];
        assert.throws(() => validateCapsuleManifest(m), (err) => err.field.startsWith(`backend.${field}`),
            `should reject missing backend.${field}`);
    }
});

test('rejects backend.needsRestart that is not a boolean', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.needsRestart = 'true';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.needsRestart' });
});

test('rejects negative schemaVersion', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.schemaVersion = 0;
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.schemaVersion' });
});

test('rejects shutdownTimeoutMs above the cap', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.shutdownTimeoutMs = 999_999_999;
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.shutdownTimeoutMs' });
});

// ---------------------------------------------------------------------------
// Reserved-path denylist (A8)
// ---------------------------------------------------------------------------

test('rejects dataDir under data/wallets/ (mnemonic store shadow)', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.dataDir = 'data/wallets/';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' });
    m.backend.dataDir = 'data/wallets/loot/';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' });
});

test('rejects dataDir claiming the shared data/installed-apps/ root', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.dataDir = 'data/installed-apps/';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' });
});

test('rejects dataDir at /etc/, /root/, /var/, etc.', (t) => {
    if (skipIfMissing(t)) return;
    for (const bad of ['/etc/', '/root/secrets/', '/var/log/', '/proc/']) {
        const m = validManifest(); m.backend.dataDir = bad;
        assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' },
            `should reject dataDir="${bad}"`);
    }
});

test('rejects path traversal in dataDir', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.dataDir = 'data/installed-apps/foo/../../../etc/';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' });
});

test('rejects absolute Windows path in dataDir', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.dataDir = 'C:\\Users\\evil\\';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' });
});

test('rejects dataDir at macOS-canonicalized reserved path (case-insensitive)', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.backend.dataDir = 'data/WALLETS/';
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.dataDir' });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

test('rejects spawnProcesses entry containing a path separator', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.backend.capabilities.spawnProcesses = ['ela', '/usr/bin/bash'];
    assert.throws(() => validateCapsuleManifest(m),
        { field: 'backend.capabilities.spawnProcesses' });
});

test('rejects filesystem.write glob outside dataDir tree', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.backend.capabilities.filesystem.write = ['data/wallets/**'];
    assert.throws(() => validateCapsuleManifest(m),
        { field: 'backend.capabilities.filesystem.write' });
});

test('rejects privileged TCP ports', (t) => {
    if (skipIfMissing(t)) return;
    for (const port of [22, 80, 443, 5353]) {
        const m = validManifest();
        m.backend.capabilities.ports.tcp = [port];
        assert.throws(() => validateCapsuleManifest(m),
            { field: 'backend.capabilities.ports.tcp' }, `should reject port ${port}`);
    }
});

test('rejects out-of-range TCP ports', (t) => {
    if (skipIfMissing(t)) return;
    for (const port of [0, -1, 65536, 1.5, 'eighty']) {
        const m = validManifest();
        m.backend.capabilities.ports.tcp = [port];
        assert.throws(() => validateCapsuleManifest(m),
            { field: 'backend.capabilities.ports.tcp' }, `should reject port ${port}`);
    }
});

test('rejects malformed env var name', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.backend.capabilities.env = ['lower_case'];
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.capabilities.env' });
});

test('rejects malformed import string', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.backend.capabilities.imports = ['not-a-service-spec'];
    assert.throws(() => validateCapsuleManifest(m), { field: 'backend.capabilities.imports' });
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

test('rejects asset with non-https url', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets[0].url = 'http://insecure.example.com/binary.tgz';
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[0].url' });
});

test('rejects asset with malformed sha256', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets[0].sha256 = 'tooshort';
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[0].sha256' });
});

test('rejects asset with malformed signature length', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets[0].signature = 'aabbcc';
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[0].signature' });
});

test('rejects asset with extractTo under reserved path', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets[0].extractTo = 'data/wallets/loot/';
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[0].extractTo' });
});

test('rejects duplicate asset ids', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets.push({ ...m.assets[0] });   // same id
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[1].id' });
});

test('rejects asset with bad fetchOn value', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets[0].fetchOn = 'someday';
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[0].fetchOn' });
});

test('rejects asset.mirrors entry that is neither https nor ipfs', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest();
    m.assets[0].mirrors = ['ftp://example.com/'];
    assert.throws(() => validateCapsuleManifest(m), { field: 'assets[0].mirrors' });
});

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

test('rejects distribution missing required fields', (t) => {
    if (skipIfMissing(t)) return;
    for (const field of ['cid', 'manifestDigest', 'signature', 'signedBy']) {
        const m = validManifest(); delete m.distribution[field];
        assert.throws(() => validateCapsuleManifest(m),
            (err) => err.field.startsWith(`distribution.${field}`),
            `should reject missing distribution.${field}`);
    }
});

test('rejects distribution.signedBy with wrong length', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.distribution.signedBy = 'aabbcc';
    assert.throws(() => validateCapsuleManifest(m), { field: 'distribution.signedBy' });
});

test('rejects distribution.signature with wrong length', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.distribution.signature = 'aabbcc';
    assert.throws(() => validateCapsuleManifest(m), { field: 'distribution.signature' });
});

test('rejects distribution.cid that does not look like an IPFS CID', (t) => {
    if (skipIfMissing(t)) return;
    const m = validManifest(); m.distribution.cid = 'not-a-cid';
    assert.throws(() => validateCapsuleManifest(m), { field: 'distribution.cid' });
});

// ---------------------------------------------------------------------------
// Constants are exported and sane
// ---------------------------------------------------------------------------

test('RESERVED_DATADIR_ROOTS includes wallets + installed-apps', (t) => {
    if (skipIfMissing(t)) return;
    assert.ok(RESERVED_DATADIR_ROOTS.includes('data/wallets/'));
    assert.ok(RESERVED_DATADIR_ROOTS.includes('data/installed-apps/'));
});

test('PRIVILEGED_PORTS includes 22, 80, 443', (t) => {
    if (skipIfMissing(t)) return;
    assert.ok(PRIVILEGED_PORTS.has(22));
    assert.ok(PRIVILEGED_PORTS.has(80));
    assert.ok(PRIVILEGED_PORTS.has(443));
    assert.ok(!PRIVILEGED_PORTS.has(20336));   // ELA mainchain RPC, allowed
});
