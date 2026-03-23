/**
 * Thumbnail Generation Module
 * 
 * Generates thumbnails for images, videos, PDFs, and text files
 * Uses optional dependencies: sharp, canvas, pdfjs-dist, ffmpeg
 */

import { logger } from '../utils/logger.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile as writeFileAsync, unlink as unlinkAsync } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

let sharp: any = null;
let canvas: any = null;
let pdfjs: any = null;

// Load required dependencies (sharp and pdfjs-dist are in package.json)
try {
  const sharpModule = await import('sharp');
  // sharp is the default export
  sharp = sharpModule.default || sharpModule;
  logger.info('[Thumbnail] ✅ Sharp loaded - image/video thumbnail generation enabled');
} catch (e) {
  logger.error('[Thumbnail] ❌ Sharp failed to load - image thumbnails will be disabled');
  logger.error('[Thumbnail] This is a required dependency. Please reinstall: npm install');
}

// Load optional dependency (canvas requires native compilation)
try {
  canvas = await import('canvas');
  logger.info('[Thumbnail] ✅ Canvas loaded - PDF/text thumbnail generation enabled');
} catch (e) {
  logger.warn('[Thumbnail] ⚠️  Canvas not available - PDF/text thumbnails will be disabled');
  logger.warn('[Thumbnail] 💡 Canvas is optional. To enable PDF/text thumbnails: npm install canvas');
  logger.warn('[Thumbnail] 💡 Note: Canvas requires native compilation and system libraries');
}

// Load required dependency (pdfjs-dist is in package.json)
try {
  const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs = pdfjsModule;
  logger.info('[Thumbnail] ✅ PDF.js loaded - PDF thumbnail generation enabled');
} catch (e) {
  logger.error('[Thumbnail] ❌ PDF.js failed to load - PDF thumbnails will be disabled');
  logger.error('[Thumbnail] This is a required dependency. Please reinstall: npm install');
}

/**
 * Check if a mime type supports thumbnails
 */
export function supportsThumbnails(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return mimeType.startsWith('image/') || 
         mimeType.startsWith('video/') || 
         mimeType === 'application/pdf' ||
         mimeType === 'text/plain' ||
         mimeType.startsWith('text/') ||
         mimeType === 'application/x-ddrm' ||
         mimeType === 'application/x-edrm' ||
         mimeType === 'application/x-ddrm+json';
}

const DDRM_BADGE_SIZE = 40;
const DDRM_BORDER_WIDTH = 4;
const DDRM_THUMB_SIZE = 128;
const DDRM_INNER_SIZE = DDRM_THUMB_SIZE - DDRM_BORDER_WIDTH * 2;

const DDRM_BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${DDRM_BADGE_SIZE}" height="${DDRM_BADGE_SIZE}" viewBox="0 0 40 40">
  <circle cx="20" cy="20" r="18" fill="#5C6BC0" stroke="#FFFFFF" stroke-width="2.5"/>
  <path d="M20 30s7-3.5 7-8.75V14.75L20 12l-7 2.75v6.5C13 26.5 20 30 20 30z" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="20" cy="20.5" r="1.8" fill="#FFFFFF"/>
</svg>`;

const DDRM_BORDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${DDRM_THUMB_SIZE}" height="${DDRM_THUMB_SIZE}" viewBox="0 0 ${DDRM_THUMB_SIZE} ${DDRM_THUMB_SIZE}">
  <rect x="1" y="1" width="${DDRM_THUMB_SIZE - 2}" height="${DDRM_THUMB_SIZE - 2}" rx="8" ry="8" fill="none" stroke="#5C6BC0" stroke-width="${DDRM_BORDER_WIDTH}"/>
</svg>`;

/**
 * Generate thumbnail for a dDRM capsule file.
 * Fetches the NFT artwork, adds an indigo border frame, and
 * composites a 40px dDRM shield badge in the bottom-right corner.
 */
