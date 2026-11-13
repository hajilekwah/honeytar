import { decoyFor, decoyResponse } from './decoys.js';
import { allowMaze, mazeMatch, mazeMs, mazePrefix, mazeResponse } from './maze.js';
import { reportHit, reportHold, reportMaze } from './report.js';
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
  const { pathname } = new URL(request.url);
  const kind = decoyFor(pathname);
  if (!kind) return maze(request, env, ctx, pathname);
  const report = reportHit(request, env);
  if (ctx) ctx.waitUntil(report);
  else void report;
  return tarpit(decoyResponse(kind, request.method), env, {
    keepAlive: (done) => { if (ctx) ctx.waitUntil(done); },
    onDone: (result) => reportHold(request, env, result),
  });
}

/**
 * The crawler maze (off unless HONEYTAR_MAZE is set). A GET or HEAD under the prefix gets a generated page, held back for
 * HONEYTAR_MAZE_MS, and each view is reported with its depth. A path that is not a valid maze path, or a request beyond
 * the per-minute budget, gets a plain 404, so the maze never generates arbitrary pages and cannot run up the Worker's use.
 */
async function maze(request: Request, env: HoneytarEnv, ctx: ExecCtx | undefined, pathname: string): Promise<Response | null> {
  const prefix = mazePrefix(env);
  if (!prefix || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const match = mazeMatch(pathname, prefix);
  if (!match) return null;
  if (match.kind === 'bogon' || !allowMaze(Date.now())) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const send = (heldMs: number, outcome: 'gave_up' | 'completed') => reportMaze(request, env, { depth: match.depth, heldMs, outcome });
  let held = false;
  const ms = mazeMs(env);
  const res = ms > 0
    ? await tarpit(mazeResponse(prefix, match.segments, request.method), { ...env, HONEYTAR_TARPIT_MS: String(ms) }, {
        keepAlive: (done) => { held = true; if (ctx) ctx.waitUntil(done); },
        onDone: (result) => send(result.heldMs, result.outcome),
      })
    : mazeResponse(prefix, match.segments, request.method);
  // No hold (turned off, or the tarpit is full): report the view now.
  if (!held) {
    const report = send(0, 'completed');
    if (ctx) ctx.waitUntil(report);
    else void report;
  }
  return res;
}
