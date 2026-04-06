/**
 * @elacity-js/access — Smart contract ABIs for Elacity V3 on Base
 *
 * Minimal ABI fragments for the contracts used in asset minting and access.
 * V3 contract system: CentralStorage, AuthorityGateway, ChannelFactory,
 * RoyaltyTradeGateway, AssetFactory, EventHub.
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
    'function subscribePlan(uint8 planId, bytes args)',
    'event AssetCreated(address indexed _to, address indexed _channel, uint256 _tokenId, string _tokenUri, uint16 _opType, address indexed opContract)',
    'event DigitalAssetRegistered(address indexed channel, uint256 indexed tokenId, address creator, string tokenURI, uint16 opType, bytes16 contentId)',
];
export const CENTRAL_STORAGE_ABI = [
    'function mediaCreationFee() view returns (uint256 fee, address token)',
    'function channelCreationFee() view returns (uint256 fee, address token)',
    'function bindIP(bytes16 _contentId, address channel, uint256 tokenId)',
];
export const CHANNEL_FACTORY_ABI = [
    'function createChannel(uint8 _channelType, uint8 _scope, string _name, string _tokenURI, bytes data) payable',
    'event ChannelCreated(uint8 indexed channelType, uint8 indexed scope, address indexed creator, address channel, address factoryAddr)',
];
export const AUTHORITY_GATEWAY_ABI = [
    'function operative(address channel, uint256 tokenId) view returns (address)',
    'function hasAccessByContentId(address holder, bytes16 contentId) view returns (bool)',
    'function supportsLitProtocol() pure returns (bool)',
];
export const OPERATIVE_BUYABLE_ABI = [
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address account, address operator) view returns (bool)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function paymentProcessor() view returns (address)',
];
/** @deprecated Use CENTRAL_STORAGE_ABI */
export const CORE_STORAGE_ABI = CENTRAL_STORAGE_ABI;
/** @deprecated Use CHANNEL_FACTORY_ABI */
export const CHANNEL_CORE_ABI = CHANNEL_FACTORY_ABI;
/**
 * V3 contract addresses on Base (chain ID 8453).
 */
export const BASE_CONTRACTS = {
    CENTRAL_STORAGE: '0x0C1EeA2A3361B80AC0e42179335dB536A951760b',
    AUTHORITY_GATEWAY: '0x09dBe796f40ECEffEAccf243c3d758C4c1d8D87D',
    CHANNEL_FACTORY: '0xE1365ed47353De2F8A6a69E271e36650A9EE368F',
    ROYALTY_TRADE_GATEWAY: '0xd02451BCE627EF476B8ee52Cf131C426f67dbcB2',
    ASSET_FACTORY: '0x4c80A6209F16437f0dc4a98E3D43f08aeBF57765',
    EVENT_HUB: '0x5a694A6d988354dca491fe0F6db7a6ef46b656c2',
    SUBSCRIPTION_MANAGER: '0xb00456b57598006ef11d1F1678DcE68713eC897D',
    UNIVERSAL_CHECKIN: '0x2361a02e6727Ff1798920186b8ACf0f100f621C0',
};
/**
 * Operative types for the mint function.
 * Determines the access model for the minted asset.
 */
export const OP_TYPES = {
    FREE: 0,
    BUY_ONCE: 1,
    BUY_AND_RESELL: 2,
};
/**
 * Role type IDs used in opRawData encoding.
 */
export const ROLE_TYPES = {
    ACCESS_TOKEN: 1,
    ROYALTY_SHARE: 2,
    DISTRIBUTION_RIGHT: 3,
};
/**
 * USDC contract address on Base (6 decimals).
 */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/**
 * Public Elacity Channel on Base.
 * Any wallet can mint to this channel without deploying their own.
 */
export const PUBLIC_ELACITY_CHANNEL = '0x2fb53d4ab93112a6c0a1e54ffcd7199c6fd37412';
//# sourceMappingURL=abis.js.map