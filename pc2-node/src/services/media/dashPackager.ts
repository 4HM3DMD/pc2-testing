/**
 * DASH Packager for PC2 Node.
 *
 * Handles CENC encryption and MPEG-DASH packaging:
 *   CEK generation -> Chipotle CEK escrow -> PSSH construction -> mp4dash -> IPFS upload
 *
 * Uses the Elacity custom PSSH system ID and dDRM metadata format.
 */

import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { encryptWithLitAction, buildSelfRefConditions, type EncryptResult } from '../../api/chipotle-client.js';
import { type Bento4Paths } from './bento4.js';

const execFileAsync = promisify(execFile);

const ELACITY_SYSTEM_ID = 'bf8ef85d2c54475d8c1ee27db60332a2';

const MEDIA_DECRYPT_ACTION_CID = 'QmcNdiSuT2c2zKwhGozTgvT12uP26gAWMw2D49GvcLj2Go';
const MEDIA_ENCRYPT_ACTION_CID = 'QmdwzJvfgCRvNh9pQ63zroFozR9CfJdiweqTCkVMubD47U';

const DEFAULT_AUTHORITY = process.env.DDRM_AUTHORITY || '0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29';
const DEFAULT_CHAIN_ID = parseInt(process.env.DDRM_CHAIN_ID || '8453', 10);
const DEFAULT_RPC = process.env.DDRM_RPC || 'https://mainnet.base.org';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DashPackageResult {
  cid: string;
  mpdUri: string;
  kid: string;
  ciphertext: string;
  dataToEncryptHash: string;
  litBackend: 'chipotle';
  size: number;
}

interface PSSHProtectionData {
  protocolVersion: string;
  protectionType: string;
  variant: string;
  ciphersuite: string;
  data: {
    authority: string;
    chainId: number;
    rpc: string;
    actionIpfsId: string;
    litBackend: string;
    ciphertext: string;
    hash: string;
    kid: string;
  };
}

// ─── CEK Generation ─────────────────────────────────────────────────────────

export function generateCEK(): { cek: Buffer; kid: string } {
  const cek = crypto.randomBytes(16);
  const kid = crypto.randomUUID().replace(/-/g, '');
  return { cek, kid };
}

// ─── CEK Encryption via Chipotle ────────────────────────────────────────────

export async function encryptMediaCEK(cek: Buffer): Promise<EncryptResult> {
  const cekBase64 = cek.toString('base64');
  const dataToEncrypt = new TextEncoder().encode(cekBase64);
  const conditions = buildSelfRefConditions(MEDIA_ENCRYPT_ACTION_CID);

  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await encryptWithLitAction({
        dataToEncrypt,
        accessControlConditions: conditions,
      });
      logger.info(`[DASHPackager] CEK encrypted via Chipotle (hash: ${result.dataToEncryptHash.substring(0, 12)}...)`);
      return result;
    } catch (err: any) {
      const msg = err.message || '';
      const isRetryable = msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('TLS') ||
        msg.includes('SSL') ||
        msg.includes('socket disconnected') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED');
      if (isRetryable && attempt < MAX_RETRIES) {
        const delayMs = Math.min(attempt * 3000, 15000);
        logger.warn(`[DASHPackager] CEK encrypt attempt ${attempt}/${MAX_RETRIES} failed (${msg}), retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('encryptMediaCEK: unreachable');
}

// ─── PSSH Construction ──────────────────────────────────────────────────────

export function buildPSSHJson(outputDir: string, encryptResult: { ciphertext: string; dataToEncryptHash: string }): string {
  // Derive the on-chain content ID (bytes16) from the encryption hash.
  // Must match hashToContentId() in the creator app: first 16 bytes, 0x-prefixed.
  const cleanHash = encryptResult.dataToEncryptHash.startsWith('0x')
    ? encryptResult.dataToEncryptHash.slice(2)
    : encryptResult.dataToEncryptHash;
  const contractKid = '0x' + cleanHash.slice(0, 32).padEnd(32, '0');

  const protectionData: PSSHProtectionData = {
    protocolVersion: '2.0',
    protectionType: 'cenc:web3-drm-v1',
    variant: 'eth.web3.clearkey',
    ciphersuite: 'e8582013',
    data: {
      authority: DEFAULT_AUTHORITY,
      chainId: DEFAULT_CHAIN_ID,
      rpc: DEFAULT_RPC,
      actionIpfsId: MEDIA_DECRYPT_ACTION_CID,
      litBackend: 'chipotle',
      ciphertext: encryptResult.ciphertext,
      hash: encryptResult.dataToEncryptHash,
      kid: contractKid,
    },
  };

  const psshPath = join(outputDir, `pssh-${ELACITY_SYSTEM_ID}.json`);
  writeFileSync(psshPath, JSON.stringify(protectionData));
  return psshPath;
}

// ─── DASH Packaging with CENC Encryption ────────────────────────────────────

export async function packageDASH(
  fragmentedFiles: string[],
  outputDir: string,
  cekHex: string,
  kid: string,
  bento4: Bento4Paths,
  encryptResult: { ciphertext: string; dataToEncryptHash: string },
): Promise<string> {
  const psshPath = buildPSSHJson(outputDir, encryptResult);
  const dashDir = join(outputDir, 'dash');

  const encryptionArgs = `--global-option mpeg-cenc.eme-pssh:true --pssh ${ELACITY_SYSTEM_ID}:${psshPath}`;

  const args = [
    bento4.mp4dash,
    '--use-segment-timeline',
    `--encryption-key=${kid}:${cekHex}:random`,
    '--encryption-cenc-scheme=cenc',
    `--encryption-args=${encryptionArgs}`,
    `--output-dir=${dashDir}`,
    '--force',
    ...fragmentedFiles,
  ];

  logger.info(`[DASHPackager] Running mp4dash with ${fragmentedFiles.length} input(s)...`);

  const { stdout, stderr } = await execFileAsync(bento4.python3, args, {
    timeout: 600000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${join(bento4.mp4encrypt, '..')}:${process.env.PATH}`,
    },
  });

  const mpdPath = join(dashDir, 'stream.mpd');
  if (!existsSync(mpdPath)) {
    throw new Error(`mp4dash failed to produce MPD. stderr: ${stderr}`);
  }

  logger.info(`[DASHPackager] DASH package created at ${dashDir}`);
  return dashDir;
}

