/**
 * Lit Action: Media Asset CEK Encryption (Chipotle/PKP-AES)
 *
 * Encrypts a 16-byte (128-bit) CENC Content Encryption Key using
 * Lit.Actions.Encrypt (PKP-AES). Identical mechanism to non-media encryption
 * but kept as a separate action for distinct CID registration and future
 * divergence (e.g. media-specific PSSH metadata handling).
 *
 * jsParams expected:
 *   - plaintext:  The base64-encoded 16-byte media CEK to encrypt
 *   - pkpId:      PKP wallet address to encrypt under
 */

(async () => {
  try {
    const encrypted = await Lit.Actions.Encrypt({
      pkpId: pkpId,
      message: plaintext,
    });
    Lit.Actions.setResponse({ response: JSON.stringify({ ciphertext: encrypted }) });
  } catch (e) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: e.message }) });
  }
})();
