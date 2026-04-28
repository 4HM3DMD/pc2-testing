/**
 * Elacity Creator Dashboard
 *
 * Encrypt any digital asset with Lit Protocol dDRM and upload to IPFS.
 * Produces CIDs ready for on-chain minting via Elacity Channel contracts.
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────

  var BASE_CHAIN_ID = 8453;
  var BASE_CHAIN_HEX = '0x2105';

  var CONTRACTS = {
    CENTRAL_STORAGE: '0x0C1EeA2A3361B80AC0e42179335dB536A951760b',
    AUTHORITY_GATEWAY: '0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D',
    CHANNEL_FACTORY: '0xE1365ed47353De2F8A6a69E271e36650A9EE368F',
    ROYALTY_TRADE_GATEWAY: '0xd02451BCE627EF476B8ee52Cf131C426f67dbcB2',
    ASSET_FACTORY: '0x4c80A6209F16437f0dc4a98E3D43f08aeBF57765',
    EVENT_HUB: '0x5a694A6d988354dca491fe0F6db7a6ef46b656c2',
  };

  var USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  // V3 contract ABIs (Elacity dDRM V3 on Base)
  var ABI = {
    DIGITAL_ASSET: [
      'function mint(string _uri, uint16 opType, bytes opRawData, bytes sellRawData) payable',
      'function authority() view returns (address)',
      'function totalSupply() view returns (uint256)',
      'event AssetCreated(address indexed _to, address indexed _channel, uint256 _tokenId, string _tokenUri, uint16 _opType, address indexed opContract)',
    ],
    AUTHORITY_GATEWAY: [
      'function operative(address channel, uint256 tokenId) view returns (address)',
    ],
    CENTRAL_STORAGE: [
      'function mediaCreationFee() view returns (uint256 fee, address token)',
      'function channelCreationFee() view returns (uint256 fee, address token)',
    ],
    CHANNEL_FACTORY: [
      'function createChannel(uint8 _channelType, uint8 _scope, string _name, string _tokenURI, bytes data) payable',
      'event ChannelCreated(uint8 indexed channelType, uint8 indexed scope, address indexed creator, address channel, address factoryAddr)',
    ],
    OPERATIVE: [
      'function setApprovalForAll(address operator, bool approved)',
      'function isApprovedForAll(address account, address operator) view returns (bool)',
    ],
    ACCESS_CONTROL: [
      'function grantRole(bytes32 role, address account)',
      'function hasRole(bytes32 role, address account) view returns (bool)',
    ],
  };

  var OP_TYPES = { FREE: 0, BUY_ONCE: 1, BUY_AND_RESELL: 2 };
  var ROLE_ACCESS_TOKEN = 1;
  var ROLE_ROYALTY_SHARE = 2;
  var ROLE_DISTRIBUTION_RIGHT = 3;
  var ELACITY_ROYALTY_ADDRESS = '0x0917Aa260359670F7855a5454c630993ce40C52D';
  var ELACITY_CHANNEL_ROYALTY_ADDRESS = '0xCE4639Aa1E47E400683F49d95025475D5F50192d';
  var ELACITY_ROYALTY_PERCENT = 5;
  var DEFAULT_CHANNEL = '0x2fb53d4ab93112a6c0a1e54ffcd7199c6fd37412';
  var ELACITY_BACKEND = 'https://base.ela.city/api';

  var CHANNEL_SCOPE = { PUBLIC: 1, PRIVATE: 2 };
  var CHANNEL_TYPE = { STANDARD: 1, MULTI: 2 };

  var USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
  var CURRENCIES = [
    { symbol: 'USDC', address: USDC_BASE, decimals: 6 },
    { symbol: 'USDT', address: USDT_BASE, decimals: 6 },
    { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  ];

  var DURATION_OPTIONS = [
    { value: 1, unit: 'days', label: '1 Day', seconds: 86400 },
    { value: 7, unit: 'days', label: '1 Week', seconds: 604800 },
    { value: 1, unit: 'months', label: '1 Month', seconds: 2592000 },
    { value: 3, unit: 'months', label: '3 Months', seconds: 7776000 },
    { value: 6, unit: 'months', label: '6 Months', seconds: 15552000 },
    { value: 12, unit: 'months', label: '1 Year', seconds: 31104000 },
  ];

  var DEFAULT_PLANS = [
    { price: '5', payToken: USDC_BASE, duration: { value: 1, unit: 'months' }, label: '1 Month', description: 'Monthly subscription' },
    { price: '25.50', payToken: USDC_BASE, duration: { value: 6, unit: 'months' }, label: '6 Months', description: '6-month subscription with 15% discount' },
    { price: '45.00', payToken: USDC_BASE, duration: { value: 12, unit: 'months' }, label: '1 Year', description: 'Annual subscription with 25% discount' },
  ];

  var SUPPLY_TIERS = [
    { name: 'Standard Edition', supply: 1000, price: 4.99, description: 'Accessible pricing for your entire community' },
    { name: 'Limited Edition', supply: 384, price: 12.99, description: 'Premium scarcity with broad appeal' },
    { name: 'Exclusive Edition', supply: 125, price: 39.99, description: 'Ultra-rare collectible with maximum resale potential' },
  ];

  var ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
  ];

  var SUBSCRIPTION_MODULE_ABI = [
    'function bulkUpdatePlans(tuple(string action, bytes args)[] updates)',
    'function configureTokenOwnershipAccess(tuple(address tokenAddress, uint256 threshold)[] thresholds)',
  ];

  // ── IPC & Smart Account ──────────────────────────────

  var urlParams = new URLSearchParams(window.location.search);
  var smartAccountAddress = urlParams.get('puter.smart_account') || null;
  var appInstanceId = urlParams.get('puter.app_instance_id') || '';
  var ipcMsgCounter = 0;

  function hasSmartAccount() {
    return !!smartAccountAddress && smartAccountAddress.toLowerCase() !== (state.walletAddress || '').toLowerCase();
  }

  function getEffectiveAddress(walletChoice) {
    if (walletChoice === 'sa' && smartAccountAddress) return smartAccountAddress;
    return state.walletAddress;
  }

  function parentSendTransaction(txParams) {
    return new Promise(function (resolve, reject) {
      var msgId = 'creator-tx-' + (++ipcMsgCounter) + '-' + Date.now();
      function handler(event) {
        if (!event.data || event.data.original_msg_id !== msgId) return;
        window.removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.txHash);
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({
        $: 'puter-ipc', msg: 'walletSendTransaction',
        appInstanceID: appInstanceId, env: 'app',
        uuid: msgId, txParams: txParams,
      }, '*');
    });
  }

  function parentExecuteSmartAccountBatch(chainId, transactions, expectTokens) {
    return new Promise(function (resolve, reject) {
      var msgId = 'creator-batch-' + (++ipcMsgCounter) + '-' + Date.now();
      function handler(event) {
        if (!event.data || event.data.original_msg_id !== msgId) return;
        if (event.data.msg !== 'walletExecuteSmartAccountBatchResult') return;
        window.removeEventListener('message', handler);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve({ transactionId: event.data.transactionId, transactionHash: event.data.transactionHash });
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({
        $: 'puter-ipc', msg: 'walletExecuteSmartAccountBatch',
        appInstanceID: appInstanceId, env: 'app',
        uuid: msgId, chainId: chainId,
        transactions: transactions, expectTokens: expectTokens || [],
      }, '*');
    });
  }

  function showWalletChoice(titleText) {
    if (!hasSmartAccount()) return Promise.resolve('eoa');
    return new Promise(function (resolve) {
      var modal = document.getElementById('mint-wallet-choice-modal');
      var titleEl = document.getElementById('mint-wc-title');
      var saBtn = document.getElementById('mint-wc-sa');
      var eoaBtn = document.getElementById('mint-wc-eoa');
      var saAddr = document.getElementById('mint-wc-sa-addr');
      var eoaAddr = document.getElementById('mint-wc-eoa-addr');

      if (titleEl) titleEl.textContent = titleText || 'Choose Wallet';
      saAddr.textContent = smartAccountAddress ? (smartAccountAddress.slice(0, 6) + '...' + smartAccountAddress.slice(-4)) : '';
      eoaAddr.textContent = state.walletAddress ? (state.walletAddress.slice(0, 6) + '...' + state.walletAddress.slice(-4)) : '';

      modal.classList.remove('hidden');

      function cleanup() { modal.classList.add('hidden'); saBtn.onclick = null; eoaBtn.onclick = null; }
      saBtn.onclick = function () { cleanup(); resolve('sa'); };
      eoaBtn.onclick = function () { cleanup(); resolve('eoa'); };
    });
  }

  function getChannelOwnerType(channelSelectEl) {
    if (!channelSelectEl) return null;
    var opt = channelSelectEl.options[channelSelectEl.selectedIndex];
    return opt ? (opt.getAttribute('data-owner') || null) : null;
  }

  // ── State ─────────────────────────────────────────────

  var state = {
    selectedFile: null,
    fileBytes: null,
    walletAddress: null,
    walletChoice: null,
    currentStep: 1,
    result: null,
    customThumbnail: null,
    processingResult: null,
    processingError: null,
    processingRunning: false,
    metadataUploaded: false,
    metaCid: null,
    draftId: null,
  };

  // ── DOM refs ──────────────────────────────────────────

  var dom = {};

  function cacheDom() {
    dom.walletBtn = document.getElementById('wallet-btn');
    dom.dropZone = document.getElementById('drop-zone');
    dom.fileInput = document.getElementById('file-input');
    dom.filePreview = document.getElementById('file-preview');
    dom.fileIcon = document.getElementById('file-icon');
    dom.fileName = document.getElementById('file-name');
    dom.fileMeta = document.getElementById('file-meta');
    dom.fileRemove = document.getElementById('file-remove');
    dom.btnToStep2 = document.getElementById('btn-to-step-2');
    dom.btnBackTo1 = document.getElementById('btn-back-to-1');
    dom.btnToStep3 = document.getElementById('btn-to-step-3');
    dom.btnBackTo2 = document.getElementById('btn-back-to-2');
    dom.btnNewAsset = document.getElementById('btn-new-asset');
    dom.assetTitle = document.getElementById('asset-title');
    dom.assetDescription = document.getElementById('asset-description');
    dom.assetCategory = document.getElementById('asset-category');
    dom.assetPrice = document.getElementById('asset-price');
    dom.assetAccess = document.getElementById('asset-access');
    dom.assetCopies = document.getElementById('asset-copies');
    dom.assetChannel = document.getElementById('asset-channel');
    dom.assetChannelCustom = document.getElementById('asset-channel-custom');
    dom.progressError = document.getElementById('progress-error');
    dom.resultAssetCid = document.getElementById('result-asset-cid');
    dom.resultMetaCid = document.getElementById('result-meta-cid');
    dom.resultEncryptHash = document.getElementById('result-encrypt-hash');
    dom.resultSize = document.getElementById('result-size');
    dom.toastContainer = document.getElementById('toast-container');
    dom.thumbDropZone = document.getElementById('thumb-drop-zone');
    dom.thumbInput = document.getElementById('thumb-input');
    dom.thumbPreview = document.getElementById('thumb-preview');
    dom.thumbPreviewImg = document.getElementById('thumb-preview-img');
    dom.thumbRemove = document.getElementById('thumb-remove');
  }

  // ── pc2Fetch (auth wrapper) ───────────────────────────

  function pc2Fetch(path, options) {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('puter.auth.token');
    options = options || {};
    options.headers = options.headers || {};
    if (token) {
      options.headers['Authorization'] = 'Bearer ' + token;
    }
    return fetch(window.location.origin + path, options);
  }

  // ── Toast ─────────────────────────────────────────────

  function showToast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    dom.toastContainer.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  // ── Wallet ────────────────────────────────────────────

  function connectWallet() {
    if (!window.ethereum) {
      showToast('No wallet provider found', 'error');
      return;
    }
    window.ethereum.request({ method: 'eth_requestAccounts' })
      .then(function (accounts) {
        if (accounts && accounts[0]) {
          state.walletAddress = accounts[0];
          dom.walletBtn.textContent = accounts[0].substring(0, 6) + '...' + accounts[0].slice(-4);
          dom.walletBtn.classList.add('connected');
          showToast('Wallet connected', 'success');
          // Auto-fill creator address in first royalty row
          var firstRoyaltyAddr = document.querySelector('.royalty-row .royalty-address');
          if (firstRoyaltyAddr && !firstRoyaltyAddr.value) {
            firstRoyaltyAddr.value = accounts[0];
          }
          if (state.currentStep >= 1 && !state.channelsLoaded) {
            loadChannels(accounts[0]);
          }
        }
      })
      .catch(function (err) {
        showToast('Wallet connection failed: ' + (err.message || ''), 'error');
      });
  }

  // ── Step navigation ───────────────────────────────────

  function goToStep(n) {
    state.currentStep = n;
    var panels = document.querySelectorAll('.step-panel');
    var steps = document.querySelectorAll('#steps-bar .step');

    panels.forEach(function (p, i) {
      p.classList.toggle('active', i === n - 1);
    });

    steps.forEach(function (s, i) {
      var stepNum = i + 1;
      s.classList.remove('active', 'done');
      if (stepNum === n) s.classList.add('active');
      else if (stepNum < n) s.classList.add('done');
    });

    if (n === 1 && state.walletAddress && !state.channelsLoaded) {
      loadChannels(state.walletAddress);
    }
    if (n === 2 && state.walletAddress) {
      var firstRoyaltyAddr = document.querySelector('.royalty-row .royalty-address');
      if (firstRoyaltyAddr && !firstRoyaltyAddr.value) {
        firstRoyaltyAddr.value = state.walletAddress;
      }
    }
  }

  // ── V3 channel discovery: cache → on-chain (V3 factory only) ──

  var CHANNEL_FACTORY_DEPLOY_BLOCK = 43892000;
  var CHANNEL_CACHE_KEY = 'elacity_v3_channels_v3_';
  var CHANNEL_CACHE_TTL = 12 * 60 * 60 * 1000;

  function getCachedChannels(walletAddress, allowStale) {
    try {
      var raw = localStorage.getItem(CHANNEL_CACHE_KEY + walletAddress.toLowerCase());
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!allowStale && Date.now() - cached.ts > CHANNEL_CACHE_TTL) return null;
      return cached.channels;
    } catch (_) { return null; }
  }

  function setCachedChannels(walletAddress, channels) {
    try {
      localStorage.setItem(CHANNEL_CACHE_KEY + walletAddress.toLowerCase(),
        JSON.stringify({ ts: Date.now(), channels: channels }));
    } catch (_) { }
  }

  function invalidateChannelCache(walletAddress) {
    try {
      if (walletAddress) localStorage.removeItem(CHANNEL_CACHE_KEY + walletAddress.toLowerCase());
    } catch (_) { }
  }

  async function rpcBatch(calls) {
    var resp = await fetch(BASE_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calls.map(function (c, i) { return { jsonrpc: '2.0', id: i, method: c.method, params: c.params }; })),
    });
    return resp.json();
  }

  async function fetchV3ChannelsOnChain(walletAddress) {
    try {
      var cached = getCachedChannels(walletAddress);
      if (cached && cached.length > 0) {
        console.log('[Creator] V3 channels from cache (' + cached.length + ')');
        return cached;
      }

      // Return stale cache immediately if available; refresh will happen next time
      var stale = getCachedChannels(walletAddress, true);
      if (stale && stale.length > 0) {
        console.log('[Creator] V3 channels from stale cache (' + stale.length + '), refreshing in background');
        refreshV3ChannelsInBackground(walletAddress);
        return stale;
      }

      return await scanV3ChannelsOnChain(walletAddress);
    } catch (err) {
      console.warn('[Creator] V3 channel scan failed:', err.message);
      return getCachedChannels(walletAddress, true) || [];
    }
  }

  function refreshV3ChannelsInBackground(walletAddress) {
    scanV3ChannelsOnChain(walletAddress).catch(function () { });
  }

  async function scanV3ChannelsOnChain(walletAddress) {
    var iface = new ethers.Interface(ABI.CHANNEL_FACTORY);
    var topic0 = iface.getEvent('ChannelCreated').topicHash;
    var creatorTopic = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');

    var blockResp = await fetch(BASE_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    var latestBlock = parseInt((await blockResp.json()).result, 16);

    var CHUNK = 9999;
    var PARALLEL = 8;
    var minBlock = CHANNEL_FACTORY_DEPLOY_BLOCK;
    var foundAddrs = {};

    // Scan recent blocks first (last ~2M blocks), then older if needed
    var recentCutoff = Math.max(latestBlock - 2000000, minBlock);
    var phases = [
      { from: recentCutoff, to: latestBlock },
      { from: minBlock, to: recentCutoff - 1 },
    ];

    for (var phase = 0; phase < phases.length; phase++) {
      var phaseRange = phases[phase];
      if (phaseRange.from > phaseRange.to) continue;

      var ranges = [];
      for (var c = phaseRange.to; c > phaseRange.from; c = c - CHUNK - 1) {
        ranges.push({ from: Math.max(c - CHUNK, phaseRange.from), to: c });
      }

      for (var b = 0; b < ranges.length; b += PARALLEL) {
        var batch = ranges.slice(b, b + PARALLEL);
        var calls = batch.map(function (r) {
          return { method: 'eth_getLogs', params: [{ address: CONTRACTS.CHANNEL_FACTORY, fromBlock: '0x' + r.from.toString(16), toBlock: '0x' + r.to.toString(16), topics: [topic0, null, null, creatorTopic] }] };
        });
        try {
          var results = await rpcBatch(calls);
          if (!Array.isArray(results)) results = [results];
          results.forEach(function (r) {
            (r.result || []).forEach(function (log) {
              if (log.data && log.data.length >= 130) {
                foundAddrs[ethers.getAddress('0x' + log.data.slice(26, 66))] = true;
              }
            });
          });
        } catch (_) { }
      }

      // If we found channels in recent blocks, skip scanning older ones
      if (Object.keys(foundAddrs).length > 0 && phase === 0) {
        console.log('[Creator] Found V3 channels in recent blocks, skipping older scan');
        break;
      }
    }

    var addrs = Object.keys(foundAddrs);
    if (addrs.length === 0) return [];

    var nameCalls = addrs.map(function (a) {
      return { method: 'eth_call', params: [{ to: a, data: '0x06fdde03' }, 'latest'] };
    });
    var nameResults = [];
    try { nameResults = await rpcBatch(nameCalls); } catch (_) { }
    if (!Array.isArray(nameResults)) nameResults = [nameResults];

    var channels = addrs.map(function (addr, idx) {
      var chName = addr.substring(0, 10) + '...';
      try {
        var r = nameResults[idx];
        if (r && r.result && r.result.length > 2) {
          var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], r.result);
          if (decoded[0]) chName = decoded[0];
        }
      } catch (_) { }
      return { address: addr, name: chName, _v3: true, creator: { address: walletAddress } };
    });

    setCachedChannels(walletAddress, channels);
    return channels;
  }

  // ── Channel fetching from PC2 local catalog (V3-only, indexed from V3 factory) ──

  async function fetchChannelsFromLocalCatalog(creatorAddress) {
    try {
      var origin = (typeof window !== 'undefined' && window.puter_api_origin) || window.location.origin;
      var target = String(creatorAddress || '').toLowerCase();
      // Server-side filter keeps this O(1) at scale (millions of indexed channels)
      var resp = await fetch(origin + '/api/catalog/channels?creator=' + encodeURIComponent(target));
      if (!resp.ok) return [];
      var json = await resp.json();
      if (!json || !json.success || !Array.isArray(json.data)) return [];
      return json.data.map(function (ch) {
        return {
          address: ch.address,
          name: ch.name || (ch.address ? ch.address.substring(0, 10) + '...' : 'Unnamed'),
          _v3: true,
          creator: { address: (ch.creator || target).toLowerCase() },
        };
      });
    } catch (_) {
      return [];
    }
  }

  /**
   * Trigger an immediate PC2 indexer scan so newly-created channels or mints
   * show up without waiting for the regular scan interval (5 min). Fire-and-forget.
   */
  async function triggerLocalReindex() {
    try {
      var origin = (typeof window !== 'undefined' && window.puter_api_origin) || window.location.origin;
      await fetch(origin + '/api/catalog/reindex', { method: 'POST' });
    } catch (_) { }
  }

  // ── Channel fetching from Elacity backend ──────────────

  async function fetchChannelsFromBackend(query) {
    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query FetchChannels($query: ChannelQueryInput, $filters: FilterPaginationInput) { result: fetchChannels(query: $query, filters: $filters) { total data { _id address name imageURL creator { address } } } }',
        variables: { query: query, filters: { offset: 0, limit: 50 } },
      }),
    });
    if (!resp.ok) return [];
    var json = await resp.json();
    return (json.data && json.data.result && json.data.result.data) || [];
  }

  async function retrieveChannelFromBackend(address) {
    var query = [
      'query RetrieveChannel($query: ChannelQueryInput) {',
      '  channel: retrieveChannel(query: $query) {',
      '    _id name address description channelType categories',
      '    image imageURL coverImage coverImageURL itemsCount isPublic',
      '    creator { address }',
      '    plans { planId label description price payToken duration { unit value } }',
      '    tokenAccess { address value }',
      '  }',
      '}',
    ].join('\n');
    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: { query: { address: address } } }),
    });
    if (!resp.ok) throw new Error('Failed to retrieve channel: ' + resp.status);
    var json = await resp.json();
    if (json.errors && json.errors.length > 0) throw new Error(json.errors[0].message);
    return (json.data && json.data.channel) || null;
  }

  async function updateChannelInfoOnBackend(address, input) {
    var token = await getElacityAuthToken(state.walletAddress);
    var mutation = [
      'mutation UpdateChannel($address: String!, $input: ChannelInformationInput!) {',
      '  channel: updateChannelInformation(address: $address, input: $input) {',
      '    name description categories image coverImage',
      '  }',
      '}',
    ].join('\n');
    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: mutation, variables: { address: address, input: input } }),
    });
    if (!resp.ok) throw new Error('Update channel failed: ' + resp.status);
    var json = await resp.json();
    if (json.errors && json.errors.length > 0) throw new Error(json.errors[0].message);
    return json.data.channel;
  }

  async function updateSubscriptionPlanOnBackend(address, actions) {
    var token = await getElacityAuthToken(state.walletAddress);
    var mutation = [
      'mutation UpdatePlan($address: String!, $input: [SubscriptionPlanUpdateAction]!) {',
      '  updateSubscriptionPlan(address: $address, input: $input) {',
      '    name plans { planId label price }',
      '  }',
      '}',
    ].join('\n');
    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: mutation, variables: { address: address, input: actions } }),
    });
    if (!resp.ok) throw new Error('Update plans failed: ' + resp.status);
    var json = await resp.json();
    if (json.errors && json.errors.length > 0) throw new Error(json.errors[0].message);
    return json.data.updateSubscriptionPlan;
  }

  function showChannelStepState(stateId) {
    var states = document.querySelectorAll('.channel-step-state');
    states.forEach(function (el) { el.style.display = 'none'; });
    var target = document.getElementById(stateId);
    if (target) target.style.display = '';
  }

  async function loadChannels(walletAddress) {
    var select = dom.assetChannel;
    var hint = document.getElementById('channel-hint');
    select.innerHTML = '<option value="">Loading channels...</option>';
    select.disabled = true;

    showChannelStepState('channel-loading');

    try {
      var eoaAddr = walletAddress.toLowerCase();
      var saAddr = hasSmartAccount() ? smartAccountAddress.toLowerCase() : null;
      console.log('[Creator] loadChannels: eoa=' + eoaAddr + ', sa=' + (saAddr || 'none') + ', hasSA=' + hasSmartAccount());

      // PRIMARY: PC2 local catalog — V3-only, indexed from V3 factory, sub-100ms, no network
      var eoaChannels = [];
      var saChannels = [];
      try {
        var localResults = await Promise.all([
          fetchChannelsFromLocalCatalog(eoaAddr),
          saAddr ? fetchChannelsFromLocalCatalog(saAddr) : Promise.resolve([]),
        ]);
        eoaChannels = localResults[0] || [];
        saChannels = localResults[1] || [];
        console.log('[Creator] loadChannels via PC2 local catalog: eoa=' + eoaChannels.length + ', sa=' + saChannels.length);
      } catch (localErr) {
        console.warn('[Creator] Local catalog fetch failed:', localErr.message);
      }

      // FALLBACK 1: On-chain V3 factory scan (covers very fresh channels not yet indexed)
      if (eoaChannels.length === 0 && saChannels.length === 0) {
        console.log('[Creator] No channels from local catalog, trying on-chain V3 scan...');
        var onChainResults = await Promise.all([
          fetchV3ChannelsOnChain(eoaAddr),
          saAddr ? fetchV3ChannelsOnChain(saAddr) : Promise.resolve([]),
        ]);
        eoaChannels = onChainResults[0] || [];
        saChannels = onChainResults[1] || [];
        console.log('[Creator] loadChannels via on-chain scan: eoa=' + eoaChannels.length + ', sa=' + saChannels.length);
      }

      // NOTE: We deliberately DO NOT fall back to Elacity backend — it returns V2 channels
      // mixed with V3, and the user only cares about V3. Local catalog is the V3 source of truth.
      console.log('[Creator] loadChannels result: eoa=' + eoaChannels.length + ', sa=' + saChannels.length);

      var publicChannels = [];

      select.innerHTML = '';
      var hasOwned = eoaChannels.length > 0 || saChannels.length > 0;
      var hasAny = hasOwned || publicChannels.length > 0;

      if (!hasAny) {
        var defOpt = document.createElement('option');
        defOpt.value = DEFAULT_CHANNEL;
        defOpt.textContent = 'Public Elacity Channel';
        select.appendChild(defOpt);
        hint.textContent = 'No channels found. Create one to start publishing.';
        hint.className = 'field-hint';

        showChannelStepState('channel-empty-state');
      } else {
        if (eoaChannels.length > 0) {
          var group1 = document.createElement('optgroup');
          group1.label = 'Your Channels — Wallet (' + eoaChannels.length + ')';
          group1.setAttribute('data-group', 'eoa');
          eoaChannels.forEach(function (ch) {
            var opt = document.createElement('option');
            opt.value = ch.address;
            opt.setAttribute('data-owner', 'eoa');
            opt.textContent = ch.name + ' (' + ch.address.substring(0, 8) + '...)';
            group1.appendChild(opt);
          });
          select.appendChild(group1);
        }

        if (saChannels.length > 0) {
          var group1a = document.createElement('optgroup');
          group1a.label = 'Your Channels — Agent Account (' + saChannels.length + ')';
          group1a.setAttribute('data-group', 'sa');
          saChannels.forEach(function (ch) {
            var opt = document.createElement('option');
            opt.value = ch.address;
            opt.setAttribute('data-owner', 'sa');
            opt.textContent = ch.name + ' (' + ch.address.substring(0, 8) + '...)';
            group1a.appendChild(opt);
          });
          select.appendChild(group1a);
        }

        if (publicChannels.length > 0) {
          var group2 = document.createElement('optgroup');
          group2.label = 'Public Channels (' + publicChannels.length + ')';
          publicChannels.forEach(function (ch) {
            var opt = document.createElement('option');
            opt.value = ch.address;
            opt.textContent = (ch.name || 'Unnamed') + ' (' + ch.address.substring(0, 8) + '...)';
            group2.appendChild(opt);
          });
          select.appendChild(group2);
        }

        if (hasOwned) {
          var firstOwned = eoaChannels.length > 0 ? eoaChannels[0] : saChannels[0];
          var firstType = eoaChannels.length > 0 ? 'EOA Wallet' : 'Agent Account';
          select.value = firstOwned.address;
          hint.textContent = 'Your channel selected (' + firstType + ') — you have full minting rights.';
          hint.className = 'field-hint success';
        } else {
          hint.textContent = 'Public channels available. Create your own for full minting rights.';
          hint.className = 'field-hint';
        }

        showChannelStepState('channel-select-area');
      }

      var customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = '— Enter address manually —';
      select.appendChild(customOpt);

      select.disabled = false;
      state.channelsLoaded = true;
      validateStep1();
    } catch (err) {
      console.error('[Creator] Failed to fetch channels:', err);
      select.innerHTML = '<option value="' + DEFAULT_CHANNEL + '">Public Elacity Channel (fallback)</option>';
      var customFb = document.createElement('option');
      customFb.value = '__custom__';
      customFb.textContent = '— Enter address manually —';
      select.appendChild(customFb);
      hint.textContent = 'Could not load channels from Elacity backend. Using default.';
      hint.className = 'field-hint';
      select.disabled = false;
      showChannelStepState('channel-select-area');
      validateStep1();
    }

    select.disabled = false;
  }

  // ── Channel address resolution ───────────────────────

  function getSelectedChannel() {
    var val = dom.assetChannel.value;
    if (val === '__custom__') {
      return (dom.assetChannelCustom.value || '').trim();
    }
    return val.trim();
  }

  // ── File handling ─────────────────────────────────────

  var FILE_ICONS = {
    'application/pdf': '📕',
    'application/epub+zip': '📖',
    'application/epub': '📖',
    'application/vnd.comicbook+zip': '💥',
    'application/x-cbz': '💥',
    'image/': '🖼️',
    'audio/': '🎵',
    'video/': '🎬',
    'text/': '📝',
    'application/json': '📊',
    'application/zip': '📦',
    'model/': '🧊',
  };

  function getFileIcon(mime) {
    if (!mime) return '📄';
    for (var prefix in FILE_ICONS) {
      if (mime.startsWith(prefix)) return FILE_ICONS[prefix];
    }
    return '📄';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // Browser File API doesn't know MIME types for many asset formats.
  // Override from file extension so the backend receives correct types.
  var EXT_MIME_MAP = {
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.obj': 'model/obj',
    '.stl': 'model/stl',
    '.fbx': 'model/vnd.autodesk.fbx',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.onnx': 'application/x-onnx',
    '.safetensors': 'application/x-safetensors',
    '.gguf': 'application/x-gguf',
    '.epub': 'application/epub+zip',
    '.cbz': 'application/vnd.comicbook+zip',
  };

  function resolveFileMime(file) {
    if (file.type && file.type !== 'application/octet-stream') return file.type;
    var name = (file.name || '').toLowerCase();
    var dotIdx = name.lastIndexOf('.');
    if (dotIdx !== -1) {
      var ext = name.substring(dotIdx);
      if (EXT_MIME_MAP[ext]) return EXT_MIME_MAP[ext];
    }
    return file.type || 'application/octet-stream';
  }

  function handleFileSelected(file) {
    if (!file) return;

    var resolvedMime = resolveFileMime(file);

    var isMedia = resolvedMime.startsWith('video/') || resolvedMime.startsWith('audio/');
    var MAX_FILE_SIZE = isMedia ? 4 * 1024 * 1024 * 1024 : 100 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      showToast('File too large. Maximum size: ' + (isMedia ? '4 GB' : '100 MB'), 'error');
      return;
    }

    // Wrap file with resolved MIME for downstream use
    state.selectedFile = file;
    state.resolvedMime = resolvedMime;

    dom.fileIcon.textContent = getFileIcon(resolvedMime);
    dom.fileName.textContent = file.name;
    dom.fileMeta.textContent = formatSize(file.size) + ' — ' + (resolvedMime || 'unknown type');
    dom.dropZone.classList.add('hidden');
    dom.filePreview.classList.remove('hidden');
    validateStep1();

    // Auto-detect category from MIME type
    var autoCategory = '';
    if (resolvedMime.startsWith('video/')) autoCategory = 'video';
    else if (resolvedMime.startsWith('audio/')) autoCategory = 'audio';
    else if (resolvedMime.startsWith('image/')) autoCategory = 'image';
    else if (resolvedMime === 'application/pdf') autoCategory = 'ebook';
    else if (resolvedMime === 'application/epub+zip' || resolvedMime === 'application/epub') autoCategory = 'ebook';
    else if (resolvedMime === 'application/vnd.comicbook+zip' || resolvedMime === 'application/x-cbz') autoCategory = 'comic';
    else if (resolvedMime === 'text/markdown' && file.name.match(/skill/i)) autoCategory = 'skill';
    else if (resolvedMime.startsWith('text/')) autoCategory = 'document';
    else if (resolvedMime === 'application/json') autoCategory = 'dataset';
    else if (resolvedMime === 'font/ttf' || resolvedMime === 'font/otf' || resolvedMime === 'font/woff' || resolvedMime === 'font/woff2') autoCategory = 'font';
    else if (file.name.match(/\.(glb|gltf|obj|fbx|stl|usdz)$/i)) autoCategory = '3d-model';
    else if (file.name.match(/\.(py|js|ts|rs|go|java|c|cpp|h|rb|php|sh|sql|zip|tar|gz)$/i)) autoCategory = 'code';
    else if (file.name.match(/\.(csv|tsv|parquet|jsonl|ndjson|xml)$/i)) autoCategory = 'dataset';
    else if (file.name.match(/\.(onnx|safetensors|pt|pth|h5|pb|tflite|gguf|ggml)$/i)) autoCategory = 'ai-model';
    if (autoCategory && dom.assetCategory) {
      dom.assetCategory.value = autoCategory;
    }

    // Show media encoding badge and preview settings for video/audio files
    var existingBadge = document.getElementById('media-encode-badge');
    if (existingBadge) existingBadge.remove();
    var previewSection = document.getElementById('preview-settings-section');
    if (isMedia) {
      var badge = document.createElement('div');
      badge.id = 'media-encode-badge';
      badge.style.cssText = 'margin-top: 8px; padding: 6px 12px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border-radius: 6px; font-size: 12px; display: flex; align-items: center; gap: 6px;';
      badge.innerHTML = '<span style="font-size: 14px;">&#9881;</span> Media Encoding Pipeline — will transcode, DASH package, CENC encrypt & upload to IPFS';
      dom.filePreview.appendChild(badge);
      if (previewSection) previewSection.style.display = '';
    } else {
      if (previewSection) previewSection.style.display = 'none';
    }

    // For media files, don't read into memory — the backend handles the file directly
    if (!isMedia) {
      var reader = new FileReader();
      reader.onload = function () {
        state.fileBytes = new Uint8Array(reader.result);
      };
      reader.readAsArrayBuffer(file);
      state.isMediaFile = false;
    } else {
      state.fileBytes = null;
      state.isMediaFile = true;
    }

    if (!dom.assetTitle.value) {
      var nameNoExt = file.name.replace(/\.[^.]+$/, '');
      dom.assetTitle.value = nameNoExt;
    }

    var accessArea = document.getElementById('step1-access-method');
    if (accessArea) accessArea.style.display = '';
  }

  function clearFile() {
    state.selectedFile = null;
    state.fileBytes = null;
    state.isMediaFile = false;
    dom.dropZone.classList.remove('hidden');
    dom.filePreview.classList.add('hidden');
    validateStep1();
    dom.fileInput.value = '';
    var existingBadge = document.getElementById('media-encode-badge');
    if (existingBadge) existingBadge.remove();
    var previewSection = document.getElementById('preview-settings-section');
    if (previewSection) previewSection.style.display = 'none';
    var prevEnabled = document.getElementById('preview-enabled');
    var prevDur = document.getElementById('preview-duration');
    if (prevEnabled) { prevEnabled.checked = true; prevEnabled.disabled = false; }
    if (prevDur) { prevDur.value = '15'; prevDur.disabled = false; }
    var prevDisplay = document.getElementById('preview-duration-display');
    if (prevDisplay) prevDisplay.textContent = '15s';
    var accessArea = document.getElementById('step1-access-method');
    if (accessArea) accessArea.style.display = 'none';
  }

  // ── Form validation ───────────────────────────────────

  function validateStep1() {
    var ch = getSelectedChannel();
    var hasChannel = ch && ethers.isAddress(ch);
    var hasFile = !!state.selectedFile;
    var btn = dom.btnToStep2;
    if (btn) btn.disabled = !(hasChannel && hasFile);
  }

  function validateStep2() {
    var title = dom.assetTitle.value.trim();
    var category = dom.assetCategory.value;
    var price = parseFloat(dom.assetPrice.value);
    var accessMethod = dom.assetAccess.value;

    var titleValid = title.length >= 3;
    var categoryValid = !!category;
    var priceValid = accessMethod === 'free' || (!isNaN(price) && price >= 0.001 && price <= 1000000);

    var royaltyValid = validateRoyaltyTotal();
    var royaltyHint = document.getElementById('royalty-total-hint');
    if (royaltyHint) {
      if (royaltyValid) {
        royaltyHint.textContent = 'Platform fee: 5% (auto-added). Your shares total 95%.';
        royaltyHint.style.color = '';
      } else {
        var partners = getRoyaltyPartners();
        var total = partners.reduce(function (s, r) { return s + Number(r.royalty); }, 0);
        royaltyHint.textContent = 'Shares total ' + total.toFixed(1) + '% — must equal 95% (platform takes 5%).';
        royaltyHint.style.color = 'var(--error)';
      }
    }

    var valid = titleValid && categoryValid && priceValid && royaltyValid;
    if (dom.btnToStep3) dom.btnToStep3.disabled = !valid;
  }

  function validateStep3() {
    var legalChecks = document.querySelectorAll('.legal-check');
    var allChecked = true;
    legalChecks.forEach(function (cb) { if (!cb.checked) allChecked = false; });
    var btnSign = document.getElementById('btn-sign-mint');
    if (btnSign) btnSign.disabled = !allChecked || !state.metadataUploaded;
  }

  // ── Encrypt & Upload pipeline ─────────────────────────

  function setProgStep(id, status, cls) {
    var el = document.getElementById(id);
    var statusEl = document.getElementById(id + '-status');
    if (!el || !statusEl) return;
    el.className = 'progress-step ' + (cls || '');
    statusEl.textContent = status;
    if (cls === 'active' || cls === 'done') {
      var labelEl = el.querySelector('.prog-label');
      var label = labelEl ? labelEl.textContent : status;
      updateFloatingProgress(id, label + (cls === 'active' ? ' — ' + status : ''), cls);
    }
  }

  function swapProgressStepsForMedia() {
    var mediaSteps = [
      { id: 'prog-connect', icon: '🎬', label: 'Upload to encoder' },
      { id: 'prog-encrypt', icon: '⚙️', label: 'Encode, encrypt & package' },
      { id: 'prog-upload-asset', icon: '🌐', label: 'Finalize IPFS' },
    ];
    mediaSteps.forEach(function (step) {
      var el = document.getElementById(step.id);
      if (!el) return;
      var iconEl = el.querySelector('.prog-icon');
      var labelEl = el.querySelector('.prog-label');
      if (iconEl) iconEl.textContent = step.icon;
      if (labelEl) labelEl.textContent = step.label;
    });
    var detail = document.getElementById('media-pipeline-detail');
    if (detail) detail.style.display = 'block';
  }

  function restoreProgressStepsDefault() {
    var defaultSteps = [
      { id: 'prog-connect', icon: '🔌', label: 'Connect to Lit Protocol' },
      { id: 'prog-encrypt', icon: '🔐', label: 'Encrypt asset with ACCESS_TOKEN conditions' },
      { id: 'prog-upload-asset', icon: '📦', label: 'Upload encrypted asset to IPFS' },
    ];
    defaultSteps.forEach(function (step) {
      var el = document.getElementById(step.id);
      if (!el) return;
      var iconEl = el.querySelector('.prog-icon');
      var labelEl = el.querySelector('.prog-label');
      if (iconEl) iconEl.textContent = step.icon;
      if (labelEl) labelEl.textContent = step.label;
    });
    var detail = document.getElementById('media-pipeline-detail');
    if (detail) detail.style.display = 'none';
    resetMediaSubSteps();
  }

  var MEDIA_SUB_STEPS = ['analyze', 'transcode', 'fragment', 'encrypt', 'upload'];
  var STAGE_TO_SUB = {
    analyzing: 'analyze',
    transcoding: 'transcode',
    fragmenting: 'fragment',
    packaging: 'encrypt',
    uploading: 'upload',
  };
  var STAGE_PROGRESS = { analyzing: 5, transcoding: 60, fragmenting: 75, packaging: 90, uploading: 95, complete: 100 };

  function setMediaSubStep(subId, state, info) {
    var iconEl = document.getElementById('media-sub-' + subId + '-icon');
    var infoEl = document.getElementById('media-sub-' + subId + '-info');
    var rowEl = document.getElementById('media-sub-' + subId);
    var barEl = document.getElementById('media-sub-' + subId + '-bar');
    if (!iconEl) return;
    if (state === 'done') {
      iconEl.textContent = '✓'; iconEl.style.color = '#22c55e';
      if (rowEl) rowEl.style.color = '#e2e8f0';
      if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#22c55e'; }
    } else if (state === 'active') {
      iconEl.textContent = '◉'; iconEl.style.color = '#8b5cf6';
      if (rowEl) rowEl.style.color = '#e2e8f0';
      if (barEl) { barEl.style.width = '30%'; barEl.style.background = '#6366f1'; }
    } else if (state === 'error') {
      iconEl.textContent = '✗'; iconEl.style.color = '#ef4444';
      if (rowEl) rowEl.style.color = '#fca5a5';
      if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#ef4444'; }
    } else {
      iconEl.textContent = '○'; iconEl.style.color = '#64748b';
      if (rowEl) rowEl.style.color = '#94a3b8';
      if (barEl) { barEl.style.width = '0%'; barEl.style.background = '#6366f1'; }
    }
    if (infoEl) infoEl.textContent = info || '';
  }

  function setMediaProgress(pct, elapsed) {
    var bar = document.getElementById('media-progress-bar');
    var pctEl = document.getElementById('media-progress-pct');
    var elapsedEl = document.getElementById('media-elapsed');
    if (bar) bar.style.width = Math.min(pct, 100) + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    if (elapsedEl && elapsed > 0) {
      var mins = Math.floor(elapsed / 60);
      var secs = elapsed % 60;
      elapsedEl.textContent = 'Elapsed: ' + (mins > 0 ? mins + 'm ' : '') + secs + 's';
    }
  }

  function resetMediaSubSteps() {
    MEDIA_SUB_STEPS.forEach(function (id) { setMediaSubStep(id, 'pending', ''); });
    setMediaProgress(0, 0);
  }

  function uint8ToBase64(bytes) {
    var binary = '';
    var chunkSize = 32768;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ── Floating progress bar ──────────────────────────
  var PIPELINE_WEIGHTS = {
    'prog-connect': { start: 0, end: 10 },
    'prog-encrypt': { start: 10, end: 45 },
    'prog-upload-asset': { start: 45, end: 60 },
    'prog-upload-meta': { start: 60, end: 80 },
    'prog-pin': { start: 80, end: 90 },
    'prog-mint': { start: 90, end: 97 },
    'prog-approve': { start: 97, end: 100 },
  };

  function updateFloatingProgress(stepId, label, stepState) {
    var bar = document.getElementById('floating-progress');
    var fill = document.getElementById('floating-progress-fill');
    var text = document.getElementById('floating-progress-text');
    var pct = document.getElementById('floating-progress-pct');
    if (!bar) return;

    bar.style.display = '';
    bar.classList.remove('done', 'hiding');

    var weight = PIPELINE_WEIGHTS[stepId];
    var percent = 0;
    if (weight) {
      percent = stepState === 'done' ? weight.end : weight.start;
    }

    if (fill) fill.style.width = percent + '%';
    if (text) text.textContent = label;
    if (pct) pct.textContent = Math.round(percent) + '%';

    // Sync the smooth progress bar in step 3 panel
    var smoothFill = document.getElementById('smooth-progress-fill');
    var smoothLabel = document.getElementById('smooth-progress-label');
    if (smoothFill) smoothFill.style.width = percent + '%';
    if (smoothLabel) smoothLabel.textContent = label;

    if (stepState === 'done' && stepId === 'prog-approve') {
      bar.classList.add('done');
      if (fill) fill.style.width = '100%';
      if (pct) pct.textContent = '100%';
      if (text) text.textContent = 'Published successfully';
      if (smoothFill) smoothFill.style.width = '100%';
      if (smoothLabel) smoothLabel.textContent = 'Published successfully';
      setTimeout(function () {
        bar.classList.add('hiding');
        setTimeout(function () { bar.style.display = 'none'; }, 350);
      }, 3000);
    }
  }

  function hideFloatingProgress() {
    var bar = document.getElementById('floating-progress');
    if (bar) {
      bar.classList.add('hiding');
      setTimeout(function () { bar.style.display = 'none'; bar.classList.remove('hiding', 'done'); }, 350);
    }
  }

  // ── Legal attestation for metadata ────────────────
  var LEGAL_ATTESTATIONS = [
    { key: 'rights', text: 'I am the rightful owner or have obtained all necessary rights, licenses, and permissions to distribute this content' },
    { key: 'lawful', text: 'This content does not contain illegal, harmful, defamatory, or prohibited material under applicable law' },
    { key: 'ip', text: 'No unauthorized use of third-party copyrighted, trademarked, or proprietary material' },
    { key: 'terms', text: 'I accept responsibility for this publication and agree to the network terms of use' },
  ];

  async function buildLegalAttestation(walletAddress) {
    var timestamp = new Date().toISOString();
    var attestationText = LEGAL_ATTESTATIONS.map(function (a) { return a.key + ':' + a.text; }).join('|');
    var payload = walletAddress.toLowerCase() + '|' + timestamp + '|' + attestationText;

    var encoder = new TextEncoder();
    var data = encoder.encode(payload);
    var hashBuffer = await crypto.subtle.digest('SHA-256', data);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    var hashHex = hashArray.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

    return {
      version: '1.0',
      attestedAt: timestamp,
      attestedBy: walletAddress.toLowerCase(),
      declarations: LEGAL_ATTESTATIONS.map(function (a) { return a.key; }),
      hash: '0x' + hashHex,
    };
  }

  function getContentTypeCode(mimeType) {
    if (!mimeType) return 'B';
    if (mimeType.startsWith('audio/')) return 'F';
    if (mimeType.startsWith('image/')) return 'D';
    if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) return 'E';
    return 'B';
  }

  function buildMetadataEnvelope(params) {
    var contentType = params.mimeType || 'application/octet-stream';
    var isPublic = params.accessMethod === 'free';
    var isResellable = params.accessMethod === 'buy_and_resell';
    var distributionLabel = params.accessMethod === 'buy_once' ? 'Buy Once'
      : params.accessMethod === 'free' ? 'Free' : 'Buy & Resell';
    var currency = params.currency || CURRENCIES[0];
    var categories = Array.isArray(params.categories) ? params.categories
      : (params.category ? [params.category] : []);
    var tags = Array.isArray(params.tags) ? params.tags : [];

    return {
      schema: 'elacity-asset-envelope-v1',
      name: params.title,
      description: params.description,
      image: params.image || '',
      category: categories[0] || '',
      media: {
        uri: 'ipfs://' + params.assetCid,
        contentType: contentType,
        mimeType: contentType,
        object: 'self://content.json',
        ...(!isPublic && {
          protectionType: ['lit-aes-gcm-v1'],
        }),
        size: params.size,
      },
      asset: {
        cid: params.assetCid,
        mimeType: contentType,
        size: params.size,
        encrypted: !isPublic,
        algorithm: isPublic ? 'none' : 'aes-256-gcm',
        protectionType: isPublic ? 'none' : 'lit-aes-gcm-v1',
        dataToEncryptHash: params.dataToEncryptHash,
        actionCid: isPublic ? '' : (params.actionCid || ''),
        authority: isPublic ? '' : (params.authority || CONTRACTS.AUTHORITY_GATEWAY),
        chain: 'base',
        chainId: BASE_CHAIN_ID,
        rpc: 'https://mainnet.base.org',
      },
      pricing: {
        currency: isPublic ? '' : currency.symbol,
        currencyAddress: isPublic ? '' : currency.address,
        currencyDecimals: isPublic ? 0 : currency.decimals,
        price: isPublic ? 0 : params.price,
        accessMethod: params.accessMethod || 'buy_and_resell',
        copies: isPublic ? undefined : (params.copies || 10000),
        resellerCut: isResellable ? (params.resellerCut || 900) : undefined,
      },
      properties: {
        chainId: BASE_CHAIN_ID,
        ledger: params.channel || DEFAULT_CHANNEL,
        authority: params.authority || CONTRACTS.AUTHORITY_GATEWAY,
        publisher: params.creatorAddress,
        contract: 'self://contract.json',
        labelType: 'Creator',
        distribution: distributionLabel,
        tags: tags,
        categories: categories,
      },
      creator: {
        address: params.creatorAddress,
        channel: params.channel || DEFAULT_CHANNEL,
      },
      attributes: params.attributes || [],
      adult: !!params.isAdult,
      licensing: params.licensing || undefined,
      legal: params.legalAttestation || null,
      createdAt: new Date().toISOString(),
      version: '1.0.0',
    };
  }

  function buildContentJson(params) {
    var contentType = params.mimeType || 'application/octet-stream';
    return {
      title: params.title,
      type: contentType,
      description: 'Details about the content, technical informations, etc.',
      image: params.image,
      properties: {
        // keep this here for backward compatibility
        size: params.size,
        protectionType: [
          params.protectionType || 'lit-aes-gcm-v1'
        ],
        dataToEncryptHash: params.dataToEncryptHash,
        kid: params.kid || '',
      },
      attributes: [
        { trait_type: 'Content-Type', value: getContentTypeCode(params.mimeType) },
        { trait_type: 'Size', value: params.size },
        { trait_type: 'Encrypted', value: true },
        { trait_type: 'Algorithm', value: params.algorithm || 'aes-256-gcm' },
      ]
    };
  }

  function buildContractJson(params) {
    var isPublic = params.accessMethod === 'free';
    var isResellable = params.accessMethod === 'buy_and_resell';
    var currency = params.currency || CURRENCIES[0];
    return {
      title: `Contract - ${params.title}`,
      type: 'MCO',
      description: 'Media Contract Ontology (MCO) formatted in JSON',
      version: '1.0',
      properties: {
        chainId: BASE_CHAIN_ID,
        channel: params.channel || DEFAULT_CHANNEL,
        authority: params.authority || CONTRACTS.AUTHORITY_GATEWAY,
        initialPrice: {
          value: params.price,
          paymentToken: currency.address,
          paymentDecimals: currency.decimals,
        },
      },
      attributes: [
        { trait_type: 'Content-Type', value: getContentTypeCode(params.mimeType) },
        { trait_type: 'OpType', value: isPublic ? 0 : (isResellable ? 2 : 1) },
        { trait_type: 'Supply', value: params.copies || 10000 },
        { trait_type: 'Resell-Allowed', value: isResellable ? true : false },
        { trait_type: 'RRL-Percent', value: (isResellable ? (params.resellerCut || 900) : 0) / 10 }
      ]
    };
  }

  function buildTokenTypeJsons(params) {
    var files = {};
    var imageUri = params.image || '';
    var isPublic = params.accessMethod === 'free';
    var isResellable = params.accessMethod === 'buy_and_resell';

    if (!isPublic) {
      files['0000000000000000000000000000000000000000000000000000000000000001.json'] = {
        type: 'AccessToken',
        name: 'Access Token',
        description: 'Allow owner to access the content',
        image: imageUri,
        properties: {
          kid: params.kid || params.dataToEncryptHash || '',
          title: params.title,
        },
      };

      files['0000000000000000000000000000000000000000000000000000000000000002.json'] = {
        type: 'RoyaltyShare',
        name: 'Royalty Share',
        decimals: 1,
        description: '10 shares = 1% of revenue',
        image: imageUri,
        properties: {
          kid: params.kid || params.dataToEncryptHash || '',
          title: params.title,
        },
      };

      if (isResellable) {
        files['0000000000000000000000000000000000000000000000000000000000000003.json'] = {
          type: 'DistributionRight',
          name: 'Distribution Right',
          description: 'Allow owner to distribute the content via trade',
          image: imageUri,
          properties: {
            kid: params.kid || params.dataToEncryptHash || '',
            title: params.title,
          },
        };
      }
    }

    return files;
  }

  // ── Local AES-GCM encryption (no Lit Protocol needed) ─

  async function localEncrypt(plainBytes) {
    var key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv }, key, plainBytes
    );
    var rawKey = await crypto.subtle.exportKey('raw', key);
    var rawKeyBytes = new Uint8Array(rawKey);

    var hashBuf = await crypto.subtle.digest('SHA-256', plainBytes);
    var hashHex = Array.from(new Uint8Array(hashBuf))
      .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

    var keyHex = Array.from(rawKeyBytes)
      .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

    var encrypted = new Uint8Array(iv.length + cipherBuf.byteLength);
    encrypted.set(iv, 0);
    encrypted.set(new Uint8Array(cipherBuf), iv.length);

    return {
      encrypted: encrypted,
      dataToEncryptHash: hashHex,
      keyId: 'local-dev:' + keyHex.substring(0, 16),
      algorithm: 'aes-gcm',
      _localDevKey: uint8ToBase64(rawKeyBytes),
    };
  }

  // ── Minting helpers ──────────────────────────────────

  var PROGRESS_STEPS = ['prog-connect', 'prog-encrypt', 'prog-upload-asset', 'prog-upload-meta', 'prog-pin', 'prog-mint', 'prog-approve'];

  function hashToContentId(hexHash) {
    var clean = hexHash.startsWith('0x') ? hexHash.slice(2) : hexHash;
    return '0x' + clean.slice(0, 32).padEnd(32, '0');
  }

  function encodeOpRawData(params) {
    var coder = ethers.AbiCoder.defaultAbiCoder();
    var cid16 = hashToContentId(params.contentId);
    var metadataUri = 'ipfs://' + params.metadataCID;
    var isResellable = params.opType === OP_TYPES.BUY_AND_RESELL;

    var royalties = params.royalties || [
      { address: params.creatorAddress, royalty: 100 - ELACITY_ROYALTY_PERCENT, identifier: 'A' },
    ];
    // V3: protocol takes its cut via protocolShares (5%) automatically — no manual Elacity push

    var addresses = [params.creatorAddress];
    var roleTypes = [ROLE_ACCESS_TOKEN];
    var amounts = [params.copies];

    royalties.forEach(function (r) {
      addresses.push(r.address);
      roleTypes.push(ROLE_ROYALTY_SHARE);
      amounts.push(Math.round(10 * Number(r.royalty)));
    });

    if (isResellable) {
      var distributor = royalties.find(function (r) { return r.identifier === 'C' || r.key === 'C'; });
      if (distributor && distributor.address !== params.creatorAddress) {
        addresses.push(distributor.address);
        roleTypes.push(ROLE_DISTRIBUTION_RIGHT);
        amounts.push(1);
      }
    }

    if (isResellable) {
      return coder.encode(
        ['bytes16', 'string', 'address[]', 'uint256[]', 'uint256[]', 'uint16'],
        [cid16, metadataUri, addresses, roleTypes, amounts, params.resellerCut || 900]
      );
    }

    return coder.encode(
      ['bytes16', 'string', 'address[]', 'uint256[]', 'uint256[]'],
      [cid16, metadataUri, addresses, roleTypes, amounts]
    );
  }

  function encodeSellRawData(copies, priceWei, payToken) {
    var coder = ethers.AbiCoder.defaultAbiCoder();
    return coder.encode(
      ['uint256', 'uint256', 'address'],
      [copies, priceWei, payToken]
    );
  }

  async function getMintingFee() {
    var iface = new ethers.Interface(ABI.CENTRAL_STORAGE);
    var data = iface.encodeFunctionData('mediaCreationFee', []);
    var result = await rpcCall(CONTRACTS.CENTRAL_STORAGE, data);
    var decoded = iface.decodeFunctionResult('mediaCreationFee', result);
    return { fee: decoded.fee, token: decoded.token };
  }

  var BASE_RPC = 'https://mainnet.base.org';

  async function rpcCall(to, data) {
    var resp = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: to, data: data }, 'latest'],
      }),
    });
    var json = await resp.json();
    if (json.error) throw new Error('RPC error: ' + (json.error.message || JSON.stringify(json.error)));
    return json.result;
  }

  async function getChannelAuthority(channelAddress) {
    var iface = new ethers.Interface(ABI.DIGITAL_ASSET);
    var data = iface.encodeFunctionData('authority', []);
    try {
      var result = await rpcCall(channelAddress, data);
      if (!result || result === '0x') throw new Error('Empty result from authority()');
      var decoded = iface.decodeFunctionResult('authority', result);
      return decoded[0];
    } catch (err) {
      console.warn('[Creator] authority() call failed, using default gateway:', err.message);
      return CONTRACTS.AUTHORITY_GATEWAY;
    }
  }

  async function sendTx(to, data, value) {
    var txParams = {
      to: to,
      data: data,
      chainId: BASE_CHAIN_HEX,
    };
    if (value && BigInt(value) > 0n) {
      txParams.value = '0x' + BigInt(value).toString(16);
    }

    if (window.parent !== window && appInstanceId) {
      return parentSendTransaction(txParams);
    }

    txParams.from = state.walletAddress;
    var txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [txParams],
    });
    return txHash;
  }

  /**
   * Sends a transaction with retry UI — if the user cancels in the wallet or
   * the tx fails to submit, a "Retry" button appears on the progress step so
   * the user can re-attempt without restarting the whole pipeline.
   *
   * @param {string} stepId   - The progress step element id (e.g. 'prog-mint')
   * @param {string} stepLabel - Human label for the step (e.g. 'Mint on Channel contract')
   * @param {string} to       - Contract address
   * @param {string} data     - Encoded calldata
   * @param {string|undefined} value - Optional ETH value in wei
   * @returns {Promise<string>} Transaction hash
   */
  async function sendTxWithRetry(stepId, stepLabel, to, data, value) {
    while (true) {
      try {
        setProgStep(stepId, 'Confirm in wallet...', 'active');
        var txHash = await sendTx(to, data, value);
        return txHash;
      } catch (txErr) {
        var code = txErr.code || (txErr.data && txErr.data.code);
        var msg = txErr.message || '';
        var isUserReject = code === 4001 || code === 'ACTION_REJECTED'
          || msg.includes('User denied') || msg.includes('user rejected')
          || msg.includes('User rejected');

        console.warn('[Creator] Transaction failed:', msg, '(code:', code, ')');

        var retryPromise = new Promise(function (resolve) {
          setProgStep(stepId, (isUserReject ? 'Cancelled' : 'Failed') + ' — ', 'error');
          var stepEl = document.getElementById(stepId);
          if (!stepEl) { resolve(false); return; }
          var statusEl = document.getElementById(stepId + '-status') || stepEl.querySelector('.prog-status') || stepEl.querySelector('span:last-child');
          if (!statusEl) { resolve(false); return; }

          var retryBtn = document.createElement('button');
          retryBtn.textContent = 'Retry';
          retryBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;padding:4px 12px;font-size:12px;line-height:1;font-family:inherit;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;margin-left:8px;';
          retryBtn.addEventListener('click', function () {
            retryBtn.remove();
            resolve(true);
          });

          var cancelBtn = document.createElement('button');
          cancelBtn.textContent = 'Skip';
          cancelBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;padding:4px 12px;font-size:12px;line-height:1;font-family:inherit;background:#6b7280;color:white;border:none;border-radius:4px;cursor:pointer;margin-left:4px;';
          cancelBtn.addEventListener('click', function () {
            retryBtn.remove();
            cancelBtn.remove();
            resolve(false);
          });

          statusEl.appendChild(retryBtn);
          statusEl.appendChild(cancelBtn);
        });

        var shouldRetry = await retryPromise;
        if (!shouldRetry) {
          throw new Error(stepLabel + ' skipped by user');
        }
      }
    }
  }

  async function waitForReceipt(txHash, maxWait) {
    var start = Date.now();
    maxWait = maxWait || 120000;
    while (Date.now() - start < maxWait) {
      // Try standard RPC first — returns complete logs needed for event parsing
      var resp = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      });
      var json = await resp.json();
      var receipt = json.result;
      if (receipt && receipt.status) return receipt;

      // Fallback: Smart Account wallets (Particle/UniversalX) return UserOperation
      // hashes that standard RPC won't recognize. Try the wallet provider which can
      // resolve UserOp hashes to real receipts.
      try {
        var walletReceipt = await window.ethereum.request({
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        });
        if (walletReceipt && walletReceipt.status) return walletReceipt;
      } catch (_) { /* wallet provider doesn't support it, keep polling */ }

      await new Promise(function (r) { setTimeout(r, 3000); });
    }
    console.warn('[Creator] waitForReceipt timed out for', txHash);
    return { status: 'timeout', transactionHash: txHash };
  }

  // ── Channel creation ─────────────────────────────────

  async function getChannelCreationFee() {
    var iface = new ethers.Interface(ABI.CENTRAL_STORAGE);
    var data = iface.encodeFunctionData('channelCreationFee', []);
    var result = await rpcCall(CONTRACTS.CENTRAL_STORAGE, data);
    var decoded = iface.decodeFunctionResult('channelCreationFee', result);
    return { fee: decoded.fee, token: decoded.token };
  }

  function parseChannelCreatedEvent(receipt) {
    var iface = new ethers.Interface(ABI.CHANNEL_FACTORY);
    var logs = receipt.logs || [];
    for (var i = 0; i < logs.length; i++) {
      try {
        var parsed = iface.parseLog({ topics: logs[i].topics, data: logs[i].data });
        if (parsed && parsed.name === 'ChannelCreated') {
          // V3: (uint8 indexed channelType, uint8 indexed scope, address indexed creator, address channel, address factoryAddr)
          return {
            channelAddr: parsed.args.channel,
            channelType: Number(parsed.args.channelType),
            owner: parsed.args.creator,
            scope: Number(parsed.args.scope),
            name: '',
          };
        }
      } catch (_) { /* not our event */ }
    }
    return null;
  }

  async function doCreateChannel(channelName, description, walletChoice) {
    if (!state.walletAddress) throw new Error('Connect wallet first');
    walletChoice = walletChoice || 'eoa';
    var creatorAddr = getEffectiveAddress(walletChoice);

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_CHAIN_HEX }],
      });
    } catch (_) { }

    var feeInfo = await getChannelCreationFee();
    console.log('[Creator] Channel creation fee:', feeInfo.fee.toString(), 'wallet:', walletChoice);

    var channelDesc = description || 'PC2 digital assets channel';
    var channelMeta = {};
    channelMeta['0000000000000000000000000000000000000000000000000000000000000000.json'] = {
      name: channelName,
      description: channelDesc,
      properties: { creator: creatorAddr },
      attributes: [
        { trait_type: 'Type', value: CHANNEL_TYPE.STANDARD },
        { trait_type: 'Scope', value: CHANNEL_SCOPE.PRIVATE },
      ],
    };
    channelMeta['0000000000000000000000000000000000000000000000000000000000000002.json'] = {
      name: 'Royalty Share - ' + channelName,
      description: 'Shares for royalty distribution over all subscriptions to the channel \'' + channelName + '\'',
      properties: { decimals: 1, creator: creatorAddr },
      attributes: [],
    };

    var channelPlansForMeta = getChannelPlans();
    channelPlansForMeta.forEach(function (plan, idx) {
      var planIdx = idx + 1;
      var r = BigInt(0xff) << BigInt(120);
      var shifted = BigInt(planIdx) << BigInt(112);
      var tokenId = (r | shifted).toString(16).padStart(64, '0');
      channelMeta[tokenId + '.json'] = {
        name: plan.label + ' - ' + channelName,
        description: plan.description || plan.label + ' plan',
        image: '',
        attributes: [
          { trait_type: 'Duration', value: plan.duration.value + ' ' + plan.duration.unit },
        ],
      };
    });

    var files = {};
    for (var fname in channelMeta) {
      var jsonStr = JSON.stringify(channelMeta[fname], null, 2);
      files[fname] = btoa(unescape(encodeURIComponent(jsonStr)));
    }

    var metaResp = await pc2Fetch('/api/storage/ipfs/add-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files, announce: true }),
    });
    if (!metaResp.ok) {
      var errBody = await metaResp.json().catch(function () { return {}; });
      throw new Error('Channel metadata upload failed: ' + (errBody.error || metaResp.status));
    }
    var metaData = await metaResp.json();
    var metaCid = metaData.cid;
    console.log('[Creator] Channel metadata CID:', metaCid);

    var creatorPer1000 = Math.round((100 - ELACITY_ROYALTY_PERCENT) * 10);
    var elacityPer1000 = Math.round(ELACITY_ROYALTY_PERCENT * 10);

    var channelPlans = getChannelPlans();
    var channelTokenAccess = getTokenAccessThresholds();
    var channelRoyalties = getRoyaltyPartners();

    var royaltyTuples = channelRoyalties.map(function (r) {
      return [r.address, Math.round(10 * Number(r.royalty))];
    });
    // V3: protocol takes its cut via protocolShares (5%) automatically — no manual Elacity push

    var planTuples = channelPlans.map(function (p) {
      var durOpt = DURATION_OPTIONS.find(function (d) { return d.value === p.duration.value && d.unit === p.duration.unit; });
      var durationSecs = durOpt ? durOpt.seconds : 2592000;
      var tokenDecimals = (CURRENCIES.find(function (c) { return c.address === p.payToken; }) || { decimals: 18 }).decimals;
      var priceWei = ethers.parseUnits(p.price.toString(), tokenDecimals);
      return [0, p.payToken, priceWei, durationSecs, true];
    });

    var tokenAccessTuples = channelTokenAccess.map(function (tk) {
      return [tk.address, ethers.parseUnits(String(tk.value), tk.decimals || 0)];
    });

    var coder = ethers.AbiCoder.defaultAbiCoder();
    var configData = coder.encode(
      ['tuple(address,uint256)[]', 'tuple(uint8,address,uint256,uint256,bool)[]', 'tuple(address,uint256)[]'],
      [royaltyTuples, planTuples, tokenAccessTuples]
    );

    var iface = new ethers.Interface(ABI.CHANNEL_FACTORY);
    var callData = iface.encodeFunctionData('createChannel', [
      CHANNEL_TYPE.STANDARD,
      CHANNEL_SCOPE.PRIVATE,
      channelName,
      'ipfs://' + metaCid,
      configData,
    ]);

    var txHash;
    var channelAddr = null;

    if (walletChoice === 'sa' && hasSmartAccount()) {
      var feeHex = feeInfo.fee && BigInt(feeInfo.fee) > 0n ? '0x' + BigInt(feeInfo.fee).toString(16) : '0x0';
      var batchResult = await parentExecuteSmartAccountBatch(BASE_CHAIN_ID, [
        { to: CONTRACTS.CHANNEL_FACTORY, data: callData, value: feeHex },
      ], []);
      txHash = batchResult.transactionHash || batchResult.transactionId;
      console.log('[Creator] createChannel SA batch tx:', txHash);

      // UA batch hashes can't be resolved by standard eth_getTransactionReceipt.
      // Poll findRecentChannel instead (queries ChannelCreated events on-chain).
      var pollStart = Date.now();
      var pollMax = 60000;
      while (!channelAddr && Date.now() - pollStart < pollMax) {
        await new Promise(function (r) { setTimeout(r, 5000); });
        channelAddr = await findRecentChannel(creatorAddr);
        if (channelAddr) break;
        console.log('[Creator] Waiting for SA channel to appear on-chain...');
      }
      if (!channelAddr) {
        throw new Error('Channel created via Agent Account but could not determine address. Check BaseScan tx: ' + txHash);
      }
      console.log('[Creator] SA Channel created at:', channelAddr);
    } else {
      txHash = await sendTx(CONTRACTS.CHANNEL_FACTORY, callData, feeInfo.fee);
      console.log('[Creator] createChannel tx:', txHash);

      var receipt = await waitForReceipt(txHash);
      if (Number(receipt.status) === 0) {
        throw new Error('createChannel transaction reverted');
      }

      var event = parseChannelCreatedEvent(receipt);
      channelAddr = event ? event.channelAddr : null;

      if (!channelAddr) {
        throw new Error('Channel created but could not parse ChannelCreated event. Tx: ' + txHash);
      }
      console.log('[Creator] Channel created at:', channelAddr);
    }

    try {
      await registerChannelWithBackend({
        name: channelName,
        address: channelAddr,
        description: channelDesc,
        plans: channelPlans.map(function (p) {
          var durOpt = DURATION_OPTIONS.find(function (d) { return d.value === p.duration.value && d.unit === p.duration.unit; });
          return { price: p.price, payToken: p.payToken, duration: durOpt ? durOpt.seconds : 2592000, label: p.label };
        }),
        tokenAccess: channelTokenAccess.map(function (tk) {
          return { address: tk.address, value: parseFloat(String(tk.value)) };
        }),
        categories: [],
        creator: creatorAddr,
        txHash: txHash,
      });
      console.log('[Creator] Channel registered with Elacity backend');
    } catch (regErr) {
      console.warn('[Creator] Backend registration failed (channel still works on-chain):', regErr.message);
    }

    // Trigger local PC2 indexer so the new channel appears in the dropdown
    // immediately on next loadChannels() call (no 5-minute wait).
    invalidateChannelCache(creatorAddr);
    triggerLocalReindex();

    return { address: channelAddr, name: channelName, txHash: txHash, ownerType: walletChoice };
  }

  async function findRecentChannel(ownerAddress) {
    var iface = new ethers.Interface(ABI.CHANNEL_FACTORY);
    var eventTopic = iface.getEvent('ChannelCreated').topicHash;
    var ownerTopic = '0x000000000000000000000000' + ownerAddress.toLowerCase().slice(2);
    try {
      var blockResp = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      var blockJson = await blockResp.json();
      var currentBlock = parseInt(blockJson.result, 16);
      var fromBlock = '0x' + Math.max(0, currentBlock - 200).toString(16);

      var resp = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getLogs',
          params: [{
            address: CONTRACTS.CHANNEL_FACTORY,
            topics: [eventTopic, null, null, ownerTopic],
            fromBlock: fromBlock,
            toBlock: 'latest',
          }],
        }),
      });
      var json = await resp.json();
      var logs = json.result || [];
      if (logs.length > 0) {
        var parsed = iface.parseLog({ topics: logs[logs.length - 1].topics, data: logs[logs.length - 1].data });
        if (parsed && parsed.name === 'ChannelCreated') return parsed.args.channel;
      }
    } catch (_) { }
    return null;
  }

  // ── Elacity backend auth (nonce-sign-login) ──────────

  var elacityAuthCache = { token: null, address: null };

  async function elacityGraphQL(query, variables) {
    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables }),
    });
    if (!resp.ok) throw new Error('Elacity GraphQL ' + resp.status);
    var json = await resp.json();
    if (json.errors && json.errors.length > 0) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function getElacityAuthToken(walletAddress) {
    var addr = walletAddress.toLowerCase();
    if (elacityAuthCache.token && elacityAuthCache.address === addr) {
      return elacityAuthCache.token;
    }

    var nonceData = await elacityGraphQL(
      'query GetNonce($address: String!) { getNonce(address: $address) }',
      { address: addr }
    );
    var nonce = nonceData.getNonce;
    console.log('[Creator] Elacity nonce:', nonce);

    var msg = 'Approve signature on https://ela.city with nonce ' + (nonce || 0);
    var hexMsg = '0x' + Array.from(new TextEncoder().encode(msg))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
    var signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [hexMsg, addr],
    });

    var loginVars = { address: addr, signature: signature };
    var sa = smartAccountAddress || null;
    var loginMutation = sa
      ? 'mutation UserLogin($address: String!, $signature: String!, $sa: String) { userLogin(address: $address, signature: $signature, sa: $sa) { token address alias } }'
      : 'mutation UserLogin($address: String!, $signature: String!) { userLogin(address: $address, signature: $signature) { token address alias } }';
    if (sa) loginVars.sa = sa;
    var loginData = await elacityGraphQL(loginMutation, loginVars);

    var token = loginData.userLogin.token;
    elacityAuthCache = { token: token, address: addr };
    console.log('[Creator] Elacity auth token obtained');
    return token;
  }

  async function registerChannelWithBackend(params) {
    var mutation = [
      'mutation CreateChannel($input: ChannelInput) {',
      '  created: createChannel(input: $input) {',
      '    _id name address imageURL coverImageURL',
      '  }',
      '}',
    ].join('\n');

    var input = {
      name: params.name,
      address: params.address,
      description: params.description || '',
      creator: params.creator.toLowerCase(),
      scope: String(CHANNEL_SCOPE.PRIVATE),
      channelType: String(CHANNEL_TYPE.STANDARD),
      image: params.image || '',
      coverImage: params.coverImage || '',
      categories: params.categories || [],
      plans: params.plans || [],
      tokenAccess: params.tokenAccess || [],
    };

    var authToken = await getElacityAuthToken(state.walletAddress);

    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Transaction-Id': params.txHash,
        'Authorization': 'Bearer ' + authToken,
      },
      body: JSON.stringify({
        query: mutation,
        variables: { input: input },
      }),
    });

    if (!resp.ok) {
      throw new Error('GraphQL request failed: ' + resp.status);
    }

    var data = await resp.json();
    if (data.errors && data.errors.length > 0) {
      throw new Error('GraphQL error: ' + data.errors[0].message);
    }

    return data.data ? data.data.created : null;
  }

  // ── Tab Switching ──────────────────────────────────────

  function switchTab(tabName) {
    var mintView = document.getElementById('main');
    var channelsView = document.getElementById('channels-view');
    var tabs = document.querySelectorAll('.header-tab');
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === tabName); });

    if (tabName === 'mint') {
      mintView.style.display = '';
      channelsView.style.display = 'none';
    } else {
      mintView.style.display = 'none';
      channelsView.style.display = '';
      populateManageChannelSelector();
    }
  }

  function populateManageChannelSelector() {
    var src = document.getElementById('asset-channel');
    var dst = document.getElementById('manage-channel-select');
    if (!src || !dst) return;

    var contentEl = document.getElementById('channels-view-content');
    var loadingEl = document.getElementById('channels-view-loading');

    if (!state.walletAddress || !state.channelsLoaded) {
      contentEl.style.display = 'none';
      loadingEl.style.display = '';
      return;
    }
    loadingEl.style.display = 'none';
    contentEl.style.display = '';

    var prevValue = dst.value;
    dst.innerHTML = '';
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— Select a channel to manage —';
    dst.appendChild(defaultOpt);

    var count = 0;
    for (var i = 0; i < src.options.length; i++) {
      var o = src.options[i];
      if (!o.value || o.value === '__custom__' || !ethers.isAddress(o.value)) continue;
      if (!o.getAttribute('data-owner')) continue;
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.textContent;
      dst.appendChild(opt);
      count++;
    }

    if (prevValue && dst.querySelector('option[value="' + prevValue + '"]')) {
      dst.value = prevValue;
    }

    var emptyMsg = document.getElementById('channels-view-empty');
    if (emptyMsg) emptyMsg.style.display = count === 0 ? '' : 'none';
  }

  // ── Channel Management UI ──────────────────────────────

  var managedChannelData = null;

  async function showChannelManagement() {
    var sel = document.getElementById('manage-channel-select');
    var addr = sel ? sel.value : '';
    if (!addr || !ethers.isAddress(addr)) return;

    var section = document.getElementById('channel-manage-section');
    var loading = document.getElementById('manage-loading');
    var content = document.getElementById('manage-content');
    section.style.display = '';
    loading.style.display = '';
    content.style.display = 'none';

    try {
      managedChannelData = await retrieveChannelFromBackend(addr);
      if (!managedChannelData) throw new Error('Channel not found');

      document.getElementById('manage-channel-name').value = managedChannelData.name || '';
      document.getElementById('manage-channel-description').value = managedChannelData.description || '';

      loadManagePlans(managedChannelData.plans || []);
      loadManageTokenGates(managedChannelData.tokenAccess || []);

      loading.style.display = 'none';
      content.style.display = '';
    } catch (err) {
      loading.innerHTML = '<p style="color:var(--error); font-size:13px;">Error: ' + err.message + '</p>';
    }
  }

  function hideChannelManagement() {
    var section = document.getElementById('channel-manage-section');
    if (section) section.style.display = 'none';
    managedChannelData = null;
    setManageStatus('manage-details-status', '');
    setManageStatus('manage-plans-status', '');
    setManageStatus('manage-gates-status', '');
  }

  function setManageStatus(id, msg, isError) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--error)' : 'var(--success)';
  }

  async function saveChannelDetails() {
    if (!managedChannelData) return;
    var name = document.getElementById('manage-channel-name').value.trim();
    var description = document.getElementById('manage-channel-description').value.trim();
    if (!name) { setManageStatus('manage-details-status', 'Name is required', true); return; }

    setManageStatus('manage-details-status', 'Saving...');
    try {
      await updateChannelInfoOnBackend(managedChannelData.address, { name: name, description: description });
      setManageStatus('manage-details-status', 'Saved!');
      managedChannelData.name = name;
      managedChannelData.description = description;

      ['asset-channel', 'manage-channel-select'].forEach(function (selId) {
        var sel = document.getElementById(selId);
        if (!sel) return;
        var opt = sel.querySelector('option[value="' + managedChannelData.address + '"]');
        if (opt) opt.textContent = name;
      });
    } catch (err) {
      setManageStatus('manage-details-status', 'Error: ' + err.message, true);
    }
  }

  function loadManagePlans(plans) {
    var container = document.getElementById('manage-plans-container');
    container.innerHTML = '';
    var countEl = document.getElementById('manage-plans-count');
    if (countEl) countEl.textContent = plans.length > 0 ? '(' + plans.length + ' plans)' : '';

    plans.forEach(function (plan) {
      addManagePlanRow(plan);
    });
  }

  function addManagePlanRow(plan) {
    var container = document.getElementById('manage-plans-container');
    var row = document.createElement('div');
    row.className = 'plan-row';
    row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
    if (plan.planId) row.setAttribute('data-plan-id', plan.planId);

    var dur = plan.duration || {};
    var durLabel = dur.value && dur.unit ? dur.value + ' ' + dur.unit : '1 Month';
    var durOptions = DURATION_OPTIONS.map(function (d) {
      var matchLabel = d.label;
      var sel = (d.value === dur.value && d.unit === dur.unit) || matchLabel === durLabel ? ' selected' : '';
      return '<option value="' + d.label + '"' + sel + '>' + d.label + '</option>';
    }).join('');

    var payToken = plan.payToken || USDC_BASE;
    var currencyOptions = CURRENCIES.map(function (c) {
      var sel = c.address.toLowerCase() === payToken.toLowerCase() ? ' selected' : '';
      return '<option value="' + c.address + '"' + sel + '>' + c.symbol + '</option>';
    }).join('');

    row.innerHTML =
      '<select class="plan-duration" style="width:110px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);">' + durOptions + '</select>' +
      '<input class="plan-price" type="number" min="0.01" step="0.01" value="' + (plan.price || '5') + '" placeholder="Price" style="width:80px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text); text-align:right;" />' +
      '<select class="plan-currency" style="width:72px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);">' + currencyOptions + '</select>' +
      '<input class="plan-label" type="text" placeholder="Description" value="' + (plan.description || plan.label || '') + '" style="flex:1; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);" />' +
      '<button type="button" class="manage-plan-save" title="Save" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; font-size:14px; line-height:1; font-family:inherit; background:var(--accent); color:white; border:none; border-radius:4px; cursor:pointer;">&#10003;</button>' +
      '<button type="button" class="manage-plan-remove" title="Remove" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; font-size:14px; line-height:1; font-family:inherit; background:var(--error); color:white; border:none; border-radius:4px; cursor:pointer;">&times;</button>';

    container.appendChild(row);

    row.querySelector('.manage-plan-save').addEventListener('click', function () {
      var planId = row.getAttribute('data-plan-id');
      if (planId) {
        saveEditPlan(managedChannelData.address, planId, row);
      } else {
        saveAddPlan(managedChannelData.address, row);
      }
    });
    row.querySelector('.manage-plan-remove').addEventListener('click', function () {
      var planId = row.getAttribute('data-plan-id');
      if (planId) {
        removePlan(managedChannelData.address, planId, row);
      } else {
        row.remove();
      }
    });
  }

  function readPlanRowData(row) {
    var durLabel = row.querySelector('.plan-duration').value;
    var durOpt = DURATION_OPTIONS.find(function (d) { return d.label === durLabel; });
    var price = row.querySelector('.plan-price').value;
    var payToken = row.querySelector('.plan-currency').value;
    var description = row.querySelector('.plan-label').value;
    return {
      label: durLabel,
      description: description || durLabel,
      duration: durOpt ? { value: durOpt.value, unit: durOpt.unit } : { value: 1, unit: 'months' },
      price: price,
      payToken: payToken,
    };
  }

  async function saveAddPlan(channelAddress, row) {
    var data = readPlanRowData(row);
    setManageStatus('manage-plans-status', 'Adding plan...');
    try {
      var result = await updateSubscriptionPlanOnBackend(channelAddress, [{ action: 'ADD', args: data }]);
      setManageStatus('manage-plans-status', 'Plan added!');
      if (result && result.plans && result.plans.length > 0) {
        var lastPlan = result.plans[result.plans.length - 1];
        if (lastPlan && lastPlan.planId) row.setAttribute('data-plan-id', lastPlan.planId);
        managedChannelData.plans = result.plans;
        var countEl = document.getElementById('manage-plans-count');
        if (countEl) countEl.textContent = '(' + result.plans.length + ' plans)';
      }
    } catch (err) {
      setManageStatus('manage-plans-status', 'Error: ' + err.message, true);
    }
  }

  async function saveEditPlan(channelAddress, planId, row) {
    var data = readPlanRowData(row);
    data.planId = planId;
    setManageStatus('manage-plans-status', 'Updating plan...');
    try {
      var result = await updateSubscriptionPlanOnBackend(channelAddress, [{ action: 'UPDATE', args: data }]);
      setManageStatus('manage-plans-status', 'Plan updated!');
      if (result && result.plans) managedChannelData.plans = result.plans;
    } catch (err) {
      setManageStatus('manage-plans-status', 'Error: ' + err.message, true);
    }
  }

  async function removePlan(channelAddress, planId, row) {
    if (!confirm('Remove this plan?')) return;
    setManageStatus('manage-plans-status', 'Removing plan...');
    try {
      var result = await updateSubscriptionPlanOnBackend(channelAddress, [{ action: 'REMOVE', args: { planId: planId } }]);
      row.remove();
      setManageStatus('manage-plans-status', 'Plan removed!');
      if (result && result.plans) {
        managedChannelData.plans = result.plans;
        var countEl = document.getElementById('manage-plans-count');
        if (countEl) countEl.textContent = result.plans.length > 0 ? '(' + result.plans.length + ' plans)' : '';
      }
    } catch (err) {
      setManageStatus('manage-plans-status', 'Error: ' + err.message, true);
    }
  }

  function loadManageTokenGates(tokenAccess) {
    var container = document.getElementById('manage-gates-container');
    container.innerHTML = '';
    var countEl = document.getElementById('manage-gates-count');
    if (countEl) countEl.textContent = tokenAccess.length > 0 ? '(' + tokenAccess.length + ' rules)' : '';

    tokenAccess.forEach(function (gate) {
      addManageGateRow(gate);
    });
  }

  function addManageGateRow(gate) {
    var container = document.getElementById('manage-gates-container');
    var row = document.createElement('div');
    row.className = 'token-gate-row';
    row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
    row.innerHTML =
      '<input class="gate-address" type="text" placeholder="0x... token contract" value="' + (gate.address || '') + '" style="flex:1; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);" />' +
      '<input class="gate-value" type="number" min="1" step="1" value="' + (gate.value || '1') + '" placeholder="Min balance" style="width:80px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text); text-align:right;" />' +
      '<span class="gate-info" style="font-size:11px; color:var(--text-muted); min-width:60px;"></span>' +
      '<button type="button" class="gate-remove" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; font-size:14px; line-height:1; font-family:inherit; background:var(--error); color:white; border:none; border-radius:4px; cursor:pointer;">&times;</button>';
    container.appendChild(row);

    row.querySelector('.gate-remove').addEventListener('click', function () { row.remove(); });

    var addrInput = row.querySelector('.gate-address');
    var infoSpan = row.querySelector('.gate-info');
    if (gate.address && ethers.isAddress(gate.address)) {
      (async function () {
        try {
          var iface = new ethers.Interface(ERC20_ABI);
          var nameData = await rpcCall(gate.address, iface.encodeFunctionData('symbol', []));
          var sym = iface.decodeFunctionResult('symbol', nameData)[0];
          infoSpan.textContent = sym;
          infoSpan.style.color = 'var(--success)';
        } catch (_) { infoSpan.textContent = 'NFT?'; infoSpan.style.color = 'var(--text-muted)'; }
      })();
    }
    addrInput.addEventListener('blur', async function () {
      var addr = addrInput.value.trim();
      if (!addr || !ethers.isAddress(addr)) { infoSpan.textContent = ''; return; }
      try {
        var iface = new ethers.Interface(ERC20_ABI);
        var nameData = await rpcCall(addr, iface.encodeFunctionData('symbol', []));
        var sym = iface.decodeFunctionResult('symbol', nameData)[0];
        infoSpan.textContent = sym;
        infoSpan.style.color = 'var(--success)';
      } catch (_) { infoSpan.textContent = 'NFT?'; infoSpan.style.color = 'var(--text-muted)'; }
    });
  }

  async function saveTokenGates() {
    if (!managedChannelData) return;
    var rows = document.querySelectorAll('#manage-gates-container .token-gate-row');
    var thresholds = [];
    for (var i = 0; i < rows.length; i++) {
      var addr = rows[i].querySelector('.gate-address').value.trim();
      var val = rows[i].querySelector('.gate-value').value.trim();
      if (!addr || !ethers.isAddress(addr)) continue;
      thresholds.push({ address: addr, value: val || '1' });
    }
    setManageStatus('manage-gates-status', 'Saving...');
    try {
      await updateChannelInfoOnBackend(managedChannelData.address, { tokenAccess: thresholds });
      managedChannelData.tokenAccess = thresholds;
      loadManageTokenGates(thresholds);
      setManageStatus('manage-gates-status', 'Saved!');
    } catch (err) {
      setManageStatus('manage-gates-status', 'Error: ' + err.message, true);
    }
  }

  function parseAssetCreatedEvent(receipt, channelAddress) {
    var iface = new ethers.Interface(ABI.DIGITAL_ASSET);
    var logs = receipt.logs || [];

    for (var i = 0; i < logs.length; i++) {
      try {
        var parsed = iface.parseLog({ topics: logs[i].topics, data: logs[i].data });
        if (parsed && parsed.name === 'AssetCreated') {
          return {
            tokenId: parsed.args._tokenId.toString(),
            creator: parsed.args._creator,
            tokenURI: parsed.args._tokenURI,
            opType: Number(parsed.args._opType),
            opContract: parsed.args.opContract,
          };
        }
      } catch (_) { /* not our event */ }
    }

    // Fallback: the proxy implementation may emit events with different signatures.
    // Extract operative from ContractCreated and tokenId from the channel's TransferSingle.
    var CONTRACT_CREATED_TOPIC = '0x2d49c67975aadd2d389580b368cfff5b49965b0bd5da33c144922ce01e7a4d7b';
    var TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
    var ZERO_TOPIC = '0x' + '0'.repeat(64);
    var channelLower = channelAddress ? channelAddress.toLowerCase() : '';

    var opContract = null;
    var tokenId = null;

    for (var i = 0; i < logs.length; i++) {
      var log = logs[i];
      if (!log.topics || log.topics.length < 1) continue;

      if (log.topics[0] === CONTRACT_CREATED_TOPIC && log.topics.length >= 3) {
        opContract = ethers.getAddress('0x' + log.topics[2].slice(26));
      }

      if (log.topics[0] === TRANSFER_SINGLE_TOPIC
        && log.topics.length >= 4
        && log.topics[2] === ZERO_TOPIC
        && log.address && log.address.toLowerCase() === channelLower) {
        try {
          tokenId = BigInt('0x' + log.data.slice(2, 66)).toString();
        } catch (_) { }
      }
    }

    if (opContract || tokenId) {
      console.log('[Creator] Fallback event parse — tokenId:', tokenId, 'opContract:', opContract);
      return { tokenId: tokenId, creator: null, tokenURI: null, opType: null, opContract: opContract };
    }

    return null;
  }

  // ── Form data helpers ────────────────────────────────

  function getSelectedCategories() {
    var primary = dom.assetCategory.value;
    return primary ? [primary] : [];
  }

  function getSelectedTags() {
    var el = document.getElementById('asset-tags');
    if (!el || !el.value.trim()) return [];
    return el.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function getResellerCut() {
    var el = document.getElementById('reseller-cut');
    if (!el) return 900;
    return parseInt(el.value) || 900;
  }

  function getSelectedCurrencyAddress() {
    var el = document.getElementById('asset-currency');
    if (!el) return USDC_BASE;
    return el.value || USDC_BASE;
  }

  var priceCurrency = USDC_BASE;

  function getRoyaltyPartners() {
    var rows = document.querySelectorAll('.royalty-row');
    if (!rows || rows.length === 0) {
      return [{ address: state.walletAddress, royalty: 100 - ELACITY_ROYALTY_PERCENT, identifier: 'A' }];
    }
    var partners = [];
    rows.forEach(function (row) {
      var addrEl = row.querySelector('.royalty-address');
      var pctEl = row.querySelector('.royalty-percent');
      var roleEl = row.querySelector('.royalty-role');
      if (addrEl && pctEl) {
        var addr = addrEl.value.trim();
        var pct = parseFloat(pctEl.value);
        if (addr && pct > 0) {
          partners.push({
            address: addr,
            royalty: pct,
            identifier: roleEl ? roleEl.value : (partners.length === 0 ? 'A' : 'B'),
            key: roleEl ? roleEl.value : undefined,
          });
        }
      }
    });
    if (partners.length === 0) {
      return [{ address: state.walletAddress, royalty: 100 - ELACITY_ROYALTY_PERCENT, identifier: 'A' }];
    }
    return partners;
  }

  function getChannelPlans() {
    var rows = document.querySelectorAll('.plan-row');
    if (!rows || rows.length === 0) return [];
    var plans = [];
    rows.forEach(function (row) {
      var priceEl = row.querySelector('.plan-price');
      var durEl = row.querySelector('.plan-duration');
      var labelEl = row.querySelector('.plan-label');
      var currEl = row.querySelector('.plan-currency');
      if (priceEl && durEl) {
        var durOpt = DURATION_OPTIONS.find(function (d) { return d.label === durEl.value; }) || DURATION_OPTIONS[2];
        var tokenAddr = currEl ? currEl.value : USDC_BASE;
        plans.push({
          price: priceEl.value || '0',
          payToken: tokenAddr,
          duration: { value: durOpt.value, unit: durOpt.unit },
          label: durOpt.label,
          description: labelEl ? labelEl.value : durOpt.label + ' plan',
        });
      }
    });
    return plans;
  }

  function getTokenAccessThresholds() {
    var rows = document.querySelectorAll('.token-gate-row');
    if (!rows || rows.length === 0) return [];
    var thresholds = [];
    rows.forEach(function (row) {
      var addrEl = row.querySelector('.token-gate-address');
      var valEl = row.querySelector('.token-gate-value');
      if (addrEl && valEl) {
        var addr = addrEl.value.trim();
        var val = parseFloat(valEl.value);
        if (addr && val > 0 && ethers.isAddress(addr)) {
          thresholds.push({ address: addr, value: val, decimals: 0 });
        }
      }
    });
    return thresholds;
  }

  function validateRoyaltyTotal() {
    var partners = getRoyaltyPartners();
    var total = partners.reduce(function (sum, r) { return sum + Number(r.royalty); }, 0) + ELACITY_ROYALTY_PERCENT;
    return Math.abs(total - 100) < 0.01;
  }

  function updateRevenueCalc() {
    var priceEl = dom.assetPrice;
    var copiesEl = dom.assetCopies;
    var calcEl = document.getElementById('revenue-calc');
    if (!calcEl || !priceEl || !copiesEl) return;
    var p = parseFloat(priceEl.value) || 0;
    var c = parseInt(copiesEl.value) || 0;
    var total = (p * c).toFixed(2);
    calcEl.textContent = 'Potential revenue: ' + c + ' × $' + p.toFixed(2) + ' = $' + total;
  }

  // ── Licensing helpers ────────────────────────────────

  function wireCardSelector(containerId, hiddenInputId, onChange) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.addEventListener('click', function (e) {
      var card = e.target.closest('.access-card');
      if (!card) return;
      container.querySelectorAll('.access-card').forEach(function (c) { c.classList.remove('selected'); });
      card.classList.add('selected');
      var val = card.getAttribute('data-value');
      if (hiddenInputId) {
        var hidden = document.getElementById(hiddenInputId);
        if (hidden) {
          hidden.value = val;
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (onChange) onChange(val);
    });
  }

  function getLicensingData() {
    var terms = {
      commercial: true,
      modification: false,
      redistribution: false,
      attribution: true,
      exclusivity: false,
    };

    var aiTrainingToggle = document.getElementById('ai-training-toggle');
    var isAITrainingEnabled = aiTrainingToggle ? aiTrainingToggle.classList.contains('active') : false;

    if (!isAITrainingEnabled) {
      return { type: 'perpetual', terms: terms };
    }

    var result = { type: 'training-rights', terms: terms };

    result.aiTraining = {
      permitted: true,
      scope: 'commercial',
      modelTypes: ['llm', 'vision', 'audio', 'code', 'multimodal', 'diffusion', 'embedding'],
      attribution: true,
      derivativeWorks: false,
      outputOwnership: 'licensee',
    };

    return result;
  }

  // ── Pipeline ─────────────────────────────────────────

  async function runPipeline() {
    var usedLocalEncryption = false;

    var pipelineAccessMethod = dom.assetAccess.value;
    var isFreeContent = pipelineAccessMethod === 'free';
    console.log('[Creator] Pipeline starting — accessMethod=' + pipelineAccessMethod + (isFreeContent ? ' (cleartext, no encryption)' : ''));

    updateFloatingProgress('prog-connect', 'Starting pipeline...', 'active');

    dom.progressError.classList.add('hidden');
    if (dom.btnBackTo2) dom.btnBackTo2.disabled = true;

    try {
      if (!state.walletAddress) {
        var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        state.walletAddress = accounts[0];
      }

      // ── Step 1: Encrypt (skipped for free content) ──────
      setProgStep('prog-connect', isFreeContent ? 'Free content — no encryption needed' : 'Connecting...', isFreeContent ? 'done' : 'active');

      var isMediaFile = state.resolvedMime.startsWith('video/') || state.resolvedMime.startsWith('audio/');
      var encryptResult;
      var mediaEncodeResult = null;

      // SHA-256 hash of the original unencrypted file — proof of content integrity
      var originalContentHash = null;
      try {
        var hashSource = isMediaFile
          ? new Uint8Array(await state.selectedFile.arrayBuffer())
          : state.fileBytes;
        if (hashSource) {
          var hashBuf = await crypto.subtle.digest('SHA-256', hashSource);
          var hashArr = Array.from(new Uint8Array(hashBuf));
          originalContentHash = '0x' + hashArr.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          console.log('[Creator] Original content SHA-256:', originalContentHash.substring(0, 20) + '...');
        }
      } catch (hashErr) {
        console.warn('[Creator] Content hash generation failed (non-fatal):', hashErr.message);
      }

      if (isFreeContent) {
        // ── Free content: skip all encryption ──
        setProgStep('prog-encrypt', 'Skipped (free content)', 'done');
        encryptResult = {
          encrypted: null,
          dataToEncryptHash: originalContentHash || '0x0000000000000000000000000000000000000000000000000000000000000000',
          actionCid: '',
          conditions: null,
          litCiphertext: '',
          iv: '',
          litBackend: 'none',
          cleartext: true,
        };
        console.log('[Creator] Free content — encryption skipped, using content hash as ID');

        if (isMediaFile) {
          // Media still needs transcode + DASH packaging but WITHOUT CENC
          swapProgressStepsForMedia();
          setProgStep('prog-connect', 'Uploading file to encoder...', 'active');
          console.log('[Creator] Free media file — transcode + DASH (no CENC)');

          var formData = new FormData();
          formData.append('file', state.selectedFile);
          formData.append('skipCenc', 'true');

          var previewEnabled = document.getElementById('preview-enabled');
          var previewDurSlider = document.getElementById('preview-duration');
          if (previewEnabled && previewEnabled.checked && previewDurSlider) {
            formData.append('previewDuration', previewDurSlider.value);
          }

          var encodeResp = await pc2Fetch('/api/media/encode', {
            method: 'POST',
            body: formData,
          });
          if (!encodeResp.ok) {
            var encErrBody = await encodeResp.json().catch(function () { return {}; });
            throw new Error(encErrBody.error || 'Media encode failed: ' + encodeResp.status);
          }
          var encodeData = await encodeResp.json();
          var jobId = encodeData.jobId;
          console.log('[Creator] Encode job started (cleartext):', jobId);
          setProgStep('prog-connect', 'Uploaded — job ' + jobId.substring(0, 8) + '...', 'done');
          setProgStep('prog-encrypt', 'Transcoding (no encryption)...', 'active');
          setMediaSubStep('analyze', 'active', '');

          var pollInterval = 1500;
          var maxPollTime = 4 * 60 * 60 * 1000;
          var pollStart = Date.now();
          var lastStage = '';

          while (true) {
            await new Promise(function (r) { setTimeout(r, pollInterval); });
            var statusResp = await pc2Fetch('/api/media/encode/status/' + jobId);
            if (!statusResp.ok) throw new Error('Failed to check encode status');
            var statusData = await statusResp.json();

            if (statusData.status === 'error') {
              var failedSub = STAGE_TO_SUB[lastStage] || 'analyze';
              setMediaSubStep(failedSub, 'error', statusData.error || 'failed');
              throw new Error('Media encoding failed: ' + (statusData.error || 'unknown error'));
            }
            if (statusData.status === 'complete') {
              mediaEncodeResult = statusData.result;
              MEDIA_SUB_STEPS.forEach(function (id) { setMediaSubStep(id, 'done', ''); });
              setMediaProgress(100, Math.round((Date.now() - pollStart) / 1000));
              setProgStep('prog-encrypt', 'Complete (cleartext)', 'done');
              console.log('[Creator] Media encoding complete (cleartext):', mediaEncodeResult);
              break;
            }

            var stage = statusData.progress?.stage || statusData.status;
            var elapsed = Math.round((Date.now() - pollStart) / 1000);
            var pct = STAGE_PROGRESS[stage] || 0;

            if (stage !== lastStage) {
              var curSubIdx = MEDIA_SUB_STEPS.indexOf(STAGE_TO_SUB[stage]);
              if (curSubIdx > 0) {
                for (var si = 0; si < curSubIdx; si++) {
                  setMediaSubStep(MEDIA_SUB_STEPS[si], 'done', '');
                }
              }
            }
            var curSub = STAGE_TO_SUB[stage];
            if (curSub) {
              var speed = statusData.progress?.speed || '';
              var fps = statusData.progress?.fps || 0;
              var timeStr = statusData.progress?.time || '';
              var subBarPct = 50;
              var subInfo = '';
              if (stage === 'transcoding') {
                var parts = [];
                if (speed && speed !== '0x') parts.push(speed);
                if (fps > 0) parts.push(Math.round(fps) + ' fps');
                if (timeStr && timeStr !== '00:00:00.00') parts.push(timeStr);
                subInfo = parts.join(' · ');
                if (timeStr && timeStr !== '00:00:00.00') {
                  var tParts = timeStr.split(':');
                  var tSec = parseInt(tParts[0]) * 3600 + parseInt(tParts[1]) * 60 + parseFloat(tParts[2]);
                  var estPct = Math.min(5 + (tSec / 120) * 55, 58);
                  pct = Math.max(pct, estPct);
                  subBarPct = Math.min(Math.round((tSec / 120) * 100), 95);
                }
              }
              setMediaSubStep(curSub, 'active', subInfo);
              var subBarEl = document.getElementById('media-sub-' + curSub + '-bar');
              if (subBarEl) subBarEl.style.width = subBarPct + '%';
            }

            lastStage = stage;
            setMediaProgress(pct, elapsed);
            var headerLabel = stage === 'transcoding' ? 'Transcoding...' :
              stage === 'analyzing' ? 'Analyzing...' :
                stage === 'fragmenting' ? 'Fragmenting...' :
                  stage === 'packaging' ? 'Packaging (no encryption)...' :
                    stage === 'uploading' ? 'Uploading to IPFS...' : 'Processing...';
            setProgStep('prog-encrypt', headerLabel, 'active');

            if (Date.now() - pollStart > maxPollTime) {
              throw new Error('Media encoding timed out after ' + (maxPollTime / 3600000) + ' hours');
            }
            if (pollInterval < 3000) pollInterval = Math.min(pollInterval + 300, 3000);
          }

          encryptResult.dataToEncryptHash = mediaEncodeResult.dataToEncryptHash || originalContentHash || '';
        }

      } else if (isMediaFile) {
        // ── Media Path: Encode + CENC encrypt via backend pipeline ──
        swapProgressStepsForMedia();

        setProgStep('prog-connect', 'Uploading file to encoder...', 'active');
        console.log('[Creator] Media file detected (' + state.resolvedMime + '), routing through /api/media/encode');

        var formData = new FormData();
        formData.append('file', state.selectedFile);

        var previewEnabled = document.getElementById('preview-enabled');
        var previewDurSlider = document.getElementById('preview-duration');
        if (previewEnabled && previewEnabled.checked && previewDurSlider) {
          formData.append('previewDuration', previewDurSlider.value);
        }

        var encodeResp = await pc2Fetch('/api/media/encode', {
          method: 'POST',
          body: formData,
        });
        if (!encodeResp.ok) {
          var encErrBody = await encodeResp.json().catch(function () { return {}; });
          throw new Error(encErrBody.error || 'Media encode failed: ' + encodeResp.status);
        }
        var encodeData = await encodeResp.json();
        var jobId = encodeData.jobId;
        console.log('[Creator] Encode job started:', jobId);
        setProgStep('prog-connect', 'Uploaded — job ' + jobId.substring(0, 8) + '...', 'done');
        setProgStep('prog-encrypt', 'Starting...', 'active');
        setMediaSubStep('analyze', 'active', '');

        // Poll for completion with detailed sub-step display
        var pollInterval = 1500;
        var maxPollTime = 4 * 60 * 60 * 1000;
        var pollStart = Date.now();
        var lastStage = '';

        while (true) {
          await new Promise(function (r) { setTimeout(r, pollInterval); });
          var statusResp = await pc2Fetch('/api/media/encode/status/' + jobId);
          if (!statusResp.ok) throw new Error('Failed to check encode status');
          var statusData = await statusResp.json();

          if (statusData.status === 'error') {
            var failedSub = STAGE_TO_SUB[lastStage] || 'analyze';
            setMediaSubStep(failedSub, 'error', statusData.error || 'failed');
            throw new Error('Media encoding failed: ' + (statusData.error || 'unknown error'));
          }
          if (statusData.status === 'complete') {
            mediaEncodeResult = statusData.result;
            // Mark all remaining as done
            MEDIA_SUB_STEPS.forEach(function (id) { setMediaSubStep(id, 'done', ''); });
            setMediaProgress(100, Math.round((Date.now() - pollStart) / 1000));
            setProgStep('prog-encrypt', 'Complete', 'done');
            console.log('[Creator] Media encoding complete:', mediaEncodeResult);
            break;
          }

          // Track stage transitions
          var stage = statusData.progress?.stage || statusData.status;
          var elapsed = Math.round((Date.now() - pollStart) / 1000);
          var pct = STAGE_PROGRESS[stage] || 0;

          // If stage changed, mark ALL prior sub-steps as done (not just the
          // immediate predecessor) to handle fast transitions between polls.
          if (stage !== lastStage) {
            var curSubIdx = MEDIA_SUB_STEPS.indexOf(STAGE_TO_SUB[stage]);
            if (curSubIdx > 0) {
              for (var si = 0; si < curSubIdx; si++) {
                setMediaSubStep(MEDIA_SUB_STEPS[si], 'done', '');
              }
            }
          }
          var curSub = STAGE_TO_SUB[stage];
          if (curSub) {
            var speed = statusData.progress?.speed || '';
            var fps = statusData.progress?.fps || 0;
            var timeStr = statusData.progress?.time || '';
            var subBarPct = 50;

            var subInfo = '';
            if (stage === 'transcoding') {
              var parts = [];
              if (speed && speed !== '0x') parts.push(speed);
              if (fps > 0) parts.push(Math.round(fps) + ' fps');
              if (timeStr && timeStr !== '00:00:00.00') parts.push(timeStr);
              subInfo = parts.join(' · ');

              if (timeStr && timeStr !== '00:00:00.00') {
                var tParts = timeStr.split(':');
                var tSec = parseInt(tParts[0]) * 3600 + parseInt(tParts[1]) * 60 + parseFloat(tParts[2]);
                var estPct = Math.min(5 + (tSec / 120) * 55, 58);
                pct = Math.max(pct, estPct);
                subBarPct = Math.min(Math.round((tSec / 120) * 100), 95);
              }
            }

            setMediaSubStep(curSub, 'active', subInfo);
            var subBarEl = document.getElementById('media-sub-' + curSub + '-bar');
            if (subBarEl) subBarEl.style.width = subBarPct + '%';
          }

          lastStage = stage;
          setMediaProgress(pct, elapsed);

          // Header status
          var headerLabel = stage === 'transcoding' ? 'Transcoding...' :
            stage === 'analyzing' ? 'Analyzing...' :
              stage === 'fragmenting' ? 'Fragmenting...' :
                stage === 'packaging' ? 'Encrypting & packaging...' :
                  stage === 'uploading' ? 'Uploading to IPFS...' : 'Processing...';
          setProgStep('prog-encrypt', headerLabel, 'active');

          if (Date.now() - pollStart > maxPollTime) {
            throw new Error('Media encoding timed out after ' + (maxPollTime / 3600000) + ' hours');
          }

          if (pollInterval < 3000) pollInterval = Math.min(pollInterval + 300, 3000);
        }

        // Media pipeline produces its own CID, CEK, etc.
        encryptResult = {
          encrypted: null,
          dataToEncryptHash: mediaEncodeResult.dataToEncryptHash || '',
          actionCid: '',
          conditions: null,
          litCiphertext: mediaEncodeResult.ciphertext || '',
          iv: '',
          litBackend: 'chipotle',
        };

      } else {
        try {
          setProgStep('prog-connect', 'Connecting to Lit (server-side)...', 'active');
          console.log('[Creator] Encrypting via backend Lit endpoint...');

          var fileBase64 = uint8ToBase64(state.fileBytes);
          var litResp = await pc2Fetch('/api/storage/lit/encrypt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: fileBase64 }),
          });

          if (!litResp.ok) {
            var litErrBody = await litResp.json().catch(function () { return {}; });
            throw new Error(litErrBody.error || 'Lit encrypt returned ' + litResp.status);
          }

          var litData = await litResp.json();
          console.log('[Creator] Two-layer encryption succeeded. Hash:', litData.dataToEncryptHash?.substring(0, 20) + '...');
          console.log('[Creator] Action CID:', litData.actionCid);
          console.log('[Creator] AES-encrypted data:', litData.encryptedData?.length, 'chars, IV:', litData.iv);
          setProgStep('prog-connect', 'Lit Connected (' + (litData.litBackend || 'chipotle') + ')', 'done');

          setProgStep('prog-encrypt', 'Encrypting (AES + Lit CEK)...', 'active');
          encryptResult = {
            encrypted: base64ToUint8(litData.encryptedData),
            dataToEncryptHash: litData.dataToEncryptHash,
            actionCid: litData.actionCid,
            conditions: litData.conditions,
            litCiphertext: litData.litCiphertext,
            iv: litData.iv,
            litBackend: litData.litBackend || 'chipotle',
          };
        } catch (litErr) {
          console.error('[Creator] Lit Protocol error:', litErr);
          console.warn('[Creator] Lit server unavailable, using local encryption:', litErr.message);
          setProgStep('prog-connect', 'Local mode (Lit unavailable)', 'done');

          setProgStep('prog-encrypt', 'Encrypting (local AES-GCM)...', 'active');
          encryptResult = await localEncrypt(state.fileBytes);
          usedLocalEncryption = true;
        }
        setProgStep('prog-encrypt', 'Encrypted', 'done');
      } // end else (non-media path)

      // ── Step 2: Upload asset to IPFS ────────
      var assetCid;

      if (isMediaFile && mediaEncodeResult) {
        assetCid = mediaEncodeResult.cid;
        setProgStep('prog-upload-asset', 'CID: ' + assetCid.substring(0, 12) + '... (from encoder)', 'done');
        console.log('[Creator] Media asset CID from encoder:', assetCid);
      } else {
        setProgStep('prog-upload-asset', 'Uploading to local node...', 'active');
        var uploadBytes = isFreeContent ? state.fileBytes : encryptResult.encrypted;
        var assetBase64 = uint8ToBase64(uploadBytes);

        var localAssetResp = await pc2Fetch('/api/storage/ipfs/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: assetBase64, announce: true }),
        });
        if (!localAssetResp.ok) {
          var errBody = await localAssetResp.json().catch(function () { return {}; });
          throw new Error('Local IPFS upload failed: ' + (errBody.error || localAssetResp.status));
        }
        var localAssetData = await localAssetResp.json();
        var localAssetCid = localAssetData.cid;
        console.log('[Creator] Local asset CID:', localAssetCid, isFreeContent ? '(cleartext)' : '(encrypted)');

        setProgStep('prog-upload-asset', 'Pinning to Elacity IPFS...', 'active');
        var assetCid = localAssetCid;
        try {
          var elacityAssetResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: assetBase64, filename: isFreeContent ? 'free-asset' : 'encrypted-asset' }),
          });
          if (elacityAssetResp.ok) {
            var elacityAssetData = await elacityAssetResp.json();
            assetCid = elacityAssetData.cid;
            console.log('[Creator] Elacity asset CID:', assetCid);
          } else {
            console.warn('[Creator] Elacity IPFS upload failed, using local CID');
          }
        } catch (e) {
          console.warn('[Creator] Elacity IPFS upload error:', e.message);
        }
        setProgStep('prog-upload-asset', 'CID: ' + assetCid.substring(0, 12) + '...', 'done');
      } // end else (non-media IPFS upload)

      // ── Step 3: Build & upload metadata ─────────────────
      // Wait for user to advance past step 2 (confirm their metadata inputs)
      if (state.currentStep < 3) {
        setProgStep('prog-upload-meta', 'Waiting for you to confirm metadata...', 'active');
        var fpBar = document.getElementById('floating-progress');
        var fpFill = document.getElementById('floating-progress-fill');
        var fpText = document.getElementById('floating-progress-text');
        var fpPct = document.getElementById('floating-progress-pct');
        if (fpBar) fpBar.classList.add('done');
        if (fpFill) fpFill.style.width = '70%';
        if (fpText) fpText.textContent = 'Processing complete — fill in details and click Next';
        if (fpPct) fpPct.textContent = '70%';
        await new Promise(function (resolve) {
          var check = setInterval(function () {
            if (state.currentStep >= 3) {
              clearInterval(check);
              resolve();
            }
          }, 200);
        });
      }

      // Read form values now (user has confirmed them by advancing to step 3)
      var title = dom.assetTitle.value.trim();
      var description = dom.assetDescription.value.trim();
      var category = dom.assetCategory.value;
      var price = parseFloat(dom.assetPrice.value);
      var accessMethod = dom.assetAccess.value;
      var copies = parseInt(dom.assetCopies.value) || 10000;
      var channel = getSelectedChannel();
      priceCurrency = getSelectedCurrencyAddress();

      setProgStep('prog-upload-meta', 'Building metadata...', 'active');

      // Resolve authority (gateway) and generate thumbnail for metadata
      var authorityAddress = CONTRACTS.AUTHORITY_GATEWAY;
      try {
        authorityAddress = await getChannelAuthority(channel);
      } catch (e) {
        console.warn('[Creator] authority() lookup failed, using default:', e.message);
      }

      // Resolve thumbnail: user-selected takes priority, auto-generate as fallback
      var imageUri = '';
      try {
        var thumbBase64 = null;

        if (state.customThumbnail) {
          // User selected a custom thumbnail — resize to 1280px max and convert to JPEG
          var thumbCanvas = document.createElement('canvas');
          var thumbCtx = thumbCanvas.getContext('2d');
          var img = await createImageBitmap(state.customThumbnail);
          var maxDim = 1280;
          var scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
          thumbCanvas.width = Math.round(img.width * scale);
          thumbCanvas.height = Math.round(img.height * scale);
          thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
          var thumbBlob = await new Promise(function (resolve) {
            thumbCanvas.toBlob(resolve, 'image/jpeg', 0.85);
          });
          thumbBase64 = uint8ToBase64(new Uint8Array(await thumbBlob.arrayBuffer()));
          console.log('[Creator] Using user-selected thumbnail');
        } else if (state.selectedFile && state.resolvedMime.startsWith('image/')) {
          // Low-res + slight blur to prevent usability as a substitute
          var autoCanvas = document.createElement('canvas');
          var autoCtx = autoCanvas.getContext('2d');
          var autoImg = await createImageBitmap(state.selectedFile);
          var autoDim = 200;
          var autoScale = Math.min(autoDim / autoImg.width, autoDim / autoImg.height, 1);
          autoCanvas.width = Math.round(autoImg.width * autoScale);
          autoCanvas.height = Math.round(autoImg.height * autoScale);
          autoCtx.filter = 'blur(1px)';
          autoCtx.drawImage(autoImg, 0, 0, autoCanvas.width, autoCanvas.height);
          autoCtx.filter = 'none';
          autoCtx.fillStyle = 'rgba(0,0,0,0.08)';
          autoCtx.fillRect(0, 0, autoCanvas.width, autoCanvas.height);
          var autoBlob = await new Promise(function (resolve) {
            autoCanvas.toBlob(resolve, 'image/jpeg', 0.6);
          });
          thumbBase64 = uint8ToBase64(new Uint8Array(await autoBlob.arrayBuffer()));
          console.log('[Creator] Auto-generated thumbnail from image (low-res)');
        } else if (state.selectedFile && state.resolvedMime.startsWith('video/')) {
          // Extract a frame from the video at 2 seconds (or 0s for short clips)
          try {
            thumbBase64 = await new Promise(function (resolve, reject) {
              var videoEl = document.createElement('video');
              videoEl.preload = 'auto';
              videoEl.muted = true;
              videoEl.playsInline = true;
              var blobUrl = URL.createObjectURL(state.selectedFile);
              videoEl.src = blobUrl;

              var resolved = false;
              function captureFrame() {
                if (resolved) return;
                resolved = true;
                var vw = videoEl.videoWidth || 640;
                var vh = videoEl.videoHeight || 360;
                var thumbDim = 640;
                var thumbScale = Math.min(thumbDim / vw, thumbDim / vh, 1);
                var cw = Math.round(vw * thumbScale);
                var ch = Math.round(vh * thumbScale);
                var vCanvas = document.createElement('canvas');
                vCanvas.width = cw;
                vCanvas.height = ch;
                var vCtx = vCanvas.getContext('2d');
                vCtx.drawImage(videoEl, 0, 0, cw, ch);
                vCanvas.toBlob(function (blob) {
                  URL.revokeObjectURL(blobUrl);
                  videoEl.src = '';
                  if (blob) {
                    blob.arrayBuffer().then(function (buf) {
                      resolve(uint8ToBase64(new Uint8Array(buf)));
                    });
                  } else {
                    resolve(null);
                  }
                }, 'image/jpeg', 0.85);
              }

              videoEl.addEventListener('seeked', captureFrame, { once: true });
              videoEl.addEventListener('loadeddata', function () {
                var seekTo = Math.min(2, videoEl.duration * 0.1);
                videoEl.currentTime = seekTo;
              }, { once: true });
              videoEl.addEventListener('error', function () {
                URL.revokeObjectURL(blobUrl);
                resolve(null);
              }, { once: true });
              setTimeout(function () { if (!resolved) { resolved = true; URL.revokeObjectURL(blobUrl); resolve(null); } }, 15000);
              videoEl.load();
            });
            if (thumbBase64) console.log('[Creator] Auto-generated thumbnail from video frame');
          } catch (vThumbErr) {
            console.warn('[Creator] Video thumbnail extraction failed:', vThumbErr.message);
          }
        } else if (state.selectedFile && state.resolvedMime.startsWith('audio/')) {
          // Generate a simple audio waveform placeholder thumbnail
          try {
            var aCanvas = document.createElement('canvas');
            aCanvas.width = 640;
            aCanvas.height = 360;
            var aCtx = aCanvas.getContext('2d');
            aCtx.fillStyle = '#1a1a2e';
            aCtx.fillRect(0, 0, 640, 360);
            aCtx.strokeStyle = '#6366f1';
            aCtx.lineWidth = 2;
            aCtx.beginPath();
            var barCount = 48;
            var barWidth = 640 / barCount;
            for (var bi = 0; bi < barCount; bi++) {
              var h = 40 + Math.random() * 140;
              var x = bi * barWidth + barWidth * 0.2;
              var y = (360 - h) / 2;
              aCtx.fillStyle = 'rgba(99, 102, 241, ' + (0.5 + Math.random() * 0.5) + ')';
              aCtx.fillRect(x, y, barWidth * 0.6, h);
            }
            aCtx.fillStyle = '#e2e8f0';
            aCtx.font = 'bold 18px sans-serif';
            aCtx.textAlign = 'center';
            aCtx.fillText(state.selectedFile.name.substring(0, 40), 320, 340);
            var aBlob = await new Promise(function (resolve) { aCanvas.toBlob(resolve, 'image/jpeg', 0.85); });
            thumbBase64 = uint8ToBase64(new Uint8Array(await aBlob.arrayBuffer()));
            console.log('[Creator] Auto-generated audio waveform thumbnail');
          } catch (aThumbErr) {
            console.warn('[Creator] Audio thumbnail generation failed:', aThumbErr.message);
          }
        } else if (state.selectedFile && (state.resolvedMime === 'application/pdf' || state.resolvedMime === 'text/plain' || state.resolvedMime.startsWith('text/'))) {
          // Server-side thumbnail generation for PDFs and text files
          var fileBytes = new Uint8Array(await state.selectedFile.arrayBuffer());
          var serverThumbResp = await pc2Fetch('/api/storage/thumbnail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: uint8ToBase64(fileBytes), mimeType: state.resolvedMime, filename: state.selectedFile.name }),
          });
          if (serverThumbResp.ok) {
            var serverThumbData = await serverThumbResp.json();
            if (serverThumbData.thumbnail) {
              thumbBase64 = serverThumbData.thumbnail;
              console.log('[Creator] Server-generated thumbnail for', state.resolvedMime);
            } else {
              console.warn('[Creator] Server thumbnail response had no thumbnail field:', Object.keys(serverThumbData));
            }
          } else {
            console.warn('[Creator] Server thumbnail failed:', serverThumbResp.status, await serverThumbResp.text().catch(function () { return ''; }));
          }
        }

        // Generic fallback for any file type that didn't produce a thumbnail
        if (!thumbBase64 && state.selectedFile) {
          try {
            var fCanvas = document.createElement('canvas');
            fCanvas.width = 640;
            fCanvas.height = 360;
            var fCtx = fCanvas.getContext('2d');
            var grad = fCtx.createLinearGradient(0, 0, 640, 360);
            grad.addColorStop(0, '#1e1b4b');
            grad.addColorStop(1, '#312e81');
            fCtx.fillStyle = grad;
            fCtx.fillRect(0, 0, 640, 360);
            fCtx.fillStyle = 'rgba(99, 102, 241, 0.15)';
            fCtx.beginPath();
            fCtx.arc(320, 150, 60, 0, Math.PI * 2);
            fCtx.fill();
            fCtx.fillStyle = '#a5b4fc';
            fCtx.font = 'bold 36px sans-serif';
            fCtx.textAlign = 'center';
            fCtx.textBaseline = 'middle';
            var ext = (state.selectedFile.name.split('.').pop() || '?').toUpperCase();
            fCtx.fillText(ext, 320, 150);
            fCtx.fillStyle = '#e2e8f0';
            fCtx.font = '16px sans-serif';
            fCtx.fillText(state.selectedFile.name.substring(0, 44), 320, 240);
            fCtx.fillStyle = '#94a3b8';
            fCtx.font = '13px sans-serif';
            fCtx.fillText(state.resolvedMime || 'unknown', 320, 268);
            var fBlob = await new Promise(function (resolve) { fCanvas.toBlob(resolve, 'image/jpeg', 0.85); });
            thumbBase64 = uint8ToBase64(new Uint8Array(await fBlob.arrayBuffer()));
            console.log('[Creator] Fallback thumbnail generated for', state.resolvedMime);
          } catch (fThumbErr) {
            console.warn('[Creator] Fallback thumbnail failed:', fThumbErr.message);
          }
        }

        if (thumbBase64) {
          // Always pin the thumbnail locally first via Helia. This guarantees
          // the bytes are reachable through *some* IPFS gateway even when
          // Elacity's pinning service is degraded (502 / extreme slowness).
          // Mirrors the belt-and-braces pattern used by the asset upload
          // and metadata directory upload paths above.
          var localThumbCid = null;
          try {
            var localThumbResp = await pc2Fetch('/api/storage/ipfs/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: thumbBase64, filename: 'thumbnail.jpg' }),
            });
            if (localThumbResp.ok) {
              var localThumbData = await localThumbResp.json();
              localThumbCid = localThumbData.cid;
            } else {
              console.warn('[Creator] Local thumbnail pin returned', localThumbResp.status);
            }
          } catch (localThumbErr) {
            console.warn('[Creator] Local thumbnail pin failed:', localThumbErr.message);
          }

          var elacityThumbCid = null;
          try {
            var thumbResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: thumbBase64, filename: 'thumbnail.jpg' }),
            });
            if (thumbResp.ok) {
              var thumbData = await thumbResp.json();
              elacityThumbCid = thumbData.cid;
            } else {
              console.warn('[Creator] Elacity thumbnail upload returned', thumbResp.status);
            }
          } catch (elacityThumbErr) {
            console.warn('[Creator] Elacity thumbnail upload failed:', elacityThumbErr.message);
          }

          // Prefer Elacity (faster global discovery), fall back to local.
          // Either way the metadata.json gets a non-empty `imageUri`, so the
          // marketplace + player + file manager all show the cover art.
          if (elacityThumbCid) {
            imageUri = 'ipfs://' + elacityThumbCid;
            console.log('[Creator] Thumbnail pinned to Elacity:', imageUri);
          } else if (localThumbCid) {
            imageUri = 'ipfs://' + localThumbCid;
            console.log('[Creator] Thumbnail pinned locally only (Elacity unreachable):', imageUri);
          }
        }
      } catch (thumbErr) {
        console.warn('[Creator] Thumbnail generation failed (non-fatal):', thumbErr.message);
      }

      if (!imageUri) {
        console.warn('[Creator] No thumbnail bytes available — asset will have no preview image in marketplace');
      }

      var selectedCurrency = CURRENCIES.find(function (c) { return c.address === priceCurrency; }) || CURRENCIES[0];
      var selectedCategories = getSelectedCategories();
      var selectedTags = getSelectedTags();
      var resellerCut = getResellerCut();
      var royaltyPartners = getRoyaltyPartners();

      var isAdultContent = !!(document.getElementById('adult-content-check') && document.getElementById('adult-content-check').checked);
      var legalAttestation = await buildLegalAttestation(state.walletAddress);
      var licensingData = getLicensingData();
      var hasAITraining = licensingData.type === 'training-rights' && licensingData.aiTraining && licensingData.aiTraining.permitted;
      var assetAttributes = [];
      if (hasAITraining) {
        assetAttributes.push({ trait_type: 'AI Training', value: 'Allowed' });
      }
      if (category === 'skill') {
        assetAttributes.push({ trait_type: 'Content Type', value: 'AI Agent Skill' });
      }
      if (isAdultContent) {
        assetAttributes.push({ trait_type: 'Adult Content', value: '18+' });
      }

      var metaParams = {
        title: title,
        description: description,
        category: selectedCategories[0] || category,
        categories: selectedCategories.length > 0 ? selectedCategories : [category],
        tags: selectedTags,
        attributes: assetAttributes,
        isAdult: isAdultContent,
        legalAttestation: legalAttestation,
        licensing: licensingData.type !== 'perpetual' ? licensingData : undefined,
        assetCid: assetCid,
        mimeType: state.resolvedMime || 'application/octet-stream',
        size: state.selectedFile.size,
        dataToEncryptHash: encryptResult.dataToEncryptHash,
        actionCid: encryptResult.actionCid || '',
        price: price,
        accessMethod: accessMethod,
        copies: copies,
        resellerCut: resellerCut,
        currency: selectedCurrency,
        royalties: royaltyPartners,
        creatorAddress: state.walletAddress,
        channel: channel,
        authority: authorityAddress,
        image: imageUri,
      };

      var envelope = buildMetadataEnvelope(metaParams);

      if (encryptResult.litCiphertext) {
        envelope.asset.litCiphertext = encryptResult.litCiphertext;
        envelope.asset.iv = encryptResult.iv;
        envelope.asset.litBackend = encryptResult.litBackend || 'chipotle';
      }

      if (isMediaFile && mediaEncodeResult) {
        if (isFreeContent) {
          envelope.asset.protectionType = 'none';
          envelope.asset.cleartext = true;
          envelope.asset.directPlayback = true;
        } else {
          envelope.asset.protectionType = 'cenc:web3-drm-v1';
          envelope.asset.mpdUri = mediaEncodeResult.mpdUri;
          envelope.asset.kid = mediaEncodeResult.kid;
          envelope.asset.litBackend = 'chipotle';
        }
        envelope.asset.mediaType = state.resolvedMime.startsWith('video/') ? 'video' : 'audio';
        envelope.media.previewURL = mediaEncodeResult.previewURL || undefined;
        if (mediaEncodeResult.duration) envelope.media.duration = mediaEncodeResult.duration;
        if (mediaEncodeResult.resolution) envelope.media.resolution = mediaEncodeResult.resolution;
        if (mediaEncodeResult.codec) envelope.media.codec = mediaEncodeResult.codec;
      }

      // Content integrity proof — buyers (and AI agents) can verify post-purchase
      if (originalContentHash) {
        envelope.asset.contentHash = originalContentHash;
        envelope.asset.contentHashAlgorithm = 'SHA-256';
      }

      // Content stats for buyer trust signals (machine-readable by AI agents)
      try {
        var mime = state.resolvedMime || '';
        if (!isMediaFile && state.fileBytes) {
          if (mime.startsWith('text/') || mime === 'application/json') {
            var textContent = new TextDecoder().decode(state.fileBytes);
            var wordCount = textContent.split(/\s+/).filter(function (w) { return w.length > 0; }).length;
            var lineCount = textContent.split(/\n/).length;
            envelope.media.wordCount = wordCount;
            envelope.media.lineCount = lineCount;
          } else if (mime.startsWith('image/')) {
            envelope.media.fileType = 'image';
          }
          envelope.media.originalSize = state.selectedFile.size;
          envelope.media.originalName = state.selectedFile.name;
        } else if (isMediaFile) {
          envelope.media.originalSize = state.selectedFile.size;
          envelope.media.originalName = state.selectedFile.name;
        }
      } catch (statsErr) {
        console.warn('[Creator] Content stats extraction failed (non-fatal):', statsErr.message);
      }

      if (usedLocalEncryption) {
        envelope.asset._devMode = true;
        envelope.asset._localKey = encryptResult._localDevKey;
      }

      var kid = (isMediaFile && mediaEncodeResult) ? mediaEncodeResult.kid : (encryptResult.dataToEncryptHash || '');

      var contentJson = buildContentJson({
        assetCid: assetCid,
        mimeType: state.resolvedMime || 'application/octet-stream',
        size: state.selectedFile.size,
        dataToEncryptHash: encryptResult.dataToEncryptHash,
        kid: kid,
        protectionType: envelope.asset.protectionType,
        algorithm: envelope.asset.algorithm,
      });

      var contractJson = buildContractJson({
        accessMethod: accessMethod,
        channel: channel,
        authority: authorityAddress,
        copies: copies,
        price: price,
        resellerCut: resellerCut,
        currency: selectedCurrency,
        royalties: royaltyPartners,
        mimeType: state.resolvedMime || 'application/octet-stream',
      });

      var tokenTypeFiles = buildTokenTypeJsons({
        accessMethod: accessMethod,
        image: imageUri,
        title: title,
        kid: kid,
        dataToEncryptHash: encryptResult.dataToEncryptHash,
      });

      var metaDirFiles = {
        'metadata.json': envelope,
        'content.json': contentJson,
        'contract.json': contractJson,
        ...tokenTypeFiles
      };

      // Upload metadata.json as a flat file to Elacity IPFS — returns a CIDv0 (Qm...)
      setProgStep('prog-upload-meta', 'Uploading to IPFS...', 'active');

      var metaCid = null;
      try {
        var elacityMetaResp = await pc2Fetch('/api/storage/ipfs/upload-elacity-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: metaDirFiles, filename: 'metadataFolder' }),
        });
        if (elacityMetaResp.ok) {
          var elacityMetaData = await elacityMetaResp.json();
          metaCid = elacityMetaData.cid;
          console.log('[Creator] Elacity meta CID:', metaCid);
        }
      } catch (e) {
        console.warn('[Creator] Elacity meta upload error:', e.message);
      }

      if (!metaCid) {
        throw new Error('Failed to upload metadata to IPFS');
      }

      setProgStep('prog-upload-meta', 'CID: ' + metaCid.substring(0, 12) + '...', 'done');

      // Verify on Elacity gateway
      setProgStep('prog-pin', 'Verifying...', 'active');
      try {
        var verifyResp = await fetch('https://ipfs.ela.city/ipfs/' + metaCid, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
        });
        if (verifyResp.ok) {
          setProgStep('prog-pin', 'Live on ipfs.ela.city', 'done');
        } else {
          setProgStep('prog-pin', 'Uploaded — indexing...', 'done');
        }
      } catch (verifyErr) {
        setProgStep('prog-pin', 'Uploaded — will index shortly', 'done');
      }

      // ── Wait for user to review and click Sign & Mint ──
      state.metaCid = metaCid;
      state.metadataUploaded = true;
      state.processingRunning = false;

      // Save draft so user can close and come back to sign later
      try {
        var draftWalletType = getChannelOwnerType(dom.assetChannel) || (hasSmartAccount() ? 'sa' : 'eoa');
        var draftBody = {
          title: title,
          description: description,
          category: category,
          file_name: state.selectedFile ? state.selectedFile.name : '',
          file_size: state.selectedFile ? state.selectedFile.size : 0,
          mime_type: state.resolvedMime || '',
          asset_cid: assetCid,
          metadata_cid: metaCid,
          encrypt_hash: encryptResult.dataToEncryptHash,
          channel: channel,
          wallet_choice: draftWalletType,
          price: String(price || 0),
          currency_address: priceCurrency,
          currency_symbol: (CURRENCIES.find(function (c) { return c.address === priceCurrency; }) || CURRENCIES[0]).symbol,
          copies: copies,
          access_method: accessMethod,
          reseller_cut: getResellerCut(),
          royalty_partners: JSON.stringify(getRoyaltyPartners()),
          thumbnail_cid: imageUri || '',
          adult: isAdultContent,
          licensing: licensingData.type !== 'perpetual' ? JSON.stringify(licensingData) : '',
        };
        var draftResp = await pc2Fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draftBody),
        });
        if (draftResp.ok) {
          var draftData = await draftResp.json();
          state.draftId = draftData.id;
          // Notify parent window (desktop shell) so the publish badge updates
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({ msg: 'mint-draft-saved' }, '*');
            }
          } catch (_) { }
        }
      } catch (draftErr) {
        console.warn('[Creator] Draft auto-save failed:', draftErr.message);
      }

      var fpBar = document.getElementById('floating-progress');
      var fpFill = document.getElementById('floating-progress-fill');
      var fpText = document.getElementById('floating-progress-text');
      var fpPct = document.getElementById('floating-progress-pct');
      if (fpBar) fpBar.classList.add('done');
      if (fpFill) fpFill.style.width = '90%';
      if (fpText) fpText.textContent = 'Ready to publish — complete the checklist below';
      if (fpPct) fpPct.textContent = '90%';

      setProgStep('prog-mint', 'Ready — check the boxes below and click Sign & Mint', 'active');
      if (dom.btnBackTo2) dom.btnBackTo2.disabled = false;
      var publishLaterBtn = document.getElementById('btn-publish-later');
      if (publishLaterBtn) publishLaterBtn.style.display = '';
      validateStep3();

      var mintSuccess = false;
      while (!mintSuccess) {
        await new Promise(function (resolve) {
          state._mintResolve = resolve;
        });
        if (dom.btnBackTo2) dom.btnBackTo2.disabled = true;

        // ── Step 4: Mint on Channel contract ──────────────
        var mintedTokenId = null;
        var mintedOpContract = null;
        var mintTxHash = null;

        var needsGatewayApproval = accessMethod !== 'free';
        var btnMintText = document.getElementById('btn-sign-mint-text');
        if (btnMintText && needsGatewayApproval) {
          btnMintText.textContent = 'Transaction 1 of 2 — Minting...';
        } else if (btnMintText) {
          btnMintText.textContent = 'Minting...';
        }

        try {
          if (channel && ethers.isAddress(channel)) {
            setProgStep('prog-mint', 'Preparing...', 'active');

            var walletChoice = getChannelOwnerType(dom.assetChannel) || (hasSmartAccount() ? 'sa' : 'eoa');
            if (!getChannelOwnerType(dom.assetChannel)) {
              walletChoice = await showWalletChoice('Choose Wallet for Minting');
            }
            state.walletChoice = walletChoice;

            if (!state.walletAddress) {
              try {
                var accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                if (accts && accts[0]) state.walletAddress = accts[0];
              } catch (_) { }
            }
            if (!state.walletAddress) {
              throw new Error('Wallet not connected — please reconnect your wallet and try again.');
            }

            var effectiveAddr = getEffectiveAddress(walletChoice);
            if (!effectiveAddr || effectiveAddr === '0x' || effectiveAddr.length < 10) {
              throw new Error('Could not determine wallet address for ' + walletChoice + '. Reconnect wallet and try again.');
            }
            console.log('[Creator] Wallet choice:', walletChoice, '(from channel owner) effective:', effectiveAddr);

            try {
              var currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
              if (currentChainId !== BASE_CHAIN_HEX) {
                await window.ethereum.request({
                  method: 'wallet_switchEthereumChain',
                  params: [{ chainId: BASE_CHAIN_HEX }],
                });
                await new Promise(function (r) { setTimeout(r, 1500); });
              }
            } catch (switchErr) {
              console.warn('[Creator] Chain switch failed (may already be on Base):', switchErr.message);
            }

            var gatewayAddress = await getChannelAuthority(channel);
            console.log('[Creator] Channel authority (gateway):', gatewayAddress);

            var MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
            var needsGrantRole = false;
            try {
              var acIface = new ethers.Interface(ABI.ACCESS_CONTROL);
              var roleCheck = await rpcCall(channel, acIface.encodeFunctionData('hasRole', [MINTER_ROLE, effectiveAddr]));
              var hasMinterRole = acIface.decodeFunctionResult('hasRole', roleCheck)[0];
              if (!hasMinterRole) {
                if (walletChoice === 'sa') {
                  needsGrantRole = true;
                  console.log('[Creator] SA needs MINTER_ROLE — will include in batch');
                } else {
                  throw new Error('Your wallet does not have MINTER_ROLE on this channel. Create your own channel or request access from the channel owner.');
                }
              }
              console.log('[Creator] MINTER_ROLE verified for', effectiveAddr);
            } catch (roleCheckErr) {
              if (roleCheckErr.message.includes('MINTER_ROLE')) throw roleCheckErr;
              console.warn('[Creator] Could not verify MINTER_ROLE (proceeding anyway):', roleCheckErr.message);
            }

            var feeInfo = await getMintingFee();
            var priceWei = ethers.parseUnits(price.toString(), selectedCurrency.decimals);
            var opType = accessMethod === 'free' ? OP_TYPES.FREE
              : accessMethod === 'buy_once' ? OP_TYPES.BUY_ONCE
                : OP_TYPES.BUY_AND_RESELL;

            var opRawData = opType !== OP_TYPES.FREE
              ? encodeOpRawData({
                contentId: encryptResult.dataToEncryptHash,
                metadataCID: metaCid,
                creatorAddress: effectiveAddr,
                copies: copies,
                opType: opType,
                resellerCut: resellerCut,
                royalties: royaltyPartners,
              })
              : ethers.AbiCoder.defaultAbiCoder().encode(['bytes16'], [hashToContentId(encryptResult.dataToEncryptHash)]);
            var sellRawData = opType !== OP_TYPES.FREE
              ? encodeSellRawData(copies, priceWei, selectedCurrency.address)
              : '0x';

            // we assume `metaCid` is the folder CID that contains all metadata group for this new item
            // it includes metadata for the media, for the underlying tokens of the operative contract
            var mintUri = `${metaCid}/metadata.json`;
            var iface = new ethers.Interface(ABI.DIGITAL_ASSET);
            var mintData = iface.encodeFunctionData('mint', [mintUri, opType, opRawData, sellRawData]);

            setProgStep('prog-mint', 'Preparing...', 'active');

            if (walletChoice === 'sa' && hasSmartAccount()) {
              if (needsGrantRole) {
                var grantIface = new ethers.Interface(ABI.ACCESS_CONTROL);
                var grantData = grantIface.encodeFunctionData('grantRole', [MINTER_ROLE, smartAccountAddress]);
                var grantTxHash = await sendTxWithRetry('prog-mint', 'Grant MINTER_ROLE to Agent Account (EOA tx)', channel, grantData, 0);
                setProgStep('prog-mint', 'Confirming role grant...', 'active');
                await waitForReceipt(grantTxHash);
              }

              var preMintSupply = null;
              try {
                var preSupData = iface.encodeFunctionData('totalSupply', []);
                var preSupResult = await rpcCall(channel, preSupData);
                preMintSupply = iface.decodeFunctionResult('totalSupply', preSupResult)[0].toString();
                console.log('[Creator] Pre-mint totalSupply:', preMintSupply);
              } catch (_) { }

              var batchTxs = [];
              var mintFeeHex = feeInfo.fee && BigInt(feeInfo.fee) > 0n ? '0x' + BigInt(feeInfo.fee).toString(16) : '0x0';
              batchTxs.push({ to: channel, data: mintData, value: mintFeeHex });

              var batchResult = null;
              while (!batchResult) {
                try {
                  setProgStep('prog-mint', 'Confirm in wallet (Agent Account batch)...', 'active');
                  batchResult = await parentExecuteSmartAccountBatch(BASE_CHAIN_ID, batchTxs, []);
                } catch (saBatchErr) {
                  var saBatchMsg = saBatchErr.message || '';
                  console.warn('[Creator] SA batch error:', saBatchMsg);
                  var saRetry = await new Promise(function (resolve) {
                    setProgStep('prog-mint', (saBatchMsg.includes('Insufficient') ? 'Insufficient gas' : 'Failed') + ' — ', 'error');
                    var stepEl = document.getElementById('prog-mint');
                    var statusEl = stepEl && (document.getElementById('prog-mint-status') || stepEl.querySelector('.prog-status') || stepEl.querySelector('span:last-child'));
                    if (!statusEl) { resolve(false); return; }
                    var retryBtn = document.createElement('button');
                    retryBtn.textContent = 'Retry';
                    retryBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;padding:4px 12px;font-size:12px;line-height:1;font-family:inherit;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;margin-left:8px;';
                    retryBtn.addEventListener('click', function () { retryBtn.remove(); cancelBtn.remove(); resolve(true); });
                    var cancelBtn = document.createElement('button');
                    cancelBtn.textContent = 'Cancel';
                    cancelBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;padding:4px 12px;font-size:12px;line-height:1;font-family:inherit;background:#6b7280;color:white;border:none;border-radius:4px;cursor:pointer;margin-left:4px;';
                    cancelBtn.addEventListener('click', function () { retryBtn.remove(); cancelBtn.remove(); resolve(false); });
                    statusEl.appendChild(retryBtn);
                    statusEl.appendChild(cancelBtn);
                  });
                  if (!saRetry) throw new Error('Mint cancelled: ' + saBatchMsg);
                }
              }
              mintTxHash = batchResult.transactionHash || batchResult.transactionId;
              var saOnChainHash = batchResult.transactionHash;
              console.log('[Creator] SA batch result — txHash:', saOnChainHash, 'txId:', batchResult.transactionId);

              setProgStep('prog-mint', 'Waiting for on-chain confirmation...', 'active');

              var saPollStart = Date.now();
              while (Date.now() - saPollStart < 90000) {
                await new Promise(function (r) { setTimeout(r, 4000); });

                try {
                  var blockResp = await fetch(BASE_RPC, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
                  });
                  var blockJson = await blockResp.json();
                  var curBlock = parseInt(blockJson.result, 16);
                  var logsResp = await fetch(BASE_RPC, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
                      params: [{ address: channel, fromBlock: '0x' + Math.max(0, curBlock - 30).toString(16), toBlock: 'latest' }],
                    }),
                  });
                  var logsJson = await logsResp.json();
                  var channelLogs = logsJson.result || [];

                  if (channelLogs.length > 0) {
                    var realTxHash = channelLogs[channelLogs.length - 1].transactionHash;
                    console.log('[Creator] SA found channel activity, real txHash:', realTxHash);

                    var rcptResp = await fetch(BASE_RPC, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [realTxHash] }),
                    });
                    var rcptJson = await rcptResp.json();
                    if (rcptJson.result && rcptJson.result.logs && rcptJson.result.logs.length > 0) {
                      console.log('[Creator] SA full receipt — logs:', rcptJson.result.logs.length, 'status:', rcptJson.result.status);
                      var parsedEvent = parseAssetCreatedEvent(rcptJson.result, channel);
                      if (parsedEvent) {
                        mintedTokenId = parsedEvent.tokenId;
                        mintedOpContract = parsedEvent.opContract;
                        if (mintedOpContract === ethers.ZeroAddress) mintedOpContract = null;
                        mintTxHash = realTxHash;
                        console.log('[Creator] SA mint resolved — tokenId:', mintedTokenId, 'opContract:', mintedOpContract);
                        break;
                      }
                    }
                  }
                } catch (pollErr) {
                  console.warn('[Creator] SA poll error:', pollErr.message);
                }

                setProgStep('prog-mint', 'Waiting for on-chain confirmation...', 'active');
              }
            } else {
              mintTxHash = await sendTxWithRetry('prog-mint', 'Mint on Channel contract', channel, mintData, feeInfo.fee);
              setProgStep('prog-mint', 'Confirming tx...', 'active');
              var mintReceipt = await waitForReceipt(mintTxHash);

              if (mintReceipt.status === '0x0' || mintReceipt.status === 0) {
                throw new Error('Mint transaction reverted');
              }

              var assetEvent = parseAssetCreatedEvent(mintReceipt, channel);
              if (assetEvent) {
                mintedTokenId = assetEvent.tokenId;
                mintedOpContract = assetEvent.opContract;
              }

              if (!mintedTokenId) {
                try {
                  var supplyData2 = iface.encodeFunctionData('totalSupply', []);
                  var supplyResult2 = await rpcCall(channel, supplyData2);
                  var supplyDecoded2 = iface.decodeFunctionResult('totalSupply', supplyResult2);
                  mintedTokenId = supplyDecoded2[0].toString();
                } catch (tsErr) {
                  console.warn('[Creator] Could not get totalSupply:', tsErr.message);
                }
              }

              if (!mintedOpContract && mintedTokenId && opType !== OP_TYPES.FREE) {
                try {
                  var agIface2 = new ethers.Interface(ABI.AUTHORITY_GATEWAY);
                  var opLookupData2 = agIface2.encodeFunctionData('operative', [channel, mintedTokenId]);
                  var opLookupResult2 = await rpcCall(CONTRACTS.AUTHORITY_GATEWAY, opLookupData2);
                  var opDecoded2 = agIface2.decodeFunctionResult('operative', opLookupResult2);
                  if (opDecoded2[0] && opDecoded2[0] !== ethers.ZeroAddress) {
                    mintedOpContract = opDecoded2[0];
                  }
                } catch (opLookupErr) {
                  console.warn('[Creator] operative lookup failed:', opLookupErr.message);
                }
              }
            }

            setProgStep('prog-mint', mintedTokenId
              ? 'Token #' + mintedTokenId + ' minted'
              : 'Minted (tx: ' + (mintTxHash || '').substring(0, 10) + '...)', 'done');

            // ── Step 5: Set approval on Operative ─────────
            var gatewayApproved = false;
            if (mintedOpContract && mintedOpContract !== '0x0000000000000000000000000000000000000000') {
              if (btnMintText) btnMintText.textContent = 'Transaction 2 of 2 — Gateway approval...';

              if (walletChoice === 'sa' && hasSmartAccount()) {
                try {
                  setProgStep('prog-approve', 'Approving gateway (Agent Account)...', 'active');
                  await new Promise(function (r) { setTimeout(r, 3000); });
                  var opIface2 = new ethers.Interface(ABI.OPERATIVE);
                  var approveData2 = opIface2.encodeFunctionData('setApprovalForAll', [gatewayAddress, true]);
                  await parentExecuteSmartAccountBatch(BASE_CHAIN_ID, [{ to: mintedOpContract, data: approveData2, value: '0x0' }], []);
                  setProgStep('prog-approve', 'Gateway approved', 'done');
                  gatewayApproved = true;
                } catch (approveErr) {
                  console.error('[Creator] SA Gateway approval failed:', approveErr);
                  setProgStep('prog-approve', '⚠️ Failed — use Fix tool below', 'error');
                  showToast('Gateway approval failed. Use the Fix Gateway Approval tool.', 'error');
                }
              } else {
                try {
                  setProgStep('prog-approve', 'Waiting for chain to settle...', 'active');
                  await new Promise(function (r) { setTimeout(r, 5000); });
                  setProgStep('prog-approve', 'Approving gateway on ' + mintedOpContract.substring(0, 8) + '...', 'active');
                  var opIface = new ethers.Interface(ABI.OPERATIVE);
                  var approveData = opIface.encodeFunctionData('setApprovalForAll', [gatewayAddress, true]);
                  var approveTxHash = await sendTxWithRetry('prog-approve', 'Set gateway approval', mintedOpContract, approveData);
                  setProgStep('prog-approve', 'Confirming tx...', 'active');
                  var approveReceipt = await waitForReceipt(approveTxHash);
                  if (approveReceipt.status === 'timeout') {
                    setProgStep('prog-approve', 'Tx sent — verify on BaseScan (' + approveTxHash.substring(0, 10) + '...)', 'done');
                  } else {
                    setProgStep('prog-approve', 'Gateway approved', 'done');
                    gatewayApproved = true;
                  }
                } catch (approveErr) {
                  console.error('[Creator] Gateway approval failed:', approveErr);
                  setProgStep('prog-approve', '⚠️ Failed — use Fix tool below (' + (approveErr.message || '').substring(0, 60) + ')', 'error');
                  showToast('Gateway approval failed. Use the Fix Gateway Approval tool after results load.', 'error');
                }
              }
            } else if (opType === OP_TYPES.FREE) {
              setProgStep('prog-approve', 'Skipped (free content)', 'done');
              gatewayApproved = true;
            } else {
              setProgStep('prog-approve', '⚠️ Operative not detected — use Fix tool below', 'error');
              showToast('Gateway approval could not run — use Fix Gateway Approval tool below.', 'error');
            }
          } else {
            setProgStep('prog-mint', 'Skipped (no channel)', 'done');
            setProgStep('prog-approve', 'Skipped', 'done');
          }

          mintSuccess = true;
        } catch (mintStepErr) {
          console.error('[Creator] Mint step failed:', mintStepErr.message);
          var btnSignMintRetry = document.getElementById('btn-sign-mint');
          var btnMintTextRetry = document.getElementById('btn-sign-mint-text');
          if (btnSignMintRetry) btnSignMintRetry.disabled = false;
          if (btnMintTextRetry) btnMintTextRetry.textContent = 'Retry Sign & Mint';
          setProgStep('prog-mint', 'Failed — click Retry above', 'error');
          if (dom.btnBackTo2) dom.btnBackTo2.disabled = false;
          showToast('Mint failed: ' + (mintStepErr.message || '').substring(0, 80) + ' — click Retry', 'error');
          PROGRESS_STEPS.forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.classList.contains('active')) setProgStep(id, 'Waiting for retry', 'pending');
          });
        }
      } // end while (!mintSuccess)

      // ── Done — delete draft since mint completed ──────
      if (state.draftId) {
        try {
          await pc2Fetch('/api/drafts/' + state.draftId, { method: 'DELETE' });
        } catch (_) { }
        state.draftId = null;
      }

      // ── Show results ───────────────────────────────────
      var didMintOnChain = !!(channel && ethers.isAddress(channel) && mintTxHash);

      state.result = {
        assetCid: assetCid,
        metaCid: metaCid,
        encryptHash: encryptResult.dataToEncryptHash,
        size: state.selectedFile.size,
        tokenId: mintedTokenId,
        txHash: mintTxHash,
        channel: channel,
        opContract: mintedOpContract,
      };

      document.getElementById('result-asset-cid').textContent = assetCid;
      document.getElementById('result-meta-cid').textContent = metaCid;
      document.getElementById('result-encrypt-hash').textContent = encryptResult.dataToEncryptHash;
      document.getElementById('result-size').textContent = formatSize(state.selectedFile.size);

      if (didMintOnChain) {
        var tokenLabel = mintedTokenId ? 'Token #' + mintedTokenId : 'tx ' + mintTxHash.substring(0, 10) + '...';
        document.getElementById('result-row-token').style.display = '';
        document.getElementById('result-token-id').textContent = mintedTokenId || mintTxHash;
        document.getElementById('result-row-channel').style.display = '';
        document.getElementById('result-channel').textContent = channel;
        if (mintedOpContract && mintedOpContract !== '0x0000000000000000000000000000000000000000') {
          document.getElementById('result-row-operative').style.display = '';
          document.getElementById('result-operative').textContent = mintedOpContract;
        }
        if (gatewayApproved) {
          document.getElementById('result-title').textContent = 'Asset Minted On-Chain';
          document.getElementById('result-desc').textContent = 'Your encrypted asset is on IPFS and minted on Base as ' + tokenLabel + '.';
          document.getElementById('result-note').innerHTML = '<strong>Live on Base:</strong> Your asset is now on the Elacity channel. <a href="https://basescan.org/tx/' + mintTxHash + '" target="_blank">View on BaseScan</a>';
        } else {
          document.getElementById('result-title').textContent = 'Minted — Gateway Approval Needed';
          document.getElementById('result-desc').textContent = 'Token ' + tokenLabel + ' was minted but the marketplace approval did not complete. Buyers cannot purchase until you approve.';
          document.getElementById('result-note').innerHTML = '<strong>Action required:</strong> Use the <em>Fix Gateway Approval</em> tool below to send the approval transaction. <a href="https://basescan.org/tx/' + mintTxHash + '" target="_blank">View mint on BaseScan</a>';
        }
      } else {
        document.getElementById('result-title').textContent = 'Asset Published to IPFS';
        document.getElementById('result-desc').textContent = 'Your encrypted asset is stored on IPFS and ready for on-chain listing.';
        document.getElementById('result-row-token').style.display = 'none';
        document.getElementById('result-row-channel').style.display = 'none';
        document.getElementById('result-note').innerHTML = '<strong>Next step:</strong> Enter a Channel contract address in step 2 to mint on-chain, or use the CIDs above to mint manually.';
      }

      goToStep(4);
      var modeLabel = usedLocalEncryption ? ' (local dev mode)' : '';
      var mintLabel = mintedTokenId ? ' Token #' + mintedTokenId : '';
      if (didMintOnChain && !gatewayApproved) {
        showToast('Minted' + mintLabel + ' — gateway approval still needed' + modeLabel, 'error');
        // Pre-fill the Fix Gateway Approval tool so user doesn't have to find the address
        if (mintedOpContract) {
          var fixInput = document.getElementById('fix-operative-addr');
          if (fixInput) fixInput.value = mintedOpContract;
        }
      } else {
        showToast('Asset published!' + mintLabel + modeLabel, 'success');
      }

      // Post-mint: kick PC2 indexer so the new asset appears in catalog/Market
      // immediately instead of waiting for the next 5-minute scan cycle.
      triggerLocalReindex();

      // Post-mint: register asset locally so it appears in library and is seedable
      if (assetCid && state.walletAddress) {
        try {
          await pc2Fetch('/api/storage/ipfs/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cid: assetCid }),
          });
          console.log('[Creator] Asset registered for local seeding:', assetCid);
        } catch (seedErr) {
          console.warn('[Creator] Local seed registration failed (non-fatal):', seedErr.message);
        }
      }
      if (metaCid && state.walletAddress) {
        try {
          await pc2Fetch('/api/storage/ipfs/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cid: metaCid }),
          });
          console.log('[Creator] Metadata registered for local seeding:', metaCid);
        } catch (seedErr) {
          console.warn('[Creator] Metadata seed registration failed (non-fatal):', seedErr.message);
        }
      }

      // Post-mint: save .ddrm capsule to user's directory so the asset is
      // immediately openable without needing the Elacity Market app.
      if (assetCid && state.walletAddress && encryptResult) {
        try {
          var walletAddr = state.walletAddress.toLowerCase();
          var cleanHash = (encryptResult.dataToEncryptHash || '').replace(/^0x/, '');
          var capsuleKid = cleanHash ? '0x' + cleanHash.slice(0, 32).padEnd(32, '0') : '';
          var assetMime = state.resolvedMime || 'application/octet-stream';
          var capsuleFolder = '/' + walletAddr + '/' + (
            isMediaFile ? 'Videos' :
              assetMime.startsWith('image/') ? 'Pictures' : 'Documents'
          );
          var safeName = (title || 'asset').replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 80).trim() || 'asset';
          var capsulePath = capsuleFolder + '/' + safeName + '.ddrm';

          var capsule = {
            schema: 'ddrm-capsule-v2',
            type: isMediaFile ? 'media' : 'non-media',
            version: 1,
            title: title || 'Untitled',
            contractAddress: channel || '',
            tokenId: mintedTokenId || '0',
            authority: CONTRACTS.AUTHORITY_GATEWAY,
            operative: mintedOpContract || '',
            ledger: channel || '',
            thumbnail: imageUri || '',
            acquiredAt: new Date().toISOString(),
            acquiredBy: state.walletAddress,
          };

          if (isFreeContent) {
            capsule.cleartext = true;
            capsule.cid = assetCid;
            capsule.mimeType = assetMime;
            capsule.gateway = window.location.origin + '/ipfs/';
            capsule.fallbackGateway = 'https://ipfs.ela.city/ipfs/';
            capsule.isProtected = false;
            if (isMediaFile && mediaEncodeResult) {
              capsule.type = 'media';
              capsule.mediaType = assetMime.startsWith('video/') ? 'video' : 'audio';
              capsule.mpdUri = mediaEncodeResult.mpdUri || '';
              capsule.duration = mediaEncodeResult.duration || 0;
            }
          } else if (isMediaFile && mediaEncodeResult) {
            capsule.cid = assetCid;
            capsule.gateway = window.location.origin + '/ipfs/';
            capsule.fallbackGateway = 'https://ipfs.ela.city/ipfs/';
            capsule.mediaType = assetMime.startsWith('video/') ? 'video' : 'audio';
            capsule.duration = mediaEncodeResult.duration || 0;
            capsule.isProtected = true;
          } else {
            capsule.encryptedDataCid = assetCid;
            capsule.mimeType = assetMime;
            capsule.dataToEncryptHash = encryptResult.dataToEncryptHash || '';
            capsule.kid = capsuleKid;
            capsule.litCiphertext = encryptResult.litCiphertext || '';
            capsule.iv = encryptResult.iv || '';
            capsule.actionCid = encryptResult.actionCid || '';
            capsule.litBackend = encryptResult.litBackend || 'chipotle';
          }

          capsule.signedBy = state.walletAddress;

          // Content-address the capsule: SHA-256 of the canonical JSON (without hash field)
          try {
            var canonicalJson = JSON.stringify(capsule);
            var hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
            var hashArray = Array.from(new Uint8Array(hashBuffer));
            capsule.capsuleHash = 'sha256:' + hashArray.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          } catch (hashErr) {
            console.warn('[Creator] capsuleHash computation failed (non-fatal):', hashErr.message);
          }

          await pc2Fetch('/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: capsulePath,
              content: JSON.stringify(capsule, null, 2),
              mime_type: 'application/x-ddrm',
              overwrite: false,
              dedupe_name: true,
            }),
          });
          console.log('[Creator] .ddrm capsule saved:', capsulePath);
        } catch (capsuleErr) {
          console.warn('[Creator] .ddrm capsule save failed (non-fatal):', capsuleErr.message);
        }
      }

    } catch (err) {
      state.processingRunning = false;
      dom.progressError.textContent = 'Error: ' + (err.message || 'Unknown error');
      dom.progressError.classList.remove('hidden');
      if (dom.btnBackTo2) dom.btnBackTo2.disabled = false;
      showToast('Pipeline failed: ' + (err.message || ''), 'error');

      hideFloatingProgress();

      PROGRESS_STEPS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.classList.contains('active')) {
          setProgStep(id, 'Failed', 'error');
        }
      });

    }
  }

  function resetAll() {
    state.selectedFile = null;
    state.fileBytes = null;
    state.result = null;
    state.customThumbnail = null;
    state.processingResult = null;
    state.processingError = null;
    state.processingRunning = false;
    state.metadataUploaded = false;
    state.metaCid = null;
    state.draftId = null;
    state._mintResolve = null;
    clearFile();
    // Reset thumbnail picker UI
    if (dom.thumbPreviewImg) dom.thumbPreviewImg.src = '';
    if (dom.thumbPreview) dom.thumbPreview.classList.add('hidden');
    if (dom.thumbDropZone) dom.thumbDropZone.classList.remove('hidden');
    if (dom.thumbInput) dom.thumbInput.value = '';
    dom.assetTitle.value = '';
    dom.assetDescription.value = '';
    dom.assetCategory.value = '';
    dom.assetPrice.value = '4.99';
    dom.assetAccess.value = 'free';
    dom.assetCopies.value = '10000';
    state.channelsLoaded = false;
    dom.progressError.classList.add('hidden');
    if (dom.btnBackTo2) dom.btnBackTo2.disabled = false;

    // Reset channel creation form
    var channelConfig = document.getElementById('channel-create-config');
    if (channelConfig) channelConfig.style.display = 'none';
    var channelNameInput = document.getElementById('new-channel-name');
    if (channelNameInput) channelNameInput.value = '';
    var channelDescInput = document.getElementById('new-channel-description');
    if (channelDescInput) channelDescInput.value = '';

    // Reset licensing section
    var ltHidden = document.getElementById('license-type');
    if (ltHidden) ltHidden.value = 'perpetual';
    var aiToggle = document.getElementById('ai-training-toggle');
    if (aiToggle) { aiToggle.classList.remove('active'); aiToggle.setAttribute('aria-checked', 'false'); }
    var adultToggle = document.getElementById('adult-toggle');
    if (adultToggle) { adultToggle.classList.remove('active'); adultToggle.setAttribute('aria-checked', 'false'); }
    var adultCheck = document.getElementById('adult-content-check');
    if (adultCheck) adultCheck.checked = false;

    PROGRESS_STEPS.forEach(function (id) {
      setProgStep(id, 'Waiting...', '');
    });
    restoreProgressStepsDefault();
    resetMediaSubSteps();
    hideFloatingProgress();

    goToStep(1);
  }

  // ── Copy buttons ──────────────────────────────────────

  function setupCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('data-copy');
        var el = document.getElementById(targetId);
        if (el && el.textContent) {
          navigator.clipboard.writeText(el.textContent).then(function () {
            showToast('Copied to clipboard', 'success');
          });
        }
      });
    });
  }

  // ── Init ──────────────────────────────────────────────

  function init() {
    cacheDom();
    setupCopyButtons();

    // Wallet
    dom.walletBtn.addEventListener('click', connectWallet);

    // File selection
    dom.dropZone.addEventListener('click', function () { dom.fileInput.click(); });
    dom.fileInput.addEventListener('change', function () {
      if (dom.fileInput.files.length > 0) handleFileSelected(dom.fileInput.files[0]);
    });
    dom.fileRemove.addEventListener('click', clearFile);

    // Drag & drop
    dom.dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dom.dropZone.classList.add('drag-over');
    });
    dom.dropZone.addEventListener('dragleave', function () {
      dom.dropZone.classList.remove('drag-over');
    });
    dom.dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dom.dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) handleFileSelected(e.dataTransfer.files[0]);
    });

    // Thumbnail picker
    var THUMB_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
    var THUMB_ACCEPT = ['image/png', 'image/jpeg', 'image/jpg', 'image/bmp', 'image/webp'];

    function handleThumbSelected(file) {
      if (!file) return;
      if (THUMB_ACCEPT.indexOf(file.type) === -1 && !file.type.startsWith('image/')) {
        showToast('Thumbnail must be an image (PNG, JPG, BMP, WebP)', 'error');
        return;
      }
      if (file.size > THUMB_MAX_BYTES) {
        showToast('Thumbnail must be under 2 MB', 'error');
        return;
      }
      state.customThumbnail = file;
      var reader = new FileReader();
      reader.onload = function (ev) {
        dom.thumbPreviewImg.src = ev.target.result;
        dom.thumbPreview.classList.remove('hidden');
        dom.thumbDropZone.classList.add('hidden');
      };
      reader.readAsDataURL(file);
    }

    function clearThumb() {
      state.customThumbnail = null;
      dom.thumbPreviewImg.src = '';
      dom.thumbPreview.classList.add('hidden');
      dom.thumbDropZone.classList.remove('hidden');
      dom.thumbInput.value = '';
    }

    dom.thumbDropZone.addEventListener('click', function () { dom.thumbInput.click(); });
    dom.thumbInput.addEventListener('change', function () {
      if (dom.thumbInput.files.length > 0) handleThumbSelected(dom.thumbInput.files[0]);
    });
    dom.thumbRemove.addEventListener('click', clearThumb);
    dom.thumbDropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dom.thumbDropZone.classList.add('drag-over');
    });
    dom.thumbDropZone.addEventListener('dragleave', function () {
      dom.thumbDropZone.classList.remove('drag-over');
    });
    dom.thumbDropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dom.thumbDropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) handleThumbSelected(e.dataTransfer.files[0]);
    });

    // Show channel creation form
    function showChannelCreateForm() {
      var configPanel = document.getElementById('channel-create-config');
      if (configPanel) configPanel.style.display = '';
      var nameInput = document.getElementById('new-channel-name');
      if (nameInput) nameInput.focus();
    }

    function hideChannelCreateForm() {
      var configPanel = document.getElementById('channel-create-config');
      if (configPanel) configPanel.style.display = 'none';
      var nameInput = document.getElementById('new-channel-name');
      var descInput = document.getElementById('new-channel-description');
      if (nameInput) nameInput.value = '';
      if (descInput) descInput.value = '';
    }

    // Create Channel button (shows the creation form)
    var btnCreateChannel = document.getElementById('btn-create-channel');
    if (btnCreateChannel) {
      btnCreateChannel.addEventListener('click', function () {
        if (!state.walletAddress) {
          showToast('Connect your wallet first', 'error');
          return;
        }
        showChannelCreateForm();
      });
    }

    // "Create Your First Channel" button (empty state)
    var btnCreateFirst = document.getElementById('btn-create-first-channel');
    if (btnCreateFirst) {
      btnCreateFirst.addEventListener('click', function () {
        if (!state.walletAddress) {
          showToast('Connect your wallet first', 'error');
          return;
        }
        showChannelCreateForm();
      });
    }

    // Cancel channel creation
    var btnCancelChannel = document.getElementById('btn-cancel-channel');
    if (btnCancelChannel) {
      btnCancelChannel.addEventListener('click', function () {
        hideChannelCreateForm();
      });
    }

    // Deploy channel (from creation form)
    var btnDeployChannel = document.getElementById('btn-deploy-channel');
    if (btnDeployChannel) {
      btnDeployChannel.addEventListener('click', async function () {
        var channelNameInput = document.getElementById('new-channel-name');
        var channelDescInput = document.getElementById('new-channel-description');
        var channelName = (channelNameInput ? channelNameInput.value.trim() : '') || 'My Channel';
        var channelDesc = (channelDescInput ? channelDescInput.value.trim() : '') || 'Digital assets channel on Elacity';
        var channelHint = document.getElementById('channel-hint');

        if (!state.walletAddress) {
          showToast('Connect your wallet first', 'error');
          return;
        }

        var channelWalletChoice = await showWalletChoice('Choose Wallet for Channel');

        btnDeployChannel.disabled = true;
        btnDeployChannel.textContent = 'Deploying...';

        try {
          var result = await doCreateChannel(channelName, channelDesc, channelWalletChoice);
          showToast('Channel created: ' + result.address.substring(0, 10) + '...', 'success');
          hideChannelCreateForm();
          state.channelsLoaded = false;
          await loadChannels(state.walletAddress);

          var found = false;
          for (var i = 0; i < dom.assetChannel.options.length; i++) {
            if (dom.assetChannel.options[i].value.toLowerCase() === result.address.toLowerCase()) {
              found = true;
              break;
            }
          }
          if (!found) {
            var ownerLabel = result.ownerType === 'sa' ? 'Agent Account' : 'Wallet';
            var newGroup = dom.assetChannel.querySelector('optgroup[data-group="' + result.ownerType + '"]');
            if (!newGroup) {
              newGroup = document.createElement('optgroup');
              newGroup.label = 'Your Channels — ' + ownerLabel + ' (1)';
              newGroup.setAttribute('data-group', result.ownerType);
              dom.assetChannel.insertBefore(newGroup, dom.assetChannel.firstChild);
            }
            var newOpt = document.createElement('option');
            newOpt.value = result.address;
            newOpt.setAttribute('data-owner', result.ownerType);
            newOpt.textContent = result.name + ' (' + result.address.substring(0, 8) + '...)';
            newGroup.appendChild(newOpt);
          }

          dom.assetChannel.value = result.address;
          dom.assetChannelCustom.classList.add('hidden');
          var walletLabel = result.ownerType === 'sa' ? 'Agent Account' : 'EOA Wallet';
          if (channelHint) {
            channelHint.textContent = 'Your channel: ' + result.address.substring(0, 10) + '... (' + walletLabel + ' — full minting rights)';
            channelHint.className = 'field-hint success';
          }
          validateStep1();
        } catch (err) {
          if (channelHint) {
            channelHint.textContent = 'Channel creation failed: ' + (err.message || '').substring(0, 80);
            channelHint.className = 'field-hint';
          }
          showToast('Channel creation failed: ' + (err.message || ''), 'error');
        } finally {
          btnDeployChannel.disabled = false;
          btnDeployChannel.textContent = 'Deploy Channel';
        }
      });
    }

    dom.assetChannel.addEventListener('change', function () {
      var isCustom = dom.assetChannel.value === '__custom__';
      dom.assetChannelCustom.classList.toggle('hidden', !isCustom);
      if (isCustom) {
        dom.assetChannelCustom.focus();
        validateStep1();
        return;
      }
      var ownerType = getChannelOwnerType(dom.assetChannel);
      var hint = document.getElementById('channel-hint');
      if (hint && ownerType) {
        var label = ownerType === 'sa' ? 'Agent Account' : 'EOA Wallet';
        hint.textContent = 'Channel selected (' + label + ') — minting will use ' + label + '.';
        hint.className = 'field-hint success';
      }
      validateStep1();
    });

    // Tab switching
    document.querySelectorAll('.header-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-tab')); });
    });

    // Channels view: selector change loads management
    var manageSelect = document.getElementById('manage-channel-select');
    if (manageSelect) {
      manageSelect.addEventListener('change', function () {
        if (manageSelect.value && ethers.isAddress(manageSelect.value)) {
          showChannelManagement();
        } else {
          hideChannelManagement();
        }
      });
    }

    var btnChannelsCreate = document.getElementById('btn-channels-create');
    if (btnChannelsCreate) {
      btnChannelsCreate.addEventListener('click', function () {
        if (!state.walletAddress) { showToast('Connect your wallet first', 'error'); return; }
        switchTab('mint');
        showChannelCreateForm();
      });
    }

    var btnSaveDetails = document.getElementById('btn-save-channel-details');
    if (btnSaveDetails) btnSaveDetails.addEventListener('click', saveChannelDetails);

    var btnManageAddPlan = document.getElementById('btn-manage-add-plan');
    if (btnManageAddPlan) {
      btnManageAddPlan.addEventListener('click', function () {
        addManagePlanRow({ price: '5', payToken: USDC_BASE, duration: { value: 1, unit: 'months' }, label: '', description: '' });
      });
    }

    var btnManageAddGate = document.getElementById('btn-manage-add-gate');
    if (btnManageAddGate) {
      btnManageAddGate.addEventListener('click', function () {
        addManageGateRow({ address: '', value: '1' });
      });
    }

    // Save token gates button -- add a save button dynamically if gates exist
    var gatesBody = document.getElementById('manage-gates-body');
    if (gatesBody) {
      var saveGatesBtn = document.createElement('button');
      saveGatesBtn.type = 'button';
      saveGatesBtn.className = 'inline-btn primary';
      saveGatesBtn.textContent = 'Save Token Gates';
      saveGatesBtn.style.marginTop = '8px';
      saveGatesBtn.addEventListener('click', saveTokenGates);
      gatesBody.appendChild(saveGatesBtn);
    }

    // Collapsible section headers
    document.querySelectorAll('.manage-section-header').forEach(function (header) {
      header.addEventListener('click', function () {
        var targetId = header.getAttribute('data-target');
        var body = document.getElementById(targetId);
        if (!body) return;
        var chevron = header.querySelector('.manage-chevron');
        if (body.style.display === 'none') {
          body.style.display = '';
          if (chevron) chevron.innerHTML = '&#9660;';
        } else {
          body.style.display = 'none';
          if (chevron) chevron.innerHTML = '&#9654;';
        }
      });
    });

    // Reseller cut slider
    var resellerSlider = document.getElementById('reseller-cut');
    var resellerGroup = document.getElementById('reseller-cut-group');
    if (resellerSlider) {
      resellerSlider.addEventListener('input', function () {
        var pct = parseInt(resellerSlider.value) / 10;
        document.getElementById('reseller-cut-display').textContent = pct + '%';
        document.getElementById('reseller-pct').textContent = pct;
        document.getElementById('partner-pct').textContent = (100 - pct);
      });
    }

    // Show/hide reseller cut + price + distribution based on access method
    dom.assetAccess.addEventListener('change', function () {
      var val = dom.assetAccess.value;
      var isFree = val === 'free';
      if (resellerGroup) {
        resellerGroup.style.display = val === 'buy_and_resell' ? '' : 'none';
      }
      var priceRow = document.getElementById('step1-price-row');
      if (priceRow) priceRow.style.display = isFree ? 'none' : '';

      var distSection = document.querySelector('[data-section="distribution"]');
      if (distSection) distSection.style.display = isFree ? 'none' : '';
    });

    // Revenue calc update
    if (dom.assetPrice) {
      dom.assetPrice.addEventListener('input', updateRevenueCalc);
    }
    if (dom.assetCopies) {
      dom.assetCopies.addEventListener('input', updateRevenueCalc);
    }

    // Supply tier presets
    document.querySelectorAll('.supply-preset').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var supply = parseInt(btn.getAttribute('data-supply'));
        var tierPrice = parseFloat(btn.getAttribute('data-price'));
        if (dom.assetCopies) dom.assetCopies.value = supply;
        if (dom.assetPrice) dom.assetPrice.value = tierPrice;
        updateRevenueCalc();
      });
    });

    // Add royalty partner
    var btnAddRoyalty = document.getElementById('btn-add-royalty');
    if (btnAddRoyalty) {
      btnAddRoyalty.addEventListener('click', function () {
        var container = document.getElementById('royalty-container');
        var row = document.createElement('div');
        row.className = 'royalty-row';
        row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
        row.innerHTML = '<select class="royalty-role" style="width:90px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);"><option value="B" selected>Partner</option><option value="C">Distributor</option></select>' +
          '<input class="royalty-address" type="text" placeholder="0x... wallet" style="flex:1; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);" />' +
          '<input class="royalty-percent" type="number" min="0.1" max="94.9" step="0.1" value="10" style="width:70px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text); text-align:right;" />' +
          '<span style="font-size:12px; color:var(--text-muted);">%</span>' +
          '<button type="button" class="royalty-remove" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; font-size:14px; line-height:1; font-family:inherit; background:var(--error); color:white; border:none; border-radius:4px; cursor:pointer;">&times;</button>';
        container.appendChild(row);
        row.querySelector('.royalty-remove').addEventListener('click', function () { row.remove(); });
      });
    }

    // Auto-fill creator address in first royalty row
    function fillCreatorRoyaltyAddress() {
      if (!state.walletAddress) return;
      var firstAddr = document.querySelector('.royalty-row .royalty-address');
      if (firstAddr && !firstAddr.value) firstAddr.value = state.walletAddress;
    }

    // Add subscription plan
    var btnAddPlan = document.getElementById('btn-add-plan');
    if (btnAddPlan) {
      btnAddPlan.addEventListener('click', function () {
        addPlanRow({ price: '5', duration: '1 Month' });
      });
    }

    // Use default 3-tier plans
    var btnDefaultPlans = document.getElementById('btn-use-default-plans');
    if (btnDefaultPlans) {
      btnDefaultPlans.addEventListener('click', function () {
        var container = document.getElementById('plans-container');
        container.innerHTML = '';
        DEFAULT_PLANS.forEach(function (p) {
          addPlanRow({ price: p.price, duration: p.label, description: p.description, payToken: p.payToken });
        });
      });
    }

    function addPlanRow(defaults) {
      var container = document.getElementById('plans-container');
      var row = document.createElement('div');
      row.className = 'plan-row';
      row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
      var durOptions = DURATION_OPTIONS.map(function (d) {
        var sel = d.label === (defaults.duration || '1 Month') ? ' selected' : '';
        return '<option value="' + d.label + '"' + sel + '>' + d.label + '</option>';
      }).join('');
      var defaultToken = defaults.payToken || USDC_BASE;
      var currencyOptions = CURRENCIES.map(function (c) {
        var sel = c.address === defaultToken ? ' selected' : '';
        return '<option value="' + c.address + '"' + sel + '>' + c.symbol + '</option>';
      }).join('');
      row.innerHTML = '<select class="plan-duration" style="width:110px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);">' + durOptions + '</select>' +
        '<input class="plan-price" type="number" min="0.01" step="0.01" value="' + (defaults.price || '5') + '" placeholder="Price" style="width:80px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text); text-align:right;" />' +
        '<select class="plan-currency" style="width:72px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);">' + currencyOptions + '</select>' +
        '<input class="plan-label" type="text" placeholder="Description" value="' + (defaults.description || '') + '" style="flex:1; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);" />' +
        '<button type="button" class="plan-remove" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; font-size:14px; line-height:1; font-family:inherit; background:var(--error); color:white; border:none; border-radius:4px; cursor:pointer;">&times;</button>';
      container.appendChild(row);
      row.querySelector('.plan-remove').addEventListener('click', function () { row.remove(); });
    }

    // Add token gate
    var btnAddTokenGate = document.getElementById('btn-add-token-gate');
    if (btnAddTokenGate) {
      btnAddTokenGate.addEventListener('click', function () {
        var container = document.getElementById('token-gate-container');
        var row = document.createElement('div');
        row.className = 'token-gate-row';
        row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
        row.innerHTML = '<input class="token-gate-address" type="text" placeholder="0x... token contract" style="flex:1; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text);" />' +
          '<input class="token-gate-value" type="number" min="1" step="1" value="1" placeholder="Min balance" style="width:80px; padding:6px; font-size:12px; border:1px solid var(--border); border-radius:4px; background:var(--bg-elevated); color:var(--text); text-align:right;" />' +
          '<span class="token-gate-info" style="font-size:11px; color:var(--text-muted); min-width:60px;"></span>' +
          '<button type="button" class="token-gate-remove" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; font-size:14px; line-height:1; font-family:inherit; background:var(--error); color:white; border:none; border-radius:4px; cursor:pointer;">&times;</button>';
        container.appendChild(row);
        row.querySelector('.token-gate-remove').addEventListener('click', function () { row.remove(); });

        // Token introspection on blur
        var addrInput = row.querySelector('.token-gate-address');
        var infoSpan = row.querySelector('.token-gate-info');
        addrInput.addEventListener('blur', async function () {
          var addr = addrInput.value.trim();
          if (!addr || !ethers.isAddress(addr)) { infoSpan.textContent = ''; return; }
          try {
            var iface = new ethers.Interface(ERC20_ABI);
            var nameData = await rpcCall(addr, iface.encodeFunctionData('symbol', []));
            var sym = iface.decodeFunctionResult('symbol', nameData)[0];
            infoSpan.textContent = sym;
            infoSpan.style.color = 'var(--success)';
          } catch (_) {
            infoSpan.textContent = 'NFT?';
            infoSpan.style.color = 'var(--text-muted)';
          }
        });
      });
    }

    // Channel plans/token-gating are always visible in the creation form now

    // Preview duration display
    var previewDurSlider = document.getElementById('preview-duration');
    if (previewDurSlider) {
      previewDurSlider.addEventListener('input', function () {
        document.getElementById('preview-duration-display').textContent = previewDurSlider.value + 's';
      });
    }

    // Royalty percent inputs — validate on change
    document.addEventListener('input', function (e) {
      if (e.target && e.target.classList.contains('royalty-percent')) validateStep2();
    });

    // Step 3 legal checkboxes
    document.addEventListener('change', function (e) {
      if (e.target && e.target.classList.contains('legal-check')) validateStep3();
    });

    // Wire the custom toggle to the hidden checkboxes
    var legalToggle = document.getElementById('legal-toggle');
    if (legalToggle) {
      legalToggle.addEventListener('click', function () {
        var isActive = legalToggle.classList.toggle('active');
        legalToggle.setAttribute('aria-checked', String(isActive));
        var checks = document.querySelectorAll('.legal-check');
        checks.forEach(function (cb) { cb.checked = isActive; });
        validateStep3();
      });
    }

    // Wire card selectors (access method + licensing)
    wireCardSelector('access-cards', 'asset-access', function (val) {
      var isFree = val === 'free';

      var priceRow = document.getElementById('step1-price-row');
      if (priceRow) priceRow.style.display = isFree ? 'none' : '';

      var resellerGroup = document.getElementById('reseller-cut-group');
      if (resellerGroup) resellerGroup.style.display = val === 'buy_and_resell' ? '' : 'none';

      var distSection = document.querySelector('[data-section="distribution"]');
      if (distSection) distSection.style.display = isFree ? 'none' : '';

      validateStep1();
      validateStep2();
    });

    var aiTrainingToggle = document.getElementById('ai-training-toggle');
    if (aiTrainingToggle) {
      aiTrainingToggle.addEventListener('click', function () {
        var isActive = aiTrainingToggle.classList.toggle('active');
        aiTrainingToggle.setAttribute('aria-checked', String(isActive));
        var hidden = document.getElementById('license-type');
        if (hidden) hidden.value = isActive ? 'training-rights' : 'perpetual';
      });
    }

    var adultToggle = document.getElementById('adult-toggle');
    if (adultToggle) {
      adultToggle.addEventListener('click', function () {
        var isActive = adultToggle.classList.toggle('active');
        adultToggle.setAttribute('aria-checked', String(isActive));
        var hidden = document.getElementById('adult-content-check');
        if (hidden) hidden.checked = isActive;
      });
    }

    // Step 1 channel validation
    ['input', 'change'].forEach(function (evt) {
      dom.assetChannel.addEventListener(evt, validateStep1);
      dom.assetChannelCustom.addEventListener(evt, validateStep1);
    });

    // Step 3 form validation (describe step)
    ['input', 'change'].forEach(function (evt) {
      dom.assetTitle.addEventListener(evt, validateStep2);
      dom.assetCategory.addEventListener(evt, validateStep2);
      dom.assetPrice.addEventListener(evt, validateStep2);
      dom.assetAccess.addEventListener(evt, validateStep2);
    });

    // Step 1 → Step 2: channel + file selected, go to describe form and start pipeline
    dom.btnToStep2.addEventListener('click', function () {
      goToStep(2);
      var prevEnabled = document.getElementById('preview-enabled');
      var prevDur = document.getElementById('preview-duration');
      if (prevEnabled) prevEnabled.disabled = true;
      if (prevDur) prevDur.disabled = true;
      validateStep2();
      if (!state.processingRunning) {
        state.processingRunning = true;
        runPipeline();
      }
    });

    dom.btnBackTo1.addEventListener('click', function () { goToStep(1); });

    // Step 2 → Step 3: validate form, then show review page where pipeline progress is visible
    dom.btnToStep3.addEventListener('click', async function () {
      if (!state.walletAddress) {
        showToast('Connect your wallet first', 'error');
        return;
      }
      var ch = getSelectedChannel();
      if (!ch || !ethers.isAddress(ch)) {
        showToast('Channel selection required — go back to Step 1', 'error');
        return;
      }
      goToStep(3);

      var reviewEl = document.getElementById('review-summary');
      if (reviewEl) {
        var p = parseFloat(dom.assetPrice.value) || 0;
        var c = parseInt(dom.assetCopies.value) || 0;
        var currency = CURRENCIES.find(function (cur) { return cur.address === getSelectedCurrencyAddress(); }) || CURRENCIES[0];
        var accessLabel = dom.assetAccess.value === 'buy_and_resell' ? 'Buy & Resell'
          : dom.assetAccess.value === 'buy_once' ? 'Buy Once' : 'Free';
        var channelVal = dom.assetChannel.value || '';
        var channelDisplay = channelVal.length > 12 ? channelVal.substring(0, 8) + '...' + channelVal.slice(-4) : channelVal;
        var isFreeReview = dom.assetAccess.value === 'free';
        var rows = [
          { label: 'Title', value: dom.assetTitle.value || 'Untitled' },
          { label: 'Price', value: isFreeReview ? 'Free' : p.toFixed(2) + ' ' + currency.symbol },
        ];
        if (!isFreeReview) rows.push({ label: 'Copies', value: c.toLocaleString() });
        rows.push({ label: 'Access', value: accessLabel });
        rows.push({ label: 'Channel', value: channelDisplay });
        var desc = (dom.assetDescription.value || '').trim();
        if (desc) {
          rows.splice(1, 0, { label: 'Description', value: desc.length > 60 ? desc.substring(0, 60) + '...' : desc });
        }
        var licensingData = getLicensingData();
        if (licensingData.type === 'training-rights') {
          rows.push({ label: 'AI Training', value: 'Allowed (' + (licensingData.aiTraining.scope || 'commercial') + ')' });
        }
        var adultCheck = document.getElementById('adult-content-check');
        if (adultCheck && adultCheck.checked) {
          rows.push({ label: 'Adult Content', value: '18+ Flagged' });
        }
        reviewEl.innerHTML = rows.map(function (r) {
          return '<div class="review-row"><span class="review-label">' + r.label + '</span><span class="review-value">' + r.value + '</span></div>';
        }).join('');
      }
    });

    var btnSignMint = document.getElementById('btn-sign-mint');
    if (btnSignMint) {
      btnSignMint.addEventListener('click', function () {
        if (state._mintResolve) {
          btnSignMint.disabled = true;
          state._mintResolve();
          state._mintResolve = null;
        }
      });
    }

    dom.btnBackTo2.addEventListener('click', function () { goToStep(2); });
    dom.btnNewAsset.addEventListener('click', resetAll);

    var btnPublishLater = document.getElementById('btn-publish-later');
    if (btnPublishLater) {
      btnPublishLater.addEventListener('click', function () {
        showToast('Saved — you can publish from the toolbar later', 'success');
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ msg: 'mint-draft-saved' }, '*');
            setTimeout(function () {
              window.parent.postMessage({ msg: 'mint-close-creator' }, '*');
            }, 1000);
          }
        } catch (_) { }
      });
    }

    // ── Fix Gateway Approval tool ──────────────────────
    var fixOpInput = document.getElementById('fix-operative-addr');
    var fixStatus = document.getElementById('fix-approval-status');
    var btnCheck = document.getElementById('btn-check-approval');
    var btnFix = document.getElementById('btn-fix-approval');

    btnCheck.addEventListener('click', async function () {
      var addr = fixOpInput.value.trim();
      if (!ethers.isAddress(addr)) {
        fixStatus.textContent = 'Enter a valid operative address';
        fixStatus.className = 'tool-status error';
        fixStatus.classList.remove('hidden');
        return;
      }
      fixStatus.textContent = 'Checking approval status...';
      fixStatus.className = 'tool-status checking';
      fixStatus.classList.remove('hidden');
      btnFix.disabled = true;

      try {
        var opIface = new ethers.Interface(ABI.OPERATIVE);
        var checkData = opIface.encodeFunctionData('isApprovedForAll', [
          state.walletAddress || '0x0000000000000000000000000000000000000000',
          CONTRACTS.AUTHORITY_GATEWAY,
        ]);
        var result = await rpcCall(addr, checkData);
        var decoded = opIface.decodeFunctionResult('isApprovedForAll', result);
        var isApproved = decoded[0];

        if (isApproved) {
          fixStatus.textContent = '✅ Gateway is already approved on this operative.';
          fixStatus.className = 'tool-status approved';
          btnFix.disabled = true;
        } else {
          fixStatus.textContent = '❌ Gateway NOT approved. Click "Send Approval Tx" to fix.';
          fixStatus.className = 'tool-status not-approved';
          btnFix.disabled = false;
        }
      } catch (err) {
        fixStatus.textContent = 'Check failed: ' + (err.message || '').substring(0, 80);
        fixStatus.className = 'tool-status error';
      }
    });

    btnFix.addEventListener('click', async function () {
      var addr = fixOpInput.value.trim();
      if (!ethers.isAddress(addr)) return;
      if (!state.walletAddress) {
        showToast('Connect your wallet first', 'error');
        return;
      }

      fixStatus.textContent = 'Sending setApprovalForAll — confirm in wallet...';
      fixStatus.className = 'tool-status sending';
      btnFix.disabled = true;
      btnCheck.disabled = true;

      try {
        var opIface = new ethers.Interface(ABI.OPERATIVE);
        var txData = opIface.encodeFunctionData('setApprovalForAll', [CONTRACTS.AUTHORITY_GATEWAY, true]);
        var txHash = await sendTx(addr, txData);
        fixStatus.textContent = 'Tx sent (' + txHash.substring(0, 14) + '...) — waiting for confirmation...';
        fixStatus.className = 'tool-status sending';

        var receipt = await waitForReceipt(txHash);
        if (receipt.status === 'timeout') {
          fixStatus.textContent = '⏳ Tx sent but receipt timed out. Check BaseScan: ' + txHash.substring(0, 14) + '...';
          fixStatus.className = 'tool-status checking';
        } else if (receipt.status === '0x1' || receipt.status === 1) {
          fixStatus.textContent = '✅ Gateway approval set! You can now purchase this asset on ela.city.';
          fixStatus.className = 'tool-status approved';
        } else {
          fixStatus.textContent = '❌ Transaction reverted. Check BaseScan: ' + txHash;
          fixStatus.className = 'tool-status error';
        }
        showToast('Approval transaction processed', 'success');
      } catch (err) {
        fixStatus.textContent = 'Failed: ' + (err.message || '').substring(0, 100);
        fixStatus.className = 'tool-status error';
        showToast('Approval failed: ' + (err.message || ''), 'error');
      } finally {
        btnCheck.disabled = false;
      }
    });

    // Auto-populate operative from last result if available
    if (state.result && state.result.opContract) {
      fixOpInput.value = state.result.opContract;
    }

    // Watch for result changes to auto-populate and auto-open if approval failed
    var origGoToStep = window._goToStep || goToStep;
    var _origGoToStep4 = goToStep;
    var approvalObserver = new MutationObserver(function () {
      if (state.result && state.result.opContract && !fixOpInput.value) {
        fixOpInput.value = state.result.opContract;
      }
      var approveStatus = document.getElementById('prog-approve-status');
      if (approveStatus && approveStatus.textContent && approveStatus.textContent.indexOf('Failed') !== -1) {
        document.getElementById('fix-approval-details').open = true;
        if (state.result && state.result.opContract) {
          fixOpInput.value = state.result.opContract;
        }
      }
    });
    approvalObserver.observe(document.getElementById('step-4') || document.body, { childList: true, subtree: true, characterData: true });

    // Auto-connect wallet and switch to Base chain
    if (window.ethereum) {
      // Switch to Base first — Elastos NFT may have set bridge to ESC
      window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] })
        .catch(function () { })
        .then(function () {
          return window.ethereum.request({ method: 'eth_accounts' });
        })
        .then(function (accounts) {
          if (accounts && accounts[0]) {
            state.walletAddress = accounts[0];
            dom.walletBtn.textContent = accounts[0].substring(0, 6) + '...' + accounts[0].slice(-4);
            dom.walletBtn.classList.add('connected');

            // Detect Smart Account from wallet provider or RPC
            if (!smartAccountAddress && window.ethereum.smartAccountAddress) {
              smartAccountAddress = window.ethereum.smartAccountAddress;
            }

            // Wait for SA detection (up to 3s) before loading channels
            var saPromise = Promise.resolve();
            if (!smartAccountAddress && window.ethereum.request) {
              saPromise = Promise.race([
                window.ethereum.request({ method: 'pc2_getSmartAccountAddress' })
                  .then(function (sa) {
                    if (sa && sa.toLowerCase() !== accounts[0].toLowerCase()) {
                      smartAccountAddress = sa;
                      console.log('[Creator] SA detected via RPC:', sa);
                    }
                  })
                  .catch(function () { }),
                new Promise(function (resolve) { setTimeout(resolve, 3000); })
              ]);
            }

            saPromise.then(function () {
              if (!state.channelsLoaded) {
                loadChannels(accounts[0]);
              }
            });
          }
        })
        .catch(function () { });
    }

    // Listen for late-arriving SA address from wallet bridge init
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'pc2-wallet-init' && e.data.smartAccountAddress) {
        var sa = e.data.smartAccountAddress;
        if (!smartAccountAddress && sa.toLowerCase() !== (state.walletAddress || '').toLowerCase()) {
          smartAccountAddress = sa;
          console.log('[Creator] SA from wallet-init event:', sa);
          if (state.walletAddress && !state.channelsLoaded) {
            loadChannels(state.walletAddress);
          } else if (state.walletAddress && state.channelsLoaded) {
            state.channelsLoaded = false;
            loadChannels(state.walletAddress);
          }
        }
      }
    });

    // Resume from saved draft (launched from toolbar queue)
    async function resumeFromDraft(draftId) {
      try {
        var resp = await pc2Fetch('/api/drafts/' + draftId);
        if (!resp.ok) throw new Error('Draft not found');
        var draft = await resp.json();

        if (state.walletAddress && state.walletAddress.toLowerCase() !== draft.wallet_address.toLowerCase()) {
          showToast('Wallet mismatch — this draft belongs to a different wallet', 'error');
          return;
        }

        // Populate form fields from draft
        if (dom.assetTitle) dom.assetTitle.value = draft.title || '';
        if (dom.assetDescription) dom.assetDescription.value = draft.description || '';
        if (dom.assetCategory) dom.assetCategory.value = draft.category || '';
        if (dom.assetPrice) dom.assetPrice.value = draft.price || '0';
        if (dom.assetAccess) dom.assetAccess.value = draft.access_method || 'buy_and_resell';
        if (dom.assetCopies) dom.assetCopies.value = draft.copies || 10000;
        var channelSel = dom.assetChannel;
        var draftOwner = draft.wallet_choice || null;
        if (channelSel && draft.channel) {
          channelSel.value = draft.channel;
          if (channelSel.value === draft.channel) {
            var selOpt = channelSel.options[channelSel.selectedIndex];
            if (selOpt && draftOwner && !selOpt.getAttribute('data-owner')) {
              selOpt.setAttribute('data-owner', draftOwner);
            }
          } else {
            var draftOpt = document.createElement('option');
            draftOpt.value = draft.channel;
            draftOpt.textContent = (draft.title || 'Draft') + ' (' + draft.channel.substring(0, 8) + '...)';
            if (draftOwner) draftOpt.setAttribute('data-owner', draftOwner);
            channelSel.insertBefore(draftOpt, channelSel.firstChild);
            channelSel.value = draft.channel;
          }
        }
        var currSel = document.getElementById('asset-currency');
        if (currSel && draft.currency_address) currSel.value = draft.currency_address;
        var adultCheck = document.getElementById('adult-content-check');
        if (adultCheck) adultCheck.checked = !!draft.adult;

        // Set state as if pipeline completed
        state.metaCid = draft.metadata_cid;
        state.metadataUploaded = true;
        state.processingRunning = false;
        state.draftId = draftId;

        // Update file preview with draft info
        var fileInfo = document.getElementById('file-info');
        if (fileInfo) {
          fileInfo.innerHTML = '<strong>' + (draft.file_name || 'Untitled') + '</strong><br>' +
            '<span style="color:#888">' + (draft.mime_type || '') + ' — ' + formatSize(draft.file_size || 0) + '</span>';
        }
        var filePreview = document.getElementById('file-preview-area');
        if (filePreview) filePreview.classList.remove('hidden');

        // Jump to step 3 (review & sign) with all progress steps done
        ['prog-fragment', 'prog-encrypt', 'prog-upload', 'prog-finalize', 'prog-upload-meta', 'prog-pin'].forEach(function (id) {
          setProgStep(id, 'Done (from saved draft)', 'done');
        });

        goToStep(3);

        // Build review summary card from draft data
        var reviewEl = document.getElementById('review-summary');
        if (reviewEl) {
          var draftPrice = parseFloat(draft.price) || 0;
          var draftCopies = draft.copies || 10000;
          var draftCurrency = CURRENCIES.find(function (c) { return c.address === draft.currency_address; }) || CURRENCIES[0];
          var draftAccessLabel = draft.access_method === 'buy_and_resell' ? 'Buy & Resell'
            : draft.access_method === 'buy_once' ? 'Buy Once' : 'Free';
          var isDraftFree = draft.access_method === 'free';
          var rows = [
            { label: 'Title', value: draft.title || 'Untitled' },
            { label: 'Category', value: draft.category || '—' },
            { label: 'Price', value: isDraftFree ? 'Free' : draftPrice.toFixed(2) + ' ' + draftCurrency.symbol },
          ];
          if (!isDraftFree) rows.push({ label: 'Copies', value: draftCopies.toLocaleString() });
          rows.push({ label: 'Access', value: draftAccessLabel });
          rows.push({ label: 'Channel', value: (draft.channel || '').length > 12 ? (draft.channel || '').substring(0, 8) + '...' + (draft.channel || '').slice(-4) : (draft.channel || '') });
          if (draft.description) {
            rows.splice(1, 0, { label: 'Description', value: draft.description.length > 60 ? draft.description.substring(0, 60) + '...' : draft.description });
          }
          reviewEl.innerHTML = rows.map(function (r) {
            return '<div class="review-row"><span class="review-label">' + r.label + '</span><span class="review-value">' + r.value + '</span></div>';
          }).join('');
        }

        // Populate step 4 summary grid
        var priceSum = document.getElementById('result-summary-price-val');
        var copiesSum = document.getElementById('result-summary-copies-val');
        var channelSum = document.getElementById('result-summary-channel-val');
        if (priceSum) {
          var dCur = CURRENCIES.find(function (c) { return c.address === draft.currency_address; }) || CURRENCIES[0];
          priceSum.textContent = draft.access_method === 'free' ? 'Free' : (parseFloat(draft.price) || 0).toFixed(2) + ' ' + dCur.symbol;
        }
        if (copiesSum) copiesSum.textContent = (draft.copies || 10000).toLocaleString();
        if (channelSum) channelSum.textContent = (draft.channel || '').substring(0, 8) + '...' + (draft.channel || '').slice(-4);

        setProgStep('prog-mint', 'Ready — check the boxes below and click Sign & Mint', 'active');
        var publishLaterBtn2 = document.getElementById('btn-publish-later');
        if (publishLaterBtn2) publishLaterBtn2.style.display = '';
        validateStep3();

        showToast('Draft loaded — review and sign to publish', 'success');

        // Wait for user to click Sign & Mint
        await new Promise(function (resolve) {
          state._mintResolve = resolve;
        });

        // Execute mint using draft data
        var channel = draft.channel;
        var metaCid = draft.metadata_cid;
        var encryptHash = draft.encrypt_hash;
        var price = parseFloat(draft.price) || 0;
        var accessMethod = draft.access_method || 'buy_and_resell';
        var copies = draft.copies || 10000;
        var selectedCurrency = CURRENCIES.find(function (c) { return c.address === draft.currency_address; }) || CURRENCIES[0];

        var mintedTokenId = null;
        var mintedOpContract = null;
        var mintTxHash = null;

        if (channel && ethers.isAddress(channel)) {
          setProgStep('prog-mint', 'Preparing...', 'active');

          var draftWalletChoice = getChannelOwnerType(dom.assetChannel) || draft.wallet_choice || (hasSmartAccount() ? 'sa' : 'eoa');
          if (!getChannelOwnerType(dom.assetChannel) && !draft.wallet_choice) {
            draftWalletChoice = await showWalletChoice('Choose Wallet for Minting');
          }
          state.walletChoice = draftWalletChoice;

          if (!state.walletAddress) {
            try {
              var draftAccts = await window.ethereum.request({ method: 'eth_requestAccounts' });
              if (draftAccts && draftAccts[0]) state.walletAddress = draftAccts[0];
            } catch (_) { }
          }
          if (!state.walletAddress) {
            throw new Error('Wallet not connected — please reconnect your wallet and try again.');
          }

          var draftEffectiveAddr = getEffectiveAddress(draftWalletChoice);
          if (!draftEffectiveAddr || draftEffectiveAddr === '0x' || draftEffectiveAddr.length < 10) {
            throw new Error('Could not determine wallet address for ' + draftWalletChoice + '. Reconnect wallet and try again.');
          }

          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0x2105' }],
            });
          } catch (switchErr) {
            console.warn('[Creator] Chain switch failed:', switchErr.message);
          }

          var gatewayAddress = await getChannelAuthority(channel);

          var MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
          var draftNeedsGrant = false;
          try {
            var roleData = new ethers.Interface(['function hasRole(bytes32,address) view returns (bool)'])
              .encodeFunctionData('hasRole', [MINTER_ROLE, draftEffectiveAddr]);
            var roleResult = await rpcCall(channel, roleData);
            var hasRoleResult = roleResult !== '0x' + '0'.repeat(64);
            if (!hasRoleResult) {
              if (draftWalletChoice === 'sa') {
                draftNeedsGrant = true;
              } else {
                setProgStep('prog-mint', 'Granting MINTER_ROLE...', 'active');
                var grantIface = new ethers.Interface(['function grantRole(bytes32,address)']);
                var grantData = grantIface.encodeFunctionData('grantRole', [MINTER_ROLE, state.walletAddress]);
                var grantTxHash = await sendTxWithRetry('prog-mint', 'Grant MINTER_ROLE', channel, grantData);
                await waitForReceipt(grantTxHash);
              }
            }
          } catch (roleCheckErr) {
            if (roleCheckErr.message.includes('MINTER_ROLE')) throw roleCheckErr;
          }

          var feeInfo = await getMintingFee();
          var priceWei = ethers.parseUnits(price.toString(), selectedCurrency.decimals);
          var opType = accessMethod === 'free' ? OP_TYPES.FREE
            : accessMethod === 'buy_once' ? OP_TYPES.BUY_ONCE
              : OP_TYPES.BUY_AND_RESELL;

          var opRawData = opType !== OP_TYPES.FREE
            ? encodeOpRawData({
              contentId: encryptHash,
              metadataCID: metaCid,
              creatorAddress: draftEffectiveAddr,
              copies: copies,
              opType: opType,
              resellerCut: draft.reseller_cut || 900,
              royalties: draft.royalty_partners ? JSON.parse(draft.royalty_partners) : [],
            })
            : ethers.AbiCoder.defaultAbiCoder().encode(['bytes16'], [hashToContentId(encryptHash)]);
          var sellRawData = opType !== OP_TYPES.FREE
            ? encodeSellRawData(copies, priceWei, selectedCurrency.address)
            : '0x';

          var iface = new ethers.Interface(ABI.DIGITAL_ASSET);
          var mintData = iface.encodeFunctionData('mint', [metaCid, opType, opRawData, sellRawData]);

          if (draftWalletChoice === 'sa' && hasSmartAccount()) {
            if (draftNeedsGrant) {
              var dgIface = new ethers.Interface(ABI.ACCESS_CONTROL);
              var dgData = dgIface.encodeFunctionData('grantRole', [MINTER_ROLE, smartAccountAddress]);
              var dgTxHash = await sendTxWithRetry('prog-mint', 'Grant MINTER_ROLE to Agent Account (EOA tx)', channel, dgData, 0);
              setProgStep('prog-mint', 'Confirming role grant...', 'active');
              await waitForReceipt(dgTxHash);
            }

            var draftBatchTxs = [];
            var draftMintFee = feeInfo.fee && BigInt(feeInfo.fee) > 0n ? '0x' + BigInt(feeInfo.fee).toString(16) : '0x0';
            draftBatchTxs.push({ to: channel, data: mintData, value: draftMintFee });

            setProgStep('prog-mint', 'Confirm in wallet (Agent Account batch)...', 'active');
            var draftBatchResult = await parentExecuteSmartAccountBatch(BASE_CHAIN_ID, draftBatchTxs, []);
            mintTxHash = draftBatchResult.transactionHash || draftBatchResult.transactionId;
            console.log('[Creator] Draft SA batch — txHash:', draftBatchResult.transactionHash, 'txId:', draftBatchResult.transactionId);

            setProgStep('prog-mint', 'Waiting for on-chain confirmation...', 'active');
            var draftPollStart = Date.now();
            while (Date.now() - draftPollStart < 90000) {
              await new Promise(function (r) { setTimeout(r, 4000); });
              try {
                var dBlkR = await fetch(BASE_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
                var dBlkJ = await dBlkR.json();
                var dCurBlk = parseInt(dBlkJ.result, 16);
                var dLogsR = await fetch(BASE_RPC, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: channel, fromBlock: '0x' + Math.max(0, dCurBlk - 30).toString(16), toBlock: 'latest' }] }),
                });
                var dLogsJ = await dLogsR.json();
                var dChLogs = dLogsJ.result || [];
                if (dChLogs.length > 0) {
                  var dRealHash = dChLogs[dChLogs.length - 1].transactionHash;
                  var dRcpt = await fetch(BASE_RPC, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [dRealHash] }),
                  });
                  var dRcptJ = await dRcpt.json();
                  if (dRcptJ.result && dRcptJ.result.logs && dRcptJ.result.logs.length > 0) {
                    var dParsed = parseAssetCreatedEvent(dRcptJ.result, channel);
                    if (dParsed) {
                      mintedTokenId = dParsed.tokenId;
                      mintedOpContract = dParsed.opContract;
                      if (mintedOpContract === ethers.ZeroAddress) mintedOpContract = null;
                      mintTxHash = dRealHash;
                      console.log('[Creator] Draft SA from receipt — tokenId:', mintedTokenId, 'opContract:', mintedOpContract);
                      break;
                    }
                  }
                }
              } catch (dPollErr) {
                console.warn('[Creator] Draft SA poll error:', dPollErr.message);
              }
              setProgStep('prog-mint', 'Waiting for on-chain confirmation...', 'active');
            }
          } else {
            mintTxHash = await sendTxWithRetry('prog-mint', 'Mint on Channel contract', channel, mintData, feeInfo.fee);
            setProgStep('prog-mint', 'Confirming tx...', 'active');
            var mintReceipt = await waitForReceipt(mintTxHash);

            if (mintReceipt.status === '0x0' || mintReceipt.status === 0) {
              throw new Error('Mint transaction reverted');
            }

            var assetEvent = parseAssetCreatedEvent(mintReceipt, channel);
            if (assetEvent) {
              mintedTokenId = assetEvent.tokenId;
              mintedOpContract = assetEvent.opContract;
            }

            if (!mintedTokenId) {
              try {
                var supplyData = iface.encodeFunctionData('totalSupply', []);
                var supplyResult = await rpcCall(channel, supplyData);
                var supplyDecoded = iface.decodeFunctionResult('totalSupply', supplyResult);
                mintedTokenId = supplyDecoded[0].toString();
              } catch (tsErr) {
                console.warn('[Creator] Could not get totalSupply:', tsErr.message);
              }
            }

            if (!mintedOpContract && mintedTokenId && opType !== OP_TYPES.FREE) {
              try {
                var agIface = new ethers.Interface(ABI.AUTHORITY_GATEWAY);
                var opLookupData = agIface.encodeFunctionData('operative', [channel, mintedTokenId]);
                var opLookupResult = await rpcCall(CONTRACTS.AUTHORITY_GATEWAY, opLookupData);
                var opDecoded = agIface.decodeFunctionResult('operative', opLookupResult);
                if (opDecoded[0] && opDecoded[0] !== ethers.ZeroAddress) {
                  mintedOpContract = opDecoded[0];
                }
              } catch (opLookupErr) {
                console.warn('[Creator] operative lookup failed:', opLookupErr.message);
              }
            }
          }

          setProgStep('prog-mint', mintedTokenId ? 'Token #' + mintedTokenId + ' minted' : 'Minted', 'done');

          var gatewayApproved = false;
          if (mintedOpContract && mintedOpContract !== ethers.ZeroAddress) {
            if (draftWalletChoice === 'sa' && hasSmartAccount()) {
              try {
                setProgStep('prog-approve', 'Approving gateway (Agent Account)...', 'active');
                await new Promise(function (r) { setTimeout(r, 3000); });
                var draftOpIface = new ethers.Interface(ABI.OPERATIVE);
                var draftApproveData = draftOpIface.encodeFunctionData('setApprovalForAll', [gatewayAddress, true]);
                await parentExecuteSmartAccountBatch(BASE_CHAIN_ID, [{ to: mintedOpContract, data: draftApproveData, value: '0x0' }], []);
                setProgStep('prog-approve', 'Gateway approved', 'done');
                gatewayApproved = true;
              } catch (approveErr) {
                setProgStep('prog-approve', 'Failed — use Fix tool below', 'error');
                showToast('Gateway approval failed. Use Fix Gateway Approval tool.', 'error');
              }
            } else {
              try {
                setProgStep('prog-approve', 'Waiting for chain to settle...', 'active');
                await new Promise(function (r) { setTimeout(r, 5000); });
                setProgStep('prog-approve', 'Approving gateway...', 'active');
                var opIface = new ethers.Interface(ABI.OPERATIVE);
                var approveData = opIface.encodeFunctionData('setApprovalForAll', [gatewayAddress, true]);
                var approveTxHash = await sendTxWithRetry('prog-approve', 'Gateway approval', mintedOpContract, approveData);
                var approveReceipt = await waitForReceipt(approveTxHash);
                if (approveReceipt.status !== '0x0' && approveReceipt.status !== 0) {
                  setProgStep('prog-approve', 'Gateway approved', 'done');
                  gatewayApproved = true;
                }
              } catch (approveErr) {
                setProgStep('prog-approve', 'Failed — use Fix tool below', 'error');
                showToast('Gateway approval failed. Use Fix Gateway Approval tool.', 'error');
              }
            }
          } else if (opType !== OP_TYPES.FREE) {
            setProgStep('prog-approve', 'Operative not detected — use Fix tool below', 'error');
          }

          // Delete draft after successful mint
          try {
            await pc2Fetch('/api/drafts/' + draftId, { method: 'DELETE' });
          } catch (_) { }
          state.draftId = null;

          // Show results
          state.result = {
            assetCid: draft.asset_cid,
            metaCid: metaCid,
            encryptHash: encryptHash,
            size: draft.file_size || 0,
            tokenId: mintedTokenId,
            txHash: mintTxHash,
            channel: channel,
            opContract: mintedOpContract,
          };

          var resultAssetCid = document.getElementById('result-asset-cid');
          var resultMetaCid = document.getElementById('result-meta-cid');
          var resultEncryptHash = document.getElementById('result-encrypt-hash');
          var resultSize = document.getElementById('result-size');
          if (resultAssetCid) resultAssetCid.textContent = draft.asset_cid;
          if (resultMetaCid) resultMetaCid.textContent = metaCid;
          if (resultEncryptHash) resultEncryptHash.textContent = encryptHash;
          if (resultSize) resultSize.textContent = formatSize(draft.file_size || 0);

          var tokenLabel = mintedTokenId ? 'Token #' + mintedTokenId : 'tx ' + mintTxHash.substring(0, 10) + '...';
          var resultRowToken = document.getElementById('result-row-token');
          var resultTokenId = document.getElementById('result-token-id');
          var resultRowChannel = document.getElementById('result-row-channel');
          var resultChannel = document.getElementById('result-channel');
          var resultRowOperative = document.getElementById('result-row-operative');
          var resultOperative = document.getElementById('result-operative');
          var resultTitle = document.getElementById('result-title');
          var resultDesc = document.getElementById('result-desc');
          var resultNote = document.getElementById('result-note');

          if (resultRowToken) resultRowToken.style.display = '';
          if (resultTokenId) resultTokenId.textContent = mintedTokenId || mintTxHash;
          if (resultRowChannel) resultRowChannel.style.display = '';
          if (resultChannel) resultChannel.textContent = channel;
          if (mintedOpContract && resultRowOperative) {
            resultRowOperative.style.display = '';
            if (resultOperative) resultOperative.textContent = mintedOpContract;
          }
          if (gatewayApproved) {
            if (resultTitle) resultTitle.textContent = 'Asset Minted On-Chain';
            if (resultDesc) resultDesc.textContent = 'Your encrypted asset is on IPFS and minted on Base as ' + tokenLabel + '.';
            if (resultNote) resultNote.innerHTML = '<strong>Live on Base:</strong> Your asset is now on the Elacity channel. <a href="https://basescan.org/tx/' + mintTxHash + '" target="_blank">View on BaseScan</a>';
          } else {
            if (resultTitle) resultTitle.textContent = 'Minted — Gateway Approval Needed';
            if (resultDesc) resultDesc.textContent = 'Token ' + tokenLabel + ' was minted but the marketplace approval did not complete.';
            if (resultNote) resultNote.innerHTML = '<strong>Action required:</strong> Use the <em>Fix Gateway Approval</em> tool below. <a href="https://basescan.org/tx/' + mintTxHash + '" target="_blank">View on BaseScan</a>';
            var fixInput = document.getElementById('fix-operative-addr');
            if (fixInput && mintedOpContract) fixInput.value = mintedOpContract;
          }

          goToStep(4);
          if (gatewayApproved) {
            showToast('Asset published! Token #' + mintedTokenId, 'success');
          } else {
            showToast('Minted — gateway approval still needed', 'error');
          }
          // Kick indexer so the asset shows up in local catalog/Market immediately
          triggerLocalReindex();
        }
      } catch (err) {
        console.error('[Creator] Resume from draft failed:', err);
        showToast('Resume failed: ' + (err.message || ''), 'error');
      }
    }

    // Pre-load file or resume draft when launched
    (function () {
      var puterArgs;
      try {
        var raw = new URLSearchParams(window.location.search).get('puter.args');
        puterArgs = raw ? JSON.parse(raw) : {};
      } catch (_) { puterArgs = {}; }

      // Resume from draft takes priority
      if (puterArgs.resumeDraft) {
        resumeFromDraft(puterArgs.resumeDraft);
        return;
      }

      // Pick up file from toolbar dropdown (window.__mintFile set by UIMintButton)
      if (puterArgs.fromToolbar && window.parent && window.parent.__mintFile) {
        var mintFile = window.parent.__mintFile;
        window.parent.__mintFile = null;
        handleFileSelected(mintFile);
        return;
      }

      if (!puterArgs.filePath) return;

      pc2Fetch('/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: puterArgs.filePath }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Read failed: ' + res.status);
          var contentType = res.headers.get('Content-Type') || 'application/octet-stream';
          return res.blob().then(function (blob) {
            return { blob: blob, contentType: contentType };
          });
        })
        .then(function (result) {
          var fileName = puterArgs.fileName || puterArgs.filePath.split('/').pop() || 'file';
          var file = new File([result.blob], fileName, { type: result.contentType });
          handleFileSelected(file);
        })
        .catch(function (err) {
          console.error('[Creator] Failed to pre-load file from puter.args:', err);
          showToast('Could not pre-load file: ' + (err.message || ''), 'error');
        });
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
