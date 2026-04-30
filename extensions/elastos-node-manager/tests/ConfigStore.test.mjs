/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ConfigStore tests — round-trip, joi rejection, atomic-write backup,
 * rollback path, and the encrypt/decrypt RPC password lifecycle.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';
const fs = require('node:fs');

const ConfigStore = require('../lib/ConfigStore');
const { configPath, configBackupPath } = require('../lib/DataDir');
const { defaultConfig } = require('../lib/EnmConfigSchema');
const { _resetCacheForTests: resetEncCache } = require('../lib/EnmEncryption');

beforeEach(() => {
    ConfigStore._resetCacheForTests();
    resetEncCache();
});

function makeFullChainCfg(overrides) {
    return {
        enabled: true,
        binaryPath: '/usr/local/bin/ela',
        binaryVersion: 'v0.9.9.5',
        dataDir: '/tmp/elastos',
        activeNet: 'mainnet',
        ports: {
            rpc: 20336,
            nodePort: 20338,
            httpInfo: 20333,
            httpRest: 20334,
            httpWs: 20335,
            dpos: 20339,
        },
        rpc: {
            user: 'ela',
            passwordEncrypted: '{"v":1,"iv":"","tag":"","ct":""}', // placeholder; updated below
            whiteIPList: ['127.0.0.1'],
        },
        dpos: {
            enableArbiter: false,
            ipAddressMode: 'auto',
            ipAddressManual: null,
            refreshOnRestart: true,
            ownerPublicKey: '',
            nodePublicKey: '',
        },
        memoryLimitMb: 4096,
        archiveMode: false,
        logLevel: 'info',
        ...overrides,
    };
}

describe('ConfigStore', () => {
    it('returns the default config when no file exists', async () => {
        const cfg = await ConfigStore.load();
        expect(cfg.version).toBe(1);
        expect(cfg.setup.completed).toBe(false);
        expect(cfg.global.audit.retentionDays).toBe(365);
    });

    it('saves and reloads a valid config', async () => {
        const cfg = defaultConfig();
        const chainCfg = makeFullChainCfg();
        ConfigStore.setRpcPassword(chainCfg, 'plain-text-password');
        cfg.chains.mainchain = chainCfg;
        cfg.setup.completed = true;
        cfg.setup.completedStep = 'complete';
        cfg.setup.completedAt = Date.now();

        await ConfigStore.save(cfg);

        // File should be written with mode 0600.
        const stat = fs.statSync(configPath());
        // eslint-disable-next-line no-bitwise
        expect(stat.mode & 0o777).toBe(0o600);

        const reloaded = await ConfigStore.load();
        expect(reloaded.chains.mainchain.binaryPath).toBe('/usr/local/bin/ela');
        expect(reloaded.setup.completed).toBe(true);
        // RPC password round-trips.
        expect(ConfigStore.getRpcPassword(reloaded.chains.mainchain)).toBe('plain-text-password');
    });

    it('writes a .bak of the previous version on save', async () => {
        const cfg = defaultConfig();
        const chainCfg = makeFullChainCfg();
        ConfigStore.setRpcPassword(chainCfg, 'first');
        cfg.chains.mainchain = chainCfg;
        await ConfigStore.save(cfg);

        const cfg2 = defaultConfig();
        const chainCfg2 = makeFullChainCfg({ logLevel: 'debug' });
        ConfigStore.setRpcPassword(chainCfg2, 'second');
        cfg2.chains.mainchain = chainCfg2;
        await ConfigStore.save(cfg2);

        expect(fs.existsSync(configBackupPath())).toBe(true);
        // .bak should hold the FIRST password (the one we just overwrote).
        const bak = JSON.parse(fs.readFileSync(configBackupPath(), 'utf8'));
        expect(ConfigStore.getRpcPassword(bak.chains.mainchain)).toBe('first');
    });

    it('rollback restores the previous version', async () => {
        const cfg = defaultConfig();
        const chainCfg = makeFullChainCfg();
        ConfigStore.setRpcPassword(chainCfg, 'before');
        cfg.chains.mainchain = chainCfg;
        await ConfigStore.save(cfg);

        const cfg2 = defaultConfig();
        const chainCfg2 = makeFullChainCfg({ logLevel: 'debug' });
        ConfigStore.setRpcPassword(chainCfg2, 'after');
        cfg2.chains.mainchain = chainCfg2;
        await ConfigStore.save(cfg2);

        const restored = await ConfigStore.rollback();
        expect(restored).not.toBeNull();
        expect(restored.chains.mainchain.logLevel).toBe('info'); // matches "before"
        expect(ConfigStore.getRpcPassword(restored.chains.mainchain)).toBe('before');
    });

    it('rollback returns null when no backup exists', async () => {
        const result = await ConfigStore.rollback();
        expect(result).toBeNull();
    });

    it('rejects a config that fails the joi schema', async () => {
        const bad = defaultConfig();
        bad.version = 99; // schema requires 1
        await expect(ConfigStore.save(bad)).rejects.toThrow(/invalid config/);
    });

    it('setRpcPassword/getRpcPassword round-trip through encryption', () => {
        const chainCfg = { rpc: {} };
        ConfigStore.setRpcPassword(chainCfg, 'super-secret');
        const envelope = chainCfg.rpc.passwordEncrypted;
        expect(typeof envelope).toBe('string');
        // Plaintext must NOT appear in the envelope.
        expect(envelope.includes('super-secret')).toBe(false);
        expect(ConfigStore.getRpcPassword(chainCfg)).toBe('super-secret');
    });
});
