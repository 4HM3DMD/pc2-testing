# @elacity-js/access — Technical Specification

> **Purpose:** Complete technical spec for the universal access layer package that extracts Lit Protocol key retrieval from `@elacity-js/media-player` into a standalone, asset-agnostic SDK.
> **Created:** 2026-03-13
> **Status:** Design complete — ready for implementation
> **Branch:** `dDRM-extended` (implementation)

---

## Overview

`@elacity-js/access` is the critical SDK unlock that enables Elacity's dDRM protocol to protect ANY digital asset — not just streaming media. It extracts the Lit Protocol access control, key retrieval, wallet signing, and certificate caching from `@elacity-js/media-player` into a standalone package usable by any consumer.

**Related Documents:**
- [ELACITY_UNIVERSAL_ASSET_STRATEGY.md](./ELACITY_UNIVERSAL_ASSET_STRATEGY.md) — marketplace verticals, revenue model
- [ARCHITECTURE_CONVERGENCE.md](./ARCHITECTURE_CONVERGENCE.md) — Part 15: dDRM as universal access layer
- [ROADMAP.md](./ROADMAP.md) — SDK evolution milestones

---

## Architecture

### Current State (Monolithic)

```
@elacity-js/media-player (index.js: 4.5MB, player.wasm: 19.3MB)
  ├── Lit Protocol client init + session management
  ├── ACCESS_TOKEN ownership check (AuthorityGateway.hasAccess)
  ├── PSSH payload construction (prepare_payload)
  ├── License acquisition (__protocol__acquire_license handler)
  ├── Wallet signing (EIP-712 for Lit auth)
  ├── Certificate caching
  ├── Key delivery to WASM worker (postMessage → license_receiver_callback)
  ├── DASH demuxing (MPD parse, segment fetch)
  ├── CENC AES decryption (in WASM)
  ├── MediaSource API (SourceBuffer append)
  └── media-chrome UI
```

The top 7 items are asset-agnostic. The bottom 4 are media-specific.

### Target State (Extracted)

```
@elacity-js/access (NEW — universal, ~200KB)
  ├── Lit Protocol client init + session management
  ├── ACCESS_TOKEN ownership verification
  ├── Key retrieval from Lit Network
  ├── Wallet signing flow (EOA + Smart Account)
  ├── Certificate caching
  ├── AES-GCM encrypt/decrypt (WebCrypto — for non-media assets)
  └── CENC-compatible acquireLicense() (for media-player backward compat)

@elacity-js/media-player (unchanged API, but internally delegates to @access)
  ├── DASH demuxing
  ├── CENC AES decryption (in WASM)
  ├── MediaSource API
  └── media-chrome UI
```

---

## Implementation Approach: Clean-Room Build

Build from scratch using the Lit Protocol SDK directly, NOT by decompiling `media-player`'s 4.5MB index.js. Rationale:

1. Asset-agnostic API design from day one
2. No coupling to WASM worker messaging (`postMessage`, `license_receiver_callback`)
3. Clean dependency tree (no 19MB WASM blob)
4. Works in both browser AND Node.js (critical for agent-to-agent commerce)
5. Lit Protocol SDK is well-documented — we know the exact flow from player analysis

---

## Package API

### Core Interface

```typescript
import { ElacityAccess, ConnectOptions, DecryptionKey } from '@elacity-js/access';

// Create instance (NOT a singleton — capsule-compatible)
const access = new ElacityAccess();

// Connect with wallet provider
await access.connect(provider, {
  chainId: 8453,                    // Base
  litNetwork: 'cayenne',
  drmSystems: {
    'cenc:lit-drm-v1': { priority: 1 },
    'cenc:lit-drm-sa-v1': { priority: 0 },
  },
  smartAccount: '0x...',            // Particle UA address (optional)
});

// Check access
const verification = await access.verifyAccess({
  ledger: '0xChannelAddress',
  tokenId: '42',
});
// Returns: { hasAccess: true, tokenBalance: 1n, operative: '0x...', capabilities: [] }

// Get decryption key
const key = await access.acquireKey({
  ledger: '0xChannelAddress',
  tokenId: '42',
});
// Returns: { raw: Uint8Array, keyId: '...', algorithm: 'aes-gcm', expiresAt: ... }

// Decrypt a buffer (non-media: AES-GCM via WebCrypto)
const decrypted = await access.decryptBuffer(encryptedData, key);

// High-level: fetch from IPFS + decrypt
const data = await access.fetchAndDecrypt({
  cid: 'QmEncryptedContent...',
  ledger: '0xChannelAddress',
  tokenId: '42',
  gateway: 'http://localhost:4200/ipfs/',
});

// For media-player backward compatibility (CENC license format)
const license = await access.acquireLicense({
  payload: psshPayload,  // From WASM worker
  refs: psshRefs,        // DRM system refs
});

// Creator side: encrypt a file
const { encrypted, conditions } = await access.encryptBuffer(rawData, {
  ledger: '0xChannelAddress',
  tokenId: '42',
  algorithm: 'aes-gcm',
});

// Events
access.on('sign_request', () => { /* show signing UI */ });
access.on('sign_error', (err) => { /* handle error */ });

// Cleanup
await access.disconnect();
```

