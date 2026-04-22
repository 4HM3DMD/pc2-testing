# Design: Lit Action Signature-Based Buyer Authentication

**Task**: LIT-ACTION-SIGNATURE-AUTH
**Author**: PC2 engineering (captured 2026-04-17 from V1.2 pre-release call; revised 2026-04-17 for session-key UX)
**Status**: Design only — no code changes yet
**Scope**: `non-media-decrypt.js`, `media-decrypt.js`, `/lit/secure-view`,
`chipotle-client.ts`, dDRM viewer and Creator test apps.
**Pattern chosen**: **Option C — Session Key Delegation** (one wallet
prompt per connection, ephemeral device key signs all subsequent
requests; see Section 9 for why we rejected per-asset and per-session
signing).

---

## 1. Current State (Vulnerable)

### 1.1 The access-control chain

```
┌──────────────┐   session auth   ┌──────────────────────┐   jsParams   ┌──────────────┐  eth_call  ┌──────────────────┐
│ dDRM Viewer  │ ───────────────▶ │ PC2 /lit/secure-view │ ───────────▶ │  Lit Action  │ ─────────▶ │ AuthorityGateway │
│  (client)    │                  │  (server-side)       │              │  (on Lit     │            │  hasAccessBy-    │
│              │                  │                      │              │   nodes/TEE) │            │  ContentId()     │
└──────────────┘                  └──────────────────────┘              └──────────────┘            └──────────────────┘
        ▲                                      │                               │
        │                                      │                               │
        │ buyer session cookie                 │ buyerAddress derived from     │ userAddress taken
        │ (PC2 local account)                  │ authenticated session         │ verbatim from jsParams
        │                                      │                               │ (← THE HOLE)
        └──────────────────────────────────────┘                               │
                                                                               ▼
                                                                    CEK released if holder has
                                                                    AccessToken for kid
```

### 1.2 Why the chain breaks

The left-most and middle boxes look fine — PC2 authenticates its own
user, derives `buyerAddress` from the session, passes it into
`jsParams.userAddress`.

But the **right-most box** (the Lit Action) trusts any
`userAddress` it receives. Because:

- The action is loaded via `ipfsId` — it's immutable, public, pinned.
- Any Lit-compatible client (an attacker's own PC2 node, a custom
  Chipotle REST call, a script against a local Lit node) can invoke
  the action with arbitrary `jsParams`.
- There's no check that the caller *is* `userAddress`; they just have
  to *name* an authorized address.

The attacker only needs the public `(ciphertext, dataToEncryptHash,
kid, actionIpfsId)` tuple (all pinned alongside the encrypted asset)
plus **one** known authorized buyer's address (pullable from
`AccessTokenMinted` events on Base).

### 1.3 Concrete exploit (25-line Node script)

```js
// exploit-nonmedia.js — DO NOT SHIP. Proves the vulnerability.
import { LitNodeClient } from '@lit-protocol/lit-node-client';

const client = new LitNodeClient({ litNetwork: 'datil' });
await client.connect();

// All pulled from IPFS / on-chain events — public info.
const jsParams = {
  ciphertext:      '<pinned ciphertext>',
  dataToEncryptHash: '<pinned hash>',
  kid:             '0x<pinned kid>',
  actionIpfsId:    '<pinned action CID>',
  authority:       '0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29',
  chain:           'base',
  rpc:             'https://mainnet.base.org',
  userAddress:     '<any address observed buying this asset>',
};

const result = await client.executeJs({
  ipfsId: jsParams.actionIpfsId,
  jsParams,
  sessionSigs: /* any valid session sigs */,
});

console.log('CEK:', result.response); // ← attacker now decrypts
```

This is the exact pattern `pc2-node/src/api/storage.ts` line 1660-1674
runs internally. The difference is the attacker supplies *someone
else's* address.

### 1.4 The access-token / wallet duality we must preserve

PC2 already handles the "was this bought with my EOA or my Particle
smart account?" case. See `pc2-node/src/api/storage.ts` L2084-L2109:

- `buyerAddress` = EOA from session.
- `buyerAddressAlt` = Particle smart account (if any).
- Server preflights both via `hasAccessByContentId(...)` and picks
  whichever holds the AccessToken before calling Lit.

Any fix must keep this working — users who paid through their smart
account must continue to read without a second wallet.

---

## 2. Target State (Session Key Delegation)

### 2.1 Two signatures, one wallet prompt

```
┌───────────────────────────────────────────────────────────────────────┐
│ One-time, at wallet connect:                                          │
│                                                                       │
│   User's EOA ──signs──▶ "I authorize ephemeral key 0xEPH to decrypt   │
│                          dDRM content I own, for 24h, across          │
│                          addresses [EOA, SmartAccount]"               │
│                                                                       │
│   Ephemeral keypair generated in-browser via Web Crypto,              │
│   private key non-extractable.                                        │
└───────────────────────────────────────────────────────────────────────┘
                                │
                                │  (saved in browser for the session)
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Every asset open, silently (no popup):                                │
│                                                                       │
│   Ephemeral key ──signs──▶ "secure-view for kid=X, at T, nonce=N"     │
│                                                                       │
│   PC2 forwards { delegation, delegationSig, request, requestSig }     │
│   to the Lit Action.                                                  │
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Lit Action verifies:                                                  │
│   1. delegationSig was signed by delegation.ownerAddress              │
│      (EIP-191 for EOAs, EIP-1271 for contract wallets)                │
│   2. requestSig was signed by delegation.sessionPublicKey             │
│   3. request.kid matches, request.requestedAt within delegation's     │
│      valid window                                                     │
│   4. For at least one addr in delegation.coveredAddresses:            │
│      hasAccessByContentId(addr, kid) === true                         │
│   → release CEK                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

Key property: the attacker cannot produce either signature without
(a) the user's wallet key, AND (b) the user's device-bound non-
extractable ephemeral key. Neither is obtainable remotely.

### 2.2 The `SecureViewDelegation` message (signed once)

```ts
interface SecureViewDelegation {
  /** Binds to our product. Prevents cross-app reuse. */
  domain: 'pc2.secure-view.v1';

