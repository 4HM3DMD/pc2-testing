/**
 * Provider Operation Interfaces
 *
 * TypeScript interfaces formalizing the ElastOS Runtime's provider contract
 * protocol (stdin/stdout JSON with fetch/store/list/delete operations).
 *
 * These are documentation-as-code: our existing services already implicitly
 * implement these interfaces. Making them explicit provides:
 * 1. A clear contract for future capsule extraction
 * 2. Type safety for provider implementations
 * 3. A 1:1 mapping to Runtime provider operations
 *
 * No behavioral changes — these are types only.
 * See docs/core/CAPSULE_COMPATIBILITY.md for the full provider mapping.
 */

/**
 * Base provider operation interface.
 * Maps to the Runtime's stdin/stdout JSON protocol.
 */
export interface ProviderOperation {
  fetch(resourceId: string, params?: Record<string, unknown>): Promise<Buffer>;
  store(resourceId: string, data: Buffer, params?: Record<string, unknown>): Promise<string>;
  list(prefix: string, params?: Record<string, unknown>): Promise<string[]>;
  delete(resourceId: string): Promise<void>;
}

/**
 * DRM Provider — handles content encryption, decryption, access verification, and rendering.
 *
 * Maps to Runtime provider operations: drm:decrypt, drm:encrypt, drm:verify-access, drm:render
 *
 * Current implementations:
 * - WASMRuntime.executeRenderer() → drm:render
 * - WASMRuntime.executeDecryptOnly() → drm:decrypt
 * - WASMRuntime.executeCENCDecrypt() → drm:decrypt-media
 * - chipotle-client.recoverNonMediaCEK() → drm:decrypt (CEK recovery)
 * - storage.ts /lit/secure-view → drm:decrypt + drm:render (composite)
 */
export interface DRMProvider extends ProviderOperation {
  decrypt(kid: string, buyerAddress: string): Promise<{ cek: Buffer }>;
  verifyAccess(contentId: string, accessor: string): Promise<boolean>;
  render(encryptedData: Buffer, cek: Buffer, mimeType: string): Promise<Buffer>;
  encrypt(plaintext: Buffer, mimeType: string): Promise<{
    ciphertext: Buffer;
    cek: Buffer;
    iv: string;
    dataToEncryptHash: string;
  }>;
}

/**
 * Storage Provider — handles file and IPFS operations.
 *
 * Maps to Runtime provider operations: storage:read, storage:write, storage:pin, storage:ipfs-fetch
 *
 * Current implementations:
 * - Express routes /read, /write, /readdir, /delete → filesystem operations
 * - IPFSStorage → IPFS pin/fetch/add operations
 * - ContentSeedingService → automatic content distribution
 */
export interface StorageProvider extends ProviderOperation {
  pin(cid: string): Promise<void>;
  resolve(cid: string): Promise<Buffer>;
  add(data: Buffer): Promise<string>;
  addDirectory(files: Array<{ path: string; content: Buffer }>): Promise<string>;
}

/**
 * Identity Provider — handles authentication, DID resolution, and signing.
 *
 * Maps to Runtime provider operations: identity:auth, identity:resolve, identity:sign
 *
 * Current implementations:
 * - auth.ts /auth/particle → wallet signature authentication
 * - IdentityService → node Ed25519 identity (did:boson)
 * - middleware.ts → session token + API key validation
 */
export interface IdentityProvider extends ProviderOperation {
  authenticate(walletAddress: string, signature: string): Promise<{
    sessionToken: string;
    walletAddress: string;
    smartAccountAddress: string | null;
  }>;
  resolve(did: string): Promise<Record<string, unknown>>;
  sign(data: Buffer): Promise<{ signature: Buffer; publicKey: Buffer }>;
}

/**
 * Compute Provider — handles WASM execution, AI inference, and shell commands.
 *
 * Maps to Runtime provider operations: compute:wasm, compute:ai-chat, compute:shell
 *
 * Current implementations:
 * - WASMRuntime → all WASM execution (ddrm-renderer, cenc-*, ipfs-assemble, mp4-split)
 * - AIChatService → AI chat and tool execution
 * - TerminalService → shell command execution
 */
export interface ComputeProvider extends ProviderOperation {
  executeWasm(wasmPath: string, input: Buffer, args?: string[]): Promise<Buffer>;
  aiChat(messages: Array<{ role: string; content: string }>, model?: string): Promise<string>;
}
