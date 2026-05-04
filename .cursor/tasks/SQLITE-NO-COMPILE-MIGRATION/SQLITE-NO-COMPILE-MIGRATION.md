# Task: Eliminate Xcode-CLT requirement on fresh Mac install — migrate `better-sqlite3` → `@photostructure/sqlite`

**Task ID**: SQLITE-NO-COMPILE-MIGRATION
**Created**: 2026-05-01
**Status**: InProgress (Phase 2 complete, awaiting user approval to start Phase 3 verification)
**Priority**: High
**Target release**: v1.2.7 (or rolled into v1.3 if other v1.3 work converges)
**Reported by**: Sasha — fresh Mac install via ElastOS Launcher on 2026-05-01 evening

---

## TL;DR

`better-sqlite3` is the last native module forcing PC2's "download and run" experience to fall back to a terminal command (`xcode-select --install`). The fix is to swap it for `@photostructure/sqlite` — a Node-API drop-in with prebuilds **bundled inside the npm tarball** — eliminating both the postinstall download AND the per-Node-major-version ABI matching that bites every fresh Mac install. Estimated effort: ~2–4 hours of focused work across `pc2-node/src/storage/database.ts` and a small handful of callers + scripts.

---

## Background — What happened on 2026-05-01

After cutting v1.2.6 and tagging it, the user did a fresh-Mac validation install via the ElastOS Launcher (Electron app, separate repo from `pc2.net`). The install log shows:

```
[7:39:54 PM] Installing PC2 to /Users/sash/.pc2...
[7:39:54 PM] Using Node.js: /Users/sash/.elastos/node/node-v22.13.1-darwin-arm64/bin/node
...
[7:41:42 PM] Rebuilding better-sqlite3 against Node ABI...
[7:42:01 PM] Verifying better-sqlite3 loads against bundled Node...
[7:42:02 PM] ⚠ better-sqlite3 failed to load — attempting clean reinstall...
[7:42:03 PM] ❌ better-sqlite3 failed to load even after clean reinstall.
              Install Xcode Command Line Tools: xcode-select --install
[7:43:11 PM] Starting PC2 from /Users/sash/.pc2/pc2-node...   ← launcher should have aborted here
[7:43:12 PM] [ERROR] ❌ Failed to initialize database:
  The module '/Users/sash/.pc2/pc2-node/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  was compiled against a different Node.js version using NODE_MODULE_VERSION 115.
  This version of Node.js requires NODE_MODULE_VERSION 127.
[7:43:12 PM] PC2 exited with code 1
```

Two distinct problems exposed:

1. **The actual ABI mismatch.** The runtime is Node 22.13.1 (`NODE_MODULE_VERSION 127`) but the on-disk `better_sqlite3.node` is compiled for Node 20 (`NODE_MODULE_VERSION 115`). v1.2.6 bumped to `better-sqlite3@^11.10.0` which DOES ship Node-22 darwin-arm64 prebuilds, but the launcher's install pipeline still ended up with a Node-20 binary. Likely cause: the launcher does `npm install` (fetches a prebuild against whatever `process.versions.modules` resolves to at that moment) followed by an explicit `npm rebuild better-sqlite3` (which without `--update-binary` tries to compile from source) — when the source compile fails silently (Xcode CLT missing), the existing wrong-ABI prebuild is left in place.

2. **The launcher abort bug.** The launcher's verification gauntlet correctly detected the failure and printed the right user-facing message (`Install Xcode Command Line Tools: xcode-select --install`), but then continued to `Starting PC2 from /Users/sash/.pc2/pc2-node...` instead of aborting. PC2 then crash-logged at `DatabaseManager.initialize`, burying the actionable error under a stack trace. This is a launcher-repo bug — out of scope for `pc2.net` itself but tracked here for cross-reference.

---

## Why `@photostructure/sqlite` is the right fix

From the `@photostructure/sqlite` library-comparison docs (the maintainer maps the trade-off explicitly):

