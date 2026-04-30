# Lit Protocol Chipotle — Developer Handover

> Complete reference for the Chipotle (Lit v3 TEE) integration in Elacity dDRM.
> All credentials, architecture decisions, and operational details in one place.

---

## 1. Dashboard Access

**Lit Express Dashboard:** https://dashboard.dev.litprotocol.com/ *(dev network — will change for production)*

| Credential | Value | Purpose |
|-----------|-------|---------|
| **Account Key** | *(stored in `data/.chipotle-account-key`, never committed)* | Dashboard management — create/edit API keys, groups, PKPs. NOT for executing Lit Actions. |
| **Usage API Key** | *(stored in `data/.chipotle-api-key`, never committed)* | Runtime key — all PC2 nodes use this to execute Lit Actions. Key name: `pc2-ddrm-v3`. |
| **PKP ID** | `0x09bdfc8f8ec5a3bd2970497b930bd94839f22227` | Account Master Wallet (new dev network). Used for `Lit.Actions.Encrypt/Decrypt`. (Public on-chain — safe to publish.) |
| **Group** | `elacity-ddrm` (group_id: 1) | Scopes the usage key to permitted PKPs and actions. |

**API Endpoints:**
- Dev: `https://api.dev.litprotocol.com` (current default)
- Prod: `https://api.litprotocol.com` (for mainnet launch)

---

## 2. Architecture — How It Fits Together

```
┌─────────────────────────────────────────────────────────────┐
│                     ELACITY dDRM STACK                       │
│                  (ALL proprietary / ours)                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ENCRYPT (Creator mints asset):                              │
│    1. PC2 node generates random 32-byte CEK                  │
│    2. File encrypted with AES-256-GCM using CEK (Layer 1)    │
│    3. CEK base64 string sent to Chipotle TEE                 │
│       → Lit.Actions.Encrypt({ pkpId, message: cekBase64 })   │
│    4. Returns hex ciphertext (Layer 2)                       │
│    5. Encrypted file → IPFS, ciphertext → on-chain metadata  │
│                                                              │
│  DECRYPT (Buyer views asset):                                │
│    1. Server sends Lit Action code to Chipotle TEE           │
│    2. TEE checks on-chain: hasAccessByContentId(buyer, kid)  │
│    3. If access: Lit.Actions.Decrypt({ pkpId, ciphertext })  │
│       → Returns original CEK base64 string                   │
│    4. Server decrypts file with AES-256-GCM + recovered CEK  │
│    5. WASM renderer converts to pixels (never raw to browser)│
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Lit Protocol = KEY VAULT ONLY                               │
│  They never see the file, only the 44-char CEK string        │
└─────────────────────────────────────────────────────────────┘
```

### Non-Media vs Media

| | Non-Media (images, PDFs, text, code) | Media (video, audio) |
|---|---|---|
| **File encryption** | AES-256-GCM (32-byte CEK) | CENC AES-128-CTR (16-byte CEK) |
| **CEK protection** | Chipotle PKP-AES direct | ECDH P-256 envelope wrapping |
| **Lit Action** | `non-media-decrypt-chipotle.js` | Media-specific action (ECDH) |
| **Rendering** | WASM sandbox → pixels | WASM cenc-decrypt → MSE player |
| **Chipotle status** | **Working E2E** | Wired, untested |

---

## 3. Key Files

### Core Chipotle Client
| File | Purpose |
|------|---------|
| `pc2-node/src/api/chipotle-client.ts` | REST client replacing entire Lit SDK. `encryptWithLitAction()`, `recoverNonMediaCEK()`, `recoverMediaCEKEnvelope()`. Three-tier API key resolution. |

### Lit Actions (run inside TEE)
| File | IPFS CID | Purpose |
|------|----------|---------|
| `pc2-node/data/lit-actions/non-media-encrypt-chipotle.js` | `QmUdZUxe6BVoXiZcw4hE86YCHsgQVGEmgbN6sr7MhnL8pp` | Chipotle: PKP-AES encrypt CEK |
| `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` | `QmfWksjQkuLxVGEZdHrbFKxUb2sL4K34bLYbD3mAKv2CZA` | Chipotle: on-chain access check + PKP-AES decrypt |
| `pc2-node/data/lit-actions/non-media-decrypt.js` | `QmQbJDg5nXVdbZhzd4BJAAsMfi8J6jwawfm2JFKjAvN62z` | Datil (legacy): on-chain access check + threshold BLS decrypt |

