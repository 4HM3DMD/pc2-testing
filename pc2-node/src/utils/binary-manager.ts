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

import { existsSync, mkdirSync, createWriteStream, renameSync, unlinkSync, chmodSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { logger } from './logger.js';

const RELEASE_TAG = 'pc2-binaries-v1';
const GITHUB_RELEASE_BASE = `https://github.com/Elacity/pc2.net/releases/download/${RELEASE_TAG}`;

const SINGBOX_VERSION = '1.13.0';
const SINGBOX_RELEASE_BASE = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}`;

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

    renameSync(tmpPath, targetPath);

    if (!isWin) {
      chmodSync(targetPath, 0o755);
    }

    logger.info(`[BinaryManager] ${spec.name} installed (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    return true;
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    logger.warn(`[BinaryManager] Failed to download ${spec.name}: ${(err as Error).message}`);
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
  }
  if (report.downloaded === 0 && report.failed.length === 0) {
    logger.info(`[BinaryManager] All ${report.checked} transport binaries present`);
  }

  return report;
}
