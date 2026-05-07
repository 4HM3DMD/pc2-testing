#!/usr/bin/env bash
#
# deploy-enm.sh — install OR upgrade ENM on this PC2 host using a tagged release.
#
# Two modes, picked automatically:
#
#   FRESH INSTALL  (no /var/lib/pc2/data/installed-apps/elastos-node-manager)
#     1. Download the tagged .tar.gz + .json from GitHub Releases
#     2. Extract the tarball to a temp dir
#     3. POST /api/installed-apps/install-local with manifest + temp path —
#        pc2-node copies the bundle into place AND spawns the backend AND
#        records the row in installed_apps.
#
#   UPGRADE  (bundle dir already present)
#     1. Download the tarball
#     2. Backup the current install to /tmp
#     3. Extract on top
#     4. Kill the ENM PID — AppProcessManager respawns it
#     5. Health check; auto-rollback on failure
#
# Usage:
#   sudo ./deploy-enm.sh                     # latest tagged release
#   sudo ./deploy-enm.sh enm-v0.1.0-alpha.4  # specific tag
#
# Auth (only needed for fresh install):
#   PC2_OWNER_TOKEN   the owner's Bearer token (mandatory for fresh install,
#                     ignored for upgrades)
#
# Env overrides:
#   GITHUB_REPO   default 4HM3DMD/pc2-testing
#   BUNDLE_DIR    default /var/lib/pc2/data/installed-apps/elastos-node-manager
#   ENM_PORT      default 4180  (used for the post-deploy health check)
#   PC2_PORT      default 4202  (pc2-node HTTP — only used for fresh install)

set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-4HM3DMD/pc2-testing}"
BUNDLE_DIR="${BUNDLE_DIR:-/var/lib/pc2/data/installed-apps/elastos-node-manager}"
ENM_PORT="${ENM_PORT:-4180}"
PC2_PORT="${PC2_PORT:-4202}"
TAG="${1:-latest}"

log() { printf '\033[1;36m[deploy-enm]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[deploy-enm] ERROR:\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

command -v wget >/dev/null  || die "wget not installed"
command -v jq >/dev/null    || die "jq not installed (apt install jq)"
command -v curl >/dev/null  || die "curl not installed"

# 1. Resolve tag → release JSON via the GitHub API.
log "resolving release tag '$TAG' from $GITHUB_REPO"
if [ "$TAG" = "latest" ]; then
    RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest") \
        || die "could not fetch latest release (private repo? rate-limited? wrong repo name?)" 2
else
    RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/tags/$TAG") \
        || die "release tag '$TAG' not found" 2
fi

TARBALL_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url' | head -1)
MANIFEST_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name | endswith(".json")) | .browser_download_url' | head -1)
[ -n "$TARBALL_URL" ]  || die "no .tar.gz asset in release '$TAG'" 2
[ -n "$MANIFEST_URL" ] || die "no .json (manifest) asset in release '$TAG'" 2
TARBALL_NAME=$(basename "$TARBALL_URL")
log "tarball:  $TARBALL_URL"
log "manifest: $MANIFEST_URL"

# 2. Download both to temp.
TMP_TARBALL=$(mktemp --suffix=.tar.gz)
TMP_MANIFEST=$(mktemp --suffix=.json)
TMP_EXTRACT=""
trap 'rm -f "$TMP_TARBALL" "$TMP_MANIFEST"; [ -n "$TMP_EXTRACT" ] && rm -rf "$TMP_EXTRACT"' EXIT

log "downloading $TARBALL_NAME..."
wget -q -O "$TMP_TARBALL"  "$TARBALL_URL"  || die "tarball download failed" 2
wget -q -O "$TMP_MANIFEST" "$MANIFEST_URL" || die "manifest download failed" 2

DOWNLOADED_BYTES=$(stat -c '%s' "$TMP_TARBALL")
log "downloaded $DOWNLOADED_BYTES bytes"
[ "$DOWNLOADED_BYTES" -gt 100000 ] || die "tarball suspiciously small (got $DOWNLOADED_BYTES bytes)" 2

# 3. Pick the install mode based on whether the bundle dir already exists.
if [ -d "$BUNDLE_DIR" ]; then
    MODE="upgrade"
else
    MODE="fresh"
fi
log "mode: $MODE"

