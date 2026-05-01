# Task: WalletConnect/Essentials Transaction Routing

**Task ID**: WALLETCONNECT-TX-ROUTING
**Created**: 2026-04-30
**Status**: InProgress (folded into v1.2.1 hotfix)
**Priority**: High (blocking dApp signing for every WC user on v1.2.0)
**Release**: 1.2.1

## Description

Route WalletConnect/Essentials wallet RPC calls through the existing Particle
Auth wallet iframe (which auto-restores the WC ConnectKit session via
`reconnectOnMount`) instead of falling through to whatever browser-extension
wallet owns `window.ethereum` in the parent frame (almost always MetaMask).
This is the underlying cause of every "approve in MetaMask" prompt that WC
users have been seeing since v1.2.0 made WalletConnect a first-class login
method.

## Background

`v1.2.0` shipped WalletConnect for SIWE login, but every signing path after
login still routed external (non-embedded) users through `window.ethereum`.
The actual WC provider only exists inside the `/particle-auth` iframe origin,
restored from `wc@*` localStorage keys by ConnectKit. So WC users got the
authoritatively wrong account in MetaMask's prompt, and every signing attempt
failed with *"unauthorized account"* or signed from the wrong wallet entirely.

A deeper code read showed that the infrastructure to route through the iframe
already exists — it's just gated on `isEmbeddedLogin()` (i.e. email/social).
The wallet iframe is mounted persistently for every logged-in user, ConnectKit
auto-reconnects on mount, the postMessage handlers (`particle-wallet.eoa-send`,
`particle-wallet.rpc`) already use `connector.getProvider().request(...)` —
which is the WC provider once the connector is restored. We just need to
flip a few branches to include WC users alongside embedded users.

A side-discovery during the same investigation: `pc2-node/.gitignore` was
excluding the four wallet-bridge source files via the broad `src/**/*.js`
rule. On the Jetson, `git reset --hard` followed by `npm run build:frontend`
left zero wallet-bridge files in the served frontend → every dApp fell back
to `window.ethereum` (which is the upstream of the WC bug). Fixing this is
included in this task because without it, even the WC routing changes would
not survive the first in-app update.

## Requirements

1. WalletConnect users sign Glide swaps with their connected mobile wallet
   (Essentials), not MetaMask.
2. WalletConnect users sign Elacity Market buys (approve + buy batch) with
   their connected mobile wallet.
3. WalletConnect users sign ESC token transfers with their connected mobile
   wallet, with the same `LEGACY_ONLY_CHAINS=[20]` type-0 enforcement that
   MetaMask gets (chain-aware gas pre-fill is preserved end-to-end).
4. MetaMask / Coinbase / injected-extension users see no behavioral change.
5. Email / social users see no behavioral change.
6. Hard-refresh of `zzz.ela.city` while logged in via WC restores the WC
   session in the wallet iframe within ~2 s, no second QR scan needed.
7. Wallet bridge sources are tracked in git so `git reset --hard` on update
   no longer wipes them. `build-frontend.js` fails loudly if any
   wallet-bridge source is missing (rather than silently shipping a
   broken frontend).

## Implementation Plan

- [x] Read existing wallet-bridge / WalletService / ParticleNetworkContext
      / connectkit / IPC code to understand current state
- [x] Add `isWalletConnectLogin()` helper to `WalletService.js`
- [x] Branch `WalletService.sendTransactionViaParticleIframe` for WC →
      `UIWindowParticleSigning`
- [x] Branch `WalletService.sendSmartAccountBatch` Phase 2 for WC →
      `UIWindowParticleSigning`
- [x] Branch `WalletService._sendEOATransaction` external-wallet path for
      WC → `UIWindowParticleSigning`
- [x] Add `isWalletConnectLogin()` + `shouldRouteViaIframe()` helpers to
      `pc2-wallet-bridge.js`
- [x] Update `pc2-wallet-bridge.js handleRpc` to route WC via
      `routeToParticle()`
- [x] Update `pc2-wallet-bridge.js handleReady` to skip `window.ethereum`
      account read for WC
- [x] Update `pc2-wallet-bridge.js wallet_switchEthereumChain` to skip
      double-forwarding to `window.ethereum` for WC
- [x] Sync `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` →
      `pc2-node/frontend/pc2-wallet-bridge.js`
- [x] Add `!src/wallet-bridge/` exception to `pc2-node/.gitignore`
- [x] Force-add the four wallet-bridge source files
- [x] Make `build-frontend.js` throw on missing wallet-bridge source
- [x] Add WC-aware diagnostic logging in
      `ParticleNetworkContext.tsx particle-wallet.eoa-send` (longer
      retry window, named connector in error message)
- [x] Update `CHANGELOG.md` v1.2.1 with Fix #4 entry + same-shipment
      side-fix
- [x] Write this task doc
- [ ] Build verification: rebuild GUI bundle, rebuild pc2-node frontend,
      diff bridge files
- [ ] Local validation walkthrough

## Acceptance Criteria

