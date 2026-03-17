/**
 * Lit Action: Non-Media Asset Decryption (Chipotle/PKP-AES)
 *
 * Chipotle-specific version using Lit.Actions.Decrypt (PKP-AES) instead of
 * Datil's decryptAndCombine (threshold BLS).
 *
 * Trust model identical to the Datil version:
 *   - On-chain access check via AuthorityGateway.hasAccessByContentId()
 *   - Immutable code pinned on IPFS, runs in TEE
 *   - userAddress from jsParams (server-verified buyer, not :userAddress)
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

  // Step 1: Verify on-chain access
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

  // Step 2: Decrypt the CEK via PKP-AES (Chipotle)
  const cek = await Lit.Actions.Decrypt({
    pkpId: pkpId,
    ciphertext: ciphertext,
  });

  // Step 3: Return the raw CEK (base64)
  Lit.Actions.setResponse({ response: cek });
})();
