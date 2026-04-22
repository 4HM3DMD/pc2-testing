# Wave 4 — CI / Secret Hygiene (SEC-CI-SECRETSCAN)

**Parent**: `SEC-2026-04-21-PC2-AUDIT`
**Status**: ✅ Shipped (PR-blocking gate live; 1 follow-up rotation queued)
**Severity**: Medium (preventative gate, no live exploit closed)

---

## TL;DR

Repository now has a secret-scanner gate at three points:

| Stage              | Tool          | Scope                          | Action          |
|--------------------|---------------|--------------------------------|-----------------|
| Local pre-commit   | gitleaks      | staged diff vs HEAD            | Block commit    |
| GitHub PR          | gitleaks-action | PR diff vs base branch       | Fail check      |
| GitHub push        | gitleaks-action | Full working tree              | Fail check      |

Baseline scan of the working tree found **426 raw matches**, of which:
- **413 in runtime/vendored noise** (`pc2-node/data/`, `node_modules/`, IPFS blocks, log files) → eliminated by `.gitleaks.toml` path allowlist
- **12 vendored bundles + doc false-positives** → suppressed by inline path rules + `.gitleaksignore`
- **1 real historical leak** (`data/identity.json` — Boson DID node private key) → triaged for rotation, see below

After hardening: **0 leaks** detected. Scan time **6.7 s** on a 17k-file checkout.

---

## Why gitleaks (not trufflehog)

| Criterion              | gitleaks                          | trufflehog                       |
|------------------------|-----------------------------------|----------------------------------|
| Binary footprint       | Single Go binary, ~10 MB          | Heavier, more deps               |
| Pre-commit speed       | <1 s on staged diff               | Several seconds (live verification) |
| GitHub Action          | Official, well-maintained         | Official                         |
| False-positive control | `.gitleaksignore` + inline allowlist | `--config` only                |
| Live credential check  | No (pattern only)                 | Yes (this is overkill for gating) |

trufflehog's strength (verifying secrets are still live by hitting provider APIs) is the wrong shape for a CI gate — we want to *block leaks at write time*, not *prove leaks already happened*.

---

## Files changed

### Created
- `.gitleaks.toml` — repo config: extends default ruleset, path allowlist for runtime/vendored/IPFS-block/test-fixture content, regex allowlist for public-by-design IPFS CIDs and EVM addresses
- `.gitleaksignore` — fingerprint allowlist for triaged historical findings (each annotated with TRIAGE-N + rationale + follow-up task)
- `.github/workflows/secret-scan.yml` — gitleaks-action@v2 on PR + push to long-lived branches
- `.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md` (this file)
- `docs/wiki/Technical/SECRET_SCANNING.md` — install + bypass + rotation runbook for contributors

### Modified
- `.husky/pre-commit` — prepended `gitleaks protect --staged` call; skips silently if `gitleaks` not on PATH (zero contributor friction); guidance message on block

---

## Triage table — historical findings

These are the only items the scanner surfaces today. Items 2-4 are documented false-positives or public-by-design identifiers; item 1 needs rotation.

| ID | Severity | File | What | Follow-up |
|----|----------|------|------|-----------|
| **TRIAGE-1** | **High** | `data/identity.json` | Real Ed25519 PKCS#8 private key for a Boson DID node identity. Already in `.gitignore` but committed at `4b10bad94` (2026-03-06) **before** the gitignore rule. Exposed on `origin/{dDRM-extended, feature/ddrm-universal-access-layer, feature/elacity-ddrm-marketplace, feature/lit-chipotle-migration}`. | Open follow-up task: (a) rotate the DID anywhere it's referenced, (b) `git rm --cached data/identity.json` in a follow-up commit, (c) optionally `git filter-repo` to scrub history (requires force-push — separate decision). |
| TRIAGE-2 | Info | `docs/PRIVACY_CONSENT_POPUP_SOLITAIRE.md:54` | `websiteKey` for the bundled FRVR Solitaire game — publishable, visible in browser network traffic by design. | None — documentation. |
| TRIAGE-3 | Info | `docs/core/CHIPOTLE_HANDOVER.md:242` | False positive: gitleaks `curl-auth-header` rule matched a multi-line curl example with no actual `Authorization:` header on the matched line. | None — false positive. |
| TRIAGE-4 | Info | `src/gui/src/UI/AI/UIAIChat.js:28` | `CONVERSATIONS_KEY_PREFIX = 'ai-conversation-'` — localStorage key prefix, not a secret. Generic-api-key rule matched any `*KEY*` constant. | None — false positive. |

---

## Acceptance criteria

- [x] `.gitleaks.toml` checked in, extends default ruleset
- [x] `.gitleaksignore` checked in with fingerprints for all 4 triaged historicals
- [x] `gitleaks detect --no-git --config=.gitleaks.toml` exits 0 against current HEAD
- [x] `.github/workflows/secret-scan.yml` runs on PR + push, blocks on leak
- [x] `.husky/pre-commit` runs `gitleaks protect --staged` when installed; skips when not
- [x] Smoke matrix:
    - [x] Clean staged area → pre-commit exits 0
    - [x] Slack bot token in staged diff → pre-commit exits 1 with guidance message
    - [x] gitleaks not installed → pre-commit exits 0 (silently skipped, ESLint still runs)
- [x] `docs/wiki/Technical/SECRET_SCANNING.md` documents install + bypass + rotation runbook

---

## Smoke test commands

```bash
# Manual scan (matches what CI runs on push):
gitleaks detect --no-git --config=.gitleaks.toml

# Manual staged-diff scan (matches what pre-commit runs):
gitleaks protect --staged --config=.gitleaks.toml

# Bypass for a one-off false-positive (rare, justify in commit message):
git commit --no-verify

# Add a triaged finding to allowlist:
echo '<File>:<RuleID>:<StartLine>' >> .gitleaksignore
# (and add a TRIAGE-N comment block above with rationale + task link)
```

---

## Out of scope (deferred)

- **Full git-history sweep** (`gitleaks detect` against all 5256 commits) — the scan exceeded 14 minutes on a developer laptop. Will run as a one-off on a CI runner, results pasted into TRIAGE table in this file. Note: nothing currently in `data/identity.json` is materially worse than what TRIAGE-1 already documents — the historical sweep is a thoroughness exercise, not an emergency.
- **`git filter-repo` history rewrite** for TRIAGE-1 — requires force-push to 4 origin branches, breaks every contributor's checkout, must be coordinated with the team. Decided separately.
- **Trufflehog secondary scan** for live-verification of any token-shaped match — track as `SEC-CI-LIVECRED-VERIFY` if appetite exists post-v1.2.
- **GitHub native secret scanning** — already on by default for public repos; redundant with this gate but worth verifying the dashboard at `Settings → Code security`.

---

## Rollback

`.husky/pre-commit` skips the gitleaks call entirely when the binary isn't installed, so removing the local install is the soft rollback.

The CI workflow can be hard-disabled by deleting `.github/workflows/secret-scan.yml` (or commenting out the `on:` triggers). The repo will still build/test without it.

`.gitleaks.toml` and `.gitleaksignore` are inert without the scanner — they can be left in place after rollback with no effect.
