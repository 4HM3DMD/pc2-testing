# Task: Fix paid-content playback inside MetaMask Mobile's in-app browser

**Task ID**: SECURE-VIEW-MM-MOBILE-INAPP-BROWSER
**Created**: 2026-05-02
**Status**: Proposed
**Priority**: Medium (only affects MM Mobile in-app browser; desktop + Brave + Safari + WalletConnect from external mobile browsers all work)
**Target release**: v1.2.7 (bundled with the SQLite migration if both fit; otherwise v1.2.8)
**Reported by**: Sasha — 2026-05-02 morning, MetaMask Mobile in-app browser navigated to `zzz.ela.city`

---

## TL;DR

Inside MetaMask Mobile's in-app browser (MetaMask app → Browser tab → `zzz.ela.city`), tapping **Play** on a paid asset fails synchronously: the secure-view delegation toast flickers for ~200ms then disappears, no `personal_sign` prompt is ever shown, and the runtime reports `Initialization failed: Invalid parameters: must provide an Ethereum address.`. Login + general signature requests + EOA → smart-wallet transactions all work fine in the same browser session — only the secure-view delegation flow fails. A full evening of remote diagnostic patches (hex-encoded message, lowercased signer, EIP-6963 provider discovery, fresh `eth_accounts` re-fetch) reproduced the same symptom and were further hampered by aggressive in-app-browser caching that prevented later patches from loading on the user's device. Remote debugging hit a wall; this task picks up with hands-on local debugging.

**The error string `"Invalid parameters: must provide an Ethereum address."` originates inside Particle Auth's bundled provider wrapper at `src/particle-auth/assets/index-CLS56Zo3.js`** — confirmed by grep. So the most likely scenario is: Particle's wrapper has hijacked `window.ethereum` on the dapp page, sees our `personal_sign` call from `pc2-secure-view.js`, validates the params with stricter rules than MM Mobile would natively (or the `from` param doesn't match Particle's notion of the connected account), rejects synchronously, and we never get to MM Mobile at all. Why this only fails on MM Mobile in-app and not desktop is the unresolved part.

---

## Symptoms (what the user sees)

1. Open MetaMask Mobile → tap the Browser icon → navigate to `https://zzz.ela.city/`.
2. Login flow works: initial signature toast appears, MM Mobile signature prompt appears, user signs, login completes. Confirmed via screenshot.
3. EOA → smart-wallet transaction works: the in-page wallet UI lets the user move USDC, MM Mobile signature prompt appears, user signs, tx confirms. Confirmed by user.
4. Tap **Play** on any paid (opType 1 or 2) asset:
   - The PC2 media runtime opens.
   - The bottom-right "Approve secure-view session — Check MetaMask" toast appears for ~100–300ms.
   - Toast disappears. No MM Mobile signature prompt is ever shown.
   - Runtime overlays `Initialization failed: Invalid parameters: must provide an Ethereum address.` and stays in failed state.
   - User cannot retry without a hard browser reload.
5. **Free** (opType 0) assets play normally on the same setup — they don't go through secure-view delegation.

---

## What the user already verified works in the same session

