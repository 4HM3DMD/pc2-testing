/**
 * Unified Capability Vocabulary
 *
 * Single source of truth for capability scope names used across:
 * - AppManifest.capabilities (AppInstallService.ts)
 * - API key scopes (middleware.ts)
 * - Wallet bridge method classification (pc2-wallet-bridge.js)
 * - Runtime v2 capability token `action` fields
 *
 * These map 1:1 to ElastOS Runtime provider contract operations.
 * See docs/core/CAPSULE_COMPATIBILITY.md for the full mapping.
 */

export const CAPABILITY_SCOPES = {
  'storage:read': 'Read files from user storage',
  'storage:write': 'Write files to user storage',
  'ipfs:fetch': 'Fetch content from IPFS',
  'ipfs:pin': 'Pin content to local IPFS node',
  'wallet:read': 'Read wallet address and balances',
  'wallet:sign': 'Sign transactions and messages',
  'drm:decrypt': 'Decrypt dDRM-protected content',
  'drm:encrypt': 'Encrypt content with dDRM',
  'compute:wasm': 'Execute WASM modules',
  'compute:ai': 'Use AI chat and inference',
  'network:rpc': 'Make RPC calls to blockchain nodes',
  'ipc:launch': 'Launch other apps via IPC',
  'ipc:message': 'Send/receive IPC messages between apps',
  'identity:auth': 'Authenticate and access user identity',
} as const;

export type CapabilityScope = keyof typeof CAPABILITY_SCOPES;

/**
 * Classification of wallet bridge RPC methods by required capability.
 * Used by wallet bridge origin validation to categorize requests.
 */
export const WALLET_METHOD_CAPABILITIES: Record<string, CapabilityScope> = {
  eth_accounts: 'wallet:read',
  eth_requestAccounts: 'wallet:read',
  eth_chainId: 'network:rpc',
  eth_blockNumber: 'network:rpc',
  eth_getBalance: 'network:rpc',
  eth_getCode: 'network:rpc',
  eth_call: 'network:rpc',
  eth_estimateGas: 'network:rpc',
  eth_gasPrice: 'network:rpc',
  eth_getTransactionCount: 'network:rpc',
  eth_getTransactionReceipt: 'network:rpc',
  eth_getTransactionByHash: 'network:rpc',
  eth_getBlockByNumber: 'network:rpc',
  eth_getBlockByHash: 'network:rpc',
  eth_getLogs: 'network:rpc',
  net_version: 'network:rpc',
  web3_clientVersion: 'network:rpc',

  eth_sendTransaction: 'wallet:sign',
  eth_signTransaction: 'wallet:sign',
  eth_sign: 'wallet:sign',
  personal_sign: 'wallet:sign',
  eth_signTypedData: 'wallet:sign',
  eth_signTypedData_v3: 'wallet:sign',
  eth_signTypedData_v4: 'wallet:sign',

  wallet_switchEthereumChain: 'network:rpc',
  wallet_addEthereumChain: 'network:rpc',
};

/**
 * Full capability set — granted to authenticated user sessions in v1.
 * In v2+, apps receive only their declared manifest capabilities.
 */
export const FULL_CAPABILITY_SET: CapabilityScope[] = Object.keys(CAPABILITY_SCOPES) as CapabilityScope[];

/**
 * Maps AppManifest.capabilities keys to CapabilityScope values.
 * Used to translate app.json declarations into the unified vocabulary.
 */
export const MANIFEST_CAPABILITY_MAP: Record<string, CapabilityScope[]> = {
  wallet: ['wallet:read', 'wallet:sign'],
  network: ['network:rpc'],
  'storage.read': ['storage:read'],
  'storage.write': ['storage:write'],
  'ipfs.fetch': ['ipfs:fetch'],
  'ipfs.pin': ['ipfs:pin'],
  drm: ['drm:decrypt', 'drm:encrypt'],
  ipc: ['ipc:launch', 'ipc:message'],
};
