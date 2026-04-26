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

# Authoritative supernode (registry.json source of truth). Contabo mirrors
# from this URL via cron every 5 minutes (see /root/pc2/app-registry/sync-registry.sh).
# We do NOT push directly to Contabo — its mirror cron would overwrite us
# anyway. Instead we trigger the mirror's sync script manually after pushing
# to InterServer for instant convergence.
PRIMARY_SUPERNODE="${PRIMARY_SUPERNODE:-root@69.164.241.210}"
MIRROR_SUPERNODE="${MIRROR_SUPERNODE:-root@38.242.211.112}"
MIRROR_SYNC_SCRIPT="/root/pc2/app-registry/sync-registry.sh"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/id_ed25519}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
[ -f "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)

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

# 2. Pre-flight: confirm SSH works to both hosts before we touch anything.
PRIMARY_HOST="${PRIMARY_SUPERNODE#*@}"
MIRROR_HOST="${MIRROR_SUPERNODE#*@}"
for target in "$PRIMARY_SUPERNODE" "$MIRROR_SUPERNODE"; do
  log "checking ssh ${BOLD}${target}${RESET}..."
  ssh "${SSH_OPTS[@]}" "$target" 'echo ok' >/dev/null \
    || fail "ssh to $target failed (no key? wrong user? firewall?). Set SSH_KEY/PRIMARY_SUPERNODE/MIRROR_SUPERNODE env or fix SSH and retry."
done

# 3. Deploy to primary (InterServer)
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
log "deploying registry.json to PRIMARY ${BOLD}${PRIMARY_SUPERNODE}${RESET}"

# Backup existing file (if any) before overwriting.
ssh "${SSH_OPTS[@]}" "$PRIMARY_SUPERNODE" "
  set -e
  mkdir -p /root/pc2/app-registry
  if [ -f '$REMOTE_PATH' ]; then
    cp '$REMOTE_PATH' '${REMOTE_PATH}.bak-${TIMESTAMP}'
  fi
"

# Atomic upload: scp to .new, then mv into place.
scp "${SSH_OPTS[@]}" -q "$LOCAL_REGISTRY" "${PRIMARY_SUPERNODE}:${REMOTE_PATH}.new" \
  || fail "scp to $PRIMARY_SUPERNODE failed"

ssh "${SSH_OPTS[@]}" "$PRIMARY_SUPERNODE" "mv '${REMOTE_PATH}.new' '$REMOTE_PATH'" \
  || fail "atomic mv on $PRIMARY_SUPERNODE failed"

log "  uploaded → ${REMOTE_PATH} (backup kept: ${REMOTE_PATH}.bak-${TIMESTAMP})"

# Verify via the primary's own health endpoint. Server hot-reloads on mtime
# change; give it 1-2s to stat.
sleep 1
HEALTH="$(curl -fsS --max-time 6 "http://${PRIMARY_HOST}:4500/api/registry/health" || echo '{}')"
REMOTE_COUNT="$(echo "$HEALTH" | node -e "
  let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
    try { console.log(JSON.parse(buf).apps || 0); } catch { console.log(0); }
  });
")"

if [ "$REMOTE_COUNT" = "$EXPECTED_COUNT" ]; then
  log "  ${GREEN}✓${RESET} primary health: $REMOTE_COUNT apps (matches local)"
else
  warn "  primary health mismatch: remote reports $REMOTE_COUNT apps, local has $EXPECTED_COUNT (may need 1-2s longer to hot-reload)"
fi

# 4. Trigger mirror sync on Contabo immediately so we don't wait up to 5 min
# for the next cron tick. The sync script pulls from the primary's HTTP
# endpoint, so this is a pure read against the freshly-deployed registry.
log ""
log "triggering mirror sync on ${BOLD}${MIRROR_SUPERNODE}${RESET}..."
ssh "${SSH_OPTS[@]}" "$MIRROR_SUPERNODE" "bash $MIRROR_SYNC_SCRIPT && echo OK" >/dev/null \
  || warn "mirror sync trigger failed — Contabo will pick it up within 5 min via its */5 cron anyway"

sleep 1
MIRROR_HEALTH="$(curl -fsS --max-time 6 "http://${MIRROR_HOST}:4500/api/registry/health" || echo '{}')"
MIRROR_COUNT="$(echo "$MIRROR_HEALTH" | node -e "
  let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
    try { console.log(JSON.parse(buf).apps || 0); } catch { console.log(0); }
  });
")"
if [ "$MIRROR_COUNT" = "$EXPECTED_COUNT" ]; then
  log "  ${GREEN}✓${RESET} mirror health: $MIRROR_COUNT apps (in sync)"
else
  warn "  mirror reports $MIRROR_COUNT apps (expected $EXPECTED_COUNT) — wait up to 5 min for next cron, or re-run trigger"
fi

# 5. End-to-end verification: fetch the actual /apps payload from primary
# and confirm the v1.2 entries with CIDs are visible.
log ""
log "verifying v1.2 entries are queryable end-to-end..."
APPS_JSON="$(curl -fsS --max-time 8 "http://${PRIMARY_HOST}:4500/api/registry/apps")"
SIGNED_COUNT="$(echo "$APPS_JSON" | node -e "
  let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
    const r = JSON.parse(buf);
    const signed = (r.apps || []).filter(a => a.distribution?.cid && a.distribution?.signature);
    console.log(signed.length);
    signed.forEach(a => console.error('  - ' + a.name.padEnd(20) + ' v' + a.version + ' cid=' + a.distribution.cid));
  });
")"
log "  ${GREEN}✓${RESET} ${SIGNED_COUNT} signed entries visible at ${PRIMARY_HOST}:4500"

log ""
log "${BOLD}done.${RESET}"
log "PC2 nodes will pick up the new catalog within 5 min (registry cache TTL),"
log "or restart pc2-node to refresh immediately."
log ""
log "${YELLOW}Next:${RESET} run install-pinning.sh on EACH supernode (both InterServer"
log "and Contabo, since pin sets are local to each kubo daemon) so the bundle"
log "bytes are actually retrievable when users click Install."
