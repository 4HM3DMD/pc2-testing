/**
 * CapsuleManifest — schema, types, and validator for hybrid capsules.
 *
 * Hybrid capsules are the v0.3 deployment shape for PC2 apps that ship
 * BOTH a frontend and a privileged backend in one package. Format is
 * specified in `enm-server/docs/wave7-extension-migration.md` (the
 * Wave 7 hybrid-capsule plan, replacing the original "collapse into
 * PC2 image" approach).
 *
 * This module is the foundation for the install pipeline:
 *   - Parses + validates `app.json` against the v0.3 schema
 *   - Throws `CapsuleManifestError` (with `field` location) on any
 *     malformed input
 *   - Defines the reserved-path denylist that backend `dataDir` and
 *     filesystem allow-lists must respect
 *
 * Trust model note: capabilities declared here are DISCLOSURE for the
 * operator's consent screen, not enforced allow-lists. PC2 cannot
 * meaningfully wrap `child_process.spawn` etc. in-process. The actual
 * security boundary is the publisher's Ed25519 signature; see
 * `CapsuleSignature.ts`. The hard rules in this module (ban
 * `postinstall`, native modules, remote URLs in `extractTo`, etc.)
 * are publish-time hygiene that a malicious publisher could bypass —
 * worth catching benign mistakes, not a guard against compromise.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const ED25519_PUBKEY_HEX_RE = /^[0-9a-fA-F]{64}$/;
const ED25519_SIG_HEX_RE = /^[0-9a-fA-F]{128}$/;
const CID_RE = /^(bafy|Qm)[a-zA-Z0-9]{10,}$/;
const ENGINE_NODE_RE = /^[<>=^~* 0-9.x]+$/;
const ENGINE_PC2_RE = /^[<>=^~* 0-9.x]+$/;

/**
 * Reserved roots a capsule's `dataDir` must NOT shadow. Catches the
 * obvious "let me write into the operator's wallet store" attack +
 * the less-obvious "shadow another installed app's data" mistake.
 *
 * Compared after canonicalization (POSIX-style, lowercased — defends
 * against macOS case-insensitive collision per A8 finding).
 */
export const RESERVED_DATADIR_ROOTS: readonly string[] = Object.freeze([
    'data/wallets/',
    'data/credentials/',
    'data/secrets/',
    'data/encryption.key',
    'data/installed-apps/',  // each capsule gets its own subdir; a capsule
                             // CANNOT claim the whole tree
    'data/dev-apps/',
    'data/test-apps/',
    'data/agents/',
    '/etc/',
    '/root/',
    '/home/',
    '/var/',
    '/usr/',
    '/sys/',
    '/proc/',
]);

/**
 * Privileged TCP ports operators should not be casually exposing to
 * a third-party capsule. Hard reject at install time. (Operator can
 * still bind these manually outside PC2; the rule is "we don't help.")
 */
export const PRIVILEGED_PORTS: ReadonlySet<number> = new Set([
    22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995,
    3306, 5432, 6379, 27017,  // common DB ports
    5353,                     // mDNS
]);

/**
 * Maximum reasonable shutdown timeout. A capsule that says "give me
 * 10 minutes to shut down" is misbehaving; cap to 5 minutes.
 */
export const MAX_SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// Type definitions
// =============================================================================

export type CapsuleKind = 'hybrid';
export type CapsuleChannel = 'stable' | 'beta' | 'nightly';
export type AssetFetchOn = 'install' | 'first-run';

export interface CapsuleEngines {
    /** Node.js range (npm-style, e.g. ">=20 <23") */
    node: string;
    /** PC2 host range (npm-style, e.g. "^1.2") */
    pc2: string;
}

export interface CapsuleFrontend {
    /** Path to the frontend HTML entry, relative to the bundle's `app/` */
    entry: string;
}

export interface CapsuleCapabilities {
    /** Binary basenames the backend may spawn (e.g. ["ela", "ela-cli"]) */
    spawnProcesses?: string[];
    /** Filesystem globs the backend may read / write */
    filesystem?: {
        read?: string[];
        write?: string[];
    };
    /** TCP ports the backend may bind. `publish: true` requires a host port-mapping. */
    ports?: {
        tcp?: number[];
        publish?: boolean;
    };
    /** Environment variables the backend's child env should include */
    env?: string[];
    /** PC2 internal services the backend may import (e.g. "service:database") */
    imports?: string[];
}

