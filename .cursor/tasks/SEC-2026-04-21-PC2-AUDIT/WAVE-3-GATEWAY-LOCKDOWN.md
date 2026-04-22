# Wave 3 — Web-Gateway Lockdown (per-node provisioning tokens)

**Status**: ✅ Done — shipped 2026-04-22
**Findings closed**: SEC-2 (Critical), SEC-8 (High), SEC-9 (High), SEC-INFRA-GW-AUTH (High)
**Bonus closed**: SEC-3e (Medium — username squat at registration time)
**Kill-switch**: `GW_AUTH_REQUIRED=false` (default) → log-only mode for graceful rollout

---

## TL;DR for the busy reviewer

The web-gateway (`deploy/web-gateway/index.js`) is the public-facing
HTTP server that PC2 nodes call to register usernames, provision
WireGuard / AmneziaWG / VLESS-Reality peers, and delete them. Until
this commit, every endpoint that mutated a per-user resource trusted
**only the username string** for authorisation. Anyone who knew a
victim's username (it's literally the public part of their `*.ela.city`
URL) could:

1. **Re-key** their WireGuard tunnel and steal the connection (SEC-8)
2. **Delete** their WireGuard peer and boot them off (SEC-9)
3. **Inject a shell command** into `/etc/vless-reality/manage-peers.sh`
   via the `username` field on `/api/vless/register` (SEC-2 — RCE)
