# Task: SEC Wave 8 — Chipotle hardening (post-Irzhy review)

**Task ID**: SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING
**Created**: 2026-04-28
**Status**: Review (all automated checks green; awaiting manual C-02 matrix run)
**Priority**: High (release-gate for v1.2.0 Lit Chipotle migration)

## Blocker — resolved 2026-04-28 ~23:40

Test 4 (the manual 4-case C-02 end-to-end matrix) was blocked on an **unrelated
upstream bug** introduced by Irzhy in commit
[`14e151a35`](../../) *"refactor: update content metadata structures and migrate
to directory-based IPFS storage for creator assets"* on
`feature/lit-chipotle-migration`. That commit deleted
`function buildMetadataEnvelope(params)` from
`pc2-node/data/test-apps/elacity-creator/app.js` (previously at line 1171) but
left the call site at line 3229 (`var envelope = buildMetadataEnvelope(metaParams);`).
Every mint through the creator app threw `buildMetadataEnvelope is not defined`
after the encrypt step succeeded — so Wave 8's encrypt path was proven clean in
dev, but decrypt could not be exercised without a completed mint.

**Resolution**: Irzhy pushed four follow-up commits to
`feature/lit-chipotle-migration` on 2026-04-28. Pulled and rebased our 7
Wave 8 / UI-X / MEDIA commits on top cleanly (zero conflicts — no file
overlap between his set and ours):

| SHA | Subject | Relevance |
|---|---|---|
| `149fc06d6` | fix: restore buildMetadataEnvelope function | **Unblocks Test 4** — renames minified helper `e(params)` back to `buildMetadataEnvelope(params)` so line 3229 resolves. |
| `7a468c751` | fix: adjusted metadata production to the standard | Marketplace envelope layer only — moves to wiki-hosted JSON Schema URLs and NFT-standard `attributes[]`. Does not touch PSSH-in-moov, encryption, Chipotle, or Lit Actions. |
| `8bf99b065` | fix: removed hasRole check before minting | Simplifies our test path (no role grant needed). |
| `362b8b8d6` | fix: implement safe guard to prevent crash when opening app | Defensive launch crash prevention in `pc2-node/src/storage/ipfs.ts` and `src/gui/src/helpers/launch_app.js`. Error-handling only, no API surface change. |

Impact on Wave 8 itself: **none** — all Wave 8 code paths remained shipped and
automated checks remained 15/15 green through the rebase. The blocker was
purely on the test harness side.

Next step:

1. Sash hard-refreshes the elacity-creator iframe (no PC2 rebuild needed — it
   is a static asset).
2. Runs the 4-case matrix (mint → buy → play positive + kid-swap negative, for
   both media and non-media).
3. If green, this task moves Review → Done and the branch is pushable.

## Description

Close three security findings surfaced by Irzhy's 2026-04-28 deep-audit of the
Chipotle Lit migration:

- **C-02** — Lit Action CEK decrypt was not bound to the authorised kid.
- **M-01** — `detectSmartAccountUser` accepted a creator-controlled RPC URL
  embedded inside PSSH, allowing SSRF.
- **H-01.2** — Auto-provisioning trusted unsigned JSON from supernodes.

"Wave 8" disambiguates from the existing **Wave 7 polish** work (A13–A15), which
lives under `.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH/` and is unrelated.

## Background

Irzhy's review lives at
`docs/analysis/chipotle-lit-security-review.md`. Deep cross-check against
`docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` classified each finding:

| Finding | Prior status | Action |
|---|---|---|
| C-01 (media decrypt unauthenticated) | Closed by Phase 5 sigauth | No-op |
| **C-02** (kid ↔ ciphertext not bound) | **NEW** (P1) | Wave 8 |
| H-01.1 (TLS verification off on supernode calls) | Tracked as **A8** | No-op (A8 ships separately on DNS unblock) |
| **H-01.2** (Unsigned provision JSON) | **NEW** (High) | Wave 8 |
| **M-01** (SSRF via creator RPC) | **NEW** (Medium) | Wave 8 |

