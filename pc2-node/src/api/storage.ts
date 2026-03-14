/**
 * Storage API Endpoint
 * 
 * Provides storage usage statistics including IPFS CID data
 */

import { Router, Response } from 'express';
import { authenticate, AuthenticatedRequest } from './middleware.js';
import { logger } from '../utils/logger.js';
import { getEffectiveStorageLimit } from './info.js';

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

/**
 * POST /api/storage/lit/encrypt
 * Server-side Lit Protocol encryption.
 *
 * The Lit SDK's multi-node handshake cannot run inside the PC2 iframe
 * (CSP/CORS restrictions). This endpoint moves encryption to the backend
 * where outbound HTTPS is unrestricted.
 *
 * encrypt() does not require a wallet or session sigs — it stores key
 * shares on Lit nodes gated by the provided access conditions.
 *
 * Body: { data: string (base64), ledger: string, tokenId: string }
 * Response: { success: true, ciphertext: string (base64), dataToEncryptHash: string }
 */
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

  const { LitNodeClient } = await import('@lit-protocol/lit-node-client');
  const { LIT_NETWORK } = await import('@lit-protocol/constants');

  litClientInstance = new LitNodeClient({
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

router.post('/lit/encrypt', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data, ledger, tokenId } = req.body;

    if (!data || !ledger || !tokenId) {
      res.status(400).json({ error: 'Missing required fields: data (base64), ledger, tokenId' });
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

    logger.info(`[Lit] Encrypting ${dataBytes.length} bytes for ${ledger}:${tokenId}`);

    const client = await getLitClient();

    const conditions = [
      {
        conditionType: 'evmContract',
        contractAddress: ledger,
        chain: 'base',
        functionName: 'balanceOf',
        functionParams: [':userAddress', tokenId],
        functionAbi: {
          name: 'balanceOf',
          inputs: [
            { name: 'account', type: 'address' },
            { name: 'id', type: 'uint256' },
          ],
          outputs: [
            { name: 'balance', type: 'uint256' },
          ],
          stateMutability: 'view',
          type: 'function',
        },
        returnValueTest: {
          key: '',
          comparator: '>',
          value: '0',
        },
      },
    ];

    const encryptResult = await client.encrypt({
      dataToEncrypt: new Uint8Array(dataBytes),
      unifiedAccessControlConditions: conditions,
    });

    logger.info(`[Lit] Encryption complete. Hash: ${encryptResult.dataToEncryptHash?.substring(0, 20)}...`);

    res.json({
      success: true,
      ciphertext: encryptResult.ciphertext,
      dataToEncryptHash: encryptResult.dataToEncryptHash,
      conditions,
    });
  } catch (error: any) {
    logger.error('[Lit] Encryption error:', error);
    res.status(500).json({ error: error.message || 'Lit encryption failed' });
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

