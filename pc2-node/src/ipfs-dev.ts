import express, { Request, Response } from 'express';
import path from 'path';
import { pipeline, Readable } from 'stream';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { multiaddr } from '@multiformats/multiaddr';
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

function normalizeObjectArg(arg: string): { rootCid: string; subPath: string } {
  const trimmed = arg.trim();
  if (!trimmed) {
    return { rootCid: '', subPath: '' };
  }

  if (trimmed.startsWith('/ipfs/')) {
    const withoutPrefix = trimmed.slice('/ipfs/'.length);
    const parts = withoutPrefix.split('/').filter(Boolean);
    const [rootCid, ...rest] = parts;
    return { rootCid: rootCid || '', subPath: rest.join('/') };
  }

  const parts = trimmed.split('/').filter(Boolean);
  const [rootCid, ...rest] = parts;
  return { rootCid: rootCid || '', subPath: rest.join('/') };
}

function getArgList(req: Request): string[] {
  const raw = req.query.arg;
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (raw != null) {
    const value = String(raw).trim();
    return value ? [value] : [];
  }
  return [];
}

function extractPeerIdFromMultiaddr(addr: string): string {
  const match = addr.match(/\/p2p\/([^/]+)$/);
  if (match?.[1]) return match[1];
  const legacy = addr.match(/\/ipfs\/([^/]+)$/);
  if (legacy?.[1]) return legacy[1];
  return '';
}

type CompatUploadPart = {
  name: string;
  filename: string;
  data: Buffer;
};

async function readRequestBuffer(req: Request, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > maxBytes) {
      throw new Error(`multipart payload exceeds limit (${maxBytes} bytes)`);
    }
    chunks.push(piece);
  }

  return Buffer.concat(chunks, total);
}

function parseMultipartBoundary(contentTypeHeader: string): string | null {
  const match = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim() || null;
}

function parseCompatMultipartBody(body: Buffer, boundary: string): CompatUploadPart[] {
  const boundaryMarker = `--${boundary}`;
  const text = body.toString('latin1');
  const segments = text.split(boundaryMarker);
  const parts: CompatUploadPart[] = [];

  for (const rawSegment of segments) {
    let segment = rawSegment;
    if (!segment || segment === '--' || segment === '--\r\n') continue;
    if (segment.startsWith('\r\n')) segment = segment.slice(2);
    if (segment.endsWith('\r\n')) segment = segment.slice(0, -2);
    if (segment.endsWith('--')) segment = segment.slice(0, -2);
    if (!segment) continue;

    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;

    const headersText = segment.slice(0, headerEnd);
    const dataStart = headerEnd + 4;
    let payloadText = segment.slice(dataStart);
    if (payloadText.endsWith('\r\n')) {
      payloadText = payloadText.slice(0, -2);
    }

    const dispositionLine = headersText
      .split('\r\n')
      .find((line) => /^content-disposition:/i.test(line));
    if (!dispositionLine) continue;

    const filenameMatch = dispositionLine.match(/filename="([^"]*)"/i);
    const nameMatch = dispositionLine.match(/name="([^"]*)"/i);
    if (!filenameMatch && !nameMatch) continue;

    parts.push({
      name: nameMatch?.[1] || 'file',
      filename: filenameMatch?.[1] || '',
      data: Buffer.from(payloadText, 'latin1'),
    });
  }

  return parts;
}