### Type Definitions

```typescript
interface ElacityAccess {
  connect(provider: EthereumProvider, options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;

  verifyAccess(params: VerifyAccessParams): Promise<AccessVerification>;
  acquireKey(params: AcquireKeyParams): Promise<DecryptionKey>;
  acquireLicense(params: AcquireLicenseParams): Promise<Uint8Array>;

  encryptBuffer(data: Uint8Array, params: EncryptParams): Promise<EncryptResult>;
  decryptBuffer(encrypted: Uint8Array, key: DecryptionKey): Promise<Uint8Array>;
  fetchAndDecrypt(params: FetchDecryptParams): Promise<Uint8Array>;

  on(event: AccessEvent, handler: Function): void;
  off(event: AccessEvent, handler: Function): void;
}

type DrmSystemType = 'cenc:lit-drm-v1' | 'cenc:lit-drm-sa-v1' | 'cenc:web3-drm-v1';

interface ConnectOptions {
  chainId?: number;                 // Default: 8453 (Base)
  litNetwork?: string;              // Default: 'cayenne'
  drmSystems?: Partial<Record<DrmSystemType, { priority: number; disabled?: boolean }>>;
  smartAccount?: string;            // Particle Smart Account address
  authorityGateway?: string;        // Override default AuthorityGateway address
}

interface AccessVerification {
  hasAccess: boolean;
  tokenBalance: bigint;
  operative: string;
  // Forward-compatible with Runtime capability tokens:
  capabilities?: string[];          // e.g., ["decrypt", "stream", "execute"]
  grantedBy?: string;               // Capability token issuer (Runtime v2)
  auditRef?: string;                // Audit trail reference (Runtime v2)
  expiresAt?: number;               // Subscription expiry timestamp
}

interface DecryptionKey {
  raw: Uint8Array;
  keyId: string;
  algorithm: 'aes-gcm' | 'aes-ctr' | 'aes-cbc';
  expiresAt?: number;
}

interface EncryptResult {
  encrypted: Uint8Array;
  conditions: LitAccessCondition[];
  keyId: string;
  algorithm: string;
}

type AccessEvent = 'sign_request' | 'sign_error' | 'connected' | 'disconnected';
```

---

## Internal Architecture

### File Structure

```
packages/access/
  src/
    index.ts                  # Public API exports
    client.ts                 # ElacityAccess class implementation
    lit/
      session.ts              # LitNodeClient init, session management, cert caching
      conditions.ts           # Access condition builders (ACCESS_TOKEN checks)
      key-retrieval.ts        # Key acquisition from Lit nodes
    crypto/
      decrypt.ts              # AES-GCM/CTR decryption via WebCrypto
      encrypt.ts              # AES-GCM encryption via WebCrypto (creator side)
      payload.ts              # PSSH payload construction (CENC backward compat)
    verify/
      access-token.ts         # On-chain ACCESS_TOKEN verification via AuthorityGateway
      subscription.ts         # SubscriptionModule checks
    fetch/
      ipfs.ts                 # IPFS gateway fetch helper
    types.ts                  # All TypeScript interfaces
    constants.ts              # Chain IDs, contract addresses, Lit config
    events.ts                 # EventEmitter for sign_request, etc.
  node/
    index.ts                  # Node.js entry point (uses lit-node-client-nodejs)
  package.json
  tsconfig.json
  tsconfig.node.json          # Separate config for Node.js build
  README.md
```

### Dependencies

