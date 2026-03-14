/**
 * @elacity-js/access — Constants
 *
 * Chain IDs, contract addresses, and Lit Protocol configuration.
 * Single source of truth for all network configuration.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_NAME = 'base';

/**
 * Default AuthorityGateway contract on Base mainnet.
 * This is the entry point for buyAccess() and hasAccess() checks.
 */
export const DEFAULT_AUTHORITY_GATEWAY = '0x580C26DeFf267Ef40A72cf10a4A42050F0641b8B';

/**
 * Lit Protocol network configuration.
 * datil-dev and datil-test testnets are currently offline (ports unreachable).
 * Using 'datil' (production) which has 6 healthy nodes on standard port 443.
 */
export const DEFAULT_LIT_NETWORK = 'datil';

/**
 * Lit Protocol capacity credit (RLI) token ID on Chronicle Yellowstone.
 * Owned by the Elacity wallet (0x0917Aa...C52D).
 * 100 req/kilosecond, expires April 13, 2026.
 *
 * Note: Elacity's production frontend does NOT use capacity delegation
 * in the browser. If needed, capacity delegation must be handled
 * server-side by the dApp owner wallet (createCapacityDelegationAuthSig
 * requires the NFT owner's signature, not the end user's).
 */
export const CAPACITY_TOKEN_ID = '429689';

/**
 * DRM system IDs matching the PSSH system IDs in the media-player WASM.
 * These are base64-encoded UUIDs identifying each DRM system variant.
 */
export const DRM_SYSTEM_IDS = {
  'cenc:lit-drm-v1': 't4VVRojlQPi6mcPjMDP77g==',
  'cenc:lit-drm-sa-v1': 'oX5QbZNVRxCTXx2Sjv91lA==',
  'cenc:web3-drm-v1': 'v474XSxUR12MHuJ9tgMyog==',
  'cenc': 'EHfv7MCyTQKs4zweUuL7Sw==',
} as const;

/**
 * ABI fragments for on-chain access verification.
 * Minimal ABIs — only the functions we actually call.
 */
export const AUTHORITY_GATEWAY_ABI = [
  'function hasAccess(address holder, address ledger, uint256 tokenId) view returns (bool)',
  'function buyAccess(address seller, address ledger, uint256 tokenId, uint256 _quantity, uint256 _pricePerToken) payable',
  'function buyAccess(address seller, address ledger, uint256 tokenId, uint256 _quantity, uint256 _pricePerToken, address _payToken)',
] as const;

export const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
] as const;

export const OPERATIVE_ABI = [
  'function paymentProcessor() view returns (address)',
] as const;

/**
 * Default IPFS gateways for content fetching.
 */
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.ela.city/ipfs/';
export const LOCAL_IPFS_GATEWAY = 'http://localhost:4200/ipfs/';

/**
 * Encryption defaults
 */
export const DEFAULT_ALGORITHM = 'aes-gcm' as const;
export const AES_KEY_LENGTH = 256;
export const AES_IV_LENGTH = 12;
