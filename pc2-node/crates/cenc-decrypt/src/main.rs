//! WASI entry point for the CENC Segment Decryptor.
//!
//! Uses MemFS file I/O for integration with PC2's WASMRuntime:
//!   Input:  /input/command.json   (CEK + decrypt params)
//!           /input/segment.bin    (encrypted fMP4 segment bytes)
//!           /input/init.bin       (optional: init segment for tenc extraction)
//!   Output: /output/result.json   (success, error, sample_count)
//!           /output/segment.bin   (decrypted fMP4 segment bytes)

use std::fs;
use std::io::Write;

fn main() {
    let command_json = match fs::read_to_string("/input/command.json") {
        Ok(s) => s,
        Err(e) => {
            let err = format!("{{\"success\":false,\"error\":\"failed to read /input/command.json: {e}\"}}");
            write_output(&err, None);
            return;
        }
    };

    let segment_data = match fs::read("/input/segment.bin") {
        Ok(b) => b,
        Err(e) => {
            let err = format!("{{\"success\":false,\"error\":\"failed to read /input/segment.bin: {e}\"}}");
            write_output(&err, None);
            return;
        }
    };

    let init_data = fs::read("/input/init.bin").ok();

    let (result_json, output_bytes) = cenc_decrypt::process(
        &command_json,
        &segment_data,
        init_data.as_deref(),
    );

    write_output(&result_json, output_bytes.as_deref());
}

fn write_output(result_json: &str, segment: Option<&[u8]>) {
    let dir_ok = fs::create_dir_all("/output").is_ok();
    let result_ok = if dir_ok {
        fs::write("/output/result.json", result_json).is_ok()
    } else {
        false
    };

    if dir_ok && result_ok {
        if let Some(data) = segment {
            let _ = fs::write("/output/segment.bin", data);
        }
    }

    let _ = std::io::stdout().write_all(result_json.as_bytes());
    let _ = std::io::stdout().flush();
}
