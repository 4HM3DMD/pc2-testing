#!/bin/bash
#
# PC2 Networking Fix
# 
# Installs the full transport stack: WireGuard + AmneziaWG + VLESS Reality
# Run this if your remote domain (username.ela.city) shows "initializing" forever.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/fix-networking.sh | bash
#
# Or if you already cloned the repo:
#   bash scripts/fix-networking.sh
#
# What this does:
#   1. Installs WireGuard (kernel module or wireguard-go fallback)
#   2. Installs AmneziaWG (DPI-resistant stealth transport)
#   3. Installs sing-box (VLESS Reality TCP stealth transport)
#   4. Configures passwordless sudo so PC2 can manage tunnels
#   5. Restarts PC2 to activate the transports
#
# After running:
#   - PC2 logs should show: [WireGuard] Interface wg0 up
#   - Your username.ela.city domain should load remotely
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
PURPLE='\033[0;35m'
NC='\033[0m'

echo ""
echo -e "${PURPLE}╔═══════════════════════════════════╗${NC}"
echo -e "${PURPLE}║  ${CYAN}PC2 Networking Fix${PURPLE}               ║${NC}"
echo -e "${PURPLE}║  ${NC}WireGuard + AmneziaWG + VLESS${PURPLE}     ║${NC}"
echo -e "${PURPLE}╚═══════════════════════════════════╝${NC}"
echo ""

OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
fi

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64) DEB_ARCH="amd64" ;;
    aarch64|arm64) DEB_ARCH="arm64" ;;
    *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
esac

SINGBOX_VERSION="1.13.0"
GO_MIN_VER="1.24"
GO_INSTALL_VER="1.24.4"

