/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * routes/evm.js — placeholder for the future EVM tab (v0.5+).
 *
 * Per Architectural Invariant #4 of the v0.3 rebuild: EVM operations are
 * a future 5th tab inside ENM. This module reserves the /api/enm/evm/*
 * namespace today so the layout decision is locked in. Every request
 * under it returns 501 with a clear message about the v0.5 scope.
 *
 * Why now? Because picking up the EVM tab later without reserving the
 * namespace risks naming collisions with future routes (e.g. /api/enm/
 * something-evm-shaped sneaks in elsewhere). Better to claim the
 * namespace and document the gap than to retrofit it.
 *
 * What lives here in v0.5+:
 *   - /api/enm/evm/connect      — wallet provider negotiation
 *   - /api/enm/evm/sign         — proxy to wallet for ESC tx signing
 *   - /api/enm/evm/contracts/*  — read/write to ESC contracts
 *   - /api/enm/evm/bridge/*     — ELA mainchain ↔ ESC bridge ops
 *
 * None of those exist now. ENM v0.3 is mainchain-only, identity-only.
 */

'use strict';

const express = require('express');

const { errorBody } = require('../services/EnmConstants');
const { limit } = require('../services/EnmRateLimit');

function build(_extensionHandle) {
    const router = express.Router();

    // All HTTP verbs, all subpaths — single 501 response.
    router.use('*', limit('read'), (req, res) => {
        return res.status(501).json(errorBody(
            'EVM operations are not implemented in ENM v0.3. '
            + 'Cross-chain features (ESC sidechain, contract calls, bridges) '
            + 'are scheduled for v0.5. For now, use Essentials, MetaMask, or '
            + 'your wallet provider directly for ESC operations.',
        ));
    });

    return router;
}

module.exports = { build };
