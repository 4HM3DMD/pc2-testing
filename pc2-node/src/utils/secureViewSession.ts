/**
 * Secure-View Session primitives (Option C — Session Key Delegation).
 *
 * This module is the server-side half of the Lit Action signature-auth
 * protocol specified in
 * `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md`.
 *
 * It provides the shared cryptographic plumbing that:
 *
 *   1. The PC2 node uses to defensively verify every secure-view
 *      request BEFORE spending a $0.01 Lit call — saves cost and
 *      gives clear error codes on malformed requests.
 *   2. Mirrors the checks the Lit Action will do inside the TEE, so
 *      any structural mismatch (bad domain, expired window, wrong
 *      action CID, etc.) fails fast server-side.
 *
 * Importantly, the Lit Action re-verifies everything independently.
 * This module's checks are defence-in-depth only — no security
 * boundary is moved server-side.
 *
 * Canonical JSON is byte-identical with:
 *   - `pc2-node/data/test-apps/shared/secure-view-session.js` (client)
 *   - `pc2-node/data/lit-actions/non-media-decrypt.js` (Lit Action)
 *   - `pc2-node/data/lit-actions/media-decrypt.js` (Lit Action)
 *
 * Curve decision: Phase 1 §10.2 — **P-256** for the ephemeral key
 * (K-256 not supported in any browser engine).
 */

import { recoverMessageAddress, getAddress, isAddress } from 'viem';
import type { Hex } from 'viem';
import { createLogger } from './logger.js';

const logger = createLogger('SecureViewSession');

// ── Constants matching DESIGN.md §2.2 / §2.3 ──────────────────────────

export const DELEGATION_DOMAIN = 'pc2.secure-view.v1' as const;
export const REQUEST_DOMAIN = 'pc2.secure-view.request.v1' as const;
export const MAX_DELEGATION_WINDOW_SECONDS = 24 * 3600;
/** Max ± clock skew allowed between client and PC2 (per-request). */
export const REQUEST_FRESHNESS_WINDOW_SECONDS = 60;
/** Tiny leeway for `issuedAt > now` to absorb minor clock skew. */
export const DELEGATION_CLOCK_SKEW_SECONDS = 5;
/** EIP-1271 magic value (bytes4 selector of `isValidSignature`). */
export const EIP1271_MAGIC_VALUE = '0x1626ba7e' as const;

// ── Types ─────────────────────────────────────────────────────────────

export interface SecureViewDelegation {
  domain: typeof DELEGATION_DOMAIN;
  chainId: number;
  actionIpfsId: string;
  ownerAddress: `0x${string}`;
  coveredAddresses: `0x${string}`[];
  /** Hex of uncompressed SEC1 P-256 public key (0x04 || X || Y, 65 bytes). */
  sessionPublicKey: `0x${string}`;
  issuedAt: number;
  expiresAt: number;
  nonce: `0x${string}`;
}

export interface SecureViewRequest {
  domain: typeof REQUEST_DOMAIN;
  kid: `0x${string}`;
  actionIpfsId: string;
  requestedAt: number;
  requestNonce: `0x${string}`;
}

export interface VerifyBundle {
  /** Canonical JSON string of the delegation (what was signed). */
  delegation: string;
  delegationSig: Hex;
  /** Canonical JSON string of the request (what was signed). */
  request: string;
  requestSig: Hex;
}

export type VerifyErrorCode =
  | 'bad_domain'
  | 'bad_chain'
  | 'bad_action_cid'
  | 'bad_req_domain'
  | 'bad_req_action_cid'
  | 'bad_req_kid'
  | 'del_not_yet_valid'
  | 'del_expired'
  | 'del_window_too_wide'
  | 'req_stale_or_future'
  | 'del_sig_invalid'
  | 'req_sig_invalid'
  | 'del_malformed'
  | 'req_malformed'
  | 'pub_malformed'
  | 'replayed'
  | 'revoked'
  | 'access_denied';

export interface VerifyResult {
  ok: boolean;
  error?: VerifyErrorCode;
  /**
   * When ok, parsed delegation + request and the address that was
   * recovered from the delegation signature. Consumers should still
   * run `hasAccessByContentId` for each address in `coveredAddresses`.
   */
  delegation?: SecureViewDelegation;
  request?: SecureViewRequest;
  recoveredOwner?: `0x${string}`;
}

