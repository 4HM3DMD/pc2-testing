/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * db.js — wraps better-sqlite3 to expose the Puter-extension `db.write` /
 * `db.read` shape that the ENM services were written against.
 *
 * The original ENM extension consumed `extension.import('data').db` from
 * Puter's kernel, which exposed:
 *
 *   db.write(sql, paramsArray)  → Promise<{ lastInsertRowid, changes }>
 *   db.read(sql, paramsArray)   → Promise<row[]>
 *
 * better-sqlite3 is synchronous, so we wrap each call in Promise.resolve().
 * SQL placeholder syntax (`?`) is identical, so route SQL ports verbatim.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

/**
 * @param {string} dbPath  absolute path to the SQLite file
 * @returns {{ raw: import('better-sqlite3').Database, write: Function, read: Function }}
 */
function openDb(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const raw = new Database(dbPath);
    // WAL gives us concurrent readers (the routes can hit the DB simultaneously).
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');

    return {
        raw,
        async write(sql, params = []) {
            return raw.prepare(sql).run(...(params || []));
        },
        async read(sql, params = []) {
            return raw.prepare(sql).all(...(params || []));
        },
    };
}

module.exports = { openDb };
