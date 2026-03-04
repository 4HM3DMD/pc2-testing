/**
 * Installed Apps API
 *
 * CRUD endpoints for the dApp Store's app install system.
 * All endpoints require authentication.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from './middleware.js';
import { AppInstallService, AppManifest } from '../services/AppInstallService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api-installed-apps');

export function createInstalledAppsRouter(appInstallService: AppInstallService): Router {
  const router = Router();

  /**
   * GET /api/installed-apps
   * List all installed apps.
   */
  router.get('/', (_req: AuthenticatedRequest, res: Response) => {
    try {
      const apps = appInstallService.list();
      res.json({ apps });
    } catch (error: any) {
      log.error('[list] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/installed-apps/:name
   * Get details for a single installed app.
   */
  router.get('/:name', (req: AuthenticatedRequest, res: Response) => {
    try {
      const app = appInstallService.get(req.params.name);
      if (!app) {
        res.status(404).json({ error: `App "${req.params.name}" not found` });
        return;
      }
      res.json({ app });
    } catch (error: any) {
      log.error('[get] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/installed-apps/install
   * Install a new app from IPFS CID + manifest.
   *
   * Body: { manifest: AppManifest, cid: string }
   */
  router.post('/install', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { manifest, cid } = req.body as { manifest: AppManifest; cid: string };

      if (!manifest || !cid) {
        res.status(400).json({ error: 'Missing required fields: manifest, cid' });
        return;
      }

      const app = await appInstallService.install(manifest, cid);
      log.info(`[install] App "${app.app_name}" installed by ${req.user?.wallet_address?.substring(0, 10)}`);
      res.status(201).json({ app });
    } catch (error: any) {
      log.error('[install] Error:', error.message);
      const status = error.message.includes('already installed') ? 409 : 400;
      res.status(status).json({ error: error.message });
    }
  });

  /**
   * POST /api/installed-apps/install-local
   * Install from a local directory (dev / sideloading).
   *
   * Body: { manifest: AppManifest, localDir: string }
   */
  router.post('/install-local', (req: AuthenticatedRequest, res: Response) => {
    try {
      const { manifest, localDir } = req.body as { manifest: AppManifest; localDir: string };

      if (!manifest || !localDir) {
        res.status(400).json({ error: 'Missing required fields: manifest, localDir' });
        return;
      }

      const app = appInstallService.installFromLocal(manifest, localDir);
      log.info(`[install-local] App "${app.app_name}" sideloaded by ${req.user?.wallet_address?.substring(0, 10)}`);
      res.status(201).json({ app });
    } catch (error: any) {
      log.error('[install-local] Error:', error.message);
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * POST /api/installed-apps/update
   * Update an installed app to a new CID.
   *
   * Body: { manifest: AppManifest, cid: string }
   */
  router.post('/update', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { manifest, cid } = req.body as { manifest: AppManifest; cid: string };

      if (!manifest || !cid) {
        res.status(400).json({ error: 'Missing required fields: manifest, cid' });
        return;
      }

      const app = await appInstallService.update(manifest, cid);
      log.info(`[update] App "${app.app_name}" updated by ${req.user?.wallet_address?.substring(0, 10)}`);
      res.json({ app });
    } catch (error: any) {
      log.error('[update] Error:', error.message);
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/installed-apps/:name
   * Uninstall an app.
   */
  router.delete('/:name', (req: AuthenticatedRequest, res: Response) => {
    try {
      const removed = appInstallService.uninstall(req.params.name);
      if (!removed) {
        res.status(404).json({ error: `App "${req.params.name}" not found` });
        return;
      }
      log.info(`[uninstall] App "${req.params.name}" removed by ${req.user?.wallet_address?.substring(0, 10)}`);
      res.json({ success: true });
    } catch (error: any) {
      log.error('[uninstall] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
