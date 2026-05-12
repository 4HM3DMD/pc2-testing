#!/usr/bin/env bash
#
# deploy-enm.sh — install OR upgrade ENM on this PC2 host using a tagged release.
#
# Two modes, picked automatically:
#
#   FRESH INSTALL  (no /var/lib/pc2/data/installed-apps/elastos-node-manager)
#     1. Download the tagged .tar.gz + .json from GitHub Releases
#     2. Extract the tarball to a temp test-apps dir
#     3. POST /api/installed-apps/install-local with manifest + temp path —
#        pc2-node copies the bundle into place AND spawns the backend AND
#        records the row in installed_apps.
#
#   UPGRADE  (bundle dir already present) — rewritten 2026-05-11
#     1. Download the tarball
#     2. Diagnostic backup of the current install to /tmp/enm-backup-*.tar.gz
#     3. Extract the new bundle to a temp test-apps dir (not the live dir)
#     4. DELETE /api/installed-apps/elastos-node-manager?purge=false — keeps
#        externalDataDirs (chain data + keystore + audit log live there).
#     5. POST /api/installed-apps/install-local — same call as fresh install.
#     6. Health check. On failure, the operator deploys the previous tag.
#
# Usage:
#   sudo ./deploy-enm.sh                     # latest tagged release
#   sudo ./deploy-enm.sh enm-v0.1.0-alpha.4  # specific tag
#
# Auth (REQUIRED for both fresh install AND upgrade since 2026-05-11):
#   PC2_OWNER_TOKEN   the owner's Bearer token. Grab it from your PC2
#                     desktop URL — the ?puter.auth.token=... query string.
#                     Upgrade used to skip this (file-overlay + PID kill)
#                     but pc2-node's boot sweeper reaps file-overlay
#                     bundles as "stale auto-installed", so both paths
#                     now go through /api/installed-apps/install-local.
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

