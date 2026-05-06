# Runtime Heartbeat Protocol (`pc2.heartbeat.v1`)

**Status**: stable since `pc2-node` v1.2.7.13 (2026-05-06)
**Audience**: launcher / supervisor authors who need a reliable "is pc2-node alive?" signal that survives respawns and out-of-band restarts.

---

## TL;DR

1. `pc2-node` writes `<pc2NodeDir>/data/runtime/heartbeat.json` every **2 s**.
2. To know whether `pc2-node` is alive, **poll that file** instead of tracking the child PID.
3. To **trigger** a clean restart, write `<pc2NodeDir>/data/runtime/restart-requested.flag` (any contents) — `pc2-node` will respawn itself within ~3 s.

---

## Why this exists

The `ElastOS Launcher` (Electron) currently tracks `pc2-node` by holding onto the PID of the child process it spawned. That assumption breaks in four legitimate scenarios:

| # | Trigger | What happens | Result before v1.2.7.13 |
|---|---|---|---|
| 1 | macOS in-app update (`UpdateService.performUpdate()` → `spawnDetachedRespawn`) | Original child exits, detached grandchild starts a new pc2-node | Launcher's tracked PID is dead → status indicator stuck on "Stopped" |
| 2 | macOS manual restart (`POST /api/system/restart` → `spawnDetachedRespawn`) | Same as above | Same |
| 3 | Linux/Jetson terminal `pm2 restart pc2` (or `scripts/update.sh`) | New PID the launcher never saw | Same |
| 4 | Crash + supervisor (pm2 / systemd / launcher's own auto-restart) | Same | Same |

The heartbeat decouples the launcher from the `pc2-node` process lifecycle: any path can trigger a clean restart, and the launcher always knows the current truth without having to track PIDs.

---

## File locations

Both files live in `<pc2NodeDir>/data/runtime/`. `<pc2NodeDir>` is the directory where `pc2-node`'s `dist/index.js` runs; the launcher launches it with `cwd = ~/.pc2/pc2-node/` (or the development equivalent).

| Path | Direction | Owner |
|---|---|---|
| `<pc2NodeDir>/data/runtime/heartbeat.json` | `pc2-node` → launcher (read-only by launcher) | `pc2-node` |
| `<pc2NodeDir>/data/runtime/restart-requested.flag` | launcher / update.sh / external supervisor → `pc2-node` (read-only by writer once consumed) | anyone with write access; `pc2-node` consumes + deletes |

The `runtime/` directory is created on first heartbeat write if it doesn't exist (mode `0755`).

The data directory follows `<pc2NodeDir>/data` from `config/config.json`'s `storage.database_path` (`./data/pc2.db` relative to `cwd`). If the operator overrides `DB_PATH` via env var, the `runtime/` directory follows wherever the database file lands. The launcher should derive the heartbeat path the same way to stay consistent.

---

## `heartbeat.json` schema (`pc2.heartbeat.v1`)

```jsonc
{
  "schema": "pc2.heartbeat.v1",
  "pid": 12345,
  "version": "1.2.7.13",
  "port": 4200,
  "healthy": true,
  "startedAt": "2026-05-06T03:14:15.926Z",
  "lastUpdated": "2026-05-06T03:14:17.928Z",
  "lastRestartReason": "flag-trigger:post-update"
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | string literal `"pc2.heartbeat.v1"` | Protocol version. **Refuse to interpret any other value** rather than guessing field meanings. Bump major when fields are removed/renamed; we'll bump the schema string in lockstep. |
| `pid` | number | OS process id of the running `pc2-node`. Use this to display "Running (pid=N)" in the launcher UI. |
| `version` | string | Semver of the running `pc2-node` (mirrors `pc2-node/package.json`). May differ from `<pc2NodeDir>/package.json` immediately after `git reset --hard` but before the new `pc2-node` has started — the heartbeat is the source of truth for **what's running in memory**. |
| `port` | number | TCP port `pc2-node` is bound to. Default `4200`; the launcher should iframe / proxy this. |
| `healthy` | boolean | `true` once `pc2-node` has finished startup and is serving requests; `false` during graceful shutdown. |
| `startedAt` | ISO-8601 string | When this `pc2-node` process started. Useful for displaying uptime and detecting respawns (a fresh `startedAt` after a restart trigger means the respawn worked). |
| `lastUpdated` | ISO-8601 string | When this snapshot was written. **Liveness is determined by this field, not `mtime`** — clock skew between filesystems can confuse `mtime`-based detection. |
| `lastRestartReason` | string \| undefined | Set when `pc2-node` is exiting because of a restart trigger. Tags: `flag-trigger:<reason-from-flag-file>`, `post-update`, `manual-restart`, `startup-flag`. |

---

## Liveness rules

The launcher's status determination should be:

| Condition | Status |
|---|---|
| File missing | `not-running` (clean exit or never started) |
| File exists but `lastUpdated` is more than **5 s** old (3 missed heartbeats at 2 s interval) | `stale` (likely crashed without graceful shutdown) |
| File exists, fresh, `healthy: false` | `shutting-down` |
| File exists, fresh, `healthy: true` | `running` |

Recommended polling interval: **1 s** (twice the write interval gives a deterministic upper bound on staleness detection without burning CPU).

The 5 s staleness window is deliberately conservative — `pc2-node`'s heartbeat write is best-effort (disk-full or permission errors are logged at debug level, not failed loudly), so a single missed write is normal. Three in a row is a real signal.

`pc2-node` removes `heartbeat.json` on **clean** shutdown (SIGTERM/SIGINT graceful path), so "file missing" is a clear "stopped intentionally". On crash or kill -9, the file goes stale rather than being removed.

---

## Triggering a clean restart

To restart `pc2-node` from anywhere with write access to `<pc2NodeDir>/data/runtime/`:

```bash
echo "reason: my-trigger-tag" > "<pc2NodeDir>/data/runtime/restart-requested.flag"
```

Within ~5 s (worst-case poll interval):

1. `pc2-node`'s `RuntimeHeartbeat` flag watcher fires (via `fs.watch` or the 5 s polling fallback).
2. `pc2-node` parses an optional `reason: <tag>` line from the flag content; this becomes `lastRestartReason` for traceability.
3. `pc2-node` writes one final heartbeat with `healthy: false` and the reason.
4. `pc2-node` deletes the flag file (so the new `pc2-node` doesn't see a stale flag and respawn-loop).
5. `pc2-node` calls `spawnDetachedRespawn` (a 3-second-delayed grandchild), then exits cleanly.
6. The grandchild starts a fresh `pc2-node` from the current `dist/index.js`.
7. The new `pc2-node` writes a fresh heartbeat with the new PID + `version` within ~2 s.

The flag file is **opaque** apart from the optional `reason:` line — anything else in it is informational. An empty flag file is fine; the resulting `lastRestartReason` is just `flag-trigger:<source>` (where source is `fs-watch`, `poll`, or `startup-flag`).

### Edge case: flag at startup

If the flag file is already present when `pc2-node` starts (e.g. a script wrote it before `pc2-node` had finished booting from the previous restart), `pc2-node` consumes it during `RuntimeHeartbeat.start()` rather than waiting for `fs.watch` to fire (the watcher only sees future mutations). The reason gets tagged `flag-trigger:startup-flag`.

### Edge case: simultaneous flag write + heartbeat write race

Idempotent via an in-memory `restartInProgress` guard. If both the `fs.watch` callback and the 5 s poll fall on the flag at the same time, only the first wins; the second is a no-op.

---

## Launcher integration recipe (TypeScript)

A minimal poller looks like this. (Drop-in for `elastos-launcher/src/main/pc2Heartbeat.ts`.)

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

interface HeartbeatPayload {
  schema: 'pc2.heartbeat.v1';
  pid: number;
  version: string;
  port: number;
  healthy: boolean;
  startedAt: string;
  lastUpdated: string;
  lastRestartReason?: string;
}

export type HeartbeatState =
  | { kind: 'not-running' }
  | { kind: 'stale'; lastSeen: HeartbeatPayload }
  | { kind: 'shutting-down'; payload: HeartbeatPayload }
  | { kind: 'running'; payload: HeartbeatPayload };

const STALE_AFTER_MS = 5_000;

export class HeartbeatPoller {
  private readonly heartbeatPath: string;
  private readonly restartFlagPath: string;
  private timer: NodeJS.Timeout | null = null;
  private lastState: HeartbeatState['kind'] | null = null;

  constructor(
    pc2NodeDir: string,
    private readonly onStateChange: (state: HeartbeatState) => void,
    private readonly intervalMs = 1_000,
  ) {
    const runtimeDir = join(pc2NodeDir, 'data', 'runtime');
    this.heartbeatPath = join(runtimeDir, 'heartbeat.json');
    this.restartFlagPath = join(runtimeDir, 'restart-requested.flag');
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Write the restart flag. Resolves after pc2-node has consumed it (heartbeat shows shutting-down). */
  async requestRestart(reason: string, timeoutMs = 10_000): Promise<void> {
    const dir = dirname(this.restartFlagPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.restartFlagPath, `reason: ${reason}\n`, { mode: 0o644 });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.readState();
      if (state.kind === 'shutting-down' || state.kind === 'not-running') return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`pc2-node did not acknowledge restart flag within ${timeoutMs}ms`);
  }

  private poll(): void {
    const state = this.readState();
    if (state.kind !== this.lastState) {
      this.lastState = state.kind;
      this.onStateChange(state);
    }
  }

  private readState(): HeartbeatState {
    if (!existsSync(this.heartbeatPath)) return { kind: 'not-running' };
    let payload: HeartbeatPayload;
    try {
      const raw = readFileSync(this.heartbeatPath, 'utf-8');
      payload = JSON.parse(raw);
      if (payload.schema !== 'pc2.heartbeat.v1') return { kind: 'not-running' };
    } catch {
      return { kind: 'not-running' };
    }
    const ageMs = Date.now() - new Date(payload.lastUpdated).getTime();
    if (ageMs > STALE_AFTER_MS) return { kind: 'stale', lastSeen: payload };
    if (!payload.healthy) return { kind: 'shutting-down', payload };
    return { kind: 'running', payload };
  }
}
```

### Wiring it into `pc2Manager.ts`

```ts
let heartbeatPoller: HeartbeatPoller | null = null;

export function startHeartbeatPolling(): void {
  if (heartbeatPoller) return;
  heartbeatPoller = new HeartbeatPoller(getPC2NodeDir(), (state) => {
    switch (state.kind) {
      case 'running':       emitStatus('running'); break;
      case 'shutting-down': emitStatus('stopping'); break;
      case 'stale':         emitStatus('error'); break;
      case 'not-running':   emitStatus('stopped'); break;
    }
  });
  heartbeatPoller.start();
}
```

In `pc2Process.on('exit', ...)` — the existing handler that immediately sets `'stopped'` — defer for ~6 s before declaring stopped. If a heartbeat appears in that window with a fresh `startedAt`, it's a respawn and the poller will pick it up:

```ts
pc2Process.on('exit', (code, signal) => {
  // v1.2.7.13: a respawn (in-app update / manual restart / spawnDetachedRespawn)
  // exits the original child, but a fresh pc2-node lands within ~3 s and starts
  // emitting heartbeats. Don't declare 'stopped' immediately — the heartbeat
  // poller will catch the new process if it shows up.
  pc2Process = null;
  setTimeout(() => {
    if (heartbeatPoller && heartbeatPoller.getLastState()?.kind === 'running') return;
    emitStatus('stopped');
  }, 6000);
});
```

(`getLastState()` is a small accessor you'd add to `HeartbeatPoller` — left out of the snippet above for brevity.)

### Replacing the `/health` polling in `getStatus()`

```ts
export async function getStatus(): Promise<PC2Status> {
  if (!await isInstalled()) return 'not-installed';
  const state = heartbeatPoller?.getLastState();
  if (state) {
    if (state.kind === 'running')        return 'running';
    if (state.kind === 'shutting-down')  return 'stopping';
    if (state.kind === 'stale')          return 'error';
    if (state.kind === 'not-running' && pc2Process && !pc2Process.killed) return 'starting';
    return 'stopped';
  }
  // Fallback for older pc2-node (pre-v1.2.7.13) that doesn't write heartbeats.
  // ... existing /health polling code unchanged ...
}
```

The `/health` fallback handles operators on `pc2-node` v1.2.7.12 or earlier — they keep the old behaviour until they update. No coordinated rollout required.

---

## Backward compatibility

The protocol is **strictly additive** for the launcher: an older launcher that doesn't know about heartbeats keeps working exactly as before (it just doesn't benefit from the desync fix). A newer launcher running against an older `pc2-node` (no heartbeat) falls through to the existing `/health` polling.

Schema stability: any future field additions stay under `schema: "pc2.heartbeat.v1"` with optional fields. A breaking change (field removal/rename) bumps to `pc2.heartbeat.v2`, and the launcher can negotiate by checking the schema string.

---

## Operational notes

- **Multiple pc2-node instances on one machine**: each instance must have a different `<pc2NodeDir>` (otherwise their heartbeats overwrite each other and one wins arbitrarily). The launcher today only runs one instance, but if a developer also runs `npm run dev` from `~/pc2.net/pc2-node` while the launcher's `~/.pc2/pc2-node` is up, the heartbeats are independent because their `data/runtime/` paths differ.

- **Disk-full / read-only filesystem**: heartbeat writes fail silently at `debug` level. The launcher will see the file go stale within 5 s and report `error`. The flag mechanism still works as long as `unlink` works.

- **Permissions**: heartbeat is written `mode 0644`, runtime dir `mode 0755`. The launcher reads as the same user (the one who owns `~/.pc2`). No sudo, no setuid.

- **Testing the protocol**: 
  - Trigger a respawn manually: `echo > ~/.pc2/pc2-node/data/runtime/restart-requested.flag` and watch the heartbeat — `lastRestartReason` should change, then `startedAt` should jump to a fresh timestamp ~3 s later.
  - Simulate a crash: `kill -9 $(jq -r .pid ~/.pc2/pc2-node/data/runtime/heartbeat.json)` — the file goes stale within 5 s, the launcher should report `error`.

---

## See also

- `pc2-node/src/utils/runtime-heartbeat.ts` — the `RuntimeHeartbeat` implementation.
- `pc2-node/src/utils/respawner.ts` — the `spawnDetachedRespawn` helper that the heartbeat invokes on flag triggers.
- `pc2-node/src/services/UpdateService.ts` — the in-app updater that already calls `spawnDetachedRespawn` directly on macOS (heartbeat covers its handoff to the launcher).
- `pc2-node/src/api/system.ts` — the `POST /api/system/restart` endpoint that does the same.
