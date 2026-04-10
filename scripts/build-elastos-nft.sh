#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELACITY_WEB_SRC="/Users/mtk/Documents/Cursor/elacity-web-docs"
BUILD_DIR="/tmp/elastos-nft-build"
PATCH_DIR="$PROJECT_ROOT/pc2-node/data/test-apps/elastos-nft-src"
OUTPUT_DIR="$PROJECT_ROOT/pc2-node/data/test-apps/elastos-nft"

echo "=== Elastos NFT Build (develop branch — ESC NFT Marketplace) ==="
echo "Source: $ELACITY_WEB_SRC (branch: develop)"
echo "Build:  $BUILD_DIR"
echo "Output: $OUTPUT_DIR"
echo ""

# 1. Clean and copy source
rm -rf "$BUILD_DIR"
echo "[1/7] Copying source..."
cp -r "$ELACITY_WEB_SRC" "$BUILD_DIR"

# 2. Apply .env.production
echo "[2/7] Applying .env.production..."
cp "$PATCH_DIR/.env.production" "$BUILD_DIR/.env.production"

# 3. Apply Vite build patches (develop branch already has correct provider/network config)
echo "[3/7] Applying Vite build patches..."

# --- Patch: vite.config.js — Add base: './' for relative asset paths in PC2 iframe ---
echo "  - Vite: base = './'"
sed -i '' '/^[[:space:]]*return {/a\
    base: "./",
' "$BUILD_DIR/vite.config.js"

# Remove VitePWA plugin (not needed for PC2)
echo "  - Vite: Remove VitePWA plugin"
sed -i '' "/import.*VitePWA.*from.*vite-plugin-pwa/d" "$BUILD_DIR/vite.config.js"
python3 -c "
import re
with open('$BUILD_DIR/vite.config.js', 'r') as f:
    content = f.read()
content = re.sub(r'VitePWA\(\{[\s\S]*?\}\),?', '', content, count=1)
with open('$BUILD_DIR/vite.config.js', 'w') as f:
    f.write(content)
"

# Patch baseURL() in route.ts to produce relative paths for static assets in PC2 iframe
echo "  - baseURL: relative paths for static assets"
ROUTE_PATCH_FILE=$(mktemp)
cat << ROUTE_PATCH_EOF > "$ROUTE_PATCH_FILE"
import pathlib
route_ts = pathlib.Path("$BUILD_DIR") / "src" / "utils" / "route.ts"
content = route_ts.read_text()
old = "if (path?.startsWith('http')) {\n    return path;\n  }"
new = """if (path?.startsWith('http')) {
    return path;
  }

  if (path && (path.startsWith('/static/') || path.startsWith('/fonts/'))) {
    return '.' + path;
  }"""
content = content.replace(old, new)
route_ts.write_text(content)
ROUTE_PATCH_EOF
python3 "$ROUTE_PATCH_FILE"
rm -f "$ROUTE_PATCH_FILE"

# Strip FayeProvider from provider tree (crashes with relative REACT_APP_BACKEND_URL in iframe)
echo "  - Provider: Strip FayeProvider wrapper"
sed -i '' "/import.*FayeProvider.*from.*src\/lib\/faye/d" "$BUILD_DIR/src/provider/index.tsx"
sed -i '' "s/<FayeProvider>//" "$BUILD_DIR/src/provider/index.tsx"
sed -i '' "s/<\/FayeProvider>//" "$BUILD_DIR/src/provider/index.tsx"

