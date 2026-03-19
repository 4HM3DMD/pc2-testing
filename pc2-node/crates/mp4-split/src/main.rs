//! WASI CLI entry point for mp4-split.
//!
//! Parses a fragmented MP4 (ISO BMFF) file, extracts track metadata,
//! init segment, and per-track media segments — all inside WASM linear
//! memory so V8 never holds the raw MP4 bytes.
//!
//! ## MemFS interface
//!
//! Input:  /input/fragmented.mp4
//! Output: /output/result.json   { tracks, totalDuration, initSize, segmentCount }
//!         /output/init.bin      init segment (ftyp + moov + free/skip)
//!         /output/seg-{trackId}-{index}.bin   each moof+mdat pair

use serde::Serialize;
use std::fs;
use std::process;

#[derive(Serialize)]
struct TrackInfo {
    #[serde(rename = "trackId")]
    track_id: u32,
    #[serde(rename = "type")]
    track_type: String,
    codec: String,
    timescale: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    bandwidth: u64,
    #[serde(rename = "audioSampleRate", skip_serializing_if = "Option::is_none")]
    audio_sample_rate: Option<u32>,
    #[serde(rename = "audioChannels", skip_serializing_if = "Option::is_none")]
    audio_channels: Option<u32>,
}

#[derive(Serialize)]
struct SegmentMeta {
    #[serde(rename = "trackId")]
    track_id: u32,
    index: usize,
    size: usize,
    duration: u64,
    #[serde(rename = "sampleCount")]
    sample_count: u32,
}

#[derive(Serialize)]
struct ResultOutput {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tracks: Option<Vec<TrackInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<SegmentMeta>>,
    #[serde(rename = "totalDuration", skip_serializing_if = "Option::is_none")]
    total_duration: Option<f64>,
    #[serde(rename = "initSize", skip_serializing_if = "Option::is_none")]
    init_size: Option<usize>,
}

fn read_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn read_u16(buf: &[u8], off: usize) -> u16 {
    u16::from_be_bytes([buf[off], buf[off + 1]])
}

struct BoxHeader {
    box_type: [u8; 4],
    size: usize,
    header_size: usize,
}

fn box_type_str(t: &[u8; 4]) -> &str {
    std::str::from_utf8(t).unwrap_or("????")
}

fn read_box_header(buf: &[u8], offset: usize) -> Option<BoxHeader> {
    if offset + 8 > buf.len() {
        return None;
    }
    let mut size = read_u32(buf, offset) as usize;
    let mut box_type = [0u8; 4];
    box_type.copy_from_slice(&buf[offset + 4..offset + 8]);
    let mut header_size = 8;

    if size == 1 {
        if offset + 16 > buf.len() {
            return None;
        }
        let hi = read_u32(buf, offset + 8) as u64;
        let lo = read_u32(buf, offset + 12) as u64;
        size = (hi * 0x1_0000_0000 + lo) as usize;
        header_size = 16;
    } else if size == 0 {
        size = buf.len() - offset;
    }

    Some(BoxHeader { box_type, size, header_size })
}

fn find_box(buf: &[u8], start: usize, end: usize, target: &[u8; 4]) -> Option<(usize, usize, usize)> {
    let mut pos = start;
    while pos < end {
        let bh = read_box_header(buf, pos)?;
        if bh.size < 8 {
            return None;
        }
        if &bh.box_type == target {
            return Some((pos, bh.size, bh.header_size));
        }
        pos += bh.size;
    }
    None
}

