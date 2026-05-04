/**
 * @elacity-js/access — ElacityAccess client
 *
 * Main entry point composing all modules into a single, cohesive API.
 * Each instance owns its own Lit session, event emitter, and state.
 *
 * Design principles:
 * - NOT a singleton: multiple instances can coexist (capsule-compatible)
 * - Stateless operations: verify/acquire/decrypt are independent calls
 * - Separated concerns: verify access, acquire key, and decrypt are
 *   separate steps so the Runtime can insert capability token issuance
 */

import { LitSession } from './lit/session.js';
import { AccessEventEmitter } from './events.js';
import { verifyAccess } from './verify/access-token.js';
import { acquireKey, acquireLicense } from './lit/key-retrieval.js';
import { encryptBuffer } from './crypto/encrypt.js';
import { decryptWithLit, decryptWithKey } from './crypto/decrypt.js';
import { fetchFromIpfs } from './fetch/ipfs.js';
import type {
  EthereumProvider,
  ConnectOptions,
  VerifyAccessParams,
  AccessVerification,
  AcquireKeyParams,
  DecryptionKey,
  EncryptParams,
  EncryptResult,
  FetchDecryptParams,
  AcquireLicenseParams,
  AccessEvent,
  AccessEventHandler,
} from './types.js';

export class ElacityAccess {
  private session: LitSession;
  private events: AccessEventEmitter;
  private options: ConnectOptions = {};

  constructor() {
    this.events = new AccessEventEmitter();
    this.session = new LitSession(this.events);
  }

  /**
   * Connect to the Lit Network with a wallet provider.
   * Must be called before any access operations.
   */
  async connect(provider: EthereumProvider, options?: ConnectOptions): Promise<void> {
    this.options = options ?? {};
    await this.session.connect(provider, options);
  }

  /**
   * Disconnect from the Lit Network and clean up resources.
   */
  async disconnect(): Promise<void> {
    await this.session.disconnect();
    this.events.removeAllListeners();
  }

  /**
   * Check if a wallet holds an ACCESS_TOKEN for a specific asset.
   *
   * This is a pure verification step — no key material is retrieved.
   * The Runtime will call this to decide whether to issue a capability token.
   */
  async verifyAccess(params: VerifyAccessParams): Promise<AccessVerification> {
    return verifyAccess(
      this.session.getProvider(),
      params,
      {
        authorityGateway: this.options.authorityGateway,
        signerAddress: this.session.getSignerAddress(),
      }
    );
  }

  /**
   * Acquire a standalone decryption key from the Lit Network.
   *
   * Proves ACCESS_TOKEN ownership via SIWE-signed session to Lit nodes,
   * then retrieves the symmetric key. The key can be used with
   * decryptBuffer() for one or more decryption operations.
   *
   * Requires ciphertext and dataToEncryptHash from asset metadata.
   */
  async acquireKey(params: AcquireKeyParams): Promise<DecryptionKey> {
    return acquireKey(this.session, params, this.events);
  }

  /**
   * Acquire a CENC-compatible license for the media-player WASM module.
   *
   * NOT YET IMPLEMENTED — the existing WASM media player handles CENC
   * license acquisition independently. This bridge point exists for
   * a future where media-player delegates to @elacity-js/access.
   *
   * @throws Error — not yet implemented
   */
  async acquireLicense(params: AcquireLicenseParams): Promise<Uint8Array> {
    return acquireLicense(this.session, params, this.events);
  }

  /**
   * Encrypt data with Lit Protocol access conditions (creator side).
   *
   * The encrypted data and metadata should be uploaded to IPFS.
   * Only wallets holding the ACCESS_TOKEN can decrypt it later.
   */
  async encryptBuffer(data: Uint8Array, params: EncryptParams): Promise<EncryptResult> {
    return encryptBuffer(this.session, data, params);
  }

  /**
   * Decrypt data using a previously acquired key (consumer side).
   *
   * For non-media assets: uses WebCrypto AES-GCM.
   * For streaming media: use acquireLicense() with the media-player instead.
   */
  async decryptBuffer(encrypted: Uint8Array, key: DecryptionKey): Promise<Uint8Array> {
    return decryptWithKey(encrypted, key);
  }

  /**
   * High-level convenience: fetch encrypted content from IPFS and decrypt.
   *
   * Combines:
   * 1. fetchFromIpfs() — download encrypted bytes
   * 2. decryptWithLit() — prove access and decrypt via Lit Protocol
   *
   * The CID points to raw Lit-encrypted bytes on IPFS.
   * The dataToEncryptHash must be passed in (from the asset's metadata envelope).
   */
  async fetchAndDecrypt(params: FetchDecryptParams): Promise<Uint8Array> {
    const { cid, ledger, tokenId, gateway, fallbackGateway } = params;

    const encrypted = await fetchFromIpfs(cid, { gateway, fallbackGateway });

    let ciphertext: Uint8Array | string;
    let dataToEncryptHash: string = params.dataToEncryptHash ?? '';

    try {
      const text = new TextDecoder().decode(encrypted);
      const envelope = JSON.parse(text);
      if (envelope.ciphertext && envelope.dataToEncryptHash) {
        ciphertext = envelope.ciphertext;
        dataToEncryptHash = dataToEncryptHash || envelope.dataToEncryptHash;
      } else {
        ciphertext = encrypted;
      }
    } catch {
      ciphertext = encrypted;
    }

    return decryptWithLit(
      this.session,
      { ciphertext, dataToEncryptHash, ledger, tokenId },
      this.events
    );
  }

  // ── Event handling ─────────────────────────────────────

  on(event: AccessEvent, handler: AccessEventHandler): void {
    this.events.on(event, handler);
  }

  off(event: AccessEvent, handler: AccessEventHandler): void {
    this.events.off(event, handler);
  }

  // ── State accessors ────────────────────────────────────

  isConnected(): boolean {
    return this.session.isConnected();
  }

  getAddress(): string | null {
    try {
      return this.session.getAddress();
    } catch {
      return null;
    }
  }

  getSignerAddress(): string | null {
    try {
      return this.session.getSignerAddress();
    } catch {
      return null;
    }
  }
}
