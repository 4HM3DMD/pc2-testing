# Post-Quantum Cryptographic Readiness Audit — PC2/Elacity

> **Created:** 2026-03-23
> **Last Updated:** 2026-03-23
> **Status:** Living document — update as crypto landscape evolves
> **Plan:** `.cursor/plans/pq_crypto_readiness_audit_1604477f.plan.md`

---

## Why This Matters

Today's encryption (ECDSA, ECDH, BLS) relies on mathematical problems that quantum computers can solve efficiently. Expert estimates for "Q-Day" (when a cryptographically relevant quantum computer exists):

- **20% probability by 2030** (Vitalik Buterin, Ethereum roadmap)
- **50% probability by 2031** (Dr. Michele Mosca, University of Waterloo)
- **Google Quantum AI (2025):** RSA-2048 theoretically factorable with ~1M noisy qubits — 20x reduction from prior estimates

**"Harvest now, decrypt later" is already active.** Nation-states are recording encrypted traffic today to decrypt post-Q-day. Content on IPFS is permanent — if key exchanges were captured, that content is exposed forever.

PC2 protects personal digital assets, AI skills, media — things that hold value for decades. This audit maps every cryptographic primitive, assesses quantum vulnerability, and defines the migration roadmap.

---

## Crypto Primitive Inventory

### BROKEN by Quantum (Shor's Algorithm)

A sufficiently large quantum computer completely breaks these in polynomial time.

| Primitive | Where Used in PC2 | What Breaks |
|-----------|------------------|-------------|
| **secp256k1 ECDSA** | Particle Auth, SIWE, ethers/viem tx signing, wallet identity | Private key derived from public key |
| **ECDH P-256** | Lit CEK envelope unwrap (`media.ts`, `chipotle-client.ts`) | Shared secret recovered, CEK exposed |
| **Ed25519** | Boson node identity (`IdentityService.ts`), epoxy-tls | Signatures forged, nodes impersonated |
| **X25519** | WireGuard, libp2p Noise, Boson CryptoBox | All tunnel traffic decryptable (past + future if harvested) |
| **BLS** | Lit Protocol threshold network, Ethereum consensus | Threshold signatures forged, Lit key mgmt broken |

### WEAKENED by Quantum (Grover's Algorithm)

Symmetric crypto loses half its effective security bits.

| Primitive | Where Used | Post-Quantum Effective Bits | Assessment |
|-----------|-----------|----------------------------|------------|
| **AES-256-GCM** | WASM content decrypt, mnemonic/API key encryption | 128 bits | **Still secure** |
| **AES-128-CTR** | CENC media encryption (DASH segments only) | 64 bits | **Marginal** but impractical to attack |
| **SHA-256** | CIDs, skill hashes, content hashes | 128 bits (collision) | **Still secure** |
| **ChaCha20-Poly1305** | WireGuard data plane, Noise data | 128 bits | **Still secure** |
| **XSalsa20-Poly1305** | Boson CryptoBox data plane | 128 bits | **Still secure** |

### UNAFFECTED by Quantum

| Primitive | Where Used | Why Safe |
|-----------|-----------|----------|
| **CSPRNG** (`crypto.randomBytes`) | Session tokens, API keys, nonces | True random unaffected |
| **Hash-based signatures** (future) | SPHINCS+, SLH-DSA | Based on hash functions, not discrete log |
| **STARKs** (future) | ZK proofs | Hash-based, transparent setup |

---

## Risk Assessment by Trust Boundary

### Critical (Harvest-Now-Decrypt-Later Applies)

1. **Lit Protocol ECDH P-256 envelope** — Every CEK wrapped with ECDH can be unwrapped retroactively. All dDRM content on IPFS is vulnerable if ECDH exchanges were captured.
   - Files: `pc2-node/src/api/media.ts`, `pc2-node/src/api/chipotle-client.ts`
   - **Severity: HIGH** — Content on IPFS is permanent

2. **WireGuard / libp2p Noise tunnels** — X25519 handshakes captured today can be decrypted later.
   - Files: `pc2-node/src/services/wireguard/WireGuardService.ts`, `pc2-node/src/storage/ipfs.ts`
   - **Severity: MEDIUM** — Transit data including API calls, content transfers

3. **Boson CryptoBox** — Active Proxy sessions and node identity keys are quantum-vulnerable.
   - Files: `pc2-node/src/services/boson/CryptoBox.ts`, `pc2-node/src/services/boson/IdentityService.ts`
   - **Severity: MEDIUM** — P2P channel confidentiality

### High (Breaks on Q-Day but Not Retroactive)

4. **Wallet/ECDSA identity** — Post-Q-day, private keys derivable from public keys. All funds and access tokens at risk.
   - Particle Auth, ethers, viem — throughout codebase
   - **Mitigation:** Ethereum EIP-8141 (PQ account abstraction, targeting late 2026)