v1.2 is pre-live, so there are no users to migrate — this is a "fix before
tag" window.

## Requirements

### C-02 (kid ↔ ciphertext binding)

Enforce `kid == first16Bytes(sha256(cekBase64))` inside both Chipotle Lit
Actions. This is the canonical kid-derivation already used by
`dashPackager.ts` (`contractKid`), `elacity-creator/app.js`, and the market
app. Binding it at the TEE layer closes the swap attack — an owner of `kid-A`
cannot submit `kid-B`'s ciphertext and obtain `kid-B`'s CEK, because the
returned CEK hashes to `kid-B`, not the requested `kid-A`, and the Lit
Action denies with `kid_binding_mismatch`.

### M-01 (SSRF via creator RPC)

In `pc2-node/src/api/media.ts::detectSmartAccountUser`, stop reading `rpc`
from the PSSH payload and always use `getBaseRpcUrl()`.

### H-01.2 (Unsigned provision JSON)

Wrap supernode-served provision JSON in a detached-signature envelope:

```json
{
  "v": 1,
  "domain": "elacity.pc2.chipotle-provision.v1",
  "signedAt": 1735000000,
  "payload": { /* ProvisionConfig */ },
  "sig": "<base64 Ed25519 over canonicalize({v,domain,signedAt,payload})>"
}
```

Reject anything that fails any of:

1. Version/domain mismatch.
2. `|now - signedAt|` > 90 days.
3. Signature does not verify against `ELACITY_LABS_PROVISION_PUBKEY_HEX`.
4. `payload.apiUrl` not in the allowlist (`api.chipotle.litprotocol.com`,
   `api.dev.litprotocol.com`).
5. `payload.usageKey` too short or a known placeholder.
6. `payload.pkpId` / `authority` not 0x-prefixed.

Strict mode is default (`PROVISION_SIG_REQUIRED != '0'`). Ship with an
all-zeros sentinel pubkey so no signature verifies until the key ceremony
runs — this is the fail-safe.

## Implementation Plan

- [x] Pull `feature/lit-chipotle-migration` (fast-forward from `origin`) so
      Irzhy's IPFS + metadata work is included.
- [x] **M-01**: `pc2-node/src/api/media.ts:528-540` — drop PSSH-embedded
      RPC, always use `getBaseRpcUrl()`.
- [x] **C-02 non-media**: append kid-binding check to
      `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` after the
      `Lit.Actions.Decrypt` call.
- [x] **C-02 media**: same check appended to
      `pc2-node/data/lit-actions/media-decrypt-chipotle.js`.
- [x] Compute new Lit Action CIDs locally via `ipfs add --only-hash`
      matching current version conventions (raw-v1 for non-media, v0 for
      media).
- [x] **H-01.2**: add Ed25519 verify + `apiUrl` allowlist +
      `PROVISION_SIG_REQUIRED` flag in
      `pc2-node/src/api/chipotle-client.ts`. Envelope domain constant,
      canonicalise helper, placeholder pubkey.
- [x] Write `pc2-node/scripts/wave8-smoke.sh` — static-source checks for
      C-02 + M-01 + offline H-01.2 Node harness.
- [x] Write `pc2-node/scripts/wave8-provision-sig-test.mjs` — 9 cases
      covering every accept/reject branch.
- [x] Write this task doc.
- [x] Append Wave 8 section to `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md`.
- [x] Pin both new Lit Actions to Pinata:
      non-media = `QmX5JxcFhyasptCWMA6unFPm3TRYjPSkJb5HhN8289r5uk`,
      media = `QmSHMSxPogSsNki51fenDzsrkKB3eJfRMHXEPZKqPk6EAb`. Both verified
      byte-for-byte against the local source via `gateway.pinata.cloud`.
- [x] Rotate the in-repo CID labels to the Pinata CIDs:
      `pc2-node/data/.lit-action-cid` and the hardcoded fallback in
      `chipotle-client.ts::getActionCid`, plus `MEDIA_DECRYPT_ACTION_CID`
      in `dashPackager.ts:30`.
