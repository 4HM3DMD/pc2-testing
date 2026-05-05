#!/bin/bash
#
# enm-server — one-line installer.
#
# Adds the Elastos Node Manager sidecar to an existing PC2 install. Pulls the
# prebuilt enm-server image from GitHub Container Registry, edits the
# operator's `~/pc2/docker-compose.yml` to add an `enm-server` service that
# read-only-mounts pc2-node's data dir, brings the stack up, opens UFW.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/4HM3DMD/pc2-testing/main/enm-server/scripts/install-enm.sh | bash
#
# With overrides:
#   curl -sSL .../install-enm.sh | bash -s -- --port 4180 --pc2-dir /opt/pc2

set -euo pipefail

PC2_DIR="${PC2_DIR:-$HOME/pc2}"
ENM_PORT="${ENM_PORT:-4180}"
ENM_IMAGE="${ENM_IMAGE:-ghcr.io/4hm3dmd/enm-server:latest}"
EXPOSE_BPOS="${EXPOSE_BPOS:-1}"   # 1 = expose 20338+20339 publicly (BPoS); 0 = loopback only

while [[ $# -gt 0 ]]; do
    case $1 in
        --port)     ENM_PORT="$2"; shift 2 ;;
        --pc2-dir)  PC2_DIR="$2"; shift 2 ;;
        --image)    ENM_IMAGE="$2"; shift 2 ;;
        --no-bpos)  EXPOSE_BPOS=0; shift ;;
        --help|-h)
            cat <<EOF
ENM (Elastos Node Manager) sidecar installer

Adds an enm-server container to your existing PC2 install.

Options:
  --port N          ENM API port (default: 4180)
  --pc2-dir PATH    Existing PC2 install dir (default: \$HOME/pc2)
  --image NAME      Override image (default: ghcr.io/4hm3dmd/enm-server:latest)
  --no-bpos         Bind ela P2P/DPoS ports (20338, 20339) to loopback only.
                    Use for full-node mode. Default exposes them publicly so
                    BPoS supernode peers can dial in.

