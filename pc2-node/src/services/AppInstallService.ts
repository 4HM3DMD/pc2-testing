/**
 * AppInstallService
 *
 * Handles fetching dApp bundles from IPFS, extracting them to disk,
 * validating app manifests, and registering/unregistering apps in the database.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'fs';
import { join, resolve, basename, normalize, sep as pathSep } from 'path';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import { createLogger } from '../utils/logger.js';
import { DatabaseManager, InstalledApp } from '../storage/database.js';
import { IPFSStorage } from '../storage/ipfs.js';

const log = createLogger('app-install');

const MAX_APP_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB hard cap per app

function resolveAuthorName(author?: string | AppAuthor): string | null {
  if (!author) return null;
  if (typeof author === 'string') return author;
  return author.name || null;
}

export interface AppAuthor {
  name: string;
  wallet?: string;
  url?: string;
}

export type AppType = 'web' | 'wasm' | 'data' | 'microvm' | 'agent';

export type AppCategory =
  | 'media'
  | 'blockchain'
  | 'tools'
  | 'system'
  | 'games'
  | 'social'
  | 'ai'
  | 'marketplace'
  | 'other';

const VALID_APP_TYPES: readonly string[] = ['web', 'wasm', 'data', 'microvm', 'agent'];

const VALID_CATEGORIES: readonly string[] = [
  'media', 'blockchain', 'tools', 'system', 'games', 'social', 'ai', 'marketplace', 'other',
];

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

export interface AppCapabilities {
  wallet?: boolean;
  network?: boolean;
  storage?: {
    read?: string[];
    write?: string[];
  };
  ipfs?: {
    pin?: boolean;
    fetch?: boolean;
  };
  ipc?: string[];
  drm?: boolean;
}

export interface AppDisplay {
  maximize?: boolean;
  width?: number;
  height?: number;
  resizable?: boolean;
  titlebar?: boolean;
  taskbar?: boolean;
}

export interface AppService {
  name: string;
  protocol?: string;
  endpoint?: string;
  description?: string;
}

export interface AppDistribution {
  cid?: string | null;
  signature?: string | null;
  signedBy?: string | null;
  channel?: 'stable' | 'beta' | 'dev';
  updateUrl?: string | null;
  size?: number | null;
}

export interface AppManifest {
  name: string;
  title: string;
  version: string;
  description?: string;
  author?: string | AppAuthor;
  license?: string;
  icon?: string;
  screenshots?: string[];
  entry?: string;
  type?: AppType;
  category?: AppCategory;
  system?: boolean;

  capabilities?: AppCapabilities;

  /** @deprecated Use `capabilities` instead. Kept for backward compat with existing app.json files. */
  permissions?: string[];

  requirements?: {
    headers?: string[];
    services?: string[];
    popup?: boolean;
    minVersion?: string;
  };

  display?: AppDisplay;
  services?: AppService[];
  distribution?: AppDistribution;
  dependencies?: Record<string, string>;
}

export class AppInstallService {
  private db: DatabaseManager;
  private ipfs: IPFSStorage | null;
  private appsDir: string;
  /**
   * SEC-A17 (2026-04 Wave 5.5): the only directory `installFromLocal` is
   * allowed to source from. Sideloading an app from anywhere else (e.g.
   * `data/wallets/`) would let an attacker exfiltrate the owner mnemonic
   * via the `/installed-apps/*` static route. The route layer also gates
   * `install-local` with `requireOwner`; this is defense-in-depth so any
   * future internal caller is also bound to the allowlist.
   */
  private devAppsDir: string;

  constructor(db: DatabaseManager, ipfs: IPFSStorage | null, dataDir: string) {
    this.db = db;
    this.ipfs = ipfs;
    this.appsDir = resolve(dataDir, 'installed-apps');
    this.devAppsDir = resolve(dataDir, 'dev-apps');

    if (!existsSync(this.appsDir)) {
      mkdirSync(this.appsDir, { recursive: true });
    }
    if (!existsSync(this.devAppsDir)) {
      mkdirSync(this.devAppsDir, { recursive: true });
    }
  }

  getAppsDir(): string {
    return this.appsDir;
  }

  getDevAppsDir(): string {
    return this.devAppsDir;
  }

