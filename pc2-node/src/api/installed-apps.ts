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
import { Server as SocketIOServer } from 'socket.io';
import { AuthenticatedRequest, requireOwner } from './middleware.js';
import { AppInstallService, AppManifest, InstallStage, InstallProgressMeta } from '../services/AppInstallService.js';
import { broadcastToUser } from '../websocket/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api-installed-apps');

export function createInstalledAppsRouter(appInstallService: AppInstallService): Router {
  const router = Router();

  /**
   * GET /api/installed-apps
   * List all installed apps.
   *
   * Hidden apps (manifest.hidden === true, e.g. pc2-media-runtime which
   * acts as a backstage WASM helper for elacity-player) are filtered out
   * so the dApp Centre and other consumers don't surface them as
   * standalone tiles. /get-launch-apps applies the same filter — see
   * pc2-node/src/api/info.ts handleGetLaunchApps. Without this guard the
   * dApp Centre shows two "Elacity Player" cards.
   */
  router.get('/', (req: AuthenticatedRequest, res: Response) => {
    try {
      const includeHidden = String(req.query.include_hidden || '') === '1';
      const all = appInstallService.list();
      const apps = includeHidden ? all : all.filter((a) => {
        try {
          const manifest = JSON.parse(a.manifest_json || '{}');
          return !manifest.hidden;
        } catch {
          return true;
        }
      });
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

      // Bridge install-pipeline progress events onto the authenticated
      // user's Socket.io room so the dApp Centre can draw a meaningful
      // progress bar. We intentionally only emit to the caller (room
      // `user:<wallet>`) — other tethered sessions don't care. See
      // DAPP-UX-POLISH-V12 #6.
      const io = (req.app.locals.io as SocketIOServer | undefined);
      const wallet = req.user?.wallet_address;
      const emitProgress = (stage: InstallStage, pct: number, meta?: InstallProgressMeta) => {
        if (!io || !wallet) return;
        broadcastToUser(io, wallet, 'install:progress', {
          appName: manifest.name,
          stage,
          pct,
          meta,
        });
      };

      const app = await appInstallService.install(manifest, cid, emitProgress);
      log.info(`[install] App "${app.app_name}" installed by ${wallet?.substring(0, 10)}`);

      // Notify room that the installed-apps set changed so clients
      // (Start menu, dApp Centre) can refresh without a page reload.
      if (io && wallet) {
        broadcastToUser(io, wallet, 'apps:changed', {
          action: 'installed',
          appName: app.app_name,
        });
      }
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

      // Notify room so Start menu drops its cached entry.
      // See DAPP-UX-POLISH-V12 #4.
      const io = (req.app.locals.io as SocketIOServer | undefined);
      const wallet = req.user?.wallet_address;
      if (io && wallet) {
        broadcastToUser(io, wallet, 'apps:changed', {
          action: 'uninstalled',
          appName: req.params.name,
        });
      }
      res.json({ success: true });
    } catch (error: any) {
      log.error('[uninstall] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