  /** Binds to the chain. Prevents cross-chain replay. */
  chainId: 8453; // Base

  /** Binds to the specific Lit Action version. Repin → new CID → */
  /** old delegations invalid. */
  actionIpfsId: string;

  /** The wallet that signed this delegation. For EOAs, this is the */
  /** address recoverable from the signature. For smart accounts */
  /** (EIP-1271), this is the contract address and we verify via */
  /** IERC1271.isValidSignature. */
  ownerAddress: `0x${string}`;

  /** Addresses this session is allowed to decrypt content for. */
  /** Typically [ownerAddress, particleSmartAccountAddress]. The Lit */
  /** Action runs hasAccessByContentId for each; any "true" → release. */
  coveredAddresses: `0x${string}`[];

  /** The ephemeral public key that will sign per-request payloads. */
  /** Hex of the uncompressed SEC1-encoded public key (P-256 / */
  /** secp256r1). Curve chosen in Phase 1 spike — K-256 is not */
  /** available in Chromium/Firefox/WebKit. See §10.2. */
  sessionPublicKey: `0x${string}`;

  /** Replay window for the whole session. */
  issuedAt: number;  // unix seconds
  expiresAt: number; // unix seconds — max 24h beyond issuedAt

  /** Random bytes. Single-use inside the window; server stores in */
  /** a revocation list until expiry. */
  nonce: `0x${string}`; // 16 bytes hex
}
```

Canonical form: `JSON.stringify(Object.fromEntries(Object.keys(d).sort().map(k => [k, d[k]])))`.

### 2.3 The `SecureViewRequest` message (signed per open)

```ts
interface SecureViewRequest {
  domain: 'pc2.secure-view.request.v1';
  kid: `0x${string}`;          // must match the secure-view kid
  actionIpfsId: string;         // must match delegation.actionIpfsId
  requestedAt: number;          // unix seconds; rejected if abs(now - requestedAt) > 60
  requestNonce: `0x${string}`;  // 8 bytes hex, fresh per request
}
```

Signed with the ephemeral key (secp256k1 ECDSA), same canonical-JSON
rule as the delegation.

### 2.4 Signing rules

- **Delegation**:
  - EOA path — EIP-191 `personal_sign` over canonical JSON. Recovered
    via `ethers.verifyMessage(canonical, sig)` inside the Lit Action.
  - Smart-account path (EIP-1271) — same canonical bytes; the Lit
    Action calls `IERC1271.isValidSignature(hash, sig)` on
    `ownerAddress` and checks for magic return value `0x1626ba7e`.
  - In practice for Particle users, the EOA that owns the smart
    account signs, and we list both addresses in `coveredAddresses`.
    EIP-1271 is only needed for third-party contract wallets (e.g.,
    Gnosis Safe) where there's no single EOA signer.
- **Per-request**:
  - Web Crypto ECDSA signature over canonical JSON of
    `SecureViewRequest`, using **P-256 (secp256r1)** — the curve
    locked in Phase 1 §10.2.
  - Verified inside the Lit Action via `crypto.subtle.verify(...)`
    against `delegation.sessionPublicKey`.

### 2.5 EOA vs smart account — explicit matrix

| Scenario | Signs delegation with | `ownerAddress` | `coveredAddresses` | Works? |
|---|---|---|---|---|
| Only EOA exists, owns AccessToken | EOA | EOA | `[EOA]` | ✅ |
| Particle user, AccessToken on smart account | EOA (controls the smart account) | EOA | `[EOA, SmartAccount]` → matches on SmartAccount | ✅ |
| Particle user, AccessToken on EOA | EOA | EOA | `[EOA, SmartAccount]` → matches on EOA | ✅ |
| User changed wallets; old EOA bought; still has old EOA keys | Old EOA | Old EOA | `[OldEOA, maybe NewSmartAccount]` | ✅ |
| Third-party contract wallet (Gnosis Safe) with no single EOA | Via Safe's EIP-1271 | Safe address | `[SafeAddress]` | ✅ (EIP-1271 branch) |
| Attacker with public info only, no wallet access | Cannot sign | — | — | ❌ (this is the bug) |
| Attacker has leaked `delegationSig` but not ephemeral key | Cannot sign per-request | — | — | ❌ |
| Attacker has leaked ephemeral key bytes (claimed impossible: non-extractable) | Missing delegation | — | — | ❌ |

Every legitimate scenario works. Every attacker scenario fails.

### 2.6 Server-side plumbing

`POST /api/storage/lit/secure-view` body gains:

```ts
interface SecureViewRequestBody {
  // existing fields: litCiphertext, dataToEncryptHash, iv,
  // encryptedDataCid, kid, mimeType, page, chapter, viewportWidth, …