export interface CapsuleBackend {
    /** Path to the backend code, relative to the bundle root (e.g. "backend/") */
    path: string;
    /**
     * Whether INSTALL needs a PC2 restart. v1: lazy-load means install does
     * not require restart. UPDATE always requires restart in v1.
     */
    needsRestart: boolean;
    /** Persistent on-disk state schema version. Increments trigger migrate(). */
    schemaVersion: number;
    /** Where the backend's persistent state lives, relative to PC2 data root. */
    dataDir: string;
    /** Max time the backend's shutdown() hook may take before force-terminate. */
    shutdownTimeoutMs?: number;
    capabilities?: CapsuleCapabilities;
}

export interface CapsuleAsset {
    /** Stable identifier within the manifest (referenced from logs/UI) */
    id: string;
    /** Primary HTTPS URL */
    url: string;
    /** Fallback locations (HTTPS or ipfs://) — same content, CID/hash verified */
    mirrors?: string[];
    /** SHA-256 of the asset content, lower-case hex */
    sha256: string;
    /** Ed25519 signature over the asset's sha256 bytes, hex */
    signature: string;
    /** Architecture target, e.g. "linux-x64", "linux-arm64" */
    arch: string;
    /** Expected size in bytes (preflight disk check; real size must match) */
    sizeBytes: number;
    /** When to fetch — "install" blocks install completion, "first-run" defers */
    fetchOn: AssetFetchOn;
    /** Where to extract, relative to PC2 data root (must be inside the dataDir tree) */
    extractTo: string;
}

export interface CapsuleDistribution {
    /** IPFS CID of the bundle tar.gz */
    cid: string;
    /** Optional HTTPS / ipfs:// fallback locations for the bundle */
    mirrors?: string[];
    /**
     * SHA-256 of the canonicalized manifest (everything except `signature`
     * + `manifestDigest` themselves). The signature is over THIS digest,
     * not over raw bundle bytes — so capabilities, version, name, signedBy
     * are all committed. Closes the A2 critique gap.
     */
    manifestDigest: string;
    /** Ed25519 signature (hex) over the manifestDigest bytes */
    signature: string;
    /** 32-byte Ed25519 publisher public key, hex */
    signedBy: string;
}

export interface CapsuleManifest {
    name: string;
    version: string;
    kind: CapsuleKind;
    channel?: CapsuleChannel;

    // Optional display metadata (operator-facing in dApp Centre)
    title?: string;
    description?: string;
    author?: string;
    icon?: string;

    engines: CapsuleEngines;
    frontend: CapsuleFrontend;
    backend: CapsuleBackend;
    assets?: CapsuleAsset[];
    distribution: CapsuleDistribution;
}

// =============================================================================
// Errors
// =============================================================================

export class CapsuleManifestError extends Error {
    public readonly field: string;
    public readonly value?: unknown;

    constructor(field: string, message: string, value?: unknown) {
        super(`${field}: ${message}`);
        this.name = 'CapsuleManifestError';
        this.field = field;
        this.value = value;
    }
}

// =============================================================================
// Validator
// =============================================================================

/**
 * Validate raw JSON-parsed input against the v0.3 capsule manifest schema.
 * Returns the typed manifest on success. Throws `CapsuleManifestError` on
 * any violation, with the offending field path attached.
 */
export function validateCapsuleManifest(raw: unknown): CapsuleManifest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CapsuleManifestError('(root)', 'manifest must be a JSON object', raw);
    }
    const m = raw as Record<string, unknown>;

    requireString(m, 'name', NAME_RE,
        'name must be lowercase letters/digits/hyphens, starting and ending with alphanum');
    requireString(m, 'version', SEMVER_RE,
        'version must be a valid semver (MAJOR.MINOR.PATCH[-pre][+meta])');

    if (m.kind !== 'hybrid') {
        throw new CapsuleManifestError('kind', 'must be "hybrid" (only kind defined in v0.3)', m.kind);
    }

    if (m.channel !== undefined && !['stable', 'beta', 'nightly'].includes(m.channel as string)) {
        throw new CapsuleManifestError('channel', 'must be "stable", "beta", or "nightly"', m.channel);
    }

    optionalString(m, 'title');
    optionalString(m, 'description');
    optionalString(m, 'author');
    optionalString(m, 'icon');

    validateEngines(m.engines);
    validateFrontend(m.frontend);
    validateBackend(m.backend);
    if (m.assets !== undefined) {
        validateAssets(m.assets);
    }
    validateDistribution(m.distribution);

    return m as unknown as CapsuleManifest;
}

