/**
 * spike-webcrypto-node.mjs — Phase 1 spike #3a (Node-side Web Crypto).
 *
 * Companion to scripts/spike/spike-webcrypto.html + .runner.mjs which
 * already proved P-256 is universally supported across browser engines.
 * That covers the CLIENT side (ephemeral session key generation).
 *
 * This spike covers the SERVER/Lit-Action side:
 *
 *   1. Node's `globalThis.crypto.subtle` can import the SEC1 uncompressed
 *      public key that the browser exports, and verify signatures.
 *   2. A sig produced by a non-extractable P-256 private key in a
 *      SEPARATE subtle.generateKey call verifies correctly against the
 *      exported public key (proves no shared-state cheating).
 *   3. `exportKey('raw', privateKey)` throws — the fundamental security
 *      invariant for ephemeral keys.
 *   4. `exportKey('pkcs8', privateKey)` ALSO throws when extractable:false.
 *   5. A tampered signature fails verification.
 *   6. A tampered payload (canonical JSON mutated by one byte) fails
 *      verification.
 *   7. Cross-curve attack: a signature from a different P-256 key
 *      fails verification against the original public key.
 *
 * All of these mirror the Lit Action's runtime checks (DESIGN.md §3.6)
 * and confirm the server-side half of Option C is sound.
 *
 * Exits 0 on full pass, 1 otherwise. Writes artefact to
 * scripts/spike/.results/webcrypto-node-<ts>.json.
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, '.results');

const subtle = globalThis.crypto?.subtle;
if (!subtle) {
  console.error('FATAL: globalThis.crypto.subtle unavailable (need Node 18+)');
  process.exit(1);
}

const encoder = new TextEncoder();

/** Canonical JSON — sorted keys, no whitespace. Matches spike #1 / DESIGN.md. */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function bytesToHex(buf) {
  return '0x' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mustThrow(label, fn) {
  try {
    await fn();
    return { label, threw: false, note: 'UNEXPECTED: did not throw' };
  } catch (e) {
    return { label, threw: true, error: e?.name || String(e) };
  }
}

async function main() {
  console.log('spike-webcrypto-node — proving Node verifier half of Option C\n');
  const results = { steps: [] };
  const add = (step) => {
    results.steps.push(step);
    const status = step.pass ? 'PASS' : 'FAIL';
    console.log(`  ${step.label}: ${status}${step.note ? ' (' + step.note + ')' : ''}`);
  };

  // 1. Generate a non-extractable P-256 key pair (simulating the browser's
  //    ephemeral session key).
  const kp = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // extractable: false — exactly what browser does
    ['sign', 'verify'],
  );
  add({ label: 'generateKey P-256 non-extractable', pass: !!(kp?.privateKey && kp?.publicKey) });

  // 2. Public key MUST be exportable as raw (SEC1 uncompressed 65-byte)
  const rawPub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const rawPubOk = rawPub.length === 65 && rawPub[0] === 0x04;
  add({ label: 'exportKey(raw) publicKey 65B SEC1 uncompressed', pass: rawPubOk, note: `len=${rawPub.length}` });

  // 3. Private key MUST NOT be exportable (raw)
  const privRaw = await mustThrow('exportKey(raw) privateKey throws', () => subtle.exportKey('raw', kp.privateKey));
  add({ ...privRaw, pass: privRaw.threw });

  // 4. Private key MUST NOT be exportable (pkcs8)
  const privPkcs8 = await mustThrow('exportKey(pkcs8) privateKey throws', () => subtle.exportKey('pkcs8', kp.privateKey));
  add({ ...privPkcs8, pass: privPkcs8.threw });

  // 5. Sign a canonical request payload. Matches SecureViewRequest (DESIGN.md §2.3)
  const req = {
    kid: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    assetId: '0x' + 'aa'.repeat(32),
    buyerAddress: '0x' + '11'.repeat(20),
    requestNonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    contentHash: '0x' + 'bb'.repeat(32),
  };
  const msg = canonicalize(req);
  const msgBytes = encoder.encode(msg);
  const sig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msgBytes),
  );
  add({ label: 'sign P-256 ECDSA SHA-256', pass: sig.length === 64, note: `len=${sig.length}` });

  // 6. Verify with EXPORTED public key re-imported (server simulates the
  //    "trusted public key came from a signed delegation" pathway).
  const importedPub = await subtle.importKey(
    'raw',
    rawPub,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const verifyOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, importedPub, sig, msgBytes);
  add({ label: 'verify via re-imported public key', pass: verifyOk });

  // 7. Tamper sig (flip one byte) → must fail
  const badSig = new Uint8Array(sig);
  badSig[10] ^= 0x01;
  const tamperedSigVerify = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, importedPub, badSig, msgBytes);
  add({ label: 'tampered signature rejected', pass: tamperedSigVerify === false });

  // 8. Tamper msg (flip one byte) → must fail
  const badMsg = new Uint8Array(msgBytes);
  badMsg[5] ^= 0x01;
  const tamperedMsgVerify = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, importedPub, sig, badMsg);
  add({ label: 'tampered message rejected', pass: tamperedMsgVerify === false });

  // 9. Sig from a DIFFERENT key must not verify against importedPub
  const kp2 = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const sig2 = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp2.privateKey, msgBytes));
  const crossKeyVerify = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, importedPub, sig2, msgBytes);
  add({ label: 'signature from different keypair rejected', pass: crossKeyVerify === false });

  // 10. Truncated signature must not verify
  const truncSig = sig.slice(0, 32);
  let truncResult = false;
  try {
    truncResult = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, importedPub, truncSig, msgBytes);
  } catch {
    truncResult = false; // throw is fine, counts as rejection
  }
  add({ label: 'truncated signature rejected', pass: truncResult === false });

  const allPass = results.steps.every((s) => s.pass);

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const artefactPath = join(RESULTS_DIR, `webcrypto-node-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    artefactPath,
    JSON.stringify(
      {
        schema: 'spike-webcrypto-node@v1',
        finishedAt: new Date().toISOString(),
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        curve: 'P-256',
        hash: 'SHA-256',
        ...results,
        allPass,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nArtefact: ${artefactPath}`);

  if (allPass) {
    console.log('\nVerdict: PASS. Node Web Crypto verifier is reliable for our protocol.');
    process.exit(0);
  }
  console.log('\nVerdict: FAIL.');
  process.exit(1);
}

main().catch((err) => {
  console.error('spike-webcrypto-node fatal error:', err);
  process.exit(1);
});