fn parse_codec_string(buf: &[u8], stsd_offset: usize, stsd_size: usize) -> String {
    let content_start = stsd_offset + 16;
    if content_start >= stsd_offset + stsd_size {
        return "unknown".into();
    }

    let entry = match read_box_header(buf, content_start) {
        Some(b) => b,
        None => return "unknown".into(),
    };

    let fourcc = box_type_str(&entry.box_type);
    let entry_end = content_start + entry.size;

    match fourcc {
        "avc1" | "avc3" => {
            if let Some((off, _, hs)) = find_box(buf, content_start + entry.header_size, entry_end, b"avcC") {
                let p = off + hs;
                if p + 4 <= buf.len() {
                    let profile = buf[p + 1];
                    let compat = buf[p + 2];
                    let level = buf[p + 3];
                    return format!("avc1.{:02x}{:02x}{:02x}", profile, compat, level);
                }
            }
            fourcc.into()
        }
        "hev1" | "hvc1" => fourcc.into(),
        "av01" => {
            if let Some((off, _, hs)) = find_box(buf, content_start + entry.header_size, entry_end, b"av1C") {
                let p = off + hs;
                if p + 4 <= buf.len() {
                    let profile = (buf[p + 1] >> 5) & 0x7;
                    let level = buf[p + 1] & 0x1f;
                    let tier = (buf[p + 2] >> 7) & 0x1;
                    let bit_depth = ((buf[p + 2] >> 1) & 0x7) + 8;
                    let tier_ch = if tier == 1 { 'H' } else { 'M' };
                    return format!("av01.{}.{:02}{}.{:02}", profile, level, tier_ch, bit_depth);
                }
            }
            "av01.0.01M.08".into()
        }
        "mp4a" => "mp4a.40.2".into(),
        "Opus" => "opus".into(),
        "fLaC" => "flac".into(),
        _ => fourcc.into(),
    }
}

fn parse_trak(buf: &[u8], start: usize, end: usize) -> Option<TrackInfo> {
    let (tkhd_off, _, tkhd_hs) = find_box(buf, start, end, b"tkhd")?;
    let tc = tkhd_off + tkhd_hs;
    let version = buf[tc];

    let (track_id, width, height) = if version == 1 {
        (read_u32(buf, tc + 20), read_u32(buf, tc + 84) >> 16, read_u32(buf, tc + 88) >> 16)
    } else {
        (read_u32(buf, tc + 12), read_u32(buf, tc + 76) >> 16, read_u32(buf, tc + 80) >> 16)
    };

    let (mdia_off, mdia_size, mdia_hs) = find_box(buf, start, end, b"mdia")?;
    let mdia_end = mdia_off + mdia_size;

    let mut timescale = 90000u32;
    if let Some((mdhd_off, _, mdhd_hs)) = find_box(buf, mdia_off + mdia_hs, mdia_end, b"mdhd") {
        let mc = mdhd_off + mdhd_hs;
        let mdhd_ver = buf[mc];
        timescale = if mdhd_ver == 1 {
            read_u32(buf, mc + 20)
        } else {
            read_u32(buf, mc + 12)
        };
    }

    let mut handler_type = *b"vide";
    if let Some((hdlr_off, _, hdlr_hs)) = find_box(buf, mdia_off + mdia_hs, mdia_end, b"hdlr") {
        let h = hdlr_off + hdlr_hs + 8;
        if h + 4 <= buf.len() {
            handler_type.copy_from_slice(&buf[h..h + 4]);
        }
    }

    let is_video = &handler_type == b"vide";
    let is_audio = &handler_type == b"soun";
    if !is_video && !is_audio {
        return None;
    }

    let (minf_off, minf_size, minf_hs) = find_box(buf, mdia_off + mdia_hs, mdia_end, b"minf")?;
    let (stbl_off, stbl_size, stbl_hs) = find_box(buf, minf_off + minf_hs, minf_off + minf_size, b"stbl")?;
    let stsd = find_box(buf, stbl_off + stbl_hs, stbl_off + stbl_size, b"stsd");

    let mut codec = "unknown".to_string();
    let mut audio_sample_rate: Option<u32> = None;
    let mut audio_channels: Option<u32> = None;

    if let Some((stsd_off, stsd_size, _)) = stsd {
        codec = parse_codec_string(buf, stsd_off, stsd_size);

        if is_audio {
            let entry_start = stsd_off + 16;
            if let Some(entry_box) = read_box_header(buf, entry_start) {
                let p = entry_start + entry_box.header_size;
                if p + 28 <= buf.len() {
                    audio_channels = Some(read_u16(buf, p + 16) as u32);
                    audio_sample_rate = Some(read_u32(buf, p + 24) >> 16);
                }
            }
        }
    }

    Some(TrackInfo {
        track_id,
        track_type: if is_video { "video" } else { "audio" }.into(),
        codec,
        timescale,
        width: if is_video && width > 0 { Some(width) } else { None },
        height: if is_video && height > 0 { Some(height) } else { None },
        bandwidth: 0,
        audio_sample_rate,
        audio_channels,
    })
}

