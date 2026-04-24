#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELACITY_WEB_SRC="/Users/mtk/Documents/Cursor/elacity-web-docs"
BUILD_DIR="/tmp/elastos-nft-build"
PATCH_DIR="$PROJECT_ROOT/pc2-node/data/test-apps/elastos-nft-src"
OUTPUT_DIR="$PROJECT_ROOT/pc2-node/data/test-apps/elastos-nft"

BUILD_START=$(date +%s)
echo "=== Elastos NFT Build (develop branch — ESC NFT Marketplace) ==="
echo "Source: $ELACITY_WEB_SRC (branch: develop)"
echo "Build:  $BUILD_DIR"
echo "Output: $OUTPUT_DIR"
echo ""

step_time() {
  local now=$(date +%s)
  local elapsed=$((now - BUILD_START))
  echo "  ⏱ ${elapsed}s elapsed"
}

# 1. Sync source using rsync (skips node_modules, only copies changed files)
echo "[1/8] Syncing source..."
mkdir -p "$BUILD_DIR"
rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='build' "$ELACITY_WEB_SRC/" "$BUILD_DIR/"

step_time

# 2. Apply .env.production
echo "[2/8] Applying .env.production..."
cp "$PATCH_DIR/.env.production" "$BUILD_DIR/.env.production"

# 3. Apply Vite build patches (develop branch already has correct provider/network config)
echo "[3/8] Applying Vite build patches..."

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

# --- PC2 Auto-Login: Hide "Log In" button, show user as connected immediately ---
echo "  - PC2: Auto-login patches (hide Log In button, use account instead of active)"

# Patch AccountPopover: use account (available from wagmi) instead of active (requires full provider)
sed -i '' 's|{!active ? (|{!account ? (|g' "$BUILD_DIR/src/components/mainLayout/AccountPopover.tsx"

# Patch ParticleNetworkContext: always expose account even without library
# This makes the context spread account/chainId as soon as wagmi provides the address
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/lib/particle-network/contexts/ParticleNetworkContext.tsx')
src = f.read_text()
# Change: active only needs account (not library) for PC2 where wallet is always injected
src = src.replace(
    'const active = React.useMemo(() => !!(account && library), [library, account]);',
    'const active = React.useMemo(() => !!(account), [account]);'
)
f.write_text(src)
print('    ParticleNetworkContext: active = !!account (PC2 wallet always available)')
"

# Also hide the ConnectorSelect \"Log In\" button entirely in PC2 by making it render null
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/lib/particle-network/components/ConnectorSelect.tsx')
src = f.read_text()
# Replace the ConnectorSelect default export to render null in PC2 context
old = '''export default function ConnectorSelect() {
  const theme = useTheme();

  return (
    <ConnectorContext.Consumer>
      {({ promptConnector }) => (
        <Button
          variant=\"contained\"
          onClick={promptConnector}
          sx={{
            bgcolor: theme.palette.mode === 'dark' ? theme.palette.grey[800] : theme.palette.common.white,
            color: theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.common.black,
            borderRadius: Number(theme.shape.borderRadius) * 0.6,
            minWidth: '90px',
            height: '36px',
            boxShadow: 'none',
            '&:hover': {
              bgcolor: theme.palette.mode === 'dark' ? theme.palette.grey[700] : theme.palette.grey[100],
              boxShadow: 'none',
            },
          }}
        >
          Log In
        </Button>
      )}
    </ConnectorContext.Consumer>
  );
}'''
new = '''export default function ConnectorSelect() {
  return null;
}'''
src = src.replace(old, new)
f.write_text(src)
print('    ConnectorSelect: render null (PC2 auto-login, no Log In button)')
"

# Strip profile dropdown: remove Sonic from NetworkSelector, Terms, Affiliate Links, Log Out
python3 -c "
import pathlib, re

