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
    // Master gate (alpha.19). When false, the generated ela config.json
    // forces WhiteIPList=['127.0.0.1'] so external apps cannot connect even
    // if the operator has saved a wider allow-list. Operator's whiteIPList
    // is preserved across toggle off/on so they don't lose configuration.
    // Defaults to false on fresh installs — operators explicitly open RPC.
    enabled: Joi.boolean().default(false),
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
        // beta.3.76 — per-rule enable/disable overrides. Keys are the
        // F-rule IDs (F1, F2, F4, F5, F6, F7, F8, F9, F10, F11, F12,
        // F13, F16, F18, F19, F22) plus AUTOSTART. Any rule omitted
        // here keeps its DEFAULT_ENABLED value (all true today). At
        // boot HealthChecker pushes this map into HealthRules.
        // setRuleEnabled so the engine's runAll() gate honours it.
        enabledRules: Joi.object().pattern(
            Joi.string().regex(/^(F\d{1,2}|AUTOSTART)$/),
            Joi.boolean(),
        ).default({}),
    }).default(),
    notifications: Joi.object({
        criticalRequiresAck: Joi.boolean().default(true),
        // beta.3.19 (Phase 2 Alerts) — operator-tunable thresholds
        // for HealthChecker's F3 / F4 / F5 detectors. Defaults match
        // the alpha.28 hardcoded values; bounds mirror the Joi
        // request-body schema in EnmRequestSchemas.notificationsBody.
        thresholds: Joi.object({
            diskFreeWarnGb:     Joi.number().integer().min(10).max(10000).optional(),
            diskFreeCriticalGb: Joi.number().integer().min(1).max(10000).optional(),
            peerZeroGraceMin:   Joi.number().integer().min(1).max(120).optional(),
            syncStallGraceMin:  Joi.number().integer().min(1).max(240).optional(),
        }).default({}),
    }).default(),
    audit: Joi.object({
        retentionDays: Joi.number().integer().min(0).max(3650).default(365),
    }).default(),
    // beta.3.10 — scrypt hash for the anti-snipe password. Persisted
    // here so SelfHealingEngine._verifyAntiSnipePassword can verify
    // confirm-tier proposals against it. Format:
    //     scrypt$<saltHex>$<derivedHex>
    // Cleared (delete key) when the operator clicks "Clear" in the
    // Security section. NEVER echoed back to the client — the
    // EnmConfigRedact pass converts it to a `antiSnipePasswordSet`
    // boolean before the /config GET response.
    antiSnipePasswordHash: Joi.string().allow(null).pattern(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/).optional(),
    // beta.3.20 (Phase 3 Storage) — keystore auto-backup state +
    // policy. The service writes lastKeystoreBackupAt + path
    // every successful backup; PUT /config/storage writes the
    // policy fields. All fields optional so a config from an
    // older beta still validates.
    backup: Joi.object({
        keystoreIntervalDays: Joi.number().integer().min(1).max(90).optional(),
        keystoreKeepCount:    Joi.number().integer().min(1).max(50).optional(),
        lastKeystoreBackupAt: Joi.number().integer().min(0).allow(null).optional(),
        lastKeystoreBackupPath: Joi.string().allow(null, '').optional(),
    }).default({}),
    // Auto-start: when PC2 boots and an extension's `ready` hook fires, start
    // any chain whose `enabled=true`. Reattach handles the "ela was already
    // running before PC2 restarted" case; this handles cold boots.
    autoStart: Joi.object({
        onBoot: Joi.boolean().default(true),
        delaySec: Joi.number().integer().min(0).max(600).default(10),
    }).default(),
    // Log rotation — gzip *.log older than gzipAfterDays, purge *.gz older
    // than purgeAfterDays. main.js scheduler runs compactNow every 24h.
    // beta.3.20 — purgeAfterDays min lowered from 7 → 1 day so the
    // Settings Storage section's range (1-3650) doesn't trip the
    // schema. The cross-field "gzip < purge" rule is enforced in
    // EnmRequestSchemas.storageBody at the PUT boundary.
    logRotation: Joi.object({
        enabled: Joi.boolean().default(true),
        gzipAfterDays: Joi.number().integer().min(1).max(365).default(7),
        purgeAfterDays: Joi.number().integer().min(1).max(3650).default(30),
    }).default(),
    // beta.3.63 — Phase 7 Layer 2 + 4. Periodic backup of the live DPoS/CR/
    // txPool state files so the auto-heal layer can roll forward to a recent
    // known-good state when default.dcp gets out-of-sync with the block
    // ledger (the failure mode that caused multiple hours-long chain
    // outages on srv832310). Cheap (~6MB per snapshot) and decoupled from
    // bootstrap (which is a 10GB last-resort).
    stateSnapshot: Joi.object({
        enabled: Joi.boolean().default(true),
        intervalSec: Joi.number().integer().min(60).max(86400).default(3600), // 1hr
        retention: Joi.number().integer().min(1).max(168).default(24),         // 24 snapshots
        // When true (default), F22 detection of "sponsor not in arbitrators"
        // pattern auto-restores the most-recent snapshot instead of escalating
        // to OWNER-CONFIRMS. False = always propose, never auto-execute.
        autoRestore: Joi.boolean().default(true),
    }).default(),
});

const setupSchema = Joi.object({
    completed: Joi.boolean().default(false),
    completedAt: Joi.number().integer().allow(null).default(null),
    completedStep: Joi.string().valid(
        'welcome', 'os', 'disk', 'wallet', 'binary',
        // alpha.10: 'bootstrap' sits between binary install and keystore.
        // Operator picks fast-sync (snapshot) or genesis on Card B2;
        // either path advances completedStep through 'bootstrap'.
        'bootstrap',
        'keystore', 'config', 'complete',
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
            autoStart: { onBoot: true, delaySec: 10 },
            logRotation: { enabled: true, gzipAfterDays: 7, purgeAfterDays: 90 },
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
