# Sovereign Content Indexing — Scaling Model

**Last updated**: April 2026 (PC2 v1.2)
**Applies to**: PC2 ContentIndexerService + Elacity Creator/Market apps

---

## The question

> Does PC2's content catalog scale to thousands (eventually millions) of sovereign
> nodes, each independently creating V3 channels and minting assets on Base?

**Answer**: Yes. The system is designed around the principle that **each sovereign node
scans Base independently and maintains its own local catalog**. No central server
is required for channel discovery, asset listing, or ownership verification.

---

## Architecture at a glance

```
Base mainnet
     │
     │  V3 Channel Factory  ──emits──▶  ChannelCreated(channelType, scope, creator, channel, factory)
     │  Channel contracts   ──emits──▶  AssetCreated(to, channel, tokenId, tokenURI, opType, opContract)
     │  Legacy storage      ──emits──▶  DigitalAssetRegistered(...)  (v1/v2 compat)
     ▼
┌────────────────────────────────────────────────────────────────────┐
│  Each PC2 node runs ContentIndexerService                          │
│  ─────────────────────────────────────────                         │
│  • scan_interval_minutes: 5 (configurable)                         │
│  • max_blocks_per_scan: 10000                                      │
│  • Incremental: persists indexer_last_block_${version}             │
│  • RPC failover: rotates across rpc_urls on error                  │
└────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────────┐
│  Local SQLite (pc2.db)                                             │
│  ───────────────────                                               │
│  channel_metadata:  one row per discovered V3 channel              │
│                     (address, creator, block, name, plans, ...)    │
│  content_catalog:   one row per minted asset                       │
│                     (channel_address, token_id, name, cid, ...)    │
└────────────────────────────────────────────────────────────────────┘
     │
     ▼
  API: GET  /api/catalog/channels[?creator=0x…]
       GET  /api/catalog/assets
       POST /api/catalog/reindex   ← out-of-band trigger after user actions
```

---

## What scales natively

| Concern | Why it's fine |
|---|---|
| **Channel count (→ 1M+)** | `channel_metadata` is a SQLite table with `idx_channel_metadata_creator`. Filter by creator is indexed, O(log N). |
| **Asset count (→ 10M+)** | `content_catalog` has 6 indexes incl. `idx_content_catalog_creator` and `idx_content_catalog_channel`. |
| **Block history** | Indexer is **incremental** — persists `indexer_last_block_${version}` per contract version. Each scan only fetches new blocks since the previous run, not the whole chain. |
| **Node restart** | Picks up from the last persisted block. No rescanning. |
| **Failure recovery** | `indexer_last_block` advances only after successful scan of that range. Failure mid-scan leaves the setting unchanged → retried on next cycle. |
| **RPC rate limits** | `baseRpcCall` util does failover across `rpc_urls` on any error. Elacity operates its own Base RPC on Contabo; users can configure additional endpoints. |

---

## Discovery flow — user-centric timeline

1. **User creates a channel** in Elacity Creator
   → `createChannel()` tx sent to V3 Channel Factory
   → `ChannelCreated` event emitted
   → Creator app calls `POST /api/catalog/reindex` ← **immediate**
   → Indexer scans latest blocks, finds the event, inserts into `channel_metadata`
   → Channel appears in dropdown **in seconds**, not 5 minutes

2. **User mints an asset** into the channel
   → `createAsset()` tx sent
   → `AssetCreated` event emitted
   → Creator app calls `POST /api/catalog/reindex`
   → Indexer picks up the event, inserts into `content_catalog`
   → Asset appears in Elacity Market **in seconds**

3. **User opens Creator/Market later**
   → Background 5-minute scan has already caught up with everything
   → `GET /api/catalog/channels?creator=<wallet>` returns their channels instantly from SQLite

4. **New PC2 node spins up** (fresh install)
   → Migrations run (v28 extends `channel_metadata`)
   → First scan cycle runs a **one-shot ChannelCreated backfill** from `fromBlock`
   → Subsequent cycles are purely incremental
   → `indexer_channels_backfilled_v3 = 1` persists so backfill never reruns

---

