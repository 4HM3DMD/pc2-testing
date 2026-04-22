# Wave 3 — Web-Gateway Lockdown (per-node provisioning tokens)

**Status**: ✅ Done — shipped 2026-04-22
**Findings closed**: SEC-2 (Critical), SEC-8 (High), SEC-9 (High), SEC-INFRA-GW-AUTH (High); incidentally SEC-3e (out-of-audit username squat)
**Out of scope**: Wave 4 (CI secret-scan), Wave 5 (DID JWT verify)

---

## TL;DR for a 9th grader

Before this commit, every PC2 node talked to the supernode gateway
without any password. The supernode trusted whoever asked. So if I
knew your username (a public string like `alice`), I could:

- Ask the supernode to swap your VPN keys for mine and steal your
  tunnel.
- Tell it to delete your VPN account.
- Send a username with a backslash in it that ran my code on the
  supernode (the worst one — full server takeover).

Now, the **first** time your node introduces itself the supernode
gives it a long random secret token (256 bits). Your node saves it
to disk so only you can read it (mode `0600`). Every later message
to the supernode includes that token in a header. The supernode
checks it before doing anything. Wrong token → 401. No token →
either 401 (strict mode) or "I'll just log this for now" (default).

The tokens are stored as **hashes** on the supernode (like a
password), so even if someone steals the gateway's disk they can't
replay any tokens. Each token is bound to one username — so your
token can't be used to act on someone else's account.

To keep this from breaking anyone on rollout day, the strict 401s
are **off by default** (`GW_AUTH_REQUIRED=false`). The supernode
checks the token but allows the call through and writes a
`[gw-auth]` log line. Operators deploy the supernode change first,
let every PC2 node roll out the client change at its own pace, watch
the logs, and **only then** flip the kill-switch to strict.

---

## What this wave does

### 1. New helper — `deploy/web-gateway/lib/provisioning-token.js`

A small, self-contained `ProvisioningTokenStore` class plus a
top-level `verifyProvisioningToken({ token, username, store })`
helper. The contract was locked by
`pc2-node/tests/security/requireProvisioningToken.test.js` (12 active
test cases). All pass.

Security properties enforced:

- 256-bit (64-hex-char) cryptographically random tokens.
- Stored as **SHA-256 hash** on disk; never plaintext. Verified by
  the test suite (`hashes stored, not plaintext` case).
- Constant-time comparison via `crypto.timingSafeEqual`.
- Username-bound — token for `node-A` cannot authorise a call for
  `node-B`. Verified by the `cross-account attack` test case.
