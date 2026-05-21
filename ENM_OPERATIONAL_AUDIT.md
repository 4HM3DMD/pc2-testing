# ENM Operational Audit — 2026-05-20

Scope: enm-server backend (~30K LOC, 65 services + 15 routes). 40 read-only audit
lenses across 4 waves. Goal: **100/100 operational, ZERO manual steps, safe at
hundreds-of-operators scale.** UX explicitly out of scope (deferred).

Severity: **P0** = blocks 100/100 / forces manual intervention / data loss / corruption /
blocks install on valid hosts. **P1** = serious reliability risk. **P2** = hardening.

The codebase is mature and disciplined (locking primitive, detached survivors, env
allowlist, PID-reuse defense, no resource leaks, sound auth model). The findings below
are the gaps between "works on my test box" and "100/100 for hundreds of unattended nodes."

---

## P0 — must fix before serving hundreds of operators

### Correctness bugs (broken features)
- **P0-1 — ActivateProducer is 100% broken.** `routes/chains.js:1390` uses `cfg` before its
  `const cfg = await ConfigStore.load()` at :1412 (temporal dead zone) → every BPoS
  reactivation throws → generic 500. The one BPoS write ENM supports never runs.
  **Fix:** move the `cfg`/`chainCfg` load above the RPC sync-gate block (~:1368).

### Self-healing / durability (chains end up down or corrupt with no recovery)
- **P0-2 — No auto-recovery from quarantine for a DOWN chain.** `SelfHealingEngine.js:367-381`:
  once the 3/10min restart budget is exhausted, escalation is **notify-only**; auto-restart is
  suppressed and the only auto-clear path (`_sweepAutoResolved`) requires the chain to be
  alive 30s — impossible if it's down. A transient 10-min blip → chain permanently down until
  a human clicks Confirm. **The core turnkey defect at scale.** **Fix:** long-backoff auto-retry
  from the escalated state (e.g. one more auto-restart + budget reset after 30-60 min); keep the
  proposal for visibility but never stop trying.
- **P0-3 — No binary auto-redownload on the start/heal path.** `EnmBinaryDownloader` is only
  called from setup; a missing/corrupt binary at runtime makes `adapter.start()` throw, self-heal
  re-throws, chain stays down until manual SSH. No "reset to known-good" action exists.
  **Fix:** on missing/failed-smoke-test binary in the start/heal path, trigger redownload + retry
  spawn (bounded) before surfacing failure.
- **P0-4 — `adapter.restart()` is NOT atomic.** `ChainAdapter.js:207-211` calls `stop()` then
  `start()` as two separate `withChainLock` acquisitions; the lock drops between them. A self-heal
  F1 restart racing an operator/API restart → double-start / two PIDs / port clash. Affects POST
  /restart, self-heal `_executeRestart`, auto-fix RESTART_CHAIN. **Fix:** hold ONE lock across
  stop+start (atomic restart in the adapter, or route through `NativeProcessService.restart`).
- **P0-5 — SIGINT flush skips reattached chains → leveldb corruption.** After ANY ENM restart
  (deploy/reboot), chains are re-adopted via `reattach()` with **no `ChildProcess` handle**;
  `NativeProcessService.signalAll` (:220-221) only signals chains with a handle, so the shutdown
  flush sends SIGINT to ZERO children. EVM geth then gets pc2-node's later kill mid-write →
  unclean leveldb shutdown / corruption — the exact thing the flush exists to prevent.
  **Fix:** fall back to `process.kill(handle.pid, signal)` for reattached chains.
- **P0-6 — EVM chain-resync races self-heal → corruption / wipe undone.** `EnmMaintenanceManager`
  chainResync stops + `rm`s data but never disables F1/`enabled` and the no-handle `stop()` path
  never records `manualStop`; HealthChecker synthesizes `manualStop:false` → **F1/AUTOSTART
  restarts ela mid-`rm`** → corrupt DB or the wipe silently fails. **Fix:** mark manual-stop
  (handle-independent) + hold `withChainLock` across the whole stop+wipe, or set `enabled=false`
  before stop.

### Config persistence (bricked nodes / silent data loss)
- **P0-7 — ConfigStore lost-update race.** `ConfigStore.save` (:79) is a bare read-modify-write
  with no lock; ~15 writers including background timers (HealthChecker, SelfHealingEngine,
  StorageMaintenance, autostart, adapters) interleave with operator `PUT /config/*` → last write
  wins → operator's setting silently reverts. Routine at scale. **Fix:** serialize the full
  load→mutate→save through a mutex (e.g. `ConfigStore.update(mutatorFn)` holding an internal lock).
- **P0-8 — Corrupt config bricks startup (no `.bak` fallback).** `ConfigStore.load` (:54-60) throws
  on corrupt JSON; a last-good `.bak` exists but `load()` never consults it → server won't start →
  manual file repair. **Fix:** on parse/validate failure, restore from validated `.bak` + log loudly.
