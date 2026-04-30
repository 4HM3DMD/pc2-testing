import { describe, it, expect } from 'vitest';
import {
  parseLicensePayload,
  selectDrmSystem,
  getPsshData,
} from '../src/crypto/payload.js';
import { DRM_SYSTEM_IDS } from '../src/constants.js';

describe('parseLicensePayload', () => {
  it('extracts key IDs from payload', () => {
    const result = parseLicensePayload({
      kids: ['aabbccdd', '11223344'],
      format: 'hex',
      type: 'temporary',
    });
    expect(result.keyIds).toEqual(['aabbccdd', '11223344']);
  });

  it('returns empty array when kids is missing', () => {
    const result = parseLicensePayload({
      kids: undefined as unknown as string[],
      format: 'hex',
      type: 'temporary',
    });
    expect(result.keyIds).toEqual([]);
  });

  it('detects temporary license type', () => {
    const result = parseLicensePayload({
      kids: [],
      format: 'hex',
      type: 'temporary',
    });
    expect(result.isTemporary).toBe(true);
  });

  it('detects non-temporary license type', () => {
    const result = parseLicensePayload({
      kids: [],
      format: 'hex',
      type: 'persistent',
    });
    expect(result.isTemporary).toBe(false);
  });
});

describe('selectDrmSystem', () => {
  const litSaId = DRM_SYSTEM_IDS['cenc:lit-drm-sa-v1'];
  const litV1Id = DRM_SYSTEM_IDS['cenc:lit-drm-v1'];
  const web3Id = DRM_SYSTEM_IDS['cenc:web3-drm-v1'];

  it('selects the lowest-priority enabled system', () => {
    const refs: Record<string, Uint8Array> = {
      [litSaId]: new Uint8Array([1]),
      [litV1Id]: new Uint8Array([2]),
    };
    const result = selectDrmSystem(refs);
    expect(result).toBe('cenc:lit-drm-sa-v1');
  });

  it('skips disabled systems', () => {
    const refs: Record<string, Uint8Array> = {
      [web3Id]: new Uint8Array([1]),
      [litV1Id]: new Uint8Array([2]),
    };
    const result = selectDrmSystem(refs);
    expect(result).toBe('cenc:lit-drm-v1');
  });

  it('returns null when no enabled systems match', () => {
    const refs: Record<string, Uint8Array> = {
      [web3Id]: new Uint8Array([1]),
    };
    const result = selectDrmSystem(refs);
    expect(result).toBeNull();
  });

  it('returns null for empty refs', () => {
    const result = selectDrmSystem({});
    expect(result).toBeNull();
  });

  it('returns null for unknown ref IDs', () => {
    const refs: Record<string, Uint8Array> = {
      'unknownSystemId==': new Uint8Array([1]),
    };
    const result = selectDrmSystem(refs);
    expect(result).toBeNull();
  });

  it('respects custom priority overrides', () => {
    const refs: Record<string, Uint8Array> = {
      [litSaId]: new Uint8Array([1]),
      [litV1Id]: new Uint8Array([2]),
    };
    const result = selectDrmSystem(refs, {
      'cenc:lit-drm-v1': { priority: -1 },
    });
    expect(result).toBe('cenc:lit-drm-v1');
  });

  it('can enable a disabled system via overrides', () => {
    const refs: Record<string, Uint8Array> = {
      [web3Id]: new Uint8Array([1]),
    };
    const result = selectDrmSystem(refs, {
      'cenc:web3-drm-v1': { priority: 0, disabled: false },
    });
    expect(result).toBe('cenc:web3-drm-v1');
  });
});

describe('getPsshData', () => {
  it('returns PSSH data for a known DRM system', () => {
    const litSaId = DRM_SYSTEM_IDS['cenc:lit-drm-sa-v1'];
    const data = new Uint8Array([10, 20, 30]);
    const refs: Record<string, Uint8Array> = {
      [litSaId]: data,
    };
    const result = getPsshData(refs, 'cenc:lit-drm-sa-v1');
    expect(result).toBe(data);
  });

  it('returns null when DRM system not in refs', () => {
    const result = getPsshData({}, 'cenc:lit-drm-v1');
    expect(result).toBeNull();
  });

  it('returns null for unknown DRM system type', () => {
    const result = getPsshData({}, 'unknown' as never);
    expect(result).toBeNull();
  });
});
