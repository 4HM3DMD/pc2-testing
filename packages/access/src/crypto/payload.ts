/**
 * @elacity-js/access — CENC payload handling
 *
 * Handles PSSH (Protection System Specific Header) payloads from DASH manifests.
 * This is the bridge to @elacity-js/media-player's WASM decoder.
 *
 * The WASM worker extracts PSSH boxes from encrypted DASH init segments,
 * builds a payload with key IDs and DRM system refs, and sends it to the
 * main thread via postMessage(__protocol__acquire_license).
 *
 * This module processes that payload format so the media-player can
 * delegate license acquisition to @elacity-js/access.
 */

import { DRM_SYSTEM_IDS } from '../constants.js';
import type { LicensePayload, DrmSystemType } from '../types.js';

/**
 * Parse a raw PSSH payload from the WASM worker.
 *
 * The payload structure matches what prepare_payload() in player.js produces:
 * {
 *   kids: [...hex key IDs],
 *   format: "hex",
 *   type: "temporary"
 * }
 */
export function parseLicensePayload(payload: LicensePayload): {
  keyIds: string[];
  isTemporary: boolean;
} {
  return {
    keyIds: payload.kids ?? [],
    isTemporary: payload.type === 'temporary',
  };
}

/**
 * Determine which DRM system to use based on available refs and priority.
 *
 * The refs object maps DRM system IDs (base64) to their PSSH data.
 * We select the highest-priority enabled system.
 */
export function selectDrmSystem(
  refs: Record<string, Uint8Array>,
  priorities?: Partial<Record<DrmSystemType, { priority: number; disabled?: boolean }>>
): DrmSystemType | null {
  const defaultPriorities: Record<DrmSystemType, { priority: number; disabled: boolean }> = {
    'cenc:lit-drm-sa-v1': { priority: 0, disabled: false },
    'cenc:lit-drm-v1': { priority: 1, disabled: false },
    'cenc:web3-drm-v1': { priority: 10, disabled: true },
  };

  const merged = { ...defaultPriorities };
  if (priorities) {
    for (const [key, value] of Object.entries(priorities)) {
      const drmKey = key as DrmSystemType;
      if (merged[drmKey] && value) {
        merged[drmKey] = { ...merged[drmKey], ...value };
      }
    }
  }

  const systemIdToType = new Map<string, DrmSystemType>();
  for (const [type, id] of Object.entries(DRM_SYSTEM_IDS)) {
    if (type !== 'cenc') {
      systemIdToType.set(id, type as DrmSystemType);
    }
  }

  const available: Array<{ type: DrmSystemType; priority: number }> = [];

  for (const refId of Object.keys(refs)) {
    const drmType = systemIdToType.get(refId);
    if (!drmType) continue;

    const config = merged[drmType];
    if (config && !config.disabled) {
      available.push({ type: drmType, priority: config.priority });
    }
  }

  if (available.length === 0) return null;

  available.sort((a, b) => a.priority - b.priority);
  return available[0].type;
}

/**
 * Extract the PSSH data for a specific DRM system from refs.
 */
export function getPsshData(
  refs: Record<string, Uint8Array>,
  drmSystem: DrmSystemType
): Uint8Array | null {
  const systemId = DRM_SYSTEM_IDS[drmSystem];
  if (!systemId) return null;
  return refs[systemId] ?? null;
}
