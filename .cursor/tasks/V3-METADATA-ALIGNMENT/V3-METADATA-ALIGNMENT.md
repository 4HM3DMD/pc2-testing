# Task: Align PC2 with Elacity V3 Metadata Protocol

**Task ID**: V3-METADATA-ALIGNMENT
**Created**: 2026-04-17
**Status**: **Blocked** — awaiting V3 metadata specification from the
Elacity team member
**Priority**: P1 — High (required for V1.2 parity with Elacity
frontend; blocks asset-flag features like `allowAITraining`)
**Target Release**: V1.2 (end of April 2026)
**Depends on**: Elacity V3 metadata specification document

## Description

The Elacity frontend has moved to a V3 metadata protocol that defines
four distinct metadata categories. PC2's Creator app and sync indexer
still use the V1/V2 shape. This task aligns both.

The four V3 categories (as stated on the 2026-04-17 team call — full
spec pending):

1. **Channel metadata** — channel-level descriptive fields.
2. **Token-related metadata** — per-token info including royalty
   shares and per-token traits.
3. **Plans metadata** — subscription / access-plan configuration.
4. **Asset metadata** — including the new asset flags
   (e.g., `allowAITraining: boolean`, and presumably others we'll
   learn from the spec).

Until the spec lands, this task captures the intent and surfaces the
touch points so implementation can start the same hour the document
arrives.

## Background

- Elacity's frontend already supports V3 — confirmed on call.
- PC2's current metadata construction (see
  `pc2-node/data/test-apps/elacity-creator/app.js` — `buildMetadata`
  path and metadata-directory upload) emits V1-style fields that
  Elacity's backend is back-compatible with but that don't surface
  new flags like `allowAITraining`.
- The sync indexer (internal to pc2-node) currently reads the V1/V2
  shape when pulling channel/asset metadata back for local display.
  It needs to understand V3 to avoid blanking fields on re-sync of
  V3-minted content.

## Why it's blocked

Without the specification we risk:

- Implementing the wrong field names and having to rename later.
- Diverging subtly from Elacity's expectation (e.g., wrong casing,
  wrong nesting, wrong encoding of booleans) and silently breaking
  marketplace indexing.
- Spending effort on fields that are already being re-shaped.

The correct sequence is: **receive spec → compare with current
implementation → write migration plan → implement**. This file
exists to hold all the known touch points so "implement" is a
same-day job once the spec arrives.

## Requirements (will firm up once spec arrives)

- [ ] PC2 Creator emits V3-shaped metadata by default for new mints.
- [ ] PC2 sync indexer reads V3 metadata when resolving channels
      and assets.
- [ ] `allowAITraining` and any other new asset flags are exposed in
      Creator UI and forwarded into the asset metadata.
- [ ] Backwards-compatible reader for V1/V2 metadata already in the
      wild (don't break existing channels on re-sync).
- [ ] Round-trip test: mint via PC2 Creator → read via PC2 sync
      indexer → confirm every V3 field survives.

## Implementation Plan (skeleton)

Unchecked items pending spec. Numbered to show sequence.

1. [ ] **Receive V3 spec** from Elacity team member. Save in
       `docs/wiki/Technical/V3_METADATA_SPEC.md` (or link if upstream
       has a canonical URL).
2. [ ] **Diff current-vs-spec**: produce a gap list — field-by-field,
       flag-by-flag. Save in `docs/wiki/Technical/V3_METADATA_DIFF.md`.
3. [ ] **Types**: add `V3ChannelMeta`, `V3TokenMeta`, `V3PlanMeta`,
       `V3AssetMeta` interfaces in `pc2-node/src/types/elacity.ts`
       (or new module). Keep V1/V2 types for the read path.
4. [ ] **Creator write path** (`elacity-creator/app.js`): emit V3
       shapes. Gate behind a `METADATA_VERSION` config (default `v3`)
       so we can roll back without code changes.
5. [ ] **Sync indexer read path**: detect V3 vs V1/V2 by presence of
       the version tag (or a specific V3 field) and branch.
6. [ ] **Asset flag plumbing**: add `allowAITraining` (and peers) to
       the Creator UI (form field) and to the metadata builder.
7. [ ] **Docs**:
       - `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` Section 3
         (metadata directory structure) — rewrite for V3.
       - `docs/wiki/Technical/V3_METADATA_SPEC.md` — source of truth.
8. [ ] **Tests**:
       - Round-trip mint / indexer read for channel + paid asset +
         free asset + asset with `allowAITraining: true`.
       - Back-compat: sync indexer still reads a captured V1 example
         blob without regression.

## Acceptance Criteria

- [ ] A sovereign node operator can mint a channel, an asset with
      royalty splits, and an access plan using V3 metadata from the
      PC2 Creator app, and see it appear correctly on Elacity's
      marketplace listing (field-equivalent to Elacity-native mints).
- [ ] `allowAITraining` flag round-trips from Creator form ↔ on-chain
      metadata pointer ↔ PC2 sync indexer ↔ display.
- [ ] Sync of a V1/V2 channel still works — no regression.
- [ ] Unit + integration tests green.

## Files to Modify (preliminary)

- `pc2-node/data/test-apps/elacity-creator/app.js` — metadata builder.
- `pc2-node/src/api/storage.ts` — any metadata-directory helper.
- `pc2-node/src/services/sync/*` — indexer read path. (Exact files
  to be listed once we walk the sync module against the spec.)
- `pc2-node/src/types/elacity.ts` — new type file.
- `docs/wiki/Technical/ELACITY_DDRM_INTEGRATION.md` — Section 3.

## Files to Create (preliminary)

- `docs/wiki/Technical/V3_METADATA_SPEC.md` — copy of spec.
- `docs/wiki/Technical/V3_METADATA_DIFF.md` — gap analysis output.

## Testing Strategy

1. Read a V3 mint made by Elacity's own frontend (get a reference
   channel CID from the team member) and confirm PC2 sync indexer
   returns every expected field.
2. Mint via PC2 Creator, read back via Elacity's own frontend,
   confirm parity.
3. Round-trip `allowAITraining: true` end-to-end.
4. Capture a V1 channel CID from historical data, confirm read-back
   is unchanged.

## Notes

- Blocker: **need the V3 spec**. Without it, any implementation is
  speculation.
- Suggested coordination message to the Elacity team member:
  > "Can you share the V3 metadata spec (or link to the type
  > definitions in your frontend)? We've got a task file ready to
  > implement it as soon as we have the field shapes."
- Source of feedback: V1.2 pre-release team call 2026-04-17.
- This is the only one of the three post-call tasks that we
  **shouldn't** start today. The other two
  (`LIT-ACTION-SIGNATURE-AUTH`, `IPFS-ELACITY-BOOTSTRAP`) can
  progress in parallel while we wait.
