/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EvmSidechainAdapter — Wave M3.1 (beta.3.95) — abstract base class
 * for the Elastos EVM PBFT sidechains (ESC, EID, PG — Class B per the
 * 5-class taxonomy in plan §2).
 *
 * WHY A SHARED BASE
 *
 * The three EVM sidechain binaries (esc, eid, pg) are all go-ethereum
 * forks with the same PBFT-on-mainchain-keystore architecture. They
 * differ in:
 *   - Binary name + chainId    (esc/eid/pg)
 *   - Display name + class label
 *   - Port number tuple        (per the audited Elastos docs)
 *   - Network ID / genesis hash for sanity checks
 *   - EID-specific: spvconfig.json materialization for testnet
 *   - PG-specific:  closed-source binary verification
 *
 * Everything else — spawn flag construction, PBFT-keystore wiring,
 * miner-address validation, RPC client construction, password-from-
 * mainchain-keystore decryption, start() lifecycle including pre-flight
 * keystore checks + UFW open + stdin password feed — is identical
 * across all three. M3.2 (EscAdapter / EidAdapter) and M5.1 (PgAdapter)
 * subclass this with minimal overrides.
 *
 * NODE.SH PARITY (per plan §17 Class B section + §4 anti-patterns)
 *
 * REPLICATED (operators expect these):
 *   - `--pbft.keystore ${SCRIPT_PATH}/ela/keystore.dat`
 *     The EVM sidechain's PBFT signing identity = the mainchain
 *     producer identity (node.sh:2144, 2218, 2289, 4382). H23 enforces
 *     "don't create separate per-chain PBFT keystores". We point at
 *     the mainchain keystore.dat via a stable path resolver — NOT a
 *     copy, NOT a symlink: a direct path reference. Reading is read-
 *     only from the child's perspective.
 *   - `--pbft.keystore.password <file>` — replaced with stdin-piped
 *     decrypted plaintext (the file pattern is the node.sh anti-
 *     pattern from H24; we decrypt + pipe at spawn time).
 *   - EVM keystore generation via the binary's own `account new` flow
 *     is handled by the M3.5 setup wizard (NOT by this adapter — the
 *     adapter assumes the keystore already exists at start time).
 *   - Per-chain data dir layout: chains/<chainId>/data/keystore/UTC--*
 *
 * DIVERGED (security/UX bugs ENM fixes):
 *   - No `--password "$(cat ...)"` in `ps auxw` — stdin only.
 *   - No `--allow-insecure-unlock` combined with external-bound RPC
 *     (H25). Default --http.addr is 127.0.0.1.
 *   - Strict miner-address validation (regex + EIP-55 warn) before
 *     accepting the operator's input — node.sh accepts "BANANA".
 *
 * SUBCLASS CONTRACT
 *
 * Each Class B subclass MUST provide:
 *   - chainId           (e.g. 'esc')
 *   - displayName       (e.g. 'Elastos Smart Chain')
 *   - binaryName        (e.g. 'esc')         — used by EnmBinaryDownloader
 *   - defaultRpcPort    (e.g. 20636 per docs)
 *   - chainIdValue      (e.g. 20 for ESC mainnet — the EIP-155 chain id)
 *   - generateExtraSpawnArgs(cfg, secrets)   — chain-specific flags
 *
 * Optionally override:
 *   - generateConfig(cfg, secrets) — most chains don't need an
 *     external config file; all knobs are CLI flags.
 *   - start(cfg) — only if pre-flight checks beyond the shared ones
 *     are required.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ChainAdapter = require('./ChainAdapter');
const { EthRpcClient } = require('./EthRpcClient');
const { ENM_LOG_PREFIX } = require('./EnmConstants');
const { chainDir } = require('./DataDir');
const ConfigStore = require('./ConfigStore');
const EnmCrypto = require('./EnmCrypto');
const EnmFirewallManager = require('./EnmFirewallManager');

// Standard subdirectory layout matching node.sh's per-chain conventions
// (build/skeleton/node.sh paths).
const PBFT_KEYSTORE_RELPATH = 'keystore.dat';          // inside mainchain chainDir
const EVM_KEYSTORE_RELPATH = path.join('data', 'keystore'); // inside this chain's chainDir
const DATA_RELPATH = 'data';

