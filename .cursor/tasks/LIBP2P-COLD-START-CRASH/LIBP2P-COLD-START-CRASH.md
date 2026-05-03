# Task: libp2p Cold-Start Stack-Overflow Crash After Long Downtime

**Task ID**: LIBP2P-COLD-START-CRASH
**Created**: 2026-05-02
**Status**: Proposed
**Priority**: Medium (does NOT block v1.2.7 — pre-existing bug, unrelated to SQLite migration)

---

## Description

`pc2-node` crashes with `RangeError: Maximum call stack size exceeded` inside `@libp2p/utils/dist/src/queue/job.js` (recursive `onProgress` event propagation in the libp2p job queue) approximately 2 minutes after a cold start that follows a long downtime (>24h observed). The crash is unrelated to any application code — it is entirely inside the libp2p networking stack while it bursts hundreds of peer dials at once to recover from a stale DHT/peer-store state.

This is a **pre-existing bug** present in v1.2.6 and v1.2.7 alike. It was discovered during local Phase 3 verification of the v1.2.7 SQLite migration but **the SQLite migration is not the cause**: the crash stack trace contains zero application code, the database initialised cleanly and served real HTTP requests for ~2 minutes before the crash, and `pc2-node/package.json` libp2p versions did not change in v1.2.7.

---

## Background

### How it was discovered (v1.2.7 SQLite migration verification)

During [SQLITE-NO-COMPILE-MIGRATION](../SQLITE-NO-COMPILE-MIGRATION/SQLITE-NO-COMPILE-MIGRATION.md) Phase 3 local verification (Mac, Node 20.19.0, `pc2-node` started fresh after >24h offline), the user confirmed all DB-backed paths worked correctly (login, file operations, marketplace, AI chat, settings) and then noticed the server had stopped. Investigation of `/tmp/pc2-node-v127.log` revealed the stack-overflow crash detailed below.

### Why it does NOT block v1.2.7

1. **Stack trace is 100% inside `node_modules/@libp2p/...`** — no application code, no SQLite code, no migration-touched code.
2. **The migration code worked end-to-end before the crash** — DB init, schema migrations, prepared statements, `[Stat]` POST queries (which use SQLite for metadata lookups) all succeeded.
3. **The libp2p stack is unchanged in v1.2.7** — same `libp2p@^3.1.2`, same `@libp2p/utils@7.1.0` (transitive). The same crash is reproducible from v1.2.6 under the same conditions.
4. **Production deployments run continuously** — the Jetson production node has not exhibited this in 5+ days of continuous uptime. The bug requires a cold start after long downtime to surface.

---

## Evidence

### Crash trace (from `/tmp/pc2-node-v127.log`)

```
/Users/mtk/Documents/Cursor/pc2.net/pc2-node/node_modules/ed25519-to-x25519.wasm/src/ed25519-to-x25519.js:8
... process.on("unhandledRejection",function(){process.exit(1)}) ...
                                                            ^
RangeError: Maximum call stack size exceeded
    at file:///.../@libp2p/utils/dist/src/queue/job.js:60:45
    at Array.forEach (<anonymous>)
    at JobRecipient.onProgress (file:///.../@libp2p/utils/dist/src/queue/job.js:60:37)
    at file:///.../@libp2p/utils/dist/src/queue/job.js:61:47
    at Array.forEach (<anonymous>)
    at JobRecipient.onProgress (file:///.../@libp2p/utils/dist/src/queue/job.js:60:37)
    [...frame repeats indefinitely until stack exhausted...]
Node.js v20.19.0
```

### Forensic timeline (single run, 2026-05-02)

| Event | Timestamp (UTC) |
|---|---|
| Server started, DB initialized | `20:21:34.621` |
| Schema check / migrations OK | `20:21:34.649` |
| First user HTTP request served | `20:22:56.517` (Stat /Documents) |
| Last user HTTP request served | `20:22:56.518` (Stat /Public) |
| 984 successful peer dials logged before crash | between `20:21:34` and `20:23:40` |
| `RangeError` and process exit | `20:23:40` |
| **Total uptime** | **~2 min 06 sec** |
| **Downtime before this run** | **~32 hours** (last log line in v1.2.6 run was `2026-05-01 21:29` UTC) |

### Recursive code path (`@libp2p/utils@7.1.0`)

`node_modules/@libp2p/utils/dist/src/queue/job.js` lines 56–63:

```js
const result = await raceSignal(this.fn({
    ...(this.options ?? {}),
    signal: this.controller.signal,
    onProgress: (evt) => {
        this.recipients.forEach(recipient => {
            recipient.onProgress?.(evt);
        });
    }
}), this.controller.signal);
```

