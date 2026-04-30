/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmBinaryLocator tests — covers each early-return path in validatePath().
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const locator = require('../lib/EnmBinaryLocator');

describe('EnmBinaryLocator.validatePath', () => {
    let tmpDir;
    let executable;
    let nonExecutable;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-locator-'));
        executable = path.join(tmpDir, 'fake-ela');
        nonExecutable = path.join(tmpDir, 'fake-non-exec');
        fs.writeFileSync(executable, '#!/bin/sh\necho v0.0.0-fake\n');
        fs.chmodSync(executable, 0o755);
        fs.writeFileSync(nonExecutable, 'not an executable');
        fs.chmodSync(nonExecutable, 0o644);
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects empty path', () => {
        const r = locator.validatePath('');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/required/i);
    });

    it('rejects relative path', () => {
        const r = locator.validatePath('relative/ela');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/absolute/i);
    });

    it('rejects parent-directory traversal', () => {
        const r = locator.validatePath('/tmp/foo/../etc/passwd');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/parent-directory/);
    });

    it('rejects non-existent file with helpful hint', () => {
        const r = locator.validatePath('/nope/definitely/not/here');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/make all/);
    });

    it('rejects non-executable file with chmod hint', () => {
        const r = locator.validatePath(nonExecutable);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/chmod/);
    });

    it('accepts a real executable file', () => {
        const r = locator.validatePath(executable);
        expect(r.ok).toBe(true);
        expect(r.resolvedPath).toBe(executable);
        expect(typeof r.sizeBytes).toBe('number');
        expect(r.sizeBytes).toBeGreaterThan(0);
    });
});

describe('EnmBinaryLocator.smokeTest', () => {
    let tmpDir;
    let scriptThatPrintsVersion;
    let scriptThatHangs;
    let scriptWithNoVersion;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-smoke-'));

        scriptThatPrintsVersion = path.join(tmpDir, 'fake-ela-good');
        fs.writeFileSync(
            scriptThatPrintsVersion,
            '#!/bin/sh\necho "ELA Version v0.9.9.5"\n',
            { mode: 0o755 },
        );

        scriptThatHangs = path.join(tmpDir, 'fake-ela-hang');
        fs.writeFileSync(
            scriptThatHangs,
            '#!/bin/sh\nsleep 30\n',
            { mode: 0o755 },
        );

        scriptWithNoVersion = path.join(tmpDir, 'fake-ela-mute');
        fs.writeFileSync(
            scriptWithNoVersion,
            '#!/bin/sh\necho "no version line here"\n',
            { mode: 0o755 },
        );
    });

    it('extracts a version string from --version output', async () => {
        const r = await locator.smokeTest(scriptThatPrintsVersion);
        expect(r.ok).toBe(true);
        expect(r.version).toBe('v0.9.9.5');
        expect(r.output).toMatch(/v0\.9\.9\.5/);
    });

    it('rejects a binary whose --version produces no version-shaped output', async () => {
        const r = await locator.smokeTest(scriptWithNoVersion);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/version string/);
    });

    it('times out a hanging binary', async () => {
        const r = await locator.smokeTest(scriptThatHangs, { timeoutMs: 300 });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/signal|timeout/i);
    });

    it('reports spawn failures gracefully (non-existent path)', async () => {
        const r = await locator.smokeTest('/definitely/not/here');
        expect(r.ok).toBe(false);
        // Different platforms surface this as either spawn ENOENT or an error event.
        expect(typeof r.reason).toBe('string');
    });
});
