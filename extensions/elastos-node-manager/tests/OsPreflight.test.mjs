/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * OsPreflight tests — verifies the result shape and the platform-detection
 * logic. We don't fake /etc/os-release; we just assert the function returns
 * the expected fields for whatever the host actually is.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect } from 'vitest';
const os = require('node:os');

const osPreflight = require('../lib/OsPreflight');

describe('OsPreflight.check', () => {
    it('returns an object with ok + platform fields', () => {
        const result = osPreflight.check();
        expect(typeof result).toBe('object');
        expect(typeof result.ok).toBe('boolean');
        expect(['linux', 'darwin', 'win32', 'other']).toContain(result.platform);
    });

    it('refuses non-Linux hosts with a clear reason', () => {
        const result = osPreflight.check();
        if (os.platform() !== 'linux') {
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/Ubuntu\/Debian/);
        }
    });

    it('exposes the supported-distro list', () => {
        expect(osPreflight.SUPPORTED_DISTROS).toEqual(['ubuntu', 'debian']);
    });
});
