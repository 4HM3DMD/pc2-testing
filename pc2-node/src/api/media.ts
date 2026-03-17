/**
 * PC2 Media Runtime API — DASH/CENC video playback inside PC2.
 *
 * POST /api/media/prepare-auth — Start Lit session creation, return SIWE message for user signing
 * POST /api/media/init         — Complete auth + resolve NFT, fetch MPD, recover CEK, create session
 * POST /api/media/segment      — Fetch encrypted segment from IPFS, decrypt via WASM, stream back
 */

import { Router, type Request, type Response } from 'express';
import { resolve as pathResolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import * as crypto from 'crypto';
import { webcrypto } from 'crypto';
import { parseMPD } from '../services/media/mpdParser.js';
import { mediaSessionManager } from '../services/media/sessionManager.js';
import { getWASMRuntime } from '../services/wasm/WASMRuntime.js';
import { createLogger } from '../utils/logger.js';

const subtle = webcrypto.subtle;

const logger = createLogger('media-api');
const router = Router();

interface AuthenticatedRequest extends Request {
  user?: { uuid: string; username: string };
}

function getAuthToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return (req.body?.auth_token as string) || null;
}

function getBaseUrl(req: Request, bosonService?: any): string {
  if (bosonService?.getPublicBaseUrl) {
    try {
      const pubUrl = bosonService.getPublicBaseUrl();
      if (pubUrl) return pubUrl;
    } catch { /* fall through */ }
  }
  return `${req.protocol}://${req.get('host')}`;
}