// ── Canonicalization ──────────────────────────────────────────────────

/**
 * Canonical JSON: sorted keys, no whitespace. Deterministic across
 * TS/JS/Lit-Action environments. Must stay byte-identical with
 * `canonicalize()` in the client and Lit Action modules.
 *
 * Handles nested objects and arrays. Primitives fall through to
 * `JSON.stringify` which is standards-defined for numbers/strings/
 * booleans/null.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]));
  return '{' + entries.join(',') + '}';
}

// ── Payload builders ──────────────────────────────────────────────────

export interface BuildDelegationInput {
  ownerAddress: `0x${string}`;
  coveredAddresses: `0x${string}`[];
  /** SEC1 uncompressed public key (65 bytes) as 0x-prefixed hex. */
  sessionPublicKey: `0x${string}`;
  actionIpfsId: string;
  chainId: number;
  /** Optional override. Defaults to now. */
  issuedAt?: number;
  /** Optional window length. Capped to `MAX_DELEGATION_WINDOW_SECONDS`. */
  ttlSeconds?: number;
  /** Optional 16-byte hex nonce. Auto-generated if omitted. */
  nonce?: `0x${string}`;
}

/**
 * Build the unsigned delegation payload. Canonicalize() the return
 * value to get the exact bytes the wallet will `personal_sign`.
 */
export function buildDelegationPayload(input: BuildDelegationInput): SecureViewDelegation {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    input.ttlSeconds ?? MAX_DELEGATION_WINDOW_SECONDS,
    MAX_DELEGATION_WINDOW_SECONDS,
  );
  const nonce = input.nonce ?? generateNonce(16);
  return {
    domain: DELEGATION_DOMAIN,
    chainId: input.chainId,
    actionIpfsId: input.actionIpfsId,
    ownerAddress: getAddress(input.ownerAddress),
    coveredAddresses: input.coveredAddresses.map((a) => getAddress(a)) as `0x${string}`[],
    sessionPublicKey: input.sessionPublicKey,
    issuedAt,
    expiresAt: issuedAt + ttl,
    nonce,
  };
}

/**
 * Build the unsigned per-request payload. Canonicalize() to get
 * the bytes the ephemeral P-256 key will sign.
 */
export function buildRequestPayload(input: {
  kid: `0x${string}`;
  actionIpfsId: string;
  requestedAt?: number;
  requestNonce?: `0x${string}`;
}): SecureViewRequest {
  return {
    domain: REQUEST_DOMAIN,
    kid: normaliseHex(input.kid) as `0x${string}`,
    actionIpfsId: input.actionIpfsId,
    requestedAt: input.requestedAt ?? Math.floor(Date.now() / 1000),
    requestNonce: input.requestNonce ?? generateNonce(8),
  };
}

/**
 * Produces a random 0x-prefixed hex string of the given byte length.
 * Uses Node's Web Crypto which is CSPRNG-backed.
 */
export function generateNonce(bytes: number): `0x${string}` {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let hex = '0x';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return hex as `0x${string}`;
}

function normaliseHex(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s : `0x${s}`;
}

// ── Verification primitives ───────────────────────────────────────────

/**
 * Verify a delegation signature using EIP-191 `personal_sign`
 * recovery. Returns the recovered address (checksummed) or `null`
 * on failure. Does NOT attempt EIP-1271 (that is a separate RPC call
 * handled by `verifyDelegationEip1271`).
 */
export async function verifyDelegationEip191(
  canonicalDelegation: string,
  signature: Hex,
): Promise<`0x${string}` | null> {
  try {
    const recovered = await recoverMessageAddress({
      message: canonicalDelegation,
      signature,
    });
    return getAddress(recovered) as `0x${string}`;
  } catch (e) {
    logger.debug(`EIP-191 recovery failed: ${(e as Error)?.message}`);
    return null;
  }
}

