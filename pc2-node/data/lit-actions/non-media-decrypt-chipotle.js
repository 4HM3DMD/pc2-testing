/**
 * Lit Action: Non-Media Asset Decryption (Chipotle/PKP-AES) — Session Auth
 *
 * Post-Option-C signature-based authentication. See
 *   .cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md §2.7
 *   .cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/SECURITY.md
 *
 * The calling PC2 server MUST pass the owner-signed SecureViewDelegation
 * and the ephemeral-key-signed SecureViewRequest. `userAddress` in
 * jsParams is ignored — the effective user is derived from the
 * cryptographically verified delegation, not from server-controlled
 * input.
 *
 * Chipotle v3 calls `main(params)` with js_params as the argument.
 *
 * params expected:
 *   ciphertext           PKP-AES encrypted CEK (hex from Lit.Actions.Encrypt)
 *   dataToEncryptHash    SHA-256 hash of the plaintext (for verification)
 *   kid                  Content identifier (bytes16, e.g. "0xabc...")
 *   pkpId                PKP wallet address used to encrypt (for Decrypt)
 *   authority            AuthorityGateway contract address
 *   chain                Chain name (e.g. "base")
 *   chainId              EIP-155 chain id (e.g. 8453)
 *   rpc                  RPC endpoint URL
 *   actionIpfsId         This action's own CID (echoed back by server
 *                        for the bad_action_cid check; must equal
 *                        del.actionIpfsId).
 *   delegation           Canonical JSON string of the SecureViewDelegation
 *   delegationSig        EIP-191 signature over `delegation` (EOA or
 *                        EIP-1271 magic value)
 *   request              Canonical JSON string of the SecureViewRequest
 *   requestSig           P-256 ECDSA signature over `request` by the
 *                        session public key declared in the delegation
 */

// ── Constants mirrored from secureViewSession.ts ─────────────────
const DELEGATION_DOMAIN = 'pc2.secure-view.v1';
const REQUEST_DOMAIN = 'pc2.secure-view.request.v1';
const MAX_DELEGATION_WINDOW_SECONDS = 24 * 3600;
const REQUEST_FRESHNESS_WINDOW_SECONDS = 60;
const DELEGATION_CLOCK_SKEW_SECONDS = 5;
const EIP1271_MAGIC_VALUE = '0x1626ba7e';

// ── Canonical JSON (must match server+client byte-for-byte) ──────
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') +
    '}'
  );
}

// ── Hex / bytes helpers ──────────────────────────────────────────
function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function toChecksum(addr) {
  const lower = String(addr).toLowerCase();
  return ethers.utils ? ethers.utils.getAddress(lower) : ethers.getAddress(lower);
}

function eqAddr(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// ── ECDSA over P-256: session public key must be SEC1 uncompressed (0x04||X||Y) ──
async function verifyWebCryptoP256(sessionPublicKey, canonicalBytes, sigHex) {
  const pubBytes = hexToBytes(sessionPublicKey);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) return false;
  let pubKey;
  try {
    pubKey = await crypto.subtle.importKey(
      'raw',
      pubBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return false;
  }
  const sigBytes = hexToBytes(sigHex);
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sigBytes,
      canonicalBytes,
    );
  } catch {
    return false;
  }
}

// ── EIP-1271 fallback via eth_call (ABI-encoded) ─────────────────
// isValidSignature(bytes32 messageHash, bytes signature) returns (bytes4)
// Selector: 0x1626ba7e
function encodeIsValidSignature(messageHash, signatureHex) {
  // messageHash is 32 bytes, signature is dynamic bytes.
  // ABI: selector(4) + messageHash(32) + offset-to-sig(32) + sigLen(32) + sig(padded)
  const sig = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  const sigBytesLen = sig.length / 2;
  const padLen = (32 - (sigBytesLen % 32)) % 32;
  const sigPadded = sig + '0'.repeat(padLen * 2);
  const hash = messageHash.startsWith('0x') ? messageHash.slice(2) : messageHash;
  const offset = (0x40).toString(16).padStart(64, '0');
  const lenHex = sigBytesLen.toString(16).padStart(64, '0');
  return '0x1626ba7e' + hash + offset + lenHex + sigPadded;
}

