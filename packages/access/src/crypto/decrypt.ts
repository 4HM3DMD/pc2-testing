/**
 * @elacity-js/access — AES-GCM decryption (consumer side)
 *
 * Decrypts data encrypted by the creator using AES-256-GCM via WebCrypto API.
 * Used by consumers to decrypt purchased assets after acquiring the key
 * from Lit Protocol.
 *
 * No WASM, no SharedArrayBuffer — runs in any browser or Node.js context.
 * For streaming media, the media-player uses its own WASM CENC pipeline instead.
 */

import { LitAccessControlConditionResource } from '@lit-protocol/auth-helpers';
import { buildAccessTokenCondition } from '../lit/conditions.js';
import { AES_IV_LENGTH } from '../constants.js';
import type { LitSession } from '../lit/session.js';
import type { AccessEventEmitter } from '../events.js';
import type { DecryptionKey } from '../types.js';

/**
 * Decrypt data that was encrypted via Lit Protocol's encrypt().
 *
 * Flow:
 * 1. Build access conditions (same as used during encryption)
 * 2. Generate session signatures (wallet proves ACCESS_TOKEN ownership)
 * 3. Call Lit's decrypt() which:
 *    a. Verifies the caller meets access conditions (on-chain check)
 *    b. Collects key shares from Lit nodes
 *    c. Combines shares to reconstruct symmetric key
 *    d. Decrypts the ciphertext
 * 4. Returns raw decrypted bytes
 */
export async function decryptWithLit(
  session: LitSession,
  params: {
    ciphertext: Uint8Array | string;
    dataToEncryptHash: string;
    ledger: string;
    tokenId: string;
  },
  events: AccessEventEmitter
): Promise<Uint8Array> {
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
      unifiedAccessControlConditions: conditions as unknown[],
      chain: 'base',
      sessionSigs,
    } as Parameters<typeof client.decrypt>[0]);

    if (decryptResult.decryptedData) {
      return new Uint8Array(decryptResult.decryptedData);
    }

    throw new Error('Decryption returned no data');
  } catch (error) {
    events.emit('sign_error', error);
    throw error;
  }
}

/**
 * Decrypt data locally using a raw AES-256-GCM key.
 * For cases where the key has already been acquired from Lit Protocol
 * and the caller wants to perform decryption independently.
 *
 * Expected format: first AES_IV_LENGTH bytes are the IV, rest is ciphertext.
 */
export async function decryptWithKey(
  encrypted: Uint8Array,
  key: DecryptionKey
): Promise<Uint8Array> {
  if (key.algorithm !== 'aes-gcm') {
    throw new Error(`Unsupported algorithm: ${key.algorithm}. Only aes-gcm is supported for non-media decryption.`);
  }

  const cryptoApi = getCryptoApi();
  const iv = encrypted.slice(0, AES_IV_LENGTH);
  const ciphertext = encrypted.slice(AES_IV_LENGTH);

  const cryptoKey = await cryptoApi.subtle.importKey(
    'raw',
    key.raw.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await cryptoApi.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext.buffer as ArrayBuffer
  );

  return new Uint8Array(decrypted);
}

function getCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== 'undefined') {
    return globalThis.crypto;
  }
  throw new Error('WebCrypto API not available in this environment');
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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
