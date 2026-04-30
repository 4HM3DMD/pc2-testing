#!/usr/bin/env node
/**
 * Wave 8 (H-01.2) — Offline provision-signature verification harness.
 *
 * Generates an ephemeral Ed25519 keypair, constructs a signed provision
 * envelope in the exact canonical form the real supernode must produce,
 * and exercises the acceptance/rejection paths of `parseProvisionResponse`
 * using the same verification primitives shipped in chipotle-client.ts.
 *
 * This does NOT use the real Elacity Labs key (which lives offline). It
 * verifies that the verification *logic* is correct; the real key comes
 * via ELACITY_LABS_PROVISION_PUBKEY_HEX in chipotle-client.ts after the
 * key-generation ceremony.
 */

import { generateKeyPairSync, sign as cryptoSign, createPublicKey, verify as cryptoVerify } from 'crypto';

const PROVISION_ENVELOPE_DOMAIN = 'elacity.pc2.chipotle-provision.v1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ALLOWED_API_URLS = new Set([
  'https://api.chipotle.litprotocol.com',
  'https://api.dev.litprotocol.com',
]);

let PASS = 0;
let FAIL = 0;
const ok = (label) => { console.log(`  \x1b[32m✓\x1b[0m ${label}`); PASS++; };
const ko = (label, reason) => { console.log(`  \x1b[31m✗\x1b[0m ${label}\n    \x1b[33m${reason}\x1b[0m`); FAIL++; };

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function validateProvisionPayload(p) {
  if (!p || typeof p !== 'object') return { ok: false, reason: 'payload_not_object' };
  if (typeof p.apiUrl !== 'string' || !ALLOWED_API_URLS.has(p.apiUrl)) {
    return { ok: false, reason: `apiUrl_not_allowlisted:${p.apiUrl}` };
  }
  if (typeof p.usageKey !== 'string' || p.usageKey.length < 16 || p.usageKey === 'REPLACE_WITH_USAGE_API_KEY') {
    return { ok: false, reason: 'usageKey_missing_or_placeholder' };
  }
  if (typeof p.pkpId !== 'string' || !p.pkpId.startsWith('0x')) return { ok: false, reason: 'pkpId_invalid' };
  if (typeof p.authority !== 'string' || !p.authority.startsWith('0x')) return { ok: false, reason: 'authority_invalid' };
  return { ok: true };
}

function verifyEnvelope(envelope, pubKeyHex) {
  if (/^0{64}$/.test(pubKeyHex)) return false;
  if (typeof envelope.sig !== 'string' || envelope.sig.length === 0) return false;

  const pubBytes = Buffer.from(pubKeyHex, 'hex');
  if (pubBytes.length !== 32) return false;

  const spki = Buffer.concat([ED25519_SPKI_PREFIX, pubBytes]);
  const pubKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });

  const { sig, ...signed } = envelope;
  const msg = Buffer.from(canonicalize(signed), 'utf8');
  const sigBytes = Buffer.from(sig, 'base64');
  if (sigBytes.length !== 64) return false;

  try {
    return cryptoVerify(null, msg, pubKey, sigBytes);
  } catch {
    return false;
  }
}

function parseProvisionResponse(body, opts = { strict: true, pubKeyHex: null }) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'body_not_json' };
  }

  const looksLikeEnvelope = parsed !== null && typeof parsed === 'object' && 'sig' in parsed && 'payload' in parsed;

  if (looksLikeEnvelope) {
    if (parsed.v !== 1 || parsed.domain !== PROVISION_ENVELOPE_DOMAIN) {
      return { ok: false, reason: 'envelope_bad_domain_or_version' };
    }
    if (typeof parsed.signedAt !== 'number') return { ok: false, reason: 'envelope_bad_signedAt' };

    if (!verifyEnvelope(parsed, opts.pubKeyHex)) return { ok: false, reason: 'provision_sig_invalid' };
    const valid = validateProvisionPayload(parsed.payload);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    return { ok: true, config: parsed.payload };
  }

  if (opts.strict) return { ok: false, reason: 'unsigned_provision_rejected' };
  const valid = validateProvisionPayload(parsed);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  return { ok: true, config: parsed };
}

// ── Test fixture ─────────────────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPubKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const pubKeyHex = rawPubKey.toString('hex');

const goodPayload = {
  version: 1,
  network: 'chipotle-mainnet',
  apiUrl: 'https://api.chipotle.litprotocol.com',
  usageKey: 'this-is-a-long-enough-usage-key-placeholder',
  pkpId: '0x68dcf3dc3c38d726e8a7cdca8ab318f49552c05d',
  authority: '0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D',
  chain: 'base',
  chainId: 8453,
  rpc: 'https://mainnet.base.org',
  actions: {
    nonMediaEncrypt: 'QmabcNonMediaEncrypt',
    nonMediaDecrypt: 'QmabcNonMediaDecrypt',
    mediaDecrypt: 'QmabcMediaDecrypt',
  },
};

