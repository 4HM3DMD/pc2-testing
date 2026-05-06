/*
 * logger.ts — minimal logger for the capsule runtime extension.
 *
 * Wraps console with a [tag] prefix per service. Production
 * deployments under PC2 can override the logger via
 * `setLogger(fn)` so PC2's structured logger picks up these
 * lines. Default writes to console.
 */
'use strict';

export interface Logger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
}

let writeFn: (level: string, tag: string, msg: string) => void = (level, tag, msg) => {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
};

export function setLogger(fn: typeof writeFn): void {
    writeFn = fn;
}

export function createLogger(tag: string): Logger {
    return {
        info: (msg) => writeFn('info', tag, msg),
        warn: (msg) => writeFn('warn', tag, msg),
        error: (msg) => writeFn('error', tag, msg),
        debug: (msg) => writeFn('debug', tag, msg),
    };
}