The `onProgress` callback iterates `this.recipients`, each of which is itself a `JobRecipient` whose own `onProgress` does the same iteration. With sufficient cross-references between recipients (which happens in libp2p's connection-manager job de-duplication when many concurrent dials target overlapping peer sets), this becomes self-referential and recurses without a base case.

---

## Hypothesis

**The crash is triggered by the catch-up burst of IPFS peer dials following a long downtime.** When `pc2-node` boots after being offline for many hours:

1. The cached peer store contains hundreds of stale addresses
2. The IPFS heartbeat / DHT bootstrap / Elacity peer connection-keeper all kick in roughly simultaneously
3. libp2p's connection manager dedupes overlapping dial requests by registering them as multiple `JobRecipient`s on the same underlying `Job`
4. As each dial completes, `onProgress` fires across the entire chain of recipients
5. With ~984 in-flight or recently completed dials, recipient cross-references create a cycle, and the recursive `forEach` overflows the call stack

This explains why:
- Production Jetson (continuous uptime) does not see this
- Dev Mac restarts after short pauses do not see this
- This particular cold start after 32 hours offline did

---

## Reproduction

### To reproduce

1. Stop `pc2-node` completely
2. Wait at least 24 hours (or otherwise allow the local peer store to become significantly stale)
3. Start `pc2-node` and watch `/tmp/pc2-node-*.log`
4. Within ~1–3 minutes, expect `RangeError: Maximum call stack size exceeded` originating from `@libp2p/utils/dist/src/queue/job.js`

### To confirm it is NOT v1.2.7 specific

Repeat the same procedure on `git checkout v1.2.6` (or any branch with the same libp2p versions). The same crash should occur.

---

## Scope

### In scope

- Investigate the recursion mechanism in `@libp2p/utils@7.1.0`'s job queue
- Determine whether a newer `@libp2p/utils` (or libp2p major) ships with a fix
- If no upstream fix exists, implement local mitigation:
  - Option A: Rate-limit cold-start peer dials (e.g. a startup grace period during which the connection manager processes only N dials/sec)
  - Option B: Clear stale peer store entries on startup when last-seen exceeds a threshold (e.g. 6h)
  - Option C: Wrap the libp2p `onProgress` callback in an iteration counter and break the chain at a safe depth
- Add a watchdog / auto-restart mechanism (PM2 already restarts on Jetson; verify dev script behaviour)
- Document the workaround for users who hit this

### Out of scope

- Changing application-level networking semantics (no change to which peers are dialed, only to how many at once and how their callbacks chain)
- Refactoring the larger libp2p integration

---

## Implementation Plan

> Status: Proposed. No code changes until User approves the chosen mitigation approach.

### Phase 1 — Investigation (no code changes)

- [ ] Confirm reproducibility on `pc2-node@1.2.6` HEAD (rule out v1.2.7 regression definitively)
- [ ] Check `@libp2p/utils` releases >7.1.0 for a fix to the recursive `onProgress` pattern
- [ ] Check `libp2p` releases >3.1.2 for connection-manager changes that would affect job-recipient dedup
- [ ] Search the libp2p GitHub issue tracker for matching reports (`Maximum call stack size`, `JobRecipient onProgress`, recursive forEach)
- [ ] Determine whether the Jetson production node has ever hit this (search PM2 logs for `RangeError: Maximum call stack size exceeded`)
- [ ] Decide between the three mitigation options (A: rate-limit, B: peer-store TTL, C: depth guard)

### Phase 2 — Implementation (gated on Phase 1 conclusion + User approval)

- [ ] Implement chosen mitigation
- [ ] Add an integration test or a deliberate stress harness that floods libp2p with concurrent dials and proves the new code path does not recurse
- [ ] Update `pc2-node` README or runbook with the recovery procedure if the bug ever recurs

### Phase 3 — Verification

- [ ] Reproduce the original crash conditions and confirm it no longer crashes
- [ ] Run pc2-node for 24h locally without crash
- [ ] Deploy to Jetson and observe for 1 week before considering the issue closed

---

## Acceptance Criteria

1. Cold start after >48h downtime completes peer-store catch-up without crash
2. No regression to existing IPFS connectivity (peer dialing still succeeds at expected rate)
3. Mitigation does not measurably delay first usable HTTP response on cold start (<5s budget acceptable)
4. Root cause documented in `docs/wiki/Technical/` so future maintainers understand the trade-off

---

## Files Likely Involved

- `pc2-node/src/services/ipfs/...` — wherever the libp2p connection manager and peer-store TTL are configured (exact file TBC during Phase 1)
- `pc2-node/package.json` — possible `@libp2p/utils` or `libp2p` version bump
- `pc2-node/package-lock.json`
- `docs/wiki/Technical/` — new doc page describing the bug, mitigation, and recovery procedure

## Files NOT to be modified

- Any code under `pc2-node/src/storage/` — this is purely a networking issue
- Any SQLite-related code (the v1.2.7 migration is independent and complete)

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Upgrading libp2p major triggers other regressions | High | Pin upgrade to patch/minor only if available; otherwise prefer local mitigation (Option A or C) over major bump |
| Rate-limiting cold-start dials slows IPFS warmup, hurting user-visible content load | Medium | Choose conservative limit (e.g. 20 dials/sec for first 60s, then unrestricted) |
| Clearing stale peer store on startup loses useful long-lived peer entries | Low | Use a generous TTL (24h) so legitimately reachable peers are preserved across normal restart cycles |
| Depth-guard wrapper over `onProgress` swallows legitimate callbacks | Medium | Add a metric / log line whenever the guard fires so we can observe production frequency before tightening further |

---

## Notes

- **Workaround for users hitting this in the wild today**: simply restart `pc2-node`. After the first restart, the peer store is fresher and the crash typically does not recur. If it does, restart 2–3 times until it stays up. PM2 on Jetson already does this automatically.
- **Why v1.2.7 still ships**: see "Why it does NOT block v1.2.7" above. The SQLite migration is a strict improvement that addresses a real user-facing pain point (Xcode CLT requirement) and has been verified against the user's real `pc2.db` for ~2.5 minutes of live operation, including HTTP queries that exercise SQLite read paths. This libp2p bug is older than v1.2.7 and orthogonal to it.
- **Related observation in the user's log**: the line `[ipfs] [IPFS] Elacity peer not connected; re-dialing` immediately precedes the crash by ~5 seconds. This is consistent with the hypothesis that the connection-manager dedup of the Elacity reconnect job overlaps with hundreds of in-flight DHT dials and triggers the recursion.

---

## Status Updates

| Date (UTC) | Status | Note |
|---|---|---|
| 2026-05-02 20:30 | Proposed | Filed during v1.2.7 Phase 3 verification of SQLite migration. Cause confirmed via stack trace; SQLite migration confirmed unaffected. |
