/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * chain-selector.js — beta.3.70 — top-bar dropdown that replaces the old
 * static "MAINNET" pill (and the duplicate Elastos Node Manager brand
 * name + mark). Lets the operator see what chain surfaces ENM understands
 * and select between them.
 *
 * Behaviour:
 *   - Always renders. Lists 7 options:
 *       Multi-chain overview · Main chain · ESC + Oracle ·
 *       EID + Oracle · PG + Oracle · Arbiter · SPV
 *   - Detection of node type from /api/enm/config:
 *       1 chain configured (mainchain only) → BPoS-only mode
 *         All non-mainchain options grayed out + a footer note
 *         explains "your selected mode is Main chain only".
 *       2+ chains configured → council mode
 *         Configured chains light up + are selectable.
 *   - Active selection persists in localStorage('enm:chain-selection').
 *   - Closes on outside click or Escape.
 *   - Future: changing selection will scope the Dashboard / Logs /
 *     Activity panes to that chain. For now (single chain), the
 *     selector is informational + future-proofing; selecting Main
 *     chain is a no-op past confirming the choice.
 */

(function (root) {
    'use strict';

    // The 7 known chain surfaces. Each entry:
    //   - key:     stable identifier (matches cfg.chains.* keys plus
    //              the synthetic 'all' for the multi-chain overview)
    //   - label:   operator-facing display string
    //   - hint:    one-line subtitle (rendered small / dim on the row)
    //   - alwaysOn: true for entries that aren't a chain config entry
    //              (currently only 'all' — the overview view)
    var CHAIN_OPTIONS = [
        { key: 'all',        label: 'Multi-chain overview',  hint: 'All chains aggregated' },
        { key: 'mainchain',  label: 'Main chain',            hint: 'ELA mainnet' },
        { key: 'esc',        label: 'Smart Chain',           hint: 'ESC + ESC Oracle' },
        { key: 'eid',        label: 'Identity Chain',        hint: 'EID + EID Oracle' },
        { key: 'pg',         label: 'PG Chain',              hint: 'PG + PG Oracle' },
        { key: 'arbiter',    label: 'Arbiter Service',       hint: 'Cross-chain arbitration' },
        // v0.5.168 (Phase 2) — SPV (class E) is NOT a standalone process: it's
        // embedded in the EVM sidechains (esc/eid/pg keep their own light-client
        // state under data/logs-spv) and in the arbiter (getspvheight +
        // per-sidechain getsidechainblockheight). The SPV Module view aggregates
        // those heights. Enabled on council nodes running ≥1 EVM sidechain or the
        // arbiter (see _isOptionEnabled); grayed on a Main-chain-only node.
        { key: 'spv',        label: 'SPV Module',            hint: 'Cross-chain SPV heights' },
    ];

    var STORAGE_KEY = 'enm:chain-selection';

    function ChainSelector(opts) {
        if (!opts || !opts.root || !opts.api) {
            throw new TypeError('ChainSelector: { root, api } required');
        }
        this.root = opts.root;
        this.api = opts.api;
        this.trigger = this.root.querySelector('.enm-chain-selector-trigger');
        this.label   = this.root.querySelector('.enm-chain-selector-label');
        this.menu    = this.root.querySelector('.enm-chain-selector-menu');
        this._availableChains = new Set(['mainchain']); // safe default
        this._mode = 'bpos-only';
        this._activeKey = this._loadStoredSelection() || 'mainchain';
        this._open = false;
        this._onDocClick = null;
        this._onKeydown = null;
    }

    ChainSelector.prototype.mount = function () {
        if (!this.root || !this.trigger || !this.menu) { return; }
        var self = this;
        // Wire trigger click.
        this.trigger.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self._toggle();
        });
        // Initial render — async load of config to detect node type.
        this._refreshAvailability();
        this._render();
    };

    ChainSelector.prototype.destroy = function () {
        this._closeMenu();
    };

    /** @private — load stored selection if it's still a valid option key */
    ChainSelector.prototype._loadStoredSelection = function () {
        try {
            var v = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
            if (!v) { return null; }
            var match = CHAIN_OPTIONS.filter(function (o) { return o.key === v; });
            return match.length ? v : null;
        } catch (_) { return null; }
    };

    /** @private */
    ChainSelector.prototype._saveStoredSelection = function (key) {
        try { root.localStorage.setItem(STORAGE_KEY, key); }
        catch (_) { /* swallow — private mode etc. */ }
    };

    /**
     * 0.5.8 audit Session 8 — public refresh entry point.
     *
     * Pre-0.5.8 `_refreshAvailability` only fired at mount time (app boot),
     * so chains installed AFTER boot via the wizard's Council install never
     * triggered the council-default 'all' switch. Selector stayed in
     * 'bpos-only' mode showing just "Main chain"; operator had to click
     * the selector dropdown manually to see the multi-chain options.
     * app.js _showDashboard now calls this after Card 7 onComplete to
     * re-detect mode + dispatch enm:chain-change → PaneRouter remounts
     * the pane to multi-chain overview when council is freshly installed.
     */
    ChainSelector.prototype.refresh = function () {
        this._refreshAvailability();
    };

    /** @private — fetch current config, mark available chains */
    ChainSelector.prototype._refreshAvailability = function () {
        var self = this;
        if (!this.api || typeof this.api.get !== 'function') { return; }
        this.api.get('/config').then(function (data) {
            // api.js unwraps the envelope to `parsed.result` (api.js:260), so
            // `data` here is the RESULT level = { config: { chains: {...} } } —
            // NOT the full { success, result } envelope. Resolve the config
            // object across all three shapes: full envelope (data.result.config),
            // unwrapped result (data.config — the actual runtime shape), or a
            // bare config object (data). Pre-fix this only tried
            // data.result.config || data, so chains came out empty on EVERY
            // council node → keys.length 0 → mis-detected bpos-only + grayed.
            var cfg = (data && data.result && data.result.config)
                   || (data && data.config)
                   || data || {};
            var chains = cfg.chains || {};
            var keys = Object.keys(chains);
            self._availableChains = new Set(keys);
            // BPoS-only when only mainchain is configured. Future:
            // council operator will have ['mainchain', 'esc', 'eid', ...]
            // and that count > 1 flips the mode.
            self._mode = keys.length <= 1 ? 'bpos-only' : 'council';
            self.root.setAttribute('data-mode', self._mode);
            // If the stored selection is no longer available for this
            // node type, fall back to mainchain.
            //
            // beta.3.89 (Wave M2.1) — also dispatch enm:chain-change
            // here so PaneRouter (app.js) syncs the dashboard pane to
            // mainchain. Pre-M2.1 the auto-reset was silent: PaneRouter
            // didn't exist, so nobody cared. With PaneRouter listening,
            // a silent reset would leave the dashboard rendering the
            // overview pane (because PaneRouter's localStorage read at
            // boot saw key='all') while the selector says "Main chain".
            // Dispatching keeps the two in lockstep.
            var resetHappened = false;
            if (self._mode === 'bpos-only' && self._activeKey !== 'mainchain') {
                self._activeKey = 'mainchain';
                self._saveStoredSelection('mainchain');
                resetHappened = true;
            }
            // beta.0.5.0 — when the operator's node flips from bpos-only to council
            // (sidechains/oracles/arbiter installed) AND they don't have an
            // explicit stored selection, default to the Multi-chain overview ('all').
            // Operators on a council node land on the dashboard expecting to see
            // ALL their chains; pre-0.5.0 they'd see just mainchain and have to
            // hunt for the selector.
            if (self._mode === 'council' && !self._loadStoredSelection()) {
                self._activeKey = 'all';
                self._saveStoredSelection('all');
                resetHappened = true;
            }
            self._render();
            if (resetHappened) {
                try {
                    // 0.5.73 audit Session 73 — pre-0.5.73 hardcoded
                    // key='mainchain'. Original beta.3.89 intent was the
                    // BPoS-only reset path (active → mainchain). The
                    // beta.0.5.0 council branch added _activeKey = 'all'
                    // but forgot to update the dispatch. Result on
                    // freshly-installed council nodes: selector UI
                    // shows "Multi-chain overview" highlighted while
                    // PaneRouter receives key='mainchain' and mounts
                    // the mainchain dashboard underneath — desynced.
                    // Use the resolved self._activeKey so both branches
                    // dispatch what they actually set.
                    self.root.dispatchEvent(new CustomEvent('enm:chain-change', {
                        detail: { key: self._activeKey, source: 'availability-refresh' },
                        bubbles: true,
                    }));
                } catch (_) { /* IE-era fallback unnecessary */ }
            }
        }).catch(function () {
            // Network/auth error — leave defaults. Selector still
            // functions, just stuck in safe BPoS-only state.
        });
    };

    /** @private */
    ChainSelector.prototype._render = function () {
        if (!this.label || !this.menu) { return; }
        var self = this;
        var active = CHAIN_OPTIONS.filter(function (o) { return o.key === self._activeKey; })[0]
                  || CHAIN_OPTIONS[1]; // fallback to Main chain
        this.label.textContent = active.label;
        this.root.setAttribute('data-active', active.key);

        // Re-build menu options each render (cheap, ~7 nodes).
        this.menu.innerHTML = '';
        CHAIN_OPTIONS.forEach(function (opt) {
            var enabled = self._isOptionEnabled(opt.key);
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'enm-chain-selector-option';
            row.setAttribute('role', 'option');
            row.setAttribute('data-key', opt.key);
            if (opt.key === self._activeKey) {
                row.setAttribute('aria-current', 'true');
            }
            if (!enabled) {
                row.disabled = true;
                row.setAttribute('aria-disabled', 'true');
                row.setAttribute('title', 'Not available in this mode');
            }
            var dot = document.createElement('span');
            dot.className = 'enm-chain-selector-option-indicator';
            dot.setAttribute('aria-hidden', 'true');
            row.appendChild(dot);
            var label = document.createElement('span');
            label.className = 'enm-chain-selector-option-label';
            label.textContent = opt.label;
            row.appendChild(label);
            if (opt.hint) {
                var hint = document.createElement('span');
                hint.className = 'enm-chain-selector-option-hint';
                hint.textContent = opt.hint;
                row.appendChild(hint);
            }
            if (enabled) {
                row.addEventListener('click', function () { self._select(opt.key); });
            }
            self.menu.appendChild(row);
        });

        // Footer explainer when in BPoS-only mode — tells the operator
        // why most options are grayed.
        //
        // 0.5.30 audit Session 30 — rewrote to fix three problems:
        //  1. Pre-0.5.30 promised "Settings → Install chain" but that
        //     path does NOT exist in ENM. Stale pointer bug parallel
        //     to v0.5.27's Card 7 / "Producer Identity tile".
        //  2. Listed SPV as an installable module (per Session 15
        //     v0.5.15, SPV is a wallet protocol, not a node mode).
        //  3. Listed Arbiter as a "sidechain module" (Arbiter is
        //     Class D cross-chain signer, not a sidechain).
        //  Per operator-rule positioning ([[feedback_enm_vocabulary]]):
        //  BPoS-only and Council are DISTINCT roles chosen at install
        //  time; upgrading BPoS-only → Council in place is not
        //  supported. Honest copy beats a non-existent upgrade path.
        if (this._mode === 'bpos-only') {
            var foot = document.createElement('div');
            foot.className = 'enm-chain-selector-footer';
            foot.textContent =
                'This node runs Main chain only. The grayed rows '
                + 'are for Council nodes that run additional chains.';
            this.menu.appendChild(foot);
        }
    };

    /** @private — is the option selectable given current availability */
    ChainSelector.prototype._isOptionEnabled = function (key) {
        if (key === 'all') {
            // Multi-chain overview only makes sense once >1 chain is
            // installed. Grayed out for BPoS-only nodes.
            return this._mode === 'council';
        }
        if (key === 'spv') {
            // v0.5.168 (Phase 2) — SPV is virtual (embedded in the EVM
            // sidechains + the arbiter), so cfg.chains.spv never exists. Enable
            // the SPV Module whenever at least one of its host chains is
            // configured — otherwise there are no SPV heights to show.
            return this._availableChains.has('esc')
                || this._availableChains.has('eid')
                || this._availableChains.has('pg')
                || this._availableChains.has('arbiter');
        }
        return this._availableChains.has(key);
    };

    /** @private — select a chain (persist + re-render + close menu) */
    ChainSelector.prototype._select = function (key) {
        if (!this._isOptionEnabled(key)) { return; }
        this._activeKey = key;
        this._saveStoredSelection(key);
        this._closeMenu();
        this._render();
        // beta.3.89 (Wave M2.1) — PaneRouter in app.js listens here.
        // On key='all' it hides the tab strip + mounts the multi-chain
        // overview pane; on a specific chain key it shows the tab strip
        // + re-mounts the Dashboard for that chain. Other components
        // (audit-tab, settings-tab, log-viewer) read the active chain
        // from PaneRouter's _activeChainId during their next mount cycle.
        try {
            this.root.dispatchEvent(new CustomEvent('enm:chain-change', {
                detail: { key: key, source: 'user-click' },
                bubbles: true,
            }));
        } catch (_) { /* IE-era fallback unnecessary */ }
    };

    /** @private */
    ChainSelector.prototype._toggle = function () {
        if (this._open) { this._closeMenu(); }
        else { this._openMenu(); }
    };

    /** @private */
    ChainSelector.prototype._openMenu = function () {
        var self = this;
        this.menu.hidden = false;
        this.trigger.setAttribute('aria-expanded', 'true');
        this._open = true;
        // Close-on-outside-click — installed once per open so we don't
        // keep stale listeners around.
        this._onDocClick = function (ev) {
            if (self.root.contains(ev.target)) { return; }
            self._closeMenu();
        };
        this._onKeydown = function (ev) {
            if (ev.key === 'Escape') { self._closeMenu(); self.trigger.focus(); }
        };
        document.addEventListener('click', this._onDocClick, true);
        document.addEventListener('keydown', this._onKeydown);
    };

    /** @private */
    ChainSelector.prototype._closeMenu = function () {
        this.menu.hidden = true;
        this.trigger.setAttribute('aria-expanded', 'false');
        this._open = false;
        if (this._onDocClick) {
            document.removeEventListener('click', this._onDocClick, true);
            this._onDocClick = null;
        }
        if (this._onKeydown) {
            document.removeEventListener('keydown', this._onKeydown);
            this._onKeydown = null;
        }
    };

    root.EnmChainSelector = ChainSelector;
}(typeof window !== 'undefined' ? window : globalThis));
