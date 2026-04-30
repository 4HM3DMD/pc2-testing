/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/setup.js — setup wizard endpoints (Phase 1b skeleton).
 *
 * Phase 1b ships the route shapes and preflight checks (OS, disk, binary path).
 * Phase 5 fills in the wizard's full step machine + per-step confirmation flow.
 *
 * Endpoints:
 *   GET  /api/setup/state       → wizard progress + last-completed step
 *   GET  /api/setup/preflight   → run OS + disk + wallet checks (read-only, no mutation)
 *   POST /api/setup/binary      → operator submits ela path → validatePath → store
 *   POST /api/setup/complete    → mark setup done (Phase 5 expansion: trigger first start)
 */

'use strict';

const express = require('express');

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../lib/EnmConstants');
const { limit } = require('../lib/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../lib/OwnerCheckMiddleware');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const osPreflight = require('../lib/OsPreflight');
const diskPreflight = require('../lib/DiskPreflight');
const binaryLocator = require('../lib/EnmBinaryLocator');
const { enmDataDir, chainDir, atomicWrite } = require('../lib/DataDir');
const ConfigStore = require('../lib/ConfigStore');
const { encrypt } = require('../lib/EnmEncryption');
const { ELA_DEFAULT_PORTS } = require('../lib/EnmConstants');
const ExtIpResolver = require('../lib/ExtIpResolver');
const crypto = require('node:crypto');
const { walletScopeId, validateKeystorePath } = require('../lib/EnmSetupHelpers');
const HostConflictScanner = require('../lib/HostConflictScanner');
const ChainRegistry = require('../lib/ChainRegistry');

/**
 * @param {object} extensionHandle
 * @returns {import('express').Router}
 */