// ─── POST /api/media/prepare-auth ────────────────────────────────────
// Chipotle: Two-phase SIWE auth is no longer needed (API key replaces it).
// This endpoint returns a stub response for backward compatibility with
// existing media players that still call prepare-auth before init.
router.post('/prepare-auth', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { buyerAddress } = req.body;
    if (!buyerAddress) {
      res.status(400).json({ error: 'buyerAddress is required' });
      return;
    }

    // Return a no-op requestId. The /init endpoint now ignores requestId
    // and goes straight to Chipotle REST CEK recovery.
    const requestId = crypto.randomUUID();
    logger.info(`[media/prepare-auth] Chipotle mode — skipping SIWE, returning stub for ${buyerAddress}`);
    res.json({ requestId, siweMessage: null, chipotleMode: true });
  } catch (error: any) {
    logger.error(`[media/prepare-auth] Error: ${error.message}`, error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/media/init ────────────────────────────────────────────
router.post('/init', async (req: AuthenticatedRequest, res: Response) => {
  const requestStart = Date.now();
  try {
    const { channel, tokenId, mediaUri: clientMediaUri, tokenURI, title: clientTitle, authority: clientAuthority } = req.body;
    if (!channel || !tokenId) {
      res.status(400).json({ error: 'channel and tokenId are required' });
      return;
    }

    const authToken = getAuthToken(req);
    if (!authToken) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    logger.info(`[media/init] channel=${channel} tokenId=${tokenId} mediaUri=${clientMediaUri || '(none)'}`);

    // 1. Resolve media URI — prefer what the frontend already knows
    const baseUrl = getBaseUrl(req, req.app?.locals?.bosonService);
    const ipfsGateway = baseUrl + '/ipfs/';
    const fallbackGateway = 'https://ipfs.ela.city/ipfs/';

    let mediaUri = clientMediaUri || '';
    let rawMeta: any = null;

    // If frontend didn't pass mediaUri, fetch raw token metadata from IPFS
    if (!mediaUri && tokenURI) {
      logger.info(`[media/init] No mediaUri from client, fetching tokenURI: ${tokenURI}`);
      rawMeta = await fetchJsonFromIPFS(tokenURI, ipfsGateway, fallbackGateway);
      if (rawMeta?.media?.uri) {
        mediaUri = rawMeta.media.uri.replace('ipfs://', '');
      }
    }

    if (!mediaUri) {
      res.status(400).json({ error: 'No media URI available. Ensure the asset has video/audio content.' });
      return;
    }

    // 2. Fetch and parse MPD
    const mpdUrl = ipfsGateway + mediaUri + '/stream.mpd';
    logger.info(`[media/init] Fetching MPD: ${mpdUrl}`);

    let mpdText: string;
    const mpdResponse = await fetch(mpdUrl);
    if (mpdResponse.ok) {
      mpdText = await mpdResponse.text();
    } else {
      const fallbackUrl = fallbackGateway + mediaUri + '/stream.mpd';
      logger.info(`[media/init] Local MPD failed (${mpdResponse.status}), trying fallback: ${fallbackUrl}`);
      const fbResponse = await fetch(fallbackUrl);
      if (!fbResponse.ok) {
        res.status(502).json({ error: `Failed to fetch MPD from both gateways (local: ${mpdResponse.status}, public: ${fbResponse.status})` });
        return;
      }
      mpdText = await fbResponse.text();
    }

    const mpdBaseUrl = ipfsGateway + mediaUri + '/';
    const mpd = parseMPD(mpdText, mpdBaseUrl);
    logger.info(`[media/init] Parsed MPD: ${mpd.tracks.length} tracks, ${mpd.duration.toFixed(1)}s`);

    // 3. Recover CEK via Lit Protocol
    // For media, encryption params are in the PSSH boxes of the init segment (not in token metadata).
    // Fetch the first video init segment and extract PSSH JSON.
    const videoTrack = mpd.tracks.find(t => t.type === 'video') || mpd.tracks[0];
    if (!videoTrack) {
      res.status(400).json({ error: 'No tracks found in MPD' });
      return;
    }

    logger.info(`[media/init] Fetching init segment for PSSH extraction: ${videoTrack.initUrl}`);
    const initBytes = await fetchBytesFromIPFS(videoTrack.initUrl, ipfsGateway, fallbackGateway);
    const psshEntries = extractPSSHJson(initBytes);

    if (psshEntries.length === 0) {
      res.status(400).json({ error: 'No PSSH encryption data found in init segment. Content may not be DRM-protected.' });
      return;
    }

    // Detect whether the buyer is a Smart Account (Universal Account) user.
    // If so, use cenc:lit-drm-sa-v1 whose inner Lit Action maps EOA → SA on-chain.
    const buyerAddr = req.body.buyerAddress || '';
    const hasSAEntry = psshEntries.some(p => p.protectionType === 'cenc:lit-drm-sa-v1');
    const hasEOAEntry = psshEntries.some(p => p.protectionType === 'cenc:lit-drm-v1');
    let isSmartAccountUser = false;

    if (hasSAEntry && buyerAddr) {
      try {
        isSmartAccountUser = await detectSmartAccountUser(buyerAddr, psshEntries);
      } catch (err: any) {
        logger.warn(`[media/init] SA detection failed (will try EOA path): ${err.message}`);
      }
    }

    const preferredType = isSmartAccountUser ? 'cenc:lit-drm-sa-v1' : 'cenc:lit-drm-v1';
    const pssh = psshEntries.find(p => p.protectionType === preferredType)
              || psshEntries[0];

    logger.info(`[media/init] Using PSSH: type=${pssh.protectionType}, action=${pssh.data?.actionIpfsId}, isSmartAccount=${isSmartAccountUser}`);

    const encData = pssh.data || {};

    // Extract KID from access control conditions or MPD ContentProtection
    let kid = encData.kid || '';
    if (!kid) {
      const conditions = encData.unifiedAccessControlConditions || [];
      for (const cond of conditions) {
        if (cond.parameters && Array.isArray(cond.parameters)) {
          const kidParam = cond.parameters.find((p: string) => typeof p === 'string' && /^0x[0-9a-f]{32}$/i.test(p));
          if (kidParam) { kid = kidParam; break; }
        }
      }
    }
    // Fallback: extract from MPD XML cenc:default_KID
    if (!kid) {
      const kidMatch = mpdText.match(/default_KID="([^"]+)"/);
      if (kidMatch) {
        kid = '0x' + kidMatch[1].replace(/-/g, '');
      }
    }

    const litParams = {
      litCiphertext: encData.ciphertext || '',
      dataToEncryptHash: encData.hash || encData.dataToEncryptHash || '',
      kid,
      actionCid: encData.actionIpfsId || '',
      authority: encData.authority || clientAuthority || '',
      chain: encData.chain || 'base',
      chainId: encData.chainId || 8453,
      rpc: encData.rpc || '',
    };

    if (!litParams.litCiphertext || !litParams.dataToEncryptHash || !litParams.actionCid) {
      res.status(400).json({ error: 'PSSH data incomplete — missing ciphertext, hash, or actionIpfsId' });
      return;
    }

    const { getServerWallet } = await import('./storage.js');
    const wallet = await getServerWallet();
    const buyerAddress = req.body.buyerAddress || '';

    // Chipotle: API key auth replaces two-phase SIWE. No session sigs needed.
    // The requestId/litAuthSig params from older clients are gracefully ignored.
    const cekBase64 = await recoverMediaCEK(litParams, wallet, undefined, buyerAddress);
    logger.info(`[media/init] CEK recovered in ${Date.now() - requestStart}ms`);

    // 4. Create session
    const session = mediaSessionManager.create({
      cekBase64,
      mpd,
      mpdBaseUrl,
      channel,
      tokenId,
      authToken,
    });

    // Build track info for the frontend (without CEK)
    const trackInfo = mpd.tracks.map((t, i) => ({
      index: i,
      type: t.type,
      codec: t.codec,
      mimeType: t.mimeType,
      bandwidth: t.bandwidth,
      width: t.width,
      height: t.height,
      representationId: t.representationId,
      segmentCount: t.segments.length,
      segmentStarts: t.segments.map(s => Math.round(s.startTime * 1000) / 1000),
    }));

    res.json({
      sessionId: session.id,
      title: clientTitle || rawMeta?.name || 'Untitled',
      duration: mpd.duration,
      tracks: trackInfo,
      totalTimeMs: Date.now() - requestStart,
    });
  } catch (error: any) {
    logger.error(`[media/init] Error: ${error.message}`, error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/media/segment ─────────────────────────────────────────
router.post('/segment', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId, trackIndex, segmentNumber, init } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const authToken = getAuthToken(req);
    if (!authToken) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const session = mediaSessionManager.get(sessionId, authToken);
    if (!session) {
      res.status(410).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
      return;
    }

    const trackIdx = typeof trackIndex === 'number' ? trackIndex : 0;
    const track = session.mpd.tracks[trackIdx];
    if (!track) {
      res.status(400).json({ error: `Track ${trackIdx} not found` });
      return;
    }

    // Determine which URL to fetch
    let segmentUrl: string;
    if (init) {
      segmentUrl = track.initUrl;
    } else {
      const segNum = typeof segmentNumber === 'number' ? segmentNumber : 0;
      const seg = track.segments[segNum];
      if (!seg) {
        res.status(400).json({ error: `Segment ${segNum} not found (track has ${track.segments.length} segments)` });
        return;
      }
      segmentUrl = seg.url;
    }

    logger.info(`[media/segment] Fetching: ${segmentUrl.substring(0, 80)}...`);

    // Fetch encrypted segment from IPFS
    const ipfsService = req.app?.locals?.ipfs;
    const segmentBytes = await fetchSegmentBytes(segmentUrl, ipfsService);

    if (init) {
      // Cache raw init segment for WASM decryption (tenc extraction)
      session.initSegments.set(trackIdx, segmentBytes);

      // Strip CENC encryption signaling via WASM (encv → av01, enca → mp4a/Opus,
      // remove sinf box, strip pssh boxes). Uses strip_init mode in cenc-decrypt.
      const cleanInit = await stripInitViaWASM(segmentBytes);
      logger.info(`[media/segment] Init segment: raw=${segmentBytes.length}B → clean=${cleanInit.length}B (stripped ${segmentBytes.length - cleanInit.length}B of DRM signaling)`);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(cleanInit.length));
      res.send(cleanInit);
      return;
    }

    // Get cached init segment for this track (provides tenc for IV size)
    const initSegForTrack = session.initSegments.get(trackIdx) || null;

    // Decrypt + strip via WASM (combined: decrypt samples then remove senc/saiz/saio boxes)
    const cleanSegment = await decryptSegmentViaWASM(
      segmentBytes,
      session.cekBase64,
      initSegForTrack,
    );

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(cleanSegment.length));
    res.send(cleanSegment);
  } catch (error: any) {
    logger.error(`[media/segment] Error: ${error.message}`, error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Smart Account Detection ─────────────────────────────────────────

const SA_FACTORY = '0xb3f15a44f91a08a93a11c6fbf6a4933c623275fe';
const SA_ENTRYPOINT = '0xba418fa699622de824b258c61eb150ed7a13967b';

/**
 * Detect if a user's EOA has a deployed Smart Account on Base (chain 8453).
 * Calls the factory contract's getAddress(entryPoint, initData, salt) view function
 * to derive the counterfactual SA address, then checks if it has deployed code.
 */
async function detectSmartAccountUser(
  eoaAddress: string,
  psshEntries: Array<{ protectionType: string; data: any }>,
): Promise<boolean> {
  // Extract RPC URL from PSSH data (the Lit Action embeds it)
  const saEntry = psshEntries.find(p => p.protectionType === 'cenc:lit-drm-sa-v1');
  const rpcUrl = saEntry?.data?.rpc || 'https://mainnet.base.org';

  // Build calldata for factory.getAddress(entryPoint, initData, salt=0)
  // initData = 0x2ede3bc0 + eoaAddress (padded to 32 bytes)
  const cleanAddr = eoaAddress.replace('0x', '').toLowerCase().padStart(64, '0');
  const initData = '2ede3bc0' + cleanAddr;
  const initDataLen = (initData.length / 2).toString(16).padStart(64, '0');

  const callData = '0x2e7a1a83' +
    SA_ENTRYPOINT.replace('0x', '').padStart(64, '0') +
    '0000000000000000000000000000000000000000000000000000000000000060' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    initDataLen +
    initData.padEnd(Math.ceil(initData.length / 64) * 64, '0');

  // eth_call to factory → derive SA address
  const addrResult = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: SA_FACTORY, data: callData }, 'latest'],
    }),
  });
  const addrJson = await addrResult.json() as any;
  if (addrJson.error || !addrJson.result || addrJson.result === '0x') {
    logger.warn(`[media/SA] Factory call failed: ${JSON.stringify(addrJson.error || 'empty result')}`);
    return false;
  }

  const smartAccountAddr = '0x' + addrJson.result.slice(-40);
  logger.info(`[media/SA] EOA ${eoaAddress} → derived SA ${smartAccountAddr}`);

  // Check if the SA has deployed code (i.e., has been activated)
  const codeResult = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'eth_getCode',
      params: [smartAccountAddr, 'latest'],
    }),
  });
  const codeJson = await codeResult.json() as any;
  const hasCode = codeJson.result && codeJson.result !== '0x' && codeJson.result.length > 2;

  logger.info(`[media/SA] Smart Account ${smartAccountAddr} deployed=${hasCode}`);
  return hasCode;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveIpfsUrl(url: string, gateway: string): string {
  if (!url) return '';
  if (url.startsWith('ipfs://')) return gateway + url.slice(7);
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return gateway + url;
}

