/**
 * Diagnose API
 *
 * GET /api/diagnose — authenticated structured snapshot of node state.
 *
 * Server-side equivalent of `scripts/pc2-diagnose.sh`. Returns the same
 * data as JSON so a future GUI surface can render a "Copy diagnostic"
 * panel without operators having to SSH in. Auth-gated: contains
 * recent log lines and binary paths, which we don't expose anonymously.
 *
 * Every shell-out is hard-capped at 5 s to avoid wedging the request
 * if a tool (e.g. `pm2 logs`) hangs on a starving node. All string
 * output passes through the same sanitiser as the bash script
 * (wallets, DIDs, bearer tokens, BEGIN…END blocks, 24-word mnemonics).
 *
 * v1.2.7.1: shipped to give Sasha a way to debug remote community
 * nodes without asking operators for terminal access. Pull-based,
 * opt-in, no phone-home — operator clicks the future button, gets
 * a JSON blob, pastes the relevant slice in Telegram.
 */

import { Router, Response } from 'express';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { authenticate, AuthenticatedRequest } from './middleware.js';
import { logger } from '../utils/logger.js';
import { getClusterPinConfig, getClusterPinProbeState } from '../services/clusterPin.js';

const router = Router();

const SHELL_TIMEOUT_MS = 5_000;

/**
 * Run a shell command with a hard timeout and return stdout/stderr as
 * a single sanitised string. Never throws — failures become the string
 * `(error: <message>)` so the rest of the report still renders.
 */
function safeRun (cmd: string): string {
    try {
        const out = execSync(cmd, {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SHELL_TIMEOUT_MS,
            shell: '/bin/sh',
            encoding: 'utf8',
            maxBuffer: 1 * 1024 * 1024,
        });
        return sanitise(out.trim());
    } catch (err: any) {
        const msg = (err?.stderr?.toString() || err?.message || 'unknown').trim();
        return `(error: ${sanitise(msg)})`;
    }
}

/**
 * Best-effort secret redaction. Mirrors the sed pipeline in
 * `scripts/pc2-diagnose.sh`. Keep these patterns in sync.
 *
 * NOT a security boundary — the operator must still eyeball the
 * output before pasting it publicly. This catches the common cases
 * (wallets, DIDs, bearer tokens, mnemonics, PEM blocks) so accidental
 * leaks are unlikely.
 */
function sanitise (text: string): string {
    if (!text) return text;
    return text
        .replace(/0x[a-fA-F0-9]{40}/g, '0xREDACTED_WALLET')
        .replace(/did:[a-z]+:[A-Za-z0-9_.-]{8,}/g, 'did:REDACTED')
        .replace(/(Bearer|bearer)\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer REDACTED')
        // ?token=… &api_key=… secret="…" — case-insensitive key match.
        .replace(/\b(token|api_key|apikey|secret|password|signature)=[A-Za-z0-9._~+/=-]+/gi, '$1=REDACTED')
        .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, 'REDACTED-PEM-BLOCK')
        // 24-word lowercase mnemonic on a single line. Loose match (3-8 letter
        // words) is intentional — better to over-redact than miss a leaked
        // recovery phrase.
        .replace(/(?:\b[a-z]{3,8}\b ){23}\b[a-z]{3,8}\b/g, 'REDACTED-MNEMONIC');
}

/**
 * Read pc2-node/.env and return only the KEY names (values stripped).
 * Used to confirm operator-side env config without ever leaking secrets.
 * Returns empty array if .env is missing or unreadable.
 */
function readEnvKeys (dataDir: string): string[] {
    try {
        // pc2-node/.env lives in the pc2-node/ root, not data dir
        const envPath = path.resolve(dataDir, '..', '.env');
        if (!existsSync(envPath)) return [];
        const text = readFileSync(envPath, 'utf8');
        const keys = new Set<string>();
        for (const line of text.split(/\r?\n/)) {
            const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
            if (m) keys.add(m[1]);
        }
        return Array.from(keys).sort();
    } catch {
        return [];
    }
}

/**
 * Probe each transport binary on PATH. Returns absolute path or null.
 * Hard-capped per-binary so a hung filesystem can't stall the response.
 */
function probeBinaries (): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const bin of ['wg', 'wg-quick', 'wireguard-go', 'amneziawg-go', 'awg-quick', 'sing-box']) {
        try {
            const p = execSync(`command -v ${bin} 2>/dev/null`, {
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 1_500,
                shell: '/bin/sh',
                encoding: 'utf8',
            }).trim();
            out[bin] = p || null;
        } catch {
            out[bin] = null;
        }
    }
    return out;
}

/**
 * Tail recent pm2 logs for pc2 and filter to lines that mention
 * the subsystems most relevant to the bugs we're triaging
 * (pin / cluster / ipfs / wireguard / errors). Bounded to the most
 * recent 80 matches to keep the JSON response small.
 */
function tailRelevantLogs (): string[] {
    try {
        const out = execSync(
            'pm2 logs pc2 --lines 200 --nostream 2>&1 | '
                + "grep -iE 'pin|cluster|ipfs|helia|wireguard|amnezia|error|warn' | tail -80",
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: SHELL_TIMEOUT_MS,
                shell: '/bin/sh',
                encoding: 'utf8',
                maxBuffer: 2 * 1024 * 1024,
            },
        );
        return out
            .split(/\r?\n/)
            .filter(Boolean)
            .map(sanitise);
    } catch {
        return [];
    }
}

/**
 * Best-effort disk usage for the pc2-node data dir. Returns null if
 * statfs/df is unavailable (e.g. unusual platform).
 */