function validateEngines(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CapsuleManifestError('engines', 'must be an object with `node` and `pc2`', raw);
    }
    const e = raw as Record<string, unknown>;
    requireString(e, 'node', ENGINE_NODE_RE,
        'engines.node must be a valid range expression (e.g. ">=20 <23")', 'engines.node');
    requireString(e, 'pc2', ENGINE_PC2_RE,
        'engines.pc2 must be a valid range expression (e.g. "^1.2")', 'engines.pc2');
}

function validateFrontend(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CapsuleManifestError('frontend', 'must be an object with `entry`', raw);
    }
    const f = raw as Record<string, unknown>;
    if (typeof f.entry !== 'string' || f.entry.length === 0) {
        throw new CapsuleManifestError('frontend.entry', 'must be a non-empty string', f.entry);
    }
    rejectPathTraversal('frontend.entry', f.entry);
}

function validateBackend(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CapsuleManifestError('backend', 'must be an object', raw);
    }
    const b = raw as Record<string, unknown>;

    if (typeof b.path !== 'string' || b.path.length === 0) {
        throw new CapsuleManifestError('backend.path', 'must be a non-empty string', b.path);
    }
    rejectPathTraversal('backend.path', b.path);

    if (typeof b.needsRestart !== 'boolean') {
        throw new CapsuleManifestError('backend.needsRestart', 'must be a boolean', b.needsRestart);
    }

    if (!Number.isInteger(b.schemaVersion) || (b.schemaVersion as number) < 1) {
        throw new CapsuleManifestError('backend.schemaVersion', 'must be a positive integer', b.schemaVersion);
    }

    if (typeof b.dataDir !== 'string' || b.dataDir.length === 0) {
        throw new CapsuleManifestError('backend.dataDir', 'must be a non-empty string', b.dataDir);
    }
    rejectPathTraversal('backend.dataDir', b.dataDir);
    rejectReservedDataDir('backend.dataDir', b.dataDir);

    if (b.shutdownTimeoutMs !== undefined) {
        if (!Number.isInteger(b.shutdownTimeoutMs) || (b.shutdownTimeoutMs as number) < 0
            || (b.shutdownTimeoutMs as number) > MAX_SHUTDOWN_TIMEOUT_MS) {
            throw new CapsuleManifestError('backend.shutdownTimeoutMs',
                `must be an integer in [0, ${MAX_SHUTDOWN_TIMEOUT_MS}]`, b.shutdownTimeoutMs);
        }
    }

    if (b.capabilities !== undefined) {
        validateCapabilities(b.capabilities, b.dataDir as string);
    }
}

