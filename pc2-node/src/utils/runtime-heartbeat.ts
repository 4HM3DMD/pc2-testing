/**
 * Runtime Heartbeat — single source of truth for "is pc2-node alive?".
 *
 * Why this exists (v1.2.7.13):
 *
 * The ElastOS Launcher (Electron app) currently tracks pc2-node by holding
 * onto the PID of the child process it spawned. This breaks in several
 * legitimate scenarios:
 *
 *   1. v1.2.7.6's `spawnDetachedRespawn` (in-app update + manual /api/system/
 *      restart on macOS) detaches a grandchild that the launcher cannot
 *      track. After the respawn, pc2-node is healthy on port 4200, but the
 *      launcher's status indicator is stuck on "Stopped" — clicking Start
 *      then collides on the bound port.
 *
 *   2. Terminal-based `update.sh` (or any other out-of-band restart, e.g.
 *      `pm2 restart pc2`) bypasses the launcher entirely. Same desync.
 *
 *   3. Crash + auto-restart by an external supervisor (pm2, systemd) gives
 *      pc2-node a new PID the launcher never saw. Same desync.
 *
 * Fix: pc2-node writes a heartbeat file every 2s containing { pid, version,
 * port, healthy, startedAt, lastUpdated }. The launcher polls this file as
 * its single source of truth instead of tracking the child PID. Stale
 * (>5s old) or missing → stopped. Fresh → running, with the current PID
 * and version surfaced in the launcher UI.
 *
 * Companion mechanism: pc2-node also watches for a `restart-requested.flag`
 * file in the same dir. When it appears (written by update.sh, the in-app
 * updater, or anyone else with write access), pc2-node calls
 * spawnDetachedRespawn, removes the flag, and exits cleanly. The detached
 * grandchild starts a fresh pc2-node with new code; the launcher sees the
 * heartbeat update with the new PID + version and stays in sync.
 *
 * Together these decouple the launcher from the pc2-node process lifecycle:
 * any path can trigger a clean restart, and the launcher always knows the
 * current truth without having to track PIDs.
 *
 * The heartbeat file format is documented in
 * docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md so the launcher repo
 * (which is separate from pc2.net) can integrate without ambiguity.
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync, watch, type FSWatcher } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { spawnDetachedRespawn } from './respawner.js';

const HEARTBEAT_NAME = 'heartbeat.json';
const RESTART_FLAG_NAME = 'restart-requested.flag';
const HEARTBEAT_INTERVAL_MS = 2000;

/**
 * Schema written to <dataDir>/runtime/heartbeat.json.
 *
 * Versioned via `schema` so the launcher can refuse to interpret formats
 * it doesn't understand (rather than guessing field meanings).
 */
export interface HeartbeatPayload {
  /** Schema identifier — bump major when fields are removed/renamed. */
  schema: 'pc2.heartbeat.v1';
  /** OS process id of the running pc2-node. */
  pid: number;
  /** Semver of the running pc2-node (mirrors package.json). */
  version: string;
  /** TCP port pc2-node is bound to (the launcher proxies / iframes this). */
  port: number;
  /** True iff pc2-node has finished startup and is serving requests. */
  healthy: boolean;
  /** ISO-8601 timestamp of when this pc2-node process started. */
  startedAt: string;
  /** ISO-8601 timestamp of the last heartbeat write. >5s stale = dead. */
  lastUpdated: string;
  /** Reason for the last restart, if any (e.g. 'post-update', 'flag-trigger'). */
  lastRestartReason?: string;
}

export interface RuntimeHeartbeatOptions {
  /** Base data dir (typically <homedir>/.pc2/pc2-node/data); we create runtime/ inside it. */
  dataDir: string;
  /** Current running version (read from package.json; fed in to avoid duplicating the lookup). */
  version: string;
  /** TCP port pc2-node is bound to. */
  port: number;
  /** Override interval for tests; default 2000 ms. */
  intervalMs?: number;
}

export class RuntimeHeartbeat {
  private readonly runtimeDir: string;
  private readonly heartbeatPath: string;
  private readonly restartFlagPath: string;
  private readonly version: string;
  private readonly port: number;
  private readonly intervalMs: number;
  private readonly startedAt: string;

