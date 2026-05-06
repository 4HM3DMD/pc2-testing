/**
 * ExtensionProbe — pre-load validation for hybrid-capsule backends.
 *
 * Forks a child process that requires the extension's main module with a
 * stub `extension` global. If the require throws — sync or async during
 * a brief drain window — the probe reports failure with an exit code +
 * stderr snippet. If require completes cleanly, probe passes.
 *
 * Why this matters: PC2's main process loads extensions via require() in
 * the same V8 isolate. A sync throw during that require kills PC2. The
 * probe catches the throw safely in a child process FIRST, so a bad
 * capsule can't brick boot. Combined with the LazyExtensionLoader's
 * crash-loop quarantine, this implements the A4-finding mitigation
 * ("bad capsule bricks PC2 boot loop → pre-load probe + safe-mode flag").
 *
 * Limits intentionally:
 *   - Validates module-load only. A handler that throws on its first
 *     real request still surfaces at runtime — that's the loader's
 *     crash-counter job, not the probe's.
 *   - Stub `extension` is a no-op that returns null/empty for imports.
 *     An extension that asserts on a real DB at module-load top-level
 *     will probe-fail; that's OK, surface the assertion as a publish-
 *     time bug.
 *   - Doesn't replicate PC2's full Extension class. The probe catches
 *     "code is broken at the source level"; subtle integration bugs
 *     (capability denied, route conflict) are downstream concerns.
 */

import { fork, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// probe-runner.cjs lives one dir up (src/probe-runner.cjs) — it's not
// service-specific, more of an extension-runtime sibling that
// ExtensionProbe forks.
const RUNNER_PATH = join(__dirname, '..', 'probe-runner.cjs');

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_TRIM_BYTES = 4096;

// =============================================================================
// Public types
// =============================================================================

export interface ProbeOptions {
    /** Hard kill the probe child after this many ms (default 30000). */
    timeoutMs?: number;
    /**
     * Override the runner script path. Tests use this to swap in a
     * stub runner; production callers should leave it undefined.
     */
    runnerPath?: string;
}

export interface ProbeResult {
    ok: boolean;
    /** Wall-clock ms from fork to exit (or kill on timeout). */
    durationMs: number;
    /** Human-readable failure summary; only populated when `ok: false`. */
    reason?: string;
    /** Child exit code, when applicable. `null` if killed by signal. */
    exitCode?: number | null;
    /** Signal name if killed (e.g. 'SIGKILL'). */
    signal?: string | null;
    /** Truncated stderr from the child (last STDERR_TRIM_BYTES bytes). */
    stderr?: string;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Probe a hybrid-capsule backend directory in an isolated child process.
 * Resolves to a `ProbeResult` — never throws. Errors during fork are
 * captured and reported as `{ ok: false, reason }`.
 */
export function probeExtension(
    extensionDir: string,
    opts: ProbeOptions = {},
): Promise<ProbeResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const runnerPath = opts.runnerPath ?? RUNNER_PATH;
    const start = Date.now();

    return new Promise<ProbeResult>((resolve) => {
        let child: ChildProcess;
        try {
            child = fork(runnerPath, [extensionDir], {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                env: {
                    PATH: process.env.PATH ?? '',
                    HOME: process.env.HOME ?? '',
                    LANG: process.env.LANG ?? 'C.UTF-8',
                    NODE_OPTIONS: '--no-warnings',
                },
            });
        } catch (err) {
            const e = err as Error;
            resolve({
                ok: false,
                reason: `fork failed: ${e.message}`,
                durationMs: Date.now() - start,
            });
            return;
        }

        let stderrBuf = '';
        let resolved = false;

        const finish = (result: ProbeResult) => {
            if (resolved) return;
            resolved = true;
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
            resolve(result);
        };

        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBuf += chunk.toString('utf-8');
            // Cap stderr buffering — a runaway error stream shouldn't
            // hold unbounded memory in the parent.
            if (stderrBuf.length > STDERR_TRIM_BYTES * 4) {
                stderrBuf = stderrBuf.slice(-STDERR_TRIM_BYTES * 2);
            }
        });
        child.stdout?.on('data', () => { /* drained but unused */ });

        const timer = setTimeout(() => {
            finish({
                ok: false,
                reason: `probe timed out after ${timeoutMs}ms`,
                signal: 'SIGKILL',
                stderr: trimStderr(stderrBuf),
                durationMs: Date.now() - start,
            });
        }, timeoutMs);
        // Don't keep the parent alive just for the probe timer.
        if (typeof timer.unref === 'function') timer.unref();

        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            const durationMs = Date.now() - start;
            if (code === 0) {
                finish({ ok: true, durationMs, exitCode: 0 });
                return;
            }
            finish({
                ok: false,
                reason: explainExit(code, signal),
                exitCode: code,
                signal,
                stderr: trimStderr(stderrBuf),
                durationMs,
            });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            finish({
                ok: false,
                reason: `child process error: ${err.message}`,
                stderr: trimStderr(stderrBuf),
                durationMs: Date.now() - start,
            });
        });
    });
}

// =============================================================================
// Helpers
// =============================================================================

function trimStderr(buf: string): string {
    if (buf.length <= STDERR_TRIM_BYTES) return buf.trim();
    return '…' + buf.slice(-STDERR_TRIM_BYTES).trim();
}

function explainExit(code: number | null, signal: string | null): string {
    if (signal) return `killed by signal ${signal}`;
    switch (code) {
        case 2: return 'probe-runner: missing target dir argument';
        case 3: return 'probe-runner: malformed package.json';
        case 4: return 'probe-runner: main file not found';
        case 5: return 'probe-runner: require() threw synchronously';
        case 6: return 'probe-runner: uncaughtException after require()';
        case 7: return 'probe-runner: unhandledRejection after require()';
        case 8: return 'probe-runner: async failure during drain window';
        default: return `probe-runner exited with code ${code}`;
    }
}
