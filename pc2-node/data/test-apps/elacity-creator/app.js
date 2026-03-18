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
    CORE_STORAGE: '0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575',
    AUTHORITY_GATEWAY: '0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29',
    CHANNEL_CORE: '0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6',
    TRADE_GATEWAY: '0x9eC53758b698f9F68C0654DDd9159173a159a459',
  };

  var USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  var ABI = {
    DIGITAL_ASSET: [
      'function mint(string _uri, uint16 opType, bytes opRawData, bytes sellRawData) payable',
      'function authority() view returns (address)',
      'function totalSupply() view returns (uint256)',
      'event AssetCreated(uint256 indexed _tokenId, address indexed _creator, string _tokenURI, uint16 _opType, address indexed opContract)',
    ],
    CORE_STORAGE: [
      'function mediaCreationFee() view returns (uint256 fee, address token)',
      'function channelCreationFee() view returns (uint256 fee, address token)',
    ],
    CHANNEL_CORE: [
      'function createChannel(uint8 _channelType, uint8 _scope, string _name, string _tokenURI, bytes data) payable',
      'event ChannelCreated(address indexed channelAddr, uint8 indexed channelType, address indexed owner, uint8 scope, string name)',
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
  var ELACITY_ROYALTY_ADDRESS = '0x0917Aa260359670F7855a5454c630993ce40C52D';
  var ELACITY_CHANNEL_ROYALTY_ADDRESS = '0xCE4639Aa1E47E400683F49d95025475D5F50192d';
  var ELACITY_ROYALTY_PERCENT = 5;
  var DEFAULT_CHANNEL = '0x2fb53d4ab93112a6c0a1e54ffcd7199c6fd37412';
  var ELACITY_BACKEND = 'https://base.ela.city/api';

  // ── State ─────────────────────────────────────────────

  var state = {
    selectedFile: null,
    fileBytes: null,
    walletAddress: null,
    currentStep: 1,
    result: null,
    customThumbnail: null,
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
          if (state.currentStep >= 2 && !state.channelsLoaded) {
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

    if (n === 2 && state.walletAddress && !state.channelsLoaded) {
      loadChannels(state.walletAddress);
    }
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

  async function loadChannels(walletAddress) {
    var select = dom.assetChannel;
    var hint = document.getElementById('channel-hint');
    select.innerHTML = '<option value="">Loading channels...</option>';
    select.disabled = true;

    try {
      var addr = walletAddress.toLowerCase();
      var ownedChannels = await fetchChannelsFromBackend({ creator: addr });
      var mintableChannels = await fetchChannelsFromBackend({ access: 'mint:' + addr });

      var ownedAddrs = {};
      ownedChannels.forEach(function (ch) { ownedAddrs[ch.address.toLowerCase()] = true; });
      var publicChannels = mintableChannels.filter(function (ch) {
        return !ownedAddrs[ch.address.toLowerCase()];
      });

      select.innerHTML = '';

      if (ownedChannels.length === 0 && publicChannels.length === 0) {
        select.innerHTML = '<option value="' + DEFAULT_CHANNEL + '">Public Elacity Channel</option>';
        hint.textContent = 'No channels found. Using public Elacity channel (free content only).';
        hint.className = 'field-hint';
      } else {
        if (ownedChannels.length > 0) {
          var group1 = document.createElement('optgroup');
          group1.label = 'Your Channels (' + ownedChannels.length + ')';
          ownedChannels.forEach(function (ch) {
            var opt = document.createElement('option');
            opt.value = ch.address;
            opt.textContent = ch.name + ' (' + ch.address.substring(0, 8) + '...)';
            group1.appendChild(opt);
          });
          select.appendChild(group1);
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

        if (ownedChannels.length > 0) {
          select.value = ownedChannels[0].address;
          hint.textContent = 'Your channel selected — you have full minting rights.';
          hint.className = 'field-hint success';
        } else {
          hint.textContent = 'Public channels available. Create your own for full minting rights.';
          hint.className = 'field-hint';
        }
      }

      var customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = '— Enter address manually —';
      select.appendChild(customOpt);

      state.channelsLoaded = true;
    } catch (err) {
      console.error('[Creator] Failed to fetch channels:', err);
      select.innerHTML = '<option value="' + DEFAULT_CHANNEL + '">Public Elacity Channel (fallback)</option>';
      var customFb = document.createElement('option');
      customFb.value = '__custom__';
      customFb.textContent = '— Enter address manually —';
      select.appendChild(customFb);
      hint.textContent = 'Could not load channels from Elacity backend. Using default.';
      hint.className = 'field-hint';
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

  function handleFileSelected(file) {
    if (!file) return;

    var isMedia = file.type.startsWith('video/') || file.type.startsWith('audio/');
    var MAX_FILE_SIZE = isMedia ? 4 * 1024 * 1024 * 1024 : 100 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      showToast('File too large. Maximum size: ' + (isMedia ? '4 GB' : '100 MB'), 'error');
      return;
    }

    state.selectedFile = file;

    dom.fileIcon.textContent = getFileIcon(file.type);
    dom.fileName.textContent = file.name;
    dom.fileMeta.textContent = formatSize(file.size) + ' — ' + (file.type || 'unknown type');
    dom.dropZone.classList.add('hidden');
    dom.filePreview.classList.remove('hidden');
    dom.btnToStep2.disabled = false;

    // Show media encoding badge for video/audio files
    var existingBadge = document.getElementById('media-encode-badge');
    if (existingBadge) existingBadge.remove();
    if (isMedia) {
      var badge = document.createElement('div');
      badge.id = 'media-encode-badge';
      badge.style.cssText = 'margin-top: 8px; padding: 6px 12px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border-radius: 6px; font-size: 12px; display: flex; align-items: center; gap: 6px;';
      badge.innerHTML = '<span style="font-size: 14px;">&#9881;</span> Media Encoding Pipeline — will transcode, DASH package, CENC encrypt & upload to IPFS';
      dom.filePreview.appendChild(badge);
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
  }

  function clearFile() {
    state.selectedFile = null;
    state.fileBytes = null;
    state.isMediaFile = false;
    dom.dropZone.classList.remove('hidden');
    dom.filePreview.classList.add('hidden');
    dom.btnToStep2.disabled = true;
    dom.fileInput.value = '';
    var existingBadge = document.getElementById('media-encode-badge');
    if (existingBadge) existingBadge.remove();
  }

  // ── Form validation ───────────────────────────────────

  function validateStep2() {
    var title = dom.assetTitle.value.trim();
    var category = dom.assetCategory.value;
    var price = parseFloat(dom.assetPrice.value);
    var ch = getSelectedChannel();
    var hasChannel = ch && ethers.isAddress(ch);
    var valid = title.length > 0 && category && !isNaN(price) && price >= 0 && hasChannel;
    dom.btnToStep3.disabled = !valid;
  }

  // ── Encrypt & Upload pipeline ─────────────────────────

  function setProgStep(id, status, cls) {
    var el = document.getElementById(id);
    var statusEl = document.getElementById(id + '-status');
    if (!el || !statusEl) return;
    el.className = 'progress-step ' + (cls || '');
    statusEl.textContent = status;
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

  function buildMetadataEnvelope(params) {
    var contentType = params.mimeType || 'application/octet-stream';
    return {
      schema: 'elacity-asset-envelope-v1',
      name: params.title,
      description: params.description,
      image: params.image || '',
      category: params.category,
      media: {
        uri: 'ipfs://' + params.assetCid,
        contentType: contentType,
        mimeType: contentType,
        protectionType: 'lit-aes-gcm-v1',
        size: params.size,
      },
      asset: {
        cid: params.assetCid,
        mimeType: contentType,
        size: params.size,
        encrypted: true,
        algorithm: 'aes-256-gcm',
        protectionType: 'lit-aes-gcm-v1',
        dataToEncryptHash: params.dataToEncryptHash,
        actionCid: params.actionCid || '',
        authority: params.authority || CONTRACTS.AUTHORITY_GATEWAY,
        chain: 'base',
        chainId: BASE_CHAIN_ID,
        rpc: 'https://mainnet.base.org',
      },
      pricing: {
        currency: 'USDC',
        price: params.price,
        accessMethod: params.accessMethod || 'buy_and_resell',
        copies: params.copies || 10000,
      },
      properties: {
        chainId: BASE_CHAIN_ID,
        ledger: params.channel || DEFAULT_CHANNEL,
        authority: params.authority || CONTRACTS.AUTHORITY_GATEWAY,
        publisher: params.creatorAddress,
        distribution: params.accessMethod === 'buy_once' ? 'Buy Once'
          : params.accessMethod === 'free' ? 'Free' : 'Buy & Resell',
        categories: [params.category],
      },
      creator: {
        address: params.creatorAddress,
        channel: params.channel || DEFAULT_CHANNEL,
      },
      createdAt: new Date().toISOString(),
      version: '1.0.0',
    };
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
    var creatorPer1000 = Math.round((100 - ELACITY_ROYALTY_PERCENT) * 10);
    var elacityPer1000 = Math.round(ELACITY_ROYALTY_PERCENT * 10);

    var addresses = [params.creatorAddress, params.creatorAddress, ELACITY_CHANNEL_ROYALTY_ADDRESS];
    var roleTypes = [ROLE_ACCESS_TOKEN, ROLE_ROYALTY_SHARE, ROLE_ROYALTY_SHARE];
    var amounts = [params.copies, creatorPer1000, elacityPer1000];

    if (params.opType === OP_TYPES.BUY_AND_RESELL) {
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
    var iface = new ethers.Interface(ABI.CORE_STORAGE);
    var data = iface.encodeFunctionData('mediaCreationFee', []);
    var result = await rpcCall(CONTRACTS.CORE_STORAGE, data);
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
      from: state.walletAddress,
      to: to,
      data: data,
    };
    if (value && BigInt(value) > 0n) {
      txParams.value = '0x' + BigInt(value).toString(16);
    }

    try {
      var estResp = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_estimateGas',
          params: [txParams],
        }),
      });
      var estJson = await estResp.json();
      if (estJson.result) {
        var estimated = BigInt(estJson.result);
        txParams.gas = '0x' + (estimated * 15n / 10n).toString(16);
        console.log('[Creator] Gas pre-estimated:', Number(estimated), '→ limit:', Number(estimated * 15n / 10n));
      } else if (estJson.error) {
        console.warn('[Creator] Gas estimation RPC error:', estJson.error.message || JSON.stringify(estJson.error));
      }
    } catch (e) {
      console.warn('[Creator] Gas estimation failed, using fallback:', e.message);
    }

    if (!txParams.gas) {
      txParams.gas = '0x' + BigInt(500000).toString(16);
      console.log('[Creator] Using fallback gas limit: 500000');
    }

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
      // Smart Account wallets (Particle/UniversalX) return UserOperation hashes
      // that standard RPC won't recognize. Try the wallet provider first since it
      // can resolve UserOp hashes to real receipts.
      try {
        var walletReceipt = await window.ethereum.request({
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        });
        if (walletReceipt && walletReceipt.status) return walletReceipt;
      } catch (_) { /* wallet provider doesn't support it, fall through */ }

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
      await new Promise(function (r) { setTimeout(r, 3000); });
    }
    console.warn('[Creator] waitForReceipt timed out for', txHash);
    return { status: 'timeout', transactionHash: txHash };
  }

  // ── Channel creation ─────────────────────────────────

  async function getChannelCreationFee() {
    var iface = new ethers.Interface(ABI.CORE_STORAGE);
    var data = iface.encodeFunctionData('channelCreationFee', []);
    var result = await rpcCall(CONTRACTS.CORE_STORAGE, data);
    var decoded = iface.decodeFunctionResult('channelCreationFee', result);
    return { fee: decoded.fee, token: decoded.token };
  }

  function parseChannelCreatedEvent(receipt) {
    var iface = new ethers.Interface(ABI.CHANNEL_CORE);
    var logs = receipt.logs || [];
    for (var i = 0; i < logs.length; i++) {
      try {
        var parsed = iface.parseLog({ topics: logs[i].topics, data: logs[i].data });
        if (parsed && parsed.name === 'ChannelCreated') {
          return {
            channelAddr: parsed.args.channelAddr,
            channelType: Number(parsed.args.channelType),
            owner: parsed.args.owner,
            scope: Number(parsed.args.scope),
            name: parsed.args.name,
          };
        }
      } catch (_) { /* not our event */ }
    }
    return null;
  }

  async function doCreateChannel(channelName, description) {
    if (!state.walletAddress) throw new Error('Connect wallet first');

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_CHAIN_HEX }],
      });
    } catch (_) {}

    var feeInfo = await getChannelCreationFee();
    console.log('[Creator] Channel creation fee:', feeInfo.fee.toString());

    var channelDesc = description || 'PC2 digital assets channel';
    var channelMeta = {};
    channelMeta['0000000000000000000000000000000000000000000000000000000000000000.json'] = {
      name: channelName,
      description: channelDesc,
      properties: { creator: state.walletAddress },
      attributes: [
        { trait_type: 'Type', value: 1 },
        { trait_type: 'Scope', value: 1 },
      ],
    };
    channelMeta['0000000000000000000000000000000000000000000000000000000000000002.json'] = {
      name: 'Royalty Share - ' + channelName,
      description: 'Shares for royalty distribution over all subscriptions to the channel \'' + channelName + '\'',
      properties: { decimals: 1, creator: state.walletAddress },
      attributes: [],
    };

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

    var coder = ethers.AbiCoder.defaultAbiCoder();
    var configData = coder.encode(
      ['tuple(address,uint256)[]', 'tuple(uint8,address,uint256,uint256,bool)[]', 'tuple(address,uint256)[]'],
      [
        [
          [state.walletAddress, creatorPer1000],
          [ELACITY_CHANNEL_ROYALTY_ADDRESS, elacityPer1000],
        ],
        [],
        [],
      ]
    );

    var iface = new ethers.Interface(ABI.CHANNEL_CORE);
    var callData = iface.encodeFunctionData('createChannel', [
      1,
      1,
      channelName,
      'ipfs://' + metaCid,
      configData,
    ]);

    var txHash = await sendTx(CONTRACTS.CHANNEL_CORE, callData, feeInfo.fee);
    console.log('[Creator] createChannel tx:', txHash);

    var receipt = await waitForReceipt(txHash);
    if (receipt.status === '0x0' || receipt.status === 0) {
      throw new Error('createChannel transaction reverted');
    }

    var event = parseChannelCreatedEvent(receipt);
    var channelAddr = event ? event.channelAddr : null;

    if (!channelAddr) {
      throw new Error('Channel created but could not parse ChannelCreated event. Tx: ' + txHash);
    }
    console.log('[Creator] Channel created at:', channelAddr);

    var MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
    try {
      var acIface = new ethers.Interface(ABI.ACCESS_CONTROL);
      var hasIt = await rpcCall(channelAddr, acIface.encodeFunctionData('hasRole', [MINTER_ROLE, state.walletAddress]));
      var hasMinter = acIface.decodeFunctionResult('hasRole', hasIt)[0];
      if (!hasMinter) {
        console.log('[Creator] Granting MINTER_ROLE to self...');
        var grantData = acIface.encodeFunctionData('grantRole', [MINTER_ROLE, state.walletAddress]);
        var grantTx = await sendTx(channelAddr, grantData);
        await waitForReceipt(grantTx);
        console.log('[Creator] MINTER_ROLE granted');
      } else {
        console.log('[Creator] Already has MINTER_ROLE');
      }
    } catch (roleErr) {
      console.warn('[Creator] Failed to grant MINTER_ROLE (you may need to do this manually):', roleErr.message);
    }

    try {
      await registerChannelWithBackend({
        name: channelName,
        address: channelAddr,
        description: channelDesc,
        creator: state.walletAddress,
        txHash: txHash,
      });
      console.log('[Creator] Channel registered with Elacity backend');
    } catch (regErr) {
      console.warn('[Creator] Backend registration failed (channel still works on-chain):', regErr.message);
    }

    return { address: channelAddr, name: channelName, txHash: txHash };
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

    var loginData = await elacityGraphQL(
      'mutation UserLogin($address: String!, $signature: String!) { userLogin(address: $address, signature: $signature) { token address alias } }',
      { address: addr, signature: signature }
    );

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
      scope: '1',
      channelType: '1',
      image: '',
      coverImage: '',
      categories: [],
      plans: [],
      tokenAccess: [],
    };

    var authToken = await getElacityAuthToken(params.creator);

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
        } catch (_) {}
      }
    }

    if (opContract || tokenId) {
      console.log('[Creator] Fallback event parse — tokenId:', tokenId, 'opContract:', opContract);
      return { tokenId: tokenId, creator: null, tokenURI: null, opType: null, opContract: opContract };
    }

    return null;
  }

  // ── Pipeline ─────────────────────────────────────────

  async function runPipeline() {
    var title = dom.assetTitle.value.trim();
    var description = dom.assetDescription.value.trim();
    var category = dom.assetCategory.value;
    var price = parseFloat(dom.assetPrice.value);
    var accessMethod = dom.assetAccess.value;
    var copies = parseInt(dom.assetCopies.value) || 10000;
    var channel = getSelectedChannel();
    var usedLocalEncryption = false;

    console.log('[Creator] Pipeline starting. Channel:', channel, '| Select value:', dom.assetChannel.value, '| Custom:', dom.assetChannelCustom.value);

    dom.progressError.classList.add('hidden');
    dom.btnBackTo2.disabled = true;

    try {
      if (!state.walletAddress) {
        var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        state.walletAddress = accounts[0];
      }

      // ── Step 1: Encrypt ───────────────────────────────
      setProgStep('prog-connect', 'Connecting...', 'active');

      var isMediaFile = state.selectedFile.type.startsWith('video/') || state.selectedFile.type.startsWith('audio/');
      var encryptResult;
      var mediaEncodeResult = null;

      if (isMediaFile) {
        // ── Media Path: Encode + CENC encrypt via backend pipeline ──
        swapProgressStepsForMedia();

        setProgStep('prog-connect', 'Uploading file to encoder...', 'active');
        console.log('[Creator] Media file detected (' + state.selectedFile.type + '), routing through /api/media/encode');

        var formData = new FormData();
        formData.append('file', state.selectedFile);

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

      // ── Step 2: Upload encrypted asset to IPFS ────────
      var assetCid;

      if (isMediaFile && mediaEncodeResult) {
        // Media pipeline already handled CENC encryption + IPFS upload
        assetCid = mediaEncodeResult.cid;
        setProgStep('prog-upload-asset', 'CID: ' + assetCid.substring(0, 12) + '... (from encoder)', 'done');
        console.log('[Creator] Media asset CID from encoder:', assetCid);
      } else {
      // Non-media: Upload to local node AND Elacity's IPFS for public reachability
      setProgStep('prog-upload-asset', 'Uploading to local node...', 'active');
      var assetBase64 = uint8ToBase64(encryptResult.encrypted);

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
      console.log('[Creator] Local asset CID:', localAssetCid);

      setProgStep('prog-upload-asset', 'Pinning to Elacity IPFS...', 'active');
      var assetCid = localAssetCid;
      try {
        var elacityAssetResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: assetBase64, filename: 'encrypted-asset' }),
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
        } else if (state.selectedFile && state.selectedFile.type.startsWith('image/')) {
          var autoCanvas = document.createElement('canvas');
          var autoCtx = autoCanvas.getContext('2d');
          var autoImg = await createImageBitmap(state.selectedFile);
          var autoDim = 400;
          var autoScale = Math.min(autoDim / autoImg.width, autoDim / autoImg.height, 1);
          autoCanvas.width = Math.round(autoImg.width * autoScale);
          autoCanvas.height = Math.round(autoImg.height * autoScale);
          autoCtx.drawImage(autoImg, 0, 0, autoCanvas.width, autoCanvas.height);
          var autoBlob = await new Promise(function (resolve) {
            autoCanvas.toBlob(resolve, 'image/jpeg', 0.8);
          });
          thumbBase64 = uint8ToBase64(new Uint8Array(await autoBlob.arrayBuffer()));
          console.log('[Creator] Auto-generated thumbnail from image');
        } else if (state.selectedFile && (state.selectedFile.type === 'application/pdf' || state.selectedFile.type === 'text/plain' || state.selectedFile.type.startsWith('text/'))) {
          // Server-side thumbnail generation for PDFs and text files
          var fileBytes = new Uint8Array(await state.selectedFile.arrayBuffer());
          var serverThumbResp = await pc2Fetch('/api/storage/thumbnail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: uint8ToBase64(fileBytes), mimeType: state.selectedFile.type, filename: state.selectedFile.name }),
          });
          if (serverThumbResp.ok) {
            var serverThumbData = await serverThumbResp.json();
            if (serverThumbData.thumbnail) {
              thumbBase64 = serverThumbData.thumbnail;
              console.log('[Creator] Server-generated thumbnail for', state.selectedFile.type);
            } else {
              console.warn('[Creator] Server thumbnail response had no thumbnail field:', Object.keys(serverThumbData));
            }
          } else {
            console.warn('[Creator] Server thumbnail failed:', serverThumbResp.status, await serverThumbResp.text().catch(function() { return ''; }));
          }
        }

        if (thumbBase64) {
          var thumbResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: thumbBase64, filename: 'thumbnail.jpg' }),
          });
          if (thumbResp.ok) {
            var thumbData = await thumbResp.json();
            imageUri = 'ipfs://' + thumbData.cid;
            console.log('[Creator] Thumbnail uploaded:', imageUri);
          }
        }
      } catch (thumbErr) {
        console.warn('[Creator] Thumbnail generation failed (non-fatal):', thumbErr.message);
      }

      if (!imageUri) {
        console.warn('[Creator] No thumbnail generated — asset will have no preview image in marketplace');
      }

      var envelope = buildMetadataEnvelope({
        title: title,
        description: description,
        category: category,
        assetCid: assetCid,
        mimeType: state.selectedFile.type || 'application/octet-stream',
        size: state.selectedFile.size,
        dataToEncryptHash: encryptResult.dataToEncryptHash,
        actionCid: encryptResult.actionCid || '',
        price: price,
        accessMethod: accessMethod,
        copies: copies,
        creatorAddress: state.walletAddress,
        channel: channel,
        authority: authorityAddress,
        image: imageUri,
      });

      // Two-layer encryption: store Lit-encrypted CEK and IV in metadata
      if (encryptResult.litCiphertext) {
        envelope.asset.litCiphertext = encryptResult.litCiphertext;
        envelope.asset.iv = encryptResult.iv;
        envelope.asset.litBackend = encryptResult.litBackend || 'chipotle';
      }

      // Media-specific metadata: DASH/CENC fields from encoder pipeline
      if (isMediaFile && mediaEncodeResult) {
        envelope.asset.protectionType = 'cenc:web3-drm-v1';
        envelope.asset.mpdUri = mediaEncodeResult.mpdUri;
        envelope.asset.kid = mediaEncodeResult.kid;
        envelope.asset.litBackend = 'chipotle';
        envelope.asset.mediaType = state.selectedFile.type.startsWith('video/') ? 'video' : 'audio';
      }

      if (usedLocalEncryption) {
        envelope.asset._devMode = true;
        envelope.asset._localKey = encryptResult._localDevKey;
      }

      var metaJsonStr = JSON.stringify(envelope, null, 2);
      var metaBase64 = btoa(unescape(encodeURIComponent(metaJsonStr)));

      // Upload to local IPFS (directory format for local gateway)
      var localMetaDirCid = null;
      var localMetaResp = await pc2Fetch('/api/storage/ipfs/add-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { 'metadata.json': metaBase64 }, announce: true }),
      });
      if (localMetaResp.ok) {
        var localMetaData = await localMetaResp.json();
        localMetaDirCid = localMetaData.cid;
        console.log('[Creator] Local meta dir CID:', localMetaDirCid);
      }

      // Upload metadata to Elacity's IPFS (raw file CID for public access)
      setProgStep('prog-upload-meta', 'Pinning to Elacity IPFS...', 'active');
      var metaCid = null;
      try {
        var elacityMetaResp = await pc2Fetch('/api/storage/ipfs/upload-elacity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: metaBase64, filename: 'metadata.json' }),
        });
        if (elacityMetaResp.ok) {
          var elacityMetaData = await elacityMetaResp.json();
          metaCid = elacityMetaData.cid;
          console.log('[Creator] Elacity meta CID:', metaCid);
        }
      } catch (e) {
        console.warn('[Creator] Elacity meta upload error:', e.message);
      }

      if (!metaCid && localMetaDirCid) {
        metaCid = localMetaDirCid + '/metadata.json';
        console.warn('[Creator] Falling back to local directory CID:', metaCid);
      }
      if (!metaCid) {
        throw new Error('Failed to upload metadata to IPFS');
      }
      setProgStep('prog-upload-meta', 'CID: ' + metaCid.substring(0, 12) + '...', 'done');

      // ── Step 3b: Verify on Elacity gateway ──────────────
      setProgStep('prog-pin', 'Verifying...', 'active');
      try {
        var verifyResp = await fetch('https://ipfs.ela.city/ipfs/' + metaCid, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
        });
        if (verifyResp.ok) {
          setProgStep('prog-pin', 'Verified on ipfs.ela.city', 'done');
        } else {
          setProgStep('prog-pin', 'Uploaded (gateway pending)', 'done');
        }
      } catch (e) {
        setProgStep('prog-pin', 'Uploaded to Elacity IPFS', 'done');
      }

      // ── Step 4: Mint on Channel contract ──────────────
      var mintedTokenId = null;
      var mintedOpContract = null;
      var mintTxHash = null;

      if (channel && ethers.isAddress(channel)) {
        setProgStep('prog-mint', 'Preparing...', 'active');

        // Only switch chain if not already on Base (avoids MetaMask popup)
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

        var feeInfo = await getMintingFee();
        var priceWei = ethers.parseUnits(price.toString(), 6);
        var opType = accessMethod === 'free' ? OP_TYPES.FREE
          : accessMethod === 'buy_once' ? OP_TYPES.BUY_ONCE
          : OP_TYPES.BUY_AND_RESELL;

        var opRawData = opType !== OP_TYPES.FREE
          ? encodeOpRawData({
              contentId: encryptResult.dataToEncryptHash,
              metadataCID: metaCid,
              creatorAddress: state.walletAddress,
              copies: copies,
              opType: opType,
              resellerCut: 900,
            })
          : '0x';
        var sellRawData = opType !== OP_TYPES.FREE
          ? encodeSellRawData(copies, priceWei, USDC_BASE)
          : '0x';

        var mintUri = metaCid;
        var iface = new ethers.Interface(ABI.DIGITAL_ASSET);
        var mintData = iface.encodeFunctionData('mint', [mintUri, opType, opRawData, sellRawData]);

        setProgStep('prog-mint', 'Preparing...', 'active');
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
            console.log('[Creator] TokenId from totalSupply:', mintedTokenId);
          } catch (tsErr) {
            console.warn('[Creator] Could not get totalSupply:', tsErr.message);
          }
        }

        setProgStep('prog-mint', mintedTokenId
          ? 'Token #' + mintedTokenId + ' minted'
          : 'Minted (tx: ' + mintTxHash.substring(0, 10) + '...)', 'done');

        // ── Step 5: Set approval on Operative ─────────
        if (mintedOpContract && mintedOpContract !== '0x0000000000000000000000000000000000000000') {
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
              console.warn('[Creator] Approval receipt timed out. Tx may still confirm:', approveTxHash);
            } else {
              setProgStep('prog-approve', 'Gateway approved', 'done');
            }
            console.log('[Creator] setApprovalForAll on', mintedOpContract, 'for gateway', gatewayAddress);
          } catch (approveErr) {
            console.error('[Creator] Gateway approval failed:', approveErr);
            setProgStep('prog-approve', '⚠️ Failed — use Fix tool below (' + (approveErr.message || '').substring(0, 60) + ')', 'error');
            showToast('Gateway approval failed. Use the Fix Gateway Approval tool after results load.', 'error');
          }
        } else if (opType === OP_TYPES.FREE) {
          setProgStep('prog-approve', 'Skipped (free content)', 'done');
        } else {
          setProgStep('prog-approve', 'Skipped (operative not detected)', 'done');
        }
      } else {
        setProgStep('prog-mint', 'Skipped (no channel)', 'done');
        setProgStep('prog-approve', 'Skipped', 'done');
      }

      // ── Done — show results ───────────────────────────
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
        document.getElementById('result-title').textContent = 'Asset Minted On-Chain';
        document.getElementById('result-desc').textContent = 'Your encrypted asset is on IPFS and minted on Base as ' + tokenLabel + '.';
        document.getElementById('result-row-token').style.display = '';
        document.getElementById('result-token-id').textContent = mintedTokenId || mintTxHash;
        document.getElementById('result-row-channel').style.display = '';
        document.getElementById('result-channel').textContent = channel;
        if (mintedOpContract && mintedOpContract !== '0x0000000000000000000000000000000000000000') {
          document.getElementById('result-row-operative').style.display = '';
          document.getElementById('result-operative').textContent = mintedOpContract;
        }
        document.getElementById('result-note').innerHTML = '<strong>Live on Base:</strong> Your asset is now on the Elacity channel. <a href="https://basescan.org/tx/' + mintTxHash + '" target="_blank">View on BaseScan</a>';
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
      showToast('Asset published!' + mintLabel + modeLabel, 'success');

    } catch (err) {
      dom.progressError.textContent = 'Error: ' + (err.message || 'Unknown error');
      dom.progressError.classList.remove('hidden');
      dom.btnBackTo2.disabled = false;
      showToast('Pipeline failed: ' + (err.message || ''), 'error');

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
    dom.btnBackTo2.disabled = false;

    PROGRESS_STEPS.forEach(function (id) {
      setProgStep(id, 'Waiting...', '');
    });
    restoreProgressStepsDefault();
    resetMediaSubSteps();

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

    // Create Channel button
    var btnCreateChannel = document.getElementById('btn-create-channel');
    var channelHint = document.getElementById('channel-hint');
    btnCreateChannel.addEventListener('click', async function () {
      if (!state.walletAddress) {
        showToast('Connect your wallet first', 'error');
        return;
      }
      var channelName = (dom.assetTitle.value.trim() || 'My PC2') + ' Channel';
      btnCreateChannel.disabled = true;
      btnCreateChannel.textContent = 'Creating...';
      channelHint.textContent = 'Uploading channel metadata to IPFS...';
      channelHint.className = 'field-hint';

      try {
        channelHint.textContent = 'Confirm transaction in wallet...';
        var channelDesc = dom.assetDescription.value.trim() || 'Digital assets channel on PC2';
        var result = await doCreateChannel(channelName, channelDesc);
        showToast('Channel created: ' + result.address.substring(0, 10) + '...', 'success');
        state.channelsLoaded = false;
        await loadChannels(state.walletAddress);

        // Ensure the newly created channel is in the dropdown even if the
        // backend query hasn't indexed it yet.
        var found = false;
        for (var i = 0; i < dom.assetChannel.options.length; i++) {
          if (dom.assetChannel.options[i].value.toLowerCase() === result.address.toLowerCase()) {
            found = true;
            break;
          }
        }
        if (!found) {
          var newGroup = dom.assetChannel.querySelector('optgroup[label^="Your"]');
          if (!newGroup) {
            newGroup = document.createElement('optgroup');
            newGroup.label = 'Your Channels (1)';
            dom.assetChannel.insertBefore(newGroup, dom.assetChannel.firstChild);
          }
          var newOpt = document.createElement('option');
          newOpt.value = result.address;
          newOpt.textContent = result.name + ' (' + result.address.substring(0, 8) + '...)';
          newGroup.appendChild(newOpt);
        }

        dom.assetChannel.value = result.address;
        dom.assetChannelCustom.classList.add('hidden');
        channelHint.textContent = 'Your channel: ' + result.address.substring(0, 10) + '... (you have full minting rights)';
        channelHint.className = 'field-hint success';
      } catch (err) {
        channelHint.textContent = 'Channel creation failed: ' + (err.message || '').substring(0, 80);
        channelHint.className = 'field-hint';
        showToast('Channel creation failed: ' + (err.message || ''), 'error');
      } finally {
        btnCreateChannel.disabled = false;
        btnCreateChannel.textContent = '+ Create';
      }
    });

    // Channel dropdown: toggle custom address input
    dom.assetChannel.addEventListener('change', function () {
      var isCustom = dom.assetChannel.value === '__custom__';
      dom.assetChannelCustom.classList.toggle('hidden', !isCustom);
      if (isCustom) dom.assetChannelCustom.focus();
    });

    // Step 2 form validation
    ['input', 'change'].forEach(function (evt) {
      dom.assetTitle.addEventListener(evt, validateStep2);
      dom.assetCategory.addEventListener(evt, validateStep2);
      dom.assetPrice.addEventListener(evt, validateStep2);
      dom.assetAccess.addEventListener(evt, validateStep2);
      dom.assetChannel.addEventListener(evt, validateStep2);
      dom.assetChannelCustom.addEventListener(evt, validateStep2);
    });

    // Step navigation
    dom.btnToStep2.addEventListener('click', function () {
      goToStep(2);
      var btn = document.getElementById('btn-to-step-3');
      if (btn && state.isMediaFile) {
        btn.textContent = 'Encode, Upload & Mint';
      } else if (btn) {
        btn.textContent = 'Encrypt, Upload & Mint';
      }
    });
    dom.btnBackTo1.addEventListener('click', function () { goToStep(1); });
    dom.btnToStep3.addEventListener('click', function () {
      if (!state.walletAddress) {
        showToast('Connect your wallet first', 'error');
        return;
      }
      if (!state.fileBytes && !state.isMediaFile) {
        showToast('File not loaded yet — please wait', 'error');
        return;
      }
      var ch = getSelectedChannel();
      if (!ch || !ethers.isAddress(ch)) {
        showToast('Please select a valid channel address before minting', 'error');
        var hint = document.getElementById('channel-hint');
        hint.textContent = 'A valid channel address is required. Select one from the list or enter manually.';
        hint.className = 'field-hint error';
        dom.assetChannel.focus();
        return;
      }
      goToStep(3);
      runPipeline();
    });
    dom.btnBackTo2.addEventListener('click', function () { goToStep(2); });
    dom.btnNewAsset.addEventListener('click', resetAll);

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

    // Auto-connect wallet if available
    if (window.ethereum) {
      window.ethereum.request({ method: 'eth_accounts' })
        .then(function (accounts) {
          if (accounts && accounts[0]) {
            state.walletAddress = accounts[0];
            dom.walletBtn.textContent = accounts[0].substring(0, 6) + '...' + accounts[0].slice(-4);
            dom.walletBtn.classList.add('connected');
          }
        })
        .catch(function () {});
    }

    // Pre-load file when launched via right-click "Mint on Elacity"
    (function () {
      var puterArgs;
      try {
        var raw = new URLSearchParams(window.location.search).get('puter.args');
        puterArgs = raw ? JSON.parse(raw) : {};
      } catch (_) { puterArgs = {}; }

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