5. **Lit Protocol BLS threshold** — Lit's entire key management infrastructure breaks.
   - External dependency — PC2 cannot fix this
   - **Mitigation:** Sovereign key management (replaces Lit entirely)

### Lower Priority

6. **AES-128-CTR (CENC)** — Only used for media DASH segments. 64 effective bits under Grover requires ~2^64 sequential quantum operations — impractical.
7. **AES-256-GCM, SHA-256, ChaCha20** — All remain secure with adequate margins.

---

## What PC2 Controls vs. What We Inherit

| Layer | PC2 Controls | Inherited (Can't Change Alone) |
|-------|-------------|-------------------------------|
| **WASM crypto** | AES key sizes, nonce generation, all Rust crates | Nothing — fully ours |
| **Node-level encryption** | Mnemonic, API key encryption, sessions | Nothing — fully ours |
| **Lit Protocol** | Backend choice (Chipotle/Datil), conditions | BLS threshold, PKP crypto, ECDH envelope |
| **Ethereum/Base** | Chain choice, contracts | secp256k1, Keccak, consensus |
| **Particle Auth** | Integration choice | MPC scheme, wallet crypto |
| **WireGuard** | Peer config, endpoints | Curve25519 handshake |
| **libp2p/IPFS** | Transport config | Noise key exchange, CID hashes |
| **Boson** | Identity generation, CryptoBox | tweetnacl (X25519, Ed25519) |

**Key insight:** PC2's own crypto is already quantum-safe or quantum-adequate. Vulnerabilities come from external protocol dependencies.

---

## AES-128-CTR (CENC) — Only Media, Industry Standard

**Confirmed:** AES-128-CTR is used **exclusively** in the CENC media pipeline:
- `pc2-node/crates/cenc-encrypt/src/cenc.rs` — type `Aes128Ctr = ctr::Ctr128BE<aes::Aes128>`
- `pc2-node/crates/cenc-decrypt/src/cenc.rs` — same

**Everything else uses AES-256-GCM:**
- `pc2-node/wasm-renderer/src/decrypt.rs` — non-media content
- `pc2-node/src/utils/encryption.ts` — mnemonic/API keys
- `pc2-node/src/api/storage.ts` — two-layer content encryption
- `pc2-node/data/test-apps/elacity-creator/app.js` — Creator pipeline

**Why AES-128 for media:** CENC standard (ISO 23001-7) mandates AES-128-CTR. Every DASH player, every DRM system expects 16-byte CEKs. Since we own the full pipeline (Rust WASM encrypt -> decrypt -> MSE player), we can add AES-256-CTR as a proprietary extension when needed. The Rust change is trivial (type alias).

**Why it's not the priority:** The ECDH P-256 key wrapping (via Lit) breaks **first** and breaks **everything**. AES-128 under Grover still requires ~2^64 quantum operations — hundreds of years of continuous computation. For media that depreciates in 5-20 years, key wrapping is where effort goes.

---

## Lit Protocol Replacement Strategy

### Why Replace Lit

Lit Protocol is the **single centralized dependency** in PC2. Three problems:

1. **Centralization** — Lit is a company. Chipotle migration proved they can break our APIs under us.
2. **PQ vulnerability** — No public post-quantum roadmap. BLS + ECDH P-256 breaks on Q-Day.
3. **Cost** — Capacity credits scale linearly with network usage.

### What We Already Have

Infrastructure for replacement is largely built for other reasons:
- **Supernode network** — 2 supernodes with gossip, failover, service mesh
- **Boson P2P** — Encrypted node-to-node communication (share transport)
- **WASM crypto sandbox** — CEK never touches Node.js heap (Lit Action equivalent)
- **On-chain access verification** — `hasAccessByContentId()` in `ChannelBridge.ts`
- **Content-addressed code** — IPFS CIDs for immutable custodian logic
- **Audit logging** — SQLite audit trail for every crypto operation

### Progressive Replacement

| Phase | What | Prerequisite |
|-------|------|-------------|
| **Current** | Lit Chipotle (REST API) | Working, shipping |
| **Phase A** | Dual-write: Lit + PC2 custodian | 3+ supernodes |
| **Phase B** | PC2 primary, Lit fallback | Custodian proven stable |
| **Phase C** | PC2 only, Lit optional | Quorum validated |
| **Phase D** | Content re-encryption Lit -> PC2 | PQ KEM ready |

### PQ-Native from Day 1

Sovereign key management should skip classical crypto entirely:
- Share transport: **ML-KEM-768** (not X25519)
- Custodian identity: **ML-DSA-65** (not Ed25519)
- CEK wrapping: **AES-256-GCM** (already our standard)

---

## Runtime v2 Alignment

### WASM/Rust Convergence

Every Rust crate targeting `wasm32-wasip1` is a proto-capsule for Runtime v2:

| PC2 v1 Component | Runtime v2 Capsule | PQ Status |
|-------------------|--------------------|-----------|
| `cenc-encrypt` / `cenc-decrypt` | dDRM Provider | AES-128 today, AES-256 option ready |
| `wasm-renderer` (AES-256-GCM) | Content Decrypt | Already PQ-adequate (symmetric) |
| `ipfs-assemble` | Storage Provider | No crypto (PQ-neutral) |
| `mp4-split` | Media Processing | No crypto (PQ-neutral) |
| Future: `elastos-keycustody` | Key Custody Capsule | **PQ-native from day 1** |

### The Three-in-One Principle

**Replacing Lit**, **building PQ crypto**, and **packaging for Runtime v2** are the same project:

1. Build `elastos-keycustody` in Rust targeting `wasm32-wasip1`
2. Use PQ primitives (ML-KEM-768, ML-DSA-65) — skip classical generation
3. Deploy as WASM module in PC2 v1.x supernodes
4. Same binary becomes a signed capsule in Runtime v2
5. No rework, no migration, no second system

### Questions for Anders

1. **Capability token signing** — Will Runtime adopt ML-DSA-65 or hybrid for capsule signatures?
2. **Carrier P2P crypto** — Will Carrier handshake use ML-KEM hybrid?
3. **Capsule identity** — CIDs remain SHA-256 or move to SHA-3?

---

## Migration Roadmap

| Priority | Action | When | Effort |
|----------|--------|------|--------|
| **P0** | Document this audit | Now | Done |
| **P0** | Update ROADMAP.md with PQ milestones | Now | Done |
| **P1** | Add AES-256-CTR mode flag to CENC Rust crates | When convenient | Small |
| **P2** | Grow supernode count to 3+ | Q2-Q3 2026 | Medium |
| **P2** | Prototype `elastos-keycustody` Rust crate (Shamir + ML-KEM-768, wasm32-wasip1) | Q3 2026 | Medium |
| **P2** | Evaluate ML-KEM/ML-DSA Rust crates for WASM target | Q3 2026 | Research |
| **P3** | Dual-write: Lit + PC2 custodian | Q4 2026 | Large |
| **P3** | libp2p Noise PQ hybrid (when js-libp2p ships it) | 2027 | Config change |
| **P3** | Boson CryptoBox: ML-KEM-768 + X25519 hybrid | 2027 | Medium |
| **P3** | Boson Identity: ML-DSA-65 | 2027 | Medium |
| **P4** | PC2 primary key custody, Lit fallback | 2027-2028 | Large |
| **P4** | Content re-encryption tooling (Lit -> PC2 with PQ wrapping) | 2027-2028 | Medium |
| **P4** | WireGuard PQ hybrid (Rosenpass or equivalent) | 2027-2028 | Medium |
| **P5** | Full Lit removal — PC2 only | 2028 | Medium |
| **P5** | Full PQ stack (all transports, all identity) | 2028-2030 | Large |

---

## Blind Spots

1. **Lit Protocol** — Single centralized failure point for PQ AND sovereignty. No public PQ roadmap.
2. **HNDL active now** — ECDH exchanges captured today are vulnerable. Content on IPFS is permanent.
3. **Particle Auth PQ timeline unknown** — Depends on Ethereum EIP-8141 adoption.
4. **Base chain must upgrade** — On-chain access tokens only as secure as Ethereum.
5. **Supernode count** — Need 3+ for viable Shamir threshold (currently 2).
6. **Rust PQ crate maturity** — ML-KEM/ML-DSA crates exist but need WASM target verification.
7. **Signal protocol (Baileys)** — Gateway channels use Curve25519, low priority.

---

## References

- [Ethereum PQ Roadmap (Vitalik, Feb 2026)](https://ethereum.org/roadmap/future-proofing)
- [EIP-8141: Frame Transactions](https://eips.ethereum.org/EIPS/eip-8141)
- [NIST FIPS 203 (ML-KEM), 204 (ML-DSA), 205 (SLH-DSA)](https://csrc.nist.gov/pubs/fips/203/final)
- [Lit Protocol 2025 Cryptography Roadmap](https://spark.litprotocol.com/2025-cryptography-roadmap/)
- [libp2p Post-Quantum Key Exchange (rust-libp2p #6236)](https://github.com/libp2p/rust-libp2p/issues/6236)
- [go-libp2p PQ Signature Schemes (PR #3377)](https://github.com/libp2p/go-libp2p/pull/3377)
- PC2 Architecture Convergence: `docs/core/ARCHITECTURE_CONVERGENCE.md`
- PC2 Roadmap: `docs/core/ROADMAP.md`