  /**
   * Install an app from a manifest + CID.
   * 1. Validate manifest fields
   * 2. Fetch bundle from IPFS
   * 3. Write to disk at data/installed-apps/<name>/
   * 4. Register in database
   */
  async install(manifest: AppManifest, cid: string): Promise<InstalledApp> {
    this.validateManifest(manifest);

    const appName = manifest.name;
    const appDir = join(this.appsDir, appName);

    if (this.db.getInstalledApp(appName)) {
      throw new Error(`App "${appName}" is already installed. Uninstall first or use update.`);
    }

    log.info(`[install] Starting install of "${appName}" from CID ${cid}`);

    let bundleBuffer: Buffer;
    try {
      bundleBuffer = await this.fetchFromIPFS(cid);
    } catch (err: any) {
      throw new Error(`Failed to fetch app bundle from IPFS: ${err.message}`);
    }

    if (bundleBuffer.length > MAX_APP_SIZE_BYTES) {
      throw new Error(`App bundle exceeds ${MAX_APP_SIZE_BYTES / 1024 / 1024}MB limit`);
    }

    const signatureVerified = this.verifyDistributionSignature(manifest, bundleBuffer);

    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true });
    }
    mkdirSync(appDir, { recursive: true });

    try {
      await this.extractBundle(bundleBuffer, appDir, manifest);
    } catch (err: any) {
      rmSync(appDir, { recursive: true, force: true });
      throw new Error(`Failed to extract app bundle: ${err.message}`);
    }

    const entryFile = manifest.entry || 'index.html';
    if (!existsSync(join(appDir, entryFile))) {
      rmSync(appDir, { recursive: true, force: true });
      throw new Error(`App bundle missing entry file: ${entryFile}`);
    }

    const totalSize = this.dirSize(appDir);
    const now = Date.now();

    const installedApp: InstalledApp = {
      app_name: appName,
      title: manifest.title,
      version: manifest.version,
      cid,
      size: totalSize,
      icon: manifest.icon || null,
      description: manifest.description || null,
      author: resolveAuthorName(manifest.author),
      permissions_json: JSON.stringify(manifest.capabilities || manifest.permissions || []),
      requirements_json: JSON.stringify(manifest.requirements || {}),
      manifest_json: JSON.stringify({
        ...manifest,
        _signatureVerified: signatureVerified,
      }),
      installed_at: now,
      updated_at: now,
    };

    this.db.registerInstalledApp(installedApp);

    log.info(`[install] ✅ "${appName}" v${manifest.version} installed (${(totalSize / 1024).toFixed(1)} KB)`);
    return installedApp;
  }

  /**
   * Verify Ed25519 signature on an app bundle if distribution.signature is present.
   * v1: warn-only — unsigned apps still install. v2: enforced.
   *
   * Signature is verified over SHA-256(bundleBytes) using the public key
   * from distribution.signedBy (hex-encoded Ed25519 public key).
   *
   * @returns true if signature is valid, false if absent or invalid
   */
  private verifyDistributionSignature(manifest: AppManifest, bundleBuffer: Buffer): boolean {
    const dist = manifest.distribution;
    if (!dist?.signature || !dist?.signedBy) {
      log.warn(`[install] ⚠ Unsigned app bundle: "${manifest.name}" — capsule-unsigned installs will be blocked in v2`);
      return false;
    }

    try {
      const bundleHash = createHash('sha256').update(bundleBuffer).digest();
      const signatureBytes = Buffer.from(dist.signature, 'hex');
      const publicKeyBytes = Buffer.from(dist.signedBy, 'hex');

      if (publicKeyBytes.length !== 32) {
        log.warn(`[install] ⚠ Invalid signedBy key length for "${manifest.name}": expected 32 bytes, got ${publicKeyBytes.length}`);
        return false;
      }

      if (signatureBytes.length !== 64) {
        log.warn(`[install] ⚠ Invalid signature length for "${manifest.name}": expected 64 bytes, got ${signatureBytes.length}`);
        return false;
      }

      const valid = nacl.sign.detached.verify(
        new Uint8Array(bundleHash),
        new Uint8Array(signatureBytes),
        new Uint8Array(publicKeyBytes)
      );

      if (valid) {
        log.info(`[install] ✅ Signature verified for "${manifest.name}" (signed by ${dist.signedBy.substring(0, 16)}...)`);
      } else {
        log.warn(`[install] ⚠ Signature INVALID for "${manifest.name}" — bundle may have been tampered with`);
      }

      return valid;
    } catch (err: any) {
      log.warn(`[install] ⚠ Signature verification failed for "${manifest.name}": ${err.message}`);
      return false;
    }
  }

  /**
   * Install from a local directory (for development / sideloading).
   * Skips IPFS fetch — the files must already exist on disk.
   *
   * SEC-A17 (2026-04 Wave 5.5): `localDir` is constrained to live inside
   * `data/dev-apps/`. Without this, an attacker who reaches this code path
   * (e.g. via a future internal caller that bypasses the route-level
   * `requireOwner`) could point `localDir` at `data/wallets/` and have the
   * mnemonic copied into the static-served `installed-apps/<name>/` dir.
   */
  installFromLocal(manifest: AppManifest, localDir: string): InstalledApp {
    this.validateManifest(manifest);

    const appName = manifest.name;
    const appDir = join(this.appsDir, appName);
    const resolvedLocal = resolve(localDir);

    // SEC-A17: strict allowlist. resolve() already collapses '..' segments,
    // so a path like `data/dev-apps/../wallets` resolves OUTSIDE devAppsDir
    // and is rejected here.
    const devRootWithSep = this.devAppsDir.endsWith(pathSep)
      ? this.devAppsDir
      : this.devAppsDir + pathSep;
    if (resolvedLocal !== this.devAppsDir && !resolvedLocal.startsWith(devRootWithSep)) {
      throw new Error(
        `localDir must live inside ${this.devAppsDir} (got: ${resolvedLocal})`,
      );
    }

    // SEC-A17: prevent self-targeting (copy from installed-apps into
    // installed-apps), which would also let a crafted path read out
    // another app's contents.
    const appsRootWithSep = this.appsDir.endsWith(pathSep)
      ? this.appsDir
      : this.appsDir + pathSep;
    if (resolvedLocal === this.appsDir || resolvedLocal.startsWith(appsRootWithSep)) {
      throw new Error('localDir must not point inside installed-apps/');
    }

    if (!existsSync(resolvedLocal)) {
      throw new Error(`Local directory does not exist: ${localDir}`);
    }

    const entryFile = manifest.entry || 'index.html';
    if (!existsSync(join(resolvedLocal, entryFile))) {
      throw new Error(`Local directory missing entry file: ${entryFile}`);
    }

    if (resolvedLocal !== resolve(appDir)) {
      if (existsSync(appDir)) {
        rmSync(appDir, { recursive: true, force: true });
      }
      this.copyDirRecursive(resolvedLocal, appDir);
    }

    const totalSize = this.dirSize(appDir);
    const now = Date.now();

    const installedApp: InstalledApp = {
      app_name: appName,
      title: manifest.title,
      version: manifest.version,
      cid: `local:${appName}`,
      size: totalSize,
      icon: manifest.icon || null,
      description: manifest.description || null,
      author: resolveAuthorName(manifest.author),
      permissions_json: JSON.stringify(manifest.capabilities || manifest.permissions || []),
      requirements_json: JSON.stringify(manifest.requirements || {}),
      manifest_json: JSON.stringify(manifest),
      installed_at: now,
      updated_at: now,
    };

    this.db.registerInstalledApp(installedApp);

    log.info(`[installFromLocal] ✅ "${appName}" installed from local dir (${(totalSize / 1024).toFixed(1)} KB)`);
    return installedApp;
  }

  /**
   * Uninstall an app: remove files from disk and database record.
   */
  uninstall(appName: string): boolean {
    const app = this.db.getInstalledApp(appName);
    if (!app) {
      return false;
    }

    const appDir = join(this.appsDir, appName);
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true });
    }

    this.db.uninstallApp(appName);
    log.info(`[uninstall] ✅ "${appName}" removed`);
    return true;
  }

  /**
   * List all installed apps.
   */
  list(): InstalledApp[] {
    return this.db.listInstalledApps();
  }

  /**
   * Get a single installed app.
   */
  get(appName: string): InstalledApp | undefined {
    return this.db.getInstalledApp(appName);
  }

  /**
   * Update an app: uninstall the old version, install the new one.
   */
  async update(manifest: AppManifest, cid: string): Promise<InstalledApp> {
    const existing = this.db.getInstalledApp(manifest.name);
    if (!existing) {
      throw new Error(`App "${manifest.name}" is not installed`);
    }

    if (existing.cid === cid) {
      throw new Error(`App "${manifest.name}" is already at CID ${cid}`);
    }

    this.uninstall(manifest.name);
    return this.install(manifest, cid);
  }

  // ── Private helpers ──────────────────────────────────────

  private validateManifest(manifest: AppManifest): void {
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error('Manifest missing required field: name');
    }
    if (manifest.name.length > 64) {
      throw new Error(`App name exceeds 64 character limit (${manifest.name.length})`);
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(manifest.name)) {
      throw new Error('App name must be lowercase alphanumeric with hyphens (e.g. "media-player")');
    }

    if (!manifest.title || typeof manifest.title !== 'string') {
      throw new Error('Manifest missing required field: title');
    }
    if (manifest.title.length > 128) {
      throw new Error(`App title exceeds 128 character limit (${manifest.title.length})`);
    }

    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error('Manifest missing required field: version');
    }
    if (!SEMVER_REGEX.test(manifest.version)) {
      throw new Error(`Invalid version "${manifest.version}" — must be semver (e.g. "1.0.0")`);
    }

    if (manifest.description && manifest.description.length > 500) {
      throw new Error(`Description exceeds 500 character limit (${manifest.description.length})`);
    }

    if (manifest.entry) {
      this.validateSafePath(manifest.entry);
    }

    if (manifest.type && !VALID_APP_TYPES.includes(manifest.type)) {
      log.warn(`[validateManifest] Unknown type "${manifest.type}" for app "${manifest.name}"`);
    }

    if (manifest.category && !VALID_CATEGORIES.includes(manifest.category)) {
      log.warn(`[validateManifest] Unknown category "${manifest.category}" for app "${manifest.name}"`);
    }

    if (manifest.capabilities) {
      this.validateCapabilities(manifest.capabilities, manifest.name);
    }
  }

  private validateSafePath(entry: string): void {
    const normalized = normalize(entry);
    if (normalized.startsWith('..') || normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('..')) {
      throw new Error(`Unsafe entry path: "${entry}"`);
    }
  }

  private validateCapabilities(caps: AppCapabilities, appName: string): void {
    const booleanFields: (keyof AppCapabilities)[] = ['wallet', 'network', 'drm'];
    for (const field of booleanFields) {
      if (caps[field] !== undefined && typeof caps[field] !== 'boolean') {
        log.warn(`[validateManifest] capabilities.${field} should be boolean in "${appName}"`);
      }
    }
    if (caps.ipc !== undefined && !Array.isArray(caps.ipc)) {
      log.warn(`[validateManifest] capabilities.ipc should be a string array in "${appName}"`);
    }
    if (caps.storage !== undefined && typeof caps.storage !== 'object') {
      log.warn(`[validateManifest] capabilities.storage should be an object in "${appName}"`);
    }
    if (caps.ipfs !== undefined && typeof caps.ipfs !== 'object') {
      log.warn(`[validateManifest] capabilities.ipfs should be an object in "${appName}"`);
    }
  }

  private async fetchFromIPFS(cid: string): Promise<Buffer> {
    if (!this.ipfs) {
      throw new Error('IPFS not available — cannot fetch remote app bundles');
    }
    return this.ipfs.getFile(cid);
  }

  /**
   * Extract a bundle buffer to the target directory.
   * For V1, we support raw single-file HTML or tar/zip bundles.
   * Initial implementation: treat the buffer as a single index.html if it starts with <!DOCTYPE or <html.
   * Otherwise attempt tar extraction.
   */
  private async extractBundle(buffer: Buffer, targetDir: string, manifest: AppManifest): Promise<void> {
    const header = buffer.subarray(0, 64).toString('utf-8').trimStart().toLowerCase();

    if (header.startsWith('<!doctype') || header.startsWith('<html') || header.startsWith('<head')) {
      const entryFile = manifest.entry || 'index.html';
      writeFileSync(join(targetDir, entryFile), buffer);
      return;
    }

    // For tar.gz / zip support, we'll need to add extraction libraries later.
    // For now, write as index.html and log a warning.
    log.warn(`[extractBundle] Bundle for "${manifest.name}" doesn't look like HTML — writing as-is`);
    const entryFile = manifest.entry || 'index.html';
    writeFileSync(join(targetDir, entryFile), buffer);
  }

  private dirSize(dirPath: string): number {
    let total = 0;
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += this.dirSize(fullPath);
        } else {
          total += statSync(fullPath).size;
        }
      }
    } catch {
      // ignore errors
    }
    return total;
  }

  private copyDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    const entries = readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        writeFileSync(destPath, readFileSync(srcPath));
      }
    }
  }
}
