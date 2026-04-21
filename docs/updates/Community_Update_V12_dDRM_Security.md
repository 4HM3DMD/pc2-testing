# Elacity dDRM V1.2 — Session-Key Delegation Security Upgrade

> **Status**: Shipped 2026-04-21 on `feature/lit-chipotle-migration` · Targeting V1.2 release end of April 2026
> **Audience**: Elacity community + creators + buyers using dDRM
> **TL;DR**: We closed a P0 access-control gap in the Lit Action that gates dDRM decryption, with **zero UX cost** — typical users still get one wallet popup per 24 h and none after that.

---

## What we shipped

dDRM decryption now uses **session-key delegation** end to end. Every Lit Action call is cryptographically tied to the buyer's wallet via:

1. A **delegation** signed once at wallet connect (one wallet popup) that authorizes a non-extractable, device-bound P-256 ephemeral key for up to 24 hours across the buyer's EOA + smart-account addresses.
2. A **per-request signature** from that ephemeral key, proving the request came from the same browser that holds the (wallet-blessed) key. P-256 signs in under a millisecond — no popup, no perceptible delay.
3. **TEE verification** inside the Lit Action: delegation signature (EIP-191 for EOAs, EIP-1271 for smart wallets), per-request P-256 signature, action-CID binding, request freshness, replay protection, expiry/revocation. Only after all five checks pass does the action perform the on-chain access check and release the CEK.

Old V1.1 path: action took a `userAddress` string parameter on trust → checked it on-chain → released the key. New V1.2 path: action takes a signed delegation + signed request → verifies both → derives the effective user from `delegation.coveredAddresses` → checks each address on-chain → releases the key. **`userAddress` is gone from the authorization path entirely.**

## Why we shipped it

A community member reproduced an attack on a test channel during the 2026-04-17 pre-release call: invoke the Lit Action directly with another buyer's address as a parameter, get the CEK back. Because the Lit Action source is public and immutable on IPFS, anyone running their own PC2 (or a custom Chipotle call) could do this for any asset they had a known authorized buyer for.

This is a structural problem with "trust the parameter" auth, not a bug in any one address check. The fix had to make the address claim *cryptographic*, not parameter-passed.

## Why session-key delegation (Option C)

We considered three approaches:

| | A: per-asset signature | B: per-session signature | **C: session key (shipped)** |
|---|---|---|---|
| Wallet popups per day | Many | 3-5 | **1** |
| "Double-click to open" | Regression | Partial | Preserved |
| Closes the exploit | Yes | Yes | Yes |
| Damage if one secret leaks | 1 asset, 60 s | Library for 15 min | Need **both** the signature *and* the non-extractable device key |
| Dev effort | ~1.5 days | ~2 days | ~3.5 days |

The community feedback on that 2026-04-17 call was specifically that the "double-click and open" UX is what makes dDRM feel different from every other DRM system. Option C preserves that exactly while closing the security gap and giving the strongest leak-damage profile of the three.

## What buyers will notice

**Almost nothing.** First time you open a dDRM asset in a session, you'll see one wallet popup ("Sign to authorize this device for 24 hours of dDRM decryption"). After that — for the next 24 hours, across every dDRM asset you open in that browser — there are zero popups. Same as today.

If you reject the delegation popup, you'll see a clear "Unable to create secure session" error with a Retry button instead of a silent failure.

If you sign out (via the session pill in the viewer), the device key is wiped and your delegation is added to the server's revocation list — any open viewer tabs immediately stop being able to decrypt.

## What creators will notice

**Nothing.** The encryption side of the pipeline (in the Elacity Creator app) is unchanged. Mint, list, sell, royalties — all identical. The session flow is buyer-side only.

If you've already minted assets on V1.1, they continue to work — the server enforces the new sigauth Lit Action regardless of what action CID was baked into the asset's metadata at mint time. **No re-mint, no migration, no creator action required.**

## What the security model now is

There is no caller-supplied identity claim anywhere in the dDRM authorization path. Every Lit Action call carries two cryptographic proofs:

- **Delegation signature** — the buyer's wallet (EOA or smart wallet) signed a structured message binding `domain`, `chainId`, `actionIpfsId`, `ownerAddress`, `coveredAddresses[]`, `sessionPublicKey`, `issuedAt`, `expiresAt`, `nonce`. Verified inside the Lit Action via EIP-191 (`ethers.verifyMessage`) for EOAs and EIP-1271 (`isValidSignature(bytes32,bytes)`) for smart wallets.
- **Per-request signature** — the device key (P-256, Web Crypto, `extractable: false`, stored in IndexedDB) signed `domain`, `kid`, `actionIpfsId`, `requestedAt`, `requestNonce`. Verified inside the Lit Action via `crypto.subtle.verify`.

Both signatures are checked before the on-chain `AuthorityGateway.hasAccessByContentId` call. Failures return distinct error codes (`del_sig_invalid`, `req_sig_invalid`, `bad_action_cid`, `del_expired`, `req_stale_or_future`, `replayed`, `revoked`, `access_denied`, `session_bundle_required`) so we can tell attack attempts from honest UX errors in metrics.

The exploit-regression spike (`scripts/spike/spike-exploit-regression.mjs`) covers 14 cases — static audit of the Lit Action sources, happy path, tampered `coveredAddresses`, stripped request signature, request replay, revoked delegation, wrong ephemeral key. All 14 pass against the canonical sigauth Lit Actions shipped today.

## Where to read more

- [`docs/handover/V12_SIGAUTH_HANDOVER.md`](../handover/V12_SIGAUTH_HANDOVER.md) — comprehensive cutover handover for engineers (chronological change log, deployment gotchas, rotation procedure)
- [`docs/handover/IRZHY_LIT_ACTION_FIX_V12.md`](../handover/IRZHY_LIT_ACTION_FIX_V12.md) — public-safe engineer brief
- [`docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md`](../wiki/Technical/ELACITY_DDRM_INTEGRATION.md) — security model section (now permanent, not a P0 banner)
- [`.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/`](../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/) — full task documentation: DESIGN, SECURITY, TESTING

## Credit

The vulnerability was reproduced by Irzhy on the 2026-04-17 pre-release team call. The fix design (Option C, session-key delegation) was scoped, implemented, tested, and shipped over the following four days on the `feature/lit-chipotle-migration` branch. The 2026-04-17 call also surfaced the "double-click to open" UX constraint that drove the Option C choice over Options A and B.

Thank you to everyone who took the time to actually try to break it before V1.2 went out the door. This is exactly the kind of community pressure-testing that makes open-source dDRM credible.

---

*Posted by Elacity Labs · `feature/lit-chipotle-migration` cutover summary · 2026-04-21*