# 1. Remove Sonic (chain 146) from NetworkSelector filter list
ns = pathlib.Path('$BUILD_DIR/src/lib/web3/network/NetworkSelector.tsx')
nsc = ns.read_text()
nsc = nsc.replace(\"['20', '21', '421614', '146']\", \"['20', '21']\")
ns.write_text(nsc)
print('    NetworkSelector: removed Sonic (146) from network list')

# 2. Remove Terms & policies, Affiliate Links, Log Out from AccountPopover
ap = pathlib.Path('$BUILD_DIR/src/components/mainLayout/AccountPopover.tsx')
apc = ap.read_text()

# Remove Terms & policies MenuItem (from <MenuItem component=\"a\" href=\"https://docs.ela.city/terms-of-service\" ... to closing </MenuItem>)
apc = re.sub(
    r'<MenuItem\s*\n\s*component=\"a\"\s*\n\s*href=\"https://docs\.ela\.city/terms-of-service\"[\s\S]*?Terms & policies[\s\S]*?</MenuItem>',
    '', apc, count=1
)

# Remove Affiliate Links Box (from <Box sx={{ px: 2.5 ... to closing </Box> that wraps AffiliateDialog)
apc = re.sub(
    r'<Box sx=\{\{\s*\n\s*px: 2\.5,\s*\n\s*py: 1,\s*\n\s*mx: 1,\s*\n\s*borderRadius: 1,\s*\n\s*cursor: .pointer.[\s\S]*?<AffiliateDialog />\s*</Box>',
    '', apc, count=1
)

# Remove Log Out button and its wrapper Box
apc = re.sub(
    r'<Box sx=\{\{ p: 2, pt: 1\.5 \}\}>\s*<Button fullWidth color=\"inherit\" variant=\"outlined\" onClick=\{handleDisconnect\}>\s*Log out\s*</Button>\s*</Box>',
    '', apc, count=1
)

ap.write_text(apc)
print('    AccountPopover: removed Terms, Affiliate Links, Log Out')
"

# --- PC2 Tx Speed: Skip Faye backend sync wait (no FayeProvider in PC2 context) ---
# Without Faye, createTransactionSyncEventCounter's CountWaiter always hits the 30s timeout.
# Patch TxExecutable to skip the countWaiter.wait() call entirely so transactions resolve
# immediately after on-chain confirmation (tx.wait()), then RTK cache invalidation fires.
echo "  - PC2: Patch TxExecutable to skip dead Faye sync wait (instant tx confirmation)"
python3 -c "
import pathlib

tx_file = pathlib.Path('$BUILD_DIR/src/lib/web3/executable/tx.ts')
src = tx_file.read_text()

# Replace the countWaiter.wait() line with an immediate resolution comment
src = src.replace(
    'await this.context.countWaiter?.wait(this.context.txCount);',
    '// PC2: Faye disabled — skip backend sync wait, proceed immediately after on-chain confirmation'
)

tx_file.write_text(src)
print('    TxExecutable: skipped countWaiter.wait() (no Faye in PC2)')
"

# Also patch the UX handler to not create the countWaiter in the first place
# This is in Web3ApplicationContext.tsx where onTransactionAcquired creates the counter
python3 -c "
import pathlib

ctx_file = pathlib.Path('$BUILD_DIR/src/contexts/Web3ApplicationContext.tsx')
src = ctx_file.read_text()

# Replace the onTransactionAcquired handler to skip creating a countWaiter
src = src.replace(
    'ctx.countWaiter = createTransactionSyncEventCounter(tx.hash, ctx.eventTopics);',
    '// PC2: Faye disabled — skip creating sync counter\n          // ctx.countWaiter = createTransactionSyncEventCounter(tx.hash, ctx.eventTopics);'
)

ctx_file.write_text(src)
print('    Web3ApplicationContext: disabled countWaiter creation')
"

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
# Also remove selectedType/onTypeChange props to prevent empty grey toggle container
c = c.replace('selectedType={selectedType}', '')
c = c.replace('onTypeChange={onTypeChange}', '')
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

# 2b. Header: add Back button for in-app navigation (no browser back in PC2 iframe)
echo "  - PC2: Add back button to header (no browser back in iframe)"
python3 -c "
import pathlib

f = pathlib.Path('$BUILD_DIR/src/components/mainLayout/DashboardNavbar.tsx')
src = f.read_text()

# Add ArrowBack import
src = src.replace(
    \"} from '@mui/material';\",
    \"} from '@mui/material';\nimport ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';\"
)

# Add useNavigate/useLocation imports
src = src.replace(
    \"import { useMainLayout } from 'src/layouts';\",
    \"import { useMainLayout } from 'src/layouts';\nimport { useNavigate, useLocation } from 'react-router-dom';\"
)

# Add navigate hook inside DashboardNavbar component
src = src.replace(
    'const { overlaySidebar } = useMainLayout();',
    '''const { overlaySidebar } = useMainLayout();
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== 'default';'''
)

# Place back button inside the BrandLogo Stack, after DesktopMenu
src = src.replace(
    '''<Box sx={{ mx: 1 }}>
        <DesktopMenu />
      </Box>
    </Stack>''',
    '''<Box sx={{ mx: 1 }}>
        <DesktopMenu />
      </Box>
    </Stack>'''
)

# Insert back button right after BrandLogo, inside the left section of the Toolbar
# by wrapping BrandLogo + back button in a flex row
src = src.replace(
    '<BrandLogo />',
    '''<Stack direction=\"row\" alignItems=\"center\">
          <BrandLogo />
          {canGoBack && (
            <IconButton
              size=\"small\"
              onClick={() => navigate(-1)}
              sx={{
                color: 'text.primary',
                opacity: 0.7,
                ml: -0.5,
                '&:hover': { opacity: 1 },
              }}
            >
              <ArrowBackIosNewIcon sx={{ fontSize: 16 }} />
            </IconButton>
          )}
        </Stack>'''
)

## Remove NotificationsPopover from DashboardNavbar (not relevant for NFT marketplace)
src = src.replace('''import NotificationsPopover from './NotificationsPopover';''', '// NotificationsPopover removed for NFT marketplace')
src = src.replace('<NotificationsPopover />', '')

f.write_text(src)
print('    DashboardNavbar: added back button, removed NotificationsPopover')
"

# 2c. Fix Sell button on listed NFT cards: check handler existence, not just action object
echo "  - Fix: Sell button priority checks handler existence for listed items"
python3 -c "
import pathlib

f = pathlib.Path('$BUILD_DIR/src/components/Capsule/CapsuleAdapter.tsx')
src = f.read_text()
src = src.replace(
    '''// Priority: List item > Update sale terms > Sell Access
      const actionToExecute = sellActions.listingPut || sellActions.listingEdit || sellActions.sellAccess;''',
    '''// Priority: prefer action with handler — listed items only have listingEdit handler
      const actionToExecute = (sellActions.listingPut?.handler && sellActions.listingPut) || (sellActions.listingEdit?.handler && sellActions.listingEdit) || (sellActions.sellAccess?.handler && sellActions.sellAccess);'''
)
f.write_text(src)
print('    CapsuleAdapter: fixed sell button handler priority for listed items')
"

# 2d. Revenue sidebar badge: only count offers (not channel/asset royalties from removed features)
echo "  - Fix: Revenue badge only counts active offers (removed channel/asset royalty counts)"
python3 -c "
import pathlib

f = pathlib.Path('$BUILD_DIR/src/contexts/MainLayout/MainNavigation.tsx')
src = f.read_text()

# Remove the channel royalties query
src = src.replace(
    '''const { data: channelsRoyaltiesData } = useFetchMyRoyaltyItemsQuery(
    {
      address: account || '',
      category: 'channels',
      filters: { limit: 100, offset: 0 },
    },
    { skip: !account }
  );''',
    ''
)

# Remove the asset royalties query
src = src.replace(
    '''const { data: assetsRoyaltiesData } = useFetchMyRoyaltyItemsQuery(
    {
      address: account || '',
      category: 'assets',
      filters: { limit: 100, offset: 0 },
    },
    { skip: !account }
  );''',
    ''
)

# Replace the earningsNotificationCount calculation to only count offers
src = src.replace(
    '''const earningsNotificationCount = React.useMemo(() => {
    let totalCount = 0;

    // Channels with claimable rewards
    if (channelsRoyaltiesData?.data) {
      const claimableChannels = channelsRoyaltiesData.data.filter((item) => item.__typename === 'RoyaltyChannel' && item.unclaimedRewards > 0);
      totalCount += claimableChannels.length;
    }

    // Assets with claimable rewards
    if (assetsRoyaltiesData?.data) {
      const claimableAssets = assetsRoyaltiesData.data.filter((item) => item.__typename === 'RoyaltyAsset' && item.unclaimedRewards > 0);
      totalCount += claimableAssets.length;
    }

    // Note: Sales notifications excluded from sidebar badge as requested

    // Offers made (active offers)
    if (offersMadeData?.data?.length) {
      totalCount += offersMadeData.data.length;
    }

    // Offers received (active incoming offers)
    if (offersReceivedData?.data?.length) {
      totalCount += offersReceivedData.data.length;
    }

    return totalCount > 99 ? 99 : totalCount;
  }, [channelsRoyaltiesData, assetsRoyaltiesData, offersMadeData, offersReceivedData]);''',
    '''const earningsNotificationCount = React.useMemo(() => {
    let totalCount = 0;
    const now = Date.now();
    if (offersMadeData?.data?.length) {
      totalCount += offersMadeData.data.filter((o: any) => {
        const d = typeof o.deadline === 'number' ? o.deadline : new Date(o.deadline).getTime();
        return d > now;
      }).length;
    }
    if (offersReceivedData?.data?.length) {
      totalCount += offersReceivedData.data.filter((o: any) => {
        const d = typeof o.deadline === 'number' ? o.deadline : new Date(o.deadline).getTime();
        return d > now;
      }).length;
    }
    return totalCount > 99 ? 99 : totalCount;
  }, [offersMadeData, offersReceivedData]);'''
)

f.write_text(src)
print('    MainNavigation: Revenue badge now only counts active offers')
"

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
    layout: 'card',
    categories: ['image'],
  };\"\"\"
)
e.write_text(ec)
"

