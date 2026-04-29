# Handover: Irzhy's Playback Failure (2026-04-28)

> **Audience**: Irzhy + anyone reproducing the same `"Playback Error — fetch failed"`
> **Status**: Diagnosed. No code bug in the playback path itself; the failure
> is upstream IPFS propagation. Mitigation in v1.2.1.

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
