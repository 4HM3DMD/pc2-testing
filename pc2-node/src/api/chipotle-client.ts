/**
 * chipotle-client.ts — Minimal REST client for Lit Protocol Chipotle (v3)
 *
 * Replaces the entire Lit SDK (@lit-protocol/*) with a single HTTP call.
 * No SIWE, no session sigs, no capacity credits, no WebSocket connections.
 *
 * Three-tier API key resolution:
 *   Tier 1: Elacity-provided shared key (default for all PC2 nodes)
 *   Tier 2: User-provided key (self-sovereign, set in Settings UI)
 *   Tier 3: Future — Elacity dDRM API product key
 *
 * Auto-provisioning: If no key is found locally, the client fetches
 * the shared config from an Elacity supernode on first use.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('chipotle');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');

// ── File Paths ───────────────────────────────────────────────────────────────

const CHIPOTLE_KEY_PATH = join(DATA_DIR, '.chipotle-api-key');
const USER_KEY_PATH = join(DATA_DIR, '.chipotle-user-key');
const LIT_ACTION_CID_PATH = join(DATA_DIR, '.lit-action-cid');
const PROVISION_CACHE_PATH = join(DATA_DIR, '.chipotle-provision.json');

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = 'https://api.dev.litprotocol.com';
const PROD_API_URL = 'https://api.litprotocol.com';

const DEFAULT_AUTHORITY = '0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29';
const DEFAULT_RPC = 'https://mainnet.base.org';
const DEFAULT_CHAIN = 'base';
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_PKP_ID = '0x09bdfc8f8ec5a3bd2970497b930bd94839f22227';

const SUPERNODE_PROVISION_URLS = [
  'https://69.164.241.210/api/ddrm/provision',
  'https://38.242.211.112/api/ddrm/provision',
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChipotleConfig {
  apiUrl?: string;
  apiKey?: string;
  pkpId?: string;
}

export interface LitActionParams {
  code: string;
  jsParams: Record<string, unknown>;
}

export interface LitActionResult {
  response: string;
  logs: string;
  hasError: boolean;
}

export interface NonMediaDecryptParams {
  litCiphertext: string;
  dataToEncryptHash: string;
  kid: string;
  buyerAddress: string;
  actionCid?: string;
  authority?: string;
  chain?: string;
  chainId?: number;
  rpc?: string;
}

export interface MediaDecryptParams {
  litCiphertext: string;
  dataToEncryptHash: string;
  kid: string;
  buyerAddress: string;
  actionCid: string;
  publicKeyHex: string;
  authority?: string;
  chain?: string;
  chainId?: number;
  rpc?: string;
}

export interface EncryptParams {
  dataToEncrypt: Uint8Array;
  accessControlConditions: Record<string, unknown>[];
}

export interface EncryptResult {
  ciphertext: string;
  dataToEncryptHash: string;
}

// ── Auto-Provisioning from Supernode ─────────────────────────────────────────

interface ProvisionConfig {
  version: number;
  network: string;
  apiUrl: string;
  usageKey: string;
  pkpId: string;
  authority: string;
  chain: string;
  chainId: number;
  rpc: string;
  actions: {
    nonMediaEncrypt: string;
    nonMediaDecrypt: string;
    mediaDecrypt?: string;
  };
}

let cachedProvision: ProvisionConfig | null = null;

function loadCachedProvision(): ProvisionConfig | null {
  if (cachedProvision) return cachedProvision;

  if (existsSync(PROVISION_CACHE_PATH)) {
    try {
      const raw = readFileSync(PROVISION_CACHE_PATH, 'utf8').trim();
      if (raw) {
        cachedProvision = JSON.parse(raw);
        return cachedProvision;
      }
    } catch {
      // Corrupted cache — will re-provision
    }
  }
  return null;
}

function httpsGet(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchProvisionFromSupernode(): Promise<ProvisionConfig | null> {
  for (const url of SUPERNODE_PROVISION_URLS) {
    try {
      logger.info(`[Chipotle] Fetching dDRM config from ${url}...`);
      const body = await httpsGet(url);
      const config: ProvisionConfig = JSON.parse(body);

      if (!config.usageKey || config.usageKey === 'REPLACE_WITH_USAGE_API_KEY') {
        logger.warn(`[Chipotle] Supernode ${url} has unprovisioned dDRM config, skipping`);
        continue;
      }

      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(PROVISION_CACHE_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
      writeFileSync(CHIPOTLE_KEY_PATH, config.usageKey, { mode: 0o600 });

      cachedProvision = config;
      logger.info(`[Chipotle] Auto-provisioned from supernode (network: ${config.network}, pkpId: ${config.pkpId.substring(0, 10)}...)`);
      return config;
    } catch (err: any) {
      logger.warn(`[Chipotle] Failed to fetch from ${url}: ${err.message}`);
    }
  }
  return null;
}

let provisionPromise: Promise<ProvisionConfig | null> | null = null;

async function ensureProvisioned(): Promise<ProvisionConfig | null> {
  const cached = loadCachedProvision();
  if (cached) return cached;

  if (!provisionPromise) {
    provisionPromise = fetchProvisionFromSupernode().finally(() => {
      provisionPromise = null;
    });
  }
  return provisionPromise;
}

// ── API Key Resolution ───────────────────────────────────────────────────────

function resolveApiKey(): string {
  // Tier 2: User-provided key takes priority (self-sovereign)
  const envUserKey = process.env.LIT_CHIPOTLE_USER_KEY;
  if (envUserKey) return envUserKey;

  if (existsSync(USER_KEY_PATH)) {
    const key = readFileSync(USER_KEY_PATH, 'utf8').trim();
    if (key) {
      logger.info('[Chipotle] Using user-provided API key (Tier 2 self-sovereign)');
      return key;
    }
  }

  // Tier 1: Shared Elacity key (default for all PC2 nodes)
  const envSharedKey = process.env.LIT_CHIPOTLE_USAGE_KEY;
  if (envSharedKey) return envSharedKey;

  if (existsSync(CHIPOTLE_KEY_PATH)) {
    const key = readFileSync(CHIPOTLE_KEY_PATH, 'utf8').trim();
    if (key) return key;
  }

  // Tier 0: Check cached provision (from supernode auto-fetch)
  const provision = loadCachedProvision();
  if (provision?.usageKey) return provision.usageKey;

  throw new Error(
    'No Chipotle API key configured. ' +
    'The node will auto-provision from a supernode on the next dDRM operation, ' +
    'or set LIT_CHIPOTLE_USAGE_KEY env var, or place the key in data/.chipotle-api-key',
  );
}

function resolvePkpId(config?: ChipotleConfig): string {
  if (config?.pkpId) return config.pkpId;
  const provision = loadCachedProvision();
  if (provision?.pkpId) return provision.pkpId;
  return DEFAULT_PKP_ID;
}

function resolveApiUrl(): string {
  return process.env.LIT_CHIPOTLE_API_URL || DEFAULT_API_URL;
}

// ── Lit Action Code Loading ──────────────────────────────────────────────────

let cachedNonMediaCode: string | null = null;
let cachedChipotleNonMediaCode: string | null = null;
let cachedChipotleEncryptCode: string | null = null;

function getNonMediaActionCode(): string {
  if (cachedNonMediaCode) return cachedNonMediaCode;

  const actionPath = join(DATA_DIR, 'lit-actions/non-media-decrypt.js');
  if (!existsSync(actionPath)) {
    throw new Error(
      `Non-media Lit Action not found at ${actionPath}. ` +
      'Deploy it first via POST /api/storage/lit/deploy-action.',
    );
  }
  cachedNonMediaCode = readFileSync(actionPath, 'utf8');
  return cachedNonMediaCode;
}

function getChipotleNonMediaActionCode(): string {
  if (cachedChipotleNonMediaCode) return cachedChipotleNonMediaCode;

  const actionPath = join(DATA_DIR, 'lit-actions/non-media-decrypt-chipotle.js');
  if (!existsSync(actionPath)) {
    throw new Error(
      `Chipotle non-media Lit Action not found at ${actionPath}.`,
    );
  }
  cachedChipotleNonMediaCode = readFileSync(actionPath, 'utf8');
  return cachedChipotleNonMediaCode;
}

function getChipotleEncryptCode(): string {
  if (cachedChipotleEncryptCode) return cachedChipotleEncryptCode;

  const actionPath = join(DATA_DIR, 'lit-actions/non-media-encrypt-chipotle.js');
  if (!existsSync(actionPath)) {
    throw new Error(
      `Chipotle encrypt Lit Action not found at ${actionPath}.`,
    );
  }
  cachedChipotleEncryptCode = readFileSync(actionPath, 'utf8');
  return cachedChipotleEncryptCode;
}

function getActionCid(): string {
  const envCid = process.env.LIT_ACTION_CID;
  if (envCid) return envCid;

  if (existsSync(LIT_ACTION_CID_PATH)) {
    const cid = readFileSync(LIT_ACTION_CID_PATH, 'utf8').trim();
    if (cid) return cid;
  }

  return 'QmVMgKMKFELHTZf8PmD58nYBhr4S5DHLpuwFTvyDKLPXgq';
}

// ── Core REST Client ─────────────────────────────────────────────────────────

class ChipotleError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ChipotleError';
  }
}

async function executeLitAction(params: LitActionParams, config?: ChipotleConfig): Promise<LitActionResult> {
  let apiKey = config?.apiKey;
  let apiUrl = config?.apiUrl;

  if (!apiKey) {
    try {
      apiKey = resolveApiKey();
    } catch {
      const provision = await ensureProvisioned();
      if (provision?.usageKey) {
        apiKey = provision.usageKey;
        if (!apiUrl) apiUrl = provision.apiUrl;
      } else {
        throw new Error(
          'No Chipotle API key configured and auto-provisioning from supernodes failed. ' +
          'Set LIT_CHIPOTLE_USAGE_KEY env var or place the key in data/.chipotle-api-key',
        );
      }
    }
  }

  apiUrl = apiUrl || resolveApiUrl();
  const url = `${apiUrl}/core/v1/lit_action`;

  logger.debug(`[Chipotle] POST ${url} (code: ${params.code.length} chars, params: ${Object.keys(params.jsParams).join(',')})`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      code: params.code,
      js_params: params.jsParams,
    }),
  });

  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ChipotleError(
      `Chipotle returned non-JSON: ${text.substring(0, 200)}`,
      resp.status,
    );
  }

  if (!resp.ok) {
    const errMsg = typeof json === 'string' ? json : json?.error || json?.message || text.substring(0, 300);
    throw new ChipotleError(
      `Chipotle HTTP ${resp.status}: ${errMsg}`,
      resp.status,
      json,
    );
  }

  if (json.has_error) {
    logger.warn(`[Chipotle] Lit Action had errors. Logs: ${json.logs?.substring(0, 200)}`);
  }

  return {
    response: typeof json.response === 'string' ? json.response : JSON.stringify(json.response),
    logs: json.logs || '',
    hasError: json.has_error || false,
  };
}

// ── High-Level Operations ────────────────────────────────────────────────────

/**
 * Recover the Content Encryption Key for a non-media asset.
 * Replaces: getLitClient() + getExecuteSessionSigs() + client.executeJs()
 */
