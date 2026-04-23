#!/usr/bin/env bash
# =============================================================================
# Wave 5 Security Smoke Tests
#
# Regression suite for the five release-blocking findings closed in Wave 5
# (audit disposition: docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md).
#
#   A1  /api/terminal/exec  — RCE for any authenticated wallet
#   A2  /api/git/*          — RCE via shell-concat of body fields
#   A3  /api/backups/*      — owner mnemonic exfil + node takeover
#   A4  /read fallback      — cross-wallet file read
#   A5  /api/ai/voice/*     — sudo-driven installs by tethered wallet
#
# These tests confirm the fixes are wired correctly. They DO NOT replace the
# unit-test suite — run those first with `npm test`.
#
# USAGE
#   BASE_URL=http://localhost:8888 \
#   OWNER_KEY=<api-key-of-owner-wallet> \
#   TETHERED_KEY=<api-key-of-tethered-wallet> \
#   OWNER_WALLET=0xOwnerWallet \
#   FOREIGN_WALLET=0xSomeOtherWalletWithFiles \
#     ./scripts/wave5-smoke.sh
#
# Both keys must be provisioned via /api/keys with the `terminal,backup,git`
# scopes. The OWNER_WALLET must match `config.json:owner.wallet_address`. The
# FOREIGN_WALLET should be a different wallet that has at least one file the
# A4 cross-read test can target (e.g. /0xFOREIGN_WALLET/Public/.profile).
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8888}"
OWNER_KEY="${OWNER_KEY:?OWNER_KEY is required (api key of the owner wallet)}"
TETHERED_KEY="${TETHERED_KEY:?TETHERED_KEY is required (api key of a tethered wallet)}"
OWNER_WALLET="${OWNER_WALLET:?OWNER_WALLET is required}"
FOREIGN_WALLET="${FOREIGN_WALLET:-${OWNER_WALLET}}"

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

# Helper: HTTP status code only
status() {
  local key="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $key" "$@"
}

# Helper: full response body
body() {
  local key="$1"; shift
  curl -s -H "X-API-Key: $key" "$@"
}

echo -e "${BLUE}═════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Wave 5 Security Smoke Tests${NC}"
echo -e "${BLUE}  Target: $BASE_URL${NC}"
echo -e "${BLUE}═════════════════════════════════════════════════${NC}"

# -----------------------------------------------------------------------------
# A1 — terminal: requireOwner + execFile + reject shell:true
# -----------------------------------------------------------------------------
hdr "A1 /api/terminal/exec"

code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/terminal/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo","args":["hi"]}')
[[ "$code" == "403" ]] && pass "tethered wallet → 403 Forbidden" \
  || fail "tethered wallet should be denied" "got HTTP $code"

code=$(status "$OWNER_KEY" -X POST "$BASE_URL/api/terminal/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo","args":["hi"],"shell":true}')
[[ "$code" == "400" ]] && pass "owner + shell:true → 400 Bad Request" \
  || fail "shell:true must be rejected" "got HTTP $code"

code=$(status "$OWNER_KEY" -X POST "$BASE_URL/api/terminal/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo;rm -rf /","args":[]}')
[[ "$code" == "400" ]] && pass "owner + metacharacters in command → 400" \
  || fail "shell metacharacters in command must be rejected" "got HTTP $code"

code=$(status "$OWNER_KEY" -X POST "$BASE_URL/api/terminal/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo","args":["hello"]}')
[[ "$code" == "200" ]] && pass "owner + clean argv → 200 OK" \
  || fail "owner argv form should succeed" "got HTTP $code"

# -----------------------------------------------------------------------------
# A2 — git: argv form + input validation (per-user, not owner-locked)
# -----------------------------------------------------------------------------
hdr "A2 /api/git/clone"

code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/git/clone" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/git/git.git","branch":"--upload-pack=evil"}')
[[ "$code" == "400" ]] && pass "branch with leading dash → 400" \
  || fail "argument injection via branch must be rejected" "got HTTP $code"

code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/git/clone" \
  -H 'Content-Type: application/json' \
  -d '{"url":"file:///etc/passwd"}')
[[ "$code" == "400" ]] && pass "non-https/ssh url → 400" \
  || fail "non-https/ssh url must be rejected" "got HTTP $code"

# -----------------------------------------------------------------------------
# A3 — backups: requireOwner on all 5 routes + filename whitelist
# -----------------------------------------------------------------------------
hdr "A3 /api/backups/*"

for route in \
  "POST /api/backups/create" \
  "GET  /api/backups" \
  "GET  /api/backups/download/foo.tar.gz" \
  "DELETE /api/backups/foo.tar.gz"; do
  method="${route%% *}"
  path="${route##* }"
  code=$(status "$TETHERED_KEY" -X "$method" "$BASE_URL$path")
  [[ "$code" == "403" ]] && pass "$method $path → 403 (tethered)" \
    || fail "tethered wallet must be denied $method $path" "got HTTP $code"
done

code=$(status "$OWNER_KEY" "$BASE_URL/api/backups/download/..%2F..%2Fetc%2Fpasswd")
[[ "$code" == "400" ]] && pass "owner + path-traversal filename → 400" \
  || fail "path traversal in backup filename must be rejected" "got HTTP $code"

code=$(status "$OWNER_KEY" "$BASE_URL/api/backups/download/--evil.tar.gz")
[[ "$code" == "400" ]] && pass "owner + leading-dash filename → 400" \
  || fail "leading-dash filename must be rejected (flag injection)" "got HTTP $code"

# -----------------------------------------------------------------------------
# A4 — filesystem: cross-wallet read denied
# -----------------------------------------------------------------------------
hdr "A4 /read cross-wallet"

if [[ "$FOREIGN_WALLET" == "$OWNER_WALLET" ]]; then
  echo -e "  ${YELLOW}⚠${NC} FOREIGN_WALLET not set — skipping cross-wallet read test"
else
  code=$(status "$TETHERED_KEY" "$BASE_URL/read?path=/${FOREIGN_WALLET}/Public/.profile")
  [[ "$code" == "404" || "$code" == "403" ]] && pass "tethered → /<foreign>/Public/.profile → $code" \
    || fail "cross-wallet read must NOT succeed" "got HTTP $code"
fi

# -----------------------------------------------------------------------------
# A5 — voice: requireOwner on install/enable/disable
# -----------------------------------------------------------------------------
hdr "A5 /api/ai/voice/*"

for route in voice/install voice/enable voice/disable; do
  code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/ai/$route")
  [[ "$code" == "403" ]] && pass "POST /api/ai/$route → 403 (tethered)" \
    || fail "tethered wallet must be denied /api/ai/$route" "got HTTP $code"
done

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo -e "${BLUE}═════════════════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}  ✓ Wave 5 smoke tests: ALL $PASS PASSED${NC}"
  exit 0
else
  echo -e "${RED}  ✗ Wave 5 smoke tests: $PASS PASSED, $FAIL FAILED${NC}"
  exit 1
fi
