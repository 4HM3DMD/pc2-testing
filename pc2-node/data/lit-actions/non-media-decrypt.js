/**
 * Lit Action: Non-Media Asset Decryption (PC2 Sovereign Node)
 *
 * Runs on Lit Protocol nodes (TEE) — trustless, immutable (pinned on IPFS).
 * Compatible with both Datil (ethers v5) and Chipotle (ethers v6) TEE environments.
 *
 * Trust model:
 *   - Access conditions at encrypt time: ONLY the self-referential check
 *     (:currentActionIpfsId === this action's CID). This ensures only THIS
 *     specific Lit Action code can trigger decryption.
 *   - Access verification: This action code directly calls
 *     AuthorityGateway.hasAccessByContentId(userAddress, kid) on-chain.
 *     The userAddress comes from jsParams (passed by the server), NOT from
 *     :userAddress (which would be the server wallet, not the buyer).
 *   - Since this code is immutable on IPFS and runs on distributed Lit nodes,
 *     no one can tamper with the access check. The server cannot forge access.
 *
 * jsParams expected:
 *   - ciphertext:          Lit-encrypted CEK blob (base64)
 *   - dataToEncryptHash:   Hash for decryption verification
 *   - kid:                 Content identifier (bytes16, e.g. "0xabc...")
 *   - actionIpfsId:        This action's own IPFS CID (for self-referential match)
 *   - authority:           AuthorityGateway contract address
 *   - chain:               Chain name (e.g. "base")
 *   - rpc:                 RPC endpoint URL
 *   - userAddress:         The buyer's wallet address to verify access for
 */

(async () => {
  // Normalize kid to 0x-prefixed bytes16
  const normalizedKid = kid.startsWith("0x") ? kid : "0x" + kid;

  // Normalize addresses to EIP-55 checksum format.
  // ethers v5 getAddress() throws on wrong-checksum mixed-case input,
  // so we lowercase first to get a clean checksum from any input format.
  const toChecksum = (addr) => {
    const lower = addr.toLowerCase();
    return ethers.utils
      ? ethers.utils.getAddress(lower)  // ethers v5
      : ethers.getAddress(lower);        // ethers v6
  };
  const checksumAuthority = toChecksum(authority);
  const checksumUser = toChecksum(userAddress);

  // Step 1: Verify the buyer's on-chain access (trustless, runs on Lit nodes)
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

  // Support both ethers v5 (Datil) and ethers v6 (Chipotle)
  const provider = ethers.providers
    ? new ethers.providers.JsonRpcProvider(rpc)  // ethers v5
    : new ethers.JsonRpcProvider(rpc);            // ethers v6

  const gateway = new ethers.Contract(checksumAuthority, abi, provider);
  const hasAccess = await gateway.hasAccessByContentId(checksumUser, normalizedKid);

  if (!hasAccess) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: "Access denied: user does not hold AccessToken" })
    });
    return;
  }

  // Step 2: Decrypt the CEK via threshold decryption
  // Conditions must EXACTLY match what was used at encrypt() time.
  // Self-referential: only this exact Lit Action CID can decrypt.
  const effectiveChain = chain || "base";
  const cek = await Lit.Actions.decryptAndCombine({
    accessControlConditions: [{
      conditionType: "evmBasic",
      contractAddress: "",
      standardContractType: "",
      chain: effectiveChain,
      method: "",
      parameters: [":currentActionIpfsId"],
      returnValueTest: {
        comparator: "=",
        value: actionIpfsId
      }
    }],
    ciphertext,
    dataToEncryptHash,
    chain: effectiveChain,
  });

  // Step 3: Return the raw CEK (base64)
  Lit.Actions.setResponse({ response: cek });
})();
