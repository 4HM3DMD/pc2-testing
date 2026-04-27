# Wave 8 Rotation Runbook

Two ceremonies ship with Wave 8:

1. **Lit Action CID rotation** — new source for both Chipotle actions needs
   new IPFS pins, new PKP authorisations, new in-repo CID references.
2. **Elacity Labs provision-signing key ceremony** — generate the
   Ed25519 keypair, publish the pubkey in `chipotle-client.ts`, stand up
   the supernode signing pipeline.

Both are Sash-owned because they require Chipotle dashboard access or
custody of long-lived private keys.

---

## Part 1 — Lit Action CID rotation

### New CIDs (already computed, matching existing version conventions)

| Action | Old CID (pre-Wave 8) | New CID (post-Wave 8) |
|---|---|---|
| `non-media-decrypt-chipotle.js` | `bafkreihvm4zkyuefnuptlbdins6cmd2mbslj2xgnyzz3ssdg2ggg3jtkk4` | `bafkreie2uvfzn3xpyxpaldopjczomwik5joz3tnkjzufhwnl4k3dilxgoq` |
| `media-decrypt-chipotle.js`     | `QmcNdiSuT2c2zKwhGozTgvT12uP26gAWMw2D49GvcLj2Go`            | `QmYexzQNhYLsGc8SNXL9B7BEWy3S7tBKoeM7iwJUsFnuKr`            |

Deterministic formulae:

```bash
ipfs add --only-hash --cid-version=1 --raw-leaves=true pc2-node/data/lit-actions/non-media-decrypt-chipotle.js
ipfs add --only-hash --cid-version=0                    pc2-node/data/lit-actions/media-decrypt-chipotle.js
```

Re-run these after any future edit to the action sources — the CIDs change
byte-for-byte, so source and CID must rotate together.

### Step-by-step

> **Canary strategy**: authorise the NEW CIDs on the PKP while keeping the
> OLD CIDs authorised. Rotate the server config to point at the new CIDs,
> restart, smoke. If anything breaks, revert the config and traffic
> fails back to the old CIDs. After 24h of clean traffic, de-authorise
> the old CIDs.

1. **Pin to IPFS** (both local and Elacity IPFS for Lit reachability).

   ```bash
   # Local pin (already done during dev):
   ipfs add --cid-version=1 --raw-leaves=true pc2-node/data/lit-actions/non-media-decrypt-chipotle.js
   ipfs add --cid-version=0                    pc2-node/data/lit-actions/media-decrypt-chipotle.js

   # Elacity IPFS replicate (preferred — wider availability for Lit TEE nodes):
   # Use the same mechanism the dev deployment uses (base.ela.city upload,
   # or the PC2 `/api/storage/ipfs/upload-elacity` endpoint).
   ```

2. **Authorise the NEW CIDs on the Chipotle PKP**. Open the Chipotle
   dashboard (`https://dashboard.chipotle.litprotocol.com/dapps/dashboard/`),
   navigate to the Elacity PKP (`0x68dcf3dc3c38d726e8a7cdca8ab318f49552c05d`),
   and add these two CIDs to the authorised-actions list:

   - `bafkreie2uvfzn3xpyxpaldopjczomwik5joz3tnkjzufhwnl4k3dilxgoq`
   - `QmYexzQNhYLsGc8SNXL9B7BEWy3S7tBKoeM7iwJUsFnuKr`

   **Keep the old CIDs authorised** for the 24h canary window.

3. **Update the in-repo CID references**:

   ```bash
   # Non-media: referenced in pc2-node/data/.lit-action-cid
   printf '%s\n' 'bafkreie2uvfzn3xpyxpaldopjczomwik5joz3tnkjzufhwnl4k3dilxgoq' \
     > pc2-node/data/.lit-action-cid

   # Media: referenced as MEDIA_DECRYPT_ACTION_CID in pc2-node/src/services/media/dashPackager.ts:30
   # (hand-edit the constant to 'QmYexzQNhYLsGc8SNXL9B7BEWy3S7tBKoeM7iwJUsFnuKr')
   ```

4. **Restart the PC2 node** (`npm run dev` or the systemd service).

5. **Run the automated regression**:

   ```bash
   bash pc2-node/scripts/wave8-smoke.sh
   # Expect: 14/14 PASS.
   ```

6. **Run the manual C-02 end-to-end matrix** (printed at the bottom of the
   smoke script; also listed in the task doc):

   - POSITIVE non-media: mint → buy AccessToken → `/api/storage/lit/secure-view` renders.
   - NEGATIVE non-media: swap kid-A / kid-B ciphertext → Lit Action responds `kid_binding_mismatch`, server 4xx.
   - POSITIVE media: mint → buy → `/api/media/init` plays DASH.
   - NEGATIVE media: same swap → `kid_binding_mismatch`.

7. **After 24h of clean traffic**: de-authorise the old CIDs on the
   Chipotle dashboard. Rotation complete.

