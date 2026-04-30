/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * LogCompactor tests — drive compactNow against a temp chain dir with
 * synthetic log files at known mtimes. Verifies gzip + purge thresholds
 * and idempotency.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let tmpRoot;
beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-logcompact-'));
    process.env.PC2_DATA_DIR = tmpRoot;
    process.env.ENM_DATA_DIR = path.join(tmpRoot, 'extensions', 'elastos-node-manager');
    fs.mkdirSync(process.env.ENM_DATA_DIR, { recursive: true });
});
afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/DataDir')];
    delete require.cache[require.resolve('../lib/LogCompactor')];
});

async function writeOldLog(p, content, ageDays) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    const past = Date.now() - (ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(p, past / 1000, past / 1000);
}

describe('LogCompactor.compactNow', () => {
    it('gzips logs older than gzipAfterDays and skips fresh logs', async () => {
        const { compactNow } = require('../lib/LogCompactor');
        const { chainDir } = require('../lib/DataDir');
        const dir = chainDir('mainchain');
        const oldLog = path.join(dir, 'elastos/logs/node/old.log');
        const freshLog = path.join(dir, 'elastos/logs/node/fresh.log');
        await writeOldLog(oldLog, 'old log content '.repeat(1000), 30);
        await writeOldLog(freshLog, 'fresh content', 1);

        const report = await compactNow({ chainId: 'mainchain', gzipAfterDays: 7 });
        expect(report.gzipped).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(oldLog)).toBe(false); // gzipped, original removed
        expect(fs.existsSync(freshLog)).toBe(true); // untouched
        // A *.gz file should now exist near oldLog's directory.
        const ents = fs.readdirSync(path.dirname(oldLog));
        expect(ents.some((n) => n.endsWith('.gz'))).toBe(true);
    });

    it('purges *.gz older than purgeAfterDays', async () => {
        const { compactNow } = require('../lib/LogCompactor');
        const { chainDir } = require('../lib/DataDir');
        const dir = chainDir('mainchain');
        const oldGz = path.join(dir, 'elastos/logs/node/ancient.log.2024-01-01.gz');
        await writeOldLog(oldGz, 'compressed bytes', 200);

        const report = await compactNow({
            chainId: 'mainchain',
            gzipAfterDays: 7,
            purgeAfterDays: 90,
        });
        expect(report.purged).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(oldGz)).toBe(false);
        expect(report.bytesFreed).toBeGreaterThan(0);
    });

    it('is idempotent — second pass over the same dir is a no-op', async () => {
        const { compactNow } = require('../lib/LogCompactor');
        const { chainDir } = require('../lib/DataDir');
        const dir = chainDir('mainchain');
        const oldLog = path.join(dir, 'elastos/logs/node/old.log');
        await writeOldLog(oldLog, 'pad '.repeat(2000), 30);

        const r1 = await compactNow({ chainId: 'mainchain', gzipAfterDays: 7 });
        const r2 = await compactNow({ chainId: 'mainchain', gzipAfterDays: 7 });
        expect(r1.gzipped).toBeGreaterThanOrEqual(1);
        expect(r2.gzipped).toBe(0); // nothing left to do
    });

    it('returns an empty report when the chain dir has no logs', async () => {
        const { compactNow } = require('../lib/LogCompactor');
        const report = await compactNow({ chainId: 'mainchain' });
        expect(report.gzipped).toBe(0);
        expect(report.purged).toBe(0);
        expect(report.bytesFreed).toBe(0);
    });

    it('throws TypeError on missing chainId', async () => {
        const { compactNow } = require('../lib/LogCompactor');
        await expect(compactNow({})).rejects.toThrow(TypeError);
    });
});
