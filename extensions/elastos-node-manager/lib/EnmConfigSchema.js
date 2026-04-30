/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmConfigSchema — joi schema for our extension's config file.
 *
 * Per Rev 6 audit (agent 10): the only validator added to PC2 in v0.1 is joi.
 * The schema below covers the v0.1 mainchain-only config; it intentionally
 * leaves multi-chain shape (ESC, EID) for v0.2 expansion.
 *
 * Validates the JSON written to ${dataDir}/extensions/elastos-node-manager/config.json
 * (NOT the chain's own ela config.json — that's a separate file we generate
 * inside chains/<chainId>/config.json).
 */

'use strict';

const Joi = require('joi');

const { ELA_DEFAULT_PORTS } = require('./EnmConstants');

const PORT_RANGE = Joi.number().integer().min(1024).max(65535);
const HEX_PUBKEY = Joi.string().hex().length(66); // 33-byte compressed pubkey
const IP_OR_HOST = Joi.alternatives().try(
    Joi.string().ip({ version: ['ipv4'] }),
    Joi.string().hostname(),
    Joi.valid(null),
);

const rpcSchema = Joi.object({
    user: Joi.string().alphanum().min(1).max(64).required(),
    // Encrypted via EnmEncryption.encrypt() — base64 JSON envelope. We store
    // the envelope as-is and decrypt at spawn time.
    passwordEncrypted: Joi.string().required(),
    whiteIPList: Joi.array().items(
        Joi.alternatives().try(
            Joi.string().ip({ version: ['ipv4'], cidr: 'optional' }),
            Joi.valid('127.0.0.1'),
        ),
    ).default(['127.0.0.1']),
});

const dposSchema = Joi.object({
    enableArbiter: Joi.boolean().required(),
    // Auto, manual, or null (paint as auto-detect with no override yet).
    ipAddressMode: Joi.string().valid('auto', 'manual').default('auto'),
    ipAddressManual: IP_OR_HOST.default(null),
    refreshOnRestart: Joi.boolean().default(true),
    ownerPublicKey: HEX_PUBKEY.allow('').default(''),
    nodePublicKey: HEX_PUBKEY.allow('').default(''),
    // Keystore password — encrypted via EnmEncryption (same envelope shape as
    // rpc.passwordEncrypted). Optional in non-arbiter mode; required when the
    // operator flips enableArbiter=true. NativeProcessService decrypts at
    // spawn-time and pipes to stdin (Rev 1 audit: ela reads it from stdin).
    keystorePasswordEncrypted: Joi.string().allow('').default(''),
});

const portsSchema = Joi.object({
    rpc:      PORT_RANGE.default(ELA_DEFAULT_PORTS.rpc),
    nodePort: PORT_RANGE.default(ELA_DEFAULT_PORTS.nodePort),
    httpInfo: PORT_RANGE.default(ELA_DEFAULT_PORTS.httpInfo),
    httpRest: PORT_RANGE.default(ELA_DEFAULT_PORTS.httpRest),
    httpWs:   PORT_RANGE.default(ELA_DEFAULT_PORTS.httpWs),
    dpos:     PORT_RANGE.default(ELA_DEFAULT_PORTS.dpos),
});

const mainchainSchema = Joi.object({
    enabled: Joi.boolean().default(true),
    binaryPath: Joi.string().min(1).required(),
    binaryVersion: Joi.string().allow(null, '').default(null),
    dataDir: Joi.string().required(),
    activeNet: Joi.string().valid('mainnet', 'testnet', 'regnet').default('mainnet'),
    ports: portsSchema.required(),
    rpc: rpcSchema.required(),
    dpos: dposSchema.required(),
    memoryLimitMb: Joi.number().integer().min(512).max(32_768).default(4096),
    archiveMode: Joi.boolean().default(false),
    logLevel: Joi.string().valid('debug', 'info', 'warn', 'error').default('info'),
});

const globalSchema = Joi.object({
    healing: Joi.object({
        autoExecuteSafe: Joi.boolean().default(true),
        ownerConfirmsTimeoutSec: Joi.number().integer().min(60).max(86_400).default(3600),
        maxRestartAttempts: Joi.number().integer().min(1).max(20).default(3),
        restartCooldownSec: Joi.number().integer().min(5).max(600).default(30),
    }).default(),
    notifications: Joi.object({
        criticalRequiresAck: Joi.boolean().default(true),
    }).default(),
    audit: Joi.object({
        retentionDays: Joi.number().integer().min(0).max(3650).default(365),
    }).default(),
});

const setupSchema = Joi.object({
    completed: Joi.boolean().default(false),
    completedAt: Joi.number().integer().allow(null).default(null),
    completedStep: Joi.string().valid(
        'welcome', 'os', 'disk', 'wallet', 'binary', 'keystore', 'config', 'complete',
    ).default('welcome'),
});

const enmConfigSchema = Joi.object({
    version: Joi.number().integer().valid(1).required(),
    chains: Joi.object({
        mainchain: mainchainSchema.optional(),
    }).default({}),
    global: globalSchema.default(),
    setup: setupSchema.default(),
})
    .unknown(false) // reject typos
    .required();

/**
 * Validate a config object. Returns the normalized value (with defaults
 * applied) on success; throws on failure with all error messages joined.
 *
 * @param {object} input
 * @returns {object} validated + default-filled config
 */
function validate(input) {
    const result = enmConfigSchema.validate(input, {
        abortEarly: false,
        stripUnknown: false,
        convert: true,
    });
    if (result.error) {
        const details = result.error.details
            .map((d) => `  ${d.path.join('.') || '(root)'}: ${d.message}`)
            .join('\n');
        const err = new Error(`EnmConfigSchema: invalid config\n${details}`);
        err.details = result.error.details;
        throw err;
    }
    return result.value;
}

/**
 * Default config seed — used on first init before the operator runs setup.
 * Required fields are filled with placeholders that pass schema validation
 * BUT the calling code should still flag the config as "not yet configured"
 * via setup.completed=false.
 *
 * @returns {object}
 */
function defaultConfig() {
    return {
        version: 1,
        chains: {},
        global: {
            healing: {
                autoExecuteSafe: true,
                ownerConfirmsTimeoutSec: 3600,
                maxRestartAttempts: 3,
                restartCooldownSec: 30,
            },
            notifications: { criticalRequiresAck: true },
            audit: { retentionDays: 365 },
        },
        setup: {
            completed: false,
            completedAt: null,
            completedStep: 'welcome',
        },
    };
}

module.exports = {
    enmConfigSchema,
    validate,
    defaultConfig,
};
