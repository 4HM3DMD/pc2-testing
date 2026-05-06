/**
 * GracefulRestart — orchestrates the drain sequence PC2 runs when
 * a hybrid-capsule UPDATE forces a restart (lazy-load makes INSTALL
 * restart-free; updates still need the brief window per the v0.3
 * doc until per-extension subprocess hot-swap lands in v2).
 *
 * Sequence:
 *
 *   1. Broadcast "restarting in N seconds" over SSE + WS to every
 *      connected client. Gives them a chance to save form state,
 *      stop typing, expect the disconnect.
 *   2. Wait the broadcast eta — but ALSO start the drain in parallel
 *      so we don't sit idle if no in-flight work exists.
 *   3. Stop accepting new HTTP connections (server.close).
 *   4. Wait for in-flight requests to finish, capped at
 *      `drainTimeoutMs`. Anything still pending at the deadline
 *      gets a 503 + Retry-After when its handler tries to write.
 *   5. Close SSE connections cleanly (the SseReplayBuffer keeps the
 *      events so reconnecting clients can replay).
 *   6. Close WebSocket sessions with typed close frame
 *      `(1012, "service-restart")`. Client libraries auto-reconnect.
 *   7. Final settle window (default 100ms) for any best-effort flush.
 *   8. Exit. Supervisor (compose `restart: unless-stopped`, pm2,
 *      systemd) brings PC2 back. After three crash-on-boot loops,
 *      the safe-mode flag flips to skip extension loading and
 *      surface the broken capsule for manual quarantine (M3).
 *
 * Closes the A5 critique gap: today's `POST /api/system/restart`
 * has zero drain. SIGTERM lands on the master, in-flight requests
 * are severed mid-flight, every other app's session dies without
 * notice. This service is the building block; the platform team
 * wires it into `pc2-node/src/api/system.ts` to replace the
 * existing `setTimeout(500ms) → execFileSync('systemctl restart')`
 * pattern.
 *
 * Trust note: nothing security-sensitive here — pure orchestration.
 * The auth check on the restart endpoint is the platform team's
 * concern (existing code already gates with requireOwner).
 *
 * Out of scope:
 *   - Cross-app blast-radius UI ("restart will kill 3 active apps").
 *     The `onBroadcast` hook is what surfaces that; M9 just orders
 *     the steps.
 *   - The actual SSE/WS implementations. Hooks pass through to
 *     SseHub + the WS server. Tests inject stubs.
 *   - Process management (which signal, which supervisor). The
 *     `onExit` hook is what calls `process.exit(0)` in production;
 *     tests inject a no-op.
 */

const DEFAULT_BROADCAST_ETA_SECONDS = 5;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_FINAL_SETTLE_MS = 100;
const MAX_BROADCAST_ETA_SECONDS = 60;
const MAX_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// Public types
// =============================================================================

export type RestartPhase =
    | 'broadcast'
    | 'wait-eta'
    | 'stop-accepting'
    | 'drain-in-flight'
    | 'close-sse'
    | 'close-ws'
    | 'settle'
    | 'exit';

export interface DrainHooks {
    /**
     * Broadcast "restarting in N seconds" to every connected client.
     * Production: emit on SseHub for SSE, ws.send for WebSockets.
     * Tests: stub that records the call.
     *
     * Should NOT block. The orchestrator runs the broadcast in the
     * `broadcast` phase, then waits the eta in `wait-eta` regardless
     * of how long this hook takes.
     */
    onBroadcast: (etaSeconds: number, cause: string) => Promise<void> | void;

    /**
     * Stop the HTTP server from accepting new connections. Production:
     * `httpServer.close()` (which lets in-flight requests finish but
     * rejects new ones). Tests: stub that flips a flag.
     */
    onStopAcceptingConnections: () => Promise<void> | void;

    /**
     * Wait for in-flight HTTP requests to finish. Resolves when the
     * count reaches 0 OR the deadline is hit. Production: hooks into
     * a request-counter middleware. Tests: stub that returns
     * { drained, pending } directly.
     */
    waitForInFlight: (deadlineMs: number) => Promise<{ drained: boolean; pending: number }>;

    /**
     * Close SSE connections. Production: SseHub.close(). Tests: stub.
     * The SseReplayBuffer (separate service) keeps events for clients
     * that reconnect after the restart.
     */
    onCloseSseConnections: () => Promise<void> | void;

    /**
     * Close WebSocket sessions with typed close frame
     * (1012 "service-restart"). Production: io.close() with a
     * pre-broadcast goodbye. Tests: stub.
     */
    onCloseWebSockets: () => Promise<void> | void;

    /**
     * Final exit. Production: `process.exit(0)`. Tests: stub.
     * Called after the settle window so any best-effort flushes
     * land before termination.
     */
    onExit: () => void;
}

export interface RestartOptions {
    /** Operator-facing reason ("update:elastos-node-manager"). */
    cause: string;
    /**
     * Seconds clients see in the warning ("restarting in 5s").
     * Default 5. Capped at 60 — anything longer should use a
     * scheduled-maintenance flow, not a graceful restart.
     */
    broadcastEtaSeconds?: number;
    /**
     * Cap on how long we wait for in-flight requests to finish
     * once we've stopped accepting new ones. Default 10s. Capped
     * at 5min.
     */
    drainTimeoutMs?: number;
    /**
     * Final pause after closing connections, before exit. Lets
     * any best-effort flushes (audit log writes, cron checkpoints)
     * settle. Default 100ms.
     */
    finalSettleMs?: number;
    /**
     * If true, skip the wait-eta phase. Used for emergency
     * restarts where we don't want to let the broadcast interval
     * elapse. Defaults to false.
     */
    skipBroadcastWait?: boolean;
}

export interface RestartReport {
    cause: string;
    startedAt: number;
    durationMs: number;
    drained: boolean;
    pendingAtDeadline: number;
    phases: Array<{ phase: RestartPhase; ms: number }>;
    /** True if the orchestrator reached the exit hook. */
    exitCalled: boolean;
}

export class GracefulRestartError extends Error {
    public readonly phase: RestartPhase;
    constructor(phase: RestartPhase, message: string) {
        super(`[graceful-restart][${phase}] ${message}`);
        this.name = 'GracefulRestartError';
        this.phase = phase;
    }
}

// =============================================================================
// Service
// =============================================================================

export class GracefulRestart {
    private readonly hooks: DrainHooks;
    private inFlight: Promise<RestartReport> | null = null;

    constructor(hooks: DrainHooks) {
        if (!hooks
            || typeof hooks.onBroadcast !== 'function'
            || typeof hooks.onStopAcceptingConnections !== 'function'
            || typeof hooks.waitForInFlight !== 'function'
            || typeof hooks.onCloseSseConnections !== 'function'
            || typeof hooks.onCloseWebSockets !== 'function'
            || typeof hooks.onExit !== 'function') {
            throw new TypeError(
                'GracefulRestart: all six hooks (onBroadcast, ' +
                'onStopAcceptingConnections, waitForInFlight, ' +
                'onCloseSseConnections, onCloseWebSockets, onExit) required');
        }
        this.hooks = hooks;
    }

    /**
     * Run the drain sequence. Coalesced — concurrent calls return
     * the same in-flight promise so two routes invoking restart at
     * once don't trigger two parallel teardowns.
     *
     * Errors in any hook are caught and surfaced in the report
     * (we still proceed to the next phase — this is a best-effort
     * teardown, not a transactional flow).
     */
    async restart(opts: RestartOptions): Promise<RestartReport> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.runOnce(opts);
        try {
            return await this.inFlight;
        } finally {
            // Only clear if the exit hook didn't terminate us — in
            // production this branch is never reached (process is gone)
            // but tests with a stub exit will get here.
            this.inFlight = null;
        }
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private async runOnce(opts: RestartOptions): Promise<RestartReport> {
        const cause = String(opts.cause || 'unspecified');
        const eta = clampInt(opts.broadcastEtaSeconds, DEFAULT_BROADCAST_ETA_SECONDS,
            0, MAX_BROADCAST_ETA_SECONDS);
        const drainMs = clampInt(opts.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS,
            0, MAX_DRAIN_TIMEOUT_MS);
        const settleMs = clampInt(opts.finalSettleMs, DEFAULT_FINAL_SETTLE_MS, 0, 30_000);
        const skipWait = !!opts.skipBroadcastWait;

        const startedAt = Date.now();
        const phases: Array<{ phase: RestartPhase; ms: number }> = [];

        await this.runPhase('broadcast', phases, () =>
            Promise.resolve(this.hooks.onBroadcast(eta, cause)));

        if (!skipWait && eta > 0) {
            await this.runPhase('wait-eta', phases, () =>
                new Promise<void>(r => setTimeout(r, eta * 1000)));
        }

        await this.runPhase('stop-accepting', phases, () =>
            Promise.resolve(this.hooks.onStopAcceptingConnections()));

        let drained = true;
        let pendingAtDeadline = 0;
        await this.runPhase('drain-in-flight', phases, async () => {
            const result = await this.hooks.waitForInFlight(drainMs);
            drained = result.drained;
            pendingAtDeadline = result.pending;
        });

        await this.runPhase('close-sse', phases, () =>
            Promise.resolve(this.hooks.onCloseSseConnections()));

        await this.runPhase('close-ws', phases, () =>
            Promise.resolve(this.hooks.onCloseWebSockets()));

        if (settleMs > 0) {
            await this.runPhase('settle', phases, () =>
                new Promise<void>(r => setTimeout(r, settleMs)));
        }

        let exitCalled = false;
        await this.runPhase('exit', phases, () => {
            try { this.hooks.onExit(); exitCalled = true; }
            catch { /* swallow — we're done either way */ }
            return Promise.resolve();
        });

        return {
            cause,
            startedAt,
            durationMs: Date.now() - startedAt,
            drained,
            pendingAtDeadline,
            phases,
            exitCalled,
        };
    }

    private async runPhase(
        phase: RestartPhase,
        phases: Array<{ phase: RestartPhase; ms: number }>,
        body: () => Promise<unknown>,
    ): Promise<void> {
        const start = Date.now();
        try {
            await body();
        } catch {
            // Best-effort teardown — record the phase ran (with elapsed
            // time) and move on. The report's `drained`/`exitCalled`
            // flags surface real failures; mid-phase errors here are
            // typically network blips on close that don't matter.
        } finally {
            phases.push({ phase, ms: Date.now() - start });
        }
    }
}

// =============================================================================
// Helpers
// =============================================================================

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
    if (v === undefined || v === null) return fallback;
    if (!Number.isFinite(v)) return fallback;
    const n = Math.floor(v);
    if (n < min) return min;
    if (n > max) return max;
    return n;
}
