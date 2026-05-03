/**
 * Update Service
 * 
 * Checks for updates to the PC2 node software and notifies the user.
 * Supports macOS-style auto-updates: user clicks update, system downloads/builds/restarts.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

// Rolling log buffer cap. 400 lines covers a Jetson cold install + build
// (each npm install emits ~100 lines max with progress collapsed).
const LOG_BUFFER_MAX_LINES = 400;

// Watchdog: if a streamed child emits zero bytes for this long, kill it.
// On Jetson, native compiles can be quiet for a while during cc1plus runs;
// 8 minutes is generous but bounded so we never silently hang again.
const STREAM_IDLE_TIMEOUT_MS = 8 * 60 * 1000;

export interface VersionInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
  downloadUrl?: string;
  dockerImage?: string;
  checksums?: {
    sha256?: string;
  };
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseDate?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  dockerImage?: string;
}

export interface UpdateServiceConfig {
  checkUrl?: string;
  githubRepo?: string;
  checkInterval?: number; // milliseconds
  enabled?: boolean;
  projectRoot?: string;
}

const DEFAULT_CONFIG: Required<UpdateServiceConfig> = {
  checkUrl: 'https://ela.city/api/pc2/version',
  githubRepo: 'Elacity/pc2.net',
  checkInterval: 3 * 60 * 60 * 1000, // 3 hours
  enabled: true,
  projectRoot: process.cwd(),
};

export class UpdateService {
  private config: Required<UpdateServiceConfig>;
  private currentVersion: string;
  private latestVersion: VersionInfo | null = null;
  private lastCheck: Date | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private isUpdating: boolean = false;
  private updateProgress: string = '';
  // Rolling buffer of recent stdout/stderr from update sub-commands.
  // Exposed via /api/update/progress so the UI can show a live "View logs"
  // dropdown — fixes the v1.2.2 "flying blind" UX where users couldn't tell
  // whether a 10-min "Installing dependencies" was working or hung.
  private logBuffer: string[] = [];
  // Monotonic counter so the UI can detect new lines without diffing strings.
  private logSeq: number = 0;

  constructor(config: UpdateServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentVersion = this.loadCurrentVersion();
    
    logger.info(`[UpdateService] Initialized with version ${this.currentVersion}`);
  }

  /**
   * Check if an update is currently in progress
   */
  getIsUpdating(): boolean {
    return this.isUpdating;
  }

  /**
   * Get current update progress message
   */
  getUpdateProgress(): string {
    return this.updateProgress;
  }

  /**
   * Get rolling log buffer (most recent first cap = LOG_BUFFER_MAX_LINES).
   * Each entry already includes a HH:MM:SS prefix and source tag.
   */
  getUpdateLog(): string[] {
    return [...this.logBuffer];
  }

  /**
   * Monotonic sequence number that increments on each appended log line.
   * The UI uses this to skip re-rendering when nothing new arrived.
   */
  getLogSeq(): number {
    return this.logSeq;
  }

  /**
   * Append a single line to the log buffer. Auto-trims.
   * Source tag (e.g. "git", "npm-root") helps the UI colour-code lines.
   */
  private appendLog(source: string, line: string): void {
    const trimmed = line.replace(/\r/g, '').trimEnd();
    if (!trimmed) return;
    const ts = new Date().toISOString().substring(11, 19);
    this.logBuffer.push(`[${ts}] [${source}] ${trimmed}`);
    if (this.logBuffer.length > LOG_BUFFER_MAX_LINES) {
      this.logBuffer = this.logBuffer.slice(-LOG_BUFFER_MAX_LINES);
    }
    this.logSeq++;
  }

  /**
   * Reset log buffer at the start of each performUpdate() call.
   */
  private resetLog(): void {
    this.logBuffer = [];
    this.logSeq = 0;
  }

  /**
   * Run a child process with live stdout/stderr capture into the rolling
   * log buffer. Replaces execAsync for long-running update steps so the
   * UI gets live feedback and we can enforce an idle-timeout watchdog.
   *
   * - HUSKY=0 is forced into the env to neutralise the husky `prepare`
   *   lifecycle script. Without this, fresh production installs of
   *   v1.2.2 would crash with "sh: husky: not found" (exit 127).
   * - Idle watchdog kills any child that produces no output for
   *   STREAM_IDLE_TIMEOUT_MS, preventing the silent-hang we saw where
   *   npm crashed but the parent await never resolved.
   */
  private execStreamed(
    source: string,
    cmd: string,
    args: string[],
    opts: { cwd: string; extraEnv?: Record<string, string> } = { cwd: process.cwd() }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.appendLog(source, `$ ${cmd} ${args.join(' ')} (cwd: ${opts.cwd})`);

      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          // Disable husky in any pulled-in workspace; production installs
          // never need git hooks installed.
          HUSKY: '0',
          // Force npm to be non-interactive on slow ARM where prompts
          // would otherwise hang the daemon.
          CI: process.env.CI || 'true',
          ...(opts.extraEnv || {}),
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      let idleTimer: NodeJS.Timeout | null = null;
      let killedByWatchdog = false;

      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          killedByWatchdog = true;
          this.appendLog(source, `[watchdog] No output for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — killing process`);
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, STREAM_IDLE_TIMEOUT_MS);
      };

      const flushBuf = (buf: string): string => {
        const lines = buf.split('\n');
        const tail = lines.pop() || '';
        for (const line of lines) this.appendLog(source, line);
        return tail;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf = flushBuf(stdoutBuf + chunk.toString('utf8'));
        resetIdle();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf = flushBuf(stderrBuf + chunk.toString('utf8'));
        resetIdle();
      });

      child.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer);
        this.appendLog(source, `[error] spawn failed: ${err.message}`);
        reject(err);
      });

      child.on('exit', (code, signal) => {
        if (idleTimer) clearTimeout(idleTimer);
        if (stdoutBuf) this.appendLog(source, stdoutBuf);
        if (stderrBuf) this.appendLog(source, stderrBuf);

        if (killedByWatchdog) {
          reject(new Error(`${cmd} killed by watchdog (no output for ${STREAM_IDLE_TIMEOUT_MS / 1000}s)`));
          return;
        }
        if (signal) {
          reject(new Error(`${cmd} terminated by signal ${signal}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`${cmd} exited with code ${code}`));
          return;
        }
        this.appendLog(source, `[ok] ${cmd} ${args.join(' ')} completed`);
        resolve();
      });

      resetIdle();
    });
  }

  /**
   * Load current version from package.json or environment
   */
  private loadCurrentVersion(): string {
    // Check environment variable first (set in Docker)
    if (process.env.PC2_VERSION) {
      return process.env.PC2_VERSION;
    }

    // Try to read from package.json
    const packagePaths = [
      path.join(process.cwd(), 'package.json'),
      path.join(process.cwd(), '..', 'package.json'),
      path.join(process.cwd(), '..', '..', 'package.json'),
    ];

    for (const packagePath of packagePaths) {
      if (existsSync(packagePath)) {
        try {
          const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
          if (packageJson.version) {
            return packageJson.version;
          }
        } catch (error) {
          logger.debug(`[UpdateService] Failed to read ${packagePath}:`, error);
        }
      }
    }

    return '0.0.0-dev';
  }

  /**
   * Get current version
   */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /**
   * Get latest version info
   */
  getLatestVersion(): VersionInfo | null {
    return this.latestVersion;
  }

  /**
   * Get last check timestamp
   */
  getLastCheck(): Date | null {
    return this.lastCheck;
  }

  /**
   * Check for updates (uses GitHub releases as primary source)
   */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (!this.config.enabled) {
      return {
        updateAvailable: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
      };
    }

    // Use GitHub releases as primary source (no separate version API needed)
    return this.checkGitHubReleases();
  }

  /**
   * Compare semantic versions
   * Returns: -1 if a < b, 0 if a == b, 1 if a > b
   */
  private compareVersions(a: string, b: string): number {
    // Handle dev/snapshot versions
    const cleanA = a.replace(/-.*$/, '');
    const cleanB = b.replace(/-.*$/, '');

    const partsA = cleanA.split('.').map(Number);
    const partsB = cleanB.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;

      if (numA < numB) return -1;
      if (numA > numB) return 1;
    }

    // If base versions are equal, check pre-release
    // dev < alpha < beta < rc < release
    const preReleaseOrder: Record<string, number> = {
      'dev': 0,
      'alpha': 1,
      'beta': 2,
      'rc': 3,
    };

    const getPreRelease = (v: string) => {
      const match = v.match(/-(\w+)/);
      return match ? preReleaseOrder[match[1]] ?? 2.5 : 100;
    };

    const preA = getPreRelease(a);
    const preB = getPreRelease(b);

    return preA - preB;
  }

  /**
   * Start periodic update checks
   */
  startPeriodicChecks(): void {
    if (!this.config.enabled) {
      logger.info('[UpdateService] Periodic checks disabled');
      return;
    }

    // Check immediately
    this.checkForUpdates().catch(err => {
      logger.error('[UpdateService] Initial check failed:', err);
    });

    // Schedule periodic checks
    this.checkTimer = setInterval(() => {
      this.checkForUpdates().catch(err => {
        logger.error('[UpdateService] Periodic check failed:', err);
      });
    }, this.config.checkInterval);

    logger.info(`[UpdateService] Periodic checks enabled (every ${this.config.checkInterval / 1000 / 60 / 60} hours)`);
  }

  /**
   * Stop periodic update checks
   */
  stopPeriodicChecks(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      logger.info('[UpdateService] Periodic checks stopped');
    }
  }

  /**
   * Check GitHub releases for latest version
   */
  async checkGitHubReleases(): Promise<UpdateCheckResult> {
    try {
      logger.info('[UpdateService] Checking GitHub releases...');
      
      const response = await fetch(
        `https://api.github.com/repos/${this.config.githubRepo}/releases/latest`,
        {
          headers: {
            'User-Agent': `PC2-Node/${this.currentVersion}`,
            'Accept': 'application/vnd.github.v3+json',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const release = await response.json();
      const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';
      
      this.latestVersion = {
        version: latestVersion,
        releaseDate: release.published_at,
        releaseNotes: release.body || '',
        downloadUrl: release.html_url,
      };
      this.lastCheck = new Date();

      const updateAvailable = this.compareVersions(this.currentVersion, latestVersion) < 0;

      if (updateAvailable) {
        logger.info(`[UpdateService] Update available from GitHub: ${this.currentVersion} → ${latestVersion}`);
      }

      return {
        updateAvailable,
        currentVersion: this.currentVersion,
        latestVersion,
        releaseDate: release.published_at,
        releaseNotes: release.body || '',
        downloadUrl: release.html_url,
      };
    } catch (error) {
      logger.error('[UpdateService] GitHub release check failed:', error);
      return {
        updateAvailable: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
      };
    }
  }

  /**
   * Perform the actual update: git pull, npm install, npm build, restart
   */
  async performUpdate(): Promise<{ success: boolean; message: string }> {
    if (this.isUpdating) {
      return { success: false, message: 'Update already in progress' };
    }

    this.isUpdating = true;
    this.updateProgress = 'Starting update...';
    this.resetLog();

    try {
      // Find project root (go up from pc2-node to root)
      const projectRoot = path.resolve(this.config.projectRoot, '..');
      const pc2NodeDir = this.config.projectRoot;

      logger.info(`[UpdateService] Starting update in ${projectRoot}`);
      this.appendLog('update', `Starting update in ${projectRoot}`);

      // Step 1+2: Fetch upstream and force-reset to origin/main.
      //
      // We deliberately use `git fetch + git reset --hard origin/main`
      // instead of the previous `git checkout -- . + git pull origin main`
      // sequence. `git pull` halts with a merge error on any divergent
      // history (e.g. nodes that were once on a fork or whose history was
      // rewritten upstream), and the silent failure was the proximate
      // cause of v1.2.0 nodes never picking up the new release. The hard
      // reset:
      //   - replaces local HEAD with origin/main (no merge attempted)
      //   - restores every tracked file in the working tree
      //     (subsumes `git checkout -- .`, including any frontend assets
      //      a previous broken update half-deleted)
      //   - destroys local commits, but production nodes are not
      //     supposed to carry local commits in the first place
      this.updateProgress = 'Fetching latest code...';
      logger.info('[UpdateService] Fetching origin/main...');
      await this.execStreamed('git', 'git', ['fetch', 'origin', 'main'], { cwd: projectRoot });

      this.updateProgress = 'Resetting to latest release...';
      logger.info('[UpdateService] Resetting working tree to origin/main...');
      await this.execStreamed('git', 'git', ['reset', '--hard', 'origin/main'], { cwd: projectRoot });

      // Drop ignored assets that an earlier broken update may have
      // half-installed. Best-effort, never fatal — wrapped in try/catch
      // so a missing path or repo state quirk can't abort the update.
      try {
        await this.execStreamed('git', 'git', ['clean', '-fd', 'src/particle-auth/assets/'], { cwd: projectRoot });
      } catch (cleanErr) {
        this.appendLog('git', `[warn] git clean failed (non-fatal): ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}`);
      }
      logger.info('[UpdateService] Working tree synced with origin/main');

      // Step 3: npm install (in case of new dependencies)
      // We install at BOTH locations:
      //   - project root: provides shared/hoisted deps (e.g. ethers, siwe,
      //     @lit-protocol/*) consumed via dynamic `await import()` from pc2-node
      //   - pc2-node:     provides pc2-node's own declared deps + @types
      // Using --legacy-peer-deps to avoid dependency conflicts.
      // Using --include=dev (pc2-node only) to ensure @types packages are
      // installed for the TypeScript build.
      //
      // execStreamed forces HUSKY=0 in the env to neutralise the husky
      // `prepare` lifecycle script — which crashed every v1.2.2 install
      // with "sh: husky: not found" (exit 127). The package.json fix
      // (`"prepare": "husky 2>/dev/null || true"`) provides defence in
      // depth at the package level; HUSKY=0 here covers nodes that
      // somehow still pull a broken package.json.
      this.updateProgress = 'Installing root dependencies...';
      logger.info('[UpdateService] Running npm install at project root...');
      await this.execStreamed('npm-root', 'npm', ['install', '--legacy-peer-deps', '--no-fund', '--no-audit'], { cwd: projectRoot });
      logger.info('[UpdateService] Root npm install complete');

      this.updateProgress = 'Installing pc2-node dependencies...';
      logger.info('[UpdateService] Running npm install in pc2-node...');
      await this.execStreamed('npm-node', 'npm', ['install', '--legacy-peer-deps', '--include=dev', '--no-fund', '--no-audit'], { cwd: pc2NodeDir });
      logger.info('[UpdateService] pc2-node npm install complete');

      // Step 4: Build GUI and backend (skip particle-auth rebuild - it's pre-built in repo).
      //
      // We rebuild the wallet-bridge bundle as a separate explicit step BEFORE
      // the GUI build. The wallet-bridge JS files (pc2-secure-view.js,
      // pc2-wallet-bridge.js, …) live in src/wallet-bridge/ and need to be
      // copied into pc2-node/frontend/ for the browser to load them — without
      // this, fixes to those files (e.g. the v1.2.4 stale-Lit-CID self-heal)
      // would land in source on disk but never reach users via auto-update,
      // because the user's browser keeps loading the previously-shipped frontend
      // copy. build:gui only handles the desktop bundle, not these files.
      this.updateProgress = 'Syncing wallet bridge...';
      logger.info('[UpdateService] Syncing wallet-bridge files src -> frontend...');
      try {
        await this.execStreamed('build-frontend', 'npm', ['run', 'build:frontend'], { cwd: pc2NodeDir });
      } catch (frontendErr) {
        // Don't hard-fail the update — older nodes may not have the
        // build:frontend script defined. Log and continue; the wallet-bridge
        // copies in frontend/ that came down via `git reset --hard` will be
        // used as the source of truth.
        const msg = frontendErr instanceof Error ? frontendErr.message : String(frontendErr);
        logger.warn(`[UpdateService] build:frontend skipped (older node?): ${msg}`);
        this.appendLog('build-frontend', `[warn] build:frontend skipped (non-fatal): ${msg}`);
      }

      this.updateProgress = 'Building application...';
      logger.info('[UpdateService] Running builds...');
      await this.execStreamed('build-gui', 'npm', ['run', 'build:gui'], { cwd: projectRoot });
      await this.execStreamed('build-backend', 'npm', ['run', 'build:backend'], { cwd: pc2NodeDir });
      logger.info('[UpdateService] Build complete');

      // Step 4.5 (v1.2.6, retained in v1.2.7): Native-module verification
      // gauntlet.
      //
      // Before we restart PC2 against the freshly-installed deps, verify
      // that the critical native modules actually load. If they don't —
      // e.g. a prebuild failed to extract or node_modules is half-baked —
      // fail the update LOUDLY now rather than letting PM2 restart-loop
      // on the new broken state.
      //
      // v1.2.7: switched the load test from `better-sqlite3` to
      // `@photostructure/sqlite`. The new library uses Node-API and
      // ships per-platform prebuilds bundled in the npm tarball, so the
      // historical NODE_MODULE_VERSION mismatch class of failures is gone.
      // We retain the gauntlet anyway because (a) cheap defence in depth,
      // and (b) it still catches genuine "node_modules is corrupt"
      // failure modes (partial extraction, disk-full mid-install, etc).
      this.updateProgress = 'Verifying native modules...';
      logger.info('[UpdateService] Verifying @photostructure/sqlite loads against current Node ABI...');
      try {
        await this.execStreamed(
          'verify-natives',
          'node',
          ['-e', "const { DatabaseSync } = require('@photostructure/sqlite'); new DatabaseSync(':memory:').prepare('SELECT 1').get(); console.log('@photostructure/sqlite OK');"],
          { cwd: pc2NodeDir }
        );
        logger.info('[UpdateService] Native modules verified');
      } catch (verifyErr) {
        const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        logger.error('[UpdateService] Native module verification FAILED:', errMsg);
        this.appendLog('verify-natives', `[fatal] Native module verification failed: ${errMsg}`);
        this.appendLog('verify-natives', '[fatal] PC2 would crash-loop on restart. Aborting update.');
        this.appendLog('verify-natives', '[hint] @photostructure/sqlite ships prebuilds for all platforms. If this fails, node_modules is likely corrupt.');
        this.appendLog('verify-natives', '[hint] Try: cd ' + pc2NodeDir + ' && rm -rf node_modules package-lock.json && npm install');
        this.isUpdating = false;
        this.updateProgress = '';
        return {
          success: false,
          message: 'Update built but native modules failed to load. Try a clean reinstall: cd pc2-node && rm -rf node_modules package-lock.json && npm install',
        };
      }

      // Step 5: Schedule restart
      this.updateProgress = 'Restarting server...';
      logger.info('[UpdateService] Update complete, scheduling restart...');

      // Return success before restarting
      setTimeout(async () => {
        logger.info('[UpdateService] Attempting restart...');

        // v1.2.7 restart preference order:
        //
        //   1. `pm2 startOrRestart <ecosystem.config.cjs> --only pc2 --update-env`
        //      RE-READS ecosystem.config.cjs and refreshes pm2's stored env
        //      from the file. Without this, pm2's env is frozen at the
        //      original `pm2 start` time and any new env vars added to
        //      ecosystem.config.cjs by a release (e.g. SUPERNODE_CLUSTER_PIN_*
        //      added in v1.2.7) silently never apply on in-app updates.
        //      This was flagged in v1.2.6 CHANGELOG; promoted into v1.2.7.
        //
        //   2-N. existing fallbacks. Kept verbatim — they already work for
        //        every install path we've seen in production:
        //        - systemctl unit (Docker/sysadmin installs)
        //        - bare `pm2 restart pc2` (preserves stale env, but at
        //          least keeps the process alive)
        //        - nvm-managed pm2 (Ahmed's setup, Apr 30 2026)
        //        - /usr/local/bin/pm2 (Homebrew Mac installs)
        //
        // The ecosystem path resolves from projectRoot (computed from
        // this.config.projectRoot above as `path.resolve(projectRoot, '..')`).
        // If the file isn't at that path (e.g. a non-standard install),
        // startOrRestart fails and we fall through to the next handler;
        // the user never sees a difference.
        const ecosystemPath = path.join(projectRoot, 'ecosystem.config.cjs');
        const ecosystemExists = existsSync(ecosystemPath);

        const restartCommands: Array<{ cmd: string; name: string }> = [];
        if (ecosystemExists) {
          // Quote the path so spaces in ~/Library/Application Support/... etc.
          // don't break the shell. --only pc2 narrows to our app even if the
          // ecosystem file later grows additional entries. --update-env is
          // the bit that actually refreshes pm2's stored env from the file.
          restartCommands.push({
            cmd: `pm2 startOrRestart "${ecosystemPath}" --only pc2 --update-env`,
            name: 'pm2 startOrRestart ecosystem.config.cjs',
          });
        }
        restartCommands.push(
          { cmd: 'systemctl restart pc2-node', name: 'systemctl pc2-node' },
          { cmd: 'systemctl restart pc2', name: 'systemctl pc2' },
          { cmd: 'pm2 restart pc2', name: 'pm2 pc2' },
          { cmd: 'pm2 restart all', name: 'pm2 all' },
          { cmd: `${process.env.HOME}/.nvm/versions/node/*/bin/pm2 restart pc2`, name: 'pm2 (nvm path)' },
          { cmd: '/usr/local/bin/pm2 restart pc2', name: 'pm2 (/usr/local)' },
        );

        for (const { cmd, name } of restartCommands) {
          try {
            logger.info(`[UpdateService] Trying ${name}...`);
            execSync(cmd, { timeout: 30000, shell: '/bin/bash' }); // Use bash for glob expansion
            logger.info(`[UpdateService] Restart successful via ${name}`);
            return; // Success, don't try other methods
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`[UpdateService] ${name} failed: ${errorMessage}`);
          }
        }

        // If all restart methods failed, exit and let process manager restart
        logger.info('[UpdateService] All restart methods failed, exiting for external restart...');
        process.exit(0);
      }, 1000);

      return { success: true, message: 'Update complete, server is restarting...' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[UpdateService] Update failed:', error);
      this.isUpdating = false;
      this.updateProgress = '';
      return { success: false, message: `Update failed: ${errorMessage}` };
    }
  }

  /**
   * Get update status for API response
   */
  getStatus(): {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    lastCheck: string | null;
    releaseNotes: string | null;
    downloadUrl: string | null;
    dockerImage: string | null;
    isUpdating: boolean;
    updateProgress: string;
    logSeq: number;
  } {
    const updateAvailable = this.latestVersion 
      ? this.compareVersions(this.currentVersion, this.latestVersion.version) < 0
      : false;

    return {
      currentVersion: this.currentVersion,
      latestVersion: this.latestVersion?.version || null,
      updateAvailable,
      lastCheck: this.lastCheck?.toISOString() || null,
      releaseNotes: this.latestVersion?.releaseNotes || null,
      downloadUrl: this.latestVersion?.downloadUrl || null,
      dockerImage: this.latestVersion?.dockerImage || null,
      isUpdating: this.isUpdating,
      updateProgress: this.updateProgress,
      logSeq: this.logSeq,
    };
  }
}

// Singleton instance
let updateServiceInstance: UpdateService | null = null;

export function getUpdateService(): UpdateService {
  if (!updateServiceInstance) {
    updateServiceInstance = new UpdateService();
  }
  return updateServiceInstance;
}

export function initUpdateService(config: UpdateServiceConfig = {}): UpdateService {
  updateServiceInstance = new UpdateService(config);
  return updateServiceInstance;
}