  delegation: string;       // canonical JSON of SecureViewDelegation
  delegationSig: `0x${string}`;
  request: string;          // canonical JSON of SecureViewRequest
  requestSig: `0x${string}`;
}
```

Flow through `recoverCEKAndFetchData` (storage.ts line 1596):

1. Existing session-auth middleware still runs. `req.user.wallet_address`
   and `req.user.smart_account_address` are sanity-checked against
   `delegation.ownerAddress` and `delegation.coveredAddresses` (they
   must intersect; any mismatch → 401 before spending a Lit call).
2. **Server-side defence-in-depth** (not a replacement for Lit Action
   checks, but saves Lit calls on obvious failures):
   - Parse delegation; verify `domain`, `chainId`, `actionIpfsId`.
   - Check `delegation.expiresAt > now` and `expiresAt - issuedAt <= 24h`.
   - Parse request; verify `request.kid === req.body.kid` and
     `abs(now - request.requestedAt) <= 60`.
   - Verify `delegationSig` via `ethers.verifyMessage` for EOA path;
     for EIP-1271 owners, call `isValidSignature` via RPC.
   - Verify `requestSig` via `crypto.subtle.verify` against
     `delegation.sessionPublicKey`.
   - Check anti-replay cache: `(delegation.nonce, request.requestNonce)`
     not previously seen.
   - Check revocation list: `delegation.nonce` not on the server's
     revoke set.
3. Only then call the Lit Action with
   `jsParams: { delegation, delegationSig, request, requestSig, kid,
   actionIpfsId, authority, chain, rpc, ciphertext, dataToEncryptHash }`.
   **`userAddress` is removed from `jsParams` entirely.**

### 2.7 Lit Action pseudocode (non-media)

```js
// non-media-decrypt.js (post-fix)
(async () => {
  const del = JSON.parse(delegation);
  const req = JSON.parse(request);

  // ── Structural checks ──
  if (del.domain !== 'pc2.secure-view.v1')          return fail('bad_domain');
  if (del.chainId !== 8453)                          return fail('bad_chain');
  if (del.actionIpfsId !== actionIpfsId)             return fail('bad_action_cid');
  if (req.domain !== 'pc2.secure-view.request.v1')  return fail('bad_req_domain');
  if (req.actionIpfsId !== actionIpfsId)             return fail('bad_req_action_cid');
  if (req.kid.toLowerCase() !==
      (kid.startsWith('0x') ? kid : '0x' + kid).toLowerCase())
                                                     return fail('bad_req_kid');

  const now = Math.floor(Date.now() / 1000);
  if (now < del.issuedAt - 5)                        return fail('del_not_yet_valid');
  if (now > del.expiresAt)                           return fail('del_expired');
  if (del.expiresAt - del.issuedAt > 24 * 3600)     return fail('del_window_too_wide');
  if (Math.abs(now - req.requestedAt) > 60)         return fail('req_stale_or_future');

  // ── Delegation signature (EOA or EIP-1271) ──
  const delCanonical = canonicalize(del);
  let delOk = false;
  try {
    const recovered = (ethers.utils || ethers).verifyMessage(delCanonical, delegationSig);
    delOk = toChecksum(recovered) === toChecksum(del.ownerAddress);
  } catch { /* might be EIP-1271 */ }

  if (!delOk) {
    // EIP-1271 path for contract wallets
    delOk = await isValidSignatureEip1271(
      del.ownerAddress, delCanonical, delegationSig, rpc
    );
    if (!delOk) return fail('del_sig_invalid');
  }

  // ── Per-request signature (ephemeral key, Web Crypto) ──
  const reqCanonical = canonicalize(req);
  const reqOk = await verifyWebCryptoSig(
    del.sessionPublicKey, reqCanonical, requestSig
  );
  if (!reqOk) return fail('req_sig_invalid');

  // ── Access check across ALL covered addresses ──
  const provider = ethers.providers
    ? new ethers.providers.JsonRpcProvider(rpc)
    : new ethers.JsonRpcProvider(rpc);
  const gateway = new ethers.Contract(toChecksum(authority), ABI, provider);
  const normalizedKid = kid.startsWith('0x') ? kid : '0x' + kid;

  let hasAccess = false;
  for (const addr of del.coveredAddresses) {
    try {
      const ok = await gateway.hasAccessByContentId(toChecksum(addr), normalizedKid);
      if (ok) { hasAccess = true; break; }
    } catch { /* keep trying next */ }
  }
  if (!hasAccess) return fail('access_denied');

  // ── Decrypt CEK via existing self-referential ACC ──
  const cek = await Lit.Actions.decryptAndCombine({ /* ...unchanged... */ });
  Lit.Actions.setResponse({ response: cek });
})();
```

`verifyWebCryptoSig` is a small helper using
`crypto.subtle.importKey('raw', sessionPubBytes, { name: 'ECDSA',
namedCurve: 'P-256' }, false, ['verify'])` then
`crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub,
sigBytes, canonicalBytes)`.

`isValidSignatureEip1271` is a provider.call to the owner contract's
`isValidSignature(bytes32, bytes)` method, checking for the magic
`0x1626ba7e` return value.

### 2.8 What's removed

- `jsParams.userAddress` — completely. Any old client that still sends
  it has that field ignored; the action only reads from the signed
  delegation.
- The server's unconditional `userAddress: buyerAddress` inclusion in
  `jsParams`.

### 2.9 What's unchanged

- **CEK cache** (storage.ts line 1613 `getCachedCEK`) — still keyed
  by `(kid, buyerAddress)`, where `buyerAddress` is now the first
  `coveredAddress` with `hasAccessByContentId === true`. A 15-chapter
  EPUB still pays one Lit call. All subsequent chapters hit the
  cache.
- **Promise coalescing** (line 1625) — unchanged.
- **Rate limiter** (line 2116) — unchanged.
- The self-referential `:currentActionIpfsId` access-control condition
  at encrypt time — unchanged. Session-key auth is **additive** to
  that existing check.
- Existing PC2 session-auth (middleware) — unchanged. Stops
  unauthenticated PC2 users from calling the endpoint at all.

---

## 3. Client-Side UX

### 3.1 Session lifecycle

```
Wallet connect ──────────────────────────────────▶ 1 wallet prompt
  │
  │ on sign:
  │   - Ephemeral keypair generated (non-extractable)
  │   - Delegation signed, stored locally
  │   - Session indicator shows "🔒 dDRM session · 24h"
  │
  ▼
Asset open × N ──────────────────────────────────▶ 0 prompts
  │
  │ per open:
  │   - Fresh requestNonce
  │   - Ephemeral key signs SecureViewRequest
  │   - POST { delegation, delegationSig, request, requestSig }
  │
  ▼
"Sign out" button ──────────────────────────────▶ 0 prompts
  │
  │ on click:
  │   - Ephemeral key wiped from IndexedDB
  │   - Delegation sent to PC2 for revocation (nonce blacklisted)
  │   - Session indicator clears
  │
  ▼
