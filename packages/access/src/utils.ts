/**
 * @elacity-js/access — Shared utilities
 *
 * Extracted from crypto/encrypt.ts, crypto/decrypt.ts, and lit/key-retrieval.ts
 * to eliminate duplication. These are pure functions with no side effects.
 */

// ── WebCrypto API ───────────────────────────────────────

export function getCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== 'undefined') {
    return globalThis.crypto;
  }
  throw new Error('WebCrypto API not available in this environment');
}

// ── Base64 ↔ Uint8Array conversion ─────────────────────

export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── SIWE message construction ───────────────────────────

/**
 * Build a SIWE (Sign-In with Ethereum) message for Lit Protocol auth.
 * Used by both key-retrieval and decrypt flows.
 */
export function buildSiweMessage(params: {
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

export function generateNonce(): string {
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
