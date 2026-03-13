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
    dom.progressError = document.getElementById('progress-error');
    dom.resultAssetCid = document.getElementById('result-asset-cid');
    dom.resultMetaCid = document.getElementById('result-meta-cid');
    dom.resultEncryptHash = document.getElementById('result-encrypt-hash');
    dom.resultSize = document.getElementById('result-size');
    dom.toastContainer = document.getElementById('toast-container');
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

    var MAX_FILE_SIZE = 100 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      showToast('File too large. Maximum size: 100 MB', 'error');
      return;
    }

    state.selectedFile = file;

    dom.fileIcon.textContent = getFileIcon(file.type);
    dom.fileName.textContent = file.name;
    dom.fileMeta.textContent = formatSize(file.size) + ' — ' + (file.type || 'unknown type');
    dom.dropZone.classList.add('hidden');
    dom.filePreview.classList.remove('hidden');
    dom.btnToStep2.disabled = false;

    var reader = new FileReader();
    reader.onload = function () {
      state.fileBytes = new Uint8Array(reader.result);
    };
    reader.readAsArrayBuffer(file);

    if (!dom.assetTitle.value) {
      var nameNoExt = file.name.replace(/\.[^.]+$/, '');
      dom.assetTitle.value = nameNoExt;
    }
  }

  function clearFile() {
    state.selectedFile = null;
    state.fileBytes = null;
    dom.dropZone.classList.remove('hidden');
    dom.filePreview.classList.add('hidden');
    dom.btnToStep2.disabled = true;
    dom.fileInput.value = '';
  }

  // ── Form validation ───────────────────────────────────

  function validateStep2() {
    var title = dom.assetTitle.value.trim();
    var category = dom.assetCategory.value;
    var price = parseFloat(dom.assetPrice.value);
    var valid = title.length > 0 && category && !isNaN(price) && price >= 0;
    dom.btnToStep3.disabled = !valid;
  }

  // ── Encrypt & Upload pipeline ─────────────────────────

  function setProgStep(id, status, cls) {
    var el = document.getElementById(id);
    var statusEl = document.getElementById(id + '-status');
    el.className = 'progress-step ' + (cls || '');
    statusEl.textContent = status;
  }

  function uint8ToBase64(bytes) {
    var binary = '';
    var chunkSize = 32768;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function buildMetadataEnvelope(params) {
    return {
      schema: 'elacity-asset-envelope-v1',
      name: params.title,
      description: params.description,
      category: params.category,
      asset: {
        cid: params.assetCid,
        mimeType: params.mimeType,
        size: params.size,
        encrypted: true,
        algorithm: 'aes-gcm',
        dataToEncryptHash: params.dataToEncryptHash,
        keyId: params.keyId,
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
        publisher: params.creatorAddress,
        distribution: params.accessMethod === 'buy_once' ? 'Buy Once'
          : params.accessMethod === 'free' ? 'Free' : 'Buy & Resell',
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

  var PROGRESS_STEPS = ['prog-connect', 'prog-encrypt', 'prog-upload-asset', 'prog-upload-meta', 'prog-mint', 'prog-approve'];

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
    var txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [txParams],
    });
    return txHash;
  }

  async function waitForReceipt(txHash, maxWait) {
    var start = Date.now();
    maxWait = maxWait || 120000;
    while (Date.now() - start < maxWait) {
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
    throw new Error('Transaction confirmation timeout');
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
      creator: params.creator,
      scope: '1',
      channelType: '1',
      categories: [],
      plans: [],
      tokenAccess: [],
    };

    var resp = await fetch(ELACITY_BACKEND + '/2.0/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Transaction-Id': params.txHash,
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
    var channel = dom.assetChannel.value.trim();
    var usedLocalEncryption = false;

    dom.progressError.classList.add('hidden');
    dom.btnBackTo2.disabled = true;

    try {
      if (!state.walletAddress) {
        var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        state.walletAddress = accounts[0];
      }

      // ── Step 1: Encrypt ───────────────────────────────
      setProgStep('prog-connect', 'Connecting...', 'active');

      var encryptResult;
      var ledger = channel || '0x0000000000000000000000000000000000000000';
      var tokenId = '0';

      try {
        var mod = await import('./vendor/access/elacity-access.browser.js');
        var access = new mod.ElacityAccess();
        await access.connect(window.ethereum, { chainId: BASE_CHAIN_ID });
        setProgStep('prog-connect', 'Lit Connected (datil)', 'done');

        setProgStep('prog-encrypt', 'Encrypting (Lit)...', 'active');
        encryptResult = await access.encryptBuffer(state.fileBytes, {
          ledger: ledger,
          tokenId: tokenId,
        });
      } catch (litErr) {
        console.warn('[Creator] Lit Protocol unavailable, using local encryption:', litErr.message);
        setProgStep('prog-connect', 'Local mode (Lit unreachable)', 'done');

        setProgStep('prog-encrypt', 'Encrypting (local AES-GCM)...', 'active');
        encryptResult = await localEncrypt(state.fileBytes);
        usedLocalEncryption = true;
      }
      setProgStep('prog-encrypt', 'Encrypted', 'done');

      // ── Step 2: Upload encrypted asset to IPFS ────────
      setProgStep('prog-upload-asset', 'Uploading...', 'active');
      var assetBase64 = uint8ToBase64(encryptResult.encrypted);
      var assetResp = await pc2Fetch('/api/storage/ipfs/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: assetBase64, announce: true }),
      });

      if (!assetResp.ok) {
        var errBody = await assetResp.json().catch(function () { return {}; });
        throw new Error('IPFS upload failed: ' + (errBody.error || assetResp.status));
      }

      var assetData = await assetResp.json();
      var assetCid = assetData.cid;
      setProgStep('prog-upload-asset', 'CID: ' + assetCid.substring(0, 12) + '...', 'done');

      // ── Step 3: Upload metadata as IPFS directory ─────
      // Elacity expects {dirCID}/metadata.json — we upload a directory
      // containing metadata.json so the URI resolves on any IPFS gateway.
      setProgStep('prog-upload-meta', 'Uploading...', 'active');
      var envelope = buildMetadataEnvelope({
        title: title,
        description: description,
        category: category,
        assetCid: assetCid,
        mimeType: state.selectedFile.type || 'application/octet-stream',
        size: state.selectedFile.size,
        dataToEncryptHash: encryptResult.dataToEncryptHash,
        keyId: encryptResult.keyId,
        price: price,
        accessMethod: accessMethod,
        copies: copies,
        creatorAddress: state.walletAddress,
        channel: channel,
      });

      if (usedLocalEncryption) {
        envelope.asset._devMode = true;
        envelope.asset._localKey = encryptResult._localDevKey;
      }

      var metaJsonStr = JSON.stringify(envelope, null, 2);
      var metaBase64 = btoa(unescape(encodeURIComponent(metaJsonStr)));
      var metaResp = await pc2Fetch('/api/storage/ipfs/add-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: { 'metadata.json': metaBase64 },
          announce: true,
        }),
      });

      if (!metaResp.ok) {
        var metaErr = await metaResp.json().catch(function () { return {}; });
        throw new Error('Metadata upload failed: ' + (metaErr.error || metaResp.status));
      }

      var metaData = await metaResp.json();
      var metaCid = metaData.cid;
      setProgStep('prog-upload-meta', 'CID: ' + metaCid.substring(0, 12) + '...', 'done');

      // ── Step 4: Mint on Channel contract ──────────────
      var mintedTokenId = null;
      var mintedOpContract = null;
      var mintTxHash = null;

      if (channel && ethers.isAddress(channel)) {
        setProgStep('prog-mint', 'Preparing...', 'active');

        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: BASE_CHAIN_HEX }],
          });
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

        var mintUri = metaCid + '/metadata.json';
        var iface = new ethers.Interface(ABI.DIGITAL_ASSET);
        var mintData = iface.encodeFunctionData('mint', [mintUri, opType, opRawData, sellRawData]);

        setProgStep('prog-mint', 'Confirm in wallet...', 'active');
        mintTxHash = await sendTx(channel, mintData, feeInfo.fee);

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
          setProgStep('prog-approve', 'Approving gateway on ' + mintedOpContract.substring(0, 8) + '...', 'active');

          var opIface = new ethers.Interface(ABI.OPERATIVE);
          var approveData = opIface.encodeFunctionData('setApprovalForAll', [gatewayAddress, true]);

          setProgStep('prog-approve', 'Confirm in wallet...', 'active');
          var approveTxHash = await sendTx(mintedOpContract, approveData);
          setProgStep('prog-approve', 'Confirming tx...', 'active');
          await waitForReceipt(approveTxHash);
          setProgStep('prog-approve', 'Gateway approved', 'done');
          console.log('[Creator] setApprovalForAll done on', mintedOpContract, 'for gateway', gatewayAddress);
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
    clearFile();
    dom.assetTitle.value = '';
    dom.assetDescription.value = '';
    dom.assetCategory.value = '';
    dom.assetPrice.value = '4.99';
    dom.assetAccess.value = 'free';
    dom.assetCopies.value = '10000';
    dom.assetChannel.value = DEFAULT_CHANNEL;
    dom.progressError.classList.add('hidden');
    dom.btnBackTo2.disabled = false;

    PROGRESS_STEPS.forEach(function (id) {
      setProgStep(id, 'Waiting...', '');
    });

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
        dom.assetChannel.value = result.address;
        channelHint.textContent = 'Your channel: ' + result.address.substring(0, 10) + '... (you have full minting rights)';
        channelHint.className = 'field-hint success';
        showToast('Channel created: ' + result.address.substring(0, 10) + '...', 'success');
      } catch (err) {
        channelHint.textContent = 'Channel creation failed: ' + (err.message || '').substring(0, 80);
        channelHint.className = 'field-hint';
        showToast('Channel creation failed: ' + (err.message || ''), 'error');
      } finally {
        btnCreateChannel.disabled = false;
        btnCreateChannel.textContent = '+ Create Channel';
      }
    });

    // Step 2 form validation
    ['input', 'change'].forEach(function (evt) {
      dom.assetTitle.addEventListener(evt, validateStep2);
      dom.assetCategory.addEventListener(evt, validateStep2);
      dom.assetPrice.addEventListener(evt, validateStep2);
      dom.assetAccess.addEventListener(evt, validateStep2);
    });

    // Step navigation
    dom.btnToStep2.addEventListener('click', function () { goToStep(2); });
    dom.btnBackTo1.addEventListener('click', function () { goToStep(1); });
    dom.btnToStep3.addEventListener('click', function () {
      if (!state.walletAddress) {
        showToast('Connect your wallet first', 'error');
        return;
      }
      if (!state.fileBytes) {
        showToast('File not loaded yet — please wait', 'error');
        return;
      }
      goToStep(3);
      runPipeline();
    });
    dom.btnBackTo2.addEventListener('click', function () { goToStep(2); });
    dom.btnNewAsset.addEventListener('click', resetAll);

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
