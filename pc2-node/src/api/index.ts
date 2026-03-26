import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DatabaseManager, FilesystemManager } from '../storage/index.js';
import { Config } from '../config/loader.js';
import { Server as SocketIOServer } from 'socket.io';
import { authenticate, corsMiddleware, errorHandler, AuthenticatedRequest } from './middleware.js';
import { logger, createLogger } from '../utils/logger.js';
const log = createLogger('api-index');
import { handleWhoami } from './whoami.js';
import { handleParticleAuth, handleGrantUserApp, handleGetUserAppToken } from './auth.js';
import { handleStat, handleReaddir, handleRead, handleWrite, handleMkdir, handleDelete, handleMove, handleRename, handleCopy } from './filesystem.js';
import { handleSign, handleVersion, handleOSUser, handleKV, handleRAO, handleContactUs, handleDriversCall, handleGetWallets, handleOpenItem, handleSuggestApps, handleItemMetadata, handleWriteFile, handleSetDesktopBg, handleSetProfilePicture } from './other.js';
import { handleAPIInfo, handleGetLaunchApps, handleDF, handleBatch, handleCacheTimestamp, handleStats } from './info.js';
import { handleFile } from './file.js';
import storageRouter from './storage.js';
import { mediaRouter } from './media.js';
import aiRouter from './ai.js';
import wasmRouter from './wasm.js';
import resourcesRouter from './resources.js';
import { handleSearch } from './search.js';
import { handleGetApp } from './apps.js';
import { handleGetVersions, handleGetVersion, handleRestoreVersion } from './versions.js';
import { createBackup, listBackups, downloadBackup, deleteBackup, restoreBackup } from './backup.js';
import { handleTerminalStats, handleTerminalAdminStats, handleDestroyAllTerminals, handleTerminalStatus, handleExecCommand, handleExecScript, handleListTools } from './terminal.js';
import { getTerminalService } from '../services/terminal/TerminalService.js';
import { handleListApiKeys, handleCreateApiKey, handleDeleteApiKey, handleRevokeApiKey, handleGetScopes } from './apikeys.js';
import { handleListTools as handleListAgentTools, handleGetTool, handleListCategories, handleGetOpenAPISchema } from './tools.js';
import { createPublicRouter, setBandwidthLimit, getCDNStats } from './public.js';
import { IPFSStorage } from '../storage/ipfs.js';
import { checkTransportBinaries, ensureTransportBinaries } from '../utils/binary-manager.js';
import { httpClientRouter } from './http-client.js';
import { gitRouter } from './git.js';
import { auditRouter, auditMiddleware } from './audit.js';
import { rateLimitMiddleware, getRateLimitStatus } from './rate-limit.js';
import { schedulerRouter } from './scheduler.js';
import bosonRouter from './boson.js';
import setupRouter from './setup.js';
import updateRouter from './update.js';
import accessControlRouter from './access-control.js';
import didRouter from './did.js';
import walletRouter from './wallet.js';
import draftsRouter from './drafts.js';
import gatewayRouter from './gateway.js';
import systemRouter from './system.js';
import contextRouter from './context.js';
import voiceRouter from './voice.js';
import { createInstalledAppsRouter } from './installed-apps.js';
import { AppInstallService } from '../services/AppInstallService.js';
import registryRouter from './registry.js';
import { createSupernodeRouter } from './supernode.js';

// Extend Express Request to include database, filesystem, config, and WebSocket
declare global {
  namespace Express {
    interface Application {
      locals: {
        db?: DatabaseManager;
        filesystem?: FilesystemManager;
        config?: Config;
        io?: SocketIOServer;
      };
    }
  }
}

