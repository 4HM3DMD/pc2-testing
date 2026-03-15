//! WASI entry point for the dDRM Universal Renderer.
//!
//! Uses MemFS file I/O for integration with PC2's WASMRuntime:
//!   Input:  /input/command.json  (render parameters + CEK)
//!           /input/encrypted.bin (raw encrypted bytes)
//!   Output: /output/result.json  (metadata: success, content_type, etc.)
//!           /output/rendered.bin (raw rendered pixel data)
//!
//! Also supports stdout fallback: if /output/ writes fail, writes result JSON
//! to stdout for WASMRuntime to capture via wasi.getStdoutString().

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

    let encrypted_bytes = match fs::read("/input/encrypted.bin") {
        Ok(b) => b,
        Err(e) => {
            let err = format!("{{\"success\":false,\"error\":\"failed to read /input/encrypted.bin: {e}\"}}");
            write_output(&err, None);
            return;
        }
    };

    let (result_json, rendered_bytes) = ddrm_renderer::process_from_files(&command_json, &encrypted_bytes);
    write_output(&result_json, rendered_bytes.as_deref());
}

/// Write output to MemFS files. If MemFS writes fail, fall back to stdout.
fn write_output(result_json: &str, rendered: Option<&[u8]>) {
    // Try MemFS first
    let dir_ok = fs::create_dir_all("/output").is_ok();
    let result_ok = if dir_ok {
        fs::write("/output/result.json", result_json).is_ok()
    } else {
        false
    };

    if dir_ok && result_ok {
        if let Some(data) = rendered {
            let _ = fs::write("/output/rendered.bin", data);
        }
    }

    // Always write to stdout as well — WASMRuntime can read this via
    // wasi.getStdoutString() as a fallback if MemFS reads fail.
    let _ = std::io::stdout().write_all(result_json.as_bytes());
    let _ = std::io::stdout().flush();
}