/**
 * Verify a delegation signature using EIP-1271 `isValidSignature`.
 * Calls the `ownerAddress` contract via the provided eth_call client.
 *
 * Contract: `function isValidSignature(bytes32 hash, bytes sig)
 * external view returns (bytes4)`. Magic value `0x1626ba7e` === valid.
 *
 * `hash` is the Ethereum-signed-message hash of `canonicalDelegation`
 * (matches EIP-191's `keccak256("\x19Ethereum Signed Message:\n" +
 * len + msg)`). Viem exposes this as `hashMessage()` internally, but
 * we let the caller pass a pre-computed `messageHash` for flexibility.
 *
 * Signature of ethCall: must accept `{ to, data }` and return raw hex
 * including `0x` prefix, or throw on revert. The storage.ts route
 * already has a `PublicClient` handy for this.
 */
export async function verifyDelegationEip1271(
  ownerAddress: `0x${string}`,
  messageHash: Hex,
  signature: Hex,
  ethCall: (tx: { to: `0x${string}`; data: Hex }) => Promise<Hex>,
): Promise<boolean> {
  try {
    // ABI-encode isValidSignature(bytes32, bytes) call
    const selector = '0x1626ba7e' as const;
    const offsetToBytes = (64).toString(16).padStart(64, '0'); // 0x40
    const sigNo0x = signature.startsWith('0x') ? signature.slice(2) : signature;
    const sigLen = (sigNo0x.length / 2).toString(16).padStart(64, '0');
    const sigPadded = padRight32(sigNo0x);
    const hashNo0x = messageHash.startsWith('0x') ? messageHash.slice(2) : messageHash;
    const data = (selector +
      hashNo0x +
      offsetToBytes +
      sigLen +
      sigPadded) as Hex;

    const raw = await ethCall({ to: ownerAddress, data });
    const rawLower = raw.toLowerCase();
    // Return is bytes4 left-aligned in a 32-byte word
    // 0x1626ba7e00...00 on success.
    return rawLower.startsWith(EIP1271_MAGIC_VALUE);
  } catch (e) {
    logger.debug(`EIP-1271 call failed for ${ownerAddress}: ${(e as Error)?.message}`);
    return false;
  }
}

/** Pad hex string right to next multiple of 64 chars (32 bytes). */
function padRight32(hexNo0x: string): string {
  const rem = hexNo0x.length % 64;
  return rem === 0 ? hexNo0x : hexNo0x + '0'.repeat(64 - rem);
}

/**
 * Verify a per-request signature using Web Crypto ECDSA over P-256.
 *
 * `sessionPublicKey` must be the 65-byte uncompressed SEC1 form
 * (0x04 || X || Y) as hex — the exact format the client exported
 * from `subtle.exportKey('raw', publicKey)`.
 *
 * Signature MUST be 64 bytes (r || s), as Web Crypto produces — NOT
 * DER. The Lit Action uses the same format.
 */
export async function verifyRequestSignature(
  sessionPublicKey: `0x${string}`,
  canonicalRequest: string,
  requestSig: Hex,
): Promise<boolean> {
  try {
    const pubBytes = hexToBytes(sessionPublicKey);
    if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
      logger.debug(`Session public key malformed: len=${pubBytes.length}, tag=${pubBytes[0]}`);
      return false;
    }
    const sigBytes = hexToBytes(requestSig);
    if (sigBytes.length !== 64) {
      logger.debug(`Request signature wrong length: ${sigBytes.length} (expected 64)`);
      return false;
    }
    const subtle = globalThis.crypto.subtle;
    // TS 5.7+ `BufferSource` narrows to `ArrayBuffer`-backed views;
    // we re-wrap our Uint8Array into a fresh ArrayBuffer to satisfy
    // the signature without silencing the type-check for everyone.
    const pub = await subtle.importKey(
      'raw',
      toArrayBuffer(pubBytes),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      toArrayBuffer(sigBytes),
      toArrayBuffer(new TextEncoder().encode(canonicalRequest)),
    );
  } catch (e) {
    logger.debug(`Request sig verify threw: ${(e as Error)?.message}`);
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}