| Property | `better-sqlite3` (today) | `@photostructure/sqlite` (proposed) | `node:sqlite` (alternative) |
|---|---|---|---|
| ABI model | **V8-specific** — separate prebuild per Node major version | **Node-API** — single prebuild per platform works across all Node majors | N/A — built into Node runtime |
| Prebuild distribution | **Postinstall download from GitHub** — fails on slow networks, behind firewalls, or when a Node × platform combo isn't in the matrix | **Bundled in the npm tarball** — `npm install` is the only step | N/A |
| Compile fallback when prebuild missing | C++ source compile via `node-gyp` — needs Xcode CLT / `build-essential` | C++ source compile if the bundled prebuild somehow doesn't match — but every supported platform IS in the bundle | None possible |
| API parity with our existing code | Reference (we already use this) | 100% compatible with `node:sqlite`, ~95% compatible with `better-sqlite3` (the 5%: `db.transaction()` helper and a few PRAGMA shortcuts) | Same as `@photostructure/sqlite` |
| Maintenance status | Maintenance mode (Dec 2025+) — SQLite & prebuild updates only, no new features | Active development | Active core dev |
| Min Node version | 20+ | 20+ | **22.5+** |
| `node:sqlite` migration path later | Not API-compatible | **One-line import change** | N/A — already there |

**Verdict**: `@photostructure/sqlite` gives us:
- ✅ Genuine zero-compile, zero-postinstall-download install on every supported platform
- ✅ Sync, ergonomic API our existing code uses
- ✅ A trivial future migration to `node:sqlite` when it stabilises (just change the import)
- ✅ Eliminates the entire `NODE_MODULE_VERSION` mismatch class of bugs
- ✅ Removes the launcher's brittleness — no more "rebuild against bundled Node" gymnastics needed

We deliberately do NOT pick `node:sqlite` directly because it's still ExperimentalWarning until Node 25.7+ — would tie our DB layer to a runtime we don't fully control.

---

## Scope

### In scope

- **Replace the `better-sqlite3` dependency** in `pc2-node/package.json` with `@photostructure/sqlite` (current version, latest stable at task-start time).
- **Migrate `pc2-node/src/storage/database.ts`** — the primary consumer — from `import Database from 'better-sqlite3'` / `new Database(path)` to `import { DatabaseSync } from '@photostructure/sqlite'` / `new DatabaseSync(path)`.
- **Audit and update the small set of `better-sqlite3`-specific API uses** that don't exist in the Node-API surface:
  - `db.transaction(fn)` helper → wrap in explicit `db.exec('BEGIN')` / `db.exec('COMMIT')` / `db.exec('ROLLBACK')` pattern, or implement a small helper inline.
  - `db.pragma(name, { simple: true })` → `db.exec(\`PRAGMA \${name}\`)` or `db.prepare(\`PRAGMA \${name}\`).get()` depending on whether a return value is needed.
  - `Statement.iterate()` (if used) → `for (const row of stmt.all())` (small perf hit, easy fix).
- **Verify all other consumers** of better-sqlite3 import paths in the repo (grep + targeted `Read`) and update them too.
- **Remove `--build-from-source` for `better-sqlite3`** in `scripts/update.sh`, `scripts/install-arm.sh`, `pc2-node/src/services/UpdateService.ts`, and any other install-flow files. The flag stays in place for `node-datachannel` (still genuinely needs source compile sometimes — different problem).
- **Update the verification gauntlet** in `update.sh`, `UpdateService.ts`, and `scripts/install-arm.sh` to load-test the new module name (`@photostructure/sqlite` instead of `better-sqlite3`). Keep the gauntlet — it's still valuable for `node-datachannel` and as defence in depth.
- **Rev `package.json` versions** — `1.2.6` → `1.2.7` (root + `pc2-node/`).
- **CHANGELOG.md** — new `[1.2.7]` section explaining what shipped and that #1 from v1.2.6 is now genuinely complete.
- **End-to-end verification on three platforms before tag**: Jetson (linux-arm64), Mac fresh install via ElastOS Launcher (darwin-arm64), and either x86_64 Linux or WSL.

### Explicitly out of scope (separate tasks)

- **The launcher abort bug** — when the verification gauntlet fails, the launcher should `process.exit(1)`, not continue. This lives in the ElastOS Launcher repo (Electron app), not `pc2.net`. Track separately.
- **Migration to native `node:sqlite`** — defer until `node:sqlite` is stable (Stability 1.2 / Release Candidate as of Node 25.7+, hopefully stable by the time we want to do this). Trivial follow-up: change one import line.
- **Other native modules** — `bcrypt`, `node-pty`, `sharp`, `node-datachannel` already use NAPI or platform-specific prebuilt subpackages and are working correctly. Don't touch.
- **Database schema changes** — this is a binding-layer migration only, no schema work.

