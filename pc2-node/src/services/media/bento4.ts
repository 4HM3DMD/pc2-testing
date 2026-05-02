/**
 * Bento4 Binary Manager for PC2 Node.
 *
 * Handles discovery, download, and execution of Bento4 mp4fragment tool.
 * Phase 2: mp4encrypt and mp4dash are no longer needed — encryption is handled
 * by the cenc-encrypt WASM module and DASH packaging by mpdGenerator.ts.
 *
 * Binaries are cached in pc2-node/bin/bento4/<platform>/
 * and downloaded from bok.net (Bento4's official binary host) on first use.
 *
 * Platforms WITHOUT a bok.net prebuild (linux-arm64 — Jetson, Raspberry Pi,
 * AWS Graviton, …) automatically fall back to ffmpeg-based fragmentation.
 * ffmpeg's -movflags frag_keyframe+empty_moov+default_base_moof+dash produces
 * DASH-compatible fragmented MP4 that's structurally equivalent to
 * mp4fragment's output. ffmpeg is a hard dependency of the encoder anyway,
 * so it's always available.
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, chmodSync, createWriteStream, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import * as https from 'https';
import * as http from 'http';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

const BENTO4_VERSION = '1-6-0-641';

// bok.net hosts darwin-universal, linux-x64, but NOT linux-arm64.
// linux-arm64 nodes (Jetson, Pi, Graviton) use the ffmpeg fallback below.
const BENTO4_URLS: Record<string, string> = {
  'linux-x64':    `https://www.bok.net/Bento4/binaries/Bento4-SDK-${BENTO4_VERSION}.x86_64-unknown-linux.zip`,
  'darwin-x64':   `https://www.bok.net/Bento4/binaries/Bento4-SDK-${BENTO4_VERSION}.universal-apple-macosx.zip`,
  'darwin-arm64': `https://www.bok.net/Bento4/binaries/Bento4-SDK-${BENTO4_VERSION}.universal-apple-macosx.zip`,
};

function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function getBento4Dir(): string {
  const dataDir = process.env.PC2_DATA_DIR || join(process.cwd(), 'data');
  return join(dataDir, 'bin', 'bento4');
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Result of ensureBento4(). Either we have a real mp4fragment binary, or
 * we're falling back to ffmpeg-based fragmentation (signalled by
 * `useFfmpegFallback: true`). The encoder's fragmentMedia() dispatches
 * on this flag and either invokes mp4fragment or ffmpeg accordingly.
 */
export interface Bento4Paths {
  mp4fragment: string;
  useFfmpegFallback?: boolean;
}

// ─── Binary Resolution ──────────────────────────────────────────────────────

export async function ensureBento4(): Promise<Bento4Paths> {
  const bento4Dir = getBento4Dir();
  const platform = getPlatformKey();
  const binDir = join(bento4Dir, platform, 'bin');
  const mp4fragmentPath = join(binDir, 'mp4fragment');

  // Cached binary from a previous install
  if (existsSync(mp4fragmentPath)) {
    return { mp4fragment: mp4fragmentPath };
  }

  // System-wide install (e.g. user installed bento4 via package manager)
  try {
    await execFileAsync('mp4fragment', ['--version'], { timeout: 5000 });
    return { mp4fragment: 'mp4fragment' };
  } catch { /* not on PATH, need to download */ }

  const url = BENTO4_URLS[platform];
  if (!url) {
    // No Bento4 prebuild for this platform (currently: linux-arm64).
    // Fall back to ffmpeg-based fragmentation. ffmpeg is already required
    // by the encoder for transcoding, so it's guaranteed to be available.
    logger.info(`[Bento4] No prebuild for ${platform} — using ffmpeg fragmentation fallback`);
    try {
      await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
      return { mp4fragment: 'ffmpeg', useFfmpegFallback: true };
    } catch (ffmpegErr: unknown) {
      const errMsg = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr);
      throw new Error(
        `No Bento4 binary available for ${platform} and ffmpeg fallback failed: ${errMsg}. ` +
        `Install ffmpeg (apt install ffmpeg / brew install ffmpeg) or Bento4 manually: ` +
        `https://www.bento4.com/downloads/`
      );
    }
  }

  // Download Bento4 from bok.net
  logger.info(`[Bento4] Downloading Bento4 SDK for ${platform}...`);
  const platformDir = join(bento4Dir, platform);
  mkdirSync(platformDir, { recursive: true });

  const zipPath = join(bento4Dir, `bento4-${platform}.zip`);

  // If the download fails (bok.net returns 404 / 500 / network issue),
  // fall back to ffmpeg rather than failing the whole encode pipeline.
  try {
    await downloadFile(url, zipPath);
  } catch (downloadErr: unknown) {
    const errMsg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
    logger.warn(`[Bento4] Download failed for ${platform} (${errMsg}) — falling back to ffmpeg`);
    try {
      await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
      return { mp4fragment: 'ffmpeg', useFfmpegFallback: true };
    } catch (ffmpegErr: unknown) {
      const ffErrMsg = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr);
      throw new Error(
        `Bento4 download from ${url} failed (${errMsg}) and ffmpeg fallback unavailable (${ffErrMsg}). ` +
        `Install ffmpeg or download Bento4 manually: https://www.bento4.com/downloads/`
      );
    }
  }

  logger.info('[Bento4] Extracting...');
  execSync(`unzip -o -q "${zipPath}" -d "${platformDir}"`, { timeout: 60000 });

  const extractedDirs = readdirSync(platformDir)
    .filter((f: string) => f.startsWith('Bento4'));
  if (extractedDirs.length > 0) {
    const extractedDir = join(platformDir, extractedDirs[0]);
    execSync(`cp -r "${extractedDir}/"* "${platformDir}/"`, { timeout: 30000 });
    execSync(`rm -rf "${extractedDir}"`, { timeout: 10000 });
  }

  if (existsSync(join(binDir, 'mp4fragment'))) {
    chmodSync(join(binDir, 'mp4fragment'), 0o755);
  }

  try { unlinkSync(zipPath); } catch { /* ignore */ }

  logger.info('[Bento4] SDK installed successfully (mp4fragment only)');

  return {
    mp4fragment: existsSync(mp4fragmentPath) ? mp4fragmentPath : 'mp4fragment',
  };
}

// ─── Download Helper ────────────────────────────────────────────────────────

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    const request = (protocol as typeof https).get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          downloadFile(redirectUrl, dest).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      reject(err);
    });

    request.setTimeout(300000, () => {
      request.destroy();
      reject(new Error('Download timed out'));
    });
  });
}
