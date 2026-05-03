#!/usr/bin/env bash
# scripts/cluster-setup/01-survey.sh
#
# READ-ONLY survey for an Elacity supernode candidate (Contabo / GCloud / InterServer).
# Designed to be safe to run on a live, production-traffic-bearing host:
#  - No package installs
#  - No service restarts
#  - No file writes outside /tmp
#  - No network changes
#
# Outputs a single human-readable report block that can be pasted directly into
# .cursor/tasks/SUPERNODE-CLUSTER-SETUP/SUPERNODE-CLUSTER-SETUP.md
#
# Usage:
#   curl -fsSL <url-of-this-script> | bash
#   # or copy this file to the box and run:
#   bash 01-survey.sh
#
# Exit codes: always 0 (this is informational; never breaks the box).

set +e
shopt -s nullglob

OUT=/tmp/elacity-supernode-survey.txt
RAW_OUT=/tmp/elacity-supernode-survey.raw.txt

# ─── Helpers ─────────────────────────────────────────────────────────
hr()    { printf '\n────────────────────────────────────────────────────────────\n  %s\n────────────────────────────────────────────────────────────\n' "$1"; }
have()  { command -v "$1" >/dev/null 2>&1; }
maybe() { if have "$1"; then "$@" 2>&1; else echo "  (skipped: '$1' not installed)"; fi; }
trim()  { sed -e 's/[[:space:]]*$//' -e '/^$/d'; }

# Capture all output to a tee'd file
exec > >(tee "$RAW_OUT") 2>&1

# ─── Header ──────────────────────────────────────────────────────────
echo "============================================================"
echo " Elacity Supernode Survey — $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo " Host: $(hostname -f 2>/dev/null || hostname)"
echo " Script version: 01-survey.sh v1 (2026-05-02)"
echo "============================================================"

# ─── Section 1: Identity & OS ────────────────────────────────────────
hr "1. Host identity"
echo "  hostname (short):  $(hostname)"
echo "  hostname (FQDN):   $(hostname -f 2>/dev/null || echo '(not configured)')"
echo "  uptime:            $(uptime -p 2>/dev/null || uptime)"
echo "  current user:      $(whoami)  (uid=$(id -u))"
echo "  root access:       $( [ "$(id -u)" -eq 0 ] && echo 'YES (root)' || echo 'NO (sudo may be needed for some checks)' )"
echo
echo "  /etc/os-release:"
sed -e 's/^/    /' /etc/os-release 2>/dev/null | grep -E '^[ ]*(NAME|VERSION|ID)=' || echo "    (no /etc/os-release)"
echo
echo "  kernel:            $(uname -r)  arch=$(uname -m)"