class EvmSidechainAdapter extends ChainAdapter {
    /**
     * @param {object} deps  forwarded to ChainAdapter base
     */
    constructor(deps) {
        super(deps);
    }

    // -------- Required subclass overrides (throws if not implemented) --------

    /** @returns {string} e.g. 'esc' */
    get chainId() {
        throw new Error('EvmSidechainAdapter: subclass must override chainId');
    }
    /** @returns {string} e.g. 'Elastos Smart Chain' */
    get displayName() {
        throw new Error('EvmSidechainAdapter: subclass must override displayName');
    }
    /** @returns {string} binary file name expected on disk (e.g. 'esc') */
    get binaryName() {
        throw new Error('EvmSidechainAdapter: subclass must override binaryName');
    }
    /** @returns {number} default RPC port for sanity-checking cfg.ports.rpc */
    get defaultRpcPort() {
        throw new Error('EvmSidechainAdapter: subclass must override defaultRpcPort');
    }
    /** @returns {number} EIP-155 chain id used for net_version sanity check */
    get chainIdValue() {
        throw new Error('EvmSidechainAdapter: subclass must override chainIdValue');
    }

    // -------- Implementations shared by all Class B chains --------

    /**
     * Class B is always 'B' per the canonical map. Override of
     * ChainAdapter's getter purely for explicit-is-better-than-implicit;
     * the base class would compute the same value via classOf().
     */
    get chainClass() { return 'B'; }
    /** Class B chains have no parent in the dependency DAG. */
    get parentChainId() { return null; }

    /**
     * Build an EthRpcClient pointing at this chain's HTTP-RPC port.
     * No HTTP Basic auth — geth doesn't use it; access control is
     * loopback-bind + UFW.
     *
     * @param {object} cfg
     * @returns {import('./EthRpcClient').EthRpcClient}
     */
    rpcClient(cfg) {
        if (!cfg || !cfg.ports || !cfg.ports.rpc) {
            throw new Error(
                `${this.chainId}: rpcClient called with cfg missing ports.rpc`,
            );
        }
        return new EthRpcClient({
            host: '127.0.0.1',
            port: cfg.ports.rpc,
        });
    }

    /**
     * Default: no external config file. ESC/EID/PG drive everything
     * from CLI flags so generateConfig returns null. EID's testnet
     * spvconfig.json is materialized separately by EidAdapter's
     * generateConfig override (M3.7).
     *
     * @param {object} cfg
     * @returns {object|null}
     */
    // eslint-disable-next-line no-unused-vars
    generateConfig(cfg) { return null; }

    /**
     * Subclass hook for per-chain spawn flags. The shared base assembles
     * the common geth flags (--datadir, --http, --pbft.keystore, etc.);
     * subclasses can append chain-specific flags (e.g. ESC sets
     * --escdata, EID sets --spvconfig).
     *
     * @param {object} cfg
     * @param {object} secrets  { mainchainKeystorePath: string }
     * @returns {string[]}
     */
    // eslint-disable-next-line no-unused-vars
    generateExtraSpawnArgs(cfg, secrets) { return []; }