# =============================================================================
# Fresh install — go through pc2-node so the DB row + process supervision land.
# =============================================================================
if [ "$MODE" = "fresh" ]; then
    [ -n "${PC2_OWNER_TOKEN:-}" ] || die "fresh install needs PC2_OWNER_TOKEN env var (the owner's Bearer token from the PC2 desktop URL: ?puter.auth.token=...)"

    # /install-local restricts localDir to a safe-list — extracting to /tmp
    # gets rejected with "localDir must live inside one of [test-apps, dev-apps]".
    # Use test-apps as the staging root so the path passes the gate.
    PC2_TEST_APPS_DIR="${PC2_TEST_APPS_DIR:-/var/lib/pc2/data/test-apps}"
    mkdir -p "$PC2_TEST_APPS_DIR"
    TMP_EXTRACT=$(mktemp -d -p "$PC2_TEST_APPS_DIR")
    log "extracting tarball into $TMP_EXTRACT"
    tar -C "$TMP_EXTRACT" -xzf "$TMP_TARBALL" || die "extract failed" 3

    log "calling pc2-node /api/installed-apps/install-local"
    BODY=$(jq -n \
        --slurpfile manifest "$TMP_MANIFEST" \
        --arg localDir "$TMP_EXTRACT" \
        '{ manifest: $manifest[0], localDir: $localDir }')
    RESP=$(curl -sS -X POST "http://127.0.0.1:${PC2_PORT}/api/installed-apps/install-local" \
        -H "Authorization: Bearer ${PC2_OWNER_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "$BODY") || die "install-local request failed (is pc2-node running on :${PC2_PORT}?)" 3

    # pc2-node returns either { app: {...} } on success or { error: "..." } on failure.
    if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
        die "install-local rejected: $(echo "$RESP" | jq -r '.error')" 3
    fi
    APP_NAME=$(echo "$RESP" | jq -r '.app.app_name // .app.name // "elastos-node-manager"')
    log "pc2-node installed '$APP_NAME' and started its backend"
fi

# =============================================================================
# Upgrade — extract on top of the existing install. pc2-node already has the
# DB row + AppProcessManager already supervises the process; we just refresh
# the files and restart the backend.
# =============================================================================
if [ "$MODE" = "upgrade" ]; then
    BACKUP_PATH="/tmp/enm-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    log "backing up current bundle to $BACKUP_PATH"
    tar czf "$BACKUP_PATH" -C "$BUNDLE_DIR" . || die "backup failed" 3

    log "extracting into $BUNDLE_DIR"
    tar -C "$BUNDLE_DIR" -xzf "$TMP_TARBALL" || die "extract failed" 3

    ENM_PID=$(pgrep -f 'elastos-node-manager.*server.js' | head -1 || true)
    if [ -n "$ENM_PID" ]; then
        log "killing ENM pid $ENM_PID — AppProcessManager will respawn"
        kill "$ENM_PID" || log "kill returned non-zero (process may have already exited)"
    else
        log "no running ENM process found — pc2-node should start it on next hydrate tick"
    fi
fi

# =============================================================================
# Smoke test (both modes).
# =============================================================================
log "waiting for ENM to come up on :$ENM_PORT..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 2
    if curl -fsS "http://localhost:${ENM_PORT}/api/enm/health" >/dev/null 2>&1; then
        log "health OK after ${i}x2s"
        log "deployed: $TARBALL_NAME ($MODE mode)"
        if [ "$MODE" = "upgrade" ]; then
            log "rollback: tar -C $BUNDLE_DIR -xzf $BACKUP_PATH && kill \$(pgrep -f 'elastos-node-manager.*server.js')"
        fi
        exit 0
    fi
done

# Health didn't come back — for upgrades, restore the backup. Fresh installs
# get left as-is so the operator can poke at the DB / logs to see what failed.
if [ "$MODE" = "upgrade" ]; then
    log "health check failed — rolling back"
    tar -C "$BUNDLE_DIR" -xzf "$BACKUP_PATH" || die "rollback ALSO failed; investigate. backup at $BACKUP_PATH" 4
    ENM_PID2=$(pgrep -f 'elastos-node-manager.*server.js' | head -1 || true)
    [ -n "$ENM_PID2" ] && kill "$ENM_PID2" 2>/dev/null || true
    die "deploy failed and was rolled back. backup tarball preserved at $BACKUP_PATH" 4
fi

die "fresh install completed but ENM never came up on :$ENM_PORT — check 'journalctl -u pc2-node' and the install-local response above" 4
