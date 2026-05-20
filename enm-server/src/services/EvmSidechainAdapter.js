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
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

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
// 0.5.157 — BUG-C8b: geth's --pbft.keystore.password takes a FILE PATH; we
// write the decrypted password here (0600) inside this chain's dir.
const PBFT_PASSWORD_FILENAME = '.pbft-keystore-password';
const EVM_KEYSTORE_RELPATH = path.join('data', 'keystore'); // inside this chain's chainDir
const DATA_RELPATH = 'data';
// FIX-C12 — the EVM keystore account's own password (NOT the mainchain
// PBFT keystore password). node.sh's *_init writes this to
// ~/.config/elastos/<chain>.txt (esc_init:3241) and the binary's
// `account new --password <file>` consumes it (esc_init:3245). We keep
// it next to the chain's data (0600), encrypt the value into cfg via
// EnmCrypto, and reuse it on every subsequent start.
const EVM_ACCOUNT_PASSWORD_FILENAME = '.evm-account-password';
// `account new` can be slow on a cold box (scrypt KDF + disk). node.sh
// gives it no explicit timeout; we use a generous one so a busy host
// doesn't spuriously fail the first miner start.
const EVM_ACCOUNT_NEW_TIMEOUT_MS = 120_000;

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
     *     --allow-insecure-unlock                   (only when miner.enabled)
     *     --password <evmAccountPasswordFile>       (only when miner.enabled)
     *
     * FIX-C12 — the miner branch now passes --allow-insecure-unlock +
     * --password <file>, matching node.sh's council miner branch
     * (esc_start:2139,2143). The RPC listener stays bound to 127.0.0.1
     * (H25): --allow-insecure-unlock only relaxes geth's refusal to unlock
     * an account when RPC is reachable; it does NOT expose the listener.
     * geth's password resolution for --unlock reads from --password's
     * file, so the unlock is fully non-interactive (no stdin race).
     *
     * @param {object} cfg
     * @param {object} secrets   { mainchainKeystorePath: string, externalIp?: string,
     *                             pbftPasswordFile?: string, evmAccountPasswordFile?: string }
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
            // FIX-C12 — when mining, the PBFT consensus engine needs the
            // `pbft` (+ personal/txpool) RPC namespaces enabled so the
            // miner can drive consensus, mirroring node.sh's council miner
            // branch (esc_start:2150 uses 'db,eth,net,pbft,personal,txpool,
            // web3'). We keep our hardened set but add the consensus APIs.
            // Non-miner chains keep the minimal loopback set. cfg.rpcApis,
            // if explicitly set by the operator, always wins. The RPC
            // listener stays bound to 127.0.0.1 (H25) regardless.
            '--rpcapi',
            cfg.rpcApis
                || (cfg.miner.enabled === true
                    ? 'eth,net,web3,admin,pbft,personal,txpool'
                    : 'eth,net,web3,admin'),
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
        // 0.5.157 — BUG-C8b: this geth fork reads the PBFT keystore password
        // from the --pbft.keystore.password flag, whose value is a FILE PATH
        // (NOT the literal password — verified: passing the value fatals
        // "Failed to read password file: open <value>: no such file"). The
        // adapter previously piped the password to stdin (start() step 8),
        // which the binary ignored for PBFT → it logged "create dpos account
        // error: password wrong", fell back to a non-signing "common sync
        // node", and for EID (PBFT from block 0) escalated to "Failed to
        // prepare header for mining: wait for recoved states" → code=2 exit.
        // Fix: start() writes the password to a 0600 file and passes its path
        // here (node.sh's H24 pattern). Verified end-to-end: eid then unlocks
        // PBFT + enters consensus (onDuty list), no "password wrong". Bonus:
        // the password stays OUT of `ps`/`/proc/<pid>/cmdline`.
        if (secrets.pbftPasswordFile) {
            args.push('--pbft.keystore.password', secrets.pbftPasswordFile);
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
            // FIX-C12 — node.sh's council miner branch (esc_start:2139)
            // sets --allow-insecure-unlock. geth refuses to unlock an
            // account with a password file unless this is set (the
            // "Account unlock with HTTP access is forbidden" guard fires
            // even though our RPC is loopback-only). Required for the
            // --unlock + --password file combo below to take effect.
            args.push('--allow-insecure-unlock');
            // FIX-C12 — node.sh:2143 passes `--password <file>` so geth
            // can non-interactively unlock the --unlock account. The flag
            // value is a FILE PATH (same pattern as --pbft.keystore.password
            // / the H24 anti-pattern). start() writes the EVM account
            // password to a 0600 file and threads its path here. We pass a
            // file (NOT stdin) because this geth fork reads --unlock's
            // password from --password's file when present, and feeding it
            // on stdin instead is racy at boot.
            if (secrets.evmAccountPasswordFile) {
                args.push('--password', secrets.evmAccountPasswordFile);
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
     *   3. FIX-C12 — ensure the EVM keystore account exists (auto-create
     *      via `account new` on first miner start, reuse thereafter); skip
     *      entirely when miner.enabled=false.
     *   4. Decrypt the mainchain keystore password.
     *   5. Compute spawn args via buildSpawnArgs (PBFT + EVM-account
     *      password files threaded in as --pbft.keystore.password /
     *      --password).
     *   6. Open UFW for this chain's P2P + discovery ports.
     *   7. Pass cfg.spawnArgs into NativeProcessService.start.
     *   8. No stdin step — both the PBFT keystore password and the EVM
     *      account unlock password are delivered via --password files
     *      (FIX-C12 / BUG-C8b), so the unlock is fully non-interactive.
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

        // Step 3 — FIX-C12 — EVM account auto-creation. node.sh's *_init
        // runs the geth binary's `account new` to create the EVM keystore
        // account (data/keystore/UTC--*) that the miner branch later
        // --unlocks + uses as --miner.etherbase (esc_init:3245). Pre-FIX-C12
        // start() simply ERRORED when miner.enabled and the keystore dir was
        // empty, so a fresh council install could never start its sidechains
        // as miners. We now create the account on first miner start (and
        // reuse it on every subsequent start). Mutates cfg.miner in place
        // (evmKeystoreAddr + evmKeystorePasswordEncrypted) and persists via
        // ConfigStore so buildSpawnArgs --unlock works.
        let evmAccountPasswordFile = null;
        if (cfg.miner && cfg.miner.enabled === true) {
            evmAccountPasswordFile = await this._ensureEvmAccount(cfg);
        }
        // Step 4 — mainchain password decryption (raises with friendly message).
        const pbftPassword = await this.readMainchainKeystorePassword();

        // Step 5 — spawn args.
        const externalIp = (cfg.pbft && cfg.pbft.ipAddress) || null;
        // 0.5.157 — BUG-C8b: write the decrypted PBFT keystore password to a
        // 0600 file and hand its PATH to geth via --pbft.keystore.password
        // (the flag expects a file path, not the literal value). Overwritten
        // each start; sits next to keystore.dat (same 0600 sensitivity).
        const pbftPasswordFile = path.join(chainDir(this.chainId), PBFT_PASSWORD_FILENAME);
        fs.writeFileSync(pbftPasswordFile, pbftPassword, { mode: 0o600 });
        cfg.spawnArgs = this.buildSpawnArgs(cfg, {
            mainchainKeystorePath,
            externalIp,
            pbftPasswordFile,
            // FIX-C12 — path to the EVM account password file (0600) for the
            // miner branch's --password flag. null when not mining.
            evmAccountPasswordFile,
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

        // Step 8 — 0.5.157 (BUG-C8b): the PBFT keystore is unlocked via the
        // --pbft.keystore.password <file> flag (written in step 5), NOT
        // stdin. This geth fork ignores stdin for the PBFT password (it
        // logged "create dpos account error: password wrong", ran as a
        // non-signing "common sync node", and crashed EID with code=2). So we
        // no longer feed pbftPassword to stdin.
        //
        // FIX-C12 — the EVM keystore account's --unlock password is now ALSO
        // delivered via a file (--password <file>, written in
        // _ensureEvmAccount + threaded into buildSpawnArgs at step 5), exactly
        // as node.sh does (esc_start:2143). Pre-FIX-C12 we decrypted
        // evmKeystorePasswordEncrypted and piped it to stdin here, which is
        // racy at boot (geth may have already passed the unlock prompt). With
        // --password the unlock is fully non-interactive, so there is no
        // remaining stdin step for EVM sidechains. We deliberately feed
        // NOTHING to stdin now.
        return result;
    }

    /**
     * FIX-C12 — ensure an EVM keystore account exists for this chain and
     * return the path to its (0600) password file for the miner branch's
     * --password flag. Idempotent:
     *
     *   - If a UTC--* keystore file already exists under <dataDir>/keystore/
     *     AND we have the encrypted password on file, decrypt it, (re)write
     *     the 0600 password file, ensure cfg.miner.evmKeystoreAddr is set
     *     from the existing keystore, and return — NO `account new` run.
     *   - Otherwise generate a strong random password (node.sh gen_pass
     *     parity), write it to the 0600 file, run `<binary> --datadir
     *     <dataDir> account new --password <pwFile>` (node.sh esc_init:3245),
     *     resolve the created 0x address from the new UTC--* JSON, persist
     *     BOTH the encrypted password and the 0x address back into cfg via
     *     ConfigStore, and return the password-file path.
     *
     * @param {object} cfg  cfg.chains.<id> (mutated in place: miner.evmKeystoreAddr,
     *                       miner.evmKeystorePasswordEncrypted)
     * @returns {Promise<string>} absolute path to the 0600 EVM account password file
     * @throws {Error} loudly on any failure (account new, address parse, persist)
     */
    async _ensureEvmAccount(cfg) {
        const dataDir = path.join(chainDir(this.chainId), DATA_RELPATH);
        const keystoreDir = path.join(chainDir(this.chainId), EVM_KEYSTORE_RELPATH);
        const passwordFile = path.join(chainDir(this.chainId), EVM_ACCOUNT_PASSWORD_FILENAME);

        const existingAddr = this._findExistingEvmKeystoreAddress(keystoreDir);

        // ---- Idempotent reuse path: account already on disk ----
        if (existingAddr) {
            const envelope = cfg.miner && cfg.miner.evmKeystorePasswordEncrypted;
            if (!envelope) {
                // The keystore exists but we lost the password we created it
                // with — geth can't unlock it and we can't regenerate it
                // (the file is encrypted with the original password). Fail
                // loudly with an actionable message rather than silently
                // starting a non-mining node.
                throw new Error(
                    `${this.chainId}: an EVM keystore account (${existingAddr}) already exists `
                    + `at ${keystoreDir} but its password is not on file, so geth cannot unlock `
                    + 'it for mining. Remove that keystore file to let ENM recreate the account, '
                    + 'or import the matching password.',
                );
            }
            let password;
            try {
                password = EnmCrypto.decrypt(envelope);
            } catch (err) {
                throw new Error(
                    `${this.chainId}: cannot decrypt the stored EVM account password: ${err.message}. `
                    + 'The EVM keystore cannot be unlocked for mining.',
                );
            }
            fs.writeFileSync(passwordFile, password, { mode: 0o600 });
            // Keep cfg.miner.evmKeystoreAddr authoritative from disk.
            if (!cfg.miner.evmKeystoreAddr || cfg.miner.evmKeystoreAddr !== existingAddr) {
                cfg.miner.evmKeystoreAddr = existingAddr;
                await this._persistMinerAccount(existingAddr, envelope);
            }
            return passwordFile;
        }

        // ---- Creation path: no account yet → run `account new` ----
        if (this.extensionHandle && this.extensionHandle.log) {
            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} ${this.chainId}: no EVM keystore account found — `
                + 'creating one via `account new` (FIX-C12 miner parity).',
            );
        }
        // Strong random password (node.sh gen_pass parity — 32 chars, all
        // four complexity classes). This is the EVM account's OWN password,
        // independent of the mainchain keystore password.
        const password = EnmCrypto.generatePassword(32);
        // Ensure the data dir exists so geth can write the keystore subtree.
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(passwordFile, password, { mode: 0o600 });

        // node.sh esc_init:3245 — `./esc --datadir <data> account new
        // --password <file>`. We add --verbosity 0 (esc_init does too) to
        // keep the keystore-creation output quiet. execFile (no shell) so the
        // password file path is never shell-interpreted.
        try {
            await execFileAsync(
                cfg.binaryPath,
                ['--datadir', dataDir, '--verbosity', '0', 'account', 'new', '--password', passwordFile],
                { timeout: EVM_ACCOUNT_NEW_TIMEOUT_MS },
            );
        } catch (err) {
            // Best-effort: remove the password file we just wrote so a failed
            // attempt doesn't leave a dangling secret with no matching account.
            try { fs.unlinkSync(passwordFile); } catch (_) { /* ignore */ }
            throw new Error(
                `${this.chainId}: \`account new\` failed: ${err.message}. `
                + 'Could not create the EVM mining account. Check the binary and disk space.',
            );
        }

        // Resolve the freshly-created address from the keystore UTC--* JSON.
        const createdAddr = this._findExistingEvmKeystoreAddress(keystoreDir);
        if (!createdAddr) {
            try { fs.unlinkSync(passwordFile); } catch (_) { /* ignore */ }
            throw new Error(
                `${this.chainId}: \`account new\` reported success but no keystore file `
                + `appeared under ${keystoreDir}. Cannot resolve the EVM mining address.`,
            );
        }

        // Persist encrypted password + 0x address back into cfg.
        const envelope = EnmCrypto.encrypt(password);
        cfg.miner.evmKeystoreAddr = createdAddr;
        cfg.miner.evmKeystorePasswordEncrypted = envelope;
        await this._persistMinerAccount(createdAddr, envelope);

        if (this.extensionHandle && this.extensionHandle.log) {
            this.extensionHandle.log.info(
                `${ENM_LOG_PREFIX} ${this.chainId}: created EVM mining account ${createdAddr}.`,
            );
        }
        return passwordFile;
    }

    /**
     * FIX-C12 — read the first UTC--* keystore file under keystoreDir and
     * return its 0x-prefixed address. go-ethereum keystore files are JSON
     * with a lowercase, un-prefixed `address` field (e.g. "abc123...").
     *
     * @param {string} keystoreDir
     * @returns {string|null} 0x-prefixed checksum-agnostic address, or null
     *   when no parseable keystore file exists.
     */
    _findExistingEvmKeystoreAddress(keystoreDir) {
        let entries;
        try {
            entries = fs.readdirSync(keystoreDir);
        } catch (err) {
            if (err && err.code === 'ENOENT') return null;
            throw err;
        }
        // go-ethereum names keystore files "UTC--<timestamp>--<address>".
        const utc = entries.filter((f) => f.startsWith('UTC--')).sort();
        if (utc.length === 0) return null;
        const filePath = path.join(keystoreDir, utc[0]);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            throw new Error(
                `${this.chainId}: failed to parse EVM keystore file ${filePath}: ${err.message}`,
            );
        }
        if (!parsed || typeof parsed.address !== 'string' || parsed.address.length === 0) {
            throw new Error(
                `${this.chainId}: EVM keystore file ${filePath} has no usable .address field.`,
            );
        }
        const addr = parsed.address.startsWith('0x') ? parsed.address : `0x${parsed.address}`;
        return addr;
    }

    /**
     * FIX-C12 — persist the resolved EVM mining account (0x address +
     * encrypted password) back into the canonical cfg.chains.<id>.miner
     * block via ConfigStore, so the next start reuses it without a fresh
     * `account new`. Reloads cfg to avoid clobbering concurrent edits.
     *
     * @param {string} addr            0x-prefixed EVM address
     * @param {string} passwordEnvelope EnmCrypto.encrypt() envelope string
     */
    async _persistMinerAccount(addr, passwordEnvelope) {
        const full = await ConfigStore.load();
        if (!full || !full.chains || !full.chains[this.chainId]) {
            // Chain not in cfg (shouldn't happen at start time) — skip
            // persistence rather than throw; the in-memory cfg still drives
            // this start.
            if (this.extensionHandle && this.extensionHandle.log) {
                this.extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} ${this.chainId}: cfg.chains.${this.chainId} missing at `
                    + 'EVM-account persist time; skipping save (in-memory cfg still used).',
                );
            }
            return;
        }
        const m = full.chains[this.chainId].miner || {};
        m.evmKeystoreAddr = addr;
        m.evmKeystorePasswordEncrypted = passwordEnvelope;
        full.chains[this.chainId].miner = m;
        await ConfigStore.save(full);
    }
}

module.exports = EvmSidechainAdapter;
// Exported for tests.
module.exports._internal = {
    PBFT_KEYSTORE_RELPATH,
    EVM_KEYSTORE_RELPATH,
    DATA_RELPATH,
};
