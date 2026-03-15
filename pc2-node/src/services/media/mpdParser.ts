/**
 * Minimal DASH MPD parser for PC2 Media Runtime.
 *
 * Extracts adaptation sets, representations, segment templates/timelines,
 * and builds a flat segment map for the media API to serve.
 * Handles SegmentTemplate with $Number$ and SegmentTimeline (Bento4 output).
 */

export interface SegmentRef {
  url: string;
  startTime: number;
  duration: number;
}

export interface Track {
  type: 'video' | 'audio';
  codec: string;
  mimeType: string;
  bandwidth: number;
  width?: number;
  height?: number;
  representationId: string;
  initUrl: string;
  segments: SegmentRef[];
}

export interface ParsedMPD {
  duration: number;
  tracks: Track[];
}

/**
 * Parse a DASH MPD XML string into a structured representation.
 * Uses regex-based extraction (no XML parser dependency needed).
 */
export function parseMPD(xml: string, baseUrl: string): ParsedMPD {
  const duration = parseDuration(attr(xml, 'MPD', 'mediaPresentationDuration') || 'PT0S');

  const tracks: Track[] = [];

  const periods = extractElements(xml, 'Period');
  // Only handle the first period for now
  const period = periods[0] || xml;

  const adaptationSets = extractElements(period, 'AdaptationSet');
  for (const as_ of adaptationSets) {
    const asMimeType = attrDirect(as_, 'mimeType') || '';
    const trackType: 'video' | 'audio' = asMimeType.startsWith('audio') ? 'audio' : 'video';

    // SegmentTemplate at AdaptationSet level
    const segTemplate = extractElements(as_, 'SegmentTemplate')[0] || '';
    const timescale = parseInt(attrDirect(segTemplate, 'timescale') || '1', 10);
    const initTemplate = attrDirect(segTemplate, 'initialization') || '';
    const mediaTemplate = attrDirect(segTemplate, 'media') || '';
    const startNumber = parseInt(attrDirect(segTemplate, 'startNumber') || '1', 10);

    // SegmentTimeline
    const timeline = extractElements(segTemplate, 'SegmentTimeline')[0] || '';
    const segments = parseSegmentTimeline(timeline, timescale, startNumber);

    const representations = extractElements(as_, 'Representation');
    for (const rep of representations) {
      const repId = attrDirect(rep, 'id') || '';
      const codec = attrDirect(rep, 'codecs') || '';
      const bandwidth = parseInt(attrDirect(rep, 'bandwidth') || '0', 10);
      const width = parseInt(attrDirect(rep, 'width') || '0', 10) || undefined;
      const height = parseInt(attrDirect(rep, 'height') || '0', 10) || undefined;

      // Resolve URL templates
      const initUrl = resolveTemplate(initTemplate, repId, 0, baseUrl);
      const trackSegments: SegmentRef[] = segments.map(s => ({
        url: resolveTemplate(mediaTemplate, repId, s.number, baseUrl),
        startTime: s.startTime,
        duration: s.duration,
      }));

      tracks.push({
        type: trackType,
        codec,
        mimeType: asMimeType,
        bandwidth,
        width,
        height,
        representationId: repId,
        initUrl,
        segments: trackSegments,
      });
    }
  }

  return { duration, tracks };
}

interface TimelineSegment {
  number: number;
  startTime: number;
  duration: number;
}

function parseSegmentTimeline(timeline: string, timescale: number, startNumber: number): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  const sElements = timeline.match(/<S\s[^/>]*\/?>/g) || [];
  let time = 0;
  let number = startNumber;

  for (const s of sElements) {
    const d = parseInt(attrDirect(s, 'd') || '0', 10);
    const r = parseInt(attrDirect(s, 'r') || '0', 10);
    const t = attrDirect(s, 't');
    if (t) time = parseInt(t, 10);

    for (let i = 0; i <= r; i++) {
      segments.push({
        number,
        startTime: time / timescale,
        duration: d / timescale,
      });
      time += d;
      number++;
    }
  }

  return segments;
}

function resolveTemplate(template: string, repId: string, number: number, baseUrl: string): string {
  const resolved = template
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Number\$/g, String(number))
    .replace(/\$Number%(\d+)d\$/g, (_, width) => String(number).padStart(parseInt(width, 10), '0'));

  if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
    return resolved;
  }
  return baseUrl + resolved;
}

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (parseFloat(m[1] || '0') * 3600) +
         (parseFloat(m[2] || '0') * 60) +
         parseFloat(m[3] || '0');
}

/** Extract the value of a named attribute from an XML tag string. */
function attrDirect(tag: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : null;
}

/** Extract attribute from the first occurrence of a specific element. */
function attr(xml: string, element: string, name: string): string | null {
  const re = new RegExp(`<${element}[^>]*${name}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Extract all element blocks (opening tag through closing tag, or self-closing). */
function extractElements(xml: string, tag: string): string[] {
  const results: string[] = [];
  const openRe = new RegExp(`<${tag}[\\s>]`, 'gi');
  let match;
  while ((match = openRe.exec(xml)) !== null) {
    const start = match.index;
    // Find end of the opening tag to check for self-closing
    const openTagEnd = xml.indexOf('>', start);
    if (openTagEnd === -1) continue;

    if (xml[openTagEnd - 1] === '/') {
      // Genuinely self-closing: <Tag ... />
      results.push(xml.substring(start, openTagEnd + 1));
    } else {
      // Has children — find matching close tag
      const closeTag = `</${tag}>`;
      const closeIdx = xml.indexOf(closeTag, openTagEnd);
      if (closeIdx !== -1) {
        results.push(xml.substring(start, closeIdx + closeTag.length));
      }
    }
  }
  return results;
}