async function fetchJsonFromIPFS(cid: string, localGateway: string, publicGateway: string): Promise<any> {
  const cleanCid = cid.replace('ipfs://', '');
  const localUrl = localGateway + cleanCid;
  const publicUrl = publicGateway + cleanCid;

  try {
    const localRes = await fetch(localUrl);
    if (localRes.ok) return await localRes.json();
    logger.info(`[media] Local IPFS fetch failed (${localRes.status}), trying public`);
  } catch {
    logger.info('[media] Local IPFS unreachable, trying public');
  }

  const publicRes = await fetch(publicUrl);
  if (!publicRes.ok) throw new Error(`Failed to fetch ${cleanCid} from both gateways`);
  return await publicRes.json();
}

async function fetchBytesFromIPFS(pathOrUrl: string, localGateway: string, publicGateway: string): Promise<Buffer> {
  // If already a full URL (from resolved template), use it directly
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    const res = await fetch(pathOrUrl);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    // Try replacing gateway
    const ipfsMatch = pathOrUrl.match(/\/ipfs\/(.+)/);
    if (ipfsMatch) {
      const publicUrl = publicGateway + ipfsMatch[1];
      const pubRes = await fetch(publicUrl);
      if (pubRes.ok) return Buffer.from(await pubRes.arrayBuffer());
    }
    throw new Error(`Failed to fetch: ${pathOrUrl} (${res.status})`);
  }

  const cleanPath = pathOrUrl.replace('ipfs://', '').replace(/^\/ipfs\//, '');
  const localUrl = localGateway + cleanPath;
  const publicUrl = publicGateway + cleanPath;

  try {
    const localRes = await fetch(localUrl);
    if (localRes.ok) {
      const buf = await localRes.arrayBuffer();
      logger.info(`[media] Fetched ${buf.byteLength} bytes from local IPFS: ${cleanPath}`);
      return Buffer.from(buf);
    }
    logger.info(`[media] Local fetch failed (${localRes.status}), trying public gateway`);
  } catch {
    logger.info('[media] Local IPFS unreachable for bytes, trying public');
  }

  const publicRes = await fetch(publicUrl);
  if (!publicRes.ok) throw new Error(`Failed to fetch bytes ${cleanPath} from both gateways`);
  const buf = await publicRes.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Extract PSSH JSON payloads from an fMP4 init segment.
 * PSSH boxes contain JSON-encoded Lit Protocol DRM parameters.
 * The JSON is embedded as raw bytes in PSSH box data fields.
 */
function extractPSSHJson(initSegment: Buffer): Array<{ protectionType: string; data: any }> {
  const results: Array<{ protectionType: string; data: any }> = [];
  // Convert to string; binary is ASCII-safe for the JSON portions
  const text = initSegment.toString('binary');

  // Strategy: find JSON objects starting with {"data": that contain actionIpfsId.
  // These can be large (nested access conditions), so we use brace counting.
  let searchStart = 0;
  while (true) {
    const marker = text.indexOf('{"data":{', searchStart);
    if (marker === -1) break;

    // Walk forward counting braces to find the end of this JSON object
    let depth = 0;
    let end = -1;
    for (let i = marker; i < text.length && i < marker + 8192; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }

    if (end === -1) { searchStart = marker + 1; continue; }

    const jsonStr = text.substring(marker, end);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.data?.actionIpfsId) {
        results.push({
          protectionType: parsed.protectionType || 'unknown',
          data: parsed.data,
        });
      }
    } catch (e) {
      logger.warn(`[media] Failed to parse PSSH JSON at offset ${marker}: ${(e as Error).message}`);
    }
    searchStart = end;
  }

  logger.info(`[media] Extracted ${results.length} PSSH entries from init segment (${initSegment.length} bytes)`);
  return results;
}

