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

// beta.3.87 — Wave M1.3 — per-chain healing rule overrides. Shape mirrors
// cfg.global.healing.enabledRules (which becomes legacy fallback). Keys
// are F-rule IDs (F1..F22) plus AUTOSTART. Values are booleans. Any
// rule omitted falls back to the global override, then DEFAULT_ENABLED.
//
// HealthChecker._loadConfigSafe does a ONE-SHOT migration on first
// boot under this schema: if cfg.chains.mainchain.healing.enabledRules
// is absent AND cfg.global.healing.enabledRules has entries, the global
// map is copied here, an SSE notification fires, and an audit row is
// written. Operators' existing per-chain toggles survive the upgrade.
const perChainHealingSchema = Joi.object({
    enabledRules: Joi.object().pattern(
        Joi.string().regex(/^(F\d{1,2}|AUTOSTART)$/),
        Joi.boolean(),
    ).default({}),
}).default({});

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
    // beta.3.87 — per-chain healing rule overrides.
    healing: perChainHealingSchema,
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
    // beta.3.78 — `stateSnapshot` config block removed with the snapshot
    // service. F22 is now alert-only; recovery is operator-driven.
    //
    // beta.3.79 — pre-3.78 configs on disk still carry global.stateSnapshot.
    // Without a tolerant key here, Joi rejects the whole config with
    // "stateSnapshot is not allowed" — blocking config.load(), which in
    // turn blocked HealthChecker, AUTOSTART, and every chains/ route.
    // Operators woke up to chain-stopped + 500s from the UI.
    //
    // Joi.any().strip() accepts the legacy field on read and quietly
    // drops it from the validated output, so the next ConfigStore.save
    // writes a clean config and the legacy field is gone for good.
    stateSnapshot: Joi.any().strip(),
    // beta.3.98 (Wave M3.4) — Council-wide strategy answers (plan §5
    // Layer 1). Two questions asked once on the first non-mainchain
    // install:
    //   1. passwordStrategy:    one password for all sidechain EVM
    //                           keystores OR per-chain
    //   2. minerAddressStrategy: one Ethereum address for all chains
    //                            OR per-chain
    // Shared values (when strategy='shared') live here so all class B
    // install wizards can pull them; per-chain values live on each
    // cfg.chains.<id> (M3.3 classBSchema.miner.rewardAddress etc.).
    council: Joi.object({
        passwordStrategy: Joi.string().valid('shared', 'per-chain').optional(),
        // Encrypted shared password — populated when passwordStrategy
        // ='shared'. AES-GCM envelope (EnmEncryption). Each Class B
        // install copies this to cfg.chains.<id>.miner.evmKeystore
        // PasswordEncrypted for backward-compat with the per-chain
        // unlock path in EvmSidechainAdapter (M3.1).
        sharedPasswordEncrypted: Joi.string().allow('').default(''),
        minerAddressStrategy: Joi.string().valid('shared', 'per-chain').optional(),
        sharedMinerAddress: Joi.string().regex(/^0x[0-9a-fA-F]{40}$/).allow('').default(''),
        setupCompletedAt: Joi.number().integer().allow(null).default(null),
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

// beta.3.86 — Wave M1.2 — multi-chain config-shape opening.
//
// Placeholder schemas for non-mainchain classes. Each currently accepts
// any shape (`.unknown(true)`) so M1.2 only OPENS the door for future
// per-class fields without prescribing what they look like (that lands
// in M3 for Class B, M4 for Class C, M5 for PG-specific, M6 for Class D).
//
// Why now: by introducing the pattern matchers in M1.2, the schema
// stops rejecting any non-mainchain chainId before the per-class schemas
// land. This lets later milestones add chain entries to the config
// without simultaneously needing schema migration.
//
// The mainchain key stays as a NAMED key (not a pattern match) so the
// existing strict mainchainSchema continues to validate exactly as
// before. Backward compat: pre-3.86 configs with `chains.mainchain`
// only continue to validate without any change.
//
// ECO is intentionally absent from the regex (H3 — operator-instructed
// 2026-05-18); attempting to add `chains.eco: {...}` is REJECTED.

// beta.3.97 (Wave M3.3) — Class B (EVM PBFT sidechain) schema. Real
// shape; the M1.2 `Joi.object().unknown(true)` placeholder is replaced
// here for ESC + EID + PG (PG fills in the remaining PG-specific
// quirks in M5.1; this shape works for PG today, just without the
// closed-source binary SHA256 manifest).
//
// node.sh parity:
//   - pbft.usesMainchainKeystore is schema-locked to true (H23 — the
//     EVM sidechain's PBFT keystore is ALWAYS the mainchain
//     keystore.dat per node.sh:2144). Surfacing it in the schema lets
//     operators reading the cfg file see the invariant.
//   - miner.rewardAddress is operator-supplied (NOT derived from the
//     EVM keystore — H22). Format regex here is the shape gate; full
//     EIP-55 + checksum validation happens at the route layer via
//     EnmCrypto.validateEthAddress.
//   - miner.evmKeystorePasswordEncrypted is the AES-GCM envelope
//     produced by EnmEncryption (H24 — no plaintext on disk).
//   - sync.mode mirrors geth's --syncmode {fast,full,archive}; node.sh
//     defaults to 'fast'.
const classBPortsSchema = Joi.object({
    rpc:       PORT_RANGE.required(),
    p2p:       PORT_RANGE.required(),
    dpos:      PORT_RANGE.required(),
    discovery: PORT_RANGE.required(),
    httpInfo:  PORT_RANGE.optional(),
});
const classBPbftSchema = Joi.object({
    usesMainchainKeystore: Joi.boolean().valid(true).default(true),
    ipAddress: IP_OR_HOST.default(null),
}).default();
const classBMinerSchema = Joi.object({
    enabled: Joi.boolean().default(false),
    // 0x + 40 hex shape gate; route layer applies EIP-55 + warn.
    rewardAddress: Joi.string().regex(/^0x[0-9a-fA-F]{40}$/).allow('').default(''),
    rewardAddressSource: Joi.string().valid('shared', 'per-chain').default('per-chain'),
    evmKeystoreAddr: Joi.string().regex(/^0x[0-9a-fA-F]{40}$/).allow('').default(''),
    evmKeystorePasswordEncrypted: Joi.string().allow('').default(''),
    threads: Joi.number().integer().min(1).max(16).default(1),
}).default();
const classBSyncSchema = Joi.object({
    mode: Joi.string().valid('fast', 'full', 'archive').default('fast'),
}).default();
const classBSchema = Joi.object({
    enabled: Joi.boolean().default(false),
    binaryPath: Joi.string().allow('').default(''),
    binaryVersion: Joi.string().allow('').default(''),
    activeNet: Joi.string().valid('mainnet', 'testnet').default('mainnet'),
    ports: classBPortsSchema.required(),
    pbft: classBPbftSchema,
    miner: classBMinerSchema,
    sync: classBSyncSchema,
    bootnodes: Joi.array().items(Joi.string().max(512)).default([]),
    healing: perChainHealingSchema,
});

const classCPlaceholderSchema = Joi.object().unknown(true);  // Oracles (M4, M5)
const classDPlaceholderSchema = Joi.object().unknown(true);  // Arbiter (M6)
const classEPlaceholderSchema = Joi.object().unknown(true);  // SPV (M6-opt)

const enmConfigSchema = Joi.object({
    version: Joi.number().integer().valid(1).required(),
    chains: Joi.object({
        // Named key — preserves bit-for-bit mainchain validation. Stays
        // as a named key forever; Class A is the only class with a
        // singleton (only one mainchain ever).
        mainchain: mainchainSchema.optional(),
    })
        // Class B chainIds — esc, eid, pg. Real schema landed in M3.3
        // (replaces the M1.2 .unknown(true) placeholder). PG additions
        // (closed-source SHA256 manifest) layer on in M5.1 but the
        // current shape covers all three.
        .pattern(/^(esc|eid|pg)$/, classBSchema)
        // Class C chainIds — oracles. Real schema in M4 (ESC, EID Oracle)
        // and M5 (PG Oracle).
        .pattern(/^(esc-oracle|eid-oracle|pg-oracle)$/, classCPlaceholderSchema)
        // Class D — arbiter (singleton). Real schema in M6.
        .pattern(/^arbiter$/, classDPlaceholderSchema)
        // Class E — spv (singleton, optional). Real schema in M6-opt.
        .pattern(/^spv$/, classEPlaceholderSchema)
        .default({}),
    global: globalSchema.default(),
    setup: setupSchema.default(),
})
    .unknown(false) // reject typos at the top level (chains/global/setup/version only)
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