### Server Routes
| File | Routes |
|------|--------|
| `pc2-node/src/api/storage.ts` | `POST /lit/encrypt`, `POST /lit/secure-view`, `GET /lit/server-info` |
| `pc2-node/src/api/media.ts` | `POST /media/prepare-auth`, `POST /media/init`, `GET /media/segment` |

### Frontend (dApps in iframes)
| File | Purpose |
|------|---------|
| `pc2-node/data/test-apps/elacity-creator/app.js` | Creator: encrypt → IPFS → mint. Stores `litBackend` in metadata. |
| `pc2-node/data/test-apps/elacity-market/app.js` | Market: buy → open viewer. Passes `litBackend` to viewer. |
| `pc2-node/data/test-apps/ddrm-viewer/viewer.js` | Viewer: calls `/lit/secure-view` with `litBackend` field. |

---

## 4. Configuration

### Environment Variables (all optional — defaults work)
| Variable | Default | Purpose |
|----------|---------|---------|
| `LIT_BACKEND` | `chipotle` | `chipotle` or `datil`. Controls which Lit backend is used. |
| `LIT_CHIPOTLE_USAGE_KEY` | *(from `data/.chipotle-api-key`)* | Override the Tier 1 shared API key |
| `LIT_CHIPOTLE_USER_KEY` | none | Tier 2: self-sovereign key (takes priority) |
| `LIT_CHIPOTLE_API_URL` | `https://api.dev.litprotocol.com` | Chipotle API endpoint |
| `LIT_ACTION_CID` | `QmVMgKMKFELHTZf8PmD58nYBhr4S5DHLpuwFTvyDKLPXgq` | Override Lit Action IPFS CID |

### API Key Resolution Order (Tier system)
1. **Tier 2**: `LIT_CHIPOTLE_USER_KEY` env → `data/.chipotle-user-key` file
2. **Tier 1**: `LIT_CHIPOTLE_USAGE_KEY` env → `data/.chipotle-api-key` file
3. **Auto-provision**: Cached `data/.chipotle-provision.json` (from prior supernode fetch)
4. **Supernode fetch**: `GET https://<supernode>/api/ddrm/provision` → saves key + config locally

For a fresh node: the first encrypt/decrypt operation triggers auto-provisioning from an Elacity supernode. The supernode serves the shared usage key + PKP ID + API URL. The key is cached locally so subsequent operations don't require network access.

### Auto-Provisioning Architecture
```
Fresh PC2 Node → first dDRM operation → no key found locally
  → tries GET https://69.164.241.210/api/ddrm/provision
  → tries GET https://38.242.211.112/api/ddrm/provision
  → receives { usageKey, pkpId, apiUrl, network, actions }
  → writes data/.chipotle-api-key + data/.chipotle-provision.json
  → all subsequent operations use cached key
```

### Supernode Setup (for operators)
Each supernode must have the usage key file deployed:
```bash
# On supernode server
mkdir -p /etc/pc2
echo "YOUR_USAGE_API_KEY_HERE" > /etc/pc2/ddrm-api-key
echo "0x09bdfc8f8ec5a3bd2970497b930bd94839f22227" > /etc/pc2/ddrm-pkp-id
chmod 600 /etc/pc2/ddrm-api-key /etc/pc2/ddrm-pkp-id
```

### Pre-Production Checklist
See `docs/core/LIT_PRODUCTION_CHECKLIST.md` for the complete list of changes needed when Lit Protocol moves to production.

---

## 5. Chipotle vs Datil — Critical Differences

| | Datil (deprecated ~Apr 25, 2026) | Chipotle (current) |
|---|---|---|
| **SDK** | `@lit-protocol/*` v7.3.0 (WebSocket, heavy) | Single REST call (no SDK) |
| **Auth** | SIWE + Capacity Credits + Session Sigs | API key in `X-Api-Key` header |
| **Crypto** | Threshold BLS (multi-node) | PKP-AES (single TEE) |
| **Encrypt** | `client.encrypt()` | `Lit.Actions.Encrypt({ pkpId, message })` |
| **Decrypt** | `decryptAndCombine()` | `Lit.Actions.Decrypt({ pkpId, ciphertext })` |
| **Action execution** | `client.executeJs({ ipfsId })` | `POST /core/v1/lit_action { code }` |
| **Code delivery** | IPFS CID (fetched by nodes) | Inline code in request body |
| **Compatibility** | NOT cross-compatible — Datil-encrypted cannot be decrypted by Chipotle, and vice versa |

