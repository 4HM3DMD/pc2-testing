#!/bin/bash
# Start PC2 node with Elacity Kubo pin forward enabled.
#
# Reads ELACITY_PIN_FORWARD_URL + ELACITY_PIN_FORWARD_TOKEN from
# ~/.pc2-secrets/elacity-pin.env (git-ignored, 0600 perms).
#
# ELACITY-KUBO-PIN-FORWARD task — commit 92a953022.
set -euo pipefail

ELACITY_ENV="$HOME/.pc2-secrets/elacity-pin.env"
if [[ -f "$ELACITY_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$ELACITY_ENV"
  echo "🔗 Elacity pin forward: $ELACITY_PIN_FORWARD_URL"
else
  echo "⚠️  $ELACITY_ENV not found — pin forward will be disabled"
fi

cd "$(dirname "$0")"

echo "🚀 Starting PC2 Node..."
echo "   Port: 4200"
echo "   Database: $(pwd)/data/pc2.db"
echo ""

exec env PORT=4200 \
  ELACITY_PIN_FORWARD_URL="${ELACITY_PIN_FORWARD_URL:-}" \
  ELACITY_PIN_FORWARD_TOKEN="${ELACITY_PIN_FORWARD_TOKEN:-}" \
  node dist/index.js
