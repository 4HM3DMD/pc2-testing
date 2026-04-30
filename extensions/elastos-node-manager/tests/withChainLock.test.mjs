/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * withChainLock — must serialize work for the same chainId, must run work
 * for different chainIds in parallel, must not deadlock or starve.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';

const { withChainLock, _resetForTests } = require('../lib/withChainLock');

beforeEach(() => {
    _resetForTests();
});

describe('withChainLock', () => {
    it('runs operations for the same chainId sequentially (FIFO)', async () => {
        const events = [];
        const slow = async (label, ms) => withChainLock('mainchain', async () => {
            events.push(`start:${label}`);
            await new Promise((r) => setTimeout(r, ms));
            events.push(`end:${label}`);
            return label;
        });

        const [a, b, c] = await Promise.all([slow('A', 50), slow('B', 30), slow('C', 20)]);
        expect(a).toBe('A');
        expect(b).toBe('B');
        expect(c).toBe('C');
        expect(events).toEqual([
            'start:A', 'end:A',
            'start:B', 'end:B',
            'start:C', 'end:C',
        ]);
    });

    it('runs operations for different chainIds in parallel', async () => {
        const events = [];
        const work = (chain, ms) => withChainLock(chain, async () => {
            events.push(`start:${chain}`);
            await new Promise((r) => setTimeout(r, ms));
            events.push(`end:${chain}`);
        });
        await Promise.all([work('a', 30), work('b', 30)]);
        // Both starts should happen before either end.
        const aStartIdx = events.indexOf('start:a');
        const bStartIdx = events.indexOf('start:b');
        const aEndIdx   = events.indexOf('end:a');
        const bEndIdx   = events.indexOf('end:b');
        expect(aStartIdx).toBeGreaterThanOrEqual(0);
        expect(bStartIdx).toBeGreaterThanOrEqual(0);
        expect(Math.max(aStartIdx, bStartIdx)).toBeLessThan(Math.min(aEndIdx, bEndIdx));
    });

    it('releases the lock even when the operation throws', async () => {
        let secondRan = false;
        await expect(
            withChainLock('boom', async () => { throw new Error('first failed'); }),
        ).rejects.toThrow(/first failed/);
        // Second call must not deadlock waiting on the broken first.
        await withChainLock('boom', async () => { secondRan = true; });
        expect(secondRan).toBe(true);
    });

    it('rejects invalid chainId', async () => {
        await expect(withChainLock('', async () => 1)).rejects.toThrow(TypeError);
        await expect(withChainLock(null, async () => 1)).rejects.toThrow(TypeError);
    });

    it('rejects non-function fn', async () => {
        await expect(withChainLock('x', null)).rejects.toThrow(TypeError);
    });
});
