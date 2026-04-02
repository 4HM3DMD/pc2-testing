# Lit Protocol Migration: Datil → Chipotle

> **Purpose:** Reference document for Elacity's migration from Lit Protocol v2 (Datil) to v3 (Chipotle), including the breaking changes discovered on Mar 21, 2026, and the completed production migration on Apr 2, 2026.
>
> **Last Updated:** 2026-04-02
> **Status:** PRODUCTION on `api.chipotle.litprotocol.com`. Gate 1 (Lit mainnet) complete. Gate 2 (V3 dDRM contracts) pending.

---

## Timeline

| Date | Event |
|------|-------|
| Mar 13, 2026 | Chipotle migration started — `chipotle-client.ts` created, replacing full Lit SDK |
| Mar 14-18 | Non-media + media encrypt/decrypt E2E verified on dev network |
| Mar 18 | Auto-provisioning system coded (supernodes distribute API key + PKP) |
| Mar 20 | Chipotle TEE went **DOWN** (connect timeout to Phala dStack worker) |
| Mar 21 | TEE came back **UP** with undocumented breaking changes — 4hrs debugging |
| Apr 1, 2026 | Lit Chipotle v3 goes **generally available** on production |
| Apr 2, 2026 | Elacity production migration **completed** — account, group, actions, PKP |
| ~May 2026 | Gate 2: V3 dDRM contracts (AuthorityGateway) migration (pending) |

---

## Architecture: Datil vs Chipotle

### Datil (v2) — What We Had

```
PC2 Node                          Lit Network (Datil)
┌──────────┐                      ┌────────────────────┐
│ @lit-protocol/lit-node-client   │  Threshold BLS     │
│ @lit-protocol/constants     ──► │  Network            │
│ @lit-protocol/crypto            │  (multi-node)       │
│ SIWE + Session Sigs             │  decryptAndCombine  │
│ Capacity Credits (RLI)          │  SessionSigs verify │
│ WebSocket connections           │                     │
└──────────┘                      └────────────────────┘
```

- **SDK**: 5+ npm packages (~50MB), complex SIWE auth flow
- **Encryption**: Threshold BLS (multi-node secret sharing)
- **Auth**: Session Signatures via SIWE (Sign-In With Ethereum)
- **Capacity**: Required RLI tokens (capacity credits) — 15-day rotation
- **Connection**: Persistent WebSocket to Lit nodes
- **Code execution**: `client.executeJs({ ipfsId, jsParams, sessionSigs })`
- **Param injection**: `jsParams` values injected as **global variables**

### Chipotle (v3) — What We Have Now

```
PC2 Node                          Lit Chipotle TEE
┌──────────────┐                  ┌──────────────────────┐
│ chipotle-     │  HTTP POST      │  Single TEE worker   │
│ client.ts     │ ───────────►    │  (Phala dStack)      │
│ (fetch only)  │  code +         │  PKP-AES encrypt/    │
│               │  js_params      │  decrypt             │
│ No SDK deps   │                 │  ethers.js available │
│ API key auth  │  ◄───────────   │  Lit.Actions.* SDK   │
│               │  response       │                      │
└──────────────┘                  └──────────────────────┘
```

- **SDK**: Zero npm packages — single HTTP POST via `fetch()`
- **Encryption**: PKP-AES (single TEE, deterministic key from PKP)
- **Auth**: API key in `X-Api-Key` header (no SIWE, no session sigs)
- **Capacity**: Usage API key balance (no RLI tokens)
- **Connection**: Stateless HTTP (no WebSocket)
- **Code execution**: `POST /core/v1/lit_action` with `{ code, js_params }`
- **Param injection**: `main(params)` function pattern (see breaking changes below)

---

## Breaking Changes Discovered Mar 21, 2026

When the Chipotle dev TEE was restarted after an outage, three undocumented breaking changes were deployed:

### 1. Execution Model: IIFE → `main(params)`

**Before (working until Mar 20):**
```javascript
(async () => {
  // js_params values injected as globals: kid, ciphertext, pkpId, etc.
  const normalizedKid = kid.startsWith("0x") ? kid : "0x" + kid;
  // ... use globals directly
  Lit.Actions.setResponse({ response: cek });
})();
```