- **P0-9 — `atomicWrite` has no fsync → power-loss corruption.** `DataDir.js:176-183`: writeFile +
  rename with no `fsync` on the temp fd before rename nor the parent dir after. Power loss can
  leave a zero-length `config.json` (and `.bak` shares the flaw). **Fix:** fsync temp fd before
  rename, fsync parent dir after.

### Install / turnkey (can't install, or install corrupts)
- **P0-10 — OsPreflight hard-blocks all non-Debian distros.** `OsPreflight.js:42-48,73-80` rejects
  RHEL/Fedora/CentOS/Rocky/Alma/Amazon/Arch/SUSE/Alpine — a valid host literally cannot install.
  It also checks the *wrong* things (no disk/RAM/`tar`/glibc check; the one case that SHOULD block,
  musl/Alpine, isn't detected). **Fix:** stop gating on distro family; detect-and-warn, hard-block
  only on a real missing capability (libc, `tar`, disk).
- **P0-11 — Snapshot-extract idempotency trap → silent genesis resync / crash-loop.**
  `EnmSnapshotDownloader`: interrupted extract leaves a partial datadir; `isSnapshotApplied` returns
  true for ANY non-empty dir → re-run SKIPS the snapshot → chain boots on corrupt/partial data →
  multi-day resync or boot failure, forcing manual `rm -rf`. **Fix:** extract to temp + atomic
  rename on success (mirror EnmBootstrapDownloader), or gate idempotency on a `.snapshot-complete`
  sentinel, not "dir non-empty".
- **P0-12 — Snapshot download: no resume + no disk preflight.** Multi-GB download restarts from
  byte 0 on any network drop (no HTTP Range); the active 4-chain parallel path has ZERO free-space
  check (unlike Bootstrap) → mid-extract disk-full corrupts the datadir and can wedge the VPS.
  **Fix:** Range-resume + bounded retry; sum selected-chain footprints vs free space before start;
  serialize extraction.
- **P0-13 — No download integrity verification (supply-chain) + off-host redirect.** Binaries +
  snapshots trust whatever bytes arrive over TLS (`EnmBinaryDownloader.js:18-21`); PG's comment
  claims a `verifyChecksum` that **doesn't exist**; a clean-finish truncation is undetected (no
  Content-Length check); 30x redirects are followed to ANY host. A poisoned mirror / hijacked
  redirect delivers a binary ENM runs **as root**. **Fix:** pin + verify SHA-256 (ideally
  signature) per chain+version+arch before rename/extract; assert `Content-Length`; allow-list
  redirect hosts to `*.elastos.io`.

### Diagnostics / health (false actions on healthy chains)
- **P0-14 — Diagnostics class-blind RPC → restarts healthy arbiter (C19 reincarnated).**
  `Diagnostics.js:356-357` calls `getblockcount`/`getconnectioncount` on EVERY alive chain;
  the arbiter (class D) serves neither → false `rpc-reachable: FAIL (F2)` with `autoFix:
  RESTART_CHAIN`. **Fix:** call the class-correct `adapter.health()`/`primaryHeight()` instead of
  hardcoding ELA verbs. (Same root cause lingers in `HealthChecker._fetchRpcSummary` medium tick —
  see P1.)

### Networking / preflight (can't sync, or can't install on capable hosts)
- **P0-15 — UDP discovery ports never opened in UFW → 0 inbound peers.** `EnmFirewallManager` is
  TCP-only (`${port}/tcp`), but the geth fork shares `--port` for TCP+UDP and ELA uses UDP
  discovery → on a default-deny UFW host, discovery is silently dropped (the exact "0 peers"
  symptom this module was meant to fix, half-fixed). **Fix:** open `/udp` for P2P/discovery ports too.
- **P0-16 — System preflight thresholds mis-tuned + not env-overridable.** `EnmSystemCheck`: 1 TB
  council disk floor false-blocks capable 500GB VPS hosts; the only override is a blunt global
  `ENM_DEV_RELAX_SYSCHECK` that over-relaxes everything (and warns "NOT FOR PRODUCTION"). No
  per-value env override → forces in-place code patches (the documented pain point). Disk check
  also ignores the actual selected-chain footprint. **Fix:** per-value env overrides with strict
  defaults; compute required disk from selected chains' download+extract sizes.

---

## P1 — serious reliability risks (fix before/with scale)

- **P1-1** setup.js install state is in-memory only → ENM restart mid-install (likely during a
  ~1hr snapshot) strands the operator with no resume signal (steps ARE idempotent, but nothing
  re-triggers). Also `/install-council` returns 202 *before* the running-check → double-submit
  clobbers in-flight state. **Fix:** persist job state + auto-resume on boot; 409 on concurrent.
