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
import { writeFileSync, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { encryptWithLitAction, buildSelfRefConditions, type EncryptResult } from '../../api/chipotle-client.js';
import { type Bento4Paths } from './bento4.js';

const execFileAsync = promisify(execFile);

const ELACITY_SYSTEM_ID = 'bf8ef85d2c54475d8c1ee27db60332a2';

const MEDIA_DECRYPT_ACTION_CID = 'QmcNdiSuT2c2zKwhGozTgvT12uP26gAWMw2D49GvcLj2Go';
const MEDIA_ENCRYPT_ACTION_CID = 'QmdwzJvfgCRvNh9pQ63zroFozR9CfJdiweqTCkVMubD47U';

const DEFAULT_AUTHORITY = process.env.DDRM_AUTHORITY || '0x580c26DefF267EF40A72CF10A4A42050F0641b8B';
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

  const result = await encryptWithLitAction({
    dataToEncrypt,
    accessControlConditions: conditions,
  });

  logger.info(`[DASHPackager] CEK encrypted via Chipotle (hash: ${result.dataToEncryptHash.substring(0, 12)}...)`);
  return result;
}

// ─── PSSH Construction ──────────────────────────────────────────────────────

export function buildPSSHJson(outputDir: string): string {
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
): Promise<string> {
  const psshPath = buildPSSHJson(outputDir);
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

  let totalSize = 0;
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        totalSize += statSync(fullPath).size;
      }
    }
  };
  walkDir(dashDir);

  // Use the IPFS instance's addDirectory if available, otherwise use CLI
  if (ipfs?.addDirectory) {
    const result = await ipfs.addDirectory(dashDir);
    logger.info(`[DASHPackager] Uploaded to IPFS: ${result.cid} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
    return { cid: result.cid.toString(), size: totalSize };
  }

  // Fallback: use ipfs CLI
  const { stdout } = await execFileAsync('ipfs', [
    'add', '-r', '-Q', '--cid-version', '0', dashDir,
  ], { timeout: 600000 });

  const cid = stdout.trim();
  logger.info(`[DASHPackager] Uploaded to IPFS: ${cid} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
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
  const dashDir = await packageDASH(fragmentedFiles, outputDir, cekHex, kid, bento4);

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