**After (required from Mar 21):**
```javascript
async function main(params) {
  // js_params passed as the `params` argument to main()
  const { kid, ciphertext, pkpId, authority, chain, rpc, userAddress } = params;
  const normalizedKid = kid.startsWith("0x") ? kid : "0x" + kid;
  // ... use destructured params
  Lit.Actions.setResponse({ response: cek });
}
```

The TEE now **calls `main(params)`** after loading your code. If `main` is not defined, you get `ReferenceError: main is not defined`. If you use the old IIFE pattern, params are not available as globals — `ReferenceError: kid is not defined`.

### 2. Wallet-Group Bindings Cleared

PKP wallets were removed from groups during the restart. `Lit.Actions.Decrypt()` and `Lit.Actions.Encrypt()` require the PKP to be in the group, otherwise: `Error: API key cannot use selected wallet in selected action`.

**Fix:** Re-add PKP via API:
```bash
curl -X POST "https://api.dev.litprotocol.com/core/v1/add_pkp_to_group" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ACCOUNT_KEY" \
  -d '{"group_id":1,"pkp_id":"0x09bdfc8f8ec5a3bd2970497b930bd94839f22227"}'
```

### 3. Action CIDs Invalidated

Since the code structure changed (IIFE → `main()`), every Lit Action file now has a different IPFS content hash. All CIDs must be re-registered:

```bash
# Get the CID the server will compute for your code
CID=$(curl -X POST "$BASE/core/v1/get_lit_action_ipfs_id" \
  -H "Content-Type: application/json" \
  -d "$(node -e "console.log(JSON.stringify(require('fs').readFileSync('ACTION.js','utf8')))")" | tr -d '"')

# Register it in your group
curl -X POST "$BASE/core/v1/add_action_to_group" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ACCOUNT_KEY" \
  -d "{\"group_id\":1,\"action_ipfs_cid\":\"$CID\"}"
```

---

## Current Registered CIDs (Production — Apr 2, 2026)

| Script | CID | Purpose |
|--------|-----|---------|
| `non-media-encrypt-chipotle.js` | `QmNayE5MYzXcoMS9nvRk6MUo8r4ESLa3i65vHXzuBsnC2b` | Encrypt non-media CEK (creator upload) |
| `non-media-decrypt-chipotle.js` | `QmYuh3LQXcC5Ddk7xTV2eR8Xvp1xKNSzqoimqpyM1SSDMC` | Decrypt non-media CEK (images, PDFs, 3D, etc.) |
| `media-encrypt-chipotle.js` | `QmXgZXJw9pzSeRkVZLtgNzgaxfErKhthv7j7Etge6WNG4u` | Encrypt media CEK (DASH encoding) |
| `media-decrypt-chipotle.js` | `QmTPi2w7tSfGb7AzkMDCR6bCdSHkU5v5C6CGJC3sULTZN9` | Decrypt media CEK (video/audio DASH) |

**Environment:** Production (Chipotle mainnet)
**Dashboard group:** `elacity-ddrm` (group ID: 1)
**PKP wallet:** `0x68dcf3dc3c38d726e8a7cdca8ab318f49552c05d` (Account Master Wallet — production)
**API URL:** `https://api.chipotle.litprotocol.com`
**Account balance:** $10.00 credit ($0.01/sec per action execution)

**Dev environment (preserved for reference):**
**PKP wallet (dev):** `0x09bdfc8f8ec5a3bd2970497b930bd94839f22227`
**API URL (dev):** `https://api.dev.litprotocol.com`

---

## File Locations

| File | Purpose |
|------|---------|
| `pc2-node/src/api/chipotle-client.ts` | REST client — API key resolution, auto-provisioning, executeLitAction() |
| `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` | Lit Action: non-media CEK decrypt with on-chain access check |
| `pc2-node/data/lit-actions/media-decrypt-chipotle.js` | Lit Action: media CEK decrypt with on-chain access check |
| `pc2-node/data/lit-actions/non-media-encrypt-chipotle.js` | Lit Action: non-media CEK encrypt via PKP-AES |
| `pc2-node/data/lit-actions/media-encrypt-chipotle.js` | Lit Action: media CEK encrypt via PKP-AES |
| `pc2-node/data/.chipotle-api-key` | Usage API key (auto-provisioned from supernode) |
| `pc2-node/data/.chipotle-account-key` | Account API key (dashboard management only) |
| `deploy/web-gateway/index.js` | Supernode gateway — serves `/api/ddrm/provision` config |

