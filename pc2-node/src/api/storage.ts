/**
 * Storage API Endpoint
 * 
 * Provides storage usage statistics including IPFS CID data
 */

import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest } from './middleware.js';
import { logger } from '../utils/logger.js';
import { getEffectiveStorageLimit } from './info.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getWASMRuntime, type RendererCommand } from '../services/wasm/WASMRuntime.js';

const router = Router();

/**
 * GET /api/storage/usage
 * Returns storage usage statistics including IPFS CID information
 */
router.get('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = req.app.locals.db;
    const userAddress = req.user?.wallet_address;

    if (!userAddress) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Get total storage used
    const totalResult = db.queryOne(`
      SELECT 
        COALESCE(SUM(size), 0) as total_size,
        COUNT(*) as file_count,
        COUNT(CASE WHEN ipfs_hash IS NOT NULL THEN 1 END) as files_with_cid
      FROM files
      WHERE wallet_address = ? AND is_dir = 0
    `, userAddress) as { total_size: number; file_count: number; files_with_cid: number };

    // Get storage by file type
    const byTypeResult = db.query(`
      SELECT 
        CASE 
          WHEN mime_type LIKE 'image/%' THEN 'image'
          WHEN mime_type LIKE 'video/%' THEN 'video'
          WHEN mime_type LIKE 'audio/%' THEN 'audio'
          WHEN mime_type LIKE 'application/pdf' THEN 'pdf'
          WHEN mime_type LIKE 'text/%' OR mime_type LIKE 'application/javascript' OR mime_type LIKE 'application/json' THEN 'document'
          WHEN mime_type LIKE 'application/zip' OR mime_type LIKE 'application/x-%' THEN 'archive'
          ELSE 'other'
        END as type,
        COALESCE(SUM(size), 0) as total_size,
        COUNT(*) as file_count,
        COUNT(CASE WHEN ipfs_hash IS NOT NULL THEN 1 END) as files_with_cid
      FROM files
      WHERE wallet_address = ? AND is_dir = 0
      GROUP BY type
      ORDER BY total_size DESC
    `, userAddress) as Array<{ type: string; total_size: number; file_count: number; files_with_cid: number }>;

    // Get largest files with IPFS CIDs
    const largestFiles = db.query(`
      SELECT 
        path,
        size,
        mime_type as type,
        ipfs_hash,
        updated_at as modified
      FROM files
      WHERE wallet_address = ? AND is_dir = 0
      ORDER BY size DESC
      LIMIT 10
    `, userAddress) as Array<{
      path: string;
      size: number;
      type: string | null;
      ipfs_hash: string | null;
      modified: number;
    }>;

    // Get unused files (not accessed in 30 days) - note: we don't track last_accessed yet
    // For now, use files older than 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const unusedFiles = db.query(`
      SELECT 
        path,
        size,
        mime_type as type,
        ipfs_hash,
        updated_at as modified
      FROM files
      WHERE wallet_address = ? 
        AND is_dir = 0
        AND updated_at < ?
      ORDER BY size DESC
      LIMIT 20
    `, userAddress, thirtyDaysAgo) as Array<{
      path: string;
      size: number;
      type: string | null;
      ipfs_hash: string | null;
      modified: number;
    }>;

    // Get storage timeline (last 12 months) - group by month
    const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
    const timeline = db.query(`
      SELECT 
        strftime('%Y-%m', datetime(created_at / 1000, 'unixepoch')) as month,
        SUM(size) as monthly_size
      FROM files
      WHERE wallet_address = ?
        AND is_dir = 0
        AND created_at > ?
      GROUP BY month
      ORDER BY month ASC
    `, userAddress, oneYearAgo) as Array<{ month: string; monthly_size: number }>;

    // Get IPFS CID statistics
    const ipfsStats = db.queryOne(`
      SELECT 
        COUNT(*) as total_files,
        COUNT(CASE WHEN ipfs_hash IS NOT NULL THEN 1 END) as files_with_cid,
        COALESCE(SUM(CASE WHEN ipfs_hash IS NOT NULL THEN size ELSE 0 END), 0) as size_with_cid
      FROM files
      WHERE wallet_address = ? AND is_dir = 0
    `, userAddress) as { total_files: number; files_with_cid: number; size_with_cid: number };

    // Extract file names from paths
    const extractFileName = (path: string): string => {
      const parts = path.split('/');
      return parts[parts.length - 1] || path;
    };

    const totalSize = totalResult.total_size || 0;
    const storageLimit = getEffectiveStorageLimit(db);

    res.json({
      total: {
        size: totalSize,
        files: totalResult.file_count || 0,
        filesWithCID: totalResult.files_with_cid || 0
      },
      storageLimit,
      storage: {
        used: totalSize,
        limit: storageLimit,
        available: storageLimit === Number.MAX_SAFE_INTEGER ? storageLimit : Math.max(0, storageLimit - totalSize)
      },
      byType: byTypeResult.map(row => ({
        type: row.type || 'unknown',
        size: row.total_size,
        files: row.file_count,
        filesWithCID: row.files_with_cid,
        percentage: totalResult.total_size > 0 
          ? parseFloat(((row.total_size / totalResult.total_size) * 100).toFixed(1))
          : 0
      })),
      largestFiles: largestFiles.map(file => ({
        path: file.path,
        name: extractFileName(file.path),
        size: file.size,
        type: file.type || 'unknown',
        cid: file.ipfs_hash,
        modified: file.modified
      })),
      unusedFiles: unusedFiles.map(file => ({
        path: file.path,
        name: extractFileName(file.path),
        size: file.size,
        type: file.type || 'unknown',
        cid: file.ipfs_hash,
        modified: file.modified
      })),
      timeline: timeline.map(row => ({
        date: row.month,
        size: row.monthly_size
      })),
      ipfs: {
        totalFiles: ipfsStats.total_files,
        filesWithCID: ipfsStats.files_with_cid,
        sizeWithCID: ipfsStats.size_with_cid,
        percentage: ipfsStats.total_files > 0
          ? parseFloat(((ipfsStats.files_with_cid / ipfsStats.total_files) * 100).toFixed(1))
          : 0
      }
    });
  } catch (error) {
    logger.error('[Storage API]: Error getting storage usage:', error);
    res.status(500).json({ error: 'Failed to get storage usage' });
  }
});

/**
 * GET /api/storage/limit
 * Returns the current storage limit setting
 */
router.get('/limit', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = req.app.locals.db;
    
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const limitSetting = db?.getSetting('storage_limit') || 'auto';
    res.json({ limit: limitSetting });
  } catch (error) {
    logger.error('[Storage API]: Error getting storage limit:', error);
    res.status(500).json({ error: 'Failed to get storage limit' });
  }
});

/**
 * POST /api/storage/limit
 * Sets the storage limit preference
 */
router.post('/limit', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = req.app.locals.db;
    
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { limit } = req.body;
    
    // Validate limit value
    const validLimits = ['auto', '10GB', '25GB', '50GB', '100GB', '250GB', '500GB', 'unlimited'];
    if (!validLimits.includes(limit)) {
      return res.status(400).json({ error: 'Invalid limit value', validValues: validLimits });
    }
    
    db?.setSetting('storage_limit', limit);
    
    // Update global config so it takes effect immediately
    if (!(global as any).pc2Config) {
      (global as any).pc2Config = {};
    }
    if (!(global as any).pc2Config.resources) {
      (global as any).pc2Config.resources = {};
    }
    if (!(global as any).pc2Config.resources.storage) {
      (global as any).pc2Config.resources.storage = {};
    }
    (global as any).pc2Config.resources.storage.limit = limit;
    
    logger.info(`[Storage API]: Storage limit set to ${limit}`);
    res.json({ success: true, limit });
  } catch (error) {
    logger.error('[Storage API]: Error setting storage limit:', error);
    res.status(500).json({ error: 'Failed to set storage limit' });
  }
});

// ============================================================================
// IPFS Settings & Sharing Endpoints
// ============================================================================

/**
 * GET /api/ipfs/settings
 * Returns IPFS network settings and sharing statistics
 */
router.get('/ipfs/settings', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = req.app.locals.db;
    const ipfs = req.app.locals.ipfs;
    const walletAddress = req.user?.wallet_address;

    if (!walletAddress) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get IPFS settings from database (defaults: hybrid mode, auto-announce enabled)
    const settings = {
      mode: db?.getSetting(`${walletAddress}:ipfs_mode`) || 'hybrid',
      autoAnnouncePublic: db?.getSetting(`${walletAddress}:ipfs_auto_announce`) !== 'false',
      enableBootstrap: db?.getSetting(`${walletAddress}:ipfs_bootstrap`) !== 'false',
    };

    // Get IPFS stats if available
    let ipfsStats = null;
    if (ipfs) {
      const announcementStats = ipfs.getAnnouncementStats();
      const networkStats = await ipfs.getNetworkStats();
      
      ipfsStats = {
        ...announcementStats,
        peerId: networkStats.peerId,
        addresses: networkStats.addresses,
      };
    }

    // Get public file statistics
    const publicCIDCount = db?.getPublicCIDCount() || 0;

    res.json({
      settings,
      ipfs: ipfsStats,
      publicFiles: {
        uniqueCIDs: publicCIDCount,
      },
    });
  } catch (error) {
    logger.error('[Storage API]: Error getting IPFS settings:', error);
    res.status(500).json({ error: 'Failed to get IPFS settings' });
  }
});

/**
 * POST /api/ipfs/settings
 * Update IPFS network settings
 */
router.post('/ipfs/settings', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = req.app.locals.db;
    const walletAddress = req.user?.wallet_address;

    if (!walletAddress) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { mode, autoAnnouncePublic, enableBootstrap } = req.body;

    // Validate mode
    if (mode !== undefined) {
      const validModes = ['private', 'hybrid', 'public'];
      if (!validModes.includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode', validValues: validModes });
      }
      db?.setSetting(`${walletAddress}:ipfs_mode`, mode);
    }

    // Save other settings
    if (autoAnnouncePublic !== undefined) {
      db?.setSetting(`${walletAddress}:ipfs_auto_announce`, String(autoAnnouncePublic));
    }

    if (enableBootstrap !== undefined) {
      db?.setSetting(`${walletAddress}:ipfs_bootstrap`, String(enableBootstrap));
    }

    logger.info(`[Storage API]: IPFS settings updated for ${walletAddress}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('[Storage API]: Error updating IPFS settings:', error);
    res.status(500).json({ error: 'Failed to update IPFS settings' });
  }
});