# Remove version-check banner (PC2 build version will never match ela.city server version)
echo "  - App.tsx: Remove server version check"
python3 -c "
import pathlib
app = pathlib.Path('$BUILD_DIR/src/App.tsx')
c = app.read_text()
old = '''    const version = process.env.REACT_APP_VERSION;
    // retrieve latest version tag registered in server side
    fetch(\`\${process.env.REACT_APP_BACKEND_URL}/info/server\`)
      .then((r) => r.json())
      .then(({ status, data }: ApiResponse<ServerInfo>) => {
        if (status === 'success' && version !== data.version) {
          enqueueSnackbar(
            // eslint-disable-next-line max-len
            \`A more recent release is available (\${data.version}). If you keep receiving this message, then please close all tabs navigating on ela.city then re-open a new one to get latest version\`,
            {
              variant: 'warning',
              persist: true,
              action: (key: SnackbarKey) => (
                <>
                  <StackButton size=\"small\" variant=\"text\" onClick={() => closeSnackbar(key)}>
                    Dismiss
                  </StackButton>
                </>
              ),
            }
          );
        }
      })
      .catch((err: Error) => {
        console.log('Unable to fetch version from server', err.message);
      })
      .finally(() => {
        // Log initial performance report
        setTimeout(() => {
          logReport('app-init');
        }, 1000);
      });'''
new = '''    // Log initial performance report (version check removed for PC2)
    setTimeout(() => {
      logReport('app-init');
    }, 1000);'''
c = c.replace(old, new)
app.write_text(c)
"

# Fix hardcoded absolute static/font paths that don't go through baseURL()
echo "  - Fix hardcoded absolute asset paths"
sed -i '' "s|logo: '/static/|logo: './static/|g" "$BUILD_DIR/src/lib/particle-network/contexts/connectkit.tsx"
sed -i '' 's|href="/fonts/|href="./fonts/|g' "$BUILD_DIR/index.html"

# Remove manual chunks that reference packages likely missing or unused in PC2 context
echo "  - Vite: Remove unused manual chunks"
sed -i '' "/'feature-xmtp'/d" "$BUILD_DIR/vite.config.js"
sed -i '' "/'feature-media'/d" "$BUILD_DIR/vite.config.js"
sed -i '' "/'feature-lit'/d" "$BUILD_DIR/vite.config.js"
sed -i '' "/'feature-ffmpeg'/d" "$BUILD_DIR/vite.config.js"

# --- NFT-only UI stripping: remove DRM/Cinema features ---
echo "  - UI: Strip non-NFT features (Channels, Messages, Subscriptions, Create, DRM content types)"

