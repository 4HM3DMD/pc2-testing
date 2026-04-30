/**
 * @elacity-js/access — Mint data encoding helpers
 *
 * Encodes the opRawData and sellRawData parameters for the
 * DigitalAsset.mint() function, matching the exact format used
 * by the Elacity frontend's formatMintData() in src/lib/drm/utils.ts.
 *
 * Key encoding rules (from Elacity smart contracts):
 * - Royalties are stored as per-1000 values (95% = 950, 5% = 50)
 * - Elacity platform royalty (5%) is auto-added for paid content
 * - Creator appears twice in addresses: once for AccessToken, once for RoyaltyShare
 * - resellerCut is only included for opType=2 (buy_and_resell)
 * - contentId is bytes16 (first 16 bytes of the hash, hex-prefixed)
 */

import { ethers } from 'ethers';
import { OP_TYPES, ROLE_TYPES } from './abis.js';

/**
 * Elacity platform royalty recipient on Base.
 * Auto-added at 5% for all paid content.
 */
export const ELACITY_ROYALTY_ADDRESS = '0x0917Aa260359670F7855a5454c630993ce40C52D';
export const ELACITY_ROYALTY_PERCENT = 5;

export interface MintDataParams {
  /** Content identifier: dataToEncryptHash (non-media) or KID (media) */
  contentId: string;
  /** IPFS CID of the metadata envelope/directory */
  metadataCID: string;
  /** Creator wallet address */
  creatorAddress: string;
  /** Number of access token copies available */
  copies: number;
  /** Price per token in payment token's smallest unit (e.g. USDC 6 decimals) */
  priceInWei: bigint;
  /** ERC-20 payment token address */
  payTokenAddress: string;
  /** 0=free, 1=buy_once, 2=buy_and_resell */
  opType: number;
  /** Creator's royalty percentage (0-95). Elacity 5% is auto-added. */
  creatorRoyaltyPercent?: number;
  /** Per-1000 reseller cut, only for opType=2 (default 900 = 90%) */
  resellerCut?: number;
}

/**
 * Convert a hex string to a bytes16 content ID.
 *
 * For non-media assets, the input is typically a SHA-256 dataToEncryptHash (64 hex chars / 32 bytes).
 * We take the first 16 bytes (32 hex chars) and pad if shorter. This truncation is intentional:
 * bytes16 is what the contract stores. For media assets, the KID is already 16 bytes.
 *
 * All dashes are stripped (handles UUID-formatted KIDs with 4 dashes).
 */
export function hashToContentId(hash: string): string {
  const clean = hash.startsWith('0x') ? hash.slice(2) : hash;
  const stripped = clean.replace(/-/g, '');
  return '0x' + stripped.slice(0, 32).padEnd(32, '0');
}

/**
 * Encode opRawData for the mint() call, matching Elacity's formatMintData().
 *
 * For paid content (opType 1 or 2):
 *   Layout: ['bytes16', 'string', 'address[]', 'uint256[]', 'uint256[]', ?'uint16']
 *   - addresses: [creator, creator, elacity]  (creator appears twice)
 *   - roleTypes: [1(AccessToken), 2(RoyaltyShare), 2(RoyaltyShare)]
 *   - amounts:   [copies, creatorPer1000, elacityPer1000]
 *   - resellerCut: only for opType=2
 *
 * For free content (opType 0): returns '0x'
 */
export function encodeOpRawData(params: MintDataParams): string {
  const {
    contentId,
    metadataCID,
    creatorAddress,
    copies,
    opType,
    creatorRoyaltyPercent = 95,
    resellerCut = 900,
  } = params;

  if (opType === OP_TYPES.FREE) return '0x';

  const cid16 = hashToContentId(contentId);
  const metadataUri = `ipfs://${metadataCID}`;

  const creatorPer1000 = Math.round(creatorRoyaltyPercent * 10);
  const elacityPer1000 = Math.round(ELACITY_ROYALTY_PERCENT * 10);

  const addresses = [creatorAddress, creatorAddress, ELACITY_ROYALTY_ADDRESS];
  const roleTypes = [
    ROLE_TYPES.ACCESS_TOKEN,
    ROLE_TYPES.ROYALTY_SHARE,
    ROLE_TYPES.ROYALTY_SHARE,
  ];
  const amounts = [copies, creatorPer1000, elacityPer1000];

  const isResellable = opType === OP_TYPES.BUY_AND_RESELL;

  const abiTypes = isResellable
    ? ['bytes16', 'string', 'address[]', 'uint256[]', 'uint256[]', 'uint16']
    : ['bytes16', 'string', 'address[]', 'uint256[]', 'uint256[]'];

  const abiValues: unknown[] = isResellable
    ? [cid16, metadataUri, addresses, roleTypes, amounts, resellerCut]
    : [cid16, metadataUri, addresses, roleTypes, amounts];

  return ethers.AbiCoder.defaultAbiCoder().encode(abiTypes, abiValues);
}

/**
 * Encode sellRawData for the mint() call.
 *
 * Layout: ['uint256', 'uint256', 'address']
 *
 * For free content (opType 0): returns '0x'
 */
export function encodeSellRawData(
  copies: number,
  priceInWei: bigint,
  payTokenAddress: string
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'address'],
    [copies, priceInWei, payTokenAddress]
  );
}