### Rollback

If step 5 or 6 fails:

```bash
# Point the configs back at the OLD CIDs:
printf '%s\n' 'bafkreihvm4zkyuefnuptlbdins6cmd2mbslj2xgnyzz3ssdg2ggg3jtkk4' \
  > pc2-node/data/.lit-action-cid
# Revert MEDIA_DECRYPT_ACTION_CID to 'QmcNdiSuT2c2zKwhGozTgvT12uP26gAWMw2D49GvcLj2Go'

# Restart PC2. Traffic resumes on the old CIDs immediately — they never
# lost authorisation. Open an incident, diff the Lit Action source, and
# retry the rotation after the issue is understood.
```

---

## Part 2 — Elacity Labs provision-signing key ceremony

Goal: stand up the Ed25519 key that authenticates supernode-served
provision JSON to fresh PC2 nodes.

### Step-by-step

1. **Generate the keypair on an offline / hardware-isolated host**
   (preferred: dedicated ops laptop with disk encryption):

   ```bash
   openssl genpkey -algorithm Ed25519 -out elacity-provision.ed25519.pem

   # Extract the raw 32-byte public key in hex:
   openssl pkey -in elacity-provision.ed25519.pem -pubout -outform DER \
     | tail -c 32 | xxd -p -c 64
   ```

2. **Commit the public key** to `pc2-node/src/api/chipotle-client.ts`:

   ```diff
   -const ELACITY_LABS_PROVISION_PUBKEY_HEX =
   -  '0000000000000000000000000000000000000000000000000000000000000000';
   +const ELACITY_LABS_PROVISION_PUBKEY_HEX =
   +  '<the 64-hex-character output from step 1>';
   ```

   The private key NEVER goes in git. Store it in the Elacity Labs ops
   vault or the supernode signing CI.

3. **Provision the signing pipeline on each supernode**: whenever a
   supernode serves `/api/ddrm/provision`, wrap the ProvisionConfig
   payload in the signed envelope:

   ```js
   // Pseudocode — run on each supernode's provisioning service:
   import { sign, createPrivateKey } from 'node:crypto';

   const signingKey = createPrivateKey(process.env.ELACITY_PROVISION_PRIVKEY_PEM);
   const signedAt = Math.floor(Date.now() / 1000);
   const env = {
     v: 1,
     domain: 'elacity.pc2.chipotle-provision.v1',
     signedAt,
     payload, // the existing ProvisionConfig
   };
   const msg = Buffer.from(canonicalize(env), 'utf8');
   env.sig = sign(null, msg, signingKey).toString('base64');
   return res.json(env);
   ```

   `canonicalize` must be the same deterministic JSON used by the client
   (keys sorted ASCII-ascending at every level, no whitespace). See the
   implementation in `pc2-node/scripts/wave8-provision-sig-test.mjs`.

4. **Deploy the supernode change to every node in
   `SUPERNODE_PROVISION_URLS`**. Current list is two IPs:

   - `https://69.164.241.210/api/ddrm/provision`
   - `https://38.242.211.112/api/ddrm/provision`

5. **Regression-test against a fresh PC2 install**:

   ```bash
   # With strict mode (default):
   rm pc2-node/data/.chipotle-provision.json pc2-node/data/.chipotle-api-key
   npm run dev
   # Log should show: "[Chipotle] Signed provision accepted from https://… (signedAt=…)".
   ```

6. **If the key is compromised**:
   - Generate a new keypair.
   - Rotate `ELACITY_LABS_PROVISION_PUBKEY_HEX` in-repo.
   - Roll the supernode signing pipeline to the new private key.
   - `.chipotle-provision.json` cached locally on existing installs is
     unaffected; they don't re-fetch unless the file is deleted.

### Emergency bootstrap

If the ceremony is not yet complete AND a fresh PC2 needs to provision,
operators can set `PROVISION_SIG_REQUIRED=0` for a single run. The
client accepts the legacy unsigned blob with a loud warning.

**Always flip back to strict mode once the real key is committed.**
Leave `PROVISION_SIG_REQUIRED=0` unset in production service files.

---

## Sign-off checklist

- [ ] New Lit Action CIDs pinned (local + Elacity IPFS).
- [ ] New CIDs authorised on the Chipotle PKP; old CIDs still authorised.
- [ ] `.lit-action-cid` and `MEDIA_DECRYPT_ACTION_CID` updated.
- [ ] PC2 restarted, `wave8-smoke.sh` green.
- [ ] Manual C-02 matrix: 4/4 green.
- [ ] Old CIDs de-authorised (T+24h).
- [ ] Elacity Labs Ed25519 keypair generated and stored off-keyboard.
- [ ] `ELACITY_LABS_PROVISION_PUBKEY_HEX` updated in `chipotle-client.ts`.
- [ ] Supernode signing pipeline deployed to both nodes.
- [ ] Fresh-install signed-provision regression passes.
