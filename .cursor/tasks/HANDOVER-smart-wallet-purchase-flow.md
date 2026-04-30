# Handover: Elacity Smart Wallet Purchase & IPFS Decentralization

**Created**: 2026-03-04
**Branch**: `feature/elacity-ddrm-marketplace`
**Status**: InProgress — purchase flow fix deployed, awaiting user test

---

## What This Task Is About

Making the Elacity Market dApp inside PC2 fully functional: users buy DRM-protected media with their Particle Smart Wallet (Universal Account), download it to their local IPFS node, and play it from local storage — eliminating Elacity CDN costs.

---

## Current State (as of 2026-03-04)

### COMPLETED

1. **Elacity Market dApp** — browse, search, view details, purchase flow UI (vanilla JS app at `pc2-node/data/test-apps/elacity-market/`)
2. **Elacity Media Player** — React dApp at `pc2-node/data/test-apps/elacity-player-src/`, plays DRM-protected DASH streams with `@elacity-js/media-player` SDK
3. **SIWE Authentication** — single-signature login with smart account address passed to Elacity API
4. **My Library** — shows owned assets using smart account address
5. **Auto-download on purchase** — `.edrm` descriptor files created in `/Videos/` on purchase
6. **Double-click `.edrm` to play** — opens the Elacity Player with autoplay + smart account context
7. **DRM signing flow** — SDK handles `eth_signTypedData_v4` internally via Lit Protocol
8. **Dark mode scrollbar** — matches PC2 GUI theme
9. **Smart wallet transaction routing** — IPC chain: Market app → GUI IPC → WalletService → Particle iframe → `eth_sendTransaction` via Particle provider (uses EOA as signer, smart account executes via AA)

### JUST FIXED (this session, needs testing)

**Problem**: `particle-wallet.eth-send-transaction-result` message type was missing from `WalletService.js` message handler. The Particle iframe would complete the transaction and send back the result, but WalletService never processed it — causing a timeout and the market app never receiving the `txHash`.

**Fix applied in**:
- `src/gui/src/services/WalletService.js` — Added `case 'particle-wallet.eth-send-transaction-result'` to the `messageHandler` switch, routing to `_handleGenericResult(payload, requestId)`
- Also increased timeout for transaction-type IPC requests from 30s to 120s
- Bundle rebuilt and copied to `pc2-node/frontend/bundle.min.js`

### NOT YET DONE

1. **Local IPFS playback** (eliminates CDN costs) — see section below
2. **Plan items from `app_store_and_media_market` plan** — see section below

---

## Transaction Flow Architecture (Reference)

### How elacity-web does it (the reference implementation)

Location: `/Users/mtk/Documents/Cursor/elacity-web-docs` (cloned from `https://github.com/Elacity/elacity-web.git`)

Key files:
- `src/lib/particle-network/contexts/connectkit.tsx` — ConnectKit config with chains, connectors
- `src/lib/particle-network/contexts/ParticleNetworkContext.tsx` — Gets provider from `primaryWallet.connector.getProvider()`, wraps as `Web3Provider`
- `src/lib/web3/Ecosystem.tsx` — Exposes `provider` (from Particle) to all components
- `src/lib/web3/hooks.tsx` — `useContractWithSigner()` creates ethers `Contract` with `provider.getSigner()`
- `src/lib/web3/executable/tx.ts` — `TxExecutable.invoke()` calls `contract[method](...args)` — the Particle provider internally routes through smart account via AA
- `src/components/Cinema/Media/MediaContext.tsx` — `buyAccess()` implementation (lines 140-196)

**Key insight**: In elacity-web, Particle's ConnectKit provider handles AA internally. No explicit SmartAccount wrapping in app code. When `eth_sendTransaction` is called through the Particle provider, it automatically routes through the smart account.

### How PC2 does it (our implementation)

Since PC2's Market app runs in a sandboxed iframe without direct access to Particle's React context, we use IPC:

```
Market app (wallet.js)
  → parentSendTransaction() via postMessage IPC
    → GUI IPC handler (IPC.js) receives 'walletSendTransaction'
      → walletService._sendToIframe('particle-wallet.eth-send-transaction', { txParams })
        → Particle iframe (ParticleNetworkContext.tsx) handles it
          → Sets from: connectedEoaAddress (EOA signs, smart account executes via AA)
          → provider.request({ method: 'eth_sendTransaction', params: [txParams] })
          → Sends back 'particle-wallet.eth-send-transaction-result' with { txHash }
        → WalletService receives result, resolves pending promise  ← THIS WAS THE MISSING PIECE
      → IPC handler sends txHash back to market app iframe
    → Market app receives txHash, continues purchase flow
```

### Key Files (PC2 side)

