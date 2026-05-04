/**
 * Boson Identity Service
 * 
 * Manages PC2 node identity using Ed25519 keypairs.
 * - Generates new identity on first run
 * - Stores identity securely in data directory
 * - Provides DID (did:boson:{nodeId})
 * - Provides 24-word mnemonic backup that deterministically derives the keypair
 * 
 * Identity versions:
 * - v1 (legacy): Keys randomly generated, mnemonic independent (cannot derive keys)
 * - v2 (current): Mnemonic generated first, keys deterministically derived from it
 */

import { createHash, randomBytes, createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import nacl from 'tweetnacl';
import { logger } from '../../utils/logger.js';
import { 
  EncryptedMnemonic, 
  encryptMnemonicWithSignature, 
  decryptMnemonicWithSignature,
  getMnemonicSignMessage 
} from '../../utils/encryption.js';

// Well-known DER prefixes for Ed25519 key encoding (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// BIP39 English wordlist (2048 words)
// Using a simplified subset for demonstration - in production use a full BIP39 library
const WORDLIST = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
  'adapt', 'add', 'addict', 'address', 'adjust', 'admit', 'adult', 'advance',
  'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent',
  'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album',
  'alcohol', 'alert', 'alien', 'all', 'alley', 'allow', 'almost', 'alone',
  'alpha', 'already', 'also', 'alter', 'always', 'amateur', 'amazing', 'among',
  'amount', 'amused', 'analyst', 'anchor', 'ancient', 'anger', 'angle', 'angry',
  'animal', 'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique',
  'anxiety', 'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april',
  'arch', 'arctic', 'area', 'arena', 'argue', 'arm', 'armed', 'armor',
  'army', 'around', 'arrange', 'arrest', 'arrive', 'arrow', 'art', 'artefact',
  'artist', 'artwork', 'ask', 'aspect', 'assault', 'asset', 'assist', 'assume',
  'asthma', 'athlete', 'atom', 'attack', 'attend', 'attitude', 'attract', 'auction',
  'audit', 'august', 'aunt', 'author', 'auto', 'autumn', 'average', 'avocado',
  'avoid', 'awake', 'aware', 'away', 'awesome', 'awful', 'awkward', 'axis',
  'baby', 'bachelor', 'bacon', 'badge', 'bag', 'balance', 'balcony', 'ball',
  'bamboo', 'banana', 'banner', 'bar', 'barely', 'bargain', 'barrel', 'base',
  'basic', 'basket', 'battle', 'beach', 'bean', 'beauty', 'because', 'become',
  'beef', 'before', 'begin', 'behave', 'behind', 'believe', 'below', 'belt',
  'bench', 'benefit', 'best', 'betray', 'better', 'between', 'beyond', 'bicycle',
  'bid', 'bike', 'bind', 'biology', 'bird', 'birth', 'bitter', 'black',
  'blade', 'blame', 'blanket', 'blast', 'bleak', 'bless', 'blind', 'blood',
  'blossom', 'blouse', 'blue', 'blur', 'blush', 'board', 'boat', 'body',
  'boil', 'bomb', 'bone', 'bonus', 'book', 'boost', 'border', 'boring',
  'borrow', 'boss', 'bottom', 'bounce', 'box', 'boy', 'bracket', 'brain',
  'brand', 'brass', 'brave', 'bread', 'breeze', 'brick', 'bridge', 'brief',
  'bright', 'bring', 'brisk', 'broccoli', 'broken', 'bronze', 'broom', 'brother',
  'brown', 'brush', 'bubble', 'buddy', 'budget', 'buffalo', 'build', 'bulb',
  'bulk', 'bullet', 'bundle', 'bunker', 'burden', 'burger', 'burst', 'bus',
  'business', 'busy', 'butter', 'buyer', 'buzz', 'cabbage', 'cabin', 'cable',
  // ... truncated for size, using first 256 words
  'cage', 'cake', 'call', 'calm', 'camera', 'camp', 'can', 'canal',
  'cancel', 'candy', 'cannon', 'canoe', 'canvas', 'canyon', 'capable', 'capital',
  'captain', 'car', 'carbon', 'card', 'cargo', 'carpet', 'carry', 'cart',
  'case', 'cash', 'casino', 'castle', 'casual', 'cat', 'catalog', 'catch',
  'category', 'cattle', 'caught', 'cause', 'caution', 'cave', 'ceiling', 'celery',
  'cement', 'census', 'century', 'cereal', 'certain', 'chair', 'chalk', 'champion',
  'change', 'chaos', 'chapter', 'charge', 'chase', 'chat', 'cheap', 'check',
  'cheese', 'chef', 'cherry', 'chest', 'chicken', 'chief', 'child', 'chimney',
  'choice', 'choose', 'chronic', 'chuckle', 'chunk', 'churn', 'cigar', 'cinnamon',
  'circle', 'citizen', 'city', 'civil', 'claim', 'clap', 'clarify', 'claw',
  'clay', 'clean', 'clerk', 'clever', 'click', 'client', 'cliff', 'climb',
  'clinic', 'clip', 'clock', 'clog', 'close', 'cloth', 'cloud', 'clown',
  'club', 'clump', 'cluster', 'clutch', 'coach', 'coast', 'coconut', 'code',
  'coffee', 'coil', 'coin', 'collect', 'color', 'column', 'combine', 'come',
  'comfort', 'comic', 'common', 'company', 'concert', 'conduct', 'confirm', 'congress',
  'connect', 'consider', 'control', 'convince', 'cook', 'cool', 'copper', 'copy',
  'coral', 'core', 'corn', 'correct', 'cost', 'cotton', 'couch', 'country',
  'couple', 'course', 'cousin', 'cover', 'coyote', 'crack', 'cradle', 'craft',
  'cram', 'crane', 'crash', 'crater', 'crawl', 'crazy', 'cream', 'credit',
  'creek', 'crew', 'cricket', 'crime', 'crisp', 'critic', 'crop', 'cross',
  'crouch', 'crowd', 'crucial', 'cruel', 'cruise', 'crumble', 'crunch', 'crush',
  'cry', 'crystal', 'cube', 'culture', 'cup', 'cupboard', 'curious', 'current',
  'curtain', 'curve', 'cushion', 'custom', 'cute', 'cycle', 'dad', 'damage',
  'damp', 'dance', 'danger', 'daring', 'dash', 'daughter', 'dawn', 'day',
  'deal', 'debate', 'debris', 'decade', 'december', 'decide', 'decline', 'decorate',
  'decrease', 'deer', 'defense', 'define', 'defy', 'degree', 'delay', 'deliver',
  'demand', 'demise', 'denial', 'dentist', 'deny', 'depart', 'depend', 'deposit',
  'depth', 'deputy', 'derive', 'describe', 'desert', 'design', 'desk', 'despair',
  'destroy', 'detail', 'detect', 'develop', 'device', 'devote', 'diagram', 'dial',
  'diamond', 'diary', 'dice', 'diesel', 'diet', 'differ', 'digital', 'dignity',
  'dilemma', 'dinner', 'dinosaur', 'direct', 'dirt', 'disagree', 'discover', 'disease',
];