fn extract_tracks(buf: &[u8], moov_off: usize, moov_size: usize) -> Vec<TrackInfo> {
    let moov_end = moov_off + moov_size;
    let mut tracks = Vec::new();
    let mut pos = moov_off + 8;

    while pos < moov_end {
        let bh = match read_box_header(buf, pos) {
            Some(b) if b.size >= 8 => b,
            _ => break,
        };
        if &bh.box_type == b"trak" {
            if let Some(t) = parse_trak(buf, pos + bh.header_size, pos + bh.size) {
                tracks.push(t);
            }
        }
        pos += bh.size;
    }

    tracks
}

fn parse_moof_track_id(buf: &[u8], moof_content: usize, moof_end: usize) -> u32 {
    if let Some((traf_off, traf_size, traf_hs)) = find_box(buf, moof_content, moof_end, b"traf") {
        if let Some((tfhd_off, _, tfhd_hs)) = find_box(buf, traf_off + traf_hs, traf_off + traf_size, b"tfhd") {
            return read_u32(buf, tfhd_off + tfhd_hs + 4);
        }
    }
    0
}

fn parse_moof_duration(buf: &[u8], moof_content: usize, moof_end: usize) -> (u64, u32) {
    let (traf_off, traf_size, traf_hs) = match find_box(buf, moof_content, moof_end, b"traf") {
        Some(t) => t,
        None => return (0, 0),
    };
    let traf_end = traf_off + traf_size;

    let mut default_duration = 0u32;
    if let Some((tfhd_off, _, tfhd_hs)) = find_box(buf, traf_off + traf_hs, traf_end, b"tfhd") {
        let flags = read_u32(buf, tfhd_off + tfhd_hs) & 0xFF_FFFF;
        let mut off = tfhd_off + tfhd_hs + 8;
        if flags & 0x1 != 0 { off += 8; }
        if flags & 0x2 != 0 { off += 4; }
        if flags & 0x8 != 0 && off + 4 <= buf.len() {
            default_duration = read_u32(buf, off);
        }
    }

    let (trun_off, _, trun_hs) = match find_box(buf, traf_off + traf_hs, traf_end, b"trun") {
        Some(t) => t,
        None => return (0, 0),
    };

    let tc = trun_off + trun_hs;
    let flags = read_u32(buf, tc) & 0xFF_FFFF;
    let sample_count = read_u32(buf, tc + 4);

    let has_duration = flags & 0x100 != 0;
    let has_size = flags & 0x200 != 0;
    let has_flags = flags & 0x400 != 0;
    let has_cto = flags & 0x800 != 0;

    let mut off = tc + 8;
    if flags & 0x1 != 0 { off += 4; }
    if flags & 0x4 != 0 { off += 4; }

    let entry_size = (if has_duration { 4 } else { 0 })
        + (if has_size { 4 } else { 0 })
        + (if has_flags { 4 } else { 0 })
        + (if has_cto { 4 } else { 0 });

    let mut total_duration = 0u64;
    for _ in 0..sample_count {
        if has_duration && off + 4 <= buf.len() {
            total_duration += read_u32(buf, off) as u64;
        } else {
            total_duration += default_duration as u64;
        }
        off += entry_size;
    }

    (total_duration, sample_count)
}