REAL_USER="${SUDO_USER:-$(whoami)}"

ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; }
step() { echo -e "${CYAN}  ▶${NC} $1"; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. WireGuard
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${CYAN}[1/3] WireGuard (Tier 1 — fast UDP tunnel)${NC}"

WG_READY=false

if [[ "$OS" == "macos" ]]; then
    if command -v wg &>/dev/null && command -v wg-quick &>/dev/null; then
        ok "WireGuard tools already installed"
        WG_READY=true
    else
        step "Installing WireGuard via Homebrew..."
        if ! command -v brew &>/dev/null; then
            fail "Homebrew not installed. Install it first: https://brew.sh"
        else
            brew install wireguard-tools 2>&1 || true
            if command -v wg &>/dev/null; then
                ok "WireGuard tools installed"
                WG_READY=true
            else
                fail "WireGuard install failed"
            fi
        fi
    fi

    if $WG_READY; then
        WG_QUICK_PATH=$(which wg-quick 2>/dev/null)
        if [[ -n "$WG_QUICK_PATH" ]] && [[ ! -f /etc/sudoers.d/wireguard ]]; then
            step "Configuring WireGuard permissions..."
            sudo sh -c "echo '$REAL_USER ALL=(ALL) NOPASSWD: ${WG_QUICK_PATH}' > /etc/sudoers.d/wireguard && chmod 440 /etc/sudoers.d/wireguard"
            ok "WireGuard permissions configured"
        fi
    fi

elif [[ "$OS" == "linux" ]]; then
    # Install wireguard-tools
    if command -v wg &>/dev/null && command -v wg-quick &>/dev/null; then
        ok "WireGuard tools already installed"
    else
        step "Installing wireguard-tools..."
        sudo apt-get update -qq
        sudo apt-get install -y -qq wireguard-tools 2>/dev/null || true
        if command -v wg &>/dev/null; then
            ok "WireGuard tools installed"
        else
            fail "Failed to install wireguard-tools"
        fi
    fi

    # Check kernel module or install wireguard-go
    if lsmod 2>/dev/null | grep -q wireguard; then
        ok "WireGuard kernel module loaded"
        WG_READY=true
    elif modinfo wireguard &>/dev/null 2>&1; then
        ok "WireGuard kernel module available"
        WG_READY=true
    elif command -v wireguard-go &>/dev/null || test -x /usr/local/bin/wireguard-go; then
        ok "wireguard-go (userspace) already installed"
        WG_READY=true
    else
        step "Kernel module not available — building wireguard-go from source..."
        
        # Ensure Go is available
        GO_CMD=""
        if command -v go &>/dev/null; then
            GO_CMD="go"
        else
            step "Installing Go compiler..."
            sudo apt-get install -y -qq golang-go 2>/dev/null || true
            if command -v go &>/dev/null; then
                GO_CMD="go"
            fi
        fi

        if [[ -n "$GO_CMD" ]]; then
            WG_TMP=$(mktemp -d)
            if git clone --depth 1 https://git.zx2c4.com/wireguard-go "$WG_TMP/wireguard-go" 2>/dev/null; then
                cd "$WG_TMP/wireguard-go"
                if make 2>&1; then
                    sudo cp wireguard-go /usr/local/bin/
                    sudo chmod +x /usr/local/bin/wireguard-go
                    ok "wireguard-go built and installed"
                    WG_READY=true
                elif go build -o wireguard-go 2>&1; then
                    sudo cp wireguard-go /usr/local/bin/
                    sudo chmod +x /usr/local/bin/wireguard-go
                    ok "wireguard-go built and installed"
                    WG_READY=true
                else
                    fail "wireguard-go build failed"
                fi
                cd ~
            fi
            rm -rf "$WG_TMP"
        else
            fail "Go compiler not available — cannot build wireguard-go"
        fi
    fi

    # Configure passwordless sudo for wg-quick
    if command -v wg-quick &>/dev/null || test -x /usr/bin/wg-quick; then
        SUDOERS_FILE="/etc/sudoers.d/pc2-wireguard"
        WG_QUICK_PATH=$(which wg-quick 2>/dev/null || echo "/usr/bin/wg-quick")

        if [ -f "$SUDOERS_FILE" ]; then
            ok "WireGuard permissions already configured"
        else
            step "Configuring WireGuard permissions..."
            sudo tee "$SUDOERS_FILE" > /dev/null << SUDOERS_EOF
# PC2: Allow wg-quick without password (SETENV for wireguard-go)
ALL ALL=(root) NOPASSWD: SETENV: ${WG_QUICK_PATH} up *, ${WG_QUICK_PATH} down *
SUDOERS_EOF
            sudo chmod 440 "$SUDOERS_FILE"
            if sudo visudo -c -f "$SUDOERS_FILE" &>/dev/null; then
                ok "WireGuard permissions configured"
            else
                fail "Invalid sudoers file, removing"
                sudo rm -f "$SUDOERS_FILE"
            fi
        fi
        WG_READY=true
    fi
fi

if $WG_READY; then
    ok "WireGuard ready"
else
    warn "WireGuard not fully installed — PC2 will fall back to Boson relay"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. AmneziaWG (stealth — DPI resistant)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[2/3] AmneziaWG (Tier 2 — DPI-resistant stealth)${NC}"

AWG_READY=false

if [[ "$OS" == "macos" ]]; then
    # macOS: build from source
    if command -v amneziawg-go &>/dev/null; then
        ok "AmneziaWG binary already installed"
        AWG_READY=true
    else
        step "Building amneziawg-go from source..."
        GO_CMD="go"
        if ! command -v go &>/dev/null; then
            warn "Go compiler not found — installing via Homebrew..."
            brew install go 2>&1 || true
        fi

        if command -v go &>/dev/null; then
            AWG_TMP=$(mktemp -d)
            AWG_BIN_DIR="/usr/local/bin"
            (cd "$AWG_TMP" && git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-go.git 2>&1 && cd amneziawg-go && make 2>&1 && cp amneziawg-go "$AWG_BIN_DIR/amneziawg-go" && chmod 755 "$AWG_BIN_DIR/amneziawg-go") || true
            rm -rf "$AWG_TMP"
            if command -v amneziawg-go &>/dev/null; then
                ok "AmneziaWG binary built and installed"
                AWG_READY=true
            else
                warn "AmneziaWG build failed"
            fi
        fi
    fi

    # awg-quick
    if ! command -v awg-quick &>/dev/null; then
        step "Building AmneziaWG tools (awg-quick)..."
        AWG_TOOLS_TMP=$(mktemp -d)
        if git clone --depth 1 https://github.com/amnezia-vpn/amnezia-wg-tools.git "$AWG_TOOLS_TMP" 2>/dev/null; then
            if [[ -d "$AWG_TOOLS_TMP/src" ]]; then
                (cd "$AWG_TOOLS_TMP/src" && make 2>&1 && sudo make install 2>&1) || true
            fi
        fi
        rm -rf "$AWG_TOOLS_TMP"
        if command -v awg-quick &>/dev/null; then
            ok "AmneziaWG tools installed"
        else
            warn "AmneziaWG tools build failed"
            AWG_READY=false
        fi
    else
        ok "AmneziaWG tools already installed"
    fi

    # Fix awg-quick paths if needed
    AWG_QUICK_PATH=$(which awg-quick 2>/dev/null || echo "")
    if [[ -n "$AWG_QUICK_PATH" ]]; then
        if grep -q '/var/run/wireguard/\$INTERFACE.name' "$AWG_QUICK_PATH" 2>/dev/null || grep -q 'cmd wg ' "$AWG_QUICK_PATH" 2>/dev/null; then
            step "Patching awg-quick paths..."
            sudo sed -i.bak \
                -e 's|/var/run/wireguard/\$INTERFACE\.name|/var/run/amneziawg/\$INTERFACE.name|g' \
                -e 's|/var/run/wireguard/\$REAL_INTERFACE\.sock|/var/run/amneziawg/\$REAL_INTERFACE.sock|g' \
                -e 's|cmd wg |cmd awg |g' \
                "$AWG_QUICK_PATH"
            ok "awg-quick paths patched"
        fi
    fi

    # Sudo permissions
    KILLALL_PATH=$(which killall 2>/dev/null || echo "/usr/bin/killall")
    if [[ -n "$AWG_QUICK_PATH" ]] && [[ ! -f /etc/sudoers.d/amneziawg ]]; then
        step "Configuring AmneziaWG permissions..."
        sudo sh -c "cat > /etc/sudoers.d/amneziawg << SUDOEOF
$REAL_USER ALL=(ALL) NOPASSWD: ${AWG_QUICK_PATH}
$REAL_USER ALL=(ALL) NOPASSWD: ${KILLALL_PATH} amneziawg-go
$REAL_USER ALL=(ALL) NOPASSWD: /bin/rm -rf /var/run/amneziawg/
SUDOEOF
chmod 440 /etc/sudoers.d/amneziawg"
        ok "AmneziaWG permissions configured"
    fi

elif [[ "$OS" == "linux" ]]; then
    if command -v amneziawg-go &>/dev/null || test -x /usr/local/bin/amneziawg-go; then
        ok "AmneziaWG binary already installed"
        AWG_READY=true
    else
        GO_CMD=""

        # Check system Go version
        if command -v go &>/dev/null; then
            SYS_GO_VER=$(go version 2>/dev/null | grep -oP '\d+\.\d+' | head -1)
            if [[ "$(printf '%s\n' "$GO_MIN_VER" "$SYS_GO_VER" | sort -V | head -1)" = "$GO_MIN_VER" ]]; then
                GO_CMD="go"
            else
                warn "System Go ($SYS_GO_VER) too old for amneziawg-go (needs $GO_MIN_VER+)"
            fi
        fi

        # Install recent Go if needed
        if [[ -z "$GO_CMD" ]]; then
            step "Installing Go $GO_INSTALL_VER for AmneziaWG build..."
            GO_TMP=$(mktemp -d)
            if wget -q "https://go.dev/dl/go${GO_INSTALL_VER}.linux-${DEB_ARCH}.tar.gz" -O "$GO_TMP/go.tar.gz" 2>/dev/null || \
               curl -sL "https://go.dev/dl/go${GO_INSTALL_VER}.linux-${DEB_ARCH}.tar.gz" -o "$GO_TMP/go.tar.gz"; then
                sudo rm -rf /usr/local/go-awg
                sudo tar -C /usr/local -xzf "$GO_TMP/go.tar.gz"
                sudo mv /usr/local/go /usr/local/go-awg
                GO_CMD="/usr/local/go-awg/bin/go"
                ok "Go ${GO_INSTALL_VER} installed to /usr/local/go-awg"
            else
                fail "Failed to download Go"
            fi
            rm -rf "$GO_TMP"
        fi

        if [[ -n "$GO_CMD" ]]; then
            step "Building amneziawg-go from source (takes 1-2 minutes)..."
            AWG_BUILD_TMP=$(mktemp -d)
            if git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-go.git "$AWG_BUILD_TMP/amneziawg-go" 2>/dev/null; then
                if sudo bash -c "export PATH='$(dirname $GO_CMD)':\$PATH && cd '$AWG_BUILD_TMP/amneziawg-go' && make" 2>&1; then
                    if test -x "$AWG_BUILD_TMP/amneziawg-go/amneziawg-go"; then
                        sudo cp "$AWG_BUILD_TMP/amneziawg-go/amneziawg-go" /usr/local/bin/amneziawg-go
                        sudo chmod 755 /usr/local/bin/amneziawg-go
                    fi
                fi
            fi
            sudo rm -rf "$AWG_BUILD_TMP"
            if test -x /usr/local/bin/amneziawg-go; then
                ok "AmneziaWG binary built and installed"
                AWG_READY=true
            else
                warn "AmneziaWG build failed"
            fi
        fi
    fi

    # Install awg-quick
    if ! command -v awg-quick &>/dev/null && ! test -x /usr/local/bin/awg-quick; then
        step "Building AmneziaWG tools (awg, awg-quick)..."
        AWG_TOOLS_TMP=$(mktemp -d)
        if git clone --depth 1 https://github.com/amnezia-vpn/amnezia-wg-tools.git "$AWG_TOOLS_TMP" 2>/dev/null; then
            if [[ -d "$AWG_TOOLS_TMP/src" ]]; then
                (cd "$AWG_TOOLS_TMP/src" && make 2>&1 && sudo make install 2>&1) || true
            fi
        fi
        rm -rf "$AWG_TOOLS_TMP"
        if command -v awg-quick &>/dev/null || test -x /usr/local/bin/awg-quick; then
            ok "AmneziaWG tools installed"
        else
            warn "AmneziaWG tools build failed"
            AWG_READY=false
        fi
    else
        ok "AmneziaWG tools already installed"
    fi

    # Configure passwordless sudo for awg-quick
    if command -v awg-quick &>/dev/null || test -x /usr/local/bin/awg-quick; then
        SUDOERS_FILE="/etc/sudoers.d/pc2-amneziawg"
        AWG_QUICK_PATH=$(which awg-quick 2>/dev/null || echo "/usr/local/bin/awg-quick")

        if [ ! -f "$SUDOERS_FILE" ]; then
            step "Configuring AmneziaWG permissions..."
            sudo tee "$SUDOERS_FILE" > /dev/null << SUDOERS_EOF
# PC2: Allow awg-quick without password (SETENV for amneziawg-go)
ALL ALL=(root) NOPASSWD: SETENV: ${AWG_QUICK_PATH} up *, ${AWG_QUICK_PATH} down *
SUDOERS_EOF
            sudo chmod 440 "$SUDOERS_FILE"
            if sudo visudo -c -f "$SUDOERS_FILE" &>/dev/null; then
                ok "AmneziaWG permissions configured"
            else
                fail "Invalid sudoers file, removing"
                sudo rm -f "$SUDOERS_FILE"
            fi
        else
            ok "AmneziaWG permissions already configured"
        fi
    fi
fi

if $AWG_READY; then
    ok "AmneziaWG ready"
else
    warn "AmneziaWG not available — not critical unless behind DPI"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. sing-box (VLESS Reality — TCP stealth)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[3/3] sing-box (Tier 3 — VLESS Reality TCP stealth)${NC}"

SB_READY=false

if command -v sing-box &>/dev/null || test -x /usr/local/bin/sing-box; then
    INSTALLED_VER=$(sing-box version 2>/dev/null | head -1 | awk '{print $NF}')
    if [ "$INSTALLED_VER" = "$SINGBOX_VERSION" ]; then
        ok "sing-box ${SINGBOX_VERSION} already installed"
        SB_READY=true
    else
        step "Upgrading sing-box from ${INSTALLED_VER} to ${SINGBOX_VERSION}..."
    fi
fi

if ! $SB_READY; then
    SB_TMP=$(mktemp -d)

    if [[ "$OS" == "macos" ]]; then
        SB_ARCH="$DEB_ARCH"
        step "Downloading sing-box v${SINGBOX_VERSION}..."
        if command -v brew &>/dev/null; then
            brew install sing-box 2>&1 || true
        fi
        if ! command -v sing-box &>/dev/null; then
            curl -sL "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-darwin-${SB_ARCH}.tar.gz" -o "$SB_TMP/sing-box.tar.gz"
            (cd "$SB_TMP" && tar -xzf sing-box.tar.gz && sudo cp sing-box-*/sing-box /usr/local/bin/sing-box && sudo chmod 755 /usr/local/bin/sing-box) 2>/dev/null || true
        fi
    elif [[ "$OS" == "linux" ]]; then
        step "Downloading sing-box v${SINGBOX_VERSION} for ${DEB_ARCH}..."
        wget -q "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${DEB_ARCH}.tar.gz" -O "$SB_TMP/sing-box.tar.gz" 2>/dev/null || \
            curl -sL "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${DEB_ARCH}.tar.gz" -o "$SB_TMP/sing-box.tar.gz"
        (cd "$SB_TMP" && tar -xzf sing-box.tar.gz && sudo cp sing-box-*/sing-box /usr/local/bin/sing-box && sudo chmod 755 /usr/local/bin/sing-box) 2>/dev/null || true
    fi

    rm -rf "$SB_TMP"

    if command -v sing-box &>/dev/null || test -x /usr/local/bin/sing-box; then
        ok "sing-box installed"
        SB_READY=true
    else
        warn "sing-box installation failed — VLESS Reality will be unavailable"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary & restart
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${PURPLE}════════════════════════════════════════${NC}"
echo -e "${CYAN}  Transport Stack Summary${NC}"
echo -e "${PURPLE}════════════════════════════════════════${NC}"

if $WG_READY; then
    echo -e "  ${GREEN}✓${NC} Tier 1: WireGuard (fast UDP tunnel)"
else
    echo -e "  ${RED}✗${NC} Tier 1: WireGuard (not installed)"
fi

if $AWG_READY; then
    echo -e "  ${GREEN}✓${NC} Tier 2: AmneziaWG (DPI-resistant)"
else
    echo -e "  ${YELLOW}⚠${NC} Tier 2: AmneziaWG (not available)"
fi

if $SB_READY; then
    echo -e "  ${GREEN}✓${NC} Tier 3: VLESS Reality (TCP stealth)"
else
    echo -e "  ${YELLOW}⚠${NC} Tier 3: VLESS Reality (not available)"
fi

echo ""

# Restart PC2
if command -v pm2 &>/dev/null; then
    step "Restarting PC2 to activate transports..."
    pm2 restart pc2 2>/dev/null || pm2 restart all 2>/dev/null || true
    echo ""
    ok "PC2 restarted. Check logs with: pm2 logs pc2"
    echo ""
    echo -e "  ${CYAN}Look for:${NC}"
    echo -e "    ${GREEN}[WireGuard] Interface wg0 up${NC}"
    echo -e "    ${GREEN}[AmneziaWG] amneziawg-go binary detected${NC}"
    echo -e "    ${GREEN}[VLESSReality] sing-box binary detected${NC}"
    echo ""
    echo -e "  ${CYAN}Your domain should now load remotely!${NC}"
else
    echo ""
    warn "PM2 not found — please restart PC2 manually to activate transports"
fi

echo ""
echo -e "${GREEN}Done!${NC}"
