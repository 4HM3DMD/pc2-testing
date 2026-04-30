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

# --- First-boot PC2 profile overlay. ----------------------------------------
# Critical design decision: we do NOT pre-write config.json. Why:
#
#   PC2's RuntimeEnvironment auto-generates config.json on first boot from
#   src/backend/src/boot/default_config.js — that file is the only path that
#   includes services.database.engine='sqlite' AND randomly generates the
#   crypto secrets PC2 needs (cookie_name, jwt_secret, url_signature_secret,
#   private_uid_secret, private_uid_namespace).
#
#   If we pre-write config.json with just our extension settings, PC2 sees
#   "config exists, skip generation" and boots with no database engine and
#   no secrets. The `data` extension (priority -10000) immediately crashes
#   with "svc_database.get is not a function" because StrategizedService
#   constructed without an engine has no .get() method.
#
# Instead: write a profile overlay (pc2.json) that $requires the auto-
# generated config.json and layers our extension settings on top. PC2's
# ConfigLoader processes $requires first via deep_proto_merge in
# src/backend/src/config.js, so defaults flow in correctly.
#
# Dockerfile sets ENV PUTER_CONFIG_PROFILE=pc2 so PC2 loads pc2.json.
#
# allow_all_host_values=true: lets the operator hit the dashboard via raw
# IP (e.g. http://<server-ip>:4100) without an "Invalid Host header" 400
# from src/backend/src/modules/web/WebServerService.js. For production with
# a real DNS name, replace with `domain: "<your-domain>"`.

PROFILE_FILE="$CONFIG_DIR/pc2.json"
if [[ ! -f "$PROFILE_FILE" ]]; then
    cat > "$PROFILE_FILE" <<EOF
{
  "config_name": "PC2 (Docker)",
  "\$requires": ["config.json"],
  "allow_all_host_values": true,
  "extensions": {
    "@elastos/pc2-node": {
      "pc2_enabled": true,
      "node_name": "$NODE_NAME"
    }
  }
}
EOF
    echo "[entrypoint] Wrote PC2 profile overlay to $PROFILE_FILE"
fi

# --- Hand off to the Dockerfile's CMD. --------------------------------------
exec "$@"