/**
 * POST /api/ipfs/announce
 * Manually trigger announcement of all public CIDs to DHT
 */
router.post('/ipfs/announce', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = req.app.locals.db;
    const ipfs = req.app.locals.ipfs;
    const walletAddress = req.user?.wallet_address;

    if (!walletAddress) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!ipfs) {
      return res.status(503).json({ error: 'IPFS not available' });
    }

    if (!ipfs.canAnnounce()) {
      return res.status(400).json({ 
        error: 'DHT announcement not available',
        reason: ipfs.getNetworkMode() === 'private' 
          ? 'IPFS is in private mode' 
          : 'DHT service not initialized'
      });
    }

    // Get all public CIDs
    const publicCIDs = db?.getPublicCIDs() || [];

    if (publicCIDs.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No public files to announce',
        announced: 0,
        failed: 0
      });
    }

    // Announce all public CIDs
    logger.info(`[Storage API]: Starting announcement of ${publicCIDs.length} public CIDs`);
    const result = await ipfs.announceMultipleCIDs(publicCIDs);

    res.json({
      success: true,
      message: `Announced ${result.success} CIDs to DHT`,
      announced: result.success,
      failed: result.failed,
      total: publicCIDs.length
    });
  } catch (error) {
    logger.error('[Storage API]: Error announcing CIDs:', error);
    res.status(500).json({ error: 'Failed to announce CIDs' });
  }
});

/**
 * GET /api/ipfs/network
 * Get IPFS network status and peer information
 */
router.get('/ipfs/network', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ipfs = req.app.locals.ipfs;

    if (!ipfs) {
      return res.status(503).json({ error: 'IPFS not available' });
    }

    const networkStats = await ipfs.getNetworkStats();
    const peers = await ipfs.getConnectedPeers();

    res.json({
      mode: networkStats.mode,
      peerId: networkStats.peerId,
      addresses: networkStats.addresses,
      connectedPeers: networkStats.connectedPeers,
      peerList: peers.slice(0, 20), // Limit to 20 peers for display
    });
  } catch (error) {
    logger.error('[Storage API]: Error getting IPFS network status:', error);
    res.status(500).json({ error: 'Failed to get IPFS network status' });
  }
});

/**
 * POST /api/ipfs/add
 * Add raw content to IPFS and return the CID.
 * Accepts base64-encoded content in JSON body.
 * Used by the Creator Dashboard to upload encrypted assets.
 *
 * Body: { content: string (base64), announce?: boolean }
 * Response: { success: true, cid: string, size: number }
 */
router.post('/ipfs/add', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ipfs = req.app.locals.ipfs;
    if (!ipfs) {
      return res.status(503).json({ error: 'IPFS not available' });
    }

    const { content, announce } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid content (expected base64 string)' });
    }

    const MAX_SIZE = 100 * 1024 * 1024; // 100MB limit
    const estimatedSize = Math.ceil(content.length * 0.75);
    if (estimatedSize > MAX_SIZE) {
      return res.status(413).json({ error: `Content too large (${Math.round(estimatedSize / 1024 / 1024)}MB). Max: 100MB` });
    }

    const data = Buffer.from(content, 'base64');
    logger.info(`[Storage API] Adding ${data.length} bytes to IPFS`);

    const cid = await ipfs.storeFile(data, { pin: true, announce: !!announce });

    logger.info(`[Storage API] Added to IPFS: ${cid} (${data.length} bytes)`);

    const db = req.app.locals.db;
    const walletAddress = req.user?.wallet_address;
    if (db && walletAddress) {
      try {
        db.trackPinnedCID(cid, walletAddress, data.length, 'creator');
      } catch (trackErr) {
        logger.warn(`[Storage API] Failed to track creator CID (non-fatal): ${cid}`, trackErr);
      }
    }

    if (announce && ipfs.canAnnounce()) {
      ipfs.announceCID(cid).then((announced: boolean) => {
        if (announced) {
          logger.info(`[Storage API] Announced creator CID to DHT: ${cid}`);
          db?.updatePinnedCIDAnnouncedAt(cid);
        }
      }).catch((err: any) => {
        logger.warn(`[Storage API] DHT announcement failed (non-fatal): ${cid}`, err);
      });
    }

    res.json({ success: true, cid, size: data.length });
  } catch (error: any) {
    logger.error('[Storage API]: Error adding content to IPFS:', error);
    res.status(500).json({ error: error.message || 'Failed to add content to IPFS' });
  }
});

/**
 * POST /api/ipfs/add-directory
 * Create an IPFS directory containing one or more named files.
 * Returns a directory CID where {dirCID}/{filename} resolves on IPFS gateways.
 *
 * Body: { files: Record<string, string (base64)>, announce?: boolean }
 *   e.g. { files: { "metadata.json": "<base64>", "content.json": "<base64>" } }
 * Response: { success: true, cid: string, fileCount: number }
 */
router.post('/ipfs/add-directory', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ipfs = req.app.locals.ipfs;
    if (!ipfs) {
      return res.status(503).json({ error: 'IPFS not available' });
    }

    const { files, announce } = req.body;
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      return res.status(400).json({ error: 'Missing or invalid files (expected { "filename": "base64content", ... })' });
    }

    const filenames = Object.keys(files);
    if (filenames.length === 0) {
      return res.status(400).json({ error: 'At least one file is required' });
    }

    const MAX_SIZE = 100 * 1024 * 1024;
    const fileBuffers: Record<string, Buffer> = {};
    let totalSize = 0;

    for (const [name, content] of Object.entries(files)) {
      if (typeof content !== 'string') {
        return res.status(400).json({ error: `File "${name}" content must be a base64 string` });
      }
      const buf = Buffer.from(content as string, 'base64');
      totalSize += buf.length;
      if (totalSize > MAX_SIZE) {
        return res.status(413).json({ error: `Total content too large. Max: 100MB` });
      }
      fileBuffers[name] = buf;
    }

    logger.info(`[Storage API] Creating IPFS directory with ${filenames.length} files (${totalSize} bytes total)`);

    const cid = await ipfs.storeDirectory(fileBuffers, { pin: true });

    logger.info(`[Storage API] IPFS directory created: ${cid} (${filenames.length} files, ${totalSize} bytes)`);

    const db = req.app.locals.db;
    const walletAddress = req.user?.wallet_address;
    if (db && walletAddress) {
      try {
        db.trackPinnedCID(cid, walletAddress, totalSize, 'creator');
      } catch (trackErr) {
        logger.warn(`[Storage API] Failed to track creator directory CID (non-fatal): ${cid}`, trackErr);
      }
    }

    if (announce && ipfs.canAnnounce()) {
      ipfs.announceCID(cid).then((announced: boolean) => {
        if (announced) {
          logger.info(`[Storage API] Announced creator directory CID to DHT: ${cid}`);
          db?.updatePinnedCIDAnnouncedAt(cid);
        }
      }).catch((err: any) => {
        logger.warn(`[Storage API] DHT announcement failed (non-fatal): ${cid}`, err);
      });
    }

    res.json({ success: true, cid, fileCount: filenames.length });
  } catch (error: any) {
    logger.error('[Storage API]: Error creating IPFS directory:', error);
    res.status(500).json({ error: error.message || 'Failed to create IPFS directory' });
  }
});

/**
 * POST /api/ipfs/pin
 * Pin a remote CID to the local IPFS node (fetches content from the network/gateway).
 * Used by the Elacity Market to download owned media to the user's node.
 */
