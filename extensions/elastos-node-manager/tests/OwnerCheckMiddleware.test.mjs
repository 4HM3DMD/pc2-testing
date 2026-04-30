/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * compareAddresses tests — security-relevant. EVM addresses must compare
 * case-insensitively (since checksum casing is lossless), but other formats
 * (Solana, etc.) must NOT — that would let an attacker authenticate as a
 * different account whose base58 encoding differs only in case.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect } from 'vitest';

const { compareAddresses } = require('../lib/OwnerCheckMiddleware');

describe('compareAddresses', () => {
    it('returns true for identical EVM addresses', () => {
        const a = '0xAbCdEf0123456789abcdef0123456789abcdef01';
        expect(compareAddresses(a, a)).toBe(true);
    });

    it('returns true for EVM addresses differing only in case', () => {
        const a = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';
        const b = '0xabcdef0123456789abcdef0123456789abcdef01';
        expect(compareAddresses(a, b)).toBe(true);
    });

    it('returns false for different EVM addresses', () => {
        const a = '0x1111111111111111111111111111111111111111';
        const b = '0x2222222222222222222222222222222222222222';
        expect(compareAddresses(a, b)).toBe(false);
    });

    it('treats Solana-shaped addresses as case-sensitive', () => {
        // Realistic 44-char base58 strings differing only by one letter case.
        const a = 'Abc12Bc12Bc12Bc12Bc12Bc12Bc12Bc12Bc12Bc12345';
        const b = 'abc12Bc12Bc12Bc12Bc12Bc12Bc12Bc12Bc12Bc12345';
        expect(a).not.toBe(b);          // sanity: different strings
        expect(a.length).toBe(b.length); // same length
        expect(compareAddresses(a, b)).toBe(false); // case must NOT collapse
    });

    it('returns false when lengths differ', () => {
        expect(compareAddresses('0xabc', '0xabcdef')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
        expect(compareAddresses(null, '0xabc')).toBe(false);
        expect(compareAddresses('0xabc', undefined)).toBe(false);
        expect(compareAddresses(42, '0xabc')).toBe(false);
        expect(compareAddresses({}, '0xabc')).toBe(false);
    });

    it('returns false when one is EVM and the other is not', () => {
        const evm = '0x1234567890abcdef1234567890abcdef12345678';
        // 42-char non-EVM (no 0x prefix). Length matches but format differs.
        const nonEvm = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
        expect(evm.length).toBe(nonEvm.length); // both 42
        expect(compareAddresses(evm, nonEvm)).toBe(false);
    });

    it('returns false for EVM with wrong length even if 0x-prefixed', () => {
        // 0x-prefixed but not 42 chars total — looksLikeEvm rejects, falls to exact.
        const a = '0xabc';
        const b = '0xABC';
        expect(compareAddresses(a, b)).toBe(false); // exact compare, case differs
    });
});