// Base58 alphabet (Bitcoin style)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface NodeIdentity {
  nodeId: string;           // Base58 encoded public key
  did: string;              // did:boson:{nodeId}
  publicKey: string;        // Hex encoded public key (SPKI DER)
  privateKey: string;       // Hex encoded private key (PKCS8 DER)
  identityVersion?: number; // 1 = legacy (random keys), 2 = mnemonic-derived keys
  mnemonic?: string;        // 24-word recovery phrase (only in memory on first run)
  encryptedMnemonic?: EncryptedMnemonic;  // Encrypted mnemonic (stored on disk)
  adminWalletAddress?: string;  // First wallet to login becomes admin
  createdAt: string;        // ISO timestamp
}

export interface IdentityConfig {
  dataDir: string;          // Directory to store identity
  identityFile?: string;    // Identity filename (default: identity.json)
}

/**
 * Convert bytes to Base58 encoding
 */
export function toBase58(bytes: Buffer): string {
  let num = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  
  while (num > 0n) {
    const remainder = Number(num % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    num = num / 58n;
  }
  
  // Handle leading zeros
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }
  
  return result || '1';
}

/**
 * Convert Base58 string back to bytes
 */
export function fromBase58(str: string): Buffer {
  if (!str || str.length === 0) {
    return Buffer.alloc(0);
  }
  
  let num = BigInt(0);
  
  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }
    num = num * 58n + BigInt(index);
  }
  
  // Convert to hex string
  let hex = num.toString(16);
  // Pad to even length
  if (hex.length % 2 !== 0) {
    hex = '0' + hex;
  }
  
  // Handle leading '1's (zeros)
  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') {
      leadingZeros++;
    } else {
      break;
    }
  }
  
  // Create buffer with leading zeros
  const dataBytes = Buffer.from(hex, 'hex');
  if (leadingZeros > 0) {
    return Buffer.concat([Buffer.alloc(leadingZeros), dataBytes]);
  }
  
  return dataBytes;
}