function patchLegacyWebuiBundle(source: string): string {
  let patched = source;

  // Disable external geo lookups in legacy webui.
  patched = patched.replace(/http:\/\/freegeoip\.net\/json\//g, '/api/v0/geoip/');

  const targetPattern = /var size = atob\(this\.props\.object\.Data\)\.length - 2\s+var data = 'data:text\/plain;base64,' \+ this\.props\.object\.Data\.substr\(0, 10000\)/;
  if (!targetPattern.test(patched)) {
    return patched;
  }

  const replacement = `var raw = atob(this.props.object.Data || '')
    var size = raw.length
    var sampleLimit = Math.min(raw.length, 1024)
    var isText = true
    for(var i = 0; i < sampleLimit; i++) {
      var c = raw.charCodeAt(i)
      if(c === 9 || c === 10 || c === 13) continue
      if(c < 32 || c > 126) { isText = false; break }
    }
    var isPng = raw.length >= 8 && raw.substr(0, 8) === '\\x89PNG\\r\\n\\x1a\\n'
    var isJpeg = raw.length >= 2 && raw.charCodeAt(0) === 0xff && raw.charCodeAt(1) === 0xd8
    var isGif = raw.length >= 6 && (raw.substr(0, 6) === 'GIF87a' || raw.substr(0, 6) === 'GIF89a')
    var isWebp = raw.length >= 12 && raw.substr(0, 4) === 'RIFF' && raw.substr(8, 4) === 'WEBP'
    var mime = isPng ? 'image/png' : (isJpeg ? 'image/jpeg' : (isGif ? 'image/gif' : (isWebp ? 'image/webp' : '')))
    var data
    if(mime) {
      var html = '<!doctype html><html><body style="margin:0;background:#111;display:flex;justify-content:center"><img style="max-width:100%;height:auto" src="data:' + mime + ';base64,' + this.props.object.Data + '"></body></html>'
      data = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    } else if(isText) {
      data = 'data:text/plain;base64,' + this.props.object.Data.substr(0, 10000)
    } else {
      var preview = []
      var maxPreview = Math.min(raw.length, 200)
      for(var j = 0; j < maxPreview; j++) preview.push(raw.charCodeAt(j))
      var suffix = raw.length > 200 ? ', ...' : ''
      var pretty = 'Uint8Array(' + raw.length + ') [' + preview.join(', ') + suffix + ']'
      data = 'data:text/plain;charset=utf-8,' + encodeURIComponent(pretty)
    }`;

  return patched.replace(targetPattern, replacement);
}

function patchLegacyWebuiIndexHtml(source: string): string {
  const marker = '__pc2WebuiDataNormalizer';
  if (source.includes(marker)) {
    return source;
  }

  const script = `<script>
(function ${marker}(){
  function bytesFromBase64(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }
  function imageMime(bytes) {
    if (bytes.length >= 8 && bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4e && bytes[3]===0x47 && bytes[4]===0x0d && bytes[5]===0x0a && bytes[6]===0x1a && bytes[7]===0x0a) return 'image/png';
    if (bytes.length >= 2 && bytes[0]===0xff && bytes[1]===0xd8) return 'image/jpeg';
    if (bytes.length >= 6 && bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x38 && (bytes[4]===0x37 || bytes[4]===0x39) && bytes[5]===0x61) return 'image/gif';
    if (bytes.length >= 12 && bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 && bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) return 'image/webp';
    return '';
  }
  function isLikelyText(bytes) {
    var max = Math.min(bytes.length, 1024);
    for (var i = 0; i < max; i++) {
      var c = bytes[i];
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 32 || c > 126) return false;
    }
    return true;
  }
  function uintPreview(bytes) {
    var max = Math.min(bytes.length, 200);
    var arr = [];
    for (var i = 0; i < max; i++) arr.push(bytes[i]);
    return 'Uint8Array(' + bytes.length + ') [' + arr.join(', ') + (bytes.length > 200 ? ', ...' : '') + ']';
  }
  function patchFrame(frame) {
    var src = frame.getAttribute('src') || '';
    if (!src.startsWith('data:text/plain;base64,')) return;
    var b64 = src.substring('data:text/plain;base64,'.length);
    var bytes;
    try { bytes = bytesFromBase64(b64); } catch (_) { return; }

    var mime = imageMime(bytes);
    if (mime) {
      var html = '<!doctype html><html><body style="margin:0;background:#111;display:flex;justify-content:center;align-items:flex-start;"><img style="max-width:100%;height:auto" src="data:' + mime + ';base64,' + b64 + '"></body></html>';
      frame.setAttribute('src', 'data:text/html;charset=utf-8,' + encodeURIComponent(html));
      return;
    }
    if (isLikelyText(bytes)) return;
    frame.setAttribute('src', 'data:text/plain;charset=utf-8,' + encodeURIComponent(uintPreview(bytes)));
  }
  function scan() {
    var frames = document.querySelectorAll('iframe.panel-inner');
    for (var i = 0; i < frames.length; i++) patchFrame(frames[i]);
  }
  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  setInterval(scan, 500);
  scan();
})();
</script>`;

  if (source.includes('</body>')) {
    return source.replace('</body>', `${script}\n</body>`);
  }
  return `${source}\n${script}`;
}

async function readDAGPathBytes(ipfs: IPFSStorage, rootCid: string, subPath: string, maxBytes = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of ipfs.getDAGFileStream(rootCid, subPath)) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      break;
    }

    if (piece.length > remaining) {
      chunks.push(piece.subarray(0, remaining));
      total += remaining;
      break;
    }

    chunks.push(piece);
    total += piece.length;
  }

  return Buffer.concat(chunks, total);
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
  const kuboCompatApiEnabled = process.env.IPFS_DEV_ENABLE_KUBO_API != null
    ? process.env.IPFS_DEV_ENABLE_KUBO_API === '1' || process.env.IPFS_DEV_ENABLE_KUBO_API === 'true'
    : (process.env.NODE_ENV ?? 'development') === 'development';

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
  log.info(`[IPFS DEV] Kubo compatibility API (/api/v0) ${kuboCompatApiEnabled ? 'enabled' : 'disabled'}`);

  const app = express();
  const webuiDistPath = path.resolve(__dirname, '..', 'node_modules', 'ipfs-webui', 'versions', 'QmaaqrHyAQm7gALkRW8DcfGX3u8q9rWKnxEMmf7m9z515w');

  app.get('/webui/static/bundle.min.js', (_req: Request, res: Response) => {
    try {
      const bundlePath = path.join(webuiDistPath, 'static', 'bundle.min.js');
      const source = readFileSync(bundlePath, 'utf8');
      const patched = patchLegacyWebuiBundle(source);
      res.type('application/javascript');
      res.send(patched);
    } catch (error: any) {
      res.status(500).type('text/plain').send(`Failed to load patched webui bundle: ${error?.message || 'unknown error'}`);
    }
  });

  app.use('/webui', express.static(webuiDistPath));
  app.get('/webui/', (_req: Request, res: Response) => {
    try {
      const indexPath = path.join(webuiDistPath, 'index.html');
      const source = readFileSync(indexPath, 'utf8');
      res.type('text/html').send(patchLegacyWebuiIndexHtml(source));
    } catch (error: any) {
      res.status(500).type('text/plain').send(`Failed to load patched webui index: ${error?.message || 'unknown error'}`);
    }
  });
  app.get('/webui/index.html', (_req: Request, res: Response) => {
    try {
      const indexPath = path.join(webuiDistPath, 'index.html');
      const source = readFileSync(indexPath, 'utf8');
      res.type('text/html').send(patchLegacyWebuiIndexHtml(source));
    } catch (error: any) {
      res.status(500).type('text/plain').send(`Failed to load patched webui index: ${error?.message || 'unknown error'}`);
    }
  });
  app.get('/webui', (_req: Request, res: Response) => {
    try {
      const indexPath = path.join(webuiDistPath, 'index.html');
      const source = readFileSync(indexPath, 'utf8');
      res.type('text/html').send(patchLegacyWebuiIndexHtml(source));
    } catch (error: any) {
      res.status(500).type('text/plain').send(`Failed to load patched webui index: ${error?.message || 'unknown error'}`);
    }
  });

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
  app.use(express.urlencoded({ extended: true }));

  if (kuboCompatApiEnabled) {
    // Kubo RPC compatibility for legacy ipfs-webui bundle (dev only).
    const compatPinnedCids = new Set<string>();
    let compatGatewayEnabled = true;

    const resolveGatewayAddress = async (): Promise<string> => {
      const node = await ipfs.getNodeInfo();
      const firstAddress = node.addresses.find((addr) => addr.startsWith('/ip4/')) || '/ip4/127.0.0.1/tcp/4301';
      return firstAddress
        .replace(/\/p2p\/.+$/, '')
        .replace('/tcp/4001', '/tcp/4301')
        .replace('/tcp/4002/ws', '/tcp/4301');
    };

    const resolveObject = async (arg: string) => {
      const { rootCid, subPath } = normalizeObjectArg(arg);
      if (!rootCid) return null;
      const target = subPath
        ? await ipfs.resolveDAGPath(rootCid, subPath)
        : await ipfs.inspectCID(rootCid);
      if (!target) return null;

      if (target.type === 'directory') {
        const entries = await ipfs.listDirectory(target.cid);
        return {
          Links: entries.map((entry) => ({
            Name: entry.name,
            Hash: entry.cid,
            Size: entry.size,
          })),
          Data: 'AAA=',
        };
      }

      const data = subPath
        ? await readDAGPathBytes(ipfs, rootCid, subPath)
        : await ipfs.getFile(target.cid);
      return {
        Links: [],
        Data: data.toString('base64'),
      };
    };

    const getLibp2p = (): any | null => ipfs.getHeliaInstance()?.libp2p ?? null;

    const formatConnectionString = (peerId: string, remoteAddr?: string): string => {
      const addr = (remoteAddr || '').trim();
      if (!addr) return `/p2p/${peerId}`;
      if (/\/(p2p|ipfs)\//.test(addr)) return addr;
      return `${addr}/p2p/${peerId}`;
    };

    const listConnectionRows = (): Array<{ peerId: string; addr: string }> => {
      const libp2p = getLibp2p();
      const conns: any[] = libp2p?.getConnections?.() ?? [];
      return conns.map((conn) => ({
        peerId: conn?.remotePeer?.toString?.() || '',
        addr: conn?.remoteAddr?.toString?.() || '',
      })).filter((row) => row.peerId);
    };

    const decodeMetadataValue = (value: any): string => {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return Buffer.from(value).toString('utf8').trim();
      }
      if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
        return Buffer.from(value).toString('utf8').trim();
      }
      return String(value).trim();
    };

    const readPeerVersionsFromMetadata = (peer: any): { agentVersion: string; protocolVersion: string } => {
      const out = { agentVersion: '', protocolVersion: '' };
      const metadata = peer?.metadata;
      if (!metadata) return out;

      const entries: Array<[string, any]> = [];
      if (metadata instanceof Map) {
        for (const [key, value] of metadata.entries()) {
          entries.push([String(key), value]);
        }
      } else if (typeof metadata === 'object') {
        for (const [key, value] of Object.entries(metadata)) {
          entries.push([String(key), value]);
        }
      }

      for (const [rawKey, rawValue] of entries) {
        const key = rawKey.toLowerCase();
        const value = decodeMetadataValue(rawValue);
        if (!value) continue;
        if (!out.agentVersion && (key.includes('agentversion') || key === 'agent')) {
          out.agentVersion = value;
        }
        if (!out.protocolVersion && (key.includes('protocolversion') || key === 'protocol')) {
          out.protocolVersion = value;
        }
      }

      return out;
    };

    app.get('/api/v0/version', (_req: Request, res: Response) => {
      res.json({
        Version: 'helia-dev',
        Commit: '',
        Repo: '',
        System: process.platform,
        Golang: '',
      });
    });

    app.get('/api/v0/id', async (req: Request, res: Response) => {
      const requestedId = getArgList(req)[0];
      const node = await ipfs.getNodeInfo();
      if (!requestedId || requestedId === node.id) {
        return res.json({
          ID: node.id,
          PublicKey: '',
          Addresses: node.addresses,
          AgentVersion: node.agentVersion,
          ProtocolVersion: node.protocolVersion,
        });
      }

      const libp2p = getLibp2p();
      if (!libp2p) {
        return res.status(500).json({ Message: 'libp2p unavailable' });
      }

      const connectionRows = listConnectionRows();
      const connectedAddrs = connectionRows
        .filter((row) => row.peerId === requestedId)
        .map((row) => formatConnectionString(row.peerId, row.addr));

      let peerStoreAddrs: string[] = [];
      let peerVersions = { agentVersion: '', protocolVersion: '' };
      try {
        const allPeers = await libp2p.peerStore.all();
        const peer = allPeers.find((p: any) => p?.id?.toString?.() === requestedId);
        if (peer?.addresses?.length) {
          peerStoreAddrs = peer.addresses
            .map((entry: any) => entry?.multiaddr?.toString?.() || '')
            .filter(Boolean)
            .map((addr: string) => formatConnectionString(requestedId, addr));
        }
        peerVersions = readPeerVersionsFromMetadata(peer);
      } catch {
        // Best-effort lookup only.
      }

      // Optional best-effort dial for known peer-store addresses to improve reliability.
      if (connectedAddrs.length === 0 && peerStoreAddrs.length > 0) {
        for (const addr of peerStoreAddrs.slice(0, 3)) {
          try {
            await (libp2p as any).dial(multiaddr(addr));
            break;
          } catch {
            // Try next candidate.
          }
        }
      }

      const refreshedConnected = listConnectionRows()
        .filter((row) => row.peerId === requestedId)
        .map((row) => formatConnectionString(row.peerId, row.addr));

      const addresses = Array.from(new Set([...refreshedConnected, ...peerStoreAddrs]));
      if (addresses.length === 0) {
        return res.status(404).json({ Message: `Peer not found: ${requestedId}` });
      }

      res.json({
        ID: requestedId,
        PublicKey: '',
        Addresses: addresses,
        AgentVersion: peerVersions.agentVersion || '',
        ProtocolVersion: peerVersions.protocolVersion || '',
      });
    });

    app.get('/api/v0/swarm/peers', async (_req: Request, res: Response) => {
      const rows = listConnectionRows();
      res.json({
        Strings: rows.map((row) => formatConnectionString(row.peerId, row.addr)),
        Peers: rows.map((row) => ({
          Addr: row.addr,
          Peer: row.peerId,
          Latency: '',
          Muxer: '',
          Streams: [],
        })),
      });
    });

    app.get('/api/v0/swarm/connect', async (req: Request, res: Response) => {
      const target = getArgList(req)[0];
      if (!target) {
        return res.status(400).json({ Message: 'missing arg peer multiaddr' });
      }
      const result = await ipfs.connectToPeer(target);
      if (!result.success) {
        return res.status(400).json({ Message: result.error || 'Failed to connect peer' });
      }
      return res.json({ Strings: [target] });
    });

    app.get('/api/v0/bitswap/wantlist', (_req: Request, res: Response) => {
      res.json({ Keys: [] });
    });

    app.get('/api/v0/geoip/:ip', (_req: Request, res: Response) => {
      res.json({ formatted: '' });
    });

    app.get('/api/v0/config', async (req: Request, res: Response) => {
      const args = getArgList(req);
      const key = args[0];
      const value = args[1];
      const gatewayAddress = await resolveGatewayAddress();
      if (!key) {
        return res.status(400).json({ Message: 'missing config key in arg' });
      }

      if (key === 'Gateway.Enabled' && value != null) {
        compatGatewayEnabled = value === 'true' || value === '1';
      }

      if (key === 'Addresses.Gateway') {
        return res.json({ Key: key, Value: gatewayAddress });
      }
      if (key === 'Gateway.Enabled') {
        return res.json({ Key: key, Value: compatGatewayEnabled });
      }
      return res.status(404).json({ Message: `Unsupported config key: ${key}` });
    });

    app.get('/api/v0/config/show', async (_req: Request, res: Response) => {
      const gatewayAddress = await resolveGatewayAddress();

      res.json({
        Addresses: {
          Gateway: gatewayAddress,
        },
        Gateway: {
          Enabled: compatGatewayEnabled,
        },
      });
    });

    app.post('/api/v0/config/replace', (_req: Request, res: Response) => {
      // No-op compatibility endpoint; this dev server does not persist full Kubo config files.
      res.json({ Message: 'ok' });
    });

    app.get('/api/v0/gateway/enable', (_req: Request, res: Response) => {
      compatGatewayEnabled = true;
      res.json({ Message: 'Gateway enabled' });
    });

    app.get('/api/v0/gateway/disable', (_req: Request, res: Response) => {
      compatGatewayEnabled = false;
      res.json({ Message: 'Gateway disabled' });
    });

    app.get('/api/v0/pin/ls', (req: Request, res: Response) => {
      const args = getArgList(req);
      if (args.length > 0) {
        const cid = args[0];
        if (!cid) return res.status(400).json({ Message: 'missing cid' });
        return res.json({ Keys: compatPinnedCids.has(cid) ? [cid] : [] });
      }
      return res.json({ Keys: Array.from(compatPinnedCids).sort() });
    });

    app.get('/api/v0/pin/add', async (req: Request, res: Response) => {
      const cid = getArgList(req)[0];
      if (!cid) return res.status(400).json({ Message: 'missing cid arg' });
      await ipfs.pinFile(cid);
      compatPinnedCids.add(cid);
      return res.json({ Pins: [cid] });
    });

    app.get('/api/v0/pin/rm', async (req: Request, res: Response) => {
      const cid = getArgList(req)[0];
      if (!cid) return res.status(400).json({ Message: 'missing cid arg' });
      await ipfs.unpinFile(cid);
      compatPinnedCids.delete(cid);
      return res.json({ Pins: [cid] });
    });

    app.post('/api/v0/add', async (req: Request, res: Response) => {
      const contentType = String(req.headers['content-type'] || '');
      const boundary = parseMultipartBoundary(contentType);
      if (!boundary) {
        return res.status(400).json({ Message: 'Missing multipart boundary in Content-Type' });
      }

      const rawBody = await readRequestBuffer(req);
      const files = parseCompatMultipartBody(rawBody, boundary);
      if (files.length === 0) {
        return res.status(400).json({ Message: 'No file payload found in multipart body' });
      }

      const results: Array<{ Name: string; Hash: string; Size: number }> = [];
      for (const file of files) {
        const cid = await ipfs.storeFile(file.data, { pin: true });
        compatPinnedCids.add(cid);
        results.push({
          Name: file.filename || file.name || '',
          Hash: cid,
          Size: file.data.length,
        });
      }

      return res.json(results);
    });

    app.get('/api/v0/object/get', async (req: Request, res: Response) => {
      const arg = getArgList(req)[0];
      if (!arg) {
        return res.status(400).json({ Message: 'missing arg query parameter' });
      }

      try {
        const object = await resolveObject(arg);
        if (!object) {
          return res.status(404).json({ Message: 'Path not found' });
        }
        return res.json(object);
      } catch (error: any) {
        return res.status(500).json({ Message: error?.message || 'Failed to retrieve object' });
      }
    });

    app.get('/api/v0/object/links', async (req: Request, res: Response) => {
      const arg = getArgList(req)[0];
      if (!arg) return res.status(400).json({ Message: 'missing arg query parameter' });
      try {
        const object = await resolveObject(arg);
        if (!object) return res.status(404).json({ Message: 'Path not found' });
        return res.json({ Links: object.Links });
      } catch (error: any) {
        return res.status(500).json({ Message: error?.message || 'Failed to retrieve links' });
      }
    });

    app.get('/api/v0/object/data', async (req: Request, res: Response) => {
      const arg = getArgList(req)[0];
      if (!arg) return res.status(400).json({ Message: 'missing arg query parameter' });
      try {
        const object = await resolveObject(arg);
        if (!object) return res.status(404).json({ Message: 'Path not found' });
        const decoded = Buffer.from(object.Data || '', 'base64');
        res.type('application/octet-stream');
        return res.send(decoded);
      } catch (error: any) {
        return res.status(500).json({ Message: error?.message || 'Failed to retrieve data' });
      }
    });

    app.get('/api/v0/update/check', (_req: Request, res: Response) => {
      res.status(500).json({ Message: 'update not supported in helia-dev' });
    });

    app.get('/api/v0/update', (_req: Request, res: Response) => {
      res.status(500).json({ Message: 'update not supported in helia-dev' });
    });

    app.get('/api/v0/log/tail', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('x-chunked-output', '1');
      res.write(`${JSON.stringify({ event: 'ipfs-dev', message: 'log tail compatibility stream', ts: new Date().toISOString() })}\n`);
      res.end();
    });
  } else {
    app.use('/api/v0', (_req: Request, res: Response) => {
      res.status(404).json({ Message: 'Kubo compatibility API is disabled (dev-only endpoint)' });
    });
  }

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
  <p>WebUI: <a href="/webui">/webui</a></p>
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
