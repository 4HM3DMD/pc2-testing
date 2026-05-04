/**
 * spike-secureview-primitives.mjs — exercises pc2-node/src/utils/
 * secureViewSession.ts end-to-end against real EOA + ephemeral keys.
 *
 * This is a *co-requisite* test for Phase 2a: it proves the server
 * verifier we just wrote actually accepts legitimate bundles and
 * rejects every negative case enumerated in DESIGN.md §2.6.
 *
 * If this script goes green, Phase 2a primitives are ready for
 * Phase 2b (endpoints).
 */

import { privateKeyToAccount, generatePrivateKey } from '../../pc2-node/node_modules/viem/_esm/accounts/index.js';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESULTS_DIR = join(__dirname, '.results');

// Resolve the compiled module dynamically so we pick up whatever the
// last `npm run build:ts` produced. We run tsc first in CI.
const MODULE_PATH = '../../pc2-node/dist/utils/secureViewSession.js';
const sv = await import(MODULE_PATH);

const DOMAIN = sv.DELEGATION_DOMAIN;
const REQ_DOMAIN = sv.REQUEST_DOMAIN;

const ACTION_CID = 'QmNayE5MYzXcoMS9nvRk6MUo8r4ESLa3i65vHXzuBsnC2b';
const CHAIN_ID = 8453;
const KID = '0x' + 'ab'.repeat(16);

async function makeSessionKey() {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const hex = '0x' + Array.from(rawPub).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { kp, sessionPublicKey: hex };
}

async function signRequest(kp, canonicalRequest) {
  const bytes = new TextEncoder().encode(canonicalRequest);
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, bytes),
  );
  return '0x' + Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildAndSign(owner, session, overrides = {}) {
  const del = sv.buildDelegationPayload({
    ownerAddress: owner.address,
    coveredAddresses: [owner.address],
    sessionPublicKey: session.sessionPublicKey,
    actionIpfsId: ACTION_CID,
    chainId: CHAIN_ID,
    ...overrides.delegation,
  });
  const delCanon = sv.canonicalize(del);
  const delSig = await owner.signMessage({ message: delCanon });

  const req = sv.buildRequestPayload({
    kid: KID,
    actionIpfsId: ACTION_CID,
    ...overrides.request,
  });
  const reqCanon = sv.canonicalize(req);
  const reqSig = await signRequest(session.kp, reqCanon);

  return { del, delCanon, delSig, req, reqCanon, reqSig };
}

function step(label, actual, expected) {
  const pass = actual === expected;
  console.log(`  ${label}: ${pass ? 'PASS' : 'FAIL'} (got ${actual}, expected ${expected})`);
  return pass;
}

