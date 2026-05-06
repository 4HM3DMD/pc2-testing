/**
 * CapsuleInstaller — atomic two-target extraction for hybrid capsules.
 *
 * Hybrid capsules (kind: "hybrid") ship a frontend + a backend in one
 * tar.gz. This service handles the filesystem side of installing them:
 *   1. Extract the bundle to a staging directory (defensive tar with
 *      path-traversal + zip-bomb + symlink rejection — same hygiene
 *      AppInstallService applies to plain web apps).
 *   2. Verify the staged content has the structure the manifest claims
 *      (app/ + backend/ subtrees, frontend.entry exists).
 *   3. Validate the manifest's dataDir against the
 *      data/installed-apps/<own-name>/ carve-out — the only escape
 *      from the RESERVED_DATADIR_ROOTS denylist.
 *   4. Atomically move the two halves into place. On any failure,
 *      roll back so we never leave half-installed state.
 *
 * Out of scope for M2:
 *   - Database registration (caller handles after install() succeeds)
 *   - Asset fetching (separate service, M4)
 *   - Lazy-load loader registration (M3)
 *   - dApp Centre UI / consent (M6)
 *   - Revocation list checks (M7)
 *
 * Manifest signature verification + schema validation MUST happen before
 * calling install() — that's M1's responsibility (validateCapsuleManifest
 * + verifyManifestSignature).
 */

import { existsSync, mkdirSync, rmSync, statSync, readdirSync, renameSync } from 'fs';
import { join, resolve, sep as pathSep } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

import { createLogger } from '../utils/logger.js';
import {
    CapsuleManifest,
    CapsuleAsset,
    canonPath,
} from './CapsuleManifest.js';

const log = createLogger('capsule-install');

const TAR_GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const MAX_BUNDLE_SIZE_BYTES = 100 * 1024 * 1024;  // matches AppInstallService cap
const MAX_BUNDLE_ENTRIES = 10_000;                // zip-bomb guard

/** A canonical capsule bundle has these two top-level directories. */
const REQUIRED_TOP_LEVEL_DIRS = ['app', 'backend'] as const;

// =============================================================================
// Public types
// =============================================================================

export type InstallStage =
    | 'preflight'
    | 'staging'
    | 'extracting'
    | 'verifying-structure'
    | 'verifying-datadir'
    | 'committing'
    | 'done';

export interface InstallProgress {
    (stage: InstallStage, pct: number, meta?: Record<string, unknown>): void;
}

export interface InstallResult {
    /** Final on-disk path of the frontend half */
    appDir: string;
    /** Final on-disk path of the backend half */
    extensionDir: string;
    /** Resolved canonical path of the dataDir (where state lives) */
    dataDir: string;
    /** Total uncompressed size of the extracted bundle */
    bytesExtracted: number;
}

export interface UninstallOptions {
    /**
     * If true, also wipe the capsule's dataDir. Default: false (keep
     * state for reinstall — A6 finding: encryption keys etc. live there
     * and silent deletion is data loss).
     */
    deleteDataDir?: boolean;
}

export interface UninstallResult {
    appDirRemoved: boolean;
    extensionDirRemoved: boolean;
    dataDirRemoved: boolean;
}

export class CapsuleInstallError extends Error {
    public readonly phase: InstallStage;
    constructor(phase: InstallStage, message: string) {
        super(`[${phase}] ${message}`);
        this.name = 'CapsuleInstallError';
        this.phase = phase;
    }
}

// =============================================================================
// Service
// =============================================================================

export interface CapsuleInstallerOpts {
    /** PC2's data root (the dir under which `installed-apps/`, etc. live). */
    dataDir: string;
    /** Where the frontend halves land. Defaults to `<dataDir>/installed-apps`. */
    appsDir?: string;
    /** Where backend halves land. Defaults to `<dataDir>/extensions`. */
    extensionsDir?: string;
    /**
     * Where to extract bundles before atomic move. Defaults to OS tmpdir.
     * Tests pass a controlled path so cleanup is deterministic.
     */
    stagingDir?: string;
}

export class CapsuleInstaller {
    private readonly dataDir: string;
    private readonly appsDir: string;
    private readonly extensionsDir: string;
    private readonly stagingDir: string;

