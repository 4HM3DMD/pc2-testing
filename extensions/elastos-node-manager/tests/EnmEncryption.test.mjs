/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Round-trip + tamper-detection tests for our AES-256-GCM module.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';
const fs = require('node:fs');

const enc = require('../lib/EnmEncryption');
const { encryptionKeyPath } = require('../lib/DataDir');

describe('EnmEncryption', () => {
    beforeEach(() => {
        // Force re-derivation per test so getMasterKey() exercises both paths.
        enc._resetCacheForTests();
        try {
            fs.unlinkSync(encryptionKeyPath());
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
    });

    it('round-trips utf-8 strings', () => {
        const plaintext = 'hunter2 — passphrase ☃︎';
        const envelope = enc.encrypt(plaintext);
        expect(typeof envelope).toBe('string');
        const parsed = JSON.parse(envelope);
        expect(parsed.v).toBe(1);
        expect(typeof parsed.iv).toBe('string');
        expect(typeof parsed.tag).toBe('string');
        expect(typeof parsed.ct).toBe('string');
        expect(enc.decrypt(envelope)).toBe(plaintext);
    });

    it('produces a different ciphertext on every call (random IV)', () => {
        const plaintext = 'same input';
        const a = JSON.parse(enc.encrypt(plaintext));
        const b = JSON.parse(enc.encrypt(plaintext));
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
    });

    it('writes the master key with mode 0600', () => {
        enc.encrypt('seed the key file');
        const stat = fs.statSync(encryptionKeyPath());
        // Strip out the file-type bits — we only care about the perm bits.
        // eslint-disable-next-line no-bitwise
        const perms = stat.mode & 0o777;
        expect(perms).toBe(0o600);
    });

    it('throws on tampered ciphertext', () => {
        const envelope = enc.encrypt('confidential');
        const parsed = JSON.parse(envelope);
        // Flip one bit of the ciphertext.
        const ct = Buffer.from(parsed.ct, 'base64');
        ct[0] ^= 0x01;
        parsed.ct = ct.toString('base64');
        expect(() => enc.decrypt(JSON.stringify(parsed))).toThrow();
    });

    it('throws on wrong format version', () => {
        const envelope = enc.encrypt('hello');
        const parsed = JSON.parse(envelope);
        parsed.v = 999;
        expect(() => enc.decrypt(JSON.stringify(parsed))).toThrow(/format version/);
    });

    it('throws TypeError on non-string input', () => {
        expect(() => enc.encrypt(42)).toThrow(TypeError);
        expect(() => enc.decrypt(42)).toThrow(TypeError);
    });
});