function build(extensionHandle) {
    const router = express.Router();

    /**
     * GET /setup/state
     * Returns { completed, currentStep, ...flags } for the calling owner.
     */
    router.get('/state', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const { db } = extensionHandle.import('data');
            const rows = await db.read(
                `SELECT * FROM enm_setup_state WHERE wallet_address = ?`,
                [wallet],
            );
            if (!Array.isArray(rows) || rows.length === 0) {
                return res.json(successBody({
                    completed: false,
                    currentStep: 'welcome',
                    osCheckPassed: false,
                    diskCheckPassed: false,
                    walletCheckPassed: false,
                    binaryPath: null,
                    binaryVersion: null,
                    keystoreImported: false,
                    configGenerated: false,
                }));
            }
            const row = rows[0];
            return res.json(successBody({
                completed: row.completed === 1,
                currentStep: row.current_step,
                osCheckPassed: row.os_check_passed === 1,
                diskCheckPassed: row.disk_check_passed === 1,
                walletCheckPassed: row.wallet_check_passed === 1,
                binaryPath: row.binary_path,
                binaryVersion: row.binary_version,
                keystoreImported: row.keystore_imported === 1,
                configGenerated: row.config_generated === 1,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/state error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to load setup state.'));
        }
    });

    /**
     * GET /setup/conflicts
     * Scan the host for pre-existing Elastos state that would collide with
     * an ENM-managed run. Returns an array of conflicts; the wizard renders
     * each as a remediation card.
     *
     * Setup-time AND restart-time check — the start route calls this too and
     * refuses to spawn if any CRITICAL items are unresolved.
     */
    router.get('/conflicts', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const list = await HostConflictScanner.scan({
                logger: extensionHandle.log,
            });
            return res.json(successBody({
                conflicts: list,
                blockers: HostConflictScanner.blockers(list).length,
                total: list.length,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/conflicts: ${err.message}`);
            return res.status(500).json(errorBody('Conflict scan failed.'));
        }
    });

    /**
     * GET /setup/preflight
     * Read-only — runs OS + disk checks. The wallet check is implicit (this
     * endpoint requires authentication).
     */
    router.get('/preflight', limit('read'), async (req, res) => {
        const wallet = readActorWallet(req);
        if (!wallet) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const osResult = osPreflight.check();
            const diskResult = await diskPreflight.check(enmDataDir());
            return res.json(successBody({
                os: osResult,
                disk: diskResult,
                wallet: { ok: true, walletAddress: wallet },
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/preflight error: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * GET /setup/build-status
     *
     * Snapshot of the auto-build pipeline (idle / preparing / fetching-go /
     * cloning / building / verifying / done / failed / cancelled). The wizard
     * polls this as a fallback when SSE isn't available; the SSE topic
     * `setup:build` is the live channel.
     */
    router.get('/build-status', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const status = ChainRegistry.getAutoBuilder().getStatus();
            return res.json(successBody(status));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/build-status: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * POST /setup/auto-install-ela
     *
     * Kicks off the one-button "build ela for me" pipeline:
     *   1. Reuse system Go if version >= 1.20, else download official Go
     *      release into our private cache (no sudo, no PATH pollution).
     *   2. git clone Elastos.ELA, checkout the pinned tag (v0.9.9.5).
     *   3. make all  — output streamed to SSE topic `setup:build`.
     *   4. Smoke-test the resulting binary.
     *   5. Persist the resolved path in setup-state so the binary step
     *      auto-fills.
     *
     * Returns immediately. Caller subscribes to SSE for live progress or
     * polls /setup/build-status. Idempotent: a second call while a build is
     * in flight returns the existing status.
     */
    router.post('/auto-install-ela', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        try {
            const builder = ChainRegistry.getAutoBuilder();
            const result = builder.start({ ownerWallet: wallet });
            // Kick a background watcher: when the build finishes successfully,
            // persist the binary path into enm_setup_state so the wizard's
            // binary step picks it up without an extra round-trip.
            const onPhase = setInterval(async () => {
                const s = builder.getStatus();
                if (s.phase === 'done' && s.resolvedPath) {
                    clearInterval(onPhase);
                    try {
                        const { db } = extensionHandle.import('data');
                        await upsertSetupState(db, wallet, {
                            binary_path: s.resolvedPath,
                            binary_version: s.version || null,
                            current_step: 'keystore',
                        });
                    } catch (err) {
                        extensionHandle.log.warn(
                            `${ENM_LOG_PREFIX} auto-install: setup-state persist failed: ${err.message}`,
                        );
                    }
                } else if (s.phase === 'failed' || s.phase === 'cancelled') {
                    clearInterval(onPhase);
                }
            }, 2000);
            // Defensive cap — terminate the watcher after 30 min even if the
            // build hangs in some weird way, so we don't leak a timer.
            setTimeout(() => clearInterval(onPhase), 30 * 60 * 1000).unref?.();

            return res.status(result.alreadyRunning ? 202 : 200).json(successBody({
                alreadyRunning: result.alreadyRunning,
                status: result.status,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/auto-install-ela: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * DELETE /setup/auto-install-ela
     *
     * Cancel an in-flight build. Sends SIGTERM to the child (git/make/tar);
     * leaves the cache intact so a retry can resume from the cloned source.
     */
    router.delete('/auto-install-ela', limit('admin'), requireOwner, async (req, res) => {
        try {
            ChainRegistry.getAutoBuilder().cancel();
            return res.json(successBody(ChainRegistry.getAutoBuilder().getStatus()));
        } catch (err) {
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * POST /setup/binary  { binaryPath: string }
     * Phase 2: static validation + `./ela --version` smoke test.
     */
    router.post('/binary', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        const binaryPath = req.body && typeof req.body.binaryPath === 'string'
            ? req.body.binaryPath.trim()
            : '';

        const validation = binaryLocator.validatePath(binaryPath);
        if (!validation.ok) {
            return res.status(400).json(errorBody(validation.reason));
        }

        // Smoke test — confirm it actually runs and reports a version.
        const smoke = await binaryLocator.smokeTest(validation.resolvedPath);
        if (!smoke.ok) {
            return res.status(400).json(errorBody(`Binary failed --version smoke test: ${smoke.reason}`));
        }

        try {
            const { db } = extensionHandle.import('data');
            await upsertSetupState(db, wallet, {
                binary_path: validation.resolvedPath,
                binary_version: smoke.version,
                current_step: 'keystore',
            });
            return res.json(successBody({
                resolvedPath: validation.resolvedPath,
                sizeBytes: validation.sizeBytes,
                version: smoke.version,
                versionOutput: smoke.output,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/binary error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to persist setup state.'));
        }
    });

    /**
     * POST /setup/keystore  { keystorePath: string, keystorePassword: string, enableArbiter?: boolean }
     *
     * Operator's keystore.dat lives on their disk (we never generate per Rev 6
     * RNG-bug findings). We:
     *   1. Verify the path is an absolute file readable by us
     *   2. Copy it to chainDir/keystore.dat with mode 0600
     *   3. Encrypt the password with our AES-GCM and stash the envelope in
     *      enm_setup_state until /setup/complete folds it into the chain config
     *
     * If enableArbiter=false, keystorePath/Password may be empty — non-arbiter
     * (full-node) mode doesn't need a producer key.
     */
    router.post('/keystore', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        const body = req.body || {};
        const enableArbiter = body.enableArbiter !== false; // default to BPoS
        const keystorePath = typeof body.keystorePath === 'string' ? body.keystorePath.trim() : '';
        const keystorePassword = typeof body.keystorePassword === 'string' ? body.keystorePassword : '';

        try {
            if (!enableArbiter) {
                // Full-node mode: skip both, advance to network step.
                const { db } = extensionHandle.import('data');
                await upsertSetupState(db, wallet, {
                    keystore_imported: 1,
                    current_step: 'network',
                });
                return res.json(successBody({ enableArbiter: false, keystoreImported: false }));
            }

            // BPoS mode: keystore path + password are both required.
            const pathValidation = validateKeystorePath(keystorePath);
            if (!pathValidation.ok) {
                return res.status(400).json(errorBody(pathValidation.reason));
            }
            if (!keystorePassword || keystorePassword.length < 1) {
                return res.status(400).json(errorBody('keystorePassword is required for BPoS mode.'));
            }

            // Read source — confirms readability + size before we copy.
            let stat;
            try {
                stat = await fsp.stat(keystorePath);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return res.status(400).json(errorBody(`No file at ${keystorePath}.`));
                }
                return res.status(400).json(errorBody(`Cannot stat keystore: ${err.message}`));
            }
            if (!stat.isFile()) {
                return res.status(400).json(errorBody('keystorePath is not a regular file.'));
            }
            // Reasonable upper bound — keystore.dat is typically <10 KB.
            if (stat.size > 1_048_576) {
                return res.status(400).json(errorBody('keystore is implausibly large (>1 MB).'));
            }

            // Copy to chain dir at mode 0600.
            const dir = chainDir('mainchain');
            await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
            const dest = path.join(dir, 'keystore.dat');
            const data = await fsp.readFile(keystorePath);
            await atomicWrite(dest, data, { mode: 0o600 });

            // Encrypt the password — envelope stays in enm_setup_state until
            // /setup/complete folds it into the chain config.
            const envelope = encrypt(keystorePassword);

            const { db } = extensionHandle.import('data');
            await upsertSetupState(db, wallet, {
                keystore_imported: 1,
                current_step: 'network',
            });
            // Stash the envelope on a side channel — we don't want it in
            // enm_setup_state (long-term row, indexed by wallet); instead
            // write a sealed file under the data dir, mode 0600. /setup/complete
            // reads + deletes it.
            const stashPath = path.join(enmDataDir(), `.setup-keystore-${walletScopeId(wallet)}.json`);
            await atomicWrite(stashPath, JSON.stringify({ envelope }), { mode: 0o600 });

            return res.json(successBody({
                enableArbiter: true,
                keystoreImported: true,
                size: stat.size,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/keystore error: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * POST /setup/network  { mode: 'auto'|'manual', manualValue?: string }
     *
     * Records the IP override choice in enm_setup_state. /setup/complete reads
     * this and writes it into the chain config.
     */
    router.post('/network', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        const body = req.body || {};
        const mode = body.mode === 'manual' ? 'manual' : 'auto';
        const manualValue = typeof body.manualValue === 'string' ? body.manualValue.trim() : '';

        try {
            // If mode=manual, validate the value here so we surface errors
            // before /setup/complete (which would otherwise reject via joi).
            if (mode === 'manual') {
                const validation = ExtIpResolver.validateOverride(manualValue);
                if (!validation.ok) {
                    return res.status(400).json(errorBody(validation.reason));
                }
            }
            const { db } = extensionHandle.import('data');
            await upsertSetupState(db, wallet, {
                current_step: 'confirm',
            });
            // Stash network choice — /setup/complete reads it.
            const stashPath = path.join(enmDataDir(), `.setup-network-${walletScopeId(wallet)}.json`);
            await atomicWrite(
                stashPath,
                JSON.stringify({ mode, manualValue: mode === 'manual' ? manualValue : null }),
                { mode: 0o600 },
            );
            return res.json(successBody({ mode, manualValue: mode === 'manual' ? manualValue : null }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/network error: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * POST /setup/complete
     *
     * Final step. Reads the binary, keystore-envelope, and network choice
     * stashes; composes a chains.mainchain config; auto-generates a strong
     * RPC password (32-byte hex); writes the config; deletes the stashes.
     *
     * Does NOT start the chain — that's a separate explicit POST /chains/...
     * /start by the operator. v0.2 may add an optional auto-start flag.
     */
    router.post('/complete', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        try {
            const { db } = extensionHandle.import('data');
            const stateRows = await db.read(
                `SELECT binary_path, binary_version FROM enm_setup_state WHERE wallet_address = ?`,
                [wallet],
            );
            const stateRow = (Array.isArray(stateRows) && stateRows[0]) || null;
            if (!stateRow || !stateRow.binary_path) {
                return res.status(409).json(errorBody(
                    'Cannot complete setup: binary path missing. Restart the wizard.',
                ));
            }

            // --- Read the keystore stash if BPoS, else null. ---
            const ksStashPath = path.join(enmDataDir(), `.setup-keystore-${walletScopeId(wallet)}.json`);
            let keystoreEnvelope = '';
            let enableArbiter = false;
            try {
                const ks = JSON.parse(await fsp.readFile(ksStashPath, 'utf8'));
                if (ks && typeof ks.envelope === 'string') {
                    keystoreEnvelope = ks.envelope;
                    enableArbiter = true;
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    extensionHandle.log.warn(
                        `${ENM_LOG_PREFIX} /setup/complete: keystore stash read failed: ${err.message}`,
                    );
                }
            }

            // --- Read the network stash. ---
            const netStashPath = path.join(enmDataDir(), `.setup-network-${walletScopeId(wallet)}.json`);
            let ipMode = 'auto';
            let ipManual = null;
            try {
                const net = JSON.parse(await fsp.readFile(netStashPath, 'utf8'));
                if (net && net.mode) ipMode = net.mode;
                if (net && net.manualValue) ipManual = net.manualValue;
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    extensionHandle.log.warn(
                        `${ENM_LOG_PREFIX} /setup/complete: network stash read failed: ${err.message}`,
                    );
                }
            }

            // --- Generate a strong RPC password. The operator can override
            // it later via Settings → Mainchain Advanced. ---
            const rpcPasswordPlain = crypto.randomBytes(24).toString('hex');
            const rpcPasswordEnvelope = encrypt(rpcPasswordPlain);

            // --- Compose chains.mainchain config. ---
            const cfg = await ConfigStore.load();
            cfg.chains = cfg.chains || {};
            cfg.chains.mainchain = {
                enabled: true,
                binaryPath: stateRow.binary_path,
                binaryVersion: stateRow.binary_version || null,
                dataDir: chainDir('mainchain'),
                activeNet: 'mainnet',
                ports: { ...ELA_DEFAULT_PORTS },
                rpc: {
                    user: 'ela',
                    passwordEncrypted: rpcPasswordEnvelope,
                    whiteIPList: ['127.0.0.1'],
                },
                dpos: {
                    enableArbiter,
                    ipAddressMode: ipMode,
                    ipAddressManual: ipManual,
                    refreshOnRestart: true,
                    ownerPublicKey: '',
                    nodePublicKey: '',
                    keystorePasswordEncrypted: keystoreEnvelope,
                },
                memoryLimitMb: 4096,
                archiveMode: false,
                logLevel: 'info',
            };
            cfg.setup = cfg.setup || {};
            cfg.setup.completed = true;
            cfg.setup.completedAt = Date.now();
            cfg.setup.completedStep = 'complete';

            await ConfigStore.save(cfg, { logger: extensionHandle.log });

            // --- Mark setup-state row complete. ---
            const now = Date.now();
            await upsertSetupState(db, wallet, {
                completed: 1,
                config_generated: 1,
                current_step: 'complete',
                completed_at: now,
            });

            // --- Clean up stashes (best-effort — they're mode 0600 and would
            // be safe to leave, but tidy is better). ---
            await fsp.unlink(ksStashPath).catch(() => {});
            await fsp.unlink(netStashPath).catch(() => {});

            return res.json(successBody({
                completed: true,
                completedAt: now,
                enableArbiter,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/complete error: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    return router;
}

// walletScopeId + validateKeystorePath are imported from EnmSetupHelpers so
// they can be unit-tested without pulling Express into the test environment.

/**
 * Insert-or-update enm_setup_state for a wallet. Builds dynamic SQL from the
 * provided fields so Phase 5 can extend without rewriting.
 *
 * @param {object} db
 * @param {string} walletAddress
 * @param {object} fields
 */
async function upsertSetupState(db, walletAddress, fields) {
    const now = Date.now();
    const existing = await db.read(
        `SELECT 1 FROM enm_setup_state WHERE wallet_address = ?`,
        [walletAddress],
    );

    if (Array.isArray(existing) && existing.length > 0) {
        const setParts = [];
        const args = [];
        for (const [k, v] of Object.entries(fields)) {
            setParts.push(`${k} = ?`);
            args.push(v);
        }
        setParts.push('updated_at = ?');
        args.push(now);
        args.push(walletAddress);
        await db.write(
            `UPDATE enm_setup_state SET ${setParts.join(', ')} WHERE wallet_address = ?`,
            args,
        );
        return;
    }

    // First insert — fill required defaults.
    const cols = ['wallet_address', 'started_at', 'updated_at'];
    const vals = [walletAddress, now, now];
    for (const [k, v] of Object.entries(fields)) {
        cols.push(k);
        vals.push(v);
    }
    const placeholders = cols.map(() => '?').join(', ');
    await db.write(
        `INSERT INTO enm_setup_state (${cols.join(', ')}) VALUES (${placeholders})`,
        vals,
    );
}

module.exports = {
    build,
};
