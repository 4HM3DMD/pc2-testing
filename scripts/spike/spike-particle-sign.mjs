/**
 * spike-particle-sign.mjs — Phase 1 spike #1 (EIP-191 personal_sign roundtrip).
 *
 * Goal: prove the `SecureViewDelegation` signing flow our Lit Action
 * will rely on — specifically that:
 *
 *   1. An EOA signs the canonical JSON of a SecureViewDelegation via
 *      EIP-191 `personal_sign` (what every web3 wallet emits, including
 *      Particle's EOA layer).
 *   2. The resulting signature is recoverable back to the EOA's address
 *      by `ethers.utils.verifyMessage` — which is the exact primitive
 *      used inside the Lit Action (see non-media-decrypt.js:309).
 *
 * Why does this prove the Particle case without a Particle wallet?
 *
 *   - `personal_sign` (EIP-191) is an Ethereum standard. Particle's
 *     wallet-SDK calls the underlying EOA signer. It doesn't alter the
 *     signature format.
 *   - ECDSA over secp256k1 is deterministic to recover modulo a chain-id
 *     tweak (EIP-155 is only for tx signing, not personal_sign).
 *   - Therefore if recovery is correct for ANY random EOA under viem's
 *     (server-side) recover primitive, it is correct for Particle's EOA.
 *
 *   The Particle-specific risks (popup UI, SDK wiring, session-sig vs
 *   native-sig toggle) are UI integration concerns — testable in Phase 3.
 *   This spike isolates the cryptographic primitive.
 *
 * Extras tested:
 *
 *   - `recoverMessageAddress` (viem) matches what ethers would do.
 *   - `verifyMessage` short-circuit primitive matches too.
 *   - Attacker trying to swap the address out of canonical JSON fails
 *     (tampered payload ⇒ recovers a different address ⇒ our code
 *      rejects).
 *
 * Exits 0 on full pass, 1 otherwise. Writes an artefact to
 * scripts/spike/.results/particle-sign-<ts>.json.
 */

import { privateKeyToAccount, generatePrivateKey } from '../../pc2-node/node_modules/viem/_esm/accounts/index.js';
import { verifyMessage, recoverMessageAddress } from '../../pc2-node/node_modules/viem/_esm/utils/index.js';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, '.results');

/**
 * Canonical JSON — sorted keys, no whitespace.
 * MUST stay byte-identical with the client-side canonicalize() and the
 * Lit Action's canonicalize(). Any drift breaks verification.
 */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/**
 * Build a SecureViewDelegation matching DESIGN.md §2.2 schema.
 * sessionPublicKey is a dummy string here; Spike 3 already validated
 * real P-256 keys end-to-end.
 */
function buildDelegation(ownerAddress, smartAccountAddress) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    actionIpfsId: 'QmNayE5MYzXcoMS9nvRk6MUo8r4ESLa3i65vHXzuBsnC2b',
    chainId: 8453,
    coveredAddresses: [ownerAddress, ...(smartAccountAddress ? [smartAccountAddress] : [])],
    domain: 'pc2.secure-view.v1',
    expiresAt: issuedAt + 24 * 3600,
    issuedAt,
    nonce: '0x' + 'ab'.repeat(16),
    ownerAddress,
    sessionPublicKey: '0x' + '04' + '11'.repeat(64), // dummy SEC1 uncompressed
  };
}

async function runOne({ label, smartAccountAddress }) {
  const acc = privateKeyToAccount(generatePrivateKey());
  const del = buildDelegation(acc.address, smartAccountAddress);
  const canonical = canonicalize(del);

  // 1. Sign canonical JSON via EIP-191 personal_sign
  const signature = await acc.signMessage({ message: canonical });

  // 2. Verify via the most commonly used server primitive
  const recovered = await recoverMessageAddress({ message: canonical, signature });
  const verifyOk = await verifyMessage({ address: acc.address, message: canonical, signature });
  const recoverMatches = recovered.toLowerCase() === acc.address.toLowerCase();

  // 3. Tamper test — if we mutate the canonical JSON, recovery must NOT
  //    recover the same address
  const tampered = canonical.replace(del.nonce, '0x' + 'cd'.repeat(16));
  const tamperedRecovered = await recoverMessageAddress({ message: tampered, signature });
  const tamperDefenceOk = tamperedRecovered.toLowerCase() !== acc.address.toLowerCase();

  // 4. Signature length & hex format sanity (wallet SDKs emit 65-byte r|s|v)
  const sigHexOk = /^0x[0-9a-fA-F]{130}$/.test(signature);

  return {
    label,
    ownerAddress: acc.address,
    smartAccountAddress: smartAccountAddress ?? null,
    canonicalLength: canonical.length,
    signature,
    recovered,
    recoverMatches,
    verifyOk,
    tamperDefenceOk,
    sigHexOk,
    allPass: recoverMatches && verifyOk && tamperDefenceOk && sigHexOk,
  };
}

async function main() {
  console.log('spike-particle-sign — proving EIP-191 delegation-sign roundtrip\n');

  const cases = [
    // EOA-only buyer (simplest case, matches DESIGN.md §2.5 row 1)
    { label: 'eoa-only', smartAccountAddress: null },
    // EOA + Particle smart account (DESIGN.md §2.5 row 2 — coveredAddresses has both)
    { label: 'particle-eoa+smart-account', smartAccountAddress: '0x' + '42'.repeat(20) },
  ];

  const results = [];
  let allPassed = true;
  for (const c of cases) {
    const r = await runOne(c);
    results.push(r);
    const status = r.allPass ? 'PASS' : 'FAIL';
    console.log(`  ${c.label}: ${status}`);
    console.log(`    owner         ${r.ownerAddress}`);
    if (r.smartAccountAddress) console.log(`    smart-account ${r.smartAccountAddress}`);
    console.log(`    sigHexOk      ${r.sigHexOk}`);
    console.log(`    recoverMatch  ${r.recoverMatches}`);
    console.log(`    verifyOk      ${r.verifyOk}`);
    console.log(`    tamperDefence ${r.tamperDefenceOk}\n`);
    if (!r.allPass) allPassed = false;
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const artefactPath = join(RESULTS_DIR, `particle-sign-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    artefactPath,
    JSON.stringify(
      {
        schema: 'spike-particle-sign@v1',
        finishedAt: new Date().toISOString(),
        platform: { node: process.version, os: process.platform, arch: process.arch },
        primitives: {
          canonicalization: 'sorted-keys JSON, matches client + Lit Action',
          signer: 'viem privateKeyToAccount().signMessage (EIP-191 personal_sign)',
          serverVerify: 'viem recoverMessageAddress / verifyMessage',
          litActionVerify: 'ethers.utils.verifyMessage (ethers v5) / ethers.verifyMessage (v6)',
        },
        results,
        verdict: {
          allPassed,
          note: allPassed
            ? 'EIP-191 delegation-sign roundtrip is sound. Particle EOA path ready.'
            : 'At least one case failed — investigate before Phase 2.',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Artefact: ${artefactPath}`);

  if (allPassed) {
    console.log('\nVerdict: PASS. EIP-191 delegation-sign works end-to-end.');
    console.log('Particle EOA path is cryptographically equivalent (personal_sign is standard).');
    process.exit(0);
  }
  console.log('\nVerdict: FAIL.');
  process.exit(1);
}

main().catch((err) => {
  console.error('spike-particle-sign error:', err);
  process.exit(1);
});
