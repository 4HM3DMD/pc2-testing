/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmConfigGenerator — produces a chain config.json that matches what
 * node.sh writes (build/skeleton/node.sh:1255-1295).
 *
 * The actual schema is hands-off small: most fields default sensibly
 * inside ela itself (per common/config/config.go in the Elastos.ELA
 * source). The few we have to set are:
 *
 *   - ActiveNet       (omit for mainnet, "testnet" for testnet)
 *   - Magic           (only required on testnet; 2018101 per node.sh)
 *   - DPoSConfiguration.EnableArbiter   (true to run as a producer)
 *   - DPoSConfiguration.IPAddress       (this server's externally-reachable IP)
 *   - EnableRPC                         (true so we can talk to the chain)
 *   - RpcConfiguration.User/Pass        (random per install)
 *   - RpcConfiguration.WhiteIPList      ([127.0.0.1] by default)
 *
 * Everything else is left to ela's defaults — which means future ela
 * releases that change defaults won't fight us, and our generated config
 * stays small enough to read at a glance.
 */

'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const VALID_NETWORKS = Object.freeze(['mainnet', 'testnet']);
// Testnet magic per node.sh:1260; not strictly required (ela can derive
// it from ActiveNet) but we set it explicitly because the upstream
// installer does.
const TESTNET_MAGIC = 2018101;

/**
 * Generate a 32-char random alphanumeric token (matches node.sh's
 * "openssl rand -base64 100 | shasum | head -c 32" pattern).
 */
function randomCredential() {
    return crypto.randomBytes(32).toString('hex').slice(0, 32);
}

class EnmConfigGenerator {
    /**
     * Build the config object (not yet serialised). Caller can
     * post-process before writing.
     *
     * @param {object}  opts
     * @param {string}  [opts.network='mainnet']
     * @param {boolean} [opts.enableArbiter=true]
     * @param {string}  [opts.externalIp]
     * @param {string}  [opts.rpcUser]   default: 32-char random
     * @param {string}  [opts.rpcPass]   default: 32-char random
     * @param {string[]} [opts.whiteIPList=['127.0.0.1']]
     */
    static build(opts = {}) {
        const network = opts.network || 'mainnet';
        if (!VALID_NETWORKS.includes(network)) {
            throw new Error(`Unknown network: ${network}. Choose one of: ${VALID_NETWORKS.join(', ')}`);
        }

        const config = {
            Configuration: {
                DPoSConfiguration: {
                    EnableArbiter: opts.enableArbiter !== false,
                    IPAddress: opts.externalIp || '',
                },
                EnableRPC: true,
                RpcConfiguration: {
                    User: opts.rpcUser || randomCredential(),
                    Pass: opts.rpcPass || randomCredential(),
                    WhiteIPList: Array.isArray(opts.whiteIPList) && opts.whiteIPList.length
                        ? opts.whiteIPList.slice()
                        : ['127.0.0.1'],
                },
            },
        };

        if (network === 'testnet') {
            config.Configuration.ActiveNet = 'testnet';
            config.Configuration.Magic = TESTNET_MAGIC;
        }

        return config;
    }

    /**
     * Build + serialise + write to disk. Sets file mode 0600 because the
     * RPC password is in plaintext inside (same threat model as node.sh,
     * which writes config.json as the operator's user with no special
     * perms — node.sh:1306).
     *
     * Returns { config, configPath, rpcUser, rpcPass } so the caller can
     * stash the credentials for later use without re-reading the file.
     */
    static async writeFor(opts) {
        if (!opts || !opts.configPath) {
            throw new Error('EnmConfigGenerator.writeFor: { configPath } required');
        }
        const config = EnmConfigGenerator.build(opts);
        await fsp.mkdir(path.dirname(opts.configPath), { recursive: true });
        await fsp.writeFile(opts.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
        return {
            configPath: opts.configPath,
            rpcUser: config.Configuration.RpcConfiguration.User,
            rpcPass: config.Configuration.RpcConfiguration.Pass,
            network: opts.network || 'mainnet',
            enableArbiter: config.Configuration.DPoSConfiguration.EnableArbiter,
            externalIp: config.Configuration.DPoSConfiguration.IPAddress,
            config,
        };
    }
}

module.exports = {
    EnmConfigGenerator,
    randomCredential,
    VALID_NETWORKS,
};
