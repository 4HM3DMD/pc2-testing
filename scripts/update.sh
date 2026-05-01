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

# Source nvm if installed so that node/npm/pm2 (commonly installed via
# `npm i -g pm2` under nvm-managed Node) are on PATH. Without this, the
# script's bare bash environment doesn't see ~/.nvm/versions/node/*/bin
# and `pm2 stop` fails with "command not found", breaking step 1 even
# though pm2 is installed and working in the user's interactive shell.
# v1.2.4's update.sh shipped without this and broke for users on a
# nvm-managed pm2 install (reported by 4HM3D, Apr 30 2026).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    \. "$NVM_DIR/nvm.sh"
fi

# Last-ditch: probe the standard nvm-managed pm2 location and add it to
# PATH if the symlink chain is intact. This catches setups where nvm.sh
# isn't installed but pm2 is at a known location.
if ! command -v pm2 >/dev/null 2>&1; then
    for npm_bin_dir in "$HOME"/.nvm/versions/node/*/bin /usr/local/bin /opt/homebrew/bin; do
        if [[ -x "$npm_bin_dir/pm2" ]]; then
            export PATH="$npm_bin_dir:$PATH"
            break
        fi
    done
fi

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

# Verify pm2 is actually reachable now that we've sourced nvm + probed
# common locations. If it's still missing the user genuinely needs to
# install it, and we should say so clearly.
if ! command -v pm2 >/dev/null 2>&1; then
    echo "❌ pm2 is required but not on PATH."
    echo ""
    echo "   Install it (one of):"
    echo "     npm install -g pm2"
    echo "     # or with nvm:"
    echo "     source ~/.nvm/nvm.sh && nvm use default && npm install -g pm2"
    echo ""
    echo "   Then re-run this script."
    exit 1
fi
echo "✓ pm2 found at: $(command -v pm2)"
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
# Strategy: only force --build-from-source for better-sqlite3 (the one
# module known to ship Node-22-incompatible prebuilds). For everything
# else, run plain `npm rebuild` so prebuild-install can use the
# prebuilt binary when available.
#
# v1.2.4 forced --build-from-source for ALL modules, which broke fresh
# installs because node-datachannel falls back to a cmake-js source
# build when no prebuild is available — and most users don't have
# cmake installed. v1.2.5 reverts to the proven v1.2.3 strategy.
if ! npm rebuild better-sqlite3 --build-from-source 2>&1; then
    echo ""
    echo "❌ better-sqlite3 failed to rebuild. The server cannot start without it."
    echo "   Common causes:"
    echo "     - missing build tools (Linux: apt install build-essential python3)"
    echo "     - missing Xcode CLT on macOS (run: xcode-select --install)"
    exit 1
fi
# Refresh the rest using prebuilds when available.
npm rebuild 2>&1 || echo "   ⚠️  Some optional native modules didn't rebuild (non-fatal — see above)"

# ─────────────────────────────────────────────────────────────────────
# Step 7b: Native module verification gauntlet.
#
# Each critical native module gets THREE attempts:
#   1. Plain load — works when prebuild-install resolved cleanly.
#   2. (Already done above for everything via `npm rebuild`.)
#   3. Clean reinstall — wipes node_modules/MOD, runs `npm install MOD`
#      which forces a fresh prebuild-install query against the CURRENT
#      Node ABI. This is what Ahmed had to do manually after v1.2.4
#      silent-shipped a broken node-datachannel — `npm rebuild` reuses
#      stale install metadata, only a clean reinstall queries fresh.
#
# If both steps fail, exit with a fix-it-yourself hint that's specific
# to the module.
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "🧪 Step 7b: Verifying critical native modules load..."

# better-sqlite3 (CJS) — verify by initialising an in-memory db.
if ! node -e "require('better-sqlite3')(':memory:').prepare('SELECT 1').get()" >/dev/null 2>&1; then
    echo "   ⚠️  better-sqlite3 doesn't load — clean reinstalling..."
    rm -rf node_modules/better-sqlite3
    npm install better-sqlite3 --legacy-peer-deps --build-from-source 2>&1 || true
    if ! node -e "require('better-sqlite3')(':memory:').prepare('SELECT 1').get()" >/dev/null 2>&1; then
        echo "❌ better-sqlite3 cannot be made to load. Try:"
        echo "   xcode-select --install    # macOS"
        echo "   sudo apt install build-essential python3    # Linux"
        node -e "require('better-sqlite3')(':memory:').prepare('SELECT 1').get()" 2>&1
        exit 1
    fi
    echo "   ✅ better-sqlite3 recovered via clean reinstall"
else
    echo "   ✅ better-sqlite3 verified"
fi

# node-datachannel (ESM) — verify via dynamic import.
if ! node -e "import('node-datachannel').then(m => { if (!m) throw new Error('null'); }).catch(e => { console.error(e.message); process.exit(1); })" >/dev/null 2>&1; then
    echo "   ⚠️  node-datachannel doesn't load — clean reinstalling..."
    rm -rf node_modules/node-datachannel
    npm install node-datachannel --legacy-peer-deps 2>&1 || true
    if ! node -e "import('node-datachannel').then(m => { if (!m) throw new Error('null'); }).catch(e => { console.error(e.message); process.exit(1); })" >/dev/null 2>&1; then
        echo "❌ node-datachannel cannot be made to load. Try:"
        if [[ "$(uname -s)" == "Darwin" ]]; then
            echo "   brew install cmake"
        else
            echo "   sudo apt install cmake"
        fi
        echo "   cd $PC2_NODE_DIR && rm -rf node_modules/node-datachannel && npm install node-datachannel"
        echo "   Then re-run this script."
        node -e "import('node-datachannel').then(()=>console.log('would have loaded')).catch(e => console.error(e.message))" 2>&1
        exit 1
    fi
    echo "   ✅ node-datachannel recovered via clean reinstall"
else
    echo "   ✅ node-datachannel verified"
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

# Step 11 (better-sqlite3 ABI re-verify) was merged into Step 7b above
# — the verification gauntlet now covers both better-sqlite3 AND
# node-datachannel with the same three-attempt pattern.

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