---

## When does the user need to open their local pc2-node?

| Phase | Local pc2-node needed? | What you do |
|---|---|---|
| **Phase 1 (investigation)** | **No.** Pure read-only static analysis (grep + npm metadata lookup). Agent does this autonomously, no install/build/restart. | Nothing. Review the agent's findings. |
| **Phase 2 (migration code edits)** | **No.** Agent edits source files and runs a clean `npm install` + `npm run build:backend` inside `pc2-node/` to verify TypeScript compiles. Doesn't need to start pc2-node. | Nothing. Review the diff. |
| **Phase 3 (verification)** | **Yes — this is where your involvement matters most.** Three platforms: local Mac dev (your machine), Jetson (via `update.sh`), fresh Mac via ElastOS Launcher (the acceptance test). | Start pc2-node locally so the agent can guide a smoke test (login → marketplace → open a paid asset). Run `update.sh` on Jetson with `pc2.db` backup taken first. |
| **Phase 4 (release)** | Optional. PR review on GitHub is sufficient. | Self-review the PR. Approve. Tag. |

So for Phase 2, you do **nothing** — just review the code diff when the agent presents it for approval. Phase 3 is when your hands-on testing matters.

---

## Implementation plan

### Phase 1 — Investigation (≤30 min, before any code change) ✅ COMPLETE 2026-05-02

#### Phase 1 results (recorded 2026-05-02 by agent during initial investigation pass)

**Pinned `@photostructure/sqlite` version**: `1.2.1` (latest stable as of 2026-05-02). Use `^1.2.1` in `pc2-node/package.json`. If a newer minor drops before Phase 2 starts, re-verify before bumping.

**Prebuild matrix** (verified by inspecting installed tarball; prebuilds are bundled directly inside the npm package, not as `optionalDependencies`):
- ✅ `darwin-arm64` (`.glibc.node` — Node-API works on macOS regardless of glibc/musl naming)
- ✅ `darwin-x64`
- ✅ `linux-arm64` (both `.glibc.node` and `.musl.node` — Jetson uses glibc)
- ✅ `linux-x64` (both glibc and musl)
- ✅ `win32-arm64`
- ✅ `win32-x64`

All platforms PC2 cares about are in the bundle. Package size: 28 MB installed (vs ~5 MB for `better-sqlite3`). Trade-off: bigger install, but zero postinstall download and zero compile fallback needed.

**SQLite C-library version parity**:
- `better-sqlite3@11.10.0` → SQLite **3.49.2**
- `@photostructure/sqlite@1.2.1` → SQLite **3.53.0**
- Forward-compat: 3.53.0 reads 3.49.2-written files with no migration. SQLite has very strong forward-compat guarantees for the file format. No `VACUUM` needed on first boot. Acceptance #3 (existing `pc2.db` carries forward) is safe.

**MAJOR FINDING — `enhance()` wrapper provides better-sqlite3-compatible API**:

`@photostructure/sqlite` exports an `enhance(db)` function that adds `.pragma()`, `.transaction()`, `.pluck()`, `.raw()`, and `.expand()` methods that are **byte-for-byte behavior-compatible with better-sqlite3**:
- `db.pragma('journal_mode', { simple: true })` returns `"memory"` (scalar) — **identical** to better-sqlite3
- `db.pragma('journal_mode')` returns `[{"journal_mode":"memory"}]` (array of objects) — **identical**
- `db.transaction(fn)` returns a callable transaction wrapper with `.deferred`, `.immediate`, `.exclusive` variants — **identical**

This dramatically simplifies the migration. We do NOT need to rewrite call sites with explicit `BEGIN`/`COMMIT` or `db.exec('PRAGMA xxx')`. We just wrap once at construction time:
```ts
import { DatabaseSync, enhance } from '@photostructure/sqlite';
const db = enhance(new DatabaseSync(path));  // existing call sites work unchanged
```

**Migration risk revised: Low → Very Low.**

**Call-site count for `better-sqlite3`-specific API surface (pc2-node only)**:

