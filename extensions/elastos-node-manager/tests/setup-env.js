/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Vitest setup — gives every test file its own PC2_DATA_DIR under os.tmpdir()
 * so DataDir / EnmEncryption don't write to the operator's real directory.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enm-test-'));
process.env.PC2_DATA_DIR = dir;
