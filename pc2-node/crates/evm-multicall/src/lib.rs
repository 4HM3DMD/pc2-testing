//! EVM ABI encoding/decoding toolkit — runs in WASM sandbox.
//!
//! Modes:
//!   "encode"     — Multicall3 aggregate3(Call3[]) calldata encoding
//!   "decode"     — Multicall3 aggregate3 result decoding
//!   "abi_decode" — Generic ABI parameter decoding (address, uint256, string, etc.)
//!
//! Multicall3 contract: 0xcA11bde05977b3631167028862bE2a173976CA11

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct MulticallInput {
    pub mode: String,
    pub calls: Option<Vec<CallInput>>,
    pub data: Option<String>,
    pub types: Option<Vec<String>>,
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

#[derive(Serialize, Deserialize)]
pub struct MulticallOutput {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<CallResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
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

/// Decode ABI-encoded parameters given a list of type names.
/// Handles both static types (uint256, address, bool, uint16, uint8, bytes16, bytes32)
/// and dynamic types (string, bytes) with proper offset resolution.
pub fn decode_abi_params(data: &[u8], types: &[String]) -> Result<Vec<String>, String> {
    let mut values = Vec::with_capacity(types.len());
    for (i, typ) in types.iter().enumerate() {
        let slot_start = i * 32;
        if slot_start + 32 > data.len() {
            return Err(format!("data too short for param {i} ({typ}): need {} bytes, have {}", slot_start + 32, data.len()));
        }
        let word = &data[slot_start..slot_start + 32];

        match typ.as_str() {
            "address" => {
                if word[..12].iter().any(|&b| b != 0) {
                    return Err(format!("param {i}: invalid address padding"));
                }
                values.push(format!("0x{}", hex::encode(&word[12..])));
            }
            "uint256" => {
                values.push(format!("0x{}", hex::encode(word)));
            }
            "uint16" => {
                let val = u16::from_be_bytes([word[30], word[31]]);
                values.push(val.to_string());
            }
            "uint8" => {
                values.push(word[31].to_string());
            }
            "bool" => {
                values.push(if word[31] != 0 { "true" } else { "false" }.to_string());
            }
            "bytes16" => {
                values.push(format!("0x{}", hex::encode(&word[..16])));
            }
            "bytes32" => {
                values.push(format!("0x{}", hex::encode(word)));
            }
            "string" | "bytes" => {
                let offset = read_uint256(word);
                if offset + 32 > data.len() {
                    return Err(format!("param {i}: string/bytes offset {offset} out of bounds (data len {})", data.len()));
                }
                let len = read_uint256(&data[offset..offset + 32]);
                let content_start = offset + 32;
                if content_start + len > data.len() {
                    return Err(format!("param {i}: string/bytes length {len} exceeds data at offset {content_start} (data len {})", data.len()));
                }
                let content = &data[content_start..content_start + len];
                if typ == "string" {
                    match std::str::from_utf8(content) {
                        Ok(s) => values.push(s.to_string()),
                        Err(_) => return Err(format!("param {i}: invalid UTF-8 in string")),
                    }
                } else {
                    values.push(format!("0x{}", hex::encode(content)));
                }
            }
            other => {
                return Err(format!("unsupported type: '{other}'"));
            }
        }
    }

    Ok(values)
}

/// Helper to build an error output.
fn err_out(msg: String) -> MulticallOutput {
    MulticallOutput { success: false, error: Some(msg), encoded: None, results: None, values: None }
}

/// Process a multicall command from JSON.
pub fn process(command_json: &str) -> String {
    let input: MulticallInput = match serde_json::from_str(command_json) {
        Ok(v) => v,
        Err(e) => return serde_json::to_string(&err_out(format!("invalid JSON: {e}"))).unwrap_or_default(),
    };

    match input.mode.as_str() {
        "encode" => {
            let calls = match input.calls {
                Some(c) => c,
                None => return serde_json::to_string(&err_out("missing 'calls' field".into())).unwrap_or_default(),
            };

            match encode_aggregate3(&calls) {
                Ok(encoded) => serde_json::to_string(&MulticallOutput {
                    success: true, error: None, encoded: Some(encode_hex(&encoded)), results: None, values: None,
                }).unwrap_or_default(),
                Err(e) => serde_json::to_string(&err_out(e)).unwrap_or_default(),
            }
        }
        "decode" => {
            let data_hex = match input.data {
                Some(d) => d,
                None => return serde_json::to_string(&err_out("missing 'data' field".into())).unwrap_or_default(),
            };

            match decode_hex(&data_hex).and_then(|bytes| decode_aggregate3_result(&bytes)) {
                Ok(results) => serde_json::to_string(&MulticallOutput {
                    success: true, error: None, encoded: None, results: Some(results), values: None,
                }).unwrap_or_default(),
                Err(e) => serde_json::to_string(&err_out(e)).unwrap_or_default(),
            }
        }
        "abi_decode" => {
            let data_hex = match input.data {
                Some(d) => d,
                None => {
                    return serde_json::to_string(&MulticallOutput {
                        success: false,
                        error: Some("missing 'data' field".to_string()),
                        encoded: None,
                        results: None,
                        values: None,
                    })
                    .unwrap_or_default();
                }
            };

            let types = match input.types {
                Some(t) => t,
                None => {
                    return serde_json::to_string(&MulticallOutput {
                        success: false,
                        error: Some("missing 'types' field".to_string()),
                        encoded: None,
                        results: None,
                        values: None,
                    })
                    .unwrap_or_default();
                }
            };

            match decode_hex(&data_hex).and_then(|bytes| decode_abi_params(&bytes, &types)) {
                Ok(values) => serde_json::to_string(&MulticallOutput {
                    success: true,
                    error: None,
                    encoded: None,
                    results: None,
                    values: Some(values),
                })
                .unwrap_or_default(),
                Err(e) => serde_json::to_string(&MulticallOutput {
                    success: false,
                    error: Some(e),
                    encoded: None,
                    results: None,
                    values: None,
                })
                .unwrap_or_default(),
            }
        }
        other => serde_json::to_string(&MulticallOutput {
            success: false,
            error: Some(format!("unknown mode: '{other}', expected 'encode', 'decode', or 'abi_decode'")),
            encoded: None,
            results: None,
            values: None,
        })
        .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_decode_single_string() {
        // ABI-encoded return value of tokenURI(): a single string "ipfs://QmTest"
        // offset(0x20) + length(13) + "ipfs://QmTest" padded
        let data = hex::decode(
            "0000000000000000000000000000000000000000000000000000000000000020\
             000000000000000000000000000000000000000000000000000000000000000d\
             697066733a2f2f516d5465737400000000000000000000000000000000000000"
        ).unwrap();
        let types = vec!["string".to_string()];
        let result = decode_abi_params(&data, &types).unwrap();
        assert_eq!(result, vec!["ipfs://QmTest"]);
    }

    #[test]
    fn abi_decode_multi_param_tuple() {
        // abi.encode(uint256, string, uint16) matching AssetCreated event data
        // tokenId = 0x00...01, tokenUri = "ipfs://Qm", opType = 2
        let token_id = "0000000000000000000000000000000000000000000000000000000000000001";
        let string_offset = "0000000000000000000000000000000000000000000000000000000000000060"; // 96
        let op_type = "0000000000000000000000000000000000000000000000000000000000000002";
        let string_len = "0000000000000000000000000000000000000000000000000000000000000009";
        let string_data = "697066733a2f2f516d0000000000000000000000000000000000000000000000"; // "ipfs://Qm"
        let hex_str = format!("{token_id}{string_offset}{op_type}{string_len}{string_data}");
        let data = hex::decode(&hex_str).unwrap();
        let types = vec!["uint256".to_string(), "string".to_string(), "uint16".to_string()];
        let result = decode_abi_params(&data, &types).unwrap();
        assert_eq!(result[0], format!("0x{token_id}"));
        assert_eq!(result[1], "ipfs://Qm");
        assert_eq!(result[2], "2");
    }

    #[test]
    fn abi_decode_address_and_bool() {
        let addr = "000000000000000000000000abcdef1234567890abcdef1234567890abcdef12";
        let bool_true = "0000000000000000000000000000000000000000000000000000000000000001";
        let data = hex::decode(format!("{addr}{bool_true}")).unwrap();
        let types = vec!["address".to_string(), "bool".to_string()];
        let result = decode_abi_params(&data, &types).unwrap();
        assert_eq!(result[0], "0xabcdef1234567890abcdef1234567890abcdef12");
        assert_eq!(result[1], "true");
    }

    #[test]
    fn abi_decode_empty_data_errors() {
        let result = decode_abi_params(&[], &["uint256".to_string()]);
        assert!(result.is_err());
    }

    #[test]
    fn abi_decode_bounds_violation() {
        // String with offset pointing past end of data
        let data = hex::decode(
            "00000000000000000000000000000000000000000000000000000000000000ff"
        ).unwrap();
        let result = decode_abi_params(&data, &["string".to_string()]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("out of bounds"));
    }

    #[test]
    fn abi_decode_via_process_json() {
        let json = r#"{"mode":"abi_decode","data":"0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000568656c6c6f000000000000000000000000000000000000000000000000000000","types":["string"]}"#;
        let result_json = process(json);
        let result: MulticallOutput = serde_json::from_str(&result_json).unwrap();
        assert!(result.success);
        assert_eq!(result.values.unwrap(), vec!["hello"]);
    }
}
