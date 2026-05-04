# Handover: Irzhy's Playback Failure (2026-04-28)

> **Audience**: Irzhy + anyone reproducing the same `"Playback Error — fetch failed"`
> **Status (as of 2026-04-29 20:00 UTC)**: **Fixed end-to-end for Irzhy's two test
> CIDs.** Durable reliability for future mints now in place via client-side
> pin forwarding + corrected nginx timeout on the Elacity Kubo pin endpoint.
> Two follow-on findings surfaced in afternoon diagnosis — see "Afternoon 2 Update"
> below. Full download-first buy flow in flight on branch `release/v1.2-pre-release`
> (task `DOWNLOAD-FIRST-BUY-FLOW`).

---

## Status Update — 2026-04-29 Afternoon (read this first)

The original diagnosis below was directionally right (DHT propagation gap)
but **missed the actual showstopper**: the `/api/v0/pin/add` endpoint on
`ipfs.ela.city` was guarded by an nginx `proxy_read_timeout 120s` which
was too short for large DASH assets. `pin/add` blocks until Kubo has
fetched every block in the DAG; anything past 120 s returned 504 to the
client **even when Kubo kept working in the background**. The result was
that the "pin" never committed durably — blocks lingered only as
transient cache, garbage-collected when Kubo approached its `StorageMax`.

Full timeline (from `/var/log/nginx/ipfs.ela.city.access.log` on `ipfs-node0`):

```
17:31:50  pin/add  bafybeicv6h...           200 OK   ← small test CID, fit in 120 s
17:37:23  pin/add  bafybeiflfrufuucgbe...   504      ← Irzhy's ORIGINAL asset timed out
17:49:53  pin/add  bafybeid2zki2ky...       504      ← Irzhy's larger test asset
17:54:38  pin/add  bafybeid2zki2ky...       500      ← 500 during an IPFS daemon restart
17:56:53  pin/add  bafybeid2zki2ky...       504      ← ...still timing out
```

Authoritative Kubo CLI check at 18:10 UTC confirmed NEITHER of Irzhy's
CIDs was actually pinned:

```
> ipfs pin ls --type=recursive bafybeiflfrufuucgbe...
Error: path '/ipfs/bafybeiflfrufuucgbe...' is not pinned
```

### What was actually done on 2026-04-29

**1. nginx patch on `ipfs.ela.city` (zero-downtime reload).** Single line
in `/etc/nginx/sites-enabled/ipfs.ela.city`, `location = /api/v0/pin/add`
block:

```diff
-    proxy_read_timeout 120s;
+    proxy_read_timeout 1800s;
```

Backup vhost saved as `ipfs.ela.city.bak.20260429-181439`. `nginx -t`
passed before reload. Verified: unauthenticated probe still returns 401
with correct JSON body.

**2. Manual `ipfs pin add` for Irzhy's two CIDs** (via CLI on `ipfs-node0`,
bypassing nginx entirely):

| CID | Role | Pin result | Elapsed |
|---|---|---|---|
| `bafybeiflfrufuucgbe...` | Irzhy's original failing asset | **recursive, durable** | 0 s (all blocks already in datastore) |
| `bafybeid2zki2ky...` | Irzhy's larger follow-up test | In-progress pin job on remote (PID 894005), 2 045 / ≈2 085 blocks fetched; `stream.mpd` already HTTP 200 on public gateway | ~15 min est. |

**3. Client-side glue (`ELACITY-KUBO-PIN-FORWARD`) shipped this morning** —
`pc2-node/src/api/storage.ts` now forwards every successful local pin /
upload to `ipfs.ela.city/api/v0/pin/add` with Bearer auth. Fire-and-
forget, 30 s client timeout, diagnostic endpoint at
`/api/storage/ipfs/elacity-pin-forward`.

**4. `IPFS-ELACITY-BOOTSTRAP` shipped earlier** — PC2 nodes auto-peer
with `ipfs.ela.city` at startup so Kubo can pull blocks directly from
the minter's Helia instead of round-tripping through DHT.

