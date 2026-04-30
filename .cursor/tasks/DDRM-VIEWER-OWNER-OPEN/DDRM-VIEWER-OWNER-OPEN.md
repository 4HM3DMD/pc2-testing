# Task: Stale SecureView delegation causes dDRM viewer 403 on open

**Task ID**: DDRM-VIEWER-OWNER-OPEN
**Created**: 2026-04-29
**Status**: Done
**Priority**: High

## Description

Opening a non-media `.ddrm` capsule in the dDRM viewer fails with HTTP 403
`delegation.ownerAddress does not match authenticated session` even when the
user is the legitimate owner (including the minter). Media playback in the
same browser session works because the media path does not apply this
strictness check — it forwards the delegation bundle to Lit directly.

Narrow the fix to the one provable gap: the client's SecureView session
cache (IndexedDB) is never invalidated when the authenticated PC2 wallet
changes, so a delegation signed under wallet A is later re-used by a
session authenticated as wallet B.

## Background

### Reproduction observed (Apr 29, 2026)

Server log trace (`/tmp/pc2-node-v3.log`):

```
[media/init] Phase-1 412 → needsSecureView kid=0x8e81a945... actionIpfsId=QmX5Jx...
[media/WASM] Decrypting segment: inputSize=247536, hasInit=true         ← media SUCCEEDS
...
[media/init] Phase-1 412 → needsSecureView kid=0x08d66d1b... actionIpfsId=QmX5Jx...
(ddrm-viewer request)
POST /api/storage/lit/secure-view → 403 delegation.ownerAddress does not match authenticated session
```

Client log:

```
[PC2 SecureView] tryRestoreSession: delegation found, expiresAt=1777576227 actionIpfsId=QmX5Jx...
[PC2 SecureView] tryRestoreSession: restored cached session (no wallet prompt needed)
[dDRM Viewer] Load failed: Error: delegation.ownerAddress does not match authenticated session
```

### Evidence for the root cause

1. `POST /api/storage/lit/begin-session` (`pc2-node/src/api/storage.ts:2721`)
   derives `delegation.ownerAddress` strictly from the authenticated wallet:
   `ownerAddress: walletAddress as 0x${string}` (line 2769), where
   `walletAddress = req.user.wallet_address`.

2. `POST /api/storage/lit/complete-session` (line 2801) re-enforces that
   `delegation.ownerAddress === authenticated wallet` before persisting.

3. `POST /api/storage/lit/secure-view` (line 3060-3066) additionally
   enforces `del.ownerAddress === buyerAddress || del.ownerAddress === buyerAddressAlt`.

4. The launcher (`src/gui/src/helpers/open_item.js:482-485`) sends
   `buyerAddress = window.user.wallet_address` and
   `buyerAddressAlt = window.user.smart_account_address` — the *current*
   session's wallets.

5. Client session cache (`pc2-node/frontend/pc2-secure-view-session.js:242-251`)
   — `getActiveDelegation()` checks only expiry, not ownership:

   ```js
   function getActiveDelegation() {
     return loadDelegation().then(function (rec) {
       if (!rec) return null;
       if (typeof rec.expiresAt === 'number' && rec.expiresAt < Math.floor(Date.now() / 1000)) {
         return deleteDelegation().then(function () { return null; });
       }
       return rec;
     });
   }
   ```

6. `tryRestoreSession()` (`pc2-node/frontend/pc2-secure-view.js:144-163`)
   restores the cached delegation without comparing its `ownerAddress` to
   the current session's wallets.

7. Logout/login in the Puter GUI does not clear SecureView IndexedDB
   (`ripgrep` for `PC2SecureViewSession`, `revokeSession`, `deleteDelegation`
   across `src/gui/src` returns no hits).

### Why media works while non-media 403s

The media path (`/api/media/init`) does not apply the
`buyerAddress === del.ownerAddress` gate; it forwards the delegation
bundle to the Chipotle Lit Action, which decrypts under
`del.ownerAddress` regardless of the `buyerAddress` field in the request
body. As long as whoever signed the cached delegation owns on-chain
access for that particular kid, media playback succeeds. For the
non-media `/secure-view` endpoint, the strict check (line 3060-3066)
fires first and refuses the whole request.

