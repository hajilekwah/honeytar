// Reporting: send each decoy visit, and how each held connection ended, to the ingest endpoint. Best effort: never throws,
// never delays the response, and is rate limited per Worker instance.
import { readSettings, type HoneytarEnv } from './settings.js';
import type { TarpitResult } from './tarpit.js';

const RATE = { windowMs: 60_000, max: 30 } as const;
let windowStart = 0;
let sent = 0;

/** At most RATE.max reports a minute per Worker instance, so a flood cannot become a flood of database calls. */
export function allowReport(now: number): boolean {
  if (now - windowStart >= RATE.windowMs) {
    windowStart = now;
    sent = 0;
  }
  if (sent >= RATE.max) return false;
  sent += 1;
  return true;
}

/** For tests. */
export function resetRateLimit(): void {
  windowStart = 0;
  sent = 0;
}

/** Reads at most `max` bytes of a request body without buffering the rest, and decodes them leniently. */
export async function readBodySample(request: Request, max = 1024): Promise<string> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // an aborted or malformed upload: use what arrived
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

/** Sends one hit to the ops console. Never throws; does nothing unless both settings are present. */
export async function reportHit(request: Request, env: HoneytarEnv, now: number = Date.now()): Promise<void> {
  try {
    const { url: reportUrl, secret } = readSettings(env);
    if (!reportUrl || !secret) return;
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip || !allowReport(now)) return;
    const url = new URL(request.url);
    // What Cloudflare knows about the connection (request.cf). All optional; the ingest function cleans and caps every value.
    const cf = (request as unknown as { cf?: { asn?: number; asOrganization?: string; city?: string; region?: string; colo?: string; httpProtocol?: string; tlsVersion?: string } }).cf;
    const headers: Record<string, string> = {};
    for (const name of ['accept', 'accept-language', 'content-type', 'origin', 'referer']) {
      const v = request.headers.get(name);
      if (v) headers[name] = v;
    }
    await fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-honeytar-secret': secret },
      body: JSON.stringify({
        ip,
        country: request.headers.get('cf-ipcountry') ?? undefined,
        asn: cf?.asn !== undefined ? String(cf.asn) : undefined,
        asOrg: cf?.asOrganization,
        city: cf?.city,
        region: cf?.region,
        colo: cf?.colo,
        httpProtocol: cf?.httpProtocol,
        tlsVersion: cf?.tlsVersion,
        // Set by Cloudflare on requests that come from another Cloudflare Worker: the zone that Worker belongs to.
        viaWorker: request.headers.get('cf-worker') ?? undefined,
        host: url.host,
        path: url.pathname,
        method: request.method,
        userAgent: request.headers.get('user-agent') ?? undefined,
        query: url.search,
        body: await readBodySample(request),
        headers,
      }),
    });
  } catch (err) {
    console.error('Honeypot report failed:', err);
  }
}

/** What Cloudflare knows about the connection (request.cf), as the ingest function expects it. Every part is optional. */
function connectionInfo(request: Request) {
  const cf = (request as unknown as { cf?: { asn?: number; asOrganization?: string; city?: string; region?: string; colo?: string; httpProtocol?: string; tlsVersion?: string } }).cf;
  return {
    country: request.headers.get('cf-ipcountry') ?? undefined,
    asn: cf?.asn !== undefined ? String(cf.asn) : undefined,
    asOrg: cf?.asOrganization,
    city: cf?.city,
    region: cf?.region,
    colo: cf?.colo,
    httpProtocol: cf?.httpProtocol,
    tlsVersion: cf?.tlsVersion,
    viaWorker: request.headers.get('cf-worker') ?? undefined,
  };
}

let mazeWindowStart = 0;
let mazeSent = 0;
const MAZE_RATE = { windowMs: 60_000, max: 120 } as const;

/** Maze reports have their own, higher cap (a crawler makes many requests); still bounded per Worker instance. */
export function allowMazeReport(now: number): boolean {
  if (now - mazeWindowStart >= MAZE_RATE.windowMs) {
    mazeWindowStart = now;
    mazeSent = 0;
  }
  if (mazeSent >= MAZE_RATE.max) return false;
  mazeSent += 1;
  return true;
}

export interface MazeVisit {
  /** How many levels below the maze's entry page this page is (0 for the entry). */
  depth: number;
  /** How long the page was held, and how that ended. */
  heldMs: number;
  outcome: 'gave_up' | 'completed';
}

/** Sends one maze page view (who, how deep, how long it was held, how it ended). Never throws. */
export async function reportMaze(request: Request, env: HoneytarEnv, visit: MazeVisit, now: number = Date.now()): Promise<void> {
  try {
    const { url: reportUrl, secret } = readSettings(env);
    if (!reportUrl || !secret) return;
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip || !allowMazeReport(now)) return;
    const url = new URL(request.url);
    await fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-honeytar-secret': secret },
      body: JSON.stringify({
        kind: 'maze',
        ip,
        ...connectionInfo(request),
        host: url.host,
        path: url.pathname,
        userAgent: request.headers.get('user-agent') ?? undefined,
        referer: request.headers.get('referer') ?? undefined,
        depth: visit.depth,
        heldMs: visit.heldMs,
        outcome: visit.outcome,
      }),
    });
  } catch (err) {
    console.error('Honeypot maze report failed:', err);
  }
}

let holdWindowStart = 0;
let holdSent = 0;

/** Same per-instance cap as reportHit, counted separately so a burst of hits cannot crowd out the results. */
export function allowHoldReport(now: number): boolean {
  if (now - holdWindowStart >= RATE.windowMs) {
    holdWindowStart = now;
    holdSent = 0;
  }
  if (holdSent >= RATE.max) return false;
  holdSent += 1;
  return true;
}

/** Sends how a held connection ended (how long, and whether the scanner gave up). Never throws. */
export async function reportHold(request: Request, env: HoneytarEnv, result: TarpitResult, now: number = Date.now()): Promise<void> {
  try {
    const { url: reportUrl, secret } = readSettings(env);
    if (!reportUrl || !secret) return;
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip || !allowHoldReport(now)) return;
    const url = new URL(request.url);
    await fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-honeytar-secret': secret },
      body: JSON.stringify({ kind: 'hold', ip, host: url.host, path: url.pathname, heldMs: result.heldMs, outcome: result.outcome }),
    });
  } catch (err) {
    console.error('Honeypot hold report failed:', err);
  }
}
