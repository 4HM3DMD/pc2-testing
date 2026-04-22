# Task: Boson DID Identity Key Rotation (`data/identity.json`)

**Task ID**: SEC-2026-04-22-BOSON-DID-ROTATION
**Created**: 2026-04-22
**Status**: Proposed
**Priority**: High
**Surfaced by**: Wave 4 (gitleaks baseline scan, see [`WAVE-4-SECRET-HYGIENE.md`](../SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md))

## Description

`data/identity.json` contains a real Ed25519 private key for a Boson DID node identity. It was committed at `4b10bad94` on 2026-03-06 — *before* the matching `.gitignore` rule was added in a later commit. As a result the key is publicly readable on **four origin branches** and any historical clone of the repo.

The key is currently allowlisted in `.gitleaksignore` as `TRIAGE-1` so the secret scanner does not block builds. Allowlisting documents the exposure but does not remove it. This task remediates.

## Background

- The file is in `.gitignore` today — new clones receive an empty/regenerated identity on first boot.
- However, anyone who cloned the repo between 2026-03-06 and now possesses the original private key.
- `gitleaks` cannot retroactively unlearn this; only on-chain/registry rotation removes the capability.

## Requirements

1. **Determine consumers** — what does this DID sign or own? Specifically:
   - Is it referenced in any Boson DHT registration?
   - Is it pinned in any Elacity registry / DHT bootstrap list?
   - Is it the identity of a long-lived demo/dev node that other nodes trust?
2. **Rotate** — generate a fresh keypair, update any on-chain or registry binding, retire the leaked key.
3. **Remove from history** (after rotation completes):
   - `git rm --cached data/identity.json`
   - Decide whether to BFG/`git filter-repo` the file from history. Note: this rewrites SHAs across all branches and breaks open PRs. May not be worth it given the key is already public — rotation is the meaningful step.
4. **Add `data/identity.json.example`** with the documented schema so contributors know the format without needing to peek at the live file.
5. **Document in CHANGELOG** under v1.2.x security notes.

## Implementation Plan

- [ ] Identify consumers of the leaked DID (ask Sash + check Boson DHT registry)
- [ ] Generate replacement keypair (`pc2-node` already has `boson:identity:generate` — use it)
- [ ] Update any external bindings (DHT, registry, peer lists)
- [ ] Stop trusting the old DID anywhere it's referenced
- [ ] `git rm --cached data/identity.json` and confirm `.gitignore` already excludes it (it does)
- [ ] Decide on history rewrite (recommend NO unless required; rotation is sufficient)
- [ ] Remove `TRIAGE-1` entry from `.gitleaksignore` once file is no longer tracked
- [ ] Update [`SEC_2026_04_21_AUDIT_DISPOSITION.md`](../../../docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md) "Outstanding Items" #2 to closed

## Acceptance Criteria

- The leaked Ed25519 private key no longer corresponds to any trusted Boson DID identity
- `data/identity.json` is no longer tracked in git
- `.gitleaks.toml` baseline scan returns 0 findings without the TRIAGE-1 allowlist
- CHANGELOG entry written
- Audit disposition doc updated

## Files to Modify

- `data/identity.json` (rotate or remove from tracking)
- `.gitleaksignore` (remove TRIAGE-1 once superseded)
- `CHANGELOG.md` (add note under v1.2.x)
- `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` (mark item closed)

## Notes

This is **not blocking v1.2 release**. The exploitation requires an attacker to (a) know what the DID is bound to and (b) be able to produce something that the binding accepts. The Wave 1-4 hardening closes the most likely abuse paths even if the key is held by an adversary. Rotation is best-practice hygiene, scheduled but not on the critical path.
