/**
 * @elacity-js/access — Type definitions
 *
 * All public interfaces for the universal access layer.
 * Designed to be capsule-ready: stateless, extensible, no singletons.
 */

// Re-export for consumers who need the provider type
export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  smartAccountAddress?: string;
};

export type DrmSystemType =
  | 'cenc:lit-drm-v1'
  | 'cenc:lit-drm-sa-v1'
  | 'cenc:web3-drm-v1';

export interface DrmSystemConfig {
  priority: number;
  disabled?: boolean;
}

export interface ConnectOptions {
  chainId?: number;
  litNetwork?: string;
  drmSystems?: Partial<Record<DrmSystemType, DrmSystemConfig>>;
  smartAccount?: string;
  authorityGateway?: string;
  /** Lit node handshake timeout in ms (default: 60000) */
  connectTimeout?: number;
}

export interface AccessVerification {
  hasAccess: boolean;
  tokenBalance: bigint;
  operative: string;
  /** Forward-compatible with Runtime capability tokens */
  capabilities?: string[];
  /** Capability token issuer (Runtime v2) */
  grantedBy?: string;
  /** Audit trail reference (Runtime v2) */
  auditRef?: string;
  /** Subscription expiry timestamp (ms) */
  expiresAt?: number;
}

export interface VerifyAccessParams {
  ledger: string;
  tokenId: string;
  wallet?: string;
}

export interface AcquireKeyParams {
  ledger: string;
  tokenId: string;
  /** Base64 ciphertext from Lit Protocol encrypt() */
  ciphertext: string;
  /** Hash of the original data, from encryptBuffer().dataToEncryptHash */
  dataToEncryptHash: string;
  keyIds?: string[];
  drmSystem?: DrmSystemType;
}

export interface DecryptionKey {
  raw: Uint8Array;
  keyId: string;
  algorithm: 'aes-gcm' | 'aes-ctr' | 'aes-cbc';
  expiresAt?: number;
}

export interface EncryptParams {
  ledger: string;
  tokenId: string;
  algorithm?: 'aes-gcm';
}

export interface EncryptResult {
  encrypted: Uint8Array;
  /** Lit access conditions used for encryption */
  conditions: UnifiedAccessControlCondition[];
  keyId: string;
  algorithm: string;
  /** Symmetric key hash for Lit Protocol reference */
  dataToEncryptHash: string;
}

export interface FetchDecryptParams {
  cid: string;
  ledger: string;
  tokenId: string;
  /** dataToEncryptHash from the asset's metadata envelope */
  dataToEncryptHash?: string;
  gateway?: string;
  fallbackGateway?: string;
}

export interface LicensePayload {
  kids: string[];
  format: string;
  type: string;
}

export interface AcquireLicenseParams {
  payload: LicensePayload;
  refs: Record<string, Uint8Array>;
}

export type AccessEvent =
  | 'sign_request'
  | 'sign_error'
  | 'connected'
  | 'disconnected';

export type AccessEventHandler = (...args: unknown[]) => void;

/**
 * Unified access control condition for Lit Protocol.
 * Matches @lit-protocol/types format for EVM contract conditions.
 */
export interface UnifiedAccessControlCondition {
  conditionType: 'evmContract' | 'evmBasic' | 'solRpc' | 'cosmos' | 'unified';
  contractAddress: string;
  chain: string;
  functionName: string;
  functionParams: string[];
  functionAbi: {
    name: string;
    inputs: Array<{ name: string; type: string }>;
    outputs: Array<{ name: string; type: string }>;
    stateMutability: string;
    type: string;
  };
  returnValueTest: {
    key: string;
    comparator: string;
    value: string;
  };
}