### Per-Asset Backend Tracking
Each asset's metadata contains `litBackend: 'chipotle' | 'datil'`. The decrypt route reads this per-request and routes to the correct backend. If absent, falls back to the server's `LIT_BACKEND` default.

---

## 6. Lit Dashboard — How to Manage

### Creating a New Usage API Key
1. Go to https://dashboard.dev.litprotocol.com/ *(will change for production)*
2. Log in with the Account Key
3. Navigate to "Usage API Keys"
4. Click "Create Usage API Key"
5. Name it descriptively (e.g., `pc2-ddrm-v2`)
6. Under **"Can execute in groups"**, select `elacity-ddrm`
7. Save — copy the key immediately (shown once)

### Adding a PKP to the Group
If you need to add a new PKP wallet:
```bash
# Read account key from local secrets file (never hardcode in scripts)
ACCOUNT_KEY=$(cat data/.chipotle-account-key)

curl -X POST https://api.dev.litprotocol.com/core/v1/add_pkp_to_group \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ACCOUNT_KEY" \
  -d '{"group_id": 1, "pkp_id": "0xNEW_PKP_ADDRESS"}'
```

### Available Lit.Actions Methods (Chipotle TEE)
```
Decrypt, Encrypt, getPrivateKey, getLitActionPrivateKey,
getLitActionPublicKey, getLitActionWalletAddress, setResponse
```

Note: `decryptAndCombine`, `signAndCombineEcdsa`, `signEcdsa` are **NOT available** (those are Datil-only).

---

## 7. On-Chain Contracts (Base 8453)

| Contract | Address | Purpose |
|----------|---------|---------|
| AuthorityGateway | `0x580c26DefF267EF40A72CF10A4A42050F0641b8B` | `hasAccessByContentId()` — checked inside Lit Action |
| CoreStorage | `0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575` | Asset registry |
| ChannelCore | `0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6` | Channel creation + minting |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment (6 decimals) |

---

## 8. Encryption Format

### Asset Metadata Envelope (stored on IPFS)
```json
{
  "schema": "elacity-asset-envelope-v1",
  "asset": {
    "cid": "Qm...",
    "encrypted": true,
    "algorithm": "aes-256-gcm",
    "protectionType": "lit-aes-gcm-v1",
    "litCiphertext": "<hex string from Lit.Actions.Encrypt>",
    "iv": "<base64 AES-GCM IV>",
    "dataToEncryptHash": "<sha256 hex>",
    "litBackend": "chipotle",
    "actionCid": "QmVMgKMKFELHTZf8PmD58nYBhr4S5DHLpuwFTvyDKLPXgq",
    "authority": "0x580c26DefF267EF40A72CF10A4A42050F0641b8B",
    "chain": "base",
    "chainId": 8453,
    "rpc": "https://mainnet.base.org"
  }
}
```

### CEK Encoding (important — was a bug source)
- Raw CEK: 32 bytes
- Base64: 44 characters (this is what Lit encrypts/decrypts)
- Single decode: `Buffer.from(cekBase64, 'base64')` → 32 bytes
- No double encoding — the `encryptWithLitAction` passes the base64 string directly as a `js_param`

---

## 9. Testing

### Quick Smoke Test (no wallet needed)
```bash
# Start node
cd pc2-node && PORT=4200 node dist/index.js

# Check backend
curl http://localhost:4200/api/storage/lit/server-info | jq .backend
# Should return: "chipotle"

# Encrypt test
curl -X POST http://localhost:4200/api/storage/lit/encrypt \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mock-token" \
  -d '{"data":"'$(echo -n "Hello test" | base64)'"}' | jq .litBackend
# Should return: "chipotle"
```

### Full E2E Test (requires wallet + USDC)
1. Open Creator Dashboard → select file → encrypt → upload → mint
2. Open Market → find asset → buy AccessToken (costs USDC on Base)
3. Click "Open" → dDRM Viewer decrypts and renders

### Phase 0 Test Script
```bash
node pc2-node/scripts/test-chipotle-phase0.mjs
```
Tests: API reachability, auth, ethers compatibility, RPC calls from TEE, code execution.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `API key cannot use selected wallet` | PKP not in group | Add PKP via REST API (see section 6) |
| `not authorized to execute the specified action` | Using Account Key instead of Usage Key | Account Key is for management only. Use Usage API Key for Lit Action execution. |
| `decryptAndCombine is not a function` | Running Datil code on Chipotle | Use `Lit.Actions.Decrypt` instead |
| CEK 44 bytes instead of 32 | Double base64 encoding | Ensure `encryptWithLitAction` passes plaintext string, not re-encoded base64 |
| `Chipotle non-media Lit Action not found` | `data/lit-actions/` missing | Run `git checkout -- pc2-node/data/lit-actions/` |
| Decrypt fails for old assets | Asset encrypted with Datil, server running Chipotle | Set `LIT_BACKEND=datil` or check asset metadata `litBackend` field |

