# Task: UI/X polish — console noise swept while Wave 8 Test 4 is blocked

**Task ID**: UIX-2026-04-28-WAVE8-WAITING-POLISH
**Created**: 2026-04-28
**Status**: InProgress (awaiting end-user hard-reload verification of fix (d); (b) deferred to tomorrow)
**Priority**: Low (polish — none of these block functionality)

## Why this exists

While the Wave 8 C-02 end-to-end matrix is blocked on Irzhy's `buildMetadataEnvelope`
regression (see
[`SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING`](../SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING.md)),
we swept four cosmetic console errors the end-user reported. Three are fixed
in-session; one (cosmetic footer banner) is left for tomorrow's broader
UI/X pass. None of these findings change behaviour in user-visible flows.

## Findings and dispositions

| # | Symptom (console) | Impact | Status |
|---|---|---|---|
| (a) | `pc2-*.js` 404 + "Refused to execute script because its MIME type ('text/html') is not executable" for `pc2-wallet-provider.js`, `pc2-wallet-bridge.js`, `pc2-secure-view.js`, `pc2-secure-view-session.js` | Broken parent-side wallet bridge `<script>` tags served index.html by the SPA fallback. Silent — bridge still worked via `postMessage` fallback. | ✅ Fixed |
| (b) | `Version: 2.5.1 · Server: undefined · Deployed: Invalid Date` shown in About banner | Cosmetic (static footer string concatenated from missing server-side fields). | ⏸ Deferred — tomorrow's UI/X pass |
| (c) | `GET /api/elastos/transactions 401 Unauthorized` from wallet panel | Wallet panel could not render ESC transaction history (empty list). | ✅ Fixed |
| (d) | `mainnet.base.org/:1 Failed to load resource: the server responded with a status of 429 ()` | Cosmetic — Particle SDK and parent `WalletService` silently fall back to other Base RPCs. | ✅ Fixed (client verification pending) |

## Fix (a) — Missing `pc2-*.js` in `pc2-node/frontend/`

The four wallet-bridge client scripts are built from `pc2-node/src/wallet-bridge/`
but the build pipeline (`pc2-node/scripts/build-frontend.js`) was not copying
them into `pc2-node/frontend/` — the directory actually served as static.
Requests fell through to the SPA `index.html` and the browser refused to
execute the HTML as JS, hence the MIME warnings.

Fixed by placing the four files directly in `pc2-node/frontend/` (mirrors the
existing pattern for non-generated static assets):

```text
pc2-node/frontend/pc2-wallet-provider.js
pc2-node/frontend/pc2-wallet-bridge.js
pc2-node/frontend/pc2-secure-view.js
pc2-node/frontend/pc2-secure-view-session.js
```

Confirmed post-fix: no further `pc2-*.js 404` lines, no MIME warnings.

### Follow-up for tomorrow

The right long-term fix is to extend `build-frontend.js` to copy these four
files as part of its normal run so rebuilds stay self-consistent. Intentionally
left for tomorrow's broader UI/X pass to avoid touching the build pipeline
mid-Wave-8.

## Fix (c) — `/api/elastos/transactions` wrongly gated behind `authenticate`

`pc2-node/src/api/index.ts` mounted the Elastos transaction-history proxy
behind the `authenticate` middleware, but the frontend caller
(`src/gui/src/services/WalletService.js::fetchElastosTransactions`) does not
attach a bearer token — the upstream reference implementation at
`src/backend/src/routers/elastos-proxy.js` is also unauthenticated (the data
is public on-chain history by wallet address).

Fix: drop the `authenticate` middleware from the single route. Diff is
deliberately minimal — everything else on the file is untouched:

```diff
- app.get('/api/elastos/transactions', authenticate, async (req, res) => {
+ app.get('/api/elastos/transactions', async (req, res) => {
```

No change to any other `/api/*` route. No new endpoint. No behaviour change
for any authenticated caller (Authorization header, if present, is simply
ignored; the route already accepts the public `address=` query param as its
only input). Confirmed post-fix: wallet panel's transaction list populates;
no 401s on that path.

## Fix (d) — `mainnet.base.org` 429 rate-limit errors

