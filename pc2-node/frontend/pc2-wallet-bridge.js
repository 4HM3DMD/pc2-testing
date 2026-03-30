/**
 * PC2 Wallet Bridge — Parent-side handler
 *
 * Listens for wallet RPC requests from child apps via:
 *   1. postMessage (iframe apps)
 *   2. BroadcastChannel (popup windows with COOP that severs opener)
 *
 * Forwards requests to the real wallet provider (Particle Auth / window.ethereum).
 *
 * ⚠️  CRITICAL: This is the SOLE handler for pc2-wallet-rpc messages.
 *    IPC.js must NOT also handle these messages, or every wallet call
 *    (signatures, transactions, chain switches) will be sent to MetaMask
 *    TWICE, causing duplicate confirmation popups ("1 of 2").
 *    See IPC.js lines ~131-141 where these messages are explicitly ignored.
 */
(function () {
  'use strict';

  if (window.__pc2WalletBridgeInstalled) return;
  window.__pc2WalletBridgeInstalled = true;

  var bc = null;
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel('pc2-wallet-bridge');
  }

  var EXTERNAL_WALLET_METHODS = ['metamask', 'walletconnect', 'coinbase'];

  function isEmbeddedLogin() {
    var method = (window.user && window.user.login_method)
      || localStorage.getItem('pc2_login_method') || '';
    if (EXTERNAL_WALLET_METHODS.indexOf(method) >= 0) return false;
    return true;
  }

  function routeToParticle(data, respond) {
    if (typeof window.pc2RouteRpcToParticle === 'function') {
      window.pc2RouteRpcToParticle(data.method, data.params)
        .then(function (result) {
          respond({
            type: 'pc2-wallet-rpc-response',
            id: data.id, method: data.method, result: result
          });
        })
        .catch(function (error) {
          respond({
            type: 'pc2-wallet-rpc-response',
            id: data.id, method: data.method,
            error: { code: error.code || -32603, message: error.message || String(error) }
          });
        });
    } else {
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method,
        error: { code: 4900, message: 'Embedded wallet not ready' }
      });
    }
  }

  function handleRpc(data, respond) {
    if (data.method === 'pc2_getSmartAccountAddress') {
      var sa = (window.user && window.user.smart_account_address) || null;
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method, result: sa
      });
      return;
    }

    if (isEmbeddedLogin()) {
      routeToParticle(data, respond);
      return;
    }

    var provider = window.ethereum;
    if (!provider || provider.isPC2WalletBridge) {
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method,
        error: { code: 4900, message: 'No wallet provider available' }
      });
      return;
    }

    provider.request({ method: data.method, params: data.params })
      .then(function (result) {
        respond({
          type: 'pc2-wallet-rpc-response',
          id: data.id, method: data.method, result: result
        });
      })
      .catch(function (error) {
        respond({
          type: 'pc2-wallet-rpc-response',
          id: data.id, method: data.method,
          error: { code: error.code || -32603, message: error.message || String(error) }
        });
      });
  }

  function handleReady(respond) {
    var smartAccountAddress = (window.user && window.user.smart_account_address) || null;

    if (isEmbeddedLogin()) {
      var addr = (window.user && window.user.wallet_address) || '';
      respond({
        type: 'pc2-wallet-init',
        accounts: addr ? [addr] : [],
        chainId: null,
        smartAccountAddress: smartAccountAddress
      });
      return;
    }

    var provider = window.ethereum;
    if (!provider || provider.isPC2WalletBridge) return;

    var accounts = [];
    var chainId = null;

    provider.request({ method: 'eth_accounts' })
      .then(function (accts) { accounts = accts || []; return provider.request({ method: 'eth_chainId' }); })
      .then(function (chain) { chainId = chain; })
      .catch(function () {})
      .finally(function () {
        respond({
          type: 'pc2-wallet-init',
          accounts: accounts,
          chainId: chainId,
          smartAccountAddress: smartAccountAddress
        });
      });
  }

  // Handle postMessage from iframes
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    var source = event.source;
    var origin = event.origin === 'null' ? '*' : event.origin;

    function respondPostMessage(msg) {
      if (source) source.postMessage(msg, origin);
    }

    if (data.type === 'pc2-wallet-rpc' && data.id && data.method) {
      handleRpc(data, respondPostMessage);
    }
    if (data.type === 'pc2-wallet-ready') {
      handleReady(respondPostMessage);
    }
  });

  // Handle BroadcastChannel from popup windows
  if (bc) {
    bc.onmessage = function (event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;

      function respondBroadcast(msg) {
        bc.postMessage(msg);
      }

      if (data.type === 'pc2-wallet-rpc' && data.id && data.method) {
        handleRpc(data, respondBroadcast);
      }
      if (data.type === 'pc2-wallet-ready') {
        handleReady(respondBroadcast);
      }
    };
  }

  console.log('[PC2] Wallet bridge handler installed (parent-side, postMessage + BroadcastChannel)');
})();
