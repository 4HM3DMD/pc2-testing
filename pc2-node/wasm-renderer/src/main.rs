//! WASI entry point for the dDRM Universal Renderer.
//!
//! Uses MemFS file I/O for integration with PC2's WASMRuntime:
//!   Input:  /input/command.json  (render parameters + CEK)
//!           /input/encrypted.bin (raw encrypted bytes — render/decrypt modes)
//!           /input/plaintext.bin (raw plaintext bytes — encrypt_only mode)
//!   Output: /output/result.json  (metadata: success, content_type, etc.)
//!           /output/rendered.bin (raw rendered pixel data)
//!           /output/decrypted.bin (raw plaintext — decrypt_only mode)
//!           /output/encrypted.bin (raw ciphertext — encrypt_only mode)
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

    let is_encrypt = command_json.contains("\"encrypt_only\"");
    let is_decrypt = command_json.contains("\"decrypt_only\"");

    let input_path = if is_encrypt {
        "/input/plaintext.bin"
    } else {
        "/input/encrypted.bin"
    };

    let input_bytes = match fs::read(input_path) {
        Ok(b) => b,
        Err(e) => {
            let err = format!("{{\"success\":false,\"error\":\"failed to read {input_path}: {e}\"}}");
            write_output(&err, None);
            return;
        }
    };

    let (result_json, output_bytes) = ddrm_renderer::process_from_files(&command_json, &input_bytes);

    let output_file = if is_encrypt {
        "/output/encrypted.bin"
    } else if is_decrypt {
        "/output/decrypted.bin"
    } else {
        "/output/rendered.bin"
    };

    write_output(&result_json, output_bytes.as_deref().map(|d| (output_file, d)));
}

/// Write output to MemFS files. If MemFS writes fail, fall back to stdout.
fn write_output(result_json: &str, output: Option<(&str, &[u8])>) {
    let dir_ok = fs::create_dir_all("/output").is_ok();
    let result_ok = if dir_ok {
        fs::write("/output/result.json", result_json).is_ok()
    } else {
        false
    };

    if dir_ok && result_ok {
        if let Some((path, data)) = output {
            let _ = fs::write(path, data);
        }
    }

    let _ = std::io::stdout().write_all(result_json.as_bytes());
    let _ = std::io::stdout().flush();
}