router.post('/ipfs/pin', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ipfs = req.app.locals.ipfs;
    if (!ipfs) {
      return res.status(503).json({ error: 'IPFS not available' });
    }

    const { cid } = req.body;
    if (!cid || typeof cid !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid CID' });
    }

    const cidClean = cid.replace(/^ipfs:\/\//, '').replace(/^\/ipfs\//, '').split('/')[0];

    logger.info(`[Storage API] Pinning remote CID: ${cidClean}`);
    const result = await ipfs.pinRemoteCID(cidClean, { timeoutMs: 180000 });

    if (result.success) {
      logger.info(`[Storage API] Successfully pinned CID: ${cidClean} (${result.size} bytes, ${result.type}, ${result.timeMs}ms)`);

      // Track in pinned_cids for CDN stats and periodic DHT re-announcement
      const db = req.app.locals.db;
      const walletAddress = req.user?.wallet_address;
      if (db && walletAddress) {
        try {
          db.trackPinnedCID(cidClean, walletAddress, result.size || 0, 'marketplace');
          logger.info(`[Storage API] Tracked pinned CID for CDN: ${cidClean}`);
        } catch (trackErr) {
          logger.warn(`[Storage API] Failed to track pinned CID (non-fatal): ${cidClean}`, trackErr);
        }
      }

      // Announce on DHT so other nodes can discover this content via Bitswap
      if (ipfs.canAnnounce()) {
        ipfs.announceCID(cidClean).then((announced: boolean) => {
          if (announced) {
            logger.info(`[Storage API] Announced pinned CID to DHT: ${cidClean}`);
            db?.updatePinnedCIDAnnouncedAt(cidClean);
          }
        }).catch((err: any) => {
          logger.warn(`[Storage API] DHT announcement failed (non-fatal): ${cidClean}`, err);
        });
      }

      res.json({
        success: true,
        cid: result.cid,
        totalSize: result.size,
        blockCount: result.blockCount || result.files || 1,
        type: result.type,
      });
    } else {
      res.status(500).json({ success: false, error: 'Failed to pin CID' });
    }
  } catch (error: any) {
    logger.error('[Storage API]: Error pinning remote CID:', error);
    res.status(500).json({ error: error.message || 'Failed to pin CID' });
  }
});

// ─── Lit Protocol: Server Key + Encrypt/Decrypt ──────────────────────────────
//
// Architecture: The pc2-node backend is the trusted decryption service.
// - Encryption: Lit access conditions gate on the SERVER wallet (not the buyer)
// - Decryption: Server verifies buyer's AccessToken on-chain, then uses its own
//   Lit auth to decrypt. This mirrors Elacity's backend architecture.
//
// The server key is auto-generated on first use and stored in the data directory.

const __litFilename = fileURLToPath(import.meta.url);
const __litDirname = dirname(__litFilename);
const LIT_KEY_PATH = join(__litDirname, '../../data/.lit-server-key');
const CAPACITY_KEY_PATH = join(__litDirname, '../../data/.lit-capacity-key');
const CAPACITY_TOKEN_ID_PATH = join(__litDirname, '../../data/.lit-capacity-token-id');
const LIT_RELAYER_CONFIG_PATH = join(__litDirname, '../../data/.lit-relayer-config');

const LIT_RELAYER_URL = 'https://datil-relayer.getlit.dev';

function getConfiguredCapacityTokenId(): string {
  if (process.env.LIT_CAPACITY_TOKEN_ID) return process.env.LIT_CAPACITY_TOKEN_ID;
  if (existsSync(CAPACITY_TOKEN_ID_PATH)) return readFileSync(CAPACITY_TOKEN_ID_PATH, 'utf8').trim();
  return '';
}

interface RelayerConfig {
  apiKey: string;
  payerSecretKey: string;
}

function getRelayerConfig(): RelayerConfig | null {
  const apiKey = process.env.LIT_RELAYER_API_KEY;
  const payerSecretKey = process.env.LIT_PAYER_SECRET_KEY;
  if (apiKey && payerSecretKey) return { apiKey, payerSecretKey };

  if (existsSync(LIT_RELAYER_CONFIG_PATH)) {
    try {
      const raw = readFileSync(LIT_RELAYER_CONFIG_PATH, 'utf8').trim();
      const parsed = JSON.parse(raw);
      if (parsed.apiKey && parsed.payerSecretKey) return parsed;
    } catch { /* ignore parse errors */ }
  }
  return null;
}

let delegateeRegistered = false;

async function ensureDelegateeRegistered(walletAddress: string): Promise<void> {
  if (delegateeRegistered) return;

  const config = getRelayerConfig();
  if (!config) {
    logger.info('[Lit] No relayer config — skipping auto-registration (may already be registered)');
    delegateeRegistered = true;
    return;
  }

  try {
    const resp = await fetch(`${LIT_RELAYER_URL}/add-users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.apiKey,
        'payer-secret-key': config.payerSecretKey,
      },
      body: JSON.stringify([walletAddress]),
    });
    const result = await resp.json() as any;
    if (result.success) {
      logger.info(`[Lit] Registered as delegatee via Payment Delegation DB (tx: ${result.txHash || 'submitted'})`);
    } else {
      logger.warn(`[Lit] Delegatee registration response:`, result);
    }
  } catch (err: any) {
    logger.warn(`[Lit] Delegatee auto-registration failed (may already be registered): ${err.message}`);
  }
  delegateeRegistered = true;
}

let cachedCapacityTokenId: string | null = null;

let cachedServerWallet: any = null;
let cachedCapacityWallet: any = null;

async function getServerWallet() {
  if (cachedServerWallet) return cachedServerWallet;

  const { ethers } = await import('ethers');

  if (existsSync(LIT_KEY_PATH)) {
    const key = readFileSync(LIT_KEY_PATH, 'utf8').trim();
    cachedServerWallet = new ethers.Wallet(key);
    logger.info(`[Lit] Server wallet loaded: ${cachedServerWallet.address}`);
  } else {
    const dataDir = dirname(LIT_KEY_PATH);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    cachedServerWallet = ethers.Wallet.createRandom();
    writeFileSync(LIT_KEY_PATH, cachedServerWallet.privateKey, { mode: 0o600 });
    logger.info(`[Lit] Generated new server wallet: ${cachedServerWallet.address}`);
  }

  return cachedServerWallet;
}

/**
 * Load the capacity credit owner wallet.
 * This wallet must own the RLI NFT (capacity credit) on Chronicle Yellowstone.
 * Store its private key in data/.lit-capacity-key or set LIT_CAPACITY_KEY env var.
 */
async function getCapacityWallet(): Promise<any | null> {
  if (cachedCapacityWallet !== null) return cachedCapacityWallet || null;

  const { ethers } = await import('ethers');
  const envKey = process.env.LIT_CAPACITY_KEY;

  if (envKey) {
    cachedCapacityWallet = new ethers.Wallet(envKey.trim());
    logger.info(`[Lit] Capacity wallet loaded from env: ${cachedCapacityWallet.address}`);
    return cachedCapacityWallet;
  }

  if (existsSync(CAPACITY_KEY_PATH)) {
    const key = readFileSync(CAPACITY_KEY_PATH, 'utf8').trim();
    cachedCapacityWallet = new ethers.Wallet(key);
    logger.info(`[Lit] Capacity wallet loaded from file: ${cachedCapacityWallet.address}`);
    return cachedCapacityWallet;
  }

  logger.info('[Lit] No capacity credit wallet found (not required if registered in Payment Delegation DB).');
  logger.info('[Lit] Optional: set LIT_CAPACITY_KEY env var for legacy delegation, or configure LIT_RELAYER_API_KEY + LIT_PAYER_SECRET_KEY for auto-registration.');
  cachedCapacityWallet = false;
  return null;
}

/**
 * Auto-detect the latest valid RLI token owned by the capacity wallet.
 * Queries the Chronicle Yellowstone chain for the wallet's RLI balance
 * and finds a non-expired token.
 */
async function detectCapacityTokenId(capacityWalletAddress: string): Promise<string> {
  const configured = getConfiguredCapacityTokenId();
  if (configured) {
    logger.info(`[Lit] Using configured capacity token ID: ${configured}`);
    return configured;
  }

  if (cachedCapacityTokenId) return cachedCapacityTokenId;

  try {
    const { ethers } = await import('ethers');
    const { LIT_RPC } = await import('@lit-protocol/constants');
    const provider = new ethers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE);

    const RLI_CONTRACT = '0xd3DEC8965Aa9676a6AfB4e4D05DA14E28D8f11e8';
    const rliAbi = [
      'function balanceOf(address owner) view returns (uint256)',
      'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
      'function capacity(uint256 tokenId) view returns (uint256 requestsPerKilosecond, uint256 expiresAt)',
    ];

    const rli = new ethers.Contract(RLI_CONTRACT, rliAbi, provider);
    const balance = await rli.balanceOf(capacityWalletAddress);
    const count = Number(balance);

    if (count === 0) {
      logger.warn('[Lit] Capacity wallet owns no RLI tokens');
      return '';
    }

    let bestTokenId = '';
    let bestExpiry = 0;
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < Math.min(count, 30); i++) {
      try {
        const tokenId = await rli.tokenOfOwnerByIndex(capacityWalletAddress, i);
        const cap = await rli.capacity(tokenId);
        const expiresAt = Number(cap.expiresAt);
        if (expiresAt > now && expiresAt > bestExpiry) {
          bestExpiry = expiresAt;
          bestTokenId = tokenId.toString();
        }
      } catch { continue; }
    }

    if (bestTokenId) {
      const expiryDate = new Date(bestExpiry * 1000).toISOString().split('T')[0];
      logger.info(`[Lit] Auto-detected capacity token #${bestTokenId} (expires ${expiryDate})`);
      cachedCapacityTokenId = bestTokenId;
      return bestTokenId;
    }

    logger.warn('[Lit] All RLI tokens are expired');
    return '';
  } catch (err: any) {
    logger.error('[Lit] Failed to auto-detect capacity token:', err.message);
    return getConfiguredCapacityTokenId();
  }
}

