/**
 * verifySiweSignature (SEC-3a, 2026-04 audit)
 *
 * Cryptographically verify a Sign-in-with-Ethereum (SIWE) or
 * Sign-in-with-Solana (SIWS) signature against an expected wallet
 * address. Supports:
 *   - EVM EOA secp256k1 (the common case)
 *   - EIP-1271 smart-contract-account signatures (UniversalX, Argent, Safe)
 *   - Solana ed25519 signatures (SIWS)
 *
 * Used by /auth/particle and /api/access/claim-ownership to bind
 * ownership claims to wallet control proofs (closes Finding 3 of the
 * security audit).
 *
 * Replay protection (nonce/timestamp) is the CALLER's job, not this
 * helper's. See pc2-node/src/api/auth/challenge-store.ts.
 *
 * Spec: pc2-node/tests/security/siwe-verify.test.js
 */

import { recoverMessageAddress, isAddress, hashMessage } from 'viem';
import type { Hex } from 'viem';
import nacl from 'tweetnacl';

export type AddressType = 'evm' | 'solana';

export interface SiweVerifyInput {
    message: string;
    signature: string;
    expectedAddress: string;
    addressType: AddressType;
    /**
   * For EIP-1271 smart-account verification: the contract address.
   * If supplied, the eip1271Verifier MUST also be supplied via options
   * — otherwise the helper fails closed and DOES NOT silently fall
   * back to EOA recovery.
   */
    smartAccountAddress?: string;
    /** For EIP-1271 RPC selection. */
    chainId?: number;
}

export interface SiweVerifyOptions {
    /**
   * Returns true iff the SA contract's isValidSignature(hash, sig)
   * returns the EIP-1271 magic value (0x1626ba7e). Injected for
   * testability and to avoid hard-coding an RPC client here.
   */
    eip1271Verifier?: (smartAccountAddress: string, hash: string, signature: string) => Promise<boolean>;
}

export type SiweVerifyResult =
    | { valid: true; recoveredAddress: string }
    | { valid: false; reason: string };

const SUPPORTED_TYPES: ReadonlySet<AddressType> = new Set(['evm', 'solana']);

// Inline base58 (Solana alphabet) — keeps this module dep-free beyond
// existing tweetnacl/viem. Spec test file uses an identical encoder.
const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BS58_INDEX: Record<string, number> = (() => {
    const m: Record<string, number> = {};
    for ( let i = 0; i < BS58_ALPHABET.length; i++ ) m[BS58_ALPHABET[i]] = i;
    return m;
})();

function bs58Decode (s: string): Uint8Array | null {
    if ( typeof s !== 'string' || s.length === 0 ) return null;
    let zeros = 0;
    while ( zeros < s.length && s[zeros] === '1' ) zeros++;
    const digits: number[] = [0];
    for ( let i = zeros; i < s.length; i++ ) {
        const idx = BS58_INDEX[s[i]];
        if ( idx === undefined ) return null;
        let carry = idx;
        for ( let j = 0; j < digits.length; j++ ) {
            carry += digits[j] * 58;
            digits[j] = carry & 0xff;
            carry >>= 8;
        }
        while ( carry > 0 ) {
            digits.push(carry & 0xff);
            carry >>= 8;
        }
    }
    const out = new Uint8Array(zeros + digits.length);
    for ( let i = 0; i < zeros; i++ ) out[i] = 0;
    for ( let i = 0; i < digits.length; i++ ) out[zeros + i] = digits[digits.length - 1 - i];
    return out;
}

function isHex (s: string): boolean {
    return /^0x[0-9a-fA-F]*$/.test(s);
}