// ─── IPFS Upload ────────────────────────────────────────────────────────────

export async function uploadDashToIPFS(
  dashDir: string,
  ipfs: any,
): Promise<{ cid: string; size: number }> {
  logger.info(`[DASHPackager] Uploading DASH directory to IPFS...`);

  const files: Record<string, Buffer> = {};
  let totalSize = 0;

  const walkDir = (dir: string, basePath: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else {
        const content = readFileSync(fullPath);
        files[relPath] = content;
        totalSize += content.length;
      }
    }
  };
  walkDir(dashDir, '');

  if (ipfs?.storeDirectory) {
    const cid = await ipfs.storeDirectory(files, { pin: true });
    logger.info(`[DASHPackager] Uploaded to IPFS via Helia: ${cid} (${(totalSize / 1024 / 1024).toFixed(1)} MB, ${Object.keys(files).length} files)`);
    return { cid, size: totalSize };
  }

  // Fallback: ipfs CLI (requires go-ipfs)
  const { stdout } = await execFileAsync('ipfs', [
    'add', '-r', '-Q', '--cid-version', '0', dashDir,
  ], { timeout: 600000 });

  const cid = stdout.trim();
  logger.info(`[DASHPackager] Uploaded to IPFS via CLI: ${cid} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
  return { cid, size: totalSize };
}

// ─── Full DASH Pipeline ─────────────────────────────────────────────────────

export async function createEncryptedDASH(
  fragmentedFiles: string[],
  outputDir: string,
  bento4: Bento4Paths,
  ipfs: any,
): Promise<DashPackageResult> {
  // Generate and encrypt CEK
  const { cek, kid } = generateCEK();
  const cekHex = cek.toString('hex');

  let encryptResult: EncryptResult;
  try {
    encryptResult = await encryptMediaCEK(cek);
  } finally {
    cek.fill(0);
  }

  // Package DASH with CENC encryption
  const dashDir = await packageDASH(fragmentedFiles, outputDir, cekHex, kid, bento4, encryptResult);

  // Upload to IPFS
  const { cid, size } = await uploadDashToIPFS(dashDir, ipfs);

  return {
    cid,
    mpdUri: `ipfs://${cid}/stream.mpd`,
    kid,
    ciphertext: encryptResult.ciphertext,
    dataToEncryptHash: encryptResult.dataToEncryptHash,
    litBackend: 'chipotle',
    size,
  };
}