    /**
     * Build the full geth-style argv for this chain. Pure helper; tested
     * in unit tests via _internal export below.
     *
     * Sample output for ESC mainnet (verbose form for readability):
     *   esc
     *     --datadir <chainDir>/data
     *     --networkid 20
     *     --port 20638
     *     --discovery.port 20630   (UDP)
     *     --http
     *     --http.addr 127.0.0.1
     *     --http.port 20636
     *     --http.api eth,net,web3,admin
     *       (`personal` deliberately omitted — H25 anti-pattern: it
     *        exposes personal_unlockAccount via RPC, which combined
     *        with an externally-bound listener would enable remote
     *        unlock. The code below at line ~227 enforces this default.)
     *     --pbft.keystore /<mainchainDir>/keystore.dat
     *     --pbft.ipaddress <externalIP>            (only if known)
     *     --pbft.dposport 20639
     *     --miner.etherbase <minerAddress>         (only when miner.enabled)
     *     --mine --miner.threads 1                  (only when miner.enabled)
     *     --unlock <evmKeystoreAddress>             (only when miner.enabled)
     *
     * Note we deliberately do NOT pass --allow-insecure-unlock (node.sh
     * anti-pattern from H25). --unlock requires --rpcaddr=127.0.0.1
     * which is the default; geth refuses --unlock with external RPC
     * unless --allow-insecure-unlock is set.
     *
     * @param {object} cfg
     * @param {object} secrets   { mainchainKeystorePath: string, externalIp?: string }
     * @returns {string[]}
     */
    buildSpawnArgs(cfg, secrets) {
        if (!cfg || !cfg.ports || !cfg.miner || !cfg.pbft) {
            throw new Error(
                `${this.chainId}: buildSpawnArgs requires cfg.{ports,miner,pbft}`,
            );
        }
        if (!secrets || typeof secrets.mainchainKeystorePath !== 'string') {
            throw new Error(
                `${this.chainId}: buildSpawnArgs requires secrets.mainchainKeystorePath`,
            );
        }
        const dataDir = path.join(chainDir(this.chainId), DATA_RELPATH);
        // 0.5.155 — BUG-C8 fix: the Elastos ESC/EID/PG binaries are an OLD
        // go-ethereum fork (Geth/v1.9.7.0-…) that uses LEGACY CLI flags, not
        // the modern --http* names. Pre-0.5.155 buildSpawnArgs passed
        // --http/--http.addr/--http.port/--http.api/--discovery.port/
        // --pbft.dposport/--pbft.ipaddress — none of which this binary
        // defines, so geth exited instantly with "flag provided but not
        // defined: -http" (code=1) and NO EVM sidechain could ever start.
        // Verified against `esc --help` on the live binary:
        //   --http*        → --rpc / --rpcaddr / --rpcport / --rpcapi
        //   --discovery.port → (none; old geth shares --port for TCP+UDP) → drop
        //   --pbft.dposport  → --pbft.net.port
        //   --pbft.ipaddress → --pbft.net.address
        // Confirmed: with these flags geth boots ("Started P2P networking",
        // "HTTP endpoint opened", "SPV Start Monitoring").
        const args = [
            '--datadir', dataDir,
            '--networkid', String(this.chainIdValue),
            '--port', String(cfg.ports.p2p),
            // HTTP-RPC: loopback only by default (H25). Legacy --rpc* flag
            // names — this geth fork predates the --http* rename.
            '--rpc',
            '--rpcaddr', '127.0.0.1',
            '--rpcport', String(cfg.ports.rpc),
            '--rpcapi', cfg.rpcApis || 'eth,net,web3,admin',
            // No separate discovery-port flag in this geth fork; UDP discovery
            // shares the TCP --port above (cfg.ports.discovery is reserved for
            // future use / firewall rules, not a geth CLI arg here).
            // PBFT keystore: ALWAYS points at the mainchain keystore.dat
            // (H23 / node.sh:2144). Subclasses cannot override this.
            '--pbft.keystore', secrets.mainchainKeystorePath,
            '--pbft.net.port', String(cfg.ports.dpos),
        ];
        if (secrets.externalIp) {
            args.push('--pbft.net.address', secrets.externalIp);
        }
        // Sync mode: 'fast' / 'full' / 'archive'. node.sh default is 'fast'.
        if (cfg.sync && cfg.sync.mode) {
            args.push('--syncmode', cfg.sync.mode);
        }
        // Miner — only enabled when the operator opted in (sidechain is
        // producing for rewards). All three values are operator-supplied:
        //   miner.enabled         → enable mining at all
        //   miner.rewardAddress   → --miner.etherbase (where rewards go)
        //   miner.threads         → --miner.threads (default 1)
        //   miner.evmKeystoreAddr → --unlock (which EVM keystore unlocks)
        if (cfg.miner.enabled === true) {
            if (!cfg.miner.rewardAddress) {
                throw new Error(
                    `${this.chainId}: miner.enabled=true but miner.rewardAddress not set. `
                    + 'Set it in Settings → Mining & Rewards before starting.',
                );
            }
            args.push('--miner.etherbase', cfg.miner.rewardAddress);
            args.push('--mine');
            args.push('--miner.threads', String(cfg.miner.threads || 1));
            if (cfg.miner.evmKeystoreAddr) {
                args.push('--unlock', cfg.miner.evmKeystoreAddr);
            }
        }
        // Subclass-provided extras (e.g. EID --spvconfig).
        const extras = this.generateExtraSpawnArgs(cfg, secrets);
        if (Array.isArray(extras)) {
            for (const a of extras) {
                if (typeof a !== 'string') {
                    throw new TypeError(
                        `${this.chainId}: generateExtraSpawnArgs returned non-string: ${typeof a}`,
                    );
                }
                args.push(a);
            }
        }
        return args;
    }