- **P1-2** Oracle has no parent-RPC readiness wait (`OracleAdapter.start`) → spawns before parent
  geth RPC is up, stays **alive-but-orphaned** (Express keeps listening), F1 never fires, F24
  references a restart-hook that doesn't exist → silently relays nothing until manual restart.
  **Fix:** port the arbiter's `_waitForMainchainRpc` pattern (wait for parent `eth_blockNumber`).
- **P1-3** `HealthChecker._fetchRpcSummary` (medium tick) RPC-probes every chain with ELA-only verbs
  → height/peers/sync never tracked for class B/C (sparkline/ETA/peer-stall detection dead). C19
  half-fix. **Fix:** class-aware summary via adapter methods.
- **P1-4** No `uncaughtException`/`unhandledRejection` handler in server.js → one stray throw crashes
  the whole sidecar, skips markAllManualStop → F1 self-heal storm on next boot. **Fix:** add
  handlers that flush (onShutdown) then exit non-zero.
- **P1-5** SelfHealingEngine restart budget is in-memory → resets every ENM restart, so a
  deep-broken chain on a flapping host restart-loops far more than 3/10min, masking escalation.
  **Fix:** persist budget in sqlite.
- **P1-6** `encryption.key` is never backed up, but every keystore/RPC password is encrypted with it.
  Migrate config+backups to a new host (or lose the volume) → all passwords permanently
  undecryptable (BPoS can't unlock, EVM can't mine). **Fix:** include `encryption.key` in the
  keystore backup bundle + boot warning if envelopes exist without the key.
- **P1-7** EVM mining keystore (`data/keystore/UTC--*`) is NOT backed up before chain-resync, and the
  resync wipe-list is mainchain-only (so EVM resync silently no-ops today; the "obvious fix" of
  adding `data/` would delete the mining identity). **Fix:** class-specific resync that preserves
  `data/keystore/` + backs it up first.
- **P1-8** EnmBinaryDownloader: no retry on transient failure, no disk preflight (binary path), no
  `cancel()` (route calls it but it's unimplemented → hung download locks the chain in DOWNLOADING).
- **P1-9** config.js: IPv6 whitelist entry passes the route schema but fails the config schema → 500
  on save; enabling RPC accepts `0.0.0.0/0` with no "password must exist" guard; disabling RPC
  closes UFW but doesn't stop the running ela RPC (toggle reads "off" but isn't until restart).
- **P1-10** SseHub: no cap on concurrent connections (per-wallet or global) + no write backpressure
  → a tab-reload storm / many dashboards / one slow client → unbounded handlers + socket buffers →
  memory/FD exhaustion. **Fix:** cap connections (503 over limit); drop slow clients by
  `res.writableLength`.
- **P1-11** OwnerCheckMiddleware caches the pc2.db handle forever → if pc2-node replaces/rotates the
  DB, every operator gets 401'd until ENM restarts (node-wide auth outage); `sessionCache` Map is
  unbounded (token spray / rotation → memory leak). **Fix:** reopen DB on SQLITE error; cap/prune cache.