async function main() {
  console.log('spike-secureview-primitives — end-to-end verifier test\n');

  const owner = privateKeyToAccount(generatePrivateKey());
  const session = await makeSessionKey();
  sv._resetSessionCaches();

  const ctx = {
    expectedActionIpfsId: ACTION_CID,
    expectedChainId: CHAIN_ID,
    expectedKid: KID,
  };

  const results = [];
  let allPass = true;
  const record = (label, pass) => {
    results.push({ label, pass });
    if (!pass) allPass = false;
  };

  // Happy path
  {
    const b = await buildAndSign(owner, session);
    const r = await sv.verifySecureViewBundle(
      { delegation: b.delCanon, delegationSig: b.delSig, request: b.reqCanon, requestSig: b.reqSig },
      ctx,
    );
    record('happy-path', step('happy-path', r.ok, true));
    record('happy-path recovered owner', step(
      'happy-path recovered owner',
      r.recoveredOwner?.toLowerCase() === owner.address.toLowerCase(),
      true,
    ));
  }

  // Bad domain
  {
    sv._resetSessionCaches();
    const b = await buildAndSign(owner, session);
    // Replace canonical JSON domain at the byte level
    const tampered = b.delCanon.replace(DOMAIN, 'evil.v1');
    const r = await sv.verifySecureViewBundle(
      { delegation: tampered, delegationSig: b.delSig, request: b.reqCanon, requestSig: b.reqSig },
      ctx,
    );
    record('bad_domain', step('bad_domain', r.error, 'bad_domain'));
  }

  // Bad chain
  {
    sv._resetSessionCaches();
    const b = await buildAndSign(owner, session, { delegation: { chainId: 1 } });
    // Re-sign since payload changed
    const delSig = await owner.signMessage({ message: b.delCanon });
    const r = await sv.verifySecureViewBundle(
      { delegation: b.delCanon, delegationSig: delSig, request: b.reqCanon, requestSig: b.reqSig },
      ctx,
    );
    record('bad_chain', step('bad_chain', r.error, 'bad_chain'));
  }

  // Bad action cid
  {
    sv._resetSessionCaches();
    const r = await sv.verifySecureViewBundle(
      (await (async () => {
        const b = await buildAndSign(owner, session, { delegation: { actionIpfsId: 'Qm-different' } });
        const sig = await owner.signMessage({ message: b.delCanon });
        return { delegation: b.delCanon, delegationSig: sig, request: b.reqCanon, requestSig: b.reqSig };
      })()),
      ctx,
    );
    record('bad_action_cid', step('bad_action_cid', r.error, 'bad_action_cid'));
  }

  // Expired delegation
  {
    sv._resetSessionCaches();
    const past = Math.floor(Date.now() / 1000) - 10;
    const del = sv.buildDelegationPayload({
      ownerAddress: owner.address,
      coveredAddresses: [owner.address],
      sessionPublicKey: session.sessionPublicKey,
      actionIpfsId: ACTION_CID,
      chainId: CHAIN_ID,
      issuedAt: past - 3600,
      ttlSeconds: 3599, // expires 1s ago
    });
    const delCanon = sv.canonicalize(del);
    const delSig = await owner.signMessage({ message: delCanon });
    const req = sv.buildRequestPayload({ kid: KID, actionIpfsId: ACTION_CID });
    const reqCanon = sv.canonicalize(req);
    const reqSig = await signRequest(session.kp, reqCanon);
    const r = await sv.verifySecureViewBundle(
      { delegation: delCanon, delegationSig: delSig, request: reqCanon, requestSig: reqSig },
      ctx,
    );
    record('del_expired', step('del_expired', r.error, 'del_expired'));
  }

  // Window too wide
  {
    sv._resetSessionCaches();
    const issuedAt = Math.floor(Date.now() / 1000);
    const del = sv.buildDelegationPayload({
      ownerAddress: owner.address,
      coveredAddresses: [owner.address],
      sessionPublicKey: session.sessionPublicKey,
      actionIpfsId: ACTION_CID,
      chainId: CHAIN_ID,
      issuedAt,
    });
    // Manually stretch expiresAt past the 24h cap (the builder caps, but attackers might hand-craft)
    const delWide = { ...del, expiresAt: issuedAt + 25 * 3600 };
    const canon = sv.canonicalize(delWide);
    const sig = await owner.signMessage({ message: canon });
    const req = sv.buildRequestPayload({ kid: KID, actionIpfsId: ACTION_CID });
    const reqCanon = sv.canonicalize(req);
    const reqSig = await signRequest(session.kp, reqCanon);
    const r = await sv.verifySecureViewBundle(
      { delegation: canon, delegationSig: sig, request: reqCanon, requestSig: reqSig },
      ctx,
    );
    record('del_window_too_wide', step('del_window_too_wide', r.error, 'del_window_too_wide'));
  }

  // Bad req kid
  {
    sv._resetSessionCaches();
    const del = sv.buildDelegationPayload({
      ownerAddress: owner.address,
      coveredAddresses: [owner.address],
      sessionPublicKey: session.sessionPublicKey,
      actionIpfsId: ACTION_CID,
      chainId: CHAIN_ID,
    });
    const delCanon = sv.canonicalize(del);
    const delSig = await owner.signMessage({ message: delCanon });
    const req = sv.buildRequestPayload({ kid: '0x' + 'cd'.repeat(16), actionIpfsId: ACTION_CID });
    const reqCanon = sv.canonicalize(req);
    const reqSig = await signRequest(session.kp, reqCanon);
    const r = await sv.verifySecureViewBundle(
      { delegation: delCanon, delegationSig: delSig, request: reqCanon, requestSig: reqSig },
      ctx,
    );
    record('bad_req_kid', step('bad_req_kid', r.error, 'bad_req_kid'));
  }

  // Stale request (requestedAt far in past)
  {
    sv._resetSessionCaches();
    const b = await buildAndSign(owner, session, {
      request: { requestedAt: Math.floor(Date.now() / 1000) - 300 },
    });
    const r = await sv.verifySecureViewBundle(
      { delegation: b.delCanon, delegationSig: b.delSig, request: b.reqCanon, requestSig: b.reqSig },
      ctx,
    );
    record('req_stale_or_future', step('req_stale_or_future', r.error, 'req_stale_or_future'));
  }

  // Wrong signer (delegation signed by some other EOA)
  {
    sv._resetSessionCaches();
    const attacker = privateKeyToAccount(generatePrivateKey());
    const del = sv.buildDelegationPayload({
      ownerAddress: owner.address, // claims owner
      coveredAddresses: [owner.address],
      sessionPublicKey: session.sessionPublicKey,
      actionIpfsId: ACTION_CID,
      chainId: CHAIN_ID,
    });
    const delCanon = sv.canonicalize(del);
    const delSig = await attacker.signMessage({ message: delCanon }); // wrong signer
    const req = sv.buildRequestPayload({ kid: KID, actionIpfsId: ACTION_CID });
    const reqCanon = sv.canonicalize(req);
    const reqSig = await signRequest(session.kp, reqCanon);
    const r = await sv.verifySecureViewBundle(
      { delegation: delCanon, delegationSig: delSig, request: reqCanon, requestSig: reqSig },
      ctx,
    );
    record('del_sig_invalid (wrong signer)', step('del_sig_invalid (wrong signer)', r.error, 'del_sig_invalid'));
  }

  // Tampered request signature (wrong ephemeral)
  {
    sv._resetSessionCaches();
    const otherSession = await makeSessionKey();
    const b = await buildAndSign(owner, session);
    const tamperReq = sv.buildRequestPayload({ kid: KID, actionIpfsId: ACTION_CID });
    const tamperCanon = sv.canonicalize(tamperReq);
    const tamperSig = await signRequest(otherSession.kp, tamperCanon); // signed by wrong key
    const r = await sv.verifySecureViewBundle(
      { delegation: b.delCanon, delegationSig: b.delSig, request: tamperCanon, requestSig: tamperSig },
      ctx,
    );
    record('req_sig_invalid', step('req_sig_invalid', r.error, 'req_sig_invalid'));
  }

  // Replay (same request nonce twice)
  {
    sv._resetSessionCaches();
    const b = await buildAndSign(owner, session);
    const bundle = { delegation: b.delCanon, delegationSig: b.delSig, request: b.reqCanon, requestSig: b.reqSig };
    const first = await sv.verifySecureViewBundle(bundle, ctx);
    const second = await sv.verifySecureViewBundle(bundle, ctx);
    record('replay first call', step('replay first call', first.ok, true));
    record('replay second call', step('replay second call', second.error, 'replayed'));
  }

  // Revocation
  {
    sv._resetSessionCaches();
    const b = await buildAndSign(owner, session);
    sv.revokeDelegation(b.del.nonce, b.del.expiresAt);
    const r = await sv.verifySecureViewBundle(
      { delegation: b.delCanon, delegationSig: b.delSig, request: b.reqCanon, requestSig: b.reqSig },
      ctx,
    );
    record('revoked delegation', step('revoked delegation', r.error, 'revoked'));
  }

  // Malformed session public key (valid request payload so parsing
  // reaches the pub-key structural check)
  {
    sv._resetSessionCaches();
    const del = sv.buildDelegationPayload({
      ownerAddress: owner.address,
      coveredAddresses: [owner.address],
      sessionPublicKey: '0xdeadbeef', // too short
      actionIpfsId: ACTION_CID,
      chainId: CHAIN_ID,
    });
    const canon = sv.canonicalize(del);
    const sig = await owner.signMessage({ message: canon });
    const req = sv.buildRequestPayload({ kid: KID, actionIpfsId: ACTION_CID });
    const reqCanon = sv.canonicalize(req);
    const r = await sv.verifySecureViewBundle(
      { delegation: canon, delegationSig: sig, request: reqCanon, requestSig: '0x' + '00'.repeat(64) },
      ctx,
    );
    record('pub_malformed', step('pub_malformed', r.error, 'pub_malformed'));
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const artefactPath = join(RESULTS_DIR, `secureview-primitives-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(artefactPath, JSON.stringify({ results, allPass }, null, 2), 'utf8');
  console.log(`\nArtefact: ${artefactPath}`);

  if (allPass) {
    console.log('\nVerdict: PASS. Phase 2a server verifier primitives are sound.');
    process.exit(0);
  }
  console.log('\nVerdict: FAIL.');
  process.exit(1);
}

main().catch((err) => {
  console.error('spike-secureview-primitives fatal:', err);
  process.exit(1);
});