// ── JS strip functions — replaced by Rust/WASM in cenc-decrypt crate ──────────
// Kept commented for one release cycle as a safety net. If WASM stripping works
// correctly across all media types, these can be deleted.
//
// function stripEncryptionSignaling(init: Buffer): Buffer { ... }
// function stripSegmentEncryptionBoxes(segment: Buffer): Buffer { ... }
// function findBoxStart(buf: Buffer, start: number, end: number, boxType: string): number { ... }
// function findBoxPath(buf: Buffer, start: number, end: number, path: string[]): { ... } | null { ... }

const FALLBACK_IPFS_GATEWAY = 'https://ipfs.ela.city/ipfs/';

async function fetchSegmentBytes(url: string, ipfsService?: any): Promise<Buffer> {
  // Try extracting CID path from URL for direct local access and fallback
  const ipfsMatch = url.match(/\/ipfs\/(.+)/);
  const ipfsPath = ipfsMatch ? ipfsMatch[1] : '';

  if (ipfsService && ipfsPath) {
    const rootCid = ipfsPath.split('/')[0];
    try {
      const bytes = await ipfsService.getFile(rootCid);
      if (bytes && bytes.length > 0) {
        logger.info(`[media/segment] Got ${bytes.length} bytes from local blockstore`);
        return Buffer.from(bytes);
      }
    } catch { /* fall through to HTTP */ }
  }

  // Try the original URL (local gateway)
  const response = await fetch(url);
  if (response.ok) {
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  // Fallback to public IPFS gateway
  if (ipfsPath) {
    const fallbackUrl = FALLBACK_IPFS_GATEWAY + ipfsPath;
    logger.info(`[media/segment] Local 404, trying public: ${fallbackUrl.substring(0, 80)}...`);
    const fbResponse = await fetch(fallbackUrl);
    if (fbResponse.ok) {
      const arrayBuf = await fbResponse.arrayBuffer();
      return Buffer.from(arrayBuf);
    }
    throw new Error(`Failed to fetch segment from both gateways (local: ${response.status}, public: ${fbResponse.status})`);
  }

  throw new Error(`Failed to fetch segment: ${response.status} ${response.statusText}`);
}

let cachedCENCWasmBinary: ArrayBuffer | null = null;

async function loadCENCWasmBinary(): Promise<ArrayBuffer> {
  if (cachedCENCWasmBinary) return cachedCENCWasmBinary;
  const wasmPath = pathResolve(__dirname, '../../wasm-apps/cenc-decrypt/cenc-decrypt.wasm');
  if (!existsSync(wasmPath)) {
    throw new Error(`CENC decrypt WASM not found: ${wasmPath}`);
  }
  cachedCENCWasmBinary = readFileSync(wasmPath).buffer;
  return cachedCENCWasmBinary;
}

/**
 * Strip encryption signaling from an init segment via WASM.
 * Uses the cenc-decrypt module's strip_init mode (encv→av01/enca→mp4a,
 * remove sinf, remove pssh). 64-bit extended box sizes handled.
 */
async function stripInitViaWASM(initSegment: Buffer): Promise<Buffer> {
  const wasmRuntime = getWASMRuntime();
  const wasmBinary = await loadCENCWasmBinary();

  const commandJson = JSON.stringify({
    cek_b64: '',
    mode: 'strip_init',
  });

  const result = await wasmRuntime.executeCENCDecrypt(
    wasmBinary,
    commandJson,
    initSegment,
    null,
    { timeoutMs: 10000 },
  );

  if (!result.success || !result.decryptedBytes) {
    throw new Error(`WASM strip_init failed: ${result.error || 'no output'}`);
  }

  return result.decryptedBytes;
}

async function decryptSegmentViaWASM(
  encryptedSegment: Buffer,
  cekBase64: string,
  initSegment?: Buffer | null,
): Promise<Buffer> {
  const wasmRuntime = getWASMRuntime();

  const commandJson = JSON.stringify({
    cek_b64: cekBase64,
    iv_size: 8,
    is_init: false,
    strip: true,
  });

  const wasmBinary = await loadCENCWasmBinary();

  logger.info(`[media/WASM] Decrypting segment: inputSize=${encryptedSegment.length}, hasInit=${!!initSegment}`);

  const result = await wasmRuntime.executeCENCDecrypt(
    wasmBinary,
    commandJson,
    encryptedSegment,
    initSegment || null,
    { timeoutMs: 30000 },
  );

  if (!result.success || !result.decryptedBytes) {
    throw new Error(`WASM decryption failed: ${result.error || 'no output'}`);
  }

  logger.info(`[media/WASM] Decrypted: outputSize=${result.decryptedBytes.length}, time=${result.executionTimeMs}ms, error=${result.error || 'none'}`);

  // Find mdat box and compare encrypted vs decrypted data within it
  const mdatStr = 'mdat';
  let mdatPos = -1;
  for (let i = 0; i < Math.min(encryptedSegment.length - 4, 64000); i++) {
    if (encryptedSegment[i] === 0x6d && encryptedSegment[i+1] === 0x64 && encryptedSegment[i+2] === 0x61 && encryptedSegment[i+3] === 0x74) {
      mdatPos = i + 4;
      break;
    }
  }
  if (mdatPos > 0 && mdatPos + 32 < encryptedSegment.length) {
    const inMdat = encryptedSegment.subarray(mdatPos, mdatPos + 32).toString('hex');
    const outMdat = result.decryptedBytes.subarray(mdatPos, mdatPos + 32).toString('hex');
    const changed = inMdat !== outMdat;
    logger.info(`[media/WASM] mdat@${mdatPos}: changed=${changed}`);
    logger.info(`[media/WASM]   encrypted: ${inMdat}`);
    logger.info(`[media/WASM]   decrypted: ${outMdat}`);
  }

  return result.decryptedBytes;
}

/**
 * Start Lit getSessionSigs with a callback-bridged auth flow.
 * The authNeededCallback constructs the SIWE message (with ReCap capabilities)
 * and delegates signing to the caller via onAuthNeeded.
 */
async function startUserSessionSigs(
  client: any,
  buyerAddress: string,
  onAuthNeeded: (siweMessage: string) => Promise<any>,
): Promise<any> {
  const {
    LitAccessControlConditionResource,
    LitActionResource,
    RecapSessionCapabilityObject,
  } = await import('@lit-protocol/auth-helpers');
  const { LIT_ABILITY } = await import('@lit-protocol/constants');
  const { SiweMessage } = await import('siwe');
  const { ethers } = await import('ethers');

  const checksumAddr = ethers.getAddress(buyerAddress);
  const expiration = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const accResource = new LitAccessControlConditionResource('*');
  const actionResource = new LitActionResource('*');

  const resourceAbilityRequests = [
    { resource: accResource, ability: LIT_ABILITY.AccessControlConditionDecryption },
    { resource: actionResource, ability: LIT_ABILITY.LitActionExecution },
  ];

  const sessionCapabilityObject = new RecapSessionCapabilityObject({}, []);
  sessionCapabilityObject.addCapabilityForResource(accResource, LIT_ABILITY.AccessControlConditionDecryption);
  sessionCapabilityObject.addCapabilityForResource(actionResource, LIT_ABILITY.LitActionExecution);

  const sessionOpts: any = {
    chain: 'ethereum',
    expiration,
    resourceAbilityRequests,
    sessionCapabilityObject,
    authNeededCallback: async (params: any) => {
      // Construct the SIWE message using the params from the Lit SDK
      // (includes session key URI, ReCap resources, nonce, etc.)
      const siweMessage = new SiweMessage({
        domain: params.domain || 'localhost',
        address: checksumAddr,
        statement: params.statement || 'Lit Protocol session signature',
        uri: params.uri || 'https://localhost',
        version: '1',
        chainId: 1,
        nonce: params.nonce || await client.getLatestBlockhash(),
        expirationTime: params.expiration || expiration,
        resources: params.resources || [],
      });

      const messageToSign = siweMessage.prepareMessage();
      logger.info(`[media/auth] SIWE message prepared for ${checksumAddr}, uri=${params.uri?.substring(0, 40)}...`);

      // Delegate signing to the frontend via the bridge
      const authSig = await onAuthNeeded(messageToSign);

      logger.info(`[media/auth] Received signed auth from frontend for ${authSig.address}`);
      return authSig;
    },
  };

  // Add capacity delegation if available
  try {
    const { getCapacityWallet, detectCapacityTokenId, getServerWallet } = await import('./storage.js');
    const capacityWallet = await getCapacityWallet();
    if (capacityWallet) {
      const tokenId = await detectCapacityTokenId(capacityWallet.address);
      if (tokenId) {
        const { capacityDelegationAuthSig } = await client.createCapacityDelegationAuthSig({
          dAppOwnerWallet: capacityWallet,
          capacityTokenId: tokenId,
          delegateeAddresses: [checksumAddr],
          uses: '10',
          expiration,
        });
        sessionOpts.capacityDelegationAuthSig = capacityDelegationAuthSig;
        logger.info(`[media/auth] Capacity delegation attached for ${checksumAddr}`);
      }
    }
  } catch (err: any) {
    logger.warn(`[media/auth] Capacity delegation setup skipped: ${err.message}`);
  }

  const sessionSigs = await client.getSessionSigs(sessionOpts);
  logger.info(`[media/auth] Session sigs created for ${checksumAddr}: ${Object.keys(sessionSigs).length} nodes`);
  return sessionSigs;
}

/**
 * Fetch and cache Lit Action JavaScript code by IPFS CID.
 * Media Lit Actions are stored on IPFS (not local like non-media-decrypt.js).
 * Chipotle requires inline code — so we fetch the JS source by CID.
 */
const litActionCodeCache = new Map<string, string>();

async function fetchLitActionCode(cid: string): Promise<string> {
  const cached = litActionCodeCache.get(cid);
  if (cached) return cached;

  const gateways = [
    `http://localhost:4200/ipfs/${cid}`,
    `https://ipfs.ela.city/ipfs/${cid}`,
    `https://gateway.pinata.cloud/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}`,
  ];

  for (const url of gateways) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const code = await resp.text();
        if (code && code.length > 10) {
          litActionCodeCache.set(cid, code);
          logger.info(`[media/CEK] Fetched Lit Action code from ${url.includes('localhost') ? 'local' : 'remote'} IPFS (${code.length} chars)`);
          return code;
        }
      }
    } catch { /* try next gateway */ }
  }

  throw new Error(`Failed to fetch media Lit Action code from IPFS: ${cid}`);
}