# 5b. Explore page: remove All/Revenue toggles, remove Audio/Video content types
python3 -c "
import pathlib

# Remove toggleOptions AND selectedType/onTypeChange from CapsuleHorizontalFilter
# (removing toggleOptions alone leaves an empty grey ToggleButtonGroup container)
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
c = c.replace('selectedType={selectedFilter}', '')
c = c.replace('onTypeChange={onFilterChange}', '')
f.write_text(c)

# Replace DRM categories with NFT collection categories in CapsuleHorizontalFilter
# Import CATEGORIES from collection constants and use them instead of horizontalOptionFilters
chf = pathlib.Path('$BUILD_DIR/src/components/Capsule/filter/CapsuleHorizontalFilter.tsx')
chfc = chf.read_text()
chfc = chfc.replace(
    \"import { horizontalOptionFilters } from './constants';\",
    \"import { CATEGORIES } from 'src/constants/collection';\"
)
chfc = chfc.replace(
    \"\"\"options={[
        ...horizontalOptionFilters
          .map((item) => (
            {
              option: item,
              value: item,
            }
          ) as horizontalFilter)]}\"\"\",
    \"\"\"options={[...CATEGORIES.map((c) => (
            {
              option: c.label,
              value: c.label,
            }) as horizontalFilter)]}\"\"\"
)
chf.write_text(chfc)
print('    CapsuleHorizontalFilter: replaced DRM categories with NFT collection categories')

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

# Hide CapsulesSelector from sidebar (only one option 'image')
sd = pathlib.Path('$BUILD_DIR/src/components/Capsule/filter/CapsuleSidebarDrawer.tsx')
sdc = sd.read_text()
sdc = sdc.replace(
    \"\"\"<SidebarSection>
          <CapsulesSelector
            filterProps={filterProps}
          />
        </SidebarSection>\"\"\",
    ''
)
sd.write_text(sdc)

# Hardcode CapsuleExplorer to always use 'image' content type (NFT images only, no DRM)
ce = pathlib.Path('$BUILD_DIR/src/components/Capsule/CapsuleExplorer.tsx')
cec = ce.read_text()
# Force capsuleType to 'image' in initialState so explore always shows NFT images
cec = cec.replace(\"capsuleType: filterValue?.capsuleType || 'all'\", \"capsuleType: 'image'\")
# Hardcode contentType to always be ['image'] regardless of capsuleType value
cec = cec.replace(
    \"\"\"...(capsuleType && {
          contentType: [capsuleType],
        }),\"\"\",
    \"contentType: ['image'],\"
)
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
# Rename 'Directory' to 'Collections' in sidebar
c = c.replace('Directory', 'Collections')
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

# 7. Home page: strip DRM content, make NFT-only
echo "  - Home page: NFT-only sections (remove channels, audio, video, subscriptions)"
HOME_PATCH=$(mktemp)
cat << 'HOME_PATCH_EOF' > "$HOME_PATCH"
import pathlib, re, sys
build_dir = sys.argv[1]

# --- Rewrite HomeExplorer to NFT-only sections ---
he = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'Main' / 'HomeExplorer.tsx'
hec = he.read_text()

# Remove imports for DRM sections
hec = hec.replace("import LatestAudioContent from '../sections/LatestAudioContent';", '')
hec = hec.replace("import SubscribedChannelsContent from '../sections/SubscribedChannelsContent';", '')
hec = hec.replace("import NewChannelsSection from '../shared/NewChannelsSection';", '')
hec = hec.replace("import HomeCarousel from '../shared/HomeCarousel';", '')

# Remove the Hero/Carousel section
hec = re.sub(
    r'      \{/\* Hero Section Revolution.*?\*/\}\s*<section aria-label="Hero Section">\s*<HomeCarousel />\s*</section>',
    '', hec, flags=re.DOTALL
)

# Remove New Channels section
hec = re.sub(
    r'      \{/\* Priority 1: New Channels.*?\*/\}\s*<section aria-label="New Channels">\s*<NewChannelsSection />\s*</section>',
    '', hec, flags=re.DOTALL
)

# Remove Subscribed Channels section
hec = re.sub(
    r'      \{/\* Priority 2: My Subscribed Content.*?\*/\}\s*<section aria-label="Latest Subscriptions">[\s\S]*?</section>',
    '', hec, count=1
)

# Remove Latest Audio section
hec = re.sub(
    r'      \{/\* Priority 5: Secondary Content \*/\}\s*<section aria-label="Latest Audio">[\s\S]*?</section>',
    '', hec, count=1
)

he.write_text(hec)

# --- LatestMediaContent: rename, remove CreateMediaPlaceholder, add API-level image filter ---
lm = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'sections' / 'LatestMediaContent.tsx'
lmc = lm.read_text()
lmc = lmc.replace("title=\"Latest Buy Now Media\"", "title=\"Latest NFTs\"")
lmc = lmc.replace("viewAllUrl=\"/explore?filterBy=permanentOwnership\"", "viewAllUrl=\"/explore\"")
lmc = lmc.replace("import CreateMediaPlaceholder from 'src/components/profile/CreateMediaPlaceholder';", '')
lmc = re.sub(
    r'\s*\{/\* Create Media placeholder.*?\*/\}\s*\{showPlaceholder && \([\s\S]*?\)\}',
    '', lmc, count=1
)
# Add contentType: ['image'] to API query to only fetch NFT images (not DRM video/audio)
lmc = lmc.replace(
    """      type: 'single',
      from: 0,
      count: 6, // Fetch 6 items for horizontal scrolling
      filterby: [],""",
    """      type: 'single',
      from: 0,
      count: 6,
      filterby: [],
      contentType: ['image'],"""
)
lm.write_text(lmc)

# --- Remove Most Viewed section entirely from HomeExplorer ---
hec = he.read_text()
hec = hec.replace("import MostViewedContent from '../sections/MostViewedContent';", '')
hec = re.sub(
    r'\s*<section aria-label="Most Viewed">[\s\S]*?</section>',
    '', hec, count=1
)
he.write_text(hec)

