export { honeytar, type ExecCtx } from './handler.js';
export { decoyFor, decoyResponse, ROUTE_PATTERNS, type DecoyKind } from './decoys.js';
export { TARPIT, tarpit, tarpitActiveCount, tarpitMs, type TarpitHooks, type TarpitResult } from './tarpit.js';
export { allowHoldReport, allowReport, readBodySample, reportHit, reportHold, resetRateLimit } from './report.js';
export { readSettings, type HoneytarEnv, type Settings } from './settings.js';
