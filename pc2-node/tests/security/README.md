# Security helper specs (pre-written before implementation)

Spec-first unit test suite for security helpers introduced by the **PC2 Security Triage 2026-04** plan. Each `.test.js` file specifies the contract for a helper that does **not yet exist**. The implementer of the corresponding wave creates the helper such that all tests in the spec go from skip → green.

## Why pre-written specs?

The tests are the executable design doc. They specify:

- **Happy path**: what success looks like.
- **Fail-closed cases**: every way the helper can be wrong, what it must explicitly return (not throw, not return true).
- **Edge cases**: malformed input, replay, missing fields, unsupported algorithms.

If the implementer misunderstands the security requirement, the tests catch it before merge.

## Files

| Spec | Helper location (created in wave) | Wave |
| --- | --- | --- |
| `siwe-verify.test.js` | `pc2-node/src/api/auth/siwe-verify.ts` | Wave 2 (SEC-3a) |
| `scope-check.test.js` | `pc2-node/src/api/middleware/scope-check.ts` | Wave 1 (SEC-3c) |
| `requireProvisioningToken.test.js` | `deploy/web-gateway/lib/provisioning-token.js` | Wave 3 (SEC-INFRA-GW-AUTH) |
| `firstRunToken.test.js` | `pc2-node/src/api/setup/first-run-token.ts` | Wave 2 (SEC-7) |
| `did-jwt-verify.test.js` | `pc2-node/src/api/did/verify-jwt.ts` | Wave 5 (SEC-11) |

## Running

From the repo root:

```bash
# Run all security specs (uses tsx so .ts helpers are loadable)
npx tsx --test pc2-node/tests/security/*.test.js

# Single spec
npx tsx --test pc2-node/tests/security/siwe-verify.test.js
```

## Pre-implementation behavior

Before any helper is written, every test in the file will **skip** with a clear `[spec] <helper> not yet implemented at <path>` message. The runner exits 0 (suite passes with skipped tests). This is intentional: the spec is reviewable and merge-able as documentation, then turned into a forcing function once the implementer starts.

## Implementation loop

1. Run `npx tsx --test pc2-node/tests/security/<helper>.test.js` — see all skips.
2. Create the helper file at the path listed.
3. Export the named symbols described in the spec's JSDoc header.
4. Run again — see fails.
5. Implement until green.
6. Open PR; CI gate confirms all specs in the relevant wave are green.

## Conventions

- ESM only (`"type": "module"` in `pc2-node/package.json`).
- Built-in `node:test` + `node:assert/strict` — zero new test framework dependencies.
- `tsx` (already a devDep) is the runner; it transparently loads `.ts` helpers via `.js` ESM-style imports.
- Each test file uses **dynamic import with try/catch** so the file loads even before the helper exists; tests then `t.skip()` with a clear reason.
- Crypto in tests uses libraries already in `pc2-node/package.json`: `viem` (EVM signing), `tweetnacl` (Solana ed25519), Node `crypto` (HMAC, hashing).
- For external dependencies the helper relies on (e.g. EIP-1271 RPC, DID resolver), the test passes a **stub** via the helper's `options` parameter — the helper API must support dependency injection for testability.

## Helper API design notes for implementers

Each spec's JSDoc header documents:
1. The **exact named export(s)** the implementer must provide.
2. The **input/output type contracts** in TypeScript-style annotation.
3. Any **dependency-injection seam** required for testability (e.g. `options.eip1271Verifier`).

Implementer is free to choose the internal implementation strategy as long as the spec passes.
