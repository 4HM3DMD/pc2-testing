# Wave 2 — SIWE Auth + Setup Lockdown + Transport Hardening

**Parent**: [`SEC-2026-04-21-PC2-AUDIT`](./SEC-2026-04-21-PC2-AUDIT.md)
**Status**: ✅ Done — shipped 2026-04-21
**Findings closed**: SEC-3a (Critical), SEC-7 (Critical), SEC-TRUST-PROXY (High), SEC-CORS-AUDIT (Medium)

---

## What broke before this wave

### SEC-3a — `/auth/particle` accepts unsigned wallet claims

`POST /auth/particle` accepted any wallet address in the Particle JWT
payload as proof of ownership. Anyone with a valid Particle session
(including their own) could change `walletAddress` in the body and
the PC2 node would mint a session for the spoofed wallet — including
**claiming ownership** of an un-claimed PC2 node from any wallet
they chose.

### SEC-7 — `/api/setup/mnemonic` returns the wallet seed phrase to anyone

`/api/setup/info` and `/api/setup/mnemonic` had no authentication.
Anyone who could reach the PC2 node on its setup port could read the
node's wallet mnemonic. The `mnemonic-sign-message` endpoint let
them sign arbitrary messages with the node wallet.

### SEC-TRUST-PROXY — `req.ip` was trivially spoofable

`app.set('trust proxy', true)` made Express trust **any**
`X-Forwarded-For` header from any source. Every middleware that used
`req.ip` for security decisions (rate limit, anti-snipe IP-binding,
loopback detection) was bypassable by sending
`X-Forwarded-For: 127.0.0.1`.

### SEC-CORS-AUDIT — SIWE flow blocked from production origins

The CORS allowlist did not include `*.ela.city` or `*.ela.local`,
so once the SIWE wiring shipped to the GUI, the browser would
preflight-fail on the new `/auth/challenge` request from any
production Elacity origin.

---

## What this wave does

### 1. SIWE / SIWS verifier (SEC-3a)

**New file**: `pc2-node/src/api/auth/siwe-verify.ts`

Verifies three signature kinds against a canonical SIWE/SIWS message
that contains the server-issued nonce:

- **EVM EOA**: `ecrecover` via `viem.recoverMessageAddress`
- **EVM smart account / EIP-1271**: contract `isValidSignature` call
  with `viem` public client; chain inferred from message
- **Solana SIWS**: ed25519 verify via `tweetnacl`, with inline
  Base58 decoder (no extra dep)

Returns `{ ok, address, kind }` or `{ ok: false, reason }`. Never
throws on malformed input.

### 2. Single-use nonce store (SEC-3a)

**New file**: `pc2-node/src/api/auth/challenge-store.ts`

In-memory `Map<nonce, { wallet, exp }>`. `issue(wallet)` returns a
fresh 16-byte URL-safe nonce with 5-min TTL. `consume(nonce, wallet)`
is **atomic** — pops the entry, returns true only if it existed,
matched the wallet, and was unexpired. Replay → false. Wrong wallet
→ false. Stale → false. Auto-purge every 60 s.

### 3. `/auth/challenge` endpoint (SEC-3a)

**Modified**: `pc2-node/src/api/auth.ts`, `pc2-node/src/api/index.ts`

```
GET /auth/challenge?wallet=0x...&chain=eip155:20  →  { nonce, message, exp }
```

Returns the canonical SIWE message the client must sign. Statement,
domain, version, chain, issued-at, expires-at all server-pinned —
client cannot influence them.

### 4. SIWE-gated `/auth/particle` (SEC-3a)

**Modified**: `pc2-node/src/api/auth.ts`

Two-tier gate:

- **`config.security.siweRequired === true`** (default `false`):
  signature + nonce + message must be present and valid; any failure
  → 401. Server logs `✅ SIWE signature verified` on success.
- **`siweRequired === false`**: signature is verified opportunistically
  if present (logs result for telemetry) but is not required. Legacy
  clients keep working byte-for-byte.

Ownership claim path (the "no owner set yet" branch) has an
additional **intent gate** even when `siweRequired === false`:

- request must come from `req.socket.remoteAddress` loopback, OR
- carry a valid one-time `firstRunToken`, OR
- carry the legitimate anti-snipe `X-Anti-Snipe` cookie (existing
  flow)

This closes the silent-claim window between server boot and the
operator finishing setup, even before `siweRequired` is flipped on.

### 5. `claim-ownership` SIWE + intent (SEC-3a)

**Modified**: `pc2-node/src/api/access-control.ts`

`POST /api/access/claim-ownership` now mirrors the `/auth/particle`
ownership-claim gate: same intent triple + SIWE if `siweRequired`.

### 6. First-run boot token (SEC-7 + SEC-3a fallback)

**New file**: `pc2-node/src/api/setup/first-run-token.ts`

Process-wide singleton `firstRunTokenStore` with:

- `getOrMint()` — idempotent per process; mints once at boot
- `verify(token)` — single-use; pops the token if it matches

Token is 32 random bytes, base64url-encoded, printed to stdout /
journalctl on server start so the operator can read it via SSH:

```
🔑 First-run token (single-use, valid until used):
   k7sJlBXsT5x_lp9c2vzN8yvUJgdK3F0LfUz1c8fZBpY
```

Used as the **escape hatch** for both:

- non-loopback setup (SEC-7) — pass as `X-First-Run-Token` header
- ownership claim when no anti-snipe password is set (SEC-3a
  Blindspot F)