```json
{
  "name": "@elacity-js/access",
  "version": "0.1.0",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./node": {
      "import": "./dist/node/index.mjs",
      "require": "./dist/node/index.js",
      "types": "./dist/node/index.d.ts"
    }
  },
  "dependencies": {
    "@lit-protocol/lit-node-client": "7.3.0",
    "@lit-protocol/auth-helpers": "7.3.0",
    "@lit-protocol/constants": "7.3.0",
    "@lit-protocol/crypto": "7.3.0",
    "@lit-protocol/types": "7.3.0",
    "@elacity-js/contracts": "^0.8.2-beta.24",
    "@elacity-js/common": "^1.0.0-beta.24",
    "ethers": "^6.0.0"
  },
  "devDependencies": {
    "@lit-protocol/lit-node-client-nodejs": "7.3.0",
    "tsup": "^8.0.0",
    "typescript": "~5.9.0",
    "vitest": "^3.0.0"
  },
  "peerDependencies": {
    "ethers": "^6.0.0"
  }
}
```

All `@lit-protocol/*` pinned to 7.3.0 — matches current media-player overrides exactly.

---

## Security Model

### Key Protection Levels

| Layer | Protection | Limitation |
|-------|-----------|------------|
| **Lit Protocol access gate** | Cannot get key without ACCESS_TOKEN (on-chain) | Relies on Lit Network availability |
| **Wallet signature** | EIP-712 signature proves wallet ownership | Key transits JS heap after retrieval |
| **Session certificates** | Cached to avoid re-signing | Session-scoped, ephemeral |
| **WebCrypto (non-media)** | AES-GCM in browser crypto subsystem | Decrypted file is in JS memory |
| **WASM (media)** | Key in WASM linear memory, compiled decryption | Equivalent to Widevine L3 |

### Security by Asset Type

**Streaming media (video/audio):**
- Key passes from `@elacity-js/access` to `@elacity-js/media-player` WASM
- WASM decrypts segments in linear memory (obfuscated)
- Decrypted frames go to MediaSource API — never a raw file on disk
- Security level: Widevine L3 equivalent (same as Netflix in browsers)

**Non-media files (models, code, datasets, documents):**
- Key retrieved by `@elacity-js/access`, decryption via WebCrypto AES-GCM
- Decrypted content is a raw buffer in memory
- This is by design — matches every software license model (Steam, Adobe, Kindle)
- DRM prevents **unauthorized** access, not redistribution by authorized purchasers
- Royalties distributed at purchase time, on-chain audit trail

**Server-side decryption (PC2 node — NO COOP/COEP issues):**
- Non-media assets can decrypt on the PC2 Node.js backend
- Uses `@elacity-js/access/node` entry point
- No browser, no SharedArrayBuffer, no popup windows
- AI models decrypt → load into Ollama directly
- Entirely within the user's PC2 node

### Runtime v2 Security Upgrade

When the Rust Runtime arrives, `@elacity-js/access` transitions to a WASM capsule:

```
Today:  dApp → access (JS) → key in JS heap → WebCrypto decrypt
v2:     App Capsule → capability token → Access Capsule (WASM sandbox)
        → key NEVER leaves sandbox → decrypted bytes via capability-gated pipe
```

Design decisions that enable this transition:
1. **Stateless key retrieval** — `acquireKey()` is pure request/response, no persistent state
2. **No singletons** — instantiable client, maps to per-capsule instances
3. **Separated operations** — verify, acquire, decrypt are independent (Runtime inserts capability token issuance between steps)
4. **Extensible types** — `AccessVerification.capabilities` field ready for Runtime grants
5. **Protocol addressing** — CID references compatible with `elastos://cid/` scheme

---

## Contract Architecture (Unchanged — Already Universal)

Every asset follows the same on-chain pattern:

```
Channel (ERC-1155)
  └── tokenId: N
       ├── metadata.asset.uri = "ipfs://QmEncryptedCID"
       ├── metadata.asset.assetType = "ai-model" | "code" | "document" | ...
       ├── metadata.asset.protectionType = ["cenc:lit-drm-v1"]
       └── Operative contract
            ├── access model (Buy&Play, Buy&Sell, Rent, PPV)
            ├── paymentProcessor() → ERC-20 approval target
            ├── RoyaltyModule (multi-stakeholder splits, 1000 shares = 100%)
            └── SubscriptionModule (time-based access, optional)

AuthorityGateway
  ├── buyAccess(seller, ledger, tokenId, qty, price[, payToken])
  │   → mints ACCESS_TOKEN (ERC-1155) to buyer
  ├── hasAccess(wallet, ledger, tokenId) → bool
  └── listings() → marketplace view

Lit Protocol conditions (off-chain, keyed to on-chain state):
  "wallet must hold ACCESS_TOKEN for channel=0x... tokenId=42 on Base (8453)"
```

---

## Marketplace Tiers

### Tier 1: Quick Markets (Days — File In, File Out)

