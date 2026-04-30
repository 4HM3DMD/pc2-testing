/**
 * requireSetupAuth (SEC-7, 2026-04 audit)
 *
 * Express middleware that gates the setup-time mnemonic-handling
 * endpoints (/api/setup/{info, mnemonic, acknowledge-mnemonic,
 * mnemonic-sign-message}) so an unauthenticated remote attacker
 * cannot:
 *   - read the bare BIP39 mnemonic (loss of node identity)
 *   - race the legitimate operator to encrypt the mnemonic with
 *     their own wallet (ownership hijack)
 *   - probe whether the node is mid-setup (recon)
 *
 * Acceptance:
 *   - Loopback (127.0.0.0/8 or ::1) → allow. Local operators always work.
 *   - X-First-Run-Token: <token>   → allow ONCE if the token matches
 *     the boot-time token printed to the journal/console.
 *   - Anything else                → 401.
 *
 * IMPORTANT: this middleware reads `req.socket.remoteAddress`, NOT
 * `req.ip`. Express's `trust proxy` setting can let `req.ip` be
 * spoofed via X-Forwarded-For when the node sits behind a misconfigured
 * reverse proxy. Trusting only the actual TCP peer is fail-safe.
 *
 * Spec: pc2-node/tests/security/firstRunToken.test.js (token mechanics)
 */

import type { Request, Response, NextFunction } from 'express';
import { firstRunTokenStore } from './first-run-token.js';
import { logger } from '../../utils/logger.js';

const LOOPBACK_PATTERNS = /^(127\.|::1$|::ffff:127\.)/;

function isLoopbackAddress (addr: string | undefined): boolean {
    if ( ! addr ) return false;
    return LOOPBACK_PATTERNS.test(addr);
}

export function requireSetupAuth (req: Request, res: Response, next: NextFunction): void {
    const remoteAddr = req.socket.remoteAddress || '';

    if ( isLoopbackAddress(remoteAddr) ) {
        return next();
    }

    const tokenHeader = req.headers['x-first-run-token'];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

    if ( token && firstRunTokenStore.verify(token) ) {
        logger.info('[Setup Auth] First-run token consumed for remote setup', {
            path: req.path,
            remoteAddr: remoteAddr.substring(0, 32),
        });
        return next();
    }

    logger.warn('[Setup Auth] Setup endpoint denied (non-loopback, no valid first-run token)', {
        path: req.path,
        method: req.method,
        remoteAddr: remoteAddr.substring(0, 32),
        hadTokenHeader: !!token,
    });
    res.status(401).json({
        error: 'setup_auth_required',
        message: 'Setup endpoints are restricted to loopback or X-First-Run-Token. See journalctl for the current first-run token.',
    });
}