- Login signature.
- General `personal_sign` for the SIWE auth round-trip (handled by `player.js` in a different code path — uses hex-encoded message and the user's primary wallet address).
- `eth_sendTransaction` for EOA → smart-wallet USDC transfers.

So the user IS connected, the wallet IS responsive, and `personal_sign` IS reachable. Only the secure-view delegation `personal_sign` fails.

---

## What we tried over 2026-05-01 evening (ALL reverted from `main` — these were diagnostic only)

The following patches were applied to `pc2-node/src/wallet-bridge/pc2-secure-view.js` and the parallel copy in `pc2-node/frontend/pc2-secure-view.js`, with cache-buster bumps in `pc2-node/frontend/index.html` and `pc2-node/scripts/build-frontend.js`. **All reverted on 2026-05-02 morning** — the last commit on `main` (v1.2.6 tag `124823dd1`) is the clean baseline. The reverts confirmed via `git checkout HEAD -- ...`.

| Patch tag | Hypothesis | What we changed | Outcome |
|---|---|---|---|
| `?v=20260502a` | "We can't see the actual error — surface it" | Catch in `runDelegationFlow` shows `err.message` in the toast for 5s before hiding | Surfaced the exact error: `Invalid parameters: must provide an Ethereum address.` |
| `?v=20260502b` | "MM Mobile rejects raw-string `personal_sign` — needs hex" | Added `utf8ToHex()`, hex-encoded the canonical message before `provider.request({ method: 'personal_sign', params: [hexMsg, signerAddr] })` | Same error. No change. |
| `?v=20260502c` | "We need more diagnostic data — what address, what provider?" | Stash `signerAddr`, `providerFlags` (`isMetaMask`/`isParticleNetwork`/constructor name), `hexMsgLen` in `__pc2LastSignAttempt`, surface in toast for 12s | Diagnostic showed: `signer: 0x34DAF3…3Dc3 (len 42) · provider: isMM,cls=h · hexMsg: 1078B`. Provider claimed `isMetaMask=true` but constructor name was `h` (minified — likely a wrapper, not native MetaMask). Signer address was mixed-case. |
| `?v=20260502d` | "MM Mobile validates EIP-55 checksum strictly — lowercase the signer" | `signerAddr = signerAddr.toLowerCase()` before passing to `personal_sign`; removed diagnostic surface | Same error. No change. |
| `?v=20260502e` | "Particle's wrapper has hijacked `window.ethereum` — find native MM via EIP-6963" | Refactored `getExternalProvider` to (a) check `window.ethereum.providers` array, (b) listen for `eip6963:announceProvider`, dispatch `eip6963:requestProvider`, build a cache, prefer non-Particle providers, prefer `io.metamask` rdns | Diagnostic showed `provider: isMM,cls=h,viaEip6963=1` — the EIP-6963 path was used but still landed on a wrapper. Same error. |
| `?v=20260502f` | "Particle is announcing itself via EIP-6963 without setting `isParticleNetwork` — needs RDNS whitelist" | `KNOWN_REAL_RDNS = ['io.metamask', 'com.coinbase.wallet', 'app.phantom', 'app.brave.brave-wallet', 'com.trustwallet.app']`; `PARTICLE_RDNS_HINTS = ['particle']`; filter accordingly. Surface `eip6963: rdns1 / rdns2` list in toast | Inconclusive — user's device started caching aggressively at this point and toast still showed the patch-`e` format. |
| `?v=20260502g` | "MM Mobile's `from` must match its currently-selected account, not our cached `user.wallet_address`" | Before `personal_sign`, call `provider.request({ method: 'eth_accounts' })` and use the returned address as the signer. Diagnostic shows `freshFrom`, `userAddr`, `selectedAddress`, `selMatch=Y/N`, `userMatch=Y/N` | User reported "exactly the same" but screenshot showed patch-`e` toast format → caching issue. Could not confirm patch-`g` ever loaded on the device. |

The caching issue at the end (`?v=20260502g` not loading despite the cache-buster URL change) effectively stalled remote debugging. We need on-device DevTools.

---

## Strong evidence that Particle's wrapper is the blocker (not MM Mobile)

```sh
$ rg "Invalid parameters: must provide an Ethereum address" src/particle-auth/
src/particle-auth/assets/index-CLS56Zo3.js: ... "Invalid parameters: must provide an Ethereum address." ...
```

The exact error string is in the Particle Auth bundle that PC2's static.ts injects on dapp HTML pages. So whatever rejects our `personal_sign` is running inside the dapp page, before the call reaches MM Mobile's native handler. The `cls=h` (minified constructor name) and `viaEip6963=1` (Particle announced via EIP-6963 too) corroborate.

What we don't yet know:
- Why this only triggers in MM Mobile's in-app browser. Particle's wrapper is loaded on desktop too — so either the validation rule is different (mobile-specific code path?) or the `from` value doesn't match Particle's expectations specifically when MM Mobile is the underlying signer (Particle thinks the user is logged in via Particle email but the EOA-wallet codepath is calling `personal_sign` with a different address).
- Whether the dapp iframe sandbox / CSP / `pc2-wallet-provider.js` shim is changing what `window.ethereum` resolves to inside MM Mobile's WebView specifically.

---

## Hypothesis tree (for the next agent to investigate)

### H1 — Particle's wrapper rejects `personal_sign` from a non-Particle account
The user signs in via MetaMask (EOA wallet), but Particle Auth might be loaded as the "primary" provider on the page. Particle's wrapper validates that the `from` address matches its known Particle-managed account, sees a mismatch, throws `Invalid parameters: must provide an Ethereum address.`. **Test**: bypass Particle entirely — make `pc2-secure-view.js` call MM Mobile's injected provider directly without going through any wrapper. EIP-6963 should give us this; we need to verify the RDNS filter actually returns a non-Particle provider on MM Mobile in-app.

**Disproof condition (be explicit, otherwise H1 stays "looks right" forever)**: the bypass must succeed AND the MM Mobile signature prompt must actually appear within ~2s. If the bypass returns a non-Particle provider but the prompt still doesn't appear → H1 is **disproved** (Particle wasn't the sole blocker), escalate to H2/H3. If the bypass appears to succeed but `eth_accounts` returns `[]` or the wrong address → H4 is in play, not H1. Don't conflate "Particle is bypassed" with "the bug is fixed" — confirm both halves separately.

