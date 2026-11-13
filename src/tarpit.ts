// The tarpit: hold a decoy's page body back so scanners tie up a connection and time out.
import { readSettings, type HoneytarEnv } from './settings.js';

/**
 * Tarpit: a decoy's status line and headers go out at once (so the scanner believes it is connected), then the
 * body is held back for `HONEYTAR_TARPIT_MS` before it is sent. Most scanners have a read timeout of 5 to 30 seconds, so
 * they give up with a timeout and the connection they tied up is wasted on a page that is only a decoy.
 * Costs next to nothing on Workers (waiting is not CPU time). Guard rails:
 *   - Off unless HONEYTAR_TARPIT_MS is set (a positive number of milliseconds); capped at 120 seconds.
 *   - At most `maxActive` held connections per Worker instance; beyond that decoys answer at once, so a flood
 *     cannot pile up open connections.
 *   - The body is the same fixed decoy text, never anything from the request.
 */
export const TARPIT = { maxMs: 120_000, maxActive: 50 } as const;
let tarpitActive = 0;

/** The configured hold in milliseconds: 0 (off) unless HONEYTAR_TARPIT_MS is a positive number, never above TARPIT.maxMs. */
export function tarpitMs(env: HoneytarEnv): number {
  const n = Number(readSettings(env).tarpitMs);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), TARPIT.maxMs) : 0;
}

/** For tests. */
export function tarpitActiveCount(): number {
  return tarpitActive;
}

export interface TarpitResult {
  /** How long the connection was held, in milliseconds. */
  heldMs: number;
  /** gave_up: the scanner hung up before the hold ended. completed: it waited the whole hold and got the decoy. */
  outcome: 'gave_up' | 'completed';
}

export interface TarpitHooks {
  /** Called once when the hold ends, either way. */
  onDone?: (result: TarpitResult) => unknown;
  /** Called at once, only when a response is actually held, with a promise that settles after `onDone` finishes. Pass it to ctx.waitUntil so the report can finish after the scanner has gone. */
  keepAlive?: (done: Promise<unknown>) => void;
}

/**
 * Returns the same response with its body held back; returns it unchanged (and calls no hooks) when the tarpit is off
 * or full. A scanner that hangs up cancels the body stream, which ends the hold early and frees the slot.
 */
export async function tarpit(res: Response, env: HoneytarEnv = {}, hooks: TarpitHooks = {}): Promise<Response> {
  const ms = tarpitMs(env);
  if (ms === 0 || tarpitActive >= TARPIT.maxActive) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  tarpitActive += 1;
  const started = Date.now();
  let settle: () => void = () => {};
  hooks.keepAlive?.(new Promise<void>((resolve) => { settle = resolve; }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const end = (outcome: TarpitResult['outcome']) => {
    if (ended) return;
    ended = true;
    tarpitActive -= 1;
    if (timer !== undefined) clearTimeout(timer);
    const heldMs = Math.max(0, Math.min(Date.now() - started, TARPIT.maxMs));
    Promise.resolve()
      .then(() => hooks.onDone?.({ heldMs, outcome }))
      .catch(() => {})
      .finally(settle);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        try {
          if (bytes.length > 0) controller.enqueue(bytes);
          controller.close();
        } catch {
          // the client already gave up
        }
        end('completed');
      }, ms);
    },
    cancel() {
      end('gave_up');
    },
  });
  const headers = new Headers(res.headers);
  headers.delete('Content-Length');
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

