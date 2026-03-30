# dApp Wallet Integration Guide

> **For**: Elacity Market, Creator tools, and any dApp that needs to process Web3 transactions with PC2.net users  
> **Prerequisite**: Read [PARTICLE_AUTH_REFERENCE.md](./PARTICLE_AUTH_REFERENCE.md) first

This guide lets you integrate PC2.net wallet capabilities into an external dApp without rediscovering all the lessons we learned building the core PC2.net wallet system.

---

## 1. Context: What the dApp Needs to Know

When a PC2.net user arrives at your dApp, they may have logged in via:

| Login Method | `loginMethod` value | Who holds the key |
|---|---|---|
| Email | `'email'` (or empty string) | Particle MPC-TSS |
| Google | `'google'` | Particle MPC-TSS |
| Apple | `'apple'` | Particle MPC-TSS |
| MetaMask | `'metamask'` | MetaMask browser extension |
| WalletConnect | `'walletconnect'` | User's mobile wallet |
| Coinbase Wallet | `'coinbase'` | Coinbase Wallet extension |

**The critical split**: email/social = "embedded signer" (in-app popup required for signing). MetaMask/WalletConnect = "external signer" (native wallet popup handles signing).

Every user has two addresses:
- **EOA address** — their raw wallet (MetaMask-style)
- **Agent Wallet address** — their smart account (cross-chain, gasless)

---

## 2. Two Integration Patterns

### Pattern A: Embedded dApp (inside Puter iframe / PC2.net window)

Your dApp runs inside a Puter `UIWindow` or `<iframe>`. You communicate with the parent GUI via `window.parent.postMessage`. This is how Elacity Market will initially work.

### Pattern B: Standalone dApp (separate website, e.g. ela.city)

Your dApp runs on its own domain. Users bring their PC2.net wallet to your site. You use Particle ConnectKit directly and share the same Particle project credentials.

Both patterns need the same core knowledge about login methods and signing flows. The implementation of calling the signing UI differs.

---

## 3. Pattern A: Embedded dApp (postMessage)

### 3a. Getting Wallet Info

From inside a Puter window, use the `pc2-wallet-bridge` event system:

```javascript
// Request wallet state from parent
window.parent.postMessage({ type: 'wallet.get-info', requestId: 'req-1' }, '*');

// Listen for response
window.addEventListener('message', (event) => {
    if (event.data.type === 'wallet.info' && event.data.requestId === 'req-1') {
        const { eoaAddress, agentWalletAddress, loginMethod, mode } = event.data.payload;
        // eoaAddress         → EOA wallet address
        // agentWalletAddress → Agent Wallet (smart account) address
        // loginMethod        → 'email' | 'google' | 'metamask' | etc.
        // mode               → 'universal' (Agent Wallet) | 'elastos' (EOA)
    }
});
```

### 3b. Requesting a Transaction

For embedded dApps, route all transaction requests through the PC2.net `WalletService`. This means your dApp asks the parent to send a transaction on the user's behalf:

```javascript
// Ask the parent GUI to send tokens
window.parent.postMessage({
    type: 'wallet.send-tokens',
    requestId: 'req-2',
    payload: {
        to: '0xRecipientAddress',
        amount: '10.5',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        chainId: 8453,
        decimals: 6,
        walletMode: 'universal', // 'universal' (Agent Wallet) or 'elastos' (EOA)
    },
}, '*');

window.addEventListener('message', (event) => {
    if (event.data.type === 'wallet.send-tokens-result' && event.data.requestId === 'req-2') {
        if (event.data.payload.success) {
            const { hash, transactionId } = event.data.payload;
            // Transaction submitted
        } else {
            const { error } = event.data.payload;
            // Show error to user
        }
    }
});
```

The parent (`WalletService.js`) handles all routing — the dApp doesn't need to know whether to use the in-app signing popup or MetaMask.

### 3c. Requesting a Signature (e.g., for auth or ownership proof)

