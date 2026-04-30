#!/usr/bin/env node
/**
 * reconcile-elacity-pins.mjs
 *
 * One-shot reconciliation: ensure a set of CIDs are durably pinned on
 * ipfs.ela.city's Kubo daemon.
 *
 * Background: before 2026-04-29 the nginx `proxy_read_timeout` on
 * ipfs.ela.city's `/api/v0/pin/add` location was 120s, so large-DAG pin
 * requests returned 504 *without* Kubo committing the pin. Content minted
 * before the fix may therefore be reachable only from the minter's PC2 node
 * (transiently, via Kubo's block cache that will GC). This script re-pins a
 * given list of CIDs, exploiting the fact that `pin/add` is idempotent
 * (Kubo returns 200 in milliseconds if the pin already exists).
 *
 * This is NOT a scheduled job — the pc2-node client-side forward
 * (storage.ts:forwardPinToElacityKubo) now does the right thing on every new
 * upload/pin. Use this script once, to reconcile the historical backlog.
 *
 * Input (one of):
 *   --file <path>   Newline-delimited CID list (one CID per line, blank/'#' ok)
 *   stdin           Same format, piped
 *
 * Environment (required):
 *   ELACITY_PIN_FORWARD_URL     e.g. https://ipfs.ela.city
 *   ELACITY_PIN_FORWARD_TOKEN   Bearer token matching nginx config
 *
 * Options:
 *   --dry-run          Print plan; no network calls
 *   --rate <n>         Requests per second (default: 1). Nginx default
 *                      burst on this endpoint is 10, so stay well under.
 *   --timeout <ms>     Per-request timeout (default: 1800000 = 30 min)
 *   --json             Machine-readable JSON output on stdout
 *   --help             Show this usage
 *
 * Examples:
 *   # One-off reconcile from a curated list
 *   node scripts/reconcile-elacity-pins.mjs --file /tmp/cids.txt
 *
 *   # Feed every IPFS-backed file from a pc2-node DB through reconcile
 *   sqlite3 /path/to/pc2.db \\
 *     "SELECT DISTINCT ipfs_hash FROM files WHERE ipfs_hash IS NOT NULL" \\
 *     | node scripts/reconcile-elacity-pins.mjs --json > /tmp/report.json
 *
 *   # Dry-run to sanity-check the list before hitting the network
 *   node scripts/reconcile-elacity-pins.mjs --file /tmp/cids.txt --dry-run
 *
 * Exit codes:
 *   0  Every CID returned 2xx
 *   1  At least one CID failed
 *   2  Configuration error
 */
import { readFileSync } from 'node:fs';

const CID_RE = /^(bafy|bafk|Qm)[0-9a-zA-Z]{10,}$/;
const DEFAULT_RATE_PER_SEC = 1;
const DEFAULT_TIMEOUT_MS = 1_800_000;

function usage() {
  const name = 'reconcile-elacity-pins.mjs';
  process.stderr.write(
    `Usage:
  node scripts/${name} --file <cids.txt>
  cat cids.txt | node scripts/${name}

Environment (required):
  ELACITY_PIN_FORWARD_URL      e.g. https://ipfs.ela.city
  ELACITY_PIN_FORWARD_TOKEN    bearer token

Options:
  --file <path>    Read CIDs from file (newline-delimited)
  --dry-run        No network calls; print plan and exit
  --rate <n>       Requests per second (default: ${DEFAULT_RATE_PER_SEC})
  --timeout <ms>   Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --json           Machine-readable JSON report on stdout
  --help           Show this help
`,
  );
}

function parseArgs(argv) {
  const args = {
    file: null,
    dryRun: false,
    rate: DEFAULT_RATE_PER_SEC,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--rate') args.rate = Number(argv[++i]);
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') {
      usage();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      usage();
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    process.stderr.write(`ERROR: --rate must be a positive number, got ${args.rate}\n`);
    process.exit(2);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    process.stderr.write(`ERROR: --timeout must be a positive integer ms, got ${args.timeoutMs}\n`);
    process.exit(2);
  }
  return args;
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function parseCidList(text) {
  const seen = new Set();
  const cids = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    cids.push(line);
  }
  return cids;
}

