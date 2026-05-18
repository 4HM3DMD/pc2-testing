/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * OracleAdapter — Wave M4.1 (beta.0.3.1) — abstract base class for
 * the Elastos cross-chain Oracles (Class C per the 5-class taxonomy).
 *
 * WHY THIS DIFFERS FROM ELA/EVM ADAPTERS
 *
 * Oracles are stateless Node.js HTTP relayers. They have no:
 *   - keystore        (nothing to sign during the running daemon —
 *                      the one-time `deployctrt.js` setup script signs;
 *                      that's separate from this adapter)
 *   - peers           (single-tenant client over RPC)
 *   - block height    (relayer, not a chain)
 *   - mining rewards  (no production)
 *   - PBFT signing    (no consensus participation)
 *
 * They DO have:
 *   - parent chain    (ESC → esc, EID → eid, PG → pg) — the EVM
 *                     sidechain whose bridge contracts they watch
 *   - mainchain RPC   (to write cross-chain payloads to ELA mainchain)
 *   - script path     (the upstream JS entry point — varies per oracle)
 *   - HTTP port       (for health probes; oracles serve a tiny
 *                     status endpoint)
 *
 * SPAWN MODEL
 *
 * Unlike Class A/B/D which spawn a binary, Class C spawns:
 *   node <scriptPath>
 *
 * with env vars carrying the parent + mainchain RPC URLs + the
 * oracle's HTTP port. The `node` interpreter version is pinned by the
 * M4.3 runtime-distribution work (Node v23.10.0 per upstream); the
 * adapter only knows the path to the `node` binary.
 *
 * SUBCLASS CONTRACT
 *
 * Each subclass MUST provide:
 *   - chainId         (e.g. 'esc-oracle')
 *   - displayName     (e.g. 'Smart Chain Oracle')
 *   - parentChainId   (e.g. 'esc')
 *   - scriptFilename  (e.g. 'crosschain_oracle.js')
 *
 * The script's absolute path is resolved at spawn time from
 * `cfg.scriptPath` (operator-supplied or M3.8-downloader-resolved)
 * with the scriptFilename appended.
 *
 * NODE.SH PARITY (plan §17 Class C row)
 *
 * REPLICATE:
 *   - Per-oracle entry filenames (ESC=crosschain_oracle.js,
 *     EID=crosschain_eid.js, PG=crosschain_pg.js)
 *   - Node.js v23.10.0 runtime pin (M4.3 ships the runtime)
 *   - env=mainnet|testnet propagation
 *   - HTTP probe on the oracle port
 *   - `nohup node ...` (we use spawn { detached:true } + unref())
 *
 * DIVERGE:
 *   - No keystore / no password (no diverge to clean up — node.sh
 *     also doesn't ship one for Class C)
 *   - No --password / --rpcuser CLI flags (oracles need none)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ChainAdapter = require('./ChainAdapter');
const { EthRpcClient } = require('./EthRpcClient');
const { chainDir } = require('./DataDir');
const ConfigStore = require('./ConfigStore');

class OracleAdapter extends ChainAdapter {
    constructor(deps) {
        super(deps);
    }

    // -------- Required subclass overrides --------

    /** @returns {string} e.g. 'esc-oracle' */
    get chainId() {
        throw new Error('OracleAdapter: subclass must override chainId');
    }
    /** @returns {string} e.g. 'Smart Chain Oracle' */
    get displayName() {
        throw new Error('OracleAdapter: subclass must override displayName');
    }
    /** @returns {string} e.g. 'crosschain_oracle.js' (the upstream filename) */
    get scriptFilename() {
        throw new Error('OracleAdapter: subclass must override scriptFilename');
    }
    /** Overridden in subclasses or resolved via base CHAIN_ID_TO_PARENT map */
    // get parentChainId() inherited from ChainAdapter.

    // -------- Shared implementations --------

    get chainClass() { return 'C'; }

    /**
     * Oracles serve a minimal HTTP endpoint for health probes. EthRpcClient
     * is the closest reusable HTTP client; it speaks JSON-RPC which is what
     * the upstream oracle endpoints serve (their / endpoint accepts a
     * dummy eth_blockNumber-style request and replies with the relayer's
     * own version + status).
     *
     * For a fuller status-only probe we'd want a plain GET, but reusing
     * EthRpcClient keeps the surface small. The health() override below
     * uses it.
     *
     * @param {object} cfg
     * @returns {import('./EthRpcClient').EthRpcClient}
     */
    rpcClient(cfg) {
        if (!cfg || !cfg.ports || !cfg.ports.httpRpc) {
            throw new Error(
                `${this.chainId}: rpcClient called with cfg missing ports.httpRpc`,
            );
        }
        return new EthRpcClient({
            host: '127.0.0.1',
            port: cfg.ports.httpRpc,
        });
    }

    /**
     * Oracles don't read a config file — env vars carry everything.
     *
     * @param {object} cfg
     * @returns {null}
     */
    generateConfig() { return null; }

    /**
     * Build the spawn argv. Just the script path; env vars carry the
     * RPC URLs + ports.
     *
     * @param {object} cfg
     * @returns {string[]}
     */
    buildSpawnArgs(cfg) {
        if (!cfg || typeof cfg.scriptPath !== 'string') {
            throw new Error(`${this.chainId}: buildSpawnArgs requires cfg.scriptPath`);
        }
        const scriptAbs = path.join(cfg.scriptPath, this.scriptFilename);
        return [scriptAbs];
    }

    /**
     * Build the env vars handed to the oracle child. The script reads
     * these (env=, ENM_PARENT_RPC, etc.) to know where to relay.
     *
     * @param {object} cfg
     * @param {object} secrets  { parentRpcUrl, mainchainRpcUrl }
     * @returns {object}
     */
    buildEnv(cfg, secrets) {
        if (!cfg || !cfg.ports || !cfg.ports.httpRpc) {
            throw new Error(`${this.chainId}: buildEnv requires cfg.ports.httpRpc`);
        }
        if (!secrets || !secrets.parentRpcUrl || !secrets.mainchainRpcUrl) {
            throw new Error(
                `${this.chainId}: buildEnv requires secrets.{parentRpcUrl, mainchainRpcUrl}`,
            );
        }
        return {
            env: cfg.activeNet || 'mainnet',
            // Upstream node.sh sets these prefixes; we mirror them.
            ENM_PARENT_CHAIN: this.parentChainId,
            ENM_PARENT_RPC: secrets.parentRpcUrl,
            ENM_MAINCHAIN_RPC: secrets.mainchainRpcUrl,
            ENM_ORACLE_PORT: String(cfg.ports.httpRpc),
        };
    }

    /**
     * Resolve the parent EVM sidechain's RPC URL from cfg. Throws when
     * the parent isn't configured (the oracle can't run without its
     * parent's RPC reachable).
     *
     * @returns {Promise<string>}
     */
    async resolveParentRpcUrl() {
        const cfg = await ConfigStore.load();
        const parent = cfg && cfg.chains && cfg.chains[this.parentChainId];
        if (!parent || !parent.ports || !parent.ports.rpc) {
            throw new Error(
                `${this.chainId}: parent chain "${this.parentChainId}" not configured. `
                + 'Install the parent EVM sidechain first.',
            );
        }
        return `http://127.0.0.1:${parent.ports.rpc}/`;
    }

    /**
     * Resolve the mainchain RPC URL. Oracles write cross-chain payloads
     * to ELA mainchain so it must be reachable too.
     *
     * @returns {Promise<string>}
     */
    async resolveMainchainRpcUrl() {
        const cfg = await ConfigStore.load();
        const main = cfg && cfg.chains && cfg.chains.mainchain;
        if (!main || !main.ports || !main.ports.rpc) {
            throw new Error(
                `${this.chainId}: mainchain not configured. The Oracle relays to mainchain; `
                + 'install + start mainchain first.',
            );
        }
        return `http://127.0.0.1:${main.ports.rpc}/`;
    }

    /**
     * start() — overrides base to handle node-vs-binary spawn.
     *
     * Pre-flight:
     *   1. cfg.scriptPath must exist + contain the per-oracle script
     *   2. cfg.binaryPath must point at a `node` interpreter (M4.3
     *      runtime ships this; for M4.1 we trust the operator)
     *   3. Parent EVM sidechain must be configured
     *   4. Mainchain must be configured
     *
     * @param {object} cfg
     * @returns {Promise<{ pid: number, startedAt: number }>}
     */
    async start(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            throw new TypeError(`${this.chainId}.start: cfg object required`);
        }
        if (typeof cfg.binaryPath !== 'string' || !fs.existsSync(cfg.binaryPath)) {
            throw new Error(
                `${this.chainId}: node interpreter not found at ${cfg.binaryPath}. `
                + 'Run the Node.js runtime install step (M4.3).',
            );
        }
        const scriptAbs = path.join(cfg.scriptPath || '', this.scriptFilename);
        if (!fs.existsSync(scriptAbs)) {
            throw new Error(
                `${this.chainId}: oracle script not found at ${scriptAbs}. `
                + 'Install the oracle scripts before starting.',
            );
        }
        const parentRpcUrl = await this.resolveParentRpcUrl();
        const mainchainRpcUrl = await this.resolveMainchainRpcUrl();
        cfg.spawnArgs = this.buildSpawnArgs(cfg);
        cfg.spawnEnv = this.buildEnv(cfg, { parentRpcUrl, mainchainRpcUrl });
        return this.processService.start(this.chainId, cfg);
    }

    /**
     * Override health() — oracles don't expose getblockcount, so the
     * base ChainAdapter.health() would always report rpcOk=false. We
     * probe net_version (cheap geth-style health check) instead since
     * the oracle responds to that with its own version string.
     *
     * @param {object} cfg
     * @returns {Promise<{ alive: boolean, rpcOk: boolean, pid: number|null }>}
     */
    async health(cfg) {
        const procStatus = this.processService.statusSync(this.chainId);
        if (!procStatus.alive) {
            return { alive: false, rpcOk: false, pid: null };
        }
        let rpcOk = false;
        try {
            await this.rpcClient(cfg).getNetVersion();
            rpcOk = true;
        } catch (_) { /* rpcOk stays false */ }
        return { alive: true, rpcOk, pid: procStatus.pid };
    }
}

module.exports = OracleAdapter;
