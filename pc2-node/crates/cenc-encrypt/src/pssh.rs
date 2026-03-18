//! PSSH (Protection System Specific Header) box generator per ISO 23001-7.
//!
//! Produces binary PSSH boxes with the Elacity dDRM system ID and custom
//! protection metadata for Chipotle-encrypted DASH streams.

use crate::mp4box::make_fullbox;

/// Elacity dDRM PSSH system ID: bf8ef85d-2c54-475d-8c1e-e27db60332a2
const ELACITY_SYSTEM_ID: [u8; 16] = [
    0xbf, 0x8e, 0xf8, 0x5d, 0x2c, 0x54, 0x47, 0x5d,
    0x8c, 0x1e, 0xe2, 0x7d, 0xb6, 0x03, 0x32, 0xa2,
];

/// Build a PSSH box (v1) with the Elacity system ID and custom data payload.
///
/// Per ISO 23001-7 §8.1:
/// ```text
/// aligned(8) class ProtectionSystemSpecificHeaderBox extends FullBox('pssh', version, flags=0) {
///   unsigned int(8)[16] SystemID;
///   if (version > 0) {
///     unsigned int(32) KID_count;
///     { unsigned int(8)[16] KID; } [KID_count];
///   }
///   unsigned int(32) DataSize;
///   unsigned int(8)[DataSize] Data;
/// }
/// ```
pub fn build_pssh(kid: &[u8; 16], data: &[u8]) -> Vec<u8> {
    let mut content = Vec::with_capacity(16 + 4 + 16 + 4 + data.len());

    // SystemID (16 bytes)
    content.extend_from_slice(&ELACITY_SYSTEM_ID);

    // KID_count (1) + KID (16 bytes) — version 1 only
    content.extend_from_slice(&1u32.to_be_bytes());
    content.extend_from_slice(kid);

    // DataSize + Data
    content.extend_from_slice(&(data.len() as u32).to_be_bytes());
    content.extend_from_slice(data);

    make_fullbox(b"pssh", 1, 0, &content)
}

/// Build the Elacity dDRM protection data payload (JSON-encoded).
pub fn build_elacity_pssh_data(
    authority: &str,
    chain_id: u32,
    rpc: &str,
    action_ipfs_id: &str,
    lit_backend: &str,
) -> Vec<u8> {
    let json = format!(
        r#"{{"protocolVersion":"2.0","protectionType":"cenc:web3-drm-v1","variant":"eth.web3.clearkey","ciphersuite":"e8582013","data":{{"authority":"{}","chainId":{},"rpc":"{}","actionIpfsId":"{}","litBackend":"{}"}}}}"#,
        authority, chain_id, rpc, action_ipfs_id, lit_backend
    );
    json.into_bytes()
}

/// Build a complete Elacity PSSH box ready for injection into an init segment.
pub fn build_elacity_pssh(
    kid: &[u8; 16],
    authority: &str,
    chain_id: u32,
    rpc: &str,
    action_ipfs_id: &str,
    lit_backend: &str,
) -> Vec<u8> {
    let data = build_elacity_pssh_data(authority, chain_id, rpc, action_ipfs_id, lit_backend);
    build_pssh(kid, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pssh_box_structure() {
        let kid = [0xAA; 16];
        let data = b"test protection data";
        let pssh = build_pssh(&kid, data);

        assert_eq!(&pssh[4..8], b"pssh");
        assert_eq!(pssh[8], 1); // version
        assert_eq!(&pssh[12..28], &ELACITY_SYSTEM_ID);

        let kid_count = u32::from_be_bytes([pssh[28], pssh[29], pssh[30], pssh[31]]);
        assert_eq!(kid_count, 1);
        assert_eq!(&pssh[32..48], &kid);

        let data_size = u32::from_be_bytes([pssh[48], pssh[49], pssh[50], pssh[51]]);
        assert_eq!(data_size, data.len() as u32);
        assert_eq!(&pssh[52..52 + data.len()], data);
    }

    #[test]
    fn elacity_pssh_json() {
        let kid = [0xBB; 16];
        let pssh = build_elacity_pssh(
            &kid,
            "0x580c26DefF267EF40A72CF10A4A42050F0641b8B",
            8453,
            "https://mainnet.base.org",
            "QmcNdiSuT2c2zKwhGozTgvT12uP26gAWMw2D49GvcLj2Go",
            "chipotle",
        );

        assert_eq!(&pssh[4..8], b"pssh");
        let data_start = 52;
        let data_size = u32::from_be_bytes([pssh[48], pssh[49], pssh[50], pssh[51]]) as usize;
        let json_str = std::str::from_utf8(&pssh[data_start..data_start + data_size]).unwrap();
        assert!(json_str.contains("chipotle"));
        assert!(json_str.contains("cenc:web3-drm-v1"));
        assert!(json_str.contains("0x580c26DefF267EF"));
    }
}