    /**
     * Resolve the absolute path to the mainchain keystore.dat. EVM
     * sidechain spawn requires this (--pbft.keystore points here). If
     * the mainchain isn't installed the EVM chain can't start; surface
     * a clear pre-flight error rather than letting the spawn fail
     * mysteriously.
     *
     * @returns {string} absolute path
     * @throws {Error} when keystore.dat doesn't exist
     */
    resolveMainchainKeystorePath() {
        const p = path.join(chainDir('mainchain'), PBFT_KEYSTORE_RELPATH);
        if (!fs.existsSync(p)) {
            throw new Error(
                `${this.chainId}: PBFT keystore (mainchain keystore.dat) not found at ${p}. `
                + 'Install + complete the mainchain BPoS setup before starting this chain.',
            );
        }
        return p;
    }

    /**
     * Read + decrypt the mainchain's keystore password. EVM sidechains
     * use the same password to unlock --pbft.keystore (it's the same
     * file). Decrypted plaintext is piped to the child's stdin at spawn
     * time; we never write it back to disk.
     *
     * @returns {Promise<string>} plaintext password
     * @throws {Error} when mainchain cfg missing or decrypt fails
     */
    async readMainchainKeystorePassword() {
        const cfg = await ConfigStore.load();
        const main = cfg && cfg.chains && cfg.chains.mainchain;
        if (!main || !main.dpos || !main.dpos.keystorePasswordEncrypted) {
            throw new Error(
                `${this.chainId}: mainchain keystore password not on file. `
                + 'The PBFT signing flow requires the mainchain keystore to be configured first.',
            );
        }
        try {
            return EnmCrypto.decrypt(main.dpos.keystorePasswordEncrypted);
        } catch (err) {
            throw new Error(
                `${this.chainId}: cannot decrypt mainchain keystore password: ${err.message}. `
                + 'Re-enter the mainchain keystore password in Settings → Identity.',
            );
        }
    }

    /**
     * Class B start() lifecycle:
     *   1. Verify binary present (ChainState reuse left for M3.8 — for
     *      M3.1 we trust cfg.binaryPath since the adapter is base-only
     *      and the install path lands in M3.8).
     *   2. Verify mainchain keystore.dat exists (--pbft.keystore target).
     *   3. Verify EVM keystore directory exists (--unlock target if
     *      miner.enabled). Skip when miner.enabled=false.
     *   4. Decrypt the mainchain keystore password.
     *   5. Compute spawn args via buildSpawnArgs.
     *   6. Open UFW for this chain's P2P + discovery ports.
     *   7. Pass cfg.spawnArgs into NativeProcessService.start.
     *   8. Pipe the decrypted password into child stdin so geth can
     *      unlock the PBFT keystore (replaces node.sh's --pbft.keystore.
     *      password file pattern from H24).
     *
     * Pre-flight failures throw with actionable messages so the route
     * handler can surface them to the operator UI rather than a generic
     * 500.
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
                `${this.chainId}: binary not found at ${cfg.binaryPath}. `
                + 'Run the install step in the setup wizard.',
            );
        }
        // Step 2 — mainchain keystore.dat must exist.
        const mainchainKeystorePath = this.resolveMainchainKeystorePath();

        // Step 3 — EVM keystore dir + unlock address present when miner enabled.
        if (cfg.miner && cfg.miner.enabled === true) {
            const evmKeystoreDir = path.join(chainDir(this.chainId), EVM_KEYSTORE_RELPATH);
            if (!fs.existsSync(evmKeystoreDir)) {
                throw new Error(
                    `${this.chainId}: mining is enabled but the EVM keystore directory is `
                    + `missing (${evmKeystoreDir}). Create or import an EVM account via `
                    + 'the setup wizard before starting in miner mode.',
                );
            }
        }
        // Step 4 — mainchain password decryption (raises with friendly message).
        const pbftPassword = await this.readMainchainKeystorePassword();

        // Step 5 — spawn args.
        const externalIp = (cfg.pbft && cfg.pbft.ipAddress) || null;
        cfg.spawnArgs = this.buildSpawnArgs(cfg, {
            mainchainKeystorePath,
            externalIp,
        });

        // Step 6 — UFW for P2P (TCP) + discovery (UDP) + dpos (TCP).
        // RPC port intentionally NOT opened (loopback-only per H25).
        try {
            await EnmFirewallManager.ensureAllowed(
                [cfg.ports.p2p, cfg.ports.dpos],
                {
                    comment: `${this.chainId} P2P/DPoS (ENM auto)`,
                    logger: this.extensionHandle && this.extensionHandle.log,
                },
            );
        } catch (err) {
            // Non-fatal: chain still starts; F18 will fire later if
            // inbound stays 0 because UFW is blocking.
            if (this.extensionHandle && this.extensionHandle.log) {
                this.extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} ${this.chainId} firewall preflight failed: ${err.message}`,
                );
            }
        }

        // Step 7 — spawn via NativeProcessService (chain-id-keyed lock).
        const result = await this.processService.start(this.chainId, cfg);
        if (result.alreadyRunning) {
            return result;
        }

        // Step 8 — stdin password feed. geth reads the --pbft.keystore
        // password from stdin in our adapter's invocation (because we
        // didn't pass --pbft.keystore.password <file>). Two consecutive
        // newlines because geth's prompts emit "password:\n" twice when
        // unlock is also enabled (once for PBFT, once for the EVM
        // keystore — they MUST match per H24 password-strategy).
        const wrote = this.processService.writeStdin(this.chainId, pbftPassword);
        if (!wrote) {
            // Kill the orphan so the operator doesn't see a "healthy"
            // chain hanging forever on a password prompt — same shape
            // as ElaMainChainAdapter's beta.3.50 fix.
            try { await this.processService.stop(this.chainId); }
            catch (_) { /* best-effort cleanup */ }
            throw new Error(
                `${this.chainId}: failed to feed PBFT keystore password to child stdin. `
                + 'Try Restart on the chain card; if it persists, file an issue with the most recent enm-server logs.',
            );
        }
        // If miner is enabled, geth will prompt a SECOND time for the
        // EVM keystore password. Per the Layer 1 wizard (M3.4) we use
        // either a shared password or per-chain — both surface through
        // cfg.miner.evmKeystorePasswordEncrypted. Decrypt + pipe.
        if (cfg.miner && cfg.miner.enabled === true) {
            const envelope = cfg.miner && cfg.miner.evmKeystorePasswordEncrypted;
            if (!envelope) {
                try { await this.processService.stop(this.chainId); }
                catch (_) { /* best-effort cleanup */ }
                throw new Error(
                    `${this.chainId}: miner.enabled=true but EVM keystore password missing. `
                    + 'Re-enter via Settings → Mining & Rewards.',
                );
            }
            let evmPlaintext;
            try {
                evmPlaintext = EnmCrypto.decrypt(envelope);
            } catch (err) {
                try { await this.processService.stop(this.chainId); }
                catch (_) { /* best-effort cleanup */ }
                throw new Error(
                    `${this.chainId}: cannot decrypt EVM keystore password: ${err.message}. `
                    + 'Re-enter via Settings → Mining & Rewards.',
                );
            }
            const wrote2 = this.processService.writeStdin(this.chainId, evmPlaintext);
            if (!wrote2) {
                try { await this.processService.stop(this.chainId); }
                catch (_) { /* best-effort cleanup */ }
                throw new Error(
                    `${this.chainId}: failed to feed EVM keystore password to child stdin.`,
                );
            }
        }
        return result;
    }
}

module.exports = EvmSidechainAdapter;
// Exported for tests.
module.exports._internal = {
    PBFT_KEYSTORE_RELPATH,
    EVM_KEYSTORE_RELPATH,
    DATA_RELPATH,
};
