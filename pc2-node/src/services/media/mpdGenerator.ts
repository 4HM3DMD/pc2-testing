/**
 * MPD Generator — creates DASH MPD XML from track metadata and segment info.
 *
 * Generates output compatible with our mpdParser.ts (SegmentTemplate + SegmentTimeline).
 * Matches the Bento4 mp4dash output format so existing playback code works unchanged.
 */

import { type TrackInfo, type SegmentInfo } from './mp4split.js';

export interface MPDSegment {
  duration: number;
}

export interface MPDTrack {
  info: TrackInfo;
  segments: MPDSegment[];
  initFilename: string;
  mediaPattern: string;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  let result = 'PT';
  if (hours > 0) result += `${hours}H`;
  if (mins > 0) result += `${mins}M`;
  result += `${secs.toFixed(3)}S`;
  return result;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSegmentTimeline(segments: MPDSegment[], timescale: number): string {
  if (segments.length === 0) return '';

  const lines: string[] = [];
  lines.push('            <SegmentTimeline>');

  let i = 0;
  while (i < segments.length) {
    const d = Math.round(segments[i].duration);
    let r = 0;
    while (i + r + 1 < segments.length && Math.round(segments[i + r + 1].duration) === d) {
      r++;
    }

    if (i === 0) {
      if (r > 0) {
        lines.push(`              <S t="0" d="${d}" r="${r}"/>`);
      } else {
        lines.push(`              <S t="0" d="${d}"/>`);
      }
    } else {
      if (r > 0) {
        lines.push(`              <S d="${d}" r="${r}"/>`);
      } else {
        lines.push(`              <S d="${d}"/>`);
      }
    }

    i += r + 1;
  }

  lines.push('            </SegmentTimeline>');
  return lines.join('\n');
}

export function generateMPD(tracks: MPDTrack[], totalDuration: number): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="urn:mpeg:dash:schema:mpd:2011" xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd" type="static" mediaPresentationDuration="${formatDuration(totalDuration)}" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">`);
  lines.push('  <Period>');

  for (const track of tracks) {
    const { info } = track;
    const mimeType = info.type === 'video' ? 'video/mp4' : 'audio/mp4';
    const contentType = info.type;

    let asAttrs = `mimeType="${escapeXml(mimeType)}" contentType="${contentType}"`;
    if (info.type === 'video' && info.width && info.height) {
      asAttrs += ` maxWidth="${info.width}" maxHeight="${info.height}"`;
    }
    if (info.audioSampleRate) {
      asAttrs += ` audioSamplingRate="${info.audioSampleRate}"`;
    }

    lines.push(`    <AdaptationSet ${asAttrs}>`);

    const repId = `${info.type === 'video' ? 'v' : 'a'}${info.trackId}`;
    let repAttrs = `id="${repId}" codecs="${escapeXml(info.codec)}" bandwidth="${info.bandwidth}"`;
    if (info.type === 'video' && info.width && info.height) {
      repAttrs += ` width="${info.width}" height="${info.height}"`;
    }
    if (info.audioChannels) {
      repAttrs += ` audioSamplingRate="${info.audioSampleRate}"`;
    }

    lines.push(`      <Representation ${repAttrs}>`);

    const segTimeline = buildSegmentTimeline(track.segments, info.timescale);
    lines.push(`        <SegmentTemplate timescale="${info.timescale}" initialization="${escapeXml(track.initFilename)}" media="${escapeXml(track.mediaPattern)}" startNumber="1">`);
    lines.push(segTimeline);
    lines.push('        </SegmentTemplate>');

    lines.push('      </Representation>');
    lines.push('    </AdaptationSet>');
  }

  lines.push('  </Period>');
  lines.push('</MPD>');

  return lines.join('\n');
}

export function buildMPDTracks(
  trackInfos: TrackInfo[],
  segmentInfos: SegmentInfo[],
): MPDTrack[] {
  return trackInfos.map(info => {
    const trackSegs = segmentInfos.filter(s => s.trackId === info.trackId);
    const dirName = `${info.type === 'video' ? 'video' : 'audio'}/${info.trackId}`;

    return {
      info,
      segments: trackSegs.map(s => ({ duration: s.duration })),
      initFilename: `${dirName}/init.mp4`,
      mediaPattern: `${dirName}/seg-$Number$.m4s`,
    };
  });
}
