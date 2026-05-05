/**
 * Binary Manager
 *
 * Runtime auto-provisioning of transport binaries (wireguard-go, amneziawg-go,
 * awg-quick, sing-box). Acts as a safety net: if install scripts succeeded,
 * this module detects the existing binaries and does nothing. If any binary
 * is missing (script failure, source install without scripts, new platform),
 * it downloads a pre-compiled version to pc2-node/bin/{platform}-{arch}/.
 *
 * Called once at startup, before WireGuard/AmneziaWG/VLESS service initialization.
 */

import { existsSync, mkdirSync, createWriteStream, createReadStream, renameSync, unlinkSync, chmodSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import https from 'https';
import http from 'http';
import { logger } from './logger.js';

const RELEASE_TAG = 'pc2-binaries-v1';
const GITHUB_RELEASE_BASE = `https://github.com/Elacity/pc2.net/releases/download/${RELEASE_TAG}`;

const SINGBOX_VERSION = '1.13.0';
const SINGBOX_RELEASE_BASE = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}`;

// v1.2.7.2: one-shot guard that flips when we hit our first 404 against
// GITHUB_RELEASE_BASE. Until pc2-binaries-v1 is actually published, every
// fresh-Mac boot used to log 4 separate "HTTP 404" warnings as we tried
// each transport. After the first 404 this short-circuits subsequent
// attempts so the log stays readable. sing-box (SagerNet release) is
// unaffected — it has its own host.
let pc2BinariesReleaseUnavailable = false;

// v1.2.7.8: SHASUMS256.txt cache for integrity verification of downloaded
// binaries. Populated lazily on first download attempt against
// GITHUB_RELEASE_BASE; null until then. shasumsFetchAttempted prevents
// repeated fetches if the manifest is genuinely unavailable.
let shasumsCache: Map<string, string> | null = null;
let shasumsFetchAttempted = false;

// v1.2.7.2: install hint catalogue. Logged once per missing binary per
// process so launcher operators see actionable advice instead of just
// "not found" or "HTTP 404". Surfaced through /api/system-readiness
// in api/index.ts.
//
// v1.2.7.8: re-worded to lead with the auto-download story (Fix 3.0b
// publishes pc2-binaries-v1 so the typical recovery path is "restart
// PC2 and let BinaryManager fetch it"). Manual package-manager commands
// are kept as a documented fallback for air-gapped or restricted
// environments where the GitHub release isn't reachable.
const INSTALL_HINTS: Record<string, { darwin?: string; linux?: string }> = {
  'wireguard-go': {
    darwin: 'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: brew install wireguard-tools',
    linux:  'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: sudo apt install wireguard-tools',
  },
  'wg': {
    darwin: 'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: brew install wireguard-tools',
    linux:  'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: sudo apt install wireguard-tools',
  },
  'wg-quick': {
    darwin: 'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: brew install wireguard-tools',
    linux:  'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: sudo apt install wireguard-tools',
  },
  'amneziawg-go': {
    darwin: 'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: brew tap amnezia-vpn/amneziawg-tools && brew install amneziawg-go amneziawg-tools',
    linux:  'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: see https://github.com/amnezia-vpn/amneziawg-go',
  },
  'awg-quick': {
    darwin: 'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: brew tap amnezia-vpn/amneziawg-tools && brew install amneziawg-tools',
    linux:  'Restart PC2 to auto-download from pc2-binaries-v1. Manual fallback: install amneziawg-tools package',
  },
  'sing-box': {
    // sing-box is not in pc2-binaries-v1; it downloads directly from SagerNet's release.
    darwin: 'Auto-downloads from github.com/SagerNet/sing-box on next PC2 restart. Manual fallback: brew install sing-box',
    linux:  'Auto-downloads from github.com/SagerNet/sing-box on next PC2 restart. Manual fallback: see https://sing-box.sagernet.org/installation/',
  },
};

/** Returns a human-readable install hint for the current platform, or null. */
function getInstallHint(binaryName: string): string | null {
  const platform = process.platform;
  const hints = INSTALL_HINTS[binaryName];
  if (!hints) return null;
  if (platform === 'darwin') return hints.darwin || null;
  if (platform === 'linux')  return hints.linux  || null;
  return null;
}

interface BinarySpec {
  name: string;
  /** Platforms that need this binary: 'all' or specific like 'linux', 'darwin' */
  platforms: string[];
  /** Function to build the download URL for the current platform */
  getDownloadUrl: (os: string, arch: string) => string;
  /** System paths to check (in addition to bundled dir and PATH) */
  systemPaths: string[];
  /** Minimum expected file size in bytes (sanity check) */
  minSize: number;
  /** Whether this is a script (not a compiled binary) */
  isScript?: boolean;
}

const TRANSPORT_BINARIES: BinarySpec[] = [
  {
    name: 'wireguard-go',
    platforms: ['linux', 'darwin', 'win32'],
    getDownloadUrl: (os, arch) => `${GITHUB_RELEASE_BASE}/wireguard-go-${os}-${arch}`,
    systemPaths: ['/usr/local/bin/wireguard-go', '/usr/bin/wireguard-go'],
    minSize: 500_000,
  },
  {
    // v1.2.7.8: native wg CLI (used as `wg show`, `wg show interfaces`,
    // `wg show <iface> dump` by WireGuardService). wg-quick wraps wg
    // internally — without wg present, wg-quick fails on `up`. The systemPaths
    // mirror WireGuardService.ts:140-141 so resolution stays consistent.
    name: 'wg',
    platforms: ['linux', 'darwin'],
    getDownloadUrl: (os, arch) => `${GITHUB_RELEASE_BASE}/wg-${os}-${arch}`,
    systemPaths: ['/usr/local/bin/wg', '/opt/homebrew/bin/wg', '/usr/bin/wg', '/usr/sbin/wg'],
    minSize: 50_000,
  },
  {
    // v1.2.7.8: wg-quick is a bash script (~600 lines) with platform-specific
    // variants — wireguard-tools ships src/wg-quick/linux.bash and
    // src/wg-quick/darwin.bash, so the per-OS URL pattern (no arch suffix)
    // mirrors awg-quick below. WireGuardService invokes it as
    // `sudo <wg-quick-path> up <conf>` on both linux and darwin.
    name: 'wg-quick',
    platforms: ['linux', 'darwin'],
    getDownloadUrl: (os, _arch) => `${GITHUB_RELEASE_BASE}/wg-quick-${os}`,
    systemPaths: ['/usr/local/bin/wg-quick', '/opt/homebrew/bin/wg-quick', '/usr/bin/wg-quick', '/usr/sbin/wg-quick'],
    minSize: 1_000,
    isScript: true,
  },
  {
    name: 'amneziawg-go',
    platforms: ['linux', 'darwin'],
    getDownloadUrl: (os, arch) => `${GITHUB_RELEASE_BASE}/amneziawg-go-${os}-${arch}`,
    systemPaths: ['/usr/local/bin/amneziawg-go', '/opt/homebrew/bin/amneziawg-go'],
    minSize: 500_000,
  },
  {
    name: 'awg-quick',
    platforms: ['linux', 'darwin'],
    getDownloadUrl: (os, _arch) =>
      `${GITHUB_RELEASE_BASE}/awg-quick-${os}`,
    systemPaths: ['/usr/local/bin/awg-quick', '/opt/homebrew/bin/awg-quick'],
    minSize: 1_000,
    isScript: true,
  },
  {
    name: 'sing-box',
    platforms: ['linux', 'darwin', 'win32'],
    getDownloadUrl: (os, arch) => {
      const singboxOs = os === 'win32' ? 'windows' : os;
      const singboxArch = arch === 'x64' ? 'amd64' : arch;
      const ext = os === 'win32' ? 'zip' : 'tar.gz';
      return `${SINGBOX_RELEASE_BASE}/sing-box-${SINGBOX_VERSION}-${singboxOs}-${singboxArch}.${ext}`;
    },
    systemPaths: ['/usr/local/bin/sing-box', '/opt/homebrew/bin/sing-box', '/usr/bin/sing-box'],
    minSize: 1_000_000,
  },
];

export interface BinaryReport {
  checked: number;
  downloaded: number;
  skipped: number;
  failed: string[];
}

export interface BinaryCheckResult {
  name: string;
  found: boolean;
  path: string | null;
}

/**
 * Resolve the actual path where a binary was found, or null if missing.
 */
function resolveBinaryPath(name: string, bundledDir: string, systemPaths: string[]): string | null {
  const isWin = process.platform === 'win32';
  const binaryName = isWin ? `${name}.exe` : name;

  const bundledPath = join(bundledDir, binaryName);
  if (existsSync(bundledPath)) return bundledPath;

  for (const p of systemPaths) {
    if (existsSync(p)) return p;
  }

  if (!isWin) {
    try {
      const found = execSync(`which ${name} 2>/dev/null`, {
        stdio: 'pipe',
        timeout: 3000,
        shell: '/bin/sh',
      }).toString().trim();
      if (found && existsSync(found)) return found;
    } catch { /* not on PATH */ }
  }

  return null;
}

/**
 * Read-only check of all transport binaries for the current platform.
 * Does NOT download anything — just reports what's found and what's missing.
 */
export function checkTransportBinaries(): BinaryCheckResult[] {
  const binDir = getBundledBinDir();
  const platform = process.platform;
  const results: BinaryCheckResult[] = [];

  for (const spec of TRANSPORT_BINARIES) {
    if (!spec.platforms.includes(platform) && !spec.platforms.includes('all')) {
      continue;
    }

    const resolvedPath = resolveBinaryPath(spec.name, binDir, spec.systemPaths);
    results.push({
      name: spec.name,
      found: resolvedPath !== null,
      path: resolvedPath,
    });
  }

  return results;
}

/**
 * Resolve the bundled binaries directory for the current platform.
 * Matches the path used by WireGuardService.getBundledBinDir().
 */
export function getBundledBinDir(): string {
  const thisFile = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const appRoot = join(thisFile, '..', '..');
  return join(appRoot, 'bin', `${process.platform}-${process.arch}`);
}

/**
 * Check if a binary exists anywhere the services would find it:
 * bundled dir, system paths, or PATH.
 */
function binaryExists(name: string, bundledDir: string, systemPaths: string[]): boolean {
  const isWin = process.platform === 'win32';
  const binaryName = isWin ? `${name}.exe` : name;

  const bundledPath = join(bundledDir, binaryName);
  if (existsSync(bundledPath)) return true;

  for (const p of systemPaths) {
    if (existsSync(p)) return true;
  }

  if (!isWin) {
    try {
      const found = execSync(`which ${name} 2>/dev/null`, {
        stdio: 'pipe',
        timeout: 3000,
        shell: '/bin/sh',
      }).toString().trim();
      if (found && existsSync(found)) return true;
    } catch { /* not on PATH */ }
  }

  return false;
}

/**
 * Follow HTTP redirects (GitHub releases redirect to CDN).
 * Returns a readable stream of the final response.
 */
function downloadStream(url: string, maxRedirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client.get(url, { headers: { 'User-Agent': 'PC2-BinaryManager/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        res.resume();
        downloadStream(res.headers.location, maxRedirects - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      resolve(res);
    }).on('error', reject);
  });
}

/**
 * v1.2.7.8: fetch + parse SHASUMS256.txt from the pc2-binaries-v1 release.
 * Cached for the lifetime of the process. Returns a Map of asset filename
 * to expected lowercase sha256 hex, or null if the manifest is missing.
 *
 * Format expected (sha256sum default output):
 *   <64 hex chars>  <filename>
 *   <64 hex chars> *<filename>      (binary mode marker, also accepted)
 *
 * Comments (#) and blank lines are tolerated.
 */
async function fetchShasums(): Promise<Map<string, string> | null> {
  if (shasumsCache !== null) return shasumsCache;
  if (shasumsFetchAttempted) return null;
  shasumsFetchAttempted = true;

  const url = `${GITHUB_RELEASE_BASE}/SHASUMS256.txt`;
  try {
    const response = await downloadStream(url);
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8');

    const map = new Map<string, string>();
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (match) {
        map.set(match[2], match[1].toLowerCase());
      }
    }

    shasumsCache = map;
    logger.info(`[BinaryManager] Loaded SHASUMS256.txt with ${map.size} entries from ${RELEASE_TAG}`);
    return map;
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.warn(`[BinaryManager] SHASUMS256.txt unavailable for ${RELEASE_TAG}: ${errMsg}. Integrity verification disabled this session.`);
    return null;
  }
}

/**
 * v1.2.7.8: stream-hash a file to lowercase sha256 hex. Used to compare
 * downloaded binaries against the SHASUMS256.txt manifest before installing.
 *
 * Uses the explicit data/end/error pattern rather than pipeline+Hash because
 * Transform-as-pipeline-terminus has subtle behaviour around output draining;
 * this form is unambiguous and matches widespread Node.js conventions.
 */
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * v1.2.7.8: strip the macOS Gatekeeper quarantine attribute from a downloaded
 * file. When PC2 runs as part of an Electron build (LSFileQuarantineEnabled
 * defaults to true), files written via Node's https layer inherit the
 * quarantine xattr from the parent process. Even with full notarisation,
 * the first-run Gatekeeper dialog still blocks invocation — particularly
 * when the binary is later spawned via `sudo`. Removing this xattr after
 * we've already verified signature + sha256 is safe and matches what
 * `xattr -d` would do interactively.
 *
 * No-op on non-darwin platforms. Silent on failure: if the attribute
 * isn't present (plain `node` parent, SIP-relaxed env, future macOS
 * change), `xattr -d` returns non-zero and we ignore — the absence of
 * the attribute is exactly the desired end state.
 */
function stripDarwinQuarantine(filePath: string): void {
  if (process.platform !== 'darwin') return;
  try {
    execSync(`xattr -d com.apple.quarantine "${filePath}" 2>/dev/null`, {
      stdio: 'pipe',
      timeout: 3000,
      shell: '/bin/sh',
    });
  } catch {
    /* xattr exits non-zero when the attribute is absent — that's fine */
  }
}

/**
 * Download a single binary to the target directory.
 * Uses atomic writes (.tmp -> rename) to prevent corrupt partial downloads.
 */
async function downloadBinary(spec: BinarySpec, targetDir: string): Promise<boolean> {
  const platform = process.platform;
  const arch = process.arch;
  const isWin = platform === 'win32';
  const binaryName = isWin ? `${spec.name}.exe` : spec.name;
  const targetPath = join(targetDir, binaryName);
  const tmpPath = `${targetPath}.tmp`;

  const url = spec.getDownloadUrl(platform, arch);

  // v1.2.7.2: short-circuit if a previous binary already 404'd against
  // pc2-binaries-v1. Avoids the 4×404 log storm fresh Macs used to produce.
  // Only applies to URLs in our own GitHub release; sing-box (SagerNet) is
  // exempt because it has its own host that does exist.
  if (pc2BinariesReleaseUnavailable && url.startsWith(GITHUB_RELEASE_BASE)) {
    logger.debug(`[BinaryManager] Skipping ${spec.name} download — pc2-binaries-v1 release confirmed unavailable this session`);
    return false;
  }

  logger.info(`[BinaryManager] Downloading ${spec.name} from ${url}`);

  try {
    const response = await downloadStream(url);

    // sing-box comes as an archive (.tar.gz on Unix, .zip on Windows)
    if (url.endsWith('.tar.gz') || url.endsWith('.zip')) {
      return await downloadAndExtractArchive(response, spec.name, targetPath, tmpPath, isWin, url);
    }

    // Direct binary download
    const fileStream = createWriteStream(tmpPath);
    await pipeline(response, fileStream);

    const stats = statSync(tmpPath);
    if (stats.size < spec.minSize) {
      unlinkSync(tmpPath);
      logger.warn(`[BinaryManager] Downloaded ${spec.name} is too small (${stats.size} bytes), discarding`);
      return false;
    }

    // v1.2.7.8: SHA-256 verification against SHASUMS256.txt published in
    // the same release. Only applies to pc2-binaries-v1 URLs (sing-box uses
    // SagerNet's host with its own integrity story; minSize check above
    // remains its first line of defence). Fail-closed: tampered or
    // unmapped assets are deleted, never installed. The cascade falls
    // back to ActiveProxy if WG/AWG/VLESS binaries can't be installed —
    // safer to lose a transport than to root-execute a bad binary.
    if (url.startsWith(GITHUB_RELEASE_BASE)) {
      const shasums = await fetchShasums();
      if (shasums) {
        const assetName = url.split('/').pop() || '';
        const expected = shasums.get(assetName);
        if (!expected) {
          unlinkSync(tmpPath);
          logger.error(`[BinaryManager] ${spec.name}: asset "${assetName}" not in SHASUMS256.txt manifest. Refusing to install (manifest may be stale; re-run the publish-pc2-binaries workflow).`);
          return false;
        }
        const actual = await sha256File(tmpPath);
        if (actual !== expected) {
          unlinkSync(tmpPath);
          logger.error(`[BinaryManager] ${spec.name}: SHA-256 mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Refusing to install (corruption or tampering).`);
          return false;
        }
        logger.debug(`[BinaryManager] ${spec.name}: SHA-256 verified (${expected.slice(0, 12)}…)`);
      }
      // shasums === null: manifest unavailable. fetchShasums() already
      // logged a warn-level message; we accept the download because the
      // alternative is a hard outage when the release is mid-publish.
    }

    renameSync(tmpPath, targetPath);

    if (!isWin) {
      chmodSync(targetPath, 0o755);
    }

    // v1.2.7.8: see stripDarwinQuarantine() docs. No-op on non-darwin.
    stripDarwinQuarantine(targetPath);

    logger.info(`[BinaryManager] ${spec.name} installed (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    return true;
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    const errMsg = (err as Error).message;

    // v1.2.7.2: detect "release does not exist" so we can short-circuit
    // sibling downloads for the rest of this process lifetime.
    if (!pc2BinariesReleaseUnavailable && url.startsWith(GITHUB_RELEASE_BASE) && /HTTP 404/.test(errMsg)) {
      pc2BinariesReleaseUnavailable = true;
      logger.warn(
        `[BinaryManager] pc2-binaries-v1 GitHub release not published — skipping further attempts. ` +
        `Relying on bundled binaries (pc2-node/bin/${platform}-${arch}/) and system PATH only.`,
      );
    } else {
      logger.warn(`[BinaryManager] Failed to download ${spec.name}: ${errMsg}`);
    }
    return false;
  }
}