export async function recoverNonMediaCEK(
  params: NonMediaDecryptParams,
  config?: ChipotleConfig,
): Promise<string> {
  const code = getChipotleNonMediaActionCode();
  const pkpId = resolvePkpId(config);

  const jsParams = {
    ciphertext: params.litCiphertext,
    dataToEncryptHash: params.dataToEncryptHash,
    kid: params.kid.startsWith('0x') ? params.kid : `0x${params.kid}`,
    pkpId,
    authority: params.authority || DEFAULT_AUTHORITY,
    chain: params.chain || DEFAULT_CHAIN,
    chainId: params.chainId || DEFAULT_CHAIN_ID,
    rpc: params.rpc || DEFAULT_RPC,
    userAddress: params.buyerAddress,
  };

  const result = await executeLitAction({ code, jsParams }, config);

  // The Lit Action returns the CEK as a plain string (base64) or as JSON { data: base64 }
  let cekBase64: string;
  try {
    const parsed = JSON.parse(result.response);
    if (parsed.error) {
      throw new Error(`Lit Action denied: ${parsed.error}`);
    }
    cekBase64 = parsed.data || parsed;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Lit Action denied')) throw e;
    cekBase64 = result.response;
  }

  if (!cekBase64 || cekBase64.length < 10) {
    throw new Error(`Invalid CEK response: ${result.response?.substring(0, 100)}`);
  }

  logger.info(`[Chipotle] Non-media CEK recovered (${cekBase64.length} chars)`);
  return cekBase64;
}

