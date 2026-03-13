/**
 * @elacity-js/access/node — Node.js Lit Protocol session
 *
 * Uses LitNodeClientNodeJs which doesn't depend on browser APIs
 * (no window, no localStorage, no DOM). Suitable for:
 * - PC2 Node backend (server-side decryption of AI models, datasets, etc.)
 * - CLI tools
 * - Agent-to-agent commerce
 *
 * All crypto uses Node.js native crypto module instead of WebCrypto DOM API.
 */

import { LitNodeClientNodeJs } from '@lit-protocol/lit-node-client-nodejs';
import { LIT_NETWORK } from '@lit-protocol/constants';
import { ethers } from 'ethers';
import { DEFAULT_LIT_NETWORK } from '../constants.js';
import type { ConnectOptions } from '../types.js';
import type { AccessEventEmitter } from '../events.js';

export interface NodeWalletConfig {
  privateKey: string;
  rpcUrl?: string;
}

export class LitSessionNode {
  private client: LitNodeClientNodeJs | null = null;
  private wallet: ethers.Wallet | null = null;
  private address: string | null = null;
  private chainId: number;
  private litNetwork: string;
  private events: AccessEventEmitter;

  constructor(events: AccessEventEmitter) {
    this.events = events;
    this.chainId = 8453;
    this.litNetwork = DEFAULT_LIT_NETWORK;
  }

  /**
   * Connect using a private key (server-side — no browser wallet).
   * The private key should come from environment variables, never hardcoded.
   */
  async connectWithKey(config: NodeWalletConfig, options?: ConnectOptions): Promise<void> {
    if (this.client?.ready) {
      return;
    }

    this.chainId = options?.chainId ?? 8453;
    this.litNetwork = options?.litNetwork ?? DEFAULT_LIT_NETWORK;

    const rpcUrl = config.rpcUrl ?? 'https://mainnet.base.org';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, provider);
    this.address = await this.wallet.getAddress();

    const litNetwork = this.resolveLitNetwork(this.litNetwork);
    this.client = new LitNodeClientNodeJs({
      litNetwork,
      debug: false,
    });

    await this.client.connect();
    this.events.emit('connected');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    this.wallet = null;
    this.address = null;
    this.events.emit('disconnected');
  }

  getClient(): LitNodeClientNodeJs {
    if (!this.client?.ready) {
      throw new Error('LitNodeClientNodeJs not connected. Call connectWithKey() first.');
    }
    return this.client;
  }

  getWallet(): ethers.Wallet {
    if (!this.wallet) {
      throw new Error('No wallet configured. Call connectWithKey() first.');
    }
    return this.wallet;
  }

  getAddress(): string {
    if (!this.address) {
      throw new Error('No wallet address. Call connectWithKey() first.');
    }
    return this.address;
  }

  getSignerAddress(): string {
    return this.getAddress();
  }

  getChainId(): number {
    return this.chainId;
  }

  isConnected(): boolean {
    return this.client?.ready === true && this.address !== null;
  }

  /**
   * Sign a message using the server-side wallet.
   * No user interaction — signs immediately with the private key.
   */
  async signMessage(message: string): Promise<string> {
    this.events.emit('sign_request');
    try {
      const signature = await this.getWallet().signMessage(message);
      return signature;
    } catch (error) {
      this.events.emit('sign_error', error);
      throw error;
    }
  }

  private resolveLitNetwork(network: string): typeof LIT_NETWORK[keyof typeof LIT_NETWORK] {
    const networkMap: Record<string, typeof LIT_NETWORK[keyof typeof LIT_NETWORK]> = {
      'datil-dev': LIT_NETWORK.DatilDev,
      'datil-test': LIT_NETWORK.DatilTest,
      'datil': LIT_NETWORK.Datil,
      'cayenne': LIT_NETWORK.DatilDev,
    };
    return networkMap[network] ?? LIT_NETWORK.DatilDev;
  }
}