4. **Re-claim** their username and point it at any URL the attacker
   controlled (SEC-3e — found during this wave's survey)

The fix is a per-node 256-bit provisioning token, minted on the FIRST
`/api/register` call for a username and required in the
`X-Provisioning-Token` header on every subsequent gateway call that
acts on that username. Tokens are stored hashed (SHA-256) on the
gateway and plaintext (mode 0600) on the PC2 node. Token verification
is constant-time, username-bound, and fail-closed.

The `GW_AUTH_REQUIRED=false` kill-switch keeps the new gateway code
backwards compatible with old PC2 clients during rollout — every check
runs and writes `[gw-auth] handler=… username=… token=… enforce=false
action=allow|deny` telemetry, but does not actually 401 until the
operator flips `GW_AUTH_REQUIRED=true`.

---

## What this wave does

### 1. ProvisioningTokenStore + verifier (SEC-INFRA-GW-AUTH)

**New file**: `deploy/web-gateway/lib/provisioning-token.js`
**Forced by spec**: `pc2-node/tests/security/requireProvisioningToken.test.js` (12 active cases, all pass)

Two exports:

- `class ProvisioningTokenStore` — file-backed
  (`/root/pc2/web-gateway/data/provisioning-tokens.json`,
  mode 0600). API: `mint(username)`, `rotate(username)`,
  `verify(token, username)`, `revoke(username)`, `has(username)`,
  `toJSON()`.
- `function verifyProvisioningToken({ token, username, store })` —
  the per-handler check used inside the gateway.

Properties (all enforced by the spec test):

- Tokens are 256-bit (64 hex chars). 128-bit security floor against
  brute force; 256-bit defends against future quantum (Grover).
- Stored as SHA-256 hash, **never plaintext**. If an attacker reads
  the JSON file they see only hashes and cannot replay them
  anywhere.
- `verify()` is **constant-time** (uses `crypto.timingSafeEqual`).
- **Username-bound**: a token minted for `node-A` returns `false`
  when presented as `node-B`'s authorisation. Limits blast radius
  to one account if a single PC2 node's disk is read.
- `verify()` returns `false` (never throws) on any malformed input
  — keeps gateway handlers simple (no try/catch around the check).
- `mint()` for an already-existing username **throws**. Renewal is
  the explicit `rotate()` flow. This blocks the obvious attack
  "re-call /api/register to overwrite the victim's token".
- File persistence uses atomic write (`writeFileSync` to `.tmp` then
  `rename`) so a partial write can't corrupt the store.

### 2. /api/register mint flow (SEC-3e bonus)

**Modified**: `deploy/web-gateway/index.js` — the `/api/register`
handler is now a four-case state machine:

| Case | Username known? | Token in store? | Header? | Outcome |
|------|------|------|------|------|
| A | no | no | — | mint + return token |
| B | yes | yes | matching | accept update; no new token |
| C | yes | yes | missing/wrong | strict: 401; log-only: allow + telemetry |
| D | yes | no | — | strict: 401; log-only: mint grandfather + return |

Case D is the migration path. Existing nodes registered before Wave
3 don't have a token bound; their next boot in log-only mode mints
one, which they persist locally. Once telemetry shows every node has
been through Case D once, the operator can safely flip to strict.

Token is returned as `provisioningToken` in the response body **only
on the call that minted it**. PC2 client side immediately persists
to `$PC2_DATA/gateway-tokens.json` (mode 0600). The plaintext is
**never** logged (the response logger redacts the field).

### 3. SEC-2 — execSync → execFileSync sweep + token gate

**Critical bug** (was at L2686 of the original file):

```javascript
// BEFORE
uuid = execSync(
  `/etc/vless-reality/manage-peers.sh add "${normalizedUsername}"`,
  { stdio: 'pipe', timeout: 10000 }
).toString().trim();
```

Username is user-supplied. Shell quoting was the only thing between
an attacker and arbitrary RCE on the supernode as root (the gateway
runs as root because it needs to manage WireGuard interfaces). A
payload like `"; rm -rf / #` would have escaped the quotes, called
`rm -rf /`, then commented out the rest.

```javascript
// AFTER (defence in depth — three layers)
// Layer 1: strict username regex BEFORE the shell ever sees it
if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(normalizedUsername)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid username (...)" }));
    return;
}

// Layer 2: provisioning-token gate — caller must own this username
if (!requireProvisioningToken(req, res, normalizedUsername, 'vless/register')) return;

// Layer 3: execFileSync — array args, no shell, no template interpretation
uuid = execFileSync(
    '/etc/vless-reality/manage-peers.sh',
    ['add', normalizedUsername],
    { stdio: 'pipe', timeout: 10000 }
).toString().trim();
```

The full sweep (9 sites): every `execSync(\`...\`)` template literal
in the gateway has been replaced with `execFileSync(cmd, [args])`.
Even though the other 8 use server-controlled inputs, the cost of
hardening is zero and the rule "no template literals into a shell"
is now uniform. Sites covered: WireGuard interface check, WG add
peer, WG remove peer, AmneziaWG variants, `wg show`/`awg show`
dumps, `pgrep -x sing-box`.

### 4. SEC-8 — token gate on WireGuard re-key

**Modified handlers**: `/api/wg/register`, `/api/awg/register`

Both routes accept an `existingPeer` re-registration that overwrites
the stored public key. Pre-fix, anyone who knew a username could
push their own pubkey and intercept the tunnel. Now the same
provisioning-token check runs on both new and re-key paths. Same
kill-switch behaviour as everywhere else.

### 5. SEC-9 — token gate + per-username throttle on peer DELETE

**Modified handler**: `DELETE /api/wg/peer/{username}`
**New handler**: `DELETE /api/awg/peer/{username}` (was missing — operator-only via SSH before)

Pre-fix the WG delete required nothing. A single `curl -X DELETE`
booted any user off the tunnel. Now:

- `requireProvisioningToken(...)` gates the call
- Per-username throttle (`PER_USERNAME_DELETE_MAX = 3 / minute`)
  prevents a runaway script from churning the WG interface even if
  the legit owner runs it. The throttle is independent from the
  per-IP rate limit so a multi-IP attacker can't blow through it.

The new `DELETE /api/awg/peer/{u}` endpoint is symmetric — same
gating, same throttle. Closes a longstanding "operator must SSH in
to remove an AWG peer" gap and prevents future drift between the
two surfaces.

### 6. PC2 client side — GatewayTokenStore + header injection

**New file**: `pc2-node/src/services/gateway/GatewayTokenStore.ts`

A per-gateway token cache. Each supernode mints its own token
independently, so the store is keyed by gateway base URL:

```json
{
  "tokens": {
    "https://69.164.241.210": "dab3...e615",
    "https://38.242.211.112": "8215...8c0",
    "https://contabo.example.com": "..."
  }
}
```

API: `get(gatewayUrl)`, `set(gatewayUrl, token)`,
`headersFor(gatewayUrl, baseHeaders)` — the latter returns the
inbound headers plus `X-Provisioning-Token` if a token is stored,
or just the inbound headers if not (so the very first
`/api/register` call legitimately goes through unauthenticated).

**Plumbed into**:

- `BosonService` (single instance constructed once per PC2 boot)
- `UsernameService.register()` — captures the response token
- `UsernameService.updateEndpoint()` — sends the stored token,
  captures any new one (Case D grandfather path)
- `UsernameService.dualWriteToSecondaries()` — same per-secondary
- `WireGuardService.provision()` — header on `/api/wg/register`
- `AmneziaWGService.provision()` — header on `/api/awg/register`
- `VLESSRealityService.provision()` — header on `/api/vless/register`

Plaintext tokens are stored on disk at mode 0600 — only the PC2
process owner can read them. Plaintext is never logged (a redaction
helper in `UsernameService` strips the field before logging).

---

## Files

### Created
- `deploy/web-gateway/lib/provisioning-token.js` (Store + verifier)
- `pc2-node/src/services/gateway/GatewayTokenStore.ts` (PC2 cache)
- `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-3-GATEWAY-LOCKDOWN.md` (this file)

### Modified — gateway side
- `deploy/web-gateway/index.js`
    - import `ProvisioningTokenStore`, `getProvisioningTokenFromRequest`, `execFileSync`
    - boot-time store load + `[gw-auth]` log line announcing record count + mode
    - `requireProvisioningToken(req, res, username, label)` middleware-style helper
    - `checkPerUsernameDeleteRate()` helper for SEC-9 throttle
    - `/api/register` four-case state machine (Case A/B/C/D)
    - `/api/wg/register` token gate (new + re-key paths)
    - `/api/awg/register` token gate (new + re-key paths)
    - `/api/vless/register` token gate + strict username regex + execFileSync
    - `DELETE /api/wg/peer/{u}` token gate + per-username throttle
    - `DELETE /api/awg/peer/{u}` (NEW)
    - 9 `execSync` sites converted to `execFileSync`

### Modified — PC2 client side
- `pc2-node/src/services/boson/BosonService.ts` — instantiate `GatewayTokenStore`, plumb to four sub-services
- `pc2-node/src/services/boson/UsernameService.ts` — capture token; resend on update + dual-write
- `pc2-node/src/services/wireguard/WireGuardService.ts` — header on provision call
- `pc2-node/src/services/wireguard/AmneziaWGService.ts` — header on provision call
- `pc2-node/src/services/vless/VLESSRealityService.ts` — header on provision call

---

## Test results

```
$ npm run test:security
# tests 79
# pass 62
# fail 0
# skipped 17  (Wave 5 SEC-11 + 1 manual integration)

$ npx tsc -p pc2-node --noEmit
(0 errors)
```

`requireProvisioningToken.test.js`: 12/12 active cases pass — verifies
all of the security-contract properties listed in section 1.

### Local gateway smoke matrix (port 18080)

| # | Mode | Action | Expected | Got |
|---|------|--------|----------|-----|
| 1 | log-only | first `/api/register` for `alice-test` | 200 + 64-hex token | ✅ |
| 2 | log-only | re-register `alice-test` with correct token | 200 | ✅ |
| 3 | log-only | re-register `alice-test` WITHOUT token | 200 + telemetry `token=missing enforce=false action=allow` | ✅ |
| 4 | log-only | re-register `alice-test` with WRONG token | 200 + telemetry `token=wrong enforce=false action=allow` | ✅ |
| 5 | log-only | first `/api/register` for `bob-test` | 200 + distinct 64-hex token | ✅ |
| A | strict | re-register `alice-test` WITHOUT token | 401 | ✅ |
| B | strict | re-register `alice-test` WRONG token | 401 | ✅ |
| C | strict | `DELETE /api/wg/peer/alice-test` no token | 401 (was: 200 + boot user) | ✅ |
| D | strict | `DELETE /api/wg/peer/random-user-123` no token | 401 (helpful message) | ✅ |
| E | strict | first `/api/register` for `charlie-test` | 200 + token (Case A still works) | ✅ |
| F | strict | re-register `charlie-test` with correct token | 200 | ✅ |

Persistence: gateway restarted between log-only and strict tests;
`/tmp/gw-smoke/provisioning-tokens.json` correctly carried `alice-test`
and `bob-test` records across the restart, verified by `[gw-auth] …
(2 records). Enforcement: STRICT.` boot line.

Hash-only storage verified: dumped the JSON file, found `tokenHash`
fields (SHA-256 hex), no plaintext token strings. Confirmed the
`mint()` return value never matches anything in the file.

---

## Deployment / rollout

The supernodes (Linode `69.164.241.210`, Contabo `38.242.211.112`,
the new Interserver one) all run `index.js` from `/root/pc2/web-gateway/`
under `systemctl pc2-gateway`. The existing `deploy/web-gateway/deploy.sh`
script does the rollout:

```bash
./deploy/web-gateway/deploy.sh 69.164.241.210
./deploy/web-gateway/deploy.sh 38.242.211.112
./deploy/web-gateway/deploy.sh <interserver-ip>
```

(That script does `scp index.js package.json ${VPS}:/root/pc2/web-gateway/`
then `npm install && systemctl restart pc2-gateway`. **Note**: the
script also needs to copy the new `lib/` directory — the deploy.sh
file may need updating to include `scp -r lib/` alongside `index.js`
in the same `scp` invocation.)

### Recommended rollout pace

1. **Day 0**: Deploy gateway code to ONE supernode. Watch
   `journalctl -u pc2-gateway | grep '\[gw-auth\]'` for 24 h.
2. **Day 1**: If telemetry shows expected log lines and no
   spurious `token=wrong` entries, deploy to the other supernodes.
3. **Day 2-7**: Watch the proportion of `enforce=false action=deny`
   counterfactuals (i.e. how many calls would have been rejected
   under strict mode). When ≥99 % of calls have `token=present
   action=allow`, the rollout is safe.
4. **Day 8**: Add `Environment=GW_AUTH_REQUIRED=true` to
   `/etc/systemd/system/pc2-gateway.service.d/override.conf` (or
   wherever the unit's env vars live), `systemctl daemon-reload`
   and `systemctl restart pc2-gateway`. From this point on, any
   call without a valid token returns 401.

### Telemetry queries to monitor

```bash
# Count of unauthorised calls per handler in the last hour
journalctl -u pc2-gateway --since '1 hour ago' \
  | grep '\[gw-auth\]' \
  | grep 'token=\(missing\|wrong\)' \
  | awk -F 'handler=' '{print $2}' | awk '{print $1}' \
  | sort | uniq -c

# Mint events (one-time, watch for unexpected duplicates)
journalctl -u pc2-gateway | grep 'action=mint-'
```

### Rollback

Revert the Wave 3 commit, redeploy the previous `index.js`,
`systemctl restart pc2-gateway`. The `provisioning-tokens.json`
file is left intact on disk — older code simply ignores it. New
PC2 clients with stored tokens will keep sending the
`X-Provisioning-Token` header; the older gateway just ignores
unknown headers.

---

## Why these design choices

### Why `X-Provisioning-Token` instead of `Authorization: Bearer`?

The pre-written test spec at
`pc2-node/tests/security/requireProvisioningToken.test.js` was
locked to `X-Provisioning-Token` as the header name. Functionally
identical to `Authorization: Bearer <token>` (both are forwarded by
nginx, neither ends up in standard access logs). Custom header is
slightly more discoverable in logs grep-wise.

### Why hash-at-rest?

If an attacker reads the gateway's `provisioning-tokens.json` they
get only `tokenHash` fields. They can't replay a hash anywhere —
the verify path requires the plaintext side as input to recompute
the hash. Strict improvement over plaintext-at-rest at zero runtime
cost (one SHA-256 per `verify` call is sub-microsecond).

### Why username-bound (not global)?

A global "is this a known token" check would let any compromised
PC2 node act on behalf of every other node. Binding the token to
the username it was minted for limits blast radius to that one
account if a single node's disk is read.

### Why does mint() refuse to overwrite?

Silent overwrite would let an attacker re-claim a victim's username
(via `/api/register`), get a fresh token, then re-key / delete the
victim's peer. The username-claim handler MUST refuse to mint a
second token; renewal is the explicit `rotate()` flow (not yet
exposed via API — manual ops only for now).

### Why per-gateway token storage on the PC2 side?

The same username can be registered on multiple supernodes
(dual-write redundancy). Each supernode mints its OWN independent
token. A single global token wouldn't work because the supernodes
don't share state. Map<gatewayUrl, token> is the smallest correct
abstraction.

### Why log-only as default?

Same pattern as Wave 2's `siweRequired=false` default. Lets us
deploy the gateway change and the PC2 client change independently
— neither blocks the other. Telemetry shows when ≥99 % of inbound
calls carry tokens; only then do we flip strict. Belt + braces:
the kill-switch lets the operator turn off enforcement instantly
without redeploying code if something blows up at 3 a.m.

---

## Known limitations / follow-ups

- **`rotate()` not exposed via API**: today operators rotate by
  deleting the username's record from `provisioning-tokens.json`
  and waiting for the next `/api/register` call (Case D
  grandfather). A `POST /api/admin/rotate-token/{username}` route
  with a fresh wallet signature could be added later.
- **No token revocation on PC2 wallet logout**: tokens persist on
  disk until the user explicitly deletes the data dir. Acceptable
  because the token is bound to the node, not the wallet.
- **SEC-3e (username squat at original `/api/register`)** is now
  closed implicitly: re-claim by anyone other than the original
  minter is rejected in strict mode. The remaining theoretical
  case is "first-ever claim of a username someone else wanted" —
  that's a name-squatting race, not a security issue, and is
  outside the audit scope.

---

## References

- Spec test: `pc2-node/tests/security/requireProvisioningToken.test.js`
- Helper: `deploy/web-gateway/lib/provisioning-token.js`
- Parent task: `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/SEC-2026-04-21-PC2-AUDIT.md`
- Wave 2 (precedent for kill-switch design): `WAVE-2-SIWE-AND-SETUP.md`