| File | Purpose |
|------|---------|
| `pc2-node/data/test-apps/elacity-market/wallet.js` | Market app wallet operations, `buyAccess()`, `parentSendTransaction()` |
| `pc2-node/data/test-apps/elacity-market/app.js` | Market app main logic, purchase flow UI |
| `pc2-node/data/test-apps/elacity-market/api.js` | Elacity GraphQL API client |
| `src/gui/src/IPC.js` | GUI IPC handler — `walletSendTransaction` case (line ~709) |
| `src/gui/src/services/WalletService.js` | Wallet service — message handler, `_sendToIframe()`, `_handleGenericResult()` |
| `packages/particle-auth/src/particle/contexts/ParticleNetworkContext.tsx` | Particle iframe — `eth-send-transaction` handler (line ~628) |
| `src/gui/src/helpers/launch_app.js` | Passes `puter.smart_account` to app iframes |
| `src/gui/src/helpers/open_item.js` | Opens `.edrm` files in player with `autoplay=true` and `smartAccount=` |
| `pc2-node/data/test-apps/elacity-player-src/src/App.tsx` | Player entry — reads smartAccount from URL |
| `pc2-node/data/test-apps/elacity-player-src/src/MediaPlayer.tsx` | Player core — DRM + autoplay logic |

---

## Remaining Work: Local IPFS Playback (CDN Cost Elimination)

### Current State
- Purchased media is downloaded and pinned to the user's local IPFS node (Helia)
- But playback still streams from `https://ipfs.ela.city/ipfs/` (Elacity CDN gateway)
- The local IPFS gateway at `localhost:4200` does NOT support UnixFS DAG path resolution (e.g., `/ipfs/<rootCID>/stream.mpd`)

### What's Needed

1. **Add UnixFS DAG path resolution to the local IPFS gateway**
   - Currently `localhost:4200/ipfs/<CID>` only resolves flat CIDs
   - DASH streams are stored as a directory DAG: `<rootCID>/stream.mpd`, `<rootCID>/segment-0.m4s`, etc.
   - Need to resolve paths like `/ipfs/<rootCID>/stream.mpd` by traversing the UnixFS DAG
   - Relevant code: `pc2-node/src/api/ipfs.ts` (IPFS API routes)

2. **Have the player prefer `localhost:4200/ipfs/` when content is locally pinned**
   - Check if content is available locally before streaming
   - Fall back to `https://ipfs.ela.city/ipfs/` if not locally available
   - This change goes in the player's stream URL resolution logic

### Impact
- Eliminates per-stream bandwidth costs for Elacity
- Each PC2 node becomes a CDN peer for content it owns
- Fully decentralizes content delivery

---

## Remaining Plan Items (from app_store_and_media_market plan)

### `purchase-flow` (in_progress)
- Smart wallet purchase routing ← **just fixed, testing now**
- Test with real USDC on Base chain

### `smart-wallet` (pending)
- The plan item says "Add Universal Account support" — most of this is now done via the IPC chain
- Still pending: giving user a choice between EOA and Smart Wallet for purchases

### `cdn-effect` (pending)
- Enable auto-pin + DHT announce for purchased content
- This is the IPFS local playback work described above

### `registry` (pending)
- Design app registry manifest format
- Supernode `/api/registry/apps` endpoint for CID discovery

### `app-build-pipeline` (pending)
- Vite build → static bundle → IPFS pin → CID → registry entry
- Document for third-party devs

### `app-center-rebuild` (pending)
- Rebuild App Center UI against real backend APIs

### `packager-backend` (pending)
- Integrate media-packager into pc2-node

### `app-factory` (pending)
- Build App Factory — local app packaging pipeline

---

## How to Resume

1. Open PC2 at `http://localhost:4200`
2. Open Elacity Market app
3. Sign in (single SIWE signature)
4. Browse and try to purchase a video
5. The purchase should route through the smart wallet (sign with EOA, execute via smart account)
6. After purchase, the video should auto-download as `.edrm` file in `/Videos/`
7. Double-click `.edrm` to play in Elacity Player

If purchase fails, check browser console for:
- `walletSendTransaction` IPC messages
- `eth-send-transaction-result` responses
- Timeout errors (now 120s for transactions)

Key debug points:
- Market app console: `parentSendTransaction` call
- GUI console: `walletService._sendToIframe` call
- Particle iframe console: `eth_sendTransaction` provider call

---

## Build & Deploy Notes

- GUI source: `src/gui/src/` → build with `npx webpack --mode production` in `src/gui/`
- GUI bundle output: `src/gui/dist/bundle.min.js`
- **Must copy to**: `pc2-node/frontend/bundle.min.js` (this is what the server serves)
- Server: `cd pc2-node && npm run dev` (runs on port 4200)
- Particle auth: `packages/particle-auth/` — built separately, served from `/particle-auth` route