function buildEnvelope(payload, opts = {}) {
  const envBase = {
    v: 1,
    domain: PROVISION_ENVELOPE_DOMAIN,
    signedAt: opts.signedAt ?? Math.floor(Date.now() / 1000),
    payload,
  };
  const msg = Buffer.from(canonicalize(envBase), 'utf8');
  const sig = cryptoSign(null, msg, privateKey).toString('base64');
  return { ...envBase, sig, ...(opts.override || {}) };
}

console.log('\nWave 8 H-01.2 provision-signature harness');
console.log(`  Ephemeral pubkey (hex, first 16): ${pubKeyHex.substring(0, 16)}…`);
console.log('');

// 1. Well-formed signed envelope — accept.
{
  const env = buildEnvelope(goodPayload);
  const result = parseProvisionResponse(JSON.stringify(env), { strict: true, pubKeyHex });
  if (result.ok && result.config.apiUrl === goodPayload.apiUrl) ok('valid signed envelope accepted');
  else ko('valid signed envelope accepted', result.reason || 'apiUrl mismatch');
}

// 2. Tampered payload after signing — reject.
{
  const env = buildEnvelope(goodPayload);
  env.payload = { ...env.payload, apiUrl: 'https://evil.example.com' };
  const result = parseProvisionResponse(JSON.stringify(env), { strict: true, pubKeyHex });
  if (!result.ok && result.reason === 'provision_sig_invalid') ok('tampered payload rejected (sig invalid)');
  else ko('tampered payload rejected (sig invalid)', `got ok=${result.ok} reason=${result.reason}`);
}

// 3. Disallowed apiUrl in a properly signed envelope — reject (allowlist).
{
  const evilPayload = { ...goodPayload, apiUrl: 'https://evil.example.com' };
  const env = buildEnvelope(evilPayload);
  const result = parseProvisionResponse(JSON.stringify(env), { strict: true, pubKeyHex });
  if (!result.ok && result.reason && result.reason.startsWith('apiUrl_not_allowlisted:')) {
    ok('disallowed apiUrl rejected by allowlist (even with valid sig)');
  } else {
    ko('disallowed apiUrl rejected by allowlist', `got ok=${result.ok} reason=${result.reason}`);
  }
}

// 4. Sig present but produced with the wrong key — reject.
{
  const env = buildEnvelope(goodPayload);
  const { privateKey: evilKey } = generateKeyPairSync('ed25519');
  const msg = Buffer.from(canonicalize({ v: env.v, domain: env.domain, signedAt: env.signedAt, payload: env.payload }), 'utf8');
  env.sig = cryptoSign(null, msg, evilKey).toString('base64');
  const result = parseProvisionResponse(JSON.stringify(env), { strict: true, pubKeyHex });
  if (!result.ok && result.reason === 'provision_sig_invalid') ok('wrong-key signature rejected');
  else ko('wrong-key signature rejected', `got ok=${result.ok} reason=${result.reason}`);
}

// 5. Wrong domain — reject.
{
  const env = buildEnvelope(goodPayload);
  env.domain = 'elacity.pc2.wrong.v1';
  const result = parseProvisionResponse(JSON.stringify(env), { strict: true, pubKeyHex });
  if (!result.ok && result.reason === 'envelope_bad_domain_or_version') ok('wrong envelope domain rejected');
  else ko('wrong envelope domain rejected', `got ok=${result.ok} reason=${result.reason}`);
}

// 6. Unsigned legacy blob in strict mode — reject.
{
  const result = parseProvisionResponse(JSON.stringify(goodPayload), { strict: true, pubKeyHex });
  if (!result.ok && result.reason === 'unsigned_provision_rejected') ok('unsigned blob rejected in strict mode');
  else ko('unsigned blob rejected in strict mode', `got ok=${result.ok} reason=${result.reason}`);
}

// 7. Unsigned legacy blob when strict=false — accepted with warning.
{
  const result = parseProvisionResponse(JSON.stringify(goodPayload), { strict: false, pubKeyHex });
  if (result.ok) ok('unsigned blob accepted in permissive mode (emergency bootstrap)');
  else ko('unsigned blob accepted in permissive mode', `got reason=${result.reason}`);
}

// 8. Non-JSON body — reject.
{
  const result = parseProvisionResponse('<html>gateway timeout</html>', { strict: true, pubKeyHex });
  if (!result.ok && result.reason === 'body_not_json') ok('non-JSON body rejected');
  else ko('non-JSON body rejected', `got ok=${result.ok} reason=${result.reason}`);
}

// 9. All-zeros placeholder pubkey — always rejects (fail-safe before ceremony).
{
  const env = buildEnvelope(goodPayload);
  const zeros = '0'.repeat(64);
  const result = parseProvisionResponse(JSON.stringify(env), { strict: true, pubKeyHex: zeros });
  if (!result.ok && result.reason === 'provision_sig_invalid') ok('placeholder pubkey rejects valid signatures (fail-safe)');
  else ko('placeholder pubkey fail-safe', `got ok=${result.ok} reason=${result.reason}`);
}

console.log('');
console.log(`  \x1b[32mPASS: ${PASS}\x1b[0m`);
console.log(`  \x1b[31mFAIL: ${FAIL}\x1b[0m`);

if (FAIL > 0) process.exit(1);
process.exit(0);
