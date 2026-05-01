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

while [[ $# -gt 0 ]]; do
    case $1 in
        --port)     ENM_PORT="$2"; shift 2 ;;
        --pc2-dir)  PC2_DIR="$2"; shift 2 ;;
        --image)    ENM_IMAGE="$2"; shift 2 ;;
        --help|-h)
            cat <<EOF
ENM (Elastos Node Manager) sidecar installer

Adds an enm-server container to your existing PC2 install.

Options:
  --port N          ENM API port (default: 4180)
  --pc2-dir PATH    Existing PC2 install dir (default: \$HOME/pc2)
  --image NAME      Override image (default: ghcr.io/4hm3dmd/enm-server:latest)

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

# --- Add enm-server service to compose --------------------------------------

cd "$PC2_DIR"

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
    volumes:
      # PC2 session DB + node-config (read-only) — auth resolves Bearer
      # tokens against pc2-node's sessions table and reads the owner wallet
      # from pc2-node's node-config.json
      - ./data:/data/pc2-node:ro
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
    ok "enm-server service appended"
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