- [x] Elacity Labs Ed25519 key ceremony — **completed 2026-04-28 in-session**:
      the existing seed at `~/.elastos/keys/elacity-labs.ed25519` was
      reused (no new keypair generation needed). Derived pubkey hex
      `1ab060ba7578261355504300c1193c484ed8a46a30499c3fa3cb9065930367eb`
      pinned in `ELACITY_LABS_PROVISION_PUBKEY_HEX`.
- [x] Supernode signing pipeline deployed to both boxes:
      `69.164.241.210` (InterServer, `pc2-gateway.service`) and
      `38.242.211.112` (Contabo, `pc2-web-gateway.service`). Seed installed
      at `/etc/pc2/elacity-provision.ed25519` (mode 0600, root-only).
      `/root/pc2/web-gateway/index.js` patched with the signing helpers
      (backups at `index.js.pre-wave8.<timestamp>`) and services restarted.
      Live probe confirms both supernodes emit v1/domain-correct envelopes
      whose signatures verify against the pinned pubkey.
- [x] Both supernodes' `ddrm-config.json` updated so the `actions.*Decrypt`
      CIDs match the new Pinata CIDs (encrypt CIDs left untouched).
- [x] Added `pc2-node/scripts/wave8-supernode-live-verify.mjs` +
      `WAVE8_LIVE=1 bash …/wave8-smoke.sh` flag — catches any future
      drift between supernode private keys and the pinned pubkey.