async function pinOne(url, token, cid, timeoutMs) {
  const target = `${url}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`;
  const start = Date.now();
  try {
    const resp = await fetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - start;
    return {
      cid,
      ok: resp.ok,
      status: resp.status,
      durationMs,
      error: resp.ok ? null : `status=${resp.status}`,
    };
  } catch (err) {
    return {
      cid,
      ok: false,
      status: 'error',
      durationMs: Date.now() - start,
      error: err?.message || 'unknown',
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rawUrl = (process.env.ELACITY_PIN_FORWARD_URL || '').trim();
  const token = (process.env.ELACITY_PIN_FORWARD_TOKEN || '').trim();
  if (!rawUrl || !token) {
    process.stderr.write(
      'ERROR: ELACITY_PIN_FORWARD_URL and ELACITY_PIN_FORWARD_TOKEN must be set.\n' +
        'Hint: source ~/.pc2-secrets/elacity-pin.env before running.\n',
    );
    process.exit(2);
  }
  if (!/^https?:\/\//.test(rawUrl)) {
    process.stderr.write(`ERROR: ELACITY_PIN_FORWARD_URL must be http(s)://..., got ${rawUrl}\n`);
    process.exit(2);
  }
  const url = rawUrl.replace(/\/+$/, '');

  const input = args.file ? readFileSync(args.file, 'utf8') : await readStdin();
  const parsed = parseCidList(input);
  if (parsed.length === 0) {
    process.stderr.write('ERROR: no CIDs found in input\n');
    process.exit(2);
  }

  const valid = [];
  const invalid = [];
  for (const c of parsed) (CID_RE.test(c) ? valid : invalid).push(c);
  if (invalid.length > 0) {
    process.stderr.write(
      `WARNING: ${invalid.length} line(s) do not look like CIDs and will be skipped:\n`,
    );
    invalid.slice(0, 5).forEach((c) => process.stderr.write(`  ${c}\n`));
    if (invalid.length > 5) process.stderr.write(`  ... and ${invalid.length - 5} more\n`);
  }

  if (args.dryRun) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          { dryRun: true, target: url, total: valid.length, cids: valid, invalid },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`[dry-run] target=${url}  cids=${valid.length}\n`);
      valid.slice(0, 10).forEach((c) => process.stderr.write(`  ${c}\n`));
      if (valid.length > 10) process.stderr.write(`  ... ${valid.length - 10} more\n`);
    }
    process.exit(0);
  }

  const spacingMs = 1000 / args.rate;
  const results = [];
  let failed = 0;

  process.stderr.write(
    `Reconciling ${valid.length} CIDs against ${url} (rate=${args.rate}/s, timeout=${args.timeoutMs}ms)\n`,
  );

  for (let i = 0; i < valid.length; i++) {
    const cid = valid[i];
    const r = await pinOne(url, token, cid, args.timeoutMs);
    results.push(r);
    if (!r.ok) failed++;
    if (!args.json) {
      const tag = r.ok ? 'OK  ' : `FAIL(${r.error})`;
      process.stderr.write(
        `  [${String(i + 1).padStart(4)}/${valid.length}] ${cid}  ${tag}  (${r.durationMs}ms)\n`,
      );
    }
    if (i < valid.length - 1) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }

  const okCount = results.length - failed;
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          target: url,
          total: results.length,
          ok: okCount,
          failed,
          invalidInput: invalid,
          results,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(`\nDone: ${okCount}/${results.length} ok, ${failed} failed\n`);
    if (failed > 0) {
      process.stderr.write('\nFailures:\n');
      results
        .filter((r) => !r.ok)
        .forEach((r) => process.stderr.write(`  ${r.cid}  ${r.error}\n`));
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