/**
 * Generate a 24-word mnemonic from 32 bytes of entropy.
 * Each word is selected by 2 bytes of entropy mod wordlist size.
 */
function generateMnemonic(entropy: Buffer): string {
  const words: string[] = [];
  const wordlistSize = WORDLIST.length;
  
  for (let i = 0; i < 24; i++) {
    const index = (entropy[i * 2 % entropy.length] * 256 + entropy[(i * 2 + 1) % entropy.length]) % wordlistSize;
    words.push(WORDLIST[index]);
  }
  
  return words.join(' ');
}

/**
 * Derive a deterministic 32-byte Ed25519 seed from a mnemonic phrase.
 * Uses HKDF-SHA256 with a fixed salt for domain separation.
 */
function mnemonicToSeed(mnemonic: string): Buffer {
  const ikm = Buffer.from(mnemonic, 'utf8');
  const salt = Buffer.from('pc2-boson-identity-v2', 'utf8');
  const info = Buffer.from('ed25519-seed', 'utf8');

  // HKDF-Extract: PRK = HMAC-SHA256(salt, ikm)
  const prk = createHmac('sha256', salt).update(ikm).digest();

  // HKDF-Expand: OKM = HMAC-SHA256(PRK, info || 0x01) truncated to 32 bytes
  const okm = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();

  return okm;
}

/**
 * Derive Ed25519 keypair from mnemonic, returned in PKCS8/SPKI DER format
 * for storage compatibility with existing getKeypair() logic.
 */
export function deriveFromMnemonic(mnemonic: string): { publicKey: Buffer; privateKey: Buffer } {
  const seed = mnemonicToSeed(mnemonic);
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));

  const rawPub = Buffer.from(kp.publicKey);
  const rawSeed = seed;

  // Wrap in DER format so getKeypair() can extract via slice(-32)
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, rawSeed]);

  return { publicKey: spki, privateKey: pkcs8 };
}

export class IdentityService {
  private config: IdentityConfig;
  private identity: NodeIdentity | null = null;
  private identityPath: string;
  private isFirstRun: boolean = false;

  constructor(config: IdentityConfig) {
    this.config = config;
    this.identityPath = join(config.dataDir, config.identityFile || 'identity.json');
  }

  /**
   * Initialize identity service
   * - Loads existing identity or generates new one
   */
  async initialize(): Promise<void> {
    // Ensure data directory exists
    if (!existsSync(this.config.dataDir)) {
      mkdirSync(this.config.dataDir, { recursive: true });
    }

    if (existsSync(this.identityPath)) {
      // Load existing identity
      this.identity = this.loadIdentity();
      logger.info(`🔑 Loaded existing node identity: ${this.identity.nodeId.slice(0, 12)}...`);
    } else {
      // Generate new identity
      this.identity = this.generateIdentity();
      this.saveIdentity();
      this.isFirstRun = true;
      logger.info(`🆕 Generated new node identity: ${this.identity.nodeId.slice(0, 12)}...`);
    }
  }

