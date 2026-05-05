/**
 * Detached self-respawner — spawn a node child that re-launches PC2
 * after a brief delay, then let the parent exit cleanly.
 *
 * Why this exists (v1.2.7.6):
 *
 * On macOS, PC2 is launched by the ElastOS Launcher (Electron app), which
 * does NOT currently auto-restart PC2 when the spawned child exits. Both
 * the in-app updater and the manual /api/system/restart endpoint were
 * relying on `process.exit(0)` to hand restart responsibility back to the
 * launcher — but the launcher just shows "PC2 stopped" and waits for the
 * user to click Start again. The browser tab's auto-reload-after-restart
 * never fires because /api/health never returns 200.
 *
 * Fix: before exiting, spawn a detached `sh -c 'sleep N && exec NODE ENTRY'`
 * child. The child inherits init (PID 1) as its parent the moment we exit,
 * runs independently of the launcher, and re-launches PC2 with the exact
 * same node binary + entry script + cwd + env. The launcher's status
 * indicator briefly shows "stopped" but PC2 itself is back online by the
 * time the GUI's /api/health probe fires.
 *
 * Linux is unaffected — pm2 / systemctl chains in UpdateService and
 * system.ts succeed first and return before this is ever reached.
 */

import { spawn } from 'child_process';
import { logger } from './logger.js';

/**
 * Spawn a detached respawner that re-launches PC2 after `delayMs`.
 *
 * @param reason - tagged in logs for traceability (e.g. 'post-update', 'manual-restart')
 * @param delayMs - how long the respawner waits before exec'ing PC2 again. Default 3000 ms gives the parent plenty of time to release port 4200.
 * @returns true if the respawner was spawned successfully, false otherwise. Caller should still proceed with process.exit(0); a false return just means the launcher will need to handle restart.
 */
export function spawnDetachedRespawn(reason: string, delayMs: number = 3000): boolean {
  const nodeBin = process.execPath;
  const entry = process.argv[1];
  const cwd = process.cwd();

  if (!entry) {
    logger.warn(`[Respawner] Cannot respawn (${reason}): process.argv[1] is empty`);
    return false;
  }

  // Quote both paths so spaces in `~/Library/Application Support/...` etc.
  // don't break the shell. The double-quote escaping below assumes neither
  // path contains a literal `"` — which is true for every Node install
  // we've ever seen on macOS or Linux.
  const shellCmd = `sleep ${Math.ceil(delayMs / 1000)} && exec "${nodeBin}" "${entry}"`;

  try {
    const child = spawn('/bin/sh', ['-c', shellCmd], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    // unref() lets the parent exit even though the child is still running.
    // Without this, the parent's event loop would wait for the child to
    // finish before our process.exit(0) fires, which defeats the whole point.
    child.unref();
    logger.info(`[Respawner] Detached child spawned for ${reason} (pid=${child.pid}, delay=${delayMs}ms, entry=${entry})`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Respawner] Failed to spawn detached respawner (${reason}): ${msg}`);
    return false;
  }
}
