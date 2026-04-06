import { LitAccessControlConditionResource } from '@lit-protocol/auth-helpers';
import { buildAccessTokenCondition } from './conditions.js';
import { buildSiweMessage } from '../utils.js';
export async function acquireKey(session, params, events) {
    const { ledger, tokenId, ciphertext, dataToEncryptHash } = params;
    const client = session.getClient();
    const address = session.getSignerAddress();
    if (!ciphertext || !dataToEncryptHash) {
        throw new Error('acquireKey() requires ciphertext and dataToEncryptHash from the ' +
            'asset metadata. These are set during encryption via encryptBuffer().');
    }
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
                const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                const message = buildSiweMessage({
                    domain,
                    address,
                    uri: callbackParams.uri ?? '',
                    expiration: callbackParams.expiration ?? sevenDays,
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
        const decryptResult = await client.decrypt({
            ciphertext,
            dataToEncryptHash,
            unifiedAccessControlConditions: conditions,
            chain: 'base',
            sessionSigs,
        });
        if (!decryptResult.decryptedData) {
            throw new Error('Lit Protocol returned no decrypted data');
        }
        const keyBytes = new Uint8Array(decryptResult.decryptedData);
        return {
            raw: keyBytes,
            keyId: `${ledger}:${tokenId}`,
            algorithm: 'aes-gcm',
        };
    }
    catch (error) {
        events.emit('sign_error', error);
        throw error;
    }
}
export async function acquireLicense(_session, _params, _events) {
    throw new Error('acquireLicense() is not yet implemented. The existing WASM media player ' +
        'handles CENC license acquisition independently via EIP-712 LicenseRequest ' +
        'signing against the AuthorityGateway. This bridge will be implemented ' +
        'when the media-player is updated to delegate to @elacity-js/access.');
}
//# sourceMappingURL=key-retrieval.js.map