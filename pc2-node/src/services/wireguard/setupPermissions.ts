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
 * Flow:
 *   1. Check if sudoers entry already exists with all required transport binaries
 *   2. If missing or incomplete, attempt to create it (with user consent / OS-level auth prompt)
 *   3. On macOS, use osascript for a native password dialog
 *   4. On Linux, write a sudoers.d drop-in file
 *   5. On Windows, no action needed (WireGuard runs as SYSTEM service)
 */

import { execSync, exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../../utils/logger.js';

// SUDOERS_TAG kept as 'pc2-wireguard' for v1.2.7.0–v1.2.7.8 backwards-compat:
// existing installs with this filename get their contents extended in-place
// rather than gaining a duplicate file. Path is the conventional sudoers.d
// location on both macOS and Linux.
const SUDOERS_TAG = 'pc2-wireguard';
const SUDOERS_FILE = `/etc/sudoers.d/${SUDOERS_TAG}`;

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
 * Check whether the current user can run wg-quick AND awg-quick via sudo without
 * a password.
 *
 * v1.2.7.9: previously only checked wg-quick. AWG and VLESS users were left in
 * fallback-to-ActiveProxy land even after wg sudoers landed. Now requires the
 * sudoers file to contain both binaries (when awg-quick is present in the
 * bundled dir). Pre-v1.2.7.9 sudoers files that only have wg-quick will be
 * detected as incomplete and re-prompt to upgrade in-place.
 */
export function checkWireGuardPermissions(wgQuickPath: string): PermissionCheckResult {
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

  if (existsSync(SUDOERS_FILE)) {
    try {
      const content = readFileSync(SUDOERS_FILE, 'utf-8');
      const hasWg = content.includes('wg-quick') || content.includes('wg quick');
      // If awg-quick isn't bundled, don't require it — keeps the check valid
      // for users who never get an AWG binary (unusual but possible).
      const hasAwg = !awgQuickPath || content.includes('awg-quick');
      if (hasWg && hasAwg) {
        return {
          sudoConfigured: true,
          needsSetup: false,
          platform,
          message: awgQuickPath
            ? 'Sudoers entry found for wg-quick + awg-quick'
            : 'Sudoers entry found for wg-quick',
        };
      }
      if (hasWg && !hasAwg) {
        return {
          sudoConfigured: false,
          needsSetup: true,
          platform,
          message: 'Sudoers entry found for wg-quick but missing awg-quick (pre-v1.2.7.9 install) — re-running setup will extend it',
        };
      }
    } catch {
      // Can't read sudoers file (expected for non-root)
    }
  }

  try {
    execSync(`sudo -n ${wgQuickPath} --version 2>/dev/null`, {
      stdio: 'pipe',
      timeout: 3000,
    });
    return {
      sudoConfigured: true,
      needsSetup: false,
      platform,
      message: 'sudo wg-quick works without password',
    };
  } catch {
    // sudo -n failed → password required
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
 * v1.2.7.9: now writes entries for both wg-quick and awg-quick (when bundled)
 * in the same sudoers file. Single OS-level auth prompt unlocks WireGuard,
 * AmneziaWG, AND VLESS Reality (transitive — sing-box userspace tunnels
 * through AWG, so AWG sudo is the gating dependency).
 */
function buildSudoersEntry(wgQuickPath: string, wgGoBinPath?: string): string {
  const user = process.env.USER || process.env.LOGNAME || 'nobody';
  const lines = [
    `# PC2 transport permissions — passwordless sudo for tunnel management`,
    `# Covers WireGuard (wg-quick) and AmneziaWG (awg-quick). VLESS Reality`,
    `# uses sing-box in userspace mode and needs no sudo.`,
    `# Auto-generated by PC2 Node. Remove this file to revoke; PC2 will`,
    `# re-prompt on next launch.`,
    `${user} ALL=(root) NOPASSWD: ${wgQuickPath} up *`,
    `${user} ALL=(root) NOPASSWD: ${wgQuickPath} down *`,
  ];

  // v1.2.7.9: include awg-quick when present in the bundled dir or a known
  // system location. Mirrors AmneziaWGService.awgQuickCmd() which calls
  // `sudo <awg-quick> up <conf>` exactly the same shape as wg-quick.
  const awgQuickPath = findSiblingBinary(wgQuickPath, 'awg-quick');
  if (awgQuickPath) {
    lines.push(`${user} ALL=(root) NOPASSWD: ${awgQuickPath} up *`);
    lines.push(`${user} ALL=(root) NOPASSWD: ${awgQuickPath} down *`);
  }

  if (wgGoBinPath) {
    lines.push(`${user} ALL=(root) NOPASSWD:SETENV: /usr/bin/env WG_QUICK_USERSPACE_IMPLEMENTATION=${wgGoBinPath} ${wgQuickPath} up *`);
    lines.push(`${user} ALL=(root) NOPASSWD:SETENV: /usr/bin/env WG_QUICK_USERSPACE_IMPLEMENTATION=${wgGoBinPath} ${wgQuickPath} down *`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Attempt to install the sudoers entry. Returns true on success.
 *
 * macOS: Uses osascript to show a native authorization dialog.
 * Linux: Writes via sudo tee (may prompt in terminal or fail silently in GUI).
 */
export async function setupWireGuardSudoers(
  wgQuickPath: string,
  wgGoBinPath?: string,
): Promise<{ success: boolean; message: string }> {
  const platform = process.platform;

  if (platform === 'win32') {
    return { success: true, message: 'No sudo needed on Windows' };
  }

  const entry = buildSudoersEntry(wgQuickPath, wgGoBinPath);
  logger.info(`[WireGuard:sudoers] Attempting to install sudoers entry for wg-quick`);

  if (platform === 'darwin') {
    return setupMacOS(entry);
  }
  return setupLinux(entry);
}

async function setupMacOS(entry: string): Promise<{ success: boolean; message: string }> {
  const escaped = entry.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const script = `
    do shell script "echo \\"${escaped}\\" > ${SUDOERS_FILE} && chmod 0440 ${SUDOERS_FILE}" with administrator privileges
  `.trim();

  return new Promise((resolve) => {
    exec(`osascript -e '${script}'`, { timeout: 60_000 }, (error) => {
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