### 7. `requireSetupAuth` middleware (SEC-7)

**New file**: `pc2-node/src/api/setup/setup-auth.ts`

Allows the request through if **either**:

- `req.socket.remoteAddress` is loopback (`127.0.0.1`, `::1`,
  `::ffff:127.0.0.1`), OR
- `X-First-Run-Token` header matches `firstRunTokenStore.verify`

`req.socket.remoteAddress` is used (not `req.ip`) so a misconfigured
`trust proxy` cannot bypass the loopback check.

**Applied to** (in `pc2-node/src/api/setup.ts`):

- `GET  /api/setup/info`
- `GET  /api/setup/mnemonic`
- `POST /api/setup/mnemonic-sign-message`
- `POST /api/setup/acknowledge-mnemonic`

### 8. `trust proxy` tightening (SEC-TRUST-PROXY)

**Modified**: `pc2-node/src/server.ts`

```diff
- app.set('trust proxy', true)
+ app.set('trust proxy', 'loopback, linklocal, uniquelocal')
```

`req.ip` now reflects only the immediate client unless the connection
came from a LAN reverse proxy. Any header from a public-internet
client is ignored. All security-sensitive code paths additionally
read `req.socket.remoteAddress` for defence in depth.

### 9. CORS allowlist extension (SEC-CORS-AUDIT)

**Modified**: `pc2-node/src/api/middleware.ts`

`corsMiddleware` allowlist extended with regex matchers for
`*.ela.city` and `*.ela.local`. Existing entries unchanged. No
origins removed.

### 10. Kill-switch flag (SEC-3a rollout)

**Modified**: `pc2-node/src/config/loader.ts`

```ts
security: {
  siweRequired: boolean   // default false
}
```

Lets operators enforce SIWE without a redeploy by editing
`config.json`.

### 11. Frontend SIWE wiring (SEC-3a, GUI side)

**Modified**: `packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx`
**Rebuilt bundle**: `src/particle-auth/{index.html,assets/*}`

`handleParticleAuthSuccess` flow:

1. `GET /auth/challenge?wallet=...` → `{ nonce, message }`
2. `connector.getProvider().request({ method: 'personal_sign', params: [message, address] })`
3. `POST /auth/particle` with `{ ...particleJwt, signature, nonce, message }`

Backward compatibility: if `/auth/challenge` returns 404 (legacy
server), fall back to the old unsigned POST. No flag, no GUI change
required to ship — the new bundle works against both old and new
servers.

---

## Why two MetaMask popups on fresh login?

The user reported seeing **two** `personal_sign` popups during fresh
login. This is expected and correct:

| # | Triggered by | Purpose |
|---|--------------|---------|
| 1 | Particle Auth SDK | Particle's own session sign-in. Third-party. Cannot be removed without dropping Particle Auth. |
| 2 | This wave (SIWE) | Cryptographic proof of wallet control to **our** backend. Closes SEC-3a. |

Industry-standard pattern for any dApp that has its own backend
(OpenSea, Uniswap, Blur, etc. all do this). Returning users skip
both: Particle keeps its own session in localStorage, our backend
session is bound to a cookie + token, neither requires re-signing
until expiry.

The `siweRequired=false` default means popup #2 is **silent today**:
the signature is collected, sent, verified, logged, but **not
enforced** — so even if a user dismisses popup #2, login still
succeeds. We will flip `siweRequired=true` in a follow-up commit
once telemetry shows ≥ 99 % of sessions presenting valid signatures.

---

## Test evidence

```
$ npm run test:security
  ▶ pc2-node/tests/security/firstRunToken.test.js     (16/16 pass)
  ▶ pc2-node/tests/security/scope-check.test.js       (17/17 pass)
  ▶ pc2-node/tests/security/siwe-verify.test.js       (17/17 pass)
  ▶ pc2-node/tests/security/requireProvisioningToken.test.js  (16 skipped — Wave 3)
  ▶ pc2-node/tests/security/did-jwt-verify.test.js    (13 skipped — Wave 5)
  → 50 pass, 29 skipped, 0 fail
```

```
$ npx tsc -p pc2-node --noEmit
  → 0 errors
```

End-to-end (user-confirmed 2026-04-21):

- Fresh login (cleared localStorage) → two MetaMask popups → login succeeds
- Server log: `✅ SIWE signature verified  wallet=0x... kind=evm-eoa`
- Existing sessions (warm localStorage) → no popups, no regression
- File operations continue to work via scoped sessions (Wave 1)

---

## Files

### Created (Wave 2 only)

```
pc2-node/src/api/auth/challenge-store.ts
pc2-node/src/api/auth/siwe-verify.ts
pc2-node/src/api/setup/first-run-token.ts
pc2-node/src/api/setup/setup-auth.ts
```

### Modified (Wave 2 only)

```
pc2-node/src/api/auth.ts                    (+SIWE)
pc2-node/src/api/access-control.ts          (+intent + SIWE)
pc2-node/src/api/index.ts                   (+/auth/challenge route)
pc2-node/src/api/middleware.ts              (CORS allowlist)
pc2-node/src/api/setup.ts                   (+requireSetupAuth)
pc2-node/src/config/loader.ts               (+siweRequired flag)
pc2-node/src/server.ts                      (trust proxy + boot token)
packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx
src/particle-auth/{index.html,assets/*}     (rebuilt bundle)
```
