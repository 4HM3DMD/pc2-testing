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
  var smartAccountAddress = null;
  var currentChainId = null;
  var siwePromise = null;

  function getProvider() {
    if (!window.ethereum) throw new Error('No wallet provider available');
    return window.ethereum;
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
        return ElacityAPI.login(connectedAddress, signature, sa);
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
        return getProvider().request({
          method: 'eth_sendTransaction',
          params: [{ from: connectedAddress, to: authorityAddr, data: data, value: ethers.toQuantity(ethers.getBigInt(priceWei)) }]
        });
      }

      return getPaymentProcessor(operativeAddr)
        .then(function (approvalTarget) {
          return approveIfNeeded(payToken, priceWei, approvalTarget);
        })
        .then(function () {
          var data = iface.encodeFunctionData(
            'buyAccess(address,address,uint256,uint256,uint256,address)',
            [seller, ledger, ethers.getBigInt(tokenId), ethers.getBigInt(quantity), ethers.getBigInt(priceWei), payToken]
          );
          return getProvider().request({
            method: 'eth_sendTransaction',
            params: [{ from: connectedAddress, to: authorityAddr, data: data }]
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

    var allowanceData = iface.encodeFunctionData('allowance', [
      connectedAddress,
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

      return getProvider().request({
        method: 'eth_sendTransaction',
        params: [{
          from: connectedAddress,
          to: tokenAddress,
          data: approveData
        }]
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

  return {
    connect: connect,
    getAddress: getAddress,
    getSignerAddress: getSignerAddress,
    isConnected: isConnected,
    getChainId: getChainId,
    isOnBase: isOnBase,
    switchToBase: switchToBase,
    siweLogin: siweLogin,
    buyAccess: buyAccess,
    waitForReceipt: waitForReceipt,
    setupListeners: setupListeners,
    BASE_CHAIN_ID: BASE_CHAIN_ID
  };
})();