# --- Remove Learning Hub / FeaturedEducationContent section from HomeExplorer ---
hec = he.read_text()
hec = hec.replace("import FeaturedEducationContent from '../sections/FeaturedEducationContent';", '')
hec = re.sub(
    r'\s*\{/\* Priority 6: Educational Content \*/\}\s*<section aria-label="Learning Hub">[\s\S]*?</section>',
    '', hec, count=1
)
he.write_text(hec)

# --- RecentlySoldContent: rename, add API-level image filter ---
rs = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'sections' / 'RecentlySoldContent.tsx'
rsc = rs.read_text()
rsc = rsc.replace("title=\"Recently Sold\"", "title=\"Recently Sold NFTs\"")
# Add contentType: ['image'] to API query
rsc = rsc.replace(
    """      type: 'single',
      from: 0,
      count: 6,
      filterby: [],""",
    """      type: 'single',
      from: 0,
      count: 6,
      filterby: [],
      contentType: ['image'],"""
)
rs.write_text(rsc)

# --- Rewrite NewChannelsSection to show Collections using the same CollectionLayoutCard as the Collections page ---
nc = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'shared' / 'NewChannelsSection.tsx'
nc.write_text('''/* eslint-disable no-underscore-dangle */
/* eslint-disable react/no-array-index-key */
import React from 'react';
import { useFetchContractsQuery } from 'src/state/api';
import CollectionLayoutCard from 'src/components/marketplace/collection/CollectionLayoutCard';
import BaseContentSection from './BaseContentSection';
import ContentItem from './ContentItem';

const NewChannelsSection: React.FC = React.memo(() => {
  const { data: contractsData, isLoading } = useFetchContractsQuery({
    filters: {
      offset: 0,
      limit: 8,
      sortBy: 'createdAt$desc',
    },
    query: {
      categories: [],
      contractType: 'Collection',
    },
  });

  const collections = React.useMemo(() => {
    if (!contractsData?.items) return [];
    return contractsData.items
      .filter((item: { __typename?: string }) => item.__typename === 'Collection')
      .slice(0, 8);
  }, [contractsData]);

  return (
    <BaseContentSection
      title="New Collections"
      viewAllUrl="/directory"
      loading={isLoading}
      emptyMessage="No collections found"
      skeletonCount={8}
      skeletonHeight={320}
    >
      {collections.map((item: any, i: number) => (
        <ContentItem
          key={item.erc721Address || item.address || i}
          index={i}
          animationName="fadeIn"
          customWidth={{
            xs: 'calc(85vw - 32px)',
            sm: 'calc(42vw - 24px)',
            md: 'calc(25vw - 24px)',
            lg: 'calc(25vw - 24px)',
          }}
        >
          <CollectionLayoutCard data={item} />
        </ContentItem>
      ))}
    </BaseContentSection>
  );
});

export default NewChannelsSection;
''')

# --- Revenue page: fully remove Subscriptions from activity filters and chart ---

# Remove "Subscriptions" from activity filter options (the toggle buttons below chart)
af_const = pathlib.Path(build_dir) / 'src' / 'components' / 'profile' / 'filter' / 'constants.ts'
afc = af_const.read_text()
afc = afc.replace(
    "{ option: 'Subscriptions', value: 'Subscription', for: ['account', 'channel', 'sale'] },\n",
    ""
)
af_const.write_text(afc)

# Remove subscriptions from ActivityLineChart entirely
ac = pathlib.Path(build_dir) / 'src' / 'components' / 'Chart' / 'ActivityLineChart.tsx'
acc = ac.read_text()
import re
# Zero out subscription data processing
acc = acc.replace("entry.subscriptions += 1;", "")
acc = acc.replace("entry.subscriptionAmount += totalAmountUSD;\n", "")
# Remove the subscription stats column
acc = acc.replace(
    """          <Box sx={{ textAlign: 'left' }}>
            <Typography
              variant={containerWidth < 600 ? 'subtitle1' : 'h6'}
              color={subscriptionColor}
              fontWeight={600}
              sx={{ lineHeight: 1.2 }}
            >
              {processedData.reduce((sum, d) => sum + d.subscriptions, 0)}
            </Typography>
            <Typography
              variant={containerWidth < 600 ? 'caption' : 'body2'}
              color="text.secondary"
              sx={{ lineHeight: 1.2 }}
            >
              Subscriptions
            </Typography>
          </Box>""",
    ""
)
# Remove subscriptions from total activity sum (show only asset sales)
acc = acc.replace(
    "processedData.reduce((sum, d) => sum + d.subscriptions + d.assetSales, 0)",
    "processedData.reduce((sum, d) => sum + d.assetSales, 0)"
)
acc = acc.replace(
    "processedData.reduce((sum, d) => sum + d.subscriptionAmount + d.assetSalesAmount, 0)",
    "processedData.reduce((sum, d) => sum + d.assetSalesAmount, 0)"
)
# Remove subscription tooltip section
acc = re.sub(
    r'<Box sx=\{\{ display: .flex., alignItems: .center., gap: 1 \}\}>\s*<LegendDot color=\{subscriptionColor\} />\s*<Box sx=\{\{ flex: 1 \}\}>\s*<Typography variant="body2">\s*Subscriptions:.*?</Box>\s*</Box>',
    '',
    acc,
    count=1,
    flags=re.DOTALL
)
# Remove subscription from total in tooltip
acc = acc.replace(
    "tooltip.data.subscriptions + tooltip.data.assetSales",
    "tooltip.data.assetSales"
)
acc = acc.replace(
    "tooltip.data.subscriptionAmount + tooltip.data.assetSalesAmount",
    "tooltip.data.assetSalesAmount"
)
# Remove subscription SVG line and data points entirely
acc = re.sub(
    r'\{/\* Subscription line \*/\}\s*<path\s+d=\{subscriptionPath\}.*?/>',
    '',
    acc,
    count=1,
    flags=re.DOTALL
)
acc = re.sub(
    r'\{/\* Data points for subscription line \*/\}\s*\{processedData\.map\(\(point, index\) => \{.*?const x = padding.*?const y = padding \+ chartHeight - \(\(point\.subscriptions.*?\}\)\}',
    '',
    acc,
    count=1,
    flags=re.DOTALL
)
ac.write_text(acc)

# --- FeaturedEducationContent removed (Learning Hub section stripped entirely) ---

