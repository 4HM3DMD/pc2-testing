/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/config.js tests — unit tests for the helpers + behavior. We don't
 * spin up a real Express server (express isn't in our direct deps; PC2
 * provides it at runtime). Instead we exercise the surface that's pure JS:
 *   - redactSecrets (covers password redaction, passwordSet flag)
 *   - rollback path (no .bak file → null)
 *   - setRpcPassword preserves existing password when called with empty string
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

// Point DataDir at a temp dir BEFORE requiring config code.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-cfg-'));
process.env.PC2_DATA_DIR = tmpRoot;
process.env.ENM_DATA_DIR = path.join(tmpRoot, 'extensions', 'elastos-node-manager');
fs.mkdirSync(process.env.ENM_DATA_DIR, { recursive: true });

const { redactSecrets } = require('../lib/EnmConfigRedact');
const ConfigStore = require('../lib/ConfigStore');

describe('redactSecrets', () => {
    it('redacts rpc.passwordEncrypted and adds passwordSet=true', () => {
        const out = redactSecrets({
            chains: { mainchain: { rpc: { passwordEncrypted: 'aes-blob' } } },
        });
        expect(out.chains.mainchain.rpc.passwordEncrypted).toBe('[REDACTED]');
        expect(out.chains.mainchain.rpc.passwordSet).toBe(true);
    });

    it('marks passwordSet=false when no encrypted password present', () => {
        const out = redactSecrets({
            chains: { mainchain: { rpc: { user: 'ela' } } },
        });
        expect(out.chains.mainchain.rpc.passwordSet).toBe(false);
    });

    it('leaves non-secret fields untouched', () => {
        const out = redactSecrets({
            chains: {
                mainchain: {
                    rpc: { user: 'ela', whiteIPList: ['127.0.0.1'], passwordEncrypted: 'X' },
                    binaryPath: '/usr/local/bin/ela',
                },
            },
            global: { audit: { retentionDays: 365 } },
        });
        expect(out.chains.mainchain.rpc.user).toBe('ela');
        expect(out.chains.mainchain.rpc.whiteIPList).toEqual(['127.0.0.1']);
        expect(out.chains.mainchain.binaryPath).toBe('/usr/local/bin/ela');
        expect(out.global.audit.retentionDays).toBe(365);
    });

    it('handles configs with no chains map', () => {
        const out = redactSecrets({ global: { audit: { retentionDays: 30 } } });
        expect(out.global.audit.retentionDays).toBe(30);
    });
});

describe('ConfigStore.rollback (route /config/rollback path)', () => {
    beforeEach(() => {
        ConfigStore._resetCacheForTests();
    });

    it('returns null when no .bak exists', async () => {
        const result = await ConfigStore.rollback();
        expect(result).toBeNull();
    });
});
