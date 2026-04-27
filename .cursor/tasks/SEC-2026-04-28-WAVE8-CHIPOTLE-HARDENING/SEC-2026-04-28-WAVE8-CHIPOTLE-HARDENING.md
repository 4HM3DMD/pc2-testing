# Task: SEC Wave 8 — Chipotle hardening (post-Irzhy review)

**Task ID**: SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING
**Created**: 2026-04-28
**Status**: Review
**Priority**: High (release-gate for v1.2.0 Lit Chipotle migration)

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
- [x] Write rotation runbook
      (`.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/ROTATION_RUNBOOK.md`)
      with the new CIDs and the Chipotle-dashboard ceremony steps.
- [ ] Sash runs the rotation ceremony (PKP authorise + config switch +
      PC2 restart).
- [ ] Sash runs the 4-case manual C-02 end-to-end matrix (positive +
      negative for both media and non-media).
- [ ] Sash runs the Elacity Labs Ed25519 key ceremony and replaces
      `ELACITY_LABS_PROVISION_PUBKEY_HEX` + updates the supernode
      provision-signing pipeline.

## Acceptance Criteria

1. `bash pc2-node/scripts/wave8-smoke.sh` → all automated checks PASS
   (5 shell + 9 offline = 14/14).
2. `npm run test:security` → no regressions (last clean HEAD was the
   Wave 6 part 2 merge).
3. Manual C-02 matrix: 2 positive + 2 negative decrypt tests all match
   expected outcome (see "Manual C-02 end-to-end checks" at the bottom of
   the smoke script).
4. H-01.2 key ceremony complete: `ELACITY_LABS_PROVISION_PUBKEY_HEX` !=
   all-zeros and supernodes can produce signed envelopes.
5. Lit Action CIDs rotated on the Chipotle dashboard; `.lit-action-cid`
   and `MEDIA_DECRYPT_ACTION_CID` in `dashPackager.ts` point at the new
   hashes; old CIDs stay authorised as a canary for 24h then are removed.

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
| `pc2-node/scripts/wave8-smoke.sh` | Automated Wave 8 regression suite (static + offline harness). |
| `pc2-node/scripts/wave8-provision-sig-test.mjs` | Offline Node harness — 9 cases covering H-01.2 verify logic. |
| `.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING.md` | This doc. |
| `.cursor/tasks/SEC-2026-04-28-WAVE8-CHIPOTLE-HARDENING/ROTATION_RUNBOOK.md` | Step-by-step CID rotation + key-ceremony runbook for Sash. |

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
- Rotation ceremony (CIDs + key) is Sash-owned; see `ROTATION_RUNBOOK.md`.
- `ELACITY_LABS_PROVISION_PUBKEY_HEX` ships as all-zeros; `PROVISION_SIG_REQUIRED`
  defaults to strict. Consequence: while the placeholder is in place,
  auto-provisioning refuses all supernode responses. PC2 nodes with an
  existing `.chipotle-provision.json` are unaffected. Fresh installs during
  the ceremony window must set `PROVISION_SIG_REQUIRED=0` as an emergency
  bootstrap; flip back to strict immediately after the real pubkey is
  committed.
