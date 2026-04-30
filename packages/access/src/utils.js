export function getCryptoApi() {
    if (typeof globalThis.crypto !== 'undefined') {
        return globalThis.crypto;
    }
    throw new Error('WebCrypto API not available in this environment');
}
export function base64ToUint8Array(base64) {
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
export function uint8ArrayToBase64(bytes) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
export function buildSiweMessage(params) {
    const { domain, address, uri, expiration, chainId } = params;
    return [
        `${domain} wants you to sign in with your Ethereum account:`,
        address,
        '',
        'Elacity dDRM access verification',
        '',
        `URI: ${uri}`,
        `Version: 1`,
        `Chain ID: ${chainId}`,
        `Nonce: ${generateNonce()}`,
        `Issued At: ${new Date().toISOString()}`,
        `Expiration Time: ${expiration}`,
    ].join('\n');
}
export function generateNonce() {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    }
    else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
//# sourceMappingURL=utils.js.map