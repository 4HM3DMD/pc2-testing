/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmAutoStart — wire `global.autoStart.onBoot` into the server.js boot path.
 *
 * Why this exists:
 *   EnmConfigSchema.js defines `global.autoStart = { onBoot: bool, delaySec: int }`
 *   with the schema-level docstring promising "start any chain whose enabled=true
 *   on boot; reattach handles the warm-restart case, this handles cold boots."
 *   server.js's boot docstring (line 16) also promises "(sweepers + auto-start)".
 *   But no code ever read the field — so every ENM restart (deploy, crash, host
 *   reboot) left enabled chains stopped until F1's slow self-heal tick eventually
 *   cleared whatever blocker (stale LOCK, etc.) and restarted them. That window
 *   was minutes to hours depending on F1 cadence. After a deploy on srv832310
 *   the chain stayed `state=stopped` indefinitely until manual restart.
 *
 * What this does:
 *   - Reads cfg via ConfigStore.load()
 *   - Gates: setup must be complete, autoStart.onBoot must not be opted out
 *   - After `delaySec` (default 10) seconds: for each chain where `enabled=true`,
 *     check if it's already alive (reattach picked it up — skip) or start it.
 *   - Writes an AUTOMATED-SAFE audit row per chain so the Activity tab shows
 *     "Auto-started <chain> on ENM boot" in friendly mode.
 *   - Failure does NOT loop here — F1's self-healing engine handles retries.
 *     Auto-start is fire-and-forget; the audit row is the only side channel.
 *
 * Design constraints:
 *   - setTimeout-based delay so server.listen() is not blocked on startup
 *   - Sequential per-chain (no Promise.all) so a future multi-chain setup doesn't
 *     race on shared resources (port-bind, leveldb open, binary smoke-tests)
 *   - statusSync guard makes the whole module idempotent — calling runAutoStart
 *     twice in quick succession won't double-start a chain
 */

'use strict';

const { ENM_LOG_PREFIX } = require('./EnmConstants');
const ConfigStore = require('./ConfigStore');
const AuditLog = require('./EnmAuditLog');

const RULE_ID = 'AUTOSTART';
const TIER = 'AUTOMATED-SAFE';
const EXECUTOR = 'system';
// beta.3.52 — switched from 0x000…000 to the literal 'system' label.
// ENM audit rows never carry EVM-shaped wallet addresses anymore;
// the column holds an actor *role*, not a PC2 identity.
const SYSTEM_WALLET = 'system';

/**
 * Orchestrate auto-start of enabled chains on ENM boot.
 *
 * Called once from server.js right after the reattach() block. Returns a quick
 * decision object describing what was scheduled; the actual start work runs
 * asynchronously via setTimeout so the boot path can proceed to app.listen().
 *
 * @param {object} deps
 * @param {object} deps.extensionHandle  PC2 extension handle (for log + db)
 * @param {object} deps.registry         ChainRegistry singleton
 * @returns {Promise<{ scheduled: boolean, reason?: string, delayMs?: number, chainCount?: number }>}
 */
async function runAutoStart(deps) {
    if (!deps || !deps.extensionHandle || !deps.registry) {
        throw new TypeError('EnmAutoStart.runAutoStart: { extensionHandle, registry } required');
    }
    const { extensionHandle, registry } = deps;
    const log = extensionHandle.log || console;

    let cfg;
    try {
        cfg = await ConfigStore.load();
    } catch (err) {
        log.warn(`${ENM_LOG_PREFIX} autoStart: ConfigStore.load failed — skipping (${err.message})`);
        return { scheduled: false, reason: 'config-load-failed' };
    }

    // Gate 1 — setup wizard must be complete. We never start chains before the
    // operator has confirmed the binary path / keystore / config in the wizard.
    if (!cfg || !cfg.setup || cfg.setup.completed !== true) {
        log.info(`${ENM_LOG_PREFIX} autoStart: setup not complete — skipping`);
        return { scheduled: false, reason: 'setup-incomplete' };
    }

    // Gate 2 — operator opt-out. Defaults from the schema are `{ onBoot: true,
    // delaySec: 10 }` so this is opt-out, not opt-in.
    const opts = (cfg.global && cfg.global.autoStart) || { onBoot: true, delaySec: 10 };
    if (opts.onBoot === false) {
        log.info(`${ENM_LOG_PREFIX} autoStart: disabled in config — skipping`);
        return { scheduled: false, reason: 'disabled-in-config' };
    }

    const delaySec = Number.isInteger(opts.delaySec) && opts.delaySec >= 0 ? opts.delaySec : 10;
    const delayMs = delaySec * 1000;

    const enabledChainIds = Object.entries(cfg.chains || {})
        .filter(([_, c]) => c && c.enabled === true)
        .map(([id]) => id);

    if (enabledChainIds.length === 0) {
        log.info(`${ENM_LOG_PREFIX} autoStart: no chains have enabled=true — nothing to do`);
        return { scheduled: false, reason: 'no-enabled-chains' };
    }

    // beta.3.88 — Wave M1.4 — dependency-DAG ordering. Pre-3.88 we
    // started chains in arbitrary Object.entries() order. For Council
    // nodes this races: an oracle starting before its parent EVM chain
    // is alive crashes on first RPC ping; Arbiter starting before all
    // chains are reachable fails its SPV catchup. The plan's boot
    // order (per node.sh + audited dependency graph):
    //
    //   mainchain → ESC | EID | PG (parallel) → their Oracles
    //   (after parent accepts RPC) → Arbiter (last, needs all 4)
    //
    // Sort the enabled list by class precedence:
    //   A (mainchain) → B (esc/eid/pg) → C (oracles) → D (arbiter) → E (spv)
    //
    // ChainAdapter.classOf returns null for unknown chainIds — those
    // sort last (treated as lowest priority). startAllChains is still
    // SEQUENTIAL within the sorted order to avoid port-bind races.
    const ChainAdapter = require('./ChainAdapter');
    const CLASS_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
    const orderedChainIds = enabledChainIds.slice().sort((a, b) => {
        const ca = ChainAdapter.classOf(a);
        const cb = ChainAdapter.classOf(b);
        const pa = ca && CLASS_ORDER[ca] !== undefined ? CLASS_ORDER[ca] : 99;
        const pb = cb && CLASS_ORDER[cb] !== undefined ? CLASS_ORDER[cb] : 99;
        if (pa !== pb) return pa - pb;
        // Stable within class: alphabetical
        return a.localeCompare(b);
    });

    log.info(
        `${ENM_LOG_PREFIX} autoStart: scheduling ${orderedChainIds.length} chain(s) `
        + `[${orderedChainIds.join(' → ')}] (dependency-DAG order) to start in ${delaySec}s`,
    );

    setTimeout(() => {
        // Re-read config inside the timer so operator changes during the grace
        // window (e.g. they disabled a chain right after boot) take effect.
        startAllChains({ extensionHandle, registry, chainIds: orderedChainIds })
            .catch((err) => {
                log.error(`${ENM_LOG_PREFIX} autoStart loop crashed: ${err.message}`);
            });
    }, delayMs);

    return { scheduled: true, delayMs, chainCount: orderedChainIds.length, order: orderedChainIds };
}

