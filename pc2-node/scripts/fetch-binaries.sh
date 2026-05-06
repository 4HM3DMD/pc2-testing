#!/bin/bash
#
# Fetch WireGuard, AmneziaWG, and sing-box binaries for all supported platforms.
# Places them in pc2-node/bin/{platform}-{arch}/ for bundling with the Electron app.
#
# Supported targets:
#   darwin-arm64   (macOS Apple Silicon)
#   darwin-x64     (macOS Intel)
#   linux-arm64    (Jetson, RPi, ARM VPS)
#   linux-x64      (standard Linux)
#   win32-x64      (Windows 64-bit)
#
# Usage:
#   bash pc2-node/scripts/fetch-binaries.sh [target]
#
# If no target is specified, builds for the current platform only.
# Use "all" to build all platforms.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/bin"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

WIREGUARD_TOOLS_REPO="https://git.zx2c4.com/wireguard-tools"
WIREGUARD_GO_REPO="https://git.zx2c4.com/wireguard-go"
AMNEZIAWG_GO_REPO="https://github.com/amnezia-vpn/amneziawg-go"
AMNEZIAWG_TOOLS_REPO="https://github.com/amnezia-vpn/amneziawg-tools"
SINGBOX_VERSION="1.13.0"
SINGBOX_BASE="https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}"

log() { echo -e "${GREEN}[fetch-binaries]${NC} $1"; }
warn() { echo -e "${YELLOW}[fetch-binaries]${NC} $1"; }
err() { echo -e "${RED}[fetch-binaries]${NC} $1"; }

detect_current_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win32" ;;
    *) err "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "Unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

REQUESTED_TARGET="${1:-$(detect_current_target)}"

if [ "$REQUESTED_TARGET" = "all" ]; then
  TARGETS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64" "win32-x64")
else
  TARGETS=("$REQUESTED_TARGET")
fi

TMPDIR_ROOT=$(mktemp -d)
trap "rm -rf $TMPDIR_ROOT" EXIT

# ---------------------------------------------------------------------------
# wireguard-go: cross-compile for each target using Go
# ---------------------------------------------------------------------------
fetch_wireguard_go() {
  local target="$1"
  local dest_dir="$BIN_DIR/$target"
  mkdir -p "$dest_dir"

  local goos goarch ext=""
  case "$target" in
    darwin-arm64) goos="darwin"; goarch="arm64" ;;
    darwin-x64)   goos="darwin"; goarch="amd64" ;;
    linux-arm64)  goos="linux";  goarch="arm64" ;;
    linux-x64)    goos="linux";  goarch="amd64" ;;
    win32-x64)    goos="windows"; goarch="amd64"; ext=".exe" ;;
  esac

  local wg_go_dir="$TMPDIR_ROOT/wireguard-go"
  if [ ! -d "$wg_go_dir" ]; then
    log "Cloning wireguard-go..."
    git clone --depth 1 "$WIREGUARD_GO_REPO" "$wg_go_dir" 2>/dev/null
  fi

  log "Building wireguard-go for $target..."
  (cd "$wg_go_dir" && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -o "$dest_dir/wireguard-go${ext}" 2>&1) || {
    warn "wireguard-go build failed for $target (Go cross-compile)"
    return
  }
  chmod +x "$dest_dir/wireguard-go${ext}" 2>/dev/null || true
  log "  -> $dest_dir/wireguard-go${ext}"
}

# ---------------------------------------------------------------------------
# inject_path_self_location: prepend the script's own directory to PATH
# so internal `wg` / `awg setconf` calls resolve to bundled binaries even
# when the script runs under sudo (where secure_path strips ~/.pc2/.../bin/).
#
# v1.2.7.11: required for awg-quick because amneziawg-tools' awg-quick.darwin
# unconditionally invokes `awg setconf` for the obfuscation params, and
# Apple sudo's default secure_path = /usr/local/bin:/usr/bin:/bin:... does
# not include the bundled directory. Defensive for wg-quick too — same
# class of issue, currently masked by wg-quick.darwin tolerating partial
# config but no guarantee that survives upstream changes.
#
# Idempotent: if the marker line is already present, the function is a no-op.
# ---------------------------------------------------------------------------
inject_path_self_location() {
  local script_path="$1"
  if grep -qF 'PC2_PATH_SELF_LOCATION_v1' "$script_path" 2>/dev/null; then
    return
  fi
  # Insert two lines after the shebang: a marker comment (for idempotency
  # detection) and the export. Using awk rather than sed to avoid having
  # to escape `"` and `$` in the replacement.
  awk 'NR==1 {print; print "# PC2_PATH_SELF_LOCATION_v1 — added by fetch-binaries.sh"; print "export PATH=\"$(cd \"$(dirname \"$0\")\" && pwd):$PATH\""; next} {print}' "$script_path" > "$script_path.tmp" \
    && mv "$script_path.tmp" "$script_path"
  chmod +x "$script_path"
}

# ---------------------------------------------------------------------------
# wireguard-tools (wg, wg-quick): compile wg from C source, copy wg-quick script
# wg-quick is a bash script so it works on all Unix platforms.
# wg is a small C binary that needs per-platform compilation.
# ---------------------------------------------------------------------------
fetch_wireguard_tools() {
  local target="$1"
  local dest_dir="$BIN_DIR/$target"
  mkdir -p "$dest_dir"

  # Windows: wg.exe from official MSI is complex; skip for now, users install WireGuard app
  if [[ "$target" == win32-* ]]; then
    log "Windows: skipping wireguard-tools (users install WireGuard for Windows)"
    return
  fi

  local tools_dir="$TMPDIR_ROOT/wireguard-tools"
  if [ ! -d "$tools_dir" ]; then
    log "Cloning wireguard-tools..."
    git clone --depth 1 "$WIREGUARD_TOOLS_REPO" "$tools_dir" 2>/dev/null
  fi

  # wg-quick is a bash script — just copy it
  if [ -f "$tools_dir/src/wg-quick/darwin.bash" ] && [[ "$target" == darwin-* ]]; then
    cp "$tools_dir/src/wg-quick/darwin.bash" "$dest_dir/wg-quick"
    chmod +x "$dest_dir/wg-quick"
    inject_path_self_location "$dest_dir/wg-quick"
    log "  -> $dest_dir/wg-quick (macOS bash script, PATH self-loc patched)"
  elif [ -f "$tools_dir/src/wg-quick/linux.bash" ] && [[ "$target" == linux-* ]]; then
    cp "$tools_dir/src/wg-quick/linux.bash" "$dest_dir/wg-quick"
    chmod +x "$dest_dir/wg-quick"
    inject_path_self_location "$dest_dir/wg-quick"
    log "  -> $dest_dir/wg-quick (Linux bash script, PATH self-loc patched)"
  fi

  # wg binary: only compile natively (cross-compiling C is harder than Go)
  local current=$(detect_current_target)
  if [ "$target" = "$current" ]; then
    log "Building wg binary for $target (native)..."
    (cd "$tools_dir/src" && make clean 2>/dev/null; make 2>&1) && {
      cp "$tools_dir/src/wg" "$dest_dir/wg"
      chmod +x "$dest_dir/wg"
      log "  -> $dest_dir/wg"
    } || warn "wg build failed for $target"
  else
    warn "Skipping wg binary for $target (cross-compile from $current not supported for C; build natively on target platform)"
  fi
}

# ---------------------------------------------------------------------------
# amneziawg-go: cross-compile for each target using Go
# Same pattern as wireguard-go but with obfuscation support.
# ---------------------------------------------------------------------------
fetch_amneziawg_go() {
  local target="$1"
  local dest_dir="$BIN_DIR/$target"
  mkdir -p "$dest_dir"

  # AmneziaWG is not supported on Windows
  if [[ "$target" == win32-* ]]; then
    log "Windows: skipping amneziawg-go (not supported)"
    return
  fi

  local goos goarch
  case "$target" in
    darwin-arm64) goos="darwin"; goarch="arm64" ;;
    darwin-x64)   goos="darwin"; goarch="amd64" ;;
    linux-arm64)  goos="linux";  goarch="arm64" ;;
    linux-x64)    goos="linux";  goarch="amd64" ;;
  esac

  local awg_go_dir="$TMPDIR_ROOT/amneziawg-go"
  if [ ! -d "$awg_go_dir" ]; then
    log "Cloning amneziawg-go..."
    git clone --depth 1 "$AMNEZIAWG_GO_REPO" "$awg_go_dir" 2>/dev/null
  fi

  log "Building amneziawg-go for $target..."
  (cd "$awg_go_dir" && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -o "$dest_dir/amneziawg-go" 2>&1) || {
    warn "amneziawg-go build failed for $target (Go cross-compile)"
    return
  }
  chmod +x "$dest_dir/amneziawg-go"
  log "  -> $dest_dir/amneziawg-go"
}

# ---------------------------------------------------------------------------
# amneziawg-tools (awg-quick + awg): copy the awg-quick bash script and
# compile the awg CLI from C source.
#
# awg-quick is a modified wg-quick with amneziawg obfuscation params support.
#
# v1.2.7.11: also builds `awg`, the AmneziaWG fork of `wg` that knows how to
# parse the obfuscation parameter keys (Jc, Jmin, Jmax, S1-S4, H1-H4, optional
# I1) when calling `awg setconf <iface> <conf>`. Without `awg` on PATH inside
# the awg-quick script, the bring-up fails at the setconf step. Plain `wg`
# cannot substitute because it would reject the unknown obfuscation keys.
# ---------------------------------------------------------------------------
fetch_amneziawg_tools() {
  local target="$1"
  local dest_dir="$BIN_DIR/$target"
  mkdir -p "$dest_dir"

  # AmneziaWG is not supported on Windows
  if [[ "$target" == win32-* ]]; then
    log "Windows: skipping amneziawg-tools (not supported)"
    return
  fi

  local tools_dir="$TMPDIR_ROOT/amneziawg-tools"
  if [ ! -d "$tools_dir" ]; then
    log "Cloning amneziawg-tools..."
    git clone --depth 1 "$AMNEZIAWG_TOOLS_REPO" "$tools_dir" 2>/dev/null
  fi

  # awg-quick is a bash script based on wg-quick with awg-specific modifications
  if [ -f "$tools_dir/src/wg-quick/darwin.bash" ] && [[ "$target" == darwin-* ]]; then
    cp "$tools_dir/src/wg-quick/darwin.bash" "$dest_dir/awg-quick"
    chmod +x "$dest_dir/awg-quick"
    # Patch: replace wg references with awg
    sed -i.bak 's|/var/run/wireguard/|/var/run/amneziawg/|g' "$dest_dir/awg-quick" 2>/dev/null || true
    sed -i.bak 's|PROGRAM="${0##*/}"|PROGRAM="awg-quick"|g' "$dest_dir/awg-quick" 2>/dev/null || true
    rm -f "$dest_dir/awg-quick.bak"
    inject_path_self_location "$dest_dir/awg-quick"
    log "  -> $dest_dir/awg-quick (macOS bash script, patched + PATH self-loc)"
  elif [ -f "$tools_dir/src/wg-quick/linux.bash" ] && [[ "$target" == linux-* ]]; then
    cp "$tools_dir/src/wg-quick/linux.bash" "$dest_dir/awg-quick"
    chmod +x "$dest_dir/awg-quick"
    # Patch: replace wg references with awg
    sed -i.bak 's|/var/run/wireguard/|/var/run/amneziawg/|g' "$dest_dir/awg-quick" 2>/dev/null || true
    sed -i.bak 's|PROGRAM="${0##*/}"|PROGRAM="awg-quick"|g' "$dest_dir/awg-quick" 2>/dev/null || true
    rm -f "$dest_dir/awg-quick.bak"
    inject_path_self_location "$dest_dir/awg-quick"
    log "  -> $dest_dir/awg-quick (Linux bash script, patched + PATH self-loc)"
  fi

  # awg binary: only compile natively (cross-compiling C is harder than Go).
  # CI uses an explicit clang -arch override step instead — see
  # .github/workflows/publish-pc2-binaries.yml "Build awg native C binary".
  local current=$(detect_current_target)
  if [ "$target" = "$current" ]; then
    log "Building awg binary for $target (native)..."
    (cd "$tools_dir/src" && make clean 2>/dev/null; make 2>&1) && {
      # amneziawg-tools' Makefile output filename varies between upstream
      # tags — sometimes `awg`, sometimes (post-rebase from upstream
      # wireguard-tools) plain `wg`. Handle both.
      if [ -f "$tools_dir/src/awg" ]; then
        cp "$tools_dir/src/awg" "$dest_dir/awg"
      elif [ -f "$tools_dir/src/wg" ]; then
        cp "$tools_dir/src/wg" "$dest_dir/awg"
      else
        warn "awg build succeeded but no awg/wg binary found in $tools_dir/src"
        return
      fi
      chmod +x "$dest_dir/awg"
      log "  -> $dest_dir/awg"
    } || warn "awg build failed for $target"
  else
    warn "Skipping awg binary for $target (cross-compile from $current not supported for C; build natively on target platform)"
  fi
}

