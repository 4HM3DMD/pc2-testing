//! Multicall3 ABI encoding/decoding for batching EVM read-only calls.
//!
//! Multicall3 contract: 0xcA11bde05977b3631167028862bE2a173976CA11
//! Function: aggregate3(Call3[]) returns (Result[])
//!
//! Call3 = (address target, bool allowFailure, bytes callData)
//! Result = (bool success, bytes returnData)

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct MulticallInput {
    pub mode: String,
    pub calls: Option<Vec<CallInput>>,
    pub data: Option<String>,
}

#[derive(Deserialize)]
pub struct CallInput {
    pub target: String,
    pub call_data: String,
    #[serde(default = "default_true")]
    pub allow_failure: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
pub struct MulticallOutput {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<CallResult>>,
}

#[derive(Serialize)]
pub struct CallResult {
    pub success: bool,
    pub return_data: String,
}

/// aggregate3 selector: keccak256("aggregate3((address,bool,bytes)[])") = 0x82ad56cb
const AGGREGATE3_SELECTOR: [u8; 4] = [0x82, 0xad, 0x56, 0xcb];

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).map_err(|e| format!("hex decode error: {e}"))
}

fn encode_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Pad bytes to 32-byte boundary
fn pad_right(data: &[u8]) -> Vec<u8> {
    let padded_len = ((data.len() + 31) / 32) * 32;
    let mut padded = data.to_vec();
    padded.resize(padded_len, 0);
    padded
}

fn encode_uint256(val: usize) -> [u8; 32] {
    let mut buf = [0u8; 32];
    let bytes = val.to_be_bytes();
    buf[32 - bytes.len()..].copy_from_slice(&bytes);
    buf
}

/// Encode calls into Multicall3.aggregate3() calldata.
///
/// ABI layout for aggregate3(Call3[]):
///   4 bytes selector
///   32 bytes: offset to array (always 0x20)
///   32 bytes: array length
///   For each element: 32 bytes offset to that tuple
///   For each tuple: encoded (address, bool, bytes)
pub fn encode_aggregate3(calls: &[CallInput]) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    result.extend_from_slice(&AGGREGATE3_SELECTOR);

    // Offset to the dynamic array (always 0x20 = 32)
    result.extend_from_slice(&encode_uint256(32));

    // Array length
    result.extend_from_slice(&encode_uint256(calls.len()));

    // Each tuple is dynamic, so we first write offsets, then the tuples
    let mut tuple_offsets: Vec<usize> = Vec::new();
    let mut encoded_tuples: Vec<Vec<u8>> = Vec::new();

    for call in calls {
        let addr_bytes = decode_hex(&call.target)?;
        if addr_bytes.len() != 20 {
            return Err(format!("invalid address length: {}", addr_bytes.len()));
        }

        let calldata = decode_hex(&call.call_data)?;

        let mut tuple = Vec::new();
        // address (left-padded to 32 bytes)
        let mut addr_padded = [0u8; 32];
        addr_padded[12..].copy_from_slice(&addr_bytes);
        tuple.extend_from_slice(&addr_padded);

        // bool allowFailure
        tuple.extend_from_slice(&encode_uint256(if call.allow_failure { 1 } else { 0 }));

        // bytes callData offset (always 0x60 = 96 since we have 3 fields before it)
        tuple.extend_from_slice(&encode_uint256(96));

        // bytes callData: length + padded data
        tuple.extend_from_slice(&encode_uint256(calldata.len()));
        tuple.extend_from_slice(&pad_right(&calldata));

        encoded_tuples.push(tuple);
    }

    // Calculate offsets for each tuple
    let header_size = calls.len() * 32; // offsets themselves
    let mut running_offset = header_size;
    for tuple in &encoded_tuples {
        tuple_offsets.push(running_offset);
        running_offset += tuple.len();
    }

    // Write offsets
    for offset in &tuple_offsets {
        result.extend_from_slice(&encode_uint256(*offset));
    }

    // Write tuples
    for tuple in &encoded_tuples {
        result.extend_from_slice(tuple);
    }

    Ok(result)
}