async function isValidSignatureEip1271(ownerAddress, canonicalText, signatureHex, rpcUrl) {
  const messageHash = ethers.utils
    ? ethers.utils.hashMessage(canonicalText)
    : ethers.hashMessage(canonicalText);
  const data = encodeIsValidSignature(messageHash, signatureHex);
  let resp;
  try {
    resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: toChecksum(ownerAddress), data }, 'latest'],
      }),
    });
  } catch {
    return false;
  }
  if (!resp.ok) return false;
  let body;
  try {
    body = await resp.json();
  } catch {
    return false;
  }
  if (!body || typeof body.result !== 'string') return false;
  return body.result.toLowerCase().startsWith(EIP1271_MAGIC_VALUE.toLowerCase());
}

// ── Fail helper ──────────────────────────────────────────────────
function deny(code, extra) {
  Lit.Actions.setResponse({
    response: JSON.stringify(Object.assign({ error: 'Access denied', code }, extra || {})),
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main(params) {
  const {
    ciphertext,
    dataToEncryptHash,
    kid,
    pkpId,
    authority,
    chain,
    chainId,
    rpc,
    actionIpfsId,
    delegation: delegationRaw,
    delegationSig,
    request: requestRaw,
    requestSig,
  } = params;

  if (typeof delegationRaw !== 'string' || typeof delegationSig !== 'string' ||
      typeof requestRaw !== 'string' || typeof requestSig !== 'string') {
    return deny('missing_session_bundle');
  }

  // ── Parse canonical bodies ─────────────────────────────────────
  // We accept the canonical JSON the server forwarded exactly as the
  // owner signed it. We DO NOT re-canonicalise here — signature
  // verification is over the bytes we received.
  let del;
  let req;
  try {
    del = JSON.parse(delegationRaw);
  } catch {
    return deny('del_malformed');
  }
  try {
    req = JSON.parse(requestRaw);
  } catch {
    return deny('req_malformed');
  }

  // Byte equality check: the server claims this string is canonical.
  // If not, something downstream mangled it — fail before spending
  // time on sig verification.
  if (canonicalize(del) !== delegationRaw) return deny('del_not_canonical');
  if (canonicalize(req) !== requestRaw) return deny('req_not_canonical');

  // ── Structural checks ──────────────────────────────────────────
  if (del.domain !== DELEGATION_DOMAIN) return deny('bad_domain');
  if (req.domain !== REQUEST_DOMAIN) return deny('bad_req_domain');
  if (Number(del.chainId) !== Number(chainId)) return deny('bad_chain');
  if (del.actionIpfsId !== actionIpfsId) return deny('bad_action_cid');
  if (req.actionIpfsId !== actionIpfsId) return deny('bad_req_action_cid');

  const normalizedKid = kid.startsWith('0x') ? kid : '0x' + kid;
  if (String(req.kid).toLowerCase() !== normalizedKid.toLowerCase()) {
    return deny('bad_req_kid');
  }
  // The request is cryptographically bound to the delegation via the
  // ephemeral P-256 signature below  only the device that holds the
  // private key pair of del.sessionPublicKey can produce a valid
  // requestSig. No separate nonce reference field is needed.

  // ── Time window ────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  if (now + DELEGATION_CLOCK_SKEW_SECONDS < del.issuedAt) return deny('del_not_yet_valid');
  if (now > del.expiresAt) return deny('del_expired');
  if (del.expiresAt - del.issuedAt > MAX_DELEGATION_WINDOW_SECONDS) return deny('del_window_too_wide');
  if (Math.abs(now - req.requestedAt) > REQUEST_FRESHNESS_WINDOW_SECONDS) return deny('req_stale_or_future');

  // ── Delegation signature (EOA first, EIP-1271 fallback) ────────
  let delOk = false;
  try {
    const recovered = ethers.utils
      ? ethers.utils.verifyMessage(delegationRaw, delegationSig)
      : ethers.verifyMessage(delegationRaw, delegationSig);
    delOk = eqAddr(recovered, del.ownerAddress);
  } catch {
    delOk = false;
  }
  if (!delOk) {
    delOk = await isValidSignatureEip1271(del.ownerAddress, delegationRaw, delegationSig, rpc);
    if (!delOk) return deny('del_sig_invalid');
  }

  // ── Per-request signature (Web Crypto P-256) ───────────────────
  const reqCanonicalBytes = new TextEncoder().encode(requestRaw);
  const reqOk = await verifyWebCryptoP256(del.sessionPublicKey, reqCanonicalBytes, requestSig);
  if (!reqOk) return deny('req_sig_invalid');

  // ── Access check across ALL coveredAddresses ───────────────────
  const abi = [{
    inputs: [
      { name: 'holder', type: 'address' },
      { name: 'contentId', type: 'bytes16' },
    ],
    name: 'hasAccessByContentId',
    outputs: [{ name: 'hasAccess', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  }];

  const provider = ethers.providers
    ? new ethers.providers.JsonRpcProvider(rpc)
    : new ethers.JsonRpcProvider(rpc);
  const gateway = new ethers.Contract(toChecksum(authority), abi, provider);

  if (!Array.isArray(del.coveredAddresses) || del.coveredAddresses.length === 0) {
    return deny('no_covered_addresses');
  }

  let authorizedAddress = null;
  for (const addr of del.coveredAddresses) {
    try {
      const ok = await gateway.hasAccessByContentId(toChecksum(addr), normalizedKid);
      if (ok) {
        authorizedAddress = toChecksum(addr);
        break;
      }
    } catch {
      /* keep trying next address */
    }
  }
  if (!authorizedAddress) return deny('access_denied');

  // ── Decrypt CEK (self-referential ACC still applies) ───────────
  let cek;
  try {
    cek = await Lit.Actions.Decrypt({
      pkpId: pkpId,
      ciphertext: ciphertext,
    });
  } catch (e) {
    return deny('decrypt_failed', { detail: String((e && e.message) || e) });
  }

  // ── SEC Wave 8 (C-02): kid ↔ ciphertext binding ─────────────────
  // Without this check, an attacker who owns kid-A can decrypt any
  // other asset by submitting kid-B's ciphertext in a request signed
  // for kid-A: hasAccessByContentId(kid-A) passes, Lit.Actions.Decrypt
  // releases kid-B's CEK, and the server happily AES-decrypts kid-B's
  // bytes. We close this by enforcing the canonical invariant:
  //    kid = first 16 bytes of sha256(cekBase64)
  // This formula is mirrored by dashPackager.ts (contractKid) and by
  // the creator + market apps (cleanHash.slice(0, 32)). Every legit
  // asset satisfies it; swapped-ciphertext attacks do not.
  const cekBytes = new TextEncoder().encode(cek);
  const digestBuf = await crypto.subtle.digest('SHA-256', cekBytes);
  const digestBytes = new Uint8Array(digestBuf);
  let derivedKid = '0x';
  for (let i = 0; i < 16; i++) {
    derivedKid += digestBytes[i].toString(16).padStart(2, '0');
  }
  if (derivedKid.toLowerCase() !== normalizedKid.toLowerCase()) {
    return deny('kid_binding_mismatch');
  }

  // The server keys its CEK cache by (kid, buyerAddress); we return
  // the authorised buyer so storage.ts can attribute the cache entry
  // to the actually-owning address (which may be the smart account,
  // not the EOA that signed the delegation).
  Lit.Actions.setResponse({
    response: JSON.stringify({
      data: cek,
      authorizedAddress,
      delegationNonce: del.nonce,
      requestNonce: req.requestNonce,
    }),
  });
}
