/**
 * IPFS Storage Module
 * 
 * Handles file storage and retrieval using Helia (modern IPFS implementation)
 * Files are stored content-addressed (by CID) and linked to paths via database
 */

// Import polyfill before Helia to ensure Promise.withResolvers is available
import '../utils/polyfill.js';

import { createHelia, type Helia } from 'helia';
import { unixfs, type UnixFS } from '@helia/unixfs';
import { createLibp2p, type Libp2pOptions } from 'libp2p';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { FsBlockstore } from 'blockstore-fs';
import { FsDatastore } from 'datastore-fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
const log = createLogger('ipfs');

const WASM_ASSEMBLE_THRESHOLD = 5 * 1024 * 1024; // 5 MB — WASM assembly reduces V8 heap pressure on constrained devices
const IPFS_ASSEMBLE_WASM_PATH = 'wasm-apps/ipfs-assemble/ipfs-assemble.wasm';
let cachedAssembleWasm: ArrayBuffer | null = null;

/**
 * IPFS Network Modes:
 * - private: Isolated node, no network connectivity (personal cloud only)
 * - public: Full DHT participation, content discoverable globally
 * - hybrid: Connect to network but only announce public content
 */
export type IPFSNetworkMode = 'private' | 'public' | 'hybrid';

/**
 * PC2 Supernode bootstrap addresses
 * These dedicated relay+DHT-server nodes are contacted first for content
 * discovery and NAT traversal. Add multiaddrs as supernodes are deployed.
 */
const PC2_SUPERNODE_BOOTSTRAP: string[] = [
  // InterServer (primary)
  '/ip4/69.164.241.210/tcp/4003/p2p/12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G',
  '/ip4/69.164.241.210/tcp/4004/ws/p2p/12D3KooWMcuTWxkKg7xS3dxRaPDK9BEUHdAvKWf2b5Kdk4Kwxy9G',
  // Contabo (secondary)
  '/ip4/38.242.211.112/tcp/4003/p2p/12D3KooWAaFWUWN7GQVeNdbdPKUUTmyoQewBAPbwXKKrhxxsck5h',
  '/ip4/38.242.211.112/tcp/4004/ws/p2p/12D3KooWAaFWUWN7GQVeNdbdPKUUTmyoQewBAPbwXKKrhxxsck5h',
  '/ip4/34.77.31.164/tcp/4001/ipfs/12D3KooWNieM3HRBJdVqaQucZEJdqA3oWKrKf3Gx3hp2cmtR9GNK',
];

/**
 * Public IPFS bootstrap nodes (fallback after supernodes)
 */
const PUBLIC_BOOTSTRAP_NODES = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
  '/ip4/34.77.31.164/tcp/4001/ipfs/12D3KooWNieM3HRBJdVqaQucZEJdqA3oWKrKf3Gx3hp2cmtR9GNK',
];

export interface IPFSOptions {
  repoPath: string;
  mode?: IPFSNetworkMode;           // Network mode (default: private)
  enableDHT?: boolean;              // Enable DHT (auto for public/hybrid)
  dhtClientMode?: boolean;          // DHT client-only mode (default: false for public/hybrid)
  enableBootstrap?: boolean;        // Use public bootstrap nodes
  autoAnnounceOnStore?: boolean;    // Auto-announce newly stored CIDs (default: true)
  prefetchOnStore?: boolean;        // Trigger public gateway prefetch after local store (default: true)
  publicGatewayPrefetchUrl?: string;// Public gateway base URL for prefetch (default: ipfs.ela.city/ipfs/)
  customBootstrap?: string[];       // Additional bootstrap nodes
  supernodeBootstrap?: string[];    // PC2 supernode relay addresses (highest priority)
  relayMode?: boolean;              // Enable relay server mode (for nodes with public IP)
  relayMaxConnections?: number;     // Max relay connections (default: 100)
}