| API | Sites in pc2-node | Notes |
|---|---|---|
| `import Database from 'better-sqlite3'` | 5 (`storage/database.ts`, `storage/migrations.ts`, `storage/context.ts`, `services/ai/memory/VectorMemoryStore.ts`, `scripts/wave5-smoke-bootstrap.mjs`) | All replaced with `import { DatabaseSync, enhance } from '@photostructure/sqlite'`. |
| `new Database(path)` | 4 (one per file above except `migrations.ts` which only uses the type) | All replaced with `enhance(new DatabaseSync(path))`. |
| `Database.Database` type annotation | 11 (in 4 files: `database.ts` ×3, `migrations.ts` ×5, `context.ts` ×2, `VectorMemoryStore.ts` ×1) | Replace with `EnhancedDatabaseSync<DatabaseSync>` from `@photostructure/sqlite`. |
| `.pragma(name, { simple: true })` | 3 (`database.ts` ×2, `VectorMemoryStore.ts` ×1) | **No change needed** — `enhance()` provides byte-compatible API. |
| `.transaction(fn)` (callback pattern) | 3 (`api/telemetry.ts`, `services/ai/memory/VectorMemoryStore.ts`, `storage/context.ts`) | **No change needed** — `enhance()` provides byte-compatible API. |
| `.iterate()` | 0 | Not used. |
| `.aggregate()` | 0 | Not used. |
| `.backup()` | 0 | Not used. |
| `.function()` (UDF registration) | 0 | Not used. |
| `.loadExtension()` (sqlite-vec, etc.) | 0 confirmed-active. `VectorMemoryStore` mentions `sqlite-vec` in comments but the actual code is **stubbed** (`hasVectorSupport = false`, FTS5 fallback only). No live extension loading to migrate. |

**False positives identified and excluded from scope**:
- `pc2-node/src/wallet-bridge/pc2-secure-view-session.js` — `db.transaction(store, 'readonly')` calls are **IndexedDB** (browser API), not better-sqlite3. Confirmed by reading context: uses `indexedDB.open()`, `objectStoreNames`, `tx.objectStore(...)`. Out of scope.

**Out-of-scope codebases (have their own `better-sqlite3` deps but are NOT shipped to PC2 end users)**:
- `src/backend/package.json` (legacy Puter backend, `^11.9.0`) + `src/backend/src/services/database/SqliteDatabaseAccessService.js`
- `deploy/network-map/package.json` (separate deployable, `^9.4.3`) + `deploy/network-map/server/database.js`
- These should NOT be migrated as part of this task. They are separate components with their own release cadences. If/when the legacy puter backend is touched again, it can be migrated separately.

**Build/install scripts containing `--build-from-source` for `better-sqlite3`**:
- `scripts/update.sh` (lines 251, 284)
- `scripts/start-local.sh` (lines 548, 602) ← was missed in the original task doc; needs same treatment
- `scripts/install-arm.sh` — **no matches** (file is unaffected by this migration; remove from file-change list)

**Build/install scripts containing the gauntlet load-test (`require('better-sqlite3')(':memory:')...`)**:
- `pc2-node/src/services/UpdateService.ts` (line 566)
- `scripts/update.sh` (lines 281, 285, 289)
- `scripts/start-local.sh` (line 594)

#### Final file-change list (presented for user approval before Phase 2 starts)

**Source files (8 production)**:
1. `pc2-node/src/storage/database.ts` — change import + `enhance()` wrap + 3 type annotations. ~5 LOC delta.
2. `pc2-node/src/storage/migrations.ts` — change import + 5 type annotations. ~5 LOC delta.
3. `pc2-node/src/storage/context.ts` — change import + `enhance()` wrap + 2 type annotations. ~4 LOC delta.
4. `pc2-node/src/services/ai/memory/VectorMemoryStore.ts` — change import + `enhance()` wrap + 1 type annotation. ~3 LOC delta.
5. `pc2-node/src/api/telemetry.ts` — **no change needed** (uses `(db as any)` cast; behavior preserved via `enhance()`). _Listed for awareness only._
6. `pc2-node/scripts/wave5-smoke-bootstrap.mjs` — change import + `enhance()` wrap. ~2 LOC delta. (Dev tool.)
7. `pc2-node/src/services/UpdateService.ts` — gauntlet load-test rename + diagnostic message rewrite. ~3 LOC delta.
8. `scripts/update.sh` — drop `--build-from-source better-sqlite3` (lines 251, 284), update gauntlet load-test (281, 285, 289), update diagnostic message hint. ~10 LOC delta.
9. `scripts/start-local.sh` — drop `--build-from-source better-sqlite3` (lines 548, 602), update gauntlet load-test (594), update diagnostic message hint. ~10 LOC delta.

