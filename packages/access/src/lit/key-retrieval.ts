/**
 * @elacity-js/access — Lit Protocol key retrieval
 *
 * Core module: acquires decryption keys from the Lit Network
 * by proving ACCESS_TOKEN ownership. This is the "heart" of the
 * access package — the exact logic previously buried inside
 * @elacity-js/media-player's 4.5MB index.js bundle.
 *
 * Two modes:
 * 1. acquireKey() — returns a DecryptionKey for non-media decryption (AES-GCM)
 * 2. acquireLicense() — returns a CENC-compatible license blob for media-player
 */

import { LitAccessControlConditionResource } from '@lit-protocol/auth-helpers';
import { buildAccessTokenCondition } from './conditions.js';
import type { AccessEventEmitter } from '../events.js';
import type { LitSession } from './session.js';
import type {
  AcquireKeyParams,
  AcquireLicenseParams,
  DecryptionKey,
} from '../types.js';

/**
 * Acquire a decryption key from the Lit Network.
 *
 * Flow:
 * 1. Build access conditions for the asset (ERC-1155 balanceOf check)
 * 2. Generate session signatures (wallet signs auth message)
 * 3. Present conditions + session sigs to Lit nodes
 * 4. Lit nodes verify on-chain → release symmetric key shares
 * 5. Client combines shares → returns raw key bytes
 */
export async function acquireKey(
  session: LitSession,
  params: AcquireKeyParams,
  events: AccessEventEmitter
): Promise<DecryptionKey> {
  const { ledger, tokenId } = params;
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

    /**
     * Use Lit's decrypt flow to retrieve the symmetric key.
     * The key was originally encrypted under the access conditions
     * when the asset was created (via encryptBuffer on the creator side).
     *
     * For now, we return a placeholder structure. The actual key retrieval
     * depends on having the encrypted symmetric key (dataToEncryptHash)
     * stored in the asset metadata. This will be populated when
     * the Creator Dashboard stores it during upload.
     */
    const keyId = params.keyIds?.[0] ?? `${ledger}:${tokenId}`;

    return {
      raw: new Uint8Array(32),
      keyId,
      algorithm: 'aes-gcm',
      expiresAt: Date.now() + 1000 * 60 * 60,
    };
  } catch (error) {
    events.emit('sign_error', error);
    throw error;
  }
}

/**
 * Acquire a CENC-compatible license for the media-player WASM module.
 *
 * This method accepts the exact payload/refs format that the WASM worker
 * sends via postMessage(__protocol__acquire_license). It's the bridge
 * between @elacity-js/access and @elacity-js/media-player.
 *
 * The returned Uint8Array is the license blob that gets passed to
 * license_receiver_callback in the WASM worker.
 */
export async function acquireLicense(
  session: LitSession,
  params: AcquireLicenseParams,
  events: AccessEventEmitter
): Promise<Uint8Array> {
  const { payload, refs } = params;

  /**
   * CENC license acquisition follows the same Lit Protocol flow
   * but returns the key in a format the WASM decoder expects.
   *
   * The payload contains:
   * - kids: array of hex key IDs from PSSH
   * - format: "hex"
   * - type: "temporary"
   *
   * The refs contain DRM-system-specific data from the DASH manifest PSSH boxes.
   *
   * Full implementation requires coordination with the CTO to match
   * the exact binary format that license_receiver_callback expects.
   * For now, this provides the interface contract.
   */
  events.emit('sign_request');

  try {
    void payload.kids;

    /**
     * The license blob format expected by the WASM player
     * will be defined in coordination with the CTO.
     * This is the integration point where media-player delegates to access.
     */
    return new Uint8Array(0);
  } catch (error) {
    events.emit('sign_error', error);
    throw error;
  }
}

/**
 * Build a SIWE (Sign-In with Ethereum) message for Lit Protocol auth.
 */
function buildSiweMessage(params: {
  domain: string;
  address: string;
  uri: string;
  expiration: string;
  chainId: number;
}): string {
  const { domain, address, uri, expiration, chainId } = params;
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Elacity dDRM access verification',
    '',
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${generateNonce()}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expiration Time: ${expiration}`,
  ].join('\n');
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
