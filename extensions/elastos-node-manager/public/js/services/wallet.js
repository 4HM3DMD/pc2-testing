/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * services/wallet.js — tethered DID flow via parent IPC.
 *
 * Per Rev 6 audit (agent 6):
 *   - Parent listener at pc2.net/src/gui/src/IPC.js:212-271 uses EXACT match on
 *     'dao-wallet-request'. Anything else gets dropped silently.
 *   - Supported actions in v0.1: getTetheredDID, openDIDTether
 *   - signMessage is NOT implemented; v0.1 OWNER-CONFIRMS uses requireOwner
 *     middleware + cooldown + checkbox + optional anti-snipe password.
 *
 * Also handles:
 *   - READY postMessage on boot (mirrors dao-dashboard:14-22)
 *   - windowWillClose responder (REQUIRED — Rev 6 audit; without it, PC2 hangs
 *     on close)
 */

(function (root) {
    'use strict';

    var WALLET_REQUEST_TYPE = 'dao-wallet-request';
    var REQUEST_TIMEOUT_MS = 30_000;

    function WalletService() {
        this.appInstanceId = new URLSearchParams(window.location.search).get('puter.app_instance_id') || null;
        this.tethered = null; // { did, wallets } once openDIDTether or getTetheredDID succeeds
        this._closeHandlerInstalled = false;
    }

    /**
     * Send the READY signal so PC2 marks our iframe as live.
     * @returns {void}
     */
    WalletService.prototype.sendReady = function () {
        if (!window.parent || window.parent === window) {
            return;
        }
        window.parent.postMessage({
            msg: 'READY',
            appInstanceID: this.appInstanceId,
            env: 'app',
        }, '*');
    };

    /**
     * Install the windowWillClose responder. Idempotent.
     * @returns {void}
     */
    WalletService.prototype.installCloseHandler = function () {
        if (this._closeHandlerInstalled) {
            return;
        }
        this._closeHandlerInstalled = true;
        window.addEventListener('message', function (ev) {
            if (!ev || !ev.data || ev.data.msg !== 'windowWillClose' || !ev.data.msg_id) {
                return;
            }
            window.parent.postMessage({
                msg: 'response',
                original_msg_id: ev.data.msg_id,
                response: true,
            }, '*');
        });
    };

    /**
     * Send a wallet request to the parent and resolve with the result.
     *
     * @param {string} action  must be a v0.1-supported action name
     * @param {object} [data]
     * @returns {Promise<*>}
     */
    WalletService.prototype.sendToParent = function (action, data) {
        var self = this;
        return new Promise(function (resolve, reject) {
            if (!window.parent || window.parent === window) {
                return reject(new Error('Not running inside a PC2 iframe — wallet API unavailable.'));
            }
            var messageId = 'enm_' + Date.now() + '_' + Math.random().toString(36).slice(2);

            function handler(ev) {
                if (!ev || !ev.data || ev.data.messageId !== messageId) {
                    return;
                }
                window.removeEventListener('message', handler);
                clearTimeout(timer);
                if (ev.data.error) {
                    reject(new Error(ev.data.error));
                } else {
                    resolve(ev.data.result);
                }
            }

            var timer = setTimeout(function () {
                window.removeEventListener('message', handler);
                reject(new Error('Wallet request timeout (' + REQUEST_TIMEOUT_MS + 'ms): ' + action));
            }, REQUEST_TIMEOUT_MS);

            window.addEventListener('message', handler);
            window.parent.postMessage({
                type: WALLET_REQUEST_TYPE, // EXACT match required (Rev 6 audit)
                messageId: messageId,
                action: action,
                data: data || {},
                appInstanceID: self.appInstanceId,
            }, '*');
        });
    };

    /**
     * Returns { did, wallets } if a wallet is tethered, or null if none yet.
     * Caches the result for the page session.
     *
     * @returns {Promise<{did: string, wallets: object}|null>}
     */
    WalletService.prototype.getTetheredDID = function () {
        var self = this;
        if (this.tethered) {
            return Promise.resolve(this.tethered);
        }
        return this.sendToParent('getTetheredDID').then(function (result) {
            self.tethered = result || null;
            return self.tethered;
        });
    };

    /**
     * Open the DID tether modal in the parent. Used when the operator hasn't
     * tethered a wallet yet. The promise resolves when the modal closes.
     *
     * @returns {Promise<{did: string, wallets: object}|null>}
     */
    WalletService.prototype.openDIDTether = function () {
        var self = this;
        return this.sendToParent('openDIDTether').then(function (result) {
            self.tethered = result || null;
            return self.tethered;
        });
    };

    root.EnmWalletService = WalletService;
}(typeof window !== 'undefined' ? window : globalThis));