export class IPFSStorage {
  private helia: Helia | null = null;
  private fs: UnixFS | null = null;
  private blockstore: FsBlockstore | null = null;
  private repoPath: string;
  private isInitialized: boolean = false;
  private networkMode: IPFSNetworkMode;
  private options: IPFSOptions;
  private relayEnabled: boolean = false;
  private bootstrapReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: IPFSOptions) {
    this.repoPath = options.repoPath;
    this.networkMode = options.mode || 'private';
    this.options = options;
    this.relayEnabled = options.relayMode ?? false;
  }

  isRelayMode(): boolean {
    return this.relayEnabled;
  }

  /**
   * Get the current network mode
   */
  getNetworkMode(): IPFSNetworkMode {
    return this.networkMode;
  }

  /**
   * Persist libp2p identity key so Peer ID stays stable across restarts.
   */
  private getLibp2pKeyPath(): string {
    return join(this.repoPath, 'libp2p-private-key.protobuf');
  }

  private async loadOrCreateLibp2pPrivateKey() {
    const keyPath = this.getLibp2pKeyPath();

    if (existsSync(keyPath)) {
      try {
        const keyBytes = readFileSync(keyPath);
        const key = privateKeyFromProtobuf(new Uint8Array(keyBytes));
        return key;
      } catch (error: any) {
        log.warn(`⚠️  Failed to load persisted libp2p identity key, regenerating: ${error?.message || 'unknown error'}`);
      }
    }

    const key = await generateKeyPair('Ed25519');
    const encoded = privateKeyToProtobuf(key);
    writeFileSync(keyPath, Buffer.from(encoded), { mode: 0o600 });
    log.info(`🔐 Created new persistent libp2p identity key: ${keyPath}`);
    return key;
  }

  /**
   * Initialize Helia IPFS node
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.helia) {
      return; // Already initialized
    }

    // Ensure repo directory exists
    if (!existsSync(this.repoPath)) {
      mkdirSync(this.repoPath, { recursive: true });
    }

    // Ensure subdirectories exist
    const blockstorePath = join(this.repoPath, 'blocks');
    const datastorePath = join(this.repoPath, 'datastore');
    if (!existsSync(blockstorePath)) {
      mkdirSync(blockstorePath, { recursive: true });
    }
    if (!existsSync(datastorePath)) {
      mkdirSync(datastorePath, { recursive: true });
    }

    try {
      // Verify polyfill is loaded
      if (typeof (Promise as any).withResolvers === 'undefined') {
        throw new Error('Promise.withResolvers polyfill not loaded. Helia requires Node.js 22+ or the polyfill.');
      }

      log.info('🌐 Initializing Helia IPFS node...');
      log.info(`   Repo path: ${this.repoPath}`);
      log.info(`   Network mode: ${this.networkMode}`);

      // Create blockstore and datastore
      this.blockstore = new FsBlockstore(blockstorePath);
      const datastore = new FsDatastore(datastorePath);
      const privateKey = await this.loadOrCreateLibp2pPrivateKey();

      // Determine if we should enable network features
      const enableNetwork = this.networkMode !== 'private';
      const enableDHT = this.options.enableDHT ?? enableNetwork;
      const enableBootstrap = this.options.enableBootstrap ?? enableNetwork;

      // Build libp2p configuration
      const libp2pConfig: Libp2pOptions = {
        addresses: {
          listen: enableNetwork ? [
            '/ip4/0.0.0.0/tcp/4001',
            '/ip4/0.0.0.0/tcp/4002/ws'
          ] : []
        },
        transports: enableNetwork ? [
          tcp(),
          webSockets(),
          circuitRelayTransport()
        ] : [
          tcp(),
          webSockets()
        ],
        connectionEncrypters: [
          noise()
        ],
        streamMuxers: [
          yamux()
        ],
        connectionManager: {
          maxConnections: enableNetwork ? 50 : 0,
        },
        datastore,
        privateKey,
        services: {} as any
      };

      // Add network services for public/hybrid modes
      if (enableNetwork) {
        log.info(`   DHT: ${enableDHT ? 'enabled' : 'disabled'}`);
        log.info(`   Bootstrap: ${enableBootstrap ? 'enabled' : 'disabled'}`);
        log.info(`   NAT traversal: enabled (autoNAT + dcutr + circuit-relay-v2)`);
        log.info(`   Max connections: 50`);

        // Add identify service (required for DHT)
        (libp2pConfig.services as any).identify = identify();

        // Add ping service (required for DHT)
        (libp2pConfig.services as any).ping = ping();

        // NAT traversal: autoNAT detects whether we're behind NAT,
        // dcutr upgrades relay connections to direct peer-to-peer links
        (libp2pConfig.services as any).autoNAT = autoNAT();
        (libp2pConfig.services as any).dcutr = dcutr();

        // Relay server: when relay mode is on, this node serves as a
        // circuit-relay for NAT'd peers, strengthening the mesh
        if (this.relayEnabled) {
          (libp2pConfig.services as any).relay = circuitRelayServer({
            reservations: {
              maxReservations: this.options.relayMaxConnections ?? 100,
            },
          });
          log.info('   Relay server: ENABLED — serving as circuit relay for other peers');
        }

        // DHT defaults to full participation for public/hybrid nodes so this
        // node can advertise locally-created CIDs to external gateways.
        // Allow opting back into client mode via config when needed.
        if (enableDHT) {
          const dhtClientMode = this.options.dhtClientMode ?? false;
          (libp2pConfig.services as any).dht = kadDHT({
            clientMode: dhtClientMode,
          });
          log.info(`   DHT mode: ${dhtClientMode ? 'client' : 'server (full participation)'}`);
        }

        // Add bootstrap nodes for initial peer discovery
        // Priority: supernodes → custom → public IPFS nodes
        if (enableBootstrap) {
          const supernodes = [
            ...PC2_SUPERNODE_BOOTSTRAP,
            ...(this.options.supernodeBootstrap || [])
          ];
          const bootstrapNodes = [
            ...supernodes,
            ...(this.options.customBootstrap || []),
            ...PUBLIC_BOOTSTRAP_NODES,
          ];
          if (supernodes.length > 0) {
            log.info(`   PC2 supernodes: ${supernodes.length} configured`);
          }
          libp2pConfig.peerDiscovery = [
            bootstrap({ list: bootstrapNodes })
          ];
        }
      } else {
        log.info('   Network: disabled (private mode)');
      }

      // Create libp2p instance
      const libp2p = await createLibp2p(libp2pConfig);

      console.log('   Initializing IPFS with libp2p:', libp2p);

      // Create Helia node with custom libp2p (no WebRTC)
      // Let Helia start libp2p - don't start it ourselves
      this.helia = await createHelia({
        blockstore: this.blockstore,
        datastore,
        libp2p
      });

      // Initialize UnixFS
      this.fs = unixfs(this.helia);

      // Get node info
      const peerId = this.helia.libp2p.peerId;
      log.info(`✅ Helia IPFS node initialized`);
      log.info(`   Node ID: ${peerId.toString()}`);

      const addresses = this.helia.libp2p.getMultiaddrs();
      log.info(`   Addresses: ${addresses.length} configured`);
      if (addresses.length > 0) {
        log.info(`   First address: ${addresses[0].toString()}`);
      }

      this.isInitialized = true;

      // Kubo-style flow: explicitly dial bootstrap peers after init.
      // This mirrors `ipfs swarm connect ...` and speeds up peering/provider exchange.
      if (enableNetwork && enableBootstrap) {
        const supernodes = [
          ...PC2_SUPERNODE_BOOTSTRAP,
          ...(this.options.supernodeBootstrap || [])
        ];
        const bootstrapNodes = [
          ...supernodes,
          ...(this.options.customBootstrap || []),
          ...PUBLIC_BOOTSTRAP_NODES,
        ];
        void this.connectBootstrapPeers(bootstrapNodes, 'initial');

        if (this.bootstrapReconnectTimer) {
          clearTimeout(this.bootstrapReconnectTimer);
        }
        this.bootstrapReconnectTimer = setTimeout(() => {
          void this.connectBootstrapPeers(bootstrapNodes, 'post-init');
        }, 10_000);
      }
    } catch (error) {
      // Clean up any partial initialization
      if (this.helia) {
        try {
          await this.helia.stop().catch((err) => {
            log.debug('Helia stop during cleanup failed (expected)', { error: err?.message });
          });
        } catch {
          // Ignore cleanup errors
        }
        this.helia = null;
        this.fs = null;
      }
      this.isInitialized = false;
      if (this.bootstrapReconnectTimer) {
        clearTimeout(this.bootstrapReconnectTimer);
        this.bootstrapReconnectTimer = null;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error('❌ Failed to initialize Helia IPFS:', errorMessage);

      // Provide helpful error messages for common issues
      if (errorMessage.includes('withResolvers')) {
        log.error('   ⚠️  This error suggests Node.js version < 22');
        log.error('   💡 A polyfill has been added, but Helia may still require Node.js 22+');
        log.error('   💡 Consider upgrading Node.js: nvm install 22 && nvm use 22');
      } else if (errorMessage.includes('EADDRINUSE')) {
        log.error('   ⚠️  IPFS ports (4001, 4002) are already in use');
        log.error('   💡 Another IPFS instance may be running');
        log.error('   💡 Try stopping other IPFS processes or change ports in config');
      } else if (errorMessage.includes('repo') || errorMessage.includes('datastore') || errorMessage.includes('blockstore')) {
        log.error('   ⚠️  IPFS repository issue');
        log.error(`   💡 Repo path: ${this.repoPath}`);
        log.error('   💡 Try deleting the repo directory and restarting');
      }

      if (errorStack && process.env.NODE_ENV !== 'production') {
        log.error('   Stack trace:', errorStack);
      }

      throw error;
    }
  }

  /**
   * Get Helia instance for external access (relay status, peer counts, etc.)
   * Returns null if not initialized.
   */
  getHeliaInstance(): Helia | null {
    return this.helia;
  }

  /**
   * Get Helia instance (throws if not initialized)
   */
  private getHelia(): Helia {
    if (!this.helia || !this.isInitialized) {
      throw new Error('Helia IPFS not initialized. Call initialize() first.');
    }
    return this.helia;
  }

  /**
   * Get UnixFS instance (throws if not initialized)
   */
  private getUnixFS(): UnixFS {
    if (!this.fs || !this.isInitialized) {
      throw new Error('UnixFS not initialized. Call initialize() first.');
    }
    return this.fs;
  }

  /**
   * Store file content in IPFS
   * Returns the Content ID (CID) that can be used to retrieve the file
   */
  async storeFile(content: Buffer | Uint8Array | string, options?: {
    pin?: boolean;
    timeoutMs?: number;
    announce?: boolean; // Announce CID to DHT after storing
  }): Promise<string> {
    const fs = this.getUnixFS();
    const timeout = options?.timeoutMs ?? 15 * 60 * 1000; // 15 min default

    try {
      const data = typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content instanceof Buffer
          ? new Uint8Array(content)
          : content;

      const cidPromise = fs.addBytes(data);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`IPFS addBytes timed out after ${Math.round(timeout / 60000)} minutes`)), timeout);
      });

      const cid = await Promise.race([cidPromise, timeoutPromise]);

      if (options?.pin !== false) {
        await this.pinFile(cid.toString());
      }

      await this.maybeAnnounceStoredCID(cid.toString(), options?.announce);
      void this.maybeWarmPublicGateway(cid.toString());

      return cid.toString();
    } catch (error) {
      log.error('Error storing file in Helia IPFS:', error);
      throw new Error(`Failed to store file in IPFS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Store multiple named files as an IPFS directory.
   * Uses the UnixFS importer with wrapWithDirectory to build a proper DAG
   * so that {dirCID}/{filename} resolves on any IPFS gateway.
   *
   * @param files - Map of filename → content (Buffer or string)
   * @returns The directory CID string
   */
  async storeDirectory(
    files: Record<string, Buffer | Uint8Array | string>,
    options?: { pin?: boolean; timeoutMs?: number; announce?: boolean }
  ): Promise<string> {
    const fs = this.getUnixFS();

    try {
      const candidates = Object.entries(files).map(([filename, content]) => {
        const data = typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content instanceof Buffer
            ? new Uint8Array(content)
            : content;

        return { path: filename, content: data };
      });

      let dirCid: string | null = null;

      for await (const entry of fs.addAll(candidates, { wrapWithDirectory: true })) {
        dirCid = entry.cid.toString();
      }

      if (!dirCid) {
        throw new Error('No CID returned from addAll');
      }

      if (options?.pin !== false) {
        await this.pinFile(dirCid);
      }

      await this.maybeAnnounceStoredCID(dirCid, options?.announce);
      void this.maybeWarmPublicGateway(dirCid);

      log.info(`[IPFS] Stored directory with ${Object.keys(files).length} files: ${dirCid}`);
      return dirCid;
    } catch (error) {
      log.error('Error storing directory in Helia IPFS:', error);
      throw new Error(`Failed to store directory in IPFS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Store a file from a readable stream without loading it entirely into memory.
   * Uses Helia's addByteStream for efficient chunked IPFS ingestion.
   */
  async storeFileStream(stream: AsyncIterable<Uint8Array>, options?: {
    pin?: boolean;
    timeoutMs?: number;
    announce?: boolean; // Announce CID to DHT after storing
  }): Promise<string> {
    const fs = this.getUnixFS();
    const timeout = options?.timeoutMs ?? 30 * 60 * 1000; // 30 min default for large files

    try {
      // Wrap with a timeout so large uploads don't hang forever
      const cidPromise = fs.addByteStream(stream);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`IPFS addByteStream timed out after ${Math.round(timeout / 60000)} minutes`)), timeout);
      });

      const cid = await Promise.race([cidPromise, timeoutPromise]);

      if (options?.pin !== false) {
        await this.pinFile(cid.toString());
      }

      await this.maybeAnnounceStoredCID(cid.toString(), options?.announce);
      void this.maybeWarmPublicGateway(cid.toString());

      return cid.toString();
    } catch (error) {
      log.error('Error storing file stream in Helia IPFS:', error);
      throw new Error(`Failed to store file stream in IPFS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async maybeAnnounceStoredCID(cid: string, explicitAnnounce?: boolean): Promise<void> {
    const autoAnnounce = this.options.autoAnnounceOnStore !== false;
    const shouldAnnounce = explicitAnnounce === true || (explicitAnnounce === undefined && autoAnnounce);

    if (!shouldAnnounce) return;
    if (!this.canAnnounce()) return;

    try {
      const announced = await this.announceCID(cid);
      if (!announced) {
        log.debug(`[IPFS] Store auto-announce skipped/failed for CID: ${cid}`);
      }
    } catch (error: any) {
      log.warn(`[IPFS] Store auto-announce failed for CID ${cid}: ${error?.message || 'unknown error'}`);
    }
  }

  private async maybeWarmPublicGateway(cid: string): Promise<void> {
    const shouldPrefetch = this.options.prefetchOnStore !== false;
    if (!shouldPrefetch) return;

    const base = (this.options.publicGatewayPrefetchUrl || 'https://ipfs.ela.city/ipfs/').replace(/\/+$/, '/');
    const url = `${base}${encodeURIComponent(cid)}`;

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(15_000),
      });
      log.debug(`[IPFS] Public gateway prefetch: ${cid} -> HTTP ${response.status}`);
    } catch (error: any) {
      log.debug(`[IPFS] Public gateway prefetch failed for ${cid}: ${error?.message || 'unknown error'}`);
    }
  }

  /**
   * Retrieve file content from IPFS using CID.
   *
   * For callers that can consume an async stream instead of a full Buffer,
   * prefer {@link getFileStream} — it keeps memory proportional to one IPFS
   * chunk (~256 KB) rather than the entire file.
   */
  async getFile(cid: string): Promise<Buffer> {
    if (!this.blockstore) {
      throw new Error('Blockstore not initialized');
    }

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — guard against Helia iterator hangs
    const LARGE_FILE_WARN_BYTES = 100 * 1024 * 1024; // 100 MB

    try {
      const { CID } = await import('multiformats/cid');
      const cidObj = CID.parse(cid);

      // IMPORTANT: Use the underlying FsBlockstore directly, not helia.blockstore (IdentityBlockstore wrapper)
      const { exporter } = await import('ipfs-unixfs-exporter');

      const entry = await exporter(cidObj, this.blockstore);

      if (!entry) {
        throw new Error(`Entry not found for CID: ${cid}`);
      }

      if (entry.type !== 'file' && entry.type !== 'raw') {
        throw new Error(`CID ${cid} is not a file (type: ${entry.type})`);
      }

      // Single-pass assembly: collect chunks and concat once.
      // Previous implementation allocated an intermediate chunks[] array, then a
      // second full-size Buffer, and copied every byte a second time. This version
      // hands the chunks directly to Buffer.concat which does one allocation.
      const pieces: Buffer[] = [];
      let totalLength = 0;

      const contentPromise = (async () => {
        for await (const chunk of entry.content()) {
          pieces.push(Buffer.from(chunk));
          totalLength += chunk.length;
        }
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`IPFS getFile timed out after ${TIMEOUT_MS / 1000}s for CID: ${cid}`)), TIMEOUT_MS);
      });

      await Promise.race([contentPromise, timeoutPromise]);

      if (pieces.length === 0) {
        throw new Error(`File content is empty for CID: ${cid}`);
      }

      log.debug(`[IPFS] Retrieved ${pieces.length} chunks, total size: ${totalLength} bytes for CID: ${cid}`);

      if (totalLength >= LARGE_FILE_WARN_BYTES) {
        log.warn(`[IPFS] getFile() fetching ${(totalLength / (1024 * 1024)).toFixed(1)}MB for CID: ${cid}.`);
      }

      // For files above threshold, assemble in Rust/WASM to keep chunk data
      // out of V8's GC-tracked heap. Only the final Buffer lives in Node.js.
      if (totalLength >= WASM_ASSEMBLE_THRESHOLD) {
        try {
          const { getWASMRuntime } = await import('../services/wasm/WASMRuntime.js');
          const runtime = getWASMRuntime();

          if (!cachedAssembleWasm) {
            cachedAssembleWasm = await runtime.loadFromFile(IPFS_ASSEMBLE_WASM_PATH);
            log.info(`[IPFS] Loaded ipfs-assemble WASM (${(cachedAssembleWasm.byteLength / 1024).toFixed(0)} KB)`);
          }

          const result = await runtime.executeIPFSAssemble(cachedAssembleWasm, pieces, totalLength, {
            timeoutMs: 120000,
          });

          if (result.success && result.assembled) {
            log.info(`[IPFS] WASM assembled ${(totalLength / (1024 * 1024)).toFixed(1)}MB in ${result.executionTimeMs}ms for CID: ${cid}`);
            return result.assembled;
          }

          log.warn(`[IPFS] WASM assemble failed (${result.error}), falling back to Buffer.concat for CID: ${cid}`);
        } catch (wasmErr) {
          log.warn(`[IPFS] WASM assembler unavailable (${wasmErr instanceof Error ? wasmErr.message : 'unknown'}), falling back to Buffer.concat for CID: ${cid}`);
        }
      }

      return Buffer.concat(pieces, totalLength);
    } catch (error) {
      log.error(`Error retrieving file from Helia IPFS (CID: ${cid}):`, error);
      throw new Error(`Failed to retrieve file from IPFS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get file size from IPFS without loading any content into memory.
   * Uses the exporter's entry.size which reads only the DAG metadata.
   */
  async inspectCID(cidString: string): Promise<{
    cid: string;
    size: number;
    type: 'file' | 'raw' | 'directory';
  }> {
    if (!this.blockstore) {
      throw new Error('Blockstore not initialized');
    }

    const { CID } = await import('multiformats/cid');
    const cidObj = CID.parse(cidString);
    const { exporter } = await import('ipfs-unixfs-exporter');

    const entry = await exporter(cidObj, this.blockstore);
    if (!entry) {
      throw new Error(`Entry not found for CID: ${cidString}`);
    }

    const type = entry.type as 'file' | 'raw' | 'directory';
    return {
      cid: entry.cid.toString(),
      size: Number(entry.size || 0),
      type,
    };
  }

  /**
   * Get file size from IPFS without loading any content into memory.
   * Uses the exporter's entry.size which reads only the DAG metadata.
   */
  async getFileSize(cid: string): Promise<number> {
    if (!this.blockstore) {
      throw new Error('Blockstore not initialized');
    }

    const { CID } = await import('multiformats/cid');
    const cidObj = CID.parse(cid);
    const { exporter } = await import('ipfs-unixfs-exporter');

    const entry = await exporter(cidObj, this.blockstore);
    if (!entry) {
      throw new Error(`Entry not found for CID: ${cid}`);
    }
    if (entry.type !== 'file' && entry.type !== 'raw') {
      throw new Error(`CID ${cid} is not a file (type: ${entry.type})`);
    }

    return Number(entry.size);
  }

  /**
   * List entries in an IPFS directory.
   * Returns array of { name, cid, size, type } for each entry.
   */
  async listDirectory(cidString: string): Promise<Array<{ name: string; cid: string; size: number; type: string }>> {
    const fs = this.getUnixFS();
    const { CID } = await import('multiformats/cid');
    const cid = CID.parse(cidString);
    const entries: Array<{ name: string; cid: string; size: number; type: string }> = [];

    for await (const entry of fs.ls(cid)) {
      entries.push({
        name: entry.name,
        cid: entry.cid.toString(),
        size: Number(entry.size || 0),
        type: entry.type,
      });
    }

    return entries;
  }

  /**
   * Stream file content from IPFS with optional byte-range support.
   * Only reads the requested bytes from the blockstore -- memory usage is
   * proportional to the chunk size (~256 KB), not the file size.
   */
  async *getFileStream(cid: string, options?: {
    offset?: number;
    length?: number;
  }): AsyncGenerator<Uint8Array> {
    if (!this.blockstore) {
      throw new Error('Blockstore not initialized');
    }

    const { CID } = await import('multiformats/cid');
    const cidObj = CID.parse(cid);
    const { exporter } = await import('ipfs-unixfs-exporter');

    const entry = await exporter(cidObj, this.blockstore);
    if (!entry) {
      throw new Error(`Entry not found for CID: ${cid}`);
    }
    if (entry.type !== 'file' && entry.type !== 'raw') {
      throw new Error(`CID ${cid} is not a file (type: ${entry.type})`);
    }

    yield* entry.content({
      offset: options?.offset,
      length: options?.length,
    });
  }

  /**
   * Resolve a sub-path within a UnixFS DAG directory.
   * e.g. resolveDAGPath("QmRoot", "video/seg-1.m4s") traverses the directory to
   * find and return the file entry.  Returns null when the root CID is not a
   * directory or the sub-path does not exist.
   */
  async resolveDAGPath(rootCid: string, subPath: string): Promise<{
    cid: string;
    size: number;
    type: 'file' | 'raw' | 'directory';
  } | null> {
    if (!this.blockstore) {
      throw new Error('Blockstore not initialized');
    }

    const { exporter } = await import('ipfs-unixfs-exporter');
    const fullPath = `${rootCid}/${subPath}`;

    try {
      const entry = await exporter(fullPath, this.blockstore);
      if (!entry) return null;

      return {
        cid: entry.cid.toString(),
        size: Number(entry.size),
        type: entry.type as 'file' | 'raw' | 'directory',
      };
    } catch {
      return null;
    }
  }

  /**
   * Stream content from a sub-path within a UnixFS DAG directory.
   * Uses the exporter's native path resolution to traverse the directory.
   */
  async *getDAGFileStream(rootCid: string, subPath: string, options?: {
    offset?: number;
    length?: number;
  }): AsyncGenerator<Uint8Array> {
    if (!this.blockstore) {
      throw new Error('Blockstore not initialized');
    }

    const { exporter } = await import('ipfs-unixfs-exporter');
    const fullPath = `${rootCid}/${subPath}`;

    const entry = await exporter(fullPath, this.blockstore);
    if (!entry) {
      throw new Error(`Path not found: ${fullPath}`);
    }
    if (entry.type !== 'file' && entry.type !== 'raw') {
      throw new Error(`Path ${fullPath} is not a file (type: ${entry.type})`);
    }

    yield* entry.content({
      offset: options?.offset,
      length: options?.length,
    });
  }

  /**
   * Check if a CID exists in IPFS
   */
  async fileExists(cid: string): Promise<boolean> {
    const helia = this.getHelia();

    try {
      // Import CID and try to get the block
      const { CID } = await import('multiformats/cid');
      const cidObj = CID.parse(cid);

      // Try to get the block - if it exists, this will succeed
      await helia.blockstore.get(cidObj);
      return true;
    } catch (error) {
      // If get fails, block doesn't exist
      return false;
    }
  }

  /**
   * Pin a file (prevent garbage collection)
   */
  async pinFile(cid: string): Promise<void> {
    const helia = this.getHelia();

    try {
      // Import CID
      const { CID } = await import('multiformats/cid');
      const cidObj = CID.parse(cid);

      // Helia pins are managed through the blockstore
      // For now, we'll just ensure the block is in the blockstore
      // (which it should be if we just added it)
      // In the future, we can use @helia/remote-pinning for proper pinning
      await helia.blockstore.get(cidObj);
    } catch (error) {
      log.error(`Error pinning file (CID: ${cid}):`, error);
      throw new Error(`Failed to pin file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Unpin a file (allow garbage collection)
   */
  async unpinFile(cid: string): Promise<void> {
    // In Helia, unpinning is typically handled by garbage collection
    // For now, we'll just log - actual unpinning would require
    // tracking pinned CIDs separately or using @helia/remote-pinning
    log.debug(`Unpinning file (CID: ${cid}) - GC will handle cleanup`);
  }

  /**
   * Error types for remote pinning operations
   */
  static readonly PinErrorType = {
    PRIVATE_MODE: 'PRIVATE_MODE',
    INVALID_CID: 'INVALID_CID',
    TIMEOUT: 'TIMEOUT',
    NOT_FOUND: 'NOT_FOUND',
    NETWORK_ERROR: 'NETWORK_ERROR',
    DIRECTORY_TOO_LARGE: 'DIRECTORY_TOO_LARGE',
  } as const;

  /**
   * Pin a remote CID from the IPFS network
   * Fetches content from other nodes and stores locally
   * Handles both files and directories with timeout support
   * Used for marketplace purchases and network participation
   * 
   * @param cidString - The CID to fetch and pin
   * @param options - Optional configuration
   * @param options.timeoutMs - Timeout in milliseconds (default: 60000)
   * @param options.maxFiles - Maximum files to fetch for directories (default: 1000)
   */
  async pinRemoteCID(cidString: string, options?: {
    timeoutMs?: number;
    maxFiles?: number;
  }): Promise<{
    success: boolean;
    cid: string;
    type: 'file' | 'directory' | 'raw';
    size: number;
    files?: number;
    timeMs: number;
    content?: Uint8Array; // Content bytes when fetched via gateway
    actualCid?: string; // Actual CID in local store (may differ due to v0/v1)
  }> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 60000; // 60 second default
    const maxFiles = options?.maxFiles ?? 1000;

    if (this.networkMode === 'private') {
      throw Object.assign(
        new Error('Remote pinning requires public or hybrid network mode'),
        { type: IPFSStorage.PinErrorType.PRIVATE_MODE }
      );
    }

    const fs = this.getUnixFS();

    // Parse CID
    let cid: any;
    try {
      const { CID } = await import('multiformats/cid');
      cid = CID.parse(cidString);
    } catch (error) {
      throw Object.assign(
        new Error(`Invalid CID format: ${cidString}`),
        { type: IPFSStorage.PinErrorType.INVALID_CID }
      );
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      log.debug(`[IPFS] Fetching remote CID from network: ${cidString} (timeout: ${timeoutMs}ms)`);

      // Helper to wrap operations with timeout check
      const checkAbort = () => {
        if (controller.signal.aborted) {
          throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        }
      };

      // Check if the original CID's root block exists in the local blockstore
      const hasRootBlock = this.blockstore ? await this.blockstore.has(cid) : false;

      if (hasRootBlock) {
        // Root block exists locally. For content uploaded by our own encoder,
        // all blocks are already in the blockstore — skip expensive traversal.
        const quickLocalTimeoutMs = 10000;
        try {
          log.info(`[IPFS] Root block exists locally for ${cidString}, trying local resolve...`);

          // Try to detect content type via exporter (fast, reads only root node)
          const { exporter } = await import('ipfs-unixfs-exporter');
          const entryPromise = exporter(cid, this.blockstore!);
          const entryTimeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), quickLocalTimeoutMs)
          );
          const entry = await Promise.race([entryPromise, entryTimeout]);

          if (entry) {
            if (entry.type === 'directory') {
              // Directory is fully local — count files from listing
              let dirFileCount = 0;
              let dirTotalSize = 0;
              try {
                for await (const child of entry.content()) {
                  // directory content() yields child entries
                  dirFileCount++;
                  dirTotalSize += Number((child as any).size || 0);
                }
              } catch {
                // content() may not work for directories; use ls instead with short timeout
                try {
                  const lsTimeout = new Promise<void>((resolve) => setTimeout(resolve, quickLocalTimeoutMs));
                  const lsWork = (async () => {
                    const fs = this.getUnixFS();
                    for await (const child of fs.ls(cid)) {
                      dirFileCount++;
                      dirTotalSize += Number(child.size || 0);
                    }
                  })();
                  await Promise.race([lsWork, lsTimeout]);
                } catch {
                  // If ls also fails, just report what we know
                }
              }

              const timeMs = Date.now() - startTime;
              log.info(`[IPFS] ✅ Local directory confirmed: ${cidString} (${dirTotalSize} bytes, ${dirFileCount} files, ${timeMs}ms)`);
              return {
                success: true,
                cid: cidString,
                type: 'directory' as const,
                size: dirTotalSize,
                files: dirFileCount || 1,
                timeMs,
              };
            }

            // File or raw: read content
            if (entry.type === 'file' || entry.type === 'raw') {
              const chunks: Uint8Array[] = [];
              let totalSize = 0;
              const catPromise = (async () => {
                for await (const chunk of entry.content()) {
                  chunks.push(chunk);
                  totalSize += chunk.length;
                  checkAbort();
                }
                return chunks;
              })();
              const catTimeout = new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), quickLocalTimeoutMs)
              );
              const result = await Promise.race([catPromise, catTimeout]);

              if (result && chunks.length > 0) {
                const combined = new Uint8Array(totalSize);
                let offset = 0;
                for (const chunk of chunks) {
                  combined.set(chunk, offset);
                  offset += chunk.length;
                }
                log.info(`[IPFS] ✅ Found locally: ${cidString} (${totalSize} bytes)`);
                const timeMs = Date.now() - startTime;
                return {
                  success: true,
                  cid: cidString,
                  type: 'file' as const,
                  size: totalSize,
                  timeMs,
                  content: combined,
                  actualCid: cidString
                };
              }
            }
          }
        } catch (localError: any) {
          log.info(`[IPFS] Quick local fetch failed for ${cidString}: ${localError.message}`);
        }
      } else {
        log.debug(`[IPFS] Root block not in blockstore for ${cidString}, skipping local fetch`);
      }

      // Phase 2: Try Bitswap — ask DHT peers for the content before gateways
      if (this.canAnnounce()) {
        try {
          const bitswapResult = await this.fetchViaBitswap(cid, cidString, fs, checkAbort);
          if (bitswapResult) {
            const timeMs = Date.now() - startTime;
            return { ...bitswapResult, timeMs };
          }
        } catch (bitswapError: any) {
          log.debug(`[IPFS] Bitswap fetch failed: ${bitswapError.message}`);
        }
      }

      // Fetch via gateway — CAR import preserves original CID block structure
      log.debug(`[IPFS] Fetching via gateway (CAR preferred) for ${cidString}...`);
      try {
        const gatewayResult = await this.fetchViaGateway(cidString, timeoutMs - (Date.now() - startTime));
        if (gatewayResult.success) {
          const timeMs = Date.now() - startTime;
          log.debug(`[IPFS] ✅ Fetched via gateway: ${cidString} (${gatewayResult.size} bytes, ${gatewayResult.blockCount || 1} blocks, ${timeMs}ms)`);
          return {
            success: true,
            cid: cidString,
            type: 'file' as const,
            size: gatewayResult.size,
            timeMs,
            content: gatewayResult.content,
            actualCid: gatewayResult.actualCid
          };
        }
      } catch (gatewayError: any) {
        log.debug(`[IPFS] Gateway fetch failed: ${gatewayError.message}`);
      }

      // Last resort: try stat + cat with remaining timeout (for directories or special cases)
      const statTimeoutMs = Math.min(timeoutMs - (Date.now() - startTime), 45000);
      let stats: any;

      try {
        checkAbort();
        log.debug(`[IPFS] Trying DHT stat for ${cidString}...`);

        const statPromise = fs.stat(cid);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('stat_timeout')), statTimeoutMs)
        );

        stats = await Promise.race([statPromise, timeoutPromise]);
        log.debug(`[IPFS] CID type: ${stats.type}`);
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.debug(`[IPFS] DHT stat failed: ${errorMsg}`);

        throw Object.assign(
          new Error(`Content not found: Could not retrieve from local cache, gateways, or DHT`),
          { type: IPFSStorage.PinErrorType.NOT_FOUND }
        );
      }

      let totalSize = 0;
      let fileCount = 0;

      if (stats.type === 'directory') {
        // Handle directory: recursively fetch all files
        log.debug(`[IPFS] Fetching directory contents...`);
        const result = await this.fetchDirectoryRecursive(fs, cid, controller.signal, maxFiles, 0);
        totalSize = result.size;
        fileCount = result.files;

        if (result.truncated) {
          log.warn(`[IPFS] ⚠️ Directory fetch truncated at ${maxFiles} files`);
        }

        log.debug(`[IPFS] ✅ Pinned remote directory: ${cidString} (${fileCount} files, ${totalSize} bytes)`);
      } else {
        // Handle file or raw: use cat() without signal
        const chunks: Uint8Array[] = [];

        for await (const chunk of fs.cat(cid)) {
          chunks.push(chunk);
          totalSize += chunk.length;
          checkAbort(); // Check abort between chunks
        }

        fileCount = 1;
        log.debug(`[IPFS] ✅ Pinned remote file: ${cidString} (${totalSize} bytes, ${chunks.length} chunks)`);
      }

      const timeMs = Date.now() - startTime;

      return {
        success: true,
        cid: cidString,
        type: stats.type,
        size: totalSize,
        files: stats.type === 'directory' ? fileCount : undefined,
        timeMs
      };
    } catch (error: any) {
      // Re-throw typed errors as-is
      if (error.type) {
        // Try gateway fallback for NOT_FOUND and NETWORK_ERROR
        if (error.type === IPFSStorage.PinErrorType.NOT_FOUND ||
          error.type === IPFSStorage.PinErrorType.NETWORK_ERROR) {
          log.debug(`[IPFS] DHT fetch failed, trying gateway fallback...`);
          try {
            const gatewayResult = await this.fetchViaGateway(cidString, timeoutMs - (Date.now() - startTime));
            if (gatewayResult.success) {
              const timeMs = Date.now() - startTime;
              return {
                success: true,
                cid: cidString,
                type: 'file' as const,
                size: gatewayResult.size,
                timeMs,
                content: gatewayResult.content,
                actualCid: gatewayResult.actualCid
              };
            }
          } catch (gatewayError: any) {
            log.debug(`[IPFS] Gateway fallback also failed: ${gatewayError.message}`);
          }
        }
        throw error;
      }

      // Handle abort/timeout
      if (error.name === 'AbortError' || controller.signal.aborted) {
        throw Object.assign(
          new Error(`Timeout: Could not fetch content within ${timeoutMs / 1000}s`),
          { type: IPFSStorage.PinErrorType.TIMEOUT }
        );
      }

      // Handle other errors - try gateway fallback
      log.error(`[IPFS] Failed to pin remote CID ${cidString}:`, error);
      log.debug(`[IPFS] Trying gateway fallback...`);

      try {
        const gatewayResult = await this.fetchViaGateway(cidString, timeoutMs - (Date.now() - startTime));
        if (gatewayResult.success) {
          const timeMs = Date.now() - startTime;
          return {
            success: true,
            cid: cidString,
            type: 'file' as const,
            size: gatewayResult.size,
            timeMs,
            content: gatewayResult.content,
            actualCid: gatewayResult.actualCid
          };
        }
      } catch (gatewayError: any) {
        log.debug(`[IPFS] Gateway fallback also failed: ${gatewayError.message}`);
      }

      throw Object.assign(
        new Error(`Network error: ${error instanceof Error ? error.message : 'Unknown error'}`),
        { type: IPFSStorage.PinErrorType.NETWORK_ERROR }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch content via public IPFS gateway and add to local node
   * Used as fallback when DHT fetching fails
   * @private
   */
  private async fetchViaGateway(cidString: string, remainingTimeoutMs: number): Promise<{
    success: boolean;
    size: number;
    content?: Uint8Array;
    actualCid?: string;
    blockCount?: number;
  }> {
    const GATEWAYS = [
      'https://ipfs.ela.city/ipfs/',
      'https://ipfs.io/ipfs/',
      'https://dweb.link/ipfs/',
      'https://w3s.link/ipfs/',
      'https://nftstorage.link/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://4everland.io/ipfs/',
      'https://cloudflare-ipfs.com/ipfs/',
    ];

    const helia = this.helia!;
    const fs = this.getUnixFS();
    const timeoutMs = Math.max(remainingTimeoutMs, 120000);

    // Phase 1: Try CAR import from gateways that support ?format=car
    // This handles both files AND directories in one request
    for (const gateway of GATEWAYS) {
      try {
        const carUrl = `${gateway}${cidString}?format=car`;
        log.debug(`[IPFS] Trying CAR import: ${carUrl}`);

        const response = await fetch(carUrl, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Accept': 'application/vnd.ipld.car' },
        });

        if (!response.ok) {
          log.debug(`[IPFS] Gateway ${gateway} CAR returned ${response.status}`);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('car') && !contentType.includes('octet-stream')) {
          log.debug(`[IPFS] Gateway ${gateway} returned ${contentType}, not CAR`);
          continue;
        }

        const carBytes = new Uint8Array(await response.arrayBuffer());
        log.debug(`[IPFS] Downloaded CAR: ${carBytes.length} bytes from ${gateway}`);

        const { CarReader } = await import('@ipld/car');
        const reader = await CarReader.fromBytes(carBytes);

        let blockCount = 0;
        let totalSize = 0;
        for await (const { cid, bytes } of reader.blocks()) {
          await helia.blockstore.put(cid, bytes);
          blockCount++;
          totalSize += bytes.length;
        }

        log.info(`[IPFS] ✅ CAR imported: ${blockCount} blocks, ${totalSize} bytes for ${cidString}`);

        return {
          success: true,
          size: totalSize,
          actualCid: cidString,
          blockCount,
        };
      } catch (error: any) {
        const errMsg = error.message || 'Unknown error';
        if (errMsg.includes('timeout') || errMsg.includes('abort')) {
          log.debug(`[IPFS] Gateway ${gateway} CAR timed out`);
        } else {
          log.debug(`[IPFS] Gateway ${gateway} CAR failed: ${errMsg.substring(0, 100)}`);
        }
        continue;
      }
    }

    // Phase 2: Try raw file fetch (only for non-directory CIDs)
    for (const gateway of GATEWAYS) {
      try {
        log.debug(`[IPFS] Trying raw fetch: ${gateway}${cidString}`);

        const response = await fetch(`${gateway}${cidString}`, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
          headers: { 'Accept': 'application/octet-stream, */*' },
        });

        if (!response.ok) {
          log.debug(`[IPFS] Gateway ${gateway} returned ${response.status}`);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          log.debug(`[IPFS] Gateway ${gateway} returned HTML (likely directory listing), skipping`);
          continue;
        }

        const buffer = await response.arrayBuffer();
        const content = new Uint8Array(buffer);

        log.debug(`[IPFS] ✅ Fetched ${content.length} bytes from gateway ${gateway}`);

        const addedCid = await fs.addBytes(content);
        log.debug(`[IPFS] ✅ Added to local IPFS: ${addedCid.toString()}`);

        return {
          success: true,
          size: content.length,
          content,
          actualCid: addedCid.toString()
        };
      } catch (error: any) {
        const errMsg = error.message || 'Unknown error';
        if (errMsg.includes('timeout') || errMsg.includes('abort')) {
          log.debug(`[IPFS] Gateway ${gateway} timed out`);
        } else {
          log.debug(`[IPFS] Gateway ${gateway} failed: ${errMsg.substring(0, 100)}`);
        }
        continue;
      }
    }

    throw new Error('All gateways failed after retries');
  }

  private static readonly BITSWAP_PEER_DISCOVERY_TIMEOUT_MS = 10_000;
  private static readonly BITSWAP_FETCH_TIMEOUT_MS = 30_000;

  /**
   * Try to fetch content directly from peers via Bitswap (DHT findProviders + fs.cat).
   * Returns null if no peers have the content or fetch fails within timeout.
   * @private
   */
  private async fetchViaBitswap(
    cid: any,
    cidString: string,
    fs: UnixFS,
    checkAbort: () => void
  ): Promise<{
    success: boolean;
    cid: string;
    type: 'file';
    size: number;
    content: Uint8Array;
    actualCid: string;
  } | null> {
    const dht = (this.helia!.libp2p.services as any).dht;
    if (!dht) return null;

    log.debug(`[IPFS] Bitswap: searching for providers of ${cidString}...`);

    let providerCount = 0;
    const discoveryTimeout = AbortSignal.timeout(IPFSStorage.BITSWAP_PEER_DISCOVERY_TIMEOUT_MS);

    try {
      for await (const event of dht.findProviders(cid, { signal: discoveryTimeout })) {
        if (event.name === 'PROVIDER') {
          providerCount += event.providers.length;
          for (const provider of event.providers) {
            log.debug(`[IPFS] Bitswap: found provider ${provider.id.toString()}`);
          }
        }
        if (providerCount > 0) break;
      }
    } catch (e: any) {
      if (!e.message?.includes('abort') && !e.message?.includes('timeout')) {
        log.debug(`[IPFS] Bitswap: findProviders error: ${e.message}`);
      }
    }

    if (providerCount === 0) {
      log.debug(`[IPFS] Bitswap: no providers found for ${cidString}`);
      return null;
    }

    log.debug(`[IPFS] Bitswap: ${providerCount} provider(s) found, fetching via fs.cat...`);

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const fetchTimeout = AbortSignal.timeout(IPFSStorage.BITSWAP_FETCH_TIMEOUT_MS);

    const catPromise = (async () => {
      for await (const chunk of fs.cat(cid, { signal: fetchTimeout })) {
        chunks.push(chunk);
        totalSize += chunk.length;
        checkAbort();
      }
    })();

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), IPFSStorage.BITSWAP_FETCH_TIMEOUT_MS)
    );

    const result = await Promise.race([catPromise, timeoutPromise]);
    if (result === null && chunks.length === 0) {
      log.debug(`[IPFS] Bitswap: fetch timed out for ${cidString}`);
      return null;
    }

    if (totalSize === 0) return null;

    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    log.info(`[IPFS] ✅ Bitswap: fetched ${cidString} from peers (${totalSize} bytes)`);

    return {
      success: true,
      cid: cidString,
      type: 'file' as const,
      size: totalSize,
      content: combined,
      actualCid: cidString,
    };
  }

  /**
   * Recursively fetch all files in a directory
   * Note: Signal checking is done manually to work around Helia async iterator issues
   * @private
   */
  private async fetchDirectoryRecursive(
    fs: UnixFS,
    cid: any,
    signal: AbortSignal,
    maxFiles: number,
    currentCount: number
  ): Promise<{ size: number; files: number; truncated: boolean }> {
    let totalSize = 0;
    let fileCount = 0;
    let truncated = false;

    if (signal.aborted) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }

    for await (const entry of fs.ls(cid)) {
      if (signal.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }

      if (currentCount + fileCount >= maxFiles) {
        truncated = true;
        break;
      }

      if (entry.type === 'directory') {
        const subResult = await this.fetchDirectoryRecursive(
          fs,
          entry.cid,
          signal,
          maxFiles,
          currentCount + fileCount
        );
        totalSize += subResult.size;
        fileCount += subResult.files;
        truncated = truncated || subResult.truncated;
      } else {
        // Use size from directory metadata when available (avoids reading all bytes)
        const entrySize = Number(entry.size || 0);
        if (entrySize > 0) {
          totalSize += entrySize;
        } else {
          // Fallback: read content to determine size (remote fetch case)
          for await (const chunk of fs.cat(entry.cid)) {
            totalSize += chunk.length;
            if (signal.aborted) {
              throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            }
          }
        }
        fileCount++;
      }
    }

    return { size: totalSize, files: fileCount, truncated };
  }

  /**
   * List all connected peers
   */
  async getConnectedPeers(): Promise<string[]> {
    if (!this.helia || !this.isInitialized) {
      return [];
    }

    const connections = this.helia.libp2p.getConnections();
    return connections.map(conn => conn.remotePeer.toString());
  }

  /**
   * Get network statistics
   */
  async getNetworkStats(): Promise<{
    mode: IPFSNetworkMode;
    peerId: string | null;
    connectedPeers: number;
    addresses: string[];
  }> {
    return {
      mode: this.networkMode,
      peerId: this.getNodeId(),
      connectedPeers: this.helia ? this.helia.libp2p.getConnections().length : 0,
      addresses: this.getMultiaddrs()
    };
  }

  /**
   * Get IPFS node information
   */
  async getNodeInfo(): Promise<{
    id: string;
    addresses: string[];
    agentVersion: string;
    protocolVersion: string;
  }> {
    const helia = this.getHelia();
    const peerId = helia.libp2p.peerId;
    const addresses = helia.libp2p.getMultiaddrs();

    return {
      id: peerId.toString(),
      addresses: addresses.map(addr => addr.toString()),
      agentVersion: 'helia',
      protocolVersion: '1.0'
    };
  }

  /**
   * Get node peer ID (short form for display)
   */
  getNodeId(): string | null {
    if (!this.helia || !this.isInitialized) {
      return null;
    }
    return this.helia.libp2p.peerId.toString();
  }

  /**
   * Get multiaddresses for this node
   */
  getMultiaddrs(): string[] {
    if (!this.helia || !this.isInitialized) {
      return [];
    }
    return this.helia.libp2p.getMultiaddrs().map(addr => addr.toString());
  }

  // ============================================================================
  // DHT Announcement Methods (for IPFS Public Folder Sharing)
  // ============================================================================

  /**
   * Announce a single CID to the DHT network
   * This makes the CID discoverable by other IPFS nodes
   */
  async announceCID(cid: string): Promise<boolean> {
    if (this.networkMode === 'private') {
      log.debug(`[IPFS] Skipping DHT announcement (private mode): ${cid}`);
      return false;
    }

    if (!this.helia || !this.isInitialized) {
      log.warn(`[IPFS] Cannot announce CID - IPFS not initialized`);
      return false;
    }

    try {
      const dht = (this.helia.libp2p.services as any).dht;
      if (!dht) {
        log.warn(`[IPFS] DHT service not available`);
        return false;
      }

      const { CID } = await import('multiformats/cid');
      const cidObj = CID.parse(cid);

      log.debug(`[IPFS] Announcing CID to DHT: ${cid}`);

      // Use the DHT provide method to announce we have this content
      await dht.provide(cidObj);

      log.debug(`[IPFS] ✅ Successfully announced CID to DHT: ${cid}`);
      return true;
    } catch (error) {
      log.error(`[IPFS] Failed to announce CID ${cid}:`, error);
      return false;
    }
  }

  /**
   * Announce multiple CIDs to the DHT network
   * Used for batch announcement of public files
   */
  async announceMultipleCIDs(cids: string[]): Promise<{ success: number; failed: number }> {
    if (this.networkMode === 'private') {
      log.debug(`[IPFS] Skipping batch DHT announcement (private mode)`);
      return { success: 0, failed: 0 };
    }

    let success = 0;
    let failed = 0;

    log.debug(`[IPFS] Starting batch announcement of ${cids.length} CIDs...`);

    for (const cid of cids) {
      try {
        const announced = await this.announceCID(cid);
        if (announced) {
          success++;
        } else {
          failed++;
        }
        // Small delay between announcements to avoid overwhelming DHT
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failed++;
        log.error(`[IPFS] Failed to announce CID ${cid}:`, error);
      }
    }

    log.info(`[IPFS] Batch announcement complete: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  /**
   * Get DHT announcement statistics
   */
  getAnnouncementStats(): {
    mode: IPFSNetworkMode;
    dhtEnabled: boolean;
    canAnnounce: boolean;
    connectedPeers: number;
  } {
    const dhtEnabled = this.networkMode !== 'private' &&
      this.helia !== null &&
      (this.helia.libp2p.services as any).dht !== undefined;

    return {
      mode: this.networkMode,
      dhtEnabled,
      canAnnounce: dhtEnabled && this.isInitialized,
      connectedPeers: this.helia ? this.helia.libp2p.getConnections().length : 0
    };
  }

  /**
   * Check if DHT is available for announcements
   */
  canAnnounce(): boolean {
    return this.networkMode !== 'private' &&
      this.isInitialized &&
      this.helia !== null &&
      (this.helia.libp2p.services as any).dht !== undefined;
  }

  /**
   * Count DHT providers for a CID without fetching content.
   * Returns the number of peers advertising they have this content.
   * Times out after the specified duration (default 8s).
   */
  async countProviders(cidString: string, timeoutMs = 8000): Promise<number> {
    if (!this.canAnnounce()) return -1;

    try {
      const { CID } = await import('multiformats/cid');
      const cidObj = CID.parse(cidString);
      const dht = (this.helia!.libp2p.services as any).dht;
      if (!dht) return -1;

      let count = 0;
      const signal = AbortSignal.timeout(timeoutMs);

      for await (const event of dht.findProviders(cidObj, { signal })) {
        if (event.name === 'PROVIDER') {
          count += event.providers.length;
        }
      }
      return count;
    } catch (e: any) {
      if (e.message?.includes('abort') || e.message?.includes('timeout')) {
        return 0;
      }
      log.debug(`[IPFS] countProviders error for ${cidString}: ${e.message}`);
      return -1;
    }
  }

  /**
   * Stop IPFS node gracefully
   */
  async stop(): Promise<void> {
    if (this.bootstrapReconnectTimer) {
      clearTimeout(this.bootstrapReconnectTimer);
      this.bootstrapReconnectTimer = null;
    }
    if (this.helia && this.isInitialized) {
      try {
        log.info('🛑 Stopping Helia IPFS node...');
        await this.helia.stop();
        this.helia = null;
        this.fs = null;
        this.isInitialized = false;
        log.info('✅ Helia IPFS node stopped');
      } catch (error) {
        log.error('Error stopping Helia IPFS node:', error);
        throw error;
      }
    }
  }

  /**
   * Check if IPFS is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.helia !== null;
  }

  private normalizeBootstrapAddr(addr: string): string {
    // Accept legacy /ipfs/<peerId> by normalizing to /p2p/<peerId>
    return addr.replace('/ipfs/', '/p2p/');
  }

  private async connectBootstrapPeers(peers: string[], phase: 'initial' | 'post-init'): Promise<void> {
    if (!this.helia || !this.isInitialized || !peers.length) return;

    const uniquePeers = Array.from(new Set(peers.map((p) => this.normalizeBootstrapAddr(p))));
    log.info(`[IPFS] Bootstrap dial (${phase}): attempting ${uniquePeers.length} peers`);

    let connected = 0;
    const dialTasks = uniquePeers.map(async (peerAddr) => {
      try {
        await (this.helia!.libp2p as any).dial(peerAddr);
        connected += 1;
        log.debug(`[IPFS] Bootstrap dial ok (${phase}): ${peerAddr}`);
      } catch (error: any) {
        log.debug(`[IPFS] Bootstrap dial failed (${phase}) ${peerAddr}: ${error?.message || 'unknown error'}`);
      }
    });

    await Promise.all(dialTasks);
    log.info(`[IPFS] Bootstrap dial (${phase}) complete: ${connected}/${uniquePeers.length} connected`);
  }
}
