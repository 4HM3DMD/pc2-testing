# Phase 1 Spikes — Lit Action Signature Auth (Option C)

These scripts de-risk the cryptographic primitives the new session-key
delegation protocol depends on, **before** any production code is
touched. They are run locally; none of them is part of CI.

See the design doc for context:
- `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md`
- `.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/SECURITY.md`
- Plan: `/Users/mtk/.cursor/plans/lit-action-session-key-auth_37036101.plan.md`

## What each spike proves

| Script | Layer | Proves |
|---|---|---|
| `spike-particle-sign.mjs` | Server / Node | EIP-191 `personal_sign` roundtrip for any EOA (= the Particle EOA path). Tamper defence via canonical JSON. |
| `spike-eip1271.mjs` | Server / Node | `isValidSignature(bytes32,bytes)` plumbing against Base mainnet RPC — positive magic, wrong bytes4, and revert all handled correctly. |
| `spike-webcrypto-node.mjs` | Server / Node | Node's Web Crypto can verify per-request P-256 ECDSA signatures, and private keys generated with `extractable:false` really cannot be exported. |
| `spike-webcrypto.html` + `spike-webcrypto.runner.mjs` | Browser | P-256 works in Chromium / Firefox / WebKit; K-256 (secp256k1) is unsupported on all three. Drives the curve decision for the ephemeral key. |

## Running

```bash
# From repo root. No build step needed for the Node spikes.
node scripts/spike/spike-particle-sign.mjs
node scripts/spike/spike-eip1271.mjs           # hits Base mainnet RPC
node scripts/spike/spike-webcrypto-node.mjs

# Browser matrix (uses Playwright-bundled Chromium/Firefox/WebKit)
npx playwright install chromium firefox webkit  # one-time
node scripts/spike/spike-webcrypto.runner.mjs

# Or just open in any browser for a human-readable render:
open scripts/spike/spike-webcrypto.html
```

## Outputs

Every run writes a timestamped JSON artefact to
`scripts/spike/.results/<spike>-<iso>.json`. That directory is
gitignored.

## Phase 1 verdict

**PASS across the board.** See `DESIGN.md §10` for the formal memo,
curve decision (P-256 for the ephemeral session key), and the
deferred-to-Phase-3 rows (real wallet in-app browser testing).

No Phase 2 blockers discovered.

## Phase 3 follow-ups (not automatable)

Human wallet-in-hand testing required for:

- Particle EOA popup UI (session vs native sig toggle)
- Real Gnosis Safe signature on Base (positive EIP-1271 path)
- MetaMask / Trust / Coinbase / Rainbow in-app browsers on iOS + Android

Opening `spike-webcrypto.html` in each of those in-app browsers is
the simplest v1 test — the page is self-contained and works off
`file://`.
