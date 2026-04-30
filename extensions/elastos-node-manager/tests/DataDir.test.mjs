/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * atomicWrite + chainDir + path-traversal tests.
 *
 * atomicWrite is correctness-critical: a botched config save during a crash
 * window would leave the operator with a corrupted JSON file. The temp+rename
 * pattern is what protects them.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, chainDir, enmDataDir, runDir, pidFilePath } = require('../lib/DataDir');

describe('DataDir.atomicWrite', () => {
    it('writes the file and renames atomically', async () => {
        const target = path.join(enmDataDir(), 'atomic-write-target.json');
        const payload = JSON.stringify({ hello: 'world' });
        await atomicWrite(target, payload);
        expect(fs.readFileSync(target, 'utf8')).toBe(payload);
    });

    it('writes with mode 0600 by default', async () => {
        const target = path.join(enmDataDir(), 'atomic-write-perm.json');
        await atomicWrite(target, 'secret');
        const stat = fs.statSync(target);
        // eslint-disable-next-line no-bitwise
        const perms = stat.mode & 0o777;
        expect(perms).toBe(0o600);
    });

    it('honors a custom mode', async () => {
        const target = path.join(enmDataDir(), 'atomic-write-public.json');
        await atomicWrite(target, 'public', { mode: 0o644 });
        const stat = fs.statSync(target);
        // eslint-disable-next-line no-bitwise
        const perms = stat.mode & 0o777;
        expect(perms).toBe(0o644);
    });

    it('does not leave the temp file behind on success', async () => {
        const target = path.join(enmDataDir(), 'atomic-write-cleanup.json');
        await atomicWrite(target, 'x');
        const dir = path.dirname(target);
        const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('atomic-write-cleanup.json.tmp.'));
        expect(leftovers).toEqual([]);
    });

    it('overwrites an existing file (no torn read)', async () => {
        const target = path.join(enmDataDir(), 'atomic-write-overwrite.json');
        await atomicWrite(target, 'first');
        await atomicWrite(target, 'second');
        expect(fs.readFileSync(target, 'utf8')).toBe('second');
    });
});

describe('DataDir.chainDir', () => {
    it('accepts valid lowercase ids', () => {
        const dir = chainDir('mainchain');
        expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('rejects empty chainId', () => {
        expect(() => chainDir('')).toThrow();
    });

    it('rejects path-traversal attempts', () => {
        expect(() => chainDir('..')).toThrow(/invalid chainId/);
        expect(() => chainDir('../etc')).toThrow();
        expect(() => chainDir('main/chain')).toThrow();
        expect(() => chainDir('Main')).toThrow(/invalid/i); // uppercase rejected
    });

    it('rejects non-string ids', () => {
        expect(() => chainDir(undefined)).toThrow();
        expect(() => chainDir(42)).toThrow();
    });
});

describe('DataDir helpers', () => {
    it('runDir returns a directory and creates it', () => {
        const dir = runDir();
        expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('pidFilePath includes the chain id', () => {
        const p = pidFilePath('mainchain');
        expect(p).toMatch(/ela-mainchain\.pid$/);
        expect(path.isAbsolute(p)).toBe(true);
    });
});