/// Decode Multicall3 aggregate3 return data.
///
/// Return layout: Result[] where Result = (bool success, bytes returnData)
///   32 bytes: offset to array
///   32 bytes: array length
///   Per element: 32 bytes offset
///   Per tuple: 32 bytes bool + 32 bytes offset to bytes + (32 bytes len + padded data)
pub fn decode_aggregate3_result(data: &[u8]) -> Result<Vec<CallResult>, String> {
    if data.len() < 64 {
        return Err("response too short".to_string());
    }

    let array_offset = read_uint256(&data[0..32]);
    let data = &data[array_offset..];

    if data.len() < 32 {
        return Err("array header too short".to_string());
    }

    let count = read_uint256(&data[0..32]);
    let data = &data[32..];

    if data.len() < count * 32 {
        return Err("not enough offset data".to_string());
    }

    let mut results = Vec::with_capacity(count);

    for i in 0..count {
        let tuple_offset = read_uint256(&data[i * 32..(i + 1) * 32]);
        let tuple = &data[tuple_offset..];

        if tuple.len() < 64 {
            return Err(format!("tuple {i} too short"));
        }

        let success = read_uint256(&tuple[0..32]) != 0;
        let bytes_offset = read_uint256(&tuple[32..64]);
        let bytes_data = &tuple[bytes_offset..];

        if bytes_data.len() < 32 {
            return Err(format!("tuple {i} bytes header too short"));
        }

        let bytes_len = read_uint256(&bytes_data[0..32]);
        let return_data = if bytes_len > 0 && bytes_data.len() >= 32 + bytes_len {
            &bytes_data[32..32 + bytes_len]
        } else {
            &[]
        };

        results.push(CallResult {
            success,
            return_data: encode_hex(return_data),
        });
    }

    Ok(results)
}

fn read_uint256(data: &[u8]) -> usize {
    if data.len() < 32 {
        return 0;
    }
    // Read last 4 bytes on wasm32 (usize=u32), last 8 on 64-bit
    let size = core::mem::size_of::<usize>();
    let start = data.len() - size;
    let mut buf = [0u8; core::mem::size_of::<usize>()];
    buf.copy_from_slice(&data[start..start + size]);
    usize::from_be_bytes(buf)
}

/// Process a multicall command from JSON.
pub fn process(command_json: &str) -> String {
    let input: MulticallInput = match serde_json::from_str(command_json) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::to_string(&MulticallOutput {
                success: false,
                error: Some(format!("invalid JSON: {e}")),
                encoded: None,
                results: None,
            })
            .unwrap_or_default();
        }
    };

    match input.mode.as_str() {
        "encode" => {
            let calls = match input.calls {
                Some(c) => c,
                None => {
                    return serde_json::to_string(&MulticallOutput {
                        success: false,
                        error: Some("missing 'calls' field".to_string()),
                        encoded: None,
                        results: None,
                    })
                    .unwrap_or_default();
                }
            };

            match encode_aggregate3(&calls) {
                Ok(encoded) => serde_json::to_string(&MulticallOutput {
                    success: true,
                    error: None,
                    encoded: Some(encode_hex(&encoded)),
                    results: None,
                })
                .unwrap_or_default(),
                Err(e) => serde_json::to_string(&MulticallOutput {
                    success: false,
                    error: Some(e),
                    encoded: None,
                    results: None,
                })
                .unwrap_or_default(),
            }
        }
        "decode" => {
            let data_hex = match input.data {
                Some(d) => d,
                None => {
                    return serde_json::to_string(&MulticallOutput {
                        success: false,
                        error: Some("missing 'data' field".to_string()),
                        encoded: None,
                        results: None,
                    })
                    .unwrap_or_default();
                }
            };

            match decode_hex(&data_hex).and_then(|bytes| decode_aggregate3_result(&bytes)) {
                Ok(results) => serde_json::to_string(&MulticallOutput {
                    success: true,
                    error: None,
                    encoded: None,
                    results: Some(results),
                })
                .unwrap_or_default(),
                Err(e) => serde_json::to_string(&MulticallOutput {
                    success: false,
                    error: Some(e),
                    encoded: None,
                    results: None,
                })
                .unwrap_or_default(),
            }
        }
        other => serde_json::to_string(&MulticallOutput {
            success: false,
            error: Some(format!("unknown mode: '{other}', expected 'encode' or 'decode'")),
            encoded: None,
            results: None,
        })
        .unwrap_or_default(),
    }
}