  private healthy = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private flagWatcher: FSWatcher | null = null;
  /**
   * Polling fallback for the flag watcher. fs.watch is unreliable on
   * macOS for files inside a freshly-created dir (events get dropped),
   * so we belt-and-braces with a low-frequency stat check.
   */
  private flagPollTimer: NodeJS.Timeout | null = null;
  private restartInProgress = false;
  private lastRestartReason?: string;

  constructor(opts: RuntimeHeartbeatOptions) {
    this.runtimeDir = join(opts.dataDir, 'runtime');
    this.heartbeatPath = join(this.runtimeDir, HEARTBEAT_NAME);
    this.restartFlagPath = join(this.runtimeDir, RESTART_FLAG_NAME);
    this.version = opts.version;
    this.port = opts.port;
    this.intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.startedAt = new Date().toISOString();
  }

  /**
   * Begin emitting heartbeats and watching for the restart flag.
   *
   * Call after the HTTP server is bound and serving (i.e. after the
   * `server.listen` callback fires) so `healthy` reflects reality from
   * the first heartbeat.
   *
   * Idempotent: calling start() twice is a no-op the second time.
   */
  start(): void {
    if (this.heartbeatTimer) {
      logger.debug('[RuntimeHeartbeat] start() called twice — ignoring');
      return;
    }

    try {
      if (!existsSync(this.runtimeDir)) {
        mkdirSync(this.runtimeDir, { recursive: true, mode: 0o755 });
      }
    } catch (err) {
      logger.warn(`[RuntimeHeartbeat] Failed to create runtime dir ${this.runtimeDir}: ${(err as Error).message}`);
      return;
    }

    // If a flag is already present at startup (e.g. update.sh wrote it
    // mid-build before pc2-node started up), consume it now rather than
    // waiting for the watcher to fire — the watcher only sees future
    // mutations, not files that already exist.
    if (existsSync(this.restartFlagPath)) {
      logger.info('[RuntimeHeartbeat] Restart flag found at startup — consuming and respawning');
      this.handleRestartFlag('startup-flag');
      return;
    }

    this.healthy = true;
    this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), this.intervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      // unref so the timer doesn't keep the event loop alive on its own —
      // we want pc2-node to be free to exit cleanly when shutdown() drains
      // every other listener.
      this.heartbeatTimer.unref();
    }

    this.installFlagWatcher();

    logger.info(`[RuntimeHeartbeat] Heartbeat active at ${this.heartbeatPath} (interval=${this.intervalMs}ms, port=${this.port}, version=${this.version})`);
  }

  /**
   * Mark the current process as not-healthy and stop emitting heartbeats.
   * Called from the SIGTERM/SIGINT graceful-shutdown handler.
   *
   * Removing the heartbeat file is the signal to the launcher that pc2-node
   * exited intentionally (vs crashed — in which case the file would simply
   * go stale). On any restart trigger we leave the file in place; the
   * detached child will overwrite it within ~2s of starting.
   *
   * @param removeFile - true to delete the heartbeat (clean exit / shutdown);
   *                     false to leave it for the respawner to overwrite (restart).
   */
  stop(removeFile: boolean): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.flagWatcher) {
      try { this.flagWatcher.close(); } catch { /* noop */ }
      this.flagWatcher = null;
    }
    if (this.flagPollTimer) {
      clearInterval(this.flagPollTimer);
      this.flagPollTimer = null;
    }

    if (removeFile && existsSync(this.heartbeatPath)) {
      try {
        unlinkSync(this.heartbeatPath);
        logger.debug('[RuntimeHeartbeat] Heartbeat file removed (clean shutdown)');
      } catch (err) {
        logger.debug(`[RuntimeHeartbeat] Failed to remove heartbeat file: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Write a single heartbeat snapshot. Best-effort — failures are logged
   * at debug level only (we don't want disk-full or permission issues to
   * crash pc2-node, the heartbeat is a hint not a contract).
   */
  private writeHeartbeat(): void {
    const payload: HeartbeatPayload = {
      schema: 'pc2.heartbeat.v1',
      pid: process.pid,
      version: this.version,
      port: this.port,
      healthy: this.healthy,
      startedAt: this.startedAt,
      lastUpdated: new Date().toISOString(),
      lastRestartReason: this.lastRestartReason,
    };

    try {
      writeFileSync(this.heartbeatPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
    } catch (err) {
      logger.debug(`[RuntimeHeartbeat] Failed to write heartbeat: ${(err as Error).message}`);
    }
  }

  /**
   * Install the restart-flag watcher.
   *
   * Two layers:
   *   1. fs.watch on the runtime dir: catches creates/renames in real time.
   *   2. setInterval poll every 5s: catches edge cases where fs.watch
   *      misses events (macOS race conditions when the runtime dir was
   *      just created, or NFS / Docker volumes that don't propagate inotify).
   *
   * Both layers feed into handleRestartFlag(), which is itself idempotent
   * via `restartInProgress`.
   */
  private installFlagWatcher(): void {
    try {
      this.flagWatcher = watch(this.runtimeDir, (eventType, filename) => {
        if (filename === RESTART_FLAG_NAME && existsSync(this.restartFlagPath)) {
          this.handleRestartFlag(`fs-watch:${eventType}`);
        }
      });
      this.flagWatcher.on('error', (err) => {
        logger.warn(`[RuntimeHeartbeat] Flag watcher error (falling back to poll-only): ${err.message}`);
        this.flagWatcher = null;
      });
    } catch (err) {
      logger.warn(`[RuntimeHeartbeat] Failed to install flag watcher (continuing with poll only): ${(err as Error).message}`);
    }

    this.flagPollTimer = setInterval(() => {
      if (existsSync(this.restartFlagPath)) {
        this.handleRestartFlag('poll');
      }
    }, 5000);
    if (typeof this.flagPollTimer.unref === 'function') {
      this.flagPollTimer.unref();
    }
  }

  /**
   * React to the restart flag being present.
   *
   * Steps:
   *   1. Mark restartInProgress so concurrent watcher+poll fires don't
   *      double-respawn (each would delete the flag, but spawning two
   *      detached respawners would race on port 4200 release).
   *   2. Optionally read the flag for a `reason:` line — lets the trigger
   *      tag the respawn (e.g. update.sh writes `reason: post-update`).
   *   3. Spawn the detached respawner (3 s delay; same as v1.2.7.6's
   *      post-update path).
   *   4. Delete the flag so a future restart needs a new write.
   *   5. Trigger a graceful shutdown of THIS pc2-node — the detached
   *      respawner will start a fresh one in 3 s.
   */
  private handleRestartFlag(source: string): void {
    if (this.restartInProgress) return;
    this.restartInProgress = true;

    let reason = `flag-trigger(${source})`;
    try {
      const content = readFileSync(this.restartFlagPath, 'utf-8').trim();
      if (content) {
        // First line `reason: foo` is honoured; other content is informational.
        const match = content.match(/^reason:\s*(\S+)/m);
        if (match && match[1]) {
          reason = `flag-trigger:${match[1]}`;
        }
      }
    } catch {
      // Flag is opaque or unreadable — keep the default reason.
    }

    this.lastRestartReason = reason;
    logger.info(`[RuntimeHeartbeat] Restart flag triggered (${source}); reason=${reason}`);

    // Update the heartbeat one last time so the launcher sees the reason
    // before pc2-node exits.
    this.healthy = false;
    this.writeHeartbeat();

    // Delete the flag BEFORE spawning the respawner so the new pc2-node
    // doesn't see a stale flag at its own startup and respawn-loop.
    try {
      if (existsSync(this.restartFlagPath)) {
        unlinkSync(this.restartFlagPath);
      }
    } catch (err) {
      logger.warn(`[RuntimeHeartbeat] Failed to delete restart flag (the new pc2-node will consume it on startup): ${(err as Error).message}`);
    }

    const spawned = spawnDetachedRespawn(reason, 3000);
    if (!spawned) {
      logger.warn('[RuntimeHeartbeat] Detached respawner failed to spawn — relying on external supervisor (pm2/launcher) to restart');
    }

    // Stop emitting heartbeats but leave the file in place — the new
    // pc2-node will overwrite it within ~2 s, providing a seamless
    // hand-off as far as the launcher is concerned.
    this.stop(/* removeFile */ false);

    // Give the respawner a moment to fork before we exit.
    setTimeout(() => {
      logger.info(`[RuntimeHeartbeat] Exiting for respawn (reason=${reason})`);
      process.exit(0);
    }, 200);
  }
}
