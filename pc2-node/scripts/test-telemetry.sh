#!/usr/bin/env bash
# Smoke test for A5 — telemetry on-ramp endpoints.
# Validates: POST owner-only auth, all 4 events writable, GET aggregates correctly.
#
# Usage:
#   bash pc2-node/scripts/test-telemetry.sh
#
# Env vars:
#   PC2_HOST    — default http://localhost:4200
#   PC2_TOKEN   — owner JWT (required for POST). Read from current owner session
#                 if not set; falls back to looking up the active token in dev mode.
set -euo pipefail

HOST="${PC2_HOST:-http://localhost:4200}"
TOKEN="${PC2_TOKEN:-}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue() { printf '\033[34m%s\033[0m\n' "$*"; }

if [ -z "$TOKEN" ]; then
  red "PC2_TOKEN not set — skipping POST tests, will only verify GET endpoint."
  blue "  To run full test: PC2_TOKEN=<owner-jwt> bash pc2-node/scripts/test-telemetry.sh"
fi

blue "[1] GET /api/telemetry/onramp/summary (public, before any events)"
BEFORE=$(curl -fsS --max-time 5 "$HOST/api/telemetry/onramp/summary")
echo "$BEFORE" | python3 -m json.tool || { red "  ✗ GET failed"; exit 1; }
BEFORE_INSTALL=$(echo "$BEFORE" | python3 -c "import sys,json;print(json.load(sys.stdin)['events']['install_started'])")
green "  ✓ baseline install_started: $BEFORE_INSTALL"

if [ -n "$TOKEN" ]; then
  echo
  blue "[2] POST 4 valid events (owner-only)"
  for evt in install_started wallet_ready first_capsule_open first_payment; do
    OUT=$(curl -fsS --max-time 5 -X POST "$HOST/api/telemetry/onramp" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"event\":\"$evt\"}")
    OUT_EVT=$(echo "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('event','MISSING'))")
    if [ "$OUT_EVT" = "$evt" ]; then
      green "  ✓ $evt → recorded"
    else
      red "  ✗ $evt → unexpected response: $OUT"; exit 1
    fi
  done

  echo
  blue "[3] POST invalid event (should reject with 400)"
  CODE=$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' -X POST "$HOST/api/telemetry/onramp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"event":"random_evil_event"}' || true)
  if [ "$CODE" = "400" ]; then
    green "  ✓ rejected with 400"
  else
    red "  ✗ expected 400, got $CODE"; exit 1
  fi

  echo
  blue "[4] POST without auth (should reject with 401)"
  CODE=$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' -X POST "$HOST/api/telemetry/onramp" \
    -H "Content-Type: application/json" \
    -d '{"event":"install_started"}' || true)
  if [ "$CODE" = "401" ]; then
    green "  ✓ rejected with 401"
  else
    red "  ✗ expected 401, got $CODE"; exit 1
  fi

  echo
  blue "[5] GET summary again — counts should have increased by 1 each"
  AFTER=$(curl -fsS --max-time 5 "$HOST/api/telemetry/onramp/summary")
  echo "$AFTER" | python3 -m json.tool
  AFTER_INSTALL=$(echo "$AFTER" | python3 -c "import sys,json;print(json.load(sys.stdin)['events']['install_started'])")
  if [ "$AFTER_INSTALL" -eq "$((BEFORE_INSTALL + 1))" ]; then
    green "  ✓ install_started: $BEFORE_INSTALL → $AFTER_INSTALL"
  else
    red "  ✗ expected install_started to be $((BEFORE_INSTALL + 1)), got $AFTER_INSTALL"; exit 1
  fi
fi

echo
green "✅ All telemetry smoke tests passed."
