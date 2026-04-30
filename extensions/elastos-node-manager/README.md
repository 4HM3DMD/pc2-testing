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

1. Make sure you're on Ubuntu 22.04+ (or Debian 11+) with PC2 running locally.
2. Build the ELA binary from source — see [docs/BUILD-ELA.md](docs/BUILD-ELA.md). Takes ~5 minutes.
3. Open ENM from the PC2 launcher.
4. The setup wizard will guide you through: locate your `ela` binary, import your keystore, generate config, start the node.

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

| Problem | Where to look |
|---------|---------------|
| Setup wizard refuses to proceed | OS check: must be Ubuntu/Debian. Disk check: ≥50 GB free. Wallet check: PC2 owner claimed. |
| `ela` binary verify fails | Re-run `make all` in `Elastos.ELA`. Make sure file is mode 0755. |
| RPC unreachable after restart | Settings → Mainchain Advanced → check `WhiteIPList` (defaults to 127.0.0.1). |
| Audit tab is empty | Tab loads paginated; "Load more" extends. Filters apply per-wallet. |
| Healing notifications not arriving | SSE stream may be disconnected — reload the dashboard. Check browser DevTools → Network for the open `/api/events` connection. |
| Producer state shows wrong rank | The chain's RPC reports based on current arbiter group; refreshes every 60s. Refresh the dashboard for fresher state. |
| Setup wizard re-prompts after relaunch | The wizard records progress in `enm_setup_state` table; if PC2's data dir was reset the wizard will start over. |

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
