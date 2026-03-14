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

function getConfiguredCapacityTokenId(): string {
  if (process.env.LIT_CAPACITY_TOKEN_ID) return process.env.LIT_CAPACITY_TOKEN_ID;
  if (existsSync(CAPACITY_TOKEN_ID_PATH)) return readFileSync(CAPACITY_TOKEN_ID_PATH, 'utf8').trim();
  return '';
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

  logger.warn('[Lit] No capacity credit wallet found. Decrypt will use authSig fallback (may hit rate limits).');
  logger.warn('[Lit] To fix: set LIT_CAPACITY_KEY env var or create data/.lit-capacity-key with the private key of the RLI token owner.');
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
async function getExecuteSessionSigs(client: any, wallet: any) {
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

  if (capacityWallet) {
    const tokenId = await detectCapacityTokenId(capacityWallet.address);
    if (tokenId) {
      const { capacityDelegationAuthSig } = await client.createCapacityDelegationAuthSig({
        dAppOwnerWallet: capacityWallet,
        capacityTokenId: tokenId,
        delegateeAddresses: [wallet.address],
        uses: '10',
        expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
      sessionOpts.capacityDelegationAuthSig = capacityDelegationAuthSig;
      logger.info(`[Lit] Capacity delegation attached (token #${tokenId})`);
    } else {
      logger.warn('[Lit] No valid capacity token found, proceeding without delegation');
    }
  }

  const sessionSigs = await client.getSessionSigs(sessionOpts);
  logger.info(`[Lit] Session sigs generated (${Object.keys(sessionSigs).length} nodes)`);
  return sessionSigs;
}

/**
 * POST /api/storage/lit/encrypt
 * Server-side Lit Protocol encryption using Lit Action access conditions.
 *
 * Access is gated by a two-layer Lit Action system (same as Elacity's media DRM):
 *   1) Self-referential check: only the designated outer Lit Action can decrypt
 *   2) Inner Lit Action: checks AuthorityGateway.hasAccessByContentId() on-chain
 *
 * This means no private keys are needed for decryption — the Lit network
 * enforces access trustlessly via smart contracts.
 *
 * Body: { data: string (base64), actionCid?: string }
 * Response: { ciphertext, dataToEncryptHash, actionCid, conditions }
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

    logger.info(`[Lit] Encrypting ${dataBytes.length} bytes (action: ${effectiveActionCid})`);

    const client = await getLitClient();
    const conditions = buildSelfRefConditions(effectiveActionCid);

    const encryptResult = await client.encrypt({
      dataToEncrypt: new Uint8Array(dataBytes),
      unifiedAccessControlConditions: conditions,
    });

    logger.info(`[Lit] Encryption complete. Hash: ${encryptResult.dataToEncryptHash?.substring(0, 20)}...`);

    res.json({
      success: true,
      ciphertext: encryptResult.ciphertext,
      dataToEncryptHash: encryptResult.dataToEncryptHash,
      actionCid: effectiveActionCid,
      conditions,
    });
  } catch (error: any) {
    logger.error('[Lit] Encryption error:', error);
    res.status(500).json({ error: error.message || 'Lit encryption failed' });
  }
});

/**
 * POST /api/storage/lit/decrypt
 * Server-side Lit Protocol decryption via executeJs (Lit Action pattern).
 *
 * Uses the same two-layer architecture as Elacity's media DRM:
 *   - Outer Lit Action: our non-media decrypt action
 *   - Inner Lit Action: Elacity's on-chain access check (hasAccessByContentId)
 *
 * The Lit network verifies access trustlessly — the server only proxies
 * the request and passes the buyer's session context.
 *
 * Body: {
 *   ciphertext: string,
 *   dataToEncryptHash: string,
 *   kid: string,                   -- content identifier (bytes16)
 *   actionCid?: string,            -- outer Lit Action CID (defaults to env)
 *   authority?: string,            -- AuthorityGateway address
 *   chain?: string,                -- chain name (default: "base")
 *   chainId?: number,              -- chain ID (default: 8453)
 *   rpc?: string,                  -- RPC endpoint
 *   buyerAddress: string,          -- wallet claiming access
 *   accountOverride?: string,      -- Smart Account address (if using UA)
 * }
 * Response: { success: true, data: string (base64) }
 */
router.post('/lit/decrypt', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      ciphertext, dataToEncryptHash, kid,
      actionCid, authority, chain, chainId, rpc,
      buyerAddress,
    } = req.body;

    if (!ciphertext || !dataToEncryptHash || !kid || !buyerAddress) {
      res.status(400).json({
        error: 'Missing required fields: ciphertext, dataToEncryptHash, kid, buyerAddress',
      });
      return;
    }

    const effectiveActionCid = actionCid || NON_MEDIA_ACTION_CID;
    if (!effectiveActionCid) {
      res.status(400).json({ error: 'No Lit Action CID configured' });
      return;
    }

    const effectiveAuthority = authority || DEFAULT_AUTHORITY;
    const effectiveChain = chain || 'base';
    const effectiveRpc = rpc || DEFAULT_RPC;

    logger.info(`[Lit] Decrypt via executeJs: kid=${kid}, buyer=${buyerAddress}, action=${effectiveActionCid}`);

    const actionSourcePath = join(__litDirname, '../../data/lit-actions/non-media-decrypt.js');
    const litActionCode = existsSync(actionSourcePath) ? readFileSync(actionSourcePath, 'utf8') : '';

    const wallet = await getServerWallet();
    const client = await getLitClient();
    const sessionSigs = await getExecuteSessionSigs(client, wallet);

    const executeParams: any = {
      sessionSigs,
      jsParams: {
        ciphertext,
        dataToEncryptHash,
        kid,
        actionIpfsId: effectiveActionCid,
        authority: effectiveAuthority,
        chain: effectiveChain,
        chainId: chainId || 8453,
        rpc: effectiveRpc,
        userAddress: buyerAddress,
      },
    };

    if (litActionCode) {
      executeParams.code = litActionCode;
      logger.info('[Lit] Using inline code (avoids IPFS gateway fetch)');
    } else {
      executeParams.ipfsId = effectiveActionCid;
      logger.info('[Lit] Using ipfsId (action source not on disk)');
    }

    const result = await client.executeJs(executeParams);

    if (!result.response) {
      res.status(500).json({ error: 'Lit Action returned empty response' });
      return;
    }

    let responseData: string;
    try {
      const parsed = JSON.parse(result.response);
      if (parsed.error) {
        res.status(403).json({ error: parsed.error });
        return;
      }
      responseData = parsed.data || result.response;
    } catch {
      responseData = result.response;
    }

    const decryptedBytes = Buffer.from(responseData, 'base64');
    if (decryptedBytes.length === 0) {
      res.status(500).json({ error: 'Decryption returned empty data' });
      return;
    }

    logger.info(`[Lit] Decryption complete: ${decryptedBytes.length} bytes for ${buyerAddress}`);

    res.json({
      success: true,
      data: decryptedBytes.toString('base64'),
      size: decryptedBytes.length,
    });
  } catch (error: any) {
    logger.error('[Lit] Decryption error:', error);
    res.status(500).json({ error: error.message || 'Lit decryption failed' });
  }
});

/**
 * GET /api/storage/lit/server-info
 * Returns the server wallet address and current Lit Action CID.
 */
router.get('/lit/server-info', async (_req: any, res: Response) => {
  try {
    const wallet = await getServerWallet();
    res.json({
      address: wallet.address,
      actionCid: NON_MEDIA_ACTION_CID || null,
      authority: DEFAULT_AUTHORITY,
    });
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

export default router;

