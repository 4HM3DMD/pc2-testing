/**
 * @elacity-js/access — Smart contract ABIs for Elacity on Base
 *
 * Minimal ABI fragments for the contracts used in asset minting and access.
 * Based on the DigitalAsset, CoreStorage, ChannelCore, and Operative contracts
 * from the Elacity smart contract system.
 */

export const DIGITAL_ASSET_ABI = [
  'function mint(string _uri, uint16 opType, bytes opRawData, bytes sellRawData) payable',
  'function authority() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function uri(uint256 tokenId) view returns (string)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function subscribePlan(uint8 planId)',
  'event AssetCreated(uint256 indexed _tokenId, address indexed _creator, string _tokenURI, uint16 _opType, address indexed opContract)',
  'event DigitalAssetRegistered(address indexed ledger, uint256 indexed tokenId, address indexed operator)',
] as const;

export const CORE_STORAGE_ABI = [
  'function mediaCreationFee() view returns (uint256 fee, address token)',
  'function channelCreationFee() view returns (uint256 fee, address token)',
  'function bindIP(bytes16 _contentId, address channel, uint256 tokenId)',
] as const;

export const CHANNEL_CORE_ABI = [
  'function createChannel(string name, string symbol, string description, address authority) payable returns (address)',
] as const;

export const OPERATIVE_BUYABLE_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function paymentProcessor() view returns (address)',
] as const;

/**
 * Verified contract addresses on Base (chain ID 8453).
 */
export const BASE_CONTRACTS = {
  CORE_STORAGE: '0xc8F50Bf1A6b765460621f861a64a5d333Bc7f575',
  AUTHORITY_GATEWAY: '0x8fe6bf9877B78BF0126819ff2593235E54Ee1E29',
  CHANNEL_CORE: '0x6a3f7780C54cb66291f8f1bE609047C2f664Dbf6',
  TRADE_GATEWAY: '0x9eC53758b698f9F68C0654DDd9159173a159a459',
  UNIVERSAL_CHECKIN: '0x2361a02e6727Ff1798920186b8ACf0f100f621C0',
} as const;

/**
 * Operative types for the mint function.
 * Determines the access model for the minted asset.
 */
export const OP_TYPES = {
  FREE: 0,
  BUY_ONCE: 1,
  BUY_AND_RESELL: 2,
} as const;

/**
 * Role type IDs used in opRawData encoding.
 */
export const ROLE_TYPES = {
  ACCESS_TOKEN: 1,
  ROYALTY_SHARE: 2,
  DISTRIBUTION_RIGHT: 3,
} as const;

/**
 * USDC contract address on Base (6 decimals).
 */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * Public Elacity Channel on Base.
 * Any wallet can mint to this channel without deploying their own.
 */
export const PUBLIC_ELACITY_CHANNEL = '0x2fb53d4ab93112a6c0a1e54ffcd7199c6fd37412';