/**
 * Iterate the chain ids and start each one in sequence. Sequential (not
 * parallel) so a future multi-chain setup doesn't race on port-bind, leveldb
 * open, or binary smoke-tests. Per-chain failure is logged + audited but does
 * not abort the loop — the next chain still gets a chance.
 *
 * @param {object} args
 * @param {object} args.extensionHandle
 * @param {object} args.registry
 * @param {string[]} args.chainIds
 */
async function startAllChains(args) {
    const { extensionHandle, registry, chainIds } = args;
    const log = extensionHandle.log || console;

    let cfg;
    try {
        cfg = await ConfigStore.load();
    } catch (err) {
        log.error(`${ENM_LOG_PREFIX} autoStart: ConfigStore.load (timer) failed — aborting: ${err.message}`);
        return;
    }

    let db = null;
    try {
        db = extensionHandle.import('data').db;
    } catch (err) {
        log.debug(`${ENM_LOG_PREFIX} autoStart: db handle unavailable — audit rows will be skipped (${err.message})`);
    }

    const proc = registry.getProcessService();

    for (const chainId of chainIds) {
        const chainCfg = cfg.chains && cfg.chains[chainId];

        // Re-check enabled: operator may have flipped it during the grace window.
        if (!chainCfg || chainCfg.enabled !== true) {
            log.info(`${ENM_LOG_PREFIX} autoStart: ${chainId} no longer enabled — skipping`);
            continue;
        }

        // Skip if already alive — reattach() during boot has already bound us
        // to the existing ela process; double-starting would race the lock.
        try {
            const st = proc.statusSync(chainId);
            if (st && st.alive) {
                log.info(`${ENM_LOG_PREFIX} autoStart: ${chainId} already alive (pid=${st.pid}) — skipping`);
                continue;
            }
        } catch (err) {
            log.warn(`${ENM_LOG_PREFIX} autoStart: ${chainId} statusSync failed (${err.message}) — attempting start anyway`);
        }

        // Try to start.
        const startedAtMs = Date.now();
        try {
            const adapter = registry.getAdapter(chainId);
            await adapter.start(chainCfg);
            const durationMs = Date.now() - startedAtMs;
            log.info(`${ENM_LOG_PREFIX} autoStart: ${chainId} started OK in ${durationMs}ms`);
            await safeAudit(db, log, {
                chainId,
                outcome: `Auto-started ${chainId} on ENM boot`,
                decision: 'executed',
                durationMs,
            });
        } catch (err) {
            const durationMs = Date.now() - startedAtMs;
            // Don't loop here — F1 self-heal will pick this up on its next tick.
            // We just record the failure so the Activity tab shows what happened.
            log.warn(`${ENM_LOG_PREFIX} autoStart: ${chainId} start failed (${err.message}) — F1 will retry`);
            await safeAudit(db, log, {
                chainId,
                outcome: `Auto-start failed: ${err.message}`,
                decision: 'failed',
                durationMs,
            });
        }
    }
}

/**
 * Append an AUTOMATED-SAFE audit row. Never throws — audit failure must not
 * crash boot. Skips silently if the db handle was unavailable upstream.
 */
async function safeAudit(db, log, args) {
    if (!db) { return; }
    try {
        await AuditLog.append(db, {
            walletAddress: SYSTEM_WALLET,
            chainId: args.chainId,
            tier: TIER,
            ruleId: RULE_ID,
            decision: args.decision,
            executor: EXECUTOR,
            outcome: args.outcome,
            durationMs: args.durationMs,
            payload: { action: 'autostart' },
        });
    } catch (err) {
        log.debug(`${ENM_LOG_PREFIX} autoStart: audit append failed (non-fatal): ${err.message}`);
    }
}

module.exports = {
    runAutoStart,
    // exported for tests
    _internal: { startAllChains, RULE_ID, TIER },
};
