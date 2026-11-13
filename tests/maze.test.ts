import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { honeytar } from '../src/handler.js';
import { MAZE, WORDS, allowMaze, mazeMatch, mazeMs, mazePage, mazePrefix, resetMazeBudget } from '../src/maze.js';
import { resetRateLimit } from '../src/report.js';

const env = { HONEYTAR_URL: 'https://hp.example.test/fn', HONEYTAR_SECRET: 'x'.repeat(32), HONEYTAR_MAZE: '/field-notes', HONEYTAR_MAZE_MS: '0' };
const req = (path: string, method = 'GET') => new Request(`https://site.example${path}`, { method, headers: { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'TestBot/1.0' } });

beforeEach(() => { resetRateLimit(); resetMazeBudget(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('maze settings', () => {
  it('is off unless a valid prefix is set', () => {
    expect(mazePrefix({})).toBeUndefined();
    expect(mazePrefix({ HONEYTAR_MAZE: '/field-notes' })).toBe('/field-notes');
    expect(mazePrefix({ HONEYTAR_MAZE: '/field-notes/' })).toBe('/field-notes');
    for (const bad of ['field-notes', '/', '/A/b', '/a b', '/../x', '/x/y', '//x']) expect(mazePrefix({ HONEYTAR_MAZE: bad }), bad).toBeUndefined();
  });

  it('holds 8 seconds by default, accepts 0, and caps the hold', () => {
    expect(mazeMs({})).toBe(MAZE.defaultMs);
    expect(mazeMs({ HONEYTAR_MAZE_MS: '0' })).toBe(0);
    expect(mazeMs({ HONEYTAR_MAZE_MS: '999999' })).toBe(MAZE.maxMs);
    expect(mazeMs({ HONEYTAR_MAZE_MS: 'soon' })).toBe(MAZE.defaultMs);
  });
});

describe('maze paths', () => {
  it('has unique plain lower-case words', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]{3,12}$/);
  });

  it('matches only paths under the prefix, and only maze words within the depth limit', () => {
    expect(mazeMatch('/blog', '/field-notes')).toBeNull();
    expect(mazeMatch('/field-notesx', '/field-notes')).toBeNull();
    expect(mazeMatch('/field-notes', '/field-notes')).toEqual({ kind: 'page', depth: 0, segments: [] });
    expect(mazeMatch('/field-notes/amber/birch', '/field-notes')).toEqual({ kind: 'page', depth: 2, segments: ['amber', 'birch'] });
    expect(mazeMatch('/field-notes/not-a-word', '/field-notes')).toEqual({ kind: 'bogon' });
    expect(mazeMatch('/field-notes/../x', '/field-notes')).toEqual({ kind: 'bogon' });
    expect(mazeMatch(`/field-notes${'/amber'.repeat(MAZE.maxDepth + 1)}`, '/field-notes')).toEqual({ kind: 'bogon' });
  });
});

describe('maze pages', () => {
  const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

  it('are the same every time for the same path, and differ between paths', () => {
    expect(mazePage('/field-notes', ['amber'])).toBe(mazePage('/field-notes', ['amber']));
    expect(mazePage('/field-notes', ['amber'])).not.toBe(mazePage('/field-notes', ['birch']));
  });

  it('link only deeper into the maze, with valid maze paths, and are marked noindex', () => {
    const html = mazePage('/field-notes', ['amber', 'birch']);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    const found = links(html);
    expect(found.length).toBeGreaterThanOrEqual(6);
    for (const href of found) {
      expect(href.startsWith('/field-notes/amber/birch/')).toBe(true);
      expect(mazeMatch(href, '/field-notes')!.kind).toBe('page');
    }
  });

  it('at the depth limit link back near the top, so every link is still valid', () => {
    const deep = Array.from({ length: MAZE.maxDepth }, (_, i) => WORDS[i]!);
    for (const href of links(mazePage('/field-notes', deep))) expect(mazeMatch(href, '/field-notes')!.kind).toBe('page');
  });

  it('never carry anything from the request, only maze words', () => {
    const html = mazePage('/field-notes', ['amber']);
    expect(html).not.toMatch(/198\.51|TestBot|script/i);
  });
});

describe('honeytar() with the maze on', () => {
  it('serves a generated page and reports its depth, held time and outcome', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    const waits: Promise<unknown>[] = [];
    const res = await honeytar(req('/field-notes/amber/birch'), env, { waitUntil: (p) => void waits.push(p) });
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-robots-tag')).toContain('noindex');
    expect(await res!.text()).toContain('<h1>');
    await Promise.all(waits);
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ kind: 'maze', ip: '198.51.100.7', path: '/field-notes/amber/birch', depth: 2, heldMs: 0, outcome: 'completed', userAgent: 'TestBot/1.0' });
  });

  it('answers a bogon path with a plain 404 and reports nothing', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    const res = await honeytar(req('/field-notes/zzz'), env);
    expect(res!.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('passes other methods and other paths on, and does nothing when the maze is off', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    expect(await honeytar(req('/field-notes/amber', 'POST'), env)).toBeNull();
    expect(await honeytar(req('/blog'), env)).toBeNull();
    expect(await honeytar(req('/field-notes/amber'), { ...env, HONEYTAR_MAZE: undefined })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('lets a decoy path win over the maze, and answers HEAD without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    expect((await (await honeytar(req('/wp-login.php'), env))!.text())).toContain('name="pwd"');
    const head = await honeytar(req('/field-notes/amber', 'HEAD'), env);
    expect(head!.status).toBe(200);
    expect(await head!.text()).toBe('');
  });

  it('stops answering with pages once the per-minute budget is used', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const now = Date.now();
    for (let i = 0; i < MAZE.maxPerMinute; i++) expect(allowMaze(now)).toBe(true);
    expect(allowMaze(now)).toBe(false);
    expect((await honeytar(req('/field-notes/amber'), env))!.status).toBe(404);
    expect(allowMaze(now + 60_000)).toBe(true);
  });

  it('holds each page, reports gave_up with its depth when the crawler hangs up, and completed when it waits', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    const waits: Promise<unknown>[] = [];
    const held = { ...env, HONEYTAR_MAZE_MS: '5000' };
    const a = await honeytar(req('/field-notes/amber'), held, { waitUntil: (p) => void waits.push(p) });
    const readerA = a!.body!.getReader();
    const read = readerA.read();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await read).done).toBe(false);
    await Promise.all(waits);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ kind: 'maze', depth: 1, outcome: 'completed' });

    const b = await honeytar(req('/field-notes/amber/birch'), held, { waitUntil: (p) => void waits.push(p) });
    await vi.advanceTimersByTimeAsync(2000);
    await b!.body!.cancel();
    await Promise.all(waits);
    const second = JSON.parse((f.mock.calls[1] as unknown as [string, { body: string }])[1].body);
    expect(second).toMatchObject({ kind: 'maze', depth: 2, outcome: 'gave_up' });
    expect(second.heldMs).toBeGreaterThanOrEqual(2000);
  });
});
