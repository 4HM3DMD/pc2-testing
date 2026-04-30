/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * DataDir — extension's on-disk paths.
 *
 * Layout under PC2's data dir:
 *   ${PC2_DATA_DIR}/extensions/elastos-node-manager/
 *     ├── encryption.key                    # AES-256 master key (mode 0600)
 *     ├── config.json                       # operator-edited config (encrypted fields)
 *     ├── config.json.bak                   # previous version (atomic-write rollback)
 *     ├── chains/
 *     │   └── mainchain/
 *     │       ├── config.json               # generated for ela process
 *     │       ├── keystore.dat              # operator-imported (mode 0600, we never generate)
 *     │       ├── keystore-password.enc     # AES-encrypted, decrypted at spawn
 *     │       └── elastos/                  # ela's data dir (chain DB + logs)
 *     │           ├── data/                 # block files
 *     │           ├── logs/{node,dpos}/     # rotated by ela itself
 *     │           └── checkpoints/
 *     └── run/
 *         └── ela-mainchain.pid             # PID of running ela process
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { ENM_NAME } = require('./EnmConstants');

/**
 * Resolve PC2's data dir. PC2 sets process.env.PC2_DATA_DIR or defaults to ./data
 * (per pc2-node Dockerfile). We never hard-code an absolute path.
 *
 * @returns {string}
 */
function pc2DataDir() {
    return process.env.PC2_DATA_DIR || path.resolve(process.cwd(), 'data');
}

/**
 * Our extension's data dir, ensured to exist on first call.
 *
 * @returns {string}
 */
function enmDataDir() {
    const dir = path.join(pc2DataDir(), 'extensions', ENM_NAME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/**
 * Per-chain data dir. Currently only 'mainchain' for v0.1.
 *
 * @param {string} chainId
 * @returns {string}
 */
function chainDir(chainId) {
    if (!chainId || typeof chainId !== 'string') {
        throw new Error('DataDir.chainDir: chainId required');
    }
    if (!/^[a-z0-9-]+$/.test(chainId)) {
        // Defence against path traversal — chainId is operator-influenced via config.
        throw new Error(`DataDir.chainDir: invalid chainId "${chainId}"`);
    }
    const dir = path.join(enmDataDir(), 'chains', chainId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/**
 * Run-state dir for PID files and other transient process state.
 *
 * @returns {string}
 */
function runDir() {
    const dir = path.join(enmDataDir(), 'run');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/** PID file path for a given chain. */
function pidFilePath(chainId) {
    return path.join(runDir(), `ela-${chainId}.pid`);
}

/** Master encryption key path. */
function encryptionKeyPath() {
    return path.join(enmDataDir(), 'encryption.key');
}

/** Main extension config (separate from generated chain config.json). */
function configPath() {
    return path.join(enmDataDir(), 'config.json');
}

/** Backup of previous config (atomic-write rollback target). */
function configBackupPath() {
    return `${configPath()}.bak`;
}

/**
 * Atomic write: write to .tmp, then rename. POSIX rename is atomic; the file at
 * the target path is either the old version or the new — never half-written.
 *
 * @param {string} target absolute path
 * @param {string|Buffer} contents
 * @param {object} [opts] optional { mode } — defaults to 0o600
 * @returns {Promise<void>}
 */
async function atomicWrite(target, contents, opts) {
    const mode = (opts && typeof opts.mode === 'number') ? opts.mode : 0o600;
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, contents, { mode });
    await fsp.rename(tmp, target);
}

module.exports = {
    pc2DataDir,
    enmDataDir,
    chainDir,
    runDir,
    pidFilePath,
    encryptionKeyPath,
    configPath,
    configBackupPath,
    atomicWrite,
};
