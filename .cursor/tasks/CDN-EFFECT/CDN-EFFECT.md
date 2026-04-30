# Task: Local IPFS Gateway DAG Resolution — Eliminate Elacity CDN Costs

**Task ID**: CDN-EFFECT
**Created**: 2026-03-06
**Status**: Done
**Priority**: High

## Description

Enable PC2 nodes to serve DASH-encrypted media streams from their local Helia IPFS node instead of routing through Elacity's CDN (`ipfs.ela.city`). When a user purchases and pins content, the player should stream from `localhost:4200/ipfs/<rootCID>/stream.mpd` rather than from the remote gateway.

## Background

When a user buys media through the Elacity Market app:
1. The purchase transaction mints an access token on-chain
2. `pinAndRegisterMedia()` calls `POST /api/storage/ipfs/pin` which pins the content CID to the local Helia node
3. A `.edrm` descriptor file is saved with `gateway: 'https://ipfs.ela.city/ipfs/'`
4. The player streams from the remote Elacity CDN

The content IS already pinned locally, but the player can't use it because:
- The local `/ipfs/:cid/:filename?` route only serves flat CID blobs — it cannot resolve paths within a UnixFS DAG directory
- DASH content is stored as a directory: `rootCID/stream.mpd`, `rootCID/video/init.mp4`, `rootCID/video/seg-N.m4s`, etc.
- The `.edrm` descriptor and player both hardcode the remote gateway

## Requirements

1. Add UnixFS DAG path resolution to the local IPFS gateway so `/ipfs/<rootCID>/stream.mpd` and `/ipfs/<rootCID>/video/seg-1.m4s` work
2. Update the `.edrm` descriptor to point to the local gateway
3. Update the player launch to prefer local gateway with fallback to Elacity CDN
4. Proper MIME types for DASH content (`.mpd`, `.m4s`, `.mp4`)
5. Streaming with Range request support for video segments

## Implementation Plan

- [x] Create task document
- [x] Add `resolveDAGPath()` method to `IPFSStorage` (ipfs.ts)
- [x] Add `/ipfs/:cid/*` wildcard route with DAG traversal (public.ts)
- [x] Update `.edrm` gateway to local node and player launch to prefer local gateway
- [x] Build and verify
- [x] NAT traversal (circuit-relay-v2, dcutr, autonat)
- [x] Bitswap-first fetching with DHT provider discovery
- [x] CID announcement + periodic re-announcement
- [x] `pinned_cids` SQLite table (Migration 17)
- [x] In-memory CDN bandwidth tracking + `/api/cdn/stats` endpoint
- [x] Supernode IPFS Relay deployed (69.164.241.210:4003/4004)
- [x] Bootstrap addresses configured in `PC2_SUPERNODE_BOOTSTRAP`

## Acceptance Criteria

- `GET /ipfs/<rootCID>/stream.mpd` returns the DASH manifest from a locally-pinned DAG directory
- `GET /ipfs/<rootCID>/video/seg-1.m4s` returns the video segment with correct MIME type
- Range requests work for video segments (206 Partial Content)
- Player opens and streams from local node when content is pinned
- Falls back to remote CDN if content is not pinned locally

## Files to Modify

- `pc2-node/src/storage/ipfs.ts` — Add DAG path resolution methods
- `pc2-node/src/api/public.ts` — Add wildcard route handler
- `pc2-node/data/test-apps/elacity-market/app.js` — Update gateway in .edrm descriptor
- `src/gui/src/helpers/open_item.js` — Update player launch URL

## Testing Strategy

1. Pin a known Elacity media CID via the Market app
2. Verify `curl localhost:4200/ipfs/<rootCID>/stream.mpd` returns the DASH manifest
3. Open .edrm file from filesystem — player should load from local gateway
4. Verify no requests to ipfs.ela.city when content is pinned locally
