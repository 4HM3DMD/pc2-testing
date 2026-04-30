#!/bin/bash
#
# Container entrypoint. Runs once per container start:
#   1. Symlinks PC2's volatile/{config,runtime} to the persistent /data volume
#      so config + runtime state survives container replacement.
#   2. On first boot only: writes a default config.json that flips PC2 mode
#      ON (otherwise PC2 boots in upstream Puter mode and the Elastos branding
#      / launcher entries for our extensions are dormant — bug we hit
#      during manual setup).
#   3. Hands off to whatever CMD the Dockerfile / compose file specifies
#      (default: npm start).
#
# The operator can override anything by mounting their own files into /data
# before container start; we never overwrite an existing config.json.

set -euo pipefail

DATA_DIR="${PC2_DATA_DIR:-/data}"
CONFIG_DIR="$DATA_DIR/config"
RUNTIME_DIR="$DATA_DIR/runtime"

NODE_NAME="${PC2_NODE_NAME:-My PC2 Node}"

mkdir -p "$CONFIG_DIR" "$RUNTIME_DIR"

# --- Wire PC2's volatile/* to our persistent volume. -------------------------
# PC2 looks for config at $REPO/volatile/config and runtime state at
# $REPO/volatile/runtime. Both paths are inside the image (ephemeral) by
# default. We replace them with symlinks into /data so anything PC2 writes
# (DB, mod_packages cache, audit log, our chain state) outlives the container.

link_to_data() {
    local src="$1"     # /app/volatile/config
    local dst="$2"     # /data/config
    # Ensure the parent dir exists. .dockerignore strips volatile/ from the
    # build context (we don't want operator state baked in), so /app/volatile
    # is missing in the image — without this, ln -sf fails with
    # "No such file or directory" and set -e kills the entrypoint.
    mkdir -p "$(dirname "$src")"
    # Already a symlink to the right place? leave it.
    if [[ -L "$src" && "$(readlink "$src")" == "$dst" ]]; then
        return 0
    fi
    # Existing dir or stale symlink — replace.
    rm -rf "$src"
    ln -sf "$dst" "$src"
}

link_to_data "/app/volatile/config" "$CONFIG_DIR"
link_to_data "/app/volatile/runtime" "$RUNTIME_DIR"

# --- First-boot default config: PC2 mode ON. --------------------------------
# Without this, PC2 boots Puter-mode and logs:
#   "[PC2 Node]: PC2 mode not enabled. Extension loaded but inactive."
# The operator can edit config.json after first boot or mount their own.
# We never overwrite — file existence is the idempotency check.

CONFIG_FILE="$CONFIG_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
    cat > "$CONFIG_FILE" <<EOF
{
  "config_name": "PC2 (Docker)",
  "extensions": {
    "@elastos/pc2-node": {
      "pc2_enabled": true,
      "node_name": "$NODE_NAME"
    }
  }
}
EOF
    echo "[entrypoint] Wrote default PC2-mode config to $CONFIG_FILE"
fi

# --- Hand off to the Dockerfile's CMD. --------------------------------------
exec "$@"