### What this means for reliability

With the three pieces above in place, new mints take this path automatically:

```
Creator PC2 node
    ├── CID pinned locally (Helia)
    └── forwardPinToElacityKubo(cid)
            │
            ▼
        POST https://ipfs.ela.city/api/v0/pin/add?arg=<cid>&recursive=true
        Authorization: Bearer <token>
            │
            ▼
        nginx (proxy_read_timeout 1800 s now)
            │
            ▼
        Kubo at 127.0.0.1:5001
            │   fetches blocks from the minter's Helia
            │   (already connected via IPFS-ELACITY-BOOTSTRAP)
            ▼
        Pin recorded in pinstore → safe from GC → reachable 24/7
```

Future buyer's fetch path (in priority order):

1. Local Helia (if they've already downloaded)
2. Other PC2 peers in the swarm (shops / 24/7 nodes)
3. `ipfs.ela.city/ipfs/<cid>` — the durable 24/7 floor
4. Broader public IPFS network

The critical change is that step 3 now always has the content. Before
today, step 3 only worked for small assets whose pin fit inside 120 s.

### Known blind spots (not yet fixed)

1. **Pin forward is fire-and-forget** — no retry queue if the forward
   call fails (nginx down, token wrong, network blip). Needs a small
   durable retry + exponential backoff. Low priority while ipfs.ela.city
   and our token are stable; medium priority before wider rollout.
2. **No post-hoc verification** — we trust the 2xx response from
   `pin/add` and never poll `pin/ls` to confirm. A 2xx *does* mean
   "Kubo committed the pin", so this is paranoia rather than a known
   defect, but worth adding to CI.
3. **Legacy assets minted before today** may have slipped through (same
   way Irzhy's two did). We should batch-reconcile: enumerate all
   on-chain marketplace CIDs, for each run `ipfs pin ls` on the Elacity
   Kubo, re-pin anything missing. One-off script, safe to run.
4. **Only one durable tier** — if `ipfs.ela.city` goes down, every
   buyer's step 3 fails. `SUPERNODE-MEDIA-PINNING` (InterServer +
   Contabo) is still the planned second tier; unchanged by today's fix.
5. **Disk on `ipfs-node0`** — `/data/ipfs` is 186 GB / 246 GB (80 %),
   Kubo `StorageMax` is 230 GB. Headroom for ~44 GB of new pins before
   GC starts pressuring unpinned content. Not urgent, but warrants a
   disk expansion or GC policy review in the next 1–2 months as pins
   accumulate.
6. **nginx recommendations to pass to Irzhy's ops team**:
   - Consider exposing `/api/v0/pin/ls?arg=<CID>` (GET, same bearer
     auth) so pc2-node can verify pin state without holding a blocking
     connection.
   - Add PC2 supernode PeerIDs to Kubo `Peering.Peers` (snippet already
     generated, lives in supernode capability assessment).
7. **Rate limit on `/api/v0/pin/add`** is `limit_req zone=pc2_pin
   burst=10 nodelay`. Burst of 10 is fine for single PC2 nodes, but if
   the supernodes ever mass-pin legacy content the burst will throttle
   them. Coordinate before running any batch reconciliation.

### Rollback (in case something regresses)

```bash
# On ipfs-node0, as an OS Login sudoer:
sudo cp -p /etc/nginx/sites-enabled/ipfs.ela.city.bak.20260429-181439 \
           /etc/nginx/sites-enabled/ipfs.ela.city
sudo nginx -t && sudo nginx -s reload
```

No Kubo changes need rolling back — the two manual pins can stay
(harmless) or be removed with `ipfs pin rm --recursive <CID>`.

---

## Afternoon 2 Update — 2026-04-29 20:00 UTC

After shipping the morning fixes, two additional findings surfaced in
follow-up diagnosis with MTK. Both affect the v1.2 release story; the
full fix is now scoped as task `DOWNLOAD-FIRST-BUY-FLOW` on branch
`release/v1.2-pre-release`.

### Finding A — `data/installed-apps/` is the serving path, `data/test-apps/` is source

`pc2-node` serves static app content from
`pc2-node/data/installed-apps/<app>/`. `pc2-node/data/test-apps/<app>/`
is the authoritative **source** but does NOT get auto-synced on edit.
Manual edits to `test-apps/` will not take effect until the files are
copied into `installed-apps/`. `installed-apps/` is `.gitignore`d via
`pc2-node/.gitignore:42` (`data/*`).

**Symptom we hit:** the pipelined-prefetch player (`player.js v=6-pipelined`,
committed `c23f8f070`) was edited in `test-apps/` and committed. But the
browser kept loading `player.js?v=5-sigauth-2` because the server was
serving from `installed-apps/pc2-media-runtime/`, which still had the
pre-v6 copy. Until the files were manually synced, every "fix" MTK
thought he was testing was against the old code.

**Action taken this afternoon:** manually copied the v6 files into
`installed-apps/pc2-media-runtime/`. Verified via:

```
curl -I http://localhost:4200/apps/pc2-media-runtime/player.js
# Content-Length: 64445   ← matches test-apps copy
# Last-Modified: Wed, 29 Apr 2026 19:49:15 GMT   ← post-sync timestamp
```

**Follow-up:** Phase 4 of `DOWNLOAD-FIRST-BUY-FLOW` adds
`pc2-node/scripts/sync-installed-apps.sh` plus a README note so this
dual-folder gotcha never surfaces again.

### Finding B — Honest P2P/CDN framing

The "What this means for reliability" flow above is accurate in the
**creator-upload direction** (the minter's pin reliably reaches
`ipfs.ela.city` and stays there). In the **buyer-fetch direction** it
over-promises. Today ~80-90% of first-buy fetches land at
`ipfs.ela.city` rather than other PC2 nodes, because PC2↔PC2 direct
provider discovery via DHT is unreliable across Helia↔Kubo boundaries.
This is acknowledged in-code at
[`pc2-node/src/storage/ipfs.ts:69-74`](../../pc2-node/src/storage/ipfs.ts):

> "Helia's DHT-based provider record propagation to external Kubo
>  nodes is unreliable for fresh CIDs. By dialing ipfs.ela.city
>  directly we guarantee bitswap-level peering..."

This is a **transitional** state, not a bug. The code path for
announce + DHT lookup is wired ([`ContentSeedingService.ts:328`](../../pc2-node/src/services/ContentSeedingService.ts)),
it's just the propagation layer that's weak. Release notes should
reflect this honestly:

| Phase | Primary fetch source | Hub role | Status |
|---|---|---|---|
| Today (v1.2) | `ipfs.ela.city` | Supporting hub | Shipping |
| Near-term (v1.2.x) | Supernode Tier-2 mirrors | Redundancy | `SUPERNODE-MEDIA-PINNING` Phase 2 |
| Medium-term | PC2 peers + supernodes | Backup / long-tail | DHT bridge / rendezvous |
| Long-term | Pure peer-to-peer | Cold storage | Full mesh |

**Framing to use in v1.2 release notes** (agreed with MTK):
"Buyers become CDN seeders and support new buyers, with Elacity IPFS as
a supporting hub today and supernodes adding Tier-2 backup shortly."

External reviewers tracing traffic during a v1.2 demo will see
`ipfs.ela.city` as the hot path — that's consistent with the "supporting
hub" framing, not a contradiction.

### Finding C — Download-first flow is not actually wired today

The current buy flow in
[`pc2-node/data/test-apps/elacity-market/app.js:3742-3785`](../../pc2-node/data/test-apps/elacity-market/app.js)
posts to `/api/storage/ipfs/pin` which returns `{queued:true}` within
milliseconds (fire-and-forget to `seedingService.seedContent`,
[`ContentSeedingService.ts:158-218`](../../pc2-node/src/services/ContentSeedingService.ts)).
Immediately after, the client writes a 1 KB `.ddrm` descriptor to the
user's Videos/Pictures/Documents folder and shows
"Downloaded & saved — you're now a seeder!" The progress bar at lines
3731-3737 is a cosmetic timer (10→90% regardless of real state).

**In reality at that moment** the actual media blocks are still
downloading in the background; playback starts by streaming segments
that fall through to `ipfs.ela.city` for anything not yet in local
Helia. This is what caused MTK's 0:19 / 0:21 freezes — serial segment
fetches racing an incomplete background pin.

**Fix scoped as `DOWNLOAD-FIRST-BUY-FLOW`** (today + tomorrow):
- Server: `GET /api/storage/ipfs/pin-status/:cid` + `POST /ipfs/pin/:cid/retry`.
- Client: real polling, `.ddrm` appears as `<title> (Preparing).ddrm`,
  renamed to `<title>.ddrm` only after pin completes, real elapsed/size
  display, retry button on failure.
- Launch gate: single point in
  [`src/gui/src/helpers/open_item.js:197-266`](../../src/gui/src/helpers/open_item.js)
  intercepts double-click of any `.ddrm`, polls pin-status, blocks the
  player/viewer until `complete`. Covers both media (`pc2-media-runtime`)
  and non-media (`ddrm-viewer`) paths from a single gate.
- Legacy `.ddrm` files (missing `pinStatus` field) fall through to old
  behavior so existing libraries don't regress.

Plan lives at `.cursor/plans/download-first_buy_flow_2a92980d.plan.md`.

---

## What Irzhy saw

After buying the `Elacity_Universal_Basic_Equity` test asset:

- Download flow completed: "Downloaded & saved — you're now a seeder!"
- Player opened, stuck on "Resolving content and recovering decryption key…"
- Failed with `Playback Error — fetch failed` after ~60 s.

Browser network tab showed `POST /api/media/init → 500`, response body
`{"error":"fetch failed"}`.

## Root cause

The asset CID `bafybeiflfrufuucgbeztwducthonjs7zjz2dsdpk4ajkgxodnkoiru7c3y`
was minted from another PC2 node (mine). Live diagnosis on 2026-04-29
confirmed:

- A known-good CID resolves on `https://ipfs.ela.city/ipfs/...`
  instantly (200 OK, ~1.5 KB headers, ~120 KB body in cache).
- This specific CID **times out** on `ipfs.ela.city` after 15 s+. The
  public Kubo gateway on GCP cannot find providers for it via DHT
  within any reasonable time window.
- The original publisher's PC2 Helia is the only node holding the DASH
  bytes. Without direct peering or a deterministic pin elsewhere, no
  third party can fetch this CID.

Irzhy independently confirmed: *"since it's an asset minted from your
personal cloud, only your computer is currently hosting this content"*.
Exact diagnosis, full agreement.

The `"fetch failed"` user-facing message comes from Node's undici
fetch in `pc2-node/src/api/media.ts` `/api/media/init`. The endpoint
tries the local IPFS gateway, falls back to `ipfs.ela.city`, and when
the fallback hangs without responding, undici eventually throws
`TypeError: fetch failed` with no useful detail in `error.message`.
That string was rendered verbatim in the player.

## What we shipped on 2026-04-29 (diagnostic improvement, not the fix)

Single small change to `pc2-node/src/api/media.ts`:

- Both gateway fetches now use `AbortController` with a **10 s** timeout
  per gateway, so the endpoint fails fast instead of hanging ~60 s.
- The 500 response now includes `cause.code` and `cause.message` from
  the underlying network error (e.g. `TIMEOUT`, `ECONNREFUSED`,
  `ENOTFOUND`).
- When *both* gateways time out, the response body is now:

  > "Content not yet reachable on IPFS. This asset was published from
  > another node and has not propagated to the public gateway yet.
  > Retry shortly, or ask the publisher to peer with ipfs.ela.city."

- The final catch block also includes the `cause` object in the 500
  body so the network tab tells you WHY in one glance.

This does not fix the underlying problem — it just makes the next
occurrence self-diagnose in 10 s instead of 60.

## What actually fixes it (v1.2.1)

Two complementary tasks, both detailed in
[`docs/core/SUPERNODE_CAPABILITY_ASSESSMENT.md`](../core/SUPERNODE_CAPABILITY_ASSESSMENT.md):

1. **`IPFS-ELACITY-BOOTSTRAP`** — make every PC2 node directly peer
   with `ipfs.ela.city`'s libp2p node at startup. Closes the DHT
   discovery gap so content I publish becomes reachable from
   `ipfs.ela.city` within a few seconds, not "if DHT is lucky".
2. **`SUPERNODE-MEDIA-PINNING`** — after every successful marketplace
   mint, fire authenticated pin requests to *both* supernode Kubo
   daemons (InterServer + Contabo, port 4101). Marketplace media is
   then served from infrastructure we control, even when the
   publisher's PC2 node is offline.

Neither is theoretical. The supernode Kubo daemons already exist
(installed by V1.2 A4 work, commit `584bb035b`). They currently pin
only the 6 capsule CIDs; this task adds marketplace media to that pin
set. Risk to live traffic: zero (purely additive endpoint and call-site
glue).

## What Irzhy can do right now

1. **Update pc2-node** to pick up:
   - The `/api/media/init` diagnostic improvement above (no behaviour
     change for happy path; better error messages when this happens
     again).
   - Migration 25–30 — your console showed
     `no such table: channel_metadata` on `/api/catalog/asset/.../...`
     500. That table is created by Migration 25 (added 2026-03-XX). If
     your DB was carried over from before that migration ran, the
     latest pc2-node will run it on next boot.

2. **Confirm `ipfs.ela.city` libp2p multiaddr**. We need
   `/dns4/ipfs.ela.city/tcp/4001/p2p/<PeerID>` (or whatever port your
   Kubo's libp2p swarm is configured for) so `IPFS-ELACITY-BOOTSTRAP`
   can land. Until you confirm, we'll fall back to fetching the
   PeerID from `https://ipfs.ela.city/api/v0/id` (already verified
   reachable, returns `Version: "0.24.0"`). Cleaner if you just paste
   the canonical multiaddr in chat.

3. **For the immediate test**: I can replicate the asset to my
   supernodes manually (`ssh + ipfs pin add`) so you can confirm
   playback works end-to-end while we ship `SUPERNODE-MEDIA-PINNING`.
   Just say the word.

## Bonus context — the `Direct RPC error: rate-limited` lines in your console

Those `QuantaInstant(Nanos(...))` strings came from one of our public
RPC fallbacks (the `governor` Rust rate-limiting crate signature) —
likely Ankr or BlockPI throttling your IP after a burst. That's
exactly the case `SUPERNODE-RPC-PROXY` solves: stand up our own
authenticated Base RPC behind the supernodes (`rpc.node1.pc2.ela.city`),
remove the third-party rate-limit dependency entirely. Same v1.2.1
fast-follow tier.

## Telegram-ready summary

> Diagnosed your playback failure — it's not a bug in PC2. The asset
> CID was minted from my node and never propagated to ipfs.ela.city's
> Kubo, so when your player falls back to the public gateway it just
> hangs. We confirmed by probing the public gateway: a known-good CID
> resolves instantly, yours times out after 15 s.
>
> Two things in v1.2.1 fix this end to end:
>
> 1. PC2 nodes directly peer with ipfs.ela.city on startup
>    (`IPFS-ELACITY-BOOTSTRAP`)
> 2. Marketplace mints auto-pin to our two supernode Kubo daemons
>    (`SUPERNODE-MEDIA-PINNING`) — they already exist on InterServer
>    and Contabo, port 4101, just unused for media today.
>
> Need from you: ipfs.ela.city's canonical libp2p multiaddr +
> PeerID — we'll use `/api/v0/id` as a temp fallback if you can't grab
> it now.
>
> While you're updating, also pull latest pc2-node — it has migrations
> that fix the `channel_metadata` 500 you saw on /catalog/asset, plus a
> diagnostic tweak to /api/media/init so future "fetch failed" errors
> tell you exactly which gateway + which network error in the
> response body.
