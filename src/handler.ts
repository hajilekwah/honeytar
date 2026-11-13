import { decoyFor, decoyResponse } from './decoys.js';
import { reportHit, reportHold } from './report.js';
import type { HoneytarEnv } from './settings.js';
import { tarpit } from './tarpit.js';

/** The part of a Worker's execution context that honeytar uses. */
export interface ExecCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * One call to put in front of everything else in a Worker's fetch handler. If the request is for a decoy path, this
 * returns the decoy response (held back by the tarpit, if it is on) and reports the visit without delaying it. For any
 * other request it returns null, and the Worker carries on as normal.
 *
 *   const decoy = await honeytar(request, env, ctx);
 *   if (decoy) return decoy;
 */
export async function honeytar(request: Request, env: HoneytarEnv, ctx?: ExecCtx): Promise<Response | null> {
  const kind = decoyFor(new URL(request.url).pathname);
  if (!kind) return null;
  const report = reportHit(request, env);
  if (ctx) ctx.waitUntil(report);
  else void report;
  return tarpit(decoyResponse(kind, request.method), env, {
    keepAlive: (done) => { if (ctx) ctx.waitUntil(done); },
    onDone: (result) => reportHold(request, env, result),
  });
}