# 1. Directory page: force collections-only (remove toggles, default to collections)
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/components/contract/filter/ContractHorizontalFilter.tsx')
c = f.read_text()
c = c.replace(
    \"\"\"toggleOptions={[
        { value: 'channels', label: 'Channels' },
        { value: 'collections', label: 'Collections' },
        { value: 'royalties', label: 'Revenue' },
      ]}\"\"\",
    ''
)
c = c.replace(\"selectedType = 'channels'\", \"selectedType = 'collections'\")
f.write_text(c)

# Force hook to default to 'collections' instead of 'channels'
h = pathlib.Path('$BUILD_DIR/src/components/contract/hooks/useContractExplorer.ts')
hc = h.read_text()
hc = hc.replace(\"useState<ContractExplorerType>('channels')\", \"useState<ContractExplorerType>('collections')\")
h.write_text(hc)
"

# 2. Header: remove Create button
sed -i '' "s|<CreateButton />||g" "$BUILD_DIR/src/components/mainLayout/DashboardNavbar.tsx"
sed -i '' "/import CreateButton/d" "$BUILD_DIR/src/components/mainLayout/DashboardNavbar.tsx"

# 3. Sidebar: remove Subscriptions, Messages, and CinemaSubscriptions
python3 -c "
import pathlib, re
f = pathlib.Path('$BUILD_DIR/src/contexts/MainLayout/MainNavigation.tsx')
c = f.read_text()

# Remove the Subscriptions menu item (lines with to='/home/subscriptions')
c = re.sub(r'<StyledMenuItem\s+component=\{RouterLink\}\s+to=\"/home/subscriptions\"[\s\S]*?</StyledMenuItem>', '', c, count=1)

# Remove the Messages menu item (lines with to='/home/messages')
c = re.sub(r'<StyledMenuItem\s+component=\{RouterLink\}\s+to=\"/home/messages\"[\s\S]*?</StyledMenuItem>', '', c, count=1)

# Remove the collapsed slide-out panels for Subscriptions and Messages
c = re.sub(r'\{/\* Animated slide-out panel for Subscriptions[\s\S]*?\}\)', '', c, count=1)
c = re.sub(r'\{/\* Animated slide-out panel for Messages[\s\S]*?\}\)', '', c, count=1)

# Remove separators and CinemaSubscriptions section between Messages and Channel Avatars
c = re.sub(r'\{/\* Separator between Messages and Channel Avatars - only in collapsed mode \*/\}[\s\S]*?\)\}', '', c, count=1)
c = re.sub(r'\{/\* Separator between Messages and Channel Avatars - only in expanded mode \*/\}[\s\S]*?\)\}', '', c, count=1)
c = re.sub(r'\{/\* Scrollable Subscriptions Section \*/\}[\s\S]*?</Box>\s*\)\}', '', c, count=1)

# Remove unused imports
c = c.replace(\"import ChatIcon from '@mui/icons-material/Chat';\", '')
c = c.replace(\"import SubscriptionsIcon from '@mui/icons-material/Subscriptions';\", '')
c = c.replace(\"import CinemaSubscriptions from 'src/components/Cinema/Utils/Subscriptions';\", '')

f.write_text(c)
"

# 4. Revenue page: remove Channels and Assets tabs, keep Sales and Offers
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/components/MyContracts/Royalties/EarningsExplorer.tsx')
c = f.read_text()
c = c.replace(
    \"\"\"const EARNINGS_TABS: EarningsTab[] = [
  {
    id: 1,
    label: 'Channels',
    value: 'channels',
    withWithdraw: true,
  },
  {
    id: 2,
    label: 'Assets',
    value: 'assets',
    withWithdraw: true,
  },
  {\"\"\",
    \"\"\"const EARNINGS_TABS: EarningsTab[] = [
  {\"\"\"
)
# Also change the default redirect from 'channels' to 'sales'
f.write_text(c)
"
# Update route default redirect from channels to sales in earnings
sed -i '' "s|element: <Navigate to=\"channels\" replace />|element: <Navigate to=\"sales\" replace />|g" "$BUILD_DIR/src/routes.tsx"

# 5. Library page: remove All, keep only Images; default to card view
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/components/MyContracts/Library/MyVaultHorizontalFilter.tsx')
c = f.read_text()
# Remove All, Audio, and Video — keep only Images
c = c.replace(
    \"\"\"export const VAULT_CATEGORIES = [
  {
    id: 0,
    icon: 'all',
    label: 'All',
    value: 'all',
  },
  {
    id: 1,
    icon: 'images',
    label: 'Images',
    value: 'image',
  },
  {
    id: 2,
    icon: 'audio',
    label: 'Audio',
    value: 'audio',
  },
  {
    id: 3,
    icon: 'video',
    label: 'Video',
    value: 'video',
  },
];\"\"\",
    \"\"\"export const VAULT_CATEGORIES = [
  {
    id: 1,
    icon: 'images',
    label: 'Images',
    value: 'image',
  },
];\"\"\"
)
f.write_text(c)

# Default Library to card view and force 'image' category
e = pathlib.Path('$BUILD_DIR/src/components/MyContracts/Library/MyVaultExplorer.tsx')
ec = e.read_text()
ec = ec.replace(
    \"\"\"const initialFilterValue = {
    searchBy: '',
    layout: isMobile ? 'card' : 'list',
  };\"\"\",
    \"\"\"const initialFilterValue = {
    searchBy: '',
    layout: 'normal',
    categories: ['image'],
  };\"\"\"
)
e.write_text(ec)
"

# 5b. Explore page: remove All/Revenue toggles, remove Audio/Video content types
python3 -c "
import pathlib

# Remove toggleOptions (All/Revenue) from CapsuleHorizontalFilter
f = pathlib.Path('$BUILD_DIR/src/components/Capsule/filter/CapsuleHorizontalFilter.tsx')
c = f.read_text()
c = c.replace(
    \"\"\"toggleOptions={[
        { value: 'all', label: 'All' },
        { value: 'royalties', label: 'Revenue' },
        // { value: 'vip', label: 'VIP' },
      ]}\"\"\",
    ''
)
f.write_text(c)

# Remove Audio/Video from capsuleType constants, keep only Image (no All)
g = pathlib.Path('$BUILD_DIR/src/components/Capsule/filter/constants.ts')
gc = g.read_text()
gc = gc.replace(
    \"\"\"export const capsuleType = [
  { label: 'All', value: 'all', Icon: LanguageIcon },
  { label: 'Image', value: 'image', Icon: PhotoIcon },
  { label: 'Audio', value: 'audio', Icon: HeadphonesIcon },
  { label: 'Video', value: 'video', Icon: SmartDisplayIcon },
];\"\"\",
    \"\"\"export const capsuleType = [
  { label: 'Image', value: 'image', Icon: PhotoIcon },
];\"\"\"
)
f2 = g
f2.write_text(gc)

