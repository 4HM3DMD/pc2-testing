/**
 * secure-view-session.js — Client half of Option C (session-key delegation).
 *
 * Consumed by ddrm-viewer/viewer.js and elacity-creator/app.js. Attached
 * as a classic script; exports a global `PC2SecureViewSession`.
 *
 * Responsibilities:
 *
 *   1. Generate an ephemeral ECDSA (P-256) keypair in Web Crypto with
 *      `extractable: false` so the private key cannot be read back out,
 *      even by JavaScript running in the same origin.
 *   2. Persist the `CryptoKey` object (not the raw bytes — we can't
 *      read them) in IndexedDB so the session survives page reloads.
 *   3. Build, canonicalize, and sign the two protocol messages:
 *        - `SecureViewDelegation` — one-time, user's wallet signs.
 *        - `SecureViewRequest`     — per open, ephemeral key signs.
 *   4. Expose a small session indicator helper.
 *
 * Byte-identical canonical JSON with:
 *   - pc2-node/src/utils/secureViewSession.ts (server)
 *   - pc2-node/data/lit-actions/non-media-decrypt.js (Lit Action)
 *   - pc2-node/data/lit-actions/media-decrypt.js (Lit Action)
 *
 * Curve: P-256. Locked in Phase 1 spike (§10.2 of DESIGN.md) after
 * K-256 failed in every major browser engine.
 */