/** Copy a Uint8Array into a fresh ArrayBuffer (for Web Crypto BufferSource). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.length);
  new Uint8Array(ab).set(u8);
  return ab;
}

// ── Anti-replay + revocation caches ──────────────────────────────────

/**
 * Two in-memory maps:
 *   - `revokedDelegations`: delegationNonce → expiresAt
 *     Once a user hits the revoke endpoint, we reject the
 *     delegation for the rest of its natural window.
 *   - `seenRequestNonces`: `${delegationNonce}:${requestNonce}` →
 *     expiresAt
 *     Enforces per-request single-use nonces within the delegation
 *     window. Drops entries via periodic sweep once their bound
 *     delegation has expired.
 *
 * These maps are PER-PROCESS. The Lit Action itself is stateless
 * across nodes, so an attacker could in theory replay within the
 * 60-second per-request freshness window. That's why the Lit Action
 * *also* enforces freshness via `abs(now - requestedAt) <= 60`.
 * Our server-side map is defence in depth — saves Lit calls on
 * obvious replay attempts that land on the same PC2 node.
 */
const revokedDelegations = new Map<string, number>();
const seenRequestNonces = new Map<string, number>();

/** Max sizes to cap worst-case memory from adversarial clients. */
const MAX_REVOKED = 10_000;
const MAX_SEEN_NONCES = 100_000;

/** Add a delegation to the revoke list until its natural expiry. */
export function revokeDelegation(delegationNonce: `0x${string}`, expiresAt: number): void {
  if (revokedDelegations.size >= MAX_REVOKED) {
    sweepRevocationCache();
  }
  revokedDelegations.set(delegationNonce.toLowerCase(), expiresAt);
}

/** Check if a delegation nonce has been revoked (and not yet expired). */
export function isDelegationRevoked(delegationNonce: `0x${string}`): boolean {
  const key = delegationNonce.toLowerCase();
  const exp = revokedDelegations.get(key);
  if (exp === undefined) return false;
  if (exp < Math.floor(Date.now() / 1000)) {
    revokedDelegations.delete(key);
    return false;
  }
  return true;
}

/**
 * Record a per-request nonce as seen. Returns true if this is the
 * first time we've seen it (ok to proceed), false if a replay.
 */
export function markRequestNonceSeen(
  delegationNonce: `0x${string}`,
  requestNonce: `0x${string}`,
  expiresAt: number,
): boolean {
  if (seenRequestNonces.size >= MAX_SEEN_NONCES) {
    sweepReplayCache();
  }
  const key = `${delegationNonce.toLowerCase()}:${requestNonce.toLowerCase()}`;
  if (seenRequestNonces.has(key)) return false;
  seenRequestNonces.set(key, expiresAt);
  return true;
}

function sweepRevocationCache(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, exp] of revokedDelegations) {
    if (exp < now) revokedDelegations.delete(k);
  }
}

function sweepReplayCache(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, exp] of seenRequestNonces) {
    if (exp < now) seenRequestNonces.delete(k);
  }
}

/** Exposed for tests / admin. */
export function _getSessionCacheStats() {
  return {
    revokedDelegations: revokedDelegations.size,
    seenRequestNonces: seenRequestNonces.size,
  };
}

/** Exposed for tests — clear in-memory state. */
export function _resetSessionCaches(): void {
  revokedDelegations.clear();
  seenRequestNonces.clear();
}

// ── Orchestration: full verify bundle ─────────────────────────────────

export interface VerifyContext {
  /** Expected Lit Action IPFS CID (from server env). */
  expectedActionIpfsId: string;
  /** Expected chain id (8453 = Base). */
  expectedChainId: number;
  /** kid from the secure-view request body (with or without 0x prefix). */
  expectedKid: string;
  /** Seconds-since-epoch. Defaults to `Date.now()/1000`. */
  now?: number;
  /**
   * Optional eth_call adapter for EIP-1271. When omitted, EIP-1271
   * verification is skipped — caller opts out. Every PC2 node uses
   * a viem `PublicClient` so wiring is trivial.
   */
  ethCall?: (tx: { to: `0x${string}`; data: Hex }) => Promise<Hex>;
  /** When EIP-1271 is used we also need the EIP-191 message hash. */
  messageHashForEip1271?: Hex;
}

/**
 * Structural + cryptographic defence-in-depth for a full verify
 * bundle. Returns `{ ok: true, delegation, request, recoveredOwner }`
 * on success.
 *
 * Deliberately DOES NOT perform the on-chain `hasAccessByContentId`
 * check — that belongs in the Lit Action (it's what the Lit Action
 * is paid to do inside the TEE).
 */