| # | Scenario | Expected | Verified |
|---|----------|----------|----------|
| 1 | WC login → Glide ELA→USDC swap on ESC | Prompt in Essentials, type-0 tx | ⏳ |
| 2 | WC login → Glide approve USDC on ESC | Prompt in Essentials | ⏳ |
| 3 | WC login → Market buy V3 on Base (approve+buy batch) | Single Essentials prompt for rootHash | ⏳ |
| 4 | WC login → ESC native ELA send | Prompt in Essentials | ⏳ |
| 5 | WC login → hard-refresh page → first signing call | Restored within ~2 s, no QR | ⏳ |
| 6 | WC login → revoke session in Essentials → next sign | Clear error message naming the connector | ⏳ |
| 7 | MetaMask login → Glide swap | Identical to v1.2.0 (no regression) | ⏳ |
| 8 | MetaMask login → Creator mint | Identical to v1.2.0 (no regression) | ⏳ |
| 9 | Email login → Wallet Send tokens | Identical to v1.2.0 (no regression) | ⏳ |
| 10 | Fresh node clone → `npm run build:backend` → check `pc2-node/frontend/pc2-wallet-bridge.js` | Present, byte-identical to source | ⏳ |
| 11 | Delete one wallet-bridge source → re-run build | Throws with named-file error (no silent shipment) | ⏳ |

## Files Modified

- `src/gui/src/services/WalletService.js` — three branch flips +
  `isWalletConnectLogin()` helper
- `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` —
  `isWalletConnectLogin()`, `shouldRouteViaIframe()`, `handleRpc`
  branch, `handleReady` branch, `wallet_switchEthereumChain` skip for WC
- `pc2-node/frontend/pc2-wallet-bridge.js` — synced from source
- `pc2-node/.gitignore` — `!src/wallet-bridge/` exception
- `pc2-node/scripts/build-frontend.js` — throw-on-missing
- `packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx`
  — longer WC retry window + named-connector error in
  `particle-wallet.eoa-send`
- `CHANGELOG.md` — v1.2.1 Fix #4 entry

## Files Created

- `pc2-node/src/wallet-bridge/pc2-wallet-bridge.js` (force-tracked, was
  excluded by gitignore)
- `pc2-node/src/wallet-bridge/pc2-wallet-provider.js` (force-tracked)
- `pc2-node/src/wallet-bridge/pc2-secure-view.js` (force-tracked)
- `pc2-node/src/wallet-bridge/pc2-secure-view-session.js` (force-tracked)
- `.cursor/tasks/WALLETCONNECT-TX-ROUTING/WALLETCONNECT-TX-ROUTING.md` (this file)

## Testing Strategy

Manual smoke test on the local node before pushing v1.2.1:
1. Email/social login regression (must be unchanged).
2. MetaMask login regression (must be unchanged).
3. WalletConnect (Essentials on phone) login → Glide → swap (the original
   user-reported failure case).
4. WalletConnect login → Market → buy a V3 asset.
5. Hard-refresh while logged in via WC, then sign → verify auto-restore.
6. Build verification on a clean checkout (`git clone` to /tmp), run
   `npm install --legacy-peer-deps && cd pc2-node && npm run
   build:frontend`, then `ls pc2-node/frontend/pc2-wallet-bridge.js` —
   must exist and match source.

## Notes

- **No new postMessage protocol** despite what the original plan implied.
  The reused infrastructure (`particle-wallet.eoa-send`,
  `particle-wallet.rpc`, `UIWindowParticleSigning`,
  `window.pc2RouteRpcToParticle`) already supports everything we need —
  it was just gated on the wrong condition.
- **No new iframe.** The existing wallet-mode iframe
  (`particle-wallet-iframe`, mounted by `WalletService._getOrCreateIframe`)
  carries the restored ConnectKit session for WC users.
- **Out of scope (deferred to v1.3)**: Routing MetaMask / Coinbase
  through the same iframe path (no current user pain), generic remote
  wallets beyond WC (deep-link Essentials etc.), visual queue of
  pending wallet requests across multiple tabs.

### Side fix #2 (2026-04-30): Auto-login-on-logout race

While shipping the WC routing changes we landed two earlier logout
hardening fixes:

1. `initgui.js` — server `/logout` is now fire-and-forget with a 4 s
   timeout so a hung server can no longer block the local cleanup.
2. `connectkit.tsx` — `reconnectOnMount={false}` when the
   `disconnect_particle` flag is present at boot, so ConnectKit cannot
   auto-restore a WC session after logout.

Despite both, a third race remained: PC2's XHR interceptor
(`pc2-node/scripts/build-frontend.js` lines 359-396) re-writes
`localStorage.auth_token` from any 200 response that contains a
`token` / `auth_token` field. A `whoami` / `readdir` / `stat` response
landing between the synchronous `localStorage.removeItem('auth_token')`
and the `window.location.href = '/'` navigation would silently restore
the just-cleared token. Same hazard for `update_auth_data` callbacks
queued by in-flight `refresh_user_data` calls. The page would reload
with `auth_token` intact and the user would be auto-signed back in,
matching the user-reported regression.

Fix:

- `src/gui/src/initgui.js` — set `window.__pc2_logging_out = true`
  *before* any cleanup runs (right above the fire-and-forget block).
- `pc2-node/scripts/build-frontend.js` — guard the XHR
  `Captured real session token from response` write path with the
  `__pc2_logging_out` check.
- `src/gui/src/helpers.js` — guard `update_auth_data` with the same
  check (defense-in-depth for the `refresh_user_data` race).
- `src/gui/src/initgui.js` — added a `[PC2 GUI]: BUILD
  v2026.04.30.pc2net.logoutrace loaded` boot marker so we can
  distinguish a stale browser-cached bundle from a real bug. Mirrors
  the existing particle-auth marker.

Verification (in browser console after a hard-refresh):

- Boot shows `[PC2 GUI]: BUILD v2026.04.30.pc2net.logoutrace loaded`.
- Click logout → console shows
  `[PC2]: ⏭️  Skipping token capture during logout` (and possibly
  `[update_auth_data] ⏭️  Skipping during logout` if a refresh was
  in-flight). Page lands on the login screen and stays there across
  manual refreshes.
