# Wave 8 Rotation Runbook

## Part 0 — What actually happened (historical record)

> **Correction from earlier drafts.** Previous drafts of this runbook claimed the
> Chipotle dashboard "authorise action CIDs" ceremony was fiction. It is not.
> Chipotle's usage API key is scoped to a **group**, and each group carries an
> allowlist of action CIDs that may be executed with that key. Modifying a Lit
> Action's source changes its Chipotle-internal CID and therefore requires the
> new CID to be added to the group before the modified action can be called.
> This was discovered the hard way during Wave 8 post-deploy testing (see
> step 7). The correction here is authoritative.

There are **two independent CID spaces** that Wave 8 depends on — both must be
kept in sync:

| CID space | Computed by | Where it shows up | Who checks it |
|-----------|-------------|-------------------|---------------|
| **IPFS canonical** (`ipfs add --cid-version=0`) | The sender (us), Pinata, any IPFS node | `.lit-action-cid`, `MEDIA_DECRYPT_ACTION_CID`, `getActionCid()` fallback, supernode `ddrm-config.json`, the delegation that the user signs, the `actionIpfsId` field inside `js_params` | The Lit Action's own `del.actionIpfsId === req.actionIpfsId === js_params.actionIpfsId` consistency check |
| **Chipotle-internal** (returned by `POST /core/v1/get_lit_action_ipfs_id`) | Chipotle's `lit_action` endpoint | Chipotle's on-chain group allowlist (via `/add_action` + `/add_action_to_group`) | Chipotle's auth layer before the TEE is invoked |

Wave 8 CID pairings:

| Action | IPFS canonical (Pinata) | Chipotle-internal, runtime-resolved (group 1 allowlist) | Chipotle-internal, `get_lit_action_ipfs_id` — **DO NOT USE** |
|--------|-------------------------|---------------------------------------------------------|---------------------------------------------------------------|
| non-media-decrypt (Wave 8, C-02 bound) | `QmX5JxcFhyasptCWMA6unFPm3TRYjPSkJb5HhN8289r5uk` | **`QmQjQTM1E6CJa6x1ob1xqHKj9sVGuMeRb9LPQCFnDB8oWi`** (decimal `16077627785…083`) | `QmNhgrX2xEaJmd4UiKJA6NvLfEwdweZk9YYZAFZDj69dS4` *(registered 2026-04-28 ~18:00 but never enforced by runtime; kept as a harmless extra allowlist entry)* |
| media-decrypt (Wave 8, C-02 bound) | `QmSHMSxPogSsNki51fenDzsrkKB3eJfRMHXEPZKqPk6EAb` | `QmeMz4QbJaLueADS1QdamgbxpUXzPWeS8JVsUGeoKpcYQx` *(happens to match — probe on 2026-04-28 ~23:20 returned HTTP 200 without extra registration)* | same CID (only for media the two pipelines happened to agree) |

The pre-Wave 8 decrypt CIDs were **retained** in group 1 as canaries, so a
short-term rollback is possible without re-touching the dashboard.

> **Runbook correction (2026-04-28 ~23:20).** The rotation ceremony
> originally used `get_lit_action_ipfs_id` to derive the Chipotle-internal
> CID. That endpoint returned `QmNhgrX2…dS4` for the non-media source,
> which was then registered + grouped. The "verify with empty params"
> probe returned HTTP 200 with `missing_session_bundle` because
> `lit_action` *also* appears to fall back to the same hash path when it
> can't resolve the enforced one — making the verify step a false-positive.
> First real `lit_action` call during Test 4 surfaced a 403 citing
> internal ID `16077627785…083` (≡ CIDv0 `QmQjQTM1…oWi`). That ID was
> added to group 1 using the same master-key ceremony; the action now
> executes. For the media action the two hashes happened to coincide so
> no correction was needed. The runtime-resolved column above is
> authoritative for future rotations; see Part 3 Step 4 for the fixed
> procedure.

What was actually executed on 2026-04-28:

1. **Pinata pin**. Both new Lit Action sources were pinned to Pinata:
   - `non-media-decrypt-chipotle.js` → `QmX5JxcFhyasptCWMA6unFPm3TRYjPSkJb5HhN8289r5uk`
   - `media-decrypt-chipotle.js` → `QmSHMSxPogSsNki51fenDzsrkKB3eJfRMHXEPZKqPk6EAb`
   - Byte-for-byte equality with the local source verified via the Pinata gateway.

2. **In-repo CID labels** updated:
   - `pc2-node/data/.lit-action-cid` → `QmX5Jxc…`
   - `MEDIA_DECRYPT_ACTION_CID` in `dashPackager.ts:30` → `QmSHMSx…`
   - Hardcoded fallback in `chipotle-client.ts::getActionCid` → `QmX5Jxc…`

3. **Ed25519 provision-signing key**:
   - Reused the pre-existing seed at `~/.elastos/keys/elacity-labs.ed25519`
     (no new keypair generated).
   - Derived public key (hex):
     `1ab060ba7578261355504300c1193c484ed8a46a30499c3fa3cb9065930367eb`
   - Pinned in `chipotle-client.ts::ELACITY_LABS_PROVISION_PUBKEY_HEX`.

4. **Supernode deployment** — both boxes:
   - **InterServer** `69.164.241.210` (service: `pc2-gateway.service`)
   - **Contabo** `38.242.211.112` (service: `pc2-web-gateway.service`)

   On each supernode:
   - Installed the 32-byte Ed25519 seed at `/etc/pc2/elacity-provision.ed25519`
     (mode `0600`, owner `root`). The seed never touched disk on the workstation;
     bytes were streamed through the SSH tunnel directly into the remote file.
   - Patched `/root/pc2/web-gateway/index.js` via the
     `SEC Wave 8 (H-01.2) provision signing` block that adds:
     - `import cryptoW8 from "node:crypto";`
     - `W8_PROVISION_DOMAIN`, `W8_PROVISION_KEY_PATH`, `W8_ED25519_PKCS8_PREFIX`
       constants.
     - Lazy seed loader (`w8LoadProvisionSigningKey`).
     - Canonical-JSON serialiser (`w8Canonicalize`) — keys sorted ASCII-ascending,
       no whitespace — matching PC2's client verifier exactly.
     - `w8SignProvisionEnvelope(payload)` wrapping payload in
       `{v:1, domain, signedAt, payload, sig}`.
   - Replaced the active `/api/ddrm/provision` handler body to call
     `w8SignProvisionEnvelope(payload)` before responding.
   - Backups left alongside the originals as `index.js.pre-wave8.<epoch>`.
   - Restarted the relevant systemd service.

5. **ddrm-config.json** updated on both supernodes so the
   `actions.nonMediaDecrypt` + `actions.mediaDecrypt` fields match the new
   Pinata CIDs (encrypt CIDs left unchanged). Backups preserved as
   `ddrm-config.json.pre-wave8.<epoch>`.

6. **Verification**: `WAVE8_LIVE=1 bash pc2-node/scripts/wave8-smoke.sh`
   returned all-green. 9 offline cases + 5 static + 1 live-supernode check
   = 15/15. Live probe confirms both supernodes produce envelopes whose
   signatures verify against the pinned pubkey.

