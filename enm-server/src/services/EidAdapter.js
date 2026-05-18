/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EidAdapter — Wave M3.2 (beta.3.96) — Elastos Identity (DID) Chain
 * adapter.
 *
 * Class B (EVM PBFT sidechain) — extends EvmSidechainAdapter base.
 *
 * IMPORTANT NAMING CALLOUTS (per plan §14 external-chains audit):
 *   - The binary + chainId is 'eid' (Elastos Identity).
 *   - The chain is operator-facing-labelled "Identity Chain (EID)"
 *     (plan §12 Q9 recommended "(EID)" over "(DID)" everywhere; we
 *     comply here).
 *   - The Arbiter's SideNodeList registers this chain as "DID"
 *     (not "ID") — handled by ArbiterAdapter in M6.1.
 *   - The KYC precompile at EID is 0x7D7 (= decimal 2007), NOT 0x14.
 *     plan §14 corrected the earlier audit; this address belongs to
 *     EID-specific contracts, not our adapter — noted here for future
 *     contract-interaction work (out of scope for M3.2).
 *
 * EID testnet adds an `spvconfig.json` requirement (plan §17 Class B
 * row, node.sh:4356-4366). That's M3.7 — generateExtraSpawnArgs adds
 * `--spvconfig <path>` only on testnet then. For M3.2 we ship the
 * adapter without the spvconfig branch; activeNet='testnet' won't
 * produce the materialized file until M3.7. Operators on mainnet are
 * unaffected.
 *
 * Canonical values (plan §14 + Elastos docs):
 *   chainId        — 'eid'
 *   chainIdValue   — 22 (EIP-155 mainnet chain id for EID)
 *   defaultRpcPort — 20646
 *
 * Ports for EID mainnet:
 *   20640 — UDP discovery
 *   20642 — HTTP info (legacy)
 *   20646 — HTTP-RPC (cfg.ports.rpc)
 *   20648 — P2P TCP+UDP (cfg.ports.p2p)
 *   20649 — DPoS TCP (cfg.ports.dpos)
 */

'use strict';

const EvmSidechainAdapter = require('./EvmSidechainAdapter');

class EidAdapter extends EvmSidechainAdapter {
    get chainId()        { return 'eid'; }
    get displayName()    { return 'Elastos Identity Chain'; }
    get binaryName()     { return 'eid'; }
    get defaultRpcPort() { return 20646; }
    get chainIdValue()   { return 22; }
}

module.exports = EidAdapter;
