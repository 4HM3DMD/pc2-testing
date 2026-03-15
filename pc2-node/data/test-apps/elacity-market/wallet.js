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
    'function paymentProcessor() view returns (address)'
  ];

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
    return getProvider().request({ method: 'eth_requestAccounts' })
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

  return {
    connect: connect,
    getAddress: getAddress,
    getSignerAddress: getSignerAddress,
    isConnected: isConnected,
    getChainId: getChainId,
    isOnBase: isOnBase,
    switchToBase: switchToBase,
    siweLogin: siweLogin,
    signMessage: signMessage,
    buyAccess: buyAccess,
    waitForReceipt: waitForReceipt,
    setupListeners: setupListeners,
    BASE_CHAIN_ID: BASE_CHAIN_ID
  };
})();
