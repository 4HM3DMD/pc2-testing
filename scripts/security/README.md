# scripts/security/

Security test artefacts for the Lit Action session-key delegation auth task
([../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md](../../.cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md)).

These scripts are **defensive security tooling**. They prove a known vulnerability
exists in the currently-deployed non-media-decrypt Lit Action so we can (a)
baseline the exploit, (b) ship the fix, then (c) re-run and prove the fix works.

## Contents

- `exploit-lit-nonmedia.ts` — Phase 0 evidence reproducer. Calls the Chipotle
  TEE directly (bypassing PC2) with a spoofed `userAddress` and watches the CEK
  come back.
- `exploit-target.example.json` — Template for the target config. Copy to
  `exploit-target.json` and fill in values from any real published Elacity asset.
- `.exploit-evidence/` — Gitignored directory where redacted run evidence is
  written. CEK values are **always** replaced with `[REDACTED sha256=... len=...]`
  before any disk write.

## Safety

- All scripts require `ALLOW_SECURITY_TEST=1` in the environment to run. This is
  an intentional tripwire so nobody runs them by accident.
- `exploit-target.json` is gitignored so you can freely paste real victim
  addresses and ciphertexts without fear of committing them.
- `.exploit-evidence/` is gitignored for the same reason. Even so, CEK values
  are redacted to SHA-256 before being written. Never edit the script to log the
  raw CEK.
- The Chipotle API key is resolved using the same tier order as
  [../../pc2-node/src/api/chipotle-client.ts](../../pc2-node/src/api/chipotle-client.ts)
  (env vars first, then `pc2-node/data/.chipotle-user-key`, then
  `.chipotle-api-key`, then `.chipotle-provision.json`) and is **never echoed**.
- These scripts only make calls that a TEE-side unauthenticated attacker could
  already make. Running them does not create new risk; blocking them in CI does
  not reduce risk.

## How to run Phase 0 (proving the vulnerability)

```bash
# 1. Pick a real published Elacity asset and get its lit metadata.
#    Any address known to hold the ERC1155 AccessToken will do as victim.
cp scripts/security/exploit-target.example.json scripts/security/exploit-target.json

# 2. Edit exploit-target.json with real values from the asset's IPFS metadata:
#      litCiphertext, dataToEncryptHash, kid, victimAddress
#    encryptedDataCid is optional (metadata only).

# 3. Run it.
ALLOW_SECURITY_TEST=1 npx tsx scripts/security/exploit-lit-nonmedia.ts

# 4. Read the evidence file the script prints.
ls scripts/security/.exploit-evidence/
```

## Expected outcomes

| Target Lit Action CID    | Expected exit | Expected outcome |
|--------------------------|---------------|------------------|
| Current (vulnerable)     | `0`           | CEK released, vulnerability confirmed |
| Phase-2 patched CID      | `2`           | `del_sig_invalid` / `del_expired` / `req_sig_invalid` |

If the current CID does not release the CEK, the exploit script is wrong or the
target asset is invalid. Re-investigate before shipping the fix.

## How to re-run after Phase 2 (regression)

The script reads the Lit Action code from
`pc2-node/data/lit-actions/non-media-decrypt-chipotle.js`. When Phase 2d
rewrites that file with the session-key auth, this script — run with the same
target config — must exit with code `2` and `denialReason` matching one of the
Phase 2 rejection codes.

Any other outcome blocks merge.
