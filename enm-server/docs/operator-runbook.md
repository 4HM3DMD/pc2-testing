# ENM v0.3 — Operator runbook

Walkthroughs for the most common operator tasks. For the "why"
behind these flows, see [architecture.md](architecture.md).

---

## Fresh install (5 minutes)

Pre-reqs: a Linux box with PC2 already installed, Docker present, and
your operator wallet already claimed via the PC2 dashboard.

```bash
# 1. Run the ENM installer (adds enm-server to your existing compose stack).
bash <(curl -sSL https://raw.githubusercontent.com/4HM3DMD/pc2-testing/main/enm-server/scripts/install-enm.sh)

# 2. Open the PC2 dashboard.
open http://<your-server-ip>:4100   # or paste into your browser

# 3. Click the "Elastos Node Manager" launcher icon. The wizard opens.
```

Inside the wizard:

1. **Welcome** — three preflight checks turn green (OS, disk, identity).
2. **Install & Configure**:
   - Click **Install**. The card switches from "Click 'Install' to begin"
     to a live progress bar that shows phase + bytes downloaded.
   - When status reads "Installed v0.9.9.5" (or current upstream version),
     pick a mode: **BPoS supernode** or **Full node**.
   - For BPoS, choose **Generate password** (recommended) or paste your own.
     The reveal panel shows the password once — copy it to your password
     manager and tick "I saved it" before continuing.
3. **Confirm & Start** — review the summary, click **Write config & start**.

The dashboard renders within a few seconds. The mainchain card moves
through `starting → syncing → healthy` as the chain catches up to the
network.

---

## Upgrade ENM

```bash
cd ~/pc2
docker compose pull enm-server
docker compose up -d enm-server
```

ENM upgrades are non-disruptive to the chain — the ela process runs
as a child of enm-server but its state lives in `/data/enm/chains/`,
which is a host-mounted volume. The chain keeps its synced data across
container restarts.

To upgrade ela itself (e.g. when a new mainnet release ships):

1. Open ENM → Dashboard → Mainchain card
2. Click **Stop** to bring the chain down cleanly
3. Open Settings → Mainchain Advanced → **Reinstall binary**
4. After the new binary lands, click **Start** on the Mainchain card

---

## Recover from a botched setup

Most botched setups are partial-install state confusion. The fastest
fix is `--reset`, which stops the container, archives `enm-data/`, and
exits without touching pc2 or its data:

```bash
bash <(curl -sSL .../install-enm.sh) --reset
```

You'll see:

```
==> Reset mode — stopping enm-server and archiving state...
✓ Container stopped and removed
✓ Archived enm-data → /home/op/pc2/enm-data.bak.20260505123045

Reset complete. To reinstall, re-run this script without --reset:
  bash <(curl -sSL .../install-enm.sh)
```

Then re-run the installer normally. The wizard appears as if this were
a fresh install.

If you want to keep audit history, copy `enm.db` out of the archive
before the next install creates a new `enm-data/`:

```bash
cp /home/op/pc2/enm-data.bak.<ts>/enm.db /tmp/enm-audit-pre-reset.db
```

---

## BPoS supernode registration

