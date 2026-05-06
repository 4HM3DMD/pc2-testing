/**
 * Transport Permission Setup
 *
 * On macOS and Linux, the wg-quick AND awg-quick scripts require root (sudo) to
 * create network interfaces and write routes. This module detects whether
 * passwordless sudo is already configured for the specific binaries we ship,
 * and provides platform-appropriate guided setup.
 *
 * v1.2.7.9: extended to grant awg-quick permissions in the same sudoers entry.
 * Single user prompt unlocks BOTH WireGuard AND AmneziaWG transports (VLESS
 * Reality is unblocked transitively because it tunnels through AmneziaWG, and
 * sing-box itself runs userspace and needs no root).
 *
 * v1.2.7.10: rules now use `NOPASSWD:SETENV:` instead of `NOPASSWD:` so that
 * `sudo -E` invocations preserving WG_QUICK_USERSPACE_IMPLEMENTATION succeed.
 * Without SETENV, sudo strips PATH-modifying env vars even with -E, and
 * wg-quick on macOS / userspace-Linux cannot find its bundled `wireguard-go` /
 * `amneziawg-go` companion (sudo default secure_path is
 * /usr/bin:/bin:/usr/sbin:/sbin which does not include ~/.pc2/pc2-node/bin).
 * Pre-v1.2.7.10 entries (no SETENV) are detected as needing upgrade and
 * trigger one more password prompt to rewrite — single cost, then never again.
 *
 * v1.2.7.11: TWO bugs fixed in the install + check flow:
 *   (a) osascript install command was breaking on apostrophes in the comment
 *       text of the sudoers entry. The whole entry was interpolated into
 *       `osascript -e 'do shell script "echo \"...\" > ..."'` and any embedded
 *       `'` terminated the outer single-quoted shell argument before osascript
 *       could run. Now: the entry is written to a temp file as the user, and
 *       osascript runs a fixed-shape `cp + chmod + rm` against known paths.
 *   (b) The fallback "is sudo configured?" probe used `sudo -n <bin> --version`,
 *       but wg-quick has no --version flag and exits non-zero on it — the
 *       probe always reported "not configured" even when sudoers was perfect.
 *       Now: probe via `sudo -n -l <bin> up <args>` which exits 0 silently
 *       when a NOPASSWD rule matches and prints the matched rule for SETENV
 *       parsing. False-positive setup attempts (and their associated noisy
 *       password prompts on every relaunch) are eliminated.
 *
 * Flow:
 *   1. Check if sudoers entry already exists with all required transport binaries
 *   2. If missing or incomplete, attempt to create it (with user consent / OS-level auth prompt)
 *   3. On macOS, use osascript for a native password dialog
 *   4. On Linux, write a sudoers.d drop-in file
 *   5. On Windows, no action needed (WireGuard runs as SYSTEM service)
 */

