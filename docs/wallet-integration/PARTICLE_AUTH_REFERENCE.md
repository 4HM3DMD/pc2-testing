# Particle Auth Reference — PC2.net Wallet System

> **Status**: Production (as of March 2026)  
> **Project**: pc2.net (Elacity TEST app on Particle Dashboard)  
> **Branch**: `feature/lit-chipotle-migration`

This document is the single source of truth for how wallet authentication and transaction signing works in PC2.net. Read this before implementing wallet features in any dApp (Elacity Market, Creator, etc.).

---

## 1. Mental Model: Two Wallets, Three Login Methods

Every user has **two wallet addresses**:

| Wallet | Type | What it is |
|--------|------|-----------|
| **EOA Wallet** | Externally Owned Account | The user's "raw" crypto wallet. Private key controlled either by MetaMask or by Particle's MPC-TSS (for email/social). |
| **Agent Wallet** | ERC-4337 Smart Account | A smart contract wallet derived from the EOA. Cross-chain, gasless, aggregated balances. Formerly called "Universal Account". |

**Three login methods** determine HOW the EOA key is controlled:

| Login Method | EOA Key Custody | Signing UI | Can use Agent Wallet? |
|---|---|---|---|
| **Email / Social (Google, Apple...)** | Particle MPC-TSS (non-custodial, split key) | In-app popup (our `UIWindowParticleSigning`) | ✅ Yes |
| **MetaMask** | User's browser extension | MetaMask popup | ✅ Yes |
| **WalletConnect / Coinbase** | User's external wallet | External wallet popup | ✅ Yes |

The distinction between email/social and external wallets is critical for transaction routing — see Section 4.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PC2.net / Puter GUI                          │
│                                                                     │
│  UIAccountSidebar ─── WalletService.js ─── UIWindowAccountSend      │
│                             │                                       │
│                    ┌────────┴─────────┐                             │
│                    │                  │                             │
│         ┌──────────▼─────┐   ┌───────▼────────────┐               │
│         │  Wallet Mode   │   │   EOA / Elastos     │               │
│         │  Background    │   │   MetaMask path     │               │
│         │  iframe        │   │   (window.ethereum) │               │
│         │  (hidden)      │   └────────────────────┘               │
│         └──────────┬─────┘                                         │
│                    │ postMessage                                    │
└────────────────────┼───────────────────────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────────────────────┐
│              particle-auth iframe (always running)                  │
│                                                                     │
│   ParticleNetworkContext.tsx                                        │
│   ├── ConnectKit / wagmi (wallet connection state)                  │
│   ├── UniversalAccount SDK (Agent Wallet / smart account)           │
│   └── Message handlers:                                             │
│       ├── get-tokens          → getPrimaryAssets()                  │
│       ├── get-transactions    → getTransactions()                   │
│       ├── estimate-fee        → createTransferTransaction()         │
│       ├── eoa-send            → eth_sendTransaction / personal_sign │
│       ├── create-transfer     → createTransferTransaction()         │
│       └── submit-transfer     → sendTransaction(tx, signature)      │
└────────────────────────────────────────────────────────────────────┘

UIWindowParticleSigning.js  ← shows the particle-auth iframe visibly
                               for signing confirmation popups
```

### Key Files

| File | Role |
|------|------|
| `packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx` | All Particle logic: ConnectKit, UniversalAccount, message handlers |
| `src/gui/src/services/WalletService.js` | GUI-side wallet orchestration, mode management, transaction routing |
| `src/gui/src/UI/UIWindowParticleSigning.js` | Shows particle iframe as visible signing popup |
| `src/gui/src/UI/UIWindowParticleLogin.js` | Login iframe wrapper (shown when user not logged in) |
| `src/gui/src/UI/UIAccountSidebar.js` | Wallet panel UI |
| `src/gui/src/UI/UIWindowAccountSend.js` | Send tokens modal |
| `packages/particle-auth/.env` | Particle project credentials (pc2.net project) |

---

## 3. Authentication / Login Flow

### 3a. Email / Social Login

```
User enters email → Captcha → OTP code → Connected