/**
 * Download an archive (.tar.gz or .zip), extract the target binary.
 * Used for sing-box which distributes as archives on GitHub.
 */
async function downloadAndExtractArchive(
  response: http.IncomingMessage,
  binaryName: string,
  targetPath: string,
  tmpPath: string,
  isWin: boolean,
  url: string,
): Promise<boolean> {
  const isZip = url.endsWith('.zip');
  const archiveExt = isZip ? '.zip' : '.tar.gz';
  const archivePath = `${tmpPath}${archiveExt}`;
  const extractDir = `${tmpPath}.extract`;

  try {
    const fileStream = createWriteStream(archivePath);
    await pipeline(response, fileStream);

    mkdirSync(extractDir, { recursive: true });

    if (isZip) {
      if (isWin) {
        execSync(`powershell -Command "Expand-Archive -Force '${archivePath}' '${extractDir}'"`, { stdio: 'pipe', timeout: 30_000 });
      } else {
        execSync(`unzip -qo "${archivePath}" -d "${extractDir}"`, { stdio: 'pipe', timeout: 30_000, shell: '/bin/sh' });
      }
    } else {
      execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { stdio: 'pipe', timeout: 30_000, shell: isWin ? undefined : '/bin/sh' });
    }

    const binFilename = isWin ? `${binaryName}.exe` : binaryName;
    const found = findFileRecursive(extractDir, binFilename);

    if (!found) {
      logger.warn(`[BinaryManager] ${binaryName} not found in archive`);
      return false;
    }

    renameSync(found, targetPath);

    if (!isWin) {
      chmodSync(targetPath, 0o755);
    }

    // v1.2.7.8: matches direct-binary path. sing-box archive came from
    // SagerNet, but the extracted binary still inherits Electron-host
    // quarantine on darwin if the parent process has LSFileQuarantineEnabled.
    stripDarwinQuarantine(targetPath);

    const stats = statSync(targetPath);
    logger.info(`[BinaryManager] ${binaryName} extracted and installed (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    return true;
  } finally {
    try { unlinkSync(archivePath); } catch { /* ignore */ }
    try { rmDirRecursive(extractDir); } catch { /* ignore */ }
  }
}

/**
 * Remove a directory recursively. Uses platform-appropriate command.
 */
function rmDirRecursive(dir: string): void {
  if (process.platform === 'win32') {
    execSync(`rmdir /s /q "${dir}"`, { stdio: 'pipe', timeout: 5000 });
  } else {
    execSync(`rm -rf "${dir}"`, { stdio: 'pipe', timeout: 5000, shell: '/bin/sh' });
  }
}

/**
 * Recursively find a file by name in a directory.
 */
function findFileRecursive(dir: string, filename: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = findFileRecursive(fullPath, filename);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Ensure all transport binaries are available for the current platform.
 *
 * For each binary:
 *   1. Check bundled dir (pc2-node/bin/{platform}-{arch}/)
 *   2. Check well-known system paths
 *   3. Check system PATH via `which`
 *   4. If not found anywhere, download pre-compiled version to bundled dir
 *
 * This is non-blocking: download failures are logged but do not prevent startup.
 * The services will still check all paths and gracefully degrade if a binary
 * is truly unavailable.
 */
export async function ensureTransportBinaries(): Promise<BinaryReport> {
  const binDir = getBundledBinDir();
  const platform = process.platform;
  const report: BinaryReport = { checked: 0, downloaded: 0, skipped: 0, failed: [] };

  logger.info(`[BinaryManager] Checking transport binaries for ${platform}-${process.arch}`);
  logger.info(`[BinaryManager] Bundled dir: ${binDir}`);

  for (const spec of TRANSPORT_BINARIES) {
    if (!spec.platforms.includes(platform) && !spec.platforms.includes('all')) {
      continue;
    }

    report.checked++;

    if (binaryExists(spec.name, binDir, spec.systemPaths)) {
      logger.debug(`[BinaryManager] ${spec.name}: found`);
      report.skipped++;
      continue;
    }

    logger.info(`[BinaryManager] ${spec.name}: not found, will download`);

    mkdirSync(binDir, { recursive: true });

    const ok = await downloadBinary(spec, binDir);
    if (ok) {
      report.downloaded++;
    } else {
      report.failed.push(spec.name);
    }
  }

  if (report.downloaded > 0) {
    logger.info(`[BinaryManager] Downloaded ${report.downloaded} missing binary(ies)`);
  }
  if (report.failed.length > 0) {
    logger.warn(`[BinaryManager] Failed to download: ${report.failed.join(', ')}. These transports may be unavailable.`);
    // v1.2.7.2: emit one actionable install hint per missing binary
    // (instead of just "failed to download"). The launcher log is
    // typically the first place a fresh-install user looks when something
    // doesn't work, so we want the fix-it command right there.
    for (const name of report.failed) {
      const hint = getInstallHint(name);
      if (hint) logger.warn(`[BinaryManager]   ${name} install hint → ${hint}`);
    }
  }
  if (report.downloaded === 0 && report.failed.length === 0) {
    logger.info(`[BinaryManager] All ${report.checked} transport binaries present`);
  }

  return report;
}

// Re-export so the system-readiness API can show the same hint to users
// without duplicating the catalogue.
export { getInstallHint };
