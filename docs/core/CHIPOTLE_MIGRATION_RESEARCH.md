# Lit Protocol Chipotle (v3) Migration Research

> **Created:** 2026-03-15
> **Status:** Research Phase
> **Deadline:** Datil sunsets ~April 25, 2026 (30 days after Chipotle production launch)
> **Branch:** `feature/ddrm-universal-access-layer`

---

## Timeline

| Date | Event |
|------|-------|
| 2026-03-25 | Chipotle production launch (targeted) |
| 2026-03-25 → 04-01 | Naga chain remains live, network stops |
| 2026-04-01 | Naga fully sunsets |
| ~2026-04-25 | Datil sunsets (30 days after Chipotle production) |

Chipotle dev environment is live NOW:
- **Dashboard:** https://dashboard.dev.litprotocol.com
- **API:** https://api.dev.litprotocol.com
- **Docs:** https://docs.dev.litprotocol.com
- **OpenAPI:** https://api.dev.litprotocol.com/core/v1/openapi.json

---

## Architecture Change: Threshold → TEE

| | Datil (current) | Chipotle (target) |
|--|-----------------|-------------------|
| Execution | Threshold across 6+ nodes | Single TEE enclave |
| Client | SDK required (v7.3.0) | REST API (HTTP) |
| Auth | Wallet-based (SIWE sessions) | API keys |
| Key mgmt | Distributed key shares | On-chain KMS via TEE root of trust |
| Latency | Multi-node coordination | Single machine |
| Cost | Capacity credits (RLI tokens) | Pay-per-request (LITKEY on Base) |
| Permissions | On-chain access control | Groups + scoped API keys |

---

## Chipotle REST API Endpoints

All under `/core/v1/`. Auth via `X-Api-Key` or `Authorization: Bearer` header.

### Account Management
- `POST /new_account` → `{ account_name, account_description, initial_balance }` → returns `api_key` (one-time)
- `GET /account_exists` → verify API key
- `GET /create_wallet` → new PKP (programmable key pair)
- `POST /add_usage_api_key` → scoped key for dApps/cron
- `POST /add_group` → organize PKPs, actions, keys
- `POST /add_action_to_group` → register IPFS CID in group
- `POST /add_pkp_to_group` → assign wallet to group

### Execution
- `POST /lit_action` → `{ code: string, js_params?: object }` → `{ response, logs, has_error }`

### Utility
- `GET /get_node_chain_config` → contract locations
- `POST /get_lit_action_ipfs_id` → hash code to CID

---

## Migration Analysis: Our Current Flow

### What We Have (Datil v7 SDK)

**Encrypt (Creator Dashboard, ~70 lines in storage.ts):**
```
1. crypto.randomBytes(32) → CEK
2. AES-256-GCM encrypt file with CEK → encryptedWithTag + iv
3. client.encrypt({ dataToEncrypt: base64(CEK), accessControlConditions }) → { ciphertext, dataToEncryptHash }
4. Return: litCiphertext, dataToEncryptHash, encryptedData, iv, actionCid
```

**Decrypt (Market App, ~200 lines in storage.ts):**
```
1. getLitClient() → LitNodeClientNodeJs singleton (~100 lines setup)
2. getExecuteSessionSigs() → SIWE + capacity delegation (~130 lines)
3. client.executeJs({ ipfsId, sessionSigs, jsParams }) → Lit Action runs
4. Lit Action: hasAccessByContentId() on-chain → decryptAndCombine() → returns CEK
5. AES-GCM decrypt file with CEK
```

**What Gets Deleted (~450 lines):**
- `getLitClient()` and `litClientInstance` singleton
- `getSessionSigs()` and all SIWE/RecapSessionCapabilityObject logic
- `getExecuteSessionSigs()` and capacity delegation
- `ensureDelegateeRegistered()` and Payment Delegation DB integration
- `getRelayerConfig()` and `.lit-relayer-config`
- `getConfiguredCapacityTokenId()` and Chronicle Yellowstone RLI detection
- `LIT_KEY_PATH`, `CAPACITY_KEY_PATH`, `.lit-server-key` auto-generation
- All `@lit-protocol/*` imports in storage.ts

### Chipotle Equivalent

**Decrypt (simple):**
```
POST /core/v1/lit_action
X-Api-Key: <usage_api_key>
{
  "code": "<our Lit Action JS code>",
  "js_params": {
    "ciphertext": "...",
    "dataToEncryptHash": "...",
    "kid": "0x...",
    "actionIpfsId": "QmVMgK...",
    "authority": "0x580C26DeFf267Ef40A72cf10a4A42050F0641b8B",
    "chain": "base",
    "rpc": "https://mainnet.base.org",
    "userAddress": "0x..."
  }
}
→ { response: "<base64 CEK>", logs: "...", has_error: false }
```

**Encrypt (needs investigation):**
- No REST encrypt endpoint in Chipotle
- Options:
  1. Keep minimal `@lit-protocol/crypto` for client-side encrypt only
  2. Use Chipotle SDK wrapper (if lighter than v7)
  3. Investigate if encrypt can be done inside a Lit Action

---

## Open Questions

### 1. IPFS CID vs Inline Code
The `LitActionRequest` schema only has `{ code, js_params }` -- no `ipfs_cid` field.
Our self-referential condition uses `:currentActionIpfsId` which requires IPFS execution.

**Options:**
- A. The `code` field might accept a CID string (untested)
- B. Register CID in group → node fetches from IPFS when `code` matches registered CID
- C. Use `get_lit_action_ipfs_id` endpoint to hash code → use as reference
- D. Inline the code and change access conditions (drop self-referential)

**Impact:** If self-referential condition doesn't work in Chipotle, we need to redesign access control. Our Lit Action already does the real access check (on-chain `hasAccessByContentId`), so the self-referential condition is an extra security layer, not the primary gate.

### 2. Encrypt API
`client.encrypt()` from Datil SDK does threshold encryption of the CEK. Chipotle's TEE model is fundamentally different. How do we encrypt data for Chipotle decryption?

**Research needed:**
- Check Chipotle SDK (`core_sdk.js`) for encrypt functions
- Test if Datil-encrypted data can be decrypted by Chipotle (backward compatibility?)
- Check if `@lit-protocol/crypto` works standalone for Chipotle-compatible encryption

### 3. Access Control Conditions Compatibility
Do Datil-style `accessControlConditions` work in Chipotle's `decryptAndCombine()`?
If not, all previously encrypted assets would need re-encryption.

### 4. LITKEY Payment Model
- How much does each `lit_action` call cost in LITKEY?
- Is LITKEY on Base (same chain as our ACCESS_TOKENs)?
- Can we pay with USDC instead?
- Do we need to hold LITKEY tokens or is there a credit system?

---

## Next Steps

1. **Create Chipotle dev account** via dashboard
2. **Test `lit_action` endpoint** with our existing Lit Action code
3. **Verify encrypt compatibility** -- can Chipotle decrypt Datil-encrypted data?
4. **Test self-referential conditions** in Chipotle
5. **Understand LITKEY costs** for budgeting
6. **If all works:** implement migration in storage.ts
