# V1.2 Pre-Release Team Call — Summary & Task Index

**Date**: 2026-04-17
**Context**: Pre-release alignment for V1.2 DRM cut, targeting end of
April 2026.
**Purpose of this file**: Single index for everything that came out of
the call, with links to the individual task files so nothing falls
through the cracks.

## Priorities Set by User on the Call

> "Lit Action security fix, metadata alignment, and IPFS fixes are
> the most important things to get tied up as soon as possible for
> the upcoming release."

The three focus areas in priority order:

1. **Lit Action security** (P0) — must ship before V1.2.
2. **IPFS connectivity** (P1) — unblocks the local-first upload path.
3. **V3 metadata alignment** (P1) — required for parity with Elacity
   frontend and for the `allowAITraining` flag.

Two additional items also came up and are parked/followed up on
separately.

## Task Index

| # | Task | Priority | Status | File |
|---|------|----------|--------|------|
| 1 | **Lit Action session-key delegation auth** | **P0** | Proposed (design + threat model ready, awaiting sign-off) | [`Task`](../LIT-ACTION-SIGNATURE-AUTH/LIT-ACTION-SIGNATURE-AUTH.md) · [`DESIGN.md`](../LIT-ACTION-SIGNATURE-AUTH/DESIGN.md) · [`SECURITY.md`](../LIT-ACTION-SIGNATURE-AUTH/SECURITY.md) |
| 2 | **IPFS bootstrap + swarm connect to Elacity gateway** | P1 | Proposed | [`../IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md`](../IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md) |
| 3 | **Align PC2 with V3 metadata protocol** | P1 | **Blocked** (awaiting spec) | [`../V3-METADATA-ALIGNMENT/V3-METADATA-ALIGNMENT.md`](../V3-METADATA-ALIGNMENT/V3-METADATA-ALIGNMENT.md) |
| 4 | Upload-Elacity local-first + fire-and-forget replication | P1 | Parked (agreed direction) | [`../UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md`](../UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md) |
| 5 | EPUB cover rendering retest | P2 | Open (retest only, no task file yet) | (see Notes) |
| 6 | Large-3D-model support investigation | P3 (future) | Icebox | (see Notes) |

## Finding 1 — Lit Action Security (P0)

### What was discussed

A team member reproduced a bypass of the non-media Lit Action's
access control: because `userAddress` is passed via `jsParams` and the
action is public/immutable on IPFS, an attacker who controls any
Lit-compatible client can invoke the action with **any** known
authorized buyer's address and receive the CEK. The same pattern
exists in the media action.

### What ships — Option C: session-key delegation

- Remove `userAddress` from `jsParams` entirely.
- On wallet connect, user signs **one** `SecureViewDelegation` with
  their EOA — authorises an ephemeral, device-bound, **non-extractable**
  Web Crypto key to decrypt dDRM content for up to 24 hours across
  their EOA and Particle smart account.
- Every asset open: ephemeral key silently signs a per-request
  message — **zero wallet popups** after the initial delegation.
- Lit Action verifies both signatures (EIP-191 or EIP-1271 for the
  delegation; Web Crypto for the per-request) and runs
  `hasAccessByContentId(addr, kid)` across the delegation's covered
  addresses.
- Re-pin both Lit Actions to IPFS; update `actionIpfsId` references.

**Why not per-asset or per-session signing?** Community feedback on
this call explicitly flagged UX: *"how nice it was to just double-
click and open a file."* Per-asset signing reintroduces a prompt every
time you open a new book; per-session signing still prompts every
15-30 minutes. Option C matches "sign in once, use all day" — same
model Argent, Privy, and every consumer crypto wallet uses. Full
comparison in DESIGN.md §9.

### Pointer

- **DESIGN.md** — exploit reproduction, full protocol, EOA/smart-
  account matrix, Lit Action pseudocode, rollout, rollback.
- **SECURITY.md** — formal threat model, 20-row attack catalogue,
  residual-risk analysis (especially the XSS-during-active-session
  case), incident response playbook, external-audit checklist.

### Why this is P0

- Security bypass. Any PC2 node operator can decrypt any encrypted
  asset as long as they observe the asset being bought by *any*
  wallet. V1.2 ships dDRM as a headline feature; shipping with this
  unfixed would be a credibility break.
- Scope is well-understood (~3.5 days: 0.5d Particle spike, 1d
  implementation, 1d test, 0.5d docs + PR). No external
  dependencies.

## Finding 2 — IPFS Node Connectivity (P1)

### What was discussed