---

## 11. Release Status — v1.2.0 Readiness

### DONE (code complete, tested)
- [x] `chipotle-client.ts` REST module — encrypt/decrypt via Lit Chipotle REST API
- [x] `non-media-encrypt-chipotle.js` — pinned Lit Action for encryption (CID registered)
- [x] `non-media-decrypt-chipotle.js` — pinned Lit Action for decryption with on-chain access check (CID registered)
- [x] `LIT_BACKEND` feature flag — defaults to `chipotle`, falls back to `datil` for old assets
- [x] Per-asset `litBackend` metadata — each asset records which backend was used for its CEK
- [x] Auto-provisioning client code — fresh nodes automatically fetch API key from supernodes
- [x] Gateway `/api/ddrm/provision` endpoint — coded in `deploy/web-gateway/index.js`
- [x] E2E verified: PDF, image, text — all encrypt/decrypt on Chipotle dev network
- [x] Lit Dashboard setup: group `elacity-ddrm`, PKP authorized, IPFS Actions registered
- [x] Production checklist documented (`LIT_PRODUCTION_CHECKLIST.md`)

### NOT DONE (v1.2.0 release blockers)
- [ ] **Deploy updated gateway to supernodes** — The `/api/ddrm/provision` endpoint is in the codebase but NOT deployed. Both supernodes (InterServer `69.164.241.210`, Contabo `38.242.211.112`) need the updated `web-gateway/index.js`.
- [ ] **Write usage key to supernodes** — `/etc/pc2/ddrm-api-key` and `/etc/pc2/ddrm-pkp-id` must be provisioned on each supernode.
- [ ] **E2E verification from clean node** — Spin up a fresh PC2 node with no local key, confirm auto-provisioning works.
- [ ] **Git commit all changes** — Gateway code, client code, Lit Action files, and docs must be committed and pushed.

### NOT DONE (ship in v1.2.1 or later)
- [ ] Media pipeline on Chipotle (video/audio DASH/CENC) — waiting for encoder code
- [ ] Lit production network migration — when Lit ships production, rotate keys/CIDs per `LIT_PRODUCTION_CHECKLIST.md`
- [ ] Self-sovereign API key settings UI for Tier 2 operators
- [ ] Cost analysis for 100+ node network

---

## 12. Future Work

1. **Media playback on Chipotle** — ECDH envelope path wired but untested
2. **Datil deprecation (~Apr 25, 2026)** — All existing assets need re-encryption or Lit must provide backward compatibility
3. **Self-sovereign API keys** — Settings UI for node operators to bring their own Lit key (Tier 2)
4. **Cost analysis** — Per-call pricing for 100+ node network
5. **Production migration** — Switch to production Lit network when announced. See `LIT_PRODUCTION_CHECKLIST.md`
6. **Deploy provisioning to supernodes** — Write usage key to `/etc/pc2/ddrm-api-key` on both InterServer and Contabo

### IPFS Actions Registered on Dashboard

All Lit Actions must be registered as IPFS Actions on the Lit dashboard. The new dev network requires explicit CID registration even for inline code.

| Name | CID | Registered |
|------|-----|-----------|
| `non-media-encrypt-chipotle` | `QmUdZUxe6BVoXiZcw4hE86YCHsgQVGEmgbN6sr7MhnL8pp` | Yes |
| `non-media-decrypt-chipotle` | `QmfWksjQkuLxVGEZdHrbFKxUb2sL4K34bLYbD3mAKv2CZA` | Yes |
| `ddrm` (test action) | (dashboard-only) | Yes |
| `Encrypt` (legacy inline) | (dashboard-only) | Yes |
| `test-decrypt` | `QmUm5dDNufxLWfchfwRe9SxtJ7YNRyd3zC8Mt9huHebnNy` | Yes |

> **Important:** If you modify any Lit Action `.js` file, the CID changes. You must re-compute the CID (`ipfs add --only-hash --cid-version 0 <file>`) and register the new CID on the dashboard + update the supernode provision config.

---

*Last updated: Mar 18, 2026 — v1.2.0 release status section added. Supernode deployment identified as the critical missing piece. All code is complete and tested; only deployment and git commit remain. See section 11 for full checklist.*
