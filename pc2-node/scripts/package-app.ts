/**
 * Capsule packager — standalone build script.
 *
 * Tarballs a test-app source directory, signs it with an Ed25519 key, and
 * emits the registry entry JSON that PC2's AppInstallService accepts via
 * `POST /api/installed-apps/install` (CID + manifest with signed `distribution`).
 *
 * The same artifact format works for both:
 *   - bundled / system apps (Market, Creator, Player, dDRM Viewer)
 *   - dapp-store capsules (Elastos NFT, Glide Finance, future third-party)
 *
 * The signed bundle hash binds the manifest's `distribution.signature` to
 * the exact tarball bytes; AppInstallService.verifyDistributionSignature
 * (already shipped in v1.2) does the corresponding verify on install.
 *
 * Usage:
 *   npx tsx scripts/package-app.ts <app-name>            # pack + sign only
 *   npx tsx scripts/package-app.ts <app-name> --pin      # also pin to local IPFS
 *   npx tsx scripts/package-app.ts <app-name> --pin --auth <token>
 *   npx tsx scripts/package-app.ts <app-name> --key /path/to/ed25519
 *   npx tsx scripts/package-app.ts <app-name> --src data/dev-apps/<name>
 *   npx tsx scripts/package-app.ts <app-name> --out dist/apps
 *
 * Source dir resolution (first match wins):
 *   1. --src <path>     (explicit override)
 *   2. data/test-apps/<app-name>/
 *   3. data/dev-apps/<app-name>/
 *
 * Signing key resolution (first match wins):
 *   1. --key <path>
 *   2. $ELACITY_SIGNING_KEY (path to a 32-byte hex secret)
 *   3. ~/.elastos/keys/elacity-labs.ed25519  (auto-generated on first run, 0600)
 *
 * IPFS pinning (--pin) requires either:
 *   - $PC2_AUTH_TOKEN env var, OR
 *   - --auth <token> CLI flag
 * The script POSTs to http://127.0.0.1:${PORT:-4200}/api/storage/ipfs/add
 * using the same auth surface every Creator-mode call uses.
 *
 * Output:
 *   - <out>/<app-name>-<version>.tar.gz             (the bundle)
 *   - <out>/<app-name>-<version>.registry.json      (signed registry entry)
 *   - registry JSON also written to stdout for piping into curl
 *
 * The registry JSON shape matches AppManifest with `distribution.cid`,
 * `distribution.signature`, `distribution.signedBy`, `distribution.size` set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

interface CliArgs {
  appName: string;
  srcDir?: string;
  keyPath?: string;
  outDir?: string;
  pin: boolean;
  authToken?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith('-')) {
    fail('Usage: package-app.ts <app-name> [--src <dir>] [--key <path>] [--out <dir>] [--pin [--auth <token>]]');
  }

  const result: CliArgs = { appName: args[0], pin: false };
  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    const next = args[i + 1];
    switch (flag) {
      case '--src':   result.srcDir   = next; i += 1; break;
      case '--key':   result.keyPath  = next; i += 1; break;
      case '--out':   result.outDir   = next; i += 1; break;
      case '--auth':  result.authToken = next; i += 1; break;
      case '--pin':   result.pin = true; break;
      default:        fail(`Unknown flag: ${flag}`);
    }
  }
  return result;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stderr.write(`[package-app] ${msg}\n`);
}

function resolveSourceDir(appName: string, override: string | undefined, repoRoot: string): string {
  if (override) {
    const resolved = resolve(repoRoot, override);
    if (!existsSync(resolved)) fail(`--src dir not found: ${resolved}`);
    return resolved;
  }
  const candidates = [
    resolve(repoRoot, 'data/test-apps', appName),
    resolve(repoRoot, 'data/dev-apps', appName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail(`No source dir found for "${appName}". Tried:\n  ${candidates.join('\n  ')}\n  (use --src to override)`);
}

function loadOrCreateKey(keyPath: string): { secret: Uint8Array; publicKey: Uint8Array } {
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, 'utf-8').trim();
    if (hex.length !== 64) fail(`Signing key at ${keyPath} must be 32-byte hex (got ${hex.length / 2} bytes)`);
    const seed = Buffer.from(hex, 'hex');
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
    return { secret: kp.secretKey, publicKey: kp.publicKey };
  }

  // First-run: generate a fresh key, write 0600. Print clear notice so the
  // operator knows to back this up — losing it means losing the publisher
  // identity for this capsule line.
  info(`No signing key at ${keyPath} — generating new Ed25519 keypair...`);
  const seed = nacl.randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const dir = dirname(keyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, Buffer.from(seed).toString('hex'), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(`${keyPath}.pub`, Buffer.from(kp.publicKey).toString('hex'));
  info(`Generated key at ${keyPath} (chmod 600). Public key: ${Buffer.from(kp.publicKey).toString('hex')}`);
  info('Back this file up. Losing it means losing publisher identity for this capsule line.');
  return { secret: kp.secretKey, publicKey: kp.publicKey };
}

function sumDirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  }
  return total;
}

async function packDirectory(srcDir: string, outFile: string): Promise<void> {
  // Pack each top-level entry directly (no wrapper dir). The tarball is
  // designed to be extracted INTO an already-created appDir, matching
  // AppInstallService.extractTarGz behaviour. A wrapper dir would cause
  // a double-nesting at install time (installed-apps/<name>/<name>/...).
  const topLevel = readdirSync(srcDir).filter((name) => {
    if (name === '.DS_Store') return false;
    if (name === 'node_modules') return false;
    return true;
  });

  await tar.c(
    {
      gzip: true,
      file: outFile,
      cwd: srcDir,
      follow: false,
      preserveOwner: false,
    },
    topLevel,
  );
}

async function pinToLocalNode(tarballPath: string, authToken: string): Promise<{ cid: string; size: number }> {
  const port = process.env.PC2_PORT || '4200';
  const url  = `http://127.0.0.1:${port}/api/storage/ipfs/add`;
  const bytes = readFileSync(tarballPath);
  const body = JSON.stringify({ content: bytes.toString('base64'), announce: false });
  info(`Pinning ${(bytes.length / 1024).toFixed(1)} KB tarball to ${url}...`);

  // Auth surface: tokens that look like `pc2_<hex>` are API keys (X-API-Key
  // header, validated by the apikey branch in middleware.ts authenticate()).
  // Anything else is treated as a session token (Authorization: Bearer).
  // The packager is intended to be driven by an owner-mode API key in
  // automation, so this falls through to the API-key path 99% of the time.
  const isApiKey = authToken.startsWith('pc2_');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isApiKey
        ? { 'X-API-Key': authToken }
        : { 'Authorization': `Bearer ${authToken}` }
      ),
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    fail(`IPFS add failed: HTTP ${res.status} — ${errText}`);
  }
  const json = await res.json() as { success?: boolean; cid?: string; size?: number; error?: string };
  if (!json.cid) fail(`IPFS add returned no cid: ${JSON.stringify(json)}`);
  return { cid: json.cid, size: json.size ?? bytes.length };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  // pc2-node/scripts/package-app.ts → repoRoot = pc2-node/
  const repoRoot = resolve(__dirname, '..');

  const srcDir = resolveSourceDir(cli.appName, cli.srcDir, repoRoot);
  const manifestPath = join(srcDir, 'app.json');
  if (!existsSync(manifestPath)) fail(`Missing app.json at ${manifestPath}`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.name !== cli.appName) {
    fail(`Manifest name mismatch: app.json says "${manifest.name}" but CLI passed "${cli.appName}"`);
  }
  if (!manifest.version) fail('Manifest is missing "version"');

  const outDir = resolve(repoRoot, cli.outDir || 'dist/apps');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const tarballPath = join(outDir, `${cli.appName}-${manifest.version}.tar.gz`);
  const registryPath = join(outDir, `${cli.appName}-${manifest.version}.registry.json`);

  info(`Source: ${srcDir}  (${(sumDirSize(srcDir) / 1024).toFixed(1)} KB on disk)`);
  info(`Packing → ${tarballPath}`);
  await packDirectory(srcDir, tarballPath);

  const tarballBytes = readFileSync(tarballPath);
  const sha256 = createHash('sha256').update(tarballBytes).digest();
  info(`SHA-256: ${sha256.toString('hex')}  (${(tarballBytes.length / 1024).toFixed(1)} KB)`);

  const keyPath = cli.keyPath
    || process.env.ELACITY_SIGNING_KEY
    || join(homedir(), '.elastos', 'keys', 'elacity-labs.ed25519');
  const { secret, publicKey } = loadOrCreateKey(keyPath);
  const signature = nacl.sign.detached(new Uint8Array(sha256), secret);
  info(`Signed by: ${Buffer.from(publicKey).toString('hex')}`);

  let cid: string | null = null;
  if (cli.pin) {
    const authToken = cli.authToken || process.env.PC2_AUTH_TOKEN;
    if (!authToken) fail('--pin requires --auth <token> or $PC2_AUTH_TOKEN');
    const result = await pinToLocalNode(tarballPath, authToken);
    cid = result.cid;
    info(`Pinned: ${cid}`);
  } else {
    info('Skipping IPFS pin (no --pin flag). Pin manually with:');
    info(`  curl -X POST -H "Authorization: Bearer $PC2_AUTH_TOKEN" -H "Content-Type: application/json" \\`);
    info(`       -d "{\\"content\\":\\"$(base64 < ${tarballPath})\\",\\"announce\\":false}" \\`);
    info(`       http://127.0.0.1:4200/api/storage/ipfs/add`);
  }

  // Emit the signed manifest. AppInstallService picks up signature/signedBy
  // from distribution and verifies on install (verifyDistributionSignature).
  const registryEntry = {
    ...manifest,
    distribution: {
      ...(manifest.distribution || {}),
      cid,
      signature: Buffer.from(signature).toString('hex'),
      signedBy: Buffer.from(publicKey).toString('hex'),
      size: tarballBytes.length,
    },
  };
  writeFileSync(registryPath, JSON.stringify(registryEntry, null, 2));
  info(`Registry entry → ${registryPath}`);

  // stdout: just the registry JSON, so the script is pipeable.
  process.stdout.write(JSON.stringify(registryEntry, null, 2) + '\n');
}

main().catch((err: Error) => fail(err.message));
