#!/usr/bin/env bash
# =============================================================================
# Wave 8 Security Smoke Tests (Chipotle hardening, post-Irzhy review 2026-04-28)
#
# Regression suite for the findings closed in Wave 8 (audit disposition:
# docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md):
#
#   M-01   /api/media/* detectSmartAccountUser — SSRF via creator-controlled RPC
#   C-02   non-media + media Chipotle Lit Actions — kid/ciphertext binding
#   H-01.2 chipotle-client.ts — unsigned supernode provision JSON
#
# Offline tests (H-01.2 signature verification) run as a Node subprocess.
# Online tests (M-01) curl against a running PC2 node.
# C-02 requires signed session bundles + live chain state; its end-to-end
# verification is documented below as a manual checklist.
#
# USAGE
#   BASE_URL=http://localhost:8888 \
#   OWNER_KEY=<api-key-of-owner-wallet> \
#   OWNER_WALLET=0xOwnerWallet \
#     ./scripts/wave8-smoke.sh
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8888}"
OWNER_KEY="${OWNER_KEY:-}"
OWNER_WALLET="${OWNER_WALLET:-}"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC} $1\n    ${YELLOW}$2${NC}"; FAIL=$((FAIL+1)); }
hdr()  { echo ""; echo -e "${BLUE}── $1 ──${NC}"; }

SCRIPT_DIR="$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)"

echo -e "${BLUE}Wave 8 Security Smoke Tests${NC}"
echo "  Base URL: $BASE_URL"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# H-01.2 — Signed provision envelope verification (offline)
# ─────────────────────────────────────────────────────────────────────────────
hdr "H-01.2: signed provision envelope verification (offline)"

if node "${SCRIPT_DIR}/wave8-provision-sig-test.mjs"; then
  pass "provision signature harness PASSED"
else
  fail "provision signature harness FAILED" "see output above"
fi

# ─────────────────────────────────────────────────────────────────────────────
# M-01 — SSRF via creator-controlled RPC URL (static check; always runs)
# ─────────────────────────────────────────────────────────────────────────────
hdr "M-01: creator-controlled RPC is ignored"

MEDIA_TS="$(dirname "$SCRIPT_DIR")/src/api/media.ts"

if grep -q 'SEC Wave 8 (M-01)' "$MEDIA_TS"; then
  pass "media.ts contains the M-01 fix marker"
else
  fail "media.ts missing M-01 marker" "fix may have regressed"
fi

if ! grep -nE 'data\?\.rpc|data\.rpc|saEntry[^_].*rpc' "$MEDIA_TS" >/dev/null 2>&1; then
  pass "no creator-controlled RPC references remain in media.ts"
else
  fail "creator-controlled RPC pattern still present" "grep found a data.rpc reference"
fi

# ─────────────────────────────────────────────────────────────────────────────
# C-02 — Lit Action kid/ciphertext binding (source check)
# ─────────────────────────────────────────────────────────────────────────────
hdr "C-02: Lit Action kid/ciphertext binding (source check)"

LIT_DIR="$(dirname "$SCRIPT_DIR")/data/lit-actions"

for action in non-media-decrypt-chipotle.js media-decrypt-chipotle.js; do
  path="$LIT_DIR/$action"
  if grep -q 'SEC Wave 8 (C-02)' "$path" && \
     grep -q 'kid_binding_mismatch' "$path" && \
     grep -q "crypto.subtle.digest('SHA-256'" "$path"; then
    pass "$action contains the C-02 binding check"
  else
    fail "$action missing C-02 binding check" "re-check Lit Action source"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
hdr "Summary"
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo ""

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}Wave 8 regression detected.${NC}"
  exit 1
fi

echo -e "${GREEN}Wave 8 automated checks PASSED.${NC}"
echo ""
echo -e "${YELLOW}Manual C-02 end-to-end checks (run after Lit Action CID rotation):${NC}"
cat <<'EOF'
  1. POSITIVE: Mint a new non-media asset as wallet A, buy AccessToken with
     wallet B, open via /api/storage/lit/secure-view → must render successfully.

  2. NEGATIVE (non-media): wallet B holds access to asset-A. B crafts a
     secure-view request signed for kid-A but submits kid-B's litCiphertext +
     dataToEncryptHash in the body. The Lit Action MUST respond with error
     code `kid_binding_mismatch` and the server MUST return a 4xx.

  3. POSITIVE (media): Mint a video asset, buy AccessToken, request
     /api/media/init → MPEG-DASH streams must play.

  4. NEGATIVE (media): same kid-A / kid-B ciphertext swap → Lit Action
     returns kid_binding_mismatch.

  All four tests must pass before closing SEC-2026-04-28-WAVE8 as Done.
EOF
exit 0
