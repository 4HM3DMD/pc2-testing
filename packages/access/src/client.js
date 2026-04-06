import { LitSession } from './lit/session.js';
import { AccessEventEmitter } from './events.js';
import { verifyAccess } from './verify/access-token.js';
import { acquireKey, acquireLicense } from './lit/key-retrieval.js';
import { encryptBuffer } from './crypto/encrypt.js';
import { decryptWithLit, decryptWithKey } from './crypto/decrypt.js';
import { fetchFromIpfs } from './fetch/ipfs.js';
export class ElacityAccess {
    session;
    events;
    options = {};
    constructor() {
        this.events = new AccessEventEmitter();
        this.session = new LitSession(this.events);
    }
    async connect(provider, options) {
        this.options = options ?? {};
        await this.session.connect(provider, options);
    }
    async disconnect() {
        await this.session.disconnect();
        this.events.removeAllListeners();
    }
    async verifyAccess(params) {
        return verifyAccess(this.session.getProvider(), params, {
            authorityGateway: this.options.authorityGateway,
            signerAddress: this.session.getSignerAddress(),
        });
    }
    async acquireKey(params) {
        return acquireKey(this.session, params, this.events);
    }
    async acquireLicense(params) {
        return acquireLicense(this.session, params, this.events);
    }
    async encryptBuffer(data, params) {
        return encryptBuffer(this.session, data, params);
    }
    async decryptBuffer(encrypted, key) {
        return decryptWithKey(encrypted, key);
    }
    async fetchAndDecrypt(params) {
        const { cid, ledger, tokenId, gateway, fallbackGateway } = params;
        const encrypted = await fetchFromIpfs(cid, { gateway, fallbackGateway });
        let ciphertext;
        let dataToEncryptHash = params.dataToEncryptHash ?? '';
        try {
            const text = new TextDecoder().decode(encrypted);
            const envelope = JSON.parse(text);
            if (envelope.ciphertext && envelope.dataToEncryptHash) {
                ciphertext = envelope.ciphertext;
                dataToEncryptHash = dataToEncryptHash || envelope.dataToEncryptHash;
            }
            else {
                ciphertext = encrypted;
            }
        }
        catch {
            ciphertext = encrypted;
        }
        return decryptWithLit(this.session, { ciphertext, dataToEncryptHash, ledger, tokenId }, this.events);
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
    getSignerAddress() {
        try {
            return this.session.getSignerAddress();
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=client.js.map