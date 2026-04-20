/**
 * Lit Action: Media Asset CEK Decryption (Chipotle/PKP-AES) — Session Auth
 *
 * Sigauth variant of `media-decrypt-chipotle.js`. Identical semantics
 * to `non-media-decrypt-chipotle-sigauth.js` — the media flow calls
 * Lit once per viewing session (when the player fetches the CEK),
 * then every DASH segment is decrypted client-side with the already
 * recovered CEK. See
 *   .cursor/tasks/LIT-ACTION-SIGNATURE-AUTH/DESIGN.md §2.8
 *
 * `userAddress` in jsParams is IGNORED. Effective user is derived
 * from the cryptographically verified delegation.
 */

const DELEGATION_DOMAIN = 'pc2.secure-view.v1';
const REQUEST_DOMAIN = 'pc2.secure-view.request.v1';
const MAX_DELEGATION_WINDOW_SECONDS = 24 * 3600;
const REQUEST_FRESHNESS_WINDOW_SECONDS = 60;
const DELEGATION_CLOCK_SKEW_SECONDS = 5;
const EIP1271_MAGIC_VALUE = '0x1626ba7e';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
    '}'
  );
}

function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function toChecksum(addr) {
  const lower = String(addr).toLowerCase();
  return ethers.utils ? ethers.utils.getAddress(lower) : ethers.getAddress(lower);
}

function eqAddr(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

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
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      hexToBytes(sigHex),
      canonicalBytes,
    );
  } catch {
    return false;
  }
}

function encodeIsValidSignature(messageHash, signatureHex) {
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
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: toChecksum(ownerAddress), data }, 'latest'],
      }),
    });
  } catch { return false; }
  if (!resp.ok) return false;
  let body;
  try { body = await resp.json(); } catch { return false; }
  if (!body || typeof body.result !== 'string') return false;
  return body.result.toLowerCase().startsWith(EIP1271_MAGIC_VALUE.toLowerCase());
}

function deny(code, extra) {
  Lit.Actions.setResponse({
    response: JSON.stringify(Object.assign({ error: 'Access denied', code }, extra || {})),
  });
}

async function main(params) {
  const {
    ciphertext, dataToEncryptHash, kid, pkpId,
    authority, chain, chainId, rpc,
    actionIpfsId,
    delegation: delegationRaw, delegationSig,
    request: requestRaw, requestSig,
  } = params;

  if (typeof delegationRaw !== 'string' || typeof delegationSig !== 'string' ||
      typeof requestRaw !== 'string' || typeof requestSig !== 'string') {
    return deny('missing_session_bundle');
  }

  let del, req;
  try { del = JSON.parse(delegationRaw); } catch { return deny('del_malformed'); }
  try { req = JSON.parse(requestRaw); } catch { return deny('req_malformed'); }

  if (canonicalize(del) !== delegationRaw) return deny('del_not_canonical');
  if (canonicalize(req) !== requestRaw) return deny('req_not_canonical');

  if (del.domain !== DELEGATION_DOMAIN) return deny('bad_domain');
  if (req.domain !== REQUEST_DOMAIN) return deny('bad_req_domain');
  if (Number(del.chainId) !== Number(chainId)) return deny('bad_chain');
  if (del.actionIpfsId !== actionIpfsId) return deny('bad_action_cid');
  if (req.actionIpfsId !== actionIpfsId) return deny('bad_req_action_cid');

  const normalizedKid = kid.startsWith('0x') ? kid : '0x' + kid;
  if (String(req.kid).toLowerCase() !== normalizedKid.toLowerCase()) return deny('bad_req_kid');
  // Binding is via the ECDSA signature over del.sessionPublicKey.

  const now = Math.floor(Date.now() / 1000);
  if (now + DELEGATION_CLOCK_SKEW_SECONDS < del.issuedAt) return deny('del_not_yet_valid');
  if (now > del.expiresAt) return deny('del_expired');
  if (del.expiresAt - del.issuedAt > MAX_DELEGATION_WINDOW_SECONDS) return deny('del_window_too_wide');
  if (Math.abs(now - req.requestedAt) > REQUEST_FRESHNESS_WINDOW_SECONDS) return deny('req_stale_or_future');

  let delOk = false;
  try {
    const recovered = ethers.utils
      ? ethers.utils.verifyMessage(delegationRaw, delegationSig)
      : ethers.verifyMessage(delegationRaw, delegationSig);
    delOk = eqAddr(recovered, del.ownerAddress);
  } catch { delOk = false; }
  if (!delOk) {
    delOk = await isValidSignatureEip1271(del.ownerAddress, delegationRaw, delegationSig, rpc);
    if (!delOk) return deny('del_sig_invalid');
  }

  const reqOk = await verifyWebCryptoP256(
    del.sessionPublicKey,
    new TextEncoder().encode(requestRaw),
    requestSig,
  );
  if (!reqOk) return deny('req_sig_invalid');

  const abi = [{
    inputs: [
      { name: 'holder', type: 'address' },
      { name: 'contentId', type: 'bytes16' },
    ],
    name: 'hasAccessByContentId',
    outputs: [{ name: 'hasAccess', type: 'bool' }],
    stateMutability: 'view', type: 'function',
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
      if (ok) { authorizedAddress = toChecksum(addr); break; }
    } catch { /* keep trying */ }
  }
  if (!authorizedAddress) return deny('access_denied');

  let cek;
  try {
    cek = await Lit.Actions.Decrypt({ pkpId: pkpId, ciphertext: ciphertext });
  } catch (e) {
    return deny('decrypt_failed', { detail: String((e && e.message) || e) });
  }

  Lit.Actions.setResponse({
    response: JSON.stringify({
      data: cek,
      authorizedAddress,
      delegationNonce: del.nonce,
      requestNonce: req.requestNonce,
    }),
  });
}
