/**
 * @elacity-js/access — Lit Protocol session management
 *
 * Handles LitNodeClient lifecycle, session signature generation,
 * and certificate caching. This is the foundation for all key
 * retrieval and encryption operations.
 *
 * Designed for single-use instantiation (capsule-compatible):
 * each LitSession owns its own client and session state.
 *
 * Note on capacity credits: Elacity's production frontend does NOT use
 * capacity delegation — it calls getSessionSigs() directly without
 * capabilityAuthSigs. Capacity credits (if needed) should be handled
 * server-side by the dApp owner wallet, not in the browser.
 */

import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK } from '@lit-protocol/constants';
import { ethers } from 'ethers';
import { DEFAULT_LIT_NETWORK } from '../constants.js';
import type { EthereumProvider, ConnectOptions } from '../types.js';
import type { AccessEventEmitter } from '../events.js';

export interface LitSessionState {
  client: LitNodeClient | null;
  connected: boolean;
  address: string | null;
  smartAccount: string | null;
  chainId: number;
}

export class LitSession {
  private client: LitNodeClient | null = null;
  private provider: EthereumProvider | null = null;
  private address: string | null = null;
  private smartAccount: string | null = null;
  private chainId: number;
  private litNetwork: string;
  private events: AccessEventEmitter;

  constructor(events: AccessEventEmitter) {
    this.events = events;
    this.chainId = 8453;
    this.litNetwork = DEFAULT_LIT_NETWORK;
  }

  async connect(provider: EthereumProvider, options?: ConnectOptions): Promise<void> {
    if (this.client?.ready) {
      return;
    }

    this.provider = provider;
    this.chainId = options?.chainId ?? 8453;
    this.litNetwork = options?.litNetwork ?? DEFAULT_LIT_NETWORK;
    this.smartAccount = options?.smartAccount ?? provider.smartAccountAddress ?? null;

    const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
    this.address = accounts[0] ?? null;

    if (!this.address) {
      throw new Error('No wallet account available');
    }

    const litNetwork = this.resolveLitNetwork(this.litNetwork);
    const connectTimeout = options?.connectTimeout ?? 60000;

    this.client = new LitNodeClient({
      litNetwork,
      debug: false,
      connectTimeout,
    });

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.client.connect();
        break;
      } catch (err: unknown) {
        const isTimeout = err instanceof Error && err.message.includes('handshake');
        if (attempt < maxRetries && isTimeout) {
          await this.client.disconnect().catch(() => {});
          this.client = new LitNodeClient({
            litNetwork,
            debug: false,
            connectTimeout: connectTimeout * (attempt + 2),
          });
          continue;
        }
        throw err;
      }
    }

    this.events.emit('connected');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    this.provider = null;
    this.address = null;
    this.smartAccount = null;
    this.events.emit('disconnected');
  }

  getClient(): LitNodeClient {
    if (!this.client?.ready) {
      throw new Error('LitNodeClient not connected. Call connect() first.');
    }
    return this.client;
  }

  getProvider(): EthereumProvider {
    if (!this.provider) {
      throw new Error('No wallet provider. Call connect() first.');
    }
    return this.provider;
  }

  getAddress(): string {
    if (!this.address) {
      throw new Error('No wallet address. Call connect() first.');
    }
    return this.address;
  }

  getSignerAddress(): string {
    return this.smartAccount ?? this.getAddress();
  }

  getChainId(): number {
    return this.chainId;
  }

  isConnected(): boolean {
    return this.client?.ready === true && this.address !== null;
  }

  /**
   * Create an ethers.BrowserProvider from the wallet provider.
   * Used for signing operations needed by Lit Protocol.
   */
  getEthersSigner(): ethers.BrowserProvider {
    const provider = this.getProvider();
    return new ethers.BrowserProvider(provider as ethers.Eip1193Provider);
  }

  /**
   * Sign a message using the connected wallet.
   * Emits 'sign_request' before signing and 'sign_error' on failure.
   */
  async signMessage(message: string): Promise<string> {
    this.events.emit('sign_request');
    try {
      const hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const signature = await this.getProvider().request({
        method: 'personal_sign',
        params: [hexMessage, this.getAddress()],
      }) as string;

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
    return networkMap[network] ?? LIT_NETWORK.Datil;
  }
}
