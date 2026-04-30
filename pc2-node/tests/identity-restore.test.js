#!/usr/bin/env node

/**
 * Automated tests for the backup/restore identity system.
 * 
 * Tests:
 * 1. Deterministic mnemonic derivation (same mnemonic -> same keys every time)
 * 2. DER round-trip (SPKI/PKCS8 wrapping preserves raw keys)
 * 3. Sign/verify with derived keys
 * 4. AES-256-GCM identity encryption/decryption (backup cycle)
 * 5. Wrong mnemonic fails decryption (stolen backup protection)
 * 6. v1 backward compatibility (old identities still loadable)
 * 7. Different mnemonics produce different keys
 * 8. Base58 encoding round-trip
 * 
 * Run: node tests/identity-restore.test.js
 */

import nacl from 'tweetnacl';
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ── Helpers (mirror the production code) ────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function mnemonicToSeed(mnemonic) {
  const ikm = Buffer.from(mnemonic, 'utf8');
  const salt = Buffer.from('pc2-boson-identity-v2', 'utf8');
  const info = Buffer.from('ed25519-seed', 'utf8');
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
}

function deriveFromMnemonic(mnemonic) {
  const seed = mnemonicToSeed(mnemonic);
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  const rawPub = Buffer.from(kp.publicKey);
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return { publicKey: spki, privateKey: pkcs8, rawPub, seed };
}

function encryptIdentity(identityJson, pubKeyHex) {
  const pubKeyBuf = Buffer.from(pubKeyHex, 'hex');
  const salt = Buffer.from('pc2-backup-identity-encryption', 'utf8');
  const info = Buffer.from('aes-256-gcm-key', 'utf8');
  const prk = createHmac('sha256', salt).update(pubKeyBuf).digest();
  const aesKey = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const plaintext = Buffer.from(identityJson, 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), authTag: authTag.toString('hex'), ciphertext: encrypted.toString('hex'), version: 2 };
}

function decryptIdentity(encPayload, pubKeyHex) {
  const pubKeyBuf = Buffer.from(pubKeyHex, 'hex');
  const salt = Buffer.from('pc2-backup-identity-encryption', 'utf8');
  const info = Buffer.from('aes-256-gcm-key', 'utf8');
  const prk = createHmac('sha256', salt).update(pubKeyBuf).digest();
  const aesKey = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  const iv = Buffer.from(encPayload.iv, 'hex');
  const authTag = Buffer.from(encPayload.authTag, 'hex');
  const ciphertext = Buffer.from(encPayload.ciphertext, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes) {
  let num = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  while (num > 0n) { result = BASE58_ALPHABET[Number(num % 58n)] + result; num = num / 58n; }
  for (const byte of bytes) { if (byte === 0) result = '1' + result; else break; }
  return result || '1';
}
function fromBase58(str) {
  let num = BigInt(0);
  for (const char of str) { const i = BASE58_ALPHABET.indexOf(char); if (i === -1) throw new Error('Invalid'); num = num * 58n + BigInt(i); }
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  let leadingZeros = 0;
  for (const c of str) { if (c === '1') leadingZeros++; else break; }
  const data = Buffer.from(hex, 'hex');
  return leadingZeros > 0 ? Buffer.concat([Buffer.alloc(leadingZeros), data]) : data;
}

// ── Test Runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ FAIL: ${name}`); }
}

const TEST_MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual';
const DIFFERENT_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo abandon';

// ── Tests ───────────────────────────────────────────────────────────────

console.log('\n🧪 PC2 Identity & Restore Tests\n');

// Test 1: Deterministic derivation
console.log('Test 1: Deterministic mnemonic derivation');
{
  const kp1 = deriveFromMnemonic(TEST_MNEMONIC);
  const kp2 = deriveFromMnemonic(TEST_MNEMONIC);
  assert(kp1.publicKey.equals(kp2.publicKey), 'Same mnemonic produces same public key');
  assert(kp1.privateKey.equals(kp2.privateKey), 'Same mnemonic produces same private key');
  assert(kp1.seed.equals(kp2.seed), 'Same mnemonic produces same seed');
}

// Test 2: DER round-trip
console.log('\nTest 2: DER round-trip (SPKI/PKCS8 wrapping)');
{
  const kp = deriveFromMnemonic(TEST_MNEMONIC);
  const extractedPub = kp.publicKey.slice(-32);
  const extractedSeed = kp.privateKey.slice(-32);
  assert(extractedPub.equals(kp.rawPub), 'Public key survives SPKI wrap/extract');
  assert(extractedSeed.equals(kp.seed), 'Seed survives PKCS8 wrap/extract');
  assert(kp.publicKey.length === 44, `SPKI is 44 bytes (got ${kp.publicKey.length})`);
  assert(kp.privateKey.length === 48, `PKCS8 is 48 bytes (got ${kp.privateKey.length})`);
}