async function generateDdrmThumbnail(jsonContent: string): Promise<string | null> {
  if (!sharp || typeof sharp !== 'function') return null;

  try {
    const descriptor = JSON.parse(jsonContent);
    let thumbnailUrl: string = descriptor.thumbnail || '';
    if (!thumbnailUrl) return null;

    if (thumbnailUrl.startsWith('ipfs://')) {
      thumbnailUrl = 'https://ipfs.ela.city/ipfs/' + thumbnailUrl.slice(7);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let imgRes: Response;
    try {
      imgRes = await fetch(thumbnailUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!imgRes.ok) return null;

    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const artworkInner = await sharp(imgBuffer)
      .resize(DDRM_INNER_SIZE, DDRM_INNER_SIZE, { fit: 'cover' })
      .png()
      .toBuffer();

    const badgePng = await sharp(Buffer.from(DDRM_BADGE_SVG))
      .resize(DDRM_BADGE_SIZE, DDRM_BADGE_SIZE)
      .png()
      .toBuffer();

    const borderPng = await sharp(Buffer.from(DDRM_BORDER_SVG))
      .resize(DDRM_THUMB_SIZE, DDRM_THUMB_SIZE)
      .png()
      .toBuffer();

    const composited = await sharp({
        create: {
          width: DDRM_THUMB_SIZE,
          height: DDRM_THUMB_SIZE,
          channels: 4,
          background: { r: 92, g: 107, b: 192, alpha: 1 },
        }
      })
      .composite([
        { input: artworkInner, left: DDRM_BORDER_WIDTH, top: DDRM_BORDER_WIDTH },
        { input: borderPng, left: 0, top: 0 },
        { input: badgePng, gravity: 'southeast' },
      ])
      .png()
      .toBuffer();

    return `data:image/png;base64,${composited.toString('base64')}`;
  } catch (error: any) {
    logger.warn(`[Thumbnail] ⚠️  dDRM thumbnail generation failed: ${error.message}`);
    return null;
  }
}

/**
 * Generate thumbnail for a file
 * Returns base64 data URL (matching Puter's format) or null if generation fails
 * Format: data:image/png;base64,{base64}
 */
export async function generateThumbnail(
  fileContent: Buffer | Uint8Array,
  mimeType: string,
  fileUuid: string
): Promise<string | null> {
  if (!sharp || !supportsThumbnails(mimeType)) {
    return null;
  }
  
  // Check if sharp is actually a function (it should be)
  if (typeof sharp !== 'function') {
    logger.warn('[Thumbnail] ⚠️  Sharp is not a function, skipping thumbnail generation');
    return null;
  }

  // dDRM capsule files: fetch NFT artwork and composite badge
  if (mimeType === 'application/x-ddrm' || mimeType === 'application/x-edrm' || mimeType === 'application/x-ddrm+json') {
    const jsonStr = Buffer.isBuffer(fileContent) ? fileContent.toString('utf8')
      : fileContent instanceof Uint8Array ? Buffer.from(fileContent).toString('utf8')
      : null;
    if (!jsonStr) return null;
    return generateDdrmThumbnail(jsonStr);
  }
  
  try {
    // Convert content to buffer
    let buffer: Buffer;
    if (Buffer.isBuffer(fileContent)) {
      buffer = fileContent;
    } else if (fileContent instanceof Uint8Array) {
      buffer = Buffer.from(fileContent);
    } else {
      return null;
    }
    
    // Skip if buffer is empty
    if (!buffer || buffer.length === 0) {
      return null;
    }
    
    if (mimeType.startsWith('image/')) {
      // Generate thumbnail for image
      const thumbnailBuffer = await sharp(buffer)
        .resize(128) // Match Puter's size (128px)
        .png() // Match Puter's format (PNG)
        .toBuffer();
      
      const base64 = thumbnailBuffer.toString('base64');
      return `data:image/png;base64,${base64}`;
      
    } else if (mimeType.startsWith('video/')) {
      // For videos, use ffmpeg to extract a frame (fully async, no event-loop blocking)
      try {
        const tempVideoPath = join(tmpdir(), `pc2-video-${fileUuid}.tmp`);
        const tempFramePath = join(tmpdir(), `pc2-video-frame-${fileUuid}.jpg`);
        
        await writeFileAsync(tempVideoPath, buffer);
        
        await execFileAsync('ffmpeg', [
          '-i', tempVideoPath,
          '-ss', '3',
          '-vframes', '1',
          '-vf', 'scale=128:128:force_original_aspect_ratio=decrease',
          '-q:v', '2',
          tempFramePath,
        ], { timeout: 30000 });
        
        if (existsSync(tempFramePath)) {
          const { readFile } = await import('fs/promises');
          const frameBuffer = await readFile(tempFramePath);
          const thumbnailBuffer = await sharp(frameBuffer)
            .resize(128)
            .png()
            .toBuffer();
          
          await Promise.allSettled([
            unlinkAsync(tempVideoPath),
            unlinkAsync(tempFramePath),
          ]);
          
          const base64 = thumbnailBuffer.toString('base64');
          return `data:image/png;base64,${base64}`;
        }
        
        await unlinkAsync(tempVideoPath).catch(() => {});
        return null;
      } catch (error: any) {
        logger.warn(`[Thumbnail] ⚠️  Video thumbnail generation failed (ffmpeg may not be installed): ${error.message}`);
        return null;
      }
      
    } else if (mimeType === 'application/pdf') {
      // For PDFs, generate thumbnail from first page
      if (!pdfjs || !canvas || !sharp) {
        return null;
      }
      
      try {
        const getDocument = pdfjs.getDocument;
        if (!getDocument) {
          return null;
        }
        
        const createCanvas = canvas.createCanvas;
        if (!createCanvas) {
          return null;
        }
        
        // Convert Buffer to Uint8Array
        const uint8Array = buffer instanceof Uint8Array 
          ? buffer 
          : new Uint8Array(buffer);
        
        // Load PDF document
        const loadingTask = getDocument({ data: uint8Array });
        const pdfDocument = await loadingTask.promise;
        
        // Get first page
        const page = await pdfDocument.getPage(1);
        
        // Calculate scale to fit 128px width
        const viewport = page.getViewport({ scale: 1.0 });
        const scale = 128 / viewport.width;
        const scaledViewport = page.getViewport({ scale });
        
        // Create canvas and render page
        const canvasInstance = createCanvas(scaledViewport.width, scaledViewport.height);
        const context = canvasInstance.getContext('2d');
        
        const renderContext = {
          canvasContext: context,
          viewport: scaledViewport
        };
        
        await page.render(renderContext).promise;
        
        // Convert canvas to PNG buffer
        const pdfImageBuffer = canvasInstance.toBuffer('image/png');
        
        // Use sharp to ensure consistent format and size
        const thumbnailBuffer = await sharp(pdfImageBuffer)
          .resize(128, 128, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .png()
          .toBuffer();
        
        const base64 = thumbnailBuffer.toString('base64');
        return `data:image/png;base64,${base64}`;
      } catch (error: any) {
        logger.warn(`[Thumbnail] ⚠️  PDF thumbnail generation failed: ${error.message}`);
        return null;
      }
      
    } else if (mimeType === 'text/plain' || mimeType.startsWith('text/')) {
      // For text files, generate a thumbnail showing text preview
      if (!canvas || !sharp) {
        return null;
      }
      
      try {
        const createCanvas = canvas.createCanvas;
        if (!createCanvas) {
          return null;
        }
        
        const textContent = buffer.toString('utf8');
        
        // Only show first few lines as a teaser, not full readable content
        const previewText = textContent.substring(0, 800);
        const lines = previewText.split('\n').slice(0, 12);
        
        const canvasWidth = 400;
        const canvasHeight = 300;
        const canvasInstance = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvasInstance.getContext('2d');
        
        ctx.fillStyle = '#f8f9fa';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        ctx.fillStyle = '#1e293b';
        ctx.font = '13px monospace';
        ctx.textBaseline = 'top';
        
        const padding = 16;
        const lineHeight = 16;
        const maxWidth = canvasWidth - (padding * 2);
        
        let y = padding;
        for (const line of lines) {
          if (y + lineHeight > canvasHeight - padding) break;
          
          let displayLine = line;
          const metrics = ctx.measureText(displayLine);
          if (metrics.width > maxWidth) {
            while (ctx.measureText(displayLine + '...').width > maxWidth && displayLine.length > 0) {
              displayLine = displayLine.slice(0, -1);
            }
            displayLine += '...';
          }
          
          ctx.fillText(displayLine, padding, y);
          y += lineHeight;
        }
        
        // Fade-out gradient so bottom text is unreadable — teaser only
        const fadeStart = canvasHeight * 0.4;
        const gradient = ctx.createLinearGradient(0, fadeStart, 0, canvasHeight);
        gradient.addColorStop(0, 'rgba(248, 249, 250, 0)');
        gradient.addColorStop(0.6, 'rgba(248, 249, 250, 0.85)');
        gradient.addColorStop(1, 'rgba(248, 249, 250, 1)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, fadeStart, canvasWidth, canvasHeight - fadeStart);
        
        // Convert canvas to PNG buffer
        const textImageBuffer = canvasInstance.toBuffer('image/png');
        
        const thumbnailBuffer = await sharp(textImageBuffer)
          .jpeg({ quality: 80 })
          .toBuffer();
        
        const base64 = thumbnailBuffer.toString('base64');
        return `data:image/jpeg;base64,${base64}`;
      } catch (error: any) {
        logger.warn(`[Thumbnail] ⚠️  Text file thumbnail generation failed: ${error.message}`);
        return null;
      }
    }
  } catch (error: any) {
    logger.warn(`[Thumbnail] ⚠️  Thumbnail generation failed: ${error.message}`);
    return null;
  }
  
  return null;
}


