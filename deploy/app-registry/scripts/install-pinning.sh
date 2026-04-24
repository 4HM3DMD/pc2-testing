#!/usr/bin/env bash
#
# Install kubo (IPFS daemon) on a PC2 supernode and pin the v1.2 app CIDs.
#
# Run this ON THE SUPERNODE itself (after `ssh root@<supernode-ip>`).
# Or invoke remotely:
#   ssh root@<supernode-ip> 'bash -s' < install-pinning.sh
#
# What it does (idempotent):
#   1. Installs kubo v0.34.1 if not already present.
#   2. Initialises ~/.ipfs if needed (server profile + 8 GB max storage).
#   3. Configures conservative resource limits (we share the box with
#      Boson DHT, IPFS relay, web gateway, app registry, nginx).
#   4. Installs a systemd unit `pc2-kubo` and starts it.
#   5. Pins the 6 v1.2 app CIDs.
#   6. Connects to the PC2 IPFS relay running locally (port 4003) so the
#      pinned content is announced via the same DHT the rest of the network
#      is using.
#   7. Verifies each CID is present and reports its size.
#
# Why kubo (not Helia)?
#   The supernode needs a long-running daemon with `pin add` semantics, real
#   garbage collection, and the standard `/api/v0` HTTP API for ops scripts.
#   Helia is great for embedded use (PC2 nodes use it), but kubo is the right
#   shape for a server pinning role.
#
# Resource budget on the supernode:
#   - kubo daemon: ~300 MB RSS at idle, ~1.5 GB during heavy fetch
#   - storage: capped at 8 GB (StorageMax), enough for 100x the current
#     app catalog
#   - bandwidth: no caps (relies on existing nginx-level rate limits)

set -euo pipefail

KUBO_VERSION="0.34.1"
KUBO_PROFILE="server"           # disables NAT punching, mDNS — we're on a public IP
KUBO_STORAGE_MAX="8GB"
SERVICE_NAME="pc2-kubo"