import { execSync, exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';

// SUDOERS_TAG kept as 'pc2-wireguard' for v1.2.7.0–v1.2.7.8 backwards-compat:
// existing installs with this filename get their contents extended in-place
// rather than gaining a duplicate file. Path is the conventional sudoers.d
// location on both macOS and Linux.
const SUDOERS_TAG = 'pc2-wireguard';
const SUDOERS_FILE = `/etc/sudoers.d/${SUDOERS_TAG}`;

// v1.2.7.12: state-marker filename written into the WireGuard data dir
// (user-writable, e.g. ~/.pc2/pc2-node/data/wireguard/) after a successful
// sudoers install. Records SHA-256 of the entry that was installed; the next
// startup probe checks this first and trusts the marker when its hash matches
// the entry we'd write today AND the sudoers file still exists. Sidesteps the
// macOS `sudo -n -l` quirk that returns non-zero for non-root users in some
// configurations even with NOPASSWD rules — the symptom Sasha hit on v1.2.7.11
// where every restart prompted for password and re-installed the same file.
const SUDOERS_MARKER_NAME = 'sudoers-marker.json';

interface SudoersMarker {
  version: string;
  hash: string;
  installedAt: string;
  sudoersFile: string;
  wgQuickPath: string;
}

function sha256OfEntry(entry: string): string {
  return createHash('sha256').update(entry, 'utf8').digest('hex');
}

export interface PermissionCheckResult {
  sudoConfigured: boolean;
  needsSetup: boolean;
  platform: string;
  message: string;
}

/**
 * Find a sibling binary next to wg-quick.
 *
 * v1.2.7.9: pc2-binaries-v1 ships wg-quick and awg-quick in the same bundled
 * directory (e.g. ~/.pc2/pc2-node/bin/darwin-arm64/), so the cheapest reliable
 * lookup is "look beside wg-quick first". Falls back to common system paths in
 * case the user installed the tools via Homebrew/apt and pc2-node found them
 * on PATH instead of the bundled dir.
 *
 * Returns null if not found — caller should treat that as "not bundled, don't
 * include in sudoers entry".
 */
function findSiblingBinary(wgQuickPath: string, name: string): string | null {
  const beside = join(dirname(wgQuickPath), name);
  if (existsSync(beside)) return beside;
  const systemPaths = [
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/bin/${name}`,
    `/usr/sbin/${name}`,
  ];
  for (const sysPath of systemPaths) {
    if (existsSync(sysPath)) return sysPath;
  }
  return null;
}

/**
 * Probe whether `sudo -n -l <binPath> up <args>` succeeds without a password
 * prompt. When sudo is given a command argument with `-l`, it exits 0 silently
 * if a NOPASSWD rule matches and prints the matched rule line(s) (which we
 * grep for the SETENV flag). On no-match or password-required it exits non-zero.
 *
 * This replaces the pre-v1.2.7.11 probe that ran `sudo -n <bin> --version` —
 * `wg-quick` has no `--version` flag and exits non-zero on it, so the old
 * probe always reported "not configured" even when sudoers was perfect.
 * That false negative cascaded into a spurious osascript install attempt on
 * every launch (logged as `Passwordless sudo not configured for wg-quick`).
 *
 * Returns `{ allowed: true, hasSetenv: <bool> }` when the rule matches.
 */
function probeSudoForBinary(binPath: string): { allowed: boolean; hasSetenv: boolean } {
  try {
    const out = execSync(`sudo -n -l ${binPath} up /dev/null 2>&1`, {
      stdio: 'pipe',
      timeout: 3000,
      shell: '/bin/sh',
    }).toString();
    return { allowed: true, hasSetenv: /SETENV/i.test(out) };
  } catch {
    return { allowed: false, hasSetenv: false };
  }
}

/**
 * Check whether the current user can run wg-quick AND awg-quick via sudo without
 * a password.
 *
 * v1.2.7.9: previously only checked wg-quick. AWG and VLESS users were left in
 * fallback-to-ActiveProxy land even after wg sudoers landed. Now requires the
 * sudoers file to contain both binaries (when awg-quick is present in the
 * bundled dir). Pre-v1.2.7.9 sudoers files that only have wg-quick will be
 * detected as incomplete and re-prompt to upgrade in-place.
 *
 * v1.2.7.10: also requires the `:SETENV:` flag to be present on the rules.
 * Without it, `sudo -E` strips WG_QUICK_USERSPACE_IMPLEMENTATION and wg-quick
 * cannot locate the bundled wireguard-go / amneziawg-go companion (which is
 * the default invocation form on macOS now). Pre-v1.2.7.10 entries get
 * detected as needing setup so they upgrade in-place on next launch — costs
 * the user one extra password prompt, after which they're permanently fixed.
 *
 * v1.2.7.11: switched to `sudo -n -l` probe as the primary check. The
 * existsSync/readFileSync path is kept as a secondary signal (for the rare
 * case where a non-root user CAN read /etc/sudoers.d/, e.g. inside a
 * container) but is now best-effort: failure to read it is no longer
 * treated as "needs setup" — the sudo -n -l result is authoritative.
 *
 * v1.2.7.12: marker file becomes the PRIMARY check. After a successful
 * install, we write a SHA-256 of the entry into <markerDir>/sudoers-marker.json
 * (user-writable, no permission games). On the next startup probe, if the
 * marker's hash matches what we'd write today AND /etc/sudoers.d/pc2-wireguard
 * still exists, we trust it without running `sudo -n -l`. This fixes the
 * regression on macOS where `sudo -n -l` returns non-zero in some configs
 * even with NOPASSWD rules — every restart was triggering osascript again
 * and re-installing the same file.
 *
 * @param wgQuickPath  Resolved path to the wg-quick binary (used to derive the
 *                     expected sudoers entry for hash comparison).
 * @param markerDir    Optional user-writable dir where the marker is stored.
 *                     When omitted, marker check is skipped (back-compat for
 *                     callers that pre-date v1.2.7.12).
 */
export function checkWireGuardPermissions(
  wgQuickPath: string,
  markerDir?: string,
): PermissionCheckResult {
  const platform = process.platform;

  if (platform === 'win32') {
    return {
      sudoConfigured: true,
      needsSetup: false,
      platform: 'windows',
      message: 'Windows uses WireGuard tunnel service (no sudo needed)',
    };
  }

  const awgQuickPath = findSiblingBinary(wgQuickPath, 'awg-quick');

  // v1.2.7.12 PRIMARY CHECK: marker file. Bulletproof on every Unix:
  //   - markerDir is user-writable (~/.pc2/pc2-node/data/wireguard) so
  //     readFileSync always succeeds for the user that installed.
  //   - Hash of the entry we'd write TODAY must match what's in the marker.
  //     If wg-quick path changed, hash differs → re-prompt. If sudoers
  //     entry text was upgraded (new SETENV format, new awg-quick rule,
  //     etc.) → re-prompt. If installed binary path moved → re-prompt.
  //   - /etc/sudoers.d/pc2-wireguard must still exist (user may have
  //     deleted it manually with `sudo rm`).
  // Three-of-three required, otherwise we fall through to the probes.
  if (markerDir) {
    const markerPath = join(markerDir, SUDOERS_MARKER_NAME);
    if (existsSync(markerPath) && existsSync(SUDOERS_FILE)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as SudoersMarker;
        const expectedEntry = buildSudoersEntry(wgQuickPath);
        const expectedHash = sha256OfEntry(expectedEntry);
        if (marker.hash === expectedHash) {
          return {
            sudoConfigured: true,
            needsSetup: false,
            platform,
            message: `Sudoers marker matches current entry (installed ${marker.installedAt})`,
          };
        }
        logger.info(`[WireGuard:sudoers] Marker hash mismatch (installed=${marker.hash.slice(0, 8)} vs expected=${expectedHash.slice(0, 8)}); re-probing`);
      } catch (err) {
        logger.warn(`[WireGuard:sudoers] Marker file present but unreadable: ${(err as Error).message}; falling back to sudo probe`);
      }
    }
  }

  // Primary probe: sudo -n -l <bin> up <args>. Works for non-root users,
  // doesn't prompt, and the matched rule line is parseable for SETENV.
  const wgProbe = probeSudoForBinary(wgQuickPath);
  if (wgProbe.allowed) {
    const awgProbe = awgQuickPath
      ? probeSudoForBinary(awgQuickPath)
      : { allowed: true, hasSetenv: true };

    if (awgProbe.allowed && wgProbe.hasSetenv && awgProbe.hasSetenv) {
      return {
        sudoConfigured: true,
        needsSetup: false,
        platform,
        message: awgQuickPath
          ? 'sudo -n -l: wg-quick + awg-quick permitted with SETENV'
          : 'sudo -n -l: wg-quick permitted with SETENV',
      };
    }

    if (awgProbe.allowed && (!wgProbe.hasSetenv || !awgProbe.hasSetenv)) {
      return {
        sudoConfigured: false,
        needsSetup: true,
        platform,
        message: 'Sudoers rules exist but missing SETENV flag (pre-v1.2.7.10 install). Re-running setup will upgrade them in-place so sudo -E can pass WG_QUICK_USERSPACE_IMPLEMENTATION through.',
      };
    }

    if (!awgProbe.allowed) {
      return {
        sudoConfigured: false,
        needsSetup: true,
        platform,
        message: 'wg-quick rule present but awg-quick rule missing (pre-v1.2.7.9 install). Re-running setup will extend the entry to cover both binaries.',
      };
    }
  }

  // Secondary probe: try reading /etc/sudoers.d/pc2-wireguard. Usually fails
  // for non-root (mode 0440 root:wheel), so the sudo -n -l probe above is
  // the authoritative check. Kept for diagnostic clarity in environments
  // where the file IS readable (some container setups, root-owned shells).
  if (existsSync(SUDOERS_FILE)) {
    try {
      const content = readFileSync(SUDOERS_FILE, 'utf-8');
      const hasWg = content.includes('wg-quick') || content.includes('wg quick');
      const hasAwg = !awgQuickPath || content.includes('awg-quick');
      const hasSetenv = /SETENV/i.test(content);
      if (hasWg && hasAwg && hasSetenv) {
        return {
          sudoConfigured: true,
          needsSetup: false,
          platform,
          message: awgQuickPath
            ? 'Sudoers file readable and contains wg-quick + awg-quick (SETENV)'
            : 'Sudoers file readable and contains wg-quick (SETENV)',
        };
      }
    } catch {
      // Expected for non-root — not a failure signal.
    }
  }

  return {
    sudoConfigured: false,
    needsSetup: true,
    platform,
    message: `Passwordless sudo not configured for wg-quick at ${wgQuickPath}`,
  };
}

/**
 * Build the sudoers entry content for the current user and the given binary paths.
 *
 * v1.2.7.9: writes entries for both wg-quick and awg-quick (when bundled).
 * Single OS-level auth prompt unlocks WireGuard, AmneziaWG, AND VLESS Reality
 * (transitive — sing-box userspace tunnels through AWG).
 *
 * v1.2.7.10: rules are now `NOPASSWD:SETENV:` instead of `NOPASSWD:`. The
 * SETENV flag is required so callers can do
 *
 *   WG_QUICK_USERSPACE_IMPLEMENTATION=/path/to/wireguard-go sudo -E /path/to/wg-quick up <conf>
 *
 * — without SETENV, sudo's env_reset+secure_path strips the var even with
 * `-E`, and wg-quick falls back to a PATH lookup for "wireguard-go" which
 * fails because /usr/bin:/bin:... doesn't include our bundled binary.
 *
 * SETENV is harmless for the kernel-mode-Linux invocation pattern (plain
 * `sudo wg-quick up <conf>` without env vars) — it just permits the env var,
 * doesn't require one. The wgGoBinPath argument is now informational only:
 * we no longer emit a separate `/usr/bin/env WG_QUICK_USERSPACE_IMPLEMENTATION=...`
 * rule (the SETENV form on the simple wg-quick rule subsumes it).
 */
function buildSudoersEntry(wgQuickPath: string, _wgGoBinPath?: string): string {
  const user = process.env.USER || process.env.LOGNAME || 'nobody';
  // v1.2.7.11: comment text deliberately avoids apostrophes/single quotes.
  // The whole entry is interpolated through `osascript -e '...'` on macOS,
  // and any embedded ' character terminates the outer single-quoted shell
  // argument before osascript ever runs (the install would fail at /bin/sh
  // parse time, before the password dialog could appear). The temp-file +
  // cp dance in setupMacOS now sidesteps the interpolation entirely, but
  // keeping the comment text apostrophe-free is a defence-in-depth measure
  // for any future code path that does interpolate the entry.
  const lines = [
    `# PC2 transport permissions: passwordless sudo for tunnel management.`,
    `# Covers WireGuard (wg-quick) and AmneziaWG (awg-quick). VLESS Reality`,
    `# uses sing-box in userspace mode and needs no sudo.`,
    `#`,
    `# v1.2.7.10: rules use NOPASSWD:SETENV: so sudo -E callers can pass`,
    `# WG_QUICK_USERSPACE_IMPLEMENTATION=<bundled-wireguard-go-path>. Without`,
    `# SETENV, sudo strips the var and wg-quick cannot locate our bundled`,
    `# wireguard-go / amneziawg-go (sudo secure_path does not include`,
    `# ~/.pc2/pc2-node/bin/<platform>-<arch>/).`,
    `#`,
    `# Auto-generated by PC2 Node. Remove this file to revoke;`,
    `# PC2 will re-prompt on next launch.`,
    `${user} ALL=(root) NOPASSWD:SETENV: ${wgQuickPath} up *`,
    `${user} ALL=(root) NOPASSWD:SETENV: ${wgQuickPath} down *`,
  ];

  const awgQuickPath = findSiblingBinary(wgQuickPath, 'awg-quick');
  if (awgQuickPath) {
    lines.push(`${user} ALL=(root) NOPASSWD:SETENV: ${awgQuickPath} up *`);
    lines.push(`${user} ALL=(root) NOPASSWD:SETENV: ${awgQuickPath} down *`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Attempt to install the sudoers entry. Returns true on success.
 *
 * macOS: Uses osascript to show a native authorization dialog.
 * Linux: Writes via sudo tee (may prompt in terminal or fail silently in GUI).
 */
/**
 * Write the post-install marker to <markerDir>/sudoers-marker.json.
 *
 * v1.2.7.12: separated from the install path so it can be called from both
 * setupMacOS and setupLinux on success. Best-effort: if the write fails, we
 * log and move on — the install itself already worked, the marker is only
 * an optimisation to skip the `sudo -n -l` probe on subsequent startups.
 */
function writeSudoersMarker(markerDir: string, entry: string, wgQuickPath: string): void {
  try {
    if (!existsSync(markerDir)) {
      mkdirSync(markerDir, { recursive: true, mode: 0o755 });
    }
    const marker: SudoersMarker = {
      version: '1.2.7.12',
      hash: sha256OfEntry(entry),
      installedAt: new Date().toISOString(),
      sudoersFile: SUDOERS_FILE,
      wgQuickPath,
    };
    const markerPath = join(markerDir, SUDOERS_MARKER_NAME);
    writeFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o644 });
    logger.info(`[WireGuard:sudoers] Marker written to ${markerPath} (hash=${marker.hash.slice(0, 8)})`);
  } catch (err) {
    logger.warn(`[WireGuard:sudoers] Failed to write marker (install still succeeded): ${(err as Error).message}`);
  }
}

export async function setupWireGuardSudoers(
  wgQuickPath: string,
  wgGoBinPath?: string,
  markerDir?: string,
): Promise<{ success: boolean; message: string }> {
  const platform = process.platform;

  if (platform === 'win32') {
    return { success: true, message: 'No sudo needed on Windows' };
  }

  const entry = buildSudoersEntry(wgQuickPath, wgGoBinPath);
  logger.info(`[WireGuard:sudoers] Attempting to install sudoers entry for wg-quick`);

  const result = platform === 'darwin'
    ? await setupMacOS(entry)
    : await setupLinux(entry);

  if (result.success && markerDir) {
    writeSudoersMarker(markerDir, entry, wgQuickPath);
  }

  return result;
}

async function setupMacOS(entry: string): Promise<{ success: boolean; message: string }> {
  // v1.2.7.11: the previous approach interpolated the sudoers entry text
  // directly into `osascript -e 'do shell script "echo \"...\" > ..."'`,
  // which broke the moment the entry contained an apostrophe (the embedded
  // ' terminated the outer single-quoted shell argument). Production hit
  // this when the v1.2.7.10 comment text contained `'sudo -E'` and `cant`
  // / `doesnt` — /bin/sh failed at parse time, before osascript ever ran,
  // and the password dialog never appeared on fresh-Mac installs.
  //
  // New approach: write the entry to a temp file as the user (mode 0600),
  // then ask osascript to run a fixed-shape `cp + chmod + rm` against
  // known paths. The shell command passed to osascript no longer contains
  // any user-controlled string, so apostrophes / quotes / unicode in the
  // entry can't break parsing.
  const tmpFile = join(tmpdir(), `pc2-sudoers-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tmpFile, entry, { mode: 0o600 });
  } catch (err) {
    return {
      success: false,
      message: `Failed to write temp sudoers file: ${err instanceof Error ? err.message : err}`,
    };
  }

  const escapeForOsa = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tmpEsc = escapeForOsa(tmpFile);
  const destEsc = escapeForOsa(SUDOERS_FILE);
  const script = `do shell script "/bin/cp \\"${tmpEsc}\\" \\"${destEsc}\\" && /bin/chmod 0440 \\"${destEsc}\\" && /bin/rm -f \\"${tmpEsc}\\"" with administrator privileges`;

  return new Promise((resolve) => {
    exec(`osascript -e '${script}'`, { timeout: 60_000 }, (error) => {
      // Best-effort cleanup if osascript bailed before deleting the temp
      // file (e.g. user cancelled the auth dialog).
      try {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      } catch {
        // Already gone (osascript completed the rm) or permission glitch — ignore.
      }
      if (error) {
        logger.warn(`[WireGuard:sudoers] macOS setup cancelled or failed: ${error.message}`);
        resolve({
          success: false,
          message: 'Permission setup cancelled. You can set it up manually by running:\n' +
            `  sudo tee ${SUDOERS_FILE} << 'EOF'\n${entry}EOF\n  sudo chmod 0440 ${SUDOERS_FILE}`,
        });
        return;
      }
      logger.info('[WireGuard:sudoers] macOS sudoers entry installed');
      resolve({ success: true, message: 'Sudoers entry installed successfully' });
    });
  });
}

async function setupLinux(entry: string): Promise<{ success: boolean; message: string }> {
  const escapedEntry = entry.replace(/'/g, "'\\''");
  const cmd = `echo '${escapedEntry}' | sudo tee ${SUDOERS_FILE} > /dev/null && sudo chmod 0440 ${SUDOERS_FILE}`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: 30_000 }, (error) => {
      if (error) {
        logger.warn(`[WireGuard:sudoers] Linux setup failed: ${error.message}`);
        resolve({
          success: false,
          message: 'Automated setup failed. Run the following manually:\n' +
            `  sudo tee ${SUDOERS_FILE} << 'EOF'\n${entry}EOF\n  sudo chmod 0440 ${SUDOERS_FILE}`,
        });
        return;
      }
      logger.info('[WireGuard:sudoers] Linux sudoers entry installed');
      resolve({ success: true, message: 'Sudoers entry installed successfully' });
    });
  });
}

/**
 * Generate manual setup instructions for the user.
 */
export function getManualSetupInstructions(wgQuickPath: string, wgGoBinPath?: string): string {
  const entry = buildSudoersEntry(wgQuickPath, wgGoBinPath);
  const platform = process.platform;

  if (platform === 'win32') {
    return 'Windows: Install WireGuard from https://www.wireguard.com/install/ — no additional setup needed.';
  }

  return [
    'To enable WireGuard tunnel management, run the following in your terminal:',
    '',
    `  sudo tee ${SUDOERS_FILE} << 'EOF'`,
    entry.trimEnd(),
    'EOF',
    `  sudo chmod 0440 ${SUDOERS_FILE}`,
    '',
    'To remove later:',
    `  sudo rm ${SUDOERS_FILE}`,
  ].join('\n');
}
