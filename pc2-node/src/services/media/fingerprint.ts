/**
 * Perceptual Hashing / Content Fingerprinting Service
 *
 * Generates perceptual fingerprints for content duplicate detection
 * and provenance verification. Supports:
 *   - Images: pHash via sharp-phash (DCT-based, 64-bit)
 *   - Video: pHash of 5 evenly-spaced frames via FFmpeg extraction
 *   - Audio: Chromaprint fingerprint via fpcalc (if available)
 *   - Documents: SimHash of text content
 *
 * All computation is local — content never leaves the node.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import phash from 'sharp-phash';
import type { PerceptualHashResult, HashAlgorithm } from '../../sdk/types.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

const VIDEO_FRAME_COUNT = 5;
const FFMPEG_TIMEOUT = 30_000;
const FPCALC_TIMEOUT = 30_000;

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export async function computePerceptualHash(
  filePath: string,
  mimeType: string,
): Promise<PerceptualHashResult> {
  const now = new Date().toISOString();

  if (mimeType.startsWith('image/')) {
    return computeImageHash(filePath, now);
  }

  if (mimeType.startsWith('video/')) {
    return computeVideoHash(filePath, now);
  }

  if (mimeType.startsWith('audio/')) {
    return computeAudioHash(filePath, now);
  }

  if (isTextMime(mimeType)) {
    return computeTextHash(filePath, now);
  }

  logger.warn(`[fingerprint] Unsupported MIME for hashing: ${mimeType}, falling back to image attempt`);
  try {
    return await computeImageHash(filePath, now);
  } catch {
    return {
      dominantHash: '',
      algorithm: 'phash',
      computedAt: now,
    };
  }
}

/**
 * Hamming distance between two pHash strings (each char is '0' or '1').
 * Lower = more similar. 0 = identical. Typical threshold: <= 10 for similar.
 */
export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) distance++;
  }
  return distance;
}

// ────────────────────────────────────────────────────────────────
// Image Hashing
// ────────────────────────────────────────────────────────────────

async function computeImageHash(
  filePath: string,
  computedAt: string,
): Promise<PerceptualHashResult> {
  const imageBuffer = await readFile(filePath);
  const hash = await phash(imageBuffer);

  return {
    imageHashes: [hash],
    dominantHash: hash,
    algorithm: 'phash',
    computedAt,
  };
}

// ────────────────────────────────────────────────────────────────
// Video Hashing (extract frames -> pHash each)
// ────────────────────────────────────────────────────────────────

async function computeVideoHash(
  filePath: string,
  computedAt: string,
): Promise<PerceptualHashResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'phash-'));

  try {
    const duration = await getVideoDuration(filePath);
    if (duration <= 0) {
      throw new Error('Cannot determine video duration');
    }

    const timestamps = getFrameTimestamps(duration, VIDEO_FRAME_COUNT);
    const frameHashes: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const framePath = join(tmpDir, `frame_${i}.png`);

      try {
        await execFileAsync('ffmpeg', [
          '-ss', timestamps[i].toFixed(2),
          '-i', filePath,
          '-frames:v', '1',
          '-vf', 'scale=32:32',
          '-y',
          framePath,
        ], { timeout: FFMPEG_TIMEOUT });

        const frameBuffer = await readFile(framePath);
        const hash = await phash(frameBuffer);
        frameHashes.push(hash);
      } catch (err: any) {
        logger.warn(`[fingerprint] Frame ${i} extraction failed at ${timestamps[i].toFixed(2)}s: ${err.message}`);
      }
    }

    if (frameHashes.length === 0) {
      throw new Error('No frames could be extracted for hashing');
    }

    // Also try audio fingerprint if present
    let audioFingerprint: string | undefined;
    try {
      audioFingerprint = await extractChromaprint(filePath);
    } catch {
      // Audio fingerprint is optional for video
    }

    return {
      imageHashes: frameHashes,
      audioFingerprint,
      dominantHash: frameHashes[Math.floor(frameHashes.length / 2)],
      algorithm: 'phash',
      computedAt,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
}

// ────────────────────────────────────────────────────────────────
// Audio Hashing (Chromaprint via fpcalc)
// ────────────────────────────────────────────────────────────────

