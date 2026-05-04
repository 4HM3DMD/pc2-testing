import { LOCAL_IPFS_GATEWAY, DEFAULT_IPFS_GATEWAY } from '../constants.js';
export async function fetchFromIpfs(cid, options) {
    const primary = options?.gateway ?? LOCAL_IPFS_GATEWAY;
    const fallback = options?.fallbackGateway ?? DEFAULT_IPFS_GATEWAY;
    const timeout = options?.timeout ?? 30_000;
    const cleanCid = cid.startsWith('ipfs://') ? cid.slice(7) : cid;
    try {
        return await fetchWithTimeout(`${primary}${cleanCid}`, timeout);
    }
    catch {
        return await fetchWithTimeout(`${fallback}${cleanCid}`, timeout);
    }
}
async function fetchWithTimeout(url, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
//# sourceMappingURL=ipfs.js.map