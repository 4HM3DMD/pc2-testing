import { buildAccessTokenCondition } from '../lit/conditions.js';
import { AES_IV_LENGTH } from '../constants.js';
import { getCryptoApi, base64ToUint8Array } from '../utils.js';
export async function encryptBuffer(session, data, params) {
    const { ledger, tokenId } = params;
    const client = session.getClient();
    const conditions = buildAccessTokenCondition(ledger, tokenId);
    const encryptResult = await client.encrypt({
        dataToEncrypt: data,
        unifiedAccessControlConditions: conditions,
    });
    const keyId = `${ledger}:${tokenId}`;
    return {
        encrypted: base64ToUint8Array(encryptResult.ciphertext),
        conditions,
        keyId,
        algorithm: 'aes-gcm',
        dataToEncryptHash: encryptResult.dataToEncryptHash ?? '',
    };
}
export async function encryptWithKey(data, keyBytes) {
    const cryptoApi = getCryptoApi();
    const iv = cryptoApi.getRandomValues(new Uint8Array(AES_IV_LENGTH));
    const key = await cryptoApi.subtle.importKey('raw', keyBytes.buffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const encrypted = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, data.buffer);
    return {
        encrypted: new Uint8Array(encrypted),
        iv,
    };
}
//# sourceMappingURL=encrypt.js.map