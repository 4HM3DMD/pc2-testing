# Security Analysis: Lit Action Session-Key Delegation (LIT-ACTION-SIGNATURE-AUTH)

**Scope**: The fix proposed in
[`DESIGN.md`](./DESIGN.md) — replaces the vulnerable
`userAddress`-in-`jsParams` pattern with a signed `SecureViewDelegation`
(one-time, per wallet-connect) + per-request signatures from a
non-extractable ephemeral key.

**Audience**: PC2 engineers, independent reviewers (Anders, Sasha),
community members who want to verify our reasoning, future auditors.

**Reviewable without reading DESIGN.md**: yes — a brief recap of the
protocol is included below in Section 2.

---

## 1. Executive Summary

| Question | Answer |
|---|---|
| What is the bug today? | Lit Action trusts `userAddress` from `jsParams` with no cryptographic proof of control. Any party with public info can decrypt any buyer's content. |
| Does the fix close it? | **Yes.** The `userAddress` input is removed; the address is recovered from a signature the attacker cannot forge. |
| Are there new attack surfaces? | **Yes, smaller ones**: XSS-during-active-session can abuse the live session while the user is logged in. Mitigated by non-extractable ephemeral keys, CSP, short default session (24h), explicit sign-out. |
| Residual risks? | (a) Malicious browser extension; (b) phishing into signing a delegation; (c) full device compromise. All are industry-standard auth risks, addressed with standard mitigations. |
| Can a stolen session be revoked? | Yes — user-initiated sign-out wipes the ephemeral key and server-side adds delegation nonce to the revoke list. Non-extractable key also expires naturally at delegation `expiresAt`. |
| External audit status? | Not yet. This document is written to make external audit straightforward. |

**Bottom line**: the fix closes the critical bypass. The residual
risks are the ones every web auth system carries. For V1.2 (dDRM
release), this is a safe and correct posture.

---

## 2. Protocol Recap (one page)

### 2.1 One-time (wallet connect)

1. User's EOA signs a `SecureViewDelegation` message:
   - `domain`, `chainId`, `actionIpfsId`, `ownerAddress`,
     `coveredAddresses[]`, `sessionPublicKey`, `issuedAt`,
     `expiresAt` (≤ 24h), `nonce`.
2. An ephemeral secp256k1 keypair is generated **in-browser** via
   Web Crypto with `extractable: false`. The private key bits never
   become available to JavaScript, even on this device.
3. Delegation + signature + public key shipped to PC2, stored.

### 2.2 Per asset open (no prompt)

1. Ephemeral key signs a `SecureViewRequest`:
   `{ domain, kid, actionIpfsId, requestedAt, requestNonce }`.
2. PC2 forwards `{ delegation, delegationSig, request, requestSig }`
   to the Lit Action.

### 2.3 Lit Action verifies

1. Delegation signature was produced by `ownerAddress`
   (EIP-191 for EOA, EIP-1271 for contract wallet).
2. Request signature was produced by `sessionPublicKey`.
3. `kid`, `actionIpfsId`, `chainId` all match and timestamps fresh.
4. `hasAccessByContentId(addr, kid)` is true for **at least one**
   `addr` in `coveredAddresses`.
5. Only then release CEK.

---

## 3. Threat Model

### 3.1 Actors

| Actor | Capabilities | Goal |
|---|---|---|
| **Legitimate buyer** | Owns a wallet key; signs delegation; views content. | Consume content they paid for. |
| **Opportunistic attacker** | Can read public IPFS, on-chain events; may run their own PC2 or Lit client. | Decrypt content without paying. |
| **Sophisticated attacker** | As above + ability to plant malicious browser extensions, mount phishing sites, or run malware on a target device. | Same, with motivation to target specific users. |
| **Malicious PC2 node operator** | Full control of their own PC2; they are the current bug's easiest attacker. | Decrypt assets sold to users they never transacted with. |

### 3.2 In scope

- Unauthorized decryption of dDRM-protected assets.
- Replay / forward / token-pass attacks across assets or sessions.
- Compromise of a single session's authorization scope.

### 3.3 Out of scope

- Attacks on the Lit Protocol network itself (threshold cryptography,
  TEE integrity). Trusting Lit is a separate decision already made
  at the platform level.
- Attacks on the user's main wallet private key (MetaMask seed
  phrase, Particle account credentials). If those are compromised
  the attacker has much more than content access.
- Physical device compromise with kernel-level access (malware,
  evil maid attacks). No web auth system survives that and we don't
  claim to.
- Denial-of-service against Lit, RPC, or PC2.

### 3.4 Assets we defend