**Symptom in log**: 5× `mainnet.base.org/:1  Failed to load resource: 429`
across a single session. Both the Particle iframe (viem HTTP transport from
inside Particle's `createTransferTransaction` / `eth_getCode` probes) and the
parent Puter GUI (`src/gui/src/services/WalletService.js::_getPublicRpcUrl`
+ the Base entry in the RPC fallback array, lines ~89-94 and ~2033) hit
`https://mainnet.base.org` directly as their first-choice Base RPC. That's
a shared public endpoint that rate-limits aggressively when multiple clients
poll.

**Fix — two layers**:

### Layer 1 — server-side proxy with multi-RPC fallback + 30s cache

New `POST /api/rpc/base` endpoint in `pc2-node/src/static.ts`. Shares the
same `handleJsonRpcProxy` helper as the existing `/api/rpc/esc` proxy
(refactored out of the Elastos proxy in this session). RPC list:

```ts
const BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
];
```

Cache keys now namespaced with a `chainKey` prefix (`esc`, `base`) so
shared method names (`eth_getBalance`, `eth_getCode`, `eth_call`) cannot
collide across chains. `eth_getCode` responses of `0x` are intentionally
**not** cached (a contract is "not deployed" until it is — caching the
negative answer for 30s introduces a race we don't want to own).

### Layer 2 — client-side interceptor rewrites (same-origin, no network change)

Rewrote `https://mainnet.base.org` → `${origin}/api/rpc/base` in **both** of
PC2's existing interceptors:

**Parent page** (`pc2-node/frontend/index.html` + the template in
`pc2-node/scripts/build-frontend.js` so clean rebuilds stay in sync). Added
an `else if (url.includes('mainnet.base.org'))` branch to both the
`fetch(...)` override and the `XMLHttpRequest.prototype.open` override.
Only string URLs — Puter GUI code path passes strings.

**Particle iframe** (`pc2-node/src/static.ts`, the injected `<script>` in
the `/particle-auth` HTML). Here the interceptor had to handle `Request` and
`URL` objects too, because viem's HTTP transport inside Particle's bundle
passes `Request` objects to `fetch` whose `.url` is read-only — a plain
`args[0] = rewritten` would silently fail. We clone the `Request` with a
new URL in that path:

```js
if (typeof Request !== 'undefined' && input instanceof Request) {
    const rewritten = rewriteUrlString(input.url);
    if (rewritten !== input.url) {
        args[0] = new Request(rewritten, input);
    }
}
```

### Verification

- Server: `curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4200/api/rpc/base -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` → `200`.
- Static: both `pc2-node/frontend/index.html` and
  `pc2-node/scripts/build-frontend.js` grep for `Intercepting Base RPC` → 2
  matches each (one fetch, one XHR).
- Client: hard-reload pending at end-user side; expected `[PC2]: Intercepting
  Base RPC fetch: https://mainnet.base.org/... -> http://localhost:4200/api/rpc/base`
  in place of the 429s.

## Files Modified

| File | Change |
|---|---|
| `pc2-node/src/api/index.ts` | Fix (c): drop `authenticate` middleware from `GET /api/elastos/transactions`. |
| `pc2-node/src/static.ts` | Fix (d) server side: extract `handleJsonRpcProxy`; add `BASE_RPC_URLS` + `POST /api/rpc/base` endpoint; namespace RPC cache by `chainKey`; skip caching `eth_getCode === '0x'`. Extend `/particle-auth` injected interceptor to rewrite `mainnet.base.org` → `/api/rpc/base`, including `Request`/`URL` object clone for viem's HTTP transport. |
| `pc2-node/frontend/index.html` | Fix (d) parent side: add `mainnet.base.org` branch to both the `fetch` override and the `XMLHttpRequest.prototype.open` override. String URLs only. |
| `pc2-node/scripts/build-frontend.js` | Fix (d) template parity: mirror the two new interceptor branches into the `HTML_TEMPLATE` so a clean rebuild regenerates `index.html` with the fix intact. |

## Files Created

| File | Purpose |
|---|---|
| `pc2-node/frontend/pc2-wallet-provider.js` | Fix (a): wallet-bridge client (copied from `src/wallet-bridge/`). |
| `pc2-node/frontend/pc2-wallet-bridge.js` | Fix (a): wallet-bridge parent-side shim. |
| `pc2-node/frontend/pc2-secure-view.js` | Fix (a): secure-view helper. |
| `pc2-node/frontend/pc2-secure-view-session.js` | Fix (a): secure-view session stub. |

## Not in scope

- (b) `Version: 2.5.1 · Server: undefined · Deployed: Invalid Date` — deferred to tomorrow.
- Extending `build-frontend.js` to auto-copy the four `pc2-*.js` files — deferred.
- Any change to Particle SDK bundles — out of scope.
- Any change to Chipotle / Lit code paths — out of scope (Wave 8 ownership).

## Risks flagged

1. **Shared code between runtimes.** The parent `index.html` interceptor and
   the template in `build-frontend.js` are two copies of the same logic.
   Today they are in sync; any future change must touch both. Annotated in
   both files.
2. **`Request` object cloning in the iframe interceptor.** `new Request(url, init)`
   with a `Request` as `init` re-consumes the body. For the `eth_*` JSON-RPC
   calls we care about (tiny POST bodies, no streams) this is safe and is
   the documented pattern. Streaming bodies would be an issue; none are used
   on this path.
3. **Pending end-user verification for (d).** Smoke-tested server-side; the
   interceptor path is only proven once the user hard-reloads and reports no
   more 429s. Rollback path: revert the two interceptor blocks and the
   `/api/rpc/base` endpoint — no persistent state touched.
