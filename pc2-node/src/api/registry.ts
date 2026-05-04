/**
 * App Registry API
 *
 * Proxies the supernode app registry with local caching.
 * PC2 nodes fetch the catalog from the supernode and cache it
 * for 5 minutes to reduce latency and network calls.
 *
 * GET /api/registry/apps          — full catalog (with optional ?category=&status= filters)
 * GET /api/registry/apps/:name    — single app by name
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('registry');
const router = Router();

const SUPERNODE_REGISTRY_URLS = (process.env.PC2_REGISTRY_URL || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

if (SUPERNODE_REGISTRY_URLS.length === 0) {
  SUPERNODE_REGISTRY_URLS.push(
    'http://69.164.241.210:4500',   // InterServer (primary)
    'http://38.242.211.112:4500',   // Contabo (secondary)
  );
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface RegistryCache {
  data: any;
  fetchedAt: number;
}

let cache: RegistryCache | null = null;

async function fetchFromUrl(baseUrl: string): Promise<any> {
  const url = `${baseUrl}/api/registry/apps`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchRegistry(): Promise<any> {
  if (cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.data;
  }

  for (const baseUrl of SUPERNODE_REGISTRY_URLS) {
    try {
      const data = await fetchFromUrl(baseUrl);
      cache = { data, fetchedAt: Date.now() };
      log.info(`[Registry] Fetched ${data.count || data.apps?.length || 0} apps from ${baseUrl}`);
      return data;
    } catch (err: any) {
      log.warn(`[Registry] ${baseUrl} failed: ${err.message}`);
    }
  }

  if (cache) {
    log.info('[Registry] All supernodes unreachable, serving stale cache');
    return cache.data;
  }
  return null;
}

router.get('/apps', async (_req: Request, res: Response) => {
  const data = await fetchRegistry();
  if (!data) {
    return res.status(503).json({ error: 'Registry unavailable' });
  }

  let apps = data.apps || [];

  const category = _req.query.category as string | undefined;
  const status = _req.query.status as string | undefined;

  if (category) {
    apps = apps.filter((a: any) => a.registry?.category === category);
  }
  if (status) {
    apps = apps.filter((a: any) => a.registry?.status === status);
  }

  res.json({
    version: data.version,
    updatedAt: data.updatedAt,
    count: apps.length,
    apps,
  });
});

router.get('/apps/:name', async (req: Request, res: Response) => {
  const data = await fetchRegistry();
  if (!data) {
    return res.status(503).json({ error: 'Registry unavailable' });
  }

  const app = (data.apps || []).find((a: any) => a.name === req.params.name);
  if (!app) {
    return res.status(404).json({ error: `App "${req.params.name}" not found` });
  }
  res.json(app);
});

export default router;
