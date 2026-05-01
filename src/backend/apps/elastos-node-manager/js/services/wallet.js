/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/wallet.js — operator-identity service.
 *
 * Two paths to the operator's wallet, tried in order:
 *
 *   1. dao-wallet-request → 'getTetheredDID' postMessage to the parent PC2
 *      window. Same path dao-dashboard uses (pc2.net/src/gui/src/IPC.js:212).
 *      Returns { did, wallets } if the operator has tethered a wallet.
 *
 *   2. /api/enm/whoami on the sidecar, with the Bearer token taken from the
 *      `?puter.auth.token=` URL param. The sidecar resolves the token against
 *      pc2-node's session DB and returns { wallet_address, isOwner }.
 *
 * Path 1 covers the "operator has connected an Elastos DID" case; path 2
 * covers the more common "operator is signed into PC2 with any wallet"
 * case — which is what we need to run the ela node.
 *
 * This file also owns the two postMessage contracts the PC2 window manager
 * requires of every iframe app:
 *   - send `{msg:'READY', appInstanceID, env:'app'}` on boot
 *   - respond to `windowWillClose` with `windowWillCloseAck`
 * Without these, minimize / close from the PC2 titlebar misbehave.
 */

(function (root) {
    'use strict';

    var WALLET_REQUEST_TYPE = 'dao-wallet-request';
    var REQUEST_TIMEOUT_MS = 15_000;

    function WalletService() {
        var params = new URLSearchParams(root.location.search);
        this.appInstanceId = params.get('puter.app_instance_id') || null;
        this.authToken = params.get('puter.auth.token')
            || params.get('auth_token')
            || params.get('token')
            || null;
        this.identity = null; // { wallet_address, did?, source: 'tether'|'whoami' }
        this._closeHandlerInstalled = false;
    }

    /**
     * Send the READY signal so PC2 marks our iframe as live. Required for
     * the window-manager handshake — without this, min/close break.
     */
    WalletService.prototype.sendReady = function () {
        if (!root.parent || root.parent === root) {
            return;
        }
        root.parent.postMessage({
            msg: 'READY',
            appInstanceID: this.appInstanceId,
            env: 'app',
        }, '*');
    };

    /**
     * Install the windowWillClose responder. Idempotent.
     */
    WalletService.prototype.installCloseHandler = function () {
        if (this._closeHandlerInstalled) { return; }
        this._closeHandlerInstalled = true;
        root.addEventListener('message', function (ev) {
            if (!ev || !ev.data || ev.data.msg !== 'windowWillClose') {
                return;
            }
            root.parent.postMessage({
                msg: 'windowWillCloseAck',
                original_msg_id: ev.data.msg_id,
            }, '*');
        });
    };

    /**
     * Resolve the operator's identity. Tries the tethered-DID IPC first,
     * falls back to the sidecar's /whoami endpoint.
     *
     * @returns {Promise<{wallet_address: string, did?: string, source: string}|null>}
     */
    WalletService.prototype.getIdentity = function () {
        if (this.identity) {
            return Promise.resolve(this.identity);
        }
        var self = this;
        return this._tryTetheredDID()
            .catch(function () { return null; })
            .then(function (tetherResult) {
                if (tetherResult && tetherResult.wallet_address) {
                    self.identity = tetherResult;
                    return tetherResult;
                }
                return self._tryWhoami();
            });
    };

    /** @private */
    WalletService.prototype._tryTetheredDID = function () {
        var self = this;
        return new Promise(function (resolve, reject) {
            if (!root.parent || root.parent === root) {
                return reject(new Error('not in iframe'));
            }
            var messageId = 'enm_' + Date.now() + '_' + Math.random().toString(36).slice(2);

            function handler(ev) {
                if (!ev || !ev.data || ev.data.messageId !== messageId) { return; }
                root.removeEventListener('message', handler);
                clearTimeout(timer);
                if (ev.data.error) {
                    return reject(new Error(ev.data.error));
                }
                var r = ev.data.result;
                if (!r || !r.did) {
                    return resolve(null);
                }
                resolve({
                    wallet_address: (r.wallets && r.wallets.ela) || r.did,
                    did: r.did,
                    wallets: r.wallets || {},
                    source: 'tether',
                });
            }

            var timer = setTimeout(function () {
                root.removeEventListener('message', handler);
                // Don't error — just signal "no answer", and let _tryWhoami decide.
                resolve(null);
            }, REQUEST_TIMEOUT_MS);

            root.addEventListener('message', handler);
            root.parent.postMessage({
                type: WALLET_REQUEST_TYPE,
                messageId: messageId,
                action: 'getTetheredDID',
                data: {},
                appInstanceID: self.appInstanceId,
            }, '*');
        });
    };

    /** @private */
    WalletService.prototype._tryWhoami = function () {
        if (!this.authToken) {
            return Promise.resolve(null);
        }
        var apiBase = (root.ENM_API_BASE)
            ? root.ENM_API_BASE
            : (root.location.protocol + '//' + root.location.hostname + ':4180/api/enm');
        var self = this;
        return fetch(apiBase + '/whoami', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': 'Bearer ' + this.authToken,
            },
            credentials: 'include',
        }).then(function (res) {
            if (!res.ok) { return null; }
            return res.json().then(function (body) {
                if (!body || body.success === false) { return null; }
                var r = body.result || body;
                if (!r || !r.wallet_address) { return null; }
                self.identity = {
                    wallet_address: r.wallet_address,
                    isOwner: !!r.isOwner,
                    source: 'whoami',
                };
                return self.identity;
            });
        }).catch(function () { return null; });
    };

    /**
     * Truncate an address for display. EVM-style if hex, else show first/last
     * 6/4 chars. Mirrors dao-dashboard's helper.
     */
    WalletService.truncateAddress = function (addr) {
        if (!addr) { return ''; }
        if (addr.length <= 12) { return addr; }
        return addr.slice(0, 6) + '...' + addr.slice(-4);
    };

    root.EnmWalletService = WalletService;
}(typeof window !== 'undefined' ? window : globalThis));
