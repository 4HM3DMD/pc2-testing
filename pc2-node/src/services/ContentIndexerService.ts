/**
 * ContentIndexerService
 *
 * Scans Base chain for Elacity content events (ChannelCreated, DigitalAssetRegistered)
 * and builds a local content catalog in SQLite. This replaces the dependency on
 * Elacity's centralized GraphQL API for content discovery.
 *
 * Design: versioned contract support — when v3 contracts deploy, add a new entry
 * to config.content_indexer.contracts and the indexer picks them up automatically.
 */

import { createLogger } from '../utils/logger.js';
import type { Config } from '../config/loader.js';
import type { DatabaseManager, ContentCatalogItem } from '../storage/database.js';
import type { IPFSStorage } from '../storage/ipfs.js';

const log = createLogger('content-indexer');

interface IndexerConfig {
  enabled: boolean;
  scanIntervalMinutes: number;
  rpcUrls: string[];
  maxBlocksPerScan: number;
  metadataFetchConcurrency: number;
  metadataGatewayUrls: string[];
  contracts: Record<string, ContractVersionConfig>;
}

interface ContractVersionConfig {
  channelFactory?: string;
  centralStorage?: string;
  authorityGateway?: string;
  eventHub?: string;
  fromBlock: number;
}

// V3 precomputed keccak256 topic hashes
const TOPICS = {
  ChannelCreated: '0x4ae6ef95ddade103ca67593cd4cf68dda177aa1054ad4eeb4963d2c3df44702e',
  DigitalAssetRegistered: '0x1b24f7763272894608506beba5887c374d345cd231bf52bd03f40bc2d0508d7b',
} as const;

const TOKEN_URI_SELECTOR = '0xc87b56dd';

function toHex(n: number): string {
  return '0x' + n.toString(16);
}

function fromHex(hex: string): number {
  return parseInt(hex, 16);
}

function padAddress(hex: string): string {
  const clean = hex.toLowerCase().replace('0x', '');
  return '0x' + clean.padStart(64, '0');
}

function unpadAddress(hex: string): string {
  return '0x' + hex.slice(-40);
}