PC2's local Helia IPFS node is not directly peered with Elacity's
gateway. DHT discovery between the two is flaky; content sometimes
takes ≥ 30 s to propagate, triggering the symptomatic "slow publish"
UX a community member reported on 2026-04-17.

### What ships

- Explicit bootstrap entry for Elacity's IPFS multiaddr.
- Post-startup `libp2p.dial(...)` to force-establish the connection.
- Background reconnect loop if the link drops.
- `/api/node/ipfs/peers` health endpoint with `elacityPeered` flag.

### Why this is P1 (not P0)

Bypass does not exist today — the slowness is an availability /
performance issue, not a correctness one. Fixing it unblocks
`UPLOAD-ELACITY-LOCAL-FIRST` (currently parked), which in turn fixes
the reported publish-flow stalls more completely.

### Coordination needed

Elacity team member to share their canonical multiaddr. We can
bootstrap from `ipfs.ela.city`'s `/api/v0/id` in the interim.

## Finding 3 — V3 Metadata Alignment (P1, Blocked)

### What was discussed

Elacity frontend has moved to V3 metadata with four categories
(channel, token, plans, asset flags including `allowAITraining`).
PC2's Creator and sync indexer are still on V1/V2. Full spec document
has not yet been delivered.

### What ships

- All four categories implemented in PC2 Creator (write) and sync
  indexer (read).
- Back-compat path for already-minted V1/V2 channels.
- `allowAITraining` exposed in Creator UI.

### Why blocked

Implementing without the authoritative spec risks diverging from
Elacity's exact field shapes. Waiting is the right call; the task
file is pre-staged so work can start the hour the spec arrives.

### Coordination needed

Elacity team member to deliver the V3 metadata spec (or a link to the
authoritative type definitions in their frontend repo).

## Finding 4 — Local-First Upload (Parked)

Already captured in
[`UPLOAD-ELACITY-LOCAL-FIRST`](../UPLOAD-ELACITY-LOCAL-FIRST/UPLOAD-ELACITY-LOCAL-FIRST.md).
User explicitly parked on 2026-04-17. It was reiterated on the call
as the right long-term direction ("local-first, Elacity pulls from
protocol") but it correctly waits for `IPFS-ELACITY-BOOTSTRAP` to
de-risk the dependency.

## Finding 5 — EPUB Cover Rendering Retest (P2)

### What was discussed

Earlier EPUB testing showed Chapter 1 being just a cover image. A
re-test is needed to confirm whether the cover renders correctly in
Paged mode and Scrolling mode with the current `ddrm-renderer` and
copy-lockdown CSS.

### Suggested action

A ~30-minute retest against a small library of EPUB samples (e.g., a
Project Gutenberg file and a commercial reference). If the cover is
still broken, open a focused task file then. No need to pre-stage.

## Finding 6 — Large 3D Models (Future)

### What was discussed

Heritage-site / LIDAR-scan use case wants to tokenize 3D models up
to ~5 GB. Current viewers handle small GLB/OBJ/STL; nothing in the
pipeline today supports multi-GB streaming.

### Suggested action

Icebox. Requires:

- A chunked IPFS delivery story (probably UnixFS sharding + progressive
  loader in the viewer).
- A DRM story for chunked non-media (our existing encrypt path does
  one-shot; multi-GB one-shot is unacceptable memory footprint).
- A renderer capable of streaming / progressively loading geometry.

Worth spiking once V1.2 is out — genuinely unlocks heritage/museum
partnerships. Not V1.2 scope.

## Recommended Sequence

**This week** (to close V1.2 security debt):

1. Implement `LIT-ACTION-SIGNATURE-AUTH` — ~1 day dev, ~0.5 day test.
2. Implement `IPFS-ELACITY-BOOTSTRAP` — ~0.5 day dev, needs Elacity
   multiaddr from team member (can proceed with interim lookup in
   parallel).

**As soon as V3 spec arrives**:

3. Implement `V3-METADATA-ALIGNMENT` against the pre-staged plan.

**Straight after** (1-3 above complete):

4. Unpark and implement `UPLOAD-ELACITY-LOCAL-FIRST` — already
   designed, will verify quickly against the now-reliable IPFS link.
5. Retest EPUB cover (`Finding 5`) — small standalone check.

**Post-V1.2**:

6. Scope `Finding 6` (large 3D models).

## Source

Transcript of the 2026-04-17 pre-release call is in the agent
transcript store under this project; not reproduced here for brevity.
All tasks above are traceable to specific call moments.