```javascript
window.parent.postMessage({
    type: 'wallet.sign-message',
    requestId: 'req-3',
    payload: {
        message: 'I confirm purchase of asset #12345',
    },
}, '*');

window.addEventListener('message', (event) => {
    if (event.data.type === 'wallet.sign-message-result' && event.data.requestId === 'req-3') {
        const { signature, address } = event.data.payload;
        // Send to your backend for verification
    }
});
```

---

## 4. Pattern B: Standalone dApp (Direct Particle Integration)

For a standalone dApp like `ela.city`, you embed Particle ConnectKit directly and share the same credentials.

### 4a. Setup

```bash
npm install @particle-network/connectkit @particle-network/connector-core @particle-network/universal-account-sdk
```

```typescript
// src/particle/config.ts
export const PARTICLE_CONFIG = {
    projectId: '01cdbdd6-b07e-45b5-81ca-7036e45dff0d',
    clientKey: 'cMSSRMUCgciyuStuvPg2FSLKSovXDmrbvknJJnLU',
    appId: 'a75cdd40-cb04-42ad-ba0f-8503e311f5f7',
};
```

### 4b. Detecting Login Method (Critical for Transaction Routing)

```typescript
import { useConnectKit } from '@particle-network/connectkit';

const EXTERNAL_METHODS = ['metamask', 'walletconnect', 'coinbase'];

function useWalletType() {
    const { connector } = useConnectKit();
    
    // Particle stores login type in the connector's provider info
    const loginMethod = connector?.name?.toLowerCase() || '';
    const isEmbedded = !EXTERNAL_METHODS.some(m => loginMethod.includes(m));
    
    return { isEmbedded, loginMethod };
}
```

### 4c. EOA Transaction — Embedded (email/social) Login

For email/social logins, you **must** use Particle's own UI components to trigger signing. The MPC-TSS signing popup is built into ConnectKit and shows automatically when you call signing methods via the Particle provider.

```typescript
import { useConnectKit } from '@particle-network/connectkit';

async function sendEOATransaction(txParams: TransactionParams) {
    const { connector } = useConnectKit();
    const provider = await connector.getProvider();
    
    // This triggers Particle's in-app MPC-TSS signing popup automatically
    const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [txParams],
    });
    
    return hash;
}
```

For the PC2.net scenario, this signing popup appears inside the particle-auth iframe. In a standalone dApp, ConnectKit renders it directly in your page.

### 4d. EOA Transaction — External (MetaMask) Login

```typescript
async function sendEOATransaction(txParams: TransactionParams) {
    // window.ethereum is MetaMask
    const hash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [txParams],
    });
    return hash;
}
```

### 4e. Agent Wallet Transaction — Embedded Login (3-Phase, MOST IMPORTANT)

This is the pattern that took the longest to get right. For email/social logins + Agent Wallet, you cannot just call `universalAccount.sendTransaction()` — you must get a signature first, and that signature must come from a UI-triggered signing call.

```typescript
import { UniversalAccount } from '@particle-network/universal-account-sdk';
import { useConnectKit } from '@particle-network/connectkit';

async function sendAgentWalletTransaction(params: {
    to: string;
    amount: string;
    tokenAddress: string | null;
    chainId: number;
    decimals: number;
}) {
    const { connector } = useConnectKit();
    
    // PHASE 1: Create the transfer (no signing yet)
    const ua = new UniversalAccount({
        projectId: PARTICLE_CONFIG.projectId,
        projectAppUuid: PARTICLE_CONFIG.appId,
        projectClientKey: PARTICLE_CONFIG.clientKey,
        ownerAddress: eoaAddress,
    });
    
    const transferPayload = {
        receiver: params.to,
        tokenAddress: params.tokenAddress || '0x0000000000000000000000000000000000000000',
        amount: params.amount,
        chainId: params.chainId,
        tokenDecimals: params.decimals,
    };
    
    const createdTx = await ua.createTransferTransaction(transferPayload);
    const { rootHash } = createdTx;
    
    // PHASE 2: Sign rootHash — this triggers the signing UI
    // For embedded logins: Particle's MPC-TSS popup appears
    // For external wallets: MetaMask/WalletConnect popup appears
    const provider = await connector.getProvider();
    const signature = await provider.request({
        method: 'personal_sign',
        params: [rootHash, eoaAddress],
    });
    
    // PHASE 3: Submit the signed transaction
    const result = await ua.sendTransaction(createdTx, signature);
    return result.transactionHash || result.hash || createdTx.transactionId;
}
```

