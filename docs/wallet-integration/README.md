# Wallet Integration Documentation

> **Last Updated**: March 2026  
> **Status**: Production — `feature/lit-chipotle-migration` branch

## Quick Links

| Document | Purpose |
|---|---|
| **[PARTICLE_AUTH_REFERENCE.md](./PARTICLE_AUTH_REFERENCE.md)** | Complete reference: login flows, transaction routing, message protocol, known issues |
| **[DAPP_WALLET_INTEGRATION.md](./DAPP_WALLET_INTEGRATION.md)** | Guide for integrating wallet auth into external dApps (Elacity Market, etc.) |

---

## Overview

PC2.net uses Particle Network for wallet authentication and transaction signing. Users can log in with email, Google, Apple, or any external wallet (MetaMask, WalletConnect).

Each user has two wallet addresses:
- **EOA Wallet** — their personal crypto wallet (raw EOA)
- **Agent Wallet** — an ERC-4337 smart account wallet, cross-chain, gasless (formerly "Universal Account")

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         PUTER MAIN WINDOW                            │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ UIAccountSidebar │  │UIWindowAccountSend│  │UIWindowParticle   │  │
│  │  (Wallet Panel)  │  │  (Send Modal)    │  │Signing (Popups)   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └─────────┬─────────┘  │
│           │                     │                       │            │
│           └─────────────────────┼───────────────────────┘            │
│                                 ▼                                    │
│                     ┌─────────────────────┐                          │
│                     │   WalletService.js  │  ← Central Orchestrator  │
│                     │  • Mode switching   │                          │
│                     │  • Token fetching   │                          │
│                     │  • Transaction send │                          │
│                     │  • Login detection  │                          │
│                     └──────────┬──────────┘                          │
│                                │                                     │
│           ┌────────────────────┼──────────────────────┐              │
│           │                    │                      │              │
│           ▼                    ▼                      ▼              │
│  ┌────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │
│  │ Particle Auth  │  │ MetaMask        │  │ Elastos Backend │       │
│  │ hidden iframe  │  │ (window.ethereum)│  │ (transaction    │       │
│  │ (wallet mode)  │  │                 │  │  history proxy) │       │
│  └────────────────┘  └─────────────────┘  └─────────────────┘       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Wallet Modes

### Agent Wallet Mode (Default)
- **Account Type**: Smart Account (ERC-4337) — the "Agent Wallet"
- **Chains**: Base, Ethereum, Polygon, Arbitrum, Optimism, Solana, and more
- **Tokens**: USDC, USDT, ETH, BTC, SOL, BNB, and more
- **Features**:
  - Aggregated multi-chain balances
  - Cross-chain transaction routing
  - Gasless transactions (sponsored)
  - Works with both email/social and external wallet logins

### EOA / Elastos Mode
- **Account Type**: EOA (Externally Owned Account)
- **Chains**: Elastos Smart Chain (also Base/EVM for email login)
- **Tokens**: ELA, or any ERC-20 on supported chains
- **Features**:
  - Direct wallet transactions
  - Native ELA transfers on Elastos
  - For email logins: in-app signing popup
  - For external wallets: native wallet popup

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx` | All Particle logic, message handlers |
| `src/gui/src/services/WalletService.js` | Central wallet management, transaction routing |
| `src/gui/src/UI/UIAccountSidebar.js` | Slide-out wallet panel |
| `src/gui/src/UI/UIWindowAccountSend.js` | Send tokens modal |
| `src/gui/src/UI/UIWindowAccountReceive.js` | Receive tokens modal |
| `src/gui/src/UI/UIWindowParticleSigning.js` | In-app signing popup |
| `src/gui/src/UI/UIWindowParticleLogin.js` | Login window |
| `src/gui/src/helpers/particle-constants.js` | Chain & token constants |
| `packages/particle-auth/.env` | Particle project credentials |

---

## WalletService API

### Initialization
```javascript
import walletService from '../services/WalletService.js';

if (walletService.isConnected()) {
    walletService.initialize();
}
```

### Mode Switching
```javascript
await walletService.setMode('universal'); // Agent Wallet mode
await walletService.setMode('elastos');   // EOA mode

const mode = walletService.getMode(); // 'universal' | 'elastos'
```

### Data Access
```javascript
const tokens          = walletService.getTokens();
const balance         = walletService.getTotalBalance();
const transactions    = walletService.getTransactions();
const smartAddress    = walletService.getSmartAccountAddress(); // Agent Wallet
const eoaAddress      = walletService.getEOAAddress();
const solanaAddress   = walletService.getSolanaAddress();
```

### Subscriptions
```javascript
const unsubscribe = walletService.subscribe((data) => {
    // data.tokens, data.totalBalance, data.mode, data.eoaAddress, etc.
});
unsubscribe(); // cleanup
```

### Transactions
```javascript
// WalletService automatically routes to the correct signing method
// based on wallet mode and login method
const result = await walletService.sendTokens({
    to: '0xRecipient...',
    amount: '10.5',
    tokenAddress: null, // null = native token
    chainId: 8453,      // Base
    decimals: 18,
});

const fee = await walletService.estimateFee({
    to: '0xRecipient...',
    amount: '10.5',
    tokenAddress: null,
    chainId: 8453,
    decimals: 18,
});
```

---

## Detecting Login Method

```javascript
const loginMethod = window.user?.login_method
    || localStorage.getItem('pc2_login_method')
    || '';

const EXTERNAL_METHODS = ['metamask', 'walletconnect', 'coinbase'];
const isEmbeddedLogin = !EXTERNAL_METHODS.includes(loginMethod);
// isEmbeddedLogin = true → email/social, signing via in-app popup
// isEmbeddedLogin = false → external wallet, signing via wallet popup
```

---

## Supported Chains (Agent Wallet Mode)

```javascript
import { CHAIN_INFO } from '../helpers/particle-constants.js';

CHAIN_INFO[8453]   // Base (default)
CHAIN_INFO[1]      // Ethereum
CHAIN_INFO[137]    // Polygon
CHAIN_INFO[42161]  // Arbitrum
CHAIN_INFO[10]     // Optimism
CHAIN_INFO[56]     // BSC
CHAIN_INFO[20]     // Elastos
```

---

## Error Handling

```javascript
try {
    await walletService.sendTokens({ ... });
} catch (error) {
    if (error.code === 4001) {
        // User rejected transaction in their wallet
    } else if (error.message.includes('insufficient funds')) {
        // Not enough balance
    } else if (error.message.includes('No wallet provider')) {
        // Session not restored — user needs to re-login
    } else {
        // Generic error
    }
}
```

---

## Security

1. **Origin Verification**: All postMessage handlers check `event.origin`
2. **Address Validation**: Uses `isValidAddressForChain()` before any transaction
3. **Provider Abstraction**: Never access `window.ethereum` directly — use helpers
4. **Logout Isolation**: `wagmi.*` localStorage keys cleared on logout to prevent auto-reconnect

---

## For DePin Integration

Use the wallet addresses as device identity:
- `window.user.wallet_address` → EOA address (always available)
- `walletService.getSmartAccountAddress()` → Agent Wallet address
- EOA mode for ELA native payments
- Agent Wallet mode for stablecoin cross-chain payments

---

*For full technical details, see [PARTICLE_AUTH_REFERENCE.md](./PARTICLE_AUTH_REFERENCE.md)*
