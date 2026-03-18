/**
 * Lit Action: Non-Media Asset Encryption (Chipotle/PKP-AES)
 *
 * Encrypts the Content Encryption Key (CEK) using Lit.Actions.Encrypt (PKP-AES).
 * The CEK is passed as a base64 string and encrypted under the specified PKP,
 * producing a ciphertext that can only be decrypted by the same PKP via
 * Lit.Actions.Decrypt.
 *
 * jsParams expected:
 *   - plaintext:  The base64-encoded CEK string to encrypt
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
