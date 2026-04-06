import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK } from '@lit-protocol/constants';
import { ethers } from 'ethers';
import { DEFAULT_LIT_NETWORK } from '../constants.js';
export class LitSession {
    client = null;
    provider = null;
    address = null;
    smartAccount = null;
    chainId;
    litNetwork;
    events;
    constructor(events) {
        this.events = events;
        this.chainId = 8453;
        this.litNetwork = DEFAULT_LIT_NETWORK;
    }
    async connect(provider, options) {
        if (this.client?.ready) {
            return;
        }
        this.provider = provider;
        this.chainId = options?.chainId ?? 8453;
        this.litNetwork = options?.litNetwork ?? DEFAULT_LIT_NETWORK;
        this.smartAccount = options?.smartAccount ?? provider.smartAccountAddress ?? null;
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
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
            }
            catch (err) {
                const isTimeout = err instanceof Error && err.message.includes('handshake');
                if (attempt < maxRetries && isTimeout) {
                    await this.client.disconnect().catch(() => { });
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
    async disconnect() {
        if (this.client) {
            await this.client.disconnect();
            this.client = null;
        }
        this.provider = null;
        this.address = null;
        this.smartAccount = null;
        this.events.emit('disconnected');
    }
    getClient() {
        if (!this.client?.ready) {
            throw new Error('LitNodeClient not connected. Call connect() first.');
        }
        return this.client;
    }
    getProvider() {
        if (!this.provider) {
            throw new Error('No wallet provider. Call connect() first.');
        }
        return this.provider;
    }
    getAddress() {
        if (!this.address) {
            throw new Error('No wallet address. Call connect() first.');
        }
        return this.address;
    }
    getSignerAddress() {
        return this.smartAccount ?? this.getAddress();
    }
    getChainId() {
        return this.chainId;
    }
    isConnected() {
        return this.client?.ready === true && this.address !== null;
    }
    getEthersSigner() {
        const provider = this.getProvider();
        return new ethers.BrowserProvider(provider);
    }
    async signMessage(message) {
        this.events.emit('sign_request');
        try {
            const hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            const signature = await this.getProvider().request({
                method: 'personal_sign',
                params: [hexMessage, this.getAddress()],
            });
            return signature;
        }
        catch (error) {
            this.events.emit('sign_error', error);
            throw error;
        }
    }
    resolveLitNetwork(network) {
        const networkMap = {
            'datil-dev': LIT_NETWORK.DatilDev,
            'datil-test': LIT_NETWORK.DatilTest,
            'datil': LIT_NETWORK.Datil,
            'cayenne': LIT_NETWORK.DatilDev,
        };
        return networkMap[network] ?? LIT_NETWORK.Datil;
    }
}
//# sourceMappingURL=session.js.map