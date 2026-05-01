#!/bin/bash
#
# PC2 Safe Update / Recovery Script
#
# Use this when:
#   - the GUI auto-updater is stuck or has failed
#   - you're on a v1.2.0 / v1.2.1 / v1.2.2 node and the auto-updater
#     can't carry you forward (older UpdateService.ts had bugs that
#     this script works around)
#   - you suspect the install is half-finished and want a forced clean
#     re-sync to whatever's on origin/main
#
# Run from inside the pc2.net repo:
#   cd ~/pc2.net && bash scripts/update.sh
#
# Or one-line from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/update.sh | bash
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PC2_DIR="$(dirname "$SCRIPT_DIR")"
PC2_NODE_DIR="$PC2_DIR/pc2-node"

# Allow running via `curl | bash` outside the repo: try common install
# locations and fall back to a clear error.
if [[ ! -d "$PC2_NODE_DIR" ]]; then
    for candidate in "$HOME/pc2.net" "$HOME/.pc2"; do
        if [[ -d "$candidate/pc2-node" ]]; then
            PC2_DIR="$candidate"
            PC2_NODE_DIR="$candidate/pc2-node"
            SCRIPT_DIR="$candidate/scripts"
            break
        fi
    done
fi

if [[ ! -d "$PC2_NODE_DIR" ]]; then
    echo "❌ Cannot find pc2-node directory."
    echo "   Looked in: $PC2_DIR/pc2-node, ~/pc2.net/pc2-node, ~/.pc2/pc2-node"
    echo "   Run this script from inside the pc2.net repo, or clone it first:"
    echo "     git clone https://github.com/Elacity/pc2.net ~/pc2.net && bash ~/pc2.net/scripts/update.sh"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────
# Safety: refuse to obliterate uncommitted work. Step 4 below does
# `git reset --hard origin/main`, which is exactly what a developer
# WOULDN'T want if they accidentally ran this script from inside their
# dev tree. A production node has no uncommitted changes (the auto-
# updater calls `git checkout -- .` before us anyway), so this guard
# only fires for accidents.
#
# Override with `PC2_UPDATE_FORCE=1` if you actually do want to nuke
# local changes (e.g. corrupted tree on a production node).
# ─────────────────────────────────────────────────────────────────────
cd "$PC2_DIR"
if [[ -z "$PC2_UPDATE_FORCE" ]]; then
    DIRTY="$(git status --porcelain 2>/dev/null | head -1)"
    if [[ -n "$DIRTY" ]]; then
        echo "❌ Refusing to run: working tree at $PC2_DIR has uncommitted changes."
        echo ""
        echo "   First file flagged: $DIRTY"
        echo "   Full status: cd $PC2_DIR && git status"
        echo ""
        echo "   This script does 'git reset --hard origin/main' which would"
        echo "   destroy those changes. If you really want to proceed (e.g. on"
        echo "   a corrupted production node), re-run with:"
        echo ""
        echo "     PC2_UPDATE_FORCE=1 bash $0"
        echo ""
        exit 1
    fi
fi

# Defence-in-depth: every npm command in this script runs with HUSKY=0
# regardless of which version of package.json is on disk. Older
# package.json versions had `"prepare": "husky"` which crashed npm
# install on production nodes (no husky binary). The v1.2.4 package.json
# wraps it in `husky 2>/dev/null || true`, but if the tree is in a
# half-updated state the OLD package.json might still be present until
# git reset completes — so we belt-and-braces it here too.
export HUSKY=0
export CI=true

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  PC2 Safe Update / Recovery                                  ║"
echo "║  Repo: $PC2_DIR"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Step 1: stop PC2 cleanly so we don't fight ourselves while building
# ─────────────────────────────────────────────────────────────────────
echo "📛 Step 1: Stopping PC2..."
pm2 stop pc2 2>/dev/null || true
sleep 2

echo "🔪 Step 2: Killing orphaned processes..."
pm2 delete pc2 2>/dev/null || true
pkill -9 -f "node.*pc2-node.*dist/index" 2>/dev/null || true
pkill -9 -f "node.*dist/index.js" 2>/dev/null || true
sleep 3

echo "🔍 Step 3: Verifying ports are free..."
for port in 4200 4001 4002; do
    if lsof -i :$port >/dev/null 2>&1; then
        echo "   ⚠️  Port $port still in use, force killing..."
        fuser -k $port/tcp 2>/dev/null || true
        sleep 2
    fi
done

if lsof -i :4200 >/dev/null 2>&1; then
    echo "❌ ERROR: Port 4200 still in use after cleanup. Manually kill the holder:"
    lsof -i :4200
    exit 1
fi
echo "   ✅ All ports free"

