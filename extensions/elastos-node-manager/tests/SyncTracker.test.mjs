/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * SyncTracker tests — drive the velocity + ETA math with synthetic samples.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeEach } from 'vitest';

const { SyncTracker, MAX_SAMPLES, MIN_SAMPLES_FOR_VELOCITY, MAX_ETA_SEC, STALE_AGE_MS } =
    require('../lib/SyncTracker');

describe('SyncTracker — empty', () => {
    it('returns null fields when no samples', () => {
        const t = new SyncTracker();
        const snap = t.syncSnapshot('mainchain');
        expect(snap.localHeight).toBeNull();
        expect(snap.networkHeight).toBeNull();
        expect(snap.percent).toBeNull();
        expect(snap.velocityBpm).toBeNull();
        expect(snap.etaSec).toBeNull();
        expect(snap.sampleCount).toBe(0);
    });
});

describe('SyncTracker — record + retention', () => {
    it('drops out-of-order samples', () => {
        const t = new SyncTracker();
        t.record('m', 100, 1000);
        t.record('m', 99,  500); // ts before previous
        t.record('m', 101, 1000); // ts equal to previous
        const snap = t.syncSnapshot('m');
        expect(snap.sampleCount).toBe(1);
        expect(snap.localHeight).toBe(100);
    });

    it('rejects non-integer / negative heights', () => {
        const t = new SyncTracker();
        t.record('m', -1, 1000);
        t.record('m', 1.5, 1000);
        t.record('m', 'oops', 1000);
        expect(t.syncSnapshot('m').sampleCount).toBe(0);
    });

    it('caps the window at MAX_SAMPLES', () => {
        const t = new SyncTracker();
        for (let i = 0; i <= MAX_SAMPLES + 5; i++) {
            t.record('m', 1000 + i, 1_000_000 + i * 1000);
        }
        const snap = t.syncSnapshot('m');
        expect(snap.sampleCount).toBe(MAX_SAMPLES);
        // Latest sample is the one we just inserted.
        expect(snap.localHeight).toBe(1000 + MAX_SAMPLES + 5);
    });
});

describe('SyncTracker — velocity', () => {
    it('returns null until min-sample threshold is reached', () => {
        const t = new SyncTracker();
        t.record('m', 100, 1000);
        t.record('m', 110, 11000);
        // 2 samples — below MIN_SAMPLES_FOR_VELOCITY=3.
        expect(MIN_SAMPLES_FOR_VELOCITY).toBeGreaterThanOrEqual(2);
        const snap = t.syncSnapshot('m');
        if (MIN_SAMPLES_FOR_VELOCITY > 2) {
            expect(snap.velocityBpm).toBeNull();
        }
    });

    it('computes BPM from the rolling window', () => {
        const t = new SyncTracker();
        // 60 blocks across 60 seconds = 60 BPM exactly.
        t.record('m', 1000, 0);
        t.record('m', 1030, 30_000);
        t.record('m', 1060, 60_000);
        const snap = t.syncSnapshot('m');
        expect(snap.velocityBpm).toBeCloseTo(60, 1);
        expect(snap.windowMinutes).toBeCloseTo(1, 2);
    });
});

describe('SyncTracker — network reference + percent + ETA', () => {
    it('reports 100% and ETA=0 when caught up', () => {
        const t = new SyncTracker();
        t.record('m', 50, 0);
        t.record('m', 60, 30_000);
        t.record('m', 70, 60_000);
        t.recordNetworkBest('m', 70);
        const snap = t.syncSnapshot('m');
        expect(snap.percent).toBeCloseTo(100, 1);
        expect(snap.blocksBehind).toBe(0);
        expect(snap.etaSec).toBe(0);
    });

    it('computes ETA from velocity + blocks behind', () => {
        const t = new SyncTracker();
        // 600 blocks across 600s window = 60 BPM.
        t.record('m', 0,   0);
        t.record('m', 300, 300_000);
        t.record('m', 600, 600_000);
        // Network is 1200 → 600 blocks behind → at 60 bpm = 600 seconds = 600s ETA.
        t.recordNetworkBest('m', 1200);
        const snap = t.syncSnapshot('m');
        expect(snap.percent).toBeCloseTo(50, 1);
        expect(snap.blocksBehind).toBe(600);
        expect(snap.etaSec).toBe(600);
    });

    it('clamps ETA to MAX_ETA_SEC for absurdly slow chains', () => {
        const t = new SyncTracker();
        // 1 block per minute, 10 million blocks behind → ETA would be huge.
        t.record('m', 0, 0);
        t.record('m', 1, 60_000);
        t.record('m', 2, 120_000);
        t.recordNetworkBest('m', 10_000_002);
        const snap = t.syncSnapshot('m');
        expect(snap.etaSec).toBe(MAX_ETA_SEC);
    });

    it('returns null percent when no network reference', () => {
        const t = new SyncTracker();
        t.record('m', 100, 0);
        t.record('m', 200, 60_000);
        const snap = t.syncSnapshot('m');
        expect(snap.percent).toBeNull();
        expect(snap.etaSec).toBeNull();
        expect(snap.localHeight).toBe(200);
    });

    it('keeps the higher of two network-best observations (monotonic)', () => {
        const t = new SyncTracker();
        t.recordNetworkBest('m', 500);
        t.recordNetworkBest('m', 400);  // older / regressed peer report
        t.recordNetworkBest('m', 600);
        t.record('m', 300, 0);
        const snap = t.syncSnapshot('m');
        expect(snap.networkHeight).toBe(600);
    });
});

describe('SyncTracker — staleness', () => {
    it('flags stale=true when newest sample is older than STALE_AGE_MS', () => {
        const t = new SyncTracker();
        const longAgo = Date.now() - STALE_AGE_MS - 60_000;
        t.record('m', 100, longAgo);
        const snap = t.syncSnapshot('m');
        expect(snap.stale).toBe(true);
    });
});
