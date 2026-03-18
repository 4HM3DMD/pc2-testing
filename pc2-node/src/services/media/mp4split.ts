/**
 * fMP4 Splitter — splits a fragmented MP4 into init segment + media segments per track.
 *
 * Replaces mp4dash's Mp4Split functionality. Parses top-level ISO BMFF boxes
 * and extracts track metadata needed for MPD generation.
 *
 * Input:  Single fragmented .mp4 file (output of mp4fragment)
 * Output: Per-track init segment, media segments, and metadata
 */

import { readFile } from 'fs/promises';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('mp4split');

export interface TrackInfo {
  trackId: number;
  type: 'video' | 'audio';
  codec: string;
  timescale: number;
  width?: number;
  height?: number;
  bandwidth: number;
  audioSampleRate?: number;
  audioChannels?: number;
}

export interface SegmentInfo {
  trackId: number;
  data: Buffer;
  duration: number;
  sampleCount: number;
}

export interface SplitResult {
  tracks: TrackInfo[];
  initSegment: Buffer;
  segments: SegmentInfo[];
  totalDuration: number;
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function readU16(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset);
}

function readBoxHeader(buf: Buffer, offset: number): { type: string; size: number; headerSize: number } | null {
  if (offset + 8 > buf.length) return null;
  let size = readU32(buf, offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    const hi = readU32(buf, offset + 8);
    const lo = readU32(buf, offset + 12);
    size = hi * 0x100000000 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }

  return { type, size, headerSize };
}

function findBox(buf: Buffer, start: number, end: number, type: string): { offset: number; size: number; headerSize: number } | null {
  let pos = start;
  while (pos < end) {
    const box = readBoxHeader(buf, pos);
    if (!box || box.size < 8) return null;
    if (box.type === type) return { offset: pos, size: box.size, headerSize: box.headerSize };
    pos += box.size;
  }
  return null;
}

