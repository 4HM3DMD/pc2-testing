# elacity-capsule-runtime

PC2 extension that adds support for `kind: "hybrid"` capsules. Loads
into PC2 via the existing extension mechanism — no changes to
`pc2-node/` required.

## What it does

PC2 already supports capsules of types `web`, `wasm`, `data`,
`microvm`, `agent` — those are sandboxed apps installable through
dApp Centre. This extension adds support for **hybrid capsules**:
apps with both an iframe frontend AND a privileged Node backend
that runs in PC2's main process.

It exposes:

```
POST /api/capsules/preview-consent
POST /api/capsules/install
POST /api/capsules/uninstall
GET  /api/capsules/health
```

Plus a heartbeat that polls the publisher revocation list every
hour (`https://registry.ela.city/revocations.json` by default).

## Why it lives here, not in pc2-node

The Wave 7 plan originally assumed PC2's platform team would extend
`pc2-node/src/services/AppInstallService.ts` to recognise
`kind: "hybrid"` and dispatch to this code. The operator vetoed
touching `pc2-node/` directly. Workaround: ship the entire
M1–M9 library + the install routes as a regular PC2 extension.
Operators who want hybrid capsule support drop this directory into
their PC2 `extensions/` folder; everyone else doesn't carry the
runtime cost.

When the platform team eventually adds the toggle and dispatch
wiring, this extension can be retired in favour of direct
integration — same library code either way.

## Layout

```
extensions/elacity-capsule-runtime/
├── main.js              extension entry (lifecycle hooks + routes)
├── src/
│   ├── services/        the M1–M9 library (12 modules)
│   ├── utils/logger.ts  small console-backed logger
│   └── probe-runner.cjs child-process wrapper used by ExtensionProbe
├── tests/               269 tests, all passing
├── scripts/
│   └── make-test-capsule.mjs   dev signing utility
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

Environment variables PC2 passes to this extension at boot:

| Var | Required | Default | What |
|-----|----------|---------|------|
| `PC2_TRUSTED_PUBLISHER_KEYS` | yes | `''` | Comma-separated 64-hex Ed25519 publisher pubkeys (typically just ElacityLabs's production key) |
| `PC2_REVOCATION_ROOT_KEY` | recommended | `''` | 64-hex Ed25519 pubkey for the revocation list. Without this, hybrid capsules can't be revoked at runtime |
| `PC2_REVOCATION_URL` | no | `https://registry.ela.city/revocations.json` | Override the revocation list URL (e.g. for staging) |
| `PC2_DATA_DIR` | no | `/data` | PC2's data root |
| `PC2_EXTENSIONS_DIR` | no | parent of this dir | Where installed-extension files land |

Without `PC2_TRUSTED_PUBLISHER_KEYS` set, every install attempt
fails with "publisher not in trusted set" — that's the right
default. An accidentally-deployed extension never accidentally
trusts a random publisher.

## Build step before deploying

The library sources are TypeScript. PC2's extension loader is
CJS Node. Before deploying:

```bash
cd extensions/elacity-capsule-runtime
npm install        # installs tar + tweetnacl
npm run build      # tsc → dist/services/*.js
```

After build, `main.js` resolves the dynamic imports against the
TypeScript sources via tsx in dev OR the compiled `dist/` in
production. (Production loader path adjustment is a follow-up —
for the dev/test workflow, `npx tsx --test tests/*.test.js`
runs the full 269-test suite directly.)

## Running the tests

```bash
cd extensions/elacity-capsule-runtime
npm install
npx tsx --test tests/*.test.js
```

All 269 tests should pass: M1 (manifest + signing), M2 (atomic
extraction), M3 (lazy loader + probe + quarantine), M4 (asset
fetcher), M5 (hello-world e2e), M6 (consent + orchestrator),
M7 (revocation transport), M8 (ENM capsule e2e), M9 (drain +
SSE replay).

## Building a test capsule (dev)

```bash
node scripts/make-test-capsule.mjs <source-dir> <out-dir>
```

Reads a capsule source directory (e.g. `extensions/elastos-node-manager/`),
bundles it, signs with a fresh dev key, writes the signed manifest
+ tarball + publisher pubkey hex. See `scripts/make-test-capsule.mjs`
for the `PC2_DEV_KEY_PATH` env var to reuse a key across builds.

## Trust model

Per the v0.3 doc — see `enm-server/docs/wave7-extension-migration.md`
or the project memory `project_wave7_hybrid_capsule.md`:

> Hybrid capsules ship with publisher-signature trust, NOT
> in-process capability enforcement. The Ed25519 signature on the
> bundle is the security boundary. Once a capsule is installed,
> its backend half runs as trusted PC2 code with full host
> privileges. Capabilities declared in the manifest are
> disclosure, not enforcement.

That means **anyone with the production publisher key can ship
code that runs as PC2**. Compromise of the publisher key is the
worst-case scenario; mitigated by the revocation list (which can
mark a key revoked) and the revocation root (a separate, cold-
stored key that signs the revocation list).
