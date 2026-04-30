/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAppRegistry — registers ENM as a launcher app in PC2's apps table so
 * the operator sees an icon they can click in the dashboard.
 *
 * PC2's launcher reads from the `apps` table (seeded by 0002_add-default-apps.sql
 * with Terminal, Editor, etc). Extensions that want a launcher entry must
 * insert their own row. We do this idempotently in the extension's init
 * handler — INSERT OR IGNORE keyed by a stable uid so re-runs don't duplicate.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENM_APP_UID = 'app-elastos-node-manager-0001';

function loadIconAsDataUrl() {
    // public/assets/icon.svg is shipped with the extension. Inline as data URL
    // so the launcher renders it without an extra HTTP fetch (matches how
    // PC2's default apps store their icons).
    try {
        const iconPath = path.join(__dirname, '..', 'public', 'assets', 'icon.svg');
        const svg = fs.readFileSync(iconPath, 'utf8');
        const b64 = Buffer.from(svg, 'utf8').toString('base64');
        return `data:image/svg+xml;base64,${b64}`;
    } catch (err) {
        // Icon missing shouldn't block app registration — fall back to a
        // generic data URL pixel. The app still appears, just without art.
        return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
    }
}

async function registerLauncherApp(db) {
    const icon = loadIconAsDataUrl();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // INSERT OR IGNORE keyed by uid. If the row exists from a prior boot,
    // this is a no-op. Future updates to title/icon would require an explicit
    // UPDATE migration — we don't second-guess operator customizations.
    await db.write(
        `INSERT OR IGNORE INTO apps (
            uid, owner_user_id, icon, name, title, description,
            index_url, approved_for_listing, approved_for_opening_items,
            approved_for_incentive_program, godmode, maximize_on_start,
            timestamp, last_review
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            ENM_APP_UID,
            1, // owner: system user
            icon,
            'elastos-node-manager',
            'Elastos Node Manager',
            'Run and self-heal an Elastos mainchain node for BPoS supernode operators',
            // Served by our install.routes handler at /extensions/elastos-node-manager/
            // (see routes/index.js). Relative URL so it works regardless of host/port.
            '/extensions/elastos-node-manager/',
            1, // approved_for_listing — must be 1 to appear in launcher
            0, // approved_for_opening_items — we don't handle file opens
            0, // approved_for_incentive_program — N/A for self-hosted
            0, // godmode — no system-level access required
            1, // maximize_on_start — wizard works best fullscreen
            now,
            null,
        ]
    );
}

module.exports = {
    ENM_APP_UID,
    registerLauncherApp,
};