let litClientInstance: any = null;
let litConnecting: Promise<void> | null = null;

async function getLitClient() {
  if (litClientInstance?.ready) {
    return litClientInstance;
  }

  if (litConnecting) {
    await litConnecting;
    if (litClientInstance?.ready) return litClientInstance;
  }

  const { LitNodeClientNodeJs } = await import('@lit-protocol/lit-node-client-nodejs');
  const { LIT_NETWORK } = await import('@lit-protocol/constants');

  litClientInstance = new LitNodeClientNodeJs({
    litNetwork: LIT_NETWORK.Datil,
    debug: false,
    connectTimeout: 120000,
  });

  litConnecting = litClientInstance.connect().then(() => {
    logger.info(`[Lit] Connected to Datil production (${litClientInstance.connectedNodes?.size || 0} nodes)`);
    litConnecting = null;
  }).catch((err: Error) => {
    logger.error('[Lit] Connection failed:', err.message);
    litClientInstance = null;
    litConnecting = null;
    throw err;
  });

  await litConnecting;
  return litClientInstance;
}

// ── Lit Action Configuration ───────────────────────────────────────
// Our non-media Lit Action (deployed to IPFS — set after first deploy)
const LIT_ACTION_CID_PATH = join(__litDirname, '../../data/.lit-action-cid');
let NON_MEDIA_ACTION_CID = process.env.LIT_ACTION_CID || '';

// ── Lit Backend Selection ─────────────────────────────────────────
// LIT_BACKEND=chipotle (default) — use Chipotle REST API (stateless, API key auth)
// LIT_BACKEND=datil             — use Datil SDK (WebSocket, SIWE, capacity credits)
type LitBackend = 'chipotle' | 'datil';
const LIT_BACKEND: LitBackend = (process.env.LIT_BACKEND as LitBackend) || 'chipotle';
logger.info(`[Lit] Backend: ${LIT_BACKEND} (set LIT_BACKEND=datil to revert to Datil SDK)`);

if (!NON_MEDIA_ACTION_CID && existsSync(LIT_ACTION_CID_PATH)) {
  NON_MEDIA_ACTION_CID = readFileSync(LIT_ACTION_CID_PATH, 'utf8').trim();
  if (NON_MEDIA_ACTION_CID) {
    logger.info(`[Lit] Loaded action CID from file: ${NON_MEDIA_ACTION_CID}`);
  }
}

const DEFAULT_AUTHORITY = '0x580C26DeFf267Ef40A72cf10a4A42050F0641b8B';
const DEFAULT_RPC = 'https://mainnet.base.org';

/**
 * Build access conditions for Lit encrypt/decrypt.
 *
 * ONLY the self-referential check: ensures only the designated Lit Action
 * code (pinned on IPFS, immutable) can trigger decryption.
 *
 * The actual on-chain access verification (hasAccessByContentId) is performed
 * INSIDE the Lit Action code itself, where it checks the real buyer's address
 * passed via jsParams. This avoids the :userAddress problem where the server
 * wallet would be checked instead of the buyer.
 */
// Self-referential condition: only the Lit Action with this exact CID can decrypt.
// The action is pinned to Pinata (Lit's IPFS backend) so Lit nodes can fetch it.
// The action code itself performs the on-chain hasAccessByContentId() check.
function buildSelfRefConditions(outerActionCid: string, chain = 'base') {
  return [
    {
      conditionType: 'evmBasic',
      contractAddress: '',
      standardContractType: '',
      chain,
      method: '',
      parameters: [':currentActionIpfsId'],
      returnValueTest: {
        comparator: '=',
        value: outerActionCid,
      },
    },
  ];
}

async function createServerAuthSig(client: any, wallet: any) {
  const { createSiweMessage, generateAuthSig } = await import('@lit-protocol/auth-helpers');

  const nonce = await client.getLatestBlockhash();
  const toSign = await createSiweMessage({
    walletAddress: wallet.address,
    nonce,
    expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });

  return generateAuthSig({ signer: wallet, toSign });
}

/**
 * Generate session signatures for Lit Action execution.
 * Requires both AccessControlConditionDecryption and LitActionExecution abilities.
 */
// Session sigs cache: avoids expensive Lit node handshake on every request.
// Sigs are valid for 15 min; we cache for 10 min to leave safety margin.
const SESSION_SIGS_TTL_MS = 10 * 60 * 1000;
let cachedSessionSigs: { sigs: any; createdAt: number } | null = null;
let sessionSigsPromise: Promise<any> | null = null;

async function getExecuteSessionSigs(client: any, wallet: any) {
  if (cachedSessionSigs && (Date.now() - cachedSessionSigs.createdAt) < SESSION_SIGS_TTL_MS) {
    logger.info(`[Lit] Reusing cached session sigs (age: ${Math.round((Date.now() - cachedSessionSigs.createdAt) / 1000)}s)`);
    return cachedSessionSigs.sigs;
  }

  // Coalesce concurrent requests: if another call is already generating sigs, wait for it
  if (sessionSigsPromise) {
    logger.info('[Lit] Session sigs generation in progress — waiting...');
    return sessionSigsPromise;
  }

  sessionSigsPromise = (async () => {
    try {
      const {
        LitAccessControlConditionResource,
        LitActionResource,
        RecapSessionCapabilityObject,
      } = await import('@lit-protocol/auth-helpers');
      const { LIT_ABILITY } = await import('@lit-protocol/constants');
      const { SiweMessage } = await import('siwe');

      const capacityWallet = await getCapacityWallet();
      const expiration = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const accResource = new LitAccessControlConditionResource('*');
      const actionResource = new LitActionResource('*');

      const resourceAbilityRequests = [
        { resource: accResource, ability: LIT_ABILITY.AccessControlConditionDecryption },
        { resource: actionResource, ability: LIT_ABILITY.LitActionExecution },
      ];

      const sessionCapabilityObject = new RecapSessionCapabilityObject({}, []);
      sessionCapabilityObject.addCapabilityForResource(
        accResource,
        LIT_ABILITY.AccessControlConditionDecryption
      );
      sessionCapabilityObject.addCapabilityForResource(
        actionResource,
        LIT_ABILITY.LitActionExecution
      );

      const sessionOpts: any = {
        chain: 'ethereum',
        expiration,
        resourceAbilityRequests,
        sessionCapabilityObject,
        authNeededCallback: async (params: any) => {
          const siweMessage = new SiweMessage({
            domain: params.domain || 'localhost',
            address: wallet.address,
            statement: params.statement || 'Lit Protocol session signature',
            uri: params.uri || 'https://localhost/login',
            version: '1',
            chainId: 1,
            nonce: params.nonce || await client.getLatestBlockhash(),
            expirationTime: params.expiration || expiration,
            resources: params.resources || [],
          });
          const messageToSign = siweMessage.prepareMessage();
          const signature = await wallet.signMessage(messageToSign);
          return {
            sig: signature,
            derivedVia: 'web3.eth.personal.sign',
            signedMessage: messageToSign,
            address: wallet.address,
          };
        },
      };

      await ensureDelegateeRegistered(wallet.address);

      if (capacityWallet) {
        const tokenId = await detectCapacityTokenId(capacityWallet.address);
        if (tokenId) {
          try {
            const { capacityDelegationAuthSig } = await client.createCapacityDelegationAuthSig({
              dAppOwnerWallet: capacityWallet,
              capacityTokenId: tokenId,
              delegateeAddresses: [wallet.address],
              uses: '10',
              expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            });
            sessionOpts.capacityDelegationAuthSig = capacityDelegationAuthSig;
            logger.info(`[Lit] Capacity delegation attached (token #${tokenId})`);
          } catch (delegErr: any) {
            logger.warn(`[Lit] Capacity delegation auth sig failed (delegation DB should cover): ${delegErr.message}`);
          }
        } else {
          logger.warn('[Lit] No valid capacity token found — relying on Payment Delegation DB');
        }
      }

      const sessionSigs = await client.getSessionSigs(sessionOpts);
      logger.info(`[Lit] Session sigs generated (${Object.keys(sessionSigs).length} nodes) — cached for ${SESSION_SIGS_TTL_MS / 60000} min`);

      cachedSessionSigs = { sigs: sessionSigs, createdAt: Date.now() };
      return sessionSigs;
    } finally {
      sessionSigsPromise = null;
    }
  })();

  return sessionSigsPromise;
}