# ─── Section 2: Public network identity ──────────────────────────────
hr "2. Public network identity"
PUBLIC_IP=$( { curl -fs --max-time 5 https://api.ipify.org \
            || curl -fs --max-time 5 https://ifconfig.me \
            || curl -fs --max-time 5 https://icanhazip.com; } 2>/dev/null | head -1 )
echo "  public IPv4:       ${PUBLIC_IP:-(could not detect)}"
echo "  primary interface: $(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $5; exit}')"
echo "  primary local IP:  $(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"

# ─── Section 3: Resources ────────────────────────────────────────────
hr "3. Resources (CPU / RAM / Disk)"
echo "  CPU:"
maybe lscpu | grep -E 'Model name|CPU\(s\):|Architecture' | sed 's/^/    /'
echo
echo "  Memory:"
free -h 2>/dev/null | sed 's/^/    /'
echo
echo "  Disk free (top 5 mounts):"
df -hT 2>/dev/null | grep -vE '^Filesystem|tmpfs|devtmpfs|squashfs|overlay' | sort -k4 -h -r | head -5 | sed 's/^/    /'

# ─── Section 4: Existing IPFS / Kubo install ─────────────────────────
hr "4. IPFS / Kubo install"
if have ipfs; then
  echo "  ipfs binary:        $(command -v ipfs)"
  echo "  ipfs version:       $(ipfs version --number 2>/dev/null || echo 'unknown')"
  IPFS_PATH_RAW=$(ipfs config show 2>/dev/null | head -1 || echo '')
  IPFS_REPO_PATH="${IPFS_PATH:-$HOME/.ipfs}"
  echo "  IPFS_PATH (effective): ${IPFS_REPO_PATH}"
  if [ -d "$IPFS_REPO_PATH" ]; then
    echo "  repo size:          $(du -sh "$IPFS_REPO_PATH" 2>/dev/null | awk '{print $1}')"
    echo "  repo writable:      $( [ -w "$IPFS_REPO_PATH" ] && echo 'YES' || echo 'NO' )"
    if [ -f "$IPFS_REPO_PATH/config" ]; then
      echo "  Datastore.StorageMax:  $(grep -oE '"StorageMax"[^,]*' "$IPFS_REPO_PATH/config" 2>/dev/null | head -1)"
      echo "  Datastore.Spec type:   $(grep -oE '"type": *"[^"]*"' "$IPFS_REPO_PATH/config" 2>/dev/null | head -3 | tr '\n' ' ')"
      echo "  Routing.Type:          $(grep -oE '"Routing"[[:space:]]*:[[:space:]]*\{[^}]*\}' "$IPFS_REPO_PATH/config" 2>/dev/null | head -1)"
    fi
  fi
  # Daemon status
  if pgrep -f 'ipfs daemon' >/dev/null 2>&1; then
    echo "  daemon running:     YES (pid $(pgrep -f 'ipfs daemon' | head -1))"
    echo "  pinset count (recursive):"
    timeout 10 ipfs pin ls --type=recursive 2>/dev/null | wc -l | sed 's/^/    /'
    echo "  peers connected:"
    timeout 5 ipfs swarm peers 2>/dev/null | wc -l | sed 's/^/    /'
    echo "  PeerID:"
    timeout 5 ipfs id --format='<id>' 2>/dev/null | sed 's/^/    /'
    echo "  swarm addresses (advertised):"
    timeout 5 ipfs id --format='<addrs>' 2>/dev/null | tr ',' '\n' | head -6 | sed 's/^/    /'
  else
    echo "  daemon running:     NO"
  fi
else
  echo "  ipfs binary:        NOT INSTALLED"
fi

# ─── Section 5: IPFS Cluster install (if any) ────────────────────────
hr "5. IPFS Cluster install"
if have ipfs-cluster-service; then
  echo "  ipfs-cluster-service: $(command -v ipfs-cluster-service)"
  echo "  version:              $(ipfs-cluster-service --version 2>/dev/null | head -1)"
  if pgrep -f 'ipfs-cluster-service' >/dev/null 2>&1; then
    echo "  cluster daemon:       RUNNING (pid $(pgrep -f 'ipfs-cluster-service' | head -1))"
    if have ipfs-cluster-ctl; then
      echo "  cluster peers:"
      timeout 5 ipfs-cluster-ctl peers ls 2>/dev/null | sed 's/^/    /' | head -20
    fi
  else
    echo "  cluster daemon:       NOT RUNNING"
  fi
else
  echo "  ipfs-cluster-service: NOT INSTALLED"
fi

# ─── Section 6: Port availability ────────────────────────────────────
hr "6. Port availability (relevant to Cluster)"
for PORT in 4001 5001 8080 9094 9095 9096; do
  if have ss; then
    USE=$(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $0; exit}')
  else
    USE=$(netstat -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $0; exit}')
  fi
  if [ -z "$USE" ]; then
    echo "  $PORT: FREE"
  else
    echo "  $PORT: IN USE  →  $USE"
  fi
done

# ─── Section 7: Firewall posture ─────────────────────────────────────
hr "7. Firewall posture"
if have ufw; then
  echo "  ufw status:"
  ufw status 2>/dev/null | sed 's/^/    /' | head -20
elif have firewall-cmd; then
  echo "  firewalld zones (default):"
  firewall-cmd --get-active-zones 2>/dev/null | sed 's/^/    /'
  firewall-cmd --list-all 2>/dev/null | sed 's/^/    /' | head -20
elif have iptables; then
  echo "  iptables rules (filter table, INPUT chain):"
  iptables -L INPUT -n 2>/dev/null | head -30 | sed 's/^/    /' || echo "    (need root)"
else
  echo "  no recognised firewall tool found (ufw/firewalld/iptables)"
fi

# ─── Section 8: Currently running services on relevant ports ─────────
hr "8. Other services on relevant ports"
echo "  pm2 processes:"
maybe pm2 jlist 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(f"    name={p[\"name\"]} status={p[\"pm2_env\"][\"status\"]} mem={p[\"monit\"][\"memory\"]/1024/1024:.0f}MB") for p in d]' 2>/dev/null || echo "    (no pm2 or no processes)"
echo
echo "  systemd services matching ipfs|cluster|nginx|caddy|gateway:"
systemctl list-units --type=service --state=running 2>/dev/null | grep -iE 'ipfs|cluster|nginx|caddy|gateway|pc2' | sed 's/^/    /' || echo "    (none)"

# ─── Section 9: Outbound reachability to other supernodes ────────────
hr "9. Outbound reachability to other Elacity supernodes"
for HOST in "Contabo:38.242.211.112" "GCloud-ipfs.ela.city:34.77.31.164" "InterServer:69.164.241.210"; do
  NAME="${HOST%%:*}"
  IP="${HOST##*:}"
  # libp2p port (4001)
  if timeout 3 bash -c "</dev/tcp/$IP/4001" 2>/dev/null; then
    P4001="OPEN"
  else
    P4001="closed/filtered"
  fi
  # Cluster swarm (9096)
  if timeout 3 bash -c "</dev/tcp/$IP/9096" 2>/dev/null; then
    P9096="OPEN"
  else
    P9096="closed/filtered"
  fi
  echo "  $NAME ($IP):  4001=$P4001  9096=$P9096"
done

# ─── Section 10: Existing pc2-web-gateway / api endpoints ────────────
hr "10. Existing Elacity HTTP endpoints on this box"
for PATH_TRY in /api/health /api/storage/ipfs/pin /api/storage/ipfs/peers; do
  CODE=$(curl -fs -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:80${PATH_TRY}" 2>/dev/null)
  echo "  http://127.0.0.1:80${PATH_TRY}      → HTTP $CODE"
  CODE=$(curl -fs -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:8080${PATH_TRY}" 2>/dev/null)
  echo "  http://127.0.0.1:8080${PATH_TRY}    → HTTP $CODE"
  CODE=$(curl -fs -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1${PATH_TRY}" 2>/dev/null)
  echo "  https://127.0.0.1${PATH_TRY}        → HTTP $CODE"
done

# ─── Section 11: Summary recommendation ──────────────────────────────
hr "11. Auto-recommendation (heuristic)"
RECS=()
have ipfs || RECS+=("Install Kubo (latest stable)")
have ipfs-cluster-service || RECS+=("Install ipfs-cluster-service + ipfs-cluster-ctl")
have ipfs-cluster-ctl || true
DISKAVAIL=$(df / 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$DISKAVAIL" ] && [ "$DISKAVAIL" -lt 524288000 ]; then  # < 500GB
  RECS+=("Disk free under 500GB; reconsider quota or expand storage")
fi
if [ ${#RECS[@]} -eq 0 ]; then
  echo "  ✓ Box looks ready for Cluster setup. Proceed to Phase 2."
else
  for R in "${RECS[@]}"; do echo "  • $R"; done
fi

echo
echo "============================================================"
echo " Survey complete. Raw output also saved to: $RAW_OUT"
echo " Paste this entire block into:"
echo "   .cursor/tasks/SUPERNODE-CLUSTER-SETUP/SUPERNODE-CLUSTER-SETUP.md"
echo "============================================================"

# Copy raw output to the OUT path that's easy to scp back
cp "$RAW_OUT" "$OUT" 2>/dev/null || true