export async function verifySiweSignature (
    input: SiweVerifyInput,
    options: SiweVerifyOptions = {},
): Promise<SiweVerifyResult> {
    if ( !input || typeof input !== 'object' ) {
        return { valid: false, reason: 'missing input' };
    }
    const { message, signature, expectedAddress, addressType, smartAccountAddress } = input;

    if ( typeof message !== 'string' || message.length === 0 ) {
        return { valid: false, reason: 'missing message' };
    }
    if ( typeof signature !== 'string' || signature.length === 0 ) {
        return { valid: false, reason: 'missing signature' };
    }
    if ( typeof expectedAddress !== 'string' || expectedAddress.length === 0 ) {
        return { valid: false, reason: 'missing expectedAddress' };
    }
    if ( ! SUPPORTED_TYPES.has(addressType) ) {
        return { valid: false, reason: `unsupported addressType: ${String(addressType)}` };
    }

    // ── EIP-1271 path: smart-account contract signature ──────────────────
    if ( smartAccountAddress ) {
        if ( addressType !== 'evm' ) {
            return { valid: false, reason: 'EIP-1271 only valid for evm addressType' };
        }
        if ( ! options.eip1271Verifier ) {
            // Fail closed — never silently fall back to EOA recovery, since
            // EOA recovery would treat the contract address as an EOA pubkey
            // and could match a maliciously-constructed signature. The caller
            // must explicitly opt in to EIP-1271 by injecting an RPC verifier.
            return { valid: false, reason: 'EIP-1271 verifier not configured (1271)' };
        }
        try {
            const hash = hashMessage(message);
            const ok = await options.eip1271Verifier(smartAccountAddress, hash, signature);
            if ( ! ok ) return { valid: false, reason: 'EIP-1271 verifier rejected signature' };
            return { valid: true, recoveredAddress: smartAccountAddress.toLowerCase() };
        } catch ( e: unknown ) {
            // RPC failures, malformed contract — fail closed, never crash.
            const msg = e instanceof Error ? e.message : 'unknown';
            return { valid: false, reason: `EIP-1271 verifier RPC error: ${msg}` };
        }
    }

    // ── EVM EOA path: secp256k1 personal_sign recovery ───────────────────
    if ( addressType === 'evm' ) {
        if ( ! isAddress(expectedAddress) ) {
            return { valid: false, reason: 'invalid EVM expectedAddress' };
        }
        if ( ! isHex(signature) ) {
            return { valid: false, reason: 'EVM signature must be hex (0x...)' };
        }
        // Standard personal_sign signatures are 65 bytes = 132 hex chars + 0x = 132.
        // Accept 132 only (defensive — rejects extra trailing bytes that some
        // wallets erroneously append).
        if ( signature.length !== 132 ) {
            return { valid: false, reason: 'EVM signature wrong length (must be 65 bytes / 132 hex chars)' };
        }
        try {
            const recovered = await recoverMessageAddress({
                message,
                signature: signature as Hex,
            });
            if ( recovered.toLowerCase() !== expectedAddress.toLowerCase() ) {
                return { valid: false, reason: 'recovered address does not match expectedAddress (mismatch)' };
            }
            return { valid: true, recoveredAddress: recovered.toLowerCase() };
        } catch ( e: unknown ) {
            const msg = e instanceof Error ? e.message : 'unknown';
            return { valid: false, reason: `EVM signature recovery failed: ${msg}` };
        }
    }

    // ── Solana SIWS path: ed25519 via tweetnacl ──────────────────────────
    if ( addressType === 'solana' ) {
        const pubKey = bs58Decode(expectedAddress);
        if ( !pubKey || pubKey.length !== 32 ) {
            return { valid: false, reason: 'invalid Solana expectedAddress (base58 / 32 bytes)' };
        }
        const sigBytes = bs58Decode(signature);
        if ( !sigBytes || sigBytes.length !== 64 ) {
            return { valid: false, reason: 'invalid Solana signature (base58 / 64 bytes)' };
        }
        try {
            const msgBytes = Buffer.from(message, 'utf8');
            const ok = nacl.sign.detached.verify(new Uint8Array(msgBytes),
                            sigBytes,
                            pubKey);
            if ( ! ok ) return { valid: false, reason: 'Solana ed25519 verification failed' };
            return { valid: true, recoveredAddress: expectedAddress };
        } catch ( e: unknown ) {
            const msg = e instanceof Error ? e.message : 'unknown';
            return { valid: false, reason: `Solana signature verification error: ${msg}` };
        }
    }

    return { valid: false, reason: 'unreachable' };
}
