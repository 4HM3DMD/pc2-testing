/**
 * @elacity-js/access — IPFS gateway fetch helper
 *
 * Fetches encrypted content from IPFS via HTTP gateway.
 * Tries local PC2 gateway first, falls back to Elacity public gateway.
 *
 * Used by fetchAndDecrypt() for the convenience method that
 * combines IPFS fetch + Lit Protocol decrypt in one call.
 */

import { LOCAL_IPFS_GATEWAY, DEFAULT_IPFS_GATEWAY } from '../constants.js';

export interface FetchOptions {
  gateway?: string;
  fallbackGateway?: string;
  timeout?: number;
}

/**
 * Fetch content from IPFS by CID via HTTP gateway.
 *
 * Tries the primary gateway first, falls back to the secondary.
 * Returns raw bytes as Uint8Array.
 */
export async function fetchFromIpfs(
  cid: string,
  options?: FetchOptions
): Promise<Uint8Array> {
  const primary = options?.gateway ?? LOCAL_IPFS_GATEWAY;
  const fallback = options?.fallbackGateway ?? DEFAULT_IPFS_GATEWAY;
  const timeout = options?.timeout ?? 30_000;

  const cleanCid = cid.startsWith('ipfs://') ? cid.slice(7) : cid;

  try {
    return await fetchWithTimeout(`${primary}${cleanCid}`, timeout);
  } catch {
    return await fetchWithTimeout(`${fallback}${cleanCid}`, timeout);
  }
}

async function fetchWithTimeout(url: string, timeout: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timeoutId);
  }
}