# --- Re-add NewChannelsSection import to HomeExplorer (we removed it, now re-add) ---
he2 = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'Main' / 'HomeExplorer.tsx'
hec2 = he2.read_text()
# Add import back
hec2 = hec2.replace(
    "import DelayedComponent from '../../common/DelayedComponent';",
    "import DelayedComponent from '../../common/DelayedComponent';\nimport NewChannelsSection from '../shared/NewChannelsSection';"
)
# Add collections section at the top of main
hec2 = hec2.replace(
    "<main role=\"main\">",
    """<main role="main">
      {/* New Collections */}
      <section aria-label="New Collections">
        <NewChannelsSection />
      </section>"""
)
he2.write_text(hec2)
HOME_PATCH_EOF
python3 "$HOME_PATCH" "$BUILD_DIR"
rm -f "$HOME_PATCH"

echo "  Patches applied."

# --- Fix broken profile/banner images ---

# Switch IPFS gateway to ipfs.io (cloudflare-ipfs.com and ipfs.ela.city are both dead)
echo "  - IPFS: Switching gateway to ipfs.io"
sed -i '' "s|https://ipfs.ela.city|https://ipfs.io|g" "$BUILD_DIR/node_modules/@elacity-js/lib/src/utils/url.sanitize.ts"
sed -i '' "s|https://cloudflare-ipfs.com|https://ipfs.io|g" "$BUILD_DIR/node_modules/@elacity-js/lib/src/utils/url.sanitize.ts"
sed -i '' "s|http://cloudflare-ipfs.com|https://ipfs.io|g" "$BUILD_DIR/node_modules/@elacity-js/lib/src/utils/url.sanitize.ts"
sed -i '' "s|https://ipfs.ela.city|https://ipfs.io|g" "$BUILD_DIR/.env"
sed -i '' "s|https://cloudflare-ipfs.com|https://ipfs.io|g" "$BUILD_DIR/.env"
sed -i '' "s|http://cloudflare-ipfs.com|https://ipfs.io|g" "$BUILD_DIR/.env"

# Add onerror handler to CoverPhoto to gracefully hide broken banner images
echo "  - CoverPhoto: Adding onerror handler for broken images"
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/components/profile/CoverPhoto.tsx')
c = f.read_text()
# Add state for image error
c = c.replace(
    'const [backgroundImage, setImage] = React.useState<string | null>(src || null);',
    'const [backgroundImage, setImage] = React.useState<string | null>(src || null);\n  const [imageError, setImageError] = React.useState(false);'
)
# Hide img on error: change the conditional from backgroundImage to also check imageError
c = c.replace(
    '{backgroundImage && (',
    '{backgroundImage && !imageError && ('
)
# Add onError handler to img tag
c = c.replace(
    \"alt=\\\"Profile cover\\\"\",
    'alt=\"Profile cover\" onError={() => setImageError(true)}'
)
# Reset error state when src changes
c = c.replace(
    'React.useEffect(() => {\n    setImage(src || null);\n  }, [src]);',
    'React.useEffect(() => {\n    setImage(src || null);\n    setImageError(false);\n  }, [src]);'
)
f.write_text(c)
print('    CoverPhoto patched')
"

# Add onerror fallback for profile avatars (MUI Avatar handles this natively with fallback)
# But let's also patch the Image component used for NFT cards to handle IPFS failures
echo "  - Image: Replacing ipfs.ela.city and cloudflare-ipfs.com everywhere in source"
python3 -c "
import pathlib, os
# Replace in all .ts/.tsx source files
count = 0
for root, dirs, files in os.walk('$BUILD_DIR/src'):
    for fname in files:
        if fname.endswith(('.ts', '.tsx')):
            fp = pathlib.Path(root) / fname
            c = fp.read_text()
            changed = False
            if 'ipfs.ela.city' in c:
                c = c.replace('https://ipfs.ela.city', 'https://ipfs.io')
                c = c.replace('http://ipfs.ela.city', 'https://ipfs.io')
                changed = True
            if 'cloudflare-ipfs.com' in c:
                c = c.replace('https://cloudflare-ipfs.com', 'https://ipfs.io')
                c = c.replace('http://cloudflare-ipfs.com', 'https://ipfs.io')
                changed = True
            if changed:
                fp.write_text(c)
                count += 1
print(f'    Updated {count} source files with new IPFS gateway')
"

# Switch ESC RPC to use Contabo archive node via local proxy
echo "  - RPC: Switching ESC RPC to Contabo node (via /api/esc-rpc proxy)"
python3 -c "
import pathlib
f = pathlib.Path('$BUILD_DIR/src/lib/web3/network/rpcs.ts')
c = f.read_text()
c = c.replace(
    \"'https://api.ela.city/esc',\",
    \"'/api/esc-rpc',\n      'https://api.ela.city/esc',\"
)
f.write_text(c)
print('    rpcs.ts updated with Contabo RPC proxy')
"

# Fix profile/banner image URL resolution - relative URLs (/api/...) were being 
# treated as IPFS hashes and wrapped in ipfsLink(), producing broken URLs
echo "  - account.ts: Fixing image URL resolution for relative paths"
ACCT_PATCH=$(mktemp)
cat > "$ACCT_PATCH" << 'ACCT_PATCH_EOF'
import pathlib, sys
build_dir = sys.argv[1]
f = pathlib.Path(build_dir) / 'src' / 'state' / 'api' / 'account.ts'
c = f.read_text()
# Fix: imageHash that's a relative URL (starts with /) should be used as-is, not wrapped in ipfsLink
old = """...(imageHash &&
              imageHash.match(/^https?/) && {
              image: imageHash,
            }),
            ...(imageHash &&
              !imageHash.match(/^https?/) && {
              image: ipfsLink(`/ipfs/${imageHash}`),
            }),
            ...(bannerHash &&
              bannerHash.match(/^https?/) && {
              banner: bannerHash,
            }),
            ...(bannerHash &&
              !bannerHash.match(/^https?/) && {
              banner: ipfsLink(`/ipfs/${bannerHash}`),
            })"""
new = """...(imageHash &&
              (imageHash.match(/^https?/) || imageHash.startsWith('/')) && {
              image: imageHash,
            }),
            ...(imageHash &&
              !imageHash.match(/^https?/) && !imageHash.startsWith('/') && {
              image: ipfsLink(`/ipfs/${imageHash}`),
            }),
            ...(bannerHash &&
              (bannerHash.match(/^https?/) || bannerHash.startsWith('/')) && {
              banner: bannerHash,
            }),
            ...(bannerHash &&
              !bannerHash.match(/^https?/) && !bannerHash.startsWith('/') && {
              banner: ipfsLink(`/ipfs/${bannerHash}`),
            })"""
if old in c:
    c = c.replace(old, new)
    f.write_text(c)
    print('    account.ts URL resolution patched')
else:
    print('    WARNING: account.ts patch pattern not found')
ACCT_PATCH_EOF
python3 "$ACCT_PATCH" "$BUILD_DIR"
rm -f "$ACCT_PATCH"