PC2 GUI                   Login iframe                    Particle API
  │                           │                               │
  │  UIWindowParticleLogin    │                               │
  │  creates iframe ─────────>│                               │
  │                           │  ConnectKit shows email UI    │
  │                           │  User enters email ──────────>│
  │                           │  OTP sent back ──────────────>│
  │                           │  User enters OTP             │
  │                           │  MPC-TSS key established      │
  │                           │  active = true                │
  │                           │                               │
  │  particle-auth.success <──│  handleParticleAuthSuccess()  │
  │  { token, address,        │  POST /auth/particle          │
  │    smartAccountAddress }  │                               │
  │                           │                               │
  │  update_auth_data()       │                               │
  │  Desktop loads            │                               │
```

Key points:
- The MPC-TSS private key is split between Particle and the user's device — Particle never holds the full key
- `eoaAddress` = the user's wallet address (same on every device after login)
- `smartAccountAddress` = the Agent Wallet address derived from the EOA
- Session token stored in `localStorage.auth_token`

### 3b. MetaMask / External Wallet Login

```
User clicks MetaMask → MetaMask pops up → User approves → Connected

PC2 GUI                   Login iframe                    MetaMask
  │                           │                               │
  │  UIWindowParticleLogin    │                               │
  │  creates iframe ─────────>│                               │
  │                           │  ConnectKit shows wallet list │
  │                           │  User selects MetaMask ──────>│
  │                           │  MetaMask connect popup       │
  │                           │  User approves ──────────────>│
  │                           │  active = true                │
  │                           │                               │
  │  particle-auth.success <──│  handleParticleAuthSuccess()  │
  │  { loginMethod: 'metamask'│  POST /auth/particle          │
  │    address, smartAddr }   │                               │
```

Key points:
- MetaMask holds the private key — Particle only orchestrates the connection
- `loginMethod` stored in `localStorage.pc2_login_method` = `'metamask'`
- All signing happens natively in MetaMask popups

---

## 4. Transaction Routing — The Most Important Section

Transaction routing depends on **two dimensions**:
1. Which wallet mode is active (`'universal'` / Agent Wallet or `'elastos'` / EOA)
2. How the user logged in (email/social = "embedded" vs MetaMask/WalletConnect = "external")

### Decision Matrix

```
                    ┌──────────────────────────────────────────────────┐
                    │              LOGIN METHOD                         │
                    │   Email/Social (embedded)  │  External (MetaMask) │
┌───────────────────┼────────────────────────────┼──────────────────────┤
│ WALLET   │ EOA    │ UIWindowParticleSigning     │ MetaMask popup       │
│ MODE     │        │ (eth_sendTransaction)       │ (eth_sendTransaction)│
│          ├────────┼────────────────────────────┼──────────────────────┤
│          │ Agent  │ 3-PHASE FLOW (see below)    │ 1-STEP UA SEND       │
│          │ Wallet │ create→sign popup→submit    │ (UA signs internally)│
└──────────┴────────┴────────────────────────────┴──────────────────────┘
```

### 4a. EOA Send — Email/Social Login

The signing popup appears (Particle's "Sign Message" UI) asking the user to confirm:

```
WalletService.sendTokens()
  └── mode = 'elastos' (EOA)
      └── _sendToIframe('particle-wallet.eoa-send', { txParams, chainId })
          └── ParticleNetworkContext: eth_sendTransaction via connector.getProvider()
              └── Particle's in-app signing UI appears automatically
```

### 4b. EOA Send — MetaMask Login

MetaMask popup appears:

```
WalletService.sendTokens()
  └── mode = 'elastos', loginMethod = 'metamask'
      └── _sendViaMetaMask(txParams, chainId)
          └── window.ethereum.request({ method: 'eth_sendTransaction' })
              └── MetaMask popup appears
```

### 4c. Agent Wallet Send — Email/Social Login (3-Phase Flow)

This is the most complex flow. Because the embedded signer (Particle MPC-TSS) needs to show a visible confirmation UI, we split the transaction into 3 phases:

```
WalletService._sendSmartWalletEmbedded()

PHASE 1: Create transfer (no signing yet)
  └── _sendToIframe('particle-wallet.create-transfer', { to, amount, chainId... })
      └── ParticleNetworkContext: universalAccount.createTransferTransaction()
      └── Returns: { rootHash, transactionData }

PHASE 2: Sign the rootHash (shows visible popup)
  └── UIWindowParticleSigning({ method: 'personal_sign', params: [rootHash, eoaAddress] })
      └── particle-auth iframe becomes VISIBLE
      └── User sees "Sign Message" popup powered by Particle
      └── User clicks Confirm → MPC-TSS signs rootHash
      └── Returns: signature (hex string)