  /**
   * Generate new node identity (v2: mnemonic-derived keys).
   * 
   * Flow: entropy --> mnemonic --> HKDF seed --> Ed25519 keypair
   * The mnemonic deterministically produces the same keypair every time.
   */
  private generateIdentity(): NodeIdentity {
    const entropy = randomBytes(48);
    const mnemonic = generateMnemonic(entropy);

    const { publicKey, privateKey } = deriveFromMnemonic(mnemonic);

    const rawPublicKey = publicKey.slice(-32);
    const nodeId = toBase58(rawPublicKey);
    const did = `did:boson:${nodeId}`;

    return {
      nodeId,
      did,
      publicKey: publicKey.toString('hex'),
      privateKey: privateKey.toString('hex'),
      identityVersion: 2,
      mnemonic,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Load identity from file
   */
  private loadIdentity(): NodeIdentity {
    const content = readFileSync(this.identityPath, 'utf8');
    const data = JSON.parse(content);
    
    // Keep encryptedMnemonic if present, but not plaintext mnemonic
    const { mnemonic, ...identity } = data;
    return identity as NodeIdentity;
  }

  /**
   * Save identity to file (without mnemonic)
   */
  private saveIdentity(): void {
    if (!this.identity) return;
    
    // Store identity WITHOUT mnemonic (mnemonic only shown once)
    const { mnemonic, ...identityWithoutMnemonic } = this.identity;
    
    writeFileSync(
      this.identityPath,
      JSON.stringify(identityWithoutMnemonic, null, 2),
      { mode: 0o600 } // Restrictive permissions
    );
    
    logger.info(`💾 Identity saved to ${this.identityPath}`);
  }

  /**
   * Get node identity
   */
  getIdentity(): NodeIdentity | null {
    return this.identity;
  }

  /**
   * Get node ID
   */
  getNodeId(): string | null {
    return this.identity?.nodeId || null;
  }

  /**
   * Get DID
   */
  getDID(): string | null {
    return this.identity?.did || null;
  }

  /**
   * Check if this is first run (mnemonic should be shown)
   */
  isNewIdentity(): boolean {
    return this.isFirstRun;
  }

  /**
   * Get mnemonic (only available on first run)
   */
  getMnemonic(): string | null {
    if (this.isFirstRun && this.identity?.mnemonic) {
      return this.identity.mnemonic;
    }
    return null;
  }

  /**
   * Get identity info for display (safe, no private key)
   */
  getPublicInfo(): { nodeId: string; did: string; createdAt: string } | null {
    if (!this.identity) return null;
    
    return {
      nodeId: this.identity.nodeId,
      did: this.identity.did,
      createdAt: this.identity.createdAt
    };
  }

  /**
   * Get cryptographic keys as Buffers for Active Proxy authentication
   * Converts from stored PKCS8 DER / SPKI formats to raw Ed25519 format
   * 
   * Key Format Conversion:
   * - PKCS8 DER (48 bytes) = 16-byte ASN.1 header + 32-byte seed
   * - SPKI (44 bytes) = 12-byte ASN.1 header + 32-byte public key
   * - Raw Ed25519 (64 bytes) = 32-byte seed + 32-byte public key
   */
  getKeypair(): { publicKey: Buffer; privateKey: Buffer } | null {
    if (!this.identity) return null;
    
    // Get stored keys (PKCS8 DER and SPKI formats)
    const storedPrivateKey = Buffer.from(this.identity.privateKey, 'hex');
    const storedPublicKey = Buffer.from(this.identity.publicKey, 'hex');
    
    // Extract raw 32-byte public key from SPKI (last 32 bytes)
    const rawPublicKey = storedPublicKey.slice(-32);
    
    // Extract raw 32-byte seed from PKCS8 DER (last 32 bytes)
    const rawSeed = storedPrivateKey.slice(-32);
    
    // Raw Ed25519 private key format: seed (32) + public (32) = 64 bytes
    const rawPrivateKey = Buffer.concat([rawSeed, rawPublicKey]);
    
    return {
      publicKey: rawPublicKey,
      privateKey: rawPrivateKey,
    };
  }

  /**
   * Check if mnemonic has been encrypted and stored
   */
  hasMnemonicBackup(): boolean {
    return !!this.identity?.encryptedMnemonic;
  }

  /**
   * Encrypt and store the mnemonic using wallet signature.
   * Call this after user confirms they've saved the mnemonic.
   * @param signature - Wallet signature for encryption
   * @param walletAddress - Wallet address used for signing
   * @returns true if successful
   */
  encryptAndStoreMnemonic(signature: string, walletAddress: string): boolean {
    if (!this.identity) {
      logger.error('[IdentityService] No identity loaded');
      return false;
    }

    if (!this.identity.mnemonic) {
      logger.warn('[IdentityService] No mnemonic available to encrypt');
      return false;
    }

    try {
      // Encrypt mnemonic with wallet signature
      const encrypted = encryptMnemonicWithSignature(
        this.identity.mnemonic,
        signature,
        walletAddress
      );

      // Store encrypted mnemonic in identity
      this.identity.encryptedMnemonic = encrypted;

      // Clear plaintext mnemonic from memory
      delete this.identity.mnemonic;

      // Save identity with encrypted mnemonic
      this.saveIdentityWithEncryptedMnemonic();

      logger.info('[IdentityService] Mnemonic encrypted and stored securely');
      return true;
    } catch (error: any) {
      logger.error('[IdentityService] Failed to encrypt mnemonic:', error.message);
      return false;
    }
  }

  /**
   * Encrypt and store a user-provided mnemonic directly.
   * Used when the mnemonic is not in memory (e.g., after node restart).
   * @param mnemonic - The 24-word mnemonic phrase
   * @param signature - Wallet signature for encryption
   * @param walletAddress - Wallet address used for signing
   * @returns true if successful
   */
  encryptAndStoreMnemonicDirect(mnemonic: string, signature: string, walletAddress: string): boolean {
    if (!this.identity) {
      logger.error('[IdentityService] No identity loaded');
      return false;
    }

    try {
      // Encrypt mnemonic with wallet signature
      const encrypted = encryptMnemonicWithSignature(
        mnemonic,
        signature,
        walletAddress
      );

      // Store encrypted mnemonic in identity
      this.identity.encryptedMnemonic = encrypted;

      // Save identity with encrypted mnemonic
      this.saveIdentityWithEncryptedMnemonic();

      logger.info('[IdentityService] User-provided mnemonic encrypted and stored securely');
      return true;
    } catch (error: any) {
      logger.error('[IdentityService] Failed to encrypt user-provided mnemonic:', error.message);
      return false;
    }
  }

  /**
   * Decrypt mnemonic using wallet signature.
   * User must sign the same message to decrypt.
   * @param signature - Wallet signature for decryption
   * @returns decrypted mnemonic or null
   */
  decryptMnemonic(signature: string): string | null {
    if (!this.identity?.encryptedMnemonic) {
      logger.warn('[IdentityService] No encrypted mnemonic found');
      return null;
    }

    try {
      const mnemonic = decryptMnemonicWithSignature(
        this.identity.encryptedMnemonic,
        signature
      );
      
      logger.info('[IdentityService] Mnemonic decrypted successfully');
      return mnemonic;
    } catch (error: any) {
      logger.error('[IdentityService] Failed to decrypt mnemonic:', error.message);
      return null;
    }
  }

  /**
   * Get the message that should be signed for mnemonic encryption/decryption
   * @param walletAddress - Wallet address to include in message
   */
  getMnemonicSignMessage(walletAddress: string): string {
    return getMnemonicSignMessage(walletAddress);
  }

  /**
   * Save identity with encrypted mnemonic (but without plaintext)
   */
  private saveIdentityWithEncryptedMnemonic(): void {
    if (!this.identity) return;
    
    // Store identity with encrypted mnemonic but without plaintext
    const { mnemonic, ...identityToStore } = this.identity;
    
    writeFileSync(
      this.identityPath,
      JSON.stringify(identityToStore, null, 2),
      { mode: 0o600 }
    );
    
    logger.info(`💾 Identity saved with encrypted mnemonic to ${this.identityPath}`);
  }

  /**
   * Clear plaintext mnemonic from memory (call after encrypting or if user declines backup)
   */
  clearMnemonic(): void {
    if (this.identity?.mnemonic) {
      delete this.identity.mnemonic;
      logger.info('[IdentityService] Plaintext mnemonic cleared from memory');
    }
  }

  /**
   * Get admin wallet address
   */
  getAdminWalletAddress(): string | null {
    return this.identity?.adminWalletAddress || null;
  }

  /**
   * Check if an address is the admin wallet
   */
  isAdminWallet(address: string): boolean {
    if (!this.identity?.adminWalletAddress) {
      return false;
    }
    return this.identity.adminWalletAddress.toLowerCase() === address.toLowerCase();
  }

  /**
   * Set admin wallet address (only if not already set)
   * Returns true if set successfully, false if already set
   */
  setAdminWallet(address: string): boolean {
    if (!this.identity) {
      logger.error('[IdentityService] No identity loaded');
      return false;
    }

    if (this.identity.adminWalletAddress) {
      logger.warn('[IdentityService] Admin wallet already set');
      return false;
    }

    this.identity.adminWalletAddress = address.toLowerCase();
    this.saveIdentityWithEncryptedMnemonic();
    
    logger.info(`[IdentityService] Admin wallet set: ${address.substring(0, 10)}...`);
    return true;
  }

  /**
   * Check if admin wallet has been set
   */
  hasAdminWallet(): boolean {
    return !!this.identity?.adminWalletAddress;
  }

  /**
   * Whether this identity was created with mnemonic-derived keys (v2).
   * Legacy (v1) identities have keys independent of the mnemonic.
   */
  isMnemonicDerived(): boolean {
    return this.identity?.identityVersion === 2;
  }

  /**
   * Verify that a mnemonic phrase produces the same keypair as this identity.
   * Only meaningful for v2 identities; always returns false for v1.
   */
  verifyMnemonic(mnemonic: string): boolean {
    if (!this.identity) return false;

    try {
      const { publicKey } = deriveFromMnemonic(mnemonic);
      return publicKey.toString('hex') === this.identity.publicKey;
    } catch {
      return false;
    }
  }
}