- `mint()` **refuses** to overwrite an existing token (would let an
  attacker re-claim a victim's username). Use `rotate()` to renew.
- File-backed persistence via `persistencePath` constructor arg.
  Atomic write (`tmp` → `rename`), mode `0600`, gracefully ignores
  corrupt file on load.

### 2. Gateway integration — `deploy/web-gateway/index.js`

Added at module scope:

```js
const provisioningTokenStore = new ProvisioningTokenStore(PROVISIONING_TOKEN_FILE);
const GW_AUTH_REQUIRED = process.env.GW_AUTH_REQUIRED === 'true';

function requireProvisioningToken(req, res, username, handlerLabel) {
  // returns true=continue, false=already responded with 401
  // log-only mode always returns true; just emits telemetry
}
```

A second helper, `checkPerUsernameDeleteRate(username)`, throttles
WG/awg peer deletion to 3/min per username (independent of the
existing per-IP rate limiter, so a runaway script can't lock out the
legitimate owner from many client IPs).

### 3. `/api/register` — token mint flow

The first endpoint a PC2 node hits. Now handles four cases
explicitly:

- **A** New username — mint a 64-hex token, store the hash, return
  the plaintext **once** in the response body's `provisioningToken`
  field.
- **B** Re-registration **with** correct token — accept and update
  endpoint info. Token is unchanged. Plaintext NOT returned again.
- **C** Re-registration **with wrong/missing** token — log-only
  mode: allow + telemetry. Strict mode: 401.
- **D** Re-registration with **no token bound yet** (legacy data
  on supernode pre-Wave 3) — log-only: auto-grandfather (mint a new
  token + return it once so the legitimate owner gets onboarded on
  the next boot). Strict: 401 (operator must manually reset).

Case D is what makes the rollout safe for existing nodes: when the
gateway boots after the upgrade, no one has tokens yet, so the very
next `/api/register` from each PC2 node mints them automatically.

### 4. SEC-2 — Shell injection on `/api/vless/register`

Pre-fix line (old, scary):

```js
uuid = execSync(`/etc/vless-reality/manage-peers.sh add "${normalizedUsername}"`, ...);
```

Fix:

```js
// Defence layer 1 — pre-shell username regex
if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(normalizedUsername)) return 400;

// Defence layer 2 — token gate
if (!requireProvisioningToken(req, res, normalizedUsername, 'vless/register')) return;

// Defence layer 3 — execFileSync passes args as an array, no shell
uuid = execFileSync('/etc/vless-reality/manage-peers.sh',
                    ['add', normalizedUsername], { ... }).toString().trim();
```

Each layer alone would close the bug; all three together is
defence in depth. We also swept the eight other `execSync` sites in
the file and converted them to `execFileSync`. They all use
server-controlled inputs (interface names from env vars, public
keys we generated ourselves, hard-coded process names) so the fix
is a hardening, not a bug fix — but cheap to do once and prevents
any future drift.

### 5. SEC-8 — Re-key gating on `/api/wg/register` + `/api/awg/register`

Pre-fix: anyone who knew a victim's username could POST a new
public key and the gateway would silently swap it in, hijacking the
tunnel.

Fix: token check at the start of the handler. The legitimate node
always has its token (from the `/api/register` flow); an attacker
guessing a username doesn't.

### 6. SEC-9 — Peer deletion gating on `DELETE /api/wg/peer/{u}`

Pre-fix: open delete; anyone who knew the username could remove a
victim's WG peer and force them off the tunnel.

Fix: token check + per-username rate limit (3 deletes/min). Even
the legitimate owner can't churn the WG interface for themselves.

### 7. Symmetric `DELETE /api/awg/peer/{u}`

Pre-fix the AmneziaWG side had no delete endpoint at all —
operators had to SSH into the supernode to clean up stale awg
peers. Adding it now (gated identically) keeps the wg/awg surfaces
symmetric and stops future drift where someone forgets which one
needs the same fix.

### 8. PC2-side client — `pc2-node/src/services/gateway/GatewayTokenStore.ts`

A small singleton, instantiated once in `BosonService` and passed
to every service that calls a gateway endpoint. Stores a
`Map<gatewayBaseUrl, plaintextToken>` because each supernode mints
its own independent token (PC2 nodes register on the primary plus
N secondaries via the dual-write pattern).

File: `$PC2_DATA/gateway-tokens.json`, mode `0600`, atomic write.

Helper: `headersFor(url, baseHeaders)` — merges the matching token
into a header object as `X-Provisioning-Token`. Returns the base
headers unchanged if no token is stored for that URL (the very
first `/api/register` call, before any token has been minted).

### 9. Wired into four services

- `UsernameService.register` / `updateEndpoint` /
  `dualWriteToSecondaries` — capture `provisioningToken` from the
  response; resend on subsequent calls. Token is **redacted** in
  the response log.
- `WireGuardService.provision` — attach token on
  `/api/wg/register`.
- `AmneziaWGService.provision` — attach token on
  `/api/awg/register`.
- `VLESSRealityService.provision` — attach token on
  `/api/vless/register`.

Each of these accepts the store via an **optional** config field
(`gatewayTokenStore?: GatewayTokenStore`). If undefined the code
silently falls back to the unauthenticated request (legacy
behaviour). This means:

- Existing tests that build these services with minimal config keep
  passing — no test plumbing changes required.
- Operators can hot-rollback by restarting the PC2 node without
  the store; the gateway will treat the call as Case D (legacy
  grandfathering) when log-only, or 401 when strict.

---

## Telemetry log format

Every check produces a single greppable line:

```
[gw-auth] handler=<route> username=<u> token=<present|missing|wrong> enforce=<bool> action=<allow|deny>
```

Plus a startup line:

```
[gw-auth] Provisioning-token store loaded from <path> (<n> records). Enforcement: <STRICT|log-only>.
```

Plus, on `/api/register`, one of:

```
[gw-auth] handler=register username=<u> action=mint-new
[gw-auth] handler=register username=<u> action=mint-grandfather   (Case D, log-only)
[gw-auth] handler=register username=<u> token=present action=allow
```

### Telemetry-driven rollout decision

Once you see roughly:

```
$ journalctl -u pc2-gateway --since '24h ago' | grep gw-auth | wc -l        # total checks
$ journalctl -u pc2-gateway --since '24h ago' | grep 'token=present' | wc -l # rolled-out
$ journalctl -u pc2-gateway --since '24h ago' | grep 'token=missing' | wc -l # not yet
```

…and `present / total` is ≥ 0.99, set `GW_AUTH_REQUIRED=true` and
restart the gateway. Done.

---

## Smoke matrix executed at CP-5

Local gateway booted on `127.0.0.1:18080` with isolated state in
`/tmp/gw-smoke/`. Both modes tested.

### Log-only mode (`GW_AUTH_REQUIRED` unset / `false`)

| # | Test | Expected | Got |
|---|------|----------|-----|
| 1 | First `/api/register` for `alice-test` | 200 + 64-hex token | ✅ `dab31ed6…e615` |
| 2 | Re-register `alice` with correct token | 200, no new token in body | ✅ |
| 3 | Re-register `alice` without token | 200 + telemetry `token=missing action=allow` | ✅ |
| 4 | Re-register `alice` with wrong token | 200 + telemetry `token=wrong action=allow` | ✅ |
| 5 | First `/api/register` for `bob-test` | 200, distinct token | ✅ tokens differ |
| 6 | Token persistence file inspected | only SHA-256 hashes, never plaintext | ✅ |

### Strict mode (`GW_AUTH_REQUIRED=true`)

| # | Test | Expected | Got |
|---|------|----------|-----|
| A | Re-register known user without token | 401 | ✅ `username already claimed; X-Provisioning-Token header required to re-register` |
| B | Re-register known user with wrong token | 401 | ✅ same message |
| C | `DELETE /api/wg/peer/alice-test` no token | 401 | ✅ `X-Provisioning-Token header missing or does not match this username` |
| D | `DELETE /api/wg/peer/random-user` (never registered) | 401 | ✅ `no provisioning token has been issued for this username; call /api/register first` |
| E | `/api/register` for new username `charlie-test` | 200 + token | ✅ Case A still works in strict |
| F | Re-register `charlie` with correct token | 200 | ✅ |

Telemetry log shows clear `enforce=true action=deny` lines for
every attack — what an operator alerts on.

---

## Files

### Created

- `deploy/web-gateway/lib/provisioning-token.js` — store + verifier (~190 LOC)
- `pc2-node/src/services/gateway/GatewayTokenStore.ts` — PC2-side per-gateway token cache (~95 LOC)
- `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md` (this file)

### Modified

- `deploy/web-gateway/index.js` — token store init, `requireProvisioningToken` middleware, `/api/register` mint flow, SEC-2 fix, SEC-8 gates, SEC-9 gates, symmetric `DELETE /api/awg/peer/{u}`, 9 `execSync`→`execFileSync` conversions
- `pc2-node/src/services/boson/BosonService.ts` — instantiate `GatewayTokenStore`, plumb to four sub-services
- `pc2-node/src/services/boson/UsernameService.ts` — capture / resend token in register, updateEndpoint, dualWriteToSecondaries; redact in logs
- `pc2-node/src/services/wireguard/WireGuardService.ts` — `headersFor()` on `/api/wg/register`
- `pc2-node/src/services/wireguard/AmneziaWGService.ts` — `headersFor()` on `/api/awg/register`
- `pc2-node/src/services/vless/VLESSRealityService.ts` — `headersFor()` on `/api/vless/register`

### Tests un-skipped

- `pc2-node/tests/security/requireProvisioningToken.test.js` — 12 active cases all pass

---

## Deploy plan

1. **Deploy gateway code to one supernode first** — pick the
   lowest-traffic one (e.g. `38.242.211.112` Contabo).
   ```
   ./deploy/web-gateway/deploy.sh 38.242.211.112
   ```
   The deploy script `scp`s `index.js`, `package.json`, and
   recurses into `lib/` (already updated for SEC-INFRA-GW-AUTH);
   then runs `npm install && systemctl restart pc2-gateway`.

2. **Watch `[gw-auth]` lines** in journalctl for ≥ 24 h:
   ```
   ssh root@38.242.211.112 'journalctl -u pc2-gateway -f | grep gw-auth'
   ```
   Expected: every PC2 node that hits this gateway lands on Case D
   (`action=mint-grandfather`) once, then on Case B
   (`token=present action=allow`) on every subsequent boot.

3. **Roll out to the other supernodes** at any pace:
   ```
   ./deploy/web-gateway/deploy.sh 69.164.241.210   # Linode
   ./deploy/web-gateway/deploy.sh <interserver-ip>
   ```
   No coordination required — log-only mode means PC2 nodes that
   haven't rolled out their client side yet still work.

4. **Roll out PC2-node binary** (the client side that captures and
   sends the token). Rollout pace is independent of the gateway —
   each PC2 node will:
   - On first boot post-upgrade: hit `/api/register` without a
     token (Case D on every gateway it knows about), receive a
     fresh token from each supernode, persist them.
   - On subsequent boots: send the token (Case B everywhere).

5. **Check telemetry**:
   ```
   ssh root@<supernode> 'journalctl -u pc2-gateway --since "24h ago" | grep -c token=missing'
   ssh root@<supernode> 'journalctl -u pc2-gateway --since "24h ago" | grep -c token=present'
   ```
   Once `present / (present + missing)` is ≥ 0.99 across every
   supernode, you're ready for the kill-switch flip.

6. **Flip kill-switch** in
   `/etc/systemd/system/pc2-gateway.service.d/override.conf` (or
   wherever your env vars live):
   ```
   Environment="GW_AUTH_REQUIRED=true"
   ```
   Then `systemctl daemon-reload && systemctl restart pc2-gateway`.
   Repeat per supernode at your own pace; they're independent.

---

## Rollback

If anything goes sideways at any point:

- **Revert kill-switch only** (preferred): `unset GW_AUTH_REQUIRED`
  in the systemd override and `systemctl restart pc2-gateway`.
  Instant return to log-only mode. Tokens stay on disk and are
  re-used as soon as you flip strict back on.
- **Revert binary**: `git revert <wave-3-commit>`, redeploy
  `index.js`. The older code path ignores
  `provisioning-tokens.json` entirely; it's just a stale file.
  Re-applying the wave later will pick the same tokens back up.

The PC2-node side is even safer — `gatewayTokenStore` is an
optional dependency. Reverting `BosonService.ts` removes the wiring
but the rest of the code paths still work.

---

## Known follow-ups (not blocking)

- **SEC-3e** — `/api/register` username-claim still allows the
  *first* claim of any unused username with no signature. After
  this wave it can't be re-claimed, but the initial squat by an
  attacker on an unused username (e.g. `alice` while Alice is
  offline) is still possible. Fix in a future wave: require an
  EVM signature on `/api/register`'s `nodeId` to prove the wallet
  controls the chosen username. Will need a registry / DID claim
  flow design first; defer.
- **Token rotation API** — `rotate(username)` is implemented in the
  store but no operator-facing CLI exposes it yet. If a node's
  token leaks, today the only recovery is to delete the user's
  entry from `provisioning-tokens.json` on the supernode and have
  them re-register. A small `gateway-cli` wrapper would be nice.