| Asset | Sensitivity |
|---|---|
| CEK (Content Encryption Key) | **High** — a single CEK decrypts all ciphertext for that asset, forever. |
| `SecureViewDelegation` + signature | **Medium** — useful for 24h, tied to one wallet's library. |
| Ephemeral private key bits | **High** — non-extractable Web Crypto means these should never be readable. |
| User's main wallet key | **Out of scope** (not held by PC2). |

---

## 4. Attack Catalogue

Every realistic attack considered, with outcome before and after the
fix. "Before" = current vulnerable system. "After" = post-fix.

| # | Attack | Before | After | Notes |
|---|---|---|---|---|
| 1 | Attacker runs own PC2, supplies any known buyer's address as `userAddress` in `jsParams` | ✅ Works — CEK released | ❌ No — Lit Action no longer reads `userAddress`; requires delegation signed by an address in `coveredAddresses` | **This is the bug we're closing.** |
| 2 | Attacker eavesdrops PC2 ↔ Lit traffic | N/A (TLS) | ❌ No | Still TLS-protected; ephemeral key never leaves device. |
| 3 | Attacker tries to decrypt an asset the buyer doesn't own | N/A | ❌ No | `hasAccessByContentId` is the final gate, unchanged. |
| 4 | Attacker intercepts a live `secure-view` request and replays it | ⚠️ Partial (kid-restricted) | ❌ No | `requestedAt` window is 60s; `requestNonce` is single-use; stale/replayed requests rejected. |
| 5 | Attacker steals `delegationSig` only (from server logs, memory dump of PC2, or network capture) | N/A | ❌ No | Per-request signature from ephemeral key also required. |
| 6 | Attacker steals `sessionPublicKey` (it's public anyway) | N/A | ❌ No | Public keys don't let you sign. |
| 7 | Attacker tries to export ephemeral private key via XSS | N/A | ❌ No | Key is Web Crypto non-extractable; `exportKey` fails. |
| 8 | Attacker with XSS **on the PC2 origin**, **while user is logged in**, calls the ephemeral key's `sign` function to forge requests | N/A | ⚠️ **Yes — for the session duration** | See Section 5. Mitigations: strong CSP (already in place for dDRM viewer), session expiry, "sign out" UX, session indicator. |
| 9 | Malicious browser extension with content-script access to PC2 origin | N/A | ⚠️ **Yes — for the session duration** | Same as #8. Users trust their installed extensions; this is a universal web-app constraint. |
| 10 | Attacker replays an *expired* delegation | N/A | ❌ No | Lit Action checks `now ≤ expiresAt`; server also checks. |
| 11 | Attacker replays a delegation against a **different Lit Action CID** (e.g., after we repin) | N/A | ❌ No | `actionIpfsId` is bound into the delegation. |
| 12 | Attacker replays delegation/request against a **different asset** (wrong `kid`) | N/A | ❌ No | Both delegation AND per-request signature encode the `kid` path: request is scoped to `kid`, and that must match. |
| 13 | Attacker replays a delegation across chains (e.g., against a future Lit Action deployed on another chain) | N/A | ❌ No | `chainId` is bound into the delegation; mismatched chain rejected. |
| 14 | Phishing: user signs a delegation intending one purpose but attacker uses it for decryption | N/A | ⚠️ **Partial** | Delegation text is explicit and scoped to dDRM decryption only; worst case attacker decrypts the user's library for ≤ 24h. Cannot drain funds / approve tokens. |
| 15 | User signs delegation on attacker-controlled dApp masquerading as PC2 | N/A | ⚠️ **Same as #14** | Domain `pc2.secure-view.v1` is encoded and displayed; wallet UX shows the message. No worse than any "connect wallet" phishing. |
| 16 | Server-side compromise of PC2: attacker has `delegation`, `delegationSig` but not ephemeral key | N/A | ❌ No | Per-request signature still required; ephemeral key is device-local. |
| 17 | User-initiated sign-out followed by attacker replaying delegation | N/A | ❌ No (for calls through PC2) / ⚠️ Partial (for direct Lit calls, until delegation `expiresAt`) | PC2 revocation list blocks `delegation.nonce` until expiry; direct Lit calls require the ephemeral private key (non-extractable). |
| 18 | Wallet device loss: user's device is stolen, thief tries to read dDRM content | N/A | ⚠️ **Yes — for the delegation duration** | Same as "laptop stolen while logged into Gmail." Mitigated by device-level screen lock + short default session. |
| 19 | Forced hand: user coerced to sign delegation | N/A | ⚠️ N/A | Out of scope; no crypto system defends against rubber-hose attacks. |
| 20 | Lit nodes themselves compromised or colluding | N/A | ⚠️ Out of scope | Platform-level trust assumption inherited from Lit Protocol. |

**Summary**: of 20 attack patterns, the fix closes **11 previously-
missing defences** (rows 1–13, 16, 17) and leaves **4 well-understood
industry-standard residual risks** (rows 8, 9, 14, 18) that are
bounded and documented. Out-of-scope items (rows 19, 20) are platform
trust assumptions.

---

## 5. The XSS-During-Active-Session Risk, Honestly

This is the most important residual risk and deserves its own section.

### 5.1 What's the scenario?

- The user is logged in to PC2 (ephemeral key is live, delegation is
  valid).
- An attacker achieves arbitrary script execution in the PC2 origin
  (via a dDRM viewer XSS, a compromised CDN asset, a malicious
  browser extension with matching manifest permissions).
- The attacker's script calls `ephemeralKey.sign(...)` using the live
  `CryptoKey` handle in IndexedDB, forging a valid per-request
  signature for any `kid` the buyer owns.
- The attacker's script decrypts content while the page is open.

### 5.2 Why can't they exfiltrate the key?

Web Crypto `extractable: false` prevents `crypto.subtle.exportKey`
from ever returning the private key bytes. This is enforced at the
browser's C++/Rust level, not in JavaScript. Even with full script
control, the attacker cannot:

- Copy the private key to their own server.
- Use the key after the page closes.
- Use the key in a different browser profile.

They can only **invoke** the key while the page is live. The moment
the page closes or the IndexedDB entry is wiped, the key is
unreachable.

### 5.3 Why isn't this worse than today?

- **Today**, a PC2-side XSS lets the attacker steal the session
  cookie / auth token and act as that user anywhere PC2 is reachable,
  for as long as the cookie is valid.
- **After the fix**, a PC2-side XSS lets the attacker decrypt that
  user's library *while the page is open*. They can't take the
  ability off-device.

Net: the attack surface doesn't grow; it changes shape. The cost of
a successful PC2 XSS goes from "can impersonate user across
everything PC2 does" to "can impersonate user for dDRM only, while
page is live."

### 5.4 Mitigations

1. **Strong CSP on the dDRM viewer** — already in place (we ship
   `sandbox="allow-same-origin"` with no-scripts-from-untrusted-
   origins policy). No regression.
2. **Short default session (24h)** — bounds damage window.
3. **Visible session indicator + sign-out button** — users can
   detect and revoke abnormal activity.
4. **Subresource integrity (SRI)** on all scripts shipped by the
   viewer — blocks compromised-CDN attacks.
5. **No user-supplied content in the dDRM viewer origin** that isn't
   DOM-sanitised (we already do this).

### 5.5 Future hardening (V1.3+)

- **Shorter default session** (1-4h) as a user preference.
- **Hardware-backed keys** where available (Secure Enclave on
  macOS/iOS, TPM on Windows, Titan on Android Chrome). Web Crypto
  does not guarantee hardware backing today; this is an upgrade
  path.
- **Per-asset re-attestation** for high-value content (creator opt-in).
- **Operator-friendly security HTTP headers audit** — HSTS,
  Trusted-Types, Permissions-Policy.

---

## 6. Cryptographic Assumptions

### 6.1 What we rely on

| Primitive | Assumption | Where |
|---|---|---|
| secp256k1 ECDSA | Signatures are unforgeable without the private key. | Delegation (EOA signer), per-request (ephemeral key). |
| EIP-191 `personal_sign` | Hash-prefix binding prevents cross-protocol signature reuse. | Delegation from EOA wallets. |
| EIP-1271 `isValidSignature` | Contract wallets correctly implement per-their-own-policy verification. | Delegation from contract-wallet signers. |
| Web Crypto `extractable: false` | Browser enforcement is correctly implemented by Chrome, Firefox, Safari. | Ephemeral key protection. |
| SHA-256 | Collision-resistant for canonical JSON → digest mapping. | Canonical message digest. |
| Lit Protocol threshold decryption | Lit nodes correctly verify access-control conditions and release decrypted plaintext only to authorized requests. | Unchanged from today. |

### 6.2 What we don't rely on

- We do not rely on a new trust anchor. All the primitives are
  standards with mainstream implementations.
- We do not rely on any single RPC provider; the access check can
  use any Base RPC.
- We do not rely on the IPFS gateway's correctness — the action CID
  is fetched by Lit nodes, and we pin at multiple gateways.

---

## 7. Incident Response

### 7.1 "My session was compromised" (user-reported)

1. User clicks "Sign out" in viewer. Client wipes ephemeral key;
   PC2 adds `delegation.nonce` to revocation list until expiry.
2. User signs a fresh delegation to restore access.
3. If the user suspects their wallet itself is compromised
   (private key exposure, not just a session): they must rotate
   the wallet entirely. That's outside dDRM scope — same as any
   Web3 app — but the session-revoke still stops the old delegation
   from being used to decrypt further content.

### 7.2 "A server PC2 instance was compromised"

1. Operator rotates all admin credentials.
2. Operator clears the sessions table and revocation list
   (legitimate users will re-sign on next visit; no data loss).
3. Operator audits the CEK cache (`POST /api/storage/admin/cek-cache/flush`).
4. Attacker cannot have exfiltrated ephemeral private keys (they're
   on user devices, not the server).
5. No action at the Lit / smart-contract layer required.

### 7.3 "The Lit Action CID is found to be buggy"

1. Patch the action, repin, update `NON_MEDIA_ACTION_CID` /
   `MEDIA_ACTION_CID` env on all PC2 nodes.
2. Existing delegations become invalid (they're `actionIpfsId`-bound).
   Users sign one fresh delegation.
3. Old CID remains pinned for 14 days as rollback safety.

### 7.4 "A user lost access unexpectedly"

1. Most likely cause: delegation expired. Solution: re-sign
   (one prompt).
2. Next most likely: action CID was rotated and their client has
   cached the old one. Solution: hard reload.
3. If neither: check `hasAccessByContentId(addr, kid)` on-chain —
   if false, the AccessToken was transferred/burned and they no
   longer own the asset. Not a dDRM issue.

---

## 8. Audit Review Checklist

For an external reviewer or an auditor to independently verify the
design and implementation.

### 8.1 Design review

- [ ] Is the attack catalogue in Section 4 complete? (Add any
      missing patterns.)
- [ ] Are the cryptographic assumptions in Section 6 standard and
      currently-recommended?
- [ ] Does the delegation message (Section 2) bind enough context
      to prevent cross-use?
- [ ] Does the per-request signature add meaningful protection over
      the delegation alone? (Spoiler: yes, because it defends
      against leaked-delegation-only scenarios.)
- [ ] Is the EIP-1271 branch correctly specified for contract
      wallets?
- [ ] Does the covered-addresses design handle the EOA/smart-account
      matrix in DESIGN.md Section 2.5 correctly?

### 8.2 Implementation review

- [ ] `ownerAddress` is never trusted from `jsParams` — only
      recovered from signature.
- [ ] Canonical JSON serialisation is byte-identical on client and
      action sides. (Test: round-trip through both code paths,
      compare bytes.)
- [ ] All timestamps use UTC seconds and are clock-skew-tolerant
      (5-second grace on `issuedAt`, 60-second grace on
      `requestedAt`).
- [ ] Revocation list is checked before issuing a Lit call
      server-side.
- [ ] Anti-replay cache covers both delegation nonce and request
      nonce.
- [ ] No path in the Lit Action reads the old `userAddress` param.
- [ ] New action CID is pinned on ≥ 2 IPFS providers before
      rollout.
- [ ] Old action CID is *kept* pinned for 14 days post-rollout for
      rollback safety.
- [ ] The exploit-repro script is checked in and passes against
      old CID, fails against new CID.

### 8.3 UX review

- [ ] The delegation-sign prompt is human-readable (not raw JSON).
- [ ] The session indicator in the viewer is visible and
      unambiguous.
- [ ] The sign-out button wipes the ephemeral key AND calls the
      server revoke endpoint.
- [ ] A 15-chapter EPUB read triggers exactly one wallet prompt
      and one Lit call.
- [ ] Particle smart-account users see no second prompt.

### 8.4 Operational review

- [ ] Metrics: count of delegations issued, count of per-request
      signatures verified, count of signature-verification failures,
      count of access-denied failures (separated).
- [ ] Logs don't record ephemeral public keys in full (truncate;
      they're not secret but they're PII-adjacent for traffic
      analysis).
- [ ] Alert on > N signature-verification failures / minute per
      IP (indicates exploit attempt).

---

## 9. Change Log

| Date | Change | Rationale |
|---|---|---|
| 2026-04-17 | Initial draft (Option A, per-asset sig) | Identified vulnerability on V1.2 pre-release call. |
| 2026-04-17 | Rejected A/B, adopted Option C (session key delegation) | Community UX feedback: "double-click to open" must be preserved. |
| 2026-04-17 | This document | Formalising the threat model for stakeholder review. |

---

## 10. Sign-Off (Pending)

| Name | Role | Date | Signed |
|---|---|---|---|
| _PC2 Engineering Lead_ | Design owner | TBD | ☐ |
| _External reviewer_ | Community/Runtime team | TBD | ☐ |
| _Release sign-off_ | User | TBD | ☐ |

Document owner: PC2 engineering. Questions, corrections, or further
review requests: file in this task folder.