# ---------------------------------------------------------------------------
# sing-box: download pre-built binaries from GitHub releases
# ---------------------------------------------------------------------------
fetch_singbox() {
  local target="$1"
  local dest_dir="$BIN_DIR/$target"
  mkdir -p "$dest_dir"

  local os arch ext="" archive_ext="tar.gz"
  case "$target" in
    darwin-arm64) os="darwin"; arch="arm64" ;;
    darwin-x64)   os="darwin"; arch="amd64" ;;
    linux-arm64)  os="linux";  arch="arm64" ;;
    linux-x64)    os="linux";  arch="amd64" ;;
    win32-x64)    os="windows"; arch="amd64"; ext=".exe"; archive_ext="zip" ;;
  esac

  local filename="sing-box-${SINGBOX_VERSION}-${os}-${arch}"
  local url="${SINGBOX_BASE}/${filename}.${archive_ext}"

  log "Downloading sing-box ${SINGBOX_VERSION} for $target..."
  local dl_dir="$TMPDIR_ROOT/singbox-$target"
  mkdir -p "$dl_dir"

  if [ "$archive_ext" = "zip" ]; then
    curl -sL "$url" -o "$dl_dir/singbox.zip" && {
      (cd "$dl_dir" && unzip -qo singbox.zip 2>/dev/null)
      local bin_path=$(find "$dl_dir" -name "sing-box${ext}" -type f | head -1)
      if [ -n "$bin_path" ]; then
        cp "$bin_path" "$dest_dir/sing-box${ext}"
        chmod +x "$dest_dir/sing-box${ext}" 2>/dev/null || true
        log "  -> $dest_dir/sing-box${ext}"
      else
        warn "sing-box binary not found in archive for $target"
      fi
    } || warn "Failed to download sing-box for $target"
  else
    curl -sL "$url" | tar xz -C "$dl_dir" 2>/dev/null && {
      local bin_path=$(find "$dl_dir" -name "sing-box" -type f | head -1)
      if [ -n "$bin_path" ]; then
        cp "$bin_path" "$dest_dir/sing-box"
        chmod +x "$dest_dir/sing-box"
        log "  -> $dest_dir/sing-box"
      else
        warn "sing-box binary not found in archive for $target"
      fi
    } || warn "Failed to download sing-box for $target"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "Targets: ${TARGETS[*]}"
log "Output: $BIN_DIR/"
echo ""

# Check Go is available (needed for wireguard-go and amneziawg-go)
if ! command -v go &>/dev/null; then
  warn "Go compiler not found. wireguard-go and amneziawg-go will not be built."
  warn "Install Go: https://go.dev/dl/"
  HAS_GO=false
else
  HAS_GO=true
  log "Go: $(go version)"
fi

for target in "${TARGETS[@]}"; do
  echo ""
  log "=== $target ==="

  if [ "$HAS_GO" = true ]; then
    fetch_wireguard_go "$target"
    fetch_amneziawg_go "$target"
  fi

  fetch_wireguard_tools "$target"
  fetch_amneziawg_tools "$target"
  fetch_singbox "$target"
done

echo ""
log "Done. Bundled binaries:"
find "$BIN_DIR" -type f | sort | while read f; do
  size=$(du -h "$f" | cut -f1)
  echo "  $size  ${f#$BIN_DIR/}"
done