**Package management (3 files)**:
10. `pc2-node/package.json` — remove `better-sqlite3`, add `@photostructure/sqlite@^1.2.1`. Bump version `1.2.6 → 1.2.7`.
11. `pc2-node/package-lock.json` — clean regeneration (`rm pc2-node/package-lock.json && cd pc2-node && npm install`).
12. `package.json` (root) — bump version `1.2.6 → 1.2.7`.

**Documentation (2 files)**:
13. `CHANGELOG.md` — new `[1.2.7]` section.
14. `.cursor/tasks/SQLITE-NO-COMPILE-MIGRATION/SQLITE-NO-COMPILE-MIGRATION.md` — status updates as Phases 2/3/4 progress.

**Files explicitly NOT modified** (separate codebases, separate concerns):
- `src/backend/**` (legacy Puter)
- `deploy/network-map/**` (separate deployable)
- `scripts/install-arm.sh` (no `better-sqlite3` references)

**Estimated total LOC changed**: ~40-50 LOC across 12 files (vs the task doc's original "30 LOC across 4 files" estimate — slightly more files, similar LOC, much lower per-site complexity than originally thought thanks to `enhance()`).

#### Original Phase 1 checklist (preserved for reference)


- [ ] Grep `pc2-node/` and the rest of the repo for every `from 'better-sqlite3'` / `require('better-sqlite3')` import. List the files. Should be a small number (`storage/database.ts` is the primary).
- [ ] Grep for the `better-sqlite3`-specific API surface that doesn't exist in `node:sqlite`/`@photostructure/sqlite`:
  - `\.transaction\(`
  - `\.pragma\(`
  - `\.iterate\(`
  - `\.aggregate\(` / `\.function\(` (UDF registration — different API in Node-API)
  - `\.backup\(` (backup support)
- [ ] Document the actual call-site count for each of the above. Decide replacement strategy per call (simple wrap vs helper extraction).
- [ ] Verify `@photostructure/sqlite` ships prebuilds for: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64` against Node 20 LTS + Node 22 LTS. (Spot-check the npm tarball or their GitHub releases.)
- [ ] **Pin the version explicitly.** Record the exact `@photostructure/sqlite` version verified above (`vX.Y.Z`) in this task doc, and use `^X.Y.Z` (caret on the verified minor) in `pc2-node/package.json`. If a newer minor drops between Phase 1 and Phase 2, re-verify before bumping. Avoids "agent picks up two days later, npm has bumped, surprise breakage."
- [ ] **Verify SQLite C-library version parity.** Both libraries link recent SQLite 3.5x but exact versions matter for WAL/journal forward-compat. Run a one-off script that opens the same fixture DB with each library and prints `SELECT sqlite_version()`. Either confirm parity, or document the delta in this task doc and decide whether a `VACUUM` on first boot is warranted (acceptance #3 dependency).

### Phase 2 — Migration

- [ ] `pc2-node/package.json`: remove `better-sqlite3`, add `@photostructure/sqlite` at the version pinned in Phase 1. **Regenerate the lockfile cleanly** (`rm pc2-node/package-lock.json && npm install` from inside `pc2-node/`). Do NOT do an incremental `npm install --save` — that risks leaving stale `better-sqlite3` lock-entries and a hybrid lockfile state that's hard to review.
- [ ] `pc2-node/src/storage/database.ts`: change the import + class instantiation. Replace any `better-sqlite3`-specific API uses identified in Phase 1 with the Node-API equivalents.
- [ ] Run `npm run build:backend` locally — fix any TypeScript errors surfaced by the type signature changes. (Both libraries ship sync APIs with similar shapes; expected delta is ~10–30 lines.)
- [ ] `pc2-node/src/services/UpdateService.ts`: rename the verification gauntlet's load test from `require('better-sqlite3')` to `require('@photostructure/sqlite')`. Adjust the SELECT 1 sanity check syntax. **Also update the user-facing diagnostic message** — current message is "Install Xcode Command Line Tools: xcode-select --install" which would be misleading for the new lib (it shouldn't fail this way). Change to something like: "@photostructure/sqlite failed to load — check that node_modules is intact, try `rm -rf node_modules && npm install`."
- [ ] `scripts/update.sh`: remove `--build-from-source better-sqlite3` line and the corresponding error hint. Update the verification gauntlet's load test AND the user-facing diagnostic message the same way as `UpdateService.ts`. Keep the `--build-from-source` for `node-datachannel` if present.
- [ ] `scripts/install-arm.sh`: same treatment.
- [ ] `pc2-node/scripts/build-frontend.js` and `pc2-node/frontend/index.html`: cache-buster bump **only if the migration actually touches something served to the browser** (it shouldn't — this is a backend-only change). Bumping the cache-buster for non-changes trains us to ignore it as a signal. If nothing browser-facing changes, leave the cache-buster at `?v=20260501c`.

### Phase 3 — Verification

- [ ] Local Mac dev: full reinstall (`rm -rf node_modules && npm install`) → `npm run build` → `npm start` → verify DB initializes, smoke test core flows (login, browse marketplace, open a paid asset).
- [ ] **No-CLT acceptance test (use the safest equivalent available, in this preference order):**
  1. **Preferred**: a darwin-arm64 GitHub Actions runner — fully isolated, no risk to dev machine.
  2. **Acceptable**: a fresh non-admin macOS user account on the dev Mac (`System Settings → Users & Groups → Add User`). Install only the bundled Node, run the launcher install in that account. CLT is per-user-discoverable; a fresh user starts without it.
  3. **Last resort**: temporarily rename `/Library/Developer/CommandLineTools` (sudo required). **This breaks `xcrun`-using tools mid-session and risks the dev environment.** Only use if 1 and 2 are unavailable. If used, restore CLT immediately after the test.
- [ ] Jetson (linux-arm64): pull the branch, run `update.sh`, verify it completes without falling back to source compile, verify pc2-node restarts healthy.
- [ ] Fresh Mac via ElastOS Launcher: this is the acceptance test. The launcher install must complete and start PC2 successfully on a Mac that has NEVER had Xcode CLT installed.
- [ ] (Bonus) WSL Ubuntu: same drill — verify cleanly.

### Phase 4 — Release

- [ ] Bump `package.json` versions to `1.2.7` in both root and `pc2-node/`. **Critical sequencing**: the version bump must land in the SAME commit as the dep swap (or a later commit on the release branch). Never have a commit at v1.2.6 with v1.2.7-only deps — that publishes a half-state if it accidentally gets tagged.
- [ ] CHANGELOG.md: new `[1.2.7]` section. Reference the v1.2.6 known issue and how this resolves it. List the three verification platforms.
- [ ] Single feature commit with HEREDOC commit message (no AI signatures, follow existing project style).
- [ ] PR `release/v1.2.7` → `main`. Self-review on GitHub before merge.
- [ ] Tag `v1.2.7` on the merge commit. Push tag.
- [ ] Create GitHub release with the new CHANGELOG section as notes.
- [ ] Run `update.sh` on the Jetson to validate the production update path one final time.

---

## Acceptance criteria

1. Fresh-Mac install via ElastOS Launcher completes successfully on a Mac without Xcode CLT installed. PC2 starts, the database initializes, the marketplace loads.
2. `update.sh` runs cleanly on the Jetson with no `--build-from-source` step for SQLite. The native-module verification gauntlet still passes (now testing `@photostructure/sqlite`).
3. Existing PC2 installs upgrading from v1.2.6 to v1.2.7 carry their database forward correctly — `pc2-node/data/pc2.db` is read by the new binding without migration. (The on-disk SQLite file format is identical; both libraries link to the same SQLite C library or a compatible version.)
4. All existing functionality works: marketplace browse/buy/play, content indexing, secure-view delegation, paid-asset playback, free-asset playback.
5. No other native module is touched. `bcrypt`, `node-pty`, `sharp`, `node-datachannel` all behave identically to v1.2.6.
6. CHANGELOG entry is honest about what changed and why — no marketing claims that turn out to be wrong this time.

---

## Files expected to change

Estimated set, to be confirmed in Phase 1:

- `pc2-node/package.json` (dep swap + version bump)
- `pc2-node/package-lock.json` (regenerated)
- `package.json` (root version bump)
- `pc2-node/src/storage/database.ts` (primary migration site)
- `pc2-node/src/services/UpdateService.ts` (gauntlet rename)
- `scripts/update.sh` (drop `--build-from-source` for sqlite, rename gauntlet target)
- `scripts/install-arm.sh` (same)
- `CHANGELOG.md` (new v1.2.7 section)
- `.cursor/tasks/SQLITE-NO-COMPILE-MIGRATION/SQLITE-NO-COMPILE-MIGRATION.md` (this file — status updates as work progresses)

Possibly:
- A handful of additional files if Phase 1 grep finds more `better-sqlite3` import sites.

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@photostructure/sqlite` API surface differs more than expected | Low | Medium | Phase 1 grep documents every divergence before any code change. If divergence is significant, fall back to keeping `better-sqlite3` and pursuing the launcher-side fix instead. |
| SQLite version skew between the two libraries causes WAL/journal compat issue with existing `pc2.db` files | Very Low | High | Both libraries link to recent SQLite (3.5x). The on-disk format is forward-compatible across SQLite minor versions. If observed, add a one-time `VACUUM` on first boot. |
| Prebuild matrix has a hole for some platform we care about | Low | Medium | Phase 1 verification step. If a hole exists, file an issue upstream and keep the source-compile fallback as defence in depth (with the existing gauntlet to surface failures). |
| Existing prepared statements have subtly different bind/return semantics | Low | Low | Both use sqlite3 type affinity. Smoke test in Phase 3 covers the common cases; any divergence shows up immediately. |

---

## Strategic context

This is the **last** install-friction issue blocking PC2 from being "download → click → run" on a fresh Mac. The roadmap goal in `.cursor/plans/Roadmap.md` Track 0 ("Normal People Product") is genuinely achievable for the macOS terminal-free path once this lands. v1.2.6's CHANGELOG §1 said "no Xcode CLT required" but it turned out we were one library swap away from that being true.

After this lands, the remaining Mac terminal-free work is purely Apple code-signing + notarization (Track 0.1 in the roadmap, $99/year). No more native-module-toolchain anxiety.

---

## Notes for the agent picking this up

- This task lives in the `pc2.net` repo (not the launcher repo). Don't try to fix the launcher abort bug here — file it separately.
- v1.2.6 is tagged at commit `124823dd1` on `main`. Branch `release/v1.2.7` from `main` for this work. **Both v1.2.7 items (this task and `SECURE-VIEW-MM-MOBILE-INAPP-BROWSER`) target the same `release/v1.2.7` branch**; if both are in flight, this task's commits land first because they're lower-risk and provide a stable base for the secure-view debugging.
- The Jetson is on a clean v1.2.6 install (verified hot-patch-free at the v1.2.6 ship). Don't break it; use `update.sh` to ship the v1.2.7 branch test build to it for verification. **Before running `update.sh` on Jetson, take a backup**: `cp pc2-node/data/pc2.db pc2-node/data/pc2.db.v126-backup`. Belt and braces — costs nothing, gives a clean rollback path.
- Don't scope-creep. The launcher abort bug is in scope for "next time the launcher repo is touched", NOT for this task.
- After Phase 1 (investigation), present the file-change list to the user for confirmation before starting Phase 2.

### Status updates as work progresses

| Date | Phase | Status | Notes |
|---|---|---|---|
| 2026-05-01 | — | Proposed (initial) | Task drafted after Sasha's fresh-Mac install hit the `NODE_MODULE_VERSION` mismatch. |
| 2026-05-02 | — | Proposed (review tweaks T1–T7 applied) | Doc-only refinements before kickoff: pin version explicitly, verify SQLite C-lib parity, safer no-CLT acceptance test, clean lockfile regen, fix gauntlet diagnostic message, don't bump cache-buster gratuitously, sequence version bump correctly. |
| 2026-05-02 | Phase 1 | InProgress → Complete | Phase 1 investigation done. Pinned `@photostructure/sqlite@^1.2.1`. Verified prebuilds for all platforms PC2 cares about. Confirmed SQLite version parity (3.49.2 → 3.53.0, forward-compat safe). **Major finding**: `enhance()` wrapper provides byte-compatible `.pragma()` and `.transaction()` APIs — migration risk dropped to Very Low. No `.iterate()`, `.aggregate()`, `.backup()`, `.function()`, or `.loadExtension()` calls in scope. False-positive `.transaction()` calls in `pc2-secure-view-session.js` are IndexedDB. Final file-change list: 12 files (~40-50 LOC). Awaiting user approval to start Phase 2. |
| 2026-05-02 | Phase 2 | InProgress → Complete | Phase 2 code edits done. Migrated `pc2-node/package.json` (dropped `better-sqlite3@^11.10.0` and `@types/better-sqlite3`, added `@photostructure/sqlite@^1.2.1`, bumped `1.2.6 → 1.2.7`). Bumped root `package.json` to `1.2.7`. Regenerated lockfile cleanly (`rm package-lock.json && npm install`). Edited 4 source files (`storage/database.ts`, `storage/migrations.ts`, `storage/context.ts`, `services/ai/memory/VectorMemoryStore.ts`) + 1 dev script (`scripts/wave5-smoke-bootstrap.mjs`) — all use the `enhance()` wrapper, no API call-site rewrites needed. Updated 3 install/update scripts (`scripts/update.sh`, `scripts/start-local.sh`, `scripts/install-wsl.sh` — last one was missed in original task doc) to drop `--build-from-source` for sqlite, rename gauntlet load-tests, fix diagnostic messages. Updated `pc2-node/src/services/UpdateService.ts` gauntlet. **TypeScript build clean for migration**: 44 pre-existing errors in untracked `src/sdk/index.ts` (NOT related to migration; see "Known unrelated issue" below); 0 errors in migration-related code. **Runtime smoke test passes** — `enhance()`-wrapped `DatabaseSync` exhibits byte-identical behavior to `better-sqlite3` for `.pragma()`, `.pragma(name,{simple:true})`, `.transaction(callback)`, `.prepare/.run/.get/.all`. Used `Database` type alias = `EnhancedDatabaseSync<DatabaseSyncInstance>` (DatabaseSync is a value/class, DatabaseSyncInstance is the type). Awaiting user approval to start Phase 3. |
| 2026-05-02 | Phase 3 | InProgress (run 1) | Local Mac smoke test: server started on port 4200 against real `pc2.db` (backed up first to `pc2.db.v126-backup-*`). DB initialized cleanly with `@photostructure/sqlite`. User exercised UI for ~2 minutes — login, file browsing, [Stat] queries on `/Documents` and `/Public`, all returning correctly (SQLite-backed metadata lookups verified live). Server then exited at 20:23:40 due to **unrelated libp2p stack-overflow crash** in `@libp2p/utils@7.1.0`'s job queue (recursive `onProgress` after 984 burst peer-dials following 32h cold-start downtime). Crash stack trace contains zero application code, zero SQLite code — confirmed pre-existing bug also present in v1.2.6. **Filed as separate ticket**: [LIBP2P-COLD-START-CRASH](../LIBP2P-COLD-START-CRASH/LIBP2P-COLD-START-CRASH.md). Restarted pc2-node (PID 27075) for continued testing. Migration verification continues on run 2. |

### Known unrelated issue surfaced during Phase 2 build

While running `npm run build:backend` to verify the migration compiles, TypeScript surfaced 44 pre-existing errors in `pc2-node/src/sdk/index.ts`.

**Confirmed unrelated to the SQLite migration**:
- `git ls-files pc2-node/src/sdk/` shows only `types.ts` is tracked. `index.ts` is **untracked** (working-tree-only).
- File creation date: 2026-03-23 (over a month before v1.2.6 shipped on 2026-05-01). Has been locally-broken for 6+ weeks.
- Nothing in `pc2-node/src/` imports from `../sdk/index.js` — only from `../sdk/types.js` (which is tracked and works fine). Confirmed via grep.

**Production impact: zero.**
- `update.sh` on the Jetson does `git pull` then `npm run build:backend`. Since `index.ts` is untracked, `git pull` never brings it across — the Jetson's working tree doesn't have this file at all.
- Same logic applies to fresh launcher installs and any other production deployment path.
- Only the user's local Mac dev tree has this file. Local dev uses `npm run dev` (`tsx watch`), which is permissive about TS errors in unused files, so the user's day-to-day workflow never noticed.

**Recommended follow-up (out of scope for v1.2.7)**: either (a) commit the missing types to `pc2-node/src/sdk/types.ts`, (b) delete the local `pc2-node/src/sdk/index.ts` file (`git clean -f pc2-node/src/sdk/index.ts`), or (c) add an exclude entry to `pc2-node/tsconfig.json`. Pick whichever is cleanest. We deliberately did not touch this in the SQLite migration to keep scope tight.

**Phase 3 verification implication**: when running `update.sh` on Jetson, the build will succeed normally. When running locally on the user's Mac, the user can either (a) ignore the sdk errors (the dev runtime tsx will still work via `npm run dev`), or (b) temporarily move/rename `pc2-node/src/sdk/index.ts` for the duration of the local smoke test.