After 24h of inactivity ─────────────────────────▶ 1 prompt to re-auth
```

### 3.2 Ephemeral key: Web Crypto non-extractable

```ts
// pc2-node/data/test-apps/shared/secure-view-session.js
async function createEphemeralKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'K-256' /* secp256k1 */ },
    /* extractable */ false,
    ['sign']
  );
  // Public key IS extractable (we need to embed it in the delegation)
  const pubBytes = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,              // non-extractable; lives only in WebCrypto
    publicKeyHex: '0x' + toHex(new Uint8Array(pubBytes)),
  };
}
```

Storage: the `privateKey` CryptoKey object is stored in IndexedDB
under `pc2.secure-view.sessionKey`. IndexedDB supports storing
CryptoKey objects directly — browsers serialise them but the private
key bits stay inside the browser's crypto boundary and never surface
to JS as bytes.

Implication: even a successful XSS cannot exfiltrate the private
key. It can still *use* the key to sign while the page is live (this
is the residual risk documented in `SECURITY.md`), but the key itself
can't leave the device.

### 3.3 The delegation prompt (user-facing)

What the user sees in their wallet:

```
Sign this message:

  PC2 dDRM Session Authorization

  I authorize PC2 to decrypt dDRM content I own, for 24 hours.

  Wallet:         0xABCd…1234 (my EOA)
  Also includes:  0x5678…90ab (my smart account)
  Session key:    0xEPH…4F5C (device-only; cannot move funds)
  Expires:        2026-04-20 15:04 UTC
  Nonce:          0xdeadbeef…

  Note: This signature does NOT authorize any token transfers,
  approvals, or contract calls.