Pre-reqs:
  - PC2 already installed (\$PC2_DIR/docker-compose.yml exists)
  - PC2 owner already claimed (you've completed wallet-claim on dashboard)
EOF
            exit 0
            ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'
say()  { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()   { printf "${GREEN}\xe2\x9c\x93 %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}! %s${NC}\n" "$*"; }
die()  { printf "${RED}\xe2\x9c\x97 %s${NC}\n" "$*" >&2; exit 1; }

# --- Pre-reqs ---------------------------------------------------------------

[[ -d "$PC2_DIR" && -f "$PC2_DIR/docker-compose.yml" ]] \
    || die "PC2 not installed at $PC2_DIR. Install PC2 first: scripts/install.sh"

command -v docker >/dev/null 2>&1 \
    || die "docker not installed (PC2 install would have done this — re-run scripts/install.sh first)"

# --- Migrate legacy compose: strip chain ports from pc2 ---------------------
#
# Pre-pivot installs (when the ENM extension lived inside PC2's image) had
# pc2 mapping the chain ports (20336, 20338, 20339, 20333-20335). After the
# split into a separate enm-server container, those mappings belong here, on
# enm-server, not on pc2 — pc2 doesn't run ela. Leaving them on pc2 means
# docker-proxy squats on host:20336 and ela inside enm-server can't bind it,
# and the HostConflictScanner fires F19 every healing tick.
#
# Strip them safely: the regex matches only the exact ela port mappings, so
# pc2's 4100/4200 stay, and any non-ela mapping survives.

cd "$PC2_DIR"

CHAIN_PORTS_RE='^[[:space:]]*-[[:space:]]*"(127\.0\.0\.1:)?(20336|20338|20339|20333|20334|20335):(20336|20338|20339|20333|20334|20335)"[[:space:]]*$'
if grep -qE "$CHAIN_PORTS_RE" docker-compose.yml; then
    say "Migrating legacy pc2 compose: chain ports are moving from pc2 to enm-server"
    cp docker-compose.yml "docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
    sed -i.tmp -E "/$CHAIN_PORTS_RE/d" docker-compose.yml
    # Also drop the comment lines that introduced them (best-effort).
    sed -i -E "/^[[:space:]]*#.*ela.*(JSON-RPC stays on loopback|read-only ports — loopback)/d" docker-compose.yml
    rm -f docker-compose.yml.tmp
    ok "Legacy chain ports stripped from pc2 (backup at docker-compose.yml.bak.*)"
fi

# --- Add enm-server service to compose --------------------------------------

# Decide port-binding strategy. BPoS supernodes need 20338 + 20339 publicly
# reachable so peers can dial in. Full-node operators don't (they can stay
# fully outbound). Toggle with --no-bpos.
if [[ "$EXPOSE_BPOS" == "1" ]]; then
    BPOS_PORTS=$'      - "20338:20338"\n      - "20339:20339"'
else
    BPOS_PORTS=$'      - "127.0.0.1:20338:20338"\n      - "127.0.0.1:20339:20339"'
fi

if grep -q "^  enm-server:" docker-compose.yml; then
    warn "enm-server service already in docker-compose.yml — leaving as-is"
else
    say "Adding enm-server service to $PC2_DIR/docker-compose.yml..."
    cat >> docker-compose.yml <<COMPOSE

  enm-server:
    image: ${ENM_IMAGE}
    container_name: enm-server
    restart: unless-stopped
    depends_on:
      - pc2
    ports:
      - "${ENM_PORT}:4180"
      # ela JSON-RPC stays on loopback by default — operator widens via the
      # ENM dashboard's Settings → Mainchain Advanced → WhiteIPList.
      - "127.0.0.1:20336:20336"
${BPOS_PORTS}
      # ela read-only ports — loopback only.
      - "127.0.0.1:20333:20333"
      - "127.0.0.1:20334:20334"
      - "127.0.0.1:20335:20335"
    volumes:
      # PC2 session DB + node-config (read-only) — auth resolves Bearer
      # tokens against pc2-node's sessions table and reads the owner wallet
      # from pc2-node's node-config.json. We mount the host's pc2-node/
      # subdir directly (NOT the parent ./data) so the inner path inside
      # the enm-server container is /data/pc2-node/pc2.db — what
      # PC2_NODE_DB_PATH defaults to. Mounting ./data here would shadow
      # the path with a nested ./data/pc2-node/pc2-node/ structure.
      - ./data/pc2-node:/data/pc2-node:ro
      # ENM state — own SQLite DB, ela build cache, audit logs
      - ./enm-data:/data/enm
    environment:
      - NODE_ENV=production
      - PORT=4180
      - ENM_DATA_DIR=/data/enm
      - PC2_NODE_DB_PATH=/data/pc2-node/pc2.db
      - PC2_NODE_CONFIG_PATH=/data/pc2-node/node-config.json
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:4180/api/enm/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
COMPOSE
    ok "enm-server service appended (BPoS ports: $([ "$EXPOSE_BPOS" = "1" ] && echo public || echo loopback))"
fi

mkdir -p "$PC2_DIR/enm-data"

# --- Pull + start -----------------------------------------------------------

say "Pulling ${ENM_IMAGE}..."
docker compose pull enm-server
ok "Image pulled"

say "Starting enm-server..."
docker compose up -d enm-server
ok "Container started"

# --- UFW --------------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    say "UFW is active — opening port $ENM_PORT..."
    sudo ufw allow "$ENM_PORT/tcp" >/dev/null
    ok "Opened $ENM_PORT in UFW"
fi

# --- Result -----------------------------------------------------------------

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "$HOST_IP" ]] && HOST_IP="<server-ip>"

cat <<EOF

${GREEN}\xe2\x95\x94\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x97
\xe2\x95\x91                ENM (chain manager) ready                  \xe2\x95\x91
\xe2\x95\x9a\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\xe2\x95\x9d${NC}

  PC2 dashboard:  http://${HOST_IP}:4100
  ENM API:        http://${HOST_IP}:${ENM_PORT}/api/enm/health

  Logs:    cd $PC2_DIR && docker compose logs -f enm-server
  Stop:    cd $PC2_DIR && docker compose stop enm-server
  Update:  cd $PC2_DIR && docker compose pull enm-server && docker compose up -d enm-server

Next steps:
  1. Open http://${HOST_IP}:4100 in your browser
  2. Make sure you're logged in (wallet-claim flow on the desktop)
  3. Click the Elastos Node Manager icon in the launcher
  4. Walk the wizard \xe2\x86\x92 "Install ela for me"

EOF