# Fix ArtAssetCard: remove linkTarget="_blank" to keep navigation inside PC2 iframe
echo "  - ArtAssetCard: Remove _blank target (navigate within app, not new window)"
sed -i '' "s/linkTarget=\"_blank\"//" "$BUILD_DIR/src/components/marketplace/museum/ArtAssetCard.tsx"

echo "  Image + RPC fixes applied."

# --- NFT IPFS Pinning: Add "Pin to Node" + "Download" buttons on ArtAssetView ---
echo "  - NFT Pin: Adding Pin + Download buttons to ArtAssetView"
NFT_PIN_PATCH=$(mktemp)
cat > "$NFT_PIN_PATCH" << 'NFT_PIN_PATCH_EOF'
import pathlib, sys
build_dir = sys.argv[1]

f = pathlib.Path(build_dir) / 'src' / 'components' / 'marketplace' / 'ArtAssetView.tsx'
c = f.read_text()

# Add PushPin + CircularProgress + Download imports
c = c.replace(
    "import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';",
    "import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';\nimport PushPinIcon from '@mui/icons-material/PushPin';\nimport FileDownloadIcon from '@mui/icons-material/FileDownload';\nimport CircularProgress from '@mui/material/CircularProgress';"
)

# Add pin state hooks BEFORE the early returns (isFetching / isError checks).
old_fetching_check = """  if (isFetching || !mounted.current) {
    return <Loader />;
  }"""

pin_hooks_and_fetching = '''  var [pinStatus, setPinStatus] = React.useState('idle');

  var getPC2Token = function() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get('puter.auth.token') || '';
    } catch(e) { return ''; }
  };

  var pc2AuthHeaders = function(extra) {
    var h = {};
    var tk = getPC2Token();
    if (tk) h['Authorization'] = 'Bearer ' + tk;
    if (extra) { for (var k in extra) h[k] = extra[k]; }
    return h;
  };

  var extractCidFromUrl = function(url) {
    if (!url) return null;
    var m = url.match(/(?:ipfs:\\/\\/|\\/ipfs\\/|^)(Qm[a-zA-Z0-9]{44}|baf[a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  };

  var nftIpfsCid = React.useMemo(
    function() {
      return extractCidFromUrl(result?.data?.metadata?.image)
        || extractCidFromUrl(result?.data?.imageURL)
        || extractCidFromUrl(result?.data?.tokenURI);
    },
    [result?.data?.metadata?.image, result?.data?.imageURL, result?.data?.tokenURI]
  );

  React.useEffect(function() {
    if (!nftIpfsCid || !isOwned) return;
    fetch('/api/nft/pin/' + nftIpfsCid, { headers: pc2AuthHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.pinned) {
          setPinStatus(data.pin_status === 'complete' ? 'pinned' : 'pinning');
        }
      })
      .catch(function() {});
  }, [nftIpfsCid, isOwned]);

  var handlePinToNode = React.useCallback(function() {
    if (!nftIpfsCid || pinStatus === 'pinned' || pinStatus === 'pinning') return;
    setPinStatus('pinning');
    fetch('/api/nft/pin', {
      method: 'POST',
      headers: pc2AuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        cid: nftIpfsCid,
        name: result?.data?.name || 'Untitled',
        collection: result?.data?.collection?.name || address || 'Unknown',
        contractAddress: address || '',
        tokenId: String(id || ''),
        mimeType: result?.data?.metadata?.mimeType || 'image/png',
      }),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) { setPinStatus('pinned'); } else { setPinStatus('error'); }
      })
      .catch(function() { setPinStatus('error'); });
  }, [nftIpfsCid, pinStatus, result?.data, address, id]);

  var handleDownloadNft = React.useCallback(function() {
    var imgUrl = result?.data?.metadata?.image || result?.data?.imageURL;
    if (!imgUrl) return;
    var a = document.createElement('a');
    a.href = imgUrl;
    a.target = '_blank';
    a.download = (result?.data?.name || 'nft') + '.' + (result?.data?.metadata?.mimeType || 'image/png').split('/').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [result?.data]);

  if (isFetching || !mounted.current) {
    return <Loader />;
  }'''

c = c.replace(old_fetching_check, pin_hooks_and_fetching)

# Add prominent Pin + Download buttons BELOW the image box (after </Box> that wraps the image)
# We target the closing of the image container and add buttons after it
old_image_close = """            </Box>
            <Box sx={{ display: { xs: 'block', sm: 'none' }, my: 4 }}>
              <ArtAssetHeader"""

new_image_close = """            </Box>
            {isOwned && (
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, mb: 1 }}>
                {nftIpfsCid && (
                  <Button
                    variant={pinStatus === 'pinned' ? 'contained' : 'outlined'}
                    size="small"
                    startIcon={pinStatus === 'pinning' ? <CircularProgress size={16} /> : <PushPinIcon />}
                    onClick={handlePinToNode}
                    disabled={pinStatus === 'pinned' || pinStatus === 'pinning'}
                    sx={{
                      flex: 1,
                      textTransform: 'none',
                      borderColor: pinStatus === 'pinned' ? '#4caf50' : undefined,
                      color: pinStatus === 'pinned' ? '#fff' : undefined,
                      backgroundColor: pinStatus === 'pinned' ? '#4caf50' : undefined,
                      '&:hover': { backgroundColor: pinStatus === 'pinned' ? '#388e3c' : undefined },
                    }}
                  >
                    {pinStatus === 'pinned' ? 'Pinned to Node' : pinStatus === 'pinning' ? 'Pinning...' : 'Pin to My Node'}
                  </Button>
                )}
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<FileDownloadIcon />}
                  onClick={handleDownloadNft}
                  sx={{ flex: 1, textTransform: 'none' }}
                >
                  Download
                </Button>
              </Stack>
            )}
            <Box sx={{ display: { xs: 'block', sm: 'none' }, my: 4 }}>
              <ArtAssetHeader"""

c = c.replace(old_image_close, new_image_close)

f.write_text(c)
print('    ArtAssetView.tsx patched with Pin + Download buttons')
NFT_PIN_PATCH_EOF
python3 "$NFT_PIN_PATCH" "$BUILD_DIR"
rm -f "$NFT_PIN_PATCH"

echo "  NFT Pin + Download buttons patched."

# --- NFT IPFS Pinning: Add pin indicator on Library cards ---
echo "  - NFT Pin: Adding pin indicator to Library cards"
LIB_PIN_PATCH=$(mktemp)
cat > "$LIB_PIN_PATCH" << 'LIB_PIN_PATCH_EOF'
import pathlib, sys
build_dir = sys.argv[1]