# v1.2 app CIDs to pin. KEEP IN SYNC with pc2-node/registry/v1.2/_index.json.
# When new apps are signed via package-app.ts, append their CIDs here and
# re-run this script — `ipfs pin add` is idempotent.
V12_CIDS=(
  "bafybeiczcdan4j7zfw2ychjgzco4y4lbb5mqceezxfl5h7f3koau7t6x5y"  # elacity-market
  "bafybeidhttd3uozgo3odpcvs3hvmrsbo2pgrbce6srum65y5qfzzvzztxy"  # elacity-creator
  "bafybeifbgkjmgnwvddgntdihvssvyncj5xml2ft6qi3dr3hellgf7wgxbi"  # elacity-player
  "bafkreicswjb7mvwdgauwd6dhw7ryirndxfraocjo2avn53vfs24oo7jeua"  # ddrm-viewer
  "bafybeich5bmanb3nx65scjcv3rp3wjcge4np6von6ybwrp7xsob7llczdy"  # elastos-nft
  "bafybeib6jbeosgudsbilc2bhlkbycnhuvdxwc5zfp22dmbsniknxddwvzq"  # glide-finance
)

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
log()  { echo "${GREEN}[kubo-install]${RESET} $*"; }
warn() { echo "${YELLOW}[warn]${RESET}          $*"; }
fail() { echo "${RED}[fail]${RESET}          $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (try: sudo bash $0)"

# 1. Install kubo if missing
if ! command -v ipfs >/dev/null 2>&1; then
  log "installing kubo v${KUBO_VERSION}..."
  cd /tmp
  curl -fsSL "https://dist.ipfs.tech/kubo/v${KUBO_VERSION}/kubo_v${KUBO_VERSION}_linux-amd64.tar.gz" -o kubo.tar.gz
  tar -xzf kubo.tar.gz
  bash kubo/install.sh
  rm -rf kubo kubo.tar.gz
else
  log "kubo already installed: $(ipfs --version)"
fi

# 2. Initialise ~/.ipfs once
if [ ! -d /root/.ipfs ]; then
  log "ipfs init --profile=${KUBO_PROFILE}..."
  ipfs init --profile="$KUBO_PROFILE"
else
  log "/root/.ipfs already exists, skipping init"
fi

# 3. Configure resource limits
log "applying config: StorageMax=${KUBO_STORAGE_MAX}, GC=enabled"
ipfs config Datastore.StorageMax "$KUBO_STORAGE_MAX"
ipfs config --json Datastore.GCPeriod '"1h"'
# Listen on all addresses for both the swarm and gateway, but bind the
# admin API to localhost only (it has no auth — never expose).
ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001","/ip4/0.0.0.0/udp/4001/quic-v1"]'
ipfs config Addresses.Gateway '/ip4/0.0.0.0/tcp/8080'
ipfs config Addresses.API '/ip4/127.0.0.1/tcp/5001'

# 4. Install systemd unit
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
if [ ! -f "$SERVICE_FILE" ] || ! grep -q "kubo daemon for PC2 supernode" "$SERVICE_FILE"; then
  log "writing ${SERVICE_FILE}"
  cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=kubo daemon for PC2 supernode (pins app registry CIDs)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=root
Environment=IPFS_PATH=/root/.ipfs
ExecStart=/usr/local/bin/ipfs daemon --migrate=true --routing=dhtclient
Restart=on-failure
RestartSec=10
LimitNOFILE=65536
# Soft mem cap so the daemon can't crowd Boson/IPFS-relay/nginx.
MemoryMax=2G
# Block kernel-level network admin (matches the rest of the supernode policy).
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
fi

log "starting ${SERVICE_NAME}..."
systemctl enable --now "$SERVICE_NAME"

# Wait for daemon to be reachable on the local API port.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 -X POST http://127.0.0.1:5001/api/v0/version >/dev/null 2>&1; then
    log "  ${GREEN}✓${RESET} daemon up after ${i}s"
    break
  fi
  sleep 1
  [ "$i" = "10" ] && fail "kubo daemon did not respond on 127.0.0.1:5001 after 10s — check 'journalctl -u $SERVICE_NAME'"
done

# 5. Connect to local PC2 IPFS relay (so DHT announces are amplified
# through the same circuit-relay mesh PC2 nodes are already using).
RELAY_PEER_ID="$(curl -fsS --max-time 4 "http://127.0.0.1:4003/peer-id" 2>/dev/null || echo '')"
if [ -n "$RELAY_PEER_ID" ]; then
  log "connecting to local pc2-ipfs-relay peer ${RELAY_PEER_ID}..."
  ipfs swarm connect "/ip4/127.0.0.1/tcp/4003/p2p/${RELAY_PEER_ID}" || warn "  swarm connect failed (relay may not be listening on /peer-id; safe to ignore)"
else
  warn "could not discover pc2-ipfs-relay peer ID (no /peer-id endpoint); kubo will still announce via the public DHT"
fi

# 6. Pin all v1.2 CIDs
log ""
log "${BOLD}pinning ${#V12_CIDS[@]} v1.2 app CIDs:${RESET}"
for cid in "${V12_CIDS[@]}"; do
  if ipfs pin ls --type=recursive "$cid" >/dev/null 2>&1; then
    SIZE_BYTES="$(ipfs files stat --size "/ipfs/${cid}" 2>/dev/null || echo '?')"
    log "  ${GREEN}✓${RESET} already pinned: $cid ($SIZE_BYTES bytes)"
  else
    log "  fetching + pinning $cid..."
    if ipfs pin add --progress "$cid"; then
      SIZE_BYTES="$(ipfs files stat --size "/ipfs/${cid}" 2>/dev/null || echo '?')"
      log "    ${GREEN}✓${RESET} pinned ($SIZE_BYTES bytes)"
    else
      warn "    pin add failed — content may not have propagated to the DHT yet."
      warn "    if this is a brand-new publish, run this script again in 60s, or"
      warn "    bridge from the publisher's node: 'ipfs swarm connect <publisher-multiaddr>'"
    fi
  fi
done

# 7. Final summary
log ""
log "${BOLD}summary:${RESET}"
ipfs pin ls --type=recursive | wc -l | xargs -I {} log "  total pins: {}"
ipfs repo stat | grep -E "RepoSize|StorageMax|NumObjects" | sed 's/^/  /'
log ""
log "${GREEN}done.${RESET} kubo is pinning the v1.2 catalog and reachable on:"
log "  - swarm:   :4001 (TCP + QUIC)"
log "  - gateway: :8080 (HTTP)"
log "  - admin:   127.0.0.1:5001 (NEVER expose)"