**Why `personal_sign` on `rootHash`?**
- The `rootHash` is a hash of the UserOperation (the bundled smart account transaction)
- Signing it proves the EOA owner authorized the Agent Wallet to execute
- Using `eth_sendTransaction` instead would attempt a raw EOA transaction, which fails with "Nonce too low" or sends the wrong thing entirely

### 4f. Agent Wallet Transaction — External Login (1-Step)

When the user has connected with MetaMask/WalletConnect, the `personal_sign` call goes directly to their wallet. No special handling needed — just call phases 1-3 and the wallet popup handles signing.

```typescript
// Same code as 4e works — connector.getProvider() returns MetaMask
// MetaMask popup appears automatically for the personal_sign call
```

### 4g. Unified Send Function

```typescript
async function sendTokens(params: SendParams) {
    const { isEmbedded } = useWalletType();
    const isAgentWallet = currentMode === 'agent'; // or 'universal'
    
    if (isAgentWallet) {
        // Both embedded and external use the same 3-phase flow
        // The difference is which UI shows for personal_sign:
        // embedded → Particle in-app popup
        // external → MetaMask/WalletConnect popup
        return sendAgentWalletTransaction(params);
    } else {
        // EOA send
        if (isEmbedded) {
            return sendEOATransaction(params); // Particle in-app popup
        } else {
            return sendViaMetaMask(params);    // MetaMask popup
        }
    }
}
```

---

## 5. Transaction Fee Estimation

Always estimate fees before sending — users expect to see costs upfront.

For Agent Wallet:
```typescript
const estimatedTx = await ua.createTransferTransaction(transferPayload);
// estimatedTx contains fee information
const feeInUSD = estimatedTx.estimatedFee?.usd || '0';
const feeInNative = estimatedTx.estimatedFee?.native || '0';
```

For EOA:
```typescript
const gasPrice = await provider.request({ method: 'eth_gasPrice' });
const gasEstimate = await provider.request({
    method: 'eth_estimateGas',
    params: [txParams],
});
const feeWei = BigInt(gasPrice) * BigInt(gasEstimate);
```

---

## 6. Authentication: Verifying User Identity in Your Backend

Your backend needs to verify the user is who they claim to be.

### Option A: Verify EOA Signature

User signs a challenge with their EOA; your backend recovers the address:

```typescript
// Frontend
const challenge = `Login to Elacity Market\nTimestamp: ${Date.now()}`;
const signature = await provider.request({
    method: 'personal_sign',
    params: [challenge, eoaAddress],
});

// Send to your backend
await fetch('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: eoaAddress, signature, challenge }),
});
```

```javascript
// Backend (Node.js)
const { ethers } = require('ethers');

function verifyEOALogin(address, signature, challenge) {
    const recovered = ethers.utils.verifyMessage(challenge, signature);
    return recovered.toLowerCase() === address.toLowerCase();
}
```

### Option B: Trust PC2.net Auth Token

If the dApp is embedded in PC2.net, the user is already logged in. Forward the PC2.net session token:

```javascript
// In embedded dApp: get the auth token from parent
const { token } = await requestFromParent({ type: 'get-auth-token' });

// Send to your backend
// Your backend verifies the token against the pc2.net API
const verifyRes = await fetch(`${PC2_API}/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
});
```

---

## 7. Displaying the Right Wallet Address

Show users the correct address based on which wallet they're using for the purchase:

```typescript
function getPaymentAddress(walletMode: 'agent' | 'eoa') {
    if (walletMode === 'agent') {
        return smartAccountAddress; // Agent Wallet address (ERC-4337)
    }
    return eoaAddress; // Raw EOA address
}

// In your UI:
// "Purchasing from: Agent Wallet 0x7A63...1519"  ← Agent Wallet
// "Purchasing from: Wallet 0x84D3...aa1"          ← EOA
```

Note: Users may have USDC in their Agent Wallet but not in their EOA. Always check balances for the correct address.

---

## 8. Common Pitfalls to Avoid

### ❌ Never call `eth_sendTransaction` for Agent Wallet sends
```typescript
// WRONG — this sends a raw EOA transaction, not a smart account transaction
await provider.request({
    method: 'eth_sendTransaction',
    params: [{ to, value, data }],
});
```

```typescript
// CORRECT — use the 3-phase flow (create → sign rootHash → submit)
const tx = await ua.createTransferTransaction(...);
const sig = await provider.request({ method: 'personal_sign', params: [tx.rootHash, eoaAddress] });
const result = await ua.sendTransaction(tx, sig);
```

### ❌ Never assume the user has MetaMask
For email/social logins, `window.ethereum` may be undefined or belong to a different account. Always get the provider from `connector.getProvider()` for Particle-managed sessions.

### ❌ Never skip fee estimation
Agent Wallet transactions go through Particle's bundler. Fees are non-zero even if "gasless" from the user's EOA perspective. The user needs to have sufficient stablecoin balance in their Agent Wallet for the fees.

### ❌ Never hardcode chain IDs for Agent Wallet
Agent Wallet is cross-chain. The user may send USDC from their Arbitrum balance even if you're targeting Base. Let the SDK handle routing.

### ❌ Don't store the full transaction object in state
`createTransferTransaction()` returns a large object. Store only `rootHash` and the minimum fields needed for `sendTransaction()`. Pass the full object only at submit time.

---

## 9. Checklist for Elacity Market Integration

- [ ] Detect `loginMethod` from user session or wallet connector
- [ ] Determine if embedded (`isEmbedded`) or external signer
- [ ] Use `connector.getProvider()` (not `window.ethereum`) for Particle sessions
- [ ] Implement 3-phase flow for Agent Wallet sends
- [ ] Show correct address in UI (Agent Wallet vs EOA)
- [ ] Check balance on correct address before allowing purchase
- [ ] Estimate fees before submitting transaction
- [ ] Handle user rejection (`error.code === 4001`)
- [ ] Handle "insufficient balance" separately from other errors
- [ ] Poll for transaction confirmation (Agent Wallet tx IDs are internal, not on-chain hashes immediately)
- [ ] Verify backend auth against EOA address (not Agent Wallet address — the EOA is the owner)
- [ ] Test with both email login AND MetaMask login
- [ ] Test with both Agent Wallet mode AND EOA mode

---

## 10. Particle Dashboard Setup for New dApps

When creating a new dApp that uses the same Particle project:

1. Log into Particle Dashboard → Project `01cdbdd6...` (pc2.net)
2. Under the App (`a75cdd40...`): add your dApp's domain to the whitelist
3. Email login must be enabled at project level (already done)
4. Use the same credentials — no new project needed unless you want separate analytics

If you need a separate project (e.g., for Elacity Market production):
1. Create new Particle project via dashboard.particle.network
2. Create a new App within the project
3. Copy credentials to your `.env`
4. Note: client key must be ≤40 chars (validate before saving)
5. Note: App ID must be exact — double-check the digits carefully

---

*Questions? See [PARTICLE_AUTH_REFERENCE.md](./PARTICLE_AUTH_REFERENCE.md) for full technical details.*