function parseCodecString(buf: Buffer, stsdOffset: number, stsdSize: number): string {
  const contentStart = stsdOffset + 16;
  if (contentStart >= stsdOffset + stsdSize) return 'unknown';

  const entryBox = readBoxHeader(buf, contentStart);
  if (!entryBox) return 'unknown';

  const fourcc = entryBox.type;

  if (fourcc === 'avc1' || fourcc === 'avc3') {
    const avcC = findBox(buf, contentStart + entryBox.headerSize, contentStart + entryBox.size, 'avcC');
    if (avcC && avcC.offset + avcC.headerSize + 3 < buf.length) {
      const p = avcC.offset + avcC.headerSize;
      const profile = buf[p + 1];
      const compat = buf[p + 2];
      const level = buf[p + 3];
      return `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
    }
    return fourcc;
  }

  if (fourcc === 'hev1' || fourcc === 'hvc1') return fourcc;
  if (fourcc === 'av01') {
    const av1C = findBox(buf, contentStart + entryBox.headerSize, contentStart + entryBox.size, 'av1C');
    if (av1C && av1C.offset + av1C.headerSize + 4 < buf.length) {
      const p = av1C.offset + av1C.headerSize;
      const profile = (buf[p + 1] >> 5) & 0x7;
      const level = buf[p + 1] & 0x1f;
      const tier = (buf[p + 2] >> 7) & 0x1;
      const bitDepth = ((buf[p + 2] >> 1) & 0x7) + 8;
      return `av01.${profile}.${level.toString().padStart(2, '0')}${tier ? 'H' : 'M'}.${bitDepth.toString().padStart(2, '0')}`;
    }
    return 'av01.0.01M.08';
  }

  if (fourcc === 'mp4a') {
    const esds = findBox(buf, contentStart + entryBox.headerSize, contentStart + entryBox.size, 'esds');
    if (esds) return 'mp4a.40.2';
    return 'mp4a.40.2';
  }

  if (fourcc === 'Opus') return 'opus';
  if (fourcc === 'fLaC') return 'flac';

  return fourcc;
}

function extractTrackInfo(buf: Buffer, moovOffset: number, moovSize: number): TrackInfo[] {
  const tracks: TrackInfo[] = [];
  const moovEnd = moovOffset + moovSize;
  let pos = moovOffset + 8;

  while (pos < moovEnd) {
    const box = readBoxHeader(buf, pos);
    if (!box || box.size < 8) break;

    if (box.type === 'trak') {
      const trakEnd = pos + box.size;
      const track = parseTrak(buf, pos + box.headerSize, trakEnd);
      if (track) tracks.push(track);
    }

    pos += box.size;
  }

  return tracks;
}

function parseTrak(buf: Buffer, start: number, end: number): TrackInfo | null {
  const tkhd = findBox(buf, start, end, 'tkhd');
  if (!tkhd) return null;

  const tkhdContent = tkhd.offset + tkhd.headerSize;
  const version = buf[tkhdContent];
  let trackId: number;
  let width: number;
  let height: number;

  if (version === 1) {
    trackId = readU32(buf, tkhdContent + 20);
    width = readU32(buf, tkhdContent + 84) >> 16;
    height = readU32(buf, tkhdContent + 88) >> 16;
  } else {
    trackId = readU32(buf, tkhdContent + 12);
    width = readU32(buf, tkhdContent + 76) >> 16;
    height = readU32(buf, tkhdContent + 80) >> 16;
  }

  const mdia = findBox(buf, start, end, 'mdia');
  if (!mdia) return null;
  const mdiaEnd = mdia.offset + mdia.size;

  const mdhd = findBox(buf, mdia.offset + mdia.headerSize, mdiaEnd, 'mdhd');
  let timescale = 90000;
  if (mdhd) {
    const mdhdContent = mdhd.offset + mdhd.headerSize;
    const mdhdVersion = buf[mdhdContent];
    timescale = mdhdVersion === 1
      ? readU32(buf, mdhdContent + 20)
      : readU32(buf, mdhdContent + 12);
  }

  const hdlr = findBox(buf, mdia.offset + mdia.headerSize, mdiaEnd, 'hdlr');
  let handlerType = 'vide';
  if (hdlr) {
    handlerType = buf.toString('ascii', hdlr.offset + hdlr.headerSize + 8, hdlr.offset + hdlr.headerSize + 12);
  }

  const isVideo = handlerType === 'vide';
  const isAudio = handlerType === 'soun';
  if (!isVideo && !isAudio) return null;

  const minf = findBox(buf, mdia.offset + mdia.headerSize, mdiaEnd, 'minf');
  if (!minf) return null;
  const stbl = findBox(buf, minf.offset + minf.headerSize, minf.offset + minf.size, 'stbl');
  if (!stbl) return null;
  const stsd = findBox(buf, stbl.offset + stbl.headerSize, stbl.offset + stbl.size, 'stsd');

  let codec = 'unknown';
  let audioSampleRate: number | undefined;
  let audioChannels: number | undefined;

  if (stsd) {
    codec = parseCodecString(buf, stsd.offset, stsd.size);

    if (isAudio) {
      const entryStart = stsd.offset + 16;
      const entryBox = readBoxHeader(buf, entryStart);
      if (entryBox && entryStart + entryBox.headerSize + 28 <= buf.length) {
        audioChannels = readU16(buf, entryStart + entryBox.headerSize + 16);
        audioSampleRate = readU32(buf, entryStart + entryBox.headerSize + 24) >> 16;
      }
    }
  }

  const info: TrackInfo = {
    trackId,
    type: isVideo ? 'video' : 'audio',
    codec,
    timescale,
    bandwidth: 0,
    ...(isVideo && width > 0 ? { width, height } : {}),
    ...(audioSampleRate ? { audioSampleRate, audioChannels } : {}),
  };

  return info;
}

function parseMoofTrackId(buf: Buffer, moofContentStart: number, moofEnd: number): number {
  const traf = findBox(buf, moofContentStart, moofEnd, 'traf');
  if (!traf) return 0;
  const tfhd = findBox(buf, traf.offset + traf.headerSize, traf.offset + traf.size, 'tfhd');
  if (!tfhd) return 0;
  return readU32(buf, tfhd.offset + tfhd.headerSize + 4);
}

function parseMoofDuration(buf: Buffer, moofContentStart: number, moofEnd: number): { duration: number; sampleCount: number } {
  const traf = findBox(buf, moofContentStart, moofEnd, 'traf');
  if (!traf) return { duration: 0, sampleCount: 0 };

  const tfhd = findBox(buf, traf.offset + traf.headerSize, traf.offset + traf.size, 'tfhd');
  let defaultDuration = 0;
  if (tfhd) {
    const flags = readU32(buf, tfhd.offset + tfhd.headerSize) & 0xFFFFFF;
    let tfhdOffset = tfhd.offset + tfhd.headerSize + 8;
    if (flags & 0x1) tfhdOffset += 8;
    if (flags & 0x2) tfhdOffset += 4;
    if (flags & 0x8) {
      defaultDuration = readU32(buf, tfhdOffset);
    }
  }

  const trun = findBox(buf, traf.offset + traf.headerSize, traf.offset + traf.size, 'trun');
  if (!trun) return { duration: 0, sampleCount: 0 };

  const trunContent = trun.offset + trun.headerSize;
  const flags = readU32(buf, trunContent) & 0xFFFFFF;
  const sampleCount = readU32(buf, trunContent + 4);

  let totalDuration = 0;
  const hasDuration = (flags & 0x100) !== 0;
  const hasSize = (flags & 0x200) !== 0;
  const hasFlags = (flags & 0x400) !== 0;
  const hasCTO = (flags & 0x800) !== 0;

  let offset = trunContent + 8;
  if (flags & 0x1) offset += 4;
  if (flags & 0x4) offset += 4;

  const entrySize = (hasDuration ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCTO ? 4 : 0);

  for (let i = 0; i < sampleCount; i++) {
    if (hasDuration && offset + 4 <= buf.length) {
      totalDuration += readU32(buf, offset);
    } else {
      totalDuration += defaultDuration;
    }
    offset += entrySize;
  }

  return { duration: totalDuration, sampleCount };
}

export async function splitFragmentedMP4(filePath: string): Promise<SplitResult> {
  const buf = await readFile(filePath);
  logger.info(`[mp4split] Parsing fragmented MP4: ${filePath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

  let initEnd = 0;
  let pos = 0;
  const segments: SegmentInfo[] = [];
  let tracks: TrackInfo[] = [];

  while (pos < buf.length) {
    const box = readBoxHeader(buf, pos);
    if (!box || box.size < 8) break;

    if (box.type === 'ftyp' || box.type === 'moov' || box.type === 'free' || box.type === 'skip') {
      if (box.type === 'moov') {
        tracks = extractTrackInfo(buf, pos, box.size);
      }
      initEnd = pos + box.size;
      pos += box.size;
      continue;
    }

    if (box.type === 'moof') {
      const moofEnd = pos + box.size;
      const nextBox = readBoxHeader(buf, moofEnd);
      const segEnd = nextBox?.type === 'mdat' ? moofEnd + nextBox.size : moofEnd;

      const trackId = parseMoofTrackId(buf, pos + box.headerSize, moofEnd);
      const { duration, sampleCount } = parseMoofDuration(buf, pos + box.headerSize, moofEnd);

      segments.push({
        trackId,
        data: Buffer.from(buf.buffer, buf.byteOffset + pos, segEnd - pos),
        duration,
        sampleCount,
      });

      pos = segEnd;
      continue;
    }

    pos += box.size;
  }

  const initSegment = Buffer.from(buf.buffer, buf.byteOffset, initEnd);

  const trackByteCounts = new Map<number, number>();
  const trackDurations = new Map<number, number>();
  for (const seg of segments) {
    trackByteCounts.set(seg.trackId, (trackByteCounts.get(seg.trackId) || 0) + seg.data.length);
    trackDurations.set(seg.trackId, (trackDurations.get(seg.trackId) || 0) + seg.duration);
  }

  for (const track of tracks) {
    const totalBytes = trackByteCounts.get(track.trackId) || 0;
    const totalDur = trackDurations.get(track.trackId) || 0;
    if (totalDur > 0) {
      track.bandwidth = Math.round((totalBytes * 8 * track.timescale) / totalDur);
    }
  }

  let totalDuration = 0;
  const videoTrack = tracks.find(t => t.type === 'video');
  const primaryTrack = videoTrack || tracks[0];
  if (primaryTrack) {
    const dur = trackDurations.get(primaryTrack.trackId) || 0;
    totalDuration = dur / primaryTrack.timescale;
  }

  logger.info(`[mp4split] Found ${tracks.length} tracks, ${segments.length} segments, duration=${totalDuration.toFixed(2)}s`);
  for (const t of tracks) {
    logger.info(`[mp4split]   Track ${t.trackId}: ${t.type} codec=${t.codec} ${t.width ? `${t.width}x${t.height}` : ''} bw=${t.bandwidth}`);
  }

  return { tracks, initSegment, segments, totalDuration };
}