7. **Chipotle group-1 allowlist ceremony** (executed via the Chipotle Core API
   against `https://api.chipotle.litprotocol.com/core/v1/` using the
   account master key). This step was discovered mid-test when a fresh
   bootstrap returned `HTTP 403: The provided API key is not authorized to
   execute the specified action`; an earlier belief that this step was not
   needed was wrong. Executed:
   ```bash
   # resolve Chipotle's internal CID for each Wave 8 source
   curl -s -X POST -H "X-Api-Key: $MASTER" -H "Content-Type: application/json" \
     https://api.chipotle.litprotocol.com/core/v1/get_lit_action_ipfs_id \
     -d "$(jq -nc --arg c "$(cat non-media-decrypt-chipotle.js)" '$c')"
   # → "QmNhgrX2xEaJmd4UiKJA6NvLfEwdweZk9YYZAFZDj69dS4"

   # register + whitelist each one
   curl -s -X POST -H "X-Api-Key: $MASTER" -H "Content-Type: application/json" \
     https://api.chipotle.litprotocol.com/core/v1/add_action \
     -d '{"action_ipfs_cid":"QmNhgrX2...dS4",
          "name":"non-media-decrypt-chipotle (Wave 8) [Chipotle-internal CID]",
          "description":"..."}'
   curl -s -X POST -H "X-Api-Key: $MASTER" -H "Content-Type: application/json" \
     https://api.chipotle.litprotocol.com/core/v1/add_action_to_group \
     -d '{"action_ipfs_cid":"QmNhgrX2...dS4","group_id":1}'
   ```
   Repeat for the media-decrypt source (Chipotle CID `QmeMz4Qb...cYQx`).
   After the ceremony, `/list_actions?group_id=1` shows **8 members**: the
   4 legacy chipotle actions, 2 sigauth Option C actions from Phase 2d,
   plus the 2 Wave 8 Chipotle-internal CIDs. The pre-Wave 8 decrypt CIDs
   were intentionally left in place as canaries.

   Verified the allowlist by calling the `lit_action` endpoint with
   `{code: <Wave 8 source>, js_params: {}}`: HTTP 200 + action-level
   `"code":"missing_session_bundle"` (Phase 5 delegation gate), **not** a 403.
   Chipotle's auth layer now accepts the Wave 8 decrypt actions.

   Account balance spend for the ceremony: $0.17 (8 paid writes plus probes).

The only remaining task is the manual 4-case C-02 end-to-end matrix (mint,
buy, play, plus the kid-swap negative test for both media and non-media).
That's printed at the bottom of the smoke script output.

---

## Part 1 — Future key rotation (emergency)

Only do this if the private key is believed compromised or the operator
team decides to rotate on a schedule. Steady-state Wave 8 needs no rotation.

### Step-by-step

1. **Generate a new keypair offline**:

   ```bash
   openssl genpkey -algorithm Ed25519 -out elacity-provision.ed25519.pem

   openssl pkey -in elacity-provision.ed25519.pem -pubout -outform DER \
     | tail -c 32 | xxd -p -c 64
   # ^ paste this hex into ELACITY_LABS_PROVISION_PUBKEY_HEX
   ```

2. **Extract the 32-byte raw seed** from the PEM (needed by the supernode
   signer, which expects a raw 32-byte seed file):

   ```bash
   openssl pkey -in elacity-provision.ed25519.pem -outform DER \
     | tail -c 32 > /tmp/new-seed.bin
   chmod 600 /tmp/new-seed.bin
   ```

3. **Stage the new seed onto both supernodes** (do not touch the old file
   in place — write alongside so you can atomically flip with a single
   mv):

   ```bash
   scp /tmp/new-seed.bin root@69.164.241.210:/etc/pc2/elacity-provision.ed25519.new
   scp /tmp/new-seed.bin root@38.242.211.112:/etc/pc2/elacity-provision.ed25519.new
   ```

   On each supernode:

   ```bash
   chmod 600 /etc/pc2/elacity-provision.ed25519.new
   ```

4. **Flip pubkey in PC2**: commit the new `ELACITY_LABS_PROVISION_PUBKEY_HEX`
   on the `feature/lit-chipotle-migration` branch (or wherever the next
   release is cut from), do **not** push yet.

