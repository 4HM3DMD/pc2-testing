/**
 * spike-webcrypto.runner.mjs — Phase 1 spike #3 runner.
 *
 * Loads scripts/spike/spike-webcrypto.html in headless Chromium, Firefox, and
 * WebKit via Playwright and collects the per-engine pass/fail matrix.
 *
 * Why this matters: wallet in-app browsers all inherit from one of these three
 * engines. MetaMask Mobile / Coinbase Wallet / Trust Wallet / Rainbow on iOS
 * use WKWebView (WebKit). Their Android counterparts use Chromium. Desktop
 * Safari is WebKit, desktop Chrome is Chromium, desktop Firefox is Firefox.
 *
 * So: if all three engines pass, the wallet matrix passes too. If WebKit
 * fails on K-256 but passes on P-256, we adopt P-256 across the board per
 * the pre-agreed fallback in DESIGN.md §5.
 *
 * Usage:
 *   node scripts/spike/spike-webcrypto.runner.mjs
 *
 * Exits 0 if all three engines pass P-256; 1 otherwise.
 */

import { chromium, firefox, webkit } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HTML_PATH = join(__dirname, 'spike-webcrypto.html');
const RESULTS_DIR = join(__dirname, '.results');

const ENGINES = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
];

async function runOne(name, browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleLines = [];
    page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

    await page.goto(pathToFileURL(HTML_PATH).toString());

    await page.waitForFunction(
      () => typeof window.__SPIKE_RESULTS__ !== 'undefined',
      null,
      { timeout: 15000 },
    );
    const results = await page.evaluate(() => window.__SPIKE_RESULTS__);
    return { engine: name, results, consoleLines };
  } finally {
    await browser.close();
  }
}

function summarise(all) {
  const header = ['engine', 'K-256', 'P-256', 'privExtractable?', 'pubExport?', 'sign?', 'verify?'];
  const rows = [header.join('\t')];
  for (const { engine, results } of all) {
    if (!results || !results.curves) {
      rows.push(`${engine}\tERROR\t-\t-\t-\t-\t-`);
      continue;
    }
    const k = results.curves['K-256'];
    const p = results.curves['P-256'];
    const CHECK = ['generateKey', 'privateKeyExtractableInvariant', 'publicKeyExport', 'sign', 'verify'];
    const allPass = (r) => CHECK.every((f) => r[f] === 'pass');
    const kStatus = allPass(k) ? 'PASS' : 'FAIL';
    const pStatus = allPass(p) ? 'PASS' : 'FAIL';
    // Show P-256 detail (the hard-required fallback)
    rows.push(
      [
        engine,
        kStatus,
        pStatus,
        p.privateKeyExtractableInvariant,
        p.publicKeyExport,
        p.sign,
        p.verify,
      ].join('\t'),
    );
  }
  return rows.join('\n');
}

async function main() {
  if (!existsSync(HTML_PATH)) {
    console.error(`spike-webcrypto.html not found at ${HTML_PATH}`);
    process.exit(1);
  }

  console.log('spike-webcrypto — running across Chromium, Firefox, WebKit');
  const all = [];
  let p256AllPass = true;
  let k256AllPass = true;

  for (const [name, type] of ENGINES) {
    try {
      const res = await runOne(name, type);
      all.push(res);
      if (!res.results || res.results.error) {
        console.error(`  ${name}: ERROR — ${res.results?.error || '(no results object)'}`);
        p256AllPass = false;
        k256AllPass = false;
        continue;
      }
      const k = res.results.curves['K-256'];
      const p = res.results.curves['P-256'];
      const CHECK = ['generateKey', 'privateKeyExtractableInvariant', 'publicKeyExport', 'sign', 'verify'];
      const allPass = (r) => CHECK.every((f) => r[f] === 'pass');
      const kOk = allPass(k);
      const pOk = allPass(p);
      if (!kOk) k256AllPass = false;
      if (!pOk) p256AllPass = false;
      console.log(
        `  ${name}: K-256=${kOk ? 'PASS' : 'FAIL'} P-256=${pOk ? 'PASS' : 'FAIL'}` +
          (k.error ? ` (K-256: ${k.error})` : '') +
          (p.error ? ` (P-256: ${p.error})` : ''),
      );
    } catch (err) {
      console.error(`  ${name}: RUNNER-ERROR — ${err.message}`);
      all.push({ engine: name, results: { error: err.message }, consoleLines: [] });
      p256AllPass = false;
      k256AllPass = false;
    }
  }

  console.log('\nMatrix:');
  console.log(summarise(all));

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const artefactPath = join(RESULTS_DIR, `webcrypto-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    artefactPath,
    JSON.stringify(
      {
        schema: 'spike-webcrypto-runner@v1',
        finishedAt: new Date().toISOString(),
        platform: { node: process.version, os: process.platform, arch: process.arch },
        engines: all,
        verdict: {
          k256AllPass,
          p256AllPass,
          chosenCurve: k256AllPass ? 'K-256' : (p256AllPass ? 'P-256' : 'NONE'),
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nArtefact: ${artefactPath}`);

  if (k256AllPass) {
    console.log('\nVerdict: K-256 passes everywhere. Use K-256 as the ephemeral curve.');
    process.exit(0);
  }
  if (p256AllPass) {
    console.log(
      '\nVerdict: K-256 failed on at least one engine but P-256 passes everywhere. ' +
        'Adopt the pre-agreed fallback: use P-256 as the ephemeral curve.',
    );
    process.exit(0);
  }
  console.log('\nVerdict: P-256 FAILED somewhere. Block Phase 2 and investigate.');
  process.exit(1);
}

main().catch((err) => {
  console.error('Top-level runner error:', err);
  process.exit(1);
});
