# Elastos Node Manager (ENM)

A PC2 extension that runs and self-heals an Elastos mainchain node for BPoS supernode operators.

## What this is

ENM is an [Elacity PC2](https://github.com/Elacity/pc2.net) extension. It replaces the legacy `node.sh` bash script with a UI-driven lifecycle for Elastos mainchain operators:

- **Start / Stop / Restart** the chain via Node.js child process management
- **Detect & auto-heal** 18 known failure modes (crash, peer loss, sync stall, OOM, etc.)
- **Notify the owner** when human attention is required (config rollback, port conflict, BPoS inactivity)
- **Audit every action** with an append-only log
- **Configure** via a single-page web UI inside PC2

v0.1 targets **BPoS supernode operators on Ubuntu/Debian**. macOS, Windows, and additional chains (ESC, EID, Arbiter, DPoS-Voting) are deferred to v0.2+.

## Operator setup (one-time)

```bash
# Install Node 20.x if you don't have it
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

# Clone, install, start
git clone https://github.com/4HM3DMD/pc2-testing.git ~/pc2 && cd ~/pc2
npm install
cd extensions/elastos-node-manager && npm install && cd ~/pc2
npm start
```

Then open `http://<server-ip>:4200` in a browser, click the **Elastos Node Manager** icon, and the wizard handles the rest:

1. OS / disk / wallet checks (auto)
2. **Binary step**: pick "Install ela for me" — ENM downloads Go if needed, clones the Elastos.ELA source, runs `make all`, and verifies (~5 min, live progress bar). The "I already have ela built" path is still there for power users — see [docs/BUILD-ELA.md](docs/BUILD-ELA.md).
3. Keystore import (skip for full-node mode)
4. Network (auto-detect or manual IP)
5. Confirm + Start mainchain

> **About `npm install`**: PC2's monorepo has two workspaces using different jsdom majors (`src/gui`@21 vs `src/backend`@27), which transitively want different `canvas` peer versions. The `.npmrc` at the repo root sets `legacy-peer-deps=true` so npm picks per-workspace nested copies instead of refusing to resolve. `canvas` is an optional dep used only by jsdom's test renderer; it's never executed by PC2 or ENM at runtime, so this is safe. The setting is committed to the repo — you don't need to add the flag to your install command.

## Architecture

ENM is a pure PC2 extension. It does not modify PC2 core.

```
Node manager app/                 # This folder. Gets copied to pc2.net/extensions/elastos-node-manager/
├── main.js                       # Extension lifecycle hooks
├── package.json                  # Pinned deps (joi, tcp-port-used; no Docker, no remote fetcher)
├── routes/                       # Express routes mounted via install.routes hook
├── lib/                          # All business logic
│   ├── NativeProcessService.js   # child_process.spawn + PID + reattach
│   ├── EnmBinaryLocator.js       # validates operator-supplied path
│   ├── EnmEncryption.js          # own AES-256-GCM (own key file)
│   ├── OwnerCheckMiddleware.js   # own requireOwner equivalent
│   ├── ...
├── public/                       # Frontend (served via express.static)
└── docs/                         # Operator guides
```

## v0.1 scope

- Mainchain only (one chain)
- Ubuntu/Debian only (refuses other OSes during setup)
- Operator pre-builds ELA from source (we never auto-download or auto-build)
- 18 failure modes detected; safe ones auto-heal, risky ones ask the owner
- All UI inside one app icon in the PC2 launcher

## Failure-mode detection (F1-F18)

Full traceability matrix in [docs/F-RULES.md](docs/F-RULES.md). Quick reference:

| Tier | Rules | What happens |
|------|-------|--------------|
| AUTOMATED-SAFE | F1, F2, F3 | Engine restarts the chain; max 3 attempts per 10 min before escalating |
| OWNER-CONFIRMS | F4, F5, F6, F7, F8, F9, F10, F13 | Engine creates a proposal; you confirm via dashboard modal |
| CRITICAL-NOTIFY | F11, F16, F18 | Banner notification; manual investigation |
| NEVER-AUTOMATIC | F12 | BPoS Inactive — you sign ActivateProducer via ela-cli |

F14 (Docker daemon) and F17 (image-pull) are dropped in Rev 9 (no Docker).
F15 (audit DB integrity) is deferred to v0.2.

## Troubleshooting

The fastest path is **GET `/api/chains/mainchain/diagnose`** (or click the Diagnose button on the chain card). It walks every subsystem in order and tells you *exactly* what's wrong with status badges (`ok` / `warn` / `fail` / `skip`) and step-by-step shell commands. Many findings expose an **Auto-fix** button for a single safe remediation.

### Common scenarios

| Problem | What it means | How to fix |
|---|---|---|
| **Chain won't start — "host has unresolved conflicts"** | F19 fired. Another process owns a port, or a rogue `ela` is running, or perms are wrong. | The toast lists every blocker with the exact shell command. After fixing, click Start. Override (not recommended): `?force=1` query param. |
| **Chain starts then dies in 5 sec** | Usually a stale `LOCK` file in `elastos/data/chain/LOCK` — ela holds it open while running and crashes if a previous instance left it. | Diagnose → "Stale LevelDB LOCK" → click Auto-fix. Or: `rm <chainDir>/elastos/data/chain/LOCK` then Start. |
| **Stuck at "Syncing" with no progress** | F4 will fire after 10 min. Three causes: (1) zero peers, (2) network height unknown, (3) chain genuinely stalled. | Diagnose shows all three. Velocity reads 0? Restart. Peers=0? Check firewall + DNS. |
| **Sync velocity dropping over time** | Disk I/O contention or LevelDB needs compaction. | Settings → Mainchain Advanced → "Compact logs" frees the obvious wins. For DB compaction itself, stop the chain, let leveldb's natural background compaction run on next start. |
| **"RPC unreachable" right after restart** | Normal for the first 30 sec — ela rebuilds indexes before opening RPC. F2 grace is 2 min. | Wait 30 sec, refresh. If it persists past 2 min: Diagnose → check `WhiteIPList` and `rpc.passwordEncrypted`. |
| **Out of disk** | F5 fires at 20 GB warn / 5 GB critical. ELA grows ~5 GB/month + logs. | (1) Settings → "Compact logs" rotates *.log → *.gz and prunes >90 days. (2) `du -sh ~/.pc2/extensions/elastos-node-manager/chains/mainchain/elastos/{data,logs}` to see what's eating space. (3) Move dataDir to a bigger volume: stop chain → `mv` → update `dataDir` in Settings → Start. |
| **High RAM / OOM kill** | F6. Default memory limit is 4 GB; archive mode + busy times push it higher. | Settings → Mainchain Advanced → memoryLimitMb → 6144 or 8192. Also `free -h` to confirm host has the headroom. |
| **Producer dropped to Inactive (BPoS)** | F12. >720 rounds since last block produced. >1300 rounds = forced inactive (deposit penalty risk). | **You must run ela-cli ActivateProducer yourself** — ENM never holds your owner key. The notification has the exact command. After signing + submitting within the 6-block window, refresh the producer card. |
| **No inbound peers** (BPoS) | F18. P2P (20338) and DPoS p2p (20339) inbound aren't reaching you. | `sudo ufw allow 20338/tcp && sudo ufw allow 20339/tcp`. If behind NAT/router: forward both ports. Cloud providers: open in security group. |
| **Wrong external IP advertised** | Auto-detect failed or you're behind CGNAT. | Settings → Network → manual override → paste correct IP or DDNS hostname. Test with `curl ifconfig.me` from the host. |
| **Clock skew warnings** | F13. Host clock drifted > 2 sec. ELA Schnorr signing fails silently above 4.2 sec. | `sudo systemctl restart chrony` or `sudo ntpdate -s pool.ntp.org`. Wait one slow tick (5 min) for ENM to re-check. |
| **Auto-restart loop won't stop** | F1 escalates after 3 attempts in 10 min — you'll see an OWNER-CONFIRMS proposal instead of more restarts. | Open the proposal modal → reject → **diagnose first** to find the real cause. Approving without diagnosing just resets the budget for another 3 attempts. |
| **Healing notifications not arriving** | SSE stream may be disconnected. | Reload the dashboard. Browser DevTools → Network → look for the open `/api/events` connection. SSE auto-reconnects with backoff but a stale tab may need a refresh. |
| **App keeps detecting old `~/.config/elastos/`** | LEGACY_CONFIG warning (non-blocking). ENM uses its own data dir. | `mv ~/.config/elastos ~/.config/elastos.legacy-$(date +%Y%m%d)` and re-scan in the wizard. Or click Adopt to import the existing keystore. |
| **systemd `node.service` keeps restarting ela behind my back** | Legacy node.sh installer left an enabled unit. | `sudo systemctl disable --now node`. The SYSTEMD_UNIT warning will clear on next scan (5 min cache). |
| **F19 keeps firing after I stopped the rogue process** | Scan results cached for 5 min. | Wait, or re-trigger scan: `GET /api/setup/conflicts`. |
| **Audit tab is empty** | Engine only logs on state-transition events. | Trigger anything (start/stop/restart) and you'll see entries. The general HTTP-mutation log is also tracked under `tier=HTTP-MUTATION`. |
| **Setup wizard re-prompts after relaunch** | Wizard state lives in `enm_setup_state`. If PC2's data dir was reset the table is gone. | Walk through the 9 steps again — config + keystore + network are persisted server-side after each step. |
| **Producer state shows wrong rank** | RPC reports based on current arbiter group; refreshes every 60s. | Wait one minute or refresh the dashboard. |
| **`ela --version` reports a different version than ENM expects** | F8. You rebuilt from a newer tag. | Settings → Mainchain Advanced → click Save (no other change needed). ENM accepts the new version. |

### How the diagnose endpoint works

```bash
curl -s -H "Authorization: Bearer <session>" \
  http://localhost:4200/extensions/elastos-node-manager/api/chains/mainchain/diagnose | jq
```

You'll get something like:

```json
{
  "success": true,
  "result": {
    "summary": { "ok": 6, "warn": 1, "fail": 1, "skip": 0, "unknown": 0 },
    "findings": [
      { "id": "config-present", "status": "ok", "title": "Configuration present", "detail": "..." },
      { "id": "binary-path", "status": "ok", "title": "ela binary present and executable", "detail": "..." },
      { "id": "process-state", "status": "fail", "title": "Chain process is not running",
        "detail": "enabled=true but no live PID...",
        "fixes": ["Click Start in the dashboard.", "If start refuses with host conflicts..."],
        "autoFix": "restart-chain" },
      { "id": "leveldb-lock", "status": "warn", "title": "Stale LevelDB LOCK file detected",
        "detail": "File at ... exists with no live owner. ela will refuse to start.",
        "fixes": ["rm ...", "Then click Start."],
        "autoFix": "clear-leveldb-lock" }
    ]
  }
}
```

Findings with `autoFix` set can be remediated with a single POST:
```bash
curl -X POST -H "Authorization: Bearer <session>" \
  'http://localhost:4200/extensions/elastos-node-manager/api/chains/mainchain/auto-fix?action=clear-leveldb-lock'
```

Whitelisted actions: `remove-stale-pid`, `restart-chain`, `config-rollback`, `clear-leveldb-lock`. Anything else → 400. None of these touch your keys; the engine refuses to clear `LOCK` on a live chain (it would corrupt the DB).

## Auto-start on host reboot

ENM auto-starts `enabled: true` chains when the extension's `ready` hook fires — both for "PC2 restarted while ela was running" (handled via PID-file reattach) and for cold boots after a host shutdown. Configurable in Settings → General → Auto-start; default on, with a 10s post-boot delay so DNS/network/disk are settled.

For the host itself to auto-restart PC2 after a power cycle, install a systemd unit:

```ini
# /etc/systemd/system/pc2.service
[Unit]
Description=PC2 (Elacity Puter fork)
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/pc2
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pc2
journalctl -u pc2 -f
```

PC2 starts → ENM extension boots → reads chain config → starts ela. Two subtleties:

1. **Don't enable a `node.service` or `ela.service` separately.** ENM's conflict scanner will flag them as SYSTEMD_UNIT warnings — they'd race ENM for the same chain.
2. **The 10-second delay is intentional.** Some cloud hosts (especially CGNAT'd VPS) take ~5 sec for outbound DNS to resolve; spawning ela earlier means a flaky first sync. Tune via `cfg.global.autoStart.delaySec` if your environment is faster/slower.

## Log rotation / chain-data compression

The biggest disk hog is ela's on-disk logs (`elastos/logs/node/*.log`, `elastos/logs/dpos/*.log`) — they grow unbounded otherwise. ENM rotates and gzips them automatically:

- Once a day, files older than `gzipAfterDays` (default 7) get gzipped to `*.<date>.gz`.
- Files older than `purgeAfterDays` (default 90) get deleted.
- The *current* day's log is left alone (gzipping a live-write target would lose data).
- Idempotent — already-gzipped files are skipped.

Tunable in Settings → General → Log rotation. Force a pass right now:

```bash
curl -X POST -H "Authorization: Bearer <session>" \
  http://localhost:4200/extensions/elastos-node-manager/api/chains/mainchain/compact-logs
```

Returns `{ gzipped, purged, bytesFreed, files: [...] }`. Typical first run on a 30-day-old install: ~1.2 GB freed.

> **Why no chain-DB compaction button?** ela's LevelDB does background compaction on its own; explicitly compacting it from outside is risky (can corrupt the DB if the chain is live). The right way to reclaim DB space is to stop the chain, let LevelDB's natural compaction settle on next start, or move `dataDir` to a fresh volume and re-sync. Both of those are operator decisions, not auto-fixes.

## Backup / restore

ENM stores its config + audit log inside PC2's data dir under `extensions/elastos-node-manager/`:
- `config.json` (validated by joi schema, encrypted RPC password)
- `config.json.bak` (one previous version, used by F9 rollback)
- `encryption.key` (mode 0600; needed to decrypt RPC password)
- `bin/` (operator-supplied binary metadata)
- `chains/<chainId>/` (chain data dir, config, keystore)

Audit log lives in PC2's shared SQLite DB (table `enm_audit_logs`).

To back up everything: include the extension data dir in PC2's normal backup workflow. To restore on a new host: copy the data dir over before starting PC2; the extension will pick up the existing config on boot.

## Uninstall

Run `scripts/enm-uninstall.sh`. Two modes:
- `--soft` (default): stops the chain, removes the PID/meta files, keeps the chain data + config.
- `--purge`: also wipes the chain data dir and the audit table rows.

The script does NOT remove the operator's `ela` binary (the operator owns its lifecycle).

## License

AGPL-3.0 (matches PC2)