export function setupAPI(app: Express): void {
  // Debug middleware for specific routes (enable as needed)
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Uncomment to debug specific routes:
    // if (req.path === '/move') {
    //   logger.info(`[Route Debug] ${req.method} ${req.path}: url=${req.url}`);
    // }
    next();
  });
  
  // CORS middleware (applied to all routes)
  app.use(corsMiddleware);
  
  // Cookie parser (required for anti-snipe session cookies)
  app.use(cookieParser());

  // Health check endpoint (no auth required)
  // Available at both /health and /api/health for Docker compatibility
  const healthHandler = (req: Request, res: Response) => {
    const db = app.locals.db;
    const filesystem = app.locals.filesystem;
    const config = app.locals.config;
    const io = app.locals.io;
    
    const dbStatus = db ? 'connected' : 'not initialized';
    const ipfsStatus = filesystem ? 'available' : 'not initialized';
    const websocketStatus = io ? 'active' : 'not initialized';
    
    let terminalStatus = 'not initialized';
    let terminalIsolation = 'unknown';
    try {
      const terminalService = getTerminalService();
      if (terminalService) {
        terminalStatus = terminalService.isAvailable() ? 'available' : 'unavailable';
        terminalIsolation = terminalService.getEffectiveIsolationMode();
      }
    } catch {
      terminalStatus = 'not available';
    }
    
    const health: {
      status: string;
      timestamp: string;
      version: string;
      uptime: number;
      database: string;
      ipfs: string;
      websocket: string;
      terminal: {
        status: string;
        isolationMode: string;
      };
      owner?: {
        set: boolean;
        tethered_wallets: number;
      };
    } = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      uptime: process.uptime(),
      database: dbStatus,
      ipfs: ipfsStatus,
      websocket: websocketStatus,
      terminal: {
        status: terminalStatus,
        isolationMode: terminalIsolation
      }
    };

    if (config) {
      health.owner = {
        set: config.owner.wallet_address !== null,
        tethered_wallets: config.owner.tethered_wallets.length
      };
    }
    
    // If critical components are missing, mark as degraded
    if (!db) {
      health.status = 'degraded';
    }
    
    res.json(health);
  };
  
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // System readiness endpoint (no auth required)
  // Reports transport binary availability for login screen health badge
  app.get('/api/system-readiness', (_req: Request, res: Response) => {
    const db = app.locals.db;
    const filesystem = app.locals.filesystem;

    const binaryChecks = checkTransportBinaries();

    const checks = [
      {
        id: 'database',
        label: 'Database',
        status: db ? 'ok' as const : 'missing' as const,
        detail: db ? 'Connected' : 'Not initialized',
        fixable: false,
      },
      {
        id: 'ipfs',
        label: 'IPFS Storage',
        status: filesystem ? 'ok' as const : 'missing' as const,
        detail: filesystem ? 'Available' : 'Not initialized',
        fixable: false,
      },
      ...binaryChecks.map((b: { name: string; found: boolean; path: string | null }) => ({
        id: b.name,
        label: b.name === 'wireguard-go' ? 'WireGuard'
             : b.name === 'amneziawg-go' ? 'AmneziaWG'
             : b.name === 'awg-quick' ? 'AWG Quick'
             : b.name === 'sing-box' ? 'VLESS Transport'
             : b.name,
        status: b.found ? 'ok' as const : 'missing' as const,
        detail: b.found ? `Found at ${b.path}` : 'Not installed',
        fixable: !b.found,
        fixAction: 'install-binaries',
      })),
    ];

    const okCount = checks.filter(c => c.status === 'ok').length;
    const overall = okCount === checks.length ? 'ready'
                  : okCount >= checks.length - 1 ? 'degraded'
                  : 'issues';

    res.json({ overall, checks, total: checks.length, ok: okCount });
  });

  // System readiness fix endpoint (auth required — modifies system)
  app.post('/api/system-readiness/fix', authenticate, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const report = await ensureTransportBinaries();
      res.json({
        success: true,
        downloaded: report.downloaded,
        failed: report.failed,
        message: report.failed.length > 0
          ? `Installed ${report.downloaded} binaries. Failed: ${report.failed.join(', ')}`
          : `All transport binaries installed successfully (${report.downloaded} downloaded)`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: (err as Error).message });
    }
  });

  // Version endpoint (no auth required)
  app.get('/version', handleVersion);
  
  // API info endpoint (no auth required)
  app.get('/api/info', handleAPIInfo);
  
  // Get launch apps (no auth required)
  app.get('/get-launch-apps', handleGetLaunchApps);
  
  // Get app info by name (no auth required - used by window.get_apps)
  // IMPORTANT: This must be registered BEFORE static file middleware to catch /apps/:name requests
  app.get('/apps/:name', handleGetApp);
  
  // Cache timestamp (no auth required - SDK calls this during initialization)
  app.get('/cache/last-change-timestamp', handleCacheTimestamp);
  
  // File access (signed URLs - no auth required, signature verified in query)
  app.get('/file', handleFile);

  // ============================================================================
  // Public IPFS Gateway (no auth required)
  // ============================================================================
  const db = app.locals.db;
  const filesystem = app.locals.filesystem;
  
  // Get IPFS instance from filesystem if available
  const ipfs = filesystem?.getIPFS() || null;
  
  if (db && filesystem) {
    const publicRouter = createPublicRouter(db, filesystem, ipfs);
    app.use(publicRouter);
    logger.info('[API] Public IPFS gateway enabled at /ipfs/:cid and /public/:wallet/*');

    const nodeConfig = app.locals.config as Config | undefined;
    const uploadLimit = nodeConfig?.seeding?.max_upload_mbps ?? 0;
    if (uploadLimit > 0) {
      setBandwidthLimit(uploadLimit);
    }
  } else {
    logger.warn('[API] Public IPFS gateway disabled - database or filesystem not available');
  }

  // Authentication endpoints
  app.post('/auth/particle', handleParticleAuth);
  app.post('/auth/grant-user-app', authenticate, handleGrantUserApp);
  app.get('/auth/get-user-app-token', authenticate, handleGetUserAppToken);
  app.post('/auth/get-user-app-token', authenticate, handleGetUserAppToken);

  // User info endpoints (no auth required - return unauthenticated state if no token)
  // Match mock server behavior: return 200 with username: null instead of 401
  app.get('/whoami', handleWhoami);
  app.get('/os/user', handleOSUser);
  app.get('/api/stats', authenticate, handleStats);
  app.get('/api/wallets', authenticate, handleGetWallets);
  
  // User profile endpoint (per-wallet settings)
  app.post('/api/user/profile', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const db = req.app.locals.db;
      const { display_name } = req.body;
      
      if (display_name !== undefined) {
        // Save per-wallet display name
        const key = `user_${req.user.wallet_address}_display_name`;
        db?.setSetting(key, display_name);
      }
      
      res.json({ success: true });
    } catch (error) {
      log.error('[User Profile] Error:', error);
      res.status(500).json({ error: 'Failed to save profile' });
    }
  });
  
  app.get('/api/user/profile', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const db = req.app.locals.db;
      const key = `user_${req.user.wallet_address}_display_name`;
      const displayName = db?.getSetting(key) || '';
      
      res.json({ display_name: displayName });
    } catch (error) {
      log.error('[User Profile] Error:', error);
      res.status(500).json({ error: 'Failed to get profile' });
    }
  });
  
  // Login history endpoint (per-wallet)
  app.get('/api/user/login-history', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const db = req.app.locals.db;
      const walletAddress = req.user.wallet_address;
      const currentToken = req.headers.authorization?.replace('Bearer ', '');
      
      // Get sessions from database (using available columns)
      const sessions = db?.db?.prepare(`
        SELECT token, created_at, expires_at
        FROM sessions 
        WHERE wallet_address = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(walletAddress) || [];
      
      const logins = sessions.map((s: any) => ({
        timestamp: new Date(s.created_at).toISOString(),
        ip: 'Local Session',
        user_agent: 'PC2 Desktop',
        is_current: s.token === currentToken
      }));
      
      res.json({ logins });
    } catch (error) {
      log.error('[Login History] Error:', error);
      res.json({ logins: [] });
    }
  });
  
  // List sessions endpoint for Session Manager
  app.get('/auth/list-sessions', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const db = req.app.locals.db;
      const walletAddress = req.user.wallet_address;
      const currentToken = req.headers.authorization?.replace('Bearer ', '');
      
      const sessions = db?.db?.prepare(`
        SELECT token, created_at, expires_at
        FROM sessions 
        WHERE wallet_address = ? AND expires_at > ?
        ORDER BY created_at DESC
      `).all(walletAddress, Date.now()) || [];
      
      const result = sessions.map((s: any, index: number) => ({
        uuid: s.token.substring(0, 16),
        current: s.token === currentToken,
        meta: {
          'Created': new Date(s.created_at).toLocaleString(),
          'Expires': new Date(s.expires_at).toLocaleString(),
          'Type': 'Wallet Session'
        }
      }));
      
      res.json(result);
    } catch (error) {
      log.error('[List Sessions] Error:', error);
      res.json([]);
    }
  });
  
  // Revoke session endpoint
  app.post('/auth/revoke-session', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const db = req.app.locals.db;
      const { uuid } = req.body;
      const walletAddress = req.user.wallet_address;
      
      // Find and delete session that starts with this uuid
      db?.db?.prepare(`
        DELETE FROM sessions 
        WHERE wallet_address = ? AND token LIKE ?
      `).run(walletAddress, `${uuid}%`);
      
      res.json({ success: true });
    } catch (error) {
      log.error('[Revoke Session] Error:', error);
      res.status(500).json({ error: 'Failed to revoke session' });
    }
  });
  
  // Apply rate limiting and audit middleware before routers so dDRM endpoints are covered
  app.use(rateLimitMiddleware());
  app.use(auditMiddleware);

  // Storage usage endpoint
  app.use('/api/storage', storageRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/wasm', wasmRouter);
  app.use('/api/resources', resourcesRouter);
  app.use('/api/http', httpClientRouter);
  app.use('/api/git', gitRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/scheduler', schedulerRouter);
  app.use('/api/boson', bosonRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/update', updateRouter);
  app.use('/api/access', accessControlRouter);
  app.use('/api/did', didRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/drafts', draftsRouter);
  app.use('/api/gateway', gatewayRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/context', contextRouter);
  app.use('/api/ai', voiceRouter);
  app.use('/api/registry', registryRouter);
  app.use('/api/supernode', createSupernodeRouter());

  // Content Catalog (on-chain indexed content — public read, no auth needed for browsing)
  app.get('/api/catalog', (req: Request, res: Response) => {
    const catalogDb = req.app.locals.db as DatabaseManager | undefined;
    if (!catalogDb) return res.status(503).json({ error: 'Database not available' });

    const { asset_type, creator, search, limit: l, offset: o } = req.query;
    const result = catalogDb.getCatalogItems({
      assetType: asset_type as string | undefined,
      creator: creator as string | undefined,
      search: search as string | undefined,
      limit: parseInt(l as string) || 50,
      offset: parseInt(o as string) || 0,
    });

    const pinnedCids = new Set(catalogDb.getPinnedCIDs());
    const enriched = result.items.map((item: any) => ({
      ...item,
      is_local: !!(item.content_cid && pinnedCids.has(item.content_cid)),
    }));

    res.json({ success: true, total: result.total, items: enriched });
  });

  app.get('/api/catalog/stats', (req: Request, res: Response) => {
    const catalogDb = req.app.locals.db as DatabaseManager | undefined;
    if (!catalogDb) return res.status(503).json({ error: 'Database not available' });

    const stats = catalogDb.getCatalogStats();
    const indexer = req.app.locals.indexerService;
    res.json({
      success: true,
      catalog: stats,
      indexer: indexer ? indexer.getStats() : { enabled: false },
    });
  });

  app.get('/api/catalog/content/:contentId', (req: Request, res: Response) => {
    const catalogDb = req.app.locals.db as DatabaseManager | undefined;
    if (!catalogDb) return res.status(503).json({ error: 'Database not available' });

    const item = catalogDb.getCatalogItemByContentId(req.params.contentId) as any;
    if (!item) return res.status(404).json({ error: 'Asset not found' });

    const pinnedCids = new Set(catalogDb.getPinnedCIDs());
    item.is_local = !!(item.content_cid && pinnedCids.has(item.content_cid));

    res.json({ success: true, item });
  });

  app.get('/api/catalog/providers/:cid', async (req: Request, res: Response) => {
    const catalogIpfs = ipfs;
    if (!catalogIpfs) return res.status(503).json({ error: 'IPFS not available' });

    const { cid } = req.params;
    const count = await catalogIpfs.countProviders(cid);

    res.json({ success: true, cid, providers: count });
  });

  app.get('/api/catalog/creator/:address', (req: Request, res: Response) => {
    const catalogDb = req.app.locals.db as DatabaseManager | undefined;
    if (!catalogDb) return res.status(503).json({ error: 'Database not available' });

    const stats = catalogDb.getCreatorStats(req.params.address);
    const cdnStatsData = req.app.locals.seedingService?.getStats?.() ?? null;

    res.json({
      success: true,
      creator: req.params.address,
      ...stats,
      seeding: cdnStatsData ? {
        enabled: cdnStatsData.enabled,
        queueLength: cdnStatsData.queueLength,
        activeDownloads: cdnStatsData.activeDownloads,
        disk: cdnStatsData.disk,
      } : null,
    });
  });

  app.get('/api/catalog/seeding', (req: Request, res: Response) => {
    const catalogDb = req.app.locals.db as DatabaseManager | undefined;
    if (!catalogDb) return res.status(503).json({ error: 'Database not available' });

    const seedingStats = catalogDb.getNodeSeedingStats();
    const seedingService = req.app.locals.seedingService;

    const cdn = getCDNStats();
    const uptimeMs = Date.now() - cdn.startedAt;

    res.json({
      success: true,
      seeding: seedingStats,
      service: seedingService ? seedingService.getStats() : null,
      cdn: {
        bytesServed: cdn.bytesServed,
        requestCount: cdn.requestCount,
        uptimeMs,
        avgBytesPerSec: uptimeMs > 0 ? Math.round(cdn.bytesServed / (uptimeMs / 1000)) : 0,
      },
    });
  });

  // Installed Apps (dApp Store) — requires db for registration
  if (db) {
    const dataDir = process.env.PC2_DATA_DIR || path.join(process.cwd(), 'data');
    const appInstallService = new AppInstallService(db, ipfs, dataDir);
    app.locals.appInstallService = appInstallService;
    app.use('/api/installed-apps', authenticate, createInstalledAppsRouter(appInstallService));
    logger.info('[API] ✅ Installed Apps API enabled at /api/installed-apps');

    // Sync bundled test apps on every startup (re-copies files if source changed)
    const testAppsDir = path.join(dataDir, 'test-apps');
    if (fs.existsSync(testAppsDir)) {
      for (const appFolder of fs.readdirSync(testAppsDir, { withFileTypes: true })) {
        if (!appFolder.isDirectory()) continue;
        const appName = appFolder.name;

        const manifestPath = path.join(testAppsDir, appName, 'app.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const existing = appInstallService.get(appName);
          if (existing) appInstallService.uninstall(appName);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          appInstallService.installFromLocal(manifest, path.join(testAppsDir, appName));
          logger.info(`[API] ✅ Synced bundled app: ${appName}`);
        } catch (err: any) {
          logger.warn(`[API] ⚠️  Failed to sync ${appName}: ${err.message}`);
        }
      }
    }
  }
  
  // Rate limit status endpoint
  app.get('/api/rate-limit/status', authenticate, (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    
    const apiKeyId = (req as any).apiKeyId;
    const status = getRateLimitStatus(req.user.wallet_address, apiKeyId);
    res.json({
      success: true,
      wallet: req.user.wallet_address.substring(0, 10) + '...',
      api_key_id: apiKeyId || 'session',
      limits: status,
    });
  });
  
  // Search endpoint (require auth)
  app.post('/search', authenticate, handleSearch);

  // File versions endpoints (require auth)
  app.get('/versions', authenticate, handleGetVersions);
  app.get('/versions/:versionNumber', authenticate, handleGetVersion);
  app.post('/versions/:versionNumber/restore', authenticate, handleRestoreVersion);

  // Filesystem endpoints (require auth)
  // Register /stat BEFORE other routes to ensure it's matched correctly
  app.all('/stat', authenticate, handleStat); // Use app.all() to handle both GET and POST
  app.post('/readdir', authenticate, handleReaddir);
  app.get('/read', authenticate, handleRead);
  app.post('/read', authenticate, handleRead); // Also support POST for /read
  app.post('/write', authenticate, handleWrite);
  // Filesystem endpoints (standard format)
  app.post('/mkdir', authenticate, handleMkdir);
  app.post('/delete', authenticate, handleDelete);
  app.post('/move', authenticate, handleMove);
  app.post('/rename', authenticate, handleRename);
  app.post('/copy', authenticate, handleCopy);
  
  // Filesystem endpoints (API format - matching mock server)
  app.post('/api/files/mkdir', authenticate, handleMkdir);
  app.post('/api/files/delete', authenticate, handleDelete);
  app.post('/api/files/move', authenticate, handleMove);
  
  // Additional filesystem endpoints
  app.get('/df', authenticate, handleDF);
  app.post('/df', authenticate, handleDF);
  
  // Batch endpoint with multer for multipart file uploads.
  // Uses diskStorage to stream uploads to a temp dir instead of buffering
  // entirely in RAM -- critical for large files on memory-constrained devices.
  // Prefer data directory over os.tmpdir() because /tmp is often tmpfs (RAM-backed)
  // and can't hold large files on memory-constrained devices like Jetson.
  const config = app.locals.config as Config | undefined;
  const dataDir = config?.storage?.database_path ? path.dirname(config.storage.database_path) : null;
  const uploadTmpDir = dataDir
    ? path.join(dataDir, 'tmp', 'pc2-uploads')
    : path.join(os.tmpdir(), 'pc2-uploads');
  if (!fs.existsSync(uploadTmpDir)) fs.mkdirSync(uploadTmpDir, { recursive: true });
  logger.info(`[API] Upload temp directory: ${uploadTmpDir}`);

  const upload = multer({ 
    storage: multer.diskStorage({
      destination: uploadTmpDir,
      filename: (_req, file, cb) => {
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        cb(null, `${unique}-${file.originalname}`);
      },
    }),
    limits: {
      fileSize: Infinity // No artificial limit -- user's hardware, user's resources
    }
  });
  
  // Restore endpoint with disk-based storage (backups can be GB — avoids OOM)
  const restoreUploadDir = path.join(uploadTmpDir, 'restore');
  if (!fs.existsSync(restoreUploadDir)) fs.mkdirSync(restoreUploadDir, { recursive: true });

  const restoreUpload = multer({
    storage: multer.diskStorage({
      destination: restoreUploadDir,
      filename: (_req, file, cb) => {
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        cb(null, `${unique}-${file.originalname}`);
      },
    }),
    limits: {
      fileSize: 10 * 1024 * 1024 * 1024 // 10GB max file size for backups
    }
  });
  
  app.post('/batch', authenticate, upload.any(), handleBatch);

  // File signing (require auth)
  app.post('/sign', authenticate, handleSign);

  // Key-value store (require auth)
  app.get('/kv/:key*', authenticate, handleKV);
  app.post('/kv/:key*', authenticate, handleKV);
  app.delete('/kv/:key*', authenticate, handleKV);
  app.get('/api/kv/:key*', authenticate, handleKV);
  app.post('/api/kv/:key*', authenticate, handleKV);
  app.delete('/api/kv/:key*', authenticate, handleKV);

  // Other endpoints (require auth)
  app.post('/rao', authenticate, handleRAO);
  app.post('/contactUs', handleContactUs);
  
  // Driver calls (require auth)
  // Note: Raw body capture must happen before body parser, but body parser is global
  // So we'll check rawBody in the handler if parsed body is empty
  app.post('/drivers/call', authenticate, handleDriversCall);

  // Open item - Get app to open a file (require auth)
  app.post('/open_item', authenticate, handleOpenItem);

  // Suggest apps for a file (require auth)
  app.post('/suggest_apps', authenticate, handleSuggestApps);

  // Item metadata (require auth)
  app.get('/itemMetadata', authenticate, handleItemMetadata);

  // Write file using signed URL (require auth)
  app.post('/writeFile', authenticate, handleWriteFile);
  app.put('/writeFile', authenticate, handleWriteFile);

  // Desktop background (require auth)
  app.post('/set-desktop-bg', authenticate, handleSetDesktopBg);
  app.post('/set-profile-picture', authenticate, handleSetProfilePicture);

  // Elastos blockchain explorer proxy (to avoid CORS issues)
  app.get('/api/elastos/transactions', authenticate, async (req: Request, res: Response) => {
    try {
      const { address, page = '1', pageSize = '20' } = req.query;
      
      if (!address || typeof address !== 'string') {
        res.status(400).json({ error: 'Address is required' });
        return;
      }
      
      // Proxy to Elastos Smart Chain explorer API
      const offset = (parseInt(page as string) - 1) * parseInt(pageSize as string);
      const apiUrl = `https://esc.elastos.io/api?module=account&action=txlist&address=${address}&offset=${offset}&limit=${pageSize}&sort=desc`;
      
      const response = await fetch(apiUrl);
      const data = await response.json();
      
      res.json(data);
    } catch (error) {
      logger.error('[Elastos Proxy] Error:', error);
      res.status(500).json({ error: 'Failed to fetch Elastos transactions' });
    }
  });

  // Backup management endpoints (require auth)
  app.post('/api/backups/create', authenticate, createBackup);
  app.get('/api/backups', authenticate, listBackups);
  app.get('/api/backups/download/:filename', authenticate, downloadBackup);
  app.delete('/api/backups/:filename', authenticate, deleteBackup);
  app.post('/api/backups/restore', authenticate, restoreUpload.single('file'), restoreBackup);

  // Terminal endpoints
  app.get('/api/terminal/status', handleTerminalStatus);  // No auth - check if available
  app.get('/api/terminal/stats', authenticate, handleTerminalStats);
  app.get('/api/terminal/admin/stats', authenticate, handleTerminalAdminStats);
  app.post('/api/terminal/destroy-all', authenticate, handleDestroyAllTerminals);
  
  // Terminal command execution API (for AI agents)
  app.post('/api/terminal/exec', authenticate, handleExecCommand);
  app.post('/api/terminal/script', authenticate, handleExecScript);
  app.get('/api/terminal/tools', authenticate, handleListTools);

  // API Keys management (for agent authentication)
  app.get('/api/keys', authenticate, handleListApiKeys);
  app.post('/api/keys', authenticate, handleCreateApiKey);
  app.delete('/api/keys/:keyId', authenticate, handleDeleteApiKey);
  app.post('/api/keys/:keyId/revoke', authenticate, handleRevokeApiKey);
  app.get('/api/keys/scopes', handleGetScopes);  // No auth needed - just lists available scopes

  // Agent Tool Registry (for AI agent discovery)
  app.get('/api/tools', handleListAgentTools);  // Optional auth - shows scopes if authenticated
  app.get('/api/tools/categories', handleListCategories);
  app.get('/api/tools/openapi', handleGetOpenAPISchema);
  app.get('/api/tools/:name', handleGetTool);

  // Error handling middleware (must be last)
  app.use(errorHandler);
}

