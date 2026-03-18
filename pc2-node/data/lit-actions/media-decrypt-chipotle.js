/**
 * Lit Action: Media Asset CEK Decryption (Chipotle/PKP-AES)
 *
 * Recovers the 16-byte CENC Content Encryption Key for DASH/CENC media
 * playback. Performs on-chain access verification via AuthorityGateway
 * before decrypting.
 *
 * Returns the raw CEK directly (not wrapped in an ECDH envelope like Datil).
 * The PC2 media runtime detects litBackend=chipotle in the PSSH metadata
 * and uses this direct CEK path instead of the Datil ECDH unwrap.
 *
 * jsParams expected:
 *   - ciphertext:          PKP-AES encrypted CEK (hex string from Lit.Actions.Encrypt)
 *   - dataToEncryptHash:   SHA-256 hash of the original plaintext (for verification)
 *   - kid:                 Content identifier (bytes16, e.g. "0xabc...")
 *   - pkpId:               PKP wallet address used to encrypt (for Decrypt)
 *   - authority:           AuthorityGateway contract address
 *   - chain:               Chain name (e.g. "base")
 *   - rpc:                 RPC endpoint URL
 *   - userAddress:         The buyer's wallet address to verify access for
 */

(async () => {
  const normalizedKid = kid.startsWith("0x") ? kid : "0x" + kid;

  const toChecksum = (addr) => {
    const lower = addr.toLowerCase();
    return ethers.utils
      ? ethers.utils.getAddress(lower)
      : ethers.getAddress(lower);
  };
  const checksumAuthority = toChecksum(authority);
  const checksumUser = toChecksum(userAddress);

  const abi = [{
    inputs: [
      { name: "holder", type: "address" },
      { name: "contentId", type: "bytes16" }
    ],
    name: "hasAccessByContentId",
    outputs: [{ name: "hasAccess", type: "bool" }],
    stateMutability: "view",
    type: "function"
  }];

  const provider = ethers.providers
    ? new ethers.providers.JsonRpcProvider(rpc)
    : new ethers.JsonRpcProvider(rpc);

  const gateway = new ethers.Contract(checksumAuthority, abi, provider);
  const hasAccess = await gateway.hasAccessByContentId(checksumUser, normalizedKid);

  if (!hasAccess) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: "Access denied: user does not hold AccessToken" })
    });
    return;
  }

  const cek = await Lit.Actions.Decrypt({
    pkpId: pkpId,
    ciphertext: ciphertext,
  });

  Lit.Actions.setResponse({ response: cek });
})();
