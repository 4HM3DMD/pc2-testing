#!/usr/bin/env bash
# setup-transport-permissions.sh
#
# Install the /etc/sudoers.d/pc2-wireguard drop-in granting passwordless
# sudo for the bundled wg-quick (WireGuard) and awg-quick (AmneziaWG)
# binaries. Run from a TTY — sudo will prompt for the user's login
# password if not already cached.
#
# Idempotent + safe to re-run:
#   - If the sudoers file is already complete, exits with status 0 (skipped).
#   - If it exists but is incomplete (e.g. pre-v1.2.7.9 wg-only entry),
#     overwrites it with the complete entry.
#   - If pc2-binaries-v1 hasn't been downloaded yet (fresh install before
#     first pc2-node start), exits 0 with a hint — runtime will retry.
#
# Why this matters:
#   wg-quick and awg-quick on macOS+Linux need root to create network
#   interfaces and write routes. They invoke `sudo` internally.
#   When pc2-node runs headless under pm2 there is no TTY for sudo to
#   prompt on, so the bring-up fails and the cascade falls to ActiveProxy.
#   Installing this sudoers entry once during update grants targeted,
#   pre-authorised sudo to ONLY the pc2-shipped binaries — no broader
#   privilege escalation. Removing the file revokes the grant.
#
# Platform support:
#   - macOS: yes (uses sudo via TTY here; also has runtime osascript
#     fallback in WireGuardService.connect for launcher users)
#   - Linux (Ubuntu, Jetson, Debian-derived VPS): yes
#   - Windows: skipped (WireGuard runs as SYSTEM service, no sudo)
#
# Exit codes:
#   0 — already configured, or installed successfully, or skipped safely
#   1 — fatal error during install (sudo declined, write failed, etc)

set -euo pipefail

# ─── Resolve install location ───────────────────────────────────────────
PC2_DIR="${PC2_DIR:-$HOME/.pc2}"
SUDOERS_FILE="/etc/sudoers.d/pc2-wireguard"

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$PLATFORM" in
    darwin) PLATFORM="darwin" ;;
    linux)  PLATFORM="linux" ;;
    mingw*|msys*|cygwin*)
        echo "Windows detected — WireGuard runs as SYSTEM service, no sudoers needed."
        exit 0
        ;;
    *)
        echo "Unsupported platform: $(uname -s) — skipping."
        exit 0
        ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
        echo "Unsupported architecture: $ARCH — skipping."
        exit 0
        ;;
esac

BIN_DIR="$PC2_DIR/pc2-node/bin/${PLATFORM}-${ARCH}"
WG_QUICK="$BIN_DIR/wg-quick"
AWG_QUICK="$BIN_DIR/awg-quick"

# ─── Pre-flight: binaries present? ──────────────────────────────────────
if [[ ! -x "$WG_QUICK" ]]; then
    echo "ℹ  wg-quick not yet present at $WG_QUICK"
    echo "   This is normal on a fresh install before pc2-node first starts."
    echo "   Re-run this script after first launch (BinaryManager will fetch it)"
    echo "   or restart pc2 — the macOS runtime will auto-prompt on first connect."
    exit 0
fi

# ─── Idempotency check: already configured? ─────────────────────────────
# We need to test whether the file exists AND contains entries for both
# wg-quick and awg-quick (when awg-quick is bundled). The file has 0440
# perms so non-root can't read it — use sudo for the read check.
needs_install="no"

if sudo -n test -f "$SUDOERS_FILE" 2>/dev/null; then
    # File exists and we have passwordless sudo — check contents
    if sudo cat "$SUDOERS_FILE" 2>/dev/null | grep -q -F "$WG_QUICK"; then
        if [[ -x "$AWG_QUICK" ]]; then
            if sudo cat "$SUDOERS_FILE" 2>/dev/null | grep -q -F "$AWG_QUICK"; then
                echo "✓ Transport sudoers already complete (wg-quick + awg-quick) — skipping."
                exit 0
            else
                echo "↻ Sudoers entry exists but missing awg-quick (pre-v1.2.7.9) — extending in-place."
                needs_install="yes"
            fi
        else
            echo "✓ Sudoers entry already configured for wg-quick (awg-quick not bundled) — skipping."
            exit 0
        fi
    else
        # File exists but doesn't contain our wg-quick path. Could be a
        # different install path or a stale entry. Reinstall.
        echo "↻ Sudoers file exists but missing current wg-quick path — replacing in-place."
        needs_install="yes"
    fi