This also explains why the user's new RC7 purchase fails with
`access_denied` on media while the older Star-of-Bethlehem title still
plays: both use the same cached delegation; only the older asset's
on-chain access is held by the wallet that *signed the delegation*.
Re-bootstrapping under the current session wallet is therefore expected
to also resolve the media access-denied symptom reported in the prior
session, though that effect is a side-benefit, not the primary
acceptance criterion.

## Requirements

1. When a cached SecureView delegation's `ownerAddress` does not match
   the currently authenticated PC2 session, the client must drop the
   cache and re-bootstrap rather than reuse the stale delegation.
2. A single wallet-prompt re-sign must be sufficient to recover.
3. No change to the wire protocol, to the server-side verifier, or to
   the delegation format itself.
4. Log the mismatch fields on the server-side 403 path so future
   occurrences are triaged from the log alone (ownerAddress vs
   buyerAddress vs buyerAddressAlt, first 10 chars only for privacy).

## Implementation Plan

- [ ] **Client**: In `pc2-node/frontend/pc2-secure-view.js`
      `tryRestoreSession()`, after `SVS.getActiveDelegation()` resolves,
      compare `active.delegation.ownerAddress` against the current
      session's primary wallet (read from `window.user.wallet_address`,
      falling back to `window.user.smart_account_address` only if
      `wallet_address` is absent). On mismatch:
  - log a single `[PC2 SecureView]` warn line including both the
    cached owner and the current session wallet (first 10 chars each),
  - call the existing `SVS.deleteSessionKey()` + `SVS.deleteDelegation()`
    (already exported; see `pc2-secure-view-session.js:263`) via a small
    local helper,
  - return `null` so `ensureSession()` falls through to
    `runDelegationFlow()` and prompts for a fresh signature.
- [ ] **Server**: In `pc2-node/src/api/storage.ts` at the existing
      `/secure-view` 403 branch (around line 3060-3066), before
      `res.status(403).json(...)`, add a single `logger.warn` line
      printing `del.ownerAddress`, `buyerAddress`, and `buyerAddressAlt`
      (first 10 chars each). No logic change.
- [ ] **Cache-bust**: Bump the SecureView script version in
      `pc2-node/frontend/index.html` (same `?v=` query-string pattern we
      use elsewhere) so the parent frame re-loads the updated
      `pc2-secure-view.js` on next Puter boot.
- [ ] Smoke-test from the user (see Testing Strategy).

## Acceptance Criteria

1. Opening a non-media `.ddrm` capsule that the currently-authenticated
   wallet legitimately owns succeeds (HTTP 200) after at most one
   wallet-signature prompt, even when the IndexedDB contains a stale
   delegation from a prior login.
2. When the mismatch is detected, the client log shows a single
   `[PC2 SecureView]` warning followed by the existing
   `runDelegationFlow:` sequence (begin-session → personal_sign →
   complete-session). No stack trace, no repeated 403s.
3. The server log now includes the actual owner / buyer / buyerAlt
   addresses whenever a 403 fires, allowing future issues to be triaged
   without a browser repro.
4. No change to media playback path: `mov-example-video-download-full-hd-1920x1080`
   and any other correctly-minted media title continue to play. The
   RC7 asset's access-denied outcome is out of scope; if it resolves
   as a side-effect, that is welcome, but it is not the acceptance bar.
5. No regression when the cached delegation is already valid for the
   current session (no extra wallet prompt, no extra network round-trip).

## Files to Modify

- `pc2-node/frontend/pc2-secure-view.js` — add owner-mismatch check in
  `tryRestoreSession`.
- `pc2-node/src/api/storage.ts` — add logger.warn at the existing 403
  branch in the `/secure-view` handler.
- `pc2-node/frontend/index.html` — bump the `?v=` query-string on the
  SecureView script tag.

## Files to Create

None.

## Testing Strategy

### Automated

- `pnpm -C pc2-node build` completes without TypeScript errors.

### Manual (user-driven smoke test)

1. Restart pc2-node with the patched build; hard-refresh the Puter desktop.
2. Open an owned non-media `.ddrm` file (image, pdf, etc.) via
   double-click from the file explorer.
