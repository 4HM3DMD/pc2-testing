/**
 * Installed Apps API
 *
 * CRUD endpoints for the dApp Store's app install system.
 *
 * SEC-A17 (2026-04 Wave 5.5): owner-mutating routes are gated by
 * `requireOwner`. Without this, any authenticated tethered wallet could
 * call `install-local` with `localDir` pointing at the owner's mnemonic
 * store and then exfiltrate it via the `/installed-apps/*` static route.
 * Read-only listing routes remain `authenticate`-only so iframe apps and
 * the dApp Store UI continue to work for non-owner sessions.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest, requireOwner } from './middleware.js';
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
   *
   * SEC-A17: requireOwner — installing an app writes to disk under
   * `data/installed-apps/<name>/` and is served by the static route.
   * Tethered wallets must not be able to plant arbitrary content there.
   */
  router.post('/install', requireOwner, async (req: AuthenticatedRequest, res: Response) => {
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
   *
   * SEC-A17: requireOwner — `installFromLocal` copies the contents of
   * `localDir` into `data/installed-apps/<name>/`. Without owner gating
   * (and the `data/dev-apps/` allowlist enforced in AppInstallService),
   * any authenticated wallet could exfiltrate the owner's mnemonic by
   * pointing `localDir` at `data/wallets/`.
   */
  router.post('/install-local', requireOwner, (req: AuthenticatedRequest, res: Response) => {
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
   *
   * SEC-A17: requireOwner — same reasoning as `/install`.
   */
  router.post('/update', requireOwner, async (req: AuthenticatedRequest, res: Response) => {
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
   *
   * SEC-A17: requireOwner — uninstall removes files from disk and the DB
   * row. Tethered wallets must not be able to take an app offline.
   */
  router.delete('/:name', requireOwner, (req: AuthenticatedRequest, res: Response) => {
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