```

The message is crafted to be human-readable. The JSON under the hood
is the canonical form; the wallet's "human readable" view is
generated by `personal_sign` of the plain-English text (EIP-191
prefix handles the hashing).

We'll ship a short video in docs showing the flow, and the **PC2 UI
clearly explains what's happening** with a banner above the prompt
saying "Sign once — view any asset you own for 24 hours."

### 3.4 Session indicator + sign-out

A small badge in the dDRM viewer UI:

```
┌────────────────────────────┐
│ 🔒 dDRM session · 23h 42m │  [Sign out]
└────────────────────────────┘
```

Click "Sign out" → ephemeral key wiped, delegation revoked via
`POST /api/storage/lit/revoke-session`.

### 3.5 Particle smart-account buyers

Particle Auth already wraps `personal_sign` in a way MetaMask-style
flows recognise. The EOA owner of the smart account signs the
delegation; the smart account is listed in `coveredAddresses`. The
access check inside the Lit Action tries each listed address in turn
and releases the CEK on the first match. **No separate prompt, no
EIP-1271 round-trip in the common case.**

EIP-1271 only fires for genuinely EOA-less wallets (Gnosis Safe with
multiple signers, etc.). Not a concern for 99% of PC2 users today.

### 3.6 Why not SIWE?

SIWE is a great format for long-lived *login* sessions. The message
format is perfect for that case. We *could* reshape our delegation as
a SIWE message with custom `Resources:` URIs encoding
`coveredAddresses` and `sessionPublicKey`. Reasons we didn't:

- SIWE's human-readable format is verbose; our narrower message is
  easier to show plainly in a wallet prompt.
- SIWE signature verification inside the Lit Action would mean
  parsing SIWE inside the action — more code, more attack surface.
- Our delegation is specifically a *key delegation*, not a *login
  grant*. SIWE doesn't have a first-class slot for "here's my
  ephemeral signing key."

If an external auditor prefers SIWE, we can re-cast the delegation as
a SIWE message without changing the security properties. Happy to
revisit if it makes sense for interoperability with other apps.

---

## 4. Server-Side Flow (PC2)

### 4.1 New endpoints

- `POST /api/storage/lit/begin-session` — server generates the
  canonical delegation fields (nonce, timestamps, actionIpfsId,
  coveredAddresses derived from session auth) and returns the
  payload the client should sign. **The server never handles the
  ephemeral private key.**
- `POST /api/storage/lit/complete-session` — client returns
  `{ delegation, delegationSig, sessionPublicKey }`; server verifies
  the signature, stores `(sessionPublicKey, ownerAddress, nonce,
  expiresAt)` in its in-memory session table, returns `{ ok: true,
  sessionId }`.
- `POST /api/storage/lit/secure-view` — existing endpoint, now
  accepts the delegation fields as in Section 2.6.
- `POST /api/storage/lit/revoke-session` — called on sign-out; adds
  `delegation.nonce` to the server's revocation list until expiry.

### 4.2 Revocation list

```ts
// Map<delegationNonce, expiresAt>; expiredcleaned up by a timer.
const revokedDelegations = new Map<string, number>();
```

Caveat: this protects calls that go through PC2. An attacker with a
stolen delegation + ephemeral key could call Lit directly, bypassing
PC2's revocation check. That's why we lean so heavily on the
ephemeral key being **non-extractable** (Section 3.2) — stealing the
key bytes isn't feasible, so there's nothing to use off-device.

The combination (non-extractable key + server revocation) means the
only attack that remains is "XSS while user is actively logged in"
which is the common web-auth risk. See `SECURITY.md`.

### 4.3 Anti-replay cache

```ts
// Map<`${delegationNonce}:${requestNonce}`, expiresAt>
const seenRequestNonces = new Map<string, number>();
```

Every incoming secure-view request adds its `(delNonce, reqNonce)`
pair here. Duplicates → 401. TTL is the delegation's `expiresAt`.
Cleaned up periodically.

---

## 5. Rollout Plan

### Day 0 — spec (this file + `SECURITY.md`)

Done. User reviews. No code touched.

### Day 1 — Particle spike (half day)

Goal: answer three questions with a small throwaway prototype.

1. Can the Particle SDK produce a valid EIP-191 signature over our
   canonical JSON that `ethers.verifyMessage` recovers correctly?
2. Does the Particle smart account's `isValidSignature` method work
   as expected when called from our RPC?
3. Do non-extractable secp256k1 keys work reliably in Chrome,
   Firefox, Safari, and Particle's embedded browser session?

Output: a short memo attached to this design doc saying "yes / yes
with caveat / no" to each question.

### Day 2 — implementation (1 full day)

1. Build `pc2-node/src/utils/secureViewSession.ts` (server-side
   helpers: generate delegation payload, verify signatures, revocation
   list, anti-replay cache).
2. Build `pc2-node/data/test-apps/shared/secure-view-session.js`
   (client-side helpers: ephemeral key generate/store, delegation
   sign, request sign, session indicator).
3. Wire `/lit/secure-view` to accept and forward the new fields.
4. Rewrite both Lit Actions (non-media + media).
5. Pin new action bundles; capture new CIDs.

### Day 3 — test (1 day)

1. Exploit script against *old* action CID — confirm CEK release
   (captured evidence for the post-mortem).
2. Same script against *new* action CID — confirm
   `del_sig_invalid` rejection.
3. Positive tests: EOA-only buyer, Particle smart-account buyer,
   three assets opened in sequence with one delegation, 15-chapter
   EPUB pays one Lit call.
4. Negative tests: expired delegation, mismatched-kid request,
   mismatched-action-CID delegation, replayed request nonce, sign-out
   followed by replayed delegation.
5. Cross-browser: Chrome, Firefox, Safari, Particle embedded.

### Day 4 — docs + PR (half day)

1. Update `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` Section 4.
2. Lift the "Known Security Issue" banner from the same file.
3. Update `docs/core/LIT_CHIPOTLE_MIGRATION.md` with new action CIDs.
4. Short Discord/Discussion post summarising the fix.
5. PR review, merge.

### Total: ~3.5 calendar days dev + test + docs

### Rollback

Both old and new action CIDs pinned for 14 days. Env-only rollback
(`NON_MEDIA_ACTION_CID`, `MEDIA_ACTION_CID` revert) reverts the fix
*and* re-opens the bug; only usable as an emergency lever while a
remediation plan is agreed. In practice we don't expect to need it —
the fix is additive and has defence-in-depth layered server-side.

---

## 6. Non-Goals

- Replacing the whole Lit session-sigs flow.
- Moving off Chipotle.
- Changing how the CEK is stored, cached, or evicted.
- Any change to encryption-time flow. Already-minted assets stay
  accessible; their ACC still points at an action CID and the only
  change is which CID is pinned.
- Hardware-key / secure-enclave backing for the ephemeral key (worth
  doing eventually; not in V1.2 scope).

---

## 7. Open Questions

1. **Do we force migration of existing minted assets?** Old assets
   point at the old (vulnerable) action CID via the encrypt-time ACC.
   We cannot retroactively rebind. Options:
   - (a) Leave old mints pointing at old CID. Acceptable *only* if no
     paid content exists on old CID. V1.1-preview test channels fit
     this.
   - (b) Add a "repin" flow for creators to rotate ACC → new CID.
     Out of V1.2 scope; can land in V1.3.
   - **Recommendation**: (a) with a public advisory listing affected
     test-channel CIDs.

2. **What if a user sign-out happens while a secure-view is in
   flight?** The in-flight request sees the revocation *after* the
   Lit call starts. Not a real security issue (the CEK was
   legitimately earned), but means "sign out" isn't instantaneous.
   Acceptable.

3. **Rotation cadence: 24h too long? 1h too short?** 24h matches
   typical SSO/SaaS sessions. We can surface this as a user
   preference in V1.3 (e.g., "end session after 1h", "end on tab
   close"). V1.2 ships at 24h default.

---

## 8. References

- Vulnerable file: `pc2-node/data/lit-actions/non-media-decrypt.js`
  (lines 26, 43, 63)
- Server call site: `pc2-node/src/api/storage.ts` (lines 1660-1674,
  2039-2130)
- Wallet-duality handling already in place: `storage.ts` L2084-L2109
- Chipotle client: `pc2-node/src/api/chipotle-client.ts` (lines 399,
  446, 492)
- Existing SIWE infra (patternable): `pc2-node/src/api/media.ts`
  (lines 28-128, 936-989)
- EIP-1271 reference: <https://eips.ethereum.org/EIPS/eip-1271>
- Web Crypto ECDSA API: <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto>
- Session transcript that triggered this fix: V1.2 pre-release call
  2026-04-17.

---

## 9. Why Not Options A or B? (Rejected)

For completeness — the three shapes considered, and why we landed
on C.

| | **Option A**: Per-asset sig | **Option B**: Per-session sig | **Option C**: Session key (chosen) |
|---|---|---|---|
| Wallet prompts per day | 1 per asset opened | 3-5 per day | **1 per day max** |
| "Double-click to open" | ❌ regression | ⚠️ partial | ✅ preserved |
| Closes current exploit | ✅ | ✅ | ✅ |
| Damage if sig leaks | 1 asset, 60s | All assets, 15 min | Needs **both** sig + non-extractable key |
| Engineering effort | ~1.5 days | ~2 days | ~3.5 days |
| Pattern precedent | Uncommon | Common (session cookies) | Common (Argent, Privy, gaming wallets) |

Option C's extra ~1.5 days buys:

- Best UX (user's original request).
- Strongest leak resistance (need two secrets, one of which is
  unexportable).
- Cleanest alignment with how other sovereign-identity apps work,
  which helps our long-term Runtime-convergence story.

Community feedback on the 2026-04-17 call explicitly weighted UX
heavily: *"What one user said to me as feedback was how nice it was
they could just double click and open a file."* Option C preserves
that.

---

## 10. Phase 1 Spike Memo (2026-04-20)

Phase 1's job is to de-risk every cryptographic primitive the
protocol depends on *before* we touch a single line of production
code. The outcome determines curve choice, wallet compatibility
assumptions, and whether any protocol changes are needed in Phase 2.

All spike scripts live in `scripts/spike/`. Raw per-run artefacts
are written to `scripts/spike/.results/` (gitignored).

### 10.1 Spike results matrix

| # | Spike | Script | Verdict | Covers |
|---|---|---|---|---|
| 1 | EIP-191 `personal_sign` roundtrip (EOA, incl. Particle EOA path) | `spike-particle-sign.mjs` | **PASS** | Delegation signing + server-side recovery + canonical-JSON tamper defence |
| 2 | EIP-1271 `isValidSignature` protocol plumbing | `spike-eip1271.mjs` | **PASS** | Third-party smart-wallet branch — positive magic-bytes, wrong bytes4, revert |
| 3a | Web Crypto verifier in Node | `spike-webcrypto-node.mjs` | **PASS** | Server-side verification of per-request signatures, non-extractability of private keys |
| 3b | Web Crypto in browsers (Chromium / Firefox / WebKit) | `spike-webcrypto.html` + `.runner.mjs` | **PASS (P-256 only)** | Client-side ephemeral key generation, cross-engine support matrix |

All four green. No Phase 2 blockers discovered.

### 10.2 Key decisions forced by spike outcomes

**Curve:** **P-256 (secp256r1)** for the ephemeral session key.

- Spike 3b proved K-256 (`secp256k1`) fails `generateKey` in
  Chromium, Firefox, *and* WebKit. That rules it out for the
  ephemeral key entirely.
- P-256 passed all five checkpoints (generate, non-extractable
  invariant, publicKey export, sign, verify) across all three
  engines — so we are on the universally-supported curve.
- This does **not** affect the EOA signature on the delegation —
  the EOA still signs secp256k1 via EIP-191 `personal_sign`, which
  the Lit Action verifies via `ethers.utils.verifyMessage`
  (Spike 1).

**Canonical JSON:** sorted-keys, no whitespace, using the exact
`canonicalize()` function pasted in every spike. The client, the
server, and the Lit Action **must** use byte-identical
implementations. Phase 2 will extract this to a single shared
module (one file in `pc2-node/src/lib/canonicalize.ts`, a sibling
in `data/test-apps/ddrm-viewer/canonicalize.js`, and pasted
verbatim into the Lit Action source).

**EIP-1271 positive case:** Spike 2 proved plumbing (magic
bytes / wrong bytes4 / revert) by injecting hand-rolled bytecode
at fake addresses via Base RPC `stateOverride`. This **does** prove
the Lit Action's `gw.isValidSignature(...) === '0x1626ba7e'`
branch, but it does **not** exercise a real third-party smart
wallet (Safe, Argent, Coinbase Smart Wallet, ...). That is a
per-vendor integration concern deferred to Phase 3 (human
wallet-in-hand testing, at least one Safe + one 4337 wallet).

**Counterfactual / ERC-6492 signatures:** Explicitly out of scope
for v1. Phase 2 will reject any signature whose EIP-1271 contract
has no deployed bytecode.

### 10.3 Deferred to Phase 3 (human-in-loop)

These rows cannot be automated without a real wallet:

| Row | Why it cannot run in CI |
|---|---|
| Particle EOA popup UI (Particle SDK session vs native toggle) | Needs a Particle account + UI flow |
| Gnosis Safe positive signature on Base | Needs a Safe with a funded owner |
| MetaMask in-app browser on iOS / Android | Needs a mobile device |
| Trust Wallet in-app browser | Needs a mobile device |
| Coinbase Wallet in-app browser | Needs a mobile device |
| Rainbow in-app browser | Needs a mobile device |
| Actual click-to-sign latency in each wallet | Real UX measurement |

Phase 3 will work from `scripts/spike/spike-webcrypto.html`
(openable from file://) + a Phase-2-built end-to-end delegation
flow. A phone-test matrix will be attached to the final PR.

### 10.4 What the spike did *not* prove (and intentionally so)

- **Lit Action bytecode changes are safe.** Phase 2 will add new
  code to `non-media-decrypt-chipotle.js`; that needs its own
  unit tests + the exploit-repro script (`scripts/security/
  exploit-lit-nonmedia.ts`) re-run to confirm the old vector is
  closed.
- **Session replay across Lit nodes.** Lit's TEE network runs the
  action in multiple nodes independently; Phase 2 will add a
  per-request nonce check that is stateless per-node (no shared
  replay store), so it is safe by construction. We will still
  check this with a multi-node replay test in Phase 3.
- **Clock skew tolerance.** Spike 1 uses `issuedAt = now`; Phase 2
  will define the acceptable `issuedAt ± clockSkew` window
  (proposed: ±120 s) and unit-test the boundary.

### 10.5 Go/No-go

**GO for Phase 2.**

No protocol changes required. Curve fixed (P-256 for session key,
secp256k1 for EOA delegation sig). All primitives proven sound on
the server, on three browser engines, and against Base mainnet
RPC. Next step is the implementation plan in
`lit-action-session-key-auth_37036101.plan.md` Phase 2.

---

## 11. Phase 2a Primitive-Layer Memo (2026-04-20)

Phase 2a landed the shared cryptographic plumbing that both server
and client consume. **No user-visible behaviour changes yet** —
this phase only adds infrastructure that Phase 2b/2c will wire into
request handlers.

### 11.1 What shipped

| File | Role |
|---|---|
| `pc2-node/src/utils/secureViewSession.ts` | Server verifier: canonicalize, buildDelegationPayload, buildRequestPayload, verifyDelegationEip191, verifyDelegationEip1271, verifyRequestSignature (P-256), revocation + anti-replay caches, `verifySecureViewBundle` orchestrator |
| `pc2-node/data/test-apps/shared/secure-view-session.js` | Client library (classic script, `window.PC2SecureViewSession`): ephemeral P-256 key gen + IndexedDB storage, canonicalize, buildDelegationPayload, signRequest, revokeSession, renderSessionIndicator |

### 11.2 Conformance tests (all green)

| Spike | Script | Verdict | Key metric |
|---|---|---|---|
| Server-verifier negative matrix (15 cases) | `scripts/spike/spike-secureview-primitives.mjs` | **PASS 15/15** | Every DESIGN.md §2.6 failure mode returns the correct `VerifyErrorCode` |
| Client ↔ server interop (Chromium / Firefox / WebKit) | `scripts/spike/spike-client-server-interop.mjs` | **PASS 3/3** | Canonical JSON is byte-identical (480 / 207 bytes); P-256 signatures verify server-side |
| Non-extractability after IndexedDB reload | `scripts/spike/spike-nonextractable.mjs` | **PASS 3/3** | `exportKey('raw')` and `exportKey('pkcs8')` both throw on the reloaded `privateKey`; `extractable === false` |

### 11.3 Design fidelity

- Canonical JSON implementation in `canonicalize()` is byte-identical
  between TS server and JS client (verified by interop test — 480
  bytes delegation, 207 bytes request, in all three engines).
- SEC1 uncompressed P-256 public keys are always 65 bytes
  (`0x04 || X || Y`) — structurally enforced by regex
  `/^0x04[0-9a-fA-F]{128}$/` in the server verifier.
- Web Crypto `sign()` / `verify()` produces raw `r || s` 64-byte
  signatures (not DER). The Lit Action in Phase 2d will receive
  the same shape.
- Anti-replay map keys on `(delegationNonce, requestNonce)` — NOT
  per-user — so a user with two tabs open can still get cache hits
  on different assets; they only collide if they replay the
  identical per-request nonce within the window.
- Revocation TTL matches delegation expiry — no memory growth
  beyond the natural 24h window + `MAX_REVOKED` / `MAX_SEEN_NONCES`
  caps.

### 11.4 Gate for Phase 2b

Phase 2b (`/lit/begin-session`, `/lit/complete-session`,
`/lit/revoke-session`, plus wiring `verifySecureViewBundle` into
`/lit/secure-view`) is cleared to proceed. Server verifier is drop-
in ready: it does not touch the Lit Protocol, does not spend
Chipotle credits, and fails closed on every known negative case.

---

## 12. Phase 2b–2d Implementation Memo (2026-04-20)

### 12.1 What landed in 2b

- `POST /api/storage/lit/begin-session` — derives
  `coveredAddresses` from the authenticated PC2 session (never from
  the client body) and returns a server-built delegation payload
  bound to `NON_MEDIA_ACTION_CID` and `chainId=8453`. Client signs
  the canonical form via EIP-191 `personal_sign`.
- `POST /api/storage/lit/complete-session` — defence-in-depth check
  that the signature verifies. EIP-191 first; EIP-1271 fallback via a
  `viem` `PublicClient` on Base. Stateless: no pending-session table.
- `POST /api/storage/lit/revoke-session` — adds the delegation nonce
  to the per-node revoke map for the rest of its natural window.
- `GET  /api/storage/admin/session-cache/stats` — owner-only. Exposes
  revoke + replay map sizes for ops visibility.
- `/lit/secure-view` grew optional `{ delegation, delegationSig,
  request, requestSig }` fields. When present,
  `verifySecureViewBundle()` runs BEFORE any Lit call; failures
  return HTTP 401 with `{ error: 'session_bundle_invalid', code }`.
  A cross-check asserts `delegation.ownerAddress` matches the
  PC2-authenticated wallet (or its paired smart-account) so a
  session X cannot forward a delegation signed by wallet Y.
- `DecryptParams.secureViewSession` carries the pre-canonicalised
  bundle downstream. Canonicalisation happens exactly once (at the
  handler boundary) — the bytes the Lit Action hashes are the bytes
  the owner signed.

### 12.2 What landed in 2c

- `chipotle-client.ts`: `SecureViewSessionBundle` type added;
  `NonMediaDecryptParams` and `MediaDecryptParams` grew an optional
  `secureViewSession` field. `recoverNonMediaCEK` and
  `recoverMediaCEKEnvelope` forward `delegation`, `delegationSig`,
  `request`, `requestSig` into `jsParams` and — in the sigauth path
  — also `actionIpfsId` so the action can perform its own
  `del.actionIpfsId === actionIpfsId` check.
- `storage.ts` Datil non-media fallback, and `media.ts` Datil ECDH
  fallback, also forward the four fields. Parity is preserved across
  Chipotle and Datil.

### 12.3 What landed in 2d

- New verifying Lit Action:
  `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` (renamed from
  `*-sigauth.js` in Phase 5 cleanup, 2026-04-21; bytes/CID preserved).
  Implements §2.7 pseudocode: canonical JSON equality check, domain
  + chain + action + kid + nonce structural checks, time-window
  enforcement with `MAX_DELEGATION_WINDOW_SECONDS` and
  `REQUEST_FRESHNESS_WINDOW_SECONDS` constants matching the server
  and client byte-for-byte, EIP-191 verification with EIP-1271
  fallback, P-256 ECDSA request-sig verification via
  `crypto.subtle.verify`, access check across ALL
  `coveredAddresses`, and CEK decrypt via
  `Lit.Actions.Decrypt({ pkpId, ciphertext })`. Response shape:
  `{ data: cekBase64, authorizedAddress, delegationNonce, requestNonce }`.
- Sibling media action: `media-decrypt-chipotle.js` (renamed from
  `*-sigauth.js` in Phase 5 cleanup, 2026-04-21; bytes/CID preserved).
  Structurally identical to the non-media action; reserved for future
  media-only divergence.
- `getChipotleNonMediaActionCode()` is sigauth-only after Phase 5
  cleanup (2026-04-21). The legacy `'legacy' | 'sigauth'` mode switch
  has been removed and any caller without a `secureViewSession` bundle
  receives `401 session_bundle_required` from `/lit/secure-view`.
- `.env.example` no longer documents `LIT_ACTION_CID_LEGACY` /
  `MEDIA_ACTION_CID_LEGACY`. The CIDs of the retired legacy actions
  remain pinned in IPFS for a 14-day window post-cutover (ops unpin at
  ~2026-05-03) to allow CEK recovery for any client that hasn't yet
  refreshed.

### 12.4 Open items (deferred to Phase 2e / Phase 3)

- ~~**IPFS pinning of the new actions**~~ — ✅ pinned 2026-04-20 via
  Elacity's Pinata workspace (filenames updated in Phase 5 cleanup,
  2026-04-21; bytes & CIDs unchanged):
  - `non-media-decrypt-chipotle.js`
    → `bafkreihvm4zkyuefnuptlbdins6cmd2mbslj2xgnyzz3ssdg2ggg3jtkk4`
    (11,905 bytes)
  - `media-decrypt-chipotle.js`
    → `bafkreihw7brius3xw2u7ltjac26hoqudulkc6mfwqrjxtrobanz2ryhvsq`
    (7,625 bytes)
  - Previous legacy non-media CID (held pinned for 14-day rollback,
    ops unpin ~2026-05-03):
    `QmNayE5MYzXcoMS9nvRk6MUo8r4ESLa3i65vHXzuBsnC2b`
- **Note on Chipotle execution model**: the Chipotle REST API ships
  Lit Action source *inline* via `/core/v1/lit_action` — the pinned
  CID is **not** fetched at execution time. The CID is used (a) as
  the value committed inside `delegation.actionIpfsId` at
  `/lit/begin-session` and (b) as the value the sigauth Lit Action
  checks against `jsParams.actionIpfsId` inside itself. Pinning to
  IPFS therefore serves provenance + public audit, not execution.
- **Removing `userAddress` from `jsParams`**: ✅ shipped in Phase 5.3
  (2026-04-21). `recoverNonMediaCEK` / `recoverMediaCEKEnvelope` and
  the Datil fallback blocks no longer pass `userAddress` — the
  effective user is derived inside the Lit Action from
  `delegation.coveredAddresses`.
- **Chipotle PKP-AES ACC binding**: unlike Datil's BLS encrypt which
  bound ciphertexts to `:currentActionIpfsId`, Chipotle's
  `Lit.Actions.Encrypt({ pkpId, message })` has no visible ACC — any
  Lit Action that can reach the PKP can `Lit.Actions.Decrypt` the
  ciphertext. The signature-auth action closes the `userAddress`
  spoofing hole; platform-level PKP access control against
  unauthorised actions is a separate concern to be confirmed with
  the Chipotle team before GA.
- **Media streaming semantics**: one delegation + one request is
  consumed once per CEK recovery. DASH segment decryption uses the
  already-recovered CEK client-side, so no additional signatures are
  required per segment — the sigauth action is called exactly once
  per viewing session (same as today's flow).

### 12.5 Rollout sequence (historical record)

1. PR containing Phase 2a–2d lands on `feature/lit-chipotle-migration`.
   ✅ shipped 2026-04-19/20.
2. Ops runs `POST /api/storage/lit/deploy-action` pointing at the
   sigauth file, captures the new CID, sets `LIT_ACTION_CID` to the
   new value and `LIT_ACTION_CID_LEGACY` to the previous value.
   ✅ shipped 2026-04-20.
3. Phase 2e ships the client integration to `ddrm-viewer` and the
   creator preflight. ✅ shipped 2026-04-20/21.
4. Phase 5 hard cutover: server returns `401 session_bundle_required`
   for any non-sigauth request, `userAddress` removed from `jsParams`
   in all paths, server-authoritative action CID enforced for media.
   ✅ shipped 2026-04-21.
5. Phase 5.4–5.7 cleanup: legacy `*-chipotle.js` Lit Action files
   deleted, `*-sigauth.js` renamed to canonical `*-chipotle.js`
   (bytes/CIDs preserved), `LIT_ACTION_CID_LEGACY` removed from
   `.env.example` and code paths. ✅ shipped 2026-04-21.
6. Ops unpins the legacy IPFS CID after the 14-day rollback window
   expires (~2026-05-03).

---

## 13. Phase 2e Client-Integration Memo (2026-04-20)

### 13.1 ddrm-viewer (viewer.js)

Session-key delegation is now wired into
`pc2-node/data/test-apps/ddrm-viewer/viewer.js`:

- `index.html` loads `lib/secure-view-session.js`
  (copied in-tree from `shared/`; the Puter capsule bundler cannot
  reach sibling directories at runtime).
- A new header slot `#session-indicator` renders the active session
  pill (`Session · 0xabc…1234 · 23h 47m left`) with a one-click
  sign-out button.
