#!/usr/bin/env node
/**
 * Merge pc2-node/registry/v1.2/_index.json into deploy/app-registry/registry.json
 *
 * Why: A2 (`pc2-node/registry/v1.2/`) produces signed registry entries for the
 * 6 v1.2 apps with real CIDs, signatures, and signedBy. This script splices
 * those into the supernode's registry.json, replacing any same-name entries
 * (e.g., the old elacity-market / elacity-player placeholders that lacked
 * CIDs) and appending the new ones (elacity-creator, ddrm-viewer, elastos-nft,
 * glide-finance).
 *
 * Behaviour:
 *   - For each app in _index.json:
 *     * If an entry with the same name exists in registry.json, REPLACE its
 *       manifest fields (preserving the curated `registry` UI metadata block
 *       — gradient, badges, staffPick, etc.).
 *     * Otherwise, APPEND it. Generate a sensible default `registry` block.
 *   - All other existing entries are preserved verbatim (the 9 coming_soon
 *     placeholders + supernode-manager).
 *   - Output bumps `version` (1 -> 2) and refreshes `updatedAt` to now.
 *   - Idempotent: re-running with the same _index.json is a no-op aside from
 *     the timestamp bump (which we suppress when --no-bump is passed, for
 *     deterministic CI runs).
 *
 * Usage:
 *   node deploy/app-registry/scripts/sync-from-pc2.mjs            # merge + write
 *   node deploy/app-registry/scripts/sync-from-pc2.mjs --dry-run  # print diff, don't write
 *   node deploy/app-registry/scripts/sync-from-pc2.mjs --no-bump  # skip updatedAt bump
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// deploy/app-registry/scripts/ -> repoRoot = ../../..
const REPO_ROOT     = resolve(__dirname, '..', '..', '..');
const PC2_INDEX     = resolve(REPO_ROOT, 'pc2-node', 'registry', 'v1.2', '_index.json');
const REGISTRY_FILE = resolve(REPO_ROOT, 'deploy', 'app-registry', 'registry.json');

const DRY_RUN = process.argv.includes('--dry-run');
const NO_BUMP = process.argv.includes('--no-bump');

// Sensible default `registry` UI-metadata block for newly-introduced apps.
// The supernode itself doesn't read these; they're consumed by the dApp
// Centre to render badges / featured / gradient. Tweak in the file later
// if the launch design wants different ordering / accent colours.
const DEFAULTS_BY_NAME = {
  'elacity-creator': {
    status: 'available',
    category: 'media',
    badges: ['ddrm', 'creator'],
    staffPick: true,
    popular: true,
    featured: true,
    gradient: 'gradient-pink',
    website: 'https://ela.city',
    compatibility: 'PC2 1.2+',
  },
  'ddrm-viewer': {
    status: 'available',
    category: 'utilities',
    badges: ['ddrm'],
    staffPick: false,
    popular: false,
    featured: false,
    gradient: 'gradient-blue',
    website: 'https://ela.city',
    compatibility: 'PC2 1.2+',
  },
  'elastos-nft': {
    status: 'available',
    category: 'marketplace',
    badges: ['nft'],
    staffPick: true,
    popular: true,
    featured: true,
    gradient: 'gradient-emerald',
    website: 'https://ela.city',
    compatibility: 'PC2 1.2+',
  },
  'glide-finance': {
    status: 'available',
    category: 'defi',
    badges: ['defi'],
    staffPick: true,
    popular: true,
    featured: true,
    gradient: 'gradient-amber',
    website: 'https://glidefinance.io',
    compatibility: 'PC2 1.2+',
  },
};

function defaultRegistryBlock(name, manifest) {
  if (DEFAULTS_BY_NAME[name]) return DEFAULTS_BY_NAME[name];

  // Last-resort fallback so any future packaged app at least renders.
  return {
    status: 'available',
    category: manifest.category || 'utilities',
    badges: [],
    staffPick: false,
    popular: false,
    featured: false,
    gradient: 'gradient-blue',
    website: manifest.author?.url || 'https://ela.city',
    compatibility: 'PC2 1.2+',
  };
}

function loadJson(path) {
  if (!existsSync(path)) {
    console.error(`ERROR: ${path} not found`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildEntry(newManifest, existing) {
  // Strip the iconDataUrl from the supernode entry — it's 50-100 KB of base64
  // per app (favicons inlined by the packager) and bloats the catalog payload
  // way beyond what's needed for the dApp Centre. The Centre falls back to
  // the `icon` string + a hardcoded SVG palette when no iconDataUrl is set.
  // Keeping iconDataUrl in the *bundle* is fine; we just don't ship it in
  // the discovery JSON.
  // eslint-disable-next-line no-unused-vars
  const { iconDataUrl, ...manifestWithoutIcon } = newManifest;

  return {
    ...manifestWithoutIcon,
    // If an existing curated icon string was set, prefer it (e.g., "marketplace"
    // -> renders the marketplace SVG icon). Otherwise the manifest's icon
    // filename is OK as a fallback.
    icon: existing?.icon || manifestWithoutIcon.icon,
    // Same for top-level `category` — manifest has it, but the existing entry
    // might have a more curated value (e.g., elacity-market manifest says
    // "marketplace" but supernode entry also says "marketplace"; collisions
    // are fine).
    category: existing?.category || manifestWithoutIcon.category,
    // Preserve curated UI metadata if present, else generate sensible defaults.
    registry: existing?.registry || defaultRegistryBlock(manifestWithoutIcon.name, manifestWithoutIcon),
  };
}

function main() {
  const pc2     = loadJson(PC2_INDEX);
  const current = loadJson(REGISTRY_FILE);

  if (!Array.isArray(pc2.apps) || pc2.apps.length === 0) {
    console.error('ERROR: pc2-node/registry/v1.2/_index.json has no apps[]');
    process.exit(2);
  }

  const incomingByName = new Map(pc2.apps.map(a => [a.name, a]));
  const existingByName = new Map(current.apps.map(a => [a.name, a]));

  // 1. Replace existing entries that have a v1.2 signed counterpart.
  // 2. Keep all other existing entries verbatim (preserve order).
  const merged = current.apps.map(existing => {
    const incoming = incomingByName.get(existing.name);
    if (!incoming) return existing;
    incomingByName.delete(existing.name);
    return buildEntry(incoming, existing);
  });

  // 3. Append v1.2 entries that didn't exist before.
  for (const incoming of incomingByName.values()) {
    merged.push(buildEntry(incoming, null));
  }

  const out = {
    version: NO_BUMP ? current.version : Math.max(current.version, 2),
    updatedAt: NO_BUMP ? current.updatedAt : new Date().toISOString(),
    publisher: pc2.publisher,
    apps: merged,
  };

  console.log('=== sync summary ===');
  console.log(`  before: ${current.apps.length} apps`);
  console.log(`  after:  ${merged.length} apps`);
  console.log(`  v1.2 signed entries: ${pc2.apps.length}`);
  console.log('');
  console.log('Per-app result:');
  for (const a of pc2.apps) {
    const wasReplacement = existingByName.has(a.name);
    const tag = wasReplacement ? '[REPLACE]' : '[NEW]    ';
    console.log(`  ${tag} ${a.name.padEnd(20)} ${a.version.padEnd(8)} cid=${a.distribution.cid}`);
  }

  if (DRY_RUN) {
    console.log('');
    console.log('--dry-run: not writing.');
    return;
  }

  writeFileSync(REGISTRY_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log('');
  console.log(`wrote ${REGISTRY_FILE}`);
  console.log(`  version:   ${out.version}`);
  console.log(`  updatedAt: ${out.updatedAt}`);
  console.log(`  publisher: ${out.publisher?.publicKey || '<none>'}`);
}

main();
