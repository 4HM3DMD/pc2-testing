#!/usr/bin/env bash
#
# Deploy registry.json to both PC2 supernodes.
#
# What it does (idempotent):
#   1. Validates registry.json is well-formed JSON locally.
#   2. scp's registry.json to /root/pc2/app-registry/registry.json on each
#      supernode listed below.
#   3. The pc2-app-registry systemd service hot-reloads on mtime change —
#      no `systemctl restart` needed; just a 5-min cache TTL on the PC2 node
#      side before clients pick up the new entries.
#   4. Verifies via `curl http://<sn>:4500/api/registry/health` that the
#      app count matches what we just shipped.
#
# Pre-reqs on YOUR LAPTOP:
#   - SSH key access to root@69.164.241.210 (InterServer)
#   - SSH key access to root@38.242.211.112 (Contabo)
#   - `jq` and `curl` installed
#
# Override SSH user / hosts via env:
#   SUPERNODES="root@host1,root@host2" ./deploy.sh
#
# Safety:
#   - Bails on the first ssh/scp failure so we never half-deploy.
#   - Atomic write on the remote via mv from a temp file.
#   - Keeps a timestamped backup at registry.json.bak-<ts> on each supernode.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL_REGISTRY="${REPO_ROOT}/deploy/app-registry/registry.json"
REMOTE_PATH="/root/pc2/app-registry/registry.json"

DEFAULT_SUPERNODES="root@69.164.241.210,root@38.242.211.112"
SUPERNODES="${SUPERNODES:-$DEFAULT_SUPERNODES}"

# Pretty
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

log()  { echo "${GREEN}[deploy]${RESET} $*"; }
warn() { echo "${YELLOW}[warn]${RESET}   $*"; }
fail() { echo "${RED}[fail]${RESET}   $*"; exit 1; }

# 1. Validate locally
[ -f "$LOCAL_REGISTRY" ] || fail "missing local registry: $LOCAL_REGISTRY"
EXPECTED_COUNT="$(node -e "console.log(require('$LOCAL_REGISTRY').apps.length)")" || fail "registry.json is not valid JSON"
EXPECTED_VERSION="$(node -e "console.log(require('$LOCAL_REGISTRY').version)")"
log "local registry: $EXPECTED_COUNT apps, version $EXPECTED_VERSION"

# 2. Pre-flight: confirm SSH works to each host before we touch anything.
IFS=',' read -ra TARGETS <<< "$SUPERNODES"
for target in "${TARGETS[@]}"; do
  host="${target#*@}"
  log "checking ssh ${BOLD}${target}${RESET}..."
  ssh -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$target" 'echo ok' >/dev/null \
    || fail "ssh to $target failed (no key? wrong user? firewall?). Set SUPERNODES env or fix SSH and retry."
done

# 3. Deploy
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
for target in "${TARGETS[@]}"; do
  host="${target#*@}"
  log "deploying to ${BOLD}${target}${RESET}"

  # Backup existing file (if any) before overwriting.
  ssh -o BatchMode=yes "$target" "
    set -e
    mkdir -p /root/pc2/app-registry
    if [ -f '$REMOTE_PATH' ]; then
      cp '$REMOTE_PATH' '${REMOTE_PATH}.bak-${TIMESTAMP}'
    fi
  "

  # Atomic upload: scp to .new, then mv into place.
  scp -o BatchMode=yes -q "$LOCAL_REGISTRY" "${target}:${REMOTE_PATH}.new" \
    || fail "scp to $target failed"

  ssh -o BatchMode=yes "$target" "mv '${REMOTE_PATH}.new' '$REMOTE_PATH'" \
    || fail "atomic mv on $target failed"

  log "  uploaded → ${REMOTE_PATH} (backup: ${REMOTE_PATH}.bak-${TIMESTAMP})"

  # Verify via the supernode's own health endpoint.
  # The pc2-app-registry server hot-reloads on mtime; give it 1s to stat.
  sleep 1
  HEALTH="$(curl -fsS --max-time 6 "http://${host}:4500/api/registry/health" || echo '{}')"
  REMOTE_COUNT="$(echo "$HEALTH" | node -e "
    let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
      try { console.log(JSON.parse(buf).apps || 0); } catch { console.log(0); }
    });
  ")"

  if [ "$REMOTE_COUNT" = "$EXPECTED_COUNT" ]; then
    log "  ${GREEN}✓${RESET} health: $REMOTE_COUNT apps (matches local)"
  else
    warn "  health mismatch: remote reports $REMOTE_COUNT apps, local has $EXPECTED_COUNT (may need 1-2s longer to hot-reload)"
  fi
done

# 4. End-to-end verification: fetch the actual /apps payload and confirm
# the v1.2 entries with CIDs are visible from at least one supernode.
log ""
log "verifying v1.2 entries are queryable end-to-end..."
FIRST_HOST="${TARGETS[0]#*@}"
APPS_JSON="$(curl -fsS --max-time 8 "http://${FIRST_HOST}:4500/api/registry/apps")"
SIGNED_COUNT="$(echo "$APPS_JSON" | node -e "
  let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
    const r = JSON.parse(buf);
    const signed = (r.apps || []).filter(a => a.distribution?.cid && a.distribution?.signature);
    console.log(signed.length);
    signed.forEach(a => console.error('  - ' + a.name.padEnd(20) + ' v' + a.version + ' cid=' + a.distribution.cid));
  });
")"
log "  ${GREEN}✓${RESET} ${SIGNED_COUNT} signed entries visible at ${FIRST_HOST}:4500"

log ""
log "${BOLD}done.${RESET}"
log "PC2 nodes will pick up the new catalog within 5 min (registry cache TTL),"
log "or restart pc2-node to refresh immediately."
log ""
log "${YELLOW}Next:${RESET} run install-pinning.sh on each supernode so the bundle bytes"
log "are actually retrievable when users click Install."
