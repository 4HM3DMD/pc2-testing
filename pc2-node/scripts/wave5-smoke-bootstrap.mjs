#!/usr/bin/env node
/**
 * wave5-smoke-bootstrap.mjs — RG3 helper.
 *
 * The wave5 smoke suite needs two API keys: one for the owner wallet (to
 * exercise the positive paths) and one for a non-owner wallet (to confirm
 * requireOwner denies it). Provisioning these via the GUI requires signing
 * in twice with two different MetaMask accounts — annoying for a smoke
 * pass. This helper sidesteps that by inserting two ephemeral keys
 * directly into the SQLite db using the same hash format the apikeys.ts
 * createApiKey path uses.
 *
 * Both keys are tagged with name="wave5-smoke-temp" so --revoke can find
 * them after the smoke completes.
 *
 * Safe to run: this only writes to data/pc2.db on the local box. The
 * raw key values are never persisted to disk by this script — they're
 * printed once to stdout (just like the production /api/keys endpoint
 * does) and then forgotten.
 *
 * Usage:
 *   node scripts/wave5-smoke-bootstrap.mjs           # provision + print env exports
 *   node scripts/wave5-smoke-bootstrap.mjs --revoke  # delete the temp keys
 */

import { DatabaseSync, enhance } from '@photostructure/sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DB_PATH   = join(REPO_ROOT, 'data', 'pc2.db');
const NAME_TAG  = 'wave5-smoke-temp';

function loadOwnerWallet() {
    const nodeConfigPath = join(REPO_ROOT, 'data', 'node-config.json');
    if (!existsSync(nodeConfigPath)) {
        throw new Error(`node-config.json not found at ${nodeConfigPath} — is this a fresh install?`);
    }
    const cfg = JSON.parse(readFileSync(nodeConfigPath, 'utf-8'));
    if (!cfg.ownerWallet) throw new Error('ownerWallet is not set in node-config.json');
    return { owner: cfg.ownerWallet, allowed: cfg.allowedWallets || [] };
}

function pickTetheredWallet(allowedWallets) {
    const evm = allowedWallets.find((w) => /^0x[0-9a-f]{40}$/i.test(w.wallet));
    if (!evm) throw new Error('No EVM allowedWallets entry found — add one in node-config.json');
    return evm.wallet.toLowerCase();
}

function hashApiKey(key) {
    return createHash('sha256').update(key).digest('hex');
}

function generateRawKey() {
    return `pc2_${randomBytes(32).toString('hex')}`;
}

function ensureUserRow(db, walletAddress) {
    const exists = db.prepare('SELECT 1 FROM users WHERE wallet_address = ?').get(walletAddress);
    if (exists) return;
    db.prepare('INSERT INTO users (wallet_address, created_at) VALUES (?, ?)')
        .run(walletAddress, Date.now());
}

function provision({ owner, tethered }) {
    if (!existsSync(DB_PATH)) throw new Error(`DB not found at ${DB_PATH}`);
    const db = enhance(new DatabaseSync(DB_PATH));

    ensureUserRow(db, owner);
    ensureUserRow(db, tethered);

    const ownerKey    = generateRawKey();
    const tetheredKey = generateRawKey();
    const now = Date.now();

    const insert = db.prepare(`
        INSERT INTO api_keys (key_id, key_hash, wallet_address, name, scopes, created_at, expires_at, last_used_at, revoked)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0)
    `);

    insert.run(randomUUID(), hashApiKey(ownerKey),    owner,    NAME_TAG, 'admin', now);
    insert.run(randomUUID(), hashApiKey(tetheredKey), tethered, NAME_TAG, 'read',  now);

    db.close();

    console.log('# Wave 5 smoke — ephemeral API keys provisioned');
    console.log('# (run `node scripts/wave5-smoke-bootstrap.mjs --revoke` after the smoke pass)');
    console.log('');
    console.log('export BASE_URL="http://localhost:4200"');
    console.log(`export OWNER_KEY="${ownerKey}"`);
    console.log(`export TETHERED_KEY="${tetheredKey}"`);
    console.log(`export OWNER_WALLET="${owner}"`);
    console.log(`export FOREIGN_WALLET="${tethered}"`);
    console.log('');
    console.log('bash pc2-node/scripts/wave5-smoke.sh');
}

function revoke() {
    if (!existsSync(DB_PATH)) throw new Error(`DB not found at ${DB_PATH}`);
    const db = enhance(new DatabaseSync(DB_PATH));
    const result = db.prepare('DELETE FROM api_keys WHERE name = ?').run(NAME_TAG);
    db.close();
    console.log(`Revoked ${result.changes} ephemeral wave5-smoke key(s).`);
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--revoke')) {
        revoke();
        return;
    }
    const { owner, allowed } = loadOwnerWallet();
    const tethered = pickTetheredWallet(allowed);
    provision({ owner: owner.toLowerCase(), tethered });
}

try {
    main();
} catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
}