- `bootstrapSession()` runs once, lazily:
  1. Checks IndexedDB for a reusable non-expired delegation + the
     ephemeral P-256 `CryptoKeyPair`. If present, reuse without any
     wallet interaction.
  2. Otherwise: generate a fresh P-256 keypair → `POST
     /lit/begin-session { sessionPublicKey }` → server returns a
     delegation bound to the PC2-authenticated wallet → dispatch
     `personal_sign(delegationCanonical, ownerAddress)` via
     `window.ethereum` → `POST /lit/complete-session` → persist
     both halves.
- `augmentBodyWithSession()` transparently injects the canonical
  strings (`delegation`, `delegationSig`, `request`, `requestSig`)
  into every `/lit/secure-view` POST. There is a single in-flight
  `signRequest` per request — P-256 on commodity laptops completes
  in under a millisecond, imperceptible to the user.
- Graceful degradation: if no injected provider is present, if the
  PC2 session wallet disagrees with `window.ethereum.selectedAddress`,
  or if any network call fails, the viewer surfaces an "unable to
  create secure session" error with a Retry button. (Pre-Phase-5 the
  viewer fell back to a legacy path; after the Phase 5 cleanup on
  2026-04-21 the sigauth path is mandatory and the server returns
  `401 session_bundle_required` for any non-sigauth request.)

