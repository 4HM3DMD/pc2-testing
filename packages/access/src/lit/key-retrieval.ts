/**
 * @elacity-js/access — Lit Protocol key retrieval
 *
 * Acquires decryption keys from the Lit Network by proving
 * ACCESS_TOKEN ownership. For non-media assets, this retrieves
 * the symmetric key that was used during Lit Protocol encryption.
 *
 * Two modes:
 * 1. acquireKey() — returns a DecryptionKey for non-media decryption (AES-GCM)
 * 2. acquireLicense() — returns a CENC-compatible license blob for media-player
 */

import { LitAccessControlConditionResource } from '@lit-protocol/auth-helpers';
import { buildAccessTokenCondition } from './conditions.js';
import { buildSiweMessage, base64ToUint8Array } from '../utils.js';
import type { AccessEventEmitter } from '../events.js';
import type { LitSession } from './session.js';
import type {
  AcquireKeyParams,
  AcquireLicenseParams,
  DecryptionKey,
} from '../types.js';

/**
 * Acquire a standalone decryption key from the Lit Network.
 *
 * Uses getSessionSigs() with SIWE signing to prove the caller
 * meets the ACCESS_TOKEN ownership conditions, then calls
 * Lit's decrypt() to retrieve the symmetric key material.
 *
 * The returned DecryptionKey can be used with decryptWithKey()
 * for one or more decryption operations, or cached for offline use.
 */
export async function acquireKey(
  session: LitSession,
  params: AcquireKeyParams,
  events: AccessEventEmitter
): Promise<DecryptionKey> {
  const { ledger, tokenId, ciphertext, dataToEncryptHash } = params;
  const client = session.getClient();
  const address = session.getSignerAddress();

  if (!ciphertext || !dataToEncryptHash) {
    throw new Error(
      'acquireKey() requires ciphertext and dataToEncryptHash from the ' +
      'asset metadata. These are set during encryption via encryptBuffer().'
    );
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
      unifiedAccessControlConditions: conditions as unknown[],
      chain: 'base',
      sessionSigs,
    } as Parameters<typeof client.decrypt>[0]);

    if (!decryptResult.decryptedData) {
      throw new Error('Lit Protocol returned no decrypted data');
    }

    const keyBytes = new Uint8Array(decryptResult.decryptedData);

    return {
      raw: keyBytes,
      keyId: `${ledger}:${tokenId}`,
      algorithm: 'aes-gcm',
    };
  } catch (error) {
    events.emit('sign_error', error);
    throw error;
  }
}

/**
 * Acquire a CENC-compatible license for the media-player WASM module.
 *
 * NOT YET IMPLEMENTED — the existing WASM media player handles CENC
 * license acquisition independently via EIP-712 LicenseRequest signing
 * against the AuthorityGateway. This bridge point exists for a future
 * where media-player delegates license acquisition to @elacity-js/access.
 *
 * @throws Error always — not yet implemented
 */
export async function acquireLicense(
  _session: LitSession,
  _params: AcquireLicenseParams,
  _events: AccessEventEmitter
): Promise<Uint8Array> {
  throw new Error(
    'acquireLicense() is not yet implemented. The existing WASM media player ' +
    'handles CENC license acquisition independently via EIP-712 LicenseRequest ' +
    'signing against the AuthorityGateway. This bridge will be implemented ' +
    'when the media-player is updated to delegate to @elacity-js/access.'
  );
}
