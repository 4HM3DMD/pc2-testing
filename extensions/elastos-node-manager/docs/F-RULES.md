# F1-F18 traceability matrix

Each rule has: detection logic, action tier, location in the codebase, and the test ID(s) covering it.

| ID | Symptom | Detection | Tier | Action | Code | Test |
|----|---------|-----------|------|--------|------|------|
| F1 | Process exited unexpectedly | `processStatus.alive=false` AND `lastExit.code !== 0` (or signal) AND not `manualStop` | AUTOMATED-SAFE | Restart (max 3× per 10 min, then escalate to OWNER-CONFIRMS) | [HealthRules.js:detectF1](../lib/HealthRules.js); fast-tick branch in [HealthChecker.js](../lib/HealthChecker.js); [SelfHealingEngine.js:_applyAutomatedSafe](../lib/SelfHealingEngine.js) | `tests/HealthRules.test.mjs` describe `detectF1` (5 cases); `tests/SelfHealingEngine.test.mjs` (auto-restart path) |
| F2 | RPC unreachable >2 min | `rpcSummary.ok=false` AND `firstRpcDownAt` older than `RPC_UNREACHABLE_GRACE_MS=120000` | AUTOMATED-SAFE | Restart | `lib/HealthRules.js:detectF2` | `tests/HealthRules.test.mjs` describe `detectF2` (3 cases) |
| F3 | Peer count 0 >5 min | `rpcSummary.peers===0` AND `firstPeerZeroAt` older than `PEER_ZERO_GRACE_MS=300000` | AUTOMATED-SAFE | Restart (reseeds DNS peers) | `lib/HealthRules.js:detectF3` | `tests/HealthRules.test.mjs` describe `detectF3` (2 cases) |
| F4 | Sync stalled >10 min | `lastHeight===rpcSummary.height` for `HEIGHT_STALL_GRACE_MS=600000` AND peers>0 | OWNER-CONFIRMS | Restart proposal | `lib/HealthRules.js:detectF4` | `tests/HealthRules.test.mjs` describe `detectF4` (2 cases) |
| F5 | Disk free low | `diskInfo.freeGb < 5` (CRITICAL) or `< 20` (WARNING) | OWNER-CONFIRMS | Suggest archive prune / volume migration (no auto-delete) | `lib/HealthRules.js:detectF5` | `tests/HealthRules.test.mjs` describe `detectF5` (3 cases) |
| F6 | Process killed by OOM | `processExit.signal==='SIGKILL'` AND not manual | OWNER-CONFIRMS | Suggest memory limit raise | `lib/HealthRules.js:detectF6` | `tests/HealthRules.test.mjs` describe `detectF6` (2 cases) |
| F7 | Port conflict on start | `ports.conflicting.length > 0` (populated by chains/start route via PortManager) | OWNER-CONFIRMS | Suggest port reassignment | `lib/HealthRules.js:detectF7` | `tests/HealthRules.test.mjs` describe `detectF7` (2 cases) |
| F8 | Binary version drift | `chainConfig.binaryVersion !== ruleState.lastBinaryVersion` (after smokeTest) | OWNER-CONFIRMS | Confirm to update recorded version | `lib/HealthRules.js:detectF8` | `tests/HealthRules.test.mjs` describe `detectF8` (3 cases) |
| F9 | Config validation failed | `configValidation.ok=false` (joi error) | OWNER-CONFIRMS | Offer rollback to `.bak` | `lib/HealthRules.js:detectF9` | `tests/HealthRules.test.mjs` describe `detectF9` (2 cases) |
| F10 | RPC password unset | `chainConfig.rpc.passwordEncrypted` empty | OWNER-CONFIRMS | Open Settings → Mainchain Advanced | `lib/HealthRules.js:detectF10` | `tests/HealthRules.test.mjs` describe `detectF10` (2 cases) |
| F11 | BPoS arbiter rotation stuck | `getarbitratorgroupbyheight(H)` and `(H-1)` both return same `ondutyarbitratorindex` AND on-duty slot is empty string | CRITICAL-NOTIFY | Notify; manual investigation (no auto-action) | `lib/HealthRules.js:detectF11`; comparison logic in [HealthChecker.js:_fetchBposState](../lib/HealthChecker.js) | `tests/HealthRules.test.mjs` describe `detectF11` (3 cases) |
| F12 | BPoS producer Inactive (rounds approaching cap) | `producer.state==='Inactive'` AND `inactiveRounds >= 720` (WARN) or `>= 1300` (CRITICAL) | NEVER-AUTOMATIC | Notify; operator runs ActivateProducer via ela-cli within 6-block window. Canceled/Returned/Illegal states intentionally silent. | `lib/HealthRules.js:detectF12` | `tests/HealthRules.test.mjs` describe `detectF12` (4 cases) |
| F13 | Host clock skew >2s | `ClockSkewChecker.check()` returns `\|skewMs\| > 2000` | OWNER-CONFIRMS (WARNING) | Suggest `chronyc` / `ntpdate` (host action) — fail-soft on no internet | `lib/HealthRules.js:detectF13`; `lib/ClockSkewChecker.js` | `tests/HealthRules.test.mjs` describe `detectF13` (3 cases); `tests/ClockSkewChecker.test.mjs` (6 cases) |
| F14 | Docker daemon unreachable | **DROPPED in Rev 9** — Ubuntu native binaries, no Docker runtime | n/a | n/a | n/a | n/a |
| F15 | Audit DB corruption | **DEFERRED to v0.2** — PC2's better-sqlite3 surface gives us PRAGMA integrity_check but no built-in handler | n/a | v0.2 work item | n/a | n/a |
| F16 | No peers >10 min (after F3 restart didn't help) | `rpcSummary.peers===0` AND `firstPeerZeroAt` older than `PEER_ZERO_FALLBACK_MS=600000` | CRITICAL-NOTIFY | Suggest fallback peer config (foundation/community nodes) — no auto-restart | `lib/HealthRules.js:detectF16` | `tests/HealthRules.test.mjs` describe `detectF16` (2 cases) |
| F17 | Image-pull failure | **DROPPED in Rev 9** — operator pre-builds binary, no pull pipeline | n/a | n/a | n/a | n/a |
| F18 | No inbound peers >5 min (BPoS only) | `outboundCount > 0` AND `inboundCount===0` AND `firstNoInboundAt` older than `NO_INBOUND_GRACE_MS=300000` AND `dpos.enableArbiter=true` | CRITICAL-NOTIFY | NAT/UPnP guidance for ports 20338+20339 | `lib/HealthRules.js:detectF18` | `tests/HealthRules.test.mjs` describe `detectF18` (3 cases) |
| F19 | Host conflict (legacy node.sh, rogue ela process, port already bound, systemd unit, stale data) | `HostConflictScanner.scan()` returns at least one CRITICAL entry — checked at setup-time, on every chain start/restart, AND every slow tick | CRITICAL-NOTIFY | Conflict-card UI lists each item with a step-by-step shell remediation (`kill <pid>`, `mv ~/.config/elastos`, etc.). `?force=1` query param overrides. | `lib/HostConflictScanner.js`; `lib/HealthRules.js:detectF19`; `routes/chains.js` start/restart gate; `routes/setup.js:/setup/conflicts` | `tests/HostConflictScanner.test.mjs` (10 cases covering rogue process, port bind, stale PID, F19 detection) |

## Tier semantics

| Tier | Action | Audit decision values |
|------|--------|----------------------|
| **AUTOMATED-SAFE** | Engine acts immediately under `withChainLock`; restart-budget caps at 3 attempts per 10 min before escalating | `proposed` → `executed` / `failed` |
| **OWNER-CONFIRMS** | Engine creates `enm_proposals` row + emits SSE notification scoped to owner wallet; operator approves via `/api/healing/confirm/:id` | `proposed` → `confirmed` → `executed` / `failed` (or `rejected` / `expired`) |
| **CRITICAL-NOTIFY** | Engine emits SSE notification only; no proposal flow because there's no auto-recoverable action | `manual-only` |
| **NEVER-AUTOMATIC** | Same as CRITICAL-NOTIFY but explicitly NEVER acts (e.g., F12 needs the operator's signing key) | `manual-only` |
| **HTTP-MUTATION** | Synthetic tier for the per-route audit middleware; not produced by the healing engine | `executed` / `failed` |

## Coverage summary

- 17 of 19 rules implemented (F14 + F17 dropped per Rev 9; F15 deferred to v0.2; F19 added in v0.1.0-alpha.2 for host-conflict detection)
- 60+ unit tests across `tests/HealthRules.test.mjs`, `tests/SelfHealingEngine.test.mjs`, and `tests/HostConflictScanner.test.mjs`
- All AUTOMATED-SAFE rules covered by `tests/SelfHealingEngine.test.mjs` end-to-end
- ClockSkewChecker network-mock tests in `tests/ClockSkewChecker.test.mjs`
- HostConflictScanner exercised against rogue-process, port-binding, and stale-PID scenarios

## Host conflict catalog (F19)

| Type | Severity | Detection | Default remediation surface |
|------|----------|-----------|------------------------------|
| `LEGACY_CONFIG`     | WARNING  | `~/.config/elastos` or `/root/.config/elastos` exists with `config.json` / `keystore.dat` / `ela.txt` | Banner; `mv ~/.config/elastos ~/.config/elastos.legacy` |
| `ROGUE_PROCESS`     | CRITICAL | `pgrep -af` finds an `ela` basename PID not owned by ENM | Blocks chain start; `kill <pid>` |
| `PORT_BOUND`        | CRITICAL | `ss -tlnH sport = :<port>` (Linux) or `lsof -iTCP -i:<port>` (macOS) returns a listener for any of 20336/20338/20333/20334/20335/20339 | Blocks chain start; suggests Settings → Mainchain Advanced |
| `SYSTEMD_UNIT`      | WARNING  | `systemctl is-enabled <name>.service` returns `enabled` or `static` for any of `node`, `ela`, `elastos`, `elamain` | Banner; `sudo systemctl disable --now <name>` |
| `STALE_DATA`        | INFO     | `~/elastos`, `~/.config/elastos/data`, or `/root/elastos` contains a leveldb `CURRENT` file or `data/` subdir | Info card; suggests pointing `dataDir` at it or archiving |
| `PERMISSION_DENIED` | CRITICAL | `fs.access(enmDataDir, W_OK \| X_OK)` throws | Blocks chain start; `sudo chown -R $(id -u):$(id -g) <dir>` |
| `STALE_PID_FILE`    | WARNING  | PID file in `runDir/` references a dead PID or contains malformed bytes | Banner; `rm <pidfile>` (next start cleans automatically) |
