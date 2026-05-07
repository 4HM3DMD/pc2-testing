#!/usr/bin/env bash
#
# deploy-enm.sh — deploy a tagged ENM bundle from GitHub Releases onto this PC2 host.
#
# What it does:
#   1. Resolves the version to download (arg, or "latest")
#   2. wget'es the .tar.gz from the matching GitHub Release
#   3. Backs up the currently-deployed bundle
#   4. Extracts the new bundle over the deployed install directory
#   5. Restarts ENM by killing its PID — pc2-node's AppProcessManager respawns it
#   6. Smoke-tests /api/enm/health
#
# Usage:
#   sudo ./deploy-enm.sh                   # latest tagged release
#   sudo ./deploy-enm.sh enm-v0.1.0-alpha.2 # specific tag
#
# Env overrides:
#   GITHUB_REPO   — defaults to the upstream repo this script ships with
#   BUNDLE_DIR    — deployed install dir (default /var/lib/pc2/data/installed-apps/elastos-node-manager)
#   ENM_PORT      — ENM HTTP port for the smoke test (default 4180)
#
# Exit codes:
#   0   success
#   1   bad usage / missing dep
#   2   download failed
#   3   extract failed
#   4   smoke test failed (rolled back)

set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-4HM3DMD/pc2-testing}"
BUNDLE_DIR="${BUNDLE_DIR:-/var/lib/pc2/data/installed-apps/elastos-node-manager}"
ENM_PORT="${ENM_PORT:-4180}"
TAG="${1:-latest}"

log() { printf '\033[1;36m[deploy-enm]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[deploy-enm] ERROR:\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

[ -d "$BUNDLE_DIR" ] || die "bundle dir not found: $BUNDLE_DIR (is ENM installed?)"
command -v wget >/dev/null  || die "wget not installed"
command -v jq >/dev/null    || die "jq not installed (apt install jq)"
command -v curl >/dev/null  || die "curl not installed"

# 1. Resolve the tag → tarball URL via GitHub's API.
log "resolving release tag '$TAG' from $GITHUB_REPO"
if [ "$TAG" = "latest" ]; then
    RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest") \
        || die "could not fetch latest release (private repo? rate-limited? wrong repo name?)" 2
else
    RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/tags/$TAG") \
        || die "release tag '$TAG' not found" 2
fi

TARBALL_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url' | head -1)
[ -n "$TARBALL_URL" ] || die "no .tar.gz asset in release '$TAG'" 2
TARBALL_NAME=$(basename "$TARBALL_URL")
log "tarball: $TARBALL_URL"

# 2. Download to a temp file.
TMP_TARBALL=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$TMP_TARBALL"' EXIT
log "downloading $TARBALL_NAME..."
wget -q -O "$TMP_TARBALL" "$TARBALL_URL" || die "download failed" 2

DOWNLOADED_BYTES=$(stat -c '%s' "$TMP_TARBALL")
log "downloaded $DOWNLOADED_BYTES bytes"
[ "$DOWNLOADED_BYTES" -gt 100000 ] || die "tarball suspiciously small (got $DOWNLOADED_BYTES bytes)" 2

# 3. Snapshot the current install before overwriting.
BACKUP_PATH="/tmp/enm-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
log "backing up current bundle to $BACKUP_PATH"
tar czf "$BACKUP_PATH" -C "$BUNDLE_DIR" . || die "backup failed" 3

# 4. Extract on top of the existing install.
log "extracting into $BUNDLE_DIR"
tar -C "$BUNDLE_DIR" -xzf "$TMP_TARBALL" || die "extract failed" 3

# 5. Restart ENM. AppProcessManager respawns within ~5s.
ENM_PID=$(pgrep -f 'elastos-node-manager.*server.js' | head -1 || true)
if [ -n "$ENM_PID" ]; then
    log "killing ENM pid $ENM_PID — AppProcessManager will respawn"
    kill "$ENM_PID" || log "kill returned non-zero (process may have already exited)"
else
    log "no running ENM process found — pc2-node should start it on next hydrate tick"
fi

# 6. Smoke test.
log "waiting for ENM to come back on :$ENM_PORT..."
for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    if curl -fsS "http://localhost:${ENM_PORT}/api/enm/health" >/dev/null 2>&1; then
        log "health OK after ${i}x2s"
        VERSION=$(curl -fsS "http://localhost:${ENM_PORT}/api/enm/health" | jq -r '.ts // .ok' 2>/dev/null || true)
        log "deployed: $TARBALL_NAME"
        log "rollback if needed: tar -C $BUNDLE_DIR -xzf $BACKUP_PATH && kill \$(pgrep -f 'elastos-node-manager.*server.js')"
        exit 0
    fi
done

# Health never came back — restore the backup so we don't leave a broken install.
log "health check failed — rolling back"
tar -C "$BUNDLE_DIR" -xzf "$BACKUP_PATH" || die "rollback ALSO failed; investigate manually. backup is at $BACKUP_PATH" 4
ENM_PID2=$(pgrep -f 'elastos-node-manager.*server.js' | head -1 || true)
[ -n "$ENM_PID2" ] && kill "$ENM_PID2" 2>/dev/null || true
die "deploy failed and was rolled back. backup tarball preserved at $BACKUP_PATH" 4
