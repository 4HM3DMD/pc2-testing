/**
 * Elacity Market Browser — Main application controller.
 * Pipeline-style sidebar UI with feed, search, library, and detail views.
 */
(function () {
  'use strict';

  var PAGE_SIZE = 20;

  var PC2_AUTH_TOKEN = (function () {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get('puter.auth.token') || params.get('auth_token') || params.get('token') || '';
    } catch (e) { return ''; }
  })();

  function pc2Fetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (PC2_AUTH_TOKEN && !opts.headers['Authorization']) {
      opts.headers['Authorization'] = 'Bearer ' + PC2_AUTH_TOKEN;
    }
    if (!opts.credentials) opts.credentials = 'include';
    return fetch(url, opts);
  }

  // ── State ────────────────────────────────────────────

  var state = {
    activeView: 'feed',
    previousView: 'feed',
    activeCategory: 'buyNow',
    searchQuery: '',
    browseItems: [],
    browseTotal: 0,
    browseOffset: 0,
    browseLoading: false,
    assetsItems: [],
    assetsTotal: 0,
    assetsOffset: 0,
    assetsLoading: false,
    searchItems: [],
    searchTotal: 0,
    searchOffset: 0,
    searchLoading: false,
    detailItem: null,
    purchasing: false,
    searchTimeout: null,
    channelData: null,
    channelItems: [],
    channelSubscribers: null,
    channelLoading: false,
    subscribedChannels: [],
    subscriptionsLoading: false,
    detailContractAddress: null,
    detailTokenId: null,
    detailSaved: false,
    detailLikes: null,
    watchLaterPlaylistId: null,
    watchLaterItems: [],
    watchLaterLoading: false,
    activeContentType: 'all',
    searchContentType: 'all',
    channelsDirData: [],
    channelsDirLoaded: false,
    channelsDirViewMode: 'grid',
    channelsDirCategory: 'all',
    selectedPlan: null,
    viewedAssets: {},
    initializing: true
  };

  // ── DOM References ───────────────────────────────────

  var dom = {};

  function cacheDom() {
    dom.sidebarNav = document.getElementById('sidebar-nav');
    dom.walletBtn = document.getElementById('wallet-btn');
    dom.networkBadge = document.getElementById('network-badge');

    dom.viewFeed = document.getElementById('view-feed');
    dom.viewSearch = document.getElementById('view-search');
    dom.viewLibrary = document.getElementById('view-library');
    dom.viewSubscriptions = document.getElementById('view-subscriptions');
    dom.viewWatchlater = document.getElementById('view-watchlater');
    dom.viewDetail = document.getElementById('view-detail');

    dom.categoryTabs = document.getElementById('category-tabs');
    dom.contentTypeTabs = document.getElementById('content-type-tabs');
    dom.searchTypeTabs = document.getElementById('search-type-tabs');
    dom.nftGrid = document.getElementById('nft-grid');
    dom.browseLoading = document.getElementById('browse-loading');
    dom.browseEmpty = document.getElementById('browse-empty');
    dom.loadMoreBtn = document.getElementById('load-more-btn');

    dom.searchInput = document.getElementById('search-input');
    dom.searchGrid = document.getElementById('search-grid');
    dom.searchLoading = document.getElementById('search-loading');
    dom.searchEmpty = document.getElementById('search-empty');

    dom.authPrompt = document.getElementById('auth-prompt');
    dom.authBtn = document.getElementById('auth-btn');
    dom.assetsGrid = document.getElementById('assets-grid');
    dom.assetsLoading = document.getElementById('assets-loading');
    dom.assetsEmpty = document.getElementById('assets-empty');

    dom.viewChannel = document.getElementById('view-channel');
    dom.channelBackBtn = document.getElementById('channel-back-btn');
    dom.channelCover = document.getElementById('channel-cover');
    dom.channelAvatarLg = document.getElementById('channel-avatar-lg');
    dom.channelPageName = document.getElementById('channel-page-name');
    dom.channelPageStats = document.getElementById('channel-page-stats');
    dom.channelDescription = document.getElementById('channel-description');
    dom.subscribeBtn = document.getElementById('subscribe-btn');
    dom.channelItemsGrid = document.getElementById('channel-items-grid');
    dom.channelItemsLoading = document.getElementById('channel-items-loading');
    dom.channelItemsEmpty = document.getElementById('channel-items-empty');

    dom.viewChannels = document.getElementById('view-channels');
    dom.channelsViewToggle = document.getElementById('channels-view-toggle');
    dom.channelCategoryTabs = document.getElementById('channel-category-tabs');
    dom.channelsDirGrid = document.getElementById('channels-dir-grid');
    dom.channelsDirList = document.getElementById('channels-dir-list');
    dom.channelsDirLoading = document.getElementById('channels-dir-loading');
    dom.channelsDirEmpty = document.getElementById('channels-dir-empty');

    dom.subsGrid = document.getElementById('subs-grid');
    dom.subsLoading = document.getElementById('subs-loading');
    dom.subsEmpty = document.getElementById('subs-empty');

    dom.watchlaterGrid = document.getElementById('watchlater-grid');
    dom.watchlaterLoading = document.getElementById('watchlater-loading');
    dom.watchlaterEmpty = document.getElementById('watchlater-empty');

    dom.detailBackBtn = document.getElementById('detail-back-btn');
    dom.detailImage = document.getElementById('detail-image');
    dom.detailTitle = document.getElementById('detail-title');
    dom.detailCreator = document.getElementById('detail-creator');
    dom.detailDate = document.getElementById('detail-date');
    dom.detailViews = document.getElementById('detail-views');
    dom.detailDescription = document.getElementById('detail-description');
    dom.detailPriceSection = document.getElementById('detail-price-section');
    dom.detailPrice = document.getElementById('detail-price');
    dom.detailOwned = document.getElementById('detail-owned');
    dom.buyBtn = document.getElementById('buy-btn');
    dom.playBtn = document.getElementById('play-btn');
    dom.playOwnedBtn = document.getElementById('play-owned-btn');
    dom.detailAttributes = document.getElementById('detail-attributes');
    dom.previewBtn = document.getElementById('preview-btn');
    dom.detailMedia = document.getElementById('detail-media');
    dom.previewPlayer = document.getElementById('detail-preview-player');
    dom.saveBtn = document.getElementById('save-btn');
    dom.saveLabel = document.getElementById('save-label');
    dom.likeBtn = document.getElementById('like-btn');
    dom.likeCount = document.getElementById('like-count');
    dom.purchaseStatus = document.getElementById('purchase-status');
    dom.downloadNodeBtn = document.getElementById('download-node-btn');
    dom.openViewerBtn = document.getElementById('open-viewer-btn');
    dom.downloadStatus = document.getElementById('download-status');
    dom.toastContainer = document.getElementById('toast-container');
    dom.themeToggle = document.getElementById('theme-toggle');
  }

  // ── Helpers ──────────────────────────────────────────

  var USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

  function getTokenSymbol(payToken) {
    if (!payToken) return 'ETH';
    if (payToken.toLowerCase() === USDC_ADDRESS) return 'USDC';
    return 'ETH';
  }

  function formatPrice(price, paymentToken) {
    if (!price && price !== 0) return '';
    var num = typeof price === 'string' ? parseFloat(price) : price;
    if (isNaN(num)) return '';
    var symbol = getTokenSymbol(paymentToken);
    var formatted = num < 0.01 ? num.toExponential(2) : num.toFixed(2);
    return formatted + ' ' + symbol;
  }

  function formatAddress(addr) {
    if (!addr) return '';
    return addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
  }

  function getCreatorName(item) {
    if (item.channel && item.channel.creator) {
      var c = item.channel.creator;
      if (c.did && c.did.credentials && c.did.credentials.name) return c.did.credentials.name;
      if (c.alias) return c.alias;
      return formatAddress(c.address);
    }
    if (item.owner) {
      var o = item.owner;
      if (o.did && o.did.credentials && o.did.credentials.name) return o.did.credentials.name;
      if (o.alias) return o.alias;
      return formatAddress(o.address);
    }
    return 'Unknown';
  }

  function getCreatorAvatar(item) {
    var creator = (item.channel && item.channel.creator) || item.owner;
    if (creator) {
      var didThumb = creator.did && creator.did.credentials && creator.did.credentials.avatar && creator.did.credentials.avatar.thumbnail;
      if (didThumb && resolveIpfsUrl(didThumb)) return didThumb;
      if (creator.avatar && resolveIpfsUrl(creator.avatar)) return creator.avatar;
    }
    if (item.channel) {
      if (item.channel.image && resolveIpfsUrl(item.channel.image)) return item.channel.image;
      if (item.channel.imageURL && resolveIpfsUrl(item.channel.imageURL)) return item.channel.imageURL;
    }
    return null;
  }

  function getContentType(item) {
    if (item.metadata && item.metadata.media && item.metadata.media.contentType) {
      var ct = item.metadata.media.contentType;
      if (ct.indexOf('video') !== -1) return 'Video';
      if (ct.indexOf('audio') !== -1) return 'Audio';
      if (ct.indexOf('image') !== -1) return 'Image';
      return ct.split('/')[0];
    }
    if (item.category) return item.category;
    return null;
  }

  function isNonMediaAsset(nft) {
    var meta = nft.metadata || {};
    var media = meta.media || {};
    var asset = meta.asset || {};
    var ct = (media.contentType || media.mimeType || '').toLowerCase();
    var duration = media.duration || nft.duration || 0;

    if (ct.indexOf('video') !== -1 || ct.indexOf('audio') !== -1) return false;
    if (asset.assetType === 'video' || asset.assetType === 'audio') return false;
    if (duration > 0 && !asset.encrypted) return false;

    var attrs = meta.attributes || [];
    for (var i = 0; i < attrs.length; i++) {
      var t = (attrs[i].trait_type || '').toLowerCase();
      var v = (String(attrs[i].value || '')).toLowerCase();
      if (t === 'type' && (v === 'video' || v === 'audio')) return false;
      if (t === 'content_type' && (v.indexOf('video') !== -1 || v.indexOf('audio') !== -1)) return false;
    }

    if (meta.schema === 'elacity-asset-envelope-v1') return true;
    if (asset.encrypted) return true;

    return ct.indexOf('video') === -1 && ct.indexOf('audio') === -1;
  }

  function resolveIpfsUrl(url) {
    if (!url) return '';
    if (url.startsWith('ipfs://')) return 'https://ipfs.ela.city/ipfs/' + url.slice(7);
    if (url.startsWith('thumbnail:')) return '';
    if (url.match(/^Qm[1-9A-HJ-NP-Za-km-z]{44}/)) return 'https://ipfs.ela.city/ipfs/' + url;
    if (url.match(/^bafy[a-z2-7]{55}/i)) return 'https://ipfs.ela.city/ipfs/' + url;
    return url;
  }

  function getImageUrl(item) {
    if (item.imageURL) return resolveIpfsUrl(item.imageURL);
    if (item.thumbnailPath) return resolveIpfsUrl(item.thumbnailPath);
    if (item.image) return resolveIpfsUrl(item.image);
    return '';
  }

  function normalizeLedgerAsset(asset) {
    if (asset.contractAddress) return asset;
    var tid = asset.tokenId || {};
    var listing = (asset.operative && asset.operative.access &&
      asset.operative.access.listings && asset.operative.access.listings[0]) || null;
    var rawPrice = listing ? listing.price : null;
    var payToken = listing ? listing.payToken : null;
    var decimals = getTokenSymbol(payToken) === 'USDC' ? 6 : 18;
    var displayPrice = rawPrice != null ? rawPrice / Math.pow(10, decimals) : null;
    return Object.assign({}, asset, {
      contractAddress: asset.address,
      hexTokenID: tid.hexTokenID || '',
      tokenID: tid.tokenID != null ? tid.tokenID : 0,
      price: displayPrice,
      paymentToken: payToken
    });
  }

  function getListing(item) {
    if (!item.operative || !item.operative.access || !item.operative.access.listings) return null;
    var listings = item.operative.access.listings;
    if (listings.length === 0) return null;
    return listings[0];
  }

  function isAssetInLibrary(nft) {
    var addr = nft.contractAddress || '';
    var tid = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '';
    return state.assetsItems.some(function (a) {
      var aAddr = a.contractAddress || '';
      var aTid = a.hexTokenID || a.tokenID || '';
      return aAddr.toLowerCase() === addr.toLowerCase() && aTid === tid;
    });
  }

  function escapeHtml(text) {
    if (!text) return '';
    var el = document.createElement('span');
    el.textContent = text;
    return el.innerHTML;
  }

  function formatViews(views) {
    if (!views) return '';
    if (views >= 1000000) return (views / 1000000).toFixed(1) + 'M views';
    if (views >= 1000) return (views / 1000).toFixed(1) + 'K views';
    return views.toLocaleString() + ' views';
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return 'Uploaded ' + d.toISOString().split('T')[0];
  }

  function getChannelName(item) {
    if (item.channel && item.channel.name) return item.channel.name;
    return getCreatorName(item);
  }

  // ── Theme ────────────────────────────────────────────

  var THEME_KEY = 'elacity-theme';

  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function toggleTheme() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem(THEME_KEY, 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem(THEME_KEY, 'dark');
    }
  }

  // ── Toast ────────────────────────────────────────────

  function showToast(message, type) {
    var toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(function () { toast.remove(); }, 300);
    }, 4000);
  }

  // ── View Routing ─────────────────────────────────────

  var VIEW_MAP = {
    feed: 'viewFeed',
    search: 'viewSearch',
    library: 'viewLibrary',
    channels: 'viewChannels',
    subscriptions: 'viewSubscriptions',
    watchlater: 'viewWatchlater',
    detail: 'viewDetail',
    channel: 'viewChannel'
  };

  function switchView(viewName) {
    if (viewName !== 'detail' && viewName !== 'channel') {
      state.previousView = viewName;
    }
    state.activeView = viewName;

    var sidebarView = viewName === 'channel' ? null : viewName;
    document.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.toggle('active', n.dataset.view === sidebarView);
    });

    Object.keys(VIEW_MAP).forEach(function (key) {
      var el = dom[VIEW_MAP[key]];
      if (el) {
        el.classList.toggle('active', key === viewName);
        el.classList.toggle('hidden', key !== viewName);
      }
    });

    if (viewName === 'library') renderMyAssetsView();
    if (viewName === 'search') dom.searchInput.focus();
    if (viewName === 'channels') loadChannelsDirectory();
    if (viewName === 'subscriptions') renderSubscriptionsView();
    if (viewName === 'watchlater') loadWatchLater();
  }

  // ── Video Card Rendering ─────────────────────────────

  function renderCard(item, isOwned) {
    var card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.contractAddress = item.contractAddress;
    card.dataset.tokenId = item.hexTokenID || item.tokenID;

    var imageUrl = getImageUrl(item);
    var title = escapeHtml(item.name || 'Untitled');
    var channelName = escapeHtml(getChannelName(item));
    var creatorName = escapeHtml(getCreatorName(item));
    var contentType = getContentType(item);
    var price = formatPrice(item.price, item.paymentToken);
    var views = item.views ? formatViews(item.views) : '';
    var avatarUrl = resolveIpfsUrl(getCreatorAvatar(item) || '');
    var avatarInitial = (creatorName || '?').charAt(0).toUpperCase();
    var avatarContent = avatarUrl
      ? '<img src="' + escapeHtml(avatarUrl) + '" alt="" onerror="this.style.display=\'none\';this.parentNode.textContent=\'' + avatarInitial + '\'" />'
      : avatarInitial;

    var hasChannel = item.channel && item.channel.address;

    var priceBadgeHtml = isOwned
      ? '<span class="price-badge owned-badge">Owned</span>'
      : (price ? '<span class="price-badge">' + price + '</span>' : '');

    card.innerHTML =
      '<div class="video-card-thumb">' +
        (imageUrl ? '<img src="' + escapeHtml(imageUrl) + '" alt="' + title + '" loading="lazy" onerror="this.style.display=\'none\'" />' : '') +
        (contentType ? '<span class="content-badge">' + escapeHtml(contentType) + '</span>' : '') +
        priceBadgeHtml +
      '</div>' +
      '<div class="video-card-info">' +
        '<div class="video-card-avatar">' + avatarContent + '</div>' +
        '<div class="video-card-text">' +
          '<div class="video-card-title">' + title + '</div>' +
          '<div class="video-card-channel' + (hasChannel ? ' clickable' : '') + '">' + channelName + '</div>' +
          '<div class="video-card-stats">' +
            (views ? '<span>' + views + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    card.addEventListener('click', function (e) {
      if (e.target.closest('.video-card-channel.clickable')) {
        e.stopPropagation();
        openChannel(item.channel.address);
        return;
      }
      openDetail(item.contractAddress, item.hexTokenID || item.tokenID, isOwned);
    });

    return card;
  }

  // ── Feed (Browse) ───────────────────────────────────

  function loadBrowse(append) {
    if (state.browseLoading) return;
    state.browseLoading = true;

    if (!append) {
      state.browseOffset = 0;
      state.browseItems = [];
      dom.nftGrid.innerHTML = '';
    }

    dom.browseLoading.classList.remove('hidden');
    dom.browseEmpty.classList.add('hidden');
    dom.loadMoreBtn.classList.add('hidden');

    var preset = ElacityAPI.PRESETS[state.activeCategory];
    var args = preset(state.browseOffset, PAGE_SIZE);
    var query = args[0];
    var filters = args[1];

    if (state.activeContentType !== 'all') {
      query.contentType = [state.activeContentType];
    }

    ElacityAPI.fetchItems(query, filters)
      .then(function (result) {
        state.browseLoading = false;
        dom.browseLoading.classList.add('hidden');

        if (!result || !result.data) {
          if (!append) dom.browseEmpty.classList.remove('hidden');
          return;
        }

        state.browseTotal = result.total;
        var validItems = (result.data || []).filter(function (item) { return item !== null; });
        state.browseItems = state.browseItems.concat(validItems);
        state.browseOffset += result.data ? result.data.length : 0;

        validItems.forEach(function (item) {
          dom.nftGrid.appendChild(renderCard(item));
        });

        if (state.browseItems.length === 0) {
          dom.browseEmpty.classList.remove('hidden');
        }

        if (state.browseOffset < state.browseTotal) {
          dom.loadMoreBtn.classList.remove('hidden');
        }
      })
      .catch(function (err) {
        state.browseLoading = false;
        dom.browseLoading.classList.add('hidden');
        showToast('Failed to load: ' + err.message, 'error');
      });
  }

  // ── Search ──────────────────────────────────────────

  function loadSearch() {
    var q = state.searchQuery;
    if (!q) {
      dom.searchGrid.innerHTML = '';
      dom.searchEmpty.classList.add('hidden');
      return;
    }

    state.searchLoading = true;
    dom.searchLoading.classList.remove('hidden');
    dom.searchEmpty.classList.add('hidden');
    dom.searchGrid.innerHTML = '';

    var searchQuery = { type: 'single' };
    if (state.searchContentType !== 'all') {
      searchQuery.contentType = [state.searchContentType];
    }

    ElacityAPI.fetchItems(
      searchQuery,
      { offset: 0, limit: PAGE_SIZE, sort: { createdAt: -1 }, searchBy: q }
    )
      .then(function (result) {
        state.searchLoading = false;
        dom.searchLoading.classList.add('hidden');

        if (!result || !result.data || result.data.length === 0) {
          dom.searchEmpty.classList.remove('hidden');
          return;
        }

        state.searchItems = result.data;
        result.data.forEach(function (item) {
          dom.searchGrid.appendChild(renderCard(item));
        });
      })
      .catch(function (err) {
        state.searchLoading = false;
        dom.searchLoading.classList.add('hidden');
        showToast('Search failed: ' + err.message, 'error');
      });
  }

  // ── My Library ──────────────────────────────────────

  function renderMyAssetsView() {
    if (!Wallet.isConnected()) {
      console.log('[Library] Wallet not connected, showing auth prompt');
      dom.authPrompt.classList.remove('hidden');
      dom.assetsGrid.classList.add('hidden');
      dom.assetsEmpty.classList.add('hidden');
      return;
    }

    if (!ElacityAPI.isAuthenticated()) {
      console.log('[Library] Not authenticated, starting SIWE login...');
      console.log('[Library] connectedAddress:', Wallet.getAddress(), 'smartAccount:', Wallet.getSignerAddress());
      dom.authPrompt.classList.add('hidden');
      dom.assetsGrid.classList.add('hidden');
      dom.assetsEmpty.classList.add('hidden');
      dom.assetsLoading.classList.remove('hidden');

      Wallet.siweLogin()
        .then(function () {
          console.log('[Library] SIWE login succeeded, signer:', ElacityAPI.getSignerAddress());
          dom.assetsLoading.classList.add('hidden');
          renderMyAssetsView();
        })
        .catch(function (err) {
          console.error('[Library] SIWE login failed:', err);
          dom.assetsLoading.classList.add('hidden');
          dom.authPrompt.classList.remove('hidden');
          showToast('Library login failed: ' + (err.message || 'signature rejected'), 'error');
        });
      return;
    }

    dom.authPrompt.classList.add('hidden');
    dom.assetsGrid.classList.remove('hidden');

    if (state.assetsItems.length === 0 && !state.assetsLoading) {
      loadMyAssets();
    }
  }

  function refreshLibrary() {
    state.assetsItems = [];
    state.assetsLoading = false;
    loadMyAssets();
  }

  function loadMyAssets() {
    var addr = Wallet.getAddress();
    var signer = Wallet.getSignerAddress();
    if (state.assetsLoading || !addr) return;
    state.assetsLoading = true;

    dom.assetsLoading.classList.remove('hidden');
    dom.assetsEmpty.classList.add('hidden');
    dom.assetsGrid.innerHTML = '';

    console.log('[Library] Loading assets for EOA:', addr, 'signer:', signer, 'auth:', ElacityAPI.isAuthenticated(), 'apiSigner:', ElacityAPI.getSignerAddress());

    ElacityAPI.fetchAccessibleAssets(0, PAGE_SIZE)
      .then(function (result) {
        state.assetsLoading = false;
        dom.assetsLoading.classList.add('hidden');

        var count = result && result.data ? result.data.length : 0;
        console.log('[Library] Got', count, 'items (total:', result ? result.total : 0, ')');

        if (!result || !result.data || result.data.length === 0) {
          dom.assetsEmpty.classList.remove('hidden');
          return;
        }

        state.assetsItems = result.data;

        result.data.forEach(function (item) {
          dom.assetsGrid.appendChild(renderCard(item, true));
        });
      })
      .catch(function (err) {
        state.assetsLoading = false;
        dom.assetsLoading.classList.add('hidden');
        console.error('[Library] Error:', err);
        dom.assetsEmpty.classList.remove('hidden');
        showToast('Failed to load library: ' + err.message, 'error');
      });
  }

  // ── Detail View ─────────────────────────────────────

  function openDetail(contractAddress, tokenId, isOwned) {
    switchView('detail');

    state.detailContractAddress = contractAddress;
    state.detailTokenId = tokenId;
    state.detailIsOwned = !!isOwned;
    state.detailSaved = false;
    state.detailLikes = null;

    dom.previewPlayer.innerHTML = '';
    dom.previewPlayer.classList.add('hidden');
    dom.detailImage.style.display = '';
    dom.detailImage.src = '';
    dom.detailImage.style.objectFit = '';
    dom.detailImage.style.height = '';
    dom.previewBtn.classList.add('hidden');
    var mediaEl = document.getElementById('detail-media');
    if (mediaEl) { mediaEl.style.aspectRatio = ''; mediaEl.style.maxHeight = ''; mediaEl.style.overflowY = ''; }
    var pdfContainer = document.getElementById('pdf-pages-container');
    if (pdfContainer) pdfContainer.remove();
    dom.detailTitle.textContent = 'Loading...';
    dom.detailCreator.innerHTML = '';
    dom.detailDate.textContent = '';
    dom.detailViews.textContent = '';
    dom.detailDescription.textContent = '';
    dom.detailPriceSection.classList.add('hidden');
    dom.buyBtn.classList.remove('hidden');
    dom.detailOwned.classList.add('hidden');
    dom.playBtn.classList.add('hidden');
    dom.playOwnedBtn.classList.add('hidden');
    dom.detailAttributes.innerHTML = '';
    dom.purchaseStatus.classList.add('hidden');
    dom.downloadNodeBtn.classList.add('hidden');
    dom.openViewerBtn.classList.add('hidden');
    dom.downloadStatus.classList.add('hidden');
    dom.saveBtn.classList.remove('saved');
    dom.saveLabel.textContent = 'Save';
    dom.likeBtn.classList.remove('liked');
    dom.likeCount.textContent = '';

    ElacityAPI.getAssetDetail(contractAddress, tokenId)
      .then(function (nft) {
        if (!nft) {
          showToast('NFT not found', 'error');
          goBack();
          return;
        }

        state.detailItem = nft;

        // For non-media assets, the Elacity GraphQL API doesn't expose our
        // custom `asset` field. Fetch raw metadata from IPFS to get the
        // encrypted content CID and dataToEncryptHash.
        var tokenURI = nft.tokenURI || '';
        var needsRawMeta = isNonMediaAsset(nft) && tokenURI;
        if (needsRawMeta) {
          fetchRawMetadataLocalFirst(tokenURI)
            .then(function (rawMeta) {
              if (rawMeta && rawMeta.asset) {
                nft._rawAsset = rawMeta.asset;
                nft._rawMedia = rawMeta.media;
                console.log('[Detail] Raw metadata loaded, asset CID:', rawMeta.asset.cid);
              }
            })
            .catch(function (e) { console.warn('[Detail] Failed to fetch raw metadata:', e.message); })
            .finally(function () {
              renderDetail(nft);
            });
        } else {
          renderDetail(nft);
        }

        loadDetailInteractions(contractAddress, tokenId);

        var viewKey = contractAddress + ':' + tokenId;
        if (!state.viewedAssets[viewKey]) {
          state.viewedAssets[viewKey] = true;
          ElacityAPI.incrementViews(contractAddress, tokenId, Wallet.getSignerAddress());
        }
      })
      .catch(function (err) {
        showToast('Failed to load details: ' + err.message, 'error');
        goBack();
      });
  }

  function renderDetail(nft) {
    var meta = nft.metadata || {};
    var media = meta.media || {};
    var channel = nft.channel || {};
    var creator = channel.creator || {};

    var imageUrl = resolveIpfsUrl(nft.image || media.previewURL || '');
    dom.detailImage.src = imageUrl;
    dom.detailImage.alt = nft.name || '';
    dom.detailImage.onerror = function () { this.style.display = 'none'; };
    if (imageUrl) dom.detailImage.style.display = '';

    dom.detailTitle.textContent = meta.name || nft.name || 'Untitled';

    var creatorName = (creator.did && creator.did.credentials && creator.did.credentials.name) ||
      creator.alias || formatAddress(creator.address || '');
    var creatorAvatar = resolveIpfsUrl(
      (creator.did && creator.did.credentials && creator.did.credentials.avatar && creator.did.credentials.avatar.thumbnail) ||
      creator.avatar || channel.imageURL || '');

    var hasChannelLink = channel && channel.address;

    var detailAvatarInitial = (creatorName || '?').charAt(0).toUpperCase();
    dom.detailCreator.innerHTML =
      '<div class="channel-avatar">' +
        (creatorAvatar ? '<img src="' + escapeHtml(creatorAvatar) + '" alt="" onerror="this.style.display=\'none\';this.parentNode.textContent=\'' + detailAvatarInitial + '\'" />' : detailAvatarInitial) +
      '</div>' +
      '<div class="channel-info">' +
        '<div class="channel-name">' + escapeHtml(channel.name || creatorName || 'Unknown') + '</div>' +
        (channel.itemsCount ? '<div class="channel-subs">' + channel.itemsCount + ' items</div>' : '') +
      '</div>';

    if (hasChannelLink) {
      dom.detailCreator.classList.add('clickable');
      dom.detailCreator.onclick = function () {
        openChannel(channel.address);
      };
    } else {
      dom.detailCreator.classList.remove('clickable');
      dom.detailCreator.onclick = null;
    }

    dom.detailDate.textContent = formatDate(nft.createdAt);
    dom.detailViews.textContent = nft.views ? formatViews(nft.views) : '';

    dom.detailDescription.textContent = meta.description || '';

    var previewUrl = media.previewURL ? resolveIpfsUrl(media.previewURL) : '';
    if (previewUrl) {
      dom.previewBtn.classList.remove('hidden');
    }

    var listing = getListing(nft);
    var hasListing = listing && listing.price;
    var isOwned = state.detailIsOwned || isAssetInLibrary(nft);

    if (hasListing && !isOwned) {
      dom.detailPriceSection.classList.remove('hidden');
      var decimals = getTokenSymbol(listing.payToken) === 'USDC' ? 6 : 18;
      var displayPrice = listing.price / Math.pow(10, decimals);
      dom.detailPrice.textContent = formatPrice(displayPrice, listing.payToken);
      dom.playBtn.classList.remove('hidden');
      dom.detailOwned.classList.add('hidden');
      dom.downloadNodeBtn.classList.add('hidden');
    } else {
      dom.detailOwned.classList.remove('hidden');
      var rawAsset = nft._rawAsset || (nft.metadata && nft.metadata.asset) || {};
      var cid = media.uri || rawAsset.uri || rawAsset.cid;
      if (cid) cid = cid.replace('ipfs://', '');
      var nonMedia = isNonMediaAsset(nft);
      if (nonMedia) {
        dom.playOwnedBtn.classList.add('hidden');
        if (cid) {
          dom.openViewerBtn.classList.remove('hidden');
          dom.downloadNodeBtn.classList.remove('hidden');
          console.log('[Detail] Non-media asset, CID:', cid, 'hash:', rawAsset.dataToEncryptHash);
        } else {
          console.warn('[Detail] Non-media asset but no CID found');
        }
      } else {
        dom.playOwnedBtn.classList.remove('hidden');
        if (cid) dom.downloadNodeBtn.classList.remove('hidden');
      }
      if (hasListing && isOwned) {
        dom.detailPriceSection.classList.remove('hidden');
        dom.buyBtn.classList.add('hidden');
        var ownedDecimals = getTokenSymbol(listing.payToken) === 'USDC' ? 6 : 18;
        var ownedPrice = listing.price / Math.pow(10, ownedDecimals);
        dom.detailPrice.textContent = formatPrice(ownedPrice, listing.payToken) + ' (Owned)';
      }
    }

    var attrs = (meta.attributes || []).filter(function (a) {
      return a.trait_type && a.trait_type.indexOf('iscc::') !== 0;
    });

    var attrHtml = '';
    if (media.contentType) {
      attrHtml += '<div class="attribute-chip"><span class="attr-label">Type</span><span class="attr-value">' + escapeHtml(media.contentType) + '</span></div>';
    }
    attrs.forEach(function (attr) {
      attrHtml += '<div class="attribute-chip">' +
        '<span class="attr-label">' + escapeHtml(attr.trait_type || '') + '</span>' +
        '<span class="attr-value">' + escapeHtml(String(attr.value || '')) + '</span>' +
        '</div>';
    });
    dom.detailAttributes.innerHTML = attrHtml;
  }

  function goBack() {
    state.detailItem = null;
    switchView(state.previousView || 'feed');
  }

  // ── Channel View ───────────────────────────────────

  var SUBS_STORAGE_KEY = 'elacity-subscriptions';

  function getLocalSubscriptions() {
    try {
      return JSON.parse(localStorage.getItem(SUBS_STORAGE_KEY) || '[]');
    } catch (e) { return []; }
  }

  function saveLocalSubscriptions(subs) {
    localStorage.setItem(SUBS_STORAGE_KEY, JSON.stringify(subs));
  }

  function openChannel(channelAddress) {
    if (!channelAddress) return;
    switchView('channel');

    state.channelData = null;
    state.channelItems = [];
    state.channelSubscribers = null;
    state.channelLoading = true;

    dom.channelPageName.textContent = 'Loading...';
    dom.channelPageStats.textContent = '';
    dom.channelDescription.textContent = '';
    dom.channelAvatarLg.innerHTML = '';
    dom.channelCover.innerHTML = '';
    dom.channelItemsGrid.innerHTML = '';
    dom.channelItemsEmpty.classList.add('hidden');
    dom.channelItemsLoading.classList.remove('hidden');
    dom.subscribeBtn.classList.remove('subscribed');
    dom.subscribeBtn.textContent = 'Subscribe';

    var signerAddr = ElacityAPI.getSignerAddress() || Wallet.getSignerAddress();

    Promise.all([
      ElacityAPI.retrieveChannel(channelAddress),
      ElacityAPI.listSubscribers(channelAddress, signerAddr || null),
      ElacityAPI.fetchChannelItems(channelAddress, 0, 40)
    ])
      .then(function (results) {
        var channel = results[0];
        var subscribers = results[1];
        var items = results[2];

        state.channelLoading = false;
        state.channelData = channel;
        state.channelSubscribers = subscribers;

        if (!channel) {
          showToast('Channel not found', 'error');
          goBack();
          return;
        }

        renderChannelPage(channel, subscribers, items);
      })
      .catch(function (err) {
        state.channelLoading = false;
        dom.channelItemsLoading.classList.add('hidden');
        showToast('Failed to load channel: ' + err.message, 'error');
      });
  }

  function renderChannelPage(channel, subscribers, items) {
    var creator = channel.creator || {};
    var creatorName = (creator.did && creator.did.credentials && creator.did.credentials.name) ||
      creator.alias || formatAddress(creator.address || '');

    dom.channelPageName.textContent = channel.name || creatorName || 'Untitled Channel';

    var statsText = '';
    if (subscribers && subscribers.count != null) {
      statsText += subscribers.count + ' subscriber' + (subscribers.count !== 1 ? 's' : '');
    }
    if (channel.itemsCount) {
      if (statsText) statsText += ' \u00B7 ';
      statsText += channel.itemsCount + ' item' + (channel.itemsCount !== 1 ? 's' : '');
    }
    dom.channelPageStats.textContent = statsText;

    dom.channelDescription.textContent = channel.description || '';

    var coverSrc = resolveIpfsUrl(channel.coverImage || channel.coverImageURL || '');
    if (coverSrc) {
      dom.channelCover.innerHTML = '<img src="' + escapeHtml(coverSrc) + '" alt="" onerror="this.style.display=\'none\'" />';
    }

    var avatarUrl = resolveIpfsUrl(channel.image || channel.imageURL ||
      (creator.did && creator.did.credentials && creator.did.credentials.avatar && creator.did.credentials.avatar.thumbnail) ||
      creator.avatar || '');
    if (avatarUrl) {
      dom.channelAvatarLg.innerHTML = '<img src="' + escapeHtml(avatarUrl) + '" alt="" onerror="this.parentNode.textContent=\'' + (channel.name || '?').charAt(0).toUpperCase() + '\'" />';
    } else {
      dom.channelAvatarLg.textContent = (channel.name || '?').charAt(0).toUpperCase();
    }

    var hasPlans = channel.plans && channel.plans.length > 0;
    if (subscribers && subscribers.isAmong) {
      dom.subscribeBtn.classList.add('subscribed');
      dom.subscribeBtn.textContent = 'Subscribed';
    } else if (hasPlans) {
      var cheapest = channel.plans.reduce(function (min, p) { return p.price < min.price ? p : min; }, channel.plans[0]);
      dom.subscribeBtn.textContent = 'Subscribe from ' + formatPrice(cheapest.price, cheapest.payToken);
    }

    dom.channelItemsLoading.classList.add('hidden');

    var itemList = (items && (items.items || items.data)) || [];
    if (itemList.length === 0) {
      dom.channelItemsEmpty.classList.remove('hidden');
      return;
    }

    state.channelItems = itemList;
    itemList.forEach(function (item) {
      dom.channelItemsGrid.appendChild(renderCard(normalizeLedgerAsset(item)));
    });
  }

  var SUBSCRIPTION_ABI = [
    { inputs: [{ type: 'address' }], name: 'hasActiveSubscription', outputs: [{ type: 'bool' }], stateMutability: 'view', type: 'function' },
    { inputs: [], name: 'paymentProcessor', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ type: 'uint8' }, { type: 'bool' }], name: 'subscribePlan', outputs: [], stateMutability: 'payable', type: 'function' }
  ];

  var ERC20_ABI = [
    { inputs: [{ type: 'address' }, { type: 'address' }], name: 'allowance', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
    { inputs: [{ type: 'address' }, { type: 'uint256' }], name: 'approve', outputs: [{ type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [], name: 'decimals', outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' }
  ];

  var ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

  function handleSubscribe() {
    var channel = state.channelData;
    if (!channel) return;

    var plans = channel.plans || [];
    if (plans.length > 0) {
      openSubscribeModal(channel, plans);
      return;
    }

    handleFollowToggle(channel);
  }

  function handleFollowToggle(channel) {
    dom.subscribeBtn.disabled = true;
    var authPromise;
    if (!Wallet.isConnected() || !ElacityAPI.isAuthenticated()) {
      authPromise = handleAuth().then(function () {
        if (!ElacityAPI.isAuthenticated()) throw new Error('Authentication required');
      });
    } else {
      authPromise = Promise.resolve();
    }

    var isSubscribed = dom.subscribeBtn.classList.contains('subscribed');
    authPromise
      .then(function () {
        return isSubscribed
          ? ElacityAPI.unsubscribeChannel(channel.address)
          : ElacityAPI.subscribeChannel(channel.address);
      })
      .then(function () {
        if (isSubscribed) {
          dom.subscribeBtn.classList.remove('subscribed');
          dom.subscribeBtn.textContent = 'Subscribe';
          removeLocalSubscription(channel.address);
          showToast('Unfollowed ' + (channel.name || 'channel'), 'success');
        } else {
          dom.subscribeBtn.classList.add('subscribed');
          dom.subscribeBtn.textContent = 'Subscribed';
          addLocalSubscription(channel);
          showToast('Following ' + (channel.name || 'channel'), 'success');
        }
        updateChannelStats(channel);
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); })
      .finally(function () { dom.subscribeBtn.disabled = false; });
  }

  function updateChannelStats(channel) {
    var statsText = (state.channelSubscribers ? state.channelSubscribers.count : 0) +
      ' subscriber' + ((state.channelSubscribers && state.channelSubscribers.count !== 1) ? 's' : '');
    if (channel.itemsCount) statsText += ' \u00B7 ' + channel.itemsCount + ' item' + (channel.itemsCount !== 1 ? 's' : '');
    dom.channelPageStats.textContent = statsText;
  }

  function openSubscribeModal(channel, plans) {
    state.selectedPlan = null;
    var modalEl = document.getElementById('subscribe-modal');
    var titleEl = document.getElementById('sub-modal-title');
    var plansEl = document.getElementById('sub-modal-plans');
    var confirmEl = document.getElementById('sub-modal-confirm');
    var statusEl = document.getElementById('sub-modal-status');

    titleEl.textContent = 'Subscribe to ' + (channel.name || 'Channel');
    statusEl.textContent = '';
    statusEl.className = 'sub-modal-status';
    confirmEl.disabled = true;
    confirmEl.textContent = 'Select a plan';

    plansEl.innerHTML = '';
    plans.forEach(function (plan) {
      var option = document.createElement('div');
      option.className = 'sub-plan-option';
      option.dataset.planId = plan.planId;

      var priceStr = formatPrice(plan.price, plan.payToken);
      var durationStr = plan.duration ? plan.duration.value + ' ' + plan.duration.unit : '';

      option.innerHTML =
        '<div class="sub-plan-radio"></div>' +
        '<div class="sub-plan-details">' +
          '<div class="sub-plan-label">' + escapeHtml(plan.label || durationStr) + '</div>' +
          (plan.description ? '<div class="sub-plan-desc">' + escapeHtml(plan.description) + '</div>' : '') +
        '</div>' +
        '<div class="sub-plan-price">' + priceStr + '</div>';

      option.addEventListener('click', function () {
        plansEl.querySelectorAll('.sub-plan-option').forEach(function (o) { o.classList.remove('selected'); });
        option.classList.add('selected');
        state.selectedPlan = plan;
        confirmEl.disabled = false;
        confirmEl.textContent = 'Subscribe for ' + priceStr;
      });

      plansEl.appendChild(option);
    });

    modalEl.classList.remove('hidden');
  }

  function closeSubscribeModal() {
    document.getElementById('subscribe-modal').classList.add('hidden');
    state.selectedPlan = null;
  }

  function executeSubscription() {
    var channel = state.channelData;
    var plan = state.selectedPlan;
    if (!channel || !plan) return;

    var confirmEl = document.getElementById('sub-modal-confirm');
    var statusEl = document.getElementById('sub-modal-status');

    confirmEl.disabled = true;
    confirmEl.textContent = 'Processing...';
    statusEl.textContent = 'Connecting wallet...';
    statusEl.className = 'sub-modal-status processing';

    var authPromise;
    if (!Wallet.isConnected() || !ElacityAPI.isAuthenticated()) {
      authPromise = handleAuth().then(function () {
        if (!ElacityAPI.isAuthenticated()) throw new Error('Authentication required');
      });
    } else {
      authPromise = Promise.resolve();
    }

    authPromise
      .then(function () {
        statusEl.textContent = 'Switching to Base chain...';
        return Wallet.switchToBase ? Wallet.switchToBase() : Promise.resolve();
      })
      .then(function () {
        if (typeof ethers === 'undefined') throw new Error('Ethers library not loaded');
        var provider = new ethers.BrowserProvider(window.ethereum);
        return provider.getSigner();
      })
      .then(function (signer) {
        var channelContract = new ethers.Contract(channel.address, SUBSCRIPTION_ABI, signer);
        var isNativeToken = !plan.payToken || plan.payToken === ADDRESS_ZERO;

        if (isNativeToken) {
          statusEl.textContent = 'Confirm transaction in your wallet...';
          var value = ethers.parseEther(String(plan.price));
          return channelContract.subscribePlan(plan.planId, false, { value: value });
        }

        statusEl.textContent = 'Checking token allowance...';
        var tokenContract = new ethers.Contract(plan.payToken, ERC20_ABI, signer);

        return tokenContract.decimals()
          .then(function (decimals) {
            var amount = ethers.parseUnits(String(plan.price), Number(decimals));
            return signer.getAddress().then(function (account) {
              return channelContract.paymentProcessor()
                .catch(function () { return channel.address; })
                .then(function (operator) {
                  return tokenContract.allowance(account, operator).then(function (currentAllowance) {
                    if (currentAllowance < amount) {
                      statusEl.textContent = 'Approve token spending...';
                      return tokenContract.approve(operator, amount).then(function (tx) {
                        statusEl.textContent = 'Waiting for approval confirmation...';
                        return tx.wait();
                      });
                    }
                  }).then(function () {
                    statusEl.textContent = 'Confirm subscription in your wallet...';
                    return channelContract.subscribePlan(plan.planId, false);
                  });
                });
            });
          });
      })
      .then(function (tx) {
        statusEl.textContent = 'Waiting for confirmation...';
        return tx.wait();
      })
      .then(function () {
        statusEl.textContent = '';
        closeSubscribeModal();
        dom.subscribeBtn.classList.add('subscribed');
        dom.subscribeBtn.textContent = 'Subscribed';
        addLocalSubscription(channel);
        showToast('Subscribed to ' + (channel.name || 'channel') + '!', 'success');
      })
      .catch(function (err) {
        var msg = err.reason || err.message || 'Transaction failed';
        if (msg.indexOf('user rejected') !== -1 || msg.indexOf('ACTION_REJECTED') !== -1) {
          msg = 'Transaction cancelled';
        }
        statusEl.textContent = msg;
        statusEl.className = 'sub-modal-status error';
        confirmEl.disabled = false;
        confirmEl.textContent = 'Try again';
      });
  }

  function addLocalSubscription(channel) {
    var subs = getLocalSubscriptions();
    var exists = subs.some(function (s) { return s.address.toLowerCase() === channel.address.toLowerCase(); });
    if (!exists) {
      subs.push({
        address: channel.address,
        name: channel.name,
        image: channel.image || channel.imageURL,
        imageURL: channel.imageURL,
        itemsCount: channel.itemsCount
      });
      saveLocalSubscriptions(subs);
    }
  }

  function removeLocalSubscription(channelAddress) {
    var subs = getLocalSubscriptions().filter(function (s) {
      return s.address.toLowerCase() !== channelAddress.toLowerCase();
    });
    saveLocalSubscriptions(subs);
  }

  // ── Subscriptions View ──────────────────────────────

  function renderChannelCard(channel) {
    var card = document.createElement('div');
    card.className = 'subscription-card';

    var avatarUrl = resolveIpfsUrl(channel.imageURL || '');
    var initial = (channel.name || '?').charAt(0).toUpperCase();

    var creatorName = '';
    if (channel.creator) {
      creatorName = (channel.creator.did && channel.creator.did.credentials && channel.creator.did.credentials.name) ||
        channel.creator.alias || formatAddress(channel.creator.address || '');
    }

    card.innerHTML =
      '<div class="sub-avatar">' +
        (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="" onerror="this.style.display=\'none\';this.parentNode.textContent=\'' + initial + '\'" />' : initial) +
      '</div>' +
      '<div class="sub-info">' +
        '<div class="sub-name">' + escapeHtml(channel.name || 'Unknown Channel') + '</div>' +
        '<div class="sub-meta">' + (channel.itemsCount || 0) + ' items' +
          (creatorName ? ' \u00B7 ' + escapeHtml(creatorName) : '') +
        '</div>' +
      '</div>';

    card.addEventListener('click', function () {
      openChannel(channel.address);
    });

    return card;
  }

  function syncSubscriptionsFromAPI() {
    var addr = Wallet.getSignerAddress();
    if (!addr || !ElacityAPI.isAuthenticated()) return;

    ElacityAPI.fetchSubscriptions(addr).then(function (apiSubs) {
      if (!apiSubs || apiSubs.length === 0) return;
      var local = getLocalSubscriptions();
      var localAddrs = {};
      local.forEach(function (s) { localAddrs[s.address.toLowerCase()] = true; });

      var merged = false;
      apiSubs.forEach(function (sub) {
        var ch = sub.channel;
        if (!ch || !ch.address) return;
        if (!localAddrs[ch.address.toLowerCase()]) {
          local.push({
            address: ch.address,
            name: ch.name,
            image: ch.image || ch.imageURL,
            imageURL: ch.imageURL,
            itemsCount: ch.itemsCount
          });
          merged = true;
        }
      });

      if (merged) saveLocalSubscriptions(local);
    });
  }

  function renderSubscriptionsView() {
    var subs = getLocalSubscriptions();

    dom.subsGrid.innerHTML = '';
    dom.subsLoading.classList.add('hidden');

    if (subs.length === 0) {
      dom.subsEmpty.classList.remove('hidden');
    } else {
      dom.subsEmpty.classList.add('hidden');
      subs.forEach(function (channel) {
        dom.subsGrid.appendChild(renderChannelCard(channel));
      });
    }
  }

  // ── Channels Directory ─────────────────────────────

  function loadChannelsDirectory() {
    if (state.channelsDirLoaded) {
      renderChannelsDirectory();
      return;
    }

    dom.channelsDirGrid.innerHTML = '';
    dom.channelsDirList.innerHTML = '';
    dom.channelsDirEmpty.classList.add('hidden');
    dom.channelsDirLoading.classList.remove('hidden');

    ElacityAPI.fetchChannels(0, 50)
      .then(function (result) {
        dom.channelsDirLoading.classList.add('hidden');

        if (!result || !result.data || result.data.length === 0) {
          dom.channelsDirEmpty.classList.remove('hidden');
          return;
        }

        state.channelsDirData = result.data;
        state.channelsDirLoaded = true;
        renderChannelsDirectory();
      })
      .catch(function (err) {
        dom.channelsDirLoading.classList.add('hidden');
        showToast('Failed to load channels: ' + err.message, 'error');
      });
  }

  function getFilteredChannels() {
    if (state.channelsDirCategory === 'all') return state.channelsDirData;
    return state.channelsDirData.filter(function (ch) {
      return ch.categories && ch.categories.indexOf(state.channelsDirCategory) !== -1;
    });
  }

  function getOwnerName(ch) {
    if (!ch.creator) return '';
    var c = ch.creator;
    return (c.did && c.did.credentials && c.did.credentials.name) || c.alias || formatAddress(c.address || '');
  }

  function getOwnerAvatar(ch) {
    if (ch.creator) {
      var c = ch.creator;
      var didThumb = c.did && c.did.credentials && c.did.credentials.avatar && c.did.credentials.avatar.thumbnail;
      if (didThumb && resolveIpfsUrl(didThumb)) return resolveIpfsUrl(didThumb);
      if (c.avatar && resolveIpfsUrl(c.avatar)) return resolveIpfsUrl(c.avatar);
    }
    if (ch.image && resolveIpfsUrl(ch.image)) return resolveIpfsUrl(ch.image);
    if (ch.imageURL && resolveIpfsUrl(ch.imageURL)) return resolveIpfsUrl(ch.imageURL);
    return '';
  }

  function getEntryPrice(ch) {
    var floor = ch.statistics && ch.statistics.floor;
    if (!floor || !floor.price) return null;
    if (floor.price <= 0) return null;
    var symbol = getTokenSymbol(floor.paymentToken);
    var formatted = floor.price < 0.01 ? floor.price.toExponential(2) : floor.price.toFixed(2);
    return formatted + ' ' + symbol;
  }

  function renderChannelsDirectory() {
    var channels = getFilteredChannels();
    if (state.channelsDirViewMode === 'grid') {
      renderChannelsGridView(channels);
      dom.channelsDirGrid.classList.remove('hidden');
      dom.channelsDirList.classList.add('hidden');
    } else {
      renderChannelsListView(channels);
      dom.channelsDirList.classList.remove('hidden');
      dom.channelsDirGrid.classList.add('hidden');
    }
  }

  function renderChannelsGridView(channels) {
    dom.channelsDirGrid.innerHTML = '';

    if (channels.length === 0) {
      dom.channelsDirEmpty.classList.remove('hidden');
      return;
    }
    dom.channelsDirEmpty.classList.add('hidden');

    channels.forEach(function (ch) {
      var card = document.createElement('div');
      card.className = 'dir-card';

      var coverUrl = resolveIpfsUrl(ch.coverImage || ch.coverImageURL || ch.image || ch.imageURL || '');
      var avatarUrl = getOwnerAvatar(ch);
      var ownerName = escapeHtml(getOwnerName(ch));
      var ownerInitial = (ownerName || '?').charAt(0).toUpperCase();
      var subs = (ch.statistics && ch.statistics.subscribers) || 0;
      var category = (ch.categories && ch.categories[0]) || '';
      var entry = getEntryPrice(ch);

      card.innerHTML =
        '<div class="dir-card-cover">' +
          (coverUrl ? '<img src="' + escapeHtml(coverUrl) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'" />' : '') +
          '<span class="dir-subs-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg> ' + subs + '</span>' +
          (category ? '<span class="dir-cat-badge">' + escapeHtml(category) + '</span>' : '') +
        '</div>' +
        '<div class="dir-card-body">' +
          '<div class="dir-card-avatar">' +
            (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="" onerror="this.style.display=\'none\';this.parentNode.textContent=\'' + ownerInitial + '\'" />' : ownerInitial) +
          '</div>' +
          '<div class="dir-card-info">' +
            '<div class="dir-card-name">' + escapeHtml(ch.name || 'Untitled') + '</div>' +
            '<div class="dir-card-meta">' + (ch.itemsCount || 0) + ' items' +
              (ownerName ? ' \u00B7 by ' + ownerName : '') +
            '</div>' +
          '</div>' +
          (entry ? '<div class="dir-card-entry">' + entry + '</div>' : '') +
        '</div>';

      card.addEventListener('click', function () {
        openChannel(ch.address);
      });

      dom.channelsDirGrid.appendChild(card);
    });
  }

  function renderChannelsListView(channels) {
    dom.channelsDirList.innerHTML = '';

    if (channels.length === 0) {
      dom.channelsDirEmpty.classList.remove('hidden');
      return;
    }
    dom.channelsDirEmpty.classList.add('hidden');

    var header = document.createElement('div');
    header.className = 'dir-list-header';
    header.innerHTML = '<div>Name</div><div>Owner</div><div>Items</div><div>Subs</div><div>Entry</div><div></div>';
    dom.channelsDirList.appendChild(header);

    channels.forEach(function (ch) {
      var row = document.createElement('div');
      row.className = 'dir-list-row';

      var imgUrl = resolveIpfsUrl(ch.image || ch.imageURL || '');
      var ownerName = escapeHtml(getOwnerName(ch));
      var subs = (ch.statistics && ch.statistics.subscribers) || 0;
      var category = (ch.categories && ch.categories[0]) || '';
      var entry = getEntryPrice(ch);

      row.innerHTML =
        '<div class="dir-list-name">' +
          (imgUrl ? '<img src="' + escapeHtml(imgUrl) + '" alt="" onerror="this.style.display=\'none\'" />' : '<div style="width:36px;height:36px;border-radius:8px;background:var(--bg-surface);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:var(--accent)">' + (ch.name || '?').charAt(0).toUpperCase() + '</div>') +
          '<div class="dir-list-name-text"><strong>' + escapeHtml(ch.name || 'Untitled') + '</strong>' +
            (category ? '<small>' + escapeHtml(category) + '</small>' : '') +
          '</div>' +
        '</div>' +
        '<div class="dir-list-owner">' + ownerName + '</div>' +
        '<div class="dir-list-cell">' + (ch.itemsCount || 0) + '</div>' +
        '<div class="dir-list-cell">' + subs + '</div>' +
        '<div class="dir-list-entry' + (entry ? ' has-entry' : '') + '">' + (entry || 'Free') + '</div>' +
        '<div class="dir-list-action"><button class="dir-sub-btn" data-address="' + escapeHtml(ch.address) + '">View</button></div>';

      row.addEventListener('click', function () {
        openChannel(ch.address);
      });

      dom.channelsDirList.appendChild(row);
    });
  }

  // ── Detail Interactions (Save + Like) ────────────────

  function loadDetailInteractions(contractAddress, tokenId) {
    var signerAddr = ElacityAPI.getSignerAddress() || Wallet.getSignerAddress();

    ElacityAPI.fetchLikesByToken(contractAddress, tokenId, signerAddr || null)
      .then(function (likes) {
        state.detailLikes = likes;
        dom.likeCount.textContent = likes.count > 0 ? likes.count : '';
        if (likes.isAmong) dom.likeBtn.classList.add('liked');
      })
      .catch(function () {});

    if (ElacityAPI.isAuthenticated()) {
      ElacityAPI.isSavedToLater(contractAddress, tokenId)
        .then(function (saved) {
          state.detailSaved = saved;
          if (saved) {
            dom.saveBtn.classList.add('saved');
            dom.saveLabel.textContent = 'Saved';
          }
        })
        .catch(function () {});
    }
  }

  function handleSave() {
    if (!ElacityAPI.isAuthenticated()) {
      showToast('Please connect your wallet first', 'error');
      return;
    }

    var contractAddress = state.detailContractAddress;
    var tokenId = state.detailTokenId;
    if (!contractAddress || !tokenId) return;

    dom.saveBtn.disabled = true;

    var ensurePlaylist = state.watchLaterPlaylistId
      ? Promise.resolve(state.watchLaterPlaylistId)
      : ElacityAPI.getUserPlaylist().then(function (playlists) {
          if (playlists && playlists.length > 0) {
            state.watchLaterPlaylistId = playlists[0]._id;
            return playlists[0]._id;
          }
          return null;
        });

    ensurePlaylist
      .then(function (playlistId) {
        if (!playlistId) {
          showToast('Could not find your watch later playlist', 'error');
          return;
        }

        if (state.detailSaved) {
          return ElacityAPI.removePlaylistItem(playlistId, contractAddress, tokenId)
            .then(function () {
              state.detailSaved = false;
              dom.saveBtn.classList.remove('saved');
              dom.saveLabel.textContent = 'Save';
              showToast('Removed from Watch Later', 'success');
            });
        } else {
          return ElacityAPI.addPlaylistItem(playlistId, contractAddress, tokenId)
            .then(function () {
              state.detailSaved = true;
              dom.saveBtn.classList.add('saved');
              dom.saveLabel.textContent = 'Saved';
              showToast('Added to Watch Later', 'success');
            });
        }
      })
      .catch(function (err) {
        showToast('Save failed: ' + err.message, 'error');
      })
      .finally(function () {
        dom.saveBtn.disabled = false;
      });
  }

  function handleLike() {
    if (!ElacityAPI.isAuthenticated()) {
      showToast('Please connect your wallet first', 'error');
      return;
    }

    var contractAddress = state.detailContractAddress;
    var tokenId = state.detailTokenId;
    if (!contractAddress || !tokenId) return;

    dom.likeBtn.disabled = true;

    ElacityAPI.toggleLike(contractAddress, tokenId)
      .then(function () {
        var wasLiked = dom.likeBtn.classList.contains('liked');
        if (wasLiked) {
          dom.likeBtn.classList.remove('liked');
          if (state.detailLikes) state.detailLikes.count = Math.max(0, state.detailLikes.count - 1);
        } else {
          dom.likeBtn.classList.add('liked');
          if (state.detailLikes) state.detailLikes.count = (state.detailLikes.count || 0) + 1;
        }
        dom.likeCount.textContent = (state.detailLikes && state.detailLikes.count > 0) ? state.detailLikes.count : '';
      })
      .catch(function (err) {
        showToast('Like failed: ' + err.message, 'error');
      })
      .finally(function () {
        dom.likeBtn.disabled = false;
      });
  }

  // ── Watch Later View ───────────────────────────────

  function loadWatchLater() {
    if (!ElacityAPI.isAuthenticated()) {
      dom.watchlaterGrid.innerHTML = '';
      dom.watchlaterLoading.classList.add('hidden');
      dom.watchlaterEmpty.classList.remove('hidden');
      return;
    }

    if (state.watchLaterLoading) return;
    state.watchLaterLoading = true;

    dom.watchlaterGrid.innerHTML = '';
    dom.watchlaterEmpty.classList.add('hidden');
    dom.watchlaterLoading.classList.remove('hidden');

    ElacityAPI.getUserPlaylist()
      .then(function (playlists) {
        if (!playlists || playlists.length === 0) {
          state.watchLaterLoading = false;
          dom.watchlaterLoading.classList.add('hidden');
          dom.watchlaterEmpty.classList.remove('hidden');
          return;
        }

        var playlist = playlists[0];
        state.watchLaterPlaylistId = playlist._id;

        if (!playlist.contents || playlist.contents.length === 0) {
          state.watchLaterLoading = false;
          dom.watchlaterLoading.classList.add('hidden');
          dom.watchlaterEmpty.classList.remove('hidden');
          return;
        }

        var MAX_RESOLVE = 20;
        var toResolve = playlist.contents.slice(0, MAX_RESOLVE);
        var fetches = toResolve.map(function (item) {
          return ElacityAPI.getAssetDetail(item.contractAddress, item.tokenId)
            .catch(function () { return null; });
        });

        return Promise.all(fetches).then(function (results) {
          state.watchLaterLoading = false;
          dom.watchlaterLoading.classList.add('hidden');

          var validItems = results.filter(function (r) { return r !== null; });

          if (validItems.length === 0) {
            dom.watchlaterEmpty.classList.remove('hidden');
            return;
          }

          state.watchLaterItems = validItems;

          validItems.forEach(function (nft) {
            var cardItem = {
              contractAddress: nft.channel ? nft.channel.address : '',
              hexTokenID: (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '',
              tokenID: (nft.tokenId && nft.tokenId.tokenID) || '',
              name: nft.name || (nft.metadata && nft.metadata.name) || 'Untitled',
              imageURL: nft.image || (nft.metadata && nft.metadata.media && nft.metadata.media.previewURL) || '',
              channel: nft.channel,
              owner: null,
              views: nft.views,
              price: null,
              paymentToken: null,
              metadata: nft.metadata,
              operative: nft.operative
            };
            dom.watchlaterGrid.appendChild(renderCard(cardItem));
          });
        });
      })
      .catch(function (err) {
        state.watchLaterLoading = false;
        dom.watchlaterLoading.classList.add('hidden');
        showToast('Failed to load watch later: ' + err.message, 'error');
      });
  }

  // ── Preview Flow ─────────────────────────────────────

  function handlePreview() {
    var nft = state.detailItem;
    if (!nft) return;
    var media = (nft.metadata && nft.metadata.media) || {};
    var previewUrl = media.previewURL ? resolveIpfsUrl(media.previewURL) : '';
    if (!previewUrl) return;

    var contentType = media.contentType || '';

    dom.detailImage.style.display = 'none';
    dom.previewPlayer.classList.remove('hidden');

    if (contentType.indexOf('audio') !== -1) {
      dom.previewPlayer.innerHTML = '<audio controls autoplay src="' + escapeHtml(previewUrl) + '"></audio>';
    } else {
      dom.previewPlayer.innerHTML = '<video controls autoplay src="' + escapeHtml(previewUrl) + '"></video>';
    }

    dom.previewBtn.classList.add('hidden');
  }

  // ── Play Flow ────────────────────────────────────────

  function handlePlay() {
    var nft = state.detailItem;
    if (!nft) return;

    var channel = nft.channel && nft.channel.address;
    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || '';

    if (!channel || !tokenId) {
      showToast('Missing content identity for playback', 'error');
      return;
    }

    var meta = nft.metadata || {};
    var media = meta.media || {};
    var props = meta.properties || {};
    var title = meta.name || nft.name || 'Untitled';
    var mediaUri = (media.uri || '').replace('ipfs://', '');
    var tokenURI = (nft.tokenURI || '').replace('ipfs://', '');
    var walletAddr = Wallet.getAddress() || '';

    if (!walletAddr) {
      showToast('Please connect your wallet first', 'error');
      return;
    }

    var checksumAddr = ethers.getAddress(walletAddr);
    showToast('Preparing Lit authentication...', 'info');

    // Phase 1: Ask the server to start a Lit session and return the SIWE message
    prepareLitAuth(checksumAddr).then(function (prepareResult) {

      // Chipotle mode: server returns siweMessage=null, no signing needed
      var authSigPromise;
      if (prepareResult.chipotleMode || !prepareResult.siweMessage) {
        authSigPromise = Promise.resolve({
          sig: '0x',
          derivedVia: 'chipotle-api-key',
          signedMessage: '',
          address: checksumAddr
        });
      } else {
        showToast('Please sign the Lit authentication message...', 'info');
        authSigPromise = Wallet.signMessage(prepareResult.siweMessage).then(function (sig) {
          return {
            sig: sig,
            derivedVia: 'web3.eth.personal.sign',
            signedMessage: prepareResult.siweMessage,
            address: checksumAddr
          };
        });
      }

      return authSigPromise.then(function (authSig) {
        window.parent.postMessage({
          msg: 'launchApp',
          appName: 'pc2-media-runtime',
          windowTitle: title + ' — PC2 Media Player',
          args: {
            channel: channel,
            tokenId: tokenId,
            mediaUri: mediaUri,
            tokenURI: tokenURI,
            title: title,
            authority: props.authority || '',
            buyerAddress: checksumAddr,
            requestId: prepareResult.requestId,
            litAuthSig: authSig,
            thumbnail: (function() {
              var url = resolveIpfsUrl(nft.image || '') || resolveIpfsUrl((meta.media || {}).previewURL || '') || getImageUrl(nft);
              console.log('[handlePlay] thumbnail URL:', url);
              return url;
            })()
          }
        }, '*');
      });
    }).catch(function (err) {
      console.error('[Play] Auth flow failed:', err);
      showToast('Playback auth failed: ' + (err.message || err), 'error');
    });
  }

  function prepareLitAuth(buyerAddress) {
    return pc2Fetch('/api/media/prepare-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyerAddress: buyerAddress })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (err) {
          throw new Error(err.error || 'prepare-auth failed');
        });
      }
      return res.json();
    });
  }

  // ── Purchase Flow ────────────────────────────────────

  function handleBuy() {
    var nft = state.detailItem;
    if (!nft || state.purchasing) return;

    var listing = getListing(nft);
    if (!listing) {
      showToast('No listing available', 'error');
      return;
    }

    state.purchasing = true;
    dom.buyBtn.disabled = true;
    setPurchaseStatus('pending', 'Connecting wallet...');

    var ensureConnected = Wallet.isConnected()
      ? Promise.resolve()
      : Wallet.connect().then(function () { updateWalletUI(); });

    ensureConnected
      .then(function () {
        setPurchaseStatus('pending', 'Switching to Base chain...');
        return Wallet.switchToBase ? Wallet.switchToBase() : Promise.resolve();
      })
      .then(function () {
        var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';
        var meta = nft.metadata || {};
        var props = meta.properties || {};
        var authorityAddr = props.authority;
        var ledger = props.ledger || nft.contractAddress || (nft.channel && nft.channel.address);

        if (!authorityAddr) {
          throw new Error('No AuthorityGateway address found for this asset');
        }

        setPurchaseStatus('pending', 'Confirm transaction in your wallet...');
        return Wallet.buyAccess(
          authorityAddr,
          listing.seller,
          ledger,
          tokenId,
          1,
          String(listing.price),
          listing.payToken,
          nft.operative ? nft.operative.address : null
        );
      })
      .then(function (txHashOrReceipt) {
        if (txHashOrReceipt && txHashOrReceipt._smartAccountConfirmed) {
          return txHashOrReceipt;
        }
        setPurchaseStatus('pending', 'Transaction submitted. Waiting for confirmation...');
        return Wallet.waitForReceipt(txHashOrReceipt);
      })
      .then(function (receipt) {
        var success = receipt && (receipt.status === '0x1' || receipt.status === 1);
        if (success) {
          setPurchaseStatus('success', 'Purchase successful! Saving to your node...');
          dom.detailPriceSection.classList.add('hidden');
          dom.playBtn.classList.add('hidden');
          dom.detailOwned.classList.remove('hidden');
          dom.playOwnedBtn.classList.remove('hidden');
          showToast('Purchase complete! Auto-downloading...', 'success');
          state.detailIsOwned = true;
          pinAndRegisterMedia(nft);

          // Invalidate library cache so next visit re-fetches from backend.
          // Retry after delays to account for Elacity GraphQL indexing lag.
          state.assetsItems = [];
          state.assetsLoading = false;
          setTimeout(function () { state.assetsItems = []; }, 8000);
          setTimeout(function () { state.assetsItems = []; }, 20000);
        } else {
          setPurchaseStatus('error', 'Transaction failed. Please try again.');
        }
        state.purchasing = false;
        dom.buyBtn.disabled = false;
      })
      .catch(function (err) {
        state.purchasing = false;
        dom.buyBtn.disabled = false;
        var msg = err.message || String(err);
        if (msg.indexOf('user rejected') !== -1 || msg.indexOf('User denied') !== -1) {
          setPurchaseStatus('error', 'Transaction cancelled by user.');
        } else {
          setPurchaseStatus('error', 'Purchase failed: ' + msg);
        }
      });
  }

  function setPurchaseStatus(type, message) {
    dom.purchaseStatus.className = 'purchase-status ' + type;
    dom.purchaseStatus.textContent = message;
    dom.purchaseStatus.classList.remove('hidden');
  }

  // ── Auto Pin & Register as .edrm / .ddrm.json ───────

  function buildDdrmCapsule(nft) {
    var meta = nft.metadata || {};
    var props = meta.properties || {};
    var media = meta.media || nft._rawMedia || {};
    var asset = nft._rawAsset || meta.asset || {};
    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';
    var title = meta.name || nft.name || 'Untitled';
    var cid = asset.cid || asset.uri || media.uri || '';
    if (cid) cid = cid.replace('ipfs://', '');
    var dataToEncryptHash = asset.dataToEncryptHash || '';
    var cleanHash = dataToEncryptHash.startsWith('0x') ? dataToEncryptHash.slice(2) : dataToEncryptHash;
    var kid = cleanHash ? '0x' + cleanHash.slice(0, 32).padEnd(32, '0') : '';
    var mime = asset.mimeType || media.contentType || media.mimeType || 'application/octet-stream';

    return {
      version: 1,
      schema: 'ddrm-capsule-v1',
      title: title,
      encryptedDataCid: cid,
      mimeType: mime,
      dataToEncryptHash: dataToEncryptHash,
      kid: kid,
      litCiphertext: asset.litCiphertext || '',
      iv: asset.iv || '',
      actionCid: asset.actionCid || '',
      authority: asset.authority || props.authority || '',
      contractAddress: nft.contractAddress || (nft.channel && nft.channel.address) || '',
      ledger: props.ledger || nft.contractAddress || '',
      tokenId: tokenId,
      operative: (nft.operative && nft.operative.address) || '',
      thumbnail: meta.image || (nft.channel && nft.channel.image) || '',
      acquiredAt: new Date().toISOString(),
      acquiredBy: Wallet.getAddress() || '',
    };
  }

  function saveDdrmCapsule(nft, folderPath) {
    var capsule = buildDdrmCapsule(nft);
    if (!capsule.encryptedDataCid || !capsule.kid) return Promise.resolve();

    var safeName = capsule.title.replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 80).trim() || 'asset';
    var capsulePath = folderPath + '/' + safeName + '.ddrm.json';

    return pc2Fetch('/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: capsulePath,
        content: JSON.stringify(capsule, null, 2),
        mime_type: 'application/x-ddrm+json',
        overwrite: false,
        dedupe_name: true,
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('Capsule save failed: ' + res.status);
      console.log('[dDRM] Capsule saved:', capsulePath);
      return res.json();
    });
  }

  function pinAndRegisterMedia(nft) {
    var media = (nft.metadata && nft.metadata.media) || {};
    var asset = nft._rawAsset || (nft.metadata && nft.metadata.asset) || {};
    var cid = asset.cid || asset.uri || media.uri;
    if (cid) cid = cid.replace('ipfs://', '');

    if (!cid) {
      dom.downloadStatus.className = 'download-status error';
      dom.downloadStatus.textContent = 'No downloadable content found for this asset.';
      dom.downloadStatus.classList.remove('hidden');
      return;
    }

    dom.downloadNodeBtn.disabled = true;
    dom.downloadNodeBtn.querySelector('span').textContent = 'Saving...';
    dom.downloadStatus.className = 'download-status pending';
    dom.downloadStatus.innerHTML = '<div class="download-progress-wrap"><div class="download-progress-bar"><div class="download-progress-fill"></div></div><span class="download-progress-text">Saving to your personal cloud...</span></div>';
    dom.downloadStatus.classList.remove('hidden');

    var progressFill = dom.downloadStatus.querySelector('.download-progress-fill');
    var progressText = dom.downloadStatus.querySelector('.download-progress-text');

    var meta = nft.metadata || {};
    var props = meta.properties || {};
    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';
    var title = meta.name || nft.name || 'Untitled';
    var safeName = title.replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 80).trim() || 'media';
    var walletAddr = Wallet.getAddress() || '';
    var nonMedia = isNonMediaAsset(nft);
    var assetMime = (asset.mimeType || media.contentType || '').toLowerCase();
    var folder = nonMedia
      ? (assetMime.startsWith('image/') ? 'Pictures' : 'Documents')
      : 'Videos';
    var ext = nonMedia ? '.ddrm.json' : '.edrm';
    var savePath = '/' + walletAddr + '/' + folder + '/' + safeName + ext;

    var localGateway = window.location.origin + '/ipfs/';
    var descriptor = nonMedia ? buildDdrmCapsule(nft) : {
      version: 1,
      title: title,
      cid: cid,
      gateway: localGateway,
      fallbackGateway: 'https://ipfs.ela.city/ipfs/',
      contractAddress: nft.contractAddress || (nft.channel && nft.channel.address) || '',
      tokenId: tokenId,
      authority: props.authority || '',
      operative: (nft.operative && nft.operative.address) || '',
      ledger: props.ledger || nft.contractAddress || '',
      thumbnail: meta.image || (nft.channel && nft.channel.image) || '',
      mediaType: media.mimeType || media.contentType || 'video',
      duration: media.duration || 0,
      isProtected: !!(nft.isProtected || (media.protectionType && media.protectionType !== 'none')),
      acquiredAt: new Date().toISOString()
    };

    progressFill.style.width = '10%';
    progressText.textContent = 'Downloading content from Elacity network...';

    var progressVal = 10;
    var progressTimer = setInterval(function () {
      if (progressVal < 90) {
        progressVal += (90 - progressVal) * 0.02;
        progressFill.style.width = Math.round(progressVal) + '%';
      }
    }, 800);

    pc2Fetch('/api/storage/ipfs/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: cid })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Download failed: ' + res.status);
        return res.json();
      })
      .then(function (pinResult) {
        clearInterval(progressTimer);
        progressVal = 90;
        progressFill.style.width = '90%';
        progressText.textContent = 'Saving to your ' + folder + ' folder...';

        descriptor.pinned = !!(pinResult && pinResult.success);
        descriptor.pinnedSize = (pinResult && pinResult.totalSize) || 0;
        descriptor.blockCount = (pinResult && pinResult.blockCount) || 0;

        var descriptorMime = nonMedia ? 'application/x-ddrm+json' : 'application/x-edrm';
        return pc2Fetch('/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: savePath,
            content: JSON.stringify(descriptor, null, 2),
            mime_type: descriptorMime,
            overwrite: false,
            dedupe_name: true
          })
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error('Save failed: ' + res.status);
        return res.json();
      })
      .then(function (writeResult) {
        clearInterval(progressTimer);
        progressFill.style.width = '100%';
        progressText.textContent = '';
        dom.downloadNodeBtn.querySelector('span').textContent = 'Saved';
        dom.downloadNodeBtn.disabled = true;
        dom.downloadStatus.className = 'download-status success';
        dom.downloadStatus.innerHTML = 'Downloaded & saved — you\'re now a seeder! <a href="#" class="open-folder-link">Open ' + folder + ' folder</a>';
        showToast('Content downloaded to your node!', 'success');

        var folderLink = dom.downloadStatus.querySelector('.open-folder-link');
        if (folderLink) {
          folderLink.addEventListener('click', function (e) {
            e.preventDefault();
            var appInstanceId = new URLSearchParams(window.location.search).get('puter.app_instance_id') || '';
            window.parent.postMessage({
              $: 'puter-ipc',
              msg: 'openFolder',
              path: '/' + walletAddr + '/' + folder,
              appInstanceID: appInstanceId,
              env: 'app'
            }, '*');
          });
        }
      })
      .catch(function (err) {
        clearInterval(progressTimer);
        console.error('[Download] Failed:', err);
        dom.downloadNodeBtn.querySelector('span').textContent = 'Save to Cloud';
        dom.downloadNodeBtn.disabled = false;
        progressFill.style.width = '0%';
        dom.downloadStatus.className = 'download-status error';
        dom.downloadStatus.textContent = 'Download failed: ' + (err.message || 'Unknown error') + '. Tap to retry.';
      });
  }

  // ── Download to Node (manual fallback) ─────────────

  function handleDownloadToNode() {
    var nft = state.detailItem;
    if (!nft) return;
    pinAndRegisterMedia(nft);
  }

  // ── Open in dDRM Viewer (secure runtime) ──

  function handleOpenInViewer() {
    var nft = state.detailItem;
    if (!nft) return;

    if (!Wallet.isConnected()) {
      showToast('Connect your wallet first', 'error');
      return;
    }

    ensureRawMetadata(nft).then(function () {
      launchViewerPopup(nft);
    }).catch(function () {
      launchViewerPopup(nft);
    });
  }

  function launchViewerPopup(nft) {
    var media = (nft.metadata && nft.metadata.media) || nft._rawMedia || {};
    var asset = nft._rawAsset || (nft.metadata && nft.metadata.asset) || {};
    var meta = nft.metadata || {};
    var props = meta.properties || {};
    var enc = asset.encryption || media.encryption || meta.encryption || {};

    var cid = asset.cid || asset.uri || media.uri || enc.encryptedDataCid;
    if (cid) cid = cid.replace('ipfs://', '');

    var dataToEncryptHash = asset.dataToEncryptHash || enc.dataToEncryptHash || enc.hash || '';
    var cleanHash = dataToEncryptHash.startsWith('0x') ? dataToEncryptHash.slice(2) : dataToEncryptHash;
    var kid = cleanHash ? ('0x' + cleanHash.slice(0, 32).padEnd(32, '0')) : '';

    var mime = asset.mimeType || media.contentType || media.mimeType || 'application/octet-stream';
    var buyerAddr = Wallet.getAddress() || '';

    var litCiphertext = asset.litCiphertext || enc.litCiphertext || enc.ciphertext || '';
    var iv = asset.iv || enc.iv || '';
    var actionCid = asset.actionCid || enc.actionCid || enc.actionIpfsId || '';
    var authority = asset.authority || enc.authority || props.authority || '';
    var title = meta.name || nft.name || 'Untitled';

    if (!cid || !kid || !litCiphertext) {
      var missing = [];
      if (!cid) missing.push('cid');
      if (!kid) missing.push('kid (dataToEncryptHash)');
      if (!litCiphertext) missing.push('litCiphertext');
      console.error('[Viewer] Missing fields:', missing.join(', '), {
        tokenURI: nft.tokenURI,
        hasRawAsset: !!nft._rawAsset,
        assetKeys: Object.keys(asset),
        encKeys: Object.keys(enc),
        mediaKeys: Object.keys(media),
      });
      showToast('Missing asset metadata for viewer (' + missing.join(', ') + '). Try refreshing the page.', 'error');
      return;
    }

    var viewerArgs = {
      litCiphertext: litCiphertext,
      dataToEncryptHash: dataToEncryptHash,
      encryptedDataCid: cid,
      iv: iv,
      kid: kid,
      buyerAddress: buyerAddr,
      mimeType: mime,
      title: title,
    };
    if (actionCid) viewerArgs.actionCid = actionCid;
    if (authority) viewerArgs.authority = authority;
    var litBackend = asset.litBackend || enc.litBackend || '';
    if (litBackend) viewerArgs.litBackend = litBackend;
    if (authority) viewerArgs.authority = authority;

    window.parent.postMessage({
      $: 'puter-ipc',
      msg: 'launchApp',
      appName: 'ddrm-viewer',
      windowTitle: title + ' — dDRM Viewer',
      args: viewerArgs,
    }, '*');
  }

  function fetchRawMetadataLocalFirst(tokenURI) {
    var cid = tokenURI.replace('ipfs://', '');
    var localUrl = window.location.origin + '/ipfs/' + cid;
    var publicUrl = resolveIpfsUrl(tokenURI);

    return fetch(localUrl)
      .then(function (r) {
        if (r.ok) return r;
        console.warn('[Meta] Local IPFS failed (' + r.status + '), trying public gateway');
        return fetch(publicUrl);
      })
      .catch(function () {
        console.warn('[Meta] Local IPFS unreachable, trying public gateway');
        return fetch(publicUrl);
      })
      .then(function (r) {
        if (!r.ok) throw new Error('IPFS fetch failed from both gateways: ' + r.status);
        return r.json();
      });
  }

  function ensureRawMetadata(nft) {
    if (nft._rawAsset && nft._rawAsset.dataToEncryptHash) {
      return Promise.resolve();
    }
    var tokenURI = nft.tokenURI || '';
    if (!tokenURI) return Promise.resolve();

    return fetchRawMetadataLocalFirst(tokenURI)
      .then(function (rawMeta) {
        if (rawMeta && rawMeta.asset) {
          nft._rawAsset = rawMeta.asset;
          nft._rawMedia = rawMeta.media;
          console.log('[Meta] Raw metadata loaded, asset CID:', rawMeta.asset.cid);
        }
      });
  }

  // ── Wallet UI ────────────────────────────────────────

  function updateWalletUI() {
    var address = Wallet.getSignerAddress();
    dom.networkBadge.classList.remove('hidden');
    dom.networkBadge.textContent = 'BASE';
    if (address) {
      dom.walletBtn.textContent = formatAddress(address);
      dom.walletBtn.classList.add('connected');
    } else {
      dom.walletBtn.textContent = 'Connect Wallet';
      dom.walletBtn.classList.remove('connected');
    }
  }

  // ── SIWE Auth Flow ───────────────────────────────────

  function handleAuth() {
    dom.authBtn.disabled = true;
    dom.authBtn.textContent = 'Signing in...';

    return Wallet.siweLogin()
      .then(function () {
        showToast('Authenticated successfully', 'success');
        updateWalletUI();
        syncSubscriptionsFromAPI();
        renderMyAssetsView();
      })
      .catch(function (err) {
        showToast('Auth failed: ' + err.message, 'error');
        throw err;
      })
      .finally(function () {
        dom.authBtn.disabled = false;
        dom.authBtn.textContent = 'Sign In with Wallet';
      });
  }

  // ── Event Binding ────────────────────────────────────

  function bindEvents() {
    dom.sidebarNav.addEventListener('click', function (e) {
      var item = e.target.closest('.nav-item');
      if (!item) return;
      switchView(item.dataset.view);
    });

    dom.walletBtn.addEventListener('click', function () {
      if (Wallet.isConnected()) return;
      Wallet.connect()
        .then(function () { updateWalletUI(); showToast('Wallet connected', 'success'); })
        .catch(function (err) { showToast('Connection failed: ' + err.message, 'error'); });
    });

    dom.categoryTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.filter-tab');
      if (!tab) return;
      document.querySelectorAll('.filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      state.activeCategory = tab.dataset.category;
      loadBrowse(false);
    });

    dom.contentTypeTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.type-tab');
      if (!tab) return;
      dom.contentTypeTabs.querySelectorAll('.type-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      state.activeContentType = tab.dataset.type;
      loadBrowse(false);
    });

    dom.searchTypeTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.type-tab');
      if (!tab) return;
      dom.searchTypeTabs.querySelectorAll('.type-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      state.searchContentType = tab.dataset.type;
      if (state.searchQuery) loadSearch();
    });

    dom.channelsViewToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('.mode-btn');
      if (!btn) return;
      dom.channelsViewToggle.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.channelsDirViewMode = btn.dataset.mode;
      if (state.channelsDirLoaded) renderChannelsDirectory();
    });

    dom.channelCategoryTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.cat-tab');
      if (!tab) return;
      dom.channelCategoryTabs.querySelectorAll('.cat-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      state.channelsDirCategory = tab.dataset.cat;
      if (state.channelsDirLoaded) renderChannelsDirectory();
    });

    dom.searchInput.addEventListener('input', function () {
      clearTimeout(state.searchTimeout);
      state.searchTimeout = setTimeout(function () {
        state.searchQuery = dom.searchInput.value.trim();
        loadSearch();
      }, 500);
    });

    dom.loadMoreBtn.addEventListener('click', function () {
      loadBrowse(true);
    });

    dom.authBtn.addEventListener('click', handleAuth);
    document.getElementById('library-refresh-btn').addEventListener('click', function () {
      if (!ElacityAPI.isAuthenticated()) {
        renderMyAssetsView();
      } else {
        refreshLibrary();
      }
    });
    dom.detailBackBtn.addEventListener('click', goBack);
    dom.channelBackBtn.addEventListener('click', goBack);
    dom.subscribeBtn.addEventListener('click', handleSubscribe);

    document.getElementById('sub-modal-close').addEventListener('click', closeSubscribeModal);
    document.getElementById('sub-modal-confirm').addEventListener('click', executeSubscription);
    document.getElementById('subscribe-modal').addEventListener('click', function (e) {
      if (e.target === this) closeSubscribeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.getElementById('subscribe-modal').classList.contains('hidden')) {
        closeSubscribeModal();
        return;
      }
      if (e.key === 'Escape' && (state.activeView === 'detail' || state.activeView === 'channel')) {
        goBack();
      }
    });

    dom.themeToggle.addEventListener('click', toggleTheme);

    dom.buyBtn.addEventListener('click', handleBuy);
    dom.downloadNodeBtn.addEventListener('click', handleDownloadToNode);
    dom.openViewerBtn.addEventListener('click', handleOpenInViewer);
    dom.previewBtn.addEventListener('click', handlePreview);
    dom.playBtn.addEventListener('click', handlePlay);
    dom.playOwnedBtn.addEventListener('click', handlePlay);
    dom.saveBtn.addEventListener('click', handleSave);
    dom.likeBtn.addEventListener('click', handleLike);

    Wallet.setupListeners({
      onAccountChange: function () {
        updateWalletUI();
        if (state.initializing) return;
        if (state._lastSignedAddress === Wallet.getAddress()) return;
        ElacityAPI.clearAuth();
        state.assetsItems = [];
        state._lastSignedAddress = Wallet.getAddress();
        Wallet.siweLogin()
          .then(function () {
            updateWalletUI();
            if (state.activeView === 'library') renderMyAssetsView();
          })
          .catch(function () {
            if (state.activeView === 'library') renderMyAssetsView();
          });
      },
      onChainChange: function () { updateWalletUI(); }
    });
  }

  // ── Init ─────────────────────────────────────────────

  function init() {
    initTheme();
    cacheDom();
    bindEvents();
    loadBrowse(false);

    Wallet.connect()
      .then(function () {
        updateWalletUI();
        return Wallet.siweLogin();
      })
      .then(function () {
        state.initializing = false;
        state._lastSignedAddress = Wallet.getAddress();
        updateWalletUI();
        syncSubscriptionsFromAPI();
        if (state.activeView === 'library') renderMyAssetsView();
      })
      .catch(function () {
        state.initializing = false;
        updateWalletUI();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