/**
 * POST /api/storage/lit/encrypt
 * Two-layer encryption: AES-GCM for the file, Lit Protocol for the CEK.
 *
 * 1. Generate a random AES-256 key (CEK)
 * 2. AES-GCM encrypt the file data with the CEK (no size limit)
 * 3. Lit-encrypt only the CEK (32 bytes) with access conditions
 *
 * Body: { data: string (base64), actionCid?: string }
 * Response: { ciphertext (Lit-encrypted CEK), dataToEncryptHash, actionCid,
 *             conditions, encryptedData (AES-encrypted file, base64), iv (base64) }
 */
router.post('/lit/encrypt', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data, actionCid } = req.body;

    if (!data) {
      res.status(400).json({ error: 'Missing required field: data (base64)' });
      return;
    }

    const effectiveActionCid = actionCid || NON_MEDIA_ACTION_CID;
    if (!effectiveActionCid) {
      res.status(400).json({
        error: 'No Lit Action CID configured. Set LIT_ACTION_CID env var or pass actionCid in request body.',
      });
      return;
    }

    const dataBytes = Buffer.from(data, 'base64');
    if (dataBytes.length === 0) {
      res.status(400).json({ error: 'Empty data' });
      return;
    }
    if (dataBytes.length > 100 * 1024 * 1024) {
      res.status(400).json({ error: 'Data exceeds 100MB limit' });
      return;
    }

    logger.info(`[Lit] Encrypting ${dataBytes.length} bytes (two-layer: AES + Lit CEK)`);

    // Layer 1: Generate CEK and AES-GCM encrypt the file
    const crypto = await import('crypto');
    const cek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv);
    const encrypted = Buffer.concat([cipher.update(dataBytes), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encryptedWithTag = Buffer.concat([encrypted, authTag]);

    logger.info(`[Lit] AES-GCM encrypted: ${dataBytes.length} → ${encryptedWithTag.length} bytes`);

    // Layer 2: Lit-encrypt only the raw CEK (32 bytes — well under 4MB limit)
    const cekBase64 = cek.toString('base64');
    let litCiphertext: string;
    let dataToEncryptHash: string;
    let conditions: any[];

    if (LIT_BACKEND === 'chipotle') {
      const { encryptWithLitAction, buildSelfRefConditions: buildConditions } = await import('./chipotle-client.js');
      conditions = buildConditions(effectiveActionCid);
      const encryptResult = await encryptWithLitAction({
        dataToEncrypt: new TextEncoder().encode(cekBase64),
        accessControlConditions: conditions,
      });
      litCiphertext = encryptResult.ciphertext;
      dataToEncryptHash = encryptResult.dataToEncryptHash;
      logger.info(`[Lit] CEK Lit-encrypted (${cek.length} bytes) via Chipotle. Hash: ${dataToEncryptHash?.substring(0, 20)}...`);
    } else {
      // Datil fallback
      const client = await getLitClient();
      conditions = buildSelfRefConditions(effectiveActionCid);
      const encryptResult = await client.encrypt({
        dataToEncrypt: new TextEncoder().encode(cekBase64),
        accessControlConditions: conditions,
      });
      litCiphertext = encryptResult.ciphertext;
      dataToEncryptHash = encryptResult.dataToEncryptHash;
      logger.info(`[Lit] CEK Lit-encrypted (${cek.length} bytes) via Datil SDK. Hash: ${dataToEncryptHash?.substring(0, 20)}...`);
    }

    res.json({
      success: true,
      litCiphertext,
      dataToEncryptHash,
      actionCid: effectiveActionCid,
      conditions,
      encryptedData: encryptedWithTag.toString('base64'),
      iv: iv.toString('base64'),
    });
  } catch (error: any) {
    logger.error('[Lit] Encryption error:', error);
    res.status(500).json({ error: error.message || 'Lit encryption failed' });
  }
});

/**
 * Shared two-layer decryption: Lit Action recovers CEK, then AES-GCM decrypts file.
 * Returns raw decrypted Buffer. Caller is responsible for zeroing it after use.
 */
interface DecryptParams {
  litCiphertext: string;
  dataToEncryptHash: string;
  iv: string;
  encryptedDataCid: string;
  kid: string;
  actionCid?: string;
  authority?: string;
  chain?: string;
  chainId?: number;
  rpc?: string;
  buyerAddress: string;
}

/**
 * Recover the CEK via Lit Protocol and fetch encrypted bytes from IPFS.
 * Returns { cekBase64, encryptedBytes } — the CEK is base64-encoded, the
 * encrypted bytes are raw. Neither the CEK nor plaintext is exposed here;
 * callers choose whether to AES-decrypt in Node.js or delegate to WASM.
 */
interface CEKRecoveryResult {
  cekBase64: string;
  encryptedBytes: Buffer;
}

async function recoverCEKAndFetchData(params: DecryptParams, ipfsService?: any): Promise<CEKRecoveryResult> {
  const {
    litCiphertext, dataToEncryptHash, encryptedDataCid, kid,
    actionCid, authority, chain, chainId, rpc, buyerAddress,
  } = params;

  logger.info(`[Lit] Recover CEK: kid=${kid}, buyer=${buyerAddress}, cid=${encryptedDataCid}`);

  // Kick off CEK recovery and IPFS fetch in parallel
  const litStart = Date.now();
  const cekPromise = (async () => {
    if (LIT_BACKEND === 'chipotle') {
      const { recoverNonMediaCEK } = await import('./chipotle-client.js');
      const cekBase64 = await recoverNonMediaCEK({
        litCiphertext,
        dataToEncryptHash,
        kid,
        buyerAddress,
        actionCid: actionCid || NON_MEDIA_ACTION_CID || undefined,
        authority,
        chain,
        chainId,
        rpc,
      });
      logger.info(`[Lit] CEK recovered in ${Date.now() - litStart}ms (Chipotle REST)`);
      return cekBase64;
    }

    // Datil fallback (LIT_BACKEND=datil)
    const wallet = await getServerWallet();
    const client = await getLitClient();
    const sessionSigs = await getExecuteSessionSigs(client, wallet);

    const effectiveActionCid = actionCid || NON_MEDIA_ACTION_CID;
    if (!effectiveActionCid) throw new Error('No Lit Action CID configured');
    const effectiveAuthority = authority || DEFAULT_AUTHORITY;
    const effectiveChain = chain || 'base';
    const effectiveRpc = rpc || DEFAULT_RPC;

    const executeParams: any = {
      sessionSigs,
      jsParams: {
        ciphertext: litCiphertext,
        dataToEncryptHash,
        kid: kid.startsWith('0x') ? kid : `0x${kid}`,
        actionIpfsId: effectiveActionCid,
        authority: effectiveAuthority,
        chain: effectiveChain,
        chainId: chainId || 8453,
        rpc: effectiveRpc,
        userAddress: buyerAddress,
      },
      ipfsId: effectiveActionCid,
    };

    const result = await client.executeJs(executeParams);
    if (!result.response) throw new Error('Lit Action returned empty response');

    let cekBase64: string;
    try {
      const parsed = JSON.parse(result.response);
      if (parsed.error) throw new Error(parsed.error);
      cekBase64 = parsed.data || result.response;
    } catch (e: any) {
      if (e.message?.includes('Access denied')) throw e;
      cekBase64 = result.response;
    }

    logger.info(`[Lit] CEK recovered in ${Date.now() - litStart}ms (Datil SDK)`);
    return cekBase64;
  })();

  // IPFS fetch: try local blockstore directly first, then HTTP fallback
  const ipfsStart = Date.now();
  const ipfsPromise = (async (): Promise<Buffer> => {
    // Direct local blockstore read — avoids HTTP round-trip to self
    if (ipfsService) {
      try {
        const bytes = await ipfsService.getFile(encryptedDataCid);
        if (bytes && bytes.length > 0) {
          logger.info(`[Lit] Fetched encrypted file: ${bytes.length} bytes from local blockstore (${Date.now() - ipfsStart}ms)`);
          return bytes;
        }
      } catch {
        logger.info(`[Lit] Local blockstore miss for ${encryptedDataCid}, trying HTTP...`);
      }
    }

    // HTTP fallback: localhost API then remote gateway
    const ipfsUrls = [
      `http://localhost:4200/ipfs/${encryptedDataCid}`,
      `https://ipfs.ela.city/ipfs/${encryptedDataCid}`,
    ];

    for (const url of ipfsUrls) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          logger.info(`[Lit] Fetched encrypted file: ${buf.length} bytes from ${url.includes('localhost') ? 'local IPFS' : 'Elacity IPFS'} (${Date.now() - ipfsStart}ms)`);
          return buf;
        }
      } catch { /* try next */ }
    }

    throw new Error(`Failed to fetch encrypted file from IPFS: ${encryptedDataCid}`);
  })();

  // Wait for both in parallel — IPFS fetch often completes while Lit is still working
  const [cekBase64, encryptedBytes] = await Promise.all([cekPromise, ipfsPromise]);

  if (!encryptedBytes || encryptedBytes.length === 0) {
    throw new Error(`Failed to fetch encrypted file from IPFS: ${encryptedDataCid}`);
  }

  return { cekBase64, encryptedBytes };
}

