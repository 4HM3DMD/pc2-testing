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

const { ENM_LOG_PREFIX, errorBody, successBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');
const { requireOwner, readActorWallet } = require('../auth/OwnerCheckMiddleware');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const osPreflight = require('../services/OsPreflight');
const diskPreflight = require('../services/DiskPreflight');
const ClockSkewChecker = require('../services/ClockSkewChecker');
const binaryLocator = require('../services/EnmBinaryLocator');
const { enmDataDir, chainDir, atomicWrite } = require('../services/DataDir');
const ConfigStore = require('../services/ConfigStore');
const { encrypt } = require('../services/EnmEncryption');
const { ELA_DEFAULT_PORTS } = require('../services/EnmConstants');
const ExtIpResolver = require('../services/ExtIpResolver');
const crypto = require('node:crypto');
const { walletScopeId, validateKeystorePath } = require('../services/EnmSetupHelpers');
const HostConflictScanner = require('../services/HostConflictScanner');
const ChainRegistry = require('../services/ChainRegistry');

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
    router.get('/conflicts', limit('read'), requireOwner, async (req, res) => {
        // requireOwner — the conflict scan reveals host fingerprinting
        // (PID files, port usage, binary paths) that we don't want to
        // expose to non-owner authenticated callers.
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
            const clockSkewResult = await runClockSkewCheck(extensionHandle);

            // Persist the booleans into setup-state so /setup/state and any
            // later UI surface (e.g., dashboard health tile) can show
            // "preflight passed" without re-running the checks.
            try {
                const { db } = extensionHandle.import('data');
                await upsertSetupState(db, wallet, {
                    os_check_passed: osResult && osResult.ok ? 1 : 0,
                    disk_check_passed: diskResult && diskResult.status !== 'critical' ? 1 : 0,
                    wallet_check_passed: 1,
                });
            } catch (persistErr) {
                extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} /setup/preflight: persist failed: ${persistErr.message}`,
                );
            }

            return res.json(successBody({
                os: osResult,
                disk: diskResult,
                wallet: { ok: true, walletAddress: wallet },
                clockSkew: clockSkewResult,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/preflight error: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * GET /setup/install-status/:chainId
     *
     * Snapshot of the binary installer state-machine for a single chain.
     * Uses getStatusWithDisk so a container restart doesn't make us forget
     * that the binary is already installed.
     */
    router.get('/install-status/:chainId', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const status = await ChainRegistry.getBinaryDownloader()
                .getStatusWithDisk(req.params.chainId);
            return res.json(successBody(status));
        } catch (err) {
            return res.status(400).json(errorBody(err.message));
        }
    });

    /**
     * GET /setup/chains
     *
     * Catalog of chains we know how to install AND start. We hide chains
     * that are downloadable but have no chain adapter — exposing them
     * would let the wizard install esc/eid/eco and then the dashboard's
     * Start button would 404. Better to keep them invisible until the
     * matching adapters land.
     */
    router.get('/chains', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const wired = new Set(ChainRegistry.listChains().map((c) => c.chainId));
            const chains = ChainRegistry.getBinaryDownloader()
                .listChains()
                .filter((c) => wired.has(c.chainId));
            return res.json(successBody({ chains }));
        } catch (err) {
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * POST /setup/install/:chainId
     *
     * Download + extract + verify the latest release of the given chain
     * from download.elastos.io. Mirrors what node.sh does — pre-built
     * tarballs only, no source build, no Go toolchain.
     *
     * Returns immediately. Caller subscribes to SSE topic
     * `setup:install:<chainId>` for live progress or polls
     * /setup/install-status/:chainId. Idempotent.
     */
    router.post('/install/:chainId', limit('write'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        const chainId = req.params.chainId;
        try {
            const dl = ChainRegistry.getBinaryDownloader();
            const result = await dl.start(chainId);

            // Watcher: when the install finishes, persist into setup-state so
            // the wizard's "downloaded ela" tile checks itself, and so a later
            // /setup/complete can find the path without another round-trip.
            // Mainchain-only — sidechains track their own paths via the chain
            // adapter once we wire those up.
            if (chainId === 'mainchain') {
                const onPhase = setInterval(async () => {
                    const s = dl.getStatus(chainId);
                    if (s.phase === 'done' && s.binaryPath) {
                        clearInterval(onPhase);
                        try {
                            const { db } = extensionHandle.import('data');
                            await upsertSetupState(db, wallet, {
                                binary_path: s.binaryPath,
                                binary_version: s.version || null,
                                current_step: 'keystore',
                            });
                        } catch (err) {
                            extensionHandle.log.warn(
                                `${ENM_LOG_PREFIX} install ${chainId}: setup-state persist failed: ${err.message}`,
                            );
                        }
                    } else if (s.phase === 'failed') {
                        clearInterval(onPhase);
                    }
                }, 2000);
                setTimeout(() => clearInterval(onPhase), 15 * 60 * 1000).unref?.();
            } else if (['esc', 'eid', 'pg'].includes(chainId)) {
                // beta.4.02 (Wave M3.8) — Class B post-install hook.
                // Writes the resolved binaryPath + binaryVersion back into
                // cfg.chains[chainId] so the chain becomes startable
                // (cfg.binaryPath was empty after M3.5's install-class-b).
                // Does NOT flip enabled=true automatically — operator
                // decides when to bring it online via the chain-card
                // Start button.
                const onPhase = setInterval(async () => {
                    const s = dl.getStatus(chainId);
                    if (s.phase === 'done' && s.binaryPath) {
                        clearInterval(onPhase);
                        try {
                            const cfg = await ConfigStore.load();
                            if (cfg.chains && cfg.chains[chainId]) {
                                cfg.chains[chainId].binaryPath = s.binaryPath;
                                cfg.chains[chainId].binaryVersion = s.version || '';
                                await ConfigStore.save(cfg);
                                extensionHandle.log.info(
                                    `${ENM_LOG_PREFIX} install ${chainId} (Class B): wrote `
                                    + `binaryPath=${s.binaryPath} version=${s.version || 'unknown'} into cfg`,
                                );
                            }
                        } catch (err) {
                            extensionHandle.log.warn(
                                `${ENM_LOG_PREFIX} install ${chainId}: cfg persist failed: ${err.message}`,
                            );
                        }
                    } else if (s.phase === 'failed') {
                        clearInterval(onPhase);
                    }
                }, 2000);
                setTimeout(() => clearInterval(onPhase), 15 * 60 * 1000).unref?.();
            }

            return res.status(result.alreadyRunning ? 202 : 200).json(successBody({
                alreadyRunning: result.alreadyRunning,
                status: result.status,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/install/${chainId}: ${err.message}`);
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
                // alpha.10: binary install advances into the bootstrap-or-genesis
                // choice card (was: straight to keystore). The wizard renders
                // Card B2; the operator's pick advances on to 'keystore' via
                // POST /setup/bootstrap below.
                current_step: 'bootstrap',
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
     * POST /setup/bootstrap  { choice: 'bootstrap' | 'genesis' }
     *
     * Records the operator's pick on Card B2 (fast-sync via snapshot, or
     * genesis sync from block 0) and advances the wizard to the keystore
     * card.
     *
     * This route does NOT trigger the download itself — the wizard hits
     * POST /chains/<id>/bootstrap directly so the existing progress UI
     * pattern (single-flight + SSE topic) works without setup-route
     * coupling. /setup/bootstrap is purely a step-transition + audit.
     */
    router.post('/bootstrap', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        const choice = req.body && req.body.choice;
        if (choice !== 'bootstrap' && choice !== 'genesis') {
            return res.status(400).json(errorBody(
                'choice must be "bootstrap" or "genesis".',
            ));
        }
        try {
            const { db } = extensionHandle.import('data');
            // The choice itself isn't persisted to setup_state — the table
            // doesn't have a bootstrap_choice column yet and adding one
            // requires a migration we don't need for v1. The audit log
            // captures the action via the standard middleware.
            await upsertSetupState(db, wallet, {
                current_step: 'keystore',
            });
            return res.json(successBody({ choice, currentStep: 'keystore' }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/bootstrap error: ${err.message}`);
            return res.status(500).json(errorBody('Failed to persist setup state.'));
        }
    });

    /**
     * POST /setup/keystore  { password?: string, enableArbiter?: boolean }
     *
     * Generates a fresh keystore.dat by invoking ela-cli wallet create — same
     * exact command node.sh runs (build/skeleton/node.sh:1317). The operator
     * never has to touch a file path. If `password` is omitted, we generate a
     * 32-char random one and surface it back exactly once in the response;
     * the caller is responsible for showing it to the operator and offering
     * a download.
     *
     * Returns the resulting public key + address so the wizard can show the
     * producer identity for registration (Essentials mobile or server-side
     * `producer register v2`).
     */
    router.post('/keystore', limit('admin'), requireOwner, async (req, res) => {
        const wallet = readActorWallet(req);
        const body = req.body || {};
        const enableArbiter = body.enableArbiter !== false; // default to BPoS
        const password = typeof body.password === 'string' ? body.password : '';
        const ksStashPath = path.join(enmDataDir(), `.setup-keystore-${walletScopeId(wallet)}.json`);

        try {
            if (!enableArbiter) {
                // Full-node mode: no keystore needed, AND clear any stash
                // from a previous BPoS attempt — otherwise /setup/complete
                // would still see it and write enableArbiter=true into the
                // chain config.
                await fsp.unlink(ksStashPath).catch(() => {});
                const { db } = extensionHandle.import('data');
                await upsertSetupState(db, wallet, {
                    keystore_imported: 1,
                    current_step: 'network',
                });
                return res.json(successBody({ enableArbiter: false, keystoreImported: false }));
            }

            // Resolve ela-cli — first the in-memory downloader status
            // (fast path during a single install session), then the disk
            // (so a container restart doesn't break this step).
            const dl = ChainRegistry.getBinaryDownloader();
            const onDisk = await dl.getStatusWithDisk('mainchain');
            const cliPath = onDisk.cliPath;
            if (!cliPath) {
                return res.status(409).json(errorBody(
                    'ela-cli not yet installed. Complete the binary install step first.',
                ));
            }

            // beta.3.42 — if a keystore.dat already exists on disk AND
            // the operator didn't pass force=true, REUSE it instead of
            // generating a new one. Two paths reach this branch:
            //   1. Operator wiped chain data but kept the keystore
            //      (Chain Resync flow), then re-walked the wizard.
            //   2. Operator nuked + reinstalled, manually restored
            //      keystore.dat (today's flow on the test server).
            //
            // We still mark keystore_imported=1 in setup_state and
            // skip the "stash password" path because we don't HAVE
            // the password — the keystore was generated by a previous
            // wizard run that already showed + saved it. The dashboard's
            // node-identity tile reads keystore-account.json which the
            // earlier wizard run wrote alongside the keystore.
            const KEYSTORE_FILENAME = 'keystore.dat';
            const existingKeystore = path.join(chainDir('mainchain'), KEYSTORE_FILENAME);
            if (!body.force && fs.existsSync(existingKeystore)) {
                extensionHandle.log.info(
                    `${ENM_LOG_PREFIX} /setup/keystore: reusing existing keystore at ${existingKeystore} (force=false)`,
                );
                // Try to read the cached identity file so we can return
                // the pubkey + address. Missing identity file is OK — the
                // wizard advances on keystore_imported regardless.
                const identityPath = path.join(chainDir('mainchain'), 'keystore-account.json');
                let identity = null;
                try {
                    identity = JSON.parse(await fsp.readFile(identityPath, 'utf8'));
                } catch (_) { /* missing/unreadable — null is acceptable */ }
                const { db: db0 } = extensionHandle.import('data');
                await upsertSetupState(db0, wallet, {
                    keystore_imported: 1,
                    current_step: 'network',
                });
                return res.json(successBody({
                    enableArbiter: true,
                    keystoreImported: true,
                    reused: true,
                    publicKey: identity && identity.publicKey || null,
                    address: identity && identity.address || null,
                    // No generatedPassword — we don't know it, and we
                    // explicitly did NOT generate a new keystore.
                    generatedPassword: null,
                }));
            }

            const ks = ChainRegistry.getKeystoreService();
            const result = await ks.create({
                cliPath,
                password: password || undefined,
                force: !!body.force,
            });

            // Encrypt + stash the password (consumed by /setup/complete).
            const envelope = encrypt(result.password);
            await atomicWrite(ksStashPath, JSON.stringify({
                envelope,
                publicKey: result.publicKey,
                address: result.address,
            }), { mode: 0o600 });

            // Cache the public identity (NOT the password) to a separate
            // file the dashboard's "node identity" tile can read without
            // a password. This file is NOT deleted by /setup/complete —
            // we want it to persist for the lifetime of the keystore.
            const identityPath = path.join(chainDir('mainchain'), 'keystore-account.json');
            await atomicWrite(identityPath, JSON.stringify({
                publicKey: result.publicKey,
                address: result.address,
                generatedAt: Date.now(),
            }), { mode: 0o600 });

            const { db } = extensionHandle.import('data');
            await upsertSetupState(db, wallet, {
                keystore_imported: 1,
                current_step: 'network',
            });

            return res.json(successBody({
                enableArbiter: true,
                keystoreImported: true,
                publicKey: result.publicKey,
                address: result.address,
                // Surfaced to the UI exactly once. The UI MUST prompt the
                // operator to save this — losing it means losing the
                // producer key permanently.
                generatedPassword: password ? null : result.password,
            }));
        } catch (err) {
            extensionHandle.log.error(`${ENM_LOG_PREFIX} /setup/keystore error: ${err.message}`);
            return res.status(500).json(errorBody(err.message));
        }
    });

    /**
     * GET /setup/keystore/account
     *
     * Returns the current keystore's public key + address from the
     * cached keystore-account.json (written at /setup/keystore time).
     * No password needed because we store the public material in plain
     * JSON when we generate the keystore — the encrypted parts stay in
     * keystore.dat. Used by the dashboard's node-identity tile.
     */
    router.get('/keystore/account', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const ks = ChainRegistry.getKeystoreService();
            const exists = await ks.exists();
            if (!exists) {
                return res.json(successBody({ exists: false }));
            }
            const identityPath = path.join(chainDir('mainchain'), 'keystore-account.json');
            let publicKey = null;
            let address = null;
            try {
                const raw = await fsp.readFile(identityPath, 'utf8');
                const parsed = JSON.parse(raw);
                publicKey = parsed.publicKey || null;
                address = parsed.address || null;
            } catch (_) {
                // No cached identity — keystore was created by an older
                // build, or the file was deleted. The dashboard treats
                // missing pubkey as "regenerate not required, but we
                // can't show the producer identity right now."
            }
            return res.json(successBody({
                exists: true,
                keystorePath: ks.keystorePath(),
                publicKey,
                address,
            }));
        } catch (err) {
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

    // beta.3.98 (Wave M3.4) — Layer 1 setup wizard endpoints.
    //
    // The Council operator answers two strategy questions BEFORE
    // installing the first non-mainchain chain:
    //   1. Password strategy: one EVM keystore password for all
    //      sidechains, or per-chain.
    //   2. Miner-address strategy: one Ethereum address for all chains,
    //      or per-chain.
    //
    // GET /setup/council-strategy returns the current state (or empty
    // object if not yet answered). POST persists answers. The M3.5
    // install wizard checks this state before any Class B install:
    // if either strategy is missing, the Layer 1 cards are shown first.

    router.get('/council-strategy', limit('read'), async (req, res) => {
        if (!readActorWallet(req)) {
            return res.status(401).json(errorBody('Authentication required.'));
        }
        try {
            const cfg = await ConfigStore.load();
            const c = (cfg.global && cfg.global.council) || {};
            // Don't echo the encrypted password back over the wire — the
            // operator never sees ciphertext in the UI, and exposing it
            // would let a read-only viewer attempt offline decryption.
            // Surface a `hasSharedPassword` bool instead.
            return res.json(successBody({
                passwordStrategy: c.passwordStrategy || null,
                hasSharedPassword: !!(c.sharedPasswordEncrypted),
                minerAddressStrategy: c.minerAddressStrategy || null,
                sharedMinerAddress: c.sharedMinerAddress || '',
                setupCompletedAt: c.setupCompletedAt || null,
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} GET /setup/council-strategy: ${err.message}`,
            );
            return res.status(500).json(errorBody(err.message));
        }
    });

    router.post('/council-strategy', limit('admin'), requireOwner, async (req, res) => {
        try {
            const body = req.body || {};
            const cfg = await ConfigStore.load();
            const council = (cfg.global && cfg.global.council) || {};
            // Password strategy.
            if (body.passwordStrategy !== undefined) {
                const ps = String(body.passwordStrategy);
                if (!['shared', 'per-chain'].includes(ps)) {
                    return res.status(400).json(errorBody(
                        'passwordStrategy must be one of "shared" | "per-chain"',
                    ));
                }
                council.passwordStrategy = ps;
                if (ps === 'shared') {
                    // Require operator to supply the actual password so we
                    // can encrypt it now (per-chain installs reuse this
                    // ciphertext rather than re-prompting). H24: never
                    // store plaintext.
                    if (typeof body.sharedPassword !== 'string' || body.sharedPassword.length < 16) {
                        return res.status(400).json(errorBody(
                            'sharedPassword required (16+ chars) when passwordStrategy="shared". '
                            + 'Use EnmCrypto.generatePassword for a complexity-compliant random.',
                        ));
                    }
                    const EnmCrypto = require('../services/EnmCrypto');
                    if (!EnmCrypto.validatePasswordComplexity(body.sharedPassword)) {
                        return res.status(400).json(errorBody(
                            'sharedPassword fails complexity: must be 16+ chars with upper, lower, digit, non-alnum',
                        ));
                    }
                    council.sharedPasswordEncrypted = EnmCrypto.encrypt(body.sharedPassword);
                } else {
                    // Per-chain — clear any prior shared envelope.
                    council.sharedPasswordEncrypted = '';
                }
            }
            // Miner-address strategy.
            if (body.minerAddressStrategy !== undefined) {
                const ms = String(body.minerAddressStrategy);
                if (!['shared', 'per-chain'].includes(ms)) {
                    return res.status(400).json(errorBody(
                        'minerAddressStrategy must be one of "shared" | "per-chain"',
                    ));
                }
                council.minerAddressStrategy = ms;
                if (ms === 'shared') {
                    if (typeof body.sharedMinerAddress !== 'string' || body.sharedMinerAddress.length === 0) {
                        return res.status(400).json(errorBody(
                            'sharedMinerAddress required when minerAddressStrategy="shared"',
                        ));
                    }
                    const EnmCrypto = require('../services/EnmCrypto');
                    const v = EnmCrypto.validateEthAddress(body.sharedMinerAddress);
                    if (!v.valid) {
                        return res.status(400).json(errorBody(
                            `sharedMinerAddress: ${v.warning}`,
                        ));
                    }
                    council.sharedMinerAddress = v.normalized || body.sharedMinerAddress;
                } else {
                    council.sharedMinerAddress = '';
                }
            }
            // Mark setup-complete when both strategies are set + at least
            // one of them was passed in this request (i.e. the operator
            // just finalized).
            if (council.passwordStrategy && council.minerAddressStrategy) {
                council.setupCompletedAt = Date.now();
            }
            // Ensure the council subdoc exists on cfg.global.
            cfg.global = cfg.global || {};
            cfg.global.council = council;
            await ConfigStore.save(cfg);
            extensionHandle.log.info(
                `${ENM_LOG_PREFIX} POST /setup/council-strategy saved: `
                + `password=${council.passwordStrategy} address=${council.minerAddressStrategy}`,
            );
            return res.json(successBody({
                passwordStrategy: council.passwordStrategy || null,
                hasSharedPassword: !!council.sharedPasswordEncrypted,
                minerAddressStrategy: council.minerAddressStrategy || null,
                sharedMinerAddress: council.sharedMinerAddress || '',
                setupCompletedAt: council.setupCompletedAt || null,
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} POST /setup/council-strategy: ${err.message}`,
            );
            return res.status(500).json(errorBody(err.message));
        }
    });

    // beta.3.99 (Wave M3.5) — Class B install endpoint. Creates the
    // cfg.chains.<chainId> entry for an EVM sidechain (ESC/EID/PG)
    // with the canonical port tuple, the operator-supplied (or shared)
    // miner address, and the encrypted EVM keystore password.
    //
    // PRE-REQUISITES (returns 412 on any miss):
    //   - cfg.global.council.passwordStrategy must be set (M3.4 wizard)
    //   - cfg.global.council.minerAddressStrategy must be set
    //   - When strategy='shared': the sharedPasswordEncrypted /
    //     sharedMinerAddress must be populated on cfg.global.council
    //
    // BINARY: M3.5 does NOT download the binary — that's M3.8. The
    // entry lands with binaryPath='' and enabled=false; the operator
    // runs the M3.8 download endpoint next to fetch + verify the
    // binary, then can flip enabled=true.
    //
    // Body shape:
    //   {
    //     chainId: 'esc' | 'eid' | 'pg',
    //     activeNet?: 'mainnet' | 'testnet',  // default 'mainnet'
    //     miner: {
    //       enabled?: boolean,                // default false
    //       rewardAddress?: string,           // required when strategy='per-chain'
    //       evmKeystoreAddr?: string,
    //       threads?: number,                 // default 1
    //     },
    //     evmKeystorePassword?: string,       // required when password strategy='per-chain'
    //     sync?: { mode?: 'fast'|'full'|'archive' },
    //   }
    router.post('/install-class-b', limit('admin'), requireOwner, async (req, res) => {
        try {
            const body = req.body || {};
            const ClassBPorts = require('../services/ClassBPorts');
            const EnmCrypto = require('../services/EnmCrypto');
            const chainId = String(body.chainId || '');
            if (!ClassBPorts.knownChainIds().includes(chainId)) {
                return res.status(400).json(errorBody(
                    `install-class-b: chainId must be one of ${ClassBPorts.knownChainIds().join('|')}, `
                    + `got "${chainId}".`,
                ));
            }
            const activeNet = body.activeNet === 'testnet' ? 'testnet' : 'mainnet';

            const cfg = await ConfigStore.load();
            const council = (cfg.global && cfg.global.council) || {};
            // Pre-requisite check 1 — Layer 1 strategy answered.
            if (!council.passwordStrategy || !council.minerAddressStrategy) {
                return res.status(412).json(errorBody(
                    'install-class-b: Council strategy not set. POST '
                    + '/api/enm/setup/council-strategy with passwordStrategy + '
                    + 'minerAddressStrategy before installing the first Class B chain.',
                ));
            }
            // Pre-requisite check 2 — already-installed-chain idempotency.
            if (cfg.chains && cfg.chains[chainId]) {
                return res.status(409).json(errorBody(
                    `install-class-b: chain "${chainId}" is already configured. `
                    + 'Use the Settings tab on its pane to edit; uninstall first if you need to reset.',
                ));
            }
            // Resolve miner.rewardAddress per strategy.
            let rewardAddress = '';
            let rewardAddressSource = council.minerAddressStrategy;
            if (council.minerAddressStrategy === 'shared') {
                rewardAddress = council.sharedMinerAddress || '';
                if (!rewardAddress) {
                    return res.status(412).json(errorBody(
                        'install-class-b: minerAddressStrategy="shared" but sharedMinerAddress not set. '
                        + 'Re-run council-strategy with sharedMinerAddress populated.',
                    ));
                }
            } else if ((body.miner && body.miner.rewardAddress) || body.miner === undefined) {
                rewardAddress = String((body.miner && body.miner.rewardAddress) || '');
                if (rewardAddress) {
                    const v = EnmCrypto.validateEthAddress(rewardAddress);
                    if (!v.valid) {
                        return res.status(400).json(errorBody(
                            `miner.rewardAddress: ${v.warning}`,
                        ));
                    }
                    rewardAddress = v.normalized || rewardAddress;
                }
            }
            // Resolve EVM keystore password envelope per strategy.
            let evmKeystorePasswordEncrypted = '';
            if (council.passwordStrategy === 'shared') {
                evmKeystorePasswordEncrypted = council.sharedPasswordEncrypted || '';
                if (!evmKeystorePasswordEncrypted) {
                    return res.status(412).json(errorBody(
                        'install-class-b: passwordStrategy="shared" but sharedPasswordEncrypted not set. '
                        + 'Re-run council-strategy with sharedPassword supplied.',
                    ));
                }
            } else if (typeof body.evmKeystorePassword === 'string' && body.evmKeystorePassword.length > 0) {
                if (!EnmCrypto.validatePasswordComplexity(body.evmKeystorePassword)) {
                    return res.status(400).json(errorBody(
                        'install-class-b: evmKeystorePassword fails complexity '
                        + '(16+ chars, upper + lower + digit + non-alnum required).',
                    ));
                }
                evmKeystorePasswordEncrypted = EnmCrypto.encrypt(body.evmKeystorePassword);
            }
            // EVM keystore address (optional pass-through).
            let evmKeystoreAddr = '';
            if (body.miner && body.miner.evmKeystoreAddr) {
                const v = EnmCrypto.validateEthAddress(String(body.miner.evmKeystoreAddr));
                if (!v.valid) {
                    return res.status(400).json(errorBody(
                        `miner.evmKeystoreAddr: ${v.warning}`,
                    ));
                }
                evmKeystoreAddr = v.normalized || body.miner.evmKeystoreAddr;
            }
            // Threads + sync.mode validations.
            let threads = 1;
            if (body.miner && Number.isInteger(body.miner.threads)) {
                if (body.miner.threads < 1 || body.miner.threads > 16) {
                    return res.status(400).json(errorBody('miner.threads must be integer in [1, 16]'));
                }
                threads = body.miner.threads;
            }
            let syncMode = 'fast';
            if (body.sync && body.sync.mode) {
                if (!['fast', 'full', 'archive'].includes(body.sync.mode)) {
                    return res.status(400).json(errorBody(
                        'sync.mode must be one of fast | full | archive',
                    ));
                }
                syncMode = body.sync.mode;
            }
            const minerEnabled = body.miner && body.miner.enabled === true;
            // Assemble the chain cfg block.
            const ports = ClassBPorts.portsFor(chainId, activeNet);
            const chainCfg = {
                enabled: false,           // operator flips after M3.8 binary download
                binaryPath: '',           // filled by M3.8 install endpoint
                binaryVersion: '',
                activeNet,
                ports,
                pbft: {
                    usesMainchainKeystore: true,  // H23 invariant
                    ipAddress: null,              // EnmIpResolver fills at start
                },
                miner: {
                    enabled: !!minerEnabled,
                    rewardAddress,
                    rewardAddressSource,
                    evmKeystoreAddr,
                    evmKeystorePasswordEncrypted,
                    threads,
                },
                sync: { mode: syncMode },
                bootnodes: [],
                healing: { enabledRules: {} },
            };
            cfg.chains = cfg.chains || {};
            cfg.chains[chainId] = chainCfg;
            await ConfigStore.save(cfg);

            // Register the adapter immediately so listChains / overview pick
            // it up without waiting for a reboot.
            try {
                const ChainRegistry = require('../services/ChainRegistry');
                ChainRegistry.registerConfiguredAdapters({ cfg });
            } catch (err) {
                extensionHandle.log.warn(
                    `${ENM_LOG_PREFIX} install-class-b ${chainId}: post-install register failed: ${err.message}`,
                );
            }

            extensionHandle.log.info(
                `${ENM_LOG_PREFIX} install-class-b ${chainId} installed `
                + `(net=${activeNet}, miner=${minerEnabled ? 'on' : 'off'}, sync=${syncMode})`,
            );
            return res.json(successBody({
                chainId,
                chainCfg,
                next: 'POST /api/enm/setup/binary/' + chainId + ' to download the binary (M3.8)',
            }));
        } catch (err) {
            extensionHandle.log.error(
                `${ENM_LOG_PREFIX} POST /setup/install-class-b: ${err.message}`,
            );
            return res.status(500).json(errorBody(err.message));
        }
    });

    return router;
}

// walletScopeId + validateKeystorePath are imported from EnmSetupHelpers so
// they can be unit-tested without pulling Express into the test environment.

// Maximum tolerated host-vs-server clock skew before DPoS signing windows
// start rejecting (the chain itself enforces ~4.2s; we warn well below that
// so the operator has time to fix NTP before they get penalized).
const CLOCK_SKEW_MAX_MS = 2000;

// Hard outer timeout for the entire clock-skew probe. ClockSkewChecker has
// its own per-endpoint timeout (5s default × 3 endpoints), but if the host
// is in a captive portal that hangs all 3 we still want preflight to return
// promptly. Fail-soft on expiry — the wizard surfaces the skip reason and
// the operator can proceed.
const CLOCK_SKEW_OUTER_TIMEOUT_MS = 5000;

/**
 * Runs the clock-skew probe with a hard outer timeout AND fail-soft semantics.
 * The wizard MUST never get stuck on this step — if the probe can't complete
 * for any reason (no internet, captive portal, DNS failure, etc.), we return
 * a skipped result and let the operator continue with a yellow warning.
 *
 * @param {object} extensionHandle
 * @returns {Promise<object>} preflight-shaped result for the wizard
 */
async function runClockSkewCheck(extensionHandle) {
    try {
        const probe = ClockSkewChecker.check({ timeoutMs: CLOCK_SKEW_OUTER_TIMEOUT_MS });
        let timer;
        const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve({
                ok: false,
                reason: `clock-skew probe exceeded ${CLOCK_SKEW_OUTER_TIMEOUT_MS}ms`,
            }), CLOCK_SKEW_OUTER_TIMEOUT_MS);
            if (timer && typeof timer.unref === 'function') { timer.unref(); }
        });
        const probeResult = await Promise.race([probe, timeoutPromise]);
        clearTimeout(timer);

        if (!probeResult || probeResult.ok !== true) {
            // Probe couldn't reach any endpoint — fail-soft so the wizard
            // can proceed. The UI renders a YELLOW warning telling the
            // operator to check NTP if they suspect host clock drift.
            return {
                ok: true,
                skipped: true,
                reason: (probeResult && probeResult.reason) || 'network unreachable',
                maxSkewMs: CLOCK_SKEW_MAX_MS,
            };
        }

        const skewMs = Number.isFinite(probeResult.skewMs) ? probeResult.skewMs : 0;
        const absSkewMs = Math.abs(skewMs);
        return {
            ok: absSkewMs <= CLOCK_SKEW_MAX_MS,
            skipped: false,
            skewMs,
            absSkewMs,
            maxSkewMs: CLOCK_SKEW_MAX_MS,
            source: probeResult.endpoint || null,
            rtt: probeResult.rtt || null,
        };
    } catch (err) {
        // Defence in depth — any unexpected throw from the probe is treated
        // as a skip, NEVER as a wizard blocker.
        extensionHandle.log.warn(
            `${ENM_LOG_PREFIX} clock-skew probe threw: ${err && err.message ? err.message : err}`,
        );
        return {
            ok: true,
            skipped: true,
            reason: 'probe error',
            maxSkewMs: CLOCK_SKEW_MAX_MS,
        };
    }
}

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