function validateCapabilities(raw: unknown, dataDir: string): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CapsuleManifestError('backend.capabilities', 'must be an object', raw);
    }
    const c = raw as Record<string, unknown>;

    if (c.spawnProcesses !== undefined) {
        requireStringArray('backend.capabilities.spawnProcesses', c.spawnProcesses);
        for (const p of c.spawnProcesses as string[]) {
            if (p.includes('/') || p.includes('\\')) {
                throw new CapsuleManifestError('backend.capabilities.spawnProcesses',
                    `must list bare binary names without paths; got "${p}"`, p);
            }
        }
    }

    if (c.filesystem !== undefined) {
        if (!c.filesystem || typeof c.filesystem !== 'object' || Array.isArray(c.filesystem)) {
            throw new CapsuleManifestError('backend.capabilities.filesystem', 'must be an object', c.filesystem);
        }
        const fs = c.filesystem as Record<string, unknown>;
        if (fs.read !== undefined) {
            requireStringArray('backend.capabilities.filesystem.read', fs.read);
            for (const g of fs.read as string[]) {
                rejectPathTraversal('backend.capabilities.filesystem.read', g);
            }
        }
        if (fs.write !== undefined) {
            requireStringArray('backend.capabilities.filesystem.write', fs.write);
            for (const g of fs.write as string[]) {
                rejectPathTraversal('backend.capabilities.filesystem.write', g);
                // Writes must stay inside the declared dataDir tree.
                const dataDirGlob = canonPath(dataDir).replace(/\/$/, '') + '/**';
                if (canonPath(g) !== canonPath(dataDir).replace(/\/$/, '') + '/**'
                    && !canonPath(g).startsWith(canonPath(dataDir))) {
                    throw new CapsuleManifestError('backend.capabilities.filesystem.write',
                        `write glob "${g}" must live inside dataDir (got dataDir="${dataDir}", expected glob like "${dataDirGlob}")`, g);
                }
            }
        }
    }

    if (c.ports !== undefined) {
        if (!c.ports || typeof c.ports !== 'object' || Array.isArray(c.ports)) {
            throw new CapsuleManifestError('backend.capabilities.ports', 'must be an object', c.ports);
        }
        const p = c.ports as Record<string, unknown>;
        if (p.tcp !== undefined) {
            if (!Array.isArray(p.tcp)) {
                throw new CapsuleManifestError('backend.capabilities.ports.tcp', 'must be an array of integers', p.tcp);
            }
            for (const port of p.tcp) {
                if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
                    throw new CapsuleManifestError('backend.capabilities.ports.tcp',
                        `port must be an integer in [1, 65535]; got ${port}`, port);
                }
                if (PRIVILEGED_PORTS.has(port as number)) {
                    throw new CapsuleManifestError('backend.capabilities.ports.tcp',
                        `port ${port} is on the privileged-ports denylist`, port);
                }
            }
        }
        if (p.publish !== undefined && typeof p.publish !== 'boolean') {
            throw new CapsuleManifestError('backend.capabilities.ports.publish', 'must be a boolean', p.publish);
        }
    }

    if (c.env !== undefined) {
        requireStringArray('backend.capabilities.env', c.env);
        for (const v of c.env as string[]) {
            if (!/^[A-Z_][A-Z0-9_]*$/.test(v)) {
                throw new CapsuleManifestError('backend.capabilities.env',
                    `env var name "${v}" must match POSIX [A-Z_][A-Z0-9_]*`, v);
            }
        }
    }

    if (c.imports !== undefined) {
        requireStringArray('backend.capabilities.imports', c.imports);
        for (const imp of c.imports as string[]) {
            if (!/^service:[a-z][a-z0-9-]*$/.test(imp)) {
                throw new CapsuleManifestError('backend.capabilities.imports',
                    `import "${imp}" must match service:<name> with lowercase service name`, imp);
            }
        }
    }
}

function validateAssets(raw: unknown): void {
    if (!Array.isArray(raw)) {
        throw new CapsuleManifestError('assets', 'must be an array', raw);
    }
    const ids = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
        const a = raw[i];
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
            throw new CapsuleManifestError(`assets[${i}]`, 'must be an object', a);
        }
        const asset = a as Record<string, unknown>;
        const path = `assets[${i}]`;

        if (typeof asset.id !== 'string' || asset.id.length === 0) {
            throw new CapsuleManifestError(`${path}.id`, 'must be a non-empty string', asset.id);
        }
        if (ids.has(asset.id as string)) {
            throw new CapsuleManifestError(`${path}.id`, `duplicate asset id "${asset.id}"`, asset.id);
        }
        ids.add(asset.id as string);

        requireString(asset, 'url', /^https:\/\//, 'must be an https:// URL', `${path}.url`);
        requireString(asset, 'sha256', SHA256_RE,
            'must be 64 lowercase hex chars (sha-256)', `${path}.sha256`);
        requireString(asset, 'signature', ED25519_SIG_HEX_RE,
            'must be 128 hex chars (Ed25519 signature)', `${path}.signature`);
        requireString(asset, 'arch', /^[a-z0-9]+-[a-z0-9_]+$/,
            'must match <os>-<arch> (e.g. linux-x64)', `${path}.arch`);

        if (!Number.isInteger(asset.sizeBytes) || (asset.sizeBytes as number) < 1) {
            throw new CapsuleManifestError(`${path}.sizeBytes`, 'must be a positive integer', asset.sizeBytes);
        }

        if (asset.fetchOn !== 'install' && asset.fetchOn !== 'first-run') {
            throw new CapsuleManifestError(`${path}.fetchOn`,
                'must be "install" or "first-run"', asset.fetchOn);
        }

        if (typeof asset.extractTo !== 'string' || asset.extractTo.length === 0) {
            throw new CapsuleManifestError(`${path}.extractTo`, 'must be a non-empty string', asset.extractTo);
        }
        rejectPathTraversal(`${path}.extractTo`, asset.extractTo as string);
        rejectReservedDataDir(`${path}.extractTo`, asset.extractTo as string);

        if (asset.mirrors !== undefined) {
            requireStringArray(`${path}.mirrors`, asset.mirrors);
            for (const u of asset.mirrors as string[]) {
                if (!/^(https:\/\/|ipfs:\/\/)/.test(u)) {
                    throw new CapsuleManifestError(`${path}.mirrors`,
                        `mirror "${u}" must be https:// or ipfs://`, u);
                }
            }
        }
    }
}