/**
 * Recover the Content Encryption Key for media assets via Lit Protocol.
 *
 * Media Lit Actions use an ECDH envelope: the caller sends an ephemeral
 * public key, the Lit Action decrypts the CEK internally, wraps it with
 * ECDH + AES-CBC, and returns the envelope. The caller unwraps to get
 * the raw 16-byte CENC AES-128-CTR key.
 */
async function recoverMediaCEK(
  litParams: {
    litCiphertext: string;
    dataToEncryptHash: string;
    kid: string;
    actionCid: string;
    authority: string;
    chain: string;
    chainId: number;
    rpc: string;
  },
  wallet: any,
  prebuiltSessionSigs?: any,
  buyerAddress?: string,
): Promise<string> {
  // Generate ephemeral ECDH P-256 key pair for envelope unwrapping
  const keyAlg = { name: 'ECDH', namedCurve: 'P-256' } as const;
  const keyPair = await subtle.generateKey(keyAlg, true, ['deriveKey', 'deriveBits']);
  const rawPubKey = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
  const publicKeyHex = Buffer.from(rawPubKey).toString('hex');

  const effectiveUserAddr = buyerAddress || wallet.address;
  logger.info(`[media/CEK] Calling Lit Action ${litParams.actionCid} with P-256 ECDH, kid=${litParams.kid}, user=${effectiveUserAddr}`);

  // Fetch the media Lit Action code by IPFS CID (it's not our local non-media-decrypt.js)
  const mediaActionCode = await fetchLitActionCode(litParams.actionCid);

  const { recoverMediaCEKEnvelope } = await import('./chipotle-client.js');
  const envelope = await recoverMediaCEKEnvelope(
    {
      litCiphertext: litParams.litCiphertext,
      dataToEncryptHash: litParams.dataToEncryptHash,
      kid: litParams.kid,
      buyerAddress: effectiveUserAddr,
      actionCid: litParams.actionCid,
      publicKeyHex,
      authority: litParams.authority,
      chain: litParams.chain,
      chainId: litParams.chainId,
      rpc: litParams.rpc,
    },
    mediaActionCode,
  );

  logger.info(`[media/CEK] Received envelope: ${envelope.length} bytes (Chipotle REST)`);

  return unwrapECDHEnvelope(envelope, keyPair.privateKey, rawPubKey, keyAlg);
}