/**
 * Full two-layer decryption: Lit recovers CEK, AES-GCM decrypts file.
 * Primary path: WASM decrypt-only (CEK isolated in WASM linear memory).
 * Fallback: Node.js crypto for very large files or WASM failures.
 * Returns raw decrypted Buffer. Caller is responsible for zeroing it after use.
 */
const WASM_DECRYPT_MAX_BYTES = 50 * 1024 * 1024; // 50MB — above this, Node.js crypto is used

async function decryptAssetTwoLayer(params: DecryptParams, ipfsService?: any): Promise<Buffer> {
  const { cekBase64, encryptedBytes } = await recoverCEKAndFetchData(params, ipfsService);

  // WASM path: CEK stays in WASM linear memory
  if (encryptedBytes.length <= WASM_DECRYPT_MAX_BYTES) {
    try {
      const wasmBinary = await loadRendererBinary();
      const runtime = getWASMRuntime();
      const result = await runtime.executeDecryptOnly(
        wasmBinary,
        cekBase64,
        params.iv,
        'application/octet-stream',
        encryptedBytes,
        { timeoutMs: 60000 },
      );

      if (result.success && result.decryptedBytes) {
        logger.info(`[Lit] Two-layer decrypt (WASM): ${result.decryptedBytes.length} bytes in ${result.executionTimeMs}ms for ${params.buyerAddress}`);
        return result.decryptedBytes;
      }

      logger.warn(`[Lit] WASM decrypt-only failed (${result.error}), falling back to Node.js`);
    } catch (wasmErr: any) {
      logger.warn(`[Lit] WASM decrypt-only error: ${wasmErr.message}, falling back to Node.js`);
    }
  } else {
    logger.info(`[Lit] File too large for WASM decrypt (${encryptedBytes.length}B > ${WASM_DECRYPT_MAX_BYTES}B), using Node.js`);
  }

  // Node.js fallback
  const crypto = await import('crypto');
  const cekBytes = Buffer.from(cekBase64, 'base64');
  const ivBytes = Buffer.from(params.iv, 'base64');

  if (cekBytes.length !== 32) {
    logger.warn(`[Lit] CEK length unexpected: ${cekBytes.length} bytes (expected 32)`);
  }

  const authTagLength = 16;
  const ciphertextOnly = encryptedBytes.subarray(0, encryptedBytes.length - authTagLength);
  const authTag = encryptedBytes.subarray(encryptedBytes.length - authTagLength);

  const decipher = crypto.createDecipheriv('aes-256-gcm', cekBytes, ivBytes);
  decipher.setAuthTag(authTag);
  const decryptedBytes = Buffer.concat([decipher.update(ciphertextOnly), decipher.final()]);

  cekBytes.fill(0);

  if (decryptedBytes.length === 0) throw new Error('AES decryption returned empty data');

  logger.info(`[Lit] Two-layer decrypt (Node.js fallback): ${decryptedBytes.length} bytes for ${params.buyerAddress}`);
  return decryptedBytes;
}

/**
 * POST /api/storage/lit/decrypt
 * DEPRECATED — raw plaintext endpoint removed for security.
 * Use /api/storage/lit/secure-view instead, which returns only rendered pixels.
 */
router.post('/lit/decrypt', authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  res.status(410).json({
    error: 'This endpoint has been removed for security. Use /api/storage/lit/secure-view instead.',
  });
});

// ── WASM Renderer Integration ────────────────────────────────────────
//
// The dDRM WASM renderer performs decryption + rendering inside WASM linear
// memory, ensuring CEK and plaintext never touch Node.js memory.
// Path: wasm-apps/ddrm-renderer/ddrm-renderer.wasm

const DDRM_RENDERER_PATH = 'wasm-apps/ddrm-renderer/ddrm-renderer.wasm';
let cachedRendererBinary: ArrayBuffer | null = null;

async function loadRendererBinary(): Promise<ArrayBuffer> {
  if (cachedRendererBinary) return cachedRendererBinary;
  const runtime = getWASMRuntime();
  cachedRendererBinary = await runtime.loadFromFile(DDRM_RENDERER_PATH);
  logger.info(`[SecureView] dDRM renderer WASM loaded (${cachedRendererBinary.byteLength} bytes)`);
  return cachedRendererBinary;
}

interface WASMRenderResult {
  contentType: string;
  rendered: Buffer;
  totalPages?: number;
  executionTimeMs: number;
}

/**
 * Render an asset via the WASM universal renderer.
 * Recovers CEK from Lit, fetches encrypted bytes from IPFS, then delegates
 * decryption + rendering to the WASM sandbox. Returns null if WASM rendering
 * is not available for the given MIME type.
 */
async function renderViaWASM(
  params: DecryptParams,
  mime: string,
  maxWidth: number,
  page?: number,
  ipfsService?: any,
): Promise<WASMRenderResult | null> {
  const { cekBase64, encryptedBytes } = await recoverCEKAndFetchData(params, ipfsService);

  const watermarkText = `${params.buyerAddress.substring(0, 10)}...${params.buyerAddress.substring(params.buyerAddress.length - 6)} ${new Date().toISOString().split('T')[0]}`;

  const command: RendererCommand = {
    cek_b64: cekBase64,
    iv_b64: params.iv,
    mime_type: mime,
    watermark: watermarkText,
    page: page ? page - 1 : undefined,
    max_width: maxWidth,
    max_height: Math.round(maxWidth * 1.5),
    output_format: 'jpeg',
  };

  const wasmBinary = await loadRendererBinary();
  const runtime = getWASMRuntime();
  const output = await runtime.executeRenderer(wasmBinary, command, encryptedBytes, {
    timeoutMs: 60000,
  });

  if (!output.result.success) {
    throw new Error(`WASM renderer: ${output.result.error}`);
  }

  if (!output.renderedBytes) {
    throw new Error('WASM renderer produced no output');
  }

  return {
    contentType: output.result.content_type || 'image/jpeg',
    rendered: output.renderedBytes,
    totalPages: output.result.total_pages,
    executionTimeMs: output.executionTimeMs,
  };
}

/**
 * POST /api/storage/lit/secure-view
 * Secure viewer: decrypts asset server-side, renders to lossy image, streams binary.
 * The raw file NEVER leaves server memory. Browser receives only rendered pixels.
 *
 * Primary path: WASM renderer (CEK/plaintext confined to WASM linear memory)
 * Fallback: Node.js Sharp/Canvas/PDF.js (for PDFs or when WASM unavailable)
 *
 * Body: same as /lit/decrypt, plus:
 *   mimeType: string,   -- original asset MIME (image/png, application/pdf, etc.)
 *   page?: number,       -- page number for PDFs (1-indexed, default 1)
 *   maxWidth?: number,   -- max render width (default 1200)
 *
 * Response: binary image stream (image/jpeg or image/png)
 *   Headers: X-Asset-Type, X-Asset-Pages (for PDFs), X-Watermark, X-Renderer
 */