PHASE 3: Submit signed transaction
  └── _sendToIframe('particle-wallet.submit-transfer', { transactionData, signature })
      └── ParticleNetworkContext: universalAccount.sendTransaction(txData, signature)
      └── Returns: { hash, transactionId }
```

### 4d. Agent Wallet Send — MetaMask Login (1-Step)

MetaMask signs internally within the iframe, no extra popup needed:

```
WalletService.sendTokens()
  └── mode = 'universal', loginMethod = 'metamask'
      └── _sendToIframe('particle-wallet.send', { to, amount, chainId... })
          └── ParticleNetworkContext: universalAccount.createTransferTransaction()
                                   + connector.getProvider().signMessage()
                                   + universalAccount.sendTransaction()
          └── MetaMask popup appears for the signMessage step
```

---

## 5. The particle-auth Iframe: Two Modes

The `particle-auth` app runs in two distinct modes determined by URL params:

### Background / Wallet Mode (`?mode=wallet&address=0x...`)
- Always running as a hidden iframe (`id="particle-wallet-iframe"`)
- Handles all data operations: token balances, transaction history, fee estimation, transaction submission
- ConnectKit auto-reconnects from wagmi persisted state
- Does NOT fire `handleParticleAuthSuccess` (skipped in wallet mode)
- Created by `WalletService._initializeIframe()`

### Login Mode (no `?mode` param)
- Shown full-screen in `UIWindowParticleLogin`
- Handles authentication: shows email/social/wallet login UI
- Fires `handleParticleAuthSuccess` → posts `particle-auth.success` to parent → GUI logs user in
- Destroyed after login completes (parent processes the token)

### Signing Mode (`?mode=signing`)
- Shown as centered overlay via `UIWindowParticleSigning`
- Used only for EOA send confirmation
- Handles `particle-wallet.eoa-send` messages

---

## 6. Message Protocol (postMessage)

All communication between the GUI and the particle-auth iframe uses `window.postMessage`.

### GUI → Iframe (requests)

| Message Type | Payload | Response |
|---|---|---|
| `particle-wallet.get-tokens` | `{ requestId }` | `particle-wallet.tokens` |
| `particle-wallet.get-transactions` | `{ requestId, page, limit }` | `particle-wallet.transactions` |
| `particle-wallet.estimate-fee` | `{ requestId, to, amount, tokenAddress, chainId, decimals }` | `particle-wallet.fee-estimate` |
| `particle-wallet.eoa-send` | `{ requestId, payload: { txParams, chainId } }` OR `{ method: 'personal_sign', params }` | `particle-wallet.eoa-send-result` |
| `particle-wallet.create-transfer` | `{ requestId, to, amount, tokenAddress, chainId, decimals }` | `particle-wallet.create-transfer-result` |
| `particle-wallet.submit-transfer` | `{ requestId, transactionData, signature }` | `particle-wallet.send-result` |
| `particle-wallet.send` | `{ requestId, to, amount, tokenAddress, chainId, decimals }` | `particle-wallet.send-result` |

### Iframe → GUI (responses / events)

| Message Type | When sent |
|---|---|
| `particle-wallet.ready` | iframe initialized and wallet session restored |
| `particle-wallet.smart-account-info` | smart account addresses loaded |
| `particle-wallet.tokens` | response to get-tokens |
| `particle-wallet.transactions` | response to get-transactions |
| `particle-wallet.fee-estimate` | response to estimate-fee |
| `particle-wallet.eoa-send-result` | EOA transaction/sign complete |
| `particle-wallet.create-transfer-result` | Phase 1 complete, rootHash available |
| `particle-wallet.send-result` | Agent Wallet transaction complete |
| `particle-wallet.error` | any error |
| `particle-auth.success` | login successful (login mode only) |

---

## 7. Session Management & Logout

### Logout Flow

```
window.logout()
  └── initgui.js 'logout' handler
      ├── POST /logout (server)
      ├── localStorage.removeItem('auth_token', 'user', ...)
      ├── Clear wagmi/* keys (prevents ConnectKit auto-reconnect)
      ├── localStorage.setItem('disconnect_particle', 'true')
      └── window.location.href = '/'
```

On page reload:
```
particle-auth iframe loads (login mode)
  └── ConnectKit detects wagmi keys cleared → no auto-reconnect
  └── If Particle internal session still exists:
      └── ConnectKit reconnects → active = true
          └── disconnect_particle effect fires:
              ├── isLogoutPendingRef.current = true  ← blocks auth
              ├── localStorage.removeItem('disconnect_particle')
              └── deactivate() → active = false
  └── handleParticleAuthSuccess checks isLogoutPendingRef → skips
  └── User sees login screen ✓
```

### Why `isLogoutPendingRef` Is Needed

Particle's own SDK session persists independently of wagmi storage. Even after clearing wagmi keys, ConnectKit can auto-reconnect from Particle's internal session. The ref flag ensures the auth callback is skipped for this auto-reconnect, but is cleared immediately so the next manual login works normally.

---

## 8. Environment Configuration

**Particle Dashboard project**: `pc2.net`  
**App name**: `Elacity TEST`

```bash
# packages/particle-auth/.env
VITE_PARTICLE_PROJECT_ID=01cdbdd6-b07e-45b5-81ca-7036e45dff0d
VITE_PARTICLE_CLIENT_KEY=cMSSRMUCgciyuStuvPg2FSLKSovXDmrbvknJJnLU
VITE_PARTICLE_APP_ID=a75cdd40-cb04-42ad-ba0f-8503e311f5f7

# Same credentials for Universal Account SDK
VITE_UA_PROJECT_ID=01cdbdd6-b07e-45b5-81ca-7036e45dff0d
VITE_UA_CLIENT_KEY=cMSSRMUCgciyuStuvPg2FSLKSovXDmrbvknJJnLU
VITE_UA_APP_ID=a75cdd40-cb04-42ad-ba0f-8503e311f5f7
```

**Important**: Client key must be exactly 40 characters. The project must have:
- Email login enabled in Particle Dashboard
- `localhost` and your domain whitelisted

---

## 9. Known Issues & Lessons Learned

### Signup chunk `S.includes` crash
Particle's ConnectKit signup component (`signup-YQFJ523Z-*.js`) crashes if the API returns a non-string in `extra[0]`. Patch applied directly to the minified chunk:
```javascript
// BEFORE (crashes if extra[0] is an object)
let S = c?.extra?.[0] || c.message || ...;
S.includes("Network Error") ...

// AFTER (patched)
let S = String(c?.extra?.[0] || c.message || ...);
S.includes("Network Error") ...
```
This patch must be re-applied after each Vite build of particle-auth.

### Stale closure in `handleWalletDataRequest`
The wallet mode iframe's message handler must include `connector`, `connectedEoaAddress`, `smartAccountInfo`, `chainId`, and `eoaAddress` in its `useEffect` dependency array, or handlers will reference stale values and `connector?.getProvider()` will return null.

### Webpack chunk deployment
When rebuilding the GUI, webpack splits code into numbered chunks (`931.bundle.min.js`, etc.). **All** chunk files must be copied to `pc2-node/frontend/`, not just `bundle.min.js`. Missing chunk files cause "No wallet provider available" errors because the dynamic import for `UIWindowParticleSigning` fails silently.

### Auto-reconnect after logout
Particle's SDK persists its own session state independently of wagmi localStorage keys. The fix is two-layered:
1. Clear `wagmi.*` keys on logout (prevents wagmi-layer reconnect)
2. Use `isLogoutPendingRef` to block auth if Particle's own session reconnects

### `personal_sign` vs `eth_sendTransaction` routing
For Agent Wallet + email login, the signing step must use `personal_sign` on the `rootHash`, NOT `eth_sendTransaction`. Sending the transaction object directly via `eth_sendTransaction` produces "Nonce too low" errors because the EOA nonce is unrelated to the Agent Wallet's internal nonce tracking.

---

## 10. Build & Deploy Checklist

After any change to `packages/particle-auth/src/`:

```bash
# 1. Rebuild particle-auth
cd packages/particle-auth && npx vite build

# 2. Copy to src/particle-auth (served by pc2-node)
cp -R packages/particle-auth/dist/* src/particle-auth/

# 3. Re-apply signup chunk patch (REQUIRED after every build)
# Find the new signup-YQFJ523Z-*.js filename in src/particle-auth/assets/
# Apply the String() wrap patch to the S.includes line

# 4. Rebuild GUI bundle
cd src/gui && node ./build.js

# 5. Copy ALL chunks to frontend (not just bundle.min.js)
cp src/gui/dist/bundle.min.js pc2-node/frontend/bundle.min.js
cp src/gui/dist/*.bundle.min.js pc2-node/frontend/

# 6. Restart server
```
