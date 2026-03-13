/**
 * @elacity-js/access/node
 *
 * Node.js entry point for server-side access operations.
 * Uses LitNodeClientNodeJs (no browser deps) and ethers.Wallet (private key).
 *
 * Usage:
 *   import { ElacityAccessNode } from '@elacity-js/access/node';
 */

export { ElacityAccessNode } from './client.js';
export { LitSessionNode, type NodeWalletConfig } from './session.js';

// Re-export shared types and utilities
export type {
  ConnectOptions,
  AccessVerification,
  VerifyAccessParams,
  DecryptionKey,
  EncryptResult,
  FetchDecryptParams,
  AccessEvent,
  AccessEventHandler,
} from '../types.js';

export { verifyAccess } from '../verify/access-token.js';
export { encryptWithKey } from '../crypto/encrypt.js';
export { decryptWithKey } from '../crypto/decrypt.js';
export { fetchFromIpfs } from '../fetch/ipfs.js';
export { buildAccessTokenCondition } from '../lit/conditions.js';
export {
  BASE_CHAIN_ID,
  DEFAULT_AUTHORITY_GATEWAY,
  DEFAULT_IPFS_GATEWAY,
  LOCAL_IPFS_GATEWAY,
} from '../constants.js';
