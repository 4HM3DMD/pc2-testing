/**
 * PC2 Wallet Provider — EIP-1193 compatible bridge
 *
 * Supports three transport modes:
 *   1. postMessage to parent (iframe apps)
 *   2. postMessage to opener (popup windows)
 *   3. BroadcastChannel (popup with COOP that severs opener — e.g. player)
 */
(function () {
  'use strict';

  if (window.__pc2WalletProviderInstalled) return;

  var hostWindow = null;
  var broadcastChannel = null;

  if (window.parent && window.parent !== window) {
    hostWindow = window.parent;
  } else if (window.opener) {
    hostWindow = window.opener;
  } else if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel('pc2-wallet-bridge');
  }

  if (!hostWindow && !broadcastChannel) return;

  window.__pc2WalletProviderInstalled = true;

  var RESPONSE_TIMEOUT_MS = 120000;
  var pending = new Map();
  var requestCounter = 0;
  var connectedAccounts = [];
  var currentChainId = null;
  var smartAccountAddress = null;

  function generateId() {
    return 'pc2-rpc-' + Date.now() + '-' + (++requestCounter);
  }

  function sendMessage(msg) {
    if (hostWindow) {
      hostWindow.postMessage(msg, '*');
    } else if (broadcastChannel) {
      broadcastChannel.postMessage(msg);
    }
  }

  function handleIncoming(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'pc2-wallet-rpc-response' && data.id) {
      var entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(data.id);

      if (data.error) {
        var err = new Error(data.error.message || data.error);
        if (data.error.code) err.code = data.error.code;
        entry.reject(err);
      } else {
        entry.resolve(data.result);
      }

      if (data.method === 'eth_requestAccounts' || data.method === 'eth_accounts') {
        if (Array.isArray(data.result)) connectedAccounts = data.result;
      }
      if (data.method === 'eth_chainId') currentChainId = data.result;
      // chainChanged event from bridge handles chain updates;
      // no need to re-query eth_chainId here
    }

    if (data.type === 'pc2-wallet-event') {
      provider.emit(data.event, data.data);
      if (data.event === 'accountsChanged' && Array.isArray(data.data)) connectedAccounts = data.data;
      if (data.event === 'chainChanged') currentChainId = data.data;
    }

    if (data.type === 'pc2-wallet-init') {
      if (data.accounts) connectedAccounts = data.accounts;
      if (data.chainId) currentChainId = data.chainId;
      if (data.smartAccountAddress) smartAccountAddress = data.smartAccountAddress;
      provider.emit('connect', { chainId: currentChainId });
      if (connectedAccounts.length > 0) {
        provider.emit('accountsChanged', connectedAccounts);
      }
    }
  }

  class PC2WalletProvider {
    constructor() {
      this.isPC2WalletBridge = true;
      this.isMetaMask = true;
      this._events = {};
    }

    async request({ method, params }) {
      var id = generateId();
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error('PC2 Wallet Bridge: timeout waiting for ' + method));
        }, RESPONSE_TIMEOUT_MS);

        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        sendMessage({ type: 'pc2-wallet-rpc', id: id, method: method, params: params || [] });
      });
    }

    async enable() { return this.request({ method: 'eth_requestAccounts' }); }

    on(event, handler) {
      if (!this._events[event]) this._events[event] = [];
      this._events[event].push(handler);
      return this;
    }

    removeListener(event, handler) {
      var handlers = this._events[event];
      if (!handlers) return this;
      this._events[event] = handlers.filter(function (h) { return h !== handler; });
      return this;
    }

    removeAllListeners(event) {
      if (event) { delete this._events[event]; } else { this._events = {}; }
      return this;
    }

    emit(event) {
      var args = Array.prototype.slice.call(arguments, 1);
      var handlers = this._events[event];
      if (!handlers) return;
      for (var i = 0; i < handlers.length; i++) {
        try { handlers[i].apply(null, args); }
        catch (e) { console.error('[PC2 Wallet] Event handler error (' + event + '):', e); }
      }
    }

    get selectedAddress() { return connectedAccounts[0] || null; }
    get chainId() { return currentChainId; }
    get smartAccountAddress() { return smartAccountAddress; }
    isConnected() { return connectedAccounts.length > 0; }

    async send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') {
        return this.request({ method: methodOrPayload, params: paramsOrCallback });
      }
      return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
    }

    async sendAsync(payload, callback) {
      try {
        var result = await this.request({ method: payload.method, params: payload.params });
        callback(null, { id: payload.id, jsonrpc: '2.0', result: result });
      } catch (error) { callback(error); }
    }
  }

  var provider = new PC2WalletProvider();

  // Listen for responses via postMessage
  window.addEventListener('message', function (event) {
    handleIncoming(event.data);
  });

  // Listen for responses via BroadcastChannel
  if (broadcastChannel) {
    broadcastChannel.onmessage = function (event) {
      handleIncoming(event.data);
    };
  }

  try {
    Object.defineProperty(window, 'ethereum', {
      value: provider, writable: false, configurable: true, enumerable: true
    });
  } catch (e) {
    try { delete window.ethereum; } catch (_) {}
    window.ethereum = provider;
  }

  window.pc2Wallet = provider;

  // Suppress ethers.js v5 NETWORK_ERROR during chain transitions.
  // These are non-fatal "underlying network changed" errors from background
  // polling that happen naturally when chains switch (same as on real MetaMask).
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    if (reason && reason.code === 'NETWORK_ERROR' &&
        reason.message && reason.message.indexOf('underlying network changed') >= 0) {
      event.preventDefault();
    }
  });

  setTimeout(function () {
    if (window.ethereum !== provider) {
      try {
        Object.defineProperty(window, 'ethereum', {
          value: provider, writable: false, configurable: true, enumerable: true
        });
      } catch (_) {}
    }
  }, 0);

  sendMessage({ type: 'pc2-wallet-ready' });
})();
