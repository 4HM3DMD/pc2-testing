/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ChainAdapter — abstract base for per-chain logic.
 *
 * v0.1 has only ElaMainChainAdapter. v0.2+ will add ElaEsccAdapter,
 * ElaEidAdapter, ElaArbiterAdapter, etc. Subclasses share lifecycle hooks
 * (start/stop/restart/health/version/peers/height/sync) so the route layer
 * doesn't need per-chain conditionals.
 *
 * Concrete subclasses must implement:
 *   - chainId         (string getter — e.g. "mainchain")
 *   - displayName     (string getter — e.g. "ELA Mainchain")
 *   - generateConfig(cfg) → string  (writes the chain's config.json contents)
 *   - rpcClient(cfg) → EnmRpcClient instance
 *
 * Lifecycle methods (start/stop/restart) are implemented in the base using
 * NativeProcessService. Subclasses can override if they need chain-specific
 * spawn behavior — but most won't.
 */

'use strict';

const { ENM_LOG_PREFIX } = require('./EnmConstants');

class ChainAdapter {
    /**
     * @param {object} deps
     * @param {object} deps.processService  NativeProcessService instance
     * @param {object} deps.extensionHandle PC2 extension global (for log/db access)
     */
    constructor(deps) {
        if (!deps || !deps.processService || !deps.extensionHandle) {
            throw new TypeError('ChainAdapter: { processService, extensionHandle } required');
        }
        this.processService = deps.processService;
        this.extensionHandle = deps.extensionHandle;
    }

    /** Override in subclass. */
    get chainId() {
        throw new Error('ChainAdapter: subclass must override chainId');
    }

    /** Override in subclass. */
    get displayName() {
        throw new Error('ChainAdapter: subclass must override displayName');
    }

    /**
     * Generate the chain's `config.json` contents from our extension config.
     *
     * @param {object} chainConfig from EnmConfigSchema (e.g. config.chains.mainchain)
     * @param {object} secrets     { rpcPassword: string, ipAddress: string|null }
     * @returns {object}           plain object that JSON.stringify-es to ela's config.json
     */
    // eslint-disable-next-line no-unused-vars
    generateConfig(chainConfig, secrets) {
        throw new Error('ChainAdapter: subclass must override generateConfig');
    }

    /**
     * Return an RPC client wired to this chain's RPC port + auth.
     *
     * @param {object} chainConfig
     * @returns {import('./EnmRpcClient').EnmRpcClient}
     */
    // eslint-disable-next-line no-unused-vars
    rpcClient(chainConfig) {
        throw new Error('ChainAdapter: subclass must override rpcClient');
    }

    /**
     * Start the chain process. Subclasses can override to add pre-flight
     * checks, but the default delegates to NativeProcessService.
     *
     * @param {object} chainConfig
     * @returns {Promise<{ pid: number, startedAt: number }>}
     */
    async start(chainConfig) {
        return this.processService.start(this.chainId, chainConfig);
    }

    /**
     * Stop the chain process gracefully. Default: SIGTERM, wait 60s, SIGKILL.
     *
     * @returns {Promise<{ exitCode: number|null, signal: string|null }>}
     */
    async stop() {
        return this.processService.stop(this.chainId);
    }

    /**
     * Restart = stop then start.
     *
     * @param {object} chainConfig
     * @returns {Promise<{ pid: number, startedAt: number }>}
     */
    async restart(chainConfig) {
        return this.processService.restart(this.chainId, chainConfig);
    }

    /**
     * Quick liveness probe — does the process exist + is RPC reachable?
     *
     * @param {object} chainConfig
     * @returns {Promise<{ alive: boolean, rpcOk: boolean, pid: number|null }>}
     */
    async health(chainConfig) {
        const procStatus = this.processService.statusSync(this.chainId);
        if (!procStatus.alive) {
            return { alive: false, rpcOk: false, pid: null };
        }
        let rpcOk = false;
        try {
            await this.rpcClient(chainConfig).getblockcount();
            rpcOk = true;
        } catch (err) {
            this.extensionHandle.log.debug(`${ENM_LOG_PREFIX} ${this.chainId} health probe RPC error: ${err.message}`);
        }
        return { alive: true, rpcOk, pid: procStatus.pid };
    }
}

module.exports = ChainAdapter;
