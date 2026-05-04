# Secret Scanning

This repo runs [gitleaks](https://github.com/gitleaks/gitleaks) at three points:

1. **Local pre-commit** (optional but recommended) — blocks commits that introduce a secret in the staged diff.
2. **GitHub PR check** — fails the PR check if the diff vs the base branch contains a secret.
3. **GitHub push to long-lived branches** — full working-tree scan as a defence-in-depth.

Wave 4 of the [SEC-2026-04-21-PC2-AUDIT](../../.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md) put this in place.

---

## Install (one-time, per developer machine)

```bash
# macOS
brew install gitleaks

# Linux
go install github.com/zricethezav/gitleaks/v8@latest

# Verify
gitleaks version
```

That's it. The pre-commit hook (`.husky/pre-commit`) detects gitleaks on `PATH` automatically. If gitleaks isn't installed it skips silently — CI still catches anything you missed.

---

## When the scanner blocks you

Output looks like:

```
Finding:     password = "REDACTED"
Secret:      <redacted>
RuleID:      generic-api-key
File:        src/foo/bar.ts
Line:        42
```

**Do this in order:**

1. **Rotate the secret immediately.** Assume it's already compromised — the moment you typed it into a tracked file the credential is leaked, even if `git push` hasn't run yet. Treat the rotation as the priority, not the commit.
2. **Remove the secret from the diff.** Move it to an environment variable, a non-tracked config file (added to `.gitignore`), or a secrets manager.
3. **Re-stage and re-commit.** The hook should now pass.
4. **If the finding is genuinely a false positive**, add the fingerprint to `.gitleaksignore` *in the same commit*, with a `# TRIAGE-N` comment explaining why. New entries to `.gitleaksignore` will be reviewed at PR time.

### Bypass (rare)

```bash
git commit --no-verify   # skips ALL pre-commit hooks
```

Use only when you've already added the finding to `.gitleaksignore` in the same commit and gitleaks is being stubborn about it locally — CI will still validate.

---

## Manual scans

```bash
# Mirror what CI runs on push:
gitleaks detect --no-git --config=.gitleaks.toml

# Mirror what pre-commit runs:
gitleaks protect --staged --config=.gitleaks.toml

# Scan a specific file:
gitleaks detect --no-git --config=.gitleaks.toml --source=path/to/file
```

---

## Where the rules live

| File              | What it does                                                       |
|-------------------|--------------------------------------------------------------------|
| `.gitleaks.toml`  | Extends the gitleaks default ruleset; adds path/regex allowlists for runtime data, vendored bundles, IPFS blocks, public-by-design IDs (CIDs, EVM addresses) |
| `.gitleaksignore` | Per-finding allowlist by SHA-1 fingerprint (`<File>:<RuleID>:<StartLine>`). Each entry has a TRIAGE-N comment + rationale + link to follow-up task |
| `.husky/pre-commit` | Calls `gitleaks protect --staged` if the binary is installed |
| `.github/workflows/secret-scan.yml` | Runs gitleaks on PR + push |

---

## Triaged historical findings

See the [Wave 4 task doc](../../.cursor/tasks/SEC-2026-04-21-PC2-AUDIT/WAVE-4-SECRET-HYGIENE.md#triage-table--historical-findings) for the current triage table. As of Wave 4 cutover: 1 real (queued for rotation), 3 false-positive / public-by-design.