function padUint256(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

function decodeAbiString(hex: string): string {
  const clean = hex.replace('0x', '');
  if (clean.length < 128) return '';
  const offset = fromHex(clean.slice(0, 64));
  const dataStart = offset * 2;
  if (dataStart + 64 > clean.length) return '';
  const length = fromHex(clean.slice(dataStart, dataStart + 64));
  const strHex = clean.slice(dataStart + 64, dataStart + 64 + length * 2);
  const bytes = new Uint8Array(strHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

function classifyAssetType(mimeType: string | null | undefined): string {
  if (!mimeType) return 'unknown';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType === 'application/pdf') return 'document';
  if (['application/javascript', 'application/json', 'application/xml', 'application/x-yaml', 'application/toml', 'application/x-sh'].includes(mimeType)) return 'code';
  if (mimeType.includes('model') || mimeType.includes('gguf') || mimeType.includes('safetensors') || mimeType.includes('onnx')) return 'ai-model';
  if (mimeType.includes('font')) return 'font';
  if (mimeType.includes('gltf') || mimeType.includes('fbx') || mimeType.includes('obj')) return '3d';
  if (mimeType.includes('csv') || mimeType.includes('parquet') || mimeType.includes('jsonl')) return 'dataset';
  return 'other';
}

export class ContentIndexerService {
  private db: DatabaseManager | null = null;
  private ipfs: IPFSStorage | null = null;
  private config: IndexerConfig;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private currentRpcIndex = 0;

  constructor(rawConfig: Config) {
    const c = rawConfig.content_indexer ?? {};
    const sharedRpcUrls = rawConfig.blockchain?.rpc_urls;
    this.config = {
      enabled: c.enabled ?? true,
      scanIntervalMinutes: c.scan_interval_minutes ?? 30,
      rpcUrls: c.rpc_urls ?? sharedRpcUrls ?? ['https://mainnet.base.org'],
      maxBlocksPerScan: c.max_blocks_per_scan ?? 10000,
      metadataFetchConcurrency: c.metadata_fetch_concurrency ?? 3,
      metadataGatewayUrls: c.metadata_gateway_urls ?? ['https://ipfs.ela.city/ipfs/', 'https://dweb.link/ipfs/'],
      contracts: {},
    };

    if (c.contracts) {
      for (const [version, cfg] of Object.entries(c.contracts)) {
        this.config.contracts[version] = {
          channelFactory: cfg.channel_factory ?? cfg.channel_core,
          centralStorage: cfg.central_storage ?? cfg.core_storage,
          authorityGateway: cfg.authority_gateway,
          eventHub: cfg.event_hub,
          fromBlock: cfg.from_block ?? 0,
        };
      }
    }
  }

  initialize(db: DatabaseManager, ipfs?: IPFSStorage | null): void {
    this.db = db;
    this.ipfs = ipfs ?? null;

    if (!this.config.enabled) {
      log.info('Content indexer disabled in config');
      return;
    }

    if (Object.keys(this.config.contracts).length === 0) {
      log.warn('No contracts configured for content indexer');
      return;
    }

    log.info(`Content indexer initialized (scan every ${this.config.scanIntervalMinutes}m, ${Object.keys(this.config.contracts).length} contract version(s))`);

    setTimeout(() => this.runScanCycle(), 5000);

    this.scanTimer = setInterval(
      () => this.runScanCycle(),
      this.config.scanIntervalMinutes * 60 * 1000
    );
  }

  shutdown(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    log.info('Content indexer shut down');
  }

  getStats(): { enabled: boolean; config: IndexerConfig; scanning: boolean } {
    return { enabled: this.config.enabled, config: this.config, scanning: this.isScanning };
  }

  // ── RPC helpers ────────────────────────────────────────────

  private getRpcUrl(): string {
    return this.config.rpcUrls[this.currentRpcIndex % this.config.rpcUrls.length];
  }

  private rotateRpc(): void {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.config.rpcUrls.length;
    log.debug(`Rotated to RPC: ${this.getRpcUrl()}`);
  }

  private async rpcCall(method: string, params: any[]): Promise<any> {
    const maxAttempts = this.config.rpcUrls.length;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(this.getRpcUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`RPC HTTP ${response.status}`);
        }

        const json = await response.json() as any;
        if (json.error) {
          throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
        }

        return json.result;
      } catch (error: any) {
        lastError = error;
        log.debug(`RPC call failed on ${this.getRpcUrl()}: ${error.message}`);
        this.rotateRpc();
      }
    }

    throw lastError || new Error('All RPC endpoints failed');
  }

  private async getLatestBlock(): Promise<number> {
    const result = await this.rpcCall('eth_blockNumber', []);
    return fromHex(result);
  }

  private async getLogs(address: string | string[], topics: (string | null)[], fromBlock: number, toBlock: number): Promise<any[]> {
    return this.rpcCall('eth_getLogs', [{
      address,
      topics,
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
    }]);
  }

  private async ethCall(to: string, data: string): Promise<string> {
    return this.rpcCall('eth_call', [{ to, data }, 'latest']);
  }

  // ── Scan cycle ─────────────────────────────────────────────

  private async runScanCycle(): Promise<void> {
    if (this.isScanning || !this.db) return;
    this.isScanning = true;

    try {
      const latestBlock = await this.getLatestBlock();
      log.info(`Starting scan cycle (latest block: ${latestBlock})`);

      for (const [version, contractCfg] of Object.entries(this.config.contracts)) {
        await this.scanContractVersion(version, contractCfg, latestBlock);
      }

      await this.resolveMetadata();

      const stats = this.db.getCatalogStats();
      log.info(`Scan cycle complete — catalog: ${stats.total} total, ${stats.resolved} resolved, ${stats.pending} pending`);
    } catch (error: any) {
      log.error(`Scan cycle failed: ${error.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  private async scanContractVersion(version: string, cfg: ContractVersionConfig, latestBlock: number): Promise<void> {
    if (!this.db) return;

    const settingKey = `indexer_last_block_${version}`;
    const lastScanned = parseInt(this.db.getSetting(settingKey) || '0', 10);
    const startBlock = Math.max(lastScanned + 1, cfg.fromBlock);

    if (startBlock > latestBlock) {
      log.debug(`[${version}] Already up to date (block ${lastScanned})`);
      return;
    }

    const totalBlocks = latestBlock - startBlock;
    log.info(`[${version}] Scanning blocks ${startBlock} → ${latestBlock} (${totalBlocks} blocks)`);

    let scannedTo = startBlock - 1;
    let newAssets = 0;

    for (let from = startBlock; from <= latestBlock; from += this.config.maxBlocksPerScan) {
      const to = Math.min(from + this.config.maxBlocksPerScan - 1, latestBlock);

      const eventSource = cfg.eventHub ?? cfg.centralStorage;
      if (eventSource) {
        const count = await this.scanDigitalAssetRegistered(eventSource, version, from, to);
        newAssets += count;
      }

      scannedTo = to;

      if (totalBlocks > this.config.maxBlocksPerScan) {
        const progress = ((to - startBlock) / totalBlocks * 100).toFixed(1);
        log.debug(`[${version}] Progress: ${progress}% (block ${to})`);
      }
    }

    this.db.setSetting(settingKey, String(scannedTo));

    if (newAssets > 0) {
      log.info(`[${version}] Found ${newAssets} new asset(s) up to block ${scannedTo}`);
    }
  }

  private async scanDigitalAssetRegistered(eventSourceAddress: string, version: string, fromBlock: number, toBlock: number): Promise<number> {
    if (!this.db) return 0;

    const logs = await this.getLogs(
      eventSourceAddress,
      [TOPICS.DigitalAssetRegistered],
      fromBlock,
      toBlock
    );

    let count = 0;

    for (const entry of logs) {
      try {
        // V3 DigitalAssetRegistered(address indexed channel, uint256 indexed tokenId,
        //   address creator, string tokenURI, uint16 opType, bytes16 contentId)
        const channelAddress = unpadAddress(entry.topics[1]);
        const tokenId = fromHex(entry.topics[2]);
        const blockNumber = fromHex(entry.blockNumber);

        // Non-indexed params in data: creator (address), tokenURI (string), opType (uint16), contentId (bytes16)
        const data = entry.data?.replace('0x', '') ?? '';
        const creatorAddress = data.length >= 64 ? unpadAddress('0x' + data.slice(0, 64)) : '';

        if (this.db.catalogItemExists(channelAddress, tokenId, 8453)) {
          continue;
        }

        const item: ContentCatalogItem = {
          content_id: null,
          channel_address: channelAddress,
          token_id: tokenId,
          operative_address: '',
          creator_address: creatorAddress,
          name: null,
          description: null,
          image_url: null,
          content_cid: null,
          metadata_cid: null,
          mime_type: null,
          asset_type: null,
          price: null,
          payment_token: null,
          op_type: null,
          chain_id: 8453,
          block_number: blockNumber,
          tx_hash: entry.transactionHash || null,
          contract_version: version,
          metadata_status: 'pending',
          indexed_at: Date.now(),
          metadata_json: null,
        };

        this.db.upsertCatalogItem(item);
        count++;
      } catch (error: any) {
        log.debug(`Failed to parse event: ${error.message}`);
      }
    }

    return count;
  }

  // ── Metadata resolution ────────────────────────────────────

  private async resolveMetadata(): Promise<void> {
    if (!this.db) return;

    const pending = this.db.getCatalogItemsPendingMetadata(this.config.metadataFetchConcurrency * 10);
    if (pending.length === 0) return;

    log.info(`Resolving metadata for ${pending.length} asset(s)...`);

    const chunks = [];
    for (let i = 0; i < pending.length; i += this.config.metadataFetchConcurrency) {
      chunks.push(pending.slice(i, i + this.config.metadataFetchConcurrency));
    }

    let resolved = 0;
    let failed = 0;

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(item => this.resolveItemMetadata(item))
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          resolved++;
        } else {
          failed++;
        }
      }
    }

    if (resolved > 0 || failed > 0) {
      log.info(`Metadata resolution: ${resolved} resolved, ${failed} failed`);
    }
  }

  private async resolveItemMetadata(item: ContentCatalogItem): Promise<boolean> {
    if (!this.db) return false;

    try {
      // Step 1: Get tokenURI from the channel contract
      const callData = TOKEN_URI_SELECTOR + padUint256(item.token_id).slice(2);
      const uriResult = await this.ethCall(item.channel_address, callData);

      if (!uriResult || uriResult === '0x') {
        this.db.updateCatalogMetadata(item.channel_address, item.token_id, item.chain_id, {
          metadata_status: 'failed',
        });
        return false;
      }

      const tokenURI = decodeAbiString(uriResult);
      if (!tokenURI) {
        this.db.updateCatalogMetadata(item.channel_address, item.token_id, item.chain_id, {
          metadata_status: 'failed',
        });
        return false;
      }

      // Step 2: Extract CID from tokenURI and fetch metadata
      const metadataCid = this.extractCid(tokenURI);
      const metadata = await this.fetchMetadata(tokenURI);

      if (!metadata) {
        this.db.updateCatalogMetadata(item.channel_address, item.token_id, item.chain_id, {
          metadata_cid: metadataCid,
          metadata_status: 'failed',
        });
        return false;
      }

      // Step 3: Parse metadata and update catalog
      const contentCid = metadata.media?.uri
        ? this.extractCid(metadata.media.uri)
        : null;
      const mimeType = metadata.media?.contentType || null;
      const kid = metadata.kid || metadata.properties?.kid || null;
      const creator = metadata.properties?.publisher || item.creator_address;

      this.db.updateCatalogMetadata(item.channel_address, item.token_id, item.chain_id, {
        content_id: kid,
        name: metadata.name || null,
        description: metadata.description || null,
        image_url: metadata.image || null,
        content_cid: contentCid,
        metadata_cid: metadataCid,
        mime_type: mimeType,
        asset_type: classifyAssetType(mimeType),
        creator_address: creator,
        metadata_status: 'resolved',
        metadata_json: JSON.stringify(metadata),
      });

      return true;
    } catch (error: any) {
      log.debug(`Metadata resolution failed for ${item.channel_address}:${item.token_id}: ${error.message}`);
      this.db?.updateCatalogMetadata(item.channel_address, item.token_id, item.chain_id, {
        metadata_status: 'failed',
      });
      return false;
    }
  }

  private extractCid(uri: string): string | null {
    if (uri.startsWith('ipfs://')) {
      return uri.replace('ipfs://', '').split('/')[0];
    }
    const ipfsMatch = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
    if (ipfsMatch) return ipfsMatch[1];
    if (uri.startsWith('Qm') || uri.startsWith('bafy')) return uri.split('/')[0];
    return null;
  }

  private async fetchMetadata(tokenURI: string): Promise<any | null> {
    const cid = this.extractCid(tokenURI);

    // Try local IPFS first
    if (cid && this.ipfs) {
      try {
        const buf = await this.ipfs.getFile(cid);
        if (buf && buf.length > 0) {
          return JSON.parse(buf.toString('utf8'));
        }
      } catch {
        // Local IPFS didn't have it, fall through to gateways
      }
    }

    // Try HTTP gateways
    const urls: string[] = [];

    if (tokenURI.startsWith('http://') || tokenURI.startsWith('https://')) {
      urls.push(tokenURI);
    }

    if (cid) {
      for (const gateway of this.config.metadataGatewayUrls) {
        urls.push(`${gateway}${cid}`);
      }
    }

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: { 'Accept': 'application/json' },
        });

        if (response.ok) {
          return await response.json();
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}