async function computeAudioHash(
  filePath: string,
  computedAt: string,
): Promise<PerceptualHashResult> {
  const fingerprint = await extractChromaprint(filePath);

  return {
    audioFingerprint: fingerprint,
    dominantHash: fingerprint,
    algorithm: 'chromaprint',
    computedAt,
  };
}

async function extractChromaprint(filePath: string): Promise<string> {
  // fpcalc is bundled with chromaprint; on macOS available via `brew install chromaprint`
  try {
    const { stdout } = await execFileAsync('fpcalc', [
      '-raw',
      '-length', '120',
      filePath,
    ], { timeout: FPCALC_TIMEOUT });

    const fingerprintLine = stdout.split('\n').find(l => l.startsWith('FINGERPRINT='));
    if (!fingerprintLine) {
      throw new Error('No FINGERPRINT line in fpcalc output');
    }

    return fingerprintLine.replace('FINGERPRINT=', '').trim();
  } catch (err: any) {
    // Fallback: extract raw audio fingerprint via FFmpeg audio analysis
    if (err.code === 'ENOENT') {
      logger.warn('[fingerprint] fpcalc not found — install chromaprint for audio fingerprinting');
    }
    throw new Error(`Audio fingerprinting unavailable: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Text / Document Hashing (SimHash)
// ────────────────────────────────────────────────────────────────

async function computeTextHash(
  filePath: string,
  computedAt: string,
): Promise<PerceptualHashResult> {
  const content = await readFile(filePath, 'utf-8');
  const hash = simhash(content);

  return {
    textHash: hash,
    dominantHash: hash,
    algorithm: 'simhash',
    computedAt,
  };
}

/**
 * SimHash: locality-sensitive hashing for text.
 * Similar documents produce hashes with small Hamming distance.
 *
 * Algorithm:
 *   1. Tokenize into shingles (word n-grams)
 *   2. Hash each shingle to a 64-bit value
 *   3. For each bit position, sum +1 (bit=1) or -1 (bit=0) across all shingle hashes
 *   4. Final hash: bit i = 1 if sum[i] > 0, else 0
 */
function simhash(text: string): string {
  const HASH_BITS = 64;
  const SHINGLE_SIZE = 3;

  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  if (words.length < SHINGLE_SIZE) {
    return '0'.repeat(HASH_BITS);
  }

  const weights = new Float64Array(HASH_BITS);

  for (let i = 0; i <= words.length - SHINGLE_SIZE; i++) {
    const shingle = words.slice(i, i + SHINGLE_SIZE).join(' ');
    const hash = fnv1a64(shingle);

    for (let bit = 0; bit < HASH_BITS; bit++) {
      const byteIdx = Math.floor(bit / 8);
      const bitIdx = bit % 8;
      if ((hash[byteIdx] >> bitIdx) & 1) {
        weights[bit] += 1;
      } else {
        weights[bit] -= 1;
      }
    }
  }

  let result = '';
  for (let bit = 0; bit < HASH_BITS; bit++) {
    result += weights[bit] > 0 ? '1' : '0';
  }

  return result;
}

/** FNV-1a hash producing 8 bytes (64-bit) for SimHash shingle hashing. */
function fnv1a64(str: string): Uint8Array {
  const FNV_OFFSET = BigInt('0xcbf29ce484222325');
  const FNV_PRIME = BigInt('0x100000001b3');

  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & BigInt('0xFFFFFFFFFFFFFFFF');
  }

  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number((hash >> BigInt(i * 8)) & BigInt(0xFF));
  }
  return bytes;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async function getVideoDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ], { timeout: FFMPEG_TIMEOUT });

  const info = JSON.parse(stdout);
  return parseFloat(info.format?.duration || '0');
}

function getFrameTimestamps(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 0) return [];
  if (count === 1) return [duration / 2];

  const margin = Math.min(duration * 0.05, 3);
  const start = Math.max(margin, 0.5);
  const end = duration - margin;

  if (start >= end) return [duration / 2];

  const step = (end - start) / (count - 1);
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    timestamps.push(start + step * i);
  }
  return timestamps;
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/pdf'
  );
}