fn run() -> Result<(), String> {
    let buf = fs::read("/input/fragmented.mp4")
        .map_err(|e| format!("failed to read /input/fragmented.mp4: {e}"))?;

    let mut init_end = 0usize;
    let mut pos = 0usize;
    let mut tracks: Vec<TrackInfo> = Vec::new();

    struct SegRaw {
        track_id: u32,
        start: usize,
        end: usize,
        duration: u64,
        sample_count: u32,
    }
    let mut raw_segments: Vec<SegRaw> = Vec::new();

    while pos < buf.len() {
        let bh = match read_box_header(&buf, pos) {
            Some(b) if b.size >= 8 => b,
            _ => break,
        };

        let btype = box_type_str(&bh.box_type);
        match btype {
            "ftyp" | "moov" | "free" | "skip" => {
                if btype == "moov" {
                    tracks = extract_tracks(&buf, pos, bh.size);
                }
                init_end = pos + bh.size;
                pos += bh.size;
            }
            "moof" => {
                let moof_end = pos + bh.size;
                let next = read_box_header(&buf, moof_end);
                let seg_end = match next {
                    Some(ref nb) if box_type_str(&nb.box_type) == "mdat" => moof_end + nb.size,
                    _ => moof_end,
                };

                let track_id = parse_moof_track_id(&buf, pos + bh.header_size, moof_end);
                let (duration, sample_count) = parse_moof_duration(&buf, pos + bh.header_size, moof_end);

                raw_segments.push(SegRaw { track_id, start: pos, end: seg_end, duration, sample_count });
                pos = seg_end;
            }
            _ => {
                pos += bh.size;
            }
        }
    }

    fs::create_dir_all("/output").ok();

    fs::write("/output/init.bin", &buf[..init_end])
        .map_err(|e| format!("failed to write init.bin: {e}"))?;

    use std::collections::HashMap;
    let mut track_bytes: HashMap<u32, usize> = HashMap::new();
    let mut track_durations: HashMap<u32, u64> = HashMap::new();
    let mut track_seg_index: HashMap<u32, usize> = HashMap::new();
    let mut seg_metas: Vec<SegmentMeta> = Vec::new();

    for seg in &raw_segments {
        *track_bytes.entry(seg.track_id).or_insert(0) += seg.end - seg.start;
        *track_durations.entry(seg.track_id).or_insert(0) += seg.duration;
        let idx = track_seg_index.entry(seg.track_id).or_insert(0);

        let filename = format!("/output/seg-{}-{}.bin", seg.track_id, idx);
        fs::write(&filename, &buf[seg.start..seg.end])
            .map_err(|e| format!("failed to write {filename}: {e}"))?;

        seg_metas.push(SegmentMeta {
            track_id: seg.track_id,
            index: *idx,
            size: seg.end - seg.start,
            duration: seg.duration,
            sample_count: seg.sample_count,
        });

        *idx += 1;
    }

    for track in &mut tracks {
        let total_bytes = track_bytes.get(&track.track_id).copied().unwrap_or(0);
        let total_dur = track_durations.get(&track.track_id).copied().unwrap_or(0);
        if total_dur > 0 {
            track.bandwidth = (total_bytes as u64 * 8 * track.timescale as u64) / total_dur;
        }
    }

    let mut total_duration = 0.0f64;
    let primary = tracks.iter().find(|t| t.track_type == "video").or(tracks.first());
    if let Some(pt) = primary {
        let dur = track_durations.get(&pt.track_id).copied().unwrap_or(0);
        total_duration = dur as f64 / pt.timescale as f64;
    }

    let result = ResultOutput {
        success: true,
        error: None,
        tracks: Some(tracks),
        segments: Some(seg_metas),
        total_duration: Some(total_duration),
        init_size: Some(init_end),
    };

    let json = serde_json::to_string(&result).unwrap();
    fs::write("/output/result.json", &json)
        .map_err(|e| format!("failed to write result.json: {e}"))?;

    Ok(())
}

fn main() {
    match run() {
        Ok(()) => {}
        Err(err) => {
            fs::create_dir_all("/output").ok();
            let result = ResultOutput {
                success: false,
                error: Some(err.clone()),
                tracks: None,
                segments: None,
                total_duration: None,
                init_size: None,
            };
            let json = serde_json::to_string(&result).unwrap();
            let _ = fs::write("/output/result.json", &json);
            eprintln!("mp4-split error: {err}");
            process::exit(1);
        }
    }
}
