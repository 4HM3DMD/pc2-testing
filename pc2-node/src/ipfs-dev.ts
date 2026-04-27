import express, { Request, Response } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { pipeline, Readable } from 'stream';
import { fileURLToPath } from 'url';
import { loadConfig } from './config/loader.js';
import { IPFSStorage, type IPFSNetworkMode } from './storage/ipfs.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('ipfs-dev');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.m4a': 'audio/mp4',
  '.mpd': 'application/dash+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
};

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function renderDirectoryHTML(cid: string, currentPath: string, entries: Array<{ name: string; cid: string; size: number; type: string }>): string {
  const cleanPath = currentPath.replace(/^\/+|\/+$/g, '');
  const pathLabel = cleanPath ? `/${cleanPath}` : '/';
  const rows = entries
    .sort((a, b) => {
      const aIsDir = a.type === 'directory';
      const bIsDir = b.type === 'directory';
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => {
      const nextPath = cleanPath ? `${cleanPath}/${entry.name}` : entry.name;
      const href = `/ipfs/${encodeURIComponent(cid)}/${nextPath.split('/').map(encodeURIComponent).join('/')}`;
      const suffix = entry.type === 'directory' ? '/' : '';
      const size = entry.type === 'directory' ? '-' : String(entry.size);
      return `<tr><td><a href="${href}">${entry.name}${suffix}</a></td><td>${entry.type}</td><td>${size}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>IPFS Dev Browser</title>
  <style>
    body { font-family: ui-monospace, Menlo, Consolas, monospace; margin: 24px; max-width: 960px; }
    h1 { margin-bottom: 6px; }
    .meta { color: #666; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; }
    a { text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>IPFS Dev Browser</h1>
  <div class="meta">CID: ${cid}<br>Path: ${pathLabel}</div>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">Directory is empty.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ipfsConfig = (config as any).ipfs || {};
  const ipfsMode = (ipfsConfig.mode || 'private') as IPFSNetworkMode;
  const repoPath = process.env.IPFS_REPO_PATH || config.storage.ipfs_repo_path;
  const port = Number(process.env.IPFS_DEV_PORT || 4301);

  const ipfs = new IPFSStorage({
    repoPath,
    mode: ipfsMode,
    enableDHT: ipfsConfig.enable_dht,
    dhtClientMode: ipfsConfig.dht_client_mode,
    enableBootstrap: ipfsConfig.enable_bootstrap,
    autoAnnounceOnStore: ipfsConfig.auto_announce_on_store !== false,
    prefetchOnStore: ipfsConfig.prefetch_on_store !== false,
    publicGatewayPrefetchUrl: ipfsConfig.public_gateway_prefetch_url,
    customBootstrap: ipfsConfig.custom_bootstrap,
    supernodeBootstrap: ipfsConfig.supernode_bootstrap,
  });

  await ipfs.initialize();
  const info = await ipfs.getNodeInfo();
  log.info(`[IPFS DEV] Ready with peer ID: ${info.id}`);

  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, mode: ipfs.getNetworkMode(), peerId: ipfs.getNodeId() });
  });

  app.get('/api/status', async (_req: Request, res: Response) => {
    const node = await ipfs.getNodeInfo();
    const network = await ipfs.getNetworkStats();
    const peers = await ipfs.getConnectedPeers();
    const announce = ipfs.getAnnouncementStats();
    res.json({
      node,
      network,
      announce,
      bootstrapPeers: ipfs.getConfiguredBootstrapPeers(),
      connectedPeers: peers,
    });
  });

  app.post('/api/bootstrap/reconnect', async (_req: Request, res: Response) => {
    const result = await ipfs.reconnectBootstrapPeers('manual');
    const peers = await ipfs.getConnectedPeers();
    res.json({
      reconnect: result,
      connectedPeers: peers,
    });
  });

  app.use(express.json());
  app.post('/api/swarm/connect', async (req: Request, res: Response) => {
    const addr = String(req.body?.addr || '').trim();
    if (!addr) {
      return res.status(400).json({ error: 'Missing addr in request body' });
    }
    const result = await ipfs.connectToPeer(addr);
    const peers = await ipfs.getConnectedPeers();
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        connectedPeers: peers,
      });
    }
    return res.json({
      success: true,
      connectedPeers: peers,
    });
  });

  app.get('/', async (_req: Request, res: Response) => {
    const node = await ipfs.getNodeInfo();
    const network = await ipfs.getNetworkStats();
    const webuiNote = app.get('has-ipfs-webui')
      ? '<p><a href="/webui/" target="_blank" rel="noreferrer">Open mounted ipfs-webui</a></p>'
      : '<p>ipfs-webui assets not found locally. Using built-in debug UI only.</p>';

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PC2 IPFS Dev</title>
  <style>
    body { font-family: ui-monospace, Menlo, Consolas, monospace; margin: 24px; max-width: 920px; }
    input { width: 100%; max-width: 760px; padding: 8px; }
    button { padding: 8px 10px; margin-left: 6px; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 14px; margin: 14px 0; }
  </style>
</head>
<body>
  <h1>PC2 IPFS Dev Entrypoint</h1>
  <div class="card">
    <div>Peer ID: <code>${node.id}</code></div>
    <div>Mode: <code>${network.mode}</code></div>
    <div>Connected peers: <code>${network.connectedPeers}</code></div>
  </div>
  <form action="/ipfs" method="get">
    <label for="cid">Browse CID:</label><br>
    <input id="cid" name="cid" placeholder="bafy..." required />
    <button type="submit">Open</button>
  </form>
  <p>JSON status: <a href="/api/status">/api/status</a></p>
  ${webuiNote}
</body>
</html>`);
  });

  app.get('/ipfs', (req: Request, res: Response) => {
    const cid = String(req.query.cid || '').trim();
    if (!cid) return res.status(400).json({ error: 'Missing cid query parameter' });
    return res.redirect(`/ipfs/${encodeURIComponent(cid)}`);
  });

  app.get('/ipfs/:cid/*', async (req: Request, res: Response) => {
    const cid = req.params.cid;
    const subPath = req.params[0] || '';

    try {
      const resolved = await ipfs.resolveDAGPath(cid, subPath);
      if (!resolved) {
        return res.status(404).json({ error: 'Path not found', cid, path: subPath });
      }

      if (resolved.type === 'directory') {
        const entries = await ipfs.listDirectory(resolved.cid);
        return res.type('html').send(renderDirectoryHTML(cid, subPath, entries));
      }

      const mime = mimeFromPath(subPath);
      const stream = ipfs.getDAGFileStream(cid, subPath);
      res.setHeader('Content-Type', mime);
      return pipeline(Readable.from(stream), res, (err) => {
        if (err && (err as any).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          log.error(`[IPFS DEV] stream error ${cid}/${subPath}: ${err.message}`);
        }
      });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to serve DAG path', details: error?.message || 'unknown error' });
    }
  });

  app.get('/ipfs/:cid', async (req: Request, res: Response) => {
    const cid = req.params.cid;
    try {
      const inspected = await ipfs.inspectCID(cid);
      if (inspected.type === 'directory') {
        const entries = await ipfs.listDirectory(inspected.cid);
        return res.type('html').send(renderDirectoryHTML(cid, '', entries));
      }

      const stream = ipfs.getFileStream(cid);
      res.setHeader('Content-Type', 'application/octet-stream');
      return pipeline(Readable.from(stream), res, (err) => {
        if (err && (err as any).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          log.error(`[IPFS DEV] stream error ${cid}: ${err.message}`);
        }
      });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to serve CID', details: error?.message || 'unknown error' });
    }
  });

  const webuiCandidates = [
    path.join(process.cwd(), 'node_modules/ipfs-webui/dist'),
    path.join(__dirname, '../node_modules/ipfs-webui/dist'),
  ];
  const webuiPath = webuiCandidates.find((candidate) => existsSync(candidate));
  if (webuiPath) {
    app.use('/webui', express.static(webuiPath));
    app.set('has-ipfs-webui', true);
    log.info(`[IPFS DEV] Mounted ipfs-webui at /webui from ${webuiPath}`);
  } else {
    app.set('has-ipfs-webui', false);
    log.info('[IPFS DEV] ipfs-webui assets not found, skipping /webui mount');
  }

  const server = app.listen(port, () => {
    log.info(`[IPFS DEV] HTTP server running at http://localhost:${port}`);
  });

  const shutdown = async () => {
    log.info('[IPFS DEV] Shutting down...');
    server.close(async () => {
      await ipfs.stop();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  log.error(`[IPFS DEV] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