---

## How the System Works (Post-Fix)

### Decrypt Flow (Consumer Opens Content)
```
1. User clicks "Open" on purchased asset
2. PC2 node reads Lit Action code from data/lit-actions/*.js
3. chipotle-client.ts sends POST to Chipotle:
   { code: <action code>, js_params: { kid, ciphertext, pkpId, userAddress, ... } }
4. Chipotle TEE:
   a. Hashes code → checks CID is in group's permitted actions
   b. Calls main(js_params) in the action code
   c. Action checks on-chain access via AuthorityGateway.hasAccessByContentId()
   d. If authorized, calls Lit.Actions.Decrypt({ pkpId, ciphertext })
   e. Returns decrypted CEK
5. PC2 node uses CEK to decrypt content (AES-GCM for files, AES-128-CTR for DASH)
6. Content displayed in viewer/player (CEK zeroed from memory after use)
```

### Auto-Provisioning Flow (New PC2 Node)
```
1. New PC2 node starts, no API key configured
2. chipotle-client.ts tries SUPERNODE_PROVISION_URLS:
   - https://69.164.241.210/api/ddrm/provision
   - https://38.242.211.112/api/ddrm/provision
3. Supernode returns: { usageKey, pkpId, apiUrl, authority, chain, actions }
4. Key saved to data/.chipotle-api-key, config cached
5. Node can now encrypt/decrypt using the shared Elacity key
```

---

## Production Migration Checklist (Completed Apr 2, 2026)

### Gate 1: Lit Mainnet (COMPLETE)

- [x] **Confirm `main(params)` pattern** — Production TEE uses same execution model (verified)
- [x] **Get production API URL** — `https://api.chipotle.litprotocol.com`
- [x] **Create production account** — Created via dashboard, funded $10
- [x] **Create production usage API key** — `pc2-ddrm-v3`, scoped to group 1 (execute only)
- [x] **Create production PKP wallet** — AMW: `0x68dcf3dc3c38d726e8a7cdca8ab318f49552c05d`
- [x] **Create production group** — `elacity-ddrm` (group ID: 1)
- [x] **Register all 4 action CIDs** on production group via `add_action_to_group`
- [x] **Add PKP to production group** via `add_pkp_to_group`
- [x] **Verify CIDs match** — `get_lit_action_ipfs_id` confirms same hashes on production
- [x] **Smoke test encrypt** — Production encrypt action verified ($0.14 cost for setup + test)
- [x] **Update `chipotle-client.ts`** — `DEFAULT_API_URL` + `DEFAULT_PKP_ID` → production
- [x] **Update `deploy/web-gateway/index.js`** — `apiUrl`, `network`, `pkpId` → production
- [x] **Update `ddrm-config.json.template`** — All fields → production values

### Gate 1: Remaining Items

- [ ] **Deploy supernodes** — Push updated gateway + place `/etc/pc2/ddrm-api-key` with production usage key
- [ ] **E2E test encrypt + decrypt** — Full round-trip with real content on production Lit
- [ ] **Rebuild TypeScript** — `npx tsc --project tsconfig.json`
- [ ] **Clear provision caches** — Delete `data/.chipotle-provision.json` on nodes
- [ ] **Test auto-provisioning** — Fresh node fetches from updated supernode

### Gate 2: V3 dDRM Contracts (PENDING — separate task)

- [ ] **Deploy V3 AuthorityGateway** on Base (new contract address)
- [ ] **Update `DEFAULT_AUTHORITY`** in `chipotle-client.ts` and web-gateway
- [ ] **Update Lit Action scripts** if contract ABI changes (will invalidate CIDs)
- [ ] **Re-register CIDs** if action code changes
- [ ] **Migrate existing access tokens** to V3 contract

### Re-encryption Consideration

The production PKP (`0x68dc...`) is different from dev PKP (`0x09bd...`). Content encrypted on dev testnet cannot be decrypted on production. This is acceptable because:
1. Dev was only used for internal testing — no real user content
2. All real production content will be encrypted with the new production PKP
3. If re-encryption is ever needed, a migration script can be created

