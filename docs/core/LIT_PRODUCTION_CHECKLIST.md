# Lit Chipotle: Pre-Production Checklist

> **Purpose:** Track everything that must change before shipping v1.2.0 and when Lit Protocol moves Chipotle from dev to production.
> **Status:** Currently running on `chipotle-dev` network (https://api.dev.litprotocol.com)
> **Created:** 2026-03-18
> **Last Updated:** 2026-03-18

---

## CRITICAL: v1.2.0 Release Blockers

These must be completed before merging to `main` and releasing v1.2.0:

### Must Do (release blockers)

- [ ] **Deploy gateway update to supernodes** — The `/api/ddrm/provision` endpoint exists in code but is NOT deployed yet. Both supernodes need the updated `web-gateway/index.js`.
  - InterServer: `69.164.241.210`
  - Contabo: `38.242.211.112`
- [ ] **Provision usage key on supernodes** — Write the Chipotle usage API key to `/etc/pc2/ddrm-api-key` on each supernode. Without this, fresh PC2 nodes cannot auto-provision and dDRM will not work.
  ```bash
  # On each supernode:
  mkdir -p /etc/pc2
  echo "<USAGE_API_KEY>" > /etc/pc2/ddrm-api-key
  echo "0x09bdfc8f8ec5a3bd2970497b930bd94839f22227" > /etc/pc2/ddrm-pkp-id
  chmod 600 /etc/pc2/ddrm-api-key /etc/pc2/ddrm-pkp-id
  ```
- [ ] **Verify auto-provisioning E2E** — After deploying, test from a clean state: delete `data/.chipotle-api-key`, start node, mint an asset, confirm it auto-provisions and encrypts/decrypts successfully.
- [ ] **Lit production network status** — Confirm with Lit team whether `chipotle-dev` is stable enough for production use, or if we should wait for their production launch. If dev-only, document this as a known limitation in release notes.
- [ ] **Git commit all changes** — Ensure `non-media-encrypt-chipotle.js`, `chipotle-client.ts` updates, gateway update, docs are all committed.

### Should Do (before release)

- [ ] **Test media (video/audio) uploads via Creator** — Currently only non-media tested on Chipotle. Video/audio uses whole-file AES-GCM path which should work but is unverified.
- [ ] **Rotate supernode SSH password** — The password was exposed in conversation. Rotate immediately.
- [ ] **Account balance monitoring** — When Lit goes production, each API call may cost gas. Set up alerts for low balance on the Lit account.

### Nice to Have (can follow in v1.2.1)

- [ ] Settings UI for Tier 2 self-sovereign API key
- [ ] Media pipeline (DASH/CENC) on Chipotle — requires encoder code from team
- [ ] Cost analysis for 100+ node network on Lit production

## Current Dev Setup (Working)

| Item | Dev Value | Where Configured |
|------|-----------|-----------------|
| API URL | `https://api.dev.litprotocol.com` | `chipotle-client.ts` `DEFAULT_API_URL` |
| Dashboard | `https://dashboard.dev.litprotocol.com/` | Manual — browser |
| Account Key | Stored in `data/.chipotle-account-key` (gitignored) | Local file |
| Usage Key | Stored in `data/.chipotle-api-key` (gitignored) | Local file + supernode `/etc/pc2/ddrm-api-key` |
| PKP ID (AMW) | `0x09bdfc8f8ec5a3bd2970497b930bd94839f22227` | `chipotle-client.ts` `DEFAULT_PKP_ID` |
| Gas / Cost | Free (dev network) | N/A |
| Network | `chipotle-dev` | Provision config `network` field |

### Registered IPFS Actions (Lit Dashboard)

| Name | CID (CIDv0) | Purpose |
|------|-------------|---------|
| `ddrm` | (registered on dashboard) | Legacy test |
| `Encrypt` | (registered on dashboard) | Legacy inline encrypt |
| `non-media-decrypt-chipotle` | `QmfWksjQkuLxVGEZdHrbFKxUb2sL4K34bLYbD3mAKv2CZA` | Non-media CEK decryption with on-chain access check |
| `non-media-encrypt-chipotle` | `QmUdZUxe6BVoXiZcw4hE86YCHsgQVGEmgbN6sr7MhnL8pp` | Non-media CEK encryption |
| `test-decrypt` | `QmUm5dDNufxLWfchfwRe9SxtJ7YNRyd3zC8Mt9huHebnNy` | Bare decrypt for testing |

---

## When Lit Announces Production

### Step 1: Create Production Account

- [ ] Go to production dashboard (likely `https://dashboard.litprotocol.com/`)
- [ ] Create new account — save the Account Key securely (password manager, NOT git)
- [ ] Create `elacity-ddrm` group
- [ ] Note the new PKP wallet address (Account Master Wallet)
- [ ] Add AMW to the `elacity-ddrm` group via API:
  ```
  curl -X POST https://api.litprotocol.com/core/v1/add_pkp_to_group \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: <ACCOUNT_KEY>" \
    -d '{"group_id": 1, "pkp_id": "<NEW_PKP_ADDRESS>"}'
  ```

### Step 2: Register All Lit Action CIDs

- [ ] Register `non-media-encrypt-chipotle` CID on production dashboard
- [ ] Register `non-media-decrypt-chipotle` CID on production dashboard
- [ ] Register any media decrypt action CID (when ready)
- [ ] Verify CIDs match: compute locally with `ipfs add --only-hash --cid-version 0 <file>`

> **Important:** If any Lit Action JS file is modified, the CID changes and must be re-registered.

### Step 3: Create Production Usage API Key

- [ ] Create usage key with `can_execute_in_groups: [1]` (scoped to `elacity-ddrm` group)
- [ ] Name it `pc2-ddrm-production`
- [ ] Save it securely — this is the key distributed to all PC2 nodes

### Step 4: Fund the Account

- [ ] Check Lit Protocol docs for gas/credit requirements on production
- [ ] Fund the account with sufficient balance for expected usage
- [ ] Set up monitoring for balance alerts (low balance = all nodes stop working)
- [ ] Estimate cost per encrypt/decrypt operation and plan top-up schedule

### Step 5: Update Code Constants

Update `pc2-node/src/api/chipotle-client.ts`:

- [ ] `DEFAULT_API_URL`: `'https://api.dev.litprotocol.com'` → `'https://api.litprotocol.com'` (or whatever Lit announces)
- [ ] `DEFAULT_PKP_ID`: `'0x09bdfc8f8ec5a3bd2970497b930bd94839f22227'` → new production PKP address

### Step 6: Update Supernode Provisioning

Update `deploy/web-gateway/index.js` (the `/api/ddrm/provision` endpoint):

- [ ] Update `apiUrl` in response: `'https://api.dev.litprotocol.com'` → production URL
- [ ] Update default PKP ID in response to match production PKP
- [ ] Update `network` field: `'chipotle-dev'` → `'chipotle'` (or `'chipotle-production'`)

On each supernode server:

- [ ] Write production usage key to `/etc/pc2/ddrm-api-key`
- [ ] Write production PKP ID to `/etc/pc2/ddrm-pkp-id`
- [ ] Restart gateway process

### Step 7: Deploy to Supernodes

- [ ] Deploy updated `web-gateway/index.js` to InterServer (`69.164.241.210`)
- [ ] Deploy updated `web-gateway/index.js` to Contabo (`38.242.211.112`)
- [ ] Verify provisioning: `curl -k https://69.164.241.210/api/ddrm/provision`
- [ ] Verify provisioning: `curl -k https://38.242.211.112/api/ddrm/provision`

### Step 8: Test Before Release

- [ ] Fresh clone test: `git clone`, `npm install`, `npm run build`, `npm start` — verify auto-provisioning works
- [ ] Encrypt test: mint an asset via Creator app
- [ ] Decrypt test: buy access and view via dDRM Viewer
- [ ] Verify `litBackend: 'chipotle'` in minted asset metadata
- [ ] Verify WASM rendering works (badges show WASM + WATERMARKED)

### Step 9: Handle Existing Dev-Encrypted Assets

- [ ] Assets minted on dev network use dev PKP — they will NOT be decryptable on production
- [ ] This is expected for testing assets only
- [ ] If any dev assets need to persist, document a re-encryption strategy

### Step 10: Merge and Release

- [ ] Merge `feature/lit-chipotle-migration` → parent branch → `main`
- [ ] Tag release (e.g., `v1.2.0`)
- [ ] Community announcement: "Non-media assets now use Chipotle dDRM"

---

## How Auto-Provisioning Works (for Developers)

```
Fresh PC2 Node Boot:
  1. Node starts, user tries to encrypt/decrypt
  2. chipotle-client.ts resolveApiKey() checks:
     a. LIT_CHIPOTLE_USER_KEY env var (Tier 2 — self-sovereign)
     b. data/.chipotle-user-key file (Tier 2)
     c. LIT_CHIPOTLE_USAGE_KEY env var (Tier 1 — shared)
     d. data/.chipotle-api-key file (Tier 1)
     e. data/.chipotle-provision.json cache (from prior auto-provision)
  3. If all fail → ensureProvisioned():
     a. Try GET https://69.164.241.210/api/ddrm/provision
     b. Try GET https://38.242.211.112/api/ddrm/provision
     c. On success: save key to data/.chipotle-api-key + full config to data/.chipotle-provision.json
  4. Subsequent operations use cached key (no re-fetch)

PKP ID Resolution:
  1. config.pkpId (explicit override)
  2. Cached provision.pkpId (from supernode)
  3. DEFAULT_PKP_ID constant (fallback)
```

---

## Architecture: Why This Is Secure

The usage API key distributed to all PC2 nodes is NOT a secret that grants admin access:

1. **Scoped to group** — can only execute Lit Actions in `elacity-ddrm` group
2. **Scoped to registered CIDs** — can only run pre-registered Lit Action code (immutable on IPFS)
3. **Scoped to registered PKP** — can only use the Elacity master PKP
4. **On-chain access check** — the Lit Action itself verifies `hasAccessByContentId(buyer, kid)` on Base mainnet. Even with the API key, you cannot decrypt without owning the ACCESS_TOKEN on-chain
5. **Account key stays secret** — only the usage key is distributed; the account key (for dashboard management) is never shared

The real security gate is the on-chain ACCESS_TOKEN ownership, enforced inside the Lit TEE. The API key is just an authentication token for the Lit platform.

---

## Files Reference

| File | Purpose |
|------|---------|
| `pc2-node/src/api/chipotle-client.ts` | REST client + auto-provisioning logic |
| `pc2-node/data/lit-actions/non-media-encrypt-chipotle.js` | Encrypt Lit Action (pinned, CID-stable) |
| `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` | Decrypt Lit Action with on-chain access check |
| `pc2-node/data/lit-actions/non-media-decrypt.js` | Datil decrypt action (legacy, for old assets) |
| `deploy/web-gateway/index.js` | Supernode gateway with `/api/ddrm/provision` endpoint |
| `pc2-node/data/.chipotle-api-key` | Local usage key (gitignored, auto-provisioned) |
| `pc2-node/data/.chipotle-provision.json` | Cached provision config (gitignored) |
| `/etc/pc2/ddrm-api-key` | Supernode-side key file (read by gateway) |
| `/etc/pc2/ddrm-pkp-id` | Supernode-side PKP ID file (read by gateway) |
