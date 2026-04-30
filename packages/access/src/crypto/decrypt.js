import { LitAccessControlConditionResource } from '@lit-protocol/auth-helpers';
import { buildAccessTokenCondition } from '../lit/conditions.js';
import { AES_IV_LENGTH } from '../constants.js';
import { getCryptoApi, uint8ArrayToBase64, buildSiweMessage } from '../utils.js';
export async function decryptWithLit(session, params, events) {
    const { ciphertext, dataToEncryptHash, ledger, tokenId } = params;
    const client = session.getClient();
    const address = session.getSignerAddress();
    const conditions = buildAccessTokenCondition(ledger, tokenId);
    events.emit('sign_request');
    try {
        const browserProvider = session.getEthersSigner();
        const signer = await browserProvider.getSigner();
        const sessionSigs = await client.getSessionSigs({
            chain: 'base',
            resourceAbilityRequests: [
                {
                    resource: new LitAccessControlConditionResource('*'),
                    ability: 'access-control-condition-decryption',
                },
            ],
            authNeededCallback: async (callbackParams) => {
                const domain = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
                const message = buildSiweMessage({
                    domain,
                    address,
                    uri: callbackParams.uri ?? '',
                    expiration: callbackParams.expiration ?? new Date(Date.now() + 1000 * 60 * 60).toISOString(),
                    chainId: session.getChainId(),
                });
                const signature = await signer.signMessage(message);
                return {
                    sig: signature,
                    derivedVia: 'web3.eth.personal.sign',
                    signedMessage: message,
                    address,
                };
            },
        });
        const ciphertextStr = typeof ciphertext === 'string'
            ? ciphertext
            : uint8ArrayToBase64(ciphertext);
        const decryptResult = await client.decrypt({
            ciphertext: ciphertextStr,
            dataToEncryptHash,
            unifiedAccessControlConditions: conditions,
            chain: 'base',
            sessionSigs,
        });
        if (decryptResult.decryptedData) {
            return new Uint8Array(decryptResult.decryptedData);
        }
        throw new Error('Decryption returned no data');
    }
    catch (error) {
        events.emit('sign_error', error);
        throw error;
    }
}
export async function decryptWithKey(encrypted, key) {
    if (key.algorithm !== 'aes-gcm') {
        throw new Error(`Unsupported algorithm: ${key.algorithm}. Only aes-gcm is supported for non-media decryption.`);
    }
    const cryptoApi = getCryptoApi();
    const iv = encrypted.slice(0, AES_IV_LENGTH);
    const ciphertext = encrypted.slice(AES_IV_LENGTH);
    const cryptoKey = await cryptoApi.subtle.importKey('raw', key.raw.buffer, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const decrypted = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext.buffer);
    return new Uint8Array(decrypted);
}
//# sourceMappingURL=decrypt.js.map