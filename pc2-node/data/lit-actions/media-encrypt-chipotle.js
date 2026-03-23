/**
 * Lit Action: Media Asset CEK Encryption (Chipotle/PKP-AES)
 *
 * Chipotle v3 calls `main(params)` with js_params as the argument.
 *
 * params expected:
 *   - plaintext:  The base64-encoded 16-byte media CEK to encrypt
 *   - pkpId:      PKP wallet address to encrypt under
 */

async function main(params) {
  const { pkpId, plaintext } = params;
  try {
    const encrypted = await Lit.Actions.Encrypt({
      pkpId: pkpId,
      message: plaintext,
    });
    Lit.Actions.setResponse({ response: JSON.stringify({ ciphertext: encrypted }) });
  } catch (e) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: e.message }) });
  }
}
