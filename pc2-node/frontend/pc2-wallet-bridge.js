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

  // Read-only RPC methods that can go directly to chain RPC
  var DIRECT_RPC_METHODS = [
    'eth_estimateGas', 'eth_call', 'eth_getBalance', 'eth_getCode',
    'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_blockNumber',
    'eth_gasPrice', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
    'eth_getLogs', 'eth_getBlockByHash', 'net_version'
  ];

  // ESC RPC endpoints with fallback (local proxy first, then Elacity, then public)
  var ESC_RPC_URLS = [
    '/api/rpc/esc',
    'https://api.ela.city/esc',
    'https://api.elastos.io/eth',
    'https://rpc.glidefinance.io'
  ];

  // Current chain ID for the bridge (default: ESC = 20)
  var bridgeChainId = 20;

  function directRpc(method, params) {
    var body = JSON.stringify({
      jsonrpc: '2.0', method: method, params: params || [], id: Date.now()
    });

    var urlIndex = 0;

    function tryNext() {
      if (urlIndex >= ESC_RPC_URLS.length) {
        return Promise.reject(new Error('All ESC RPCs failed for ' + method));
      }
      var url = ESC_RPC_URLS[urlIndex++];
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        if (json.error) {
          var err = new Error(json.error.message || 'RPC error');
          err.code = json.error.code || -32603;
          err.data = json.error.data;
          throw err;
        }
        return json.result;
      }).catch(function (err) {
        // If this was an RPC-level error (has .code), don't try next — it's a real error
        if (err.code && err.code !== -32603) throw err;
        // Network error — try next endpoint
        if (urlIndex < ESC_RPC_URLS.length) return tryNext();
        throw err;
      });
    }

    return tryNext();
  }

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
    console.log('[PC2 Bridge] handleRpc:', data.method, '| embedded=' + isEmbeddedLogin());

    if (data.method === 'pc2_getSmartAccountAddress') {
      var sa = (window.user && window.user.smart_account_address) || null;
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method, result: sa
      });
      return;
    }

    // Fast paths that don't need Particle or RPC at all
    if (data.method === 'eth_accounts' || data.method === 'eth_requestAccounts') {
      var addr = (window.user && window.user.wallet_address) || '';
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method, result: addr ? [addr] : []
      });
      return;
    }

    if (data.method === 'eth_chainId') {
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method,
        result: '0x' + bridgeChainId.toString(16)
      });
      return;
    }

    if (data.method === 'wallet_switchEthereumChain') {
      var requested = data.params && data.params[0] && data.params[0].chainId;
      if (requested) {
        bridgeChainId = parseInt(requested, 16);
        console.log('[PC2 Bridge] Chain switched to', bridgeChainId);
      }
      respond({
        type: 'pc2-wallet-rpc-response',
        id: data.id, method: data.method, result: null
      });
      return;
    }

    // Read-only RPC: ALWAYS route directly to chain RPC.
    // These methods don't need signing, so there's no reason to send them
    // through MetaMask (which may be on a different chain) or Particle.
    if (DIRECT_RPC_METHODS.indexOf(data.method) >= 0) {
      console.log('[PC2 Bridge] Direct RPC:', data.method, '(chain=' + bridgeChainId + ', embedded=' + isEmbeddedLogin() + ')');
      directRpc(data.method, data.params)
        .then(function (result) {
          respond({
            type: 'pc2-wallet-rpc-response',
            id: data.id, method: data.method, result: result
          });
        })
        .catch(function (error) {
          console.warn('[PC2 Bridge] Direct RPC error:', data.method, error.message);
          respond({
            type: 'pc2-wallet-rpc-response',
            id: data.id, method: data.method,
            error: { code: error.code || -32603, message: error.message || String(error) }
          });
        });
      return;
    }

    // Signing and other methods: route to Particle via WalletService
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
        chainId: '0x' + bridgeChainId.toString(16),
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
