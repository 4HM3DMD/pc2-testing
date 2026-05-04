/**
 * URL Utilities
 * 
 * Shared utilities for URL handling across the PC2 node.
 */

import { Request } from 'express';

/**
 * Interface for Boson service (to avoid circular imports)
 */
interface BosonServiceLike {
  getPublicUrl?: () => string | null;
}

/**
 * Get the base URL for the request, respecting reverse proxy headers.
 * When behind Nginx or other reverse proxies, req.protocol may be 'http'
 * even when the original request was HTTPS.
 * 
 * When accessed via Boson Active Proxy, the Host header may contain the internal
 * IP:port. In this case, we use the Boson service's registered public URL.
 * 
 * Use this for URLs that will be returned to a browser (response payloads,
 * absolute links in HTML, etc.). Do NOT use this to construct URLs the backend
 * fetches from itself — see {@link getInternalIPFSGateway} for that.
 * 
 * @param req - Express request object
 * @param bosonService - Optional Boson service instance for public URL resolution
 * @returns The base URL (e.g., "https://test7.ela.city")
 */
export function getBaseUrl(req: Request, bosonService?: BosonServiceLike): string {
  // Prefer x-forwarded-host (set by reverse proxies like our ela.city gateway)
  // over the Host header (which may be changed by changeOrigin: true)
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' ? forwardedHost : req.get('host')) || 'localhost';
  
  // Check x-forwarded-proto header (set by reverse proxies like Nginx and our gateway)
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto === 'https') {
    return `https://${host}`;
  }
  
  // Check origin header (contains original protocol)
  const origin = req.headers.origin;
  if (origin && typeof origin === 'string' && origin.startsWith('https://')) {
    return `https://${host}`;
  }
  
  // Fallback to req.protocol - this works correctly for direct IP access
  return `${req.protocol}://${host}`;
}

/**
 * Returns the loopback IPFS gateway URL for backend-internal fetches.
 *
 * The PC2 node exposes IPFS over HTTP at `/ipfs/<CID>` on the same port
 * as the API (default 4200), backed by an embedded Helia blockstore.
 *
 * When the backend itself needs to fetch a CID — for example, the media
 * runtime fetching an MPD or encrypted segment to feed into the WASM
 * decryptor — it must use the **loopback** URL, not the public-facing one.
 *
 * Using the public URL (`https://zzz.ela.city/ipfs/...`) for these internal
 * fetches forces the request out to the internet, into the reverse proxy,
 * and back through WireGuard to the same node. That round-trip:
 *
 *   1. Wastes external bandwidth for content the node already has.
 *   2. Adds 200 ms — 2 s of latency per segment.
 *   3. Couples local playback availability to gateway uptime, which
 *      defeats the whole point of a sovereign node.
 *
 * Resolution order:
 *   1. `LOCAL_IPFS_GATEWAY` env var — full URL, ending with `/ipfs/`
 *      (use this to point at a separate Kubo daemon, e.g.
 *      `http://127.0.0.1:8080/ipfs/`).
 *   2. `http://127.0.0.1:${PORT}/ipfs/` where PORT comes from
 *      `process.env.PORT` (default 4200).
 *
 * @returns A trailing-slash URL such as `http://127.0.0.1:4200/ipfs/`
 */
export function getInternalIPFSGateway(): string {
  const override = process.env.LOCAL_IPFS_GATEWAY;
  if (override) {
    return override.endsWith('/') ? override : `${override}/`;
  }
  const port = process.env.PORT || '4200';
  return `http://127.0.0.1:${port}/ipfs/`;
}