- **P1-12** NodeJsRuntime: no integrity/retry on the Node tarball download; oracle `binaryPath` is a
  stale install-time snapshot (host node upgrade/removal → oracle won't start, no self-heal);
  depends on `which` being installed. **Fix:** verify SHA + retry; re-resolve node at start.
- **P1-13** identity.js: `getProducerState()` returns null on RPC failure → destructive keystore
  import/reset proceeds with no warning even for an Active producer (rewards loss). **Fix:**
  distinguish "confirmed not-registered" from "couldn't determine"; require force on indeterminate.
- **P1-14** chains.js TOCTOU on `/update`, `/bootstrap`, `runChainRollback`: check `alive` then
  destructive disk op outside any lock → a concurrent start/auto-heal corrupts the data dir.
  **Fix:** wrap in `withChainLock`.
- **P1-15** ExtIpResolver: single endpoint `checkip.amazonaws.com` with no fallback → fleet-wide SPOF;
  IPv4-only (IPv6-only host gets no advertised IP); no private/CGNAT rejection. **Fix:** multi-endpoint
  rotation (pattern already exists in ClockSkewChecker); reject RFC1918/loopback.
- **P1-16** Mainchain stdin password feed (`ElaMainChainAdapter.js:278`): written + `stdin.end()`
  immediately after spawn with no readiness handshake — works by pipe-buffering luck; a slow host or
  future ela build that reads stdin differently → BPoS unlock hangs after ENM already returned success.
- **P1-17** Oracle config-patch regex hardcodes `127.0.0.1` + quoted port; an upstream format drift
  makes the patch silently no-op (warn only) → oracle relays to the wrong/stale port. **Fix:** broaden
  regex + assert match-count → hard error / health flag, not warn-and-continue.
- **P1-18** EnmRpcClient buffers the entire RPC response unbounded → a misbehaving/HTML RPC response
  is a memory-amplification vector. **Fix:** cap accumulated bytes, destroy past limit.
- **P1-19** BPoS activate doesn't verify the producer is actually `Inactive` before sending the tx
  (burns a fee on a no-op/rejected tx) + no concurrency lock on the build/send temp files.
- **P1-20** EnmDb has no `busy_timeout` → WAL checkpoint vs the 10k-row audit-cleanup DELETE can throw
  `SQLITE_BUSY` to a route/health tick. **Fix:** `pragma busy_timeout=5000`.
- **P1-21** Audit log + proposal rows have no absolute cap; `retentionDays=0` (a valid setting)
  disables pruning entirely → unbounded disk growth over months.
- **P1-22** keystore password passed as `-p <password>` argv to ela-cli (visible in `ps`/`/proc` on a
  shared host) — the geth path already does the safe stdin/file pattern. **Fix:** stdin or 0600 file.
- **P1-23** EnmBootstrapDownloader apply is non-atomic: `.bak` deleted before VERIFYING; a kill between
  the two renames leaves the chain with NO datadir; `cleanupOrphans` wipes the extracted source on
  every boot. **Fix:** keep `.bak` until verify passes; restore orphaned `.bak` with missing `data/`.
- **P1-24** Start-time conflict scan omits `chainPorts` for sidechains (only mainchain ports checked) →
  a stale/rogue bind on a sidechain port surfaces as a cryptic exit, not an attributed conflict.
- **P1-25** Non-UFW hosts (firewalld/iptables) get NO firewall management + a silent start-time skip →
  0 inbound peers on default-deny non-Debian hosts (compounds with P0-10/P0-15).
- **P1-26** ClockSkewChecker trusts a single HTTP `Date` with no sanity bound → captive portal / bad
  intermediary reports false "clock OK" or a poisoned skew. **Fix:** require ≥2 endpoints to agree;
  reject absurd skews.

---

## P2 — hardening (worth doing, not blocking)

PID-reuse recheck before SIGKILL escalation (NativeProcessService:804); `restart()` hardcodes
SIGTERM for geth (should be SIGINT for clean leveldb); autostart starts oracles after ALL class-B
(not right after their parent); no re-entrancy guard on the 3 health ticks (overlap under slow
RPC); F9 emits N duplicate proposals for one config error; F10 fragile (only safe by schema
accident — add mainchain-only guard); server binds 0.0.0.0 (consider 127.0.0.1 behind pc2-node);
ChainRegistry has no de-registration path; PBFT/EVM password files left on disk post-start; file
mode not enforced on pre-existing secret files; LogCompactor accepts `0`-day retention (deletes
recent logs); StorageMaintenance `.stop()` never called on shutdown; resolved proposals never
pruned; CouncilOverviewService does sync `readFileSync` per chain per 5s tick; CLEAR_LEVELDB_LOCK
path is mainchain-only (wrong/blind for EVM `chaindata/LOCK`); EnmIntegrityChecker is passive
(measures, never repairs — wire missing-binary `fail` into redownload); integrity baseline is
mainchain-only + goes stale (false FAIL) after every legitimate `/update`; ChainState `_versionCache`
+ `_locate` recursive walk on every snapshot() (hot path); EVM `_findExistingEvmKeystoreAddress`
picks lexically-first UTC file; `?refresh=1` update poll is read-auth not owner; HealthChecker/
SelfHealing per-chain Maps never deleted on (future) chain removal.

---

## Systemic themes

1. **Class-blindness (C19 family):** ELA RPC verbs assumed for all chains keeps recurring
   (`Diagnostics`, `HealthChecker._fetchRpcSummary`). Route ALL health/diagnose/status RPC through
   the already-class-correct `adapter.health()`/`primaryHeight()`; never hardcode `getblockcount`.
2. **No-lock read-modify-write:** ConfigStore (P0-7) and several maintenance/auto-fix ops mutate
   shared state without `withChainLock` / a config mutex → races + lost updates at scale.
3. **Durability of writes:** atomicWrite lacks fsync (P0-9); snapshot/bootstrap apply isn't atomic
   (P0-11, P1-23). Power-loss / interrupt → corruption + manual cleanup.
4. **Quarantine = dead end (P0-2):** the single biggest barrier to "unattended at scale" — a
   transient fault permanently downs a chain until a human confirms.
5. **Supply-chain / integrity (P0-13):** zero artifact verification + open redirects = root RCE risk.
6. **Host diversity (P0-10, P0-15, P0-16, P1-25):** Debian-only assumptions + TCP-only firewall +
   mis-tuned thresholds will reject or under-serve a large fraction of "hundreds of operators."
