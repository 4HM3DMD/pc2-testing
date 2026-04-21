# Task: Elacity IPFS Upload Endpoint Returning 502 + Extreme Slowness

**Task ID**: ELACITY-IPFS-UPLOAD-502
**Created**: 2026-04-21
**Status**: Proposed (ops investigation)
**Priority**: P1 — High (degrades V1.2 mint UX, masks downstream bugs)
**Target Release**: V1.2 (end of April 2026)
**Owner**: Elacity infra/ops team (NOT a PC2 code change)
**Related**: `.cursor/tasks/CREATOR-THUMBNAIL-FALLBACK/CREATOR-THUMBNAIL-FALLBACK.md`,
`.cursor/tasks/IPFS-ELACITY-BOOTSTRAP/IPFS-ELACITY-BOOTSTRAP.md`

## TL;DR

The Elacity-side IPFS pinning service that backs PC2's
`POST /api/storage/ipfs/upload-elacity` endpoint is currently:

1. **Sometimes returning 502 Bad Gateway** outright.
2. When it does respond, **uploads take 5+ minutes for tiny files**
   (≤1 MB metadata, ≤30 KB thumbnails).

PC2 mostly degrades gracefully (asset + metadata fall back to local CIDs)
but one Creator path silently drops the thumbnail
(see `CREATOR-THUMBNAIL-FALLBACK`).

## Symptoms (captured 2026-04-21)

From browser console during a normal `Purple Rain Cover.mp3` mint:

```
[Creator] Media encoding complete: …
[Creator] Media asset CID from encoder: bafybeib72c4q4iwkmprbhepqlhbdhgvyb7lne6e737r4kasczyjkrtwyd4
[Creator] Using user-selected thumbnail
:4200/api/storage/ipfs/upload-elacity:1  Failed to load resource: 502 (Bad Gateway)
[Creator] Local meta dir CID: bafybeihfdrk6qpzegzimecihcuqxpvrkb7iusssgu3iq73w2k7qyq2dnzi
:4200/api/storage/ipfs/upload-elacity:1  Failed to load resource: 502 (Bad Gateway)
[Creator] Falling back to local directory CID: …
```

User reports the encode/transcode finishes in ~90 s but the IPFS uploads
afterwards take 5+ min when they don't 502 outright. Reproduced repeatedly
across multiple sessions on 2026-04-20 and 2026-04-21.

## Server-side endpoint behaviour

`POST /api/storage/ipfs/upload-elacity` in PC2 acts as a thin proxy: it
takes base64 content from the browser and forwards to whatever Elacity-side
endpoint is configured (typically `https://ipfs.ela.city` or a sibling
service). Need to confirm:

- Which exact Elacity URL is the proxy hitting? (Check `pc2-node` env +
  `pc2-node/src/api/storage.ts` upload handler.)
- Is the 502 coming from Elacity's reverse proxy (nginx? caddy?) or from
  the IPFS daemon itself timing out?
- What's the current node uptime / pin queue depth on Elacity's side?

## Investigation plan (Elacity ops)

1. **Health-check the Elacity IPFS service**:
   - `curl -v https://ipfs.ela.city/api/v0/version`
   - `curl -v https://ipfs.ela.city/api/v0/swarm/peers | head`
   - Reverse-proxy logs for the time window 2026-04-20 18:00 UTC →
     2026-04-21 11:00 UTC.
2. **Check Elacity IPFS daemon logs** for `dial backoff`, `connection
   refused`, `pin queue full`, or repo-GC events.
3. **Check disk usage** on the IPFS node — a full repo causes silent slow
   pins followed by 5xx.
4. **Check pin-queue depth** — if there's a backlog, small uploads will
   queue behind big ones.

## Mitigation options (PC2 side, while ops investigates)

- **Adopt aggressive client-side timeouts** in PC2's
  `upload-elacity` proxy (e.g. 30 s) so the Creator gets a fast 502
  instead of hanging for 5 min, then can fall back faster.
- **Always pre-pin locally** before attempting Elacity (mirrors the
  thumbnail fix). This is implemented in
  `CREATOR-THUMBNAIL-FALLBACK` for the thumbnail and should be applied
  uniformly to the asset and metadata paths too.
- **Ship `IPFS-ELACITY-BOOTSTRAP`** so that even when Elacity hasn't
  pinned our content, Elacity's gateway can find it via direct DHT
  resolution against PC2 in a couple of seconds.

## Acceptance criteria (combined PC2 + Elacity)

- [ ] `curl -X POST https://ipfs.ela.city/...` with a 100-byte payload
      completes in <5 seconds at p99.
- [ ] `POST /api/storage/ipfs/upload-elacity` from PC2 returns 2xx
      consistently for 100 sequential 30 KB uploads.
- [ ] V1.2 mint flow shows thumbnail in player + file manager regardless
      of Elacity IPFS state (this is `CREATOR-THUMBNAIL-FALLBACK`'s
      responsibility, not this task's, but listed so the matrix is clear).
- [ ] Slack/PagerDuty alert added on Elacity IPFS service health
      (separate ops task, listed for tracking).

## Notes

- This is **infra**, not PC2 code. It will likely be resolved by Elacity
  ops independently of any PC2 release. Listed here so that the Creator
  bug (`CREATOR-THUMBNAIL-FALLBACK`) and IPFS bootstrap
  (`IPFS-ELACITY-BOOTSTRAP`) have the right cross-references.
- The PC2-side timeout mitigation can ship in V1.2 even if Elacity ops
  hasn't fixed the backend.
