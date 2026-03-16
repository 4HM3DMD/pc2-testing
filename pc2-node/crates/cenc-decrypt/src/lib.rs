//! CENC Segment Decryptor for PC2 Media Runtime.
//!
//! Compiled to `wasm32-wasip1` and executed by the PC2 node's WASMRuntime.
//! Decrypts DASH/CENC (AES-128-CTR) encrypted fMP4 segments.
//! The CEK and decrypted samples never leave WASM linear memory except
//! via the explicit MemFS output file.
//!
//! ## MemFS interface (same pattern as ddrm-renderer)
//!
//! Input:  /input/command.json   (CEK, IV size, segment type)
//!         /input/segment.bin    (encrypted fMP4 segment bytes)
//!         /input/init.bin       (optional: init segment for tenc extraction)
//! Output: /output/result.json   (success, error, sample_count)
//!         /output/segment.bin   (decrypted fMP4 segment bytes)

pub mod mp4box;
pub mod cenc;
pub mod strip;

use serde::{Deserialize, Serialize};
use base64::Engine;

#[derive(Debug, Deserialize)]
pub struct DecryptCommand {
    /// Base64-encoded 16-byte AES-128-CTR Content Encryption Key.
    pub cek_b64: String,
    /// Per-sample IV size in bytes (typically 8 or 16). Default: 8.
    pub iv_size: Option<u8>,
    /// Default sample size (from tfhd) if trun doesn't include per-sample sizes.
    pub default_sample_size: Option<u32>,
    /// If true, the input is an init segment — extract tenc and pass through unchanged.
    #[serde(default)]
    pub is_init: bool,
    /// If true, strip encryption signaling/metadata boxes from the output.
    #[serde(default)]
    pub strip: bool,
    /// If "strip_init", only strip encryption signaling from init segment (no decrypt).
    pub mode: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DecryptResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iv_size: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_protected: Option<bool>,
}

/// Process a segment decryption request from the MemFS file interface.
pub fn process(command_json: &str, segment_data: &[u8], init_data: Option<&[u8]>) -> (String, Option<Vec<u8>>) {
    let cmd: DecryptCommand = match serde_json::from_str(command_json) {
        Ok(c) => c,
        Err(e) => return (error_result(&format!("invalid command: {e}")), None),
    };

    // strip_init mode: strip encryption signaling from init segment, no decrypt
    if cmd.mode.as_deref() == Some("strip_init") {
        let stripped = strip::strip_encryption_signaling(segment_data);
        let result = DecryptResult {
            success: true,
            error: None,
            sample_count: None,
            iv_size: None,
            is_protected: None,
        };
        return (serde_json::to_string(&result).unwrap(), Some(stripped));
    }

    if cmd.is_init {
        return process_init(segment_data);
    }

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut cek_bytes = match b64.decode(&cmd.cek_b64) {
        Ok(k) => k,
        Err(e) => return (error_result(&format!("cek decode: {e}")), None),
    };

    if cek_bytes.len() != 16 {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return (error_result(&format!("cek length {} (expected 16)", cek_bytes.len())), None);
    }

    let iv_size = cmd.iv_size.unwrap_or(8);
    let default_sample_size = cmd.default_sample_size.unwrap_or(0);

    // Determine IV size from init segment's tenc if available
    let effective_iv_size = if let Some(init) = init_data {
        if let Some(tenc) = mp4box::parse_init_for_tenc(init) {
            if tenc.default_per_sample_iv_size > 0 {
                tenc.default_per_sample_iv_size
            } else {
                iv_size
            }
        } else {
            iv_size
        }
    } else {
        iv_size
    };

    let parsed = match mp4box::parse_segment(segment_data, effective_iv_size) {
        Ok(p) => p,
        Err(e) => {
            cek_bytes.iter_mut().for_each(|b| *b = 0);
            return (error_result(&format!("parse segment: {e}")), None);
        }
    };

    let traf = match &parsed.traf {
        Some(t) => t,
        None => {
            // No moof/traf — might be an unencrypted segment, pass through
            cek_bytes.iter_mut().for_each(|b| *b = 0);
            let result = DecryptResult {
                success: true,
                error: None,
                sample_count: Some(0),
                iv_size: Some(effective_iv_size),
                is_protected: Some(false),
            };
            return (serde_json::to_string(&result).unwrap(), Some(segment_data.to_vec()));
        }
    };

    let senc = match &traf.senc {
        Some(s) => s,
        None => {
            // No senc box — segment is not encrypted, pass through
            cek_bytes.iter_mut().for_each(|b| *b = 0);
            let result = DecryptResult {
                success: true,
                error: None,
                sample_count: Some(0),
                iv_size: Some(effective_iv_size),
                is_protected: Some(false),
            };
            return (serde_json::to_string(&result).unwrap(), Some(segment_data.to_vec()));
        }
    };

    let trun_entries = traf.trun.as_ref().map(|t| &t.entries[..]).unwrap_or(&[]);

    let cek_arr: [u8; 16] = cek_bytes[..16].try_into().unwrap();

    let mdat = &segment_data[parsed.mdat_offset..parsed.mdat_offset + parsed.mdat_size];

    let decrypted_mdat = match cenc::decrypt_samples(
        mdat,
        &cek_arr,
        trun_entries,
        &senc.samples,
        default_sample_size,
    ) {
        Ok(d) => d,
        Err(e) => {
            cek_bytes.iter_mut().for_each(|b| *b = 0);
            return (error_result(&format!("decrypt: {e}")), None);
        }
    };

    // Zero CEK
    cek_bytes.iter_mut().for_each(|b| *b = 0);

    // Reconstruct the segment: everything before mdat content stays the same,
    // mdat content is replaced with decrypted bytes
    let mut output = Vec::with_capacity(segment_data.len());
    output.extend_from_slice(&segment_data[..parsed.mdat_offset]);
    output.extend_from_slice(&decrypted_mdat);
    // Include any data after mdat (unlikely but safe)
    let mdat_end = parsed.mdat_offset + parsed.mdat_size;
    if mdat_end < segment_data.len() {
        output.extend_from_slice(&segment_data[mdat_end..]);
    }

    // Strip encryption metadata boxes if requested
    let final_output = if cmd.strip {
        strip::strip_segment_encryption_boxes(&output)
    } else {
        output
    };

    let result = DecryptResult {
        success: true,
        error: None,
        sample_count: Some(senc.samples.len()),
        iv_size: Some(effective_iv_size),
        is_protected: Some(true),
    };

    (serde_json::to_string(&result).unwrap(), Some(final_output))
}

/// Process an init segment — extract tenc info and pass through unchanged.
fn process_init(data: &[u8]) -> (String, Option<Vec<u8>>) {
    let tenc = mp4box::parse_init_for_tenc(data);
    let result = DecryptResult {
        success: true,
        error: None,
        sample_count: None,
        iv_size: tenc.as_ref().map(|t| t.default_per_sample_iv_size),
        is_protected: tenc.as_ref().map(|t| t.default_is_protected != 0),
    };
    (serde_json::to_string(&result).unwrap(), Some(data.to_vec()))
}

fn error_result(msg: &str) -> String {
    serde_json::to_string(&DecryptResult {
        success: false,
        error: Some(msg.to_string()),
        sample_count: None,
        iv_size: None,
        is_protected: None,
    }).unwrap()
}
