import { ethers } from 'ethers';
import { DEFAULT_AUTHORITY_GATEWAY, AUTHORITY_GATEWAY_ABI, ERC1155_ABI, } from '../constants.js';
export async function verifyAccess(provider, params, options) {
    const { ledger, tokenId, wallet } = params;
    const authorityAddr = options?.authorityGateway ?? DEFAULT_AUTHORITY_GATEWAY;
    const holderAddr = wallet ?? options?.signerAddress;
    if (!holderAddr) {
        throw new Error('No wallet address provided for access verification');
    }
    const browserProvider = new ethers.BrowserProvider(provider);
    const gateway = new ethers.Contract(authorityAddr, AUTHORITY_GATEWAY_ABI, browserProvider);
    try {
        const hasAccess = await gateway.hasAccess(holderAddr, ledger, tokenId);
        let tokenBalance = 0n;
        try {
            const ledgerContract = new ethers.Contract(ledger, ERC1155_ABI, browserProvider);
            tokenBalance = await ledgerContract.balanceOf(holderAddr, tokenId);
        }
        catch {
        }
        return {
            hasAccess,
            tokenBalance,
            operative: '',
            capabilities: [],
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Access verification failed: ${message}`);
    }
}
//# sourceMappingURL=access-token.js.map