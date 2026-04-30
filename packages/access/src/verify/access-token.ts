/**
 * @elacity-js/access — On-chain ACCESS_TOKEN verification
 *
 * Checks whether a wallet holds an ACCESS_TOKEN for a given asset
 * by calling AuthorityGateway.hasAccess() on Base.
 *
 * Separated from key retrieval so the Runtime can verify access
 * and issue a capability token before the key is fetched.
 */

import { ethers } from 'ethers';
import {
  BASE_CHAIN_ID,
  DEFAULT_AUTHORITY_GATEWAY,
  AUTHORITY_GATEWAY_ABI,
  ERC1155_ABI,
} from '../constants.js';
import type { EthereumProvider, VerifyAccessParams, AccessVerification } from '../types.js';

/**
 * Verify whether a wallet holds an ACCESS_TOKEN for a specific asset.
 *
 * Uses AuthorityGateway.hasAccess() as the primary check,
 * with ERC1155.balanceOf() as a secondary data source for token balance.
 */
export async function verifyAccess(
  provider: EthereumProvider,
  params: VerifyAccessParams,
  options?: {
    authorityGateway?: string;
    signerAddress?: string;
  }
): Promise<AccessVerification> {
  const { ledger, tokenId, wallet } = params;
  const authorityAddr = options?.authorityGateway ?? DEFAULT_AUTHORITY_GATEWAY;
  const holderAddr = wallet ?? options?.signerAddress;

  if (!holderAddr) {
    throw new Error('No wallet address provided for access verification');
  }

  const browserProvider = new ethers.BrowserProvider(provider as ethers.Eip1193Provider);

  const gateway = new ethers.Contract(
    authorityAddr,
    AUTHORITY_GATEWAY_ABI,
    browserProvider
  );

  try {
    const hasAccess: boolean = await gateway.hasAccess(holderAddr, ledger, tokenId);

    let tokenBalance = 0n;
    try {
      const ledgerContract = new ethers.Contract(ledger, ERC1155_ABI, browserProvider);
      tokenBalance = await ledgerContract.balanceOf(holderAddr, tokenId);
    } catch {
      // balanceOf may fail if ledger isn't a standard ERC1155 — non-critical
    }

    return {
      hasAccess,
      tokenBalance,
      operative: '',
      capabilities: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Access verification failed: ${message}`);
  }
}
