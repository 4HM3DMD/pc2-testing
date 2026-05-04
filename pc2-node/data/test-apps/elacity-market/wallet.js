/**
 * Wallet operations for the Elacity Market Browser.
 * All calls go through the PC2 wallet bridge (window.ethereum).
 */
var Wallet = (function () {
  'use strict';

  var BASE_CHAIN_ID = '0x2105'; // 8453 in hex
  var BASE_CHAIN_CONFIG = {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org']
  };

  var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  var BUY_ACCESS_ABI = [
    'function buyAccess(address seller, address ledger, uint256 tokenId, uint256 _quantity, uint256 _pricePerToken) payable',
    'function buyAccess(address seller, address ledger, uint256 tokenId, uint256 _quantity, uint256 _pricePerToken, address _payToken)'
  ];
  var ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)'
  ];
  var OPERATIVE_ABI = [
    'function paymentProcessor() view returns (address)',
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address account, address operator) view returns (bool)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function OP_TYPE() view returns (uint16)',
    'function resellerCut() view returns (uint16)',
    'function rewardsOf(address user, address payToken) view returns (uint256)',
    'function hasTradeAccess(address account, uint256 tokenId) view returns (bool)',
    'function withdrawRewards(address paymentToken)',
    'function multicall(bytes[] data)',
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
    'function royaltyInfo(uint256 salePrice) view returns (tuple(address receiver, uint256 amount)[])'
  ];
  var SUBSCRIPTION_MODULE_ABI = [
    'function bulkUpdatePlans(tuple(string action, bytes args)[] updates)',
    'function getPlans() view returns (tuple(uint8 planId, address payToken, uint256 price, uint256 duration, bool active)[])',
    'function configureTokenOwnershipAccess(tuple(address tokenAddress, uint256 threshold)[] thresholds)',
    'function hasActiveSubscription(address subscriber) view returns (bool)',
    'function subscribePlan(uint8 planId, bool recurring) payable',
    'function paymentProcessor() view returns (address)'
  ];
  var TOKEN_INTROSPECT_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)'
  ];
  var AUTHORITY_GATEWAY_ABI = [
    'function sellAccess(address ledger, uint256 tokenId, uint256 quantity, uint256 pricePerToken, address payToken)',
    'function withdrawListing(address operative, uint256 tokenId, uint256 quantity)',
    'function sellersOf(address operative, uint256 tokenId) view returns (address[])',
    'function listings(address operative, uint256 tokenId, address seller) view returns (uint256, uint256, address)',
    'function hasAccess(address accessor, address ledger, uint256 tokenId) view returns (bool)'
  ];
  var TRADE_GATEWAY_ABI = [
    'function sellToken(address operative, uint256 tokenId, uint256 quantity, uint256 pricePerToken, address payToken)',
    'function buyToken(address seller, address operative, uint256 tokenId, uint256 quantity) payable',
    'function withdrawListing(address operative, uint256 tokenId, uint256 quantity)',
    'function createOffer(address operative, uint256 tokenId, uint256 quantity, uint256 pricePerToken, address payToken)',
    'function acceptOffer(address from, address operative, uint256 tokenId, uint256 quantity)',
    'function cancelOffer(address operative, uint256 tokenId)',
    'function sellersOf(address operative, uint256 tokenId) view returns (address[])',
    'function listings(address operative, uint256 tokenId, address seller) view returns (uint256, uint256, address)',
    'function cstore() view returns (address)'
  ];
  var STORAGE_ABI = [
    'function offers(address op, uint256 tokenId, address owner) returns (uint256, uint256, address)',
    'function offerersOf(address op, uint256 tokenId) returns (address[])'
  ];
  var TRADE_ACCESS_ABI = [
    'function hasTradeAccess(address account, uint256 tkId) view returns (bool)'
  ];
  var ERC721_ABI = [
    'function safeTransferFrom(address from, address to, uint256 tokenId)'
  ];
  var ERC1155_ABI = [
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)'
  ];

  var AUTHORITY_GATEWAY_ADDRESS = '0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D';
  var TRADE_GATEWAY_ADDRESS = '0xd02451BCE627EF476B8ee52Cf131C426f67dbcB2';
  var USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  var TOKEN_ID_ACCESS = 1;
  var TOKEN_ID_ROYALTY_SHARE = 2;
  var TOKEN_ID_DISTRIBUTION = 3;

  var connectedAddress = null;
  var smartAccountAddress = new URLSearchParams(window.location.search).get('puter.smart_account') || null;
  var currentChainId = null;
  var siwePromise = null;

  // Short-lived RPC read cache. Base's public RPC throttles `eth_call` when
  // the detail view flips back and forth between assets (it fires a burst of
  // sellersOf + listings + balanceOf per open); throttled reads made the
  // Buy-button back-fill silently empty and the price section flicker in and
  // out. 30 s TTL is short enough to pick up fresh listings after a cancel
  // or a new mint, long enough to survive a rate-limit cooldown.
  var _rpcReadCache = {};
  var _RPC_CACHE_TTL_MS = 30000;

  function _cacheGet(key) {
    var entry = _rpcReadCache[key];
    if (!entry) return null;
    if (Date.now() - entry.at > _RPC_CACHE_TTL_MS) {
      delete _rpcReadCache[key];
      return null;
    }
    return entry.value;
  }

  function _cacheSet(key, value) {
    _rpcReadCache[key] = { at: Date.now(), value: value };
    return value;
  }

  function _isRateLimitError(err) {
    var msg = (err && err.message) || '';
    return msg.indexOf('rate-limited') !== -1
      || msg.indexOf('Too Many Requests') !== -1
      || msg.indexOf('429') !== -1;
  }

  // Retry-once wrapper for read RPC calls that get rate-limited by the
  // Base public gateway. Only retries on rate-limit errors; all other
  // failures propagate immediately.
  function _withRateLimitRetry(fn) {
    return fn().catch(function (err) {
      if (!_isRateLimitError(err)) throw err;
      return new Promise(function (resolve) { setTimeout(resolve, 600); }).then(fn);
    });
  }
  var ipcMsgCounter = 0;
  var appInstanceId = new URLSearchParams(window.location.search).get('puter.app_instance_id') || '';

  function getProvider() {
    if (!window.ethereum) throw new Error('No wallet provider available');
    return window.ethereum;
  }

  function parentSendTransaction(txParams) {
    return new Promise(function (resolve, reject) {
      var msgId = 'wallet-tx-' + (++ipcMsgCounter) + '-' + Date.now();

      function handler(event) {
        if (!event.data || event.data.original_msg_id !== msgId) return;
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.txHash);
        }
      }

      window.addEventListener('message', handler);
      window.parent.postMessage({
        $: 'puter-ipc',
        msg: 'walletSendTransaction',
        appInstanceID: appInstanceId,
        env: 'app',
        uuid: msgId,
        txParams: txParams
      }, '*');
    });
  }

  function parentExecuteSmartAccountBatch(chainId, transactions, expectTokens) {
    return new Promise(function (resolve, reject) {
      var msgId = 'wallet-batch-' + (++ipcMsgCounter) + '-' + Date.now();

      function handler(event) {
        if (!event.data || event.data.original_msg_id !== msgId) return;
        if (event.data.msg !== 'walletExecuteSmartAccountBatchResult') return;
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve({
            transactionId: event.data.transactionId,
            transactionHash: event.data.transactionHash
          });
        }
      }

      window.addEventListener('message', handler);
      window.parent.postMessage({
        $: 'puter-ipc',
        msg: 'walletExecuteSmartAccountBatch',
        appInstanceID: appInstanceId,
        env: 'app',
        uuid: msgId,
        chainId: chainId,
        transactions: transactions,
        expectTokens: expectTokens || []
      }, '*');
    });
  }

  function getSmartAccountFromParent() {
    return new Promise(function (resolve) {
      if (window.parent === window) { resolve(null); return; }
      var msgId = 'wallet-sa-' + (++ipcMsgCounter) + '-' + Date.now();
      var done = false;
      function handler(event) {
        if (!event.data || event.data.original_msg_id !== msgId) return;
        if (event.data.msg !== 'walletGetSmartAccountAddressResult') return;
        window.removeEventListener('message', handler);
        if (!done) { done = true; resolve(event.data.smartAccountAddress || null); }
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({
        $: 'puter-ipc',
        msg: 'walletGetSmartAccountAddress',
        appInstanceID: appInstanceId,
        env: 'app',
        uuid: msgId
      }, '*');
      setTimeout(function () {
        window.removeEventListener('message', handler);
        if (!done) { done = true; resolve(null); }
      }, 3000);
    });
  }

  // ── Connection ───────────────────────────────────────

  function connect() {
    return getProvider().request({ method: 'eth_accounts' })
      .then(function (accounts) {
        if (accounts && accounts.length > 0) return accounts;
        return getProvider().request({ method: 'eth_requestAccounts' });
      })
      .then(function (accounts) {
        connectedAddress = accounts[0] || null;
        return getProvider().request({ method: 'eth_chainId' });
      })
      .then(function (chainId) {
        currentChainId = chainId;
        return getProvider().request({ method: 'pc2_getSmartAccountAddress' });
      })
      .then(function (sa) {
        if (sa) smartAccountAddress = sa;
        // V3 contracts live on Base — ensure bridge routes reads to 8453
        if (currentChainId !== BASE_CHAIN_ID) {
          return switchToBase().then(function () {
            return { address: connectedAddress, chainId: currentChainId, smartAccountAddress: smartAccountAddress };
          });
        }
        return { address: connectedAddress, chainId: currentChainId, smartAccountAddress: smartAccountAddress };
      })
      .catch(function (err) {
        return { address: connectedAddress, chainId: currentChainId, smartAccountAddress: smartAccountAddress };
      });
  }

  function getAddress() {
    return connectedAddress;
  }

  function getSignerAddress() {
    return smartAccountAddress || connectedAddress;
  }

  function isConnected() {
    return !!connectedAddress;
  }

  function getChainId() {
    return currentChainId;
  }

  function isOnBase() {
    return currentChainId === BASE_CHAIN_ID;
  }

  // ── Chain Switching ──────────────────────────────────

  function switchToBase() {
    if (currentChainId === BASE_CHAIN_ID) return Promise.resolve();
    return getProvider().request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID }]
    })
      .catch(function (err) {
        if (err.code === 4902) {
          return getProvider().request({
            method: 'wallet_addEthereumChain',
            params: [BASE_CHAIN_CONFIG]
          });
        }
        throw err;
      })
      .then(function () {
        currentChainId = BASE_CHAIN_ID;
      });
  }

  // ── SIWE Authentication ──────────────────────────────

  function siweLogin() {
    if (ElacityAPI.isAuthenticated()) return Promise.resolve();
    if (siwePromise) return siwePromise;

    if (!connectedAddress) {
      siwePromise = connect().then(function () {
        siwePromise = null;
        return siweLogin();
      }).catch(function (err) {
        siwePromise = null;
        throw err;
      });
      return siwePromise;
    }

    siwePromise = ElacityAPI.getNonce(connectedAddress)
      .then(function (nonce) {
        var message = 'Approve signature on https://ela.city with nonce ' + (nonce || 0);
        var hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
          .map(function (b) { return b.toString(16).padStart(2, '0'); })
          .join('');

        return getProvider().request({
          method: 'personal_sign',
          params: [hexMessage, connectedAddress]
        });
      })
      .then(function (signature) {
        var sa = smartAccountAddress || getProvider().smartAccountAddress || null;
        if (sa) smartAccountAddress = sa;
        return ElacityAPI.login(connectedAddress, signature, sa).then(function (auth) {
          if (auth && auth.sa) smartAccountAddress = auth.sa;
          siwePromise = null;
          return auth;
        });
      })
      .catch(function (err) {
        siwePromise = null;
        throw err;
      });

    return siwePromise;
  }

  // ── Purchase ─────────────────────────────────────────

  function ensureBase() {
    if (isOnBase()) return Promise.resolve();
    return switchToBase();
  }

  function buyAccess(authorityAddr, seller, ledger, tokenId, quantity, priceWei, payToken, operativeAddr) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var isNativePayment = !payToken || payToken === ZERO_ADDRESS;
      var iface = new ethers.Interface(BUY_ACCESS_ABI);

      if (isNativePayment) {
        var data = iface.encodeFunctionData(
          'buyAccess(address,address,uint256,uint256,uint256)',
          [seller, ledger, ethers.getBigInt(tokenId), ethers.getBigInt(quantity), ethers.getBigInt(priceWei)]
        );
        return parentSendTransaction({ to: authorityAddr, data: data, value: ethers.toQuantity(ethers.getBigInt(priceWei)) });
      }

      var buyData = iface.encodeFunctionData(
        'buyAccess(address,address,uint256,uint256,uint256,address)',
        [seller, ledger, ethers.getBigInt(tokenId), ethers.getBigInt(quantity), ethers.getBigInt(priceWei), payToken]
      );
      var buyTx = { to: authorityAddr, data: buyData, value: '0x0' };

      function runSmartAccountBatch(effectiveSa) {
        console.log('[Wallet buyAccess] runSmartAccountBatch called, SA:', effectiveSa);
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        var ownerAddr = (effectiveSa || '').toLowerCase();
        return getPaymentProcessor(operativeAddr).then(function (approvalTarget) {
          console.log('[Wallet buyAccess] approvalTarget:', approvalTarget);
          var erc20Iface = new ethers.Interface(ERC20_ABI);
          var allowanceData = erc20Iface.encodeFunctionData('allowance', [ownerAddr, approvalTarget]);
          return getProvider().request({
            method: 'eth_call',
            params: [{ to: payToken, data: allowanceData }, 'latest']
          }).then(function (allowanceResult) {
            var currentAllowance = ethers.getBigInt(allowanceResult);
            var needed = ethers.getBigInt(priceWei);
            var transactions = [];
            if (currentAllowance < needed) {
              var approveData = erc20Iface.encodeFunctionData('approve', [approvalTarget, ethers.MaxUint256]);
              transactions.push({ to: payToken, data: approveData, value: '0x0' });
            }
            transactions.push(buyTx);

            // Convert priceWei to human-readable USDC amount (6 decimals) for expectTokens
            var priceNum = Number(ethers.getBigInt(priceWei));
            var usdcAmount = (priceNum / 1e6).toString();
            var expectTokens = [{ type: 'usdc', amount: usdcAmount }];

            return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, expectTokens);
          }).then(function (result) {
            var hash = result.transactionHash;
            var isOnChainHash = hash && hash.length === 66 && hash.startsWith('0x');
            if (!isOnChainHash) {
              console.warn('[Wallet buyAccess] UA transaction submitted but no on-chain hash. ID:', result.transactionId);
              if (result.transactionId) {
                console.log('[Wallet buyAccess] Check status at: https://universalx.app/activity/details?id=' + result.transactionId);
              }
            }
            return {
              status: isOnChainHash ? '0x1' : '0x0',
              transactionHash: hash || result.transactionId,
              transactionId: result.transactionId,
              _smartAccountConfirmed: true,
              _uaPending: !isOnChainHash
            };
          });
        });
      }

      function resolveSmartAccount() {
        var apiSigner = typeof ElacityAPI !== 'undefined' && ElacityAPI.getSignerAddress && ElacityAPI.getSignerAddress();
        var sa = smartAccountAddress || apiSigner;
        console.log('[Wallet buyAccess] resolveSmartAccount:', { smartAccountAddress: smartAccountAddress, apiSigner: apiSigner, sa: sa, connectedAddress: connectedAddress });
        if (sa && (connectedAddress || '').toLowerCase() !== (sa || '').toLowerCase()) {
          console.log('[Wallet buyAccess] Using SA from local/API:', sa);
          return Promise.resolve(sa);
        }
        if (window.parent !== window) {
          console.log('[Wallet buyAccess] Asking parent for SA...');
          return getSmartAccountFromParent().then(function (parentSa) {
            console.log('[Wallet buyAccess] Parent returned SA:', parentSa);
            if (parentSa) {
              smartAccountAddress = parentSa;
              return parentSa;
            }
            return null;
          });
        }
        return Promise.resolve(null);
      }

      return resolveSmartAccount().then(function (effectiveSa) {
        console.log('[Wallet buyAccess] RESOLVED SA:', effectiveSa, '| Will use batch:', !!effectiveSa);
        if (effectiveSa) {
          return runSmartAccountBatch(effectiveSa);
        }
        console.warn('[Wallet] No smart account available, falling back to EOA path');
        return getPaymentProcessor(operativeAddr)
          .then(function (approvalTarget) {
            return approveIfNeeded(payToken, priceWei, approvalTarget);
          })
          .then(function () {
            return parentSendTransaction(buyTx);
          });
      });
    });
  }

  function getPaymentProcessor(operativeAddr) {
    if (!operativeAddr) return Promise.resolve(operativeAddr);
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('paymentProcessor', []);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      var decoded = '0x' + result.slice(26);
      if (decoded === ZERO_ADDRESS) return operativeAddr;
      return decoded;
    }).catch(function () {
      return operativeAddr;
    });
  }

  function approveIfNeeded(tokenAddress, amountWei, spender, ownerOverride) {
    var iface = new ethers.Interface(ERC20_ABI);
    var ownerAddr = ownerOverride || smartAccountAddress || connectedAddress;

    var allowanceData = iface.encodeFunctionData('allowance', [
      ownerAddr,
      spender
    ]);

    return getProvider().request({
      method: 'eth_call',
      params: [{ to: tokenAddress, data: allowanceData }, 'latest']
    }).then(function (result) {
      var currentAllowance = ethers.getBigInt(result);
      var needed = ethers.getBigInt(amountWei);

      if (currentAllowance >= needed) return;

      var approveData = iface.encodeFunctionData('approve', [
        spender,
        needed
      ]);

      return parentSendTransaction({
        to: tokenAddress,
        data: approveData
      }).then(function (txHash) {
        return waitForReceipt(txHash);
      }).then(function () {
        return waitForAllowance(tokenAddress, ownerAddr, spender, needed);
      });
    });
  }

  function waitForAllowance(tokenAddress, owner, spender, needed) {
    var iface = new ethers.Interface(ERC20_ABI);
    var data = iface.encodeFunctionData('allowance', [owner, spender]);
    var attempts = 0;
    var maxAttempts = 15;

    function poll() {
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: tokenAddress, data: data }, 'latest']
      }).then(function (result) {
        var current = ethers.getBigInt(result);
        if (current >= needed) return;
        attempts++;
        if (attempts >= maxAttempts) return;
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(poll()); }, 1500);
        });
      });
    }

    return poll();
  }

  function waitForReceipt(txHash, maxAttempts) {
    maxAttempts = maxAttempts || 60;
    var attempt = 0;

    function poll() {
      return getProvider().request({
        method: 'eth_getTransactionReceipt',
        params: [txHash]
      }).then(function (receipt) {
        if (receipt) return receipt;
        attempt++;
        if (attempt >= maxAttempts) throw new Error('Transaction not confirmed after ' + maxAttempts + ' attempts');
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(poll()); }, 2000);
        });
      });
    }

    return poll();
  }

  // ── Event Listeners ──────────────────────────────────

  function setupListeners(callbacks) {
    if (!window.ethereum) return;

    window.ethereum.on('accountsChanged', function (accounts) {
      connectedAddress = accounts[0] || null;
      if (window.ethereum.smartAccountAddress) {
        smartAccountAddress = window.ethereum.smartAccountAddress;
      }
      if (callbacks.onAccountChange) callbacks.onAccountChange(connectedAddress);
    });

    window.ethereum.on('chainChanged', function (chainId) {
      currentChainId = chainId;
      if (callbacks.onChainChange) callbacks.onChainChange(chainId);
    });
  }

  function signMessage(message) {
    if (!connectedAddress) return Promise.reject(new Error('Wallet not connected'));
    var hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
    return getProvider().request({
      method: 'personal_sign',
      params: [hexMessage, connectedAddress]
    });
  }

  function getSmartAccountAddress() {
    return smartAccountAddress;
  }

  function hasSmartAccount() {
    return !!smartAccountAddress && smartAccountAddress.toLowerCase() !== (connectedAddress || '').toLowerCase();
  }

  function buyAccessWithEOA(authorityAddr, seller, ledger, tokenId, quantity, priceWei, payToken, operativeAddr) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    // Log inputs once up-front — these are the exact values passed in by
    // app.js handleBuy. Captures missing/malformed args (Irzhy's 2026-04-28
    // "Invalid Params" report showed MetaMask rejecting at addDappTransaction
    // BEFORE the user-approval dialog, which means a field in the tx envelope
    // was malformed. Logging inputs + the final tx object lets us compare.
    console.log('[Wallet buyAccessWithEOA] inputs:', {
      authorityAddr: authorityAddr,
      seller: seller,
      ledger: ledger,
      tokenId: String(tokenId),
      quantity: String(quantity),
      priceWei: String(priceWei),
      payToken: payToken,
      operativeAddr: operativeAddr,
      connectedAddress: connectedAddress,
      currentChainId: currentChainId
    });

    return ensureBase().then(function () {
      var isNativePayment = !payToken || payToken === ZERO_ADDRESS;
      var iface = new ethers.Interface(BUY_ACCESS_ABI);

      if (isNativePayment) {
        var data = iface.encodeFunctionData(
          'buyAccess(address,address,uint256,uint256,uint256)',
          [seller, ledger, ethers.getBigInt(tokenId), ethers.getBigInt(quantity), ethers.getBigInt(priceWei)]
        );
        var nativeTx = { to: authorityAddr, data: data, value: ethers.toQuantity(ethers.getBigInt(priceWei)) };
        console.log('[Wallet buyAccessWithEOA] native-payment tx envelope:', nativeTx);
        return parentSendTransaction(nativeTx);
      }

      var buyData = iface.encodeFunctionData(
        'buyAccess(address,address,uint256,uint256,uint256,address)',
        [seller, ledger, ethers.getBigInt(tokenId), ethers.getBigInt(quantity), ethers.getBigInt(priceWei), payToken]
      );
      var buyTx = { to: authorityAddr, data: buyData, value: '0x0' };
      console.log('[Wallet buyAccessWithEOA] erc20 buy tx envelope (after approve):', buyTx);

      return getPaymentProcessor(operativeAddr)
        .then(function (approvalTarget) {
          return approveIfNeeded(payToken, priceWei, approvalTarget, connectedAddress);
        })
        .then(function () {
          return parentSendTransaction(buyTx);
        });
    });
  }

  // ── Operative Read Helpers ──────────────────────────

  function getOperativeOpType(operativeAddr) {
    if (!operativeAddr) return Promise.resolve(0);
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('OP_TYPE', []);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      return Number(ethers.getBigInt(result));
    }).catch(function () { return 0; });
  }

  function getOperativeResellerCut(operativeAddr) {
    if (!operativeAddr) return Promise.resolve(0);
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('resellerCut', []);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      return Number(ethers.getBigInt(result));
    }).catch(function () { return 0; });
  }

  function getTokenBalance(contractAddr, ownerAddr, tokenId) {
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('balanceOf', [ownerAddr, tokenId]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: contractAddr, data: data }, 'latest']
    }).then(function (result) {
      return Number(ethers.getBigInt(result));
    }).catch(function () { return 0; });
  }

  function getAccessTokenBalance(operativeAddr, ownerAddr) {
    return getTokenBalance(operativeAddr, ownerAddr, TOKEN_ID_ACCESS);
  }

  function getRoyaltyShareBalance(operativeAddr, ownerAddr) {
    return getTokenBalance(operativeAddr, ownerAddr, TOKEN_ID_ROYALTY_SHARE);
  }

  function getPendingRewards(operativeAddr, ownerAddr, payToken) {
    if (!operativeAddr) return Promise.resolve(0);
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('rewardsOf', [ownerAddr, payToken]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      return ethers.getBigInt(result).toString();
    }).catch(function () { return '0'; });
  }

  function checkTradeAccess(operativeAddr, ownerAddr, tokenId) {
    if (!operativeAddr) return Promise.resolve(false);
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('hasTradeAccess', [ownerAddr, tokenId]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      return result !== '0x' + '0'.repeat(64);
    }).catch(function () { return false; });
  }

  // ── Resell Access Token (AuthorityGateway) ─────────

  function resellAccessToken(ledgerAddr, tokenId, quantity, priceWei, payToken, operativeAddr, useWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var opIface = new ethers.Interface(OPERATIVE_ABI);
      var agIface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
      var useEOA = (useWallet === 'eoa');
      var ownerAddr = useEOA ? connectedAddress : (smartAccountAddress || connectedAddress);

      var isApprovedData = opIface.encodeFunctionData('isApprovedForAll', [ownerAddr, AUTHORITY_GATEWAY_ADDRESS]);
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: operativeAddr, data: isApprovedData }, 'latest']
      }).then(function (result) {
        var approved = result !== '0x' + '0'.repeat(64);
        var transactions = [];

        if (!approved) {
          var approveData = opIface.encodeFunctionData('setApprovalForAll', [AUTHORITY_GATEWAY_ADDRESS, true]);
          transactions.push({ to: operativeAddr, data: approveData, value: '0x0' });
        }

        var sellData = agIface.encodeFunctionData('sellAccess', [
          ledgerAddr,
          ethers.getBigInt(tokenId),
          ethers.getBigInt(quantity),
          ethers.getBigInt(priceWei),
          payToken
        ]);
        transactions.push({ to: AUTHORITY_GATEWAY_ADDRESS, data: sellData, value: '0x0' });

        if (hasSmartAccount() && !useEOA) {
          var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
          return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, []);
        }

        var chain = transactions.reduce(function (p, tx) {
          return p.then(function () {
            return parentSendTransaction(tx).then(function (hash) {
              return waitForReceipt(hash);
            });
          });
        }, Promise.resolve());
        return chain;
      });
    });
  }

  function cancelAccessListing(operativeAddr, tokenId, quantity, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    // See buyAccessWithEOA for rationale on these diagnostic logs.
    console.log('[Wallet cancelAccessListing] inputs:', {
      operativeAddr: operativeAddr,
      tokenId: String(tokenId),
      quantity: String(quantity),
      fromWallet: fromWallet,
      connectedAddress: connectedAddress,
      currentChainId: currentChainId
    });

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var iface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
      var data = iface.encodeFunctionData('withdrawListing', [
        operativeAddr,
        ethers.getBigInt(tokenId),
        ethers.getBigInt(quantity)
      ]);
      var tx = { to: AUTHORITY_GATEWAY_ADDRESS, data: data, value: '0x0' };
      console.log('[Wallet cancelAccessListing] tx envelope:', tx, 'useSA:', useSA);

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        return parentExecuteSmartAccountBatch(chainIdDecimal, [tx], []);
      }
      return parentSendTransaction(tx);
    });
  }

  function getAccessSellers(operativeAddr, tokenId) {
    if (!operativeAddr) return Promise.resolve([]);
    var cacheKey = 'sellers:' + operativeAddr.toLowerCase() + ':' + String(tokenId);
    var cached = _cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    var iface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
    var data = iface.encodeFunctionData('sellersOf', [operativeAddr, ethers.getBigInt(tokenId)]);
    return _withRateLimitRetry(function () {
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: AUTHORITY_GATEWAY_ADDRESS, data: data }, 'latest']
      });
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address[]'], result);
      return _cacheSet(cacheKey, decoded[0] || []);
    }).catch(function () { return []; });
  }

  function getAccessListing(operativeAddr, tokenId, sellerAddr) {
    if (!operativeAddr || !sellerAddr) return Promise.resolve(null);
    var cacheKey = 'listing:' + operativeAddr.toLowerCase() + ':' + String(tokenId) + ':' + sellerAddr.toLowerCase();
    var cached = _cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    var iface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
    var data = iface.encodeFunctionData('listings', [operativeAddr, ethers.getBigInt(tokenId), sellerAddr]);
    return _withRateLimitRetry(function () {
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: AUTHORITY_GATEWAY_ADDRESS, data: data }, 'latest']
      });
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'address'], result);
      return _cacheSet(cacheKey, {
        quantity: Number(decoded[0]),
        pricePerToken: decoded[1].toString(),
        payToken: decoded[2]
      });
    }).catch(function () { return null; });
  }

  // ── Royalty Share Operations (TradeGateway) ────────

  function listRoyaltyShares(operativeAddr, quantity, priceWei, payToken, useWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var opIface = new ethers.Interface(OPERATIVE_ABI);
      var tgIface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var useEOA = (useWallet === 'eoa');
      var useSA = !useEOA && hasSmartAccount();
      var ownerAddr = useSA ? smartAccountAddress : connectedAddress;

      var isApprovedData = opIface.encodeFunctionData('isApprovedForAll', [ownerAddr, TRADE_GATEWAY_ADDRESS]);
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: operativeAddr, data: isApprovedData }, 'latest']
      }).then(function (result) {
        var approved = result !== '0x' + '0'.repeat(64);
        var transactions = [];

        if (!approved) {
          var approveData = opIface.encodeFunctionData('setApprovalForAll', [TRADE_GATEWAY_ADDRESS, true]);
          transactions.push({ to: operativeAddr, data: approveData, value: '0x0' });
        }

        var sellData = tgIface.encodeFunctionData('sellToken', [
          operativeAddr,
          ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE),
          ethers.getBigInt(quantity),
          ethers.getBigInt(priceWei),
          payToken
        ]);
        transactions.push({ to: TRADE_GATEWAY_ADDRESS, data: sellData, value: '0x0' });

        if (useSA) {
          var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
          return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, []);
        }

        var chain = transactions.reduce(function (p, tx) {
          return p.then(function () {
            return parentSendTransaction(tx).then(function (hash) {
              return waitForReceipt(hash);
            });
          });
        }, Promise.resolve());
        return chain;
      });
    });
  }

  function buyRoyaltyShares(sellerAddr, operativeAddr, quantity, totalPriceWei, payToken) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var tgIface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var isNative = !payToken || payToken === ZERO_ADDRESS;
      var buyData = tgIface.encodeFunctionData('buyToken', [
        sellerAddr, operativeAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), ethers.getBigInt(quantity)
      ]);
      var buyTx = {
        to: TRADE_GATEWAY_ADDRESS,
        data: buyData,
        value: isNative ? ethers.toQuantity(ethers.getBigInt(totalPriceWei)) : '0x0'
      };

      if (hasSmartAccount() && !isNative) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        var saAddr = (smartAccountAddress || '').toLowerCase();
        var erc20Iface = new ethers.Interface(ERC20_ABI);
        var allowanceData = erc20Iface.encodeFunctionData('allowance', [saAddr, TRADE_GATEWAY_ADDRESS]);
        return getProvider().request({
          method: 'eth_call',
          params: [{ to: payToken, data: allowanceData }, 'latest']
        }).then(function (result) {
          var current = ethers.getBigInt(result);
          var needed = ethers.getBigInt(totalPriceWei);
          var transactions = [];
          if (current < needed) {
            var approveData = erc20Iface.encodeFunctionData('approve', [TRADE_GATEWAY_ADDRESS, ethers.MaxUint256]);
            transactions.push({ to: payToken, data: approveData, value: '0x0' });
          }
          transactions.push(buyTx);
          var priceNum = Number(ethers.getBigInt(totalPriceWei));
          var usdcAmount = (priceNum / 1e6).toString();
          return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, [{ type: 'usdc', amount: usdcAmount }]);
        });
      }

      if (!isNative) {
        return approveIfNeeded(payToken, totalPriceWei, TRADE_GATEWAY_ADDRESS, connectedAddress)
          .then(function () { return parentSendTransaction(buyTx); });
      }
      return parentSendTransaction(buyTx);
    });
  }

  function cancelRoyaltyListing(operativeAddr, quantity, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var iface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var data = iface.encodeFunctionData('withdrawListing', [
        operativeAddr,
        ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE),
        ethers.getBigInt(quantity)
      ]);
      var tx = { to: TRADE_GATEWAY_ADDRESS, data: data, value: '0x0' };

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        return parentExecuteSmartAccountBatch(chainIdDecimal, [tx], []);
      }
      return parentSendTransaction(tx);
    });
  }

  function transferRoyaltyShares(operativeAddr, recipientAddr, amount, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');
    if (!ethers.isAddress(recipientAddr)) throw new Error('Invalid recipient address');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var fromAddr = useSA ? smartAccountAddress : connectedAddress;
      var iface = new ethers.Interface(OPERATIVE_ABI);
      var data = iface.encodeFunctionData('safeTransferFrom', [
        fromAddr, recipientAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), ethers.getBigInt(amount), '0x'
      ]);
      var tx = { to: operativeAddr, data: data, value: '0x0' };

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        return parentExecuteSmartAccountBatch(chainIdDecimal, [tx], []);
      }
      return parentSendTransaction(tx);
    });
  }

  function withdrawRewards(operativeAddr, payToken, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var iface = new ethers.Interface(OPERATIVE_ABI);
      var data = iface.encodeFunctionData('withdrawRewards', [payToken]);
      var tx = { to: operativeAddr, data: data, value: '0x0' };

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        return parentExecuteSmartAccountBatch(chainIdDecimal, [tx], []);
      }
      return parentSendTransaction(tx);
    });
  }

  function batchWithdrawRewards(operativeAddr, payTokens, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');
    if (!payTokens || payTokens.length === 0) throw new Error('No payment tokens');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var iface = new ethers.Interface(OPERATIVE_ABI);
      var encodedCalls = payTokens.map(function (pt) {
        return iface.encodeFunctionData('withdrawRewards', [pt]);
      });
      var data = iface.encodeFunctionData('multicall', [encodedCalls]);
      var tx = { to: operativeAddr, data: data, value: '0x0' };

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        return parentExecuteSmartAccountBatch(chainIdDecimal, [tx], []);
      }
      return parentSendTransaction(tx);
    });
  }

  function getRoyaltySellers(operativeAddr) {
    if (!operativeAddr) return Promise.resolve([]);
    var iface = new ethers.Interface(TRADE_GATEWAY_ABI);
    var data = iface.encodeFunctionData('sellersOf', [operativeAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE)]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: TRADE_GATEWAY_ADDRESS, data: data }, 'latest']
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address[]'], result);
      return decoded[0] || [];
    }).catch(function () { return []; });
  }

  function getRoyaltyListing(operativeAddr, sellerAddr) {
    if (!operativeAddr || !sellerAddr) return Promise.resolve(null);
    var iface = new ethers.Interface(TRADE_GATEWAY_ABI);
    var data = iface.encodeFunctionData('listings', [operativeAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), sellerAddr]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: TRADE_GATEWAY_ADDRESS, data: data }, 'latest']
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'address'], result);
      return {
        quantity: Number(decoded[0]),
        pricePerToken: decoded[1].toString(),
        payToken: decoded[2]
      };
    }).catch(function () { return null; });
  }

  // ── Royalty Share Offers (TradeGateway) ─────────────

  function createRoyaltyOffer(operativeAddr, quantity, pricePerToken, payToken, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');
    payToken = payToken || USDC_ADDRESS;
    var useSA = fromWallet ? fromWallet === 'sa' : hasSmartAccount();

    return ensureBase().then(function () {
      var totalCost = BigInt(quantity) * BigInt(pricePerToken);
      var tgIface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var offerData = tgIface.encodeFunctionData('createOffer', [
        operativeAddr,
        ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE),
        ethers.getBigInt(quantity),
        ethers.getBigInt(pricePerToken),
        payToken
      ]);
      var offerTx = { to: TRADE_GATEWAY_ADDRESS, data: offerData, value: '0x0' };

      if (useSA && hasSmartAccount()) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        var saAddr = (smartAccountAddress || '').toLowerCase();
        var erc20Iface = new ethers.Interface(ERC20_ABI);
        var allowanceData = erc20Iface.encodeFunctionData('allowance', [saAddr, TRADE_GATEWAY_ADDRESS]);
        return getProvider().request({
          method: 'eth_call',
          params: [{ to: payToken, data: allowanceData }, 'latest']
        }).then(function (result) {
          var current = BigInt(result);
          var transactions = [];
          if (current < totalCost) {
            var approveData = erc20Iface.encodeFunctionData('approve', [TRADE_GATEWAY_ADDRESS, ethers.MaxUint256]);
            transactions.push({ to: payToken, data: approveData, value: '0x0' });
          }
          transactions.push(offerTx);
          var usdcAmount = (Number(totalCost) / 1e6).toString();
          return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, [{ type: 'usdc', amount: usdcAmount }])
            .then(function (result) {
              var hash = result.transactionHash;
              var isOnChainHash = hash && hash.length === 66 && hash.startsWith('0x');
              if (!isOnChainHash) {
                console.warn('[Wallet createRoyaltyOffer] UA submitted but no confirmed on-chain hash. ID:', result.transactionId);
              }
              return {
                transactionHash: hash || result.transactionId,
                transactionId: result.transactionId,
                _uaPending: !isOnChainHash
              };
            });
        });
      }

      var erc20Iface = new ethers.Interface(ERC20_ABI);
      var allowanceData = erc20Iface.encodeFunctionData('allowance', [connectedAddress, TRADE_GATEWAY_ADDRESS]);

      return getProvider().request({
        method: 'eth_call',
        params: [{ to: payToken, data: allowanceData }, 'latest']
      }).then(function (result) {
        var current = BigInt(result);
        if (current < totalCost) {
          var approveData = erc20Iface.encodeFunctionData('approve', [TRADE_GATEWAY_ADDRESS, totalCost.toString()]);
          return parentSendTransaction({ to: payToken, data: approveData, value: '0x0' })
            .then(function (txHash) { return waitForReceipt(txHash); })
            .then(function () { return waitForAllowance(payToken, connectedAddress, TRADE_GATEWAY_ADDRESS, totalCost); });
        }
      }).then(function () {
        return parentSendTransaction(offerTx);
      });
    });
  }

  function acceptRoyaltyOffer(fromAddr, operativeAddr, quantity, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var ownerAddr = useSA ? smartAccountAddress : connectedAddress;
      var opIface = new ethers.Interface(OPERATIVE_ABI);
      var tgIface = new ethers.Interface(TRADE_GATEWAY_ABI);

      var approvedData = opIface.encodeFunctionData('isApprovedForAll', [ownerAddr, TRADE_GATEWAY_ADDRESS]);

      return getProvider().request({
        method: 'eth_call',
        params: [{ to: operativeAddr, data: approvedData }, 'latest']
      }).then(function (result) {
        var isApproved = result !== '0x' + '0'.repeat(64);
        var acceptData = tgIface.encodeFunctionData('acceptOffer', [
          fromAddr, operativeAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), ethers.getBigInt(quantity)
        ]);

        if (useSA) {
          var transactions = [];
          if (!isApproved) {
            var approveData = opIface.encodeFunctionData('setApprovalForAll', [TRADE_GATEWAY_ADDRESS, true]);
            transactions.push({ to: operativeAddr, data: approveData, value: '0x0' });
          }
          transactions.push({ to: TRADE_GATEWAY_ADDRESS, data: acceptData, value: '0x0' });
          var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
          return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, []);
        }

        if (!isApproved) {
          var setApprovalData = opIface.encodeFunctionData('setApprovalForAll', [TRADE_GATEWAY_ADDRESS, true]);
          return parentSendTransaction({ to: operativeAddr, data: setApprovalData, value: '0x0' })
            .then(function (txHash) { return waitForReceipt(txHash); })
            .then(function () {
              return parentSendTransaction({ to: TRADE_GATEWAY_ADDRESS, data: acceptData, value: '0x0' });
            });
        }
        return parentSendTransaction({ to: TRADE_GATEWAY_ADDRESS, data: acceptData, value: '0x0' });
      });
    });
  }

  function cancelRoyaltyOffer(operativeAddr, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var tgIface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var data = tgIface.encodeFunctionData('cancelOffer', [
        operativeAddr,
        ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE)
      ]);
      var tx = { to: TRADE_GATEWAY_ADDRESS, data: data, value: '0x0' };

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        return parentExecuteSmartAccountBatch(chainIdDecimal, [tx], []);
      }
      return parentSendTransaction(tx);
    });
  }

  // ── Offer & Trade Access Queries ──────────────────

  var _cachedCstoreAddr = null;

  function _getCstoreAddress() {
    if (_cachedCstoreAddr) return Promise.resolve(_cachedCstoreAddr);
    var iface = new ethers.Interface(TRADE_GATEWAY_ABI);
    var data = iface.encodeFunctionData('cstore', []);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: TRADE_GATEWAY_ADDRESS, data: data }, 'latest']
    }).then(function (result) {
      _cachedCstoreAddr = ethers.AbiCoder.defaultAbiCoder().decode(['address'], result)[0];
      return _cachedCstoreAddr;
    });
  }

  function getActiveOffer(operativeAddr, accountAddr) {
    if (!operativeAddr || !accountAddr) return Promise.resolve(null);
    return _getCstoreAddress().then(function (storageAddr) {
      var iface = new ethers.Interface(STORAGE_ABI);
      var data = iface.encodeFunctionData('offers', [operativeAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), accountAddr]);
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: storageAddr, data: data }, 'latest']
      }).then(function (result) {
        var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'address'], result);
        var qty = decoded[0];
        if (qty === 0n) return null;
        return { quantity: qty.toString(), pricePerToken: decoded[1].toString(), payToken: decoded[2] };
      });
    }).catch(function () { return null; });
  }

  function checkTradeAccess(operativeAddr, accountAddr) {
    if (!operativeAddr || !accountAddr) return Promise.resolve(false);
    var iface = new ethers.Interface(TRADE_ACCESS_ABI);
    var data = iface.encodeFunctionData('hasTradeAccess', [accountAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE)]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bool'], result);
      return decoded[0];
    }).catch(function () { return false; });
  }

  // ── Distribution Token Balance ────────────────────

  function getDistributionBalance(operativeAddr, ownerAddr) {
    if (!operativeAddr || !ownerAddr) return Promise.resolve('0');
    var iface = new ethers.Interface(OPERATIVE_ABI);
    var data = iface.encodeFunctionData('balanceOf', [ownerAddr, ethers.getBigInt(TOKEN_ID_DISTRIBUTION)]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: operativeAddr, data: data }, 'latest']
    }).then(function (result) {
      return ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], result)[0].toString();
    }).catch(function () { return '0'; });
  }

  // ── NFT Transfer (channel-level ERC721 only) ──────

  function transferNFT(nftAddress, tokenId, recipientAddress, isERC1155, amount) {
    if (!connectedAddress) throw new Error('Wallet not connected');
    if (!ethers.isAddress(recipientAddress)) throw new Error('Invalid recipient address');

    return ensureBase().then(function () {
      var fromAddr = connectedAddress;
      var data;

      if (isERC1155) {
        var iface = new ethers.Interface(ERC1155_ABI);
        data = iface.encodeFunctionData('safeTransferFrom', [
          fromAddr, recipientAddress, ethers.getBigInt(tokenId), ethers.getBigInt(amount || 1), '0x'
        ]);
      } else {
        var iface721 = new ethers.Interface(ERC721_ABI);
        data = iface721.encodeFunctionData('safeTransferFrom', [
          fromAddr, recipientAddress, ethers.getBigInt(tokenId)
        ]);
      }

      return parentSendTransaction({ to: nftAddress, data: data, value: '0x0' });
    });
  }

  // ── On-Chain Subscription Plan Management ──────────

  var DURATION_SECONDS = {
    days: 86400,
    weeks: 604800,
    months: 2592000,
    years: 31104000
  };

  function convertDurationToSeconds(durValue, durUnit) {
    var base = DURATION_SECONDS[durUnit] || DURATION_SECONDS.months;
    return durValue * base;
  }

  function getPlans(channelAddr) {
    var iface = new ethers.Interface(SUBSCRIPTION_MODULE_ABI);
    var data = iface.encodeFunctionData('getPlans', []);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: channelAddr, data: data }, 'latest']
    }).then(function (result) {
      var decoded = iface.decodeFunctionResult('getPlans', result)[0];
      return decoded.map(function (p) {
        var payToken = p.payToken;
        var isUSDC = payToken.toLowerCase() === USDC_ADDRESS.toLowerCase();
        var decimals = isUSDC ? 6 : 18;
        var priceHuman = Number(ethers.formatUnits(p.price, decimals));
        var durationSecs = Number(p.duration);
        var dur = secondsToDuration(durationSecs);
        return {
          planId: Number(p.planId),
          payToken: payToken,
          price: priceHuman,
          priceWei: p.price.toString(),
          duration: dur,
          durationSeconds: durationSecs,
          active: p.active
        };
      });
    }).catch(function (err) {
      console.warn('[Wallet] getPlans failed:', err.message);
      return [];
    });
  }

  function secondsToDuration(secs) {
    if (secs >= 31104000) return { value: Math.round(secs / 31104000), unit: 'years' };
    if (secs >= 2592000) return { value: Math.round(secs / 2592000), unit: 'months' };
    if (secs >= 604800) return { value: Math.round(secs / 604800), unit: 'weeks' };
    return { value: Math.round(secs / 86400), unit: 'days' };
  }

  function introspectToken(tokenAddr) {
    if (!tokenAddr || !ethers.isAddress(tokenAddr)) {
      return Promise.resolve({ valid: false });
    }
    var iface = new ethers.Interface(TOKEN_INTROSPECT_ABI);

    var nameCall = getProvider().request({
      method: 'eth_call',
      params: [{ to: tokenAddr, data: iface.encodeFunctionData('name', []) }, 'latest']
    }).then(function (r) {
      return iface.decodeFunctionResult('name', r)[0];
    }).catch(function () { return null; });

    var symbolCall = getProvider().request({
      method: 'eth_call',
      params: [{ to: tokenAddr, data: iface.encodeFunctionData('symbol', []) }, 'latest']
    }).then(function (r) {
      return iface.decodeFunctionResult('symbol', r)[0];
    }).catch(function () { return null; });

    var decimalsCall = getProvider().request({
      method: 'eth_call',
      params: [{ to: tokenAddr, data: iface.encodeFunctionData('decimals', []) }, 'latest']
    }).then(function (r) {
      return Number(iface.decodeFunctionResult('decimals', r)[0]);
    }).catch(function () { return -1; });

    var ERC721_INTERFACE_ID = '0x80ac58cd';
    var erc721Call = getProvider().request({
      method: 'eth_call',
      params: [{ to: tokenAddr, data: iface.encodeFunctionData('supportsInterface', [ERC721_INTERFACE_ID]) }, 'latest']
    }).then(function (r) {
      return iface.decodeFunctionResult('supportsInterface', r)[0];
    }).catch(function () { return false; });

    return Promise.all([nameCall, symbolCall, decimalsCall, erc721Call])
      .then(function (results) {
        var name = results[0];
        var symbol = results[1];
        var decimals = results[2];
        var isERC721 = results[3];

        if (!name && !symbol) return { valid: false };

        return {
          valid: true,
          name: name,
          symbol: symbol,
          isERC721: isERC721,
          isERC20: !isERC721 && decimals >= 0,
          decimals: isERC721 ? 0 : (decimals >= 0 ? decimals : 18)
        };
      });
  }

  function getTokenDecimals(payToken) {
    if (!payToken || payToken === ZERO_ADDRESS) return Promise.resolve(18);
    if (payToken.toLowerCase() === USDC_ADDRESS.toLowerCase()) return Promise.resolve(6);
    var iface = new ethers.Interface(TOKEN_INTROSPECT_ABI);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: payToken, data: iface.encodeFunctionData('decimals', []) }, 'latest']
    }).then(function (r) {
      return Number(iface.decodeFunctionResult('decimals', r)[0]);
    }).catch(function () { return 18; });
  }

  function getERC20Balance(tokenAddress, ownerAddress) {
    if (!tokenAddress || !ownerAddress) return Promise.resolve('0');
    var iface = new ethers.Interface(ERC20_ABI);
    var data = iface.encodeFunctionData('balanceOf', [ownerAddress]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: tokenAddress, data: data }, 'latest']
    }).then(function (result) {
      return ethers.getBigInt(result).toString();
    }).catch(function () { return '0'; });
  }

  function getNativeBalance(ownerAddress) {
    if (!ownerAddress) return Promise.resolve('0');
    return getProvider().request({
      method: 'eth_getBalance',
      params: [ownerAddress, 'latest']
    }).then(function (result) {
      return ethers.getBigInt(result).toString();
    }).catch(function () { return '0'; });
  }

  // ── Channel Subscription ──────────────────────────────

  function subscribeChannel(channelAddr, planId, payToken, priceWei, fromWallet) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var useSA = (fromWallet === 'sa') && hasSmartAccount();
      var isNative = !payToken || payToken === ZERO_ADDRESS;
      var subIface = new ethers.Interface(SUBSCRIPTION_MODULE_ABI);
      var subData = subIface.encodeFunctionData('subscribePlan', [planId, false]);
      var subTx = {
        to: channelAddr,
        data: subData,
        value: isNative ? ('0x' + ethers.getBigInt(priceWei).toString(16)) : '0x0'
      };

      if (useSA) {
        var chainIdDecimal = currentChainId ? parseInt(currentChainId, 16) : 8453;
        if (isNative) {
          return parentExecuteSmartAccountBatch(chainIdDecimal, [subTx], []);
        }
        var saAddr = smartAccountAddress;
        var erc20Iface = new ethers.Interface(ERC20_ABI);

        return subIface.encodeFunctionData('paymentProcessor', [])
          ? getProvider().request({
              method: 'eth_call',
              params: [{ to: channelAddr, data: subIface.encodeFunctionData('paymentProcessor', []) }, 'latest']
            }).then(function (r) {
              var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address'], r);
              return decoded[0] || channelAddr;
            }).catch(function () { return channelAddr; })
          : Promise.resolve(channelAddr)
        .then(function (operator) {
          var allowanceData = erc20Iface.encodeFunctionData('allowance', [saAddr, operator]);
          return getProvider().request({
            method: 'eth_call',
            params: [{ to: payToken, data: allowanceData }, 'latest']
          }).then(function (result) {
            var current = ethers.getBigInt(result);
            var needed = ethers.getBigInt(priceWei);
            var transactions = [];
            if (current < needed) {
              var approveData = erc20Iface.encodeFunctionData('approve', [operator, ethers.MaxUint256]);
              transactions.push({ to: payToken, data: approveData, value: '0x0' });
            }
            transactions.push(subTx);
            var priceNum = Number(ethers.getBigInt(priceWei));
            var isUSDC = payToken.toLowerCase() === USDC_ADDRESS.toLowerCase();
            var expectTokens = isUSDC ? [{ type: 'usdc', amount: (priceNum / 1e6).toString() }] : [];
            return parentExecuteSmartAccountBatch(chainIdDecimal, transactions, expectTokens);
          });
        });
      }

      // EOA path
      if (isNative) {
        return parentSendTransaction(subTx).then(function (hash) {
          return waitForReceipt(hash);
        });
      }

      var ppIface = new ethers.Interface(SUBSCRIPTION_MODULE_ABI);
      var ppData = ppIface.encodeFunctionData('paymentProcessor', []);
      return getProvider().request({
        method: 'eth_call',
        params: [{ to: channelAddr, data: ppData }, 'latest']
      }).then(function (r) {
        var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address'], r);
        return decoded[0] || channelAddr;
      }).catch(function () { return channelAddr; })
      .then(function (operator) {
        return approveIfNeeded(payToken, priceWei, operator, connectedAddress);
      }).then(function () {
        return parentSendTransaction(subTx).then(function (hash) {
          return waitForReceipt(hash);
        });
      });
    });
  }

  // V3 contracts do not implement bulkUpdatePlans, configureTokenOwnershipAccess
  // on-chain. Plan/token-gate management is handled via local catalog API.

  function bulkUpdatePlans() {
    return Promise.reject(new Error('bulkUpdatePlans is not available in V3 contracts. Use local catalog API.'));
  }

  function configureTokenAccess() {
    return Promise.reject(new Error('configureTokenOwnershipAccess is not available in V3 contracts. Use local catalog API.'));
  }

  function checkSubscription(channelAddr, subscriberAddr) {
    // V3 hasActiveSubscription exists but requires subscriptionManager to be set.
    // For now we return false since the subscription manager isn't deployed yet.
    return Promise.resolve(false);
  }

  return {
    connect: connect,
    getAddress: getAddress,
    getSignerAddress: getSignerAddress,
    getSmartAccountAddress: getSmartAccountAddress,
    hasSmartAccount: hasSmartAccount,
    isConnected: isConnected,
    getChainId: getChainId,
    isOnBase: isOnBase,
    switchToBase: switchToBase,
    siweLogin: siweLogin,
    signMessage: signMessage,
    buyAccess: buyAccess,
    buyAccessWithEOA: buyAccessWithEOA,
    waitForReceipt: waitForReceipt,
    setupListeners: setupListeners,
    getOperativeOpType: getOperativeOpType,
    getOperativeResellerCut: getOperativeResellerCut,
    getAccessTokenBalance: getAccessTokenBalance,
    getRoyaltyShareBalance: getRoyaltyShareBalance,
    getPendingRewards: getPendingRewards,
    checkTradeAccess: checkTradeAccess,
    resellAccessToken: resellAccessToken,
    cancelAccessListing: cancelAccessListing,
    getAccessSellers: getAccessSellers,
    getAccessListing: getAccessListing,
    listRoyaltyShares: listRoyaltyShares,
    buyRoyaltyShares: buyRoyaltyShares,
    cancelRoyaltyListing: cancelRoyaltyListing,
    transferRoyaltyShares: transferRoyaltyShares,
    withdrawRewards: withdrawRewards,
    batchWithdrawRewards: batchWithdrawRewards,
    getRoyaltySellers: getRoyaltySellers,
    getRoyaltyListing: getRoyaltyListing,
    createRoyaltyOffer: createRoyaltyOffer,
    acceptRoyaltyOffer: acceptRoyaltyOffer,
    cancelRoyaltyOffer: cancelRoyaltyOffer,
    getActiveOffer: getActiveOffer,
    checkTradeAccess: checkTradeAccess,
    getDistributionBalance: getDistributionBalance,
    transferNFT: transferNFT,
    getPlans: getPlans,
    bulkUpdatePlans: bulkUpdatePlans,
    configureTokenAccess: configureTokenAccess,
    subscribeChannel: subscribeChannel,
    checkSubscription: checkSubscription,
    getERC20Balance: getERC20Balance,
    getNativeBalance: getNativeBalance,
    getTokenDecimals: getTokenDecimals,
    introspectToken: introspectToken,
    BASE_CHAIN_ID: BASE_CHAIN_ID,
    AUTHORITY_GATEWAY_ADDRESS: AUTHORITY_GATEWAY_ADDRESS,
    TRADE_GATEWAY_ADDRESS: TRADE_GATEWAY_ADDRESS,
    USDC_ADDRESS: USDC_ADDRESS,
    TOKEN_ID_ACCESS: TOKEN_ID_ACCESS,
    TOKEN_ID_ROYALTY_SHARE: TOKEN_ID_ROYALTY_SHARE,
    TOKEN_ID_DISTRIBUTION: TOKEN_ID_DISTRIBUTION,
    getProvider: getProvider
  };
})();
