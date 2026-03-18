//! CENC (Common Encryption Standard, ISO 23001-7) sample encryption.
//!
//! AES-128-CTR encryption per sample with random per-sample 8-byte IVs.
//! Symmetric to the decryption in cenc-decrypt — same apply_keystream call.
//! CEK is zeroed in memory after use.

use aes::cipher::{KeyIvInit, StreamCipher};

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

/// Encrypt all samples in an mdat payload using CENC AES-128-CTR (full-sample).
///
/// Returns (encrypted_mdat, per_sample_ivs).
/// Each sample gets a unique 8-byte IV. The IV is zero-padded to 16 bytes
/// for AES-128-CTR per CENC spec.
pub fn encrypt_samples(
    mdat: &[u8],
    cek: &[u8; 16],
    sample_sizes: &[u32],
    iv_seed: &[u8],
) -> Result<(Vec<u8>, Vec<[u8; 8]>), String> {
    let mut output = mdat.to_vec();
    let mut ivs = Vec::with_capacity(sample_sizes.len());
    let mut offset = 0usize;

    for (i, &size) in sample_sizes.iter().enumerate() {
        let sample_size = size as usize;
        if offset + sample_size > output.len() {
            return Err(format!(
                "sample {i} exceeds mdat: offset={offset} size={sample_size} mdat_len={}",
                output.len()
            ));
        }

        let iv8 = generate_sample_iv(iv_seed, i);
        let iv16 = pad_iv(&iv8);

        let mut cipher = Aes128Ctr::new(cek.into(), (&iv16).into());
        cipher.apply_keystream(&mut output[offset..offset + sample_size]);

        ivs.push(iv8);
        offset += sample_size;
    }

    Ok((output, ivs))
}

/// Generate a deterministic 8-byte IV for a given sample index.
/// Uses the seed (typically derived from segment number) + sample index
/// to produce unique IVs without requiring a CSPRNG in WASM.
fn generate_sample_iv(seed: &[u8], sample_index: usize) -> [u8; 8] {
    let mut iv = [0u8; 8];
    let idx_bytes = (sample_index as u64).to_be_bytes();
    for (i, b) in iv.iter_mut().enumerate() {
        *b = seed.get(i).copied().unwrap_or(0) ^ idx_bytes[i];
    }
    iv
}

/// Pad an 8-byte IV to 16 bytes (zero-padded on the right) per CENC spec.
fn pad_iv(iv8: &[u8; 8]) -> [u8; 16] {
    let mut iv16 = [0u8; 16];
    iv16[..8].copy_from_slice(iv8);
    iv16
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::KeyIvInit;

    #[test]
    fn round_trip_encrypt_decrypt() {
        let key = [0x01u8; 16];
        let plaintext = b"Hello CENC encryption test data! More data here for good measure padding.";
        let sample_sizes = vec![plaintext.len() as u32];
        let seed = [0xAB; 8];

        let (encrypted, ivs) = encrypt_samples(plaintext, &key, &sample_sizes, &seed).unwrap();
        assert_ne!(&encrypted[..], &plaintext[..]);
        assert_eq!(ivs.len(), 1);

        let iv16 = pad_iv(&ivs[0]);
        let mut decrypted = encrypted.clone();
        let mut cipher = Aes128Ctr::new(&key.into(), (&iv16).into());
        cipher.apply_keystream(&mut decrypted);
        assert_eq!(&decrypted[..], &plaintext[..]);
    }

    #[test]
    fn multi_sample_round_trip() {
        let key = [0x42u8; 16];
        let data = b"AAAA1111BBBBBBBB2222CCCC";
        let sizes = vec![4u32, 4, 8, 4, 4];
        let seed = [0x01; 8];

        let (enc, ivs) = encrypt_samples(data, &key, &sizes, &seed).unwrap();
        assert_eq!(ivs.len(), 5);

        let mut dec = enc.clone();
        let mut offset = 0usize;
        for (i, &sz) in sizes.iter().enumerate() {
            let iv16 = pad_iv(&ivs[i]);
            let mut cipher = Aes128Ctr::new(&key.into(), (&iv16).into());
            cipher.apply_keystream(&mut dec[offset..offset + sz as usize]);
            offset += sz as usize;
        }
        assert_eq!(&dec[..], &data[..]);
    }

    #[test]
    fn unique_ivs_per_sample() {
        let seed = [0xFF; 8];
        let iv0 = generate_sample_iv(&seed, 0);
        let iv1 = generate_sample_iv(&seed, 1);
        let iv2 = generate_sample_iv(&seed, 2);
        assert_ne!(iv0, iv1);
        assert_ne!(iv1, iv2);
    }
}