/* global window, indexedDB, TextEncoder */
(function initSecureViewSession(globalScope) {
  'use strict';

  // ── Protocol constants (mirror DESIGN.md §2.2 / §2.3) ──────────
  var DELEGATION_DOMAIN = 'pc2.secure-view.v1';
  var REQUEST_DOMAIN = 'pc2.secure-view.request.v1';
  var MAX_DELEGATION_TTL_SECONDS = 24 * 3600;
  var DEFAULT_DELEGATION_TTL_SECONDS = 24 * 3600;

  // IndexedDB layout
  var DB_NAME = 'pc2-secure-view';
  var DB_VERSION = 1;
  var STORE_KEYS = 'sessionKeys';
  var STORE_DELEGATIONS = 'delegations';
  /** The fixed key under which we store the current session. */
  var SESSION_SLOT = 'current';

  // ── Canonical JSON ──────────────────────────────────────────────

  /**
   * Byte-identical with the server + Lit Action.
   * Sorted object keys, no whitespace, JSON.stringify for primitives.
   */
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) parts.push(canonicalize(value[i]));
      return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var kv = [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      kv.push(JSON.stringify(key) + ':' + canonicalize(value[key]));
    }
    return '{' + kv.join(',') + '}';
  }

  // ── Hex helpers ─────────────────────────────────────────────────

  function bytesToHex(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = '0x';
    for (var i = 0; i < u8.length; i++) {
      s += u8[i].toString(16).padStart(2, '0');
    }
    return s;
  }

  function hexToBytes(hex) {
    var h = hex.slice(0, 2) === '0x' || hex.slice(0, 2) === '0X' ? hex.slice(2) : hex;
    if (h.length % 2 !== 0) throw new Error('hex string has odd length');
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function randomHex(bytes) {
    var u8 = new Uint8Array(bytes);
    globalScope.crypto.getRandomValues(u8);
    return bytesToHex(u8);
  }

  // ── IndexedDB tiny promise wrapper ──────────────────────────────

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS);
        if (!db.objectStoreNames.contains(STORE_DELEGATIONS)) db.createObjectStore(STORE_DELEGATIONS);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readonly');
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSet(store, key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ── Ephemeral key generation + storage ──────────────────────────

  /**
   * Generate a non-extractable P-256 keypair. The CryptoKey objects
   * are stored in IndexedDB; their raw bytes never become JavaScript-
   * accessible. Returns `{ keyPair, sessionPublicKey }`.
   */
  function createEphemeralKey() {
    return globalScope.crypto.subtle
      .generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      .then(function (kp) {
        return globalScope.crypto.subtle.exportKey('raw', kp.publicKey).then(function (raw) {
          return { keyPair: kp, sessionPublicKey: bytesToHex(raw) };
        });
      });
  }

  function saveSessionKey(keyPair) {
    return idbSet(STORE_KEYS, SESSION_SLOT, keyPair);
  }

  function loadSessionKey() {
    return idbGet(STORE_KEYS, SESSION_SLOT);
  }

  function deleteSessionKey() {
    return idbDelete(STORE_KEYS, SESSION_SLOT);
  }

  function saveDelegation(record) {
    return idbSet(STORE_DELEGATIONS, SESSION_SLOT, record);
  }

  function loadDelegation() {
    return idbGet(STORE_DELEGATIONS, SESSION_SLOT);
  }

  function deleteDelegation() {
    return idbDelete(STORE_DELEGATIONS, SESSION_SLOT);
  }

  // ── Delegation / Request signing ────────────────────────────────

  /**
   * Build the canonical unsigned delegation payload. Matches
   * SecureViewDelegation shape in DESIGN.md §2.2.
   *
   * Caller is expected to feed the return value to walletSignMessage
   * (user's wallet, EIP-191) and then call `persistDelegation()`.
   */
  function buildDelegationPayload(params) {
    var nowSec = Math.floor(Date.now() / 1000);
    var ttl = Math.min(params.ttlSeconds || DEFAULT_DELEGATION_TTL_SECONDS, MAX_DELEGATION_TTL_SECONDS);
    return {
      domain: DELEGATION_DOMAIN,
      chainId: params.chainId,
      actionIpfsId: params.actionIpfsId,
      ownerAddress: params.ownerAddress,
      coveredAddresses: params.coveredAddresses.slice(),
      sessionPublicKey: params.sessionPublicKey,
      issuedAt: nowSec,
      expiresAt: nowSec + ttl,
      nonce: randomHex(16),
    };
  }

  /**
   * Build and sign a SecureViewRequest using the session ephemeral
   * key. Returns `{ request, requestCanonical, requestSig }`.
   *
   * `keyPair.privateKey` must be the CryptoKey from createEphemeralKey.
   */
  function signRequest(keyPair, params) {
    var req = {
      domain: REQUEST_DOMAIN,
      kid: params.kid,
      actionIpfsId: params.actionIpfsId,
      requestedAt: Math.floor(Date.now() / 1000),
      requestNonce: randomHex(8),
    };
    var canonical = canonicalize(req);
    var bytes = new TextEncoder().encode(canonical);
    return globalScope.crypto.subtle
      .sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, bytes)
      .then(function (sig) {
        return {
          request: req,
          requestCanonical: canonical,
          requestSig: bytesToHex(sig),
        };
      });
  }

  /**
   * Persist a signed delegation so it survives page reloads.
   * `record` should include:
   *   { delegation, delegationCanonical, delegationSig, sessionPublicKey, ownerAddress, expiresAt }
   */
  function persistDelegation(record) {
    return saveDelegation(record);
  }

  /** Get the currently active delegation, or null if none / expired. */
  function getActiveDelegation() {
    return loadDelegation().then(function (rec) {
      if (!rec) return null;
      if (typeof rec.expiresAt === 'number' && rec.expiresAt < Math.floor(Date.now() / 1000)) {
        return deleteDelegation().then(function () { return null; });
      }
      return rec;
    });
  }

  /**
   * Revoke the current session locally and optionally tell the server
   * to add it to the per-node revoke list.
   *
   * Pass `{ serverRevokeUrl, fetch }` to also POST the revoke
   * notification; `fetch` defaults to `globalScope.fetch`.
   */
  function revokeSession(options) {
    var fetchFn = (options && options.fetch) || globalScope.fetch;
    return loadDelegation().then(function (rec) {
      var promises = [deleteSessionKey(), deleteDelegation()];
      if (options && options.serverRevokeUrl && rec && rec.delegation && fetchFn) {
        promises.push(
          fetchFn(options.serverRevokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ delegationNonce: rec.delegation.nonce }),
          }).catch(function () { /* best-effort */ })
        );
      }
      return Promise.all(promises).then(function () { /* void */ });
    });
  }

  // ── Session indicator helper ────────────────────────────────────

  /**
   * Render a tiny session indicator into `container`. Shows expiry
   * countdown and a "Sign out" button. Idempotent: call repeatedly
   * and it updates the same element.
   *
   * Options:
   *   - container: HTMLElement (required)
   *   - onRevoke: () => void (callback after successful revoke)
   *   - serverRevokeUrl: string (posted to on revoke)
   */
  function renderSessionIndicator(options) {
    var container = options.container;
    if (!container) return;

    function render() {
      return getActiveDelegation().then(function (rec) {
        if (!rec) {
          container.innerHTML = '';
          return;
        }
        var secondsLeft = Math.max(0, rec.expiresAt - Math.floor(Date.now() / 1000));
        var hours = Math.floor(secondsLeft / 3600);
        var minutes = Math.floor((secondsLeft % 3600) / 60);
        var label = hours >= 1 ? hours + 'h ' + minutes + 'm' : minutes + 'm';
        var ownerShort =
          rec.ownerAddress.substring(0, 6) + '…' + rec.ownerAddress.substring(rec.ownerAddress.length - 4);

        container.innerHTML =
          '<div data-pc2-session-indicator ' +
          'style="display:inline-flex;align-items:center;gap:8px;padding:6px 10px;font:12px ui-monospace,Consolas,monospace;' +
          'background:#1f2937;color:#e5e7eb;border-radius:6px;line-height:1;">' +
          '<span style="width:8px;height:8px;background:#10b981;border-radius:50%;display:inline-block;"></span>' +
          '<span>Session · ' + ownerShort + ' · ' + label + ' left</span>' +
          '<button type="button" data-pc2-session-revoke ' +
          'style="display:inline-flex;align-items:center;justify-content:center;padding:4px 8px;font-size:11px;line-height:1;' +
          'font-family:inherit;background:#374151;color:#fff;border:1px solid #4b5563;border-radius:4px;cursor:pointer;">' +
          'Sign out</button>' +
          '</div>';

        var btn = container.querySelector('[data-pc2-session-revoke]');
        if (btn) {
          btn.onclick = function () {
            revokeSession({ serverRevokeUrl: options.serverRevokeUrl }).then(function () {
              container.innerHTML = '';
              if (typeof options.onRevoke === 'function') options.onRevoke();
            });
          };
        }
      });
    }

    render();
    // Light re-render every minute so the countdown ticks.
    if (container._pc2Interval) clearInterval(container._pc2Interval);
    container._pc2Interval = setInterval(render, 60 * 1000);
    return { refresh: render };
  }

  // ── Public API ──────────────────────────────────────────────────

  globalScope.PC2SecureViewSession = {
    // Constants (re-exported for callers that want to inspect)
    DELEGATION_DOMAIN: DELEGATION_DOMAIN,
    REQUEST_DOMAIN: REQUEST_DOMAIN,
    MAX_DELEGATION_TTL_SECONDS: MAX_DELEGATION_TTL_SECONDS,

    // Primitives
    canonicalize: canonicalize,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes,
    randomHex: randomHex,

    // Keys + storage
    createEphemeralKey: createEphemeralKey,
    saveSessionKey: saveSessionKey,
    loadSessionKey: loadSessionKey,
    deleteSessionKey: deleteSessionKey,

    // Delegation flow
    buildDelegationPayload: buildDelegationPayload,
    persistDelegation: persistDelegation,
    getActiveDelegation: getActiveDelegation,

    // Per-request signing
    signRequest: signRequest,

    // Revocation
    revokeSession: revokeSession,

    // UI
    renderSessionIndicator: renderSessionIndicator,
  };
}(typeof window !== 'undefined' ? window : globalThis));
