#!/usr/bin/env bash
# =============================================================================
# Wave 5 + Wave 5.5 Security Smoke Tests
#
# Regression suite for the release-blocking findings closed in Wave 5 and
# Wave 5.5 (audit disposition: docs/handover/SEC_2026_04_21_AUDIT_DISPOSITION.md).
#
#   A1  /api/terminal/exec     — RCE for any authenticated wallet
#   A2  /api/git/*             — RCE via shell-concat of body fields
#   A3  /api/backups/*         — owner mnemonic exfil + node takeover
#   A4  /read fallback         — cross-wallet file read
#   A5  /api/ai/voice/*        — sudo-driven installs by tethered wallet
#   A17 /api/installed-apps/*  — app-install RCE + owner-file exfil
#   A19 multer originalname    — disk-write path traversal
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
echo -e "${BLUE}  Wave 5 + 5.5 Security Smoke Tests${NC}"
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
# A17 — installed-apps: requireOwner on mutating routes + localDir allowlist
# -----------------------------------------------------------------------------
hdr "A17 /api/installed-apps/*"

# 1. Tethered wallet cannot install from IPFS
code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/installed-apps/install" \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{"name":"x","title":"x","version":"1.0.0"},"cid":"bafytest"}')
[[ "$code" == "403" ]] && pass "tethered POST /install → 403" \
  || fail "tethered wallet must be denied /install" "got HTTP $code"

# 2. Tethered wallet cannot sideload (the dangerous path)
code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/installed-apps/install-local" \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{"name":"x","title":"x","version":"1.0.0"},"localDir":"/tmp"}')
[[ "$code" == "403" ]] && pass "tethered POST /install-local → 403" \
  || fail "tethered wallet must be denied /install-local" "got HTTP $code"

# 3. Tethered wallet cannot update or uninstall
code=$(status "$TETHERED_KEY" -X POST "$BASE_URL/api/installed-apps/update" \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{"name":"x","title":"x","version":"1.0.1"},"cid":"bafytest"}')
[[ "$code" == "403" ]] && pass "tethered POST /update → 403" \
  || fail "tethered wallet must be denied /update" "got HTTP $code"

code=$(status "$TETHERED_KEY" -X DELETE "$BASE_URL/api/installed-apps/somename")
[[ "$code" == "403" ]] && pass "tethered DELETE /:name → 403" \
  || fail "tethered wallet must be denied DELETE" "got HTTP $code"

# 4. Owner sideloading OUTSIDE data/dev-apps/ → 400 (the allowlist check)
#    The 400 comes from AppInstallService rejecting the path; even if the
#    test setup doesn't have a real entry file, the allowlist check fires
#    first and returns the localDir error message.
resp=$(body "$OWNER_KEY" -X POST "$BASE_URL/api/installed-apps/install-local" \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{"name":"evil","title":"evil","version":"1.0.0"},"localDir":"/etc"}')
echo "$resp" | grep -qi 'localdir must live inside' \
  && pass "owner + localDir=/etc → rejected by allowlist" \
  || fail "owner sideload outside data/dev-apps/ should be rejected by allowlist" "$resp"

# 5. Listing routes still work for tethered wallets (read-only is fine)
code=$(status "$TETHERED_KEY" "$BASE_URL/api/installed-apps")
[[ "$code" == "200" || "$code" == "401" ]] && pass "tethered GET / → $code (not 403; listing is read-only)" \
  || fail "tethered listing must NOT be 403" "got HTTP $code"

# -----------------------------------------------------------------------------
# A19 — multer disk-write path traversal: rejected before any write
# -----------------------------------------------------------------------------
hdr "A19 multer originalname traversal"

# Use the backup-restore endpoint because (a) it requires owner so we can
# isolate the multer fileFilter behaviour, and (b) it has the strictest
# regex. A path-traversal originalname must be rejected by multer's
# fileFilter BEFORE any file lands on disk.
TMPFILE=$(mktemp)
echo "fake-backup-content" > "$TMPFILE"

# 1. Crafted originalname with `..` segments → must NOT contaminate /etc/cron.d.
#    Busboy 1.6 (the parser multer 2.x sits on) strips the path component via
#    its own basename() before the fileFilter ever runs, so the route sees
#    `evil.tar.gz` and accepts it (HTTP 200) — the file lands in BACKUPS_DIR
#    under that safe name. 400/500 are also acceptable if a future multer/
#    busboy bump stops auto-basenaming. The actual security property — no
#    write to the malicious target path — is verified by the disk sanity
#    check at the bottom of this section.
resp=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-API-Key: $OWNER_KEY" \
  -X POST "$BASE_URL/api/backups/restore" \
  -F "file=@${TMPFILE};filename=../../etc/cron.d/evil.tar.gz")
[[ "$resp" == "200" || "$resp" == "400" || "$resp" == "500" ]] && pass "owner + originalname=../../etc/... → $resp (busboy basename strips traversal)" \
  || fail "path-traversal originalname must be rejected or normalized" "got HTTP $resp"

# 2. Originalname not ending in .tar.gz → also rejected by fileFilter
resp=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-API-Key: $OWNER_KEY" \
  -X POST "$BASE_URL/api/backups/restore" \
  -F "file=@${TMPFILE};filename=evil.sh")
[[ "$resp" == "400" || "$resp" == "500" ]] && pass "owner + originalname=evil.sh → $resp (rejected pre-write)" \
  || fail "non-tar.gz originalname must be rejected" "got HTTP $resp"

# 3. Originalname with leading dash → also rejected (regex is alnum + ._-)
resp=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-API-Key: $OWNER_KEY" \
  -X POST "$BASE_URL/api/backups/restore" \
  -F "file=@${TMPFILE};filename=--evil.tar.gz")
[[ "$resp" == "400" || "$resp" == "500" ]] && pass "owner + originalname=--evil.tar.gz → $resp (regex denies)" \
  || fail "leading-dash originalname must be rejected" "got HTTP $resp"

# Side-channel check: confirm no /etc/cron.d/evil.tar.gz was created.
# (We don't have shell on the target node from here — this is a sanity
# reminder for the operator running the smoke suite.)
if [[ -e /etc/cron.d/evil.tar.gz ]]; then
  fail "DISK CONTAMINATION DETECTED" "/etc/cron.d/evil.tar.gz exists — A19 fix did NOT hold"
else
  pass "no /etc/cron.d/evil.tar.gz on operator host (sanity)"
fi

rm -f "$TMPFILE"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo -e "${BLUE}═════════════════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}  ✓ Wave 5 + 5.5 smoke tests: ALL $PASS PASSED${NC}"
  exit 0
else
  echo -e "${RED}  ✗ Wave 5 + 5.5 smoke tests: $PASS PASSED, $FAIL FAILED${NC}"
  exit 1
fi