router.post('/lit/secure-view', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const requestStart = Date.now();
  try {
    const {
      litCiphertext, dataToEncryptHash, iv, encryptedDataCid, kid,
      buyerAddress, mimeType,
      page: pageNum,
      maxWidth: reqMaxWidth,
    } = req.body;

    if (!litCiphertext || !dataToEncryptHash || !kid || !buyerAddress || !iv || !encryptedDataCid) {
      res.status(400).json({ error: 'Missing required fields for secure view' });
      return;
    }

    const mime = (mimeType || 'application/octet-stream').toLowerCase();
    const maxWidth = Math.min(reqMaxWidth || 1200, 2400);

    // Security headers
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'X-Asset-Type': mime,
      'X-Watermark': buyerAddress,
    });

    const ipfsService = req.app.locals.ipfs;

    // ── WASM Renderer Path ──────────────────────────────
    // For images, text, and PDFs: decrypt + render inside WASM linear memory.
    // CEK and plaintext never touch Node.js memory.
    const wasmCodeTypes = ['application/javascript', 'application/json', 'application/xml', 'application/x-yaml', 'application/toml', 'application/x-sh'];
    const wasmSupportedTypes = mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/pdf' || wasmCodeTypes.includes(mime);
    if (wasmSupportedTypes) {
      try {
        const wasmResult = await renderViaWASM(req.body, mime, maxWidth, pageNum, ipfsService);
        if (wasmResult) {
          res.set('Content-Type', wasmResult.contentType);
          res.set('Content-Length', String(wasmResult.rendered.length));
          res.set('X-Renderer', 'wasm');
          if (wasmResult.totalPages) {
            res.set('X-Asset-Pages', String(wasmResult.totalPages));
          }
          res.send(wasmResult.rendered);
          logger.info(`[SecureView] WASM rendered ${mime}: ${wasmResult.rendered.length} bytes (wasm: ${wasmResult.executionTimeMs}ms, total: ${Date.now() - requestStart}ms) for ${buyerAddress}`);
          return;
        }
      } catch (wasmErr: any) {
        logger.warn(`[SecureView] WASM renderer failed, falling back to Node.js: ${wasmErr.message}`);
      }
    }

    // ── Node.js Fallback Path ───────────────────────────
    // Used for PDFs (WASM PDF not yet implemented) and when WASM fails.
    const decryptedBytes = await decryptAssetTwoLayer(req.body, ipfsService);

    // ── Image pipeline (fallback) ────────────────────────
    if (mime.startsWith('image/')) {
      let sharpMod: any;
      try {
        const mod = await import('sharp');
        sharpMod = mod.default || mod;
      } catch {
        decryptedBytes.fill(0);
        res.status(500).json({ error: 'Sharp not available for image rendering' });
        return;
      }

      const watermarkText = `${buyerAddress.substring(0, 10)}...${buyerAddress.substring(buyerAddress.length - 6)}`;
      const timestamp = new Date().toISOString().split('T')[0];

      const metadata = await sharpMod(decryptedBytes).metadata();
      const imgW = Math.min(metadata.width || 800, maxWidth);
      const imgH = metadata.height ? Math.round(metadata.height * (imgW / (metadata.width || 800))) : 600;

      const watermarkSvg = Buffer.from(`<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="wm" x="0" y="0" width="320" height="180" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)">
            <text x="10" y="30" font-family="monospace" font-size="13" fill="rgba(255,255,255,0.18)" stroke="rgba(0,0,0,0.08)" stroke-width="0.5">${watermarkText}</text>
            <text x="10" y="52" font-family="monospace" font-size="10" fill="rgba(255,255,255,0.12)">${timestamp}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`);

      const rendered = await sharpMod(decryptedBytes)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .composite([{ input: watermarkSvg, gravity: 'centre' }])
        .jpeg({ quality: 82 })
        .toBuffer();

      decryptedBytes.fill(0);

      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Length', String(rendered.length));
      res.set('X-Renderer', 'nodejs-sharp');
      res.send(rendered);

      logger.info(`[SecureView] Image rendered (fallback): ${rendered.length} bytes (${imgW}x${imgH}, total: ${Date.now() - requestStart}ms) for ${buyerAddress}`);
      return;
    }

    // ── PDF pipeline ─────────────────────────────────────
    if (mime === 'application/pdf') {
      let pdfjsMod: any;
      let canvasMod: any;
      let sharpMod: any;
      try {
        pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.mjs');
        canvasMod = await import('canvas');
        const smod = await import('sharp');
        sharpMod = smod.default || smod;
      } catch {
        decryptedBytes.fill(0);
        res.status(500).json({ error: 'PDF.js/Canvas/Sharp not available for PDF rendering' });
        return;
      }

      const createCanvas = canvasMod.createCanvas;
      const registerFont = canvasMod.registerFont;
      const uint8 = new Uint8Array(decryptedBytes);

      const pdfjsResolved = fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
      const fontDir = join(dirname(pdfjsResolved), '..', '..', 'standard_fonts');

      if (registerFont) {
        const fonts = [
          { file: 'LiberationSans-Regular.ttf', family: 'LiberationSans' },
          { file: 'LiberationSans-Bold.ttf', family: 'LiberationSans', weight: 'bold' },
          { file: 'LiberationSans-Italic.ttf', family: 'LiberationSans', style: 'italic' },
          { file: 'LiberationSans-BoldItalic.ttf', family: 'LiberationSans', weight: 'bold', style: 'italic' },
        ];
        for (const f of fonts) {
          try { registerFont(join(fontDir, f.file), { family: f.family, weight: f.weight, style: f.style }); } catch { /* already registered */ }
        }
      }

      class NodeCanvasFactory {
        create(w: number, h: number) { const c = createCanvas(w, h); return { canvas: c, context: c.getContext('2d') }; }
        reset(cc: any, w: number, h: number) { cc.canvas.width = w; cc.canvas.height = h; }
        destroy(cc: any) { cc.canvas.width = 0; cc.canvas.height = 0; }
      }

      const pdfDoc = await pdfjsMod.getDocument({
        data: uint8,
        canvasFactory: new NodeCanvasFactory(),
        useSystemFonts: true,
        disableFontFace: true,
      }).promise;
      const totalPages = pdfDoc.numPages;
      const requestedPage = Math.max(1, Math.min(pageNum || 1, totalPages));

      const pdfPage = await pdfDoc.getPage(requestedPage);
      const viewport = pdfPage.getViewport({ scale: 1.0 });
      const scale = Math.min(maxWidth / viewport.width, 2.0);
      const scaledVp = pdfPage.getViewport({ scale });

      const cvs = createCanvas(scaledVp.width, scaledVp.height);
      const ctx = cvs.getContext('2d');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, scaledVp.width, scaledVp.height);

      await pdfPage.render({ canvasContext: ctx, viewport: scaledVp }).promise;

      const textContent = await pdfPage.getTextContent();
      ctx.fillStyle = '#000000';
      for (const item of textContent.items as any[]) {
        if (!item.str || !item.transform) continue;
        const tx = item.transform;
        const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) * scale;
        const x = tx[4] * scale;
        const y = scaledVp.height - (tx[5] * scale);
        ctx.font = `${fontSize}px LiberationSans, Helvetica, Arial, sans-serif`;
        ctx.fillText(item.str, x, y);
      }

      const wmText = `${buyerAddress.substring(0, 10)}...${buyerAddress.substring(buyerAddress.length - 6)}`;
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.font = '18px monospace';
      ctx.fillStyle = '#888';
      ctx.translate(scaledVp.width / 2, scaledVp.height / 2);
      ctx.rotate(-Math.PI / 6);
      for (let y = -scaledVp.height; y < scaledVp.height; y += 120) {
        for (let x = -scaledVp.width; x < scaledVp.width; x += 280) {
          ctx.fillText(wmText, x, y);
        }
      }
      ctx.restore();

      const pngBuf = cvs.toBuffer('image/png');
      decryptedBytes.fill(0);

      const rendered = await sharpMod(pngBuf).jpeg({ quality: 85 }).toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Length', String(rendered.length));
      res.set('X-Asset-Pages', String(totalPages));
      res.set('X-Asset-Page', String(requestedPage));
      res.set('X-Renderer', 'nodejs-pdfjs');
      res.send(rendered);

      logger.info(`[SecureView] PDF page ${requestedPage}/${totalPages} rendered: ${rendered.length} bytes (total: ${Date.now() - requestStart}ms) for ${buyerAddress}`);
      return;
    }

    // ── Text pipeline (fallback) ─────────────────────────
    if (mime.startsWith('text/')) {
      let canvasMod: any;
      let sharpMod: any;
      try {
        canvasMod = await import('canvas');
        const smod = await import('sharp');
        sharpMod = smod.default || smod;
      } catch {
        decryptedBytes.fill(0);
        res.status(500).json({ error: 'Canvas/Sharp not available for text rendering' });
        return;
      }

      const createCanvas = canvasMod.createCanvas;
      const text = decryptedBytes.toString('utf8');
      decryptedBytes.fill(0);

      const fontSize = 14;
      const lineHeight = 20;
      const padding = 24;
      const canvasW = 640;
      const maxCharsPerLine = Math.floor((canvasW - padding * 2) / (fontSize * 0.6));
      const maxOutputLines = 2000;

      // Word-wrap all lines
      const wrappedLines: string[] = [];
      for (const rawLine of text.split('\n')) {
        if (wrappedLines.length >= maxOutputLines) break;
        if (rawLine.trim() === '') {
          wrappedLines.push('');
          continue;
        }
        const words = rawLine.split(/\s+/);
        let current = '';
        for (const word of words) {
          if (wrappedLines.length >= maxOutputLines) break;
          if (current.length + word.length + 1 > maxCharsPerLine && current.length > 0) {
            wrappedLines.push(current);
            current = '';
          }
          if (word.length > maxCharsPerLine && current.length === 0) {
            for (let s = 0; s < word.length && wrappedLines.length < maxOutputLines; s += maxCharsPerLine) {
              wrappedLines.push(word.substring(s, s + maxCharsPerLine));
            }
            continue;
          }
          current = current.length > 0 ? current + ' ' + word : word;
        }
        if (current.length > 0 && wrappedLines.length < maxOutputLines) {
          wrappedLines.push(current);
        }
      }

      const canvasH = Math.max(200, padding * 2 + wrappedLines.length * lineHeight);

      const cvs = createCanvas(canvasW, canvasH);
      const ctx = cvs.getContext('2d');

      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, canvasW, canvasH);

      ctx.fillStyle = '#d4d4d4';
      ctx.font = `${fontSize}px monospace`;
      ctx.textBaseline = 'top';

      let y = padding;
      for (const line of wrappedLines) {
        if (y + lineHeight > canvasH - padding) break;
        ctx.fillText(line, padding, y);
        y += lineHeight;
      }

      const wmText = `${buyerAddress.substring(0, 10)}...${buyerAddress.substring(buyerAddress.length - 6)}`;
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.font = '16px monospace';
      ctx.fillStyle = '#aaa';
      ctx.translate(canvasW / 2, canvasH / 2);
      ctx.rotate(-Math.PI / 6);
      for (let wy = -canvasH; wy < canvasH; wy += 100) {
        for (let wx = -canvasW; wx < canvasW; wx += 260) {
          ctx.fillText(wmText, wx, wy);
        }
      }
      ctx.restore();

      const pngBuf = cvs.toBuffer('image/png');
      const rendered = await sharpMod(pngBuf).jpeg({ quality: 85 }).toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Length', String(rendered.length));
      res.set('X-Renderer', 'nodejs-canvas');
      res.send(rendered);

      logger.info(`[SecureView] Text rendered (fallback): ${rendered.length} bytes (${wrappedLines.length} lines, total: ${Date.now() - requestStart}ms) for ${buyerAddress}`);
      return;
    }

    // ── Audio passthrough ─────────────────────────────────
    // Audio can't be rendered as an image — decrypt and pass through for playback.
    // The viewer displays an HTML5 audio player with anti-piracy measures.
    if (mime.startsWith('audio/')) {
      const audioLen = decryptedBytes.length;
      res.set('Content-Type', mime);
      res.set('Content-Length', String(audioLen));
      res.set('X-Renderer', 'passthrough');
      res.set('X-Asset-Type', 'audio');
      res.send(Buffer.from(decryptedBytes));
      decryptedBytes.fill(0);
      logger.info(`[SecureView] Audio passthrough: ${mime}, ${audioLen} bytes (total: ${Date.now() - requestStart}ms) for ${buyerAddress}`);
      return;
    }

    // ── Unsupported type ─────────────────────────────────
    decryptedBytes.fill(0);
    res.status(415).json({
      error: `Secure viewing not yet supported for ${mime}. Use /lit/decrypt for raw access.`,
      mimeType: mime,
    });

  } catch (error: any) {
    logger.error('[SecureView] Error:', error);
    const status = error.message?.includes('Access denied') ? 403 : 500;
    res.status(status).json({ error: error.message || 'Secure view failed' });
  }
});