# Default capsuleType to 'image' in CapsulesSelector
cs = pathlib.Path('$BUILD_DIR/src/components/Capsule/filter/CapsulesSelector.tsx')
csc = cs.read_text()
csc = csc.replace(\"defaultValue: 'all'\", \"defaultValue: 'image'\")
cs.write_text(csc)

# Default capsuleType to 'image' in CapsuleExplorer initialState
ce = pathlib.Path('$BUILD_DIR/src/components/Capsule/CapsuleExplorer.tsx')
cec = ce.read_text()
cec = cec.replace(\"capsuleType: filterValue?.capsuleType || 'all'\", \"capsuleType: filterValue?.capsuleType || 'image'\")
ce.write_text(cec)

# Remove the mobile All/Subscriptions/Revenue toggle from CapsuleSidebarDrawer
h = pathlib.Path('$BUILD_DIR/src/components/Capsule/filter/CapsuleSidebarDrawer.tsx')
hc = h.read_text()
import re
hc = re.sub(r'\{/\* All/VIP Toggle.*?\*/\}\s*\{isMobile && \(\s*<Box>.*?</Box>\s*\)\}', '', hc, flags=re.DOTALL, count=1)
h.write_text(hc)
"

# 5c. Routes: make /explore the default instead of /home; redirect /home to /explore
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/routes.tsx')
c = f.read_text()
# Change root redirect from /home to /explore
c = c.replace(\"element: <Navigate to={baseURL('/home')} replace />\", \"element: <Navigate to={baseURL('/explore')} replace />\", 1)
f.write_text(c)
"

# 5d. Sidebar: remove Home item, redirect /home to /explore
python3 -c "
import pathlib, re
f = pathlib.Path('$BUILD_DIR/src/contexts/MainLayout/MainNavigation.tsx')
c = f.read_text()
# Remove the Home SlideOutMenuItem block
c = re.sub(r'<SlideOutMenuItem>\s*<StyledMenuItem\s+className=\"ntr\"\s+component=\{RouterLink\}\s+to=\"/home\"[\s\S]*?</SlideOutMenuItem>', '', c, count=1)
# Remove the Home slide-out panel
c = re.sub(r'\{/\* Animated slide-out panel for Home[\s\S]*?\}\)', '', c, count=1)
f.write_text(c)
"

# 6. Sidebar configs: remove Cinema from both sidebar configs
CINEMA_PATCH=$(mktemp)
cat << 'CINEMA_PATCH_EOF' > "$CINEMA_PATCH"
import pathlib, re, sys
build_dir = sys.argv[1]
for name in ['mainLayout/SidebarConfig.tsx', 'minimal/SidebarConfig.tsx']:
    f = pathlib.Path(build_dir) / 'src' / 'components' / name
    if f.exists():
        c = f.read_text()
        c = re.sub(r",?\s*\{\s*title:\s*['\"]Cinema['\"][\s\S]*?\},?\s*\n\];", '\n];', c)
        c = c.replace("import SmartDisplayIcon from '@mui/icons-material/SmartDisplay';", '')
        f.write_text(c)
CINEMA_PATCH_EOF
python3 "$CINEMA_PATCH" "$BUILD_DIR"
rm -f "$CINEMA_PATCH"

echo "  Patches applied."

# 4. Install dependencies
echo "[4/7] Installing dependencies..."
cd "$BUILD_DIR"
if [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile 2>/dev/null || yarn install
else
  npm install
fi

# 5. Build (with increased memory for large bundle)
echo "[5/7] Building (this may take a few minutes)..."
export NODE_OPTIONS="--max-old-space-size=8192"
NODE_ENV=production npx vite build 2>&1 | tail -30

# 6. Copy output
echo "[6/7] Copying build output..."
for item in "$OUTPUT_DIR"/*; do
  basename="$(basename "$item")"
  if [ "$basename" != "app.json" ] && [ "$basename" != "NOTICE" ] && [ "$basename" != "logo_128x128.png" ]; then
    rm -rf "$item"
  fi
done
cp -r "$BUILD_DIR/build/"* "$OUTPUT_DIR/"

# 7. Inject PC2 bootstrap script into index.html
echo "[7/7] Injecting PC2 bootstrap script..."
OUTPUT_DIR="$OUTPUT_DIR" python3 << 'PYEOF'
import pathlib, os

output_dir = os.environ["OUTPUT_DIR"]
index = pathlib.Path(output_dir) / "index.html"
html = index.read_text()

inject = r'''<script>
// --- PC2 Bootstrap: auto-login, route rewriting, chain switch ---

// 1. Bypass welcome modal
if(!localStorage.getItem("elacity-welcome-modal-seen")){
  localStorage.setItem("elacity-welcome-modal-seen",JSON.stringify({timestamp:new Date().toISOString(),version:"1.0",completed:true}));
}

// 2. Set wagmi connector storage so ConnectKit reconnectOnMount auto-connects
//    The injected connector (metaMask target) checks for "metaMask.disconnected" — remove it if present.
//    Also set recentConnectorId so wagmi knows which connector to reconnect.
try {
  localStorage.removeItem("wagmi.metaMask.disconnected");
  localStorage.setItem("wagmi.recentConnectorId", '"metaMask"');
} catch(e){}

// 3. Rewrite pathname so React Router (BrowserRouter) can match its routes.
//    Must set <base> first to preserve relative asset resolution (./assets/*, ./fonts/*, etc.)
(function(){
  var p = window.location.pathname;
  var m = p.match(/^\/(installed-apps|apps)\/elastos-nft\/?(.*)$/);
  if(m || p === "/" || p === "") {
    var baseDir = "/" + (m ? m[1] : "installed-apps") + "/elastos-nft/";
    var b = document.createElement("base");
    b.href = baseDir;
    document.head.appendChild(b);
    var sub = m ? m[2].replace(/^index\.html$/, "") : "";
    if(!sub) sub = "explore";
    window.history.replaceState(null, "", "/" + sub + window.location.search + window.location.hash);
  }
})();

// 4. Switch chain to ESC (0x14 = 20) once wallet provider is available
(function(){
  var ESC="0x14";
  function sw(){
    if(window.ethereum && window.ethereum.request){
      window.ethereum.request({method:"eth_chainId"}).then(function(c){
        if(c!==ESC){
          window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:ESC}]}).catch(function(){});
        }
      }).catch(function(){});
    }
  }
  setTimeout(sw,500);
  setTimeout(sw,2000);
  window.addEventListener("message",function h(e){
    if(e.data && e.data.type==="pc2-wallet-init"){
      setTimeout(sw,200);
      window.removeEventListener("message",h);
    }
  });
})();
</script>'''

html = html.replace('<head>', '<head>\n' + inject, 1)
index.write_text(html)
print("  Injected PC2 bootstrap script into index.html")
PYEOF

echo ""
echo "=== Build complete ==="
echo "Output: $OUTPUT_DIR"
echo "Files:"
ls -la "$OUTPUT_DIR/" | head -20
