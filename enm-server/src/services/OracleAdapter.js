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
const { ENM_LOG_PREFIX } = require('./EnmConstants');

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
    buildEnv(cfg) {
        if (!cfg || !cfg.ports || !cfg.ports.httpRpc) {
            throw new Error(`${this.chainId}: buildEnv requires cfg.ports.httpRpc`);
        }
        // v0.5.172 (#2 node.sh parity) — the upstream crosschain_*.js + common.js
        // read ONLY process.env.env (to pick mainnet/testnet contract addresses);
        // node.sh likewise exports just `export env=...`. The listen port +
        // parent-RPC URL the oracle uses are HARDCODED in the script files and
        // are now rewritten from ENM's config by _alignScriptConfig() at start.
        // Pre-0.5.172 we also exported ENM_PARENT_CHAIN / ENM_PARENT_RPC /
        // ENM_MAINCHAIN_RPC / ENM_ORACLE_PORT — all DEAD: the scripts never read
        // them, so they only gave a false impression of configuring the oracle.
        return {
            env: cfg.activeNet || 'mainnet',
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
     * v0.5.172 (#2 node.sh parity) — the upstream crosschain_*.js + common.js
     * HARDCODE the oracle's listen port (e.g. `app.listen('20632')`) and its
     * parent-chain RPC URL (e.g. `new Web3("http://127.0.0.1:20636")`), and read
     * ONLY process.env.env. ENM's old ENM_* env vars were dead — the oracle
     * worked only because the hardcoded values equalled ENM's standard ports.
     * This rewrites those two values in-place from ENM's config so ENM is
     * authoritative. Best-effort + idempotent: each rewrite fires only when its
     * pattern matches EXACTLY once; otherwise it logs and leaves the file
     * untouched (oracle falls back to its hardcoded default = pre-0.5.172
     * behavior). It never throws, so it can never block or regress start.
     *
     * @param {object} cfg          cfg.scriptPath (dir) + cfg.ports.httpRpc (desired listen port)
     * @param {string} parentRpcUrl parent EVM chain RPC, e.g. http://127.0.0.1:20636/
     */
    async _alignScriptConfig(cfg, parentRpcUrl) {
        const dir = (cfg && cfg.scriptPath) || '';
        const listenPort = cfg && cfg.ports && cfg.ports.httpRpc;
        const parentUrl = String(parentRpcUrl || '').replace(/\/+$/, '');
        if (listenPort) {
            await this._patchOnce(
                path.join(dir, this.scriptFilename),
                /app\.listen\((['"])\d+\1\)/g,
                `app.listen('${listenPort}')`,
                'oracle listen port',
            );
        }
        if (parentUrl) {
            await this._patchOnce(
                path.join(dir, 'common.js'),
                /new Web3\((['"])http:\/\/127\.0\.0\.1:\d+\1\)/g,
                `new Web3("${parentUrl}")`,
                'parent RPC url',
            );
        }
    }

    /**
     * @private — rewrite `regex` → `replacement` in `file`, but only when the
     * pattern matches exactly once. Idempotent (no-op when already aligned) and
     * fully best-effort (any read/write problem is logged, never thrown).
     */
    async _patchOnce(file, regex, replacement, label) {
        const log = this.extensionHandle && this.extensionHandle.log;
        let text;
        try {
            text = await fs.promises.readFile(file, 'utf8');
        } catch (err) {
            if (log) {
                log.warn(`${ENM_LOG_PREFIX} ${this.chainId}: cannot read ${path.basename(file)} `
                    + `to align ${label} (${err.message}) — leaving oracle script as-is`);
            }
            return;
        }
        const matches = text.match(regex);
        if (!matches || matches.length !== 1) {
            if (log) {
                log.warn(`${ENM_LOG_PREFIX} ${this.chainId}: ${label} pattern matched `
                    + `${matches ? matches.length : 0}x in ${path.basename(file)} (expected 1) — `
                    + 'not patching; oracle keeps its hardcoded default');
            }
            return;
        }
        const next = text.replace(regex, replacement);
        if (next === text) { return; }   // already aligned — no-op
        try {
            await fs.promises.writeFile(file, next);
            if (log) {
                log.info(`${ENM_LOG_PREFIX} ${this.chainId}: aligned ${label} -> ${replacement}`);
            }
        } catch (err) {
            if (log) {
                log.warn(`${ENM_LOG_PREFIX} ${this.chainId}: failed writing ${label} to `
                    + `${path.basename(file)} (${err.message}) — oracle keeps its hardcoded default`);
            }
        }
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
        // Precondition only — the oracle relays to mainchain, so it must be
        // configured. (The URL is no longer passed as an env var; the script
        // reaches mainchain via its own bundled logic.)
        await this.resolveMainchainRpcUrl();
        // v0.5.172 (#2) — rewrite the oracle script's hardcoded listen port +
        // parent-RPC URL from ENM's config so ENM is authoritative (the script
        // reads no env vars for these). Best-effort; never blocks start.
        await this._alignScriptConfig(cfg, parentRpcUrl);
        cfg.spawnArgs = this.buildSpawnArgs(cfg);
        cfg.spawnEnv = this.buildEnv(cfg);
        return this.processService.start(this.chainId, cfg);
    }

    /**
     * Override health() — PID-based, mirroring node.sh's <x>-oracle_status
     * which only checks `pgrep -fx 'node crosschain_<x>.js'` (node.sh:3581).
     *
     * BUG-C13 (node.sh parity) — the upstream crosschain_<x>.js oracle is a
     * PLAIN Express server (it serves `POST /` on a HARD-CODED port, e.g.
     * 20632/20642/20672) and does NOT speak JSON-RPC. The previous
     * net_version probe therefore ALWAYS failed → rpcOk=false forever →
     * HealthChecker F2 (rpc-unreachable-while-alive) restart-looped a
     * perfectly healthy oracle, and the SIGTERM/respawn churn eventually
     * exhausted the restart budget and left it stopped (cycle-6 finding).
     * The probe also targeted cfg.ports.httpRpc, which on testnet was a
     * fictional `+1000` port the oracle never listens on. For an oracle,
     * process-alive IS the health signal — exactly node.sh's model. The
     * `cfg` arg is kept for signature parity with the base adapter.
     *
     * @param {object} cfg
     * @returns {Promise<{ alive: boolean, rpcOk: boolean, pid: number|null }>}
     */
    async health(cfg) {  // eslint-disable-line no-unused-vars
        const procStatus = this.processService.statusSync(this.chainId);
        if (!procStatus.alive) {
            return { alive: false, rpcOk: false, pid: null };
        }
        return { alive: true, rpcOk: true, pid: procStatus.pid };
    }

    /**
     * v0.5.168 (Phase 1) — oracles are stateless relayers with no chain of
     * their own (height/peers/synced stay null — the chain card already skips
     * the height block for class C). For hero context we surface the PARENT
     * EVM sidechain's current block height (e.g. esc for esc-oracle) so the
     * operator can see what the relayer is tracking. Best-effort: loads the
     * parent's RPC port and reads eth_blockNumber. Never throws.
     *
     * @param {object} cfg  (this oracle's chain config — unused; parent looked
     *                       up from the full ConfigStore by parentChainId)
     * @returns {Promise<{height:number|null, peers:number|null, networkHeight:number|null, synced:boolean|null, parentBlockHeight:number|null}>}
     */
    async primaryHeight(cfg) {  // eslint-disable-line no-unused-vars
        const out = {
            height: null, peers: null, networkHeight: null, synced: null, parentBlockHeight: null,
        };
        try {
            const full = await ConfigStore.load();
            const parent = full && full.chains && full.chains[this.parentChainId];
            if (parent && parent.ports && parent.ports.rpc) {
                const rpc = new EthRpcClient({ host: '127.0.0.1', port: parent.ports.rpc });
                const v = await rpc.getBlockNumber();
                if (typeof v === 'number') { out.parentBlockHeight = v; }
            }
        } catch (_) { /* parent RPC unreachable; parentBlockHeight stays null */ }
        return out;
    }
}

module.exports = OracleAdapter;