3. Expected flow:
   - First open after the patch: one-off wallet-signature prompt to
     re-bootstrap the SecureView session, then the viewer renders the
     content with HTTP 200.
   - Second open within the same session: no prompt, no re-sign,
     immediate render (cache now correctly matches current wallet).
4. Open a correctly-minted non-RC7 media title and confirm playback
   still works end-to-end.
5. Confirm server log shows a `[SecureView] Session bundle verified:`
   line instead of the 403 for the non-media open.

## Notes

- The 403 check itself in `storage.ts` is correct and stays as-is
  (defense in depth; the client can lie). Only the client-side cache
  validation needs to be added; the server just gets better logging.
- Revised delegation lifetime is unchanged (24 h).
- No changes to `complete-session` contract, to the Lit Action CID, or
  to the verified SecureView bundle schema.
- If the user's original login flow in the Puter GUI is later extended
  to clear IndexedDB on wallet change (a broader, separate concern),
  that fix and this fix can coexist safely — this change treats the
  cache as untrusted on every restore, which is the belt-and-braces
  posture we want regardless.

## Out of Scope

- The RC7 media `access_denied` diagnosis. May resolve as a side effect
  of this task (because re-bootstrapping under the current wallet makes
  Lit see the correct owner). If it does not resolve after this task,
  file a new task against the Chipotle mint flow — not against PC2.
- Any refactor of `buyerAddress`/`buyerAddressAlt` resolution in
  `open_item.js` (the current code already passes both addresses).
- Any changes to login/logout lifecycle in the Puter GUI.

## Results (2026-04-29, smoke test)

Smoke test passed end-to-end. The stale-delegation hypothesis was
confirmed directly from the client console, and the side-effect
hypothesis on RC7 media was also confirmed.

**Detection fired on first dDRM-viewer open after restart:**

```
[PC2 SecureView] tryRestoreSession: loading delegation from IndexedDB…
[PC2 SecureView] tryRestoreSession: delegation found, expiresAt=1777576227
[PC2 SecureView] tryRestoreSession: cached delegation owner does not match current session
  — purging (cached=0xafdD4fD1… current=0x34DAF31B…)
```

Key finding: the cached delegation had been signed by a **third wallet
(`0xafdD4fD1…`)** that was neither the user's current EOA nor current
SA. Without the new gate, every `/secure-view` request 403'd because
both strict comparisons failed; the on-chain access-token contract also
had no grant for `0xafdD4fD1…`, which is why Lit denied RC7 media too.

**Re-bootstrap succeeded cleanly, one wallet prompt:**

```
[PC2 SecureView] runDelegationFlow: POST /api/storage/lit/begin-session
[PC2 SecureView] runDelegationFlow: begin-session status=200
[PC2 SecureView] runDelegationFlow: signer resolved: 0x34DAF31B99B5A59cEB18E424Dbc112FA6e5f3Dc3
[PC2 SecureView] runDelegationFlow: requesting personal_sign (wallet prompt expected)…
[PC2 SecureView] runDelegationFlow: delegation signed, POST /api/storage/lit/complete-session
[PC2 SecureView] runDelegationFlow: complete-session status=200
[PC2 SecureView] runDelegationFlow: session persisted to IndexedDB
[PC2 SecureView] ensureSession: bootstrap complete
```

**Acceptance criteria verification:**

1. ✅ Owned non-media `.ddrm` (Image test) renders after one prompt.
2. ✅ Mismatch surfaces as a single `[PC2 SecureView]` warn followed by
   the clean `runDelegationFlow:` chain. No 403 loop.
3. ✅ (N/A in this run — the 403 path was not hit after the patch;
   the server-side `logger.warn` will surface next time a mismatch
   slips past the client gate.)
4. ✅ Correctly-minted media continues to play.
5. ✅ RC7 media (`1409899-uhd_3840_2160_25fps`) **also** plays now —
   confirmed by `sourceended fired, readyState: ended` after the full
   stream buffered. The access_denied previously reported was the
   same stale-delegation root cause manifesting on the media path;
   no further action is needed on that RC7 listing or on the Chipotle
   mint flow.

**No regressions observed** on media playback, on correctly-scoped
delegations, or on the non-media opens for the user's other owned
capsules.