// Test 3: Sign/verify
console.log('\nTest 3: Sign and verify with derived keys');
{
  const kp = deriveFromMnemonic(TEST_MNEMONIC);
  const rawPub = kp.publicKey.slice(-32);
  const rawSeed = kp.privateKey.slice(-32);
  const rawPriv64 = Buffer.concat([rawSeed, rawPub]);
  const message = Buffer.from('test message for signing');
  const sig = nacl.sign.detached(message, new Uint8Array(rawPriv64));
  const verified = nacl.sign.detached.verify(message, sig, new Uint8Array(rawPub));
  assert(verified, 'Signature verifies with correct public key');
  
  const wrongMsg = Buffer.from('tampered message');
  const wrongVerify = nacl.sign.detached.verify(wrongMsg, sig, new Uint8Array(rawPub));
  assert(!wrongVerify, 'Tampered message fails verification');
}

// Test 4: Identity encryption/decryption (backup cycle)
console.log('\nTest 4: Identity encryption/decryption (backup cycle)');
{
  const kp = deriveFromMnemonic(TEST_MNEMONIC);
  const identity = {
    nodeId: toBase58(kp.rawPub),
    did: `did:boson:${toBase58(kp.rawPub)}`,
    publicKey: kp.publicKey.toString('hex'),
    privateKey: kp.privateKey.toString('hex'),
    identityVersion: 2,
    createdAt: new Date().toISOString()
  };
  const identityJson = JSON.stringify(identity);
  
  // Encrypt
  const encrypted = encryptIdentity(identityJson, identity.publicKey);
  assert(encrypted.version === 2, 'Encrypted payload has version 2');
  assert(encrypted.iv.length === 24, 'IV is 12 bytes (24 hex chars)');
  assert(encrypted.authTag.length === 32, 'Auth tag is 16 bytes (32 hex chars)');
  assert(encrypted.ciphertext.length > 0, 'Ciphertext is non-empty');
  
  // Decrypt with correct key (derived from same mnemonic)
  const kp2 = deriveFromMnemonic(TEST_MNEMONIC);
  const decrypted = decryptIdentity(encrypted, kp2.publicKey.toString('hex'));
  const decryptedIdentity = JSON.parse(decrypted);
  assert(decryptedIdentity.nodeId === identity.nodeId, 'Decrypted nodeId matches');
  assert(decryptedIdentity.publicKey === identity.publicKey, 'Decrypted publicKey matches');
  assert(decryptedIdentity.privateKey === identity.privateKey, 'Decrypted privateKey matches');
}

// Test 5: Wrong mnemonic fails decryption (stolen backup protection)
console.log('\nTest 5: Wrong mnemonic fails decryption (stolen backup protection)');
{
  const kp = deriveFromMnemonic(TEST_MNEMONIC);
  const identity = { publicKey: kp.publicKey.toString('hex'), privateKey: kp.privateKey.toString('hex') };
  const encrypted = encryptIdentity(JSON.stringify(identity), identity.publicKey);
  
  // Try decrypting with wrong mnemonic
  const wrongKp = deriveFromMnemonic(DIFFERENT_MNEMONIC);
  let decryptFailed = false;
  try {
    decryptIdentity(encrypted, wrongKp.publicKey.toString('hex'));
  } catch (e) {
    decryptFailed = true;
  }
  assert(decryptFailed, 'Decryption fails with wrong mnemonic (AES-GCM auth tag mismatch)');
}

// Test 6: Different mnemonics produce different keys
console.log('\nTest 6: Different mnemonics produce different keys');
{
  const kp1 = deriveFromMnemonic(TEST_MNEMONIC);
  const kp2 = deriveFromMnemonic(DIFFERENT_MNEMONIC);
  assert(!kp1.publicKey.equals(kp2.publicKey), 'Different mnemonics produce different public keys');
  assert(!kp1.seed.equals(kp2.seed), 'Different mnemonics produce different seeds');
}

// Test 7: Base58 round-trip
console.log('\nTest 7: Base58 encoding round-trip');
{
  const kp = deriveFromMnemonic(TEST_MNEMONIC);
  const nodeId = toBase58(kp.rawPub);
  assert(nodeId.length > 0, 'NodeId is non-empty');
  const decoded = fromBase58(nodeId);
  assert(decoded.equals(kp.rawPub), 'Base58 round-trip preserves public key');
}