/**
 * Unwrap an ECDH-wrapped license envelope from the media Lit Action.
 *
 * Envelope format:
 *   HEADER: format (3 bytes) + flag (1 byte)
 *   METADATA:
 *     ephemeral_pubkey_len (u16be) + ephemeral_pubkey
 *     signature_len (u16be) + signature + signer_compressed_pubkey (33 bytes)
 *   BODY:
 *     encrypted_cek_len (u32be) + encrypted_cek (AES-CBC)
 *
 * Decrypted payload (rawLicenseBytes):
 *   metadata_size (u32be) + metadata (issuer + exp) + key_count (u32be) + keys
 */
async function unwrapECDHEnvelope(
  envelope: Buffer,
  privateKey: CryptoKey,
  ourRawPubKey: Uint8Array,
  keyAlg: { name: string; namedCurve: string },
): Promise<string> {
  let offset = 4; // skip header (3 bytes format + 1 byte flag)

  // Read ephemeral public key
  const ephPubKeyLen = (envelope[offset] << 8) | envelope[offset + 1];
  offset += 2;
  const ephPubKeyRaw = envelope.subarray(offset, offset + ephPubKeyLen);
  offset += ephPubKeyLen;

  // Skip signature
  const sigLen = (envelope[offset] << 8) | envelope[offset + 1];
  offset += 2;
  offset += sigLen;
  offset += 33; // compressed signer public key

  // Read encrypted CEK
  const encCekLen = (envelope[offset] << 24) | (envelope[offset + 1] << 16) |
                    (envelope[offset + 2] << 8) | envelope[offset + 3];
  offset += 4;
  const encryptedCek = envelope.subarray(offset, offset + encCekLen);

  logger.info(`[media/CEK] Envelope: ephPubKey=${ephPubKeyLen}B, sig=${sigLen}B, encCEK=${encCekLen}B`);

  // Decompress P-256 point if needed (Lit Action compresses for P-256)
  let litPubKeyUncompressed: Uint8Array;
  if (ephPubKeyRaw[0] === 0x02 || ephPubKeyRaw[0] === 0x03) {
    litPubKeyUncompressed = decompressP256Point(ephPubKeyRaw);
  } else {
    litPubKeyUncompressed = new Uint8Array(ephPubKeyRaw);
  }

  // Import Lit's ephemeral public key
  const litPubKey = await subtle.importKey(
    'raw',
    litPubKeyUncompressed,
    { name: keyAlg.name, namedCurve: keyAlg.namedCurve },
    false,
    [],
  );

  // Derive shared AES-CBC-256 key via ECDH
  const sharedKey = await subtle.deriveKey(
    { name: keyAlg.name, namedCurve: keyAlg.namedCurve, public: litPubKey } as any,
    privateKey,
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  );

  // IV = first 16 bytes of OUR raw public key (matches Lit Action's `pubKeyBuff.subarray(0, 16)`)
  const iv = ourRawPubKey.subarray(0, 16);

  // Decrypt
  const decrypted = new Uint8Array(
    await subtle.decrypt({ name: 'AES-CBC', iv }, sharedKey, encryptedCek),
  );

  // Parse rawLicenseBytes: metadataSize(u32) | metadata | keyCount(u32) | keys
  const metaSize = (decrypted[0] << 24) | (decrypted[1] << 16) | (decrypted[2] << 8) | decrypted[3];
  const bodyOffset = 4 + metaSize;
  // const keyCount = (decrypted[bodyOffset] << 24) | ... — we expect 1 key
  const cekStart = bodyOffset + 4;
  const cekBytes = decrypted.subarray(cekStart, cekStart + 16);

  // Verify structure: read keyCount at bodyOffset
  const keyCount = (decrypted[bodyOffset] << 24) | (decrypted[bodyOffset + 1] << 16) |
                   (decrypted[bodyOffset + 2] << 8) | decrypted[bodyOffset + 3];
  logger.info(`[media/CEK] Unwrapped license: metaSize=${metaSize}, keyCount=${keyCount}, cekStart=${cekStart}, totalDecrypted=${decrypted.length}`);
  logger.info(`[media/CEK] CEK (hex): ${Buffer.from(cekBytes).toString('hex')}`);
  logger.info(`[media/CEK] Full decrypted payload (hex): ${Buffer.from(decrypted).toString('hex')}`);
  return Buffer.from(cekBytes).toString('base64');
}

