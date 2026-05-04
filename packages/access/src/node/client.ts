/**
 * @elacity-js/access/node — Server-side ElacityAccess client
 *
 * Same API surface as the browser client, but uses:
 * - LitNodeClientNodeJs (no browser dependencies)
 * - ethers.Wallet with private key (no MetaMask popup)
 * - Node.js crypto (no WebCrypto DOM restrictions)
 *
 * Usage on PC2 Node backend:
 *   import { ElacityAccessNode } from '@elacity-js/access/node';
 *   const access = new ElacityAccessNode();
 *   await access.connect({ privateKey: process.env.NODE_WALLET_KEY! });
 *   const data = await access.fetchAndDecrypt({ cid, ledger, tokenId });
 */

import { ethers } from 'ethers';
import { LitSessionNode, type NodeWalletConfig } from './session.js';
import { AccessEventEmitter } from '../events.js';
import { verifyAccess } from '../verify/access-token.js';
import { encryptWithKey } from '../crypto/encrypt.js';
import { decryptWithKey } from '../crypto/decrypt.js';
import { fetchFromIpfs } from '../fetch/ipfs.js';
import type {
  ConnectOptions,
  VerifyAccessParams,
  AccessVerification,
  DecryptionKey,
  AccessEvent,
  AccessEventHandler,
  FetchDecryptParams,
  EthereumProvider,
} from '../types.js';

export class ElacityAccessNode {
  private session: LitSessionNode;
  private events: AccessEventEmitter;
  private options: ConnectOptions = {};

  constructor() {
    this.events = new AccessEventEmitter();
    this.session = new LitSessionNode(this.events);
  }

  /**
   * Connect using a private key (no browser wallet).
   * The private key should be loaded from environment, never hardcoded.
   */
  async connect(config: NodeWalletConfig, options?: ConnectOptions): Promise<void> {
    this.options = options ?? {};
    await this.session.connectWithKey(config, options);
  }

  async disconnect(): Promise<void> {
    await this.session.disconnect();
    this.events.removeAllListeners();
  }

  /**
   * Check if a wallet holds an ACCESS_TOKEN for a specific asset.
   * Uses an ethers.JsonRpcProvider internally (no browser provider).
   */
  async verifyAccess(params: VerifyAccessParams): Promise<AccessVerification> {
    const wallet = this.session.getWallet();
    const rpcProvider = wallet.provider as ethers.JsonRpcProvider | null;

    if (!rpcProvider) {
      throw new Error('No RPC provider available');
    }

    const browserProviderShim: EthereumProvider = {
      request: async (args) => {
        if (args.method === 'eth_requestAccounts') {
          return [await wallet.getAddress()];
        }
        return rpcProvider.send(args.method, args.params ?? []);
      },
    };

    return verifyAccess(
      browserProviderShim,
      params,
      {
        authorityGateway: this.options.authorityGateway,
        signerAddress: this.session.getSignerAddress(),
      }
    );
  }

  /**
   * Decrypt data locally using a raw AES-256-GCM key.
   */
  async decryptBuffer(encrypted: Uint8Array, key: DecryptionKey): Promise<Uint8Array> {
    return decryptWithKey(encrypted, key);
  }

  /**
   * Encrypt data locally using a raw AES-256-GCM key.
   */
  async encryptBuffer(data: Uint8Array, keyBytes: Uint8Array): Promise<{ encrypted: Uint8Array; iv: Uint8Array }> {
    return encryptWithKey(data, keyBytes);
  }

  /**
   * Fetch encrypted content from IPFS and return raw bytes.
   * Decryption must be done separately with a key.
   */
  async fetchFromIpfs(cid: string, gateway?: string): Promise<Uint8Array> {
    return fetchFromIpfs(cid, { gateway });
  }

  /**
   * High-level: fetch from IPFS, parse envelope, decrypt with provided key.
   *
   * For full Lit Protocol decrypt (where the key is retrieved from Lit nodes),
   * use the browser client. Server-side Lit decryption requires additional
   * setup (Lit Action or PKP) that will be added in a future release.
   */
  async fetchAndDecryptWithKey(
    params: FetchDecryptParams,
    key: DecryptionKey
  ): Promise<Uint8Array> {
    const { cid, gateway } = params;
    const encrypted = await fetchFromIpfs(cid, { gateway });

    return decryptWithKey(encrypted, key);
  }

  on(event: AccessEvent, handler: AccessEventHandler): void {
    this.events.on(event, handler);
  }

  off(event: AccessEvent, handler: AccessEventHandler): void {
    this.events.off(event, handler);
  }

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
}
