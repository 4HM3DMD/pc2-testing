#!/usr/bin/env node
/*
 * make-test-capsule.mjs — minimal dev signing utility for hybrid capsules.
 *
 * Dev-phase only — the operator deferred production CI/release
 * infrastructure (HSM key storage, GitHub Actions workflow, multi-sig
 * revocation root, schema validator pipeline) until the platform is
 * proven prod-ready. This script is the smallest thing that lets us
 * exercise the install flow end-to-end during development.
 *
 * What it does:
 *
 *   1. Reads a capsule source directory (an `app/` + `backend/` +
 *      `app.json` template).
 *   2. Bundles `app/` and `backend/` into a tar.gz buffer.
 *   3. Generates an Ed25519 keypair (or reuses one passed via
 *      $PC2_DEV_KEY_PATH) — KEYPAIR IS DEV-ONLY, never share with
 *      production.
 *   4. Computes the manifest digest, signs it.
 *   5. Computes the bundle CID (or a placeholder — we don't actually
 *      pin to IPFS in dev).
 *   6. Writes the signed bundle + the publisher pubkey hex.
 *
 * Usage:
 *   node scripts/make-test-capsule.mjs <source-dir> <out-dir>
 *
 * Output:
 *   <out-dir>/<name>-<version>.tar.gz   — bundle to install
 *   <out-dir>/<name>-<version>.json     — signed manifest
 *   <out-dir>/publisher-pubkey.hex      — the trusted-key value PC2
 *                                         needs for verifyManifestSignature
 *
 * Limits intentionally:
 *   - No CID upload to IPFS — dev install path uses a local file
 *   - No revocation registration — there's no revocation list in dev
 *   - No multi-arch handling for `assets[]` — declare what your test needs
 *   - No schema validator — the install path validates on load anyway
 */

'use strict';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'crypto';
import * as tar from 'tar';
import nacl from 'tweetnacl';

import { signManifest } from '../src/services/CapsuleSignature.js';

async function main() {
    const [sourceDir, outDir] = process.argv.slice(2);
    if (!sourceDir || !outDir) {
        console.error('Usage: node scripts/make-test-capsule.mjs <source-dir> <out-dir>');
        console.error('  source-dir: must contain `app/`, `backend/`, and `app.json`');
        console.error('  out-dir:    where to write the bundle + signed manifest + pubkey');
        process.exit(1);
    }

    const src = resolve(sourceDir);
    const out = resolve(outDir);

    // Validate source layout
    for (const required of ['app', 'backend', 'app.json']) {
        if (!existsSync(join(src, required))) {
            console.error(`source-dir is missing "${required}"`);
            process.exit(2);
        }
    }
    if (!existsSync(out)) mkdirSync(out, { recursive: true });

    // Load + sanity-check the manifest
    const manifest = JSON.parse(readFileSync(join(src, 'app.json'), 'utf8'));
    if (manifest.kind !== 'hybrid') {
        console.error(`manifest must declare kind: "hybrid"; got "${manifest.kind}"`);
        process.exit(3);
    }

    // Resolve or generate the dev keypair
    const keypairBundle = resolveDevKeypair();

    // Build the tarball
    console.error(`[1/4] Bundling ${src} → tar.gz`);
    const chunks = [];
    await pipeline(
        tar.c({ gzip: true, cwd: src }, ['app', 'backend']),
        new Writable({ write(c, _, cb) { chunks.push(c); cb(); } }),
    );
    const bundleBuffer = Buffer.concat(chunks);
    console.error(`        ${bundleBuffer.length} bytes`);

    // Compute the bundle's CID surrogate. Real CIDs come from IPFS; for
    // dev, sha256 the bundle and prefix with "bafy" so it passes the
    // CID regex in the manifest schema. The manifest commits to it via
    // signature — a real install would still verify it against IPFS.
    const bundleSha = createHash('sha256').update(bundleBuffer).digest('hex');
    const surrogateCid = 'bafy' + bundleSha.slice(0, 50);
    console.error(`[2/4] Surrogate CID: ${surrogateCid} (sha256 of bundle bytes)`);

    // Pre-fill distribution fields, then sign
    if (!manifest.distribution) manifest.distribution = {};
    manifest.distribution.cid = surrogateCid;
    manifest.distribution.manifestDigest = '';
    manifest.distribution.signature = '';
    manifest.distribution.signedBy = '';

    console.error(`[3/4] Signing manifest with dev key`);
    const sig = signManifest(manifest, keypairBundle.secretKey);
    manifest.distribution.manifestDigest = sig.manifestDigest;
    manifest.distribution.signature = sig.signature;
    manifest.distribution.signedBy = sig.signedBy;

    // Write outputs
    const baseName = `${manifest.name}-${manifest.version}`;
    const bundlePath = join(out, `${baseName}.tar.gz`);
    const manifestPath = join(out, `${baseName}.json`);
    const pubkeyPath = join(out, 'publisher-pubkey.hex');

    writeFileSync(bundlePath, bundleBuffer, { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(pubkeyPath, sig.signedBy + '\n', { mode: 0o600 });

    console.error(`[4/4] Wrote:`);
    console.error(`        ${bundlePath}`);
    console.error(`        ${manifestPath}`);
    console.error(`        ${pubkeyPath}`);
    console.error('');
    console.error(`Trust the publisher in PC2:`);
    console.error(`  publisherKey = '${sig.signedBy}'`);
    console.error('');
    console.error(`Note: this is a DEV key. Never use for production capsules.`);
}

function resolveDevKeypair() {
    const keyPath = process.env.PC2_DEV_KEY_PATH;
    if (keyPath && existsSync(keyPath)) {
        const seed = JSON.parse(readFileSync(keyPath, 'utf8'));
        if (!Array.isArray(seed) || seed.length !== 32) {
            throw new Error(`PC2_DEV_KEY_PATH file must be a JSON array of 32 bytes`);
        }
        return nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
    }
    const kp = nacl.sign.keyPair();
    if (keyPath) {
        // Persist the seed so subsequent runs reuse the same key
        // — useful when the trusted-set in PC2 is set once at boot.
        // Seed = first 32 bytes of secretKey (Ed25519 convention).
        const seed = Array.from(kp.secretKey.slice(0, 32));
        mkdirSync(join(keyPath, '..'), { recursive: true });
        writeFileSync(keyPath, JSON.stringify(seed), { mode: 0o600 });
        console.error(`(saved fresh dev key to ${keyPath} — set PC2_DEV_KEY_PATH to reuse)`);
    }
    return kp;
}

main().catch((err) => {
    console.error(`make-test-capsule failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
