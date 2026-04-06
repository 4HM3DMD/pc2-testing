import { LitNodeClientNodeJs } from '@lit-protocol/lit-node-client-nodejs';
import { LIT_NETWORK } from '@lit-protocol/constants';
import { ethers } from 'ethers';
import { DEFAULT_LIT_NETWORK } from '../constants.js';
export class LitSessionNode {
    client = null;
    wallet = null;
    address = null;
    chainId;
    litNetwork;
    events;
    constructor(events) {
        this.events = events;
        this.chainId = 8453;
        this.litNetwork = DEFAULT_LIT_NETWORK;
    }
    async connectWithKey(config, options) {
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
    async disconnect() {
        if (this.client) {
            await this.client.disconnect();
            this.client = null;
        }
        this.wallet = null;
        this.address = null;
        this.events.emit('disconnected');
    }
    getClient() {
        if (!this.client?.ready) {
            throw new Error('LitNodeClientNodeJs not connected. Call connectWithKey() first.');
        }
        return this.client;
    }
    getWallet() {
        if (!this.wallet) {
            throw new Error('No wallet configured. Call connectWithKey() first.');
        }
        return this.wallet;
    }
    getAddress() {
        if (!this.address) {
            throw new Error('No wallet address. Call connectWithKey() first.');
        }
        return this.address;
    }
    getSignerAddress() {
        return this.getAddress();
    }
    getChainId() {
        return this.chainId;
    }
    isConnected() {
        return this.client?.ready === true && this.address !== null;
    }
    async signMessage(message) {
        this.events.emit('sign_request');
        try {
            const signature = await this.getWallet().signMessage(message);
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
        return networkMap[network] ?? LIT_NETWORK.DatilDev;
    }
}
//# sourceMappingURL=session.js.map