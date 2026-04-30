#!/usr/bin/env bash
# Copyright (C) 2026-present Elacity
# SPDX-License-Identifier: AGPL-3.0
#
# enm-uninstall.sh — soft or full uninstall.
#
# --soft  (default): stop chains, drop PID/meta files, keep config + chain data
# --purge:           also wipe chain data dirs and the audit table rows
#
# We never delete the operator's `ela` binary — that's outside our scope.

set -euo pipefail

MODE="soft"
if [[ "${1:-}" == "--purge" ]]; then
    MODE="purge"
elif [[ "${1:-}" == "--soft" ]] || [[ -z "${1:-}" ]]; then
    MODE="soft"
elif [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
    echo "Usage: $0 [--soft | --purge]"
    echo "  --soft   stop chains + remove PID/meta (keeps data + config) [default]"
    echo "  --purge  also wipe chain data + audit rows"
    exit 0
else
    echo "Unknown flag: $1" >&2
    echo "Usage: $0 [--soft | --purge]" >&2
    exit 1
fi

# Defaults match DataDir.js — operator can override via env.
PC2_DATA_DIR="${PC2_DATA_DIR:-$HOME/.pc2}"
ENM_DIR="${ENM_DATA_DIR:-$PC2_DATA_DIR/extensions/elastos-node-manager}"

if [[ ! -d "$ENM_DIR" ]]; then
    echo "No ENM data dir at $ENM_DIR — nothing to uninstall."
    exit 0
fi

echo "ENM uninstall — mode=$MODE  dir=$ENM_DIR"

# --- 1. Stop any running ela processes via PID files. ---
RUN_DIR="$ENM_DIR/run"
if [[ -d "$RUN_DIR" ]]; then
    for pidfile in "$RUN_DIR"/ela-*.pid; do
        [[ -f "$pidfile" ]] || continue
        chain_id="$(basename "$pidfile" .pid | sed 's/^ela-//')"
        pid="$(cat "$pidfile" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            echo "  Stopping $chain_id (pid=$pid) — SIGTERM, 60s grace."
            kill -TERM "$pid" || true
            for i in $(seq 1 60); do
                sleep 1
                if ! kill -0 "$pid" 2>/dev/null; then
                    break
                fi
            done
            if kill -0 "$pid" 2>/dev/null; then
                echo "  $chain_id did not exit — SIGKILL."
                kill -KILL "$pid" || true
            fi
        fi
        rm -f "$pidfile"
        rm -f "$RUN_DIR/ela-${chain_id}.meta.json"
    done
fi

# --- 2. Soft mode stops here. ---
if [[ "$MODE" == "soft" ]]; then
    echo "Soft uninstall complete. Config + chain data kept. Re-launch ENM in PC2 to resume."
    exit 0
fi

# --- 3. Purge: wipe chain dirs + config + encryption key. ---
echo "Purge: wiping chain data and config in $ENM_DIR"
rm -rf "$ENM_DIR/chains"
rm -f "$ENM_DIR/config.json" "$ENM_DIR/config.json.bak"
rm -f "$ENM_DIR/encryption.key"

# --- 4. Drop audit-log + proposals + setup-state rows from PC2's shared DB. ---
# We don't ship better-sqlite3 in our deps. Use the system `sqlite3` CLI if
# available; otherwise tell the operator how to do it manually.
PC2_DB="$PC2_DATA_DIR/pc2.db"
if [[ -f "$PC2_DB" ]] && command -v sqlite3 >/dev/null 2>&1; then
    echo "Dropping ENM rows from PC2 DB..."
    sqlite3 "$PC2_DB" "DELETE FROM enm_audit_logs; DELETE FROM enm_proposals; DELETE FROM enm_setup_state;" \
        2>/dev/null || true
elif [[ -f "$PC2_DB" ]]; then
    cat <<EOF
NOTE: 'sqlite3' CLI not found. To drop ENM rows manually:
    sqlite3 "$PC2_DB" \\
      'DELETE FROM enm_audit_logs; DELETE FROM enm_proposals; DELETE FROM enm_setup_state;'
EOF
fi

echo "Purge complete. Operator's ela binary at the configured path was NOT removed."
