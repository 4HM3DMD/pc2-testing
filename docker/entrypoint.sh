#!/bin/bash
#
# Container entrypoint — Option A: pc2-node only.
#
# After 17+ rounds of trying to integrate Puter root + pc2-node in one
# container, we made the architectural call to drop Puter entirely and
# run pc2-node as the sole server. pc2-node is THE elacity PC2 product:
# it serves the desktop frontend, owns /api/*, owns /auth/particle, owns
# the session DB. One server, one auth, one origin.
#
# Trade-off: ENM extension (which lived in PC2's Puter-kernel extension
# system) is no longer loaded. ENM gets shipped as a separate, standalone
# product later — it doesn't need a desktop OS wrapper to run an ela node.
#
# Boots:
#   1. Ensures the persistent data dir exists (chain + ipfs + DB live here).
#   2. Starts pc2-node as PID 1 on port 4100 (the operator-facing port).

set -euo pipefail

PC2_DATA_DIR="${PC2_DATA_DIR:-/data/pc2-node}"
NODE_NAME="${PC2_NODE_NAME:-My PC2 Node}"

mkdir -p "$PC2_DATA_DIR"

if [[ ! -f /app/pc2-node/dist/index.js ]]; then
    echo "[entrypoint] FATAL: /app/pc2-node/dist/index.js missing — image build incomplete"
    exit 1
fi

echo "[entrypoint] Starting pc2-node on :${PORT:-4100} (data: $PC2_DATA_DIR)"

cd /app/pc2-node

# pc2-node reads config from process.env.PORT and process.env.PC2_DATA_DIR
# among others — see pc2-node/src/index.ts and pc2-node/src/config/loader.ts.
export PORT="${PORT:-4100}"
export NODE_ENV="${NODE_ENV:-production}"
export PC2_DATA_DIR
export PC2_NODE_NAME="$NODE_NAME"

# Pin the SQLite DB path explicitly. Default config (pc2-node/config/default.json)
# resolves database_path to ./data/pc2.db, which depends on CWD and isn't
# under the bind-mounted /data volume. Pinning to $PC2_DATA_DIR/pc2.db keeps
# the DB on the persistent mount AND makes it findable by the enm-server
# sidecar (read-only mount of /data/pc2-node, default PC2_NODE_DB_PATH points
# at /data/pc2-node/pc2.db).
export DB_PATH="${DB_PATH:-$PC2_DATA_DIR/pc2.db}"

# Boson connectivity defaults — match upstream pc2-node Dockerfile so the
# ela.city gateway flow has somewhere to phone home for tunneling. Operator
# can override by setting these env vars in docker-compose.yml.
export BOSON_GATEWAY_URL="${BOSON_GATEWAY_URL:-https://demo.ela.city}"
export BOSON_PUBLIC_DOMAIN="${BOSON_PUBLIC_DOMAIN:-ela.city}"
export BOSON_PRIVACY_MODE="${BOSON_PRIVACY_MODE:-false}"

exec node dist/index.js
