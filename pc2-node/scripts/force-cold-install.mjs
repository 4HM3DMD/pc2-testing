#!/usr/bin/env node
/**
 * force-cold-install.mjs
 *
 * Targeted cold-install test helper for v1.2 pre-release validation.
 *
 * Walks the UnixFS DAG for one or more CIDs, then moves every block in
 * those DAGs (and only those blocks) out of the Helia blockstore into a
 * sibling `data/ipfs/blocks.trash/<timestamp>/` directory. This simulates
 * a PC2 node that has never seen those CIDs before, so the next install
 * via the dApp Centre exercises the real
 * `pinRemoteCID → bitswap → gateway` network-fetch path added in
 * DAPP-INSTALL-NETWORK-FETCH.
 *
 *   Usage (from pc2-node/):
 *     node scripts/force-cold-install.mjs              # defaults: glide + nft
 *     node scripts/force-cold-install.mjs <cid> ...    # explicit CIDs
 *
 * Safety:
 *   - Blocks are MOVED, not deleted. Restore by moving the shard
 *     directories under `blocks.trash/<timestamp>/` back into
 *     `data/ipfs/blocks/`.
 *   - Only blocks reachable from the given roots are touched.
 *   - Intended to be run while pc2-node is stopped (FsBlockstore has no
 *     per-block locks, so running live is mostly-safe but not bulletproof
 *     — stopping the node avoids any read/write races).
 *
 * What this script does NOT do:
 *   - It does not call the Helia pin API. Pins live in the datastore,
 *     not the blockstore; missing blocks + stale pins are benign.
 *   - It does not remove the extracted app tree at
 *     `data/installed-apps/<app>/`. Uninstall via the dApp Centre UI to
 *     remove that, otherwise this script only replays the network-fetch
 *     portion of install, not the end-to-end user flow.
 */

import { base32upper } from 'multiformats/bases/base32';
import { CID } from 'multiformats/cid';
import * as dagPB from '@ipld/dag-pb';
import * as dagCBOR from '@ipld/dag-cbor';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ─── Known v1.2 app-registry CIDs (defaults when no args given) ───────
const DEFAULT_CIDS = [
  'bafybeib6jbeosgudsbilc2bhlkbycnhuvdxwc5zfp22dmbsniknxddwvzq', // glide-finance
  'bafybeich5bmanb3nx65scjcv3rp3wjcge4np6von6ybwrp7xsob7llczdy', // elastos-nft
];

// ─── Codec IDs (CID.code) ─────────────────────────────────────────────
const CODEC_DAG_PB = 0x70;
const CODEC_DAG_CBOR = 0x71;

// ─── Resolve paths ────────────────────────────────────────────────────
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const BLOCKSTORE_ROOT = path.join(PROJECT_ROOT, 'data', 'ipfs', 'blocks');
const TRASH_ROOT = path.join(PROJECT_ROOT, 'data', 'ipfs', 'blocks.trash');

if (!existsSync(BLOCKSTORE_ROOT)) {
  console.error(`error: blockstore not found at ${BLOCKSTORE_ROOT}`);
  console.error('       run this script from pc2-node/');
  process.exit(1);
}

const args = process.argv.slice(2);
const rootCIDs = args.length > 0 ? args : DEFAULT_CIDS;

console.log('force-cold-install');
console.log(`  blockstore : ${BLOCKSTORE_ROOT}`);
console.log(`  trash      : ${TRASH_ROOT}`);
console.log(`  roots      : ${rootCIDs.length}`);
for (const c of rootCIDs) console.log(`               - ${c}`);
console.log('');

// ─── Helia/blockstore-fs key derivation (matches NextToLast sharding) ─
//
// From blockstore-fs src/sharding.js:
//   encode(cid) {
//     const str = base32upper.encoder.encode(cid.multihash.bytes);
//     const prefix = str.substring(str.length - 2);
//     return { dir: prefix, file: `${str}.data` };
//   }
//
// i.e. the filename is the CID's multihash (not the CID itself) encoded
// as base32upper, and the shard dir is the last 2 characters of that
// filename (excluding the `.data` extension).
function cidToBlockPath(cid) {
  const stem = base32upper.encoder.encode(cid.multihash.bytes);
  const shard = stem.substring(stem.length - 2);
  return {
    shard,
    file: `${stem}.data`,
    fullPath: path.join(BLOCKSTORE_ROOT, shard, `${stem}.data`),
  };
}