UX contract with the user (confirming the "double-click to open"
feedback): one additional wallet prompt at the first decryption of a
new login (or after 24 h). Every subsequent asset opens instantly —
no further signing prompts for the life of the session.

### 13.2 elacity-creator (app.js)

**No changes required.** The creator app is encryption-only
(`/api/storage/lit/encrypt`). It never calls `/lit/secure-view` and
thus never needs to produce session signatures. The `.ddrm` capsule
written post-mint also carries no session-specific fields — session
state is per-viewer, per-login, and is reconstructed on demand when
the viewer first opens the asset.

A future "verify after mint" preflight — where the creator re-opens
its own newly-minted asset inside a hidden viewer frame — would live
in `ddrm-viewer` and would automatically pick up the session flow
from §13.1. That is not in scope for this task.

### 13.3 Not-yet-integrated surfaces

Tracked for follow-ups (see the Elacity V1.3 roadmap):

- The Market React app (`elacity-next`) has its own copy of the
  secure-view caller; its integration will mirror viewer.js and is
  blocked on a product decision about whether the Market app should
  own the session for the whole PC2 or whether each capsule should
  maintain its own IndexedDB slot.
- The media streaming client in `ddrm-viewer` currently calls
  `/media/*` range endpoints that internally invoke
  `recoverMediaCEK`. In the current flow, the *viewer* only signs a
  session for `NON_MEDIA_ACTION_CID`; media still runs through the
  legacy action CID because the Lit Action binds `actionIpfsId` into
  the delegation. Phase 2f will issue a separate media delegation
  (scoped to `MEDIA_ACTION_CID`) and retire the legacy media CID.