### Rollback Plan

If production Chipotle has issues:
1. Revert `chipotle-client.ts` to point at dev API (`git checkout 71bba594f -- pc2-node/src/api/chipotle-client.ts`)
2. The safety checkpoint commit is `71bba594f` on branch `feature/lit-chipotle-migration`
3. Dev PKP and group still exist on `api.dev.litprotocol.com` for fallback

---

## Debugging Chipotle Issues

### Quick Diagnostics

```bash
# Production base URL
BASE=https://api.chipotle.litprotocol.com

# Is the TEE reachable?
curl -s "$BASE/core/v1/get_node_chain_config" | python3 -m json.tool

# Check account balance
curl -s "$BASE/core/v1/billing/balance" -H "X-Api-Key: $ACCOUNT_KEY"

# List registered actions in group
curl "$BASE/core/v1/list_actions?group_id=1&page_number=0&page_size=20" \
  -H "X-Api-Key: $ACCOUNT_KEY"

# List wallets in group
curl "$BASE/core/v1/list_wallets_in_group?group_id=1&page_number=0&page_size=10" \
  -H "X-Api-Key: $ACCOUNT_KEY"

# Get the CID the server computes for a Lit Action file
jq -Rs '.' path/to/action.js | curl -X POST "$BASE/core/v1/get_lit_action_ipfs_id" \
  -H "Content-Type: application/json" -d @-
```

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ReferenceError: kid is not defined` | Old IIFE pattern, params not injected as globals | Rewrite to `async function main(params)` |
| `ReferenceError: main is not defined` | TEE expects `main()` but code uses IIFE | Rewrite to `async function main(params)` |
| `ReferenceError: jsParams is not defined` | No `jsParams` global in Chipotle | Use `params` argument from `main(params)` |
| `API key not authorized to execute action (QmXXX/...)` | CID not registered in group | Register via `add_action_to_group` |
| `API key cannot use selected wallet` | PKP not in group | Add via `add_pkp_to_group` |
| `ConnectTimeoutError` | TEE worker down | Wait for Lit team to restore; check status |

### After Any Code Change to Lit Action Scripts

1. **Compute new CID**: `get_lit_action_ipfs_id` endpoint
2. **Register new CID**: `add_action_to_group` with account key
3. **Rebuild TypeScript**: `npx tsc --project tsconfig.json` (node runs compiled JS from `dist/`)
4. **Restart node**: `npm start` (or kill + restart)
5. **Update supernode gateway**: If CIDs changed, update `deploy/web-gateway/index.js`

---

## Lit Express Dashboard Access

**Production:**
- **Dashboard:** https://dashboard.chipotle.litprotocol.com/dapps/dashboard/
- **API:** https://api.chipotle.litprotocol.com
- **OpenAPI:** https://api.chipotle.litprotocol.com/core/v1/openapi.json
- **Swagger:** https://api.chipotle.litprotocol.com/core/v1/swagger-ui
- **Docs:** https://developer.litprotocol.com/

**Dev (preserved for fallback):**
- **Dashboard:** https://dashboard.dev.litprotocol.com/dapps/dashboard/
- **API:** https://api.dev.litprotocol.com

**Key file locations:**
- **Account key:** `pc2-node/data/.chipotle-account-key` (admin only, never distribute)
- **Usage key:** `pc2-node/data/.chipotle-api-key` (auto-provisioned from supernode)
- **Provision cache:** `pc2-node/data/.chipotle-provision.json` (auto-created, can be deleted to re-provision)

---

## Key Lessons Learned

1. **Always use `get_lit_action_ipfs_id`** to compute CIDs server-side — don't rely on local IPFS hash tools, as the server may use different chunking.

2. **`npm start` runs compiled JS** (`dist/index.js`), not TypeScript. After any `.ts` change, you MUST run `npx tsc --project tsconfig.json` before restarting.

3. **The TEE can change without notice.** Monitor for errors after any Lit team maintenance window. The `main(params)` pattern may change again when production launches.

4. **Keep the account key secure but accessible.** It's needed for group management (registering CIDs, adding PKPs) but should never be distributed to end-user nodes.

5. **Test with `get_lit_action_ipfs_id` + `add_action_to_group` + inline execution** before deploying code changes. This avoids debugging CID mismatches.
