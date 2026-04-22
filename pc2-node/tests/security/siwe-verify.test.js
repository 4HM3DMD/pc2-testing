/**
 * SPEC: verifySiweSignature
 *
 * Helper location (created in Wave 2 / SEC-3a):
 *   pc2-node/src/api/auth/siwe-verify.ts
 *
 * Purpose:
 *   Cryptographically verify a Sign-in-with-Ethereum (SIWE) or Sign-in-with-Solana (SIWS)
 *   signature against an expected wallet address. Supports:
 *     - EVM EOA secp256k1 (the common case)
 *     - EIP-1271 smart-contract-account signatures (UniversalX, Argent, Safe)
 *     - Solana ed25519 signatures (SIWS)
 *
 *   Used by /auth/particle and /api/access/claim-ownership to bind ownership
 *   claims to wallet control proofs (replaces the unauthenticated claim path
 *   identified in Finding 3 of the security audit).
 *
 * Required exports:
 *   export type AddressType = 'evm' | 'solana';
 *
 *   export interface SiweVerifyInput {
 *     message: string;              // the full SIWE/SIWS message that was signed
 *     signature: string;            // hex 0x... (EVM) or base58/base64 (Solana)
 *     expectedAddress: string;      // address we expect to have signed
 *     addressType: AddressType;
 *     smartAccountAddress?: string; // for EIP-1271, the contract address
 *     chainId?: number;             // for EIP-1271 RPC selection
 *   }
 *
 *   export interface SiweVerifyOptions {
 *     // Dependency injection for testability:
 *     // Returns true iff the SA contract's isValidSignature(hash, sig) returns
 *     // the EIP-1271 magic value (0x1626ba7e).
 *     eip1271Verifier?: (smartAccountAddress: string, hash: string, signature: string) => Promise<boolean>;
 *   }
 *
 *   export type SiweVerifyResult =
 *     | { valid: true; recoveredAddress: string }
 *     | { valid: false; reason: string };
 *
 *   export async function verifySiweSignature(
 *     input: SiweVerifyInput,
 *     options?: SiweVerifyOptions,
 *   ): Promise<SiweVerifyResult>;
 *
 * Security contract:
 *   - EVM EOA: recover with secp256k1, lowercase-compare against expectedAddress.
 *   - EIP-1271: hash the message (EIP-191 personal_sign envelope), call
 *     options.eip1271Verifier(sa, hash, sig). True iff verifier returns true.
 *   - Solana: verify ed25519 with tweetnacl against expectedAddress's public key.
 *   - ANY input parsing failure → { valid: false, reason: '...' } (NEVER throw).
 *   - Address comparison is normalized: EVM lowercase, Solana case-sensitive base58.
 *   - Empty/null inputs → { valid: false, reason: 'missing input' }.
 *   - Replay protection (nonce/timestamp checks) is the CALLER's job, not this helper's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import nacl from 'tweetnacl';

// Inline base58 (Solana alphabet) — avoids adding bs58 as a test-only dep.
const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const bs58 = {
  encode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes);
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const digits = [0];
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = '';
    for (let i = 0; i < zeros; i++) out += BS58_ALPHABET[0];
    for (let i = digits.length - 1; i >= 0; i--) out += BS58_ALPHABET[digits[i]];
    return out;
  },
};

const HELPER_PATH = '../../src/api/auth/siwe-verify.js';
let verifySiweSignature;

try {
  ({ verifySiweSignature } = await import(HELPER_PATH));
} catch (err) {
  console.warn(`[spec] siwe-verify not yet implemented at ${HELPER_PATH}: ${err.code || err.message}`);
}

function skipIfMissing(t) {
  if (!verifySiweSignature) {
    t.skip('helper not yet implemented (Wave 2 / SEC-3a)');
    return true;
  }
  return false;
}

const SIWE_MESSAGE = [
  'pc2-node.local wants you to sign in with your Ethereum account:',
  '0x1234567890123456789012345678901234567890',
  '',
  'Claim ownership of this PC2 node.',
  '',
  'URI: https://pc2-node.local',
  'Version: 1',
  'Chain ID: 20',
  'Nonce: 0123456789abcdef',
  'Issued At: 2026-04-21T12:00:00Z',
].join('\n');

// --- EVM EOA happy path & failure modes -----------------------------------

test('valid EVM EOA signature returns valid: true with normalized address', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: sig,
    expectedAddress: account.address,
    addressType: 'evm',
  });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.recoveredAddress.toLowerCase(), account.address.toLowerCase());
});

test('EVM signature compared against DIFFERENT address returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const accountA = privateKeyToAccount(generatePrivateKey());
  const accountB = privateKeyToAccount(generatePrivateKey());
  const sig = await accountA.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: sig,
    expectedAddress: accountB.address,
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /address|mismatch/i);
});

test('EVM signature over DIFFERENT message returns valid: false (tampered message)', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const tamperedMessage = SIWE_MESSAGE.replace('Claim ownership', 'Transfer 1000 ETH');
  const result = await verifySiweSignature({
    message: tamperedMessage,
    signature: sig,
    expectedAddress: account.address,
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

test('EVM signature compared case-insensitively (checksum vs lowercase)', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: sig,
    expectedAddress: account.address.toLowerCase(),
    addressType: 'evm',
  });
  assert.equal(result.valid, true, 'lowercase expectedAddress must still match');
});

// --- EVM EOA edge cases (must NEVER throw) -------------------------------

test('EVM empty signature returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  await assert.doesNotReject(verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '',
    expectedAddress: '0x1234567890123456789012345678901234567890',
    addressType: 'evm',
  }));
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '',
    expectedAddress: '0x1234567890123456789012345678901234567890',
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

test('EVM malformed signature (too short) returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0xdeadbeef',
    expectedAddress: '0x1234567890123456789012345678901234567890',
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

test('EVM signature with extra trailing bytes returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const tampered = sig + 'deadbeef'; // append extra nibbles
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: tampered,
    expectedAddress: account.address,
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

test('EVM signature with non-hex characters returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0xZZZZZZZZ' + 'a'.repeat(120),
    expectedAddress: '0x1234567890123456789012345678901234567890',
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

test('missing message returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: '',
    signature: sig,
    expectedAddress: account.address,
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

test('missing expectedAddress returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: sig,
    expectedAddress: '',
    addressType: 'evm',
  });
  assert.equal(result.valid, false);
});

// --- EIP-1271 (smart account) via injected verifier ----------------------

test('EIP-1271: verifier returns true → result valid: true', async (t) => {
  if (skipIfMissing(t)) return;
  const sa = '0xfeefeefeefeefeefeefeefeefeefeefeefeefeefee';
  const stubVerifier = async (saAddr, hash, signature) => {
    assert.equal(saAddr.toLowerCase(), sa.toLowerCase());
    assert.equal(typeof hash, 'string');
    assert.equal(typeof signature, 'string');
    return true;
  };
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0x' + 'aa'.repeat(65),
    expectedAddress: sa,
    addressType: 'evm',
    smartAccountAddress: sa,
    chainId: 20,
  }, { eip1271Verifier: stubVerifier });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('EIP-1271: verifier returns false → result valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const sa = '0xfeefeefeefeefeefeefeefeefeefeefeefeefeefee';
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0x' + 'aa'.repeat(65),
    expectedAddress: sa,
    addressType: 'evm',
    smartAccountAddress: sa,
    chainId: 20,
  }, { eip1271Verifier: async () => false });
  assert.equal(result.valid, false);
});

test('EIP-1271: verifier throws → result valid: false (RPC failure must fail-closed, never crash)', async (t) => {
  if (skipIfMissing(t)) return;
  const sa = '0xfeefeefeefeefeefeefeefeefeefeefeefeefeefee';
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0x' + 'aa'.repeat(65),
    expectedAddress: sa,
    addressType: 'evm',
    smartAccountAddress: sa,
    chainId: 20,
  }, { eip1271Verifier: async () => { throw new Error('RPC unreachable'); } });
  assert.equal(result.valid, false);
  assert.match(result.reason, /rpc|verifier|1271/i);
});

test('EIP-1271: smartAccountAddress provided but no eip1271Verifier in options → fail-closed', async (t) => {
  if (skipIfMissing(t)) return;
  const sa = '0xfeefeefeefeefeefeefeefeefeefeefeefeefeefee';
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0x' + 'aa'.repeat(65),
    expectedAddress: sa,
    addressType: 'evm',
    smartAccountAddress: sa,
    chainId: 20,
  });
  assert.equal(result.valid, false, 'no verifier configured must fail closed; helper must NOT silently fall back to EOA recovery');
});

// --- Solana SIWS (ed25519 via tweetnacl) ---------------------------------

test('valid Solana ed25519 signature returns valid: true', async (t) => {
  if (skipIfMissing(t)) return;
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  const sig = nacl.sign.detached(Buffer.from(SIWE_MESSAGE, 'utf8'), kp.secretKey);
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: bs58.encode(sig),
    expectedAddress: address,
    addressType: 'solana',
  });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('Solana signature compared against DIFFERENT address returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const kpA = nacl.sign.keyPair();
  const kpB = nacl.sign.keyPair();
  const sig = nacl.sign.detached(Buffer.from(SIWE_MESSAGE, 'utf8'), kpA.secretKey);
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: bs58.encode(sig),
    expectedAddress: bs58.encode(kpB.publicKey),
    addressType: 'solana',
  });
  assert.equal(result.valid, false);
});

test('Solana signature over DIFFERENT message returns valid: false', async (t) => {
  if (skipIfMissing(t)) return;
  const kp = nacl.sign.keyPair();
  const sig = nacl.sign.detached(Buffer.from(SIWE_MESSAGE, 'utf8'), kp.secretKey);
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE.replace('Claim', 'Transfer'),
    signature: bs58.encode(sig),
    expectedAddress: bs58.encode(kp.publicKey),
    addressType: 'solana',
  });
  assert.equal(result.valid, false);
});

test('Solana malformed signature (wrong length) returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const kp = nacl.sign.keyPair();
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: bs58.encode(Buffer.from([1, 2, 3])),
    expectedAddress: bs58.encode(kp.publicKey),
    addressType: 'solana',
  });
  assert.equal(result.valid, false);
});

test('Solana invalid base58 signature returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const kp = nacl.sign.keyPair();
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: '0OIl-not-base58',  // chars 0/O/I/l not in base58 alphabet
    expectedAddress: bs58.encode(kp.publicKey),
    addressType: 'solana',
  });
  assert.equal(result.valid, false);
});

test('Solana invalid base58 expectedAddress returns valid: false, no throw', async (t) => {
  if (skipIfMissing(t)) return;
  const kp = nacl.sign.keyPair();
  const sig = nacl.sign.detached(Buffer.from(SIWE_MESSAGE, 'utf8'), kp.secretKey);
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: bs58.encode(sig),
    expectedAddress: 'not-a-real-solana-address-0OIl',
    addressType: 'solana',
  });
  assert.equal(result.valid, false);
});

// --- Address-type confusion -----------------------------------------------

test('addressType=solana with an EVM address returns valid: false (fail-closed on type mismatch)', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: sig,
    expectedAddress: account.address,
    addressType: 'solana',  // wrong type for an EVM address
  });
  assert.equal(result.valid, false);
});

test('unknown addressType returns valid: false (fail-closed on unsupported chain)', async (t) => {
  if (skipIfMissing(t)) return;
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: SIWE_MESSAGE });
  const result = await verifySiweSignature({
    message: SIWE_MESSAGE,
    signature: sig,
    expectedAddress: account.address,
    addressType: 'cosmos',  // not supported
  });
  assert.equal(result.valid, false);
});

// --- Implementer note: replay protection -----------------------------------
//
// Replay protection (nonce/timestamp checks) is NOT this helper's responsibility.
// The caller (auth.ts /handleParticleAuth) MUST:
//   1. Issue a one-time nonce via /auth/challenge.
//   2. Verify the nonce in the SIWE message matches what was issued.
//   3. Verify the issued-at timestamp is within an acceptance window (e.g. 10min).
//   4. Mark the nonce consumed after successful verifySiweSignature().
// Integration tests for the full chain belong in auth.integration.test.js (Wave 2).