| Market | Asset Types | Consumer Action on PC2 |
|--------|------------|----------------------|
| E-books / Documents | PDF, ePub, DOCX | Decrypt → open in Puter viewer |
| Stock Photography | JPG, PNG, RAW | Decrypt → view/download |
| Audio / Music | MP3, WAV, FLAC | Decrypt → HTML5 `<audio>` (no WASM) |
| Design Templates | PSD, HTML/CSS, Figma | Decrypt → download |
| Fonts | OTF, TTF, WOFF2 | Decrypt → install/download |
| 3D Models | glTF, FBX, OBJ | Decrypt → Three.js viewer |

All use the same flow: `access.fetchAndDecrypt()` → save or open. No special runtime needed.

### Tier 2: Medium Markets (Weeks — Local Runtime Integration)

| Market | Asset Types | Consumer Action on PC2 |
|--------|------------|----------------------|
| AI Models | GGUF, SafeTensors, ONNX | Decrypt on node → `ollama create` → chat |
| Code / Plugins | npm, pip packages | Decrypt → install in sandbox |
| Datasets | CSV, Parquet, JSON-L | Decrypt → import to SQLite/embeddings |
| PC2 dApps | HTML/JS/CSS bundles | Decrypt → install via AppInstallService |

Need PC2 backend endpoints: `POST /api/models/install`, `POST /api/datasets/import`, etc.

### Tier 3: Complex Markets (Months — New Infrastructure)

| Market | Asset Types | What's Needed |
|--------|------------|--------------|
| Software Licensing | Executables | Capsule sandboxes (Runtime v2) |
| API Marketplace | Endpoint access | Metering, rate limiting |
| Agent Marketplace | LLM agents, skills | ERC-8004, agent runtime |
| Compute Marketplace | GPU/CPU time | Metering, attestation, TEE |

---

## Integration Points

### With Existing Media Player

The CTO integrates `@elacity-js/access` into `@elacity-js/media-player` by:
1. Adding `@elacity-js/access` as dependency
2. Replacing the `__protocol__acquire_license` handler to call `access.acquireLicense()`
3. Everything downstream (WASM, MSE, playback) stays unchanged
4. Consumer API (`setup()`, `create()`, `setProvider()`) stays unchanged

### With PC2 Node Backend

For server-side decryption (AI models, code, datasets):
```typescript
// pc2-node/src/api/assets.ts (new endpoint)
import { ElacityAccess } from '@elacity-js/access/node';

app.post('/api/assets/decrypt', async (req, res) => {
  const { cid, ledger, tokenId } = req.body;
  const access = new ElacityAccess();
  await access.connect(nodeWalletProvider, { chainId: 8453 });
  const data = await access.fetchAndDecrypt({ cid, ledger, tokenId });
  // Save to local storage, load into Ollama, etc.
});
```

### With Creator Dashboard dApp

For encrypting content before upload:
```typescript
const { encrypted, conditions } = await access.encryptBuffer(fileData, {
  ledger: channelAddress,
  tokenId: nextTokenId,
});
// Upload encrypted to IPFS
const cid = await pc2Fetch('/api/storage/ipfs/pin', { body: encrypted });
// Mint on-chain
await wallet.mint(channelAddress, metadataUri, ...);
```

### With Elacity Market dApp

Add "Download & Decrypt" button for non-media assets (alongside existing "Play" for media):
```javascript
// In app.js — detect asset type from metadata
if (asset.metadata.asset && asset.metadata.asset.assetType !== 'video') {
  // Non-media: download, decrypt locally, save to PC2 filesystem
  const data = await access.fetchAndDecrypt({ cid, ledger, tokenId });
  await pc2Fetch('/api/write', { body: data, filename: asset.name });
}
```

---

## Execution Plan

1. **Scaffold package** — structure, tsconfig, package.json, dependencies
2. **Lit session management** — connect, session sigs, certificate cache
3. **verifyAccess()** — AuthorityGateway.hasAccess() via @elacity-js/contracts
4. **acquireKey()** — Lit Protocol key retrieval with access conditions
5. **encryptBuffer() / decryptBuffer()** — WebCrypto AES-GCM (creator + consumer)
6. **acquireLicense()** — CENC-compatible format for media-player backward compat
7. **fetchAndDecrypt()** — IPFS gateway fetch + decrypt convenience
8. **Node.js entry point** — `@elacity-js/access/node` using lit-node-client-nodejs
9. **Integration test** — verify against real Elacity content on Base
10. **Creator Dashboard dApp** — first consumer of encrypt side
11. **AI Model Marketplace** — first non-media vertical (GGUF → Ollama)

---

*This document is the technical source of truth for the @elacity-js/access package. Update as implementation progresses.*