/**
 * Recover the Content Encryption Key for a media asset via ECDH envelope.
 * Replaces: recoverMediaCEK() with its ECDH key pair + client.executeJs()
 *
 * The caller still handles ECDH key generation and envelope unwrapping.
 * This function just runs the Lit Action and returns the raw base64 envelope.
 */
export async function recoverMediaCEKEnvelope(
  params: MediaDecryptParams,
  mediaActionCode: string,
  config?: ChipotleConfig,
): Promise<Buffer> {
  const jsParams = {
    keyAlg: { name: 'ECDH', namedCurve: 'P-256' },
    publicKey: params.publicKeyHex,
    ciphertext: params.litCiphertext,
    dataToEncryptHash: params.dataToEncryptHash,
    kid: params.kid.startsWith('0x') ? params.kid : `0x${params.kid}`,
    actionIpfsId: params.actionCid,
    authority: params.authority || DEFAULT_AUTHORITY,
    chain: params.chain || DEFAULT_CHAIN,
    chainId: params.chainId || DEFAULT_CHAIN_ID,
    rpc: params.rpc || DEFAULT_RPC,
    userAddress: params.buyerAddress,
  };

  const result = await executeLitAction({ code: mediaActionCode, jsParams }, config);

  // Media Lit Action returns a base64-encoded binary ECDH envelope
  const envelope = Buffer.from(result.response, 'base64');
  logger.info(`[Chipotle] Media CEK envelope received (${envelope.length} bytes)`);
  return envelope;
}