# ─────────────────────────────────────────────────────────────────────
# Step 4: Pull latest code (force-reset, no merges)
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "📥 Step 4: Pulling latest code from origin/main..."
cd "$PC2_DIR"
git fetch origin main
git reset --hard origin/main
# Drop any half-installed asset artefacts from a broken previous run
git clean -fd src/particle-auth/assets/ 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────
# Step 5: Install at BOTH root AND pc2-node.
#
# This is the critical step that v1.2.0 / v1.2.1 / v1.2.2 in-app
# UpdateService got wrong — it only ran `npm install` in pc2-node, so
# any new dep added at the root (consumed via `await import()` from
# pc2-node) was missing on the next boot. We always install both.
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "📦 Step 5: Installing root dependencies..."
cd "$PC2_DIR"
npm install --legacy-peer-deps --no-fund --no-audit

echo ""
echo "📦 Step 6: Installing pc2-node dependencies..."
cd "$PC2_NODE_DIR"
npm install --legacy-peer-deps --include=dev --no-fund --no-audit

# ─────────────────────────────────────────────────────────────────────
# Step 7: Rebuild native modules from source.
#
# Defends against the NODE_MODULE_VERSION mismatch that bites every
# time the runtime Node version differs from whatever Node was used
# to install the prebuilds (e.g. fresh launcher install on Node 22
# pulling Node 20 prebuilds for better-sqlite3 v9).
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "🔨 Step 7: Rebuilding native modules..."
if ! npm rebuild --build-from-source 2>&1; then
    echo "   ⚠️  Bulk rebuild had errors, retrying critical modules individually..."
    if ! npm rebuild better-sqlite3 --build-from-source; then
        echo ""
        echo "❌ better-sqlite3 failed to rebuild. The server cannot start without it."
        echo "   Common causes:"
        echo "     - missing build tools (Linux: apt install build-essential python3)"
        echo "     - missing Xcode CLT on macOS (run: xcode-select --install)"
        exit 1
    fi
    npm rebuild canvas 2>&1 || echo "   ⚠️  canvas rebuild failed (PDF/text thumbnails disabled, non-fatal)"
    npm rebuild sharp 2>&1 || echo "   ⚠️  sharp rebuild failed (image thumbnails may degrade, non-fatal)"
fi

# ─────────────────────────────────────────────────────────────────────
# Step 8: Build everything (gui + backend + frontend).
#
# Order matters:
#   1. build:frontend (pc2-node) — wipes frontend/, repopulates from
#      src/wallet-bridge + static-assets + GUI bundle. THIS is what
#      copies pc2-secure-view.js into a place the browser can load it.
#      v1.2.0/1/2/3 update flows skipped this and so wallet-bridge
#      fixes never reached the browser.
#   2. build:gui (root) — guarantees the desktop bundle is fresh.
#   3. build:backend (pc2-node) — tsc.
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "🔨 Step 8: Syncing wallet-bridge files (build:frontend)..."
cd "$PC2_NODE_DIR"
npm run build:frontend || echo "   ⚠️  build:frontend not available on this revision, skipping"

echo ""
echo "🔨 Step 9: Building GUI bundle..."
cd "$PC2_DIR"
npm run build:gui

echo ""
echo "🔨 Step 10: Compiling backend..."
cd "$PC2_NODE_DIR"
npm run build:backend

# ─────────────────────────────────────────────────────────────────────
# Step 11: Sanity-check better-sqlite3 against the running Node ABI
# before we hand off to PM2 — fail here with a clear message rather
# than 30 seconds later in pm2 logs.
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "🧪 Step 11: Verifying better-sqlite3 works under $(node -v)..."
if ! node -e "require('better-sqlite3')(':memory:').prepare('SELECT 1').get()" 2>&1; then
    echo "❌ better-sqlite3 loads but throws — ABI mismatch. Try:"
    echo "   cd $PC2_NODE_DIR && npm rebuild better-sqlite3 --build-from-source"
    exit 1
fi
echo "   ✅ better-sqlite3 verified"

# ─────────────────────────────────────────────────────────────────────
# Step 12: Start under PM2.
# Prefer ecosystem.config.cjs if present (handles env, restart policy,
# log paths). Falls back to bare invocation otherwise.
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "🚀 Step 12: Starting PC2..."
cd "$PC2_DIR"
if [ -f "ecosystem.config.cjs" ]; then
    pm2 start ecosystem.config.cjs
else
    pm2 start "$PC2_NODE_DIR/dist/index.js" \
        --name pc2 \
        --cwd "$PC2_NODE_DIR" \
        --restart-delay 10000 \
        --max-restarts 5
fi
pm2 save

# ─────────────────────────────────────────────────────────────────────
# Step 13: Verify startup. Give it 10 seconds for IPFS bootstrap
# and the first Lit handshake before declaring success.
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "🔍 Step 13: Verifying startup..."
sleep 10
if pm2 show pc2 | grep -q "online"; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  ✅ PC2 Updated Successfully!                                ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    pm2 status
    echo ""
    echo "Health check:"
    curl -s http://localhost:4200/health | head -1
    echo ""
else
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  ⚠️  PC2 started but may have issues. Check the logs:        ║"
    echo "║     pm2 logs pc2                                             ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    pm2 status
    exit 1
fi
