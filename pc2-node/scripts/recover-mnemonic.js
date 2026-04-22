#!/usr/bin/env node

/**
 * Recover Mnemonic CLI
 *
 * Restores the PC2 node identity (identity.json) deterministically from
 * a 24-word recovery phrase. Designed for the classic container-loss
 * scenario: the data volume is gone but the operator still has the phrase.
 *
 * Usage:
 *   npm run recover-mnemonic
 *     # prompts for the mnemonic on stdin (hidden input)
 *
 *   node pc2-node/scripts/recover-mnemonic.js --mnemonic "word1 word2 ..."
 *     # non-interactive; useful inside docker run --rm
 *
 *   node pc2-node/scripts/recover-mnemonic.js --force
 *     # allows overwriting an existing identity.json (backs it up first)
 *
 * Security:
 *   - The phrase is read either from stdin with echo disabled or from
 *     CLI args. Prefer stdin — CLI args can leak into shell history.
 *   - If identity.json already exists and --force is supplied, the
 *     existing file is moved to identity.json.bak-<timestamp> rather
 *     than deleted, so a mistake is always recoverable.
 *   - The phrase itself is never persisted; only the derived ed25519
 *     keypair is written (same shape IdentityService produces on init).
 */

import { createInterface } from 'readline';
import { createHmac } from 'crypto';
import { existsSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import nacl from 'tweetnacl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const DATA_DIR = process.env.PC2_DATA_DIR || join(PROJECT_ROOT, 'data');
const IDENTITY_PATH = join(DATA_DIR, 'identity.json');

// DER prefixes mirror IdentityService.ts — keep in sync.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(bytes) {
  let num = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }
  return result || '1';
}

function deriveFromMnemonic(mnemonic) {
  // HKDF-like derivation matching IdentityService.mnemonicToSeed.
  const ikm = Buffer.from(mnemonic, 'utf8');
  const salt = Buffer.from('pc2-boson-identity-v2', 'utf8');
  const info = Buffer.from('ed25519-seed', 'utf8');
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const seed = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  const rawPub = Buffer.from(kp.publicKey);
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPub]);
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return { publicKey: spki, privateKey: pkcs8 };
}

function parseArgs(argv) {
  const args = { force: false, mnemonic: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--mnemonic' || a === '-m') {
      args.mnemonic = argv[++i] || '';
    }
  }
  return args;
}

function printHelp() {
  console.log(`
PC2 Node — Mnemonic Recovery

Usage:
  npm run recover-mnemonic                           # interactive (preferred)
  node pc2-node/scripts/recover-mnemonic.js [flags]

Flags:
  --mnemonic, -m "w1 w2 ... w24"    24-word phrase (non-interactive)
  --force, -f                       overwrite existing identity.json
                                    (previous file is kept as .bak-<ts>)
  --help, -h                        show this message

Environment:
  PC2_DATA_DIR     data directory (default: pc2-node/data)

What it does:
  Derives your ed25519 identity (publicKey, privateKey, nodeId, DID)
  from the 24-word recovery phrase and writes pc2-node/data/identity.json
  with mode 0600. Next start, your node will come up with the same DID
  it had before — so your yourname.ela.city handle is recoverable on
  the gateway.
`);
}

async function promptHidden(question) {
  // Minimal hidden-input prompt: mute stdout while the user types.
  // Not bulletproof against TTYs that echo on their own, but enough
  // to keep the phrase out of a casual screen-share.
  return new Promise((resolvePrompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const stdout = process.stdout;
    const origWrite = stdout.write.bind(stdout);
    rl.question(question, (answer) => {
      stdout.write = origWrite;
      stdout.write('\n');
      rl.close();
      resolvePrompt(answer);
    });
    // Suppress echo after the prompt line has been drawn.
    stdout.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.length > 0 && chunk !== '\n') {
        return origWrite('*', ...rest);
      }
      return origWrite(chunk, ...rest);
    };
  });
}

function normaliseMnemonic(raw) {
  const words = String(raw || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length !== 24) {
    throw new Error(`Mnemonic must be exactly 24 words (got ${words.length}).`);
  }
  if (!words.every((w) => /^[a-z]+$/.test(w))) {
    throw new Error('Mnemonic words must be lower-case letters only.');
  }
  return words.join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  if (existsSync(IDENTITY_PATH) && !args.force) {
    console.error(
      `\n[ERROR] identity.json already present at ${IDENTITY_PATH}.` +
        `\n        Re-run with --force to overwrite (the existing file` +
        ` will be kept as identity.json.bak-<timestamp>).\n`,
    );
    return 2;
  }

  let mnemonic;
  try {
    if (args.mnemonic) {
      mnemonic = normaliseMnemonic(args.mnemonic);
      console.log('[recover-mnemonic] Using phrase supplied on CLI.');
    } else {
      console.log('[recover-mnemonic] Paste your 24-word recovery phrase.');
      console.log('                   (input will be hidden; press Enter when done)\n');
      const raw = await promptHidden('Mnemonic: ');
      mnemonic = normaliseMnemonic(raw);
    }
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}\n`);
    return 3;
  }

  const { publicKey, privateKey } = deriveFromMnemonic(mnemonic);
  const rawPublicKey = publicKey.slice(-32);
  const nodeId = toBase58(rawPublicKey);
  const did = `did:boson:${nodeId}`;

  const identity = {
    nodeId,
    did,
    publicKey: publicKey.toString('hex'),
    privateKey: privateKey.toString('hex'),
    identityVersion: 2,
    createdAt: new Date().toISOString(),
    restoredFromMnemonic: true,
  };

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (existsSync(IDENTITY_PATH) && args.force) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${IDENTITY_PATH}.bak-${ts}`;
    renameSync(IDENTITY_PATH, backupPath);
    console.log(`[recover-mnemonic] Existing identity moved to ${backupPath}`);
  }

  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), { mode: 0o600 });

  console.log('\n[recover-mnemonic] Identity restored.');
  console.log(`  nodeId : ${nodeId}`);
  console.log(`  did    : ${did}`);
  console.log(`  file   : ${IDENTITY_PATH}`);
  console.log(
    '\nNext steps:\n' +
      '  1. Start (or restart) the node: the Boson service will load this identity on boot.\n' +
      '  2. Re-run the setup wizard to re-attach your username — the gateway will\n' +
      '     recognise the same DID and re-bind yourname.ela.city automatically.\n',
  );
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('[recover-mnemonic] Fatal:', err?.message || err);
    process.exit(1);
  });
