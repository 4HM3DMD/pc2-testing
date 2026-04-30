/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * OsPreflight — Ubuntu/Debian detection.
 *
 * v0.1 supports Ubuntu/Debian only. We detect via /etc/os-release (the standard
 * cross-distro identification file) and refuse other OSes during setup.
 *
 * Reads ID and ID_LIKE per https://www.freedesktop.org/software/systemd/man/os-release.html
 *
 * Returns a structured result so the setup wizard can surface platform-specific
 * guidance ("we detected Fedora; v0.1 is Ubuntu/Debian only — see roadmap").
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');

const SUPPORTED_DISTROS = Object.freeze(['ubuntu', 'debian']);
const SUPPORTED_LIKE = Object.freeze(['debian']); // covers Ubuntu derivatives

/**
 * @typedef {object} OsPreflightResult
 * @property {boolean} ok
 * @property {'linux'|'darwin'|'win32'|'other'} platform
 * @property {string} [distroId]   from os-release ID
 * @property {string} [distroLike] from os-release ID_LIKE
 * @property {string} [version]    from os-release VERSION_ID
 * @property {string} [reason]     human-readable explanation
 */

/**
 * Inspect the host OS. Always synchronous, never throws — returns ok=false
 * with a reason instead.
 *
 * @returns {OsPreflightResult}
 */
function check() {
    const platform = os.platform();
    if (platform !== 'linux') {
        return {
            ok: false,
            platform: mapPlatform(platform),
            reason: `Elastos Node Manager v0.1 supports Ubuntu/Debian only. Detected ${platform}. macOS/Windows support is planned for v0.2.`,
        };
    }

    const release = readOsRelease();
    if (!release) {
        return {
            ok: false,
            platform: 'linux',
            reason: 'Could not read /etc/os-release. Cannot verify this is Ubuntu/Debian.',
        };
    }

    const distroId = (release.ID || '').toLowerCase().trim();
    const distroLike = (release.ID_LIKE || '').toLowerCase().trim();
    const version = release.VERSION_ID;

    if (SUPPORTED_DISTROS.includes(distroId)) {
        return { ok: true, platform: 'linux', distroId, distroLike, version };
    }

    // Some operators run derivatives (Linux Mint, Pop!_OS, Kali) that ID_LIKE=debian.
    // Allow them — they share the same APT/glibc/systemd assumptions.
    if (distroLike && SUPPORTED_LIKE.some((s) => distroLike.includes(s))) {
        return { ok: true, platform: 'linux', distroId, distroLike, version };
    }

    return {
        ok: false,
        platform: 'linux',
        distroId,
        distroLike,
        version,
        reason: `Elastos Node Manager v0.1 supports Ubuntu/Debian only. Detected ${distroId || 'unknown'}.`,
    };
}

/**
 * Parse /etc/os-release into a flat object. Returns null if the file is missing
 * or malformed.
 *
 * @returns {Object<string,string>|null}
 */
function readOsRelease() {
    let raw;
    try {
        raw = fs.readFileSync('/etc/os-release', 'utf8');
    } catch {
        return null;
    }
    const out = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const key = trimmed.slice(0, eq);
        let value = trimmed.slice(eq + 1);
        // Values may be quoted: KEY="value with spaces"
        if (value.length >= 2
            && (value[0] === '"' || value[0] === "'")
            && value[value.length - 1] === value[0]) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

/**
 * @param {string} p
 * @returns {'linux'|'darwin'|'win32'|'other'}
 */
function mapPlatform(p) {
    if (p === 'linux' || p === 'darwin' || p === 'win32') {
        return p;
    }
    return 'other';
}

module.exports = {
    check,
    SUPPORTED_DISTROS,
};