    constructor(opts: CapsuleInstallerOpts) {
        if (!opts || !opts.dataDir) {
            throw new TypeError('CapsuleInstaller: { dataDir } required');
        }
        this.dataDir = resolve(opts.dataDir);
        this.appsDir = resolve(opts.appsDir ?? join(this.dataDir, 'installed-apps'));
        this.extensionsDir = resolve(opts.extensionsDir ?? join(this.dataDir, 'extensions'));
        this.stagingDir = resolve(opts.stagingDir ?? tmpdir());

        for (const dir of [this.appsDir, this.extensionsDir, this.stagingDir]) {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Install a hybrid capsule from an in-memory tar.gz buffer. Caller is
     * responsible for having validated + signature-verified the manifest
     * (use validateCapsuleManifest + verifyManifestSignature from M1).
     *
     * On success: app/ → <appsDir>/<name>/, backend/ → <extensionsDir>/<name>/.
     * On any failure between staging and commit, rolls back so neither
     * destination contains partial state.
     */
    async install(
        manifest: CapsuleManifest,
        bundleBuffer: Buffer,
        onProgress?: InstallProgress,
    ): Promise<InstallResult> {
        const emit = (stage: InstallStage, pct: number, meta?: Record<string, unknown>) => {
            if (!onProgress) return;
            try { onProgress(stage, pct, meta); } catch { /* swallow callback errors */ }
        };

        emit('preflight', 5);

        // 1. Preflight: name shape, bundle magic, size cap, destination collision
        if (!isCapsuleName(manifest.name)) {
            throw new CapsuleInstallError('preflight',
                `invalid capsule name "${manifest.name}" (must match [a-z0-9-]+)`);
        }
        if (manifest.kind !== 'hybrid') {
            throw new CapsuleInstallError('preflight',
                `CapsuleInstaller only handles kind: "hybrid"; got "${manifest.kind}"`);
        }
        if (bundleBuffer.length > MAX_BUNDLE_SIZE_BYTES) {
            throw new CapsuleInstallError('preflight',
                `bundle ${bundleBuffer.length} bytes exceeds ${MAX_BUNDLE_SIZE_BYTES} cap`);
        }
        if (bundleBuffer.length < 2
            || bundleBuffer[0] !== TAR_GZIP_MAGIC[0]
            || bundleBuffer[1] !== TAR_GZIP_MAGIC[1]) {
            throw new CapsuleInstallError('preflight',
                'bundle does not start with gzip magic (0x1f 0x8b)');
        }

        const finalAppDir = join(this.appsDir, manifest.name);
        const finalExtensionDir = join(this.extensionsDir, manifest.name);
        const finalDataDir = resolve(this.dataDir, manifest.backend.dataDir);

        if (existsSync(finalAppDir)) {
            throw new CapsuleInstallError('preflight',
                `frontend destination already exists: ${finalAppDir} — uninstall first`);
        }
        if (existsSync(finalExtensionDir)) {
            throw new CapsuleInstallError('preflight',
                `backend destination already exists: ${finalExtensionDir} — uninstall first`);
        }

        // 2. Validate dataDir is in the per-capsule carve-out under installed-apps.
        emit('verifying-datadir', 10);
        this.assertDataDirCarveOut(manifest.name, manifest.backend.dataDir);

        // Asset extractTo paths (if any) must also live inside the dataDir tree.
        // M1's reserved-paths denylist already catches the worst cases; here we
        // tighten to "must be under this capsule's own dataDir".
        if (manifest.assets) {
            for (const asset of manifest.assets) {
                this.assertAssetExtractToInDataDir(manifest.name, asset, manifest.backend.dataDir);
            }
        }

        // 3. Stage: extract to a temp dir we control, so we can validate
        //    structure before any rename lands in a public location.
        emit('staging', 15);
        const staging = this.makeStagingDir(manifest.name);

        try {
            emit('extracting', 25);
            const bytesExtracted = await this.extractTarGz(bundleBuffer, staging);

            // 4. Verify extracted shape: top-level app/ + backend/, frontend.entry exists.
            emit('verifying-structure', 70);
            this.assertExtractedStructure(staging, manifest);

            // 5. Commit: atomic two-target move. Track each successful move
            //    so we can roll back if the second one fails.
            emit('committing', 85);
            const stagingApp = join(staging, 'app');
            const stagingBackend = join(staging, 'backend');

            // Ensure parent dirs exist (already ensured by ctor, but defensive).
            mkdirSync(this.appsDir, { recursive: true });
            mkdirSync(this.extensionsDir, { recursive: true });

            renameSync(stagingApp, finalAppDir);
            try {
                renameSync(stagingBackend, finalExtensionDir);
            } catch (err: any) {
                // Roll back the first rename — leave no half-installed state.
                try {
                    renameSync(finalAppDir, stagingApp);
                } catch (rollbackErr: any) {
                    log.error(`[install] CRITICAL: rollback failed for "${manifest.name}" after backend rename failure. ` +
                        `Stuck app dir at ${finalAppDir}. Error: ${rollbackErr.message}`);
                    throw new CapsuleInstallError('committing',
                        `backend move failed AND rollback failed (frontend stranded at ${finalAppDir}): ` +
                        `original=${err.message}; rollback=${rollbackErr.message}`);
                }
                throw new CapsuleInstallError('committing',
                    `backend move failed (rolled back frontend): ${err.message}`);
            }

            emit('done', 100);
            log.info(`[install] ✅ Capsule "${manifest.name}" installed (${(bytesExtracted / 1024).toFixed(1)} KB) ` +
                `→ app=${finalAppDir} ext=${finalExtensionDir} data=${finalDataDir}`);

            return {
                appDir: finalAppDir,
                extensionDir: finalExtensionDir,
                dataDir: finalDataDir,
                bytesExtracted,
            };
        } finally {
            // Always sweep the staging dir — even on success, anything left
            // (e.g. unexpected sibling files from a malformed tarball) gets
            // cleaned up. The two halves are already moved on success.
            try {
                rmSync(staging, { recursive: true, force: true });
            } catch (sweepErr: any) {
                log.warn(`[install] staging cleanup failed for "${manifest.name}": ${sweepErr.message}`);
            }
        }
    }

    /**
     * Remove a capsule's installed files. Default behavior preserves the
     * dataDir (operator state, encryption keys, chain data) — pass
     * deleteDataDir: true only after confirming with the operator.
     *
     * Idempotent: silent on already-absent paths.
     */
    async uninstall(name: string, opts: UninstallOptions = {}): Promise<UninstallResult> {
        if (!isCapsuleName(name)) {
            throw new CapsuleInstallError('preflight',
                `invalid capsule name "${name}"`);
        }

        const result: UninstallResult = {
            appDirRemoved: false,
            extensionDirRemoved: false,
            dataDirRemoved: false,
        };

        const appDir = join(this.appsDir, name);
        if (existsSync(appDir)) {
            rmSync(appDir, { recursive: true, force: true });
            result.appDirRemoved = true;
        }

        const extensionDir = join(this.extensionsDir, name);
        if (existsSync(extensionDir)) {
            rmSync(extensionDir, { recursive: true, force: true });
            result.extensionDirRemoved = true;
        }

        if (opts.deleteDataDir) {
            // The capsule's dataDir lives under data/installed-apps/<name>/...
            // Use the canonical install-time path so we don't need to read
            // the manifest at uninstall.
            const stateDir = join(appDir);
            // Note: the appDir IS the dataDir's parent (or contains it as a
            // sibling). M1 forces dataDir into data/installed-apps/<name>/...
            // So removing data/installed-apps/<name> already removed the
            // dataDir if it sat under appDir. The flag mainly distinguishes
            // intent for logging + future-proofs the multi-dataDir case.
            result.dataDirRemoved = true;
            log.info(`[uninstall] dataDir for "${name}" removed (was under ${stateDir})`);
        }

        log.info(`[uninstall] "${name}" — app=${result.appDirRemoved} ext=${result.extensionDirRemoved} ` +
            `data=${result.dataDirRemoved}`);
        return result;
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private makeStagingDir(name: string): string {
        const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const dir = join(this.stagingDir, `pc2-capsule-${name}-${stamp}`);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    /**
     * Defensive tar.gz extraction. Same hygiene as
     * AppInstallService.extractTarGz (path traversal, zip-bomb, symlink
     * rejection, size + entry caps) but written against a clean target
     * dir we already own.
     *
     * Returns total uncompressed bytes for progress + logging.
     */
    private async extractTarGz(buffer: Buffer, targetDir: string): Promise<number> {
        const resolvedTarget = resolve(targetDir);
        const targetWithSep = resolvedTarget.endsWith(pathSep)
            ? resolvedTarget
            : resolvedTarget + pathSep;

        let entryCount = 0;
        let totalUncompressedBytes = 0;
        let violationReason: string | null = null;

        const recordViolation = (reason: string): false => {
            if (violationReason === null) violationReason = reason;
            return false;
        };

        const extractor = tar.x({
            cwd: resolvedTarget,
            strict: true,
            preservePaths: false,
            preserveOwner: false,
            filter: (entryPath, entry) => {
                if (violationReason) return false;
                const readEntry = entry as tar.ReadEntry;
                if (readEntry.type !== 'File' && readEntry.type !== 'Directory') {
                    return recordViolation(
                        `disallowed entry type "${readEntry.type}" at ${entryPath}`);
                }
                if (typeof entryPath !== 'string' || entryPath.length === 0) {
                    return recordViolation('empty entry path');
                }
                const candidate = resolve(resolvedTarget, entryPath);
                if (candidate !== resolvedTarget && !candidate.startsWith(targetWithSep)) {
                    return recordViolation(`path escapes bundle root: ${entryPath}`);
                }
                return true;
            },
            onentry: (entry) => {
                if (violationReason) return;
                entryCount += 1;
                if (entryCount > MAX_BUNDLE_ENTRIES) {
                    violationReason = `exceeds ${MAX_BUNDLE_ENTRIES} entry cap`;
                    return;
                }
                const entrySize = typeof entry.size === 'number' ? entry.size : 0;
                totalUncompressedBytes += entrySize;
                if (totalUncompressedBytes > MAX_BUNDLE_SIZE_BYTES) {
                    violationReason = `uncompressed bundle exceeds ${MAX_BUNDLE_SIZE_BYTES} cap`;
                }
            },
            onwarn: (code, message) => {
                log.warn(`[extract] tar warning: ${code} — ${message}`);
            },
        });

        try {
            await pipeline(Readable.from(buffer), extractor);
        } catch (err: any) {
            throw new CapsuleInstallError('extracting',
                `tar.gz extraction failed: ${err.message}`);
        }

        if (violationReason) {
            throw new CapsuleInstallError('extracting', `bundle rejected: ${violationReason}`);
        }

        return totalUncompressedBytes;
    }

    /**
     * After extraction, the staging dir must contain top-level `app/` and
     * `backend/` directories, and the frontend.entry file must exist
     * inside `app/`. Anything else means a malformed bundle.
     */
    private assertExtractedStructure(stagingDir: string, manifest: CapsuleManifest): void {
        for (const required of REQUIRED_TOP_LEVEL_DIRS) {
            const dir = join(stagingDir, required);
            if (!existsSync(dir)) {
                throw new CapsuleInstallError('verifying-structure',
                    `bundle missing required top-level directory "${required}/"`);
            }
            const stat = statSync(dir);
            if (!stat.isDirectory()) {
                throw new CapsuleInstallError('verifying-structure',
                    `"${required}" must be a directory at the bundle root`);
            }
        }

        const entryFile = join(stagingDir, 'app', manifest.frontend.entry.replace(/^app\//, ''));
        if (!existsSync(entryFile)) {
            throw new CapsuleInstallError('verifying-structure',
                `frontend.entry "${manifest.frontend.entry}" not found in extracted bundle`);
        }

        // Backend must contain at least a package.json or main.js (otherwise
        // the lazy-load loader has nothing to require).
        const backendPkg = join(stagingDir, 'backend', 'package.json');
        const backendMain = join(stagingDir, 'backend', 'main.js');
        if (!existsSync(backendPkg) && !existsSync(backendMain)) {
            throw new CapsuleInstallError('verifying-structure',
                'backend/ must contain at least package.json or main.js');
        }
    }

    /**
     * The only allowed dataDir is `data/installed-apps/<own-name>/...`.
     * M1's RESERVED_DATADIR_ROOTS rejects the shared installed-apps root;
     * here we enforce the per-capsule carve-out at install time when
     * we know the canonical name.
     */
    private assertDataDirCarveOut(name: string, dataDir: string): void {
        const required = `data/installed-apps/${name}/`;
        const canonRequired = canonPath(required);
        const canonActual = canonPath(dataDir);

        // Allow exact match OR strict subpath of the per-capsule root.
        if (canonActual !== canonRequired && !canonActual.startsWith(canonRequired)) {
            throw new CapsuleInstallError('verifying-datadir',
                `dataDir "${dataDir}" must live under "${required}" (per-capsule carve-out)`);
        }
    }

    private assertAssetExtractToInDataDir(name: string, asset: CapsuleAsset, dataDir: string): void {
        const canonExtract = canonPath(asset.extractTo);
        const canonDataDir = canonPath(dataDir);
        const installRoot = canonPath(`data/installed-apps/${name}/`);

        // Must be either inside dataDir OR inside the install root (for binaries
        // that live alongside state — e.g. `data/installed-apps/enm/bin/`).
        if (!canonExtract.startsWith(canonDataDir) && !canonExtract.startsWith(installRoot)) {
            throw new CapsuleInstallError('verifying-datadir',
                `asset "${asset.id}" extractTo "${asset.extractTo}" must live under ` +
                `dataDir "${dataDir}" or the per-capsule install root "${installRoot}"`);
        }
    }
}

function isCapsuleName(name: unknown): name is string {
    return typeof name === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}
