/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmSetupHelpers tests — pure functions, no I/O.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect } from 'vitest';

const { walletScopeId, validateKeystorePath } = require('../lib/EnmSetupHelpers');

describe('walletScopeId', () => {
    it('returns 12-char hex', () => {
        const id = walletScopeId('0xAbCdEf0123456789012345678901234567890123');
        expect(id).toMatch(/^[0-9a-f]{12}$/);
    });

    it('case-insensitive on EVM addresses', () => {
        const a = walletScopeId('0xABCDEF0123456789012345678901234567890123');
        const b = walletScopeId('0xabcdef0123456789012345678901234567890123');
        expect(a).toBe(b);
    });

    it('different wallets give different ids', () => {
        const a = walletScopeId('0xaaaa');
        const b = walletScopeId('0xbbbb');
        expect(a).not.toBe(b);
    });
});

describe('validateKeystorePath', () => {
    it('rejects empty', () => {
        const r = validateKeystorePath('');
        expect(r.ok).toBe(false);
    });

    it('rejects relative paths', () => {
        const r = validateKeystorePath('keystore.dat');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/absolute/);
    });

    it('rejects paths with parent-directory segments', () => {
        const r = validateKeystorePath('/home/op/../etc/passwd');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/parent/);
    });

    it('accepts absolute paths without traversal', () => {
        const r = validateKeystorePath('/home/op/.elastos/keystore.dat');
        expect(r.ok).toBe(true);
    });
});
