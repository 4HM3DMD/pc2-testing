/**
 * spike-nonextractable.mjs — additional Phase 2a invariant check.
 *
 * Proves that after storing a CryptoKey in IndexedDB and reloading
 * it, `exportKey('raw', privateKey)` still throws. Browsers MUST
 * preserve extractability across structured-clone boundaries per
 * the Web Crypto spec — we verify it empirically per engine.
 */
import { chromium, firefox, webkit } from '../../node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLIENT_SCRIPT_PATH = join(REPO_ROOT, 'pc2-node/data/test-apps/shared/secure-view-session.js');
const RESULTS_DIR = join(__dirname, '.results');

function html() {
  return `<!doctype html><html><body><pre id="out"></pre>
<script src="/secure-view-session.js"></script>
<script>
(async () => {
  const sv = window.PC2SecureViewSession;
  try {
    const { keyPair } = await sv.createEphemeralKey();
    await sv.saveSessionKey(keyPair);
    const reloaded = await sv.loadSessionKey();
    let rawExportThrew = false, pkcsExportThrew = false;
    try { await crypto.subtle.exportKey('raw', reloaded.privateKey); }
    catch { rawExportThrew = true; }
    try { await crypto.subtle.exportKey('pkcs8', reloaded.privateKey); }
    catch { pkcsExportThrew = true; }
    const extractable = reloaded.privateKey && reloaded.privateKey.extractable;
    window.__RESULT__ = { rawExportThrew, pkcsExportThrew, extractable };
  } catch (e) {
    window.__RESULT__ = { error: String(e) };
  }
})();
</script></body></html>`;
}

function startPage() {
  const body = html();
  const script = readFileSync(CLIENT_SCRIPT_PATH, 'utf8');
  return new Promise((res) => {
    const s = createServer((req, r) => {
      if (req.url === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(body); }
      else if (req.url === '/secure-view-session.js') { r.writeHead(200, { 'Content-Type': 'application/javascript' }); r.end(script); }
      else { r.writeHead(404); r.end(); }
    });
    s.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${s.address().port}/`, close: () => new Promise((rc) => s.close(() => rc())) }));
  });
}

async function runEngine(name, launch) {
  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  const server = await startPage();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__RESULT__, { timeout: 15_000 });
  const r = await page.evaluate(() => window.__RESULT__);
  await browser.close();
  await server.close();
  const pass =
    !r.error &&
    r.rawExportThrew === true &&
    r.pkcsExportThrew === true &&
    r.extractable === false;
  return { engine: name, pass, ...r };
}

async function main() {
  console.log('spike-nonextractable — IndexedDB-reloaded CryptoKey invariant\n');
  const engines = [
    { name: 'chromium', launch: () => chromium.launch() },
    { name: 'firefox',  launch: () => firefox.launch()  },
    { name: 'webkit',   launch: () => webkit.launch()   },
  ];
  const out = [];
  let allPass = true;
  for (const e of engines) {
    const r = await runEngine(e.name, e.launch);
    out.push(r);
    console.log(`  ${e.name}: ${r.pass ? 'PASS' : 'FAIL'}  (raw threw=${r.rawExportThrew}, pkcs8 threw=${r.pkcsExportThrew}, extractable=${r.extractable})`);
    if (!r.pass) allPass = false;
  }
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `nonextractable-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ engines: out, allPass }, null, 2),
  );
  console.log('\nVerdict:', allPass ? 'PASS' : 'FAIL');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
