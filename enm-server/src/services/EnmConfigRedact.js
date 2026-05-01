/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * EnmConfigRedact — strip rpc.passwordEncrypted before sending the config
 * over the wire. The frontend never needs to read the encrypted blob; it
 * only needs to know IF a password is set (so the input placeholder can
 * say "leave blank to keep current" vs "set a password").
 *
 * Lives in lib/ rather than routes/ so it can be tested without pulling in
 * Express (an undeclared peer dep we get from PC2 at runtime).
 */

'use strict';

/**
 * Deep-clone the config and replace each chain's rpc.passwordEncrypted with
 * a redaction marker, plus a synthetic `passwordSet` boolean. Other fields
 * pass through unchanged.
 *
 * @param {object} cfg
 * @returns {object}
 */
function redactSecrets(cfg) {
    if (!cfg) return cfg;
    const out = JSON.parse(JSON.stringify(cfg));
    if (out.chains) {
        for (const k of Object.keys(out.chains)) {
            const chain = out.chains[k];
            if (chain && chain.rpc && chain.rpc.passwordEncrypted) {
                chain.rpc.passwordEncrypted = '[REDACTED]';
                chain.rpc.passwordSet = true;
            } else if (chain && chain.rpc) {
                chain.rpc.passwordSet = false;
            }
        }
    }
    return out;
}

module.exports = { redactSecrets };
