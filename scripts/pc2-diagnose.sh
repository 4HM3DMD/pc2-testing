#!/bin/bash
#
# PC2 Diagnostic Snapshot
#
# Self-contained, opt-in pull diagnostic that any operator can run to
# capture a sanitised snapshot of their node's state. Outputs to both
# stdout and a timestamped file under ~/, so you can paste it into a
# Telegram / GitHub thread when asking for help.
#
# Usage (from inside the repo):
#   bash scripts/pc2-diagnose.sh
#
# Or one-line from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/pc2-diagnose.sh | bash
#
# Privacy: this script makes ZERO network uploads. The output file
# stays on your machine. Wallet addresses, DIDs, bearer tokens, and
# obvious secret patterns are redacted before printing — but always
# eyeball the output before pasting it anywhere public.
#

set -u
# Don't `set -e` — partial output is more useful than an early exit.

# ─────────────────────────────────────────────────────────────────────
# Setup
# ─────────────────────────────────────────────────────────────────────

# Source nvm so node/npm/pm2 are on PATH when this runs from cron / curl|bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
if ! command -v pm2 >/dev/null 2>&1; then
    for npm_bin_dir in "$HOME"/.nvm/versions/node/*/bin /usr/local/bin /opt/homebrew/bin; do
        if [[ -x "$npm_bin_dir/pm2" ]]; then
            export PATH="$npm_bin_dir:$PATH"
            break
        fi
    done
fi

# Locate the repo (same logic as update.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
PC2_DIR=""
if [[ -n "$SCRIPT_DIR" && -d "$(dirname "$SCRIPT_DIR")/pc2-node" ]]; then
    PC2_DIR="$(dirname "$SCRIPT_DIR")"
else
    for candidate in "$HOME/pc2.net" "$HOME/.pc2"; do
        if [[ -d "$candidate/pc2-node" ]]; then
            PC2_DIR="$candidate"
            break
        fi
    done
fi

PORT="${PORT:-4200}"
HOST="http://127.0.0.1:${PORT}"

OUTPUT_FILE="$HOME/pc2-diagnose-$(date +%Y%m%d-%H%M%S).txt"

# ─────────────────────────────────────────────────────────────────────
# Sanitisation
# ─────────────────────────────────────────────────────────────────────
# Redact secrets and PII before output reaches stdout / file.
#   - 0x… EVM wallet addresses → 0x…REDACTED
#   - did:boson:… / did:ethr:… → did:REDACTED
#   - Bearer tokens in any header / log line → Bearer REDACTED
#   - Generic ?token=… / ?api_key=… in URLs → token=REDACTED
#   - PRIVATE KEY / BEGIN … blocks → REDACTED
#   - 24-word lowercase mnemonic → REDACTED MNEMONIC
sanitise () {
    # Sed runs line-at-a-time and BSD sed (macOS) lacks \b word boundaries,
    # so we use space/start/end anchors and handle PEM blocks line-by-line.
    # The macOS `sed -E` flag is also valid on GNU sed, so this works on
    # both Linux and Darwin.
    sed -E \
        -e 's/0x[a-fA-F0-9]{40}/0xREDACTED_WALLET/g' \
        -e 's/did:[a-z]+:[A-Za-z0-9_.-]{8,}/did:REDACTED/g' \
        -e 's/(Bearer|bearer)[[:space:]]+[A-Za-z0-9._~+\/=-]+/Bearer REDACTED/g' \
        -e 's/(token|api_key|apikey|secret|password|signature)=[A-Za-z0-9._~+\/=-]+/\1=REDACTED/gI' \
        -e 's/-----BEGIN [A-Z ]+ KEY-----/REDACTED-PEM-BEGIN/g' \
        -e 's/-----END [A-Z ]+ KEY-----/REDACTED-PEM-END/g' \
        -e 's/(^|[^A-Za-z0-9])([a-z]{3,8})( [a-z]{3,8}){23,}([^A-Za-z0-9]|$)/\1REDACTED-MNEMONIC\4/g'
}

# ─────────────────────────────────────────────────────────────────────
# Section helpers
# ─────────────────────────────────────────────────────────────────────
section () {
    printf '\n──── %s ────\n' "$1"
}

run () {
    # Run a command, label it, sanitise the output. Suppress missing-tool
    # stderr noise so the report stays readable.
    local label="$1"; shift
    printf '\n$ %s\n' "$label"
    "$@" 2>&1 | sanitise || true
}

# ─────────────────────────────────────────────────────────────────────
# Build the report
# ─────────────────────────────────────────────────────────────────────
{
echo "PC2 Diagnostic Snapshot"
echo "Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "Host: $(uname -n 2>/dev/null | sed 's/[a-zA-Z0-9_-]*$/REDACTED-HOSTNAME/')"
echo "Repo: ${PC2_DIR:-<NOT FOUND>}"
echo "Output file: $OUTPUT_FILE"

section "1. System"
run "uname -a" uname -a
run "lsb_release -a (or /etc/os-release)" bash -c 'lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null'
run "node --version" node --version
run "npm --version" npm --version
run "pm2 --version" pm2 --version

section "2. Resources (disk / memory)"
run "free -m" bash -c 'free -m 2>/dev/null || vm_stat 2>/dev/null'
if [[ -n "$PC2_DIR" ]]; then
    run "df -h $PC2_DIR" df -h "$PC2_DIR"
    run "df -h $PC2_DIR/pc2-node/data" df -h "$PC2_DIR/pc2-node/data" 2>/dev/null
fi
run "df -h ~/" df -h "$HOME"

section "3. PC2 process"
run "pm2 list (filter pc2)" bash -c "pm2 jlist 2>/dev/null | grep -oE '\"name\":\"pc2[^,]*\"|\"status\":\"[a-z]+\"|\"restart_time\":[0-9]+|\"uptime\":[0-9]+' | head -20"
run "lsof -i :$PORT (PID holding the port)" bash -c "lsof -i :$PORT 2>/dev/null | head -5"

# Helper: curl an endpoint, pretty-print as JSON when jq is present and
# the response is valid JSON, else print the raw response. We can't do
# `jq . || cat` inline because jq consumes stdin before cat runs;
# buffering through a tmpfile avoids that race.
fetch_json () {
    local label="$1" url="$2"
    local tmp
    tmp=$(mktemp 2>/dev/null || echo "/tmp/pc2-diag-$$.tmp")
    printf '\n$ %s\n' "$label"
    if curl -sS --max-time 5 "$url" >"$tmp" 2>&1; then
        if command -v jq >/dev/null 2>&1 && jq . "$tmp" >/dev/null 2>&1; then
            jq . "$tmp" | sanitise
        else
            sanitise <"$tmp"
        fi
    else
        echo "(curl failed — pc2-node not reachable on $url)"
    fi
    rm -f "$tmp"
}

section "4. Health endpoint ($HOST/api/health)"
fetch_json "curl /api/health" "$HOST/api/health"

section "5. System readiness ($HOST/api/system-readiness)"
fetch_json "curl /api/system-readiness" "$HOST/api/system-readiness"

section "6. WireGuard / AmneziaWG (raw)"
run "wg show (interfaces + handshakes)" bash -c "wg show 2>&1 | head -40"
run "ip link show wg0" bash -c "ip link show wg0 2>&1 || true"
run "ip link show awg0" bash -c "ip link show awg0 2>&1 || true"
run "modinfo wireguard (kernel module presence)" bash -c "modinfo wireguard 2>&1 | head -3"
run "lsmod | grep -i wireguard" bash -c "lsmod 2>/dev/null | grep -i wireguard || echo '(no wireguard kernel module loaded)'"

section "7. Transport binaries on PATH"
for b in wg wg-quick wireguard-go amneziawg-go awg-quick sing-box; do
    run "which $b" bash -c "which $b 2>&1 || echo 'not found'"
done

section "8. IPFS peering"
run "ipfs swarm peers count" bash -c "ipfs swarm peers 2>/dev/null | wc -l | sed 's/^/peers: /'"
# pc2-node bundles Helia, but if a system Kubo is also present we want both
run "ipfs id (system Kubo, if present)" bash -c "ipfs id 2>/dev/null | head -8"

section "9. Cluster pin connectivity (Elacity supernode)"
# Probe the public Elacity supernode pinning service. We DO NOT include
# any token here — we just check the endpoint is reachable. A 401 means
# the cluster is up; a connection failure means the node can't reach it.
run "curl Elacity supernode (expect HTTP 401 = up & auth-gated)" \
    bash -c "curl -sk -o /dev/null -w 'HTTP %{http_code}, time %{time_total}s\\n' --max-time 8 https://38.242.211.112/cluster-pin/pins"

section "10. Recent pm2 logs (last 200 lines, filtered for pin/cluster/ipfs/wireguard/error)"
run "pm2 logs pc2 --lines 200 --nostream | grep -iE 'pin|cluster|ipfs|helia|wireguard|amnezia|error|warn' | tail -80" \
    bash -c "pm2 logs pc2 --lines 200 --nostream 2>&1 | grep -iE 'pin|cluster|ipfs|helia|wireguard|amnezia|error|warn' | tail -80"

section "11. pc2-node/.env presence (keys only, values redacted)"
if [[ -n "$PC2_DIR" && -f "$PC2_DIR/pc2-node/.env" ]]; then
    run ".env keys" bash -c "grep -E '^[A-Z_]+=' '$PC2_DIR/pc2-node/.env' | cut -d= -f1 | sort -u"
else
    echo "  (no pc2-node/.env file found)"
fi

section "12. Git state"
if [[ -n "$PC2_DIR" ]]; then
    cd "$PC2_DIR" || true
    run "git rev-parse HEAD" git rev-parse HEAD
    run "git describe --tags --always" git describe --tags --always
    run "git status --short" git status --short
fi

echo
echo "──── End of diagnostic ────"
echo "Output written to: $OUTPUT_FILE"
echo "Eyeball the file before pasting publicly. Sanitisation is best-effort."
} 2>&1 | tee "$OUTPUT_FILE"