### H2 — `pc2-wallet-provider.js` is overshadowing `window.ethereum`
PC2's static.ts injects `pc2-wallet-provider.js` into dapp HTML files (`pc2-node/data/test-apps/elacity-market/index.html` is one). It replaces `window.ethereum` with a proxy that forwards to the parent frame. In MM Mobile's in-app browser this might interact badly because MM Mobile injects its own provider on every navigation and our shim might run before/after MM's injection in a different order on mobile vs desktop. **Test**: read `pc2-node/src/static.ts` and `pc2-node/src/wallet-bridge/pc2-wallet-provider.js`; verify whether the secure-view player runtime is in scope of that injection or running in a different page context.

### H3 — MM Mobile's WebView strips/normalises `window.ethereum` differently from desktop
The MM Mobile in-app browser uses iOS WKWebView / Android WebView, both of which can have subtle differences from desktop Chromium re: how injected JavaScript objects are exposed across iframe boundaries. Our secure-view runs in the same top-level page as the dapp (no iframe for the player itself, only for the Particle login modal), but it's worth verifying. **Test**: open Safari Web Inspector against MM Mobile iOS or Chrome DevTools against MM Mobile Android, navigate to `zzz.ela.city`, tap Play, watch what `window.ethereum` looks like at the moment `walletPersonalSign` runs.

### H4 — The user's email login session is what's mounted, not their MM connection
Sasha's primary auth flow is email-via-Particle. MM Mobile is the underlying signer in some flows but the in-page state might still treat Particle email as the active session. The `from` we pass to `personal_sign` is `user.wallet_address` from PC2's auth state — which might be the Particle-derived smart-wallet address, not the EOA MetaMask address. MM Mobile then rejects because that address isn't in its signer list, OR Particle's wrapper rejects because it expects that address but our provider lookup returned MM. **Test**: log the user's wallet state at the moment Play is tapped — `user.wallet_address`, `provider.selectedAddress`, `await provider.request({ method: 'eth_accounts' })`. The patch-`g` attempt tried this but never loaded. Repeat with proper DevTools.

---

## Decisions needed before implementation

These are user-decisions, not agent-decisions. Get explicit answers BEFORE writing any code.

