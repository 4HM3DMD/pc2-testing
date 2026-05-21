# ENM EVM Sidechain Operational Audit (esc / eid / pg)

Source-grounded investigation, 2026-05-21. Triggered by the operator's point that
the SPV-data dependency we found on pg applies to **all** EVM chains and that we
were likely missing more. Five parallel deep-dives into the esc/eid source
(`Elastos.ELA.SideChain.ESC` / `.EID`; pg is a closed-source fork of esc),
cross-checked against ENM (`enm-server/src`). All claims anchored to source.

Reference: `Elastos.ELA.SideChain.ESC` @ `/Users/ahmedibrahim/Downloads/Elastos-Knowledge-Base/repos/`.

---

## 1. Per-chain data layout (LIVE-confirmed + source-proven)

| chain | instance/chaindata dir | chaindata size | SPV state (siblings of chaindata) | IPC |
|---|---|---|---|---|
| esc | `data/geth` | **20 GB** | `data/header` (~2GB), `data/store`, `data/spv_transaction_info.db`, `data/logs-spv` | `geth.ipc` |
| eid | `data/geth` | **21 GB** | same | `geth.ipc` |
| pg  | `data/pgp`  | 4 GB | same | `pgp.ipc` |

Also siblings (preserve): `data/keystore` (mining identity), `data/miner_address.txt`.
Source: instance dir = `node/config.go:349-353 instanceDir()`; SPV root = the raw
`--datadir` (`cmd/geth/main.go:404-405 SpvDataDir`), NOT the geth subdir, so SPV is
always a sibling. `data/peers.json` is the **ELA-SPV addrmgr** peer cache
(`Elastos.ELA/p2p/addrmgr/addrmanager.go:1180`), i.e. mainchain-SPV bootstrap — not
the EVM peer DB (that's `data/<instance>/nodes`).

**ENM resync (`EnmMaintenanceManager.js:358-364`) is fundamentally correct** for all 3:
wipes `data/geth` + `data/pgp` (absent one no-ops) + cleans caches; keystore guard
absolute (`:381-394`); SPV (header/store/spv_transaction_info.db/logs-spv) preserved.

---

## 2. The SPV → EVM dependency (the operator's dev was right; now code-proven)

PBFT block validation reads the arbiter set **exclusively** from SPV:
`pbft.go verifyConfirm → spv.GetProducers(elaHeight) → SpvService.GetArbiters()`; on
error the block is **rejected** (`consensus/pbft/pbft.go:834-847`). If SPV is
missing / behind / corrupt the node **stalls or refuses to validate**; on EID (PBFT
from block 0) it hits `ErrWaitRecoverStatus = "wait for recoved states"`
(`pbft.go:86`) → code=2. So: **wiping SPV forces a multi-hour ELA-header re-sync
before the EVM chain can validate again** — exactly the dev's warning.

`ConsensusAlgorithm` enum (`Elastos.ELA.SPV/interface/spvservice.go:40-45`):
**`DPOS = 0x00`, `POW = 0x01`.** So the `Mode=0` we saw on stuck pg = **DPOS =
normal** for a synced mainnet node (spvHeight ~2.2M). Caveat: an empty/unsynced
arbiter store **also** returns 0 (zero-value default), so `Mode=0` only means
"healthy DPOS" once `spvHeight` is real — the height disambiguates.

---

## 3. F26 (auto-resync) coverage gaps — what we ship today vs the real failure modes

F26 fires on ≥3 `retrieved hash chain is invalid` (geth downloader `errInvalidChain`,
`eth/downloader/downloader.go:85`) + 20-min stall + peers>0 → wipe+resync. That's the
**right primary signature for the classic downloader wedge** and well-gated against
false positives. But it MISSES / MIS-handles:

| failure mode | signature | right fix | F26 today |
|---|---|---|---|
| classic minority-fork wedge | `retrieved hash chain is invalid` | wipe+resync | ✅ catches + fixes |
| **silent state-root halt** (PBFT live-insert, no higher-TD peer) | `invalid merkle root` / `BAD BLOCK` (NO downloader string) | wipe+resync | ❌ **misses** → only F4 restart → re-poisons |
| **startup-corruption** (genesis/gap/ancient mismatch) | `gap (#N)…ancients and leveldb` / `genesis mismatch` (node won't start) | wipe+resync | ❌ **misses** (F26 needs alive+stalled) → F1 restart-loops |
| **PBFT recovery stall** (no quorum/peers to recover) | `wait for recoved states` / `can not find active peer` | re-peer / restart — **NEVER wipe** | ⚠️ won't fire (peers>0 path), but nothing else handles it; a wipe here wastes days |
| SPV not-yet-synced (transient downloader errors during catch-up) | `retrieved hash chain is invalid` (transient) | wait for SPV | ⚠️ **F26 can't tell this from a real fork** → may wipe mid-catch-up → re-fork loop |
| keystore/account error | `create dpos account error` | operator action | ❌ no handling |

---

## 4. Shutdown / flush — the 45 s drain is not enough for 20 GB chains

- **SIGINT is correct** (binary treats SIGINT==SIGTERM, `cmd/utils/cmd.go:66-86`;
  node.sh uses `kill -s SIGINT` and waits for exit, never SIGKILLs on a timer).
- geth's clean `blockchain.Stop()` flushes the dirty trie via `triedb.Commit`
  ("Writing cached state to disk", `core/blockchain.go:889`). In `--gcmode full`,
  dirty state is flushed lazily only when `gcproc > TrieTimeLimit = 5min`
  (`blockchain.go:205`) — so at shutdown up to ~5 min of accumulated dirty state
  must be written. On a 20 GB esc/eid node under disk pressure this **can exceed
  45 s** → drain returns → supervisor SIGKILLs mid-Commit → head pointer advanced
  but HEAD trie not landed → restart rewinds → mining node re-forks. **The exact
  bug v0.5.184 was meant to fix, still reachable on the big chains.**
- The signal/redeploy path uses the **45 s** drain (`SHUTDOWN_DRAIN_GRACE_MS`),
  while a single per-chain stop gets **60 s** (`PROCESS_STOP_GRACE_MS`) — so the
  bulk path (3 nodes flushing **concurrently**, contending for IOPS) perversely gets
  *less* time. And the drain only helps if pc2-node's SIGTERM→SIGKILL grace for the
  ENM app actually exceeds it (the code comment assumes systemd 90 s, but ENM is
  supervised by **pc2-node**, grace unverified).

---

## 5. Genesis / consensus-param parity — FORK-SAFE (no P0)

Omitting `--networkid` + passing `--testnet` only on testnet is **safe for all 3**:
ChainID/genesis come from the binary's built-in genesis selected by the `--testnet`
boolean, not `--networkid` (`core/genesis.go:165-167`, `params/config.go:61`:
esc=20/eid=22). esc `--frozen.account.list` (11 addrs + binary appends 2 = 13)
matches node.sh exactly (consensus-critical, correct). `DynamicArbiterHeight=1034900`
(the consensus-switchover height) is the binary default, matches node.sh. Minor:
ESC frozen list is hard-coded in ENM and could **silently drift** if Elastos amends
it (P1); ENM doesn't force `--syncmode full` for miners like node.sh (P2).

---

## Prioritized punch list (→ v0.5.185 hardening)

**P0 — F26 is not yet safe to auto-wipe the 20 GB esc/eid chains until these land:**
- **P0-A** Surface each EVM chain's own SPV height (log-tail `spvHeight=` or RPC). *(prereq)*
- **P0-B** Gate `detectF26` on SPV-synced (return null if SPV height unknown / lagging mainchain tip) — don't wipe a chain that's merely waiting on SPV. `HealthRules.js:928`.
- **P0-C** Detect the silent state-root halt: add `/invalid merkle root|invalid receipt root hash|BAD BLOCK/` to `_probeEvmForkSignal`. `HealthChecker.js:1315`.
- **P0-D** Make the shutdown drain actually sufficient: raise `SHUTDOWN_DRAIN_GRACE_MS` toward the flush worst-case (≥120-180 s) and/or poll-until-exit; ensure it's ≥ `PROCESS_STOP_GRACE_MS`; verify pc2-node's kill grace. `EnmConstants.js`, `server.js`.

**P1:**
- **P1-A** Exclude PBFT recovery stall (`wait for recoved states` / `can not find active peer`) from F26 → alert-only rule. `HealthChecker.js`/`HealthRules.js`.
- **P1-B** Bridge startup-corruption (node exits within Ns of spawn + `gap…ancients`/`genesis mismatch`/`Failed to write block data to ancient store`) → propose resync (OWNER_CONFIRMS, paired with disk-free check). 
- **P1-C** SPV catch-up grace: suppress F4/F26 height-stall while SPV is still catching up (SPV-driven, longer than the fixed 10-min initial grace).
- **P1-D** Size the drain for concurrent flush of 3 nodes (or stagger SIGINT).
- **P1-E** ESC frozen-list drift guard (version-gate / document the binary-tied review).

**P2:**
- **P2-A** Stop wiping `data/peers.json` on resync (it's the SPV mainchain peer cache, not fork state; slows SPV re-handshake; the inline comment is misleading). `EnmMaintenanceManager.js:362`.
- **P2-B** Clean pg's `pgp.ipc` on resync (currently only `geth.ipc`). `EnmMaintenanceManager.js:361`.
- **P2-C** Add an absolute SPV-preservation filter (refuse to delete header/store/spv_transaction_info.db/logs-spv) — defense-in-depth like the keystore guard. `EnmMaintenanceManager.js:381`.
- **P2-D** Default miner starts to `--syncmode full` (node.sh parity). `EvmSidechainAdapter.js:376`.
- **P2-E** Alert (never wipe) on `create dpos account error`; add `missing trie node` to the wipe regex.

**Lower-priority follow-up areas not yet audited:** oracle↔EVM-parent interaction on resync, disk/pruning behavior under `--gcmode`, archive-vs-full implications.
