#!/usr/bin/env bash
set -euo pipefail

# Build all PC2 WASM crates for wasm32-wasip1 and deploy to wasm-apps/
# Usage: bash pc2-node/scripts/build-wasm.sh [crate-name]
#   No args = build all crates
#   crate-name = build only that crate (ddrm-renderer, cenc-decrypt, cenc-encrypt, ipfs-assemble, mp4-split, evm-multicall)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PC2_NODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="wasm32-wasip1"
PROFILE="release"

declare -A CRATE_DIRS=(
  ["ddrm-renderer"]="$PC2_NODE_DIR/wasm-renderer"
  ["cenc-decrypt"]="$PC2_NODE_DIR/crates/cenc-decrypt"
  ["cenc-encrypt"]="$PC2_NODE_DIR/crates/cenc-encrypt"
  ["ipfs-assemble"]="$PC2_NODE_DIR/crates/ipfs-assemble"
  ["mp4-split"]="$PC2_NODE_DIR/crates/mp4-split"
  ["evm-multicall"]="$PC2_NODE_DIR/crates/evm-multicall"
  ["amm-engine"]="$PC2_NODE_DIR/crates/amm-engine"
)

declare -A OUTPUT_DIRS=(
  ["ddrm-renderer"]="$PC2_NODE_DIR/wasm-apps/ddrm-renderer"
  ["cenc-decrypt"]="$PC2_NODE_DIR/wasm-apps/cenc-decrypt"
  ["cenc-encrypt"]="$PC2_NODE_DIR/wasm-apps/cenc-encrypt"
  ["ipfs-assemble"]="$PC2_NODE_DIR/wasm-apps/ipfs-assemble"
  ["mp4-split"]="$PC2_NODE_DIR/wasm-apps/mp4-split"
  ["evm-multicall"]="$PC2_NODE_DIR/wasm-apps/evm-multicall"
  ["amm-engine"]="$PC2_NODE_DIR/wasm-apps/amm-engine"
)

# Crypto crates get -O3 (maximize speed); utility crates get -Oz (minimize size)
declare -A WASM_OPT_LEVEL=(
  ["ddrm-renderer"]="-Oz"
  ["cenc-decrypt"]="-O3"
  ["cenc-encrypt"]="-O3"
  ["ipfs-assemble"]="-Oz"
  ["mp4-split"]="-Oz"
  ["evm-multicall"]="-O3"
  ["amm-engine"]="-O3"
)

build_crate() {
  local name="$1"
  local crate_dir="${CRATE_DIRS[$name]}"
  local output_dir="${OUTPUT_DIRS[$name]}"

  if [ ! -d "$crate_dir" ]; then
    echo "ERROR: Crate directory not found: $crate_dir"
    return 1
  fi

  echo ""
  echo "=== Building $name ==="
  echo "  Crate:  $crate_dir"
  echo "  Target: $TARGET"
  echo "  Output: $output_dir"

  cd "$crate_dir"
  cargo build --release --target "$TARGET" --bin "$name"

  mkdir -p "$output_dir"
  local wasm_path="$crate_dir/target/$TARGET/$PROFILE/$name.wasm"

  if [ ! -f "$wasm_path" ]; then
    echo "ERROR: Expected WASM binary not found at $wasm_path"
    return 1
  fi

  local size_before
  size_before=$(wc -c < "$wasm_path" | tr -d ' ')
  cp "$wasm_path" "$output_dir/$name.wasm"

  # wasm-opt pass: per-crate optimization level
  local opt_flag="${WASM_OPT_LEVEL[$name]:--Oz}"
  if command -v wasm-opt &>/dev/null; then
    echo "  Running wasm-opt $opt_flag..."
    wasm-opt "$opt_flag" --enable-bulk-memory --enable-nontrapping-float-to-int --enable-simd "$output_dir/$name.wasm" -o "$output_dir/$name.wasm"
    local size_opt
    size_opt=$(wc -c < "$output_dir/$name.wasm" | tr -d ' ')
    echo "  wasm-opt: $size_before -> $size_opt bytes ($(( (size_before - size_opt) * 100 / size_before ))% reduction)"
  else
    echo "  wasm-opt not found — install via: npm i -g binaryen (or brew install binaryen)"
    echo "  Skipping optimization (binary will still work, just larger)"
  fi

  local size_final
  size_final=$(wc -c < "$output_dir/$name.wasm" | tr -d ' ')
  echo "  Binary: $size_final bytes -> $output_dir/$name.wasm"

  # Update capsule.json with the SHA-256 of the final .wasm binary
  if [ -f "$output_dir/capsule.json" ]; then
    local wasm_sha256
    wasm_sha256=$(shasum -a 256 "$output_dir/$name.wasm" | cut -d' ' -f1)
    if command -v python3 &>/dev/null; then
      python3 -c "
import json, sys
with open('$output_dir/capsule.json', 'r') as f:
    c = json.load(f)
c['sha256'] = '$wasm_sha256'
with open('$output_dir/capsule.json', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
"
      echo "  Capsule manifest updated: sha256=$wasm_sha256"
    else
      echo "  python3 not found — capsule.json sha256 not updated"
    fi
  fi

  echo "  Done."
}

if [ $# -gt 0 ]; then
  for crate in "$@"; do
    if [[ -v "CRATE_DIRS[$crate]" ]]; then
      build_crate "$crate"
    else
      echo "ERROR: Unknown crate '$crate'. Available: ${!CRATE_DIRS[*]}"
      exit 1
    fi
  done
else
  echo "Building all PC2 WASM crates..."
  for crate in "${!CRATE_DIRS[@]}"; do
    build_crate "$crate"
  done
fi

echo ""
echo "All WASM builds complete."