/**
 * Encrypt data using Chipotle's PKP-AES encryption (Lit.Actions.Encrypt).
 *
 * This replaces Datil's client.encrypt() for new assets. The CEK is encrypted
 * by the TEE using the master PKP's AES key, producing a ciphertext string
 * that can only be decrypted by the same PKP via Lit.Actions.Decrypt.
 *
 * Note: assets encrypted with this method are NOT compatible with Datil's
 * decryptAndCombine. A litBackend metadata field tracks which scheme was used.
 */
export async function encryptWithLitAction(
  params: EncryptParams,
  config?: ChipotleConfig,
): Promise<EncryptResult> {
  const pkpId = resolvePkpId(config);

  // params.dataToEncrypt is the UTF-8 bytes of the base64 CEK string.
  // Pass it directly as a string to the Lit Action so Decrypt returns
  // the same string — no double-base64 encoding.
  const plaintext = new TextDecoder().decode(params.dataToEncrypt);

  const code = getChipotleEncryptCode();

  const result = await executeLitAction(
    { code, jsParams: { pkpId, plaintext } },
    config,
  );

  let parsed: { ciphertext?: string; error?: string };
  try {
    parsed = JSON.parse(result.response);
  } catch {
    throw new Error(`Chipotle encrypt returned unparseable response: ${result.response.substring(0, 200)}`);
  }

  if (parsed.error) {
    throw new ChipotleError(`Chipotle encrypt failed: ${parsed.error}`, 500);
  }

  if (!parsed.ciphertext) {
    throw new Error('Chipotle encrypt returned no ciphertext');
  }

  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');

  logger.info(`[Chipotle] Encrypted ${params.dataToEncrypt.length} bytes via PKP-AES (pkpId: ${pkpId.substring(0, 10)}...)`);

  return {
    ciphertext: parsed.ciphertext,
    dataToEncryptHash: hash,
  };
}

// ── Utility: Build Self-Referential Conditions ───────────────────────────────

export function buildSelfRefConditions(actionCid: string, chain = 'base') {
  return [
    {
      conditionType: 'evmBasic',
      contractAddress: '',
      standardContractType: '',
      chain,
      method: '',
      parameters: [':currentActionIpfsId'],
      returnValueTest: {
        comparator: '=',
        value: actionCid,
      },
    },
  ];
}

// ── Utility: Save/Read User Key ──────────────────────────────────────────────

export function saveUserApiKey(key: string): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USER_KEY_PATH, key, { mode: 0o600 });
  logger.info('[Chipotle] User API key saved (Tier 2 self-sovereign)');
}

export function getUserApiKey(): string | null {
  if (existsSync(USER_KEY_PATH)) {
    const key = readFileSync(USER_KEY_PATH, 'utf8').trim();
    return key || null;
  }
  return null;
}

export function clearUserApiKey(): void {
  if (existsSync(USER_KEY_PATH)) {
    writeFileSync(USER_KEY_PATH, '', { mode: 0o600 });
    logger.info('[Chipotle] User API key cleared (reverted to Tier 1)');
  }
}

// ── Utility: Get Current Config Info ─────────────────────────────────────────

export function getChipotleInfo() {
  const userKey = getUserApiKey();
  return {
    apiUrl: resolveApiUrl(),
    tier: userKey ? 2 : 1,
    tierLabel: userKey ? 'Self-sovereign (user-provided key)' : 'Shared Elacity key',
    actionCid: getActionCid(),
    authority: DEFAULT_AUTHORITY,
    chain: DEFAULT_CHAIN,
    chainId: DEFAULT_CHAIN_ID,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

export {
  executeLitAction,
  resolveApiKey,
  resolveApiUrl,
  getActionCid,
  getNonMediaActionCode,
  getChipotleNonMediaActionCode,
  getChipotleEncryptCode,
  ChipotleError,
  DEFAULT_PKP_ID,
};
