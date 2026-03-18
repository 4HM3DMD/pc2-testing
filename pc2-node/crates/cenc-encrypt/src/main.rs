//! WASI CLI entry point for cenc-encrypt.
//! Reads command + data from MemFS, writes result + output to MemFS.

use std::fs;
use std::process;

fn main() {
    let command_json = match fs::read_to_string("/input/command.json") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to read /input/command.json: {e}");
            process::exit(1);
        }
    };

    let segment_data = match fs::read("/input/segment.bin") {
        Ok(d) => d,
        Err(_) => Vec::new(),
    };

    let (result_json, output_data) = cenc_encrypt::process(&command_json, &segment_data);

    if let Err(e) = fs::write("/output/result.json", &result_json) {
        eprintln!("failed to write /output/result.json: {e}");
        process::exit(1);
    }

    if let Some(data) = output_data {
        if let Err(e) = fs::write("/output/segment.bin", &data) {
            eprintln!("failed to write /output/segment.bin: {e}");
            process::exit(1);
        }
    }
}