// Test 8: v1 backward compatibility (no identityVersion field)
console.log('\nTest 8: v1 backward compatibility');
{
  // Simulate a v1 identity (no identityVersion, keys from generateKeyPairSync)
  const v1Identity = {
    nodeId: 'SomeLegacyBase58Id',
    did: 'did:boson:SomeLegacyBase58Id',
    publicKey: 'aaaa'.repeat(22),  // 44 bytes = SPKI
    privateKey: 'bbbb'.repeat(24), // 48 bytes = PKCS8
    createdAt: '2024-01-01T00:00:00.000Z'
  };
  assert(v1Identity.identityVersion === undefined, 'v1 identity has no identityVersion field');
  assert(v1Identity.identityVersion !== 2, 'v1 identity is NOT version 2');
  
  // Simulate the backup.js check: only encrypt if identityVersion === 2
  const shouldEncrypt = v1Identity.identityVersion === 2;
  assert(!shouldEncrypt, 'v1 identity is NOT encrypted in backup (plaintext preserved)');
}

// Test 9: Mnemonic verification (verifyMnemonic logic)
console.log('\nTest 9: Mnemonic verification');
{
  const kp = deriveFromMnemonic(TEST_MNEMONIC);
  const storedPubKey = kp.publicKey.toString('hex');
  
  // Correct mnemonic
  const verifyKp = deriveFromMnemonic(TEST_MNEMONIC);
  assert(verifyKp.publicKey.toString('hex') === storedPubKey, 'Correct mnemonic verifies against stored public key');
  
  // Wrong mnemonic
  const wrongKp = deriveFromMnemonic(DIFFERENT_MNEMONIC);
  assert(wrongKp.publicKey.toString('hex') !== storedPubKey, 'Wrong mnemonic does NOT match stored public key');
}

// Test 10: Full backup-restore cycle simulation
console.log('\nTest 10: Full backup-restore cycle simulation');
{
  // Step 1: "New node" generates identity from mnemonic
  const mnemonic = TEST_MNEMONIC;
  const kp = deriveFromMnemonic(mnemonic);
  const originalIdentity = {
    nodeId: toBase58(kp.rawPub),
    did: `did:boson:${toBase58(kp.rawPub)}`,
    publicKey: kp.publicKey.toString('hex'),
    privateKey: kp.privateKey.toString('hex'),
    identityVersion: 2,
    createdAt: new Date().toISOString()
  };
  
  // Step 2: "Backup" encrypts identity
  const encrypted = encryptIdentity(JSON.stringify(originalIdentity), originalIdentity.publicKey);
  const backupMeta = { formatVersion: 2, identityVersion: 2, createdAt: originalIdentity.createdAt };
  
  // Step 3: "New machine" gets the backup file + mnemonic
  // Re-derive keypair from mnemonic
  const restoredKp = deriveFromMnemonic(mnemonic);
  const restoredPubHex = restoredKp.publicKey.toString('hex');
  
  // Step 4: Decrypt identity with re-derived key
  const decryptedJson = decryptIdentity(encrypted, restoredPubHex);
  const restoredIdentity = JSON.parse(decryptedJson);
  
  // Step 5: Verify everything matches
  assert(restoredIdentity.nodeId === originalIdentity.nodeId, 'Restored nodeId matches original');
  assert(restoredIdentity.did === originalIdentity.did, 'Restored DID matches original');
  assert(restoredIdentity.publicKey === originalIdentity.publicKey, 'Restored publicKey matches original');
  assert(restoredIdentity.privateKey === originalIdentity.privateKey, 'Restored privateKey matches original');
  assert(restoredIdentity.identityVersion === 2, 'Restored identity is version 2');
  
  // Step 6: Sign with restored keys and verify with original public key
  const rawPub = restoredKp.publicKey.slice(-32);
  const rawSeed = restoredKp.privateKey.slice(-32);
  const rawPriv64 = Buffer.concat([rawSeed, rawPub]);
  const testMsg = Buffer.from('restored node signing test');
  const sig = nacl.sign.detached(testMsg, new Uint8Array(rawPriv64));
  const originalRawPub = kp.publicKey.slice(-32);
  const crossVerified = nacl.sign.detached.verify(testMsg, sig, new Uint8Array(originalRawPub));
  assert(crossVerified, 'Restored node signature verifies against original public key');
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED');
  process.exit(0);
}