5. **Coordinated flip** (both supernodes + git push in the same minute):

   - On each supernode:
     ```bash
     mv /etc/pc2/elacity-provision.ed25519.new /etc/pc2/elacity-provision.ed25519
     systemctl restart pc2-gateway       # or pc2-web-gateway on Contabo
     ```
   - Push the pubkey commit to the PC2 repo. Any PC2 that pulls + restarts
     after the flip will verify correctly. PC2s that pull before the flip
     will reject the old signatures (that's the point).

6. **Run `WAVE8_LIVE=1 bash pc2-node/scripts/wave8-smoke.sh`** — both
   supernodes' "live verifier" row must return green. If either fails,
   either the PEM extraction mis-copied, the pubkey hex in-repo is wrong,
   or the supernode didn't pick up the new seed — debug before scrubbing
   the old seed.

7. **Scrub the old seed** — `shred -u /tmp/new-seed.bin` on the workstation;
   `shred -u /etc/pc2/elacity-provision.ed25519.prev` on each supernode (if
   you backed up the old seed before the flip).

### Rollback

If step 6 fails:

```bash
# Revert the pubkey commit in git (if pushed).
git revert <pubkey-flip-commit>
git push

# Restore the old seed on each supernode (if you kept a backup):
mv /etc/pc2/elacity-provision.ed25519.prev /etc/pc2/elacity-provision.ed25519
systemctl restart pc2-gateway
```

---

## Part 2 — Adding a new supernode

If a third supernode is spun up, it needs the seed + patched handler before
PC2 nodes can bootstrap through it.

1. Install seed:
   ```bash
   mkdir -p /etc/pc2
   # stream the raw 32-byte seed to the file over an encrypted channel:
   ssh root@new-supernode 'umask 077; cat > /etc/pc2/elacity-provision.ed25519' \
     < /path/to/raw-seed.bin
   ssh root@new-supernode 'chmod 600 /etc/pc2/elacity-provision.ed25519'
   ```

2. Deploy PC2 web-gateway with the Wave 8 signing block. If this supernode
   was provisioned after Wave 8 shipped, `index.js` already contains the
   signing block — skip to step 3. Otherwise re-run
   `pc2-node/scripts/wave8-gateway-patcher.mjs` (kept in-repo only
   ephemerally; recreate from this runbook if needed).

3. Add the supernode URL to `SUPERNODE_PROVISION_URLS` in
   `chipotle-client.ts`.

4. `WAVE8_LIVE=1 bash wave8-smoke.sh` — confirm the new URL probe is green.

---

## Part 3 — Rotating the Lit Action source (future)

Any change to `*-decrypt-chipotle.js` or `*-encrypt-chipotle.js` changes both
the IPFS canonical CID and Chipotle's internal CID. Skipping either half of
the ceremony below will 4xx in production.

1. **Pin on Pinata** (public IPFS layer — lets third parties verify source):
   ```bash
   export PINATA_JWT='<...>'
   cid=$(curl -s -X POST https://api.pinata.cloud/pinning/pinFileToIPFS \
     -H "Authorization: Bearer $PINATA_JWT" \
     -F "file=@pc2-node/data/lit-actions/non-media-decrypt-chipotle.js" \
     | jq -r .IpfsHash)
   # verify it matches `ipfs add --only-hash --cid-version=0` locally.
   ```

2. **Update in-repo labels** with the Pinata CID:
   - `pc2-node/data/.lit-action-cid`
   - `MEDIA_DECRYPT_ACTION_CID` in `pc2-node/src/services/media/dashPackager.ts`
   - Hardcoded fallback inside `getActionCid()` in `chipotle-client.ts`

3. **Update supernode `ddrm-config.json`** on both supernodes with the same
   Pinata CID (so fresh PC2s bootstrap to the correct label).

4. **Resolve Chipotle's internal CID for the new source** — use the **403
   probe** method, not `get_lit_action_ipfs_id`:

   > **Gotcha (learned 2026-04-28, Wave 8 Test 4).** Chipotle's
   > `get_lit_action_ipfs_id` endpoint returns a hash that is **not**
   > identical to the internal ID enforced by the `lit_action` executor.
   > Using its output to populate the allowlist leads to a self-consistent
   > probe (the "verify with empty params" step below passes) that
   > silently fails on the first real `lit_action` call. The only
   > reliable source of the enforced internal ID is the 403 response
   > body from an actual `lit_action` attempt under the usage key.

   ```bash
   USAGE=$(cat pc2-node/data/.chipotle-api-key)
   BASE='https://api.chipotle.litprotocol.com/core/v1'
   SRC=$(cat pc2-node/data/lit-actions/non-media-decrypt-chipotle.js)

   # Expected response while NOT allowlisted:
   #   HTTP 403 body:
   #   "... not authorized to execute the specified action (<IPFS-CID>/<DECIMAL>)."
   #
   # Grab the trailing decimal — that is Chipotle's internal ID.
   curl -s -X POST -H "X-Api-Key: $USAGE" -H "Content-Type: application/json" \
     "$BASE/lit_action" \
     -d "$(jq -nc --arg c "$SRC" '{code:$c, js_params:{}}')"

   # Convert decimal → CIDv0 (base58btc of 0x1220 + 32-byte big-endian digest):
   python3 -c '
   ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
   d = int(input("decimal internal ID: "))
   mh = bytes([0x12, 0x20]) + d.to_bytes(32, "big")
   n, out = int.from_bytes(mh, "big"), ""
   while n:
       n, r = divmod(n, 58); out = ALPHABET[r] + out
   print("CIDv0:", out)
   '
   ```

   If the probe returns HTTP 200 (with any action-level error such as
   `missing_session_bundle`), the action is **already** allowlisted and
   no further Chipotle Core API work is needed — skip to step 6 for
   double-checking. That's how the Wave 8 media path looked on
   2026-04-28 after the non-media entry was fixed.

5. **Register + group-add** the Chipotle-internal CID:
   ```bash
   MASTER=$(cat pc2-node/data/.chipotle-account-key)
   CHIP_CID='<CIDv0 output from step 4>'
   curl -s -X POST -H "X-Api-Key: $MASTER" -H "Content-Type: application/json" \
     "$BASE/add_action" \
     -d "{\"action_ipfs_cid\":\"$CHIP_CID\",\"name\":\"...\",\"description\":\"...\"}"
   curl -s -X POST -H "X-Api-Key: $MASTER" -H "Content-Type: application/json" \
     "$BASE/add_action_to_group" \
     -d "{\"action_ipfs_cid\":\"$CHIP_CID\",\"group_id\":1}"
   ```

6. **Verify** by re-running the **same `lit_action` probe from step 4**.
   It must now return HTTP 200 (any action-level error such as
   `missing_session_bundle` is fine; a 403 means steps 5 failed or the
   CID from step 4 was computed wrong).

7. **Leave the previous Chipotle-internal CID in group 1** as a rollback
   canary for at least one release cycle. Remove it with
   `POST /remove_action_from_group` (`hashed_cid` = the 0x-prefixed
   keccak256 shown in the allowlist listing) once you're confident.

---

## Sign-off checklist (one-time Wave 8 ship)

- [x] New Lit Actions pinned on Pinata.
- [x] `.lit-action-cid` + `MEDIA_DECRYPT_ACTION_CID` + hardcoded fallback
      all point at the Pinata CIDs.
- [x] `ELACITY_LABS_PROVISION_PUBKEY_HEX` pinned to the derived public key.
- [x] Both supernodes: seed installed at
      `/etc/pc2/elacity-provision.ed25519` (mode 0600).
- [x] Both supernodes: `index.js` patched, service restarted, envelope
      endpoint returns `{v, domain, signedAt, payload, sig}`.
- [x] Both supernodes: `ddrm-config.json` decrypt CIDs updated to match.
- [x] Automated regression + live supernode probe: 15/15 green.
- [x] Chipotle group-1 allowlist updated via Core API — both Wave 8
      Chipotle-internal CIDs registered + added; verified with a live
      `lit_action` call returning HTTP 200 instead of 403. Amended
      2026-04-28 ~23:20 after Test 4 exposed that the non-media
      allowlist entry (`QmNhgrX2…`) was computed from
      `get_lit_action_ipfs_id` which diverges from the runtime hash;
      the real runtime-resolved CID `QmQjQTM1…oWi` was added and
      verified. Media pair was already correct by chance.
- [ ] Manual C-02 matrix (4 cases): mint, buy, play positive + kid-swap
      negative on both media and non-media.
