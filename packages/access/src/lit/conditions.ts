/**
 * @elacity-js/access — Lit Protocol access condition builders
 *
 * Builds the unified access control conditions that Lit Protocol uses
 * to gate decryption key access. The primary condition is:
 * "caller must hold an ACCESS_TOKEN (ERC-1155 balanceOf > 0)
 *  for the given Channel contract and tokenId on Base."
 *
 * These conditions are used for BOTH:
 * - Encryption (creator sets conditions when encrypting)
 * - Decryption (Lit nodes verify conditions before releasing key)
 */

import { BASE_CHAIN_NAME } from '../constants.js';
import type { UnifiedAccessControlCondition } from '../types.js';

/**
 * Build the standard ACCESS_TOKEN ownership condition.
 *
 * Checks ERC1155.balanceOf(userAddress, tokenId) > 0 on the Channel contract.
 * This is the condition that gates all dDRM-protected content.
 */
export function buildAccessTokenCondition(
  ledger: string,
  tokenId: string,
  chain?: string
): UnifiedAccessControlCondition[] {
  return [
    {
      conditionType: 'evmContract',
      contractAddress: ledger,
      chain: chain ?? BASE_CHAIN_NAME,
      functionName: 'balanceOf',
      functionParams: [':userAddress', tokenId],
      functionAbi: {
        name: 'balanceOf',
        inputs: [
          { name: 'account', type: 'address' },
          { name: 'id', type: 'uint256' },
        ],
        outputs: [
          { name: 'balance', type: 'uint256' },
        ],
        stateMutability: 'view',
        type: 'function',
      },
      returnValueTest: {
        key: '',
        comparator: '>',
        value: '0',
      },
    },
  ];
}

/**
 * Build a combined condition: ACCESS_TOKEN ownership OR specific wallet.
 * Useful for creators who need to decrypt their own content.
 */
export function buildCreatorOrAccessCondition(
  ledger: string,
  tokenId: string,
  creatorAddress: string,
  chain?: string
): UnifiedAccessControlCondition[] {
  const accessCondition = buildAccessTokenCondition(ledger, tokenId, chain);

  // Wrap in a unified OR condition
  return [
    ...accessCondition,
    {
      conditionType: 'evmBasic',
      contractAddress: '',
      chain: chain ?? BASE_CHAIN_NAME,
      functionName: '',
      functionParams: [':userAddress'],
      functionAbi: {
        name: '',
        inputs: [],
        outputs: [],
        stateMutability: 'view',
        type: 'function',
      },
      returnValueTest: {
        key: '',
        comparator: '=',
        value: creatorAddress.toLowerCase(),
      },
    },
  ];
}
