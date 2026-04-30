import { LitSessionNode } from './session.js';
import { AccessEventEmitter } from '../events.js';
import { verifyAccess } from '../verify/access-token.js';
import { encryptWithKey } from '../crypto/encrypt.js';
import { decryptWithKey } from '../crypto/decrypt.js';
import { fetchFromIpfs } from '../fetch/ipfs.js';
export class ElacityAccessNode {
    session;
    events;
    options = {};
    constructor() {
        this.events = new AccessEventEmitter();
        this.session = new LitSessionNode(this.events);
    }
    async connect(config, options) {
        this.options = options ?? {};
        await this.session.connectWithKey(config, options);
    }
    async disconnect() {
        await this.session.disconnect();
        this.events.removeAllListeners();
    }
    async verifyAccess(params) {
        const wallet = this.session.getWallet();
        const rpcProvider = wallet.provider;
        if (!rpcProvider) {
            throw new Error('No RPC provider available');
        }
        const browserProviderShim = {
            request: async (args) => {
                if (args.method === 'eth_requestAccounts') {
                    return [await wallet.getAddress()];
                }
                return rpcProvider.send(args.method, args.params ?? []);
            },
        };
        return verifyAccess(browserProviderShim, params, {
            authorityGateway: this.options.authorityGateway,
            signerAddress: this.session.getSignerAddress(),
        });
    }
    async decryptBuffer(encrypted, key) {
        return decryptWithKey(encrypted, key);
    }
    async encryptBuffer(data, keyBytes) {
        return encryptWithKey(data, keyBytes);
    }
    async fetchFromIpfs(cid, gateway) {
        return fetchFromIpfs(cid, { gateway });
    }
    async fetchAndDecryptWithKey(params, key) {
        const { cid, gateway } = params;
        const encrypted = await fetchFromIpfs(cid, { gateway });
        return decryptWithKey(encrypted, key);
    }
    on(event, handler) {
        this.events.on(event, handler);
    }
    off(event, handler) {
        this.events.off(event, handler);
    }
    isConnected() {
        return this.session.isConnected();
    }
    getAddress() {
        try {
            return this.session.getAddress();
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=client.js.map