ENM v0.3 holds your producer keystore on the server but does NOT sign
or broadcast the registration transaction (per
[architecture.md § Architectural Invariant #2](architecture.md#2-operator-wallet--identity-never-signs)).
Registration happens externally with one of two paths.

### Path A — Essentials mobile wallet (recommended)

1. Open the ENM Dashboard → **Producer identity** card
2. Click **Open in Essentials**. Your phone receives a deep-link.
3. In Essentials, confirm the supernode name + URL + lock period.
4. Approve the on-chain transaction (requires 2,000 ELA in the deposit
   wallet associated with Essentials).
5. Within ~1 block, the Mainchain card's BPoS sub-panel will show
   `Producer state: Pending` → `Active`.

### Path B — `ela-cli` from a separate box

Use this if you don't have Essentials, or if your deposit wallet is on
a different machine than ENM.

1. Open the ENM Dashboard → Producer identity card
2. Expand **Register via CLI**. The card shows the templated command:

   ```bash
   ela-cli wallet buildtx producer register v2 \
     --nodepublickey 02a1b2c3...e9fa \
     --name "<your-supernode-name>" \
     --url "https://<your-supernode-url>" \
     --location 0 \
     --stakeuntil <current-height + lock-period> \
     --amount 2000 \
     --fee 0.000001
   ```

3. Fill in the placeholders. Run on the box that holds your deposit
   wallet. Sign and broadcast.
4. Verify on-chain by checking the BPoS sub-panel on ENM after one block.

---

## Daily ops

### Where do logs live?

- **enm-server logs** (the sidecar): `cd ~/pc2 && docker compose logs -f enm-server`
- **ela logs** (the chain): visible in ENM → Logs tab. On-disk:
  `~/pc2/enm-data/chains/mainchain/logs/ela.log`
- **Audit log** (every healing decision + operator action): ENM →
  Audit tab. Filterable by chain / tier / time range. Export as JSON.

### What does each chain state mean?

| Badge | Meaning | What to do |
|---|---|---|
| Not configured | Wizard hasn't run, or install was reset | Click **Configure** on the chain card |
| Stopped | Binary present but not running | Click **Start** when ready |
| Starting | Process spawned, waiting for first RPC response | Wait ~10s |
| Syncing | Healthy but behind network height | Wait — sync panel shows ETA |
| Healthy | Synced + producing blocks (BPoS) or following (full-node) | Nothing |
| Stalled | Sync hasn't advanced in 5+ min | Check Logs tab; F4 (sync-stall healing) is opt-in |
| Recovering | F1 healing fired (auto-restart on unexpected exit) | Wait — log will show the auto-restart and resync |
| Error | Process exited and F1 disabled, or start failed | Read the error toast; check Logs |

### How do I update operator preferences?

ENM → Settings tab. Three sections:

- **Network** — external IP/hostname (auto-detect or manual override)
- **Mainchain Advanced** — log level, archive mode, RPC creds, WhiteIPList
- **General preferences** — auto-execute AUTOMATED-SAFE healings, audit
  retention days, require ack on CRITICAL notifications

Saved preferences live in `enm.db` under `operator_preferences`.

### How do I see what healing has fired?

ENM → Audit tab. Default view shows the last 100 events. Filter by:

- Chain (currently only `mainchain`)
- Tier (`AUTOMATED-SAFE`, `OPERATOR-CONFIRM`, `MANUAL-ONLY`)
- Time range (from / to)

Export filtered results as JSON for incident postmortems.

---

## Common issues

### "ENM API unavailable" right after install

The container started but the API didn't come up within 60s. The
installer prints the last 30 lines of container logs. The most common
cause is the image didn't pull (network blip) — re-run the installer.

Manual investigation:

```bash
cd ~/pc2 && docker compose logs --tail=100 enm-server
```

If the logs show `EADDRINUSE: address already in use 0.0.0.0:4180`,
something else is on port 4180. Pass `--port 4181` to the installer.

### Mainchain card stuck on "Not configured" after wizard finished

Means the wizard didn't actually persist a config to disk. The
[Architectural Invariant #1](architecture.md#1-disk-is-the-source-of-truth)
self-heal would surface this as `coarseState=unconfigured` on next
boot.

Click **Configure** on the chain card to re-open the wizard inline.
The wizard pulls `/setup/state` and resumes at whichever step is
incomplete (install, keystore, or confirm).

If repeated wizard runs don't stick, run `--reset` and start fresh.

### F19 host-conflict alarms firing on every healing tick

This was a v0.2 bug — fixed in v0.3 backend. If you're still seeing
it on v0.3:

```bash
cd ~/pc2 && docker compose logs enm-server | grep -i "host conflict"
```

The v0.3 scanner treats `docker-proxy` as a benign holder for ports
ENM expects (because docker-proxy holding the host-side mapping is
exactly what we want — ela inside the container binds the inner port).
1-hour signature dedup means even legitimate conflicts only fire once
per hour, not 12×/hour.

If the alerts persist for a non-docker-proxy holder, that's a real
conflict. Identify it with:

```bash
sudo ss -ltnp '( sport = :20338 )'
```

…and stop the offending service, or pass `--no-bpos` to the installer
to bind ports to loopback only (full-node mode).

### Wizard install stalls > 30s on "preparing"

The installer is downloading a tarball from `download.elastos.io`. Slow
links can take a minute or two. If it stays at "preparing" with no
byte counter for > 60s, check container logs:

```bash
cd ~/pc2 && docker compose logs --tail=50 enm-server | grep -i download
```

You should see `EnmBinaryDownloader: GET https://download.elastos.io/...`.
If you see a network error, the upstream URL may have changed; file an
issue with the log line.

### "Mainchain installed but it's bugged it's not"

This was the v0.2 state divergence bug. v0.3's
[ChainState](../src/services/ChainState.js) reads disk truth on every
snapshot, so the dashboard cannot show "installed" while no binary
exists. If you see this on v0.3, please file an issue with:

- Output of `docker compose exec enm-server ls -la /data/enm/bin/mainchain/`
- Output of `curl http://localhost:4180/api/enm/chains/mainchain`
- The relevant container log section
