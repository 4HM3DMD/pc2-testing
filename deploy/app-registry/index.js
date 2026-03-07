/**
 * PC2 App Registry
 *
 * Lightweight HTTP server that serves the app catalog JSON.
 * Runs on port 4500 (internal only — fronted by nginx or gateway).
 *
 * Endpoints:
 *   GET /api/registry/apps         — full catalog
 *   GET /api/registry/apps/:name   — single app by name
 *   GET /api/registry/health       — health check
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.REGISTRY_PORT || '4500', 10);
const REGISTRY_FILE = path.join(__dirname, 'registry.json');

let registryData = null;
let registryMtime = 0;

function loadRegistry() {
  try {
    const stat = fs.statSync(REGISTRY_FILE);
    if (stat.mtimeMs !== registryMtime) {
      const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
      registryData = JSON.parse(raw);
      registryMtime = stat.mtimeMs;
      console.log(`[Registry] Loaded ${registryData.apps.length} apps from registry.json`);
    }
  } catch (err) {
    console.error('[Registry] Failed to load registry.json:', err.message);
  }
}

loadRegistry();

const server = http.createServer((req, res) => {
  loadRegistry();

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/registry/apps') {
    if (!registryData) {
      res.writeHead(503, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Registry not available' }));
      return;
    }

    const category = url.searchParams.get('category');
    const status = url.searchParams.get('status');
    const channel = url.searchParams.get('channel');

    let apps = registryData.apps;

    if (category) {
      apps = apps.filter(a => a.registry?.category === category);
    }
    if (status) {
      apps = apps.filter(a => a.registry?.status === status);
    }
    if (channel) {
      apps = apps.filter(a => (a.distribution?.channel || 'stable') === channel);
    }

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: registryData.version,
      updatedAt: registryData.updatedAt,
      count: apps.length,
      apps,
    }));
    return;
  }

  const singleMatch = pathname.match(/^\/api\/registry\/apps\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && singleMatch) {
    const name = singleMatch[1];
    const app = registryData?.apps.find(a => a.name === name);
    if (!app) {
      res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `App "${name}" not found` }));
      return;
    }
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(app));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/registry/health') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      apps: registryData?.apps.length || 0,
      updatedAt: registryData?.updatedAt || null,
    }));
    return;
  }

  res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PC2 App Registry] Listening on 0.0.0.0:${PORT}`);
  console.log(`[PC2 App Registry] ${registryData?.apps.length || 0} apps loaded`);
});