f = pathlib.Path(build_dir) / 'src' / 'components' / 'MyContracts' / 'Library' / 'MyVaultExplorer.tsx'
c = f.read_text()

# Add PushPin icon and state imports
c = c.replace(
    "import CapsuleAdapter from 'src/components/Capsule/CapsuleAdapter';",
    "import CapsuleAdapter from 'src/components/Capsule/CapsuleAdapter';\nimport PushPinIcon from '@mui/icons-material/PushPin';\nimport Tooltip from '@mui/material/Tooltip';"
)

# Add a context provider for pinned CIDs at the top of the MyVaultExplorer component
# We'll add a custom hook that fetches pinned CIDs once
old_card_render = '''const MyVaultCardRender: React.FC<MyVaultCardRenderProps> = ({
  item,
}) => (
  <CapsuleAdapter
    item={item as CapsuleItem}
    listingIcon={FolderCopyIcon}
  />
);'''

new_card_render = '''const PinnedCidsContext = React.createContext<Set<string>>(new Set());

const getPC2AuthToken = (): string => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('puter.auth.token') || '';
  } catch(e) { return ''; }
};

const usePinnedCids = () => {
  const [cids, setCids] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const tk = getPC2AuthToken();
    const headers: Record<string, string> = {};
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
    fetch('/api/nft/pins', { headers })
      .then(r => r.json())
      .then(data => {
        if (data.pins) {
          setCids(new Set(data.pins.map((p: any) => p.cid)));
        }
      })
      .catch(() => {});
  }, []);
  return cids;
};

const extractCid = (url: string | undefined): string | null => {
  if (!url) return null;
  const match = url.match(/(?:ipfs:\\/\\/|\\/ipfs\\/|^)(Qm[a-zA-Z0-9]{44}|baf[a-zA-Z0-9]+)/);
  return match ? match[1] : null;
};

const MyVaultCardRender: React.FC<MyVaultCardRenderProps> = ({
  item,
}) => {
  const pinnedCids = React.useContext(PinnedCidsContext);
  const capsule = item as CapsuleItem;
  const cid = extractCid(capsule.imageURL) || extractCid(capsule.tokenURI);
  const isPinned = cid ? pinnedCids.has(cid) : false;

  return (
    <Box sx={{ position: 'relative' }}>
      <CapsuleAdapter
        item={capsule}
        listingIcon={FolderCopyIcon}
      />
      {isPinned && (
        <Tooltip title="Pinned to your node">
          <Box sx={{
            position: 'absolute', top: 8, right: 8, zIndex: 2,
            bgcolor: 'rgba(0,0,0,0.6)', borderRadius: '50%',
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <PushPinIcon sx={{ fontSize: 16, color: '#4caf50' }} />
          </Box>
        </Tooltip>
      )}
    </Box>
  );
};'''

c = c.replace(old_card_render, new_card_render)

# Wrap the LazyLoadProvider with PinnedCidsContext.Provider
c = c.replace(
    "return (\n    <LazyLoadProvider",
    "const pinnedCids = usePinnedCids();\n\n  return (\n    <PinnedCidsContext.Provider value={pinnedCids}>\n    <LazyLoadProvider"
)

c = c.replace(
    "    </LazyLoadProvider>\n  );\n};",
    "    </LazyLoadProvider>\n    </PinnedCidsContext.Provider>\n  );\n};"
)

f.write_text(c)
print('    MyVaultExplorer.tsx patched with pin indicators')
LIB_PIN_PATCH_EOF
python3 "$LIB_PIN_PATCH" "$BUILD_DIR"
rm -f "$LIB_PIN_PATCH"

echo "  Library pin indicators patched."
step_time

# 4. Install dependencies
cd "$BUILD_DIR"
if [ -d "node_modules/.cache" ] && [ -f "node_modules/.yarn-integrity" ]; then
  echo "[4/8] Dependencies cached — skipping install"
else
  echo "[4/8] Installing dependencies..."
  if [ -f "yarn.lock" ]; then
    yarn install --frozen-lockfile 2>/dev/null || yarn install
  else
    npm install
  fi
fi

step_time

# 5. Build (with increased memory for large bundle)
echo "[5/8] Building..."
export NODE_OPTIONS="--max-old-space-size=8192"
NODE_ENV=production npx vite build 2>&1 | tail -30

step_time

