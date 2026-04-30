//! WASI CLI entry point for ipfs-assemble.
//!
//! Reads IPFS UnixFS chunks from MemFS, concatenates them into a single
//! contiguous buffer inside WASM linear memory, and writes the result back.
//!
//! This keeps chunk data out of V8's GC-tracked heap — the only Node.js
//! Buffer is the final assembled output read from MemFS.
//!
//! ## MemFS interface
//!
//! Input:  /input/command.json   { "chunk_count": N, "total_bytes": M }
//!         /input/chunk-0.bin
//!         /input/chunk-1.bin
//!         ...
//!         /input/chunk-(N-1).bin
//!
//! Output: /output/result.json   { "success": true, "assembled_bytes": M }
//!         /output/assembled.bin

use serde::{Deserialize, Serialize};
use std::fs;
use std::process;

#[derive(Deserialize)]
struct Command {
    chunk_count: usize,
    total_bytes: usize,
}

#[derive(Serialize)]
struct ResultOutput {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    assembled_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn run() -> Result<Vec<u8>, String> {
    let command_str = fs::read_to_string("/input/command.json")
        .map_err(|e| format!("failed to read /input/command.json: {e}"))?;

    let cmd: Command = serde_json::from_str(&command_str)
        .map_err(|e| format!("failed to parse command.json: {e}"))?;

    if cmd.chunk_count == 0 {
        return Err("chunk_count is 0".into());
    }

    let mut assembled = Vec::with_capacity(cmd.total_bytes);

    for i in 0..cmd.chunk_count {
        let path = format!("/input/chunk-{i}.bin");
        let chunk = fs::read(&path)
            .map_err(|e| format!("failed to read {path}: {e}"))?;
        assembled.extend_from_slice(&chunk);
    }

    if assembled.len() != cmd.total_bytes {
        return Err(format!(
            "size mismatch: expected {} bytes, assembled {}",
            cmd.total_bytes,
            assembled.len()
        ));
    }

    Ok(assembled)
}

fn main() {
    let _ = fs::create_dir_all("/output");

    match run() {
        Ok(data) => {
            let len = data.len();
            if let Err(e) = fs::write("/output/assembled.bin", &data) {
                eprintln!("failed to write /output/assembled.bin: {e}");
                process::exit(1);
            }

            let result = ResultOutput {
                success: true,
                assembled_bytes: Some(len),
                error: None,
            };
            let json = serde_json::to_string(&result).unwrap();
            let _ = fs::write("/output/result.json", &json);
        }
        Err(err) => {
            let result = ResultOutput {
                success: false,
                assembled_bytes: None,
                error: Some(err.clone()),
            };
            let json = serde_json::to_string(&result).unwrap();
            let _ = fs::write("/output/result.json", &json);
            eprintln!("ipfs-assemble error: {err}");
            process::exit(1);
        }
    }
}
