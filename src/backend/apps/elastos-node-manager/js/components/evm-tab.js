/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * components/evm-tab.js — EVM tab placeholder (v0.5).
 *
 * Per Architectural Invariant #4 of the v0.3 rebuild: EVM is a future
 * 5th tab inside ENM. The layout reserves the slot now so navigation
 * doesn't move when v0.5 ships. This component renders a clear
 * "coming soon" card with the v0.5 scope.
 *
 * No CTA, no link to a roadmap (we don't want to ship a dead link), no
 * hint that the tab is interactive. The button-shaped element below is
 * a static label, not a button — clicking it does nothing intentionally.
 */

(function (root) {
    'use strict';

    function EvmTab() {
        this.root = document.createElement('section');
        this.root.className = 'enm-card enm-evm-placeholder';
    }

    EvmTab.prototype.mount = function (parent) {
        parent.appendChild(this.root);
        this.root.innerHTML =
            '<header class="enm-evm-head">' +
                '<span class="enm-evm-version">v0.5</span>' +
                '<h2>EVM operations are coming</h2>' +
            '</header>' +
            '<p>' +
                'ENM v0.3 manages your native ELA mainchain only. Cross-chain ' +
                'operations (ESC sidechain, ELA→ETH bridges, smart-contract ' +
                'interactions, on-chain producer registration) will live here ' +
                'once the integration lands.' +
            '</p>' +
            '<p>' +
                'For now: use Essentials, MetaMask, or your wallet provider ' +
                'directly for ESC operations. The ' +
                '<strong>Dashboard → Producer identity</strong> card has the ' +
                'public key and the deep-link to register a supernode via ' +
                'Essentials.' +
            '</p>' +
            '<div class="enm-evm-features">' +
                '<div class="enm-evm-feature">' +
                    '<div class="enm-evm-feature-title">Wallet connect</div>' +
                    '<div class="enm-evm-feature-desc">Browser wallet for ESC tx signing</div>' +
                '</div>' +
                '<div class="enm-evm-feature">' +
                    '<div class="enm-evm-feature-title">Smart contracts</div>' +
                    '<div class="enm-evm-feature-desc">Read + write to ESC contracts</div>' +
                '</div>' +
                '<div class="enm-evm-feature">' +
                    '<div class="enm-evm-feature-title">Bridges</div>' +
                    '<div class="enm-evm-feature-desc">Mainchain ↔ ESC asset transfers</div>' +
                '</div>' +
                '<div class="enm-evm-feature">' +
                    '<div class="enm-evm-feature-title">Producer reg.</div>' +
                    '<div class="enm-evm-feature-desc">Sign + broadcast `producer register v2`</div>' +
                '</div>' +
            '</div>';
        return this;
    };

    EvmTab.prototype.destroy = function () {
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };

    root.EnmEvmTab = EvmTab;
}(typeof window !== 'undefined' ? window : globalThis));