# 0.2.0-alpha.12 — node_modules integrity check. The CI bundle SHOULD have
# every transitive dep, but install-local's copyDirRecursive has been
# observed to silently drop files under load (the operator's 2026-05-12
# trace showed `Cannot find module 'array-flatten'` after install-local
# claimed success). To be resilient, we run `npm install --omit=dev` on
# the staged dir before handing it to install-local. If npm is missing,
# we at least flag the missing key dep so the operator knows.
#
# Cost: ~30-60s of extra deploy time. Worth it to avoid crash-loops that
# end in pc2-node quarantining the app.
verify_node_modules() {
    local stage="$1"
    local backend_dir="$stage/backend"
    if [ ! -d "$backend_dir" ]; then
        log "WARN: $backend_dir not found — skipping node_modules check"
        return 0
    fi

    # Sentinel: array-flatten is Express's narrowest transitive dep. If
    # it's missing, the bundle is incomplete and ENM will ENOENT on the
    # first router.use() call (which Express lazy-loads route.js for,
    # which requires array-flatten). Other sentinels could be picked
    # (body-parser, etc.) — array-flatten is small + load-bearing.
    if [ -d "$backend_dir/node_modules/array-flatten" ]; then
        log "node_modules looks complete (array-flatten sentinel present)"
        return 0
    fi

    log "WARN: node_modules missing array-flatten — bundle from CI was incomplete"
    if command -v npm >/dev/null 2>&1; then
        log "running npm install --omit=dev to heal (this can take ~60s)…"
        if (cd "$backend_dir" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -8); then
            if [ -d "$backend_dir/node_modules/array-flatten" ]; then
                log "node_modules healed — array-flatten present after npm install"
            else
                die "npm install completed but array-flatten still missing — investigate package-lock.json"
            fi
        else
            die "npm install failed in $backend_dir — ENM cannot start without complete node_modules"
        fi
    else
        die "node_modules incomplete + npm not on PATH. Install Node 20.x first: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    fi
}

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

    verify_node_modules "$TMP_EXTRACT"

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
# Upgrade — DELETE the old install via pc2-node API, then install the new
# bundle via /api/installed-apps/install-local.
#
# The previous upgrade path (kill PID + file-overlay tarball extract over the
# live BUNDLE_DIR) seemed cheap but had a load-bearing bug: pc2-node's boot
# sweeper labels file-overlay installs as "stale auto-installed bundle" and
# uninstalls them, then the next AppProcessManager hydrate tick crashes the
# app to quarantine within ~70ms (count rises to 4 → quarantined; manual
# clearQuarantine required). After alpha.18→alpha.18 trial 2026-05-11 hit
# this on the test server, the path was rewritten to register through the
# supervisor API the same way the fresh install does.
#
# Chain data + keystore + audit log live in externalDataDirs (the
# /var/lib/pc2/data/extensions/elastos-node-manager/ tree) — those survive
# a DELETE ?purge=false because pc2-node only wipes externalDataDirs when
# purge=true. So an upgrade preserves all node state; only the bundle JS +
# the installed_apps row are swapped.
# =============================================================================
if [ "$MODE" = "upgrade" ]; then
    [ -n "${PC2_OWNER_TOKEN:-}" ] || die "upgrade requires PC2_OWNER_TOKEN. pc2-node's boot sweeper reaps file-overlay installs; the new upgrade flow calls /api/installed-apps DELETE + install-local, which need the owner's Bearer token (PC2 desktop URL: ?puter.auth.token=...)."

    BACKUP_PATH="/tmp/enm-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    log "backing up current bundle to $BACKUP_PATH (diagnostic only — rollback uses deploy-enm.sh <prev-tag>)"
    tar czf "$BACKUP_PATH" -C "$BUNDLE_DIR" . || die "backup failed" 3

    # Stage the new bundle in test-apps (install-local's safe-list).
    PC2_TEST_APPS_DIR="${PC2_TEST_APPS_DIR:-/var/lib/pc2/data/test-apps}"
    mkdir -p "$PC2_TEST_APPS_DIR"
    TMP_EXTRACT=$(mktemp -d -p "$PC2_TEST_APPS_DIR")
    log "extracting new bundle into $TMP_EXTRACT"
    tar -C "$TMP_EXTRACT" -xzf "$TMP_TARBALL" || die "extract failed" 3

    verify_node_modules "$TMP_EXTRACT"

    # Uninstall the old version (purge=false → keeps externalDataDirs so
    # chain data and keystore survive the swap).
    log "uninstalling old version via DELETE /api/installed-apps/elastos-node-manager?purge=false"
    UN_RESP=$(curl -sS -X DELETE \
        "http://127.0.0.1:${PC2_PORT}/api/installed-apps/elastos-node-manager?purge=false" \
        -H "Authorization: Bearer ${PC2_OWNER_TOKEN}" 2>&1)
    # DELETE can legitimately return 404 (sweeper already reaped the row) —
    # don't die. install-local below recovers either way.
    if echo "$UN_RESP" | jq -e '.error' >/dev/null 2>&1; then
        log "DELETE returned: $(echo "$UN_RESP" | jq -r '.error') — continuing with install-local"
    else
        log "old version uninstalled"
    fi

    # Install the new bundle. This is the same call the fresh-install path
    # makes — it registers with the supervisor so the boot sweeper leaves it
    # alone next time pc2-node restarts.
    log "calling pc2-node /api/installed-apps/install-local"
    BODY=$(jq -n \
        --slurpfile manifest "$TMP_MANIFEST" \
        --arg localDir "$TMP_EXTRACT" \
        '{ manifest: $manifest[0], localDir: $localDir }')
    RESP=$(curl -sS -X POST "http://127.0.0.1:${PC2_PORT}/api/installed-apps/install-local" \
        -H "Authorization: Bearer ${PC2_OWNER_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "$BODY") || die "install-local request failed (is pc2-node running on :${PC2_PORT}?)" 3

    if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
        die "install-local rejected: $(echo "$RESP" | jq -r '.error')" 3
    fi
    APP_NAME=$(echo "$RESP" | jq -r '.app.app_name // .app.name // "elastos-node-manager"')
    log "pc2-node reinstalled '$APP_NAME' and (re)started the backend"
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

# Health didn't come back. Both modes now go through install-local, so the
# right recovery on failure is "deploy the previous tag" — the old "untar
# the backup over the live dir" trick (used until 2026-05-11) leaves the
# install in a state pc2-node's boot sweeper later reaps as stale.
die "$MODE failed: ENM never came up on :$ENM_PORT. To restore the previous version, run:
    sudo PC2_OWNER_TOKEN=<token> $0 <previous-tag>
Diagnostic bundle: $BACKUP_PATH (untouched by the failed deploy).
Check 'journalctl -u pc2-node -n 200' and 'tail -200 /var/log/pc2-node.log' for the spawn-time error." 4
