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
    'function listings(address operative, uint256 tokenId, address seller) view returns (uint256, uint256, address)'
  ];
  var ERC721_ABI = [
    'function safeTransferFrom(address from, address to, uint256 tokenId)'
  ];
  var ERC1155_ABI = [
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)'
  ];

  var AUTHORITY_GATEWAY_ADDRESS = '0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29';
  var TRADE_GATEWAY_ADDRESS = '0x9eC53758b698f9F68C0654DDd9159173a159a459';
  var TOKEN_ID_ACCESS = 1;
  var TOKEN_ID_ROYALTY_SHARE = 2;

  var connectedAddress = null;
  var smartAccountAddress = new URLSearchParams(window.location.search).get('puter.smart_account') || null;
  var currentChainId = null;
  var siwePromise = null;
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
        siwePromise = null;
        return ElacityAPI.login(connectedAddress, signature, sa).then(function (auth) {
          if (auth && auth.sa) smartAccountAddress = auth.sa;
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
            // Particle iframe already confirmed the tx on-chain, so return a
            // receipt-like object to skip redundant eth_getTransactionReceipt polling
            return {
              status: '0x1',
              transactionHash: result.transactionHash || result.transactionId,
              _smartAccountConfirmed: true
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

  function approveIfNeeded(tokenAddress, amountWei, spender) {
    var iface = new ethers.Interface(ERC20_ABI);
    var ownerAddr = smartAccountAddress || connectedAddress;

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
      });
    });
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

      return getPaymentProcessor(operativeAddr)
        .then(function (approvalTarget) {
          return approveIfNeeded(payToken, priceWei, approvalTarget);
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

  function cancelAccessListing(operativeAddr, tokenId, quantity) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var iface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
      var data = iface.encodeFunctionData('withdrawListing', [
        operativeAddr,
        ethers.getBigInt(tokenId),
        ethers.getBigInt(quantity)
      ]);
      return parentSendTransaction({ to: AUTHORITY_GATEWAY_ADDRESS, data: data, value: '0x0' });
    });
  }

  function getAccessSellers(operativeAddr, tokenId) {
    if (!operativeAddr) return Promise.resolve([]);
    var iface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
    var data = iface.encodeFunctionData('sellersOf', [operativeAddr, ethers.getBigInt(tokenId)]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: AUTHORITY_GATEWAY_ADDRESS, data: data }, 'latest']
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address[]'], result);
      return decoded[0] || [];
    }).catch(function () { return []; });
  }

  function getAccessListing(operativeAddr, tokenId, sellerAddr) {
    if (!operativeAddr || !sellerAddr) return Promise.resolve(null);
    var iface = new ethers.Interface(AUTHORITY_GATEWAY_ABI);
    var data = iface.encodeFunctionData('listings', [operativeAddr, ethers.getBigInt(tokenId), sellerAddr]);
    return getProvider().request({
      method: 'eth_call',
      params: [{ to: AUTHORITY_GATEWAY_ADDRESS, data: data }, 'latest']
    }).then(function (result) {
      var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'address'], result);
      return {
        quantity: Number(decoded[0]),
        pricePerToken: decoded[1].toString(),
        payToken: decoded[2]
      };
    }).catch(function () { return null; });
  }

  // ── Royalty Share Operations (TradeGateway) ────────

  function listRoyaltyShares(operativeAddr, quantity, priceWei, payToken) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var opIface = new ethers.Interface(OPERATIVE_ABI);
      var tgIface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var ownerAddr = smartAccountAddress || connectedAddress;

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

        if (hasSmartAccount()) {
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
      var data = tgIface.encodeFunctionData('buyToken', [
        sellerAddr, operativeAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), ethers.getBigInt(quantity)
      ]);
      var tx = {
        to: TRADE_GATEWAY_ADDRESS,
        data: data,
        value: isNative ? ethers.toQuantity(ethers.getBigInt(totalPriceWei)) : '0x0'
      };

      if (!isNative) {
        return approveIfNeeded(payToken, totalPriceWei, TRADE_GATEWAY_ADDRESS)
          .then(function () { return parentSendTransaction(tx); });
      }
      return parentSendTransaction(tx);
    });
  }

  function cancelRoyaltyListing(operativeAddr, quantity) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var iface = new ethers.Interface(TRADE_GATEWAY_ABI);
      var data = iface.encodeFunctionData('withdrawListing', [
        operativeAddr,
        ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE),
        ethers.getBigInt(quantity)
      ]);
      return parentSendTransaction({ to: TRADE_GATEWAY_ADDRESS, data: data, value: '0x0' });
    });
  }

  function transferRoyaltyShares(operativeAddr, recipientAddr, amount) {
    if (!connectedAddress) throw new Error('Wallet not connected');
    if (!ethers.isAddress(recipientAddr)) throw new Error('Invalid recipient address');

    return ensureBase().then(function () {
      var fromAddr = connectedAddress;
      var iface = new ethers.Interface(OPERATIVE_ABI);
      var data = iface.encodeFunctionData('safeTransferFrom', [
        fromAddr, recipientAddr, ethers.getBigInt(TOKEN_ID_ROYALTY_SHARE), ethers.getBigInt(amount), '0x'
      ]);
      return parentSendTransaction({ to: operativeAddr, data: data, value: '0x0' });
    });
  }

  function withdrawRewards(operativeAddr, payToken) {
    if (!connectedAddress) throw new Error('Wallet not connected');

    return ensureBase().then(function () {
      var iface = new ethers.Interface(OPERATIVE_ABI);
      var data = iface.encodeFunctionData('withdrawRewards', [payToken]);
      return parentSendTransaction({ to: operativeAddr, data: data, value: '0x0' });
    });
  }

  function batchWithdrawRewards(operativeAddr, payTokens) {
    if (!connectedAddress) throw new Error('Wallet not connected');
    if (!payTokens || payTokens.length === 0) throw new Error('No payment tokens');

    return ensureBase().then(function () {
      var iface = new ethers.Interface(OPERATIVE_ABI);
      var encodedCalls = payTokens.map(function (pt) {
        return iface.encodeFunctionData('withdrawRewards', [pt]);
      });
      var data = iface.encodeFunctionData('multicall', [encodedCalls]);
      return parentSendTransaction({ to: operativeAddr, data: data, value: '0x0' });
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
    transferNFT: transferNFT,
    BASE_CHAIN_ID: BASE_CHAIN_ID,
    AUTHORITY_GATEWAY_ADDRESS: AUTHORITY_GATEWAY_ADDRESS,
    TRADE_GATEWAY_ADDRESS: TRADE_GATEWAY_ADDRESS,
    TOKEN_ID_ACCESS: TOKEN_ID_ACCESS,
    TOKEN_ID_ROYALTY_SHARE: TOKEN_ID_ROYALTY_SHARE
  };
})();
