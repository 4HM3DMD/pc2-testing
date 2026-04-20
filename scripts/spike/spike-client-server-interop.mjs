/**
 * spike-client-server-interop.mjs — Phase 2a interop test.
 *
 * Drives the client-side `secure-view-session.js` inside a real browser
 * (Chromium, Firefox, WebKit via Playwright) and verifies that the
 * payloads it produces are accepted by the server-side
 * `secureViewSession.ts` verifier in Node. This is the conformance
 * check that proves canonical JSON is byte-identical across the
 * boundary and that P-256 ECDSA signatures roundtrip.
 *
 * Pre-requisites:
 *   - pc2-node compiled (npm run build:backend) so dist/ exists.
 *   - Playwright browsers installed (npx playwright install).
 *
 * What this exercises per engine:
 *
 *   1. createEphemeralKey() — generate non-extractable P-256 keypair.
 *   2. buildDelegationPayload() — build payload.
 *   3. Simulate wallet: we use a fake EOA known inside Node (via
 *      viem) to sign the canonical delegation, because invoking a
 *      real wallet in a Playwright browser is out of scope for a spike.
 *      This is EXACTLY what Particle / MetaMask / Safe do — they hand
 *      back an EIP-191 signature of the same canonical bytes.
 *   4. signRequest() — silently signs per-request payload.
 *   5. Send { delegation, delegationSig, request, requestSig } to Node
 *      where verifySecureViewBundle() is invoked directly.
 *
 * Expectation: every engine emits bundles the server verifier accepts.
 */

import { chromium, firefox, webkit } from '../../node_modules/playwright/index.mjs';
import { privateKeyToAccount, generatePrivateKey } from '../../pc2-node/node_modules/viem/_esm/accounts/index.js';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLIENT_SCRIPT_PATH = join(REPO_ROOT, 'pc2-node/data/test-apps/shared/secure-view-session.js');
const RESULTS_DIR = join(__dirname, '.results');

const sv = await import(join(REPO_ROOT, 'pc2-node/dist/utils/secureViewSession.js'));

const ACTION_CID = 'QmNayE5MYzXcoMS9nvRk6MUo8r4ESLa3i65vHXzuBsnC2b';
const CHAIN_ID = 8453;
const KID = '0x' + 'ab'.repeat(16);

/** Build a served HTML for the given owner address. */
function buildHtmlFor(ownerAddress) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>interop</title></head>
<body>
<pre id="out">starting…</pre>
<script src="/secure-view-session.js"></script>
<script>
window.__TEST_OWNER_ADDRESS__ = ${JSON.stringify(ownerAddress)};
(async () => {
  const sv = window.PC2SecureViewSession;
  const out = document.getElementById('out');
  try {
    const { keyPair, sessionPublicKey } = await sv.createEphemeralKey();
    await sv.saveSessionKey(keyPair);
    const loaded = await sv.loadSessionKey();
    const storedOk = !!(loaded && loaded.privateKey && loaded.publicKey);

    const ownerAddress = window.__TEST_OWNER_ADDRESS__;
    const delegation = sv.buildDelegationPayload({
      ownerAddress,
      coveredAddresses: [ownerAddress],
      sessionPublicKey,
      actionIpfsId: ${JSON.stringify(ACTION_CID)},
      chainId: ${JSON.stringify(CHAIN_ID)},
    });
    const delegationCanonical = sv.canonicalize(delegation);

    window.__RESULT__ = { storedOk, sessionPublicKey, delegation, delegationCanonical };
    out.textContent = 'delegation built';
  } catch (e) {
    window.__RESULT__ = { error: String(e && e.stack || e) };
    out.textContent = 'ERROR: ' + e;
  }
})();
</script>
</body></html>`;
}

/**
 * Starts a tiny localhost HTTP server that serves the generated HTML
 * at /, the shared client module at /secure-view-session.js. Returns
 * `{ url, close }`. Web Crypto subtle only works in a secure context;
 * `http://127.0.0.1` qualifies.
 */