export async function verifySecureViewBundle(
  bundle: VerifyBundle,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const now = ctx.now ?? Math.floor(Date.now() / 1000);

  // Parse
  let del: SecureViewDelegation;
  let req: SecureViewRequest;
  try {
    del = JSON.parse(bundle.delegation) as SecureViewDelegation;
  } catch {
    return { ok: false, error: 'del_malformed' };
  }
  try {
    req = JSON.parse(bundle.request) as SecureViewRequest;
  } catch {
    return { ok: false, error: 'req_malformed' };
  }

  // Structural delegation checks
  if (del.domain !== DELEGATION_DOMAIN) return { ok: false, error: 'bad_domain' };
  if (del.chainId !== ctx.expectedChainId) return { ok: false, error: 'bad_chain' };
  if (del.actionIpfsId !== ctx.expectedActionIpfsId)
    return { ok: false, error: 'bad_action_cid' };
  if (!isAddress(del.ownerAddress)) return { ok: false, error: 'del_malformed' };
  if (!Array.isArray(del.coveredAddresses) || del.coveredAddresses.length === 0)
    return { ok: false, error: 'del_malformed' };
  for (const a of del.coveredAddresses) if (!isAddress(a)) return { ok: false, error: 'del_malformed' };
  if (typeof del.sessionPublicKey !== 'string' || !/^0x04[0-9a-fA-F]{128}$/.test(del.sessionPublicKey))
    return { ok: false, error: 'pub_malformed' };
  if (typeof del.issuedAt !== 'number' || typeof del.expiresAt !== 'number')
    return { ok: false, error: 'del_malformed' };
  if (now < del.issuedAt - DELEGATION_CLOCK_SKEW_SECONDS) return { ok: false, error: 'del_not_yet_valid' };
  if (now > del.expiresAt) return { ok: false, error: 'del_expired' };
  if (del.expiresAt - del.issuedAt > MAX_DELEGATION_WINDOW_SECONDS)
    return { ok: false, error: 'del_window_too_wide' };
  if (typeof del.nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(del.nonce))
    return { ok: false, error: 'del_malformed' };

  // Structural request checks
  if (req.domain !== REQUEST_DOMAIN) return { ok: false, error: 'bad_req_domain' };
  if (req.actionIpfsId !== ctx.expectedActionIpfsId) return { ok: false, error: 'bad_req_action_cid' };
  const expectedKidNormalised = normaliseHex(ctx.expectedKid).toLowerCase();
  if (typeof req.kid !== 'string' || normaliseHex(req.kid).toLowerCase() !== expectedKidNormalised)
    return { ok: false, error: 'bad_req_kid' };
  if (typeof req.requestedAt !== 'number') return { ok: false, error: 'req_malformed' };
  if (Math.abs(now - req.requestedAt) > REQUEST_FRESHNESS_WINDOW_SECONDS)
    return { ok: false, error: 'req_stale_or_future' };
  if (typeof req.requestNonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(req.requestNonce))
    return { ok: false, error: 'req_malformed' };

  // Revocation + replay (cheap, do before sig math)
  if (isDelegationRevoked(del.nonce)) return { ok: false, error: 'revoked' };
  if (!markRequestNonceSeen(del.nonce, req.requestNonce, del.expiresAt))
    return { ok: false, error: 'replayed' };

  // Delegation signature — EIP-191 first, EIP-1271 fallback
  let recoveredOwner: `0x${string}` | null = null;
  recoveredOwner = await verifyDelegationEip191(bundle.delegation, bundle.delegationSig);
  let delOk =
    recoveredOwner !== null &&
    getAddress(recoveredOwner).toLowerCase() === getAddress(del.ownerAddress).toLowerCase();

  if (!delOk && ctx.ethCall && ctx.messageHashForEip1271) {
    delOk = await verifyDelegationEip1271(
      del.ownerAddress,
      ctx.messageHashForEip1271,
      bundle.delegationSig,
      ctx.ethCall,
    );
    if (delOk) recoveredOwner = del.ownerAddress;
  }

  if (!delOk) return { ok: false, error: 'del_sig_invalid' };

  // Per-request signature
  const reqOk = await verifyRequestSignature(
    del.sessionPublicKey,
    bundle.request,
    bundle.requestSig,
  );
  if (!reqOk) return { ok: false, error: 'req_sig_invalid' };

  return { ok: true, delegation: del, request: req, recoveredOwner: recoveredOwner ?? undefined };
}