/**
 * Decompress a compressed P-256 EC point (33 bytes → 65 bytes uncompressed).
 * P-256 curve: y² = x³ - 3x + b (mod p)
 */
function decompressP256Point(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33) throw new Error(`Invalid compressed point length: ${compressed.length}`);
  const prefix = compressed[0];
  if (prefix !== 0x02 && prefix !== 0x03) throw new Error(`Invalid prefix: 0x${prefix.toString(16)}`);

  const p = BigInt('0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF');
  const b = BigInt('0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B');
  const a = p - 3n;

  // Read x coordinate
  let x = 0n;
  for (let i = 1; i < 33; i++) {
    x = (x << 8n) | BigInt(compressed[i]);
  }

  // y² = x³ + ax + b (mod p)
  const x3 = modPow(x, 3n, p);
  const rhs = (x3 + a * x + b) % p;
  let y = modSqrt(rhs, p);

  // Choose correct y based on prefix (even/odd)
  const isOdd = (y & 1n) === 1n;
  if ((prefix === 0x03) !== isOdd) {
    y = p - y;
  }

  // Build uncompressed point: 0x04 || x (32 bytes) || y (32 bytes)
  const result = new Uint8Array(65);
  result[0] = 0x04;
  const xBytes = bigintToBytes32(x);
  const yBytes = bigintToBytes32(y);
  result.set(xBytes, 1);
  result.set(yBytes, 33);
  return result;
}

function bigintToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Tonelli–Shanks modular square root for P-256 (p ≡ 3 mod 4 → simple formula). */
function modSqrt(a: bigint, p: bigint): bigint {
  // For P-256, p ≡ 3 (mod 4), so sqrt(a) = a^((p+1)/4) mod p
  return modPow(a, (p + 1n) / 4n, p);
}

export default router;
export { router as mediaRouter };
