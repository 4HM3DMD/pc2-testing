#!/usr/bin/env node
/**
 * One-shot extractor: read the 6 v1.2 capsule tarballs out of PC2's local
 * Helia blockstore and dump them to /tmp/pc2-capsules/. Used by the supernode
 * pinning step (deploy/app-registry/scripts/install-pinning.sh) — we scp these
 * tarballs to InterServer + Contabo and `ipfs add --pin` them locally on each
 * supernode's kubo daemon, since neither public IPFS gateways nor the existing
 * libp2p relay reliably resolve fresh CIDs across machines yet.
 *
 * This script is read-only against the blockstore and safe to run while
 * pc2-node is live — FsBlockstore is a flat-file store, multiple readers OK.
 */
import { FsBlockstore } from 'blockstore-fs';
import { CID } from 'multiformats/cid';
import { exporter } from 'ipfs-unixfs-exporter';
import * as dagPb from '@ipld/dag-pb';
import { CarWriter } from '@ipld/car';
import { writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PATH = resolve(__dirname, '..', 'data', 'ipfs');
const BLOCKS_PATH = join(REPO_PATH, 'blocks');
const OUT_DIR = '/tmp/pc2-capsules';

const CAPSULES = [
  { name: 'ddrm-viewer-0.1.0.tar.gz',     cid: 'bafkreicswjb7mvwdgauwd6dhw7ryirndxfraocjo2avn53vfs24oo7jeua' },
  { name: 'elacity-creator-0.1.0.tar.gz', cid: 'bafybeidhttd3uozgo3odpcvs3hvmrsbo2pgrbce6srum65y5qfzzvzztxy' },
  { name: 'elacity-market-0.2.0.tar.gz',  cid: 'bafybeiczcdan4j7zfw2ychjgzco4y4lbb5mqceezxfl5h7f3koau7t6x5y' },
  { name: 'elacity-player-0.2.0.tar.gz',  cid: 'bafybeifbgkjmgnwvddgntdihvssvyncj5xml2ft6qi3dr3hellgf7wgxbi' },
  { name: 'elastos-nft-0.1.0.tar.gz',     cid: 'bafybeich5bmanb3nx65scjcv3rp3wjcge4np6von6ybwrp7xsob7llczdy' },
  { name: 'glide-finance-1.0.0.tar.gz',   cid: 'bafybeib6jbeosgudsbilc2bhlkbycnhuvdxwc5zfp22dmbsniknxddwvzq' },
];

async function exportOne(blockstore, capsule) {
  const cidObj = CID.parse(capsule.cid);
  const entry = await exporter(cidObj, blockstore);
  if (!entry || (entry.type !== 'file' && entry.type !== 'raw')) {
    throw new Error(`CID ${capsule.cid} resolved to ${entry?.type || 'nothing'}, expected file/raw`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of entry.content()) {
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  const buf = Buffer.concat(chunks, bytes);
  const out = join(OUT_DIR, capsule.name);
  await writeFile(out, buf);
  return { out, bytes };
}

/**
 * Walk a DAG starting at `cid` and yield every block (cid + bytes) reachable
 * from it. Handles both `raw` codec (single block, no links) and `dag-pb`
 * (UnixFS chunked file, has children). Used to assemble a CAR file that
 * preserves every block CID byte-identically.
 */
/**
 * blockstore-fs@3.x returns an AsyncGenerator of Buffer chunks from .get(),
 * not a single Uint8Array. Concatenate into one fresh Uint8Array (CarWriter's
 * strict instanceof check rejects Buffer objects from a sibling module realm).
 */
async function getBlockBytes(blockstore, cidObj) {
  const chunks = [];
  let total = 0;
  for await (const chunk of blockstore.get(cidObj)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c.buffer, c.byteOffset, c.byteLength), off);
    off += c.byteLength;
  }
  return out;
}

async function* walkDag(blockstore, cid) {
  const cidObj = CID.asCID(typeof cid === 'string' ? CID.parse(cid) : cid);
  const bytes = await getBlockBytes(blockstore, cidObj);
  yield { cid: cidObj, bytes };

  // raw codec (0x55) → no links to follow
  if (cidObj.code === 0x55) return;

  // dag-pb codec (0x70) → decode and walk Links
  if (cidObj.code === 0x70) {
    const node = dagPb.decode(bytes);
    for (const link of node.Links) {
      yield* walkDag(blockstore, link.Hash);
    }
    return;
  }

  throw new Error(`Unknown CID codec 0x${cidObj.code.toString(16)} for ${cidObj.toString()} — cannot walk`);
}

/**
 * Bundle every block of every requested CID into one CAR file. The supernode
 * then runs `ipfs dag import bundle.car` which restores all blocks with their
 * original CIDs, followed by `ipfs pin add <rootCID>` for each root.
 */
async function writeBundleCar(blockstore, capsules, outPath) {
  const roots = capsules.map((c) => CID.parse(c.cid));
  const { writer, out } = CarWriter.create(roots);

  // Pump CAR bytes to disk in parallel with putting blocks in.
  const writePromise = pipeline(Readable.from(out), createWriteStream(outPath));

  let totalBlocks = 0;
  let totalBytes = 0;
  const seen = new Set(); // dedupe shared blocks across capsules

  for (const cap of capsules) {
    let blocksThisCapsule = 0;
    let bytesThisCapsule = 0;
    for await (const block of walkDag(blockstore, cap.cid)) {
      const key = block.cid.toString();
      if (!seen.has(key)) {
        await writer.put(block);
        seen.add(key);
      }
      blocksThisCapsule++;
      bytesThisCapsule += block.bytes.byteLength;
    }
    totalBlocks += blocksThisCapsule;
    totalBytes += bytesThisCapsule;
    console.log(`  ✓ ${cap.name.padEnd(34)}  ${blocksThisCapsule} blocks, ${(bytesThisCapsule / 1024 / 1024).toFixed(2)} MB`);
  }

  await writer.close();
  await writePromise;
  console.log(`[extract] CAR: ${totalBlocks} block-walks (${seen.size} unique), ${(totalBytes / 1024 / 1024).toFixed(2)} MB raw  →  ${outPath}`);
}

async function main() {
  console.log(`[extract] blockstore: ${BLOCKS_PATH}`);
  console.log(`[extract] output:     ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });
  const blockstore = new FsBlockstore(BLOCKS_PATH);
  await blockstore.open();
  try {
    // 1. Per-CID assembled .tar.gz files (still useful for sanity / curl tests)
    console.log('\n[extract] writing per-capsule .tar.gz files...');
    for (const cap of CAPSULES) {
      try {
        const { out, bytes } = await exportOne(blockstore, cap);
        console.log(`  ✓ ${cap.name}  (${(bytes / 1024 / 1024).toFixed(2)} MB)  →  ${out}`);
      } catch (err) {
        console.error(`  ✗ ${cap.name}  (${cap.cid})  →  ${err.message}`);
      }
    }

    // 2. Single CAR file with all 6 DAGs — primary delivery mechanism for kubo
    console.log('\n[extract] writing combined CAR file (all 6 DAGs, byte-identical CIDs)...');
    const carPath = join(OUT_DIR, 'pc2-v1.2-bundles.car');
    await writeBundleCar(blockstore, CAPSULES, carPath);
  } finally {
    await blockstore.close();
  }
  console.log('\n[extract] done.');
}

main().catch((err) => {
  console.error('[extract] fatal:', err);
  process.exit(1);
});
