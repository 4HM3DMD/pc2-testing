//! AES-256-GCM decryption — the only place the CEK touches memory.
//!
//! After this function returns, the caller MUST zero the returned Vec
//! before dropping it. The CEK buffer is zeroed internally.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::Engine;

const AUTH_TAG_LEN: usize = 16;

/// Decrypt AES-256-GCM encrypted content.
///
/// Input format matches PC2's two-layer encryption:
/// - `cek_b64`: base64-encoded 32-byte key
/// - `iv_b64`: base64-encoded 12-byte nonce
/// - `encrypted_b64`: base64-encoded ciphertext with 16-byte auth tag appended
pub fn aes_gcm_decrypt(cek_b64: &str, iv_b64: &str, encrypted_b64: &str) -> Result<Vec<u8>, String> {
    let b64 = base64::engine::general_purpose::STANDARD;

    // Decode CEK
    let mut cek_bytes = b64.decode(cek_b64).map_err(|e| format!("cek decode: {e}"))?;
    if cek_bytes.len() != 32 {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return Err(format!("cek length {} (expected 32)", cek_bytes.len()));
    }

    // Decode IV
    let iv_bytes = b64.decode(iv_b64).map_err(|e| format!("iv decode: {e}"))?;
    if iv_bytes.len() != 12 {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return Err(format!("iv length {} (expected 12)", iv_bytes.len()));
    }

    // Decode encrypted payload
    let encrypted = b64.decode(encrypted_b64).map_err(|e| format!("data decode: {e}"))?;
    if encrypted.len() < AUTH_TAG_LEN {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return Err("encrypted data too short for auth tag".into());
    }

    // Node.js crypto appends the auth tag; aes-gcm crate expects it appended too.
    // Our format: [ciphertext || 16-byte auth tag] — this is exactly what
    // aes-gcm's `decrypt` expects as the "ciphertext" parameter.
    let cipher = Aes256Gcm::new_from_slice(&cek_bytes).map_err(|e| format!("cipher init: {e}"))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let plaintext = cipher
        .decrypt(nonce, encrypted.as_ref())
        .map_err(|_| "decryption failed (bad key, iv, or corrupted data)".to_string())?;

    // Zero the CEK immediately after use
    cek_bytes.iter_mut().for_each(|b| *b = 0);

    Ok(plaintext)
}

/// Decrypt AES-256-GCM from raw bytes (no base64 on the encrypted payload).
///
/// Used by the MemFS file-based interface where encrypted data is read
/// directly from /input/encrypted.bin as raw bytes.
pub fn aes_gcm_decrypt_raw(cek_b64: &str, iv_b64: &str, encrypted: &[u8]) -> Result<Vec<u8>, String> {
    let b64 = base64::engine::general_purpose::STANDARD;

    let mut cek_bytes = b64.decode(cek_b64).map_err(|e| format!("cek decode: {e}"))?;
    if cek_bytes.len() != 32 {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return Err(format!("cek length {} (expected 32)", cek_bytes.len()));
    }

    let iv_bytes = b64.decode(iv_b64).map_err(|e| format!("iv decode: {e}"))?;
    if iv_bytes.len() != 12 {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return Err(format!("iv length {} (expected 12)", iv_bytes.len()));
    }

    if encrypted.len() < AUTH_TAG_LEN {
        cek_bytes.iter_mut().for_each(|b| *b = 0);
        return Err("encrypted data too short for auth tag".into());
    }

    let cipher = Aes256Gcm::new_from_slice(&cek_bytes).map_err(|e| format!("cipher init: {e}"))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let plaintext = cipher
        .decrypt(nonce, encrypted)
        .map_err(|_| "decryption failed (bad key, iv, or corrupted data)".to_string())?;

    cek_bytes.iter_mut().for_each(|b| *b = 0);
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::OsRng;
    use aes_gcm::AeadCore;
    use base64::Engine;

    #[test]
    fn round_trip() {
        let b64 = base64::engine::general_purpose::STANDARD;

        let key = Aes256Gcm::generate_key(OsRng);
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(OsRng);

        let plaintext = b"Hello from the dDRM renderer!";
        let ciphertext = cipher.encrypt(&nonce, plaintext.as_ref()).unwrap();

        let cek_b64 = b64.encode(&key);
        let iv_b64 = b64.encode(&nonce);
        let enc_b64 = b64.encode(&ciphertext);

        let result = aes_gcm_decrypt(&cek_b64, &iv_b64, &enc_b64).unwrap();
        assert_eq!(&result, plaintext);
    }

    #[test]
    fn bad_key_fails() {
        let b64 = base64::engine::general_purpose::STANDARD;

        let cek_b64 = b64.encode(&[0u8; 32]);
        let iv_b64 = b64.encode(&[0u8; 12]);
        let enc_b64 = b64.encode(&[0u8; 32]);

        let result = aes_gcm_decrypt(&cek_b64, &iv_b64, &enc_b64);
        assert!(result.is_err());
    }
}