function diskUsage (dataDir: string): { path: string; total: number | null; free: number | null } | null {
    try {
        if (!existsSync(dataDir)) return null;
        // Node 18+ has statfs but it's experimental — fall back to df.
        const out = execSync(`df -P -k ${JSON.stringify(dataDir)} | tail -1`, {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
            shell: '/bin/sh',
            encoding: 'utf8',
        }).trim();
        // df -P columns: Filesystem  1024-blocks  Used  Available  Capacity  Mounted-on
        const parts = out.split(/\s+/);
        if (parts.length < 4) return { path: dataDir, total: null, free: null };
        return {
            path: dataDir,
            total: Number(parts[1]) * 1024,
            free: Number(parts[3]) * 1024,
        };
    } catch {
        return null;
    }
}

/**
 * Connectivity probe to the public Elacity supernode cluster pinning
 * endpoint. We don't include any token — a 401 means the cluster is
 * up and gating correctly; a connection failure means this node can't
 * reach the supernodes and explains why pins fail downstream.
 *
 * Uses the same 5 s timeout as the rest of the diagnose pipeline.
 */
async function probeClusterEndpoint (): Promise<{ url: string | null; reachable: boolean; httpStatus: number | null; latencyMs: number | null; error: string | null }> {
    const cfg = getClusterPinConfig();
    const url = cfg ? `${cfg.url.replace(/\/+$/, '')}/pins` : 'https://38.242.211.112/cluster-pin/pins';
    const start = Date.now();
    try {
        // Reuse Node's global fetch (Node 18+). Force keep-alive off so a
        // hung supernode can't pin the connection in the agent pool.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SHELL_TIMEOUT_MS);
        // SECURITY: NO Authorization header here — we only want to know
        // if the endpoint is reachable. Token redacted by sanitise()
        // anyway, but defence in depth.
        const res = await fetch(url, {
            method: 'GET',
            signal: ctrl.signal,
            keepalive: false,
        });
        clearTimeout(timer);
        return {
            url: cfg?.url || null,
            reachable: true,
            httpStatus: res.status,
            latencyMs: Date.now() - start,
            error: null,
        };
    } catch (err: any) {
        return {
            url: cfg?.url || null,
            reachable: false,
            httpStatus: null,
            latencyMs: Date.now() - start,
            error: sanitise(err?.message || 'unknown'),
        };
    }
}

router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const bosonService = req.app.locals.bosonService;
        const db = req.app.locals.db;
        const filesystem = req.app.locals.filesystem;
        const dataDir = process.env.PC2_DATA_DIR || path.join(process.cwd(), 'data');

        // Live transport status via BosonService (catches kernel-mode WireGuard)
        let bosonStatus: any = null;
        if (bosonService && typeof bosonService.getStatus === 'function') {
            try { bosonStatus = bosonService.getStatus(); } catch { /* leave null */ }
        }

        const clusterCfg = getClusterPinConfig();
        const clusterProbe = getClusterPinProbeState();
        const clusterReachability = await probeClusterEndpoint();

        // Memory + load
        const totalMem = os.totalmem();
        const freeMem = os.freemem();

        const snapshot = {
            generatedAt: new Date().toISOString(),
            pc2: {
                version: process.env.npm_package_version || 'unknown',
                uptimeSec: Math.round(process.uptime()),
                pid: process.pid,
                nodeVersion: process.version,
                cwd: process.cwd(),
                dataDir,
            },
            host: {
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                cpuCount: os.cpus().length,
                loadAvg: os.loadavg(),
                totalMemBytes: totalMem,
                freeMemBytes: freeMem,
                memUsagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
            },
            disk: diskUsage(dataDir),
            services: {
                database: db ? 'ok' : 'missing',
                filesystem: filesystem ? 'ok' : 'missing',
                bosonInitialised: bosonStatus?.initialized ?? null,
                wireguard: bosonStatus?.wireguard ?? null,
                amneziaWG: bosonStatus?.amneziaWG ?? null,
                vlessReality: bosonStatus?.vlessReality ?? null,
                connectivity: bosonStatus?.connectivity ?? null,
            },
            transportBinariesOnPath: probeBinaries(),
            cluster: {
                configured: !!clusterCfg,
                url: clusterCfg?.url ?? null,
                replicationMin: clusterCfg?.replicationMin ?? null,
                replicationMax: clusterCfg?.replicationMax ?? null,
                lastProbe: clusterProbe,
                reachability: clusterReachability,
            },
            envKeysPresent: readEnvKeys(dataDir),
            git: {
                head: safeRun('git -C ' + JSON.stringify(path.resolve(dataDir, '..', '..')) + ' rev-parse HEAD'),
                describe: safeRun('git -C ' + JSON.stringify(path.resolve(dataDir, '..', '..')) + ' describe --tags --always'),
                statusShort: safeRun('git -C ' + JSON.stringify(path.resolve(dataDir, '..', '..')) + ' status --short'),
            },
            wgRaw: safeRun('wg show 2>&1 | head -40'),
            ipfsSwarmCount: (() => {
                const raw = safeRun('ipfs swarm peers 2>/dev/null | wc -l');
                const n = Number(raw.trim());
                return Number.isFinite(n) ? n : null;
            })(),
            recentLogs: tailRelevantLogs(),
            warnings: [
                'Sanitisation is best-effort. Eyeball before pasting publicly.',
                'No data is uploaded by this endpoint. The response is yours alone.',
            ],
        };

        // Note dataDir age so we know whether the install is fresh or aged.
        try {
            const st = statSync(dataDir);
            (snapshot.pc2 as any).dataDirCreatedAt = st.birthtime?.toISOString?.() || null;
        } catch { /* ignore */ }

        res.json(snapshot);
    } catch (err: any) {
        logger.error('[Diagnose] Snapshot generation failed:', err);
        res.status(500).json({ error: 'diagnose_failed', message: sanitise(err?.message || 'unknown') });
    }
});

export default router;