function validateDistribution(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CapsuleManifestError('distribution', 'must be an object', raw);
    }
    const d = raw as Record<string, unknown>;
    requireString(d, 'cid', CID_RE, 'must be a valid IPFS CID', 'distribution.cid');
    requireString(d, 'manifestDigest', SHA256_RE,
        'must be 64 hex chars (sha-256 of canonicalized manifest)', 'distribution.manifestDigest');
    requireString(d, 'signature', ED25519_SIG_HEX_RE,
        'must be 128 hex chars (Ed25519 signature)', 'distribution.signature');
    requireString(d, 'signedBy', ED25519_PUBKEY_HEX_RE,
        'must be 64 hex chars (32-byte Ed25519 publisher pubkey)', 'distribution.signedBy');

    if (d.mirrors !== undefined) {
        requireStringArray('distribution.mirrors', d.mirrors);
        for (const u of d.mirrors as string[]) {
            if (!/^(https:\/\/|ipfs:\/\/)/.test(u)) {
                throw new CapsuleManifestError('distribution.mirrors',
                    `mirror "${u}" must be https:// or ipfs://`, u);
            }
        }
    }
}

// =============================================================================
// Helpers
// =============================================================================

function requireString(
    obj: Record<string, unknown>,
    field: string,
    pattern: RegExp,
    message: string,
    fieldPath?: string,
): void {
    const v = obj[field];
    if (typeof v !== 'string' || v.length === 0) {
        throw new CapsuleManifestError(fieldPath ?? field, `must be a non-empty string`, v);
    }
    if (!pattern.test(v)) {
        throw new CapsuleManifestError(fieldPath ?? field, message, v);
    }
}

function optionalString(obj: Record<string, unknown>, field: string): void {
    const v = obj[field];
    if (v === undefined) return;
    if (typeof v !== 'string') {
        throw new CapsuleManifestError(field, 'must be a string when present', v);
    }
}

function requireStringArray(fieldPath: string, raw: unknown): void {
    if (!Array.isArray(raw)) {
        throw new CapsuleManifestError(fieldPath, 'must be an array of strings', raw);
    }
    for (const v of raw) {
        if (typeof v !== 'string' || v.length === 0) {
            throw new CapsuleManifestError(fieldPath, 'array items must be non-empty strings', v);
        }
    }
}

function rejectPathTraversal(fieldPath: string, value: string): void {
    if (value.includes('..') || value.includes('\0')) {
        throw new CapsuleManifestError(fieldPath, `path traversal not allowed: "${value}"`, value);
    }
    if (value.startsWith('//') || /^[a-zA-Z]:[\\/]/.test(value)) {
        throw new CapsuleManifestError(fieldPath, `absolute path not allowed: "${value}"`, value);
    }
}

function rejectReservedDataDir(fieldPath: string, value: string): void {
    const canon = canonPath(value);
    for (const reserved of RESERVED_DATADIR_ROOTS) {
        const reservedCanon = canonPath(reserved);
        // `dataDir` either IS a reserved root, or sits directly under
        // `data/installed-apps/` (allowed; that's where capsules live).
        if (canon === reservedCanon || canon.startsWith(reservedCanon)) {
            // Special carve-out: a capsule MAY have its dataDir under
            // `data/installed-apps/<own-name>/state/` — but the caller
            // doesn't know the capsule's name yet at this layer. The
            // carve-out is enforced at the install layer (M2) once the
            // canonical install path is computed. Here we only reject
            // claiming the SHARED prefix root (the trailing slash).
            if (canon === canonPath('data/installed-apps/')) {
                throw new CapsuleManifestError(fieldPath,
                    `cannot claim the shared root "${reserved}"; use a subdirectory under your capsule name`, value);
            }
            // The other reserved roots: hard reject in all cases.
            if (reserved !== 'data/installed-apps/') {
                throw new CapsuleManifestError(fieldPath,
                    `path "${value}" overlaps reserved root "${reserved}"`, value);
            }
        }
    }
}

/**
 * Canonicalize a filesystem-style path for comparison: forward slashes,
 * lowercased (defends against macOS case-insensitive collision per A8),
 * trailing slash preserved if present.
 */
export function canonPath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}