# 6. Copy output
echo "[6/8] Copying build output..."
for item in "$OUTPUT_DIR"/*; do
  basename="$(basename "$item")"
  if [ "$basename" != "app.json" ] && [ "$basename" != "NOTICE" ] && [ "$basename" != "logo_128x128.png" ]; then
    rm -rf "$item"
  fi
done
cp -r "$BUILD_DIR/build/"* "$OUTPUT_DIR/"

# 6b. Post-build: fix any remaining dead IPFS gateways in compiled JS
echo "  - Post-build: Replacing dead IPFS gateways in compiled JS..."
find "$OUTPUT_DIR/assets" -name '*.js' -exec sed -i '' \
  -e 's|https://cloudflare-ipfs\.com|https://ipfs.io|g' \
  -e 's|http://cloudflare-ipfs\.com|https://ipfs.io|g' \
  -e 's|https://ipfs\.ela\.city|https://ipfs.io|g' \
  {} +
echo "    Done replacing dead gateways in built JS"

# 7. Post-build cleanup: remove dead weight from unused features
echo "[7/8] Post-build cleanup (removing unused features)..."
SIZE_BEFORE=$(du -sm "$OUTPUT_DIR" | awk '{print $1}')

# 7a. XMTP WASM binary (8.0MB) - messaging feature removed
echo "  - Removing XMTP WASM binary..."
rm -f "$OUTPUT_DIR"/assets/bindings_wasm_bg-*.wasm

# 7b. wasm_exec.js (Go WASM runtime, unused)
echo "  - Removing wasm_exec.js..."
rm -f "$OUTPUT_DIR/wasm_exec.js"
# Also remove its script tag from index.html if present
sed -i '' '/<script src=".*wasm_exec.js"><\/script>/d' "$OUTPUT_DIR/index.html" 2>/dev/null

# 7c. JS chunk cleanup DISABLED
# Vite's __vitePreload lists shared dependencies across routes. Deleting ANY chunk
# that appears as a preload dependency (even for unused routes) causes dynamic imports
# to fail for ALL routes that share those dependencies. The ~2MB savings is not worth
# the breakage. Only WASM and image cleanup is safe.
echo "  - Skipping JS chunk cleanup (Vite preload dependencies are shared)"

# 7d. Static mascot/marketing images (features removed from UI)
# Keep essential "bella and flint" images used by active pages (empty states)
echo "  - Removing unused static images (keeping active empty-state images)..."
# Selectively remove unused bella and flint images instead of entire directory
# Keep: No Assets Flint Bella.png (Library), Jumping.png (Explore), No activity .png (Revenue),
#        Flint Ingelligence.png (Chart), Shopping Flint Bella.png (Revenue assets empty)
if [ -d "$OUTPUT_DIR/static/elacity/bella and flint" ]; then
  cd "$OUTPUT_DIR/static/elacity/bella and flint"
  for f in *; do
    case "$f" in
      "No Assets Flint Bella.png"|"Jumping.png"|"No activity .png"|"Flint Ingelligence.png"|"Shopping Flint Bella.png"|"Confused Flint Bella.png"|"Flint Unimpressed.png")
        ;; # keep
      *)
        rm -f "$f"
        ;;
    esac
  done
  cd "$OUTPUT_DIR"
fi
rm -rf "$OUTPUT_DIR/static/elacity/flint"
rm -rf "$OUTPUT_DIR/static/img"
rm -rf "$OUTPUT_DIR/static/mock-images"
rm -f "$OUTPUT_DIR/static/elacity/Shopping.png"
rm -f "$OUTPUT_DIR/static/elacity/Directory.png"
rm -f "$OUTPUT_DIR/static/elacity/Revenue Market.png"
rm -f "$OUTPUT_DIR/static/elacity/Flint and Bella.png"
rm -f "$OUTPUT_DIR/static/elacity/Flint and Bella 2.png"
rm -f "$OUTPUT_DIR/static/elacity/Bella Looking.png"
rm -f "$OUTPUT_DIR/static/elacity/comingsoon_dark.png"
rm -f "$OUTPUT_DIR/static/elacity/comingsoon_light.png"
rm -f "$OUTPUT_DIR/static/elacity/Libweb3 compressed.png"
rm -f "$OUTPUT_DIR/static/elacity/Welcome to Elacity compressed.png"
rm -f "$OUTPUT_DIR/static/elacity/Elacity Market Compressed.png"
rm -f "$OUTPUT_DIR/static/elacity/Elastos-SmartWeb.png"
rm -f "$OUTPUT_DIR/static/elacity/elacity-treasury.png"
rm -f "$OUTPUT_DIR/static/elacity/elanauts_trading.png"
rm -f "$OUTPUT_DIR/static/elacity/flint and Bella Explorers.png"
rm -f "$OUTPUT_DIR/static/elacity/waving.png"
rm -f "$OUTPUT_DIR/static/elacity/welcome_min.jpeg"
rm -f "$OUTPUT_DIR/static/elacity/elacity_with_logo.jpg"
rm -f "$OUTPUT_DIR/static/elacity/Flint 2.jpg"
rm -f "$OUTPUT_DIR/static/elacity/Flint 2.png"
rm -f "$OUTPUT_DIR/static/elacity/5.png"
rm -f "$OUTPUT_DIR/static/elacity/5_40p.png"
rm -f "$OUTPUT_DIR/static/elacity/4.png"
rm -f "$OUTPUT_DIR/static/elacity/9.png"
rm -f "$OUTPUT_DIR/static/filetype/video.png"
rm -f "$OUTPUT_DIR/static/filetype/3d.png"
rm -f "$OUTPUT_DIR/static/icons/database-2-original.png"
rm -f "$OUTPUT_DIR/static/icons/database-original.jpg"
rm -f "$OUTPUT_DIR/static/icons/ipfs-original.png"
rm -f "$OUTPUT_DIR/static/icons/ic_notification_chat.svg"
rm -f "$OUTPUT_DIR/static/icons/ic_notification_mail.svg"
rm -f "$OUTPUT_DIR/static/icons/ic_notification_package.svg"
rm -f "$OUTPUT_DIR/static/icons/ic_notification_shipping.svg"
rm -f "$OUTPUT_DIR/static/broken.png"

# 7e. Root welcome/marketing PNGs (welcome modal is bypassed)
echo "  - Removing welcome modal images..."
rm -f "$OUTPUT_DIR/Elacity Labs.png"
rm -f "$OUTPUT_DIR/Elacity Marketplace.png"
rm -f "$OUTPUT_DIR/Libweb3 2.png"
rm -f "$OUTPUT_DIR/Welcome to Elacity.png"

SIZE_AFTER=$(du -sm "$OUTPUT_DIR" | awk '{print $1}')
SAVED=$((SIZE_BEFORE - SIZE_AFTER))
echo "  Cleanup complete: ${SIZE_BEFORE}MB -> ${SIZE_AFTER}MB (saved ${SAVED}MB)"

step_time

# 8. Inject PC2 bootstrap script into index.html
echo "[8/8] Injecting PC2 bootstrap script..."
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

dark_scrollbar_css = r'''<style>
/* Dark scrollbar matching Elacity Market dark theme */
* { scrollbar-width: thin; scrollbar-color: #444 #121212; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #666; }
::-webkit-scrollbar-corner { background: transparent; }
</style>'''

html = html.replace('<head>', '<head>\n' + inject + '\n' + dark_scrollbar_css, 1)
index.write_text(html)
print("  Injected PC2 bootstrap script + dark scrollbar CSS into index.html")
PYEOF

# 9. Generate app.json manifest for PC2 app install system
echo "[9/9] Generating app.json manifest..."
ICON_B64=$(base64 -i "$OUTPUT_DIR/favicon-64.png" | tr -d '\n')
cat > "$OUTPUT_DIR/app.json" << APPJSONEOF
{
  "name": "elastos-nft",
  "title": "Elastos NFT",
  "version": "0.1.0",
  "description": "Browse, trade, and collect NFTs on the Elastos Smart Chain (ESC).",
  "author": {
    "name": "Elacity Labs",
    "url": "https://ela.city"
  },
  "license": "proprietary",
  "icon": "favicon-64.png",
  "iconDataUrl": "data:image/png;base64,${ICON_B64}",
  "entry": "index.html",
  "type": "web",
  "category": "marketplace",
  "role": "dapp",
  "capabilities": {
    "wallet": true,
    "network": true,
    "ipfs": { "pin": true, "fetch": true }
  },
  "requirements": {
    "minVersion": "1.1.0"
  },
  "display": {
    "maximize": true,
    "resizable": true,
    "titlebar": true,
    "taskbar": true
  },
  "distribution": {
    "channel": "stable"
  }
}
APPJSONEOF
echo "  Generated app.json with embedded icon"

BUILD_END=$(date +%s)
TOTAL=$((BUILD_END - BUILD_START))
echo ""
echo "=== Build complete in ${TOTAL}s ==="
echo "Output: $OUTPUT_DIR"
echo "Files:"
ls -la "$OUTPUT_DIR/" | head -20
