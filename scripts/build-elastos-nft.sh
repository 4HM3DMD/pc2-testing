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

# --- MostViewedContent: rename, add API-level image filter ---
mv = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'sections' / 'MostViewedContent.tsx'
mvc = mv.read_text()
mvc = mvc.replace("title=\"Most Viewed\"", "title=\"Most Viewed NFTs\"")
# Add contentType: ['image'] to API query
mvc = mvc.replace(
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
mv.write_text(mvc)

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

# --- Revenue page: hide Subscriptions from ActivityLineChart ---
ac = pathlib.Path(build_dir) / 'src' / 'components' / 'Chart' / 'ActivityLineChart.tsx'
acc = ac.read_text()
# Zero out subscription data so the chart line is flat and stats show 0
acc = acc.replace("entry.subscriptions += 1;", "")
acc = acc.replace("entry.subscriptionAmount += totalAmountUSD;\n", "")
# Rename "Subscriptions" label to hide it (replace with empty stat)
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
ac.write_text(acc)

# --- Fix FeaturedEducationContent: update channel references ---
fe = pathlib.Path(build_dir) / 'src' / 'components' / 'home' / 'sections' / 'FeaturedEducationContent.tsx'
fec = fe.read_text()
fec = fec.replace("'City Directory & Shops'", "'NFT Collections'")
fec = fec.replace("'Explore the vibrant marketplace of channels, collections, and digital storefronts in our Web3 city.'", "'Browse NFT collections on the Elastos Smart Chain marketplace.'")
fec = fec.replace("link: '/channels'", "link: '/channels'")
fe.write_text(fec)

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

# 7c. Unused lazy-loaded JS route chunks (features stripped from UI)
# CONSERVATIVE: Only delete chunks for routes that are confirmed unreachable
# Do NOT delete chunks that may be imported by shared contexts or the main bundle
echo "  - Removing unused route chunks..."
cd "$OUTPUT_DIR/assets"
rm -f AdminConsole-*.js
rm -f PlayerView-*.js
rm -f signup-*.js
rm -f RegisterForm-*.js
rm -f SubscriptionExplorer-*.js
rm -f CinemaExplorer-*.js
rm -f CinemaHorizontalFilter-*.js
rm -f ChannelCreate-*.js
rm -f HistoryMediaItemList-*.js
rm -f MediaHistory-*.js
rm -f MediaRow-*.js
rm -f MediaRoyalties-*.js
rm -f Messages-*.js
rm -f MyChannelsTabView-*.js
rm -f NoVideoFound-*.js
cd "$OUTPUT_DIR"

# 7d. Static mascot/marketing images (features removed from UI)
echo "  - Removing unused static images..."
rm -rf "$OUTPUT_DIR/static/elacity/bella and flint"
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

html = html.replace('<head>', '<head>\n' + inject, 1)
index.write_text(html)
print("  Injected PC2 bootstrap script into index.html")
PYEOF

BUILD_END=$(date +%s)
TOTAL=$((BUILD_END - BUILD_START))
echo ""
echo "=== Build complete in ${TOTAL}s ==="
echo "Output: $OUTPUT_DIR"
echo "Files:"
ls -la "$OUTPUT_DIR/" | head -20
