// The crawler maze: an opt-in set of generated pages under one URL prefix. Every page links only deeper into the maze, so a
// crawler that follows links keeps going, and each page can be held back (see handler.ts). Nothing here is real content:
// pages are plain filler words, never anything from the request, and are never indexed (noindex and robots.txt Disallow).
//
// Pages are deterministic: the same path always gives the same page, so they look like fixed files. A path is only valid
// if every segment is one of WORDS and the depth is within MAZE.maxDepth; anything else is a plain 404, so the maze cannot
// be made to generate arbitrary pages.
import { readSettings, type HoneytarEnv } from './settings.js';

export const MAZE = { maxDepth: 12, defaultMs: 8_000, maxMs: 60_000, maxPerMinute: 300 } as const;

/** Plain lower-case words used for URL segments, titles and filler. Neutral on purpose. */
export const WORDS = [
  'amber', 'anchor', 'april', 'arbor', 'aspen', 'autumn', 'basin', 'beacon', 'birch', 'bridge', 'brook', 'canyon', 'cedar',
  'chapel', 'clover', 'coast', 'copper', 'cove', 'crest', 'dawn', 'delta', 'dune', 'ember', 'fable', 'fern', 'field',
  'flint', 'forest', 'garden', 'glade', 'granite', 'grove', 'harbor', 'hazel', 'heath', 'hollow', 'island', 'ivory',
  'jasper', 'juniper', 'kettle', 'lagoon', 'lantern', 'larch', 'ledger', 'lilac', 'linden', 'maple', 'marsh', 'meadow',
  'mist', 'moss', 'north', 'oak', 'ocean', 'olive', 'orchard', 'otter', 'pasture', 'pebble', 'pine', 'plain', 'pond',
  'prairie', 'quarry', 'quartz', 'rapids', 'raven', 'reed', 'ridge', 'river', 'rowan', 'saffron', 'sage', 'shore',
  'silver', 'slate', 'spruce', 'stone', 'summit', 'sunset', 'thistle', 'timber', 'trail', 'tundra', 'valley', 'velvet',
  'violet', 'walnut', 'willow', 'winter', 'wren', 'yarrow', 'zephyr', 'almond', 'bramble', 'cinder', 'drift', 'echo',
  'fjord', 'gale', 'haven', 'inlet', 'kelp', 'loam', 'mesa', 'nectar', 'oasis', 'petal', 'quill', 'ripple', 'sparrow',
  'tidal', 'umber', 'vista', 'wharf', 'yonder', 'zenith',
] as const;
const WORD_SET: ReadonlySet<string> = new Set(WORDS);
const FILLER = ['and', 'with', 'near', 'beyond', 'above', 'under', 'between', 'along', 'toward', 'across', 'through', 'beside'] as const;

/** The maze prefix from the environment: "/name" with lower-case letters, digits and hyphens, or undefined when off or invalid. */
export function mazePrefix(env: HoneytarEnv): string | undefined {
  const raw = readSettings(env).mazePrefix?.trim().replace(/\/+$/, '');
  return raw && /^\/[a-z0-9-]{1,40}$/.test(raw) ? raw : undefined;
}

/** The hold per maze page in milliseconds (0 = none). */
export function mazeMs(env: HoneytarEnv): number {
  const raw = readSettings(env).mazeMs;
  if (raw === undefined) return MAZE.defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MAZE.maxMs) : MAZE.defaultMs;
}

export type MazeMatch = { kind: 'page'; depth: number; segments: string[] } | { kind: 'bogon' };

/** Null when the path is outside the maze; a page when every segment is a maze word within the depth limit; otherwise a bogon (404). */
export function mazeMatch(pathname: string, prefix: string): MazeMatch | null {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const segments = pathname.slice(prefix.length).split('/').filter((s) => s.length > 0);
  if (segments.length > MAZE.maxDepth || segments.some((s) => !WORD_SET.has(s))) return { kind: 'bogon' };
  return { kind: 'page', depth: segments.length, segments };
}

/** FNV-1a: a small, stable string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic random number generator. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(list: readonly T[], r: () => number): T => list[Math.floor(r() * list.length)]!;
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** One generated page as HTML. Same path, same page. Contains only maze words and maze links. */
export function mazePage(prefix: string, segments: string[]): string {
  const base = `${prefix}${segments.map((s) => `/${s}`).join('')}`;
  const r = rng(hash(`${base}|honeytar-maze`));
  const title = `${cap(pick(WORDS, r))} ${pick(FILLER, r)} ${cap(pick(WORDS, r))}`;
  const paragraphs = Array.from({ length: 2 + Math.floor(r() * 3) }, () => {
    const words = Array.from({ length: 28 + Math.floor(r() * 30) }, (_, i) => (i % 5 === 4 ? pick(FILLER, r) : pick(WORDS, r)));
    return `<p>${cap(words.join(' '))}.</p>`;
  });
  const atBottom = segments.length >= MAZE.maxDepth;
  const links = Array.from({ length: 6 + Math.floor(r() * 5) }, () => {
    const w = pick(WORDS, r);
    // At the depth limit, links lead back near the top (with a different word path), so the maze has no visible end.
    const href = atBottom ? `${prefix}/${pick(WORDS, r)}/${w}` : `${base}/${w}`;
    return `<li><a href="${href}">${cap(w)}</a></li>`;
  });
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${title}</title></head><body><h1>${title}</h1>${paragraphs.join('')}<ul>${links.join('')}</ul></body></html>\n`;
}

/** The page as a response (HEAD gets headers only). Never cached, so every visit reaches the Worker. */
export function mazeResponse(prefix: string, segments: string[], method: string): Response {
  return new Response(method === 'HEAD' ? null : mazePage(prefix, segments), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

let windowStart = 0;
let served = 0;

/** A per-instance budget of maze pages a minute, so a very fast crawler cannot run up the Worker's request count. */
export function allowMaze(now: number): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    served = 0;
  }
  if (served >= MAZE.maxPerMinute) return false;
  served += 1;
  return true;
}

/** For tests. */
export function resetMazeBudget(): void {
  windowStart = 0;
  served = 0;
}
