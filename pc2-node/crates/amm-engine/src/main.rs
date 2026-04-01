//! WASI entry point for AMM Engine.
//!
//! Uses MemFS file I/O for integration with PC2's WASMRuntime:
//!   Input:  /input/command.json   (mode + pairs + amounts)
//!   Output: /output/result.json   (computed quote, route, price impact)

use std::fs;
use std::io::Write;

fn main() {
    let command_json = match fs::read_to_string("/input/command.json") {
        Ok(s) => s,
        Err(e) => {
            let err = format!(
                "{{\"success\":false,\"error\":\"failed to read /input/command.json: {e}\"}}"
            );
            write_output(&err);
            return;
        }
    };

    let result_json = amm_engine::process(&command_json);
    write_output(&result_json);
}

fn write_output(result_json: &str) {
    let _ = fs::create_dir_all("/output");
    let _ = fs::write("/output/result.json", result_json);
    let _ = std::io::stdout().write_all(result_json.as_bytes());
    let _ = std::io::stdout().flush();
}