1. **If H1 is confirmed (Particle's wrapper is rejecting our valid `personal_sign` calls), do we accept shipping a workaround that routes around Particle's wrapper for this specific call only?** The proper fix would be upstream in Particle Auth, but we don't control that bundle. The pc2.net workaround is: for the secure-view delegation `personal_sign` only, prefer a direct MM Mobile provider reference over Particle's `window.ethereum` wrapper. This is a workaround, not a root cause fix. Risk: Particle might patch their wrapper later in a way that conflicts with our routing. Acceptable trade-off, or hold for upstream?
2. **Are we comfortable with the user enabling iOS Developer Mode** (Settings → Privacy & Security → Developer Mode) on their phone for Safari Web Inspector access? This is a one-time toggle but requires a phone reboot. Alternative: Android Studio's MM Mobile emulator on Mac (no phone touched, but emulator setup takes ~30 min and battery/perf characteristics differ from a real device).
3. **What's the test-platform fallback if the user's MM Mobile in-app browser still caches old script versions despite cache-buster URL changes?** Options: (a) `pc2-node/scripts/build-frontend.js` adds a `Cache-Control: no-store` response header for `/pc2-secure-view.js` only — kill caching at source. (b) Suffix the script filename with a content-hash instead of a query string (`pc2-secure-view.A1B2C3D4.js`). (c) Tell the user "force-quit MM Mobile and reopen the in-app browser" between every test. Need to pick one before Phase 1.

---

## Implementation plan (phased — DO NOT skip Phase 0)

### Phase 0 — Set up DevTools and reproduce on baseline (no code change)

- [ ] Confirm decisions 1–3 above with the user.
- [ ] Pick the DevTools path: **iOS (Safari Web Inspector)** or **Android (chrome://inspect)** or **Android Studio emulator**. Document in this task doc which one was chosen and why.
- [ ] **iOS**: enable Developer Mode on phone → connect via USB → enable Web Inspector in MM Mobile (Settings → Advanced → Web Inspector) → enable Develop menu in Safari (Safari → Settings → Advanced → "Show Develop menu"). On the desktop Mac, Safari → Develop → [phone name] → MetaMask Mobile → Browser → `zzz.ela.city`. Confirm Web Inspector connects and Console shows page logs.
- [ ] **Android**: enable USB debugging → install Chrome → `chrome://inspect/#devices` → enable "Discover USB devices" → select MetaMask Mobile → Browser → inspect.
- [ ] **Reproduce on a clean v1.2.6 baseline**. Use a Jetson or local pc2-node known-good on `main`. Tap Play on a paid asset. Capture: Console output, Network tab (look for the `personal_sign` round-trip), and the timing of the toast flicker. Paste findings into a "Phase 0 reproduction notes" subsection of this task doc.
- [ ] Confirm the reproduction matches the symptoms in the "Symptoms" section above. If it doesn't (e.g. the bug is no longer reproducible), STOP and re-evaluate scope with the user.

### Phase 1 — One single investigation patch (no fix yet)

- [ ] Add ONE `console.log` at the top of `walletPersonalSign()` in `pc2-node/src/wallet-bridge/pc2-secure-view.js`, right before the `provider.request({ method: 'personal_sign', ... })` call. Log: `provider` object keys, `provider.selectedAddress`, `await provider.request({ method: 'eth_accounts' })`, the full params being passed, and a timestamp. **No toast, no diagnostic UI** — just `console.log`. With DevTools open you'll see this immediately.
- [ ] Cache-buster: `?v=20260502h` (or next available). Bump in both `pc2-node/frontend/index.html` and `pc2-node/scripts/build-frontend.js`.
- [ ] If the cache-buster doesn't take effect (per Decision 3), apply the chosen fallback (cache-control header, content-hash suffix, or force-quit instruction).
- [ ] Run `npm run build:frontend` to sync the source file to `pc2-node/frontend/pc2-secure-view.js`.
- [ ] Test on the user's phone with DevTools open. Capture the Console output. Paste into "Phase 1 investigation findings" subsection. **Do not proceed to Phase 2 until this is done and the user has reviewed the output.**

### Phase 2 — H1-targeted fix (only after Phase 1 confirms or disproves H1)

- [ ] Refactor `getExternalProvider()` in `pc2-node/src/wallet-bridge/pc2-secure-view.js` to prefer (in order):
  1. EIP-6963 announced provider with RDNS in `KNOWN_REAL_RDNS` (`io.metamask`, `com.coinbase.wallet`, etc.) — explicitly reject providers with RDNS in `PARTICLE_RDNS_HINTS`.
  2. **Fallback: page-load capture**. In `pc2-node/frontend/index.html`, in the very first script tag (before any other module loads), do `window.__pc2NativeEthereum = window.ethereum`. Then in `pc2-secure-view.js`, prefer `window.__pc2NativeEthereum` over `window.ethereum` if EIP-6963 didn't return a non-Particle provider.
  3. Last resort: `window.ethereum` (current behaviour).
- [ ] Preserve the embedded-wallet (Particle email login) branch — that flow uses `parent.window.ethereum` via the iframe and must continue to work.
- [ ] Remove the Phase 1 `console.log` from the source file. The fix should not ship with debug logs.

### Phase 3 — Regression test (5 platforms, all must pass)

- [ ] **MM Mobile in-app browser** (the bug we're fixing): Play paid asset → MM Mobile signature prompt appears within ≤2s → user signs → asset plays normally. Subsequent paid Plays within 24h delegation window work without a new prompt.
- [ ] **Desktop Chrome + MetaMask extension**: secure-view delegation works exactly as in v1.2.6 (no regression).
- [ ] **Desktop Brave + Brave Wallet**: same.
- [ ] **Desktop Safari + WalletConnect**: same.
- [ ] **External mobile browser + WalletConnect → MM Mobile**: same (this is the user's current workaround; must still work).
- [ ] **Particle email login → secure-view**: no regression. The embedded-wallet branch is preserved.

### Phase 4 — Release (combined with Item 1 if both pass)

- [ ] CHANGELOG entry — honest about what was fixed and what remains a workaround vs root-cause fix.
- [ ] Cache-buster bump to release-boundary value (`?v=20260502z` or similar — pick something unambiguous as the v1.2.7 ship tag).
- [ ] Commit on `release/v1.2.7` branch (same branch as Item 1).

---

## Recommended approach for the next agent (high-level guidance)

1. **Start local, not remote.** This bug needs on-device DevTools, not blind hot-patches. Phase 0 makes this concrete.
2. **Reproduce with a clean state**. Use a Jetson or local pc2-node that's known-good on `main` (v1.2.6 baseline; the 2026-05-01 evening experimental patches were reverted — confirmed in `git log` and `git status`).
3. **One investigation patch with `console.log`, not a toast**. With DevTools open you'll see provider keys, `selectedAddress`, `eth_accounts`, and full sign params immediately. No need for the toast diagnostic gymnastics.
4. **Test H1 first** with EIP-6963 RDNS whitelist + page-load capture fallback. If MM Mobile responds to EIP-6963 (most modern builds do), the whitelist is sufficient. If not, the page-load capture is the safety net — `window.__pc2NativeEthereum` saved before Particle's bundle loads is the most reliable way to get an unwrapped reference.
5. **Don't go through more remote-patch iterations**. The user is annoyed and the caching issue made the last few iterations effectively useless. One on-device DevTools session > 20 blind patches.

---

## Out of scope (do not touch)

- The Particle Auth bundle itself (`src/particle-auth/`). It's a vendored build; we modify our wrapper around it, not the bundle.
- The login flow (`UIWindowParticleLogin.js`). Login works correctly; only the secure-view delegation flow is broken.
- The free-asset cleartext path. It doesn't go through delegation.
- WalletConnect integration. Out of scope for this task — but worth noting that "use WalletConnect from Safari instead of MM in-app browser" IS a working workaround for users hitting this today.

---

## Files involved

| File | Why it matters |
|---|---|
| `pc2-node/src/wallet-bridge/pc2-secure-view.js` | The delegation flow. `runDelegationFlow()` and `walletPersonalSign()` are the failing path. **This is the source of truth.** |
| `pc2-node/frontend/pc2-secure-view.js` | Synced from the source via `npm run build:frontend`. Same content, served from PC2's GUI. Don't edit this directly — edit the source and run `build:frontend`. |
| `pc2-node/frontend/index.html` | Cache-buster reference for `pc2-secure-view.js`. Bump on every deploy (`?v=...`). |
| `pc2-node/scripts/build-frontend.js` | The build script that copies the source file and rewrites the cache-buster. Hardcoded `?v=20260501c` lives here too — must match `index.html` after a release boundary. |
| `src/gui/src/UI/UIWindowParticleLogin.js` | Owns `window.pc2ShowLoginStatusOverlay` (used by `pc2-secure-view.js` to render the toast). v1.2.6 made this work for both fullscreen and corner toast modes. Don't regress this. |
| `pc2-node/src/static.ts` | Decides which static files get the `pc2-wallet-provider.js` shim injected. Relevant for hypothesis H2. |
| `pc2-node/src/wallet-bridge/pc2-wallet-provider.js` | The `window.ethereum` shim. Relevant for H2. |
| `pc2-node/data/test-apps/elacity-market/index.html` | Example dapp HTML where `pc2-wallet-provider.js` gets injected. Useful reference for understanding the injection target context (relevant for H2). |
| `src/particle-auth/assets/index-CLS56Zo3.js` | Vendored Particle Auth bundle. Contains the error string. Don't modify; just understand what it expects. |

---

## Acceptance criteria

1. Tapping **Play** on a paid asset inside MetaMask Mobile's in-app browser at `zzz.ela.city` triggers the standard MetaMask Mobile "Signature request" sheet **within ≤2s** of the tap. Slow-trigger implementations that take 30s+ do NOT pass this criterion — the perceived UX must match desktop secure-view delegation.
2. After the user signs, the secure-view session is established and the asset plays normally.
3. After the first sign, subsequent paid-asset Plays (within the 24h delegation window) work without a new prompt.
4. Desktop Chrome / Brave / Safari / Firefox secure-view delegation continues to work exactly as it did in v1.2.6 — no regression.
5. WalletConnect-from-Safari secure-view delegation continues to work (this is the user's current workaround).
6. The Particle email-login overlay positioning fix (#21 in v1.2.6 — corner toast for embedded-wallet methods, fullscreen for external-wallet methods) is preserved.
7. No `console.log` debug statements left in shipped code. The Phase 1 investigation log must be removed before Phase 2's fix lands.

---

## Risk register

- **Risk: bypassing Particle's wrapper might break Particle email-only logins doing secure-view delegation**. The current code goes through `getExternalProvider()` only for external-wallet (MM, WalletConnect, etc.) flows; embedded-wallet flows use the parent-frame iframe `personal_sign` directly. Need to preserve that branch. Phase 3 acceptance #6 explicitly tests this.
- **Risk: EIP-6963 isn't implemented uniformly across MM Mobile versions**. Older MM Mobile builds might not announce themselves. Fallback path needed: cache `window.ethereum` reference at page-load time (before Particle's bundle loads) and use that as a last resort. Phase 2 step 1 fallback (2) covers this.
- **Risk: this is actually a bug in Particle Auth that needs an upstream fix**. If H1 is right and Particle's wrapper is fundamentally rejecting valid `personal_sign` calls in MM Mobile, the proper fix is upstream — but we can ship a workaround in pc2.net by routing around the wrapper for this specific call. Decision 1 above gates whether this trade-off is acceptable.
- **Risk: iOS DevTools requires Developer Mode on the user's iPhone**. This is a one-time toggle (Settings → Privacy & Security → Developer Mode) but requires a phone reboot. The user must be informed BEFORE Phase 0 — don't surprise them with "now reboot your phone" mid-session. Decision 2 above gates this.
- **Risk: MM Mobile's in-app browser caches scripts aggressively**. The 2026-05-01 evening session burned the last 2 patches on this — they never loaded on the user's device despite cache-buster URL changes. Decision 3 above gates which mitigation we apply (no-store header, content-hash filename, or force-quit instruction).

---

## What v1.2.7 should look like if this lands together with the SQLite migration

| Item | Risk | LOC | Test surface |
|---|---|---|---|
| `better-sqlite3` → `@photostructure/sqlite` | Low (drop-in, same SQLite) | ~30 LOC across 4 files | Whole DB layer; well-covered by existing flows |
| MM Mobile in-app secure-view fix | Medium (wallet provider routing) | ~50 LOC in `pc2-secure-view.js` | Secure-view delegation only; doesn't touch login/buy/playback core |

Total v1.2.7 patch surface: ~80 LOC in 5–6 files. Honest, scoped, single-purpose release. Worth doing together if both pass acceptance.

---

## References

- v1.2.6 release commit: `124823dd1`
- v1.2.6 CHANGELOG: §23 (secure-view corner toast for external-wallet delegation) — the predecessor of this work
- v1.2.6 CHANGELOG known-issues §4 — public-facing description of this bug
- Handover doc: `docs/handover/HANDOVER_2026-05-02_V127_NEXT_AGENT.md` (this task is one of two items in v1.2.7's plan)
- Companion task: `.cursor/tasks/SQLITE-NO-COMPILE-MIGRATION/SQLITE-NO-COMPILE-MIGRATION.md` (the other v1.2.7 item; both ship from the same `release/v1.2.7` branch).

---

## Status updates as work progresses

| Date | Phase | Status | Notes |
|---|---|---|---|
| 2026-05-02 | — | Proposed (initial) | Task drafted morning of 2026-05-02 after the previous evening's 7-iteration remote-patch debug loop hit the cache wall. |
| 2026-05-02 | — | Proposed (review tweaks T8–T14 applied) | Doc-only refinements before kickoff: explicit H1 disproof condition, formal Phase 0/1/2/3 plan with DevTools-first sequencing, explicit decisions-needed list (workaround acceptance, iOS Dev Mode, cache mitigation), page-load capture fallback spelled out, ≤2s timing on acceptance #1, iOS Dev Mode + cache risks added to register, dapp HTML added to files-involved table. |