## Name resolution — the N+1 guard

The V3 `ChannelCreated` event does **not** include the channel name (gas cost). We
resolve names lazily via `eth_call name()` on the channel contract and cache them
in `channel_metadata.name`. This is capped at **25 unresolved per request** in
`/api/catalog/channels`, so even with 1M indexed channels:

- First request with `?creator=<wallet>` resolves only the names for that user's
  channels (typically 1–10).
- Market app requesting all channels gets progressive name population across
  requests instead of a single 1M-RPC-call stampede.
- Once resolved, names are persisted and all subsequent reads are free.

This keeps the API endpoint O(1) in the common case and bounded in the cold-cache
case.

---

## RPC strategy for V1.2 → future

**Now (V1.2)**: Each node calls Base RPC directly. Public endpoints or Elacity's
Contabo Base node (self-hosted) work fine. For the few hundred nodes expected at
V1.2 launch, existing RPC capacity is sufficient.

**Medium term (tens of thousands of nodes)**: Configure nodes to prefer their own
regional Base node or a provider like Alchemy/QuickNode. The `rpc_urls` array in
`content_indexer` config supports failover across multiple endpoints.

**Long term (Elastos runtime convergence)**: Indexing moves into an ESC/Base node
capsule called over Carrier (Anders's roadmap). Puter acts as the UI layer; the
blockchain node capsule handles RPC and event indexing. PC2 is already compatible
with this model — the `ContentIndexerService` is a contained, RPC-only component.

---

## Pressure points — known limits & mitigations

| Limit | When it bites | Mitigation |
|---|---|---|
| `eth_getLogs` range size | Some RPCs cap at 10k blocks per request | `max_blocks_per_scan: 10000` is already at safe limit; scanner chunks automatically |
| Public RPC rate limit | >10k nodes hitting same public endpoint | Operator-configured `rpc_urls` with failover; self-hosted node recommended |
| SQLite write contention | Very high-frequency concurrent writes | `better-sqlite3` uses WAL mode; indexer writes are bulk-batched per scan cycle |
| Initial backfill duration | Chain with 10M+ blocks since fromBlock | Only runs once per install; subsequent startups use incremental cursor |
| Name resolution stampede | First load of catalog with 1M unresolved | Capped at 25/request; spreads across user sessions |

---

## Verifying scale readiness

```bash
# Health check
curl http://localhost:4200/api/catalog/stats

# Per-user channel lookup (should be sub-50ms regardless of catalog size)
curl 'http://localhost:4200/api/catalog/channels?creator=0x34daf...'

# Trigger immediate catch-up (safe to call anytime — guarded against overlap)
curl -X POST http://localhost:4200/api/catalog/reindex
```

In SQLite:

```sql
-- How many channels indexed
SELECT COUNT(*) FROM channel_metadata WHERE creator_address IS NOT NULL;

-- Indexer progress
SELECT key, value FROM settings WHERE key LIKE 'indexer_%';
-- Expect:
--   indexer_last_block_v3          → current head block
--   indexer_channels_backfilled_v3 → 1
```

---

## What was fixed in V1.2

Before V1.2, the indexer only watched `DigitalAssetRegistered` and `AssetCreated`
events. Channels were implicitly discovered via their first minted asset — so a
user who created a channel but hadn't minted yet saw **no channels** in the
Creator app, and then waited up to 5 minutes after each mint for the catalog to
catch up.

V1.2 changes:

1. **Indexer now scans `ChannelCreated` from the V3 factory** directly, so empty
   channels appear in the catalog.
2. **`channel_metadata` extended** with `creator_address`, `contract_version`,
   `block_number`, `tx_hash`, `indexed_at` (Migration 28).
3. **`getCatalogChannels` rewired** — `channel_metadata` is now the primary source;
   `content_catalog` is LEFT-JOINed for `itemsCount` only.
4. **`POST /api/catalog/reindex`** added so the Creator app can trigger
   out-of-band scans immediately after user actions.
5. **One-shot historical backfill** runs on first startup after upgrade so
   existing installs retroactively pick up old channels.
6. **Name resolution capped** per request to stay O(1) at scale.