/**
 * GET /api/storage/lit/server-info
 * Returns the server wallet address and current Lit Action CID.
 */
router.get('/lit/server-info', async (_req: any, res: Response) => {
  try {
    const wallet = await getServerWallet();
    const info: any = {
      address: wallet.address,
      actionCid: NON_MEDIA_ACTION_CID || null,
      authority: DEFAULT_AUTHORITY,
      backend: LIT_BACKEND,
    };

    if (LIT_BACKEND === 'chipotle') {
      const { getChipotleInfo } = await import('./chipotle-client.js');
      const chipotleInfo = getChipotleInfo();
      info.chipotle = chipotleInfo;
    }

    res.json(info);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/lit/deploy-action
 * Deploy the non-media Lit Action to IPFS and configure it for use.
 * This uploads the Lit Action JS code to Elacity's IPFS and sets the CID.
 */
router.post('/lit/deploy-action', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actionPath = join(__litDirname, '../../data/lit-actions/non-media-decrypt.js');
    if (!existsSync(actionPath)) {
      res.status(404).json({ error: 'Lit Action source not found at data/lit-actions/non-media-decrypt.js' });
      return;
    }

    const actionCode = readFileSync(actionPath, 'utf8');
    const actionBytes = Buffer.from(actionCode, 'utf8');

    logger.info(`[Lit] Deploying non-media Lit Action (${actionBytes.length} bytes) to IPFS...`);

    const ELACITY_UPLOAD = 'https://base.ela.city/api/2.0/files/upload';
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(actionBytes)]), 'non-media-decrypt.js');

    const uploadResp = await fetch(ELACITY_UPLOAD, {
      method: 'POST',
      headers: { 'X-Target-Flow': 'ipfs' },
      body: formData,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      res.status(502).json({ error: `IPFS upload failed: ${errText}` });
      return;
    }

    const uploadResult = await uploadResp.json() as any;
    let cid: string | undefined;

    if (uploadResult.cid || uploadResult.Hash || uploadResult.hash) {
      cid = uploadResult.cid || uploadResult.Hash || uploadResult.hash;
    } else if (Array.isArray(uploadResult) && uploadResult[0]?.path) {
      cid = uploadResult[0].path;
    }

    if (!cid) {
      res.status(502).json({ error: 'IPFS upload returned no CID', raw: uploadResult });
      return;
    }

    NON_MEDIA_ACTION_CID = cid;
    logger.info(`[Lit] Non-media Lit Action deployed: ${cid}`);

    const cidPath = join(__litDirname, '../../data/.lit-action-cid');
    writeFileSync(cidPath, cid, 'utf8');

    res.json({
      success: true,
      actionCid: cid,
      ipfsUrl: `https://ipfs.ela.city/ipfs/${cid}`,
    });
  } catch (error: any) {
    logger.error('[Lit] Deploy action error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/storage/ipfs/upload-elacity
 * Upload content to Elacity's IPFS infrastructure for public reachability.
 *
 * Reads raw bytes from the request body (base64) or from a local CID,
 * then uploads to Elacity's IPFS endpoint. Returns the CID that resolves
 * on ipfs.ela.city — no third-party services, fully within the ecosystem.
 *
 * Body: { content: string (base64), filename?: string }
 *   OR: { cid: string, filename?: string }   — reads from local IPFS first
 * Response: { success: true, cid: string, size: number }
 */

router.post('/thumbnail', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { content, mimeType, filename } = req.body;
    if (!content || !mimeType) {
      res.status(400).json({ error: 'content and mimeType are required' });
      return;
    }
    const { generateThumbnail } = await import('../storage/thumbnail.js');
    const buf = Buffer.from(content, 'base64');
    const thumb = await generateThumbnail(buf, mimeType, filename || 'file');
    // Strip data URI prefix if present — callers expect raw base64
    let rawBase64 = thumb;
    if (rawBase64 && rawBase64.includes(',')) {
      rawBase64 = rawBase64.split(',')[1];
    }
    res.json({ thumbnail: rawBase64 });
  } catch (err: any) {
    logger.error('[Thumbnail API] Error:', err.message);
    res.status(500).json({ error: 'Thumbnail generation failed' });
  }
});

router.post('/ipfs/upload-elacity', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ELACITY_UPLOAD = 'https://base.ela.city/api/2.0/files/upload';
    const { content, cid, filename } = req.body;

    let bytes: Buffer;

    if (content) {
      bytes = Buffer.from(content, 'base64');
    } else if (cid) {
      const ipfs = req.app.locals.ipfs;
      if (!ipfs) {
        res.status(503).json({ error: 'IPFS not available' });
        return;
      }
      bytes = await ipfs.getFile(cid);
    } else {
      res.status(400).json({ error: 'Provide either content (base64) or cid' });
      return;
    }

    if (!bytes || bytes.length === 0) {
      res.status(400).json({ error: 'Empty content' });
      return;
    }

    logger.info(`[IPFS-Elacity] Uploading ${bytes.length} bytes to Elacity IPFS...`);

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(bytes)]), filename || 'content');

    const uploadResp = await fetch(ELACITY_UPLOAD, {
      method: 'POST',
      headers: { 'X-Target-Flow': 'ipfs' },
      body: formData,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      logger.error(`[IPFS-Elacity] Upload failed: ${uploadResp.status} ${errText}`);
      res.status(502).json({ error: `Elacity IPFS upload failed: ${uploadResp.status}` });
      return;
    }

    const uploadData = await uploadResp.json() as Array<{
      path: string; storage: string; size: number; originalFileName: string;
    }>;

    if (!uploadData?.[0]?.path) {
      res.status(502).json({ error: 'No CID returned from Elacity IPFS' });
      return;
    }

    const remoteCid = uploadData[0].path;
    const remoteSize = uploadData[0].size;

    logger.info(`[IPFS-Elacity] Pinned: ${remoteCid} (${remoteSize} bytes)`);

    res.json({
      success: true,
      cid: remoteCid,
      size: remoteSize,
    });
  } catch (error: any) {
    logger.error('[IPFS-Elacity] Upload error:', error);
    res.status(500).json({ error: error.message || 'Elacity IPFS upload failed' });
  }
});

// Backend-specific initialization
if (LIT_BACKEND === 'datil') {
  // Pre-warm Lit SDK client + session sigs (Datil only — ~5s cold-connect)
  setTimeout(async () => {
    try {
      const [wallet, client] = await Promise.all([getServerWallet(), getLitClient()]);
      await getExecuteSessionSigs(client, wallet);
      logger.info('[Lit] Pre-warm complete: Datil client connected + session sigs cached');
    } catch (err: any) {
      logger.warn(`[Lit] Pre-warm failed (will retry on first request): ${err.message}`);
    }
  }, 2000);
} else {
  logger.info('[Lit] Chipotle REST backend — no pre-warm needed (stateless HTTP)');
}

export { getServerWallet, getLitClient, getExecuteSessionSigs, ensureDelegateeRegistered, getCapacityWallet, detectCapacityTokenId };
export default router;