elif [[ ! -t 0 ]] && ! sudo -n true 2>/dev/null; then
    # No TTY and no passwordless sudo — we can't probe the file content.
    # Try a one-shot test that doesn't require reading the sudoers file:
    # if `sudo -n wg-quick --version` works, the entry must be installed.
    if sudo -n "$WG_QUICK" --version >/dev/null 2>&1; then
        echo "✓ Passwordless sudo verified for wg-quick — skipping."
        exit 0
    fi
    needs_install="yes"
else
    needs_install="yes"
fi

[[ "$needs_install" == "yes" ]] || exit 0

# ─── TTY check: only proceed interactively ──────────────────────────────
# If running headless (cron, CI, ssh without -t), skip with a hint rather
# than hanging. The macOS runtime auto-prompt covers Mac users; Linux
# users in this state should re-run interactively.
if [[ ! -t 0 ]]; then
    echo "ℹ  Not running interactively (no TTY) — skipping sudoers install."
    echo "   To install permissions later, run from a terminal:"
    echo "     bash $PC2_DIR/scripts/setup-transport-permissions.sh"
    echo "   Without this, WireGuard/AmneziaWG cannot bind and pc2 will fall"
    echo "   back to ActiveProxy."
    exit 0
fi

# ─── Build the sudoers content ──────────────────────────────────────────
# Mirror buildSudoersEntry() in setupPermissions.ts so the runtime check
# (checkWireGuardPermissions) recognises this as complete and won't
# re-prompt the user.
USER_NAME="$(whoami)"
TMPFILE="$(mktemp /tmp/pc2-sudoers.XXXXXX)"
trap 'rm -f "$TMPFILE"' EXIT

{
    echo "# PC2 transport permissions — passwordless sudo for tunnel management"
    echo "# Covers WireGuard (wg-quick) and AmneziaWG (awg-quick). VLESS Reality"
    echo "# uses sing-box in userspace mode and needs no sudo."
    echo "# Auto-generated by PC2 Node setup-transport-permissions.sh."
    echo "# Remove this file to revoke; PC2 will re-prompt on next launch."
    echo "$USER_NAME ALL=(root) NOPASSWD: $WG_QUICK up *"
    echo "$USER_NAME ALL=(root) NOPASSWD: $WG_QUICK down *"
    if [[ -x "$AWG_QUICK" ]]; then
        echo "$USER_NAME ALL=(root) NOPASSWD: $AWG_QUICK up *"
        echo "$USER_NAME ALL=(root) NOPASSWD: $AWG_QUICK down *"
    fi
} > "$TMPFILE"

# ─── Validate syntax with visudo before installing ──────────────────────
# A malformed sudoers file LOCKS YOU OUT of sudo. visudo -c -f checks the
# syntax without applying. Belt-and-braces — these are literal binary
# paths so syntax errors are unlikely, but worth the 10ms.
if ! sudo visudo -c -f "$TMPFILE" >/dev/null 2>&1; then
    echo "✗ Generated sudoers entry failed visudo syntax check — aborting." >&2
    cat "$TMPFILE" >&2
    exit 1
fi

# ─── Install ────────────────────────────────────────────────────────────
echo ""
echo "Installing transport sudoers entry. You may be prompted for your password."
echo "  Target: $SUDOERS_FILE"
echo "  Grants: passwordless sudo for $WG_QUICK + $AWG_QUICK only (no broader access)"
echo ""

sudo install -m 0440 -o root -g wheel "$TMPFILE" "$SUDOERS_FILE" 2>/dev/null \
    || sudo install -m 0440 -o root -g root "$TMPFILE" "$SUDOERS_FILE"
# macOS uses 'wheel' as the root group; Linux uses 'root'. Try both.

# ─── Verify ─────────────────────────────────────────────────────────────
if sudo -n "$WG_QUICK" --version >/dev/null 2>&1; then
    echo "✓ Sudoers entry installed and verified — passwordless sudo for wg-quick works."
else
    echo "⚠ Sudoers entry installed but verification failed."
    echo "  Try: sudo cat $SUDOERS_FILE"
    echo "  If it looks correct, restart pc2 and check logs."
    exit 1
fi

if [[ -x "$AWG_QUICK" ]]; then
    if sudo -n "$AWG_QUICK" --version >/dev/null 2>&1; then
        echo "✓ Verified passwordless sudo for awg-quick works."
    else
        echo "⚠ awg-quick passwordless sudo did NOT verify (entry may be malformed)."
    fi
fi

echo ""
echo "Done. WireGuard and AmneziaWG can now bring up tunnels without re-prompting."
echo "Restart pc2 to pick up the new permissions:"
echo "  pm2 restart pc2"