// ─── Walk the DAG: read each block, decode links, recurse ─────────────
async function walkDAG(rootCID, visited) {
  const queue = [rootCID];
  const reachable = [];
  let missing = 0;

  while (queue.length > 0) {
    const cid = queue.shift();
    const key = cid.toString();
    if (visited.has(key)) continue;
    visited.add(key);

    const { fullPath } = cidToBlockPath(cid);

    let bytes;
    try {
      bytes = await fs.readFile(fullPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        missing++;
        continue;
      }
      throw err;
    }

    reachable.push({ cid, fullPath });

    if (cid.code === CODEC_DAG_PB) {
      try {
        const node = dagPB.decode(bytes);
        for (const link of node.Links ?? []) {
          queue.push(link.Hash);
        }
      } catch (err) {
        console.warn(`  warn: dag-pb decode failed for ${key}: ${err.message}`);
      }
    } else if (cid.code === CODEC_DAG_CBOR) {
      try {
        const doc = dagCBOR.decode(bytes);
        const walk = (v) => {
          if (!v || typeof v !== 'object') return;
          const asCID = CID.asCID(v);
          if (asCID) { queue.push(asCID); return; }
          if (Array.isArray(v)) { v.forEach(walk); return; }
          for (const k of Object.keys(v)) walk(v[k]);
        };
        walk(doc);
      } catch (err) {
        console.warn(`  warn: dag-cbor decode failed for ${key}: ${err.message}`);
      }
    }
    // raw (0x55) and unknown codecs: no children to traverse
  }

  return { reachable, missing };
}

// ─── Execute walks ────────────────────────────────────────────────────
const visited = new Set();
const allReachable = [];
let totalMissing = 0;

for (const rootStr of rootCIDs) {
  const root = CID.parse(rootStr);
  console.log(`→ walking ${rootStr.slice(0, 18)}… (codec=0x${root.code.toString(16)})`);
  const { reachable, missing } = await walkDAG(root, visited);
  console.log(`  reachable: ${reachable.length}, missing-from-disk: ${missing}`);
  allReachable.push(...reachable);
  totalMissing += missing;
}

console.log('');
console.log(`total blocks to move: ${allReachable.length}`);
console.log(`already-missing:      ${totalMissing}`);

if (allReachable.length === 0) {
  console.log('nothing to do. already cold for these CIDs.');
  process.exit(0);
}

// ─── Move blocks into trash (preserving shard layout) ─────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const trashDir = path.join(TRASH_ROOT, ts);
await fs.mkdir(trashDir, { recursive: true });

console.log('');
console.log('moving blocks → trash…');
let moved = 0;
let vanished = 0;

for (const { cid, fullPath } of allReachable) {
  const { shard, file } = cidToBlockPath(cid);
  const targetShardDir = path.join(trashDir, shard);
  await fs.mkdir(targetShardDir, { recursive: true });
  const targetPath = path.join(targetShardDir, file);
  try {
    await fs.rename(fullPath, targetPath);
    moved++;
  } catch (err) {
    if (err.code === 'ENOENT') {
      vanished++;
    } else {
      throw err;
    }
  }
}

console.log('');
console.log('─── summary ──────────────────────────────────────────');
console.log(`roots:              ${rootCIDs.length}`);
console.log(`unique blocks:      ${allReachable.length}`);
console.log(`moved to trash:     ${moved}`);
console.log(`vanished mid-run:   ${vanished}`);
console.log(`already missing:    ${totalMissing}`);
console.log(`trash dir:          ${trashDir}`);
console.log('');
console.log('blockstore is now cold for the provided DAG roots.');
console.log('install those dApps again to exercise:');
console.log('  pinRemoteCID → bitswap → gateway-fallback → DHT end-to-end.');
console.log('');
console.log('to restore (if needed):');
console.log(`  mv ${path.join(trashDir, '*')} ${BLOCKSTORE_ROOT}/`);
