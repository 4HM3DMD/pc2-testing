/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * ElaMainChainAdapter.generateConfig() tests — the output goes straight into
 * the ela binary's config.json, so a typo here would corrupt every operator's
 * node. We test the shape, defaults, and the security-relevant paths
 * (RPC password injection, WhiteIPList default, DPoSPort numbering).
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect } from 'vitest';

const ElaMainChainAdapter = require('../lib/ElaMainChainAdapter');
const { ELA_DEFAULT_PORTS } = require('../lib/EnmConstants');

const fakeExt = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
};
const fakeProcessService = { /* unused for generateConfig */ };

function adapter() {
    return new ElaMainChainAdapter({
        processService: fakeProcessService,
        extensionHandle: fakeExt,
    });
}

function fullChainCfg(overrides = {}) {
    return {
        enabled: true,
        binaryPath: '/usr/local/bin/ela',
        binaryVersion: 'v0.9.9.5',
        dataDir: '/tmp/elastos',
        activeNet: 'mainnet',
        ports: { ...ELA_DEFAULT_PORTS },
        rpc: {
            user: 'ela',
            passwordEncrypted: '<envelope>',
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

describe('ElaMainChainAdapter', () => {
    describe('chainId / displayName', () => {
        it('reports the canonical chainId', () => {
            expect(adapter().chainId).toBe('mainchain');
        });
        it('reports a human-readable displayName', () => {
            expect(adapter().displayName).toMatch(/mainchain/i);
        });
    });

    describe('generateConfig', () => {
        it('produces a Configuration root', () => {
            const out = adapter().generateConfig(fullChainCfg(), {
                rpcPassword: 'pw',
                ipAddress: '203.0.113.5',
            });
            expect(out).toHaveProperty('Configuration');
        });

        it('sets ActiveNet from the chain config (mainnet default)', () => {
            const out = adapter().generateConfig(fullChainCfg(), { rpcPassword: 'pw', ipAddress: null });
            expect(out.Configuration.ActiveNet).toBe('mainnet');
        });

        it('honors testnet activeNet', () => {
            const out = adapter().generateConfig(fullChainCfg({ activeNet: 'testnet' }), {
                rpcPassword: 'pw', ipAddress: null,
            });
            expect(out.Configuration.ActiveNet).toBe('testnet');
        });

        it('writes all 5 HTTP/RPC ports + DPoS port', () => {
            const out = adapter().generateConfig(fullChainCfg(), { rpcPassword: 'pw', ipAddress: null });
            const c = out.Configuration;
            expect(c.NodePort).toBe(ELA_DEFAULT_PORTS.nodePort);
            expect(c.HttpInfoPort).toBe(ELA_DEFAULT_PORTS.httpInfo);
            expect(c.HttpRestPort).toBe(ELA_DEFAULT_PORTS.httpRest);
            expect(c.HttpWsPort).toBe(ELA_DEFAULT_PORTS.httpWs);
            expect(c.HttpJsonPort).toBe(ELA_DEFAULT_PORTS.rpc);
            expect(c.DPoSConfiguration.DPoSPort).toBe(ELA_DEFAULT_PORTS.dpos);
            // Rev 1 audit correction: DPoSPort is 20339 (NOT 20338 = NodePort).
            expect(c.DPoSConfiguration.DPoSPort).toBe(20339);
            expect(c.NodePort).toBe(20338);
            expect(c.NodePort).not.toBe(c.DPoSConfiguration.DPoSPort);
        });

        it('injects the plaintext RPC password into RpcConfiguration.Pass', () => {
            const out = adapter().generateConfig(fullChainCfg(), {
                rpcPassword: 'super-secret',
                ipAddress: null,
            });
            expect(out.Configuration.RpcConfiguration.User).toBe('ela');
            expect(out.Configuration.RpcConfiguration.Pass).toBe('super-secret');
        });

        it('defaults WhiteIPList to 127.0.0.1 (operator widens via Settings)', () => {
            // Rev 1 audit: ela default binds 0.0.0.0; we restrict to localhost
            // unless operator explicitly opens it.
            const out = adapter().generateConfig(fullChainCfg(), { rpcPassword: 'pw', ipAddress: null });
            expect(out.Configuration.RpcConfiguration.WhiteIPList).toEqual(['127.0.0.1']);
        });

        it('honors operator-supplied WhiteIPList', () => {
            const cfg = fullChainCfg();
            cfg.rpc.whiteIPList = ['127.0.0.1', '10.0.0.0/24'];
            const out = adapter().generateConfig(cfg, { rpcPassword: 'pw', ipAddress: null });
            expect(out.Configuration.RpcConfiguration.WhiteIPList).toEqual(['127.0.0.1', '10.0.0.0/24']);
        });

        it('sets DPoS IPAddress to the resolved/manual external IP', () => {
            const out = adapter().generateConfig(
                fullChainCfg({ dpos: { enableArbiter: true, ipAddressMode: 'manual' } }),
                { rpcPassword: 'pw', ipAddress: '203.0.113.5' },
            );
            expect(out.Configuration.DPoSConfiguration.IPAddress).toBe('203.0.113.5');
        });

        it('falls back to empty IPAddress when no external IP is provided', () => {
            const out = adapter().generateConfig(fullChainCfg(), { rpcPassword: 'pw', ipAddress: null });
            expect(out.Configuration.DPoSConfiguration.IPAddress).toBe('');
        });

        it('toggles EnableArbiter for BPoS nodes', () => {
            const cfg = fullChainCfg();
            cfg.dpos.enableArbiter = true;
            const out = adapter().generateConfig(cfg, { rpcPassword: 'pw', ipAddress: '203.0.113.5' });
            expect(out.Configuration.DPoSConfiguration.EnableArbiter).toBe(true);
        });

        it('emits empty PermanentPeers (ela falls back to hardcoded DNS seeds)', () => {
            // Rev 4 audit: the 4 mainnet seeds are baked into ela. Operator can
            // override via Settings → Advanced (F16 fallback for stale seeds).
            const out = adapter().generateConfig(fullChainCfg(), { rpcPassword: 'pw', ipAddress: null });
            expect(out.Configuration.PermanentPeers).toEqual([]);
        });

        it('maps logLevel string to ela PrintLevel uint32', () => {
            const cases = [
                ['debug', 1], ['info', 2], ['warn', 3], ['error', 4],
                ['unknown', 2], // unknown defaults to info
            ];
            for (const [level, expected] of cases) {
                const out = adapter().generateConfig(fullChainCfg({ logLevel: level }), {
                    rpcPassword: 'pw', ipAddress: null,
                });
                expect(out.Configuration.PrintLevel).toBe(expected);
            }
        });

        it('rejects missing rpcPassword in secrets', () => {
            expect(() => adapter().generateConfig(fullChainCfg(), { ipAddress: null }))
                .toThrow(/rpcPassword required/);
        });

        it('rejects malformed chain config', () => {
            expect(() => adapter().generateConfig({}, { rpcPassword: 'pw' }))
                .toThrow(/required/);
            expect(() => adapter().generateConfig(null, { rpcPassword: 'pw' }))
                .toThrow();
        });
    });
});
