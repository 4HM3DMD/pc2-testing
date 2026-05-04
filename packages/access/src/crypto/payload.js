import { DRM_SYSTEM_IDS } from '../constants.js';
export function parseLicensePayload(payload) {
    return {
        keyIds: payload.kids ?? [],
        isTemporary: payload.type === 'temporary',
    };
}
export function selectDrmSystem(refs, priorities) {
    const defaultPriorities = {
        'cenc:lit-drm-sa-v1': { priority: 0, disabled: false },
        'cenc:lit-drm-v1': { priority: 1, disabled: false },
        'cenc:web3-drm-v1': { priority: 10, disabled: true },
    };
    const merged = { ...defaultPriorities };
    if (priorities) {
        for (const [key, value] of Object.entries(priorities)) {
            const drmKey = key;
            if (merged[drmKey] && value) {
                merged[drmKey] = { ...merged[drmKey], ...value };
            }
        }
    }
    const systemIdToType = new Map();
    for (const [type, id] of Object.entries(DRM_SYSTEM_IDS)) {
        if (type !== 'cenc') {
            systemIdToType.set(id, type);
        }
    }
    const available = [];
    for (const refId of Object.keys(refs)) {
        const drmType = systemIdToType.get(refId);
        if (!drmType)
            continue;
        const config = merged[drmType];
        if (config && !config.disabled) {
            available.push({ type: drmType, priority: config.priority });
        }
    }
    if (available.length === 0)
        return null;
    available.sort((a, b) => a.priority - b.priority);
    return available[0].type;
}
export function getPsshData(refs, drmSystem) {
    const systemId = DRM_SYSTEM_IDS[drmSystem];
    if (!systemId)
        return null;
    return refs[systemId] ?? null;
}
//# sourceMappingURL=payload.js.map