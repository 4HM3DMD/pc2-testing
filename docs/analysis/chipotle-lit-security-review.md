# Chipotle Lit Security Review

Date: 2026-04-17
Scope: Chipotle Lit Protocol integration in `pc2-node`, with emphasis on media/non-media decrypt flows, auto-provisioning, and the documented Chipotle migration path.

## Executive Summary

The current Chipotle integration has two critical authorization weaknesses and one high-risk trust-bootstrap issue.

1. Media playback authorization is not tied to a verified user session. The media API accepts any bearer string and trusts a caller-supplied buyer address, which can let an attacker decrypt media for any wallet that already owns access.
2. The Chipotle decrypt path does not bind ciphertext to the content ID being authorized. A caller who owns one valid asset can likely substitute another asset's ciphertext and encrypted CID while reusing a `kid` they already control, defeating per-asset authorization.
3. Auto-provisioning disables TLS verification and trusts unsigned supernode responses for the shared usage key and API endpoint, allowing secret/config injection and first-call exfiltration if a supernode or network path is compromised.

These issues materially weaken the stated trust model in `docs/core/LIT_CHIPOTLE_MIGRATION.md` and `docs/core/LIT_PRODUCTION_CHECKLIST.md`.

## Critical Findings

### C-01: Media decrypt flow is not authenticated, only token-shaped

Impact: An unauthenticated caller can likely obtain decrypted media segments by supplying any arbitrary token string and a wallet address that already owns the AccessToken.

Evidence:

- The media router is mounted directly at `/api/media` with no `authenticate` middleware: `pc2-node/src/api/index.ts:417`.
- `/api/media/init` only checks that a token-shaped value exists, not that it is valid: `pc2-node/src/api/media.ts:146-149`.
- The same handler uses the caller-controlled `buyerAddress` from the request body when selecting the access-checked identity: `pc2-node/src/api/media.ts:219-226`, `pc2-node/src/api/media.ts:276-305`.
- `/api/media/segment` again only requires a token-shaped value and relies on the in-memory session created from that same unverified token: `pc2-node/src/api/media.ts:354-363`.
- Session creation stores only a hash of the arbitrary caller-provided token: `pc2-node/src/services/media/sessionManager.ts:42-58`.

Why this matters:

The Lit Action enforces `hasAccessByContentId(userAddress, kid)`, but the server is the component choosing `userAddress`. In the media path, that choice is not derived from a verified session. A caller can therefore choose a wallet that already has access and pair it with any arbitrary bearer string, then use the returned session to fetch decrypted segments.

This is the core breach: `userAddress` is being supplied exogenously to the Lit Action during decryption. That means the authorization subject is not the actual caller executing the action, but an arbitrary address chosen by the requestor. If a well-known wallet already owns access to a piece of media, an attacker can simply submit that wallet as `userAddress` and ask the TEE to evaluate access against that victim address instead of themselves.

In a secure design, `userAddress` must not be caller-controlled decryption input. It should be derived from the authenticated execution context and enforced as the current user performing the decrypt, not passed in from outside as a free parameter.

Recommended fix:

- Put `authenticate` in front of the entire media router or explicitly authenticate both `/init` and `/segment`.
- Derive `buyerAddress` exclusively from `req.user.wallet_address` and `req.user.smart_account_address`, never from request JSON.
- Treat any decrypt path that accepts externally supplied `userAddress` as insecure-by-design. The Lit Action should receive the verified caller identity only, or derive it from a trusted execution primitive if Lit provides one.
- Invalidate existing media sessions on auth changes and include the authenticated wallet identity in the session object, not just a hash of the presented token.

### C-02: Chipotle CEK decryption is not bound to the authorized asset

Impact: A user who owns access to content A may be able to decrypt content B by sending content B's `litCiphertext` and encrypted CID together with content A's authorized `kid`.

Evidence:

- The Chipotle encrypt action simply PKP-encrypts plaintext; it does not use access conditions or any asset-specific binding: `pc2-node/data/lit-actions/non-media-encrypt-chipotle.js:11-21`, `pc2-node/data/lit-actions/media-encrypt-chipotle.js:11-21`.
- The Chipotle decrypt actions authorize only on `hasAccessByContentId(userAddress, kid)` and then decrypt the supplied ciphertext directly; `dataToEncryptHash` is accepted but never used: `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js:22-65`, `pc2-node/data/lit-actions/media-decrypt-chipotle.js:20-63`.
- The server accepts `litCiphertext`, `encryptedDataCid`, and `kid` from the request body and never verifies that they belong to the same asset before recovering the CEK: `pc2-node/src/api/storage.ts:1835-1848`, `pc2-node/src/api/storage.ts:1506-1558`, `pc2-node/src/api/storage.ts:1611-1649`.
- The media flow extracts the same untrusted triplet from PSSH and uses it directly for recovery: `pc2-node/src/api/media.ts:238-273`, `pc2-node/src/api/media.ts:1088-1107`.
- The legacy Datil action did enforce a self-referential action binding and passed `dataToEncryptHash` into `decryptAndCombine`, showing the security property that was lost during Chipotle migration: `pc2-node/data/lit-actions/non-media-decrypt.js:72-92`.

Why this matters:

Under Chipotle, any ciphertext encrypted under the shared PKP can be decrypted by the registered action once the caller passes an authorized `kid`. Because the server does not bind ciphertext, hash, asset CID, and content ID together from trusted metadata, the authorization check becomes "does this user own some permitted `kid`?" rather than "does this user own the asset whose CEK is being decrypted?"

This problem becomes even worse because the authorization subject itself is externally supplied. The server passes `userAddress` into the Lit Action as request data, so the decryption check is effectively being performed on behalf of whatever address the caller names, not necessarily the real caller.

Recommended fix:

- Treat `kid`, `litCiphertext`, `dataToEncryptHash`, `encryptedDataCid`, and `actionCid` as a single signed or server-derived asset envelope, not caller input.
- On decrypt, fetch authoritative metadata for the asset from trusted storage and ignore client-supplied cryptographic fields.
- Reintroduce an asset-specific binding in the Lit action, for example by checking a signed manifest hash or using a deterministic envelope that includes `kid` and ciphertext integrity inside the TEE.

## High Findings

### H-01: Auto-provisioning disables TLS verification and trusts unsigned config

Impact: A network attacker or compromised supernode can replace the shared usage key, PKP ID, or Lit API URL and can redirect the first Lit request to an attacker-controlled endpoint, exposing plaintext CEKs during encrypt/decrypt requests or causing fleet-wide denial of service.

Evidence:

- Supernode provisioning fetch disables certificate validation: `pc2-node/src/api/chipotle-client.ts:143-157`.
- The returned JSON is accepted without authenticity checks and written directly to disk as the active provision cache and usage key: `pc2-node/src/api/chipotle-client.ts:160-178`.
- `executeLitAction()` uses the provisioned `apiUrl` on the first successful auto-provision path: `pc2-node/src/api/chipotle-client.ts:321-339`.

Why this matters:

The docs describe the shared usage key as broadly distributed to nodes via supernodes. That makes the provisioning path part of the trust root. With TLS verification disabled and no signature over the returned config, whoever can tamper with that response can become the trust root.

Recommended fix:

- Remove `rejectUnauthorized: false`.
- Pin the expected supernode certificates or sign the provision payload with a long-lived offline key and verify before writing to disk.
- Strictly allowlist the Lit API host and reject provision responses that change it unexpectedly.

## Medium Findings

### M-01: Smart-account detection performs server-side fetches to a creator-controlled RPC URL

Impact: A malicious media asset can induce authenticated viewers' nodes to make arbitrary outbound POST requests, enabling SSRF against internal services reachable from the node.

Evidence:

- The RPC URL is taken from PSSH data embedded in the media asset: `pc2-node/src/api/media.ts:445-448`.
- The server then issues `fetch()` POSTs to that URL during smart-account detection: `pc2-node/src/api/media.ts:463-490`.

Why this matters:

PSSH contents are controlled by the asset packager. If an attacker can publish or induce playback of crafted media, the viewer's node becomes a JSON-RPC client to arbitrary destinations.

Recommended fix:

- Do not use asset-provided RPC URLs for server-side calls.
- Resolve RPC endpoints from a server-side allowlist keyed by chain/network.

## Notes

- I did not validate live contract behavior or deployed supernode configuration from the network; this review is code-and-docs grounded only.
- I did not attempt active exploitation.