- [x] **Chipotle group-1 allowlist ceremony — completed 2026-04-28 via the
      Chipotle Core API** (discovered mid-testing that Chipotle *does*
      enforce a per-group action-CID allowlist; previous drafts saying "no
      dashboard step" were wrong). Chipotle's auth layer checks its own
      internal CID (from `POST /core/v1/get_lit_action_ipfs_id`) which is
      distinct from the IPFS canonical CID used for Pinata and for the
      `actionIpfsId` inside the signed delegation. Registered both Wave 8
      decrypt actions' Chipotle-internal CIDs
      (`QmNhgrX2xEaJmd4UiKJA6NvLfEwdweZk9YYZAFZDj69dS4` non-media,
      `QmeMz4QbJaLueADS1QdamgbxpUXzPWeS8JVsUGeoKpcYQx` media) via
      `POST /core/v1/add_action` and added them to group 1 via
      `POST /core/v1/add_action_to_group`. Pre-Wave 8 decrypt CIDs retained
      as rollback canaries. Verified with a `lit_action` POST using the
      usage key: HTTP 200 + action-level `missing_session_bundle` (Phase 5
      delegation gate, as designed) instead of 403. Full procedure in
      `ROTATION_RUNBOOK.md` Part 3.
- [ ] Sash runs the 4-case manual C-02 end-to-end matrix (positive +
      negative for both media and non-media) against a fresh mint on the
      updated CIDs. **🟢 Unblocked 2026-04-28 ~23:40** — Irzhy's
      `149fc06d6` restored `buildMetadataEnvelope`; rebased cleanly on
      top of his 4 commits (zero conflicts). Ready for the matrix run.

## Acceptance Criteria

1. `bash pc2-node/scripts/wave8-smoke.sh` → all automated checks PASS
   (5 shell + 9 offline = 14/14). ✅
2. `WAVE8_LIVE=1 bash pc2-node/scripts/wave8-smoke.sh` → live supernode
   probe also PASS (both supernodes emit validly-signed envelopes). ✅
3. `npm run test:security` → no regressions (last clean HEAD was the
   Wave 6 part 2 merge).
4. Manual C-02 matrix: 2 positive + 2 negative decrypt tests all match
   expected outcome (see "Manual C-02 end-to-end checks" at the bottom of
   the smoke script).
5. H-01.2 pubkey pinned + supernodes emit signed envelopes that verify. ✅
6. `.lit-action-cid` and `MEDIA_DECRYPT_ACTION_CID` point at the Pinata
   CIDs; supernode `ddrm-config.json` decrypt CIDs updated to match. ✅
7. Chipotle group-1 allowlist contains both Wave 8 Chipotle-internal CIDs;
   `lit_action` with the new sources returns HTTP 200 under the usage key
   (no 403). ✅

## Files Modified

| File | Change |
|---|---|
| `pc2-node/src/api/media.ts` | M-01: drop `saEntry?.data?.rpc` fallback, always use `getBaseRpcUrl()`. Param renamed `_psshEntries` (unused). |
| `pc2-node/data/lit-actions/non-media-decrypt-chipotle.js` | C-02: append 12-line kid ↔ ciphertext binding check after decrypt. |
| `pc2-node/data/lit-actions/media-decrypt-chipotle.js` | C-02: same binding check in the media path. |
| `pc2-node/src/api/chipotle-client.ts` | H-01.2: imports `crypto.createPublicKey/verify`, adds envelope + canonicalise + verify + validate helpers, and refactors `fetchProvisionFromSupernode` through `parseProvisionResponse`. |

## Files Created

| File | Purpose |
|---|---|
| `pc2-node/scripts/wave8-smoke.sh` | Automated Wave 8 regression suite (static + offline + opt-in live probe). |
| `pc2-node/scripts/wave8-provision-sig-test.mjs` | Offline Node harness — 9 cases covering H-01.2 verify logic. |
| `pc2-node/scripts/wave8-supernode-live-verify.mjs` | Live probe that fetches each supernode's signed envelope and verifies against the pinned pubkey. Run via `WAVE8_LIVE=1 bash wave8-smoke.sh`. |
| `.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING.md` | This doc. |
| `.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/ROTATION_RUNBOOK.md` | Historical record of what was done + future key-rotation procedure. |

## Testing Strategy

- Offline: 9-case H-01.2 Node harness generates an ephemeral Ed25519 keypair,
  exercises every accept/reject path without touching any live system.
- Source-level: shell grep checks confirm M-01 and C-02 fix markers are
  present and no regressions reintroduce the vulnerable patterns.
- Live (manual, post-rotation): the 4-case C-02 matrix in the smoke script
  plus an end-to-end mint → buy → play on both media and non-media assets.

## Notes

- "Wave 8" is an internal-only codename to avoid collision with the Wave 7
  Polish track (A13–A15, `.cursor/tasks/SEC-2026-04-22-WAVE7-POLISH`).
- All C-02/M-01/H-01.2 code comments use `SEC Wave 8 (…)` as the
  grep-anchor so the smoke script can assert fix presence.
- Strict-mode auto-provisioning now works end-to-end: the Elacity Labs
  Ed25519 seed (pre-existing at `~/.elastos/keys/elacity-labs.ed25519`)
  is installed on both supernodes; PC2 pins the derived pubkey; both
  supernodes emit signed envelopes that verify. Fresh PC2 installs will
  succeed without the `PROVISION_SIG_REQUIRED=0` emergency flag.
- `PROVISION_SIG_REQUIRED=0` is retained only for the "my supernodes are
  temporarily offline for a key rotation" corner case; steady-state value
  is `1` (default).
- **2026-04-28 EOD (updated 23:40)**: **unblocked.** Irzhy pushed four
  follow-up commits to `feature/lit-chipotle-migration` (headlined by
  `149fc06d6` restoring `buildMetadataEnvelope`). Pulled with
  `git pull --rebase origin feature/lit-chipotle-migration` — 7 local
  commits replayed cleanly on top of his 4, zero conflicts (proven by
  pre-rebase file-overlap check: empty intersection). Task flipped
  Blocked → Review. Adjacent cosmetic console-noise items swept earlier
  in the wait window are logged separately at
  [`UIX-2026-04-28-WAVE8-WAITING-POLISH`](../UIX-2026-04-28-WAVE8-WAITING-POLISH/UIX-2026-04-28-WAVE8-WAITING-POLISH.md)
  to keep Wave 8's commit trail focused on security scope. No Wave 8
  code paths touched by that work. Sash to run the 4-case manual C-02
  matrix on the unified branch; green matrix moves Review → Done and
  makes all 11 local commits pushable as one set.