function startPage(ownerAddress) {
  const html = buildHtmlFor(ownerAddress);
  const script = readFileSync(CLIENT_SCRIPT_PATH, 'utf8');
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (req.url === '/secure-view-session.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(script);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveStart({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function runEngine(name, launch) {
  const browser = await launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const pageLogs = [];
  page.on('console', (msg) => pageLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageLogs.push(`[pageerror] ${err.message}`));

  const owner = privateKeyToAccount(generatePrivateKey());
  const server = await startPage(owner.address);
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });

  // Wait for page to build delegation
  try {
    await page.waitForFunction(() => !!window.__RESULT__, { timeout: 15_000 });
  } catch (e) {
    await browser.close();
    await server.close();
    return { engine: name, pass: false, reason: 'timeout waiting for __RESULT__', logs: pageLogs };
  }
  const first = await page.evaluate(() => window.__RESULT__);
  if (first.error) {
    await browser.close();
    await server.close();
    return { engine: name, pass: false, reason: 'client-error: ' + first.error, logs: pageLogs };
  }

  // Node-side wallet signs the canonical delegation
  const delegationSig = await owner.signMessage({ message: first.delegationCanonical });

  // Hand the sig back to the page and ask it to sign a request
  await page.evaluate(async ({ delSig, kid, actionCid }) => {
    const sv = window.PC2SecureViewSession;
    const loaded = await sv.loadSessionKey();
    const signed = await sv.signRequest(loaded, { kid, actionIpfsId: actionCid });
    window.__REQ_RESULT__ = {
      delegationSig: delSig,
      request: signed.request,
      requestCanonical: signed.requestCanonical,
      requestSig: signed.requestSig,
    };
  }, { delSig: delegationSig, kid: KID, actionCid: ACTION_CID });

  const reqResult = await page.evaluate(() => window.__REQ_RESULT__);
  await browser.close();
  await server.close();

  // Feed to server verifier
  sv._resetSessionCaches();
  const verify = await sv.verifySecureViewBundle(
    {
      delegation: first.delegationCanonical,
      delegationSig: reqResult.delegationSig,
      request: reqResult.requestCanonical,
      requestSig: reqResult.requestSig,
    },
    {
      expectedActionIpfsId: ACTION_CID,
      expectedChainId: CHAIN_ID,
      expectedKid: KID,
    },
  );

  return {
    engine: name,
    storedOk: first.storedOk,
    sessionPublicKey: first.sessionPublicKey,
    delegationCanonicalLen: first.delegationCanonical.length,
    requestCanonicalLen: reqResult.requestCanonical.length,
    verify,
    pass: verify.ok === true,
  };
}

async function main() {
  console.log('spike-client-server-interop — cross-engine + server conformance\n');

  const engines = [
    { name: 'chromium', launch: () => chromium.launch() },
    { name: 'firefox',  launch: () => firefox.launch()  },
    { name: 'webkit',   launch: () => webkit.launch()   },
  ];

  const results = [];
  let allPass = true;
  for (const e of engines) {
    try {
      const r = await runEngine(e.name, e.launch);
      results.push(r);
      console.log(`  ${e.name}: ${r.pass ? 'PASS' : 'FAIL'}`);
      console.log(`    storedOk         ${r.storedOk}`);
      console.log(`    pubKey bytes     ${r.sessionPublicKey?.length ? (r.sessionPublicKey.length - 2) / 2 : '-'}`);
      console.log(`    del canon bytes  ${r.delegationCanonicalLen}`);
      console.log(`    req canon bytes  ${r.requestCanonicalLen}`);
      console.log(`    server verify    ${r.verify?.ok} ${r.verify?.error || ''}`);
      console.log('');
      if (!r.pass) allPass = false;
    } catch (err) {
      console.log(`  ${e.name}: FAIL (launch error: ${err.message})\n`);
      results.push({ engine: e.name, pass: false, reason: 'launch: ' + err.message });
      allPass = false;
    }
  }

  for (const r of results) {
    if (!r.pass && r.logs) {
      console.log(`--- ${r.engine} page logs ---`);
      for (const l of r.logs) console.log('  ' + l);
    }
    if (!r.pass && r.reason) console.log(`--- ${r.engine} reason: ${r.reason}`);
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const artefactPath = join(RESULTS_DIR, `interop-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    artefactPath,
    JSON.stringify(
      {
        schema: 'spike-client-server-interop@v1',
        finishedAt: new Date().toISOString(),
        engines: results,
        allPass,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Artefact: ${artefactPath}`);

  if (allPass) {
    console.log('\nVerdict: PASS. Client (all engines) ↔ server canonical JSON + signatures agree.');
    process.exit(0);
  }
  console.log('\nVerdict: FAIL.');
  process.exit(1);
}

main().catch((err) => {
  console.error('spike-client-server-interop fatal:', err);
  process.exit(1);
});
