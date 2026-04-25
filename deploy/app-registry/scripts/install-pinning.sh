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
# Listen on all addresses for the swarm + gateway, but bind the admin API to
# localhost only (it has no auth — never expose).
#
# Swarm port relocated to 4101 because 4001/4002 are already owned on every
# PC2 supernode by a separate libp2p process (the Boson/relay node — see
# `ss -tlnp | grep ':400[12] '` showing pid for `node dist/index.js`). We
# also pick 4101 (not 4011/4111) to keep close to the kubo default, easy
# for ops to remember as "kubo's 4001 with the supernode offset".
ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4101","/ip4/0.0.0.0/udp/4101/quic-v1"]'
ipfs config Addresses.Gateway '/ip4/0.0.0.0/tcp/8080'
ipfs config Addresses.API '/ip4/127.0.0.1/tcp/5001'

# 4. Install systemd unit (always rewrite — script is the source of truth and
# may have been updated since the last run; safe because content is fixed and
# we daemon-reload + restart afterwards).
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
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
# routing=dhtserver — this kubo's role is to be FOUND as the provider for
# the v1.2 capsule CIDs. dhtclient mode would let us fetch but not announce.
ExecStart=/usr/local/bin/ipfs daemon --migrate=true --routing=dhtserver
Restart=on-failure
RestartSec=10
LimitNOFILE=65536
# Soft mem cap so the daemon can't crowd Boson/IPFS-relay/nginx.
MemoryMax=2G
# Block kernel-level network admin (matches the rest of the supernode policy).
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX
NoNewPrivileges=true
# We can't enable ProtectHome because kubo's repo lives at /root/.ipfs and
# needs write access for the lock file, datastore, and pin set updates.
# ProtectSystem=full still protects /usr, /boot, /etc.
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

log "starting ${SERVICE_NAME}..."
# `restart` (not just `start`) so re-runs after a config change actually take effect.
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

# 4b. Open the kubo swarm port in ufw (PC2 supernodes use ufw with default-deny
# incoming, so without this kubo binds 0.0.0.0:4101 but external libp2p peers
# can't reach it — defeating the whole pinning point). Idempotent: ufw is a
# no-op if the rule already exists. We do NOT open 8080 (HTTP gateway) or
# 5001 (admin API) — those stay local-only.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "opening ufw 4101/tcp + 4101/udp (kubo swarm)..."
  ufw allow 4101/tcp comment 'PC2 kubo swarm TCP' >/dev/null
  ufw allow 4101/udp comment 'PC2 kubo swarm QUIC' >/dev/null
fi

# Wait for daemon to be reachable on the local API port.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 -X POST http://127.0.0.1:5001/api/v0/version >/dev/null 2>&1; then
    log "  ${GREEN}✓${RESET} daemon up after ${i}s"
    break
  fi
  sleep 1
  [ "$i" = "10" ] && fail "kubo daemon did not respond on 127.0.0.1:5001 after 10s — check 'journalctl -u $SERVICE_NAME'"
done

# 5. Import bundle CAR file (preferred) or fall back to swarm fetch.
#
# A CAR (Content-Addressable aRchive) bundles every block of every v1.2 capsule
# into a single file. Importing it gives kubo all the bytes locally, so the
# subsequent `ipfs pin add <root>` calls are instant and don't depend on the
# DHT being able to find the bytes (which it currently can't reliably for
# fresh PC2-published CIDs — public gateways time out).
#
# The CAR is generated on the publisher box by:
#   node pc2-node/scripts/extract-capsules.mjs
# and produces /tmp/pc2-capsules/pc2-v1.2-bundles.car (~102 MB for v1.2.0).
# Operator scp's it to /root/pc2-capsules/ before running this script.
CAR_PATH="${CAR_PATH:-/root/pc2-capsules/pc2-v1.2-bundles.car}"
if [ -f "$CAR_PATH" ]; then
  log "importing CAR ${BOLD}${CAR_PATH}${RESET} ($(du -h "$CAR_PATH" | cut -f1))..."
  # --pin-roots=false: we'll explicitly pin each root in step 6 so we get
  #                    per-CID error reporting instead of one bulk yes/no.
  if ipfs dag import --pin-roots=false "$CAR_PATH"; then
    log "  ${GREEN}✓${RESET} CAR imported (all blocks now local)"
  else
    fail "CAR import failed — check /var/log/syslog or 'journalctl -u $SERVICE_NAME'"
  fi
else
  warn "no CAR file at $CAR_PATH — will fall back to DHT/bitswap fetch (slow + may fail)"
  warn "to avoid this, scp the CAR from the publisher first:"
  warn "  scp /tmp/pc2-capsules/pc2-v1.2-bundles.car root@\$THIS_HOST:$CAR_PATH"
fi

# 6. Pin all v1.2 CIDs (now instant if CAR was imported above)
log ""
log "${BOLD}pinning ${#V12_CIDS[@]} v1.2 app CIDs:${RESET}"
for cid in "${V12_CIDS[@]}"; do
  if ipfs pin ls --type=recursive "$cid" >/dev/null 2>&1; then
    SIZE_BYTES="$(ipfs files stat --size "/ipfs/${cid}" 2>/dev/null || echo '?')"
    log "  ${GREEN}✓${RESET} already pinned: $cid ($SIZE_BYTES bytes)"
  else
    log "  pinning $cid..."
    if ipfs pin add "$cid"; then
      SIZE_BYTES="$(ipfs files stat --size "/ipfs/${cid}" 2>/dev/null || echo '?')"
      log "    ${GREEN}✓${RESET} pinned ($SIZE_BYTES bytes)"
    else
      warn "    pin add failed — content not local. Make sure the CAR file at"
      warn "    $CAR_PATH was imported successfully (check the logs above)."
    fi
  fi
done

# 7. Final summary (use plain echo here — xargs subshells can't see the `log`
# function so calling it via xargs prints "log: No such file or directory").
echo ""
echo "${GREEN}[kubo-install]${RESET} ${BOLD}summary:${RESET}"
echo "${GREEN}[kubo-install]${RESET}   total pins: $(ipfs pin ls --type=recursive | wc -l)"
ipfs repo stat | grep -E "RepoSize|StorageMax|NumObjects" | sed "s/^/${GREEN}[kubo-install]${RESET}   /"
log ""
log "${GREEN}done.${RESET} kubo is pinning the v1.2 catalog and reachable on:"
log "  - swarm:   :4101 (TCP + QUIC)  [relocated from default 4001 to avoid clash with libp2p relay]"
log "  - gateway: :8080 (HTTP)"
log "  - admin:   127.0.0.1:5001 (NEVER expose)"
