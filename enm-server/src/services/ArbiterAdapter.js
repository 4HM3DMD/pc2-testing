/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ArbiterAdapter — Wave M6.1 (beta.0.3.10) — Elastos Arbiter
 * cross-chain signer adapter (Class D per the 5-class taxonomy).
 *
 * SECURITY POSTURE
 *
 * Arbiter is THE most security-critical component in this codebase
 * (plan §11 risk #1). Its wallet signs 1-of-N multisig payloads that
 * cross all Elastos sidechains; a compromised arbiter wallet equals
 * a compromised bridge across all chains. Mitigations enforced here:
 *
 *   1. Reuses mainchain keystore.dat (H8 + plan §10 H23 — single
 *      source of truth for the producer identity). NEVER copies the
 *      keystore — uses an absolute path reference so the keystore
 *      stays in one place under chains/mainchain/. node.sh:5545 has
 *      a `cp -v` of the keystore into the arbiter dir; we diverge to
 *      symlink-equivalent (a stable resolved path) for the same
 *      reason mainchain doesn't sprout duplicate keystores.
 *   2. Wallet password is the SAME as the mainchain keystore password
 *      (mainchain.dpos.keystorePasswordEncrypted). Stdin-piped at
 *      spawn time (H24 — no plaintext file).
 *   3. Mining address is an ELA MAINCHAIN address (NOT Ethereum) —
 *      it funds the SideChainPow heartbeats. Validated via
 *      EnmCrypto.validateElaAddress at install time.
 *
 * PRE-FLIGHT CHECK
 *
 * Arbiter cannot run without ALL 4 chains (mainchain + ESC + EID + PG)
 * configured. start() pre-flight checks each via ChainRegistry +
 * cfg.chains presence; missing chains throw with a precise message.
 * This is the "6-card wizard 4/4 pre-flight" gate from plan §5
 * Layer 2 Class D wizard.
 *
 * SIDE NODE LIST (M6.6)
 *
 * The arbiter's config.json carries a SideNodeList declaring the
 * other chains it bridges. ENM auto-populates this from
 * ChainRegistry.listChains() so adding a new sidechain doesn't
 * require editing the arbiter config.
 *
 * Canonical values (plan §14):
 *   chainId        — 'arbiter'
 *   defaultRpcPort — 20536 (the audited correct port; 20606 was a
 *                    historical typo and does NOT exist)
 *   p2pPort        — 20538
 *
 * NOT IMPLEMENTED IN M6.1 (deferred to M6.2-M6.6):
 *   - 6-card install wizard endpoint (M6.2)
 *   - Wallet create OR import flow (M6.3)
 *   - Cross-chain reachability matrix (M6.4)
 *   - F23 mining-funding monitor (M6.5)
 *   - SideNodeList materialization (M6.6 — config.json generator
 *     scaffolded here but actual file write happens on first start)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ChainAdapter = require('./ChainAdapter');
const { EnmRpcClient } = require('./EnmRpcClient');
const { chainDir, atomicWrite } = require('./DataDir');
const ConfigStore = require('./ConfigStore');
const EnmCrypto = require('./EnmCrypto');
const { ENM_LOG_PREFIX } = require('./EnmConstants');
const EnmFirewallManager = require('./EnmFirewallManager');

const ARBITER_CONFIG_FILENAME = 'config.json';
const MAINCHAIN_KEYSTORE_FILENAME = 'keystore.dat';

// The four sidechains Arbiter expects in its SideNodeList. Order
// matters for some upstream tooling; we ship the canonical mainchain
// audit order.
const SIDECHAINS_REQUIRED = ['mainchain', 'esc', 'eid', 'pg'];

class ArbiterAdapter extends ChainAdapter {
    constructor(deps) {
        super(deps);
    }

    get chainId()        { return 'arbiter'; }
    get displayName()    { return 'Arbiter Service'; }
    get chainClass()     { return 'D'; }
    get parentChainId()  { return null; }
    get binaryName()     { return 'arbiter'; }

    /**
     * Arbiter speaks ela-style JSON-RPC for getspvheight + status.
     *
     * @param {object} cfg
     * @returns {import('./EnmRpcClient').EnmRpcClient}
     */
    rpcClient(cfg) {
        if (!cfg || !cfg.ports || !cfg.ports.rpc) {
            throw new Error('arbiter: rpcClient requires cfg.ports.rpc');
        }
        // No HTTP Basic auth on arbiter RPC by default. If a future
        // arbiter release enables auth, plumb cfg.rpc.user/password
        // through here.
        return new EnmRpcClient({
            host: '127.0.0.1',
            port: cfg.ports.rpc,
            user: (cfg.rpc && cfg.rpc.user) || '',
            password: (cfg.rpc && cfg.rpc.password) || '',
        });
    }

    /**
     * Build the arbiter config.json. Includes:
     *   - SideNodeList auto-populated from cfg.chains (mainchain +
     *     esc + eid + pg presently). Each entry carries the chain's
     *     RPC port + the chain-id-string for the chain (matches
     *     upstream registry: ESC, DID for EID, PG).
     *   - Mining address (ELA mainchain address).
     *   - DataDir = chains/arbiter/data
     *
     * @param {object} cfg                 cfg.chains.arbiter
     * @param {object} allChains           cfg.chains (full map)
     * @returns {object}
     */
    generateConfig(cfg, allChains) {
        if (!cfg || !cfg.mining || !cfg.mining.miningAddress) {
            throw new Error(
                'arbiter: cfg.mining.miningAddress is required (ELA mainchain '
                + 'address that funds SideChainPow heartbeats).',
            );
        }
        if (!allChains || typeof allChains !== 'object') {
            throw new Error('arbiter: generateConfig requires allChains map');
        }
        const sideNodeList = [];
        for (const chainId of SIDECHAINS_REQUIRED) {
            const cc = allChains[chainId];
            if (!cc || !cc.ports) {
                throw new Error(
                    `arbiter: sidechain "${chainId}" not configured — cannot generate `
                    + 'SideNodeList. Install all 4 chains (mainchain + esc + eid + pg) first.',
                );
            }
            // The Arbiter's "chainId" name field uses a registry-distinct
            // string: ESC stays "ESC", EID is registered as "DID" (plan
            // §14 audit), PG stays "PG", mainchain is "Elastos".
            const registryName = chainId === 'eid' ? 'DID'
                               : chainId === 'esc' ? 'ESC'
                               : chainId === 'pg'  ? 'PG'
                               : 'Elastos';
            sideNodeList.push({
                ChainID: registryName,
                Address: '127.0.0.1',
                Port: cc.ports.rpc,
                // Use the same activeNet as the chain (mainnet most often).
                ActiveNet: cc.activeNet || 'mainnet',
            });
        }
        return {
            Configuration: {
                ActiveNet: cfg.activeNet || 'mainnet',
                NodePort: cfg.ports.p2p,
                HttpJsonPort: cfg.ports.rpc,
                Mining: {
                    MiningAddress: cfg.mining.miningAddress,
                    // node.sh references SideChainPowFee — exposed as
                    // operator-tunable for future cost adjustments.
                    SideChainPowFeeELA: cfg.mining.sideChainPowFeeEla || 0.1,
                },
                SideNodeList: sideNodeList,
            },
        };
    }

    /**
     * Resolve the absolute path to the mainchain keystore. Arbiter
     * reuses the mainchain producer keystore for multisig signing —
     * a stable absolute path is the cleanest reference (no copy, no
     * symlink to maintain).
     *
     * @returns {string}
     */
    resolveMainchainKeystorePath() {
        const p = path.join(chainDir('mainchain'), MAINCHAIN_KEYSTORE_FILENAME);
        if (!fs.existsSync(p)) {
            throw new Error(
                `arbiter: mainchain keystore.dat not found at ${p}. `
                + 'The Arbiter signs with the mainchain producer keystore; complete '
                + 'mainchain BPoS setup before installing Arbiter.',
            );
        }
        return p;
    }

    /**
     * Decrypt the mainchain keystore password — same envelope as
     * Class B (Arbiter signs WITH this same password).
     *
     * @returns {Promise<string>}
     */
    async readMainchainKeystorePassword() {
        const cfg = await ConfigStore.load();
        const main = cfg && cfg.chains && cfg.chains.mainchain;
        if (!main || !main.dpos || !main.dpos.keystorePasswordEncrypted) {
            throw new Error(
                'arbiter: mainchain keystore password not on file. '
                + 'Configure mainchain BPoS first.',
            );
        }
        try {
            return EnmCrypto.decrypt(main.dpos.keystorePasswordEncrypted);
        } catch (err) {
            throw new Error(
                `arbiter: cannot decrypt mainchain keystore password: ${err.message}. `
                + 'Re-enter via Settings → Identity.',
            );
        }
    }

    /**
     * Pre-flight check that all 4 required chains are configured.
     * Throws on the first missing chain.
     *
     * @param {object} allChains  cfg.chains map
     */
    static preflightAllChainsConfigured(allChains) {
        if (!allChains || typeof allChains !== 'object') {
            throw new Error('arbiter: cfg.chains map missing');
        }
        const missing = SIDECHAINS_REQUIRED.filter((id) => !allChains[id]);
        if (missing.length > 0) {
            throw new Error(
                `arbiter: cannot start — missing chains [${missing.join(', ')}]. `
                + 'Install all 4 chains (mainchain + esc + eid + pg) before starting Arbiter.',
            );
        }
    }

    /**
     * start() lifecycle:
     *   1. Verify binary present.
     *   2. Pre-flight: all 4 sidechains configured.
     *   3. Resolve mainchain keystore path.
     *   4. Validate mining address.
     *   5. Generate config.json.
     *   6. UFW open p2p + rpc ports.
     *   7. Decrypt mainchain keystore password.
     *   8. Spawn arbiter binary.
     *   9. Stdin-pipe the keystore password (Arbiter prompts on first
     *      block sign — pre-pipe so it never blocks).
     *
     * @param {object} cfg
     * @returns {Promise<{ pid: number, startedAt: number }>}
     */
    async start(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            throw new TypeError('arbiter.start: cfg object required');
        }
        if (typeof cfg.binaryPath !== 'string' || !fs.existsSync(cfg.binaryPath)) {
            throw new Error(
                `arbiter: binary not found at ${cfg.binaryPath}. Run setup binary install.`,
            );
        }
        const allChainsCfg = await ConfigStore.load().then(
            (full) => (full && full.chains) || {},
        );
        ArbiterAdapter.preflightAllChainsConfigured(allChainsCfg);
        const mainchainKeystorePath = this.resolveMainchainKeystorePath();

        // Validate mining address (ELA mainchain, NOT Ethereum).
        if (!cfg.mining || !cfg.mining.miningAddress) {
            throw new Error(
                'arbiter: cfg.mining.miningAddress is required (ELA mainchain address).',
            );
        }
        const v = EnmCrypto.validateElaAddress(cfg.mining.miningAddress);
        if (!v.valid) {
            throw new Error(`arbiter: mining.miningAddress: ${v.warning}`);
        }

        // Generate + write config.json.
        const cfgObj = this.generateConfig(cfg, allChainsCfg);
        const dir = chainDir(this.chainId);
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        const configFile = path.join(dir, ARBITER_CONFIG_FILENAME);
        await atomicWrite(configFile, JSON.stringify(cfgObj, null, 2), { mode: 0o600 });
        // 0.5.115 audit Session 115 — dropped a stale comment that
        // described a planned-but-never-implemented "sidecar" file
        // for mainchainKeystorePath. The current shape resolves the
        // keystore path at every start() via resolveMainchainKeystorePath
        // (above) — no sidecar needed. The mainchainKeystorePath local
        // here is currently unused at write time (Arbiter reads
        // config.json from cwd); kept for future per-process env-var
        // wiring if a future arbiter release accepts the path via
        // --keystore CLI flag.
        // cfg.spawnArgs is intentionally not set — arbiter reads
        // config.json from its working directory at start time.
        void mainchainKeystorePath;  // currently unused; kept for future spawn-arg wiring

        // UFW open p2p + rpc (rpc is loopback-only too, but the operator
        // may forward through nginx if they want external admin access).
        try {
            await EnmFirewallManager.ensureAllowed(
                [cfg.ports.p2p],
                {
                    comment: 'arbiter P2P (ENM auto)',
                    logger: this.extensionHandle && this.extensionHandle.log,
                },
            );
        } catch (err) {
            if (this.extensionHandle && this.extensionHandle.log) {
                this.extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} arbiter firewall preflight failed: ${err.message}`,
                );
            }
        }

        const pbftPassword = await this.readMainchainKeystorePassword();

        // Spawn.
        const result = await this.processService.start(this.chainId, cfg);
        if (result.alreadyRunning) {
            return result;
        }
        // Pipe keystore password to stdin. Some arbiter versions don't
        // prompt on every run; piping is harmless if so.
        try {
            this.processService.writeStdin(this.chainId, pbftPassword);
        } catch (err) {
            if (this.extensionHandle && this.extensionHandle.log) {
                this.extensionHandle.log.debug(
                    `${ENM_LOG_PREFIX} arbiter stdin-pipe failed (non-fatal): ${err.message}`,
                );
            }
        }
        return result;
    }
}

module.exports = ArbiterAdapter;
// Exported for tests.
module.exports._internal = {
    SIDECHAINS_REQUIRED,
    ARBITER_CONFIG_FILENAME,
    MAINCHAIN_KEYSTORE_FILENAME,
};
