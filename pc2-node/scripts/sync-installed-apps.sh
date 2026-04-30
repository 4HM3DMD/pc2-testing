#!/usr/bin/env bash
#
# sync-installed-apps.sh
#
# pc2-node serves static app content from data/installed-apps/<app>/.
# Authoritative source lives in data/test-apps/<app>/ and must be
# copied into installed-apps/ for the node to serve the latest code.
# data/installed-apps/ is gitignored (pc2-node/.gitignore:42, data/*)
# so this is purely a local-state refresh.
#
# Background: a full afternoon of MTK/Irzhy debugging was burned because
# the v=6-pipelined player shipped in test-apps/ was not visible to the
# browser, which was fetching player.js?v=5-sigauth-2 served from the
# older installed-apps/ copy. Run this script after any edit under
# data/test-apps/ to avoid that trap.
#
# Scope (intentionally narrow): only the two apps touched by the
# download-first buy flow. Extend here when other apps change.
#
# Usage:
#   pc2-node/scripts/sync-installed-apps.sh          # default: dry-run list
#   pc2-node/scripts/sync-installed-apps.sh --apply  # actually copy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "${SCRIPT_DIR}/../data" && pwd)"
TEST_APPS="${DATA_DIR}/test-apps"
INSTALLED_APPS="${DATA_DIR}/installed-apps"

APPS=(
  "elacity-market"
  "pc2-media-runtime"
)

MODE="dry-run"
if [[ "${1:-}" == "--apply" ]]; then
  MODE="apply"
fi

echo "Source:     ${TEST_APPS}"
echo "Target:     ${INSTALLED_APPS}"
echo "Mode:       ${MODE}"
echo

copied_count=0
missing_count=0

for app in "${APPS[@]}"; do
  src="${TEST_APPS}/${app}"
  dst="${INSTALLED_APPS}/${app}"

  if [[ ! -d "${src}" ]]; then
    echo "  [skip] ${app} — source does not exist"
    missing_count=$((missing_count + 1))
    continue
  fi

  if [[ ! -d "${dst}" ]]; then
    echo "  [skip] ${app} — target does not exist (app not installed locally)"
    missing_count=$((missing_count + 1))
    continue
  fi

  echo "  [sync] ${app}"
  if [[ "${MODE}" == "apply" ]]; then
    # rsync -a: preserve timestamps/perms; --update: skip if target is newer;
    # trailing slash on source so rsync copies contents, not the dir itself.
    # Preserves target-only files (runtime state) since we don't pass --delete.
    rsync -a --update "${src}/" "${dst}/"
    copied_count=$((copied_count + 1))
  fi
done

echo
if [[ "${MODE}" == "apply" ]]; then
  echo "Done. Synced ${copied_count} app(s). Skipped ${missing_count} (source or target missing)."
  echo "Reminder: close any open app windows so the browser reloads the iframe."
else
  echo "Dry-run only. Re-run with --apply to perform the copy."
fi